import { requireActor, requireOwner } from '../../../../lib/auth.ts';
import { errorResponse, json, readJson } from '../../../../lib/errors.ts';
import { createSource, listSources } from '../../../../lib/kb/sources.ts';
import { enforce } from '../../../../lib/ratelimit.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// GET /api/kb/sources — burimet e tenant-it me statusin dhe numëruesit e job-it të fundit.
// Authorization: Bearer <access token i panelit> ose Bearer ak_... (plugin-i WordPress).
export async function GET(req: Request): Promise<Response> {
  try {
    const actor = await requireActor(req, 'kb');
    await enforce(`kb:read:${actor.tenantId}`, 600, 3600);
    return json({ sources: await listSources(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/kb/sources  { url, max_pages?, max_depth?, exclude_patterns?, sync_interval_hours? }
// Regjistron website-in. Skanimi fillestar nis pas verifikimit të pronësisë.
export async function POST(req: Request): Promise<Response> {
  try {
    const actor = await requireActor(req, 'kb');
    requireOwner(actor);
    await enforce(`kb:source:create:${actor.tenantId}`, 20, 3600);
    const body = await readJson(req, 20_000);
    return json(await createSource(actor.tenantId, body), 201);
  } catch (e) {
    return errorResponse(e);
  }
}
