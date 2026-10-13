import { envOr } from '../env.ts';

// Parametrat e Knowledge Base që varen nga ofruesi/modeli: nuk hardcode-hen në kod.
export type KbConfig = {
  chunkMaxChars: number;
  chunkOverlapChars: number;
  // Nën këtë similarity (kosinus) një chunk nuk i dërgohet modelit. 0 = pa filtër.
  minSimilarity: number;
  // Sa chunks dhe sa karaktere konteksti i dërgohen modelit për një pyetje.
  maxContextChunks: number;
  maxContextChars: number;
};

function num(name: string, fallback: number, min: number, max: number): number {
  const n = Number(envOr(name, String(fallback)));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

export function kbConfig(): KbConfig {
  const chunkMaxChars = Math.round(num('KB_CHUNK_MAX_CHARS', 1200, 300, 8000));
  return {
    chunkMaxChars,
    chunkOverlapChars: Math.round(num('KB_CHUNK_OVERLAP_CHARS', 150, 0, chunkMaxChars / 2)),
    minSimilarity: num('KB_MIN_SIMILARITY', 0.25, 0, 1),
    maxContextChunks: Math.round(num('KB_MAX_CONTEXT_CHUNKS', 6, 1, 20)),
    maxContextChars: Math.round(num('KB_MAX_CONTEXT_CHARS', 8000, 1000, 40000)),
  };
}
