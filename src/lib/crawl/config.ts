import { envOr } from '../env.ts';
import type { NetPolicy } from './netguard.ts';

// Parametrat e crawler-it. Të gjithë kanë vlera të sigurta për një SaaS të vogël
// dhe ndryshohen me env pa prekur kodin.
export type CrawlerConfig = {
  userAgent: string;
  // Token-i që kërkohet te robots.txt (User-agent: ANESPBot).
  robotsAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  // Pauza midis dy kërkesave te i njëjti site; Crawl-delay i robots.txt e rrit deri te maxDelayMs.
  minDelayMs: number;
  maxDelayMs: number;
  maxSitemaps: number;
  maxPageChars: number;
  maxAttempts: number;
  // Baza e backoff-it për një URL që dështoi përkohësisht (dyfishohet në çdo provë).
  retryBaseMs: number;
  requireVerification: boolean;
  net: NetPolicy;
};

function int(name: string, fallback: number, min: number, max: number): number {
  const n = Number(envOr(name, String(fallback)));
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : fallback;
}

// CRAWLER_DEV_HOST_MAP lejon testet e2e të drejtojnë "site-a.test" te një server
// lokal. Në production injorohet me qëllim: përndryshe do të ishte një derë SSRF.
function devHostMap(): Record<string, string> | undefined {
  const raw = process.env.CRAWLER_DEV_HOST_MAP;
  if (!raw) return undefined;
  if (process.env.NODE_ENV === 'production') {
    console.error('[crawler] CRAWLER_DEV_HOST_MAP injorohet në production');
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k.toLowerCase(), String(v)]));
  } catch {
    return undefined;
  }
}

export function crawlerConfig(): CrawlerConfig {
  const robotsAgent = envOr('CRAWLER_ROBOTS_AGENT', 'ANESPBot');
  const ports = envOr('CRAWLER_ALLOWED_PORTS', '80,443')
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return {
    robotsAgent,
    userAgent: envOr('CRAWLER_USER_AGENT', `Mozilla/5.0 (compatible; ${robotsAgent}/1.0; +${envOr('APP_URL', 'https://anesp.example')}/bot)`),
    timeoutMs: int('CRAWLER_TIMEOUT_MS', 15_000, 1_000, 60_000),
    maxBytes: int('CRAWLER_MAX_BYTES', 2_000_000, 50_000, 10_000_000),
    maxRedirects: int('CRAWLER_MAX_REDIRECTS', 5, 0, 10),
    minDelayMs: int('CRAWLER_MIN_DELAY_MS', 500, 0, 60_000),
    maxDelayMs: int('CRAWLER_MAX_DELAY_MS', 10_000, 0, 120_000),
    maxSitemaps: int('CRAWLER_MAX_SITEMAPS', 10, 1, 100),
    maxPageChars: int('CRAWLER_MAX_PAGE_CHARS', 100_000, 1_000, 200_000),
    maxAttempts: int('CRAWLER_MAX_ATTEMPTS', 3, 1, 10),
    retryBaseMs: int('CRAWLER_RETRY_BASE_MS', 30_000, 0, 3_600_000),
    requireVerification: envOr('CRAWLER_REQUIRE_VERIFICATION', 'true') !== 'false',
    net: { allowedPorts: ports.length ? ports : [80, 443], hostMap: devHostMap() },
  };
}
