import { requireActor, requireOwner } from '../../../../../lib/auth.ts';
import { errorResponse, json, readJson } from '../../../../../lib/errors.ts';
import { deleteDocument, updateDocument } from '../../../../../lib/kb/documents.ts';
import { enforce } from '../../../../../lib/ratelimit.ts';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/kb/documents/<id>  { enabled } — një faqe/FAQ e çaktivizuar nuk përdoret në përgjigje
// dhe mbetet e çaktivizuar edhe pas riskanimeve.
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = await requireActor(req, 'kb');
    requireOwner(actor);
    await enforce(`kb:doc:update:${actor.tenantId}`, 300, 3600);
    const { id } = await ctx.params;
    return json(await updateDocument(actor.tenantId, id, await readJson(req, 2_000)));
  } catch (e) {
    return errorResponse(e);
  }
}

// DELETE /api/kb/documents/<id> — fshin dokumentin dhe chunks e tij. Për një faqe web që nuk
// duhet rikthyer në riskanim, përdor exclude_patterns te burimi.
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = await requireActor(req, 'kb');
    requireOwner(actor);
    const { id } = await ctx.params;
    await deleteDocument(actor.tenantId, id);
    return json({ deleted: true });
  } catch (e) {
    return errorResponse(e);
  }
}
