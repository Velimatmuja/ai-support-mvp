// Gabim me status HTTP. Mesazhi i shkon klientit, prandaj mos fut detaje të brendshme.
export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Max-Age': '86400',
};

export function json(data: unknown, status = 200, cors = false): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(cors ? CORS : {}),
    },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export function errorResponse(e: unknown, cors = false): Response {
  if (e instanceof ApiError) {
    return json({ error: e.code, message: e.message }, e.status, cors);
  }
  // Gabimet e papritura: log i plotë në server, mesazh i përgjithshëm për klientin.
  console.error('[api] gabim i papritur', e);
  return json({ error: 'internal_error' }, 500, cors);
}

export async function readJson(req: Request, maxBytes = 300_000): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (raw.length > maxBytes) throw new ApiError(413, 'payload_too_large');
  try {
    const body: unknown = JSON.parse(raw);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // bie poshtë
  }
  throw new ApiError(400, 'invalid_json');
}

export function clientIp(req: Request): string {
  // Në Vercel këto header-a vendosen nga platforma, jo nga klienti.
  const fwd = req.headers.get('x-forwarded-for');
  return (fwd?.split(',')[0] || req.headers.get('x-real-ip') || 'unknown').trim();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
