import { admin } from '../supabase/admin.ts';
import { embed, toVector } from './embed.ts';

export type RetrievedChunk = {
  id: number;
  document_id: string;
  document_title: string;
  content: string;
  similarity: number;
  score: number;
};

export type Retrieval = { chunks: RetrievedChunk[]; embeddingTokens: number };

// Kërkim hibrid (vektor + full-text) brenda NJË tenant-i. tenantId vjen gjithmonë
// nga thirrësi i besuar; funksioni SQL filtron me të përpara çdo renditjeje.
export async function retrieve(tenantId: string, query: string, matchCount = 6): Promise<Retrieval> {
  const { embeddings, tokens } = await embed([query.slice(0, 2000)], 'query');
  const { data, error } = await admin().rpc('match_chunks', {
    p_tenant_id: tenantId,
    p_query_embedding: toVector(embeddings[0]!),
    p_query_text: query.slice(0, 500),
    p_match_count: matchCount,
  });
  if (error) throw new Error(`match_chunks: ${error.message}`);
  return { chunks: (data ?? []) as RetrievedChunk[], embeddingTokens: tokens };
}
