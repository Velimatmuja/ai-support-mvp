// Test end-to-end: route handlers realë -> supabase client -> PostgREST -> Postgres,
// me shërbimet e jashtme të imituara (mocks.ts). Nisja: bash scripts/e2e.sh
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { calls, startMocks, userJwt, USERS } from './mocks.ts';

const REST_PORT = Number(process.env.E2E_REST_PORT);
const MOCK_PORT = 54341;
const APP_PORT = 54342;
const SITE_PORT = 54343;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function serviceJwt(): string {
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${body}.${createHmac('sha256', process.env.E2E_JWT_SECRET!).update(body).digest('base64url')}`;
}

Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: MOCK,
  SUPABASE_SECRET_KEY: serviceJwt(),
  ANTHROPIC_BASE_URL: MOCK,
  ANTHROPIC_API_KEY: 'sk-ant-test',
  VOYAGE_BASE_URL: MOCK,
  VOYAGE_API_KEY: 'pa-test',
  TELEGRAM_API_BASE: MOCK,
  LANGFUSE_BASE_URL: MOCK,
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  WIDGET_TOKEN_SECRET: 'w'.repeat(64),
  CHANNEL_ENCRYPTION_KEY: 'ab'.repeat(32),
  APP_URL: APP,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  // Crawler: host-et e testit drejtohen te serveri lokal (vetëm jashtë production).
  CRAWLER_DEV_HOST_MAP: JSON.stringify({ 'alba.test': `127.0.0.1:${SITE_PORT}`, 'www.alba.test': `127.0.0.1:${SITE_PORT}`, 'beta.test': `127.0.0.1:${SITE_PORT}` }),
  CRAWLER_MIN_DELAY_MS: '0',
  CRAWLER_TIMEOUT_MS: '1000',
  CRAWLER_MAX_ATTEMPTS: '2',
  CRAWLER_RETRY_BASE_MS: '50',
  CRAWLER_TICK_BUDGET_MS: '5000',
  CRON_SECRET: 'cron-secret-for-e2e-tests',
  // Embeddings e imituara (bashkësi fjalësh) kanë similarity më të ulët se Voyage.
  KB_MIN_SIMILARITY: '0.05',
});

// ---------------------------------------------------------------------------
// Server i vogël që bën atë që bën Next.js: rrugë -> route handler.
// ---------------------------------------------------------------------------
const ROUTES: { re: RegExp; file: string; param?: string }[] = [
  { re: /^\/api\/widget\/session$/, file: 'widget/session' },
  { re: /^\/api\/widget\/message$/, file: 'widget/message' },
  { re: /^\/api\/telegram\/([^/]+)$/, file: 'telegram/[channelId]', param: 'channelId' },
  { re: /^\/api\/channels\/telegram$/, file: 'channels/telegram' },
  { re: /^\/api\/kb\/ingest$/, file: 'kb/ingest' },
  { re: /^\/api\/kb\/sources$/, file: 'kb/sources' },
  { re: /^\/api\/kb\/sources\/([^/]+)\/verify$/, file: 'kb/sources/[id]/verify', param: 'id' },
  { re: /^\/api\/kb\/sources\/([^/]+)\/sync$/, file: 'kb/sources/[id]/sync', param: 'id' },
  { re: /^\/api\/kb\/sources\/([^/]+)\/retry$/, file: 'kb/sources/[id]/retry', param: 'id' },
  { re: /^\/api\/kb\/sources\/([^/]+)$/, file: 'kb/sources/[id]', param: 'id' },
  { re: /^\/api\/kb\/documents$/, file: 'kb/documents' },
  { re: /^\/api\/kb\/documents\/([^/]+)$/, file: 'kb/documents/[id]', param: 'id' },
  { re: /^\/api\/kb\/search$/, file: 'kb/search' },
  { re: /^\/api\/plugin\/connect$/, file: 'plugin/connect' },
  { re: /^\/api\/keys\/([^/]+)$/, file: 'keys/[id]', param: 'id' },
  { re: /^\/api\/cron\/crawl$/, file: 'cron/crawl' },
  { re: /^\/api\/conversations\/([^/]+)\/reply$/, file: 'conversations/[id]/reply', param: 'id' },
];

// Skedarë statikë shtesë (i mbush një test i jashtëm përmes E2E_EXTRA).
const statics = new Map<string, { type: string; body: string | Buffer }>();

const app = createServer(async (req, res) => {
  const url = new URL(req.url!, APP);
  const extra = statics.get(url.pathname);
  if (extra) {
    res.writeHead(200, { 'content-type': extra.type });
    return res.end(extra.body);
  }
  if (url.pathname === '/widget.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    return res.end(readFileSync(new URL('../../public/widget.js', import.meta.url)));
  }
  const route = ROUTES.find((r) => r.re.test(url.pathname));
  const mod = route ? await import(`../../src/app/api/${route.file}/route.ts`) : null;
  const handler = mod?.[req.method!];
  if (!route || !handler) {
    res.writeHead(route ? 405 : 404);
    return res.end();
  }
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const request = new Request(url, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method!) ? undefined : Buffer.concat(parts),
  });
  const match = route.re.exec(url.pathname)!;
  const response: Response = await handler(request, { params: Promise.resolve(route.param ? { [route.param]: match[1] } : {}) });
  const out: Record<string, string> = {};
  response.headers.forEach((v, k) => (out[k] = v));
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
});

// ---------------------------------------------------------------------------
// Ndihmës
// ---------------------------------------------------------------------------
let ipCounter = 0;
const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function call(method: string, path: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(APP + path, {
    method,
    headers: {
      'x-forwarded-for': freshIp(),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
}

// Lexim/shkrim direkt në DB si service_role (vetëm për verifikime të testit).
async function db(path: string, init: RequestInit = {}): Promise<any> {
  const key = process.env.SUPABASE_SECRET_KEY!;
  const res = await fetch(`http://127.0.0.1:${REST_PORT}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'return=representation', ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const results: string[] = [];
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (e) {
    results.push(`  FAIL ${name}\n       ${e instanceof Error ? e.message.split('\n').join('\n       ') : e}`);
    process.exitCode = 1;
  }
}

