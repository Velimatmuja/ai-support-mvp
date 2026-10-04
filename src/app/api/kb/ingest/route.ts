import { requireOwner, requireUser } from '../../../../lib/auth.ts';
import { ApiError, errorResponse, json, readJson } from '../../../../lib/errors.ts';
import { ingestDocument } from '../../../../lib/rag/ingest.ts';
import { enforce } from '../../../../lib/ratelimit.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/kb/ingest  { title, content }   Authorization: Bearer <access token>
// Tekst -> chunks -> embeddings -> document_chunks. tenant_id vjen nga përdoruesi i
// verifikuar, jo nga body. MVP: vetëm tekst i ngjitur (FAQ, politika, çmime);
// PDF/URL shtohen më vonë si hapa që prodhojnë tekst para kësaj rruge.
export async function POST(req: Request): Promise<Response> {
  try {
    const user = await requireUser(req);
    requireOwner(user);
    await enforce(`kb:ingest:${user.tenantId}`, 30, 3600);

    const body = await readJson(req, 1_000_000);
    if (typeof body.title !== 'string' || typeof body.content !== 'string') {
      throw new ApiError(400, 'title_and_content_required');
    }
    const result = await ingestDocument({ tenantId: user.tenantId, title: body.title, content: body.content });
    return json(result, 201);
  } catch (e) {
    return errorResponse(e);
  }
}
