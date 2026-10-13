import { decryptSecret, safeEqual } from '../../../../lib/crypto.ts';
import { env } from '../../../../lib/env.ts';
import { isUuid, json } from '../../../../lib/errors.ts';
import { t } from '../../../../lib/i18n.ts';
import { handleInbound } from '../../../../lib/pipeline.ts';
import { allow } from '../../../../lib/ratelimit.ts';
import { admin } from '../../../../lib/supabase/admin.ts';
import { sendText, tg } from '../../../../lib/telegram.ts';
import { TENANT_COLUMNS } from '../../../../lib/types.ts';
import type { Conversation, Tenant } from '../../../../lib/types.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { first_name?: string; last_name?: string; username?: string; is_bot?: boolean };
  };
};

// POST /api/telegram/<channelId>  — webhook i Telegramit, një URL për çdo bot.
//
// Zgjidhja e tenant-it: channelId (në URL) -> rreshti channels -> tenant_id.
// Autentikimi: header X-Telegram-Bot-Api-Secret-Token duhet të përputhet me sekretin
// që i dhamë Telegramit te setWebhook. Pa të, kushdo që di URL-në mund të fuste
// mesazhe false dhe të digjte kuotën e tenant-it.
//
// Përpunimi bëhet brenda kërkesës (2-5 s). Nëse Telegram e ridërgon update-in
// (timeout, gabim rrjeti), indeksi unik mbi external_id e ndalon përgjigjen e dytë.
export async function POST(req: Request, ctx: { params: Promise<{ channelId: string }> }): Promise<Response> {
  const { channelId } = await ctx.params;
  if (!isUuid(channelId)) return json({ error: 'not_found' }, 404);

  const db = admin();
  const { data: channel, error: channelError } = await db
    .from('channels')
    .select('id, tenant_id, type, status')
    .eq('id', channelId)
    .eq('type', 'telegram')
    .maybeSingle();
  const { data: secrets, error: secretsError } = await db
    .from('channel_secrets')
    .select('bot_token_enc, webhook_secret, tenant_id')
    .eq('channel_id', channelId)
    .maybeSingle();
  if (channelError || secretsError) {
    console.error('[telegram] db', channelError?.message, secretsError?.message);
    return json({ error: 'temporarily_unavailable' }, 503); // Telegram do ta riprovojë.
  }

  const given = req.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!channel || !secrets || secrets.tenant_id !== channel.tenant_id || !safeEqual(given, secrets.webhook_secret)) {
    return json({ error: 'unauthorized' }, 401);
  }
  // Nga këtu e tutje kthejmë gjithmonë 200: gabimet tona nuk duhet të shkaktojnë
  // ridërgime pa fund nga Telegram.
  if (channel.status !== 'active') return json({ ok: true });

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return json({ ok: true });
  }
  const message = update.message;
  if (!message || message.chat.type !== 'private' || message.from?.is_bot || !Number.isSafeInteger(update.update_id)) {
    return json({ ok: true }); // MVP: vetëm biseda private 1-me-1.
  }

  const chatId = String(message.chat.id);
  try {
    const { data: tenantRow, error: tenantError } = await db
      .from('tenants')
      .select(TENANT_COLUMNS)
      .eq('id', channel.tenant_id)
      .single();
    if (tenantError) throw new Error(`tenant: ${tenantError.message}`);
    const tenant = tenantRow as Tenant;
    const lang = tenant.settings.language;
    const botToken = decryptSecret(secrets.bot_token_enc, env('CHANNEL_ENCRYPTION_KEY'));

    // Rate limit për chat dhe për tenant. Kur tejkalohet heshtim (pa përgjigje, pa kosto).
    if (!(await allow(`tg:chat:${channel.id}:${chatId}`, 20, 300))) return json({ ok: true });
    if (!(await allow(`tg:tenant:${tenant.id}`, 600, 3600))) return json({ ok: true });

    const text = (message.text || '').trim();
    if (!text) {
      await sendText(botToken, chatId, t(lang, 'nonText'));
      return json({ ok: true });
    }
    if (text === '/start' || text.startsWith('/start ')) {
      await sendText(botToken, chatId, tenant.settings.welcome_message || t(lang, 'welcome'));
      return json({ ok: true });
    }

    const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ').slice(0, 120) || null;
    const { data: conv, error: convError } = await db.rpc('get_or_create_conversation', {
      p_channel_id: channel.id,
      p_external_user_id: chatId,
      p_contact_name: name,
    });
    if (convError) throw new Error(`get_or_create_conversation: ${convError.message}`);

    const conversation = conv as Conversation;
    // "typing…" ndërsa AI mendon — vetëm kur biseda është te AI.
    if (conversation.ai_enabled && conversation.status !== 'handoff') {
      await tg(botToken, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
    }

    const outcome = await handleInbound({
      tenant,
      conversation,
      text: text.slice(0, 2000),
      externalId: `tg:${update.update_id}`,
    });
    if (outcome.duplicate || !outcome.reply) return json({ ok: true });

    // Telegram: tekst i thjeshtë, burimet si lidhje në fund.
    const sources = (outcome.reply.sources ?? []).map((c) => c.url);
    await sendText(botToken, chatId, sources.length ? `${outcome.reply.content}\n\n${sources.join('\n')}` : outcome.reply.content);
  } catch (e) {
    console.error('[telegram] përpunimi dështoi', { channel: channelId, update: update.update_id }, e);
  }
  return json({ ok: true });
}
