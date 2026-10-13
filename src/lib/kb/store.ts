import type { SupabaseClient } from '@supabase/supabase-js';
import { sha256Hex } from '../crypto.ts';
import { embed, toVector } from '../rag/embed.ts';

export type StoreResult = { embedded: number; reused: number; tokens: number; model: string | null };

// Shkruan chunks e një dokumenti. Chunks me tekst identik me ato që dokumenti ka
// tashmë ripërdorin embedding-un ekzistues: një faqe që ndryshon vetëm në një
// paragraf paguan embeddings vetëm për atë paragraf.
//
// Rendi (fut të rejat -> fshi të vjetrat) e mban dokumentin të kërkueshëm gjatë
// gjithë kohës; nëse procesi ndërpritet në mes, rindeksimi i radhës i pastron.
export async function replaceChunks(
  db: SupabaseClient,
  args: { tenantId: string; knowledgeBaseId: string; documentId: string; chunks: string[] },
): Promise<StoreResult> {
  const { tenantId, knowledgeBaseId, documentId, chunks } = args;

  const { data: old, error: oldError } = await db
    .from('document_chunks')
    .select('id, content_hash, embedding')
    .eq('document_id', documentId)
    .eq('tenant_id', tenantId);
  if (oldError) throw new Error(`old chunks: ${oldError.message}`);
  const reusable = new Map<string, string>();
  for (const c of (old ?? []) as { content_hash: string | null; embedding: string }[]) {
    if (c.content_hash && !reusable.has(c.content_hash)) reusable.set(c.content_hash, c.embedding);
  }

  const hashes = chunks.map((c) => sha256Hex(c));
  const missing = chunks.map((_, i) => i).filter((i) => !reusable.has(hashes[i]!));
  let tokens = 0;
  let model: string | null = null;
  const fresh = new Map<number, string>();
  if (missing.length) {
    const res = await embed(missing.map((i) => chunks[i]!), 'document');
    missing.forEach((chunkIndex, j) => fresh.set(chunkIndex, toVector(res.embeddings[j]!)));
    tokens = res.tokens;
    model = res.model;
  }

  const rows = chunks.map((content, i) => ({
    tenant_id: tenantId,
    knowledge_base_id: knowledgeBaseId,
    document_id: documentId,
    chunk_index: i,
    content,
    content_hash: hashes[i],
    embedding: fresh.get(i) ?? reusable.get(hashes[i]!)!,
  }));
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await db.from('document_chunks').insert(rows.slice(i, i + 100));
    if (error) throw new Error(`insert chunks: ${error.message}`);
  }

  const oldIds = ((old ?? []) as { id: number }[]).map((c) => c.id);
  for (let i = 0; i < oldIds.length; i += 200) {
    const { error } = await db
      .from('document_chunks')
      .delete()
      .in('id', oldIds.slice(i, i + 200))
      .eq('tenant_id', tenantId);
    if (error) throw new Error(`delete old chunks: ${error.message}`);
  }

  return { embedded: missing.length, reused: chunks.length - missing.length, tokens, model };
}

// Ledger: tokenat e embeddings regjistrohen me vlerën që ktheu ofruesi.
export async function recordEmbeddingUsage(db: SupabaseClient, tenantId: string, model: string | null, tokens: number): Promise<void> {
  if (!model || tokens <= 0) return;
  const { error } = await db.from('usage_events').insert({ tenant_id: tenantId, event_type: 'embedding', model, input_tokens: tokens });
  if (error) console.error('[kb] usage_events', error.message);
}

// Sa chunks ka tenant-i gjithsej (për kufirin e planit).
export async function tenantChunkCount(db: SupabaseClient, tenantId: string): Promise<number> {
  const { count, error } = await db
    .from('document_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`count chunks: ${error.message}`);
  return count ?? 0;
}