const DOC_A = [
  'Opening hours. Kafe Alba is open Monday to Friday from 09:00 to 17:00 and Saturday from 10:00 to 14:00. We are closed on Sunday and on public holidays. ' +
    'During August the afternoon schedule is shorter and the bar closes one hour earlier than usual. '.repeat(6),
  'Delivery. Delivery inside Tirana is free for orders above 3000 lek. For smaller orders the delivery fee is 200 lek. Orders placed before noon arrive the same day. ' +
    'Our couriers call the customer ten minutes before arriving at the address given in the order. '.repeat(6),
  'Returns. A product can be returned within 14 days if the package is unopened and the customer still has the receipt from the purchase. ' +
    'Refunds are paid back with the same payment method that was used when the product was bought. '.repeat(6),
].join('\n\n');
const DOC_B = 'Dyqani Beta sells phones. The secret wholesale price list of Beta is 999 euro for partners only. Opening hours of Beta are 12:00 to 20:00 every day.';

// ---------------------------------------------------------------------------
await startMocks(MOCK_PORT, REST_PORT);
await new Promise<void>((r) => app.listen(APP_PORT, '127.0.0.1', () => r()));

const tenants: any[] = await db('/tenants?select=id,name,widget_key&order=name');
const A = tenants.find((t) => t.name === 'Kafe Alba');
const B = tenants.find((t) => t.name === 'Dyqani Beta');
assert.ok(A && B, 'trigger-i i regjistrimit duhej të krijonte dy tenant-ë');

let tokenA = '';
let convA = '';

await step('KB: kërkon autentikim', async () => {
  assert.equal((await call('POST', '/api/kb/ingest', { body: { title: 'x', content: DOC_A } })).status, 401);
  assert.equal((await call('POST', '/api/kb/ingest', { body: { title: 'x', content: DOC_A }, token: 'tok-i-rreme' })).status, 401);
});

