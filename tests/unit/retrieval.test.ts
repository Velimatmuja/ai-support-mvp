import assert from 'node:assert/strict';
import { test } from 'node:test';
import { citationsFor } from '../../src/lib/pipeline.ts';
import { selectContext } from '../../src/lib/rag/retrieve.ts';
import type { RetrievedChunk } from '../../src/lib/rag/retrieve.ts';

const chunk = (id: number, similarity: number, extra: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  id, document_id: `d${id}`, document_title: `Doc ${id}`, content: 'x'.repeat(100), similarity, score: 1 / id, ...extra,
});
const cfg = { chunkMaxChars: 1200, chunkOverlapChars: 150, minSimilarity: 0.3, maxContextChunks: 3, maxContextChars: 250 };

test('relevanca e ulët hiqet; kufijtë e numrit dhe karaktereve të kontekstit zbatohen', () => {
  const { kept, dropped } = selectContext([chunk(1, 0.8), chunk(2, 0.1), chunk(3, 0.5), chunk(4, 0.6)], cfg);
  assert.deepEqual(kept.map((c) => c.id), [1, 3], '250 karaktere = 2 chunks prej 100');
  assert.equal(dropped, 2);
  assert.deepEqual(selectContext([chunk(1, 0.2), chunk(2, 0.29)], cfg).kept, [], 'asgjë relevante -> modeli merr "asnjë dokumentacion"');
  assert.equal(selectContext([chunk(1, 0.01)], { ...cfg, minSimilarity: 0 }).kept.length, 1, '0 = pa filtër');
});

test('referencat: vetëm faqe web me URL, pa dublikata, maksimumi 3', () => {
  const c = citationsFor([
    chunk(1, 0.9, { document_url: 'https://x.al/a', document_title: 'A' }),
    chunk(2, 0.9, { document_url: 'https://x.al/a', document_title: 'A' }),
    chunk(3, 0.9, { document_url: null, document_title: 'FAQ e brendshme' }),
    chunk(4, 0.9, { document_url: 'https://x.al/b', document_title: 'B' }),
    chunk(5, 0.9, { document_url: 'https://x.al/c', document_title: 'C' }),
    chunk(6, 0.9, { document_url: 'https://x.al/d', document_title: 'D' }),
  ]);
  assert.deepEqual(c, [
    { title: 'A', url: 'https://x.al/a' },
    { title: 'B', url: 'https://x.al/b' },
    { title: 'C', url: 'https://x.al/c' },
  ]);
});
