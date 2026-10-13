import { requireActor, requireOwner } from '../../../../../../lib/auth.ts';
import { ApiError, errorResponse, isUuid, json } from '../../../../../../lib/errors.ts';
import { verifySource } from '../../../../../../lib/kb/sources.ts';
import { enforce } from '../../../../../../lib/ratelimit.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// POST /api/kb/sources/<id>/verify — Kontrollon meta tag-un ose /.well-known/anesp-verification.txt; nëse gjendet, nis skanimin fillestar.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireActor(req, 'kb');
    requireOwner(actor);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new ApiError(404, 'source_not_found');
    await enforce(`kb:verify:${actor.tenantId}`, 20, 3600);
    return json(await verifySource(actor.tenantId, id));
  } catch (e) {
    return errorResponse(e);
  }
}
