import { admin } from '../supabase/admin.ts';
import { ApiError } from '../errors.ts';
import { sha256Hex } from '../crypto.ts';
import { kbConfig } from '../kb/config.ts';
import { recordEmbeddingUsage, replaceChunks, tenantChunkCount } from '../kb/store.ts';
import { chunkText } from './chunk.ts';

// Dokumente manuale (FAQ, politika, çmime): burim opsional, krahas faqeve të website-it.
// Kufiri i chunks vjen nga plani i tenant-it (tenants.max_kb_chunks).
export const MAX_DOC_CHARS = 200_000;

export type IngestResult = { documentId: string; chunks: number; embeddingTokens: number };

export async function ingestDocument(args: { tenantId: string; title: string; content: string }): Promise<IngestResult> {
  const { tenantId } = args;
  const title = args.title.trim().slice(0, 200);
  const content = args.content.trim();
  if (!title) throw new ApiError(400, 'title_required');
  if (content.length < 20) throw new ApiError(400, 'content_too_short');
  if (content.length > MAX_DOC_CHARS) throw new ApiError(413, 'content_too_long', `Maksimumi ${MAX_DOC_CHARS} karaktere për dokument.`);

  const db = admin();
  const cfg = kbConfig();
  const chunks = chunkText(content, { maxChars: cfg.chunkMaxChars, overlapChars: cfg.chunkOverlapChars });

  const { data: tenant, error: tenantError } = await db.from('tenants').select('max_kb_chunks').eq('id', tenantId).single();
  if (tenantError) throw new Error(`tenant: ${tenantError.message}`);
  if ((await tenantChunkCount(db, tenantId)) + chunks.length > tenant.max_kb_chunks) {
    throw new ApiError(409, 'kb_limit_reached', 'Knowledge base ka arritur kufirin e planit.');
  }

  const { data: kb, error: kbError } = await db
    .from('knowledge_bases')
    .select('id')
    .eq('tenant_id', tenantId)
    .order('created_at')
    .limit(1)
    .single();
  if (kbError) throw new Error(`knowledge base: ${kbError.message}`);

  const { data: doc, error: docError } = await db
    .from('documents')
    .insert({
      tenant_id: tenantId,
      knowledge_base_id: kb.id,
      title,
      source_type: 'text',
      status: 'processing',
      content_hash: sha256Hex(content),
      char_count: content.length,
    })
    .select('id')
    .single();
  if (docError) {
    if (docError.code === '23505') throw new ApiError(409, 'duplicate_document', 'Ky dokument është ngarkuar tashmë.');
    throw new Error(`insert document: ${docError.message}`);
  }

  try {
    const stored = await replaceChunks(db, { tenantId, knowledgeBaseId: kb.id, documentId: doc.id, chunks });

    const { error: readyError } = await db
      .from('documents')
      .update({ status: 'ready', chunk_count: chunks.length, indexed_at: new Date().toISOString() })
      .eq('id', doc.id)
      .eq('tenant_id', tenantId);
    if (readyError) throw new Error(`update document: ${readyError.message}`);

    await recordEmbeddingUsage(db, tenantId, stored.model, stored.tokens);
    return { documentId: doc.id, chunks: chunks.length, embeddingTokens: stored.tokens };
  } catch (e) {
    // Mos lër dokument gjysmak që mund të kërkohet: fshije (chunks ikin me cascade).
    await db.from('documents').delete().eq('id', doc.id).eq('tenant_id', tenantId);
    throw e;
  }
}
