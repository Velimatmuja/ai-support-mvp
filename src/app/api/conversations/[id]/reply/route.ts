import { requireUser } from '../../../../../lib/auth.ts';
import { decryptSecret } from '../../../../../lib/crypto.ts';
import { env } from '../../../../../lib/env.ts';
import { ApiError, errorResponse, isUuid, json, readJson } from '../../../../../lib/errors.ts';
import { admin } from '../../../../../lib/supabase/admin.ts';
import { sendText } from '../../../../../lib/telegram.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// POST /api/conversations/<id>/reply  { text }   Authorization: Bearer <access token>
// Përgjigjja e agjentit njerëzor. Kur njeriu shkruan, ai e merr bisedën: AI ndalet
// derisa agjenti ta kthejë (update conversations set status='open', ai_enabled=true).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await requireUser(req);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new ApiError(404, 'conversation_not_found');

    const body = await readJson(req, 20_000);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 4000) throw new ApiError(400, 'invalid_text');

    const db = admin();
    // Filtri tenant_id e bën të pamundur përgjigjen në bisedën e një tenant-i tjetër,
    // edhe nëse dikush gjen një conversation id të huaj.
    const { data: conv, error: convError } = await db
      .from('conversations')
      .select('id, channel_id, channel_type, external_user_id')
      .eq('id', id)
      .eq('tenant_id', user.tenantId)
      .maybeSingle();
    if (convError) throw new Error(`conversation: ${convError.message}`);
    if (!conv) throw new ApiError(404, 'conversation_not_found');

    const { data: message, error: insertError } = await db
      .from('messages')
      .insert({
        tenant_id: user.tenantId,
        conversation_id: conv.id,
        role: 'agent',
        content: text,
        metadata: { user_id: user.userId },
      })
      .select('id, role, content, created_at')
      .single();
    if (insertError) throw new Error(`insert message: ${insertError.message}`);

    const { error: updateError } = await db
      .from('conversations')
      .update({ status: 'handoff', ai_enabled: false, handoff_reason: 'agent_took_over', last_message_at: new Date().toISOString() })
      .eq('id', conv.id)
      .eq('tenant_id', user.tenantId);
    if (updateError) throw new Error(`update conversation: ${updateError.message}`);

    // Widget: vizitori e merr me polling. Telegram: dërgohet tani përmes bot-it.
    let delivered = true;
    if (conv.channel_type === 'telegram') {
      try {
        const { data: secrets, error } = await db
          .from('channel_secrets')
          .select('bot_token_enc')
          .eq('channel_id', conv.channel_id)
          .eq('tenant_id', user.tenantId)
          .single();
        if (error) throw new Error(error.message);
        await sendText(decryptSecret(secrets.bot_token_enc, env('CHANNEL_ENCRYPTION_KEY')), conv.external_user_id, text);
      } catch (e) {
        delivered = false;
        console.error('[reply] dërgimi në Telegram dështoi', e);
      }
    }

    return json({ message, delivered }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}
