import { requireActor } from '../../../../lib/auth.ts';
import { ApiError, errorResponse, json, readJson } from '../../../../lib/errors.ts';
import { enforce } from '../../../../lib/ratelimit.ts';
import { retrieve } from '../../../../lib/rag/retrieve.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// POST /api/kb/search  { query } — kërkim semantik në KB të tenant-it, pa thirrje te modeli
// gjenerues. Për administratorin: "çfarë do të gjente asistenti për këtë pyetje?"
export async function POST(req: Request): Promise<Response> {
  try {
    const actor = await requireActor(req, 'kb');
    await enforce(`kb:search:${actor.tenantId}`, 60, 3600);
    const body = await readJson(req, 5_000);
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query || query.length > 1000) throw new ApiError(400, 'invalid_query');
    const r = await retrieve(actor.tenantId, query);
    return json({
      results: r.chunks.map((c) => ({
        document_id: c.document_id,
        title: c.document_title,
        url: c.document_url ?? null,
        content: c.content,
        similarity: Number(c.similarity.toFixed(4)),
      })),
      dropped_low_relevance: r.dropped,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
