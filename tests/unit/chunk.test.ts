import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkText } from '../../src/lib/rag/chunk.ts';

test('tekst bosh -> asnjë chunk', () => {
  assert.deepEqual(chunkText('   \n\n  '), []);
});

test('tekst i shkurtër -> një chunk i pandryshuar', () => {
  assert.deepEqual(chunkText('Orari: 9-17.\n\nDërgesa falas mbi 3000 lekë.'), [
    'Orari: 9-17.\n\nDërgesa falas mbi 3000 lekë.',
  ]);
});

test('asnjë chunk nuk e kalon maksimumin dhe asnjë fjalë nuk humbet', () => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragrafi ${i}. ` + `fjala${i} `.repeat(30).trim() + '.');
  const chunks = chunkText(paragraphs.join('\n\n'), { maxChars: 500, overlapChars: 60 });
  assert.ok(chunks.length > 10);
  for (const c of chunks) assert.ok(c.length <= 500, `chunk ${c.length} > 500`);
  const joined = chunks.join(' ');
  for (let i = 0; i < 40; i++) assert.ok(joined.includes(`Paragrafi ${i}.`), `mungon paragrafi ${i}`);
});

test('paragraf shumë i gjatë ndahet në fjali', () => {
  const long = Array.from({ length: 30 }, (_, i) => `Kjo është fjalia numër ${i} e një paragrafi të gjatë.`).join(' ');
  const chunks = chunkText(long, { maxChars: 300, overlapChars: 0 });
  assert.equal(chunks.join(' '), long, 'pa mbivendosje, bashkimi duhet të japë tekstin origjinal');
  assert.ok(chunks.length > 3);
  for (const c of chunks) {
    assert.ok(c.length <= 300);
    assert.ok(c.endsWith('.'), `chunk nuk mbaron në fund fjalie: "${c.slice(-30)}"`);
  }
});

test('tekst pa pikësim (p.sh. listë çmimesh) pritet te hapësirat', () => {
  const chunks = chunkText('produkt '.repeat(500), { maxChars: 200, overlapChars: 0 });
  for (const c of chunks) {
    assert.ok(c.length <= 200);
    assert.ok(!c.startsWith('rodukt'), 'fjalë e prerë në mes');
  }
});

test('paragraf i ndarë: vazhdimi mbart fundin e pjesës së mëparshme (mbivendosje)', () => {
  const long = Array.from({ length: 30 }, (_, i) => `Fjalia ${i} e paragrafit.`).join(' ');
  const chunks = chunkText(long, { maxChars: 200, overlapChars: 40 });
  assert.ok(chunks.length > 2);
  for (let i = 1; i < chunks.length; i++) {
    const firstWords = chunks[i]!.split(' ').slice(0, 3).join(' ');
    assert.ok(chunks[i - 1]!.includes(firstWords), `chunk ${i} nuk fillon me fundin e chunk ${i - 1}`);
    assert.ok(chunks[i]!.length <= 200);
  }
});

test('paragrafë të ndryshëm: pa mbivendosje midis temave', () => {
  const a = 'A '.repeat(100).trim() + ' FUNDI_I_PARE';
  const b = 'B '.repeat(100).trim();
  const chunks = chunkText(`${a}\n\n${b}`, { maxChars: 260, overlapChars: 40 });
  assert.equal(chunks.length, 2);
  assert.ok(!chunks[1]!.includes('FUNDI_I_PARE'));
  assert.ok(chunks[1]!.startsWith('B B'));
});

test('normalizon CRLF dhe rreshta bosh të tepërt', () => {
  assert.deepEqual(chunkText('a\r\n\r\n\r\n\r\nb'), ['a\n\nb']);
});