await step('KB: ngarkim -> chunks + embeddings 512-dim, vetëm te tenant-i i përdoruesit', async () => {
  const a = await call('POST', '/api/kb/ingest', { body: { title: 'FAQ', content: DOC_A, tenant_id: B.id }, token: 'tok-A' });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.ok(a.data.chunks >= 3, `prita >=3 chunks, mora ${a.data.chunks}`);
  const b = await call('POST', '/api/kb/ingest', { body: { title: 'Beta', content: DOC_B }, token: 'tok-B' });
  assert.equal(b.status, 201, JSON.stringify(b.data));

  const chunksA = await db(`/document_chunks?select=tenant_id,content&document_id=eq.${a.data.documentId}`);
  assert.equal(chunksA.length, a.data.chunks);
  assert.ok(chunksA.every((c: any) => c.tenant_id === A.id), 'tenant_id në body NUK duhet të ketë efekt');
  const docs = await db(`/documents?select=status,chunk_count&id=eq.${a.data.documentId}`);
  assert.deepEqual(docs, [{ status: 'ready', chunk_count: a.data.chunks }]);

  const v = calls.voyage[0];
  assert.equal(v.input_type, 'document');
  assert.equal(v.output_dimension, 512);
  assert.equal(v.model, 'voyage-4-lite');
  assert.equal(v.auth, 'Bearer pa-test');
  const usage = await db(`/usage_events?select=event_type,input_tokens&tenant_id=eq.${A.id}`);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].event_type, 'embedding');
  assert.ok(usage[0].input_tokens > 0);
});

await step('KB: dublikatë -> 409, tekst i shkurtër -> 400', async () => {
  assert.equal((await call('POST', '/api/kb/ingest', { body: { title: 'FAQ 2', content: DOC_A }, token: 'tok-A' })).status, 409);
  assert.equal((await call('POST', '/api/kb/ingest', { body: { title: 'x', content: 'shkurt' }, token: 'tok-A' })).status, 400);
});

