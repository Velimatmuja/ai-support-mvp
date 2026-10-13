import { createHash } from 'node:crypto';
import { admin } from '../supabase/admin.ts';
import { kbConfig } from '../kb/config.ts';
import { embed, embeddingModel, toVector } from './embed.ts';

export type RetrievedChunk = {
  id: number;
  document_id: string;
  document_title: string;
  document_url?: string | null;
  content: string;
  similarity: number;
  score: number;
  fts_match?: boolean;
};

export type Retrieval = { chunks: RetrievedChunk[]; embeddingTokens: number; dropped: number; cached: boolean };

// Cache i embedding-ut të pyetjes, në memorien e instancës. I sigurt: vektori varet
// vetëm nga teksti dhe modeli (jo nga KB), ndaj nuk vjetrohet kur KB ndryshon dhe
// nuk mban përgjigje. Pyetjet e përsëritura ("orari?") nuk paguajnë Voyage sërish.
// Përgjigjet e AI NUK ruhen në cache: varen nga historiku i bisedës dhe nga KB.
const CACHE_MAX = 500;
const CACHE_TTL_MS = 3600_000;
const cache = new Map<string, { vector: string; at: number }>();

function cacheKey(tenantId: string, text: string): string {
  return createHash('sha256').update(`${embeddingModel()}\u0000${tenantId}\u0000${text.trim().toLowerCase()}`).digest('hex');
}

async function queryVector(tenantId: string, text: string): Promise<{ vector: string; tokens: number; cached: boolean }> {
  const key = cacheKey(tenantId, text);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    cache.delete(key);
    cache.set(key, hit); // LRU: i përdoruri së fundmi shkon në fund
    return { vector: hit.vector, tokens: 0, cached: true };
  }
  const { embeddings, tokens } = await embed([text], 'query');
  const vector = toVector(embeddings[0]!);
  cache.set(key, { vector, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return { vector, tokens, cached: false };
}

export function clearQueryCache(): void {
  cache.clear();
}

// Mban chunks mjaftueshëm të ngjashëm me pyetjen, brenda kufijve të kontekstit.
// Me relevancë të ulët modeli merr "asnjë dokumentacion" dhe thotë që nuk e di,
// në vend që të ndërtojë përgjigje mbi tekst pa lidhje.
export function selectContext(chunks: RetrievedChunk[], cfg = kbConfig()): { kept: RetrievedChunk[]; dropped: number } {
  const kept: RetrievedChunk[] = [];
  let chars = 0;
  for (const c of chunks) {
    if (c.similarity < cfg.minSimilarity) continue;
    if (kept.length >= cfg.maxContextChunks || chars + c.content.length > cfg.maxContextChars) break;
    kept.push(c);
    chars += c.content.length;
  }
  return { kept, dropped: chunks.length - kept.length };
}

// Kërkim hibrid (vektor + full-text) brenda NJË tenant-i. tenantId vjen gjithmonë
// nga thirrësi i besuar; funksioni SQL filtron me të përpara çdo renditjeje dhe
// përjashton burimet/dokumentet e çaktivizuara.
export async function retrieve(tenantId: string, query: string, matchCount?: number): Promise<Retrieval> {
  const cfg = kbConfig();
  const { vector, tokens, cached } = await queryVector(tenantId, query.slice(0, 2000));
  const { data, error } = await admin().rpc('match_chunks', {
    p_tenant_id: tenantId,
    p_query_embedding: vector,
    p_query_text: query.slice(0, 500),
    p_match_count: matchCount ?? cfg.maxContextChunks,
  });
  if (error) throw new Error(`match_chunks: ${error.message}`);
  const { kept, dropped } = selectContext((data ?? []) as RetrievedChunk[], cfg);
  return { chunks: kept, embeddingTokens: tokens, dropped, cached };
}
