import { newApiKey, requireActor, requireOwner, userFromAccessToken } from '../../../../lib/auth.ts';
import { sha256Hex } from '../../../../lib/crypto.ts';
import { env } from '../../../../lib/env.ts';
import { ApiError, clientIp, errorResponse, json, readJson } from '../../../../lib/errors.ts';
import { postJson, UpstreamError } from '../../../../lib/http.ts';
import { enforce } from '../../../../lib/ratelimit.ts';
import { admin } from '../../../../lib/supabase/admin.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// POST /api/plugin/connect  { email, password, siteUrl? }
// Plugin-i WordPress lidhet me llogarinë: kredencialet verifikohen nga Supabase Auth
// (server-me-server), dhe plugin-i merr një çelës API me scope 'kb' + widget_key-n.
// Fjalëkalimi nuk ruhet askund; plugin-i ruan vetëm çelësin (i revokueshëm nga paneli).
export async function POST(req: Request): Promise<Response> {
  try {
    await enforce(`plugin:connect:ip:${clientIp(req)}`, 10, 3600);
    const body = await readJson(req, 5_000);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email) || !password || password.length > 200) {
      throw new ApiError(400, 'invalid_credentials_format');
    }
    // Kundër provës së fjalëkalimeve për një llogari nga shumë IP.
    await enforce(`plugin:connect:email:${sha256Hex(email)}`, 5, 900);

    let accessToken: string;
    try {
      const session = await postJson<{ access_token?: string }>(
        `${env('NEXT_PUBLIC_SUPABASE_URL')}/auth/v1/token?grant_type=password`,
        { email, password },
        { service: 'supabase-auth', headers: { apikey: env('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY') }, timeoutMs: 10_000, retries: 1 },
      );
      accessToken = session.access_token ?? '';
    } catch (e) {
      if (e instanceof UpstreamError && e.status < 500) throw new ApiError(401, 'invalid_credentials');
      throw e;
    }
    if (!accessToken) throw new ApiError(401, 'invalid_credentials');

    const user = await userFromAccessToken(accessToken);
    requireOwner(user);

    let host = 'WordPress';
    if (typeof body.siteUrl === 'string') {
      try {
        host = `WordPress: ${new URL(body.siteUrl).hostname}`.slice(0, 120);
      } catch {
        // emri është vetëm për shfaqje
      }
    }
    const db = admin();
    const { key, hash, prefix } = newApiKey();
    const { error: keyError } = await db
      .from('api_keys')
      .insert({ tenant_id: user.tenantId, created_by: user.userId, name: host, prefix, key_hash: hash, scopes: ['kb'] });
    if (keyError) throw new Error(`api_keys: ${keyError.message}`);

    const { data: tenant, error: tenantError } = await db
      .from('tenants')
      .select('name, widget_key')
      .eq('id', user.tenantId)
      .single();
    if (tenantError) throw new Error(`tenant: ${tenantError.message}`);

    return json({ apiKey: key, widgetKey: tenant.widget_key, tenantName: tenant.name }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}

// DELETE /api/plugin/connect   Authorization: Bearer ak_...  — plugin-i shkëputet: çelësi revokohet.
export async function DELETE(req: Request): Promise<Response> {
  try {
    const actor = await requireActor(req, 'kb');
    if (actor.via !== 'api_key' || !actor.apiKeyId) throw new ApiError(400, 'api_key_required');
    const { error } = await admin()
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', actor.apiKeyId)
      .eq('tenant_id', actor.tenantId);
    if (error) throw new Error(`revoke: ${error.message}`);
    return json({ revoked: true });
  } catch (e) {
    return errorResponse(e);
  }
}
