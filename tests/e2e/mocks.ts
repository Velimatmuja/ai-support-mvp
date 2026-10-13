// Shërbimet e jashtme të imituara + "porta" e Supabase (Auth i rremë, /rest/v1 -> PostgREST real).
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export const USERS: Record<string, string> = {
  'tok-A': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'tok-B': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

// "Supabase Auth" i imituar: fjalëkalimet mbahen këtu, përdoruesit në auth.users të DB-së lokale.
const accounts = new Map<string, { id: string; password: string }>([
  ['a@test.local', { id: USERS['tok-A']!, password: 'test-password' }],
  ['b@test.local', { id: USERS['tok-B']!, password: 'test-password' }],
]);

function createAuthUser(email: string, businessName: string): string {
  const id = randomUUID();
  // psql me variabla (:'x') që vlerat të mos futen kurrë direkt në SQL.
  execFileSync(
    'psql',
    ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', process.env.E2E_PG_HOST!, '-p', process.env.E2E_PG_PORT!, '-U', 'postgres', '-d', 'postgres',
      '-v', `id=${id}`, '-v', `email=${email}`, '-v', `meta=${JSON.stringify({ business_name: businessName })}`],
    { input: "insert into auth.users (id, email, raw_user_meta_data) values (:'id', :'email', :'meta'::jsonb);" },
  );
  return id;
}

function session(id: string, email: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: userJwt(id),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: `refresh-${id}`,
    user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS',
  'access-control-expose-headers': 'content-range',
};

export const calls = {
  voyage: [] as any[],
  anthropic: [] as any[],
  telegram: [] as { token: string; method: string; body: any }[],
  langfuse: [] as { headers: Record<string, any>; body: any }[],
};

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (data: string) => createHmac('sha256', process.env.E2E_JWT_SECRET!).update(data).digest('base64url');

