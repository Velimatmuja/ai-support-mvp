import { randomUUID } from 'node:crypto';
import { signWidgetToken, verifyWidgetToken } from '../../../../lib/crypto.ts';
import { env } from '../../../../lib/env.ts';
import { ApiError, clientIp, errorResponse, isUuid, json, preflight, readJson } from '../../../../lib/errors.ts';
import { handleInbound } from '../../../../lib/pipeline.ts';
import { enforce } from '../../../../lib/ratelimit.ts';
import { admin } from '../../../../lib/supabase/admin.ts';
import type { Conversation } from '../../../../lib/types.ts';
import { bearer, tenantForWidget } from '../../../../lib/widget.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TOKEN_TTL_SECONDS = 30 * 24 * 3600;
const CONVERSATION_COLUMNS = 'id, tenant_id, channel_id, channel_type, external_user_id, status, ai_enabled';

export function OPTIONS(): Response {
  return preflight();
}

// POST /api/widget/message  { key, text, clientId? }  + opsionale Authorization: Bearer <token>
// Përgjigjja e AI kthehet në të njëjtën kërkesë (2-5 s). Pa token -> vizitor i ri:
// krijohet biseda dhe kthehet tokeni që widget-i e ruan në localStorage.
export async function POST(req: Request): Promise<Response> {
  try {
    const body = await readJson(req, 20_000);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new ApiError(400, 'text_required');
    if (text.length > 2000) throw new ApiError(413, 'text_too_long', 'Mesazhi është shumë i gjatë.');

    // Anti-abuse në tre nivele: IP (para çdo pune tjetër), tenant, bisedë.
    await enforce(`w:msg:ip:${clientIp(req)}`, 20, 300);
    const tenant = await tenantForWidget(req, body.key);
    await enforce(`w:msg:tenant:${tenant.id}`, 600, 3600);
    const secret = env('WIDGET_TOKEN_SECRET');
    const db = admin();

    let conversation: Conversation | null = null;
    const claims = verifyWidgetToken(bearer(req), secret);
    if (claims && claims.t === tenant.id) {
      const { data, error } = await db
        .from('conversations')
        .select(CONVERSATION_COLUMNS)
        .eq('id', claims.c)
        .eq('tenant_id', tenant.id)
        .eq('channel_type', 'widget')
        .maybeSingle();
      if (error) throw new Error(`conversation: ${error.message}`);
      conversation = data as Conversation | null;
    }

    if (!conversation) {
      await enforce(`w:new:ip:${clientIp(req)}`, 10, 3600);
      const { data: channel, error: channelError } = await db
        .from('channels')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('type', 'widget')
        .eq('status', 'active')
        .maybeSingle();
      if (channelError) throw new Error(`channel: ${channelError.message}`);
      if (!channel) throw new ApiError(404, 'widget_disabled');

      const { data, error } = await db.rpc('get_or_create_conversation', {
        p_channel_id: channel.id,
        p_external_user_id: randomUUID(),
        p_contact_name: null,
      });
      if (error) throw new Error(`get_or_create_conversation: ${error.message}`);
      conversation = data as Conversation;
    }

    await enforce(`w:msg:conv:${conversation.id}`, 30, 3600);

    const outcome = await handleInbound({
      tenant,
      conversation,
      text,
      // clientId (uuid nga widget-i) e bën të sigurt riprovimin pas një gabimi rrjeti.
      externalId: isUuid(body.clientId) ? `w:${body.clientId}` : null,
    });

    return json(
      {
        token: signWidgetToken(
          { t: tenant.id, c: conversation.id, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS },
          secret,
        ),
        status: outcome.status,
        duplicate: outcome.duplicate,
        reply: outcome.reply,
      },
      200,
      true,
    );
  } catch (e) {
    return errorResponse(e, true);
  }
}

// GET /api/widget/message?key=wk_...&after=<id>   Authorization: Bearer <token>
// Polling për përgjigjet e agjentit njerëzor. Kthen vetëm mesazhe të bisedës së tokenit.
export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    // Tokeni verifikohet para se të preket DB-ja.
    const claims = verifyWidgetToken(bearer(req), env('WIDGET_TOKEN_SECRET'));
    if (!claims) throw new ApiError(401, 'invalid_token');
    await enforce(`w:poll:${claims.c}`, 40, 60);
    const tenant = await tenantForWidget(req, url.searchParams.get('key'));
    if (claims.t !== tenant.id) throw new ApiError(401, 'invalid_token');

    const after = Number(url.searchParams.get('after') || 0);
    const db = admin();
    const { data: conv, error: convError } = await db
      .from('conversations')
      .select('status')
      .eq('id', claims.c)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (convError) throw new Error(`conversation: ${convError.message}`);
    if (!conv) throw new ApiError(404, 'conversation_not_found');

    const { data, error } = await db
      .from('messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', claims.c)
      .eq('tenant_id', tenant.id)
      .in('role', ['assistant', 'agent'])
      .gt('id', Number.isSafeInteger(after) && after > 0 ? after : 0)
      .order('id')
      .limit(50);
    if (error) throw new Error(`messages: ${error.message}`);

    return json({ status: conv.status, messages: data ?? [] }, 200, true);
  } catch (e) {
    return errorResponse(e, true);
  }
}
