import { verifyWidgetToken } from '../../../../lib/crypto.ts';
import { env } from '../../../../lib/env.ts';
import { clientIp, errorResponse, json, preflight } from '../../../../lib/errors.ts';
import { localeOf, t } from '../../../../lib/i18n.ts';
import { enforce } from '../../../../lib/ratelimit.ts';
import { admin } from '../../../../lib/supabase/admin.ts';
import { publicMessage } from '../../../../lib/types.ts';
import type { MessageRow } from '../../../../lib/types.ts';
import { bearer, tenantForWidget } from '../../../../lib/widget.ts';

export const dynamic = 'force-dynamic';

export function OPTIONS(): Response {
  return preflight();
}

// GET /api/widget/session?key=wk_...
// Thirret kur vizitori HAP panelin (jo në çdo page view): kthen konfigurimin e
// widget-it dhe, nëse ka token të vlefshëm, historikun e bisedës së tij.
// Nuk shkruan asgjë në DB — biseda krijohet vetëm me mesazhin e parë.
export async function GET(req: Request): Promise<Response> {
  try {
    await enforce(`w:session:${clientIp(req)}`, 60, 300);
    const tenant = await tenantForWidget(req, new URL(req.url).searchParams.get('key'));
    const lang = tenant.settings.language;

    let messages: unknown[] = [];
    let status: string | null = null;
    const token = verifyWidgetToken(bearer(req), env('WIDGET_TOKEN_SECRET'));
    if (token && token.t === tenant.id) {
      const db = admin();
      const { data: conv } = await db
        .from('conversations')
        .select('status')
        .eq('id', token.c)
        .eq('tenant_id', tenant.id)
        .maybeSingle();
      if (conv) {
        status = conv.status;
        const { data, error } = await db
          .from('messages')
          .select('id, role, content, created_at, metadata')
          .eq('conversation_id', token.c)
          .eq('tenant_id', tenant.id)
          .neq('role', 'system')
          .order('id', { ascending: false })
          .limit(50);
        if (error) throw new Error(`messages: ${error.message}`);
        messages = ((data ?? []) as MessageRow[]).reverse().map(publicMessage);
      }
    }

    return json(
      {
        config: {
          botName: tenant.settings.bot_name || tenant.name,
          welcome: tenant.settings.welcome_message || t(lang, 'welcome'),
          color: /^#[0-9a-fA-F]{6}$/.test(tenant.settings.color || '') ? tenant.settings.color : '#2563eb',
          locale: localeOf(lang),
          placeholder: t(lang, 'placeholder'),
          send: t(lang, 'send'),
          errorText: t(lang, 'error'),
        },
        status,
        messages,
      },
      200,
      true,
    );
  } catch (e) {
    return errorResponse(e, true);
  }
}
