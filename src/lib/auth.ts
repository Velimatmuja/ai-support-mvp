import { admin } from './supabase/admin.ts';
import { ApiError } from './errors.ts';
import { randomToken, sha256Hex } from './crypto.ts';

export type SessionUser = { userId: string; tenantId: string; role: 'owner' | 'agent' };

// Autorizimi i panelit: Bearer <access token i Supabase Auth>.
// 1) Supabase Auth verifikon tokenin. 2) tenant_id lexohet nga tabela users me
// id-në e verifikuar. Asgjë nga body ose nga user_metadata nuk përdoret për autorizim.
export async function requireUser(req: Request): Promise<SessionUser> {
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new ApiError(401, 'unauthorized');
  return userFromAccessToken(token);
}

export async function userFromAccessToken(token: string): Promise<SessionUser> {
  const db = admin();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, 'unauthorized');

  const { data: row, error: rowError } = await db
    .from('users')
    .select('tenant_id, role')
    .eq('id', data.user.id)
    .maybeSingle();
  if (rowError) throw new Error(`users: ${rowError.message}`);
  if (!row) throw new ApiError(403, 'no_tenant');

  return { userId: data.user.id, tenantId: row.tenant_id, role: row.role };
}

export function requireOwner(user: SessionUser): void {
  if (user.role !== 'owner') throw new ApiError(403, 'owner_only');
}

// ---------------------------------------------------------------------------
// Çelësa API (server-me-server, p.sh. plugin-i WordPress).
// Formati: ak_<64 hex>. Në DB ruhet vetëm SHA-256; tenant_id vjen nga rreshti i
// çelësit (burim i besuar), kurrë nga kërkesa. Një çelës ka vetëm scope-t e veta.
// ---------------------------------------------------------------------------
const API_KEY_RE = /^ak_[a-f0-9]{64}$/;

export type Actor = SessionUser & { via: 'session' | 'api_key'; apiKeyId: string | null };

export function newApiKey(): { key: string; hash: string; prefix: string } {
  const key = `ak_${randomToken(32)}`;
  return { key, hash: sha256Hex(key), prefix: key.slice(0, 11) };
}

async function actorFromApiKey(key: string, scope: string): Promise<Actor> {
  const db = admin();
  const { data, error } = await db
    .from('api_keys')
    .select('id, tenant_id, scopes, revoked_at, created_by, last_used_at')
    .eq('key_hash', sha256Hex(key))
    .maybeSingle();
  if (error) throw new Error(`api_keys: ${error.message}`);
  if (!data || data.revoked_at) throw new ApiError(401, 'unauthorized');
  if (!(data.scopes as string[]).includes(scope)) throw new ApiError(403, 'scope_missing');

  // last_used_at: një shkrim në 5 minuta mjafton për "aktiv së fundmi".
  if (!data.last_used_at || Date.now() - new Date(data.last_used_at).getTime() > 300_000) {
    await db.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).eq('tenant_id', data.tenant_id);
  }
  return { userId: data.created_by ?? '', tenantId: data.tenant_id, role: 'owner', via: 'api_key', apiKeyId: data.id };
}

// Pranon sesionin e panelit OSE një çelës API me scope-in e kërkuar.
export async function requireActor(req: Request, scope: 'kb'): Promise<Actor> {
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new ApiError(401, 'unauthorized');
  if (token.startsWith('ak_')) {
    if (!API_KEY_RE.test(token)) throw new ApiError(401, 'unauthorized');
    return actorFromApiKey(token, scope);
  }
  const user = await userFromAccessToken(token);
  return { ...user, via: 'session', apiKeyId: null };
}