// JWT si ai i Supabase Auth: role=authenticated, sub=id e përdoruesit.
export function userJwt(userId: string): string {
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'authenticated', sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${data}.${sign(data)}`;
}

function verifyUserJwt(token: string): string | undefined {
  const [h, p, sig] = token.split('.');
  if (!h || !p || sig !== sign(`${h}.${p}`)) return undefined;
  return JSON.parse(Buffer.from(p, 'base64url').toString()).sub;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(data));
}

// Embedding determinist "bashkësi fjalësh" (pa fjalë funksionale): tekste me fjalë
// kuptimplota të përbashkëta dalin të ngjashme — mjafton për të testuar rrjedhën.
const STOP = new Set(['what', 'are', 'your', 'the', 'and', 'for', 'with', 'that', 'was', 'from', 'how', 'much', 'can', 'our', 'has', 'have', 'when']);
function fakeEmbedding(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const word of new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u))) {
    if (word.length > 2 && !STOP.has(word)) v[createHash('md5').update(word).digest().readUInt16BE(0) % dim] = 1;
  }
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => Number((x / norm).toFixed(5)));
}

function fakeClaude(body: any): { status: number; data: unknown } {
  const last: string = body.messages[body.messages.length - 1].content;
  const question = /<customer_message>\n([\s\S]*)\n<\/customer_message>\s*$/.exec(last)?.[1] ?? '';
  const knowledge = /<knowledge>\n([\s\S]*?)\n<\/knowledge>\s*\n\s*<customer_message>\n[\s\S]*$/.exec(last)?.[1] ?? '';
  if (question.includes('FAIL500')) return { status: 500, data: { type: 'error', error: { type: 'api_error', message: 'boom' } } };

  const first = /^<source id="1" title="(.*?)"(?: url="(.*?)")?>\n([\s\S]*?)\n<\/source>/.exec(knowledge);
  let input: Record<string, unknown>;
  if (/human|njeri/i.test(question)) {
    input = { answer: 'A team member will reply here shortly.', needs_human: true, used_sources: [] };
  } else if (first) {
    input = { answer: `ANSWER: ${first[3]}`, needs_human: false, used_sources: [1, 99] };
  } else {
    input = { answer: 'I am passing this to the team.', needs_human: true, used_sources: [] };
  }
  return {
    status: 200,
    data: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'tool_use', id: 'toolu_test', name: 'reply', input }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1200, output_tokens: 80 },
    },
  };
}

export function startMocks(port: number, restPort: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://127.0.0.1:${port}`);
    const raw = await readBody(req);
    const body = raw.length && req.headers['content-type']?.includes('json') ? JSON.parse(raw.toString()) : null;

    // Paneli në browser thërret Supabase nga një origjinë tjetër.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    // --- Supabase: Data API -> PostgREST real
    if (url.pathname.startsWith('/rest/v1')) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string' && !['host', 'connection', 'content-length', 'origin'].includes(k)) headers[k] = v;
      }
      // Si porta e Supabase: një çelës publishable (jo JWT) = roli anon.
      if ((headers.authorization ?? '').split('.').length !== 3) delete headers.authorization;
      const upstream = await fetch(`http://127.0.0.1:${restPort}${url.pathname.slice('/rest/v1'.length) || '/'}${url.search}`, {
        method: req.method,
        headers,
        body: raw.length ? new Uint8Array(raw) : undefined,
      });
      const out: Record<string, string> = { ...CORS };
      upstream.headers.forEach((v, k) => {
        if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k) && !k.startsWith('access-control-')) out[k] = v;
      });
      res.writeHead(upstream.status, out);
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    // --- Supabase Auth: regjistrim (pa konfirmim email-i) -> sesion
    if (url.pathname === '/auth/v1/signup') {
      const email = String(body?.email ?? '').toLowerCase();
      if (accounts.has(email)) return send(res, 422, { error_code: 'user_already_exists', msg: 'User already registered' });
      const id = createAuthUser(email, String(body?.data?.business_name ?? ''));
      accounts.set(email, { id, password: String(body?.password ?? '') });
      return send(res, 200, session(id, email));
    }
    // --- Supabase Auth: login me fjalëkalim / rifreskim -> JWT i nënshkruar me sekretin e PostgREST
    if (url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const entry = [...accounts.entries()].find(([, a]) => `refresh-${a.id}` === body?.refresh_token);
        if (!entry) return send(res, 400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
        return send(res, 200, session(entry[1].id, entry[0]));
      }
      const email = String(body?.email ?? '').toLowerCase();
      const account = accounts.get(email);
      if (!account || account.password !== body?.password) {
        return send(res, 400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      return send(res, 200, session(account.id, email));
    }
    if (url.pathname === '/auth/v1/logout') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    // --- Supabase Auth: GET /auth/v1/user
    if (url.pathname === '/auth/v1/user') {
      const bearer = (req.headers.authorization || '').replace('Bearer ', '');
      const userId = USERS[bearer] ?? verifyUserJwt(bearer);
      if (!userId) return send(res, 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
      return send(res, 200, { id: userId, aud: 'authenticated', role: 'authenticated', email: 'x@test.local', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() });
    }
    // --- Voyage
    if (url.pathname === '/v1/embeddings') {
      calls.voyage.push({ auth: req.headers.authorization, ...body });
      const inputs: string[] = body.input;
      return send(res, 200, {
        object: 'list',
        data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: fakeEmbedding(t, body.output_dimension) })),
        model: body.model,
        usage: { total_tokens: inputs.join(' ').split(/\s+/).length },
      });
    }
    // --- Anthropic
    if (url.pathname === '/v1/messages') {
      calls.anthropic.push({ headers: req.headers, ...body });
      const { status, data } = fakeClaude(body);
      return send(res, status, data);
    }
    // --- Telegram
    const tgMatch = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (tgMatch) {
      const [, token, method] = tgMatch as unknown as [string, string, string];
      calls.telegram.push({ token, method, body });
      if (method === 'getMe') {
        if (token.startsWith('999')) return send(res, 401, { ok: false, description: 'Unauthorized' });
        return send(res, 200, { ok: true, result: { id: Number(token.split(':')[0]), is_bot: true, username: 'alba_test_bot' } });
      }
      return send(res, 200, { ok: true, result: true });
    }
    // --- Langfuse OTLP
    if (url.pathname === '/api/public/otel/v1/traces') {
      calls.langfuse.push({ headers: req.headers, body });
      return send(res, 200, {});
    }
    send(res, 404, { error: `mock: rrugë e panjohur ${url.pathname}` });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
