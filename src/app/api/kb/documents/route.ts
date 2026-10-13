import { requireActor } from '../../../../lib/auth.ts';
import { errorResponse, json } from '../../../../lib/errors.ts';
import { listDocuments } from '../../../../lib/kb/documents.ts';
import { enforce } from '../../../../lib/ratelimit.ts';

export const dynamic = 'force-dynamic';

// GET /api/kb/documents?source_id=<uuid|manual>&limit=&offset= — faqet e indeksuara dhe FAQ manuale.
export async function GET(req: Request): Promise<Response> {
  try {
    const actor = await requireActor(req, 'kb');
    await enforce(`kb:read:${actor.tenantId}`, 600, 3600);
    return json(await listDocuments(actor.tenantId, new URL(req.url).searchParams));
  } catch (e) {
    return errorResponse(e);
  }
}
