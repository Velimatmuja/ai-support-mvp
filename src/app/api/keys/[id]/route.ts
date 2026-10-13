import { requireOwner, requireUser } from '../../../../lib/auth.ts';
import { ApiError, errorResponse, isUuid, json } from '../../../../lib/errors.ts';
import { admin } from '../../../../lib/supabase/admin.ts';

export const dynamic = 'force-dynamic';

// DELETE /api/keys/<id>  — pronari revokon një çelës API (p.sh. plugin i një site-i të vjetër).
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await requireUser(req);
    requireOwner(user);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new ApiError(404, 'key_not_found');
    const { data, error } = await admin()
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('tenant_id', user.tenantId)
      .is('revoked_at', null)
      .select('id');
    if (error) throw new Error(`revoke: ${error.message}`);
    if (!data?.length) throw new ApiError(404, 'key_not_found');
    return json({ revoked: true });
  } catch (e) {
    return errorResponse(e);
  }
}
