import { env, envOr } from '../env.ts';
import { postJson } from '../http.ts';

// Shtresë e vogël abstraksioni për ofruesin e embeddings. Sot: Voyage (voyage-4-lite,
// shumëgjuhësh, i nevojshëm për shqip; 512 dimensione = gjysma e hapësirës në DB
// krahasuar me 1024). Një ofrues i ri shtohet te `providers` me të njëjtin interfejs;
// dimensioni duhet të përputhet me kolonën vector(512) — ndryshimi i tij kërkon migrim
// dhe ri-indeksim të plotë.
export const EMBEDDING_DIM = 512;

export type InputType = 'document' | 'query';
export type EmbedResult = { embeddings: number[][]; tokens: number; model: string };

type Provider = {
  model: () => string;
  batch: number;
  call: (texts: string[], inputType: InputType, model: string) => Promise<{ vectors: number[][]; tokens: number }>;
};

type VoyageResponse = {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
};

const providers: Record<string, Provider> = {
  voyage: {
    model: () => envOr('VOYAGE_MODEL', 'voyage-4-lite'),
    batch: 64,
    async call(texts, inputType, model) {
      const res = await postJson<VoyageResponse>(
        `${envOr('VOYAGE_BASE_URL', 'https://api.voyageai.com')}/v1/embeddings`,
        { model, input: texts, input_type: inputType, output_dimension: EMBEDDING_DIM },
        { service: 'voyage', headers: { authorization: `Bearer ${env('VOYAGE_API_KEY')}` }, timeoutMs: 20_000, retries: 2 },
      );
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      return { vectors: sorted.map((r) => r.embedding), tokens: res.usage?.total_tokens ?? 0 };
    },
  },
};

function provider(): Provider {
  const name = envOr('EMBEDDING_PROVIDER', 'voyage');
  const p = providers[name];
  if (!p) throw new Error(`EMBEDDING_PROVIDER i panjohur: ${name}`);
  return p;
}

export function embeddingModel(): string {
  return provider().model();
}

export async function embed(texts: string[], inputType: InputType): Promise<EmbedResult> {
  const p = provider();
  const model = p.model();
  const embeddings: number[][] = [];
  let tokens = 0;

  for (let i = 0; i < texts.length; i += p.batch) {
    const batch = texts.slice(i, i + p.batch);
    const res = await p.call(batch, inputType, model);
    if (res.vectors.length !== batch.length) throw new Error('embeddings: numër i papritur vektorësh');
    for (const v of res.vectors) {
      if (v.length !== EMBEDDING_DIM) throw new Error('embeddings: dimension i papritur');
      embeddings.push(v);
    }
    tokens += res.tokens;
  }
  return { embeddings, tokens, model };
}

// Formati tekstual i pgvector: '[0.1,0.2,...]'.
export function toVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
