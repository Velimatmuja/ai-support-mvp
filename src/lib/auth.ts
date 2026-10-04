import { admin } from './supabase/admin.ts';
import { ApiError } from './errors.ts';

export type SessionUser = { userId: string; tenantId: string; role: 'owner' | 'agent' };

// Autorizimi i panelit: Bearer <access token i Supabase Auth>.
// 1) Supabase Auth verifikon tokenin. 2) tenant_id lexohet nga tabela users me
// id-në e verifikuar. Asgjë nga body ose nga user_metadata nuk përdoret për autorizim.
export async function requireUser(req: Request): Promise<SessionUser> {
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new ApiError(401, 'unauthorized');

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
