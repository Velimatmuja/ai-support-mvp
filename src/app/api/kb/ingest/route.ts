import { requireActor, requireOwner } from '../../../../lib/auth.ts';
import { ApiError, errorResponse, json, readJson } from '../../../../lib/errors.ts';
import { ingestDocument } from '../../../../lib/rag/ingest.ts';
import { enforce } from '../../../../lib/ratelimit.ts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/kb/ingest  { title, content }   Authorization: Bearer <access token | ak_...>
// Tekst -> chunks -> embeddings -> document_chunks. tenant_id vjen nga përdoruesi i
// verifikuar ose nga çelësi API, jo nga body. Burim opsional (FAQ, politika, çmime)
// krahas faqeve të website-it (/api/kb/sources).
export async function POST(req: Request): Promise<Response> {
  try {
    const user = await requireActor(req, 'kb');
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