await step('Widget session: konfigurim pa shkrim në DB; çelës i pavlefshëm/i panjohur', async () => {
  const ok = await call('GET', `/api/widget/session?key=${A.widget_key}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.config.botName, 'Kafe Alba');
  assert.deepEqual(ok.data.messages, []);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  assert.equal((await call('GET', '/api/widget/session?key=abc')).status, 400);
  assert.equal((await call('GET', `/api/widget/session?key=wk_${'0'.repeat(32)}`)).status, 404);
  assert.equal((await db('/conversations?select=id')).length, 0);
  assert.equal((await call('OPTIONS', '/api/widget/message')).status, 204);
});

await step('Widget: pyetje -> përgjigje nga KB e tenant-it A (RAG), usage ledger, Langfuse', async () => {
  const r = await call('POST', '/api/widget/message', { body: { key: A.widget_key, text: 'What are your opening hours?' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  tokenA = r.data.token;
  assert.equal(r.data.status, 'open');
  assert.match(r.data.reply.content, /^ANSWER: Opening hours\. Kafe Alba is open Monday to Friday from 09:00 to 17:00/);

  const sent = calls.anthropic[calls.anthropic.length - 1];
  assert.equal(sent.model, 'claude-haiku-4-5-20251001');
  assert.equal(sent.headers['x-api-key'], 'sk-ant-test');
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(sent.tool_choice, { type: 'tool', name: 'reply' });
  assert.ok(sent.system.includes('"Kafe Alba"'));
  const prompt = JSON.stringify(sent.messages);
  assert.ok(!prompt.includes('999 euro') && !prompt.includes('Beta'), 'RRJEDHJE: konteksti i A përmban të dhëna të B');
  assert.equal(calls.voyage[calls.voyage.length - 1].input_type, 'query');

  const convs = await db(`/conversations?select=id,tenant_id,channel_type,status&tenant_id=eq.${A.id}`);
  assert.equal(convs.length, 1);
  convA = convs[0].id;
  const msgs = await db(`/messages?select=role,content,metadata,tenant_id&conversation_id=eq.${convA}&order=id`);
  assert.deepEqual(msgs.map((m: any) => m.role), ['user', 'assistant']);
  assert.equal(msgs[1].metadata.kind, 'ai');
  assert.equal(msgs[1].metadata.sources.length, 1, 'burimi i pavlefshëm (99) duhej hequr');

  const usage = await db(`/usage_events?select=*&tenant_id=eq.${A.id}&event_type=eq.ai_reply`);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].input_tokens, 1200);
  assert.equal(usage[0].output_tokens, 80);
  assert.equal(Number(usage[0].cost_usd), 0.0016);
  assert.equal(usage[0].conversation_id, convA);
  assert.equal(usage[0].channel_type, 'widget');

  const trace = calls.langfuse[calls.langfuse.length - 1]!;
  assert.equal(trace.headers.authorization, `Basic ${Buffer.from('pk-lf-test:sk-lf-test').toString('base64')}`);
  assert.equal(trace.headers['x-langfuse-ingestion-version'], '4');
  const spans = trace.body.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2);
  assert.equal(spans[0].traceId, usage[0].langfuse_trace_id);
  assert.match(spans[0].traceId, /^[0-9a-f]{32}$/);
  assert.equal(spans[1].parentSpanId, spans[0].spanId);
  const attr = (span: any, key: string) => span.attributes.find((a: any) => a.key === key)?.value.stringValue;
  assert.equal(attr(spans[0], 'langfuse.user.id'), A.id);
  assert.equal(attr(spans[0], 'langfuse.session.id'), convA);
  assert.equal(attr(spans[1], 'langfuse.observation.type'), 'generation');
  assert.deepEqual(JSON.parse(attr(spans[1], 'langfuse.observation.usage_details')), { input: 1200, output: 80 });
});

await step('Widget: mesazhi i dytë vazhdon të njëjtën bisedë dhe dërgon historikun', async () => {
  const r = await call('POST', '/api/widget/message', { body: { key: A.widget_key, text: 'How much is delivery in Tirana?' }, token: tokenA });
  assert.equal(r.status, 200);
  assert.match(r.data.reply.content, /^ANSWER: Delivery\./);
  assert.equal((await db(`/conversations?select=id&tenant_id=eq.${A.id}`)).length, 1);
  const sent = calls.anthropic[calls.anthropic.length - 1];
  assert.deepEqual(sent.messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
  assert.equal(sent.messages[0].content, 'What are your opening hours?');
});

await step('Widget: sesioni kthen historikun vetëm me token të vlefshëm', async () => {
  const withToken = await call('GET', `/api/widget/session?key=${A.widget_key}`, { token: tokenA });
  assert.equal(withToken.data.messages.length, 4);
  const forged = tokenA.slice(0, -3) + 'abc';
  assert.deepEqual((await call('GET', `/api/widget/session?key=${A.widget_key}`, { token: forged })).data.messages, []);
});

await step('Idempotencë: i njëjti clientId nuk prodhon përgjigje/kosto të dytë', async () => {
  const before = calls.anthropic.length;
  const body = { key: A.widget_key, text: 'Can I return a product?', clientId: '11111111-1111-4111-8111-111111111111' };
  const first = await call('POST', '/api/widget/message', { body, token: tokenA });
  const second = await call('POST', '/api/widget/message', { body, token: tokenA });
  assert.match(first.data.reply.content, /^ANSWER: Returns\./);
  assert.equal(second.data.duplicate, true);
  assert.equal(second.data.reply, null);
  assert.equal(calls.anthropic.length, before + 1);
});

await step('Izolim: tokeni i tenant-it A nuk hap asgjë te tenant-i B', async () => {
  const poll = await call('GET', `/api/widget/message?key=${B.widget_key}&after=0`, { token: tokenA });
  assert.equal(poll.status, 401);
  const session = await call('GET', `/api/widget/session?key=${B.widget_key}`, { token: tokenA });
  assert.deepEqual(session.data.messages, []);
  // Me tokenin e A te çelësi i B: trajtohet si vizitor i ri i B, me KB të B.
  const r = await call('POST', '/api/widget/message', { body: { key: B.widget_key, text: 'What are the opening hours?' }, token: tokenA });
  assert.equal(r.status, 200);
  assert.match(r.data.reply.content, /Dyqani Beta/);
  assert.ok(!r.data.reply.content.includes('Kafe Alba'));
  const convB = await db(`/conversations?select=id&tenant_id=eq.${B.id}`);
  assert.equal(convB.length, 1);
  assert.notEqual(convB[0].id, convA);
  assert.equal((await db(`/messages?select=id&conversation_id=eq.${convA}&tenant_id=eq.${B.id}`)).length, 0);
});

await step('Polling: pa token -> 401; me token -> vetëm mesazhe të reja', async () => {
  assert.equal((await call('GET', `/api/widget/message?key=${A.widget_key}&after=0`)).status, 401);
  const all = await call('GET', `/api/widget/message?key=${A.widget_key}&after=0`, { token: tokenA });
  assert.equal(all.status, 200);
  assert.equal(all.data.messages.length, 3);
  const last = all.data.messages[2].id;
  assert.deepEqual((await call('GET', `/api/widget/message?key=${A.widget_key}&after=${last}`, { token: tokenA })).data.messages, []);
});

await step('Handoff: AI kërkon njeri -> biseda kalon te njeriu dhe AI hesht', async () => {
  const r = await call('POST', '/api/widget/message', { body: { key: A.widget_key, text: 'I want to talk to a human please' }, token: tokenA });
  assert.equal(r.data.status, 'handoff');
  assert.equal(r.data.reply.content, 'A team member will reply here shortly.');
  const conv = (await db(`/conversations?select=status,ai_enabled,handoff_reason&id=eq.${convA}`))[0];
  assert.deepEqual(conv, { status: 'handoff', ai_enabled: false, handoff_reason: 'ai_requested' });

  const before = calls.anthropic.length;
  const next = await call('POST', '/api/widget/message', { body: { key: A.widget_key, text: 'Hello? Opening hours?' }, token: tokenA });
  assert.equal(next.data.reply, null);
  assert.equal(next.data.status, 'handoff');
  assert.equal(calls.anthropic.length, before, 'AI nuk duhet thirrur gjatë handoff');
});

await step('Agjenti: përgjigjja arrin te widget-i me polling; tenant tjetër -> 404', async () => {
  assert.equal((await call('POST', `/api/conversations/${convA}/reply`, { body: { text: 'hack' }, token: 'tok-B' })).status, 404);
  assert.equal((await call('POST', `/api/conversations/${convA}/reply`, { body: { text: 'hack' } })).status, 401);
  const lastId = (await db(`/messages?select=id&conversation_id=eq.${convA}&order=id.desc&limit=1`))[0].id;
  const r = await call('POST', `/api/conversations/${convA}/reply`, { body: { text: 'Hi, this is Ana from the team.' }, token: 'tok-A' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const poll = await call('GET', `/api/widget/message?key=${A.widget_key}&after=${lastId}`, { token: tokenA });
  assert.equal(poll.data.status, 'handoff');
  assert.deepEqual(poll.data.messages.map((m: any) => [m.role, m.content]), [['agent', 'Hi, this is Ana from the team.']]);
});

await step('Kthim te AI: agjenti e rihap -> AI përgjigjet sërish', async () => {
  await db(`/conversations?id=eq.${convA}`, { method: 'PATCH', body: JSON.stringify({ status: 'open', ai_enabled: true }) });
  const r = await call('POST', '/api/widget/message', { body: { key: A.widget_key, text: 'Is delivery free above 3000 lek?' }, token: tokenA });
  assert.equal(r.data.status, 'open');
  assert.match(r.data.reply.content, /^ANSWER: Delivery\./);
});

await step('Kuota: limiti i arritur -> njoftim + handoff, pa thirrje AI, pa usage', async () => {
  await db(`/tenants?id=eq.${B.id}`, { method: 'PATCH', body: JSON.stringify({ monthly_ai_reply_limit: 1, settings: { language: 'sq' } }) });
  const before = calls.anthropic.length;
  const r = await call('POST', '/api/widget/message', { body: { key: B.widget_key, text: 'Opening hours?' } });
  assert.equal(r.data.status, 'handoff');
  assert.match(r.data.reply.content, /Po ia kaloj mesazhin tuaj ekipit/);
  assert.equal(calls.anthropic.length, before);
  assert.equal((await db(`/usage_events?select=id&tenant_id=eq.${B.id}&event_type=eq.ai_reply`)).length, 1);
  const conv = (await db(`/conversations?select=handoff_reason&tenant_id=eq.${B.id}&order=created_at.desc&limit=1`))[0];
  assert.equal(conv.handoff_reason, 'quota');
  await db(`/tenants?id=eq.${B.id}`, { method: 'PATCH', body: JSON.stringify({ monthly_ai_reply_limit: 300 }) });
});

await step('Prova e skaduar -> AI ndalet', async () => {
  await db(`/tenants?id=eq.${B.id}`, { method: 'PATCH', body: JSON.stringify({ trial_ends_at: '2020-01-01T00:00:00Z' }) });
  const before = calls.anthropic.length;
  const r = await call('POST', '/api/widget/message', { body: { key: B.widget_key, text: 'Opening hours?' } });
  assert.equal(r.data.status, 'handoff');
  assert.equal(calls.anthropic.length, before);
  await db(`/tenants?id=eq.${B.id}`, { method: 'PATCH', body: JSON.stringify({ trial_ends_at: '2099-01-01T00:00:00Z' }) });
});

await step('Dështim i Claude (500) -> mesazh i sjellshëm, pa usage, biseda mbetet te AI', async () => {
  const usageBefore = (await db(`/usage_events?select=id&tenant_id=eq.${A.id}&event_type=eq.ai_reply`)).length;
  const r = await call('POST', '/api/widget/message', { body: { key: A.widget_key, text: 'FAIL500 opening hours' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'open');
  assert.match(r.data.reply.content, /something went wrong/);
  assert.equal((await db(`/usage_events?select=id&tenant_id=eq.${A.id}&event_type=eq.ai_reply`)).length, usageBefore);
});

await step('Origjinat e lejuara: faqe e huaj -> 403', async () => {
  await db(`/tenants?id=eq.${A.id}`, { method: 'PATCH', body: JSON.stringify({ allowed_origins: ['https://kafe-alba.example'] }) });
  const body = { key: A.widget_key, text: 'Opening hours?' };
  assert.equal((await call('POST', '/api/widget/message', { body })).status, 403);
  assert.equal((await call('POST', '/api/widget/message', { body, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('POST', '/api/widget/message', { body, headers: { origin: 'https://kafe-alba.example' } })).status, 200);
  const session = (headers: Record<string, string>) => call('GET', `/api/widget/session?key=${A.widget_key}`, { headers });
  assert.equal((await session({})).status, 403);
  assert.equal((await session({ referer: 'https://evil.example/page' })).status, 403);
  assert.equal((await session({ referer: 'https://kafe-alba.example/kontakt?x=1' })).status, 200);
  await db(`/tenants?id=eq.${A.id}`, { method: 'PATCH', body: JSON.stringify({ allowed_origins: [] }) });
});

await step('Validim: tekst bosh / shumë i gjatë / JSON i prishur', async () => {
  assert.equal((await call('POST', '/api/widget/message', { body: { key: A.widget_key, text: '   ' } })).status, 400);
  assert.equal((await call('POST', '/api/widget/message', { body: { key: A.widget_key, text: 'x'.repeat(2001) } })).status, 413);
  const res = await fetch(`${APP}/api/widget/message`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: '{oops' });
  assert.equal(res.status, 400);
});

await step('Rate limit: e 11-ta bisedë e re nga e njëjta IP brenda orës -> 429', async () => {
  const headers = { 'x-forwarded-for': '203.0.113.7' };
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    statuses.push((await call('POST', '/api/widget/message', { body: { key: A.widget_key, text: 'Opening hours?' }, headers })).status);
  }
  assert.deepEqual(statuses, [...Array(10).fill(200), 429]);
});

// ---------------------------- Telegram ----------------------------
const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
let channelId = '';
let webhookSecret = '';
const tgCalls = (method: string) => calls.telegram.filter((c) => c.method === method);
const update = (id: number, message: Record<string, unknown>) => ({
  update_id: id,
  message: { message_id: id, chat: { id: 555, type: 'private' }, from: { first_name: 'Ardit', is_bot: false }, ...message },
});
const hook = (payload: unknown, secret = webhookSecret) =>
  call('POST', `/api/telegram/${channelId}`, { body: payload, headers: { 'x-telegram-bot-api-secret-token': secret } });

await step('Telegram: lidhja e bot-it (getMe + setWebhook me sekret), token i enkriptuar në DB', async () => {
  assert.equal((await call('POST', '/api/channels/telegram', { body: { botToken: BOT_TOKEN } })).status, 401);
  assert.equal((await call('POST', '/api/channels/telegram', { body: { botToken: 'jo-token' }, token: 'tok-A' })).status, 400);
  assert.equal((await call('POST', '/api/channels/telegram', { body: { botToken: '999999999:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw' }, token: 'tok-A' })).status, 400);

  const r = await call('POST', '/api/channels/telegram', { body: { botToken: BOT_TOKEN }, token: 'tok-A' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.bot, '@alba_test_bot');
  channelId = r.data.channelId;

  const set = tgCalls('setWebhook').pop()!;
  assert.equal(set.token, BOT_TOKEN);
  assert.equal(set.body.url, `${APP}/api/telegram/${channelId}`);
  assert.deepEqual(set.body.allowed_updates, ['message']);
  assert.match(set.body.secret_token, /^[A-Za-z0-9_-]{1,256}$/);
  webhookSecret = set.body.secret_token;

  const secrets = (await db(`/channel_secrets?select=*&channel_id=eq.${channelId}`))[0];
  assert.equal(secrets.tenant_id, A.id);
  assert.ok(!JSON.stringify(secrets).includes('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'), 'tokeni i bot-it është i paenkriptuar në DB');

  const other = await call('POST', '/api/channels/telegram', { body: { botToken: BOT_TOKEN }, token: 'tok-B' });
  assert.equal(other.status, 409, 'i njëjti bot nuk lidhet dot me dy tenant-ë');
});

await step('Telegram webhook: sekret i gabuar / kanal i panjohur -> refuzohet pa asnjë efekt', async () => {
  const before = (await db('/messages?select=id')).length;
  assert.equal((await hook(update(1, { text: 'Opening hours?' }), 'i-gabuar')).status, 401);
  assert.equal((await call('POST', `/api/telegram/${channelId}`, { body: update(1, { text: 'x' }) })).status, 401);
  assert.equal((await call('POST', '/api/telegram/00000000-0000-4000-8000-000000000000', { body: update(1, { text: 'x' }), headers: { 'x-telegram-bot-api-secret-token': webhookSecret } })).status, 401);
  assert.equal((await call('POST', '/api/telegram/jo-uuid', { body: {} })).status, 404);
  assert.equal((await db('/messages?select=id')).length, before);
  assert.equal(tgCalls('sendMessage').length, 0);
});

await step('Telegram: pyetje -> RAG i tenant-it -> sendMessage te chat-i i duhur', async () => {
  const r = await hook(update(1001, { text: 'What are your opening hours?' }));
  assert.equal(r.status, 200);
  const sent = tgCalls('sendMessage');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.token, BOT_TOKEN);
  assert.equal(sent[0]!.body.chat_id, '555');
  assert.match(sent[0]!.body.text, /^ANSWER: Opening hours\. Kafe Alba/);
  assert.equal(sent[0]!.body.parse_mode, undefined);
  const conv = (await db(`/conversations?select=tenant_id,channel_type,external_user_id,contact_name&channel_id=eq.${channelId}`))[0];
  assert.deepEqual(conv, { tenant_id: A.id, channel_type: 'telegram', external_user_id: '555', contact_name: 'Ardit' });
  const usage = await db(`/usage_events?select=channel_type&tenant_id=eq.${A.id}&channel_type=eq.telegram`);
  assert.equal(usage.length, 1);
});

await step('Telegram: update i ridërguar (i njëjti update_id) -> asnjë përgjigje e dytë', async () => {
  const before = calls.anthropic.length;
  assert.equal((await hook(update(1001, { text: 'What are your opening hours?' }))).status, 200);
  assert.equal(tgCalls('sendMessage').length, 1);
  assert.equal(calls.anthropic.length, before);
});

await step('Telegram: /start, mesazh pa tekst, grup, bot -> pa thirrje AI', async () => {
  const before = calls.anthropic.length;
  await hook(update(1002, { text: '/start' }));
  assert.equal(tgCalls('sendMessage').pop()!.body.text, 'Hi! How can I help you?');
  await hook(update(1003, { photo: [{ file_id: 'x' }] }));
  assert.match(tgCalls('sendMessage').pop()!.body.text, /only read text/);
  const count = tgCalls('sendMessage').length;
  await hook(update(1004, { text: 'hi', chat: { id: -100, type: 'group' } }));
  await hook(update(1005, { text: 'hi', from: { is_bot: true } }));
  await hook({ update_id: 1006, edited_message: { text: 'x' } });
  assert.equal(tgCalls('sendMessage').length, count);
  assert.equal(calls.anthropic.length, before);
});

await step('Telegram: përgjigjja e agjentit dërgohet përmes bot-it; pas saj AI hesht', async () => {
  const conv = (await db(`/conversations?select=id&channel_id=eq.${channelId}`))[0];
  const r = await call('POST', `/api/conversations/${conv.id}/reply`, { body: { text: 'Ana here, I can help.' }, token: 'tok-A' });
  assert.equal(r.status, 201);
  assert.equal(r.data.delivered, true);
  const last = tgCalls('sendMessage').pop()!;
  assert.deepEqual([last.token, last.body.chat_id, last.body.text], [BOT_TOKEN, '555', 'Ana here, I can help.']);
  const count = tgCalls('sendMessage').length;
  await hook(update(1007, { text: 'thanks, and delivery?' }));
  assert.equal(tgCalls('sendMessage').length, count, 'gjatë handoff AI nuk përgjigjet');
});

await step('Ledger: çdo rresht i usage_events dhe messages i përket tenant-it të bisedës së vet', async () => {
  const rows = await db('/messages?select=tenant_id,conversations(tenant_id)');
  assert.ok(rows.length > 10);
  assert.ok(rows.every((m: any) => m.tenant_id === m.conversations.tenant_id));
  const usage = await db('/usage_events?select=tenant_id,conversations(tenant_id)&event_type=eq.ai_reply');
  assert.ok(usage.every((u: any) => u.tenant_id === u.conversations.tenant_id));
});

await step('RLS përmes Data API: përdoruesi A sheh vetëm të dhënat e veta; anon asgjë', async () => {
  const asUser = async (path: string, jwt?: string) => {
    const res = await fetch(`${MOCK}/rest/v1${path}`, { headers: { apikey: 'sb_publishable_test', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) } });
    return { status: res.status, data: await res.json() };
  };
  const jwtA = userJwt(USERS['tok-A']!);
  for (const table of ['tenants', 'conversations', 'messages', 'documents', 'usage_events', 'channels']) {
    const column = table === 'tenants' ? 'id' : 'tenant_id';
    const r = await asUser(`/${table}?select=${column}`, jwtA);
    assert.equal(r.status, 200, `${table}: ${JSON.stringify(r.data)}`);
    assert.ok(r.data.length > 0, `${table}: A duhet të shohë rreshtat e vet`);
    assert.ok(r.data.every((row: any) => row[column] === A.id), `RRJEDHJE te ${table}`);
  }
  assert.deepEqual((await asUser(`/messages?select=id&tenant_id=eq.${B.id}`, jwtA)).data, []);
  assert.equal((await asUser('/channel_secrets?select=*', jwtA)).status, 403);
  assert.equal((await asUser('/document_chunks?select=embedding', jwtA)).status, 403);
  assert.equal((await asUser('/tenants?select=id')).status, 401);
  const rpc = await fetch(`${MOCK}/rest/v1/rpc/match_chunks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwtA}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_tenant_id: B.id, p_query_embedding: '[1]', p_query_text: 'price', p_match_count: 5 }),
  });
  assert.equal(rpc.status, 403, 'përdoruesi nuk duhet të thërrasë dot match_chunks për tenant tjetër');
});

