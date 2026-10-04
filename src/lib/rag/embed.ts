import { env, envOr } from '../env.ts';
import { postJson } from '../http.ts';

// Anthropic nuk ka API embeddings. Voyage (voyage-4-lite) është shumëgjuhësh
// (i nevojshëm për shqip) dhe lejon 512 dimensione: gjysma e hapësirës në DB
// krahasuar me 1024, që ka rëndësi në planin falas të Supabase (500 MB).
export const EMBEDDING_DIM = 512;
const BATCH = 64;

type VoyageResponse = {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
};

export type EmbedResult = { embeddings: number[][]; tokens: number; model: string };

export async function embed(texts: string[], inputType: 'document' | 'query'): Promise<EmbedResult> {
  const model = envOr('VOYAGE_MODEL', 'voyage-4-lite');
  const base = envOr('VOYAGE_BASE_URL', 'https://api.voyageai.com');
  const embeddings: number[][] = [];
  let tokens = 0;

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await postJson<VoyageResponse>(
      `${base}/v1/embeddings`,
      { model, input: batch, input_type: inputType, output_dimension: EMBEDDING_DIM },
      { service: 'voyage', headers: { authorization: `Bearer ${env('VOYAGE_API_KEY')}` }, timeoutMs: 20_000, retries: 2 },
    );
    const sorted = [...res.data].sort((a, b) => a.index - b.index);
    if (sorted.length !== batch.length) throw new Error('voyage: numër i papritur embeddings');
    for (const row of sorted) {
      if (row.embedding.length !== EMBEDDING_DIM) throw new Error('voyage: dimension i papritur');
      embeddings.push(row.embedding);
    }
    tokens += res.usage?.total_tokens ?? 0;
  }
  return { embeddings, tokens, model };
}

// Formati tekstual i pgvector: '[0.1,0.2,...]'.
export function toVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
