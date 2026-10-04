// fetch me timeout + riprovim për 429/5xx. Zëvendëson SDK-të e rënda:
// më pak varësi për t'u instaluar në Termux dhe cold start më i shpejtë në Vercel.
export class UpstreamError extends Error {
  status: number;
  body: string;

  constructor(service: string, status: number, body: string) {
    super(`${service} u përgjigj me ${status}`);
    this.status = status;
    this.body = body.slice(0, 500);
  }
}

type Options = {
  service: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function postJson<T>(url: string, body: unknown, opts: Options): Promise<T> {
  const { service, headers = {}, timeoutMs = 25_000, retries = 2 } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return (await res.json()) as T;

      const text = await res.text();
      lastError = new UpstreamError(service, res.status, text);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === retries) throw lastError;

      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      await sleep(Math.min(wait, 8_000));
    } catch (e) {
      if (e instanceof UpstreamError && e.status !== 429 && e.status < 500) throw e;
      lastError = e;
      if (attempt === retries) throw e;
      if (!(e instanceof UpstreamError)) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}
