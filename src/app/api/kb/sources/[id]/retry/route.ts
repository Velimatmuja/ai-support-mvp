import { requireActor, requireOwner } from '../../../../../../lib/auth.ts';
import { ApiError, errorResponse, isUuid, json } from '../../../../../../lib/errors.ts';
import { retrySource } from '../../../../../../lib/kb/sources.ts';
import { enforce } from '../../../../../../lib/ratelimit.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// POST /api/kb/sources/<id>/retry — Rifillon job-in e fundit të dështuar ose URL-të e tij të dështuara.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireActor(req, 'kb');
    requireOwner(actor);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new ApiError(404, 'source_not_found');
    await enforce(`kb:retry:${actor.tenantId}`, 20, 3600);
    return json(await retrySource(actor.tenantId, id));
  } catch (e) {
    return errorResponse(e);
  }
}