// Website -> Knowledge Base -> RAG (crawler, indeksim, sync, plugin API).
{
  const { default: website } = await import('./website.ts');
  await website({ APP, MOCK, A, B, db, call, step, calls, userJwt, USERS, SITE_PORT });
}

if (process.env.E2E_BROWSER) {
  const { browserTest } = await import('./browser.ts');
  await step('Widget në Chromium (faqe në origjinë tjetër, CORS real)', () =>
    browserTest({
      app: APP,
      key: A.widget_key,
      agentReply: async (text) => {
        const conv = (await db(`/conversations?select=id&tenant_id=eq.${A.id}&channel_type=eq.widget&order=created_at.desc&limit=1`))[0];
        const r = await call('POST', `/api/conversations/${conv.id}/reply`, { body: { text }, token: 'tok-A' });
        assert.equal(r.status, 201);
      },
    }),
  );
}

// Teste shtesë që varen nga mjedisi (p.sh. paneli në browser): modul me `default(ctx)`.
if (process.env.E2E_EXTRA) {
  const extraModule = await import(process.env.E2E_EXTRA);
  await extraModule.default({ APP, MOCK, A, B, db, call, step, statics, calls });
}

// I fundit: shton një dokument te tenant-i A, ndaj vjen pas testeve që varen nga KB fillestare.
await step('scripts/smoke.sh: login -> RLS -> ingest -> pyetje', async () => {
  const { stdout } = await promisify(execFile)('bash', ['scripts/smoke.sh', 'a@test.local', 'test-password'], {
    env: { ...process.env, APP_URL: APP, NEXT_PUBLIC_SUPABASE_URL: MOCK, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', DATABASE_URL: 'x' },
  });
  assert.match(stdout, /Kafe Alba -> wk_[a-f0-9]{32}/);
  assert.match(stdout, /SMOKE TEST OK/);
});

console.log(results.join('\n'));
console.log(process.exitCode ? '\nE2E: KA DËSHTIME' : `\nE2E: TË GJITHA ${results.length} HAPAT KALUAN`);
process.exit(process.exitCode ?? 0);
