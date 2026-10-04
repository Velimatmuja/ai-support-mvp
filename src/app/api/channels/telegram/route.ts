import { requireOwner, requireUser } from '../../../../lib/auth.ts';
import { encryptSecret, randomToken } from '../../../../lib/crypto.ts';
import { env } from '../../../../lib/env.ts';
import { ApiError, errorResponse, json, readJson } from '../../../../lib/errors.ts';
import { enforce } from '../../../../lib/ratelimit.ts';
import { admin } from '../../../../lib/supabase/admin.ts';
import { tg } from '../../../../lib/telegram.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// POST /api/channels/telegram  { botToken }   Authorization: Bearer <access token i pronarit>
// Lidh bot-in e biznesit (krijuar te @BotFather) me tenant-in e përdoruesit të loguar:
// verifikon tokenin (getMe), e ruan të enkriptuar dhe regjistron webhook-un me sekret.
export async function POST(req: Request): Promise<Response> {
  try {
    const user = await requireUser(req);
    requireOwner(user);
    await enforce(`tg:connect:${user.tenantId}`, 10, 3600);

    const body = await readJson(req, 2_000);
    const botToken = typeof body.botToken === 'string' ? body.botToken.trim() : '';
    if (!/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(botToken)) throw new ApiError(400, 'invalid_bot_token');

    let me: { id: number; username?: string };
    try {
      me = await tg<{ id: number; username?: string }>(botToken, 'getMe', {});
    } catch {
      throw new ApiError(400, 'bot_token_rejected', 'Telegram nuk e pranoi këtë token.');
    }

    const db = admin();
    const externalId = String(me.id);
    const { data: existing, error: existingError } = await db
      .from('channels')
      .select('id, tenant_id')
      .eq('type', 'telegram')
      .eq('external_id', externalId)
      .maybeSingle();
    if (existingError) throw new Error(`channels: ${existingError.message}`);
    if (existing && existing.tenant_id !== user.tenantId) {
      throw new ApiError(409, 'bot_already_connected', 'Ky bot është i lidhur me një llogari tjetër.');
    }

    let channelId = existing?.id as string | undefined;
    if (!channelId) {
      const { data, error } = await db
        .from('channels')
        .insert({
          tenant_id: user.tenantId,
          type: 'telegram',
          external_id: externalId,
          display_name: me.username ? `@${me.username}` : 'Telegram bot',
        })
        .select('id')
        .single();
      if (error) throw new Error(`insert channel: ${error.message}`);
      channelId = data.id as string;
    }

    // Sekret i ri në çdo lidhje: e zhvlerëson çdo webhook të mëparshëm.
    const webhookSecret = randomToken(32);
    const { error: secretError } = await db.from('channel_secrets').upsert({
      channel_id: channelId,
      tenant_id: user.tenantId,
      bot_token_enc: encryptSecret(botToken, env('CHANNEL_ENCRYPTION_KEY')),
      webhook_secret: webhookSecret,
    });
    if (secretError) throw new Error(`channel_secrets: ${secretError.message}`);

    await tg(botToken, 'setWebhook', {
      url: `${env('APP_URL').replace(/\/$/, '')}/api/telegram/${channelId}`,
      secret_token: webhookSecret,
      allowed_updates: ['message'],
      drop_pending_updates: true,
      max_connections: 10,
    });

    return json({ channelId, bot: me.username ? `@${me.username}` : externalId });
  } catch (e) {
    return errorResponse(e);
  }
}
