import { admin } from './supabase/admin.ts';
import { t } from './i18n.ts';
import { newTraceId, traceReply } from './langfuse.ts';
import { generateReply } from './rag/generate.ts';
import { retrieve } from './rag/retrieve.ts';
import type { Conversation, MessageRow, Tenant } from './types.ts';

export type Outcome = {
  duplicate: boolean;
  // Mesazhi që duhet t'i dërgohet klientit tani (null = AI hesht, përgjigjet njeriu).
  reply: MessageRow | null;
  status: 'open' | 'handoff';
};

type HandoffReason = 'ai_requested' | 'quota' | 'trial_ended';

async function saveBotMessage(
  conversation: Conversation,
  content: string,
  metadata: Record<string, unknown>,
): Promise<MessageRow> {
  const { data, error } = await admin()
    .from('messages')
    .insert({ tenant_id: conversation.tenant_id, conversation_id: conversation.id, role: 'assistant', content, metadata })
    .select('id, role, content, created_at')
    .single();
  if (error) throw new Error(`insert assistant message: ${error.message}`);
  return data as MessageRow;
}

async function handOff(conversation: Conversation, reason: HandoffReason): Promise<void> {
  const { error } = await admin()
    .from('conversations')
    .update({ status: 'handoff', ai_enabled: false, handoff_reason: reason })
    .eq('id', conversation.id)
    .eq('tenant_id', conversation.tenant_id);
  if (error) throw new Error(`handoff: ${error.message}`);
}

