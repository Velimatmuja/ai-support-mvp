import { admin } from '../supabase/admin.ts';
import { ApiError } from '../errors.ts';
import { sha256Hex } from '../crypto.ts';
import { chunkText } from './chunk.ts';
import { embed, toVector } from './embed.ts';

// Kufij për pilotin. 2000 chunks x (512 float4 + tekst + indeks FTS) ≈ 8-10 MB për
// tenant -> 50 tenant-ë ≈ 0.5 GB në rastin më të keq, pra kufiri i planit falas.
// Në praktikë një FAQ + politika e një SMB-je është 20-200 chunks.
export const MAX_DOC_CHARS = 200_000;
export const MAX_CHUNKS_PER_TENANT = 2_000;

export type IngestResult = { documentId: string; chunks: number; embeddingTokens: number };

export async function ingestDocument(args: { tenantId: string; title: string; content: string }): Promise<IngestResult> {
  const { tenantId } = args;
  const title = args.title.trim().slice(0, 200);
  const content = args.content.trim();
  if (!title) throw new ApiError(400, 'title_required');
  if (content.length < 20) throw new ApiError(400, 'content_too_short');
  if (content.length > MAX_DOC_CHARS) throw new ApiError(413, 'content_too_long', `Maksimumi ${MAX_DOC_CHARS} karaktere për dokument.`);

  const db = admin();
  const chunks = chunkText(content);

  const { count, error: countError } = await db
    .from('document_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  if (countError) throw new Error(`count chunks: ${countError.message}`);
  if ((count ?? 0) + chunks.length > MAX_CHUNKS_PER_TENANT) {
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
    const { embeddings, tokens, model } = await embed(chunks, 'document');
    const rows = chunks.map((text, i) => ({
      tenant_id: tenantId,
      knowledge_base_id: kb.id,
      document_id: doc.id,
      chunk_index: i,
      content: text,
      embedding: toVector(embeddings[i]!),
    }));
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await db.from('document_chunks').insert(rows.slice(i, i + 100));
      if (error) throw new Error(`insert chunks: ${error.message}`);
    }

    const { error: readyError } = await db
      .from('documents')
      .update({ status: 'ready', chunk_count: chunks.length })
      .eq('id', doc.id)
      .eq('tenant_id', tenantId);
    if (readyError) throw new Error(`update document: ${readyError.message}`);

    const { error: usageError } = await db.from('usage_events').insert({
      tenant_id: tenantId,
      event_type: 'embedding',
      model,
      input_tokens: tokens,
    });
    if (usageError) console.error('[ingest] usage_events', usageError.message);

    return { documentId: doc.id, chunks: chunks.length, embeddingTokens: tokens };
  } catch (e) {
    // Mos lër dokument gjysmak që mund të kërkohet: fshije (chunks ikin me cascade).
    await db.from('documents').delete().eq('id', doc.id).eq('tenant_id', tenantId);
    throw e;
  }
}
