import { requireActor, requireOwner } from '../../../../../lib/auth.ts';
import { ApiError, errorResponse, isUuid, json, readJson } from '../../../../../lib/errors.ts';
import { deleteSource, sourceJobs, updateSource } from '../../../../../lib/kb/sources.ts';
import { enforce } from '../../../../../lib/ratelimit.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

async function sourceId(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  if (!isUuid(id)) throw new ApiError(404, 'source_not_found');
  return id;
}

// GET /api/kb/sources/<id> — job-et e fundit, ngjarjet dhe URL-të e dështuara (pa sekrete).
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = await requireActor(req, 'kb');
    await enforce(`kb:read:${actor.tenantId}`, 600, 3600);
    return json(await sourceJobs(actor.tenantId, await sourceId(ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}

// PATCH /api/kb/sources/<id>  { enabled?, exclude_patterns?, max_pages?, max_depth?, sync_interval_hours? }
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = await requireActor(req, 'kb');
    requireOwner(actor);
    await enforce(`kb:source:update:${actor.tenantId}`, 60, 3600);
    const body = await readJson(req, 20_000);
    return json(await updateSource(actor.tenantId, await sourceId(ctx), body));
  } catch (e) {
    return errorResponse(e);
  }
}

// DELETE /api/kb/sources/<id> — fshin burimin dhe të gjitha të dhënat e lidhura.
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = await requireActor(req, 'kb');
    requireOwner(actor);
    await deleteSource(actor.tenantId, await sourceId(ctx));
    return json({ deleted: true });
  } catch (e) {
    return errorResponse(e);
  }
}