// Rrjedha e vetme për çdo mesazh hyrës, e njëjtë për widget dhe Telegram:
//
//   mesazh -> ruaj (idempotent) -> a e ka njeriu bisedën? -> kuota/prova
//          -> retrieval -> Claude -> ruaj përgjigjen -> usage ledger -> handoff? -> Langfuse
//
// `tenant` dhe `conversation` janë zgjidhur nga thirrësi prej një burimi të besuar.
export async function handleInbound(args: {
  tenant: Tenant;
  conversation: Conversation;
  text: string;
  externalId: string | null;
}): Promise<Outcome> {
  const { tenant, conversation, text, externalId } = args;
  const db = admin();
  const lang = tenant.settings.language;

  // 1) Ruaj mesazhin e klientit. Indeksi unik (conversation_id, external_id) e bën
  //    idempotent: një webhook i ridërguar nuk prodhon përgjigje (dhe kosto) të dytë.
  const { data: userMsg, error: insertError } = await db
    .from('messages')
    .insert({
      tenant_id: tenant.id,
      conversation_id: conversation.id,
      role: 'user',
      content: text,
      external_id: externalId,
    })
    .select('id')
    .single();
  if (insertError) {
    if (insertError.code === '23505') return { duplicate: true, reply: null, status: 'open' };
    throw new Error(`insert user message: ${insertError.message}`);
  }

  // 2) Përditëso bisedën. Një bisedë e mbyllur rihapet dhe i kthehet AI-së.
  let status = conversation.status;
  let aiEnabled = conversation.ai_enabled;
  const patch: Record<string, unknown> = { last_message_at: new Date().toISOString() };
  if (status === 'closed') {
    Object.assign(patch, { status: 'open', ai_enabled: true, handoff_reason: null });
    status = 'open';
    aiEnabled = true;
  }
  const { error: touchError } = await db
    .from('conversations')
    .update(patch)
    .eq('id', conversation.id)
    .eq('tenant_id', tenant.id);
  if (touchError) throw new Error(`update conversation: ${touchError.message}`);

  // 3) Biseda është te njeriu: AI hesht. Mesazhi shfaqet në inbox të agjentit.
  if (!aiEnabled || status === 'handoff') return { duplicate: false, reply: null, status: 'handoff' };

  // 4) Kufijtë e planit — HARD limit për AI, por biseda nuk humbet: kalon te njeriu.
  let blocked: HandoffReason | null = null;
  if (tenant.status !== 'active' || new Date(tenant.trial_ends_at).getTime() < Date.now()) {
    blocked = 'trial_ended';
  } else {
    const { data: used, error: quotaError } = await db.rpc('ai_replies_this_month', { p_tenant_id: tenant.id });
    if (quotaError) throw new Error(`ai_replies_this_month: ${quotaError.message}`);
    if ((used as number) >= tenant.monthly_ai_reply_limit) blocked = 'quota';
  }
  if (blocked) {
    const notice = await saveBotMessage(conversation, t(lang, 'handoff'), { kind: 'notice', reason: blocked });
    await handOff(conversation, blocked);
    return { duplicate: false, reply: notice, status: 'handoff' };
  }

  // 5) RAG + Claude.
  const startedAt = new Date();
  const traceId = newTraceId();
  try {
    const { data: historyRows, error: historyError } = await db
      .from('messages')
      .select('id, role, content, created_at, metadata')
      .eq('conversation_id', conversation.id)
      .eq('tenant_id', tenant.id)
      .lt('id', userMsg.id)
      .order('id', { ascending: false })
      .limit(10);
    if (historyError) throw new Error(`history: ${historyError.message}`);
    // Njoftimet teknike ("pati një problem") nuk janë pjesë e bisedës për modelin.
    const history = ((historyRows ?? []) as (MessageRow & { metadata: { kind?: string } | null })[])
      .filter((m) => m.metadata?.kind !== 'error')
      .reverse();

    const retrieval = await retrieve(tenant.id, text);
    const gen = await generateReply({ tenant, history, text, chunks: retrieval.chunks });
    const topSimilarity = retrieval.chunks.reduce((max, c) => Math.max(max, c.similarity), 0);

    // 6) Ruaj përgjigjen.
    const reply = await saveBotMessage(conversation, gen.answer, {
      kind: 'ai',
      model: gen.model,
      needs_human: gen.needsHuman,
      sources: gen.usedSources.map((n) => retrieval.chunks[n - 1]!.id),
      top_similarity: Number(topSimilarity.toFixed(4)),
      trace_id: traceId,
    });

    // 7) Usage ledger në Supabase = burimi i së vërtetës për kuotat. Shkruhet PARA
    //    Langfuse dhe me tokenat realë që ktheu API.
    const { error: usageError } = await db.from('usage_events').insert({
      tenant_id: tenant.id,
      conversation_id: conversation.id,
      message_id: reply.id,
      event_type: 'ai_reply',
      channel_type: conversation.channel_type,
      model: gen.model,
      input_tokens: gen.inputTokens,
      output_tokens: gen.outputTokens,
      cost_usd: gen.costUsd,
      langfuse_trace_id: traceId,
    });
    if (usageError) throw new Error(`usage_events: ${usageError.message}`);

    // 8) Handoff nëse modeli e kërkoi.
    if (gen.needsHuman) await handOff(conversation, 'ai_requested');

    // 9) Trace — best effort, nuk e rrëzon kurrë përgjigjen.
    await traceReply({
      traceId,
      tenantId: tenant.id,
      conversationId: conversation.id,
      channel: conversation.channel_type,
      model: gen.model,
      system: gen.system,
      messages: gen.messages,
      output: { answer: gen.answer, needs_human: gen.needsHuman, used_sources: gen.usedSources },
      inputTokens: gen.inputTokens,
      outputTokens: gen.outputTokens,
      costUsd: gen.costUsd,
      startedAt,
      endedAt: new Date(),
      metadata: {
        chunks: retrieval.chunks.length,
        top_similarity: Number(topSimilarity.toFixed(4)),
        needs_human: gen.needsHuman,
        grounded: gen.usedSources.length > 0,
      },
    }).catch((e) => console.error('[langfuse]', e instanceof Error ? e.message : e));

    return { duplicate: false, reply, status: gen.needsHuman ? 'handoff' : 'open' };
  } catch (e) {
    // Dështim i Voyage/Claude/DB: klienti merr një mesazh të sjellshëm, nuk regjistrohet
    // përdorim (nuk i hahet kuota) dhe biseda mbetet te AI për provën tjetër.
    console.error('[pipeline] dështoi përgjigjja', { tenant: tenant.id, conversation: conversation.id }, e);
    const notice = await saveBotMessage(conversation, t(lang, 'error'), { kind: 'error' });
    return { duplicate: false, reply: notice, status: 'open' };
  }
}
