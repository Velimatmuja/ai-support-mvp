import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHistory, buildSystemPrompt, buildUserTurn, costUsd } from '../../src/lib/rag/generate.ts';
import type { MessageRow } from '../../src/lib/types.ts';

const row = (id: number, role: MessageRow['role'], content: string): MessageRow => ({ id, role, content, created_at: '' });

test('historiku alternon rolet dhe fillon me user', () => {
  const turns = buildHistory([
    row(1, 'assistant', 'mirësevini'),
    row(2, 'user', 'a'),
    row(3, 'user', 'b'),
    row(4, 'assistant', 'c'),
    row(5, 'agent', 'd'),
    row(6, 'system', 'shënim i brendshëm'),
    row(7, 'user', 'e'),
  ]);
  assert.deepEqual(turns, [
    { role: 'user', content: 'a\nb' },
    { role: 'assistant', content: 'c\nd' },
    { role: 'user', content: 'e' },
  ]);
});

test('historiku respekton buxhetin e karaktereve dhe mban fundin', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(i, i % 2 ? 'assistant' : 'user', `${i}`.padEnd(100, 'x')));
  const turns = buildHistory(rows, 450);
  assert.ok(turns.length <= 4);
  assert.equal(turns[0]!.role, 'user');
  assert.ok(turns[turns.length - 1]!.content.startsWith('19'));
});

test('historik bosh', () => {
  assert.deepEqual(buildHistory([]), []);
});

test('mesazhi i përdoruesit mban burimet e numëruara', () => {
  const text = buildUserTurn('sa kushton?', [
    { id: 7, document_id: 'd', document_title: 'Çmimet', content: 'Kafe 150 lekë', similarity: 0.8, score: 0.03 },
  ]);
  assert.ok(text.includes('[1] (Çmimet)\nKafe 150 lekë'));
  assert.ok(text.includes('<customer_message>\nsa kushton?\n</customer_message>'));
  assert.ok(buildUserTurn('x', []).includes('no matching documentation'));
});

test('system prompt: emri i biznesit dhe kufizimi i udhëzimeve të tenant-it', () => {
  const prompt = buildSystemPrompt({ name: 'Dyqani X', settings: { bot_name: 'Ana', extra_instructions: 'z'.repeat(5000) } });
  assert.ok(prompt.includes('You are Ana'));
  assert.ok(prompt.includes('"Dyqani X"'));
  assert.ok(prompt.length < 3500, 'udhëzimet e tenant-it duhet të priten në 1000 karaktere');
});

test('kostoja: Haiku 4.5 = $1 / $5 për 1M tokena', () => {
  assert.equal(costUsd('claude-haiku-4-5-20251001', 1_000_000, 0), 1);
  assert.equal(costUsd('claude-haiku-4-5-20251001', 2500, 200), 0.0035);
  assert.equal(costUsd('model-i-panjohur', 1000, 1000), 0);
});
