import { gunzipSync } from 'node:zlib';
import type { CrawlerConfig } from './config.ts';
import { FetchError, safeFetch } from './netguard.ts';
import type { Robots } from './robots.ts';
import { parseRobots } from './robots.ts';
import { parseSitemap } from './sitemap.ts';
import { inScope, normalizeUrl } from './url.ts';

// Gabim që e shtyn job-in për më vonë (backoff), p.sh. robots.txt i paarritshëm.
export class RetryableCrawlError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const fetchOpts = (cfg: CrawlerConfig, maxBytes = cfg.maxBytes) => ({
  ...cfg.net,
  userAgent: cfg.userAgent,
  timeoutMs: cfg.timeoutMs,
  maxBytes,
  maxRedirects: cfg.maxRedirects,
});

// robots.txt sipas RFC 9309: 2xx -> rregullat; 4xx -> pa kufizime; 5xx/rrjet -> mos
// crawl-o tani (riprovo më vonë). Kthen tekstin e papërpunuar për ta ruajtur te job-i.
export async function fetchRobots(origin: string, cfg: CrawlerConfig): Promise<string> {
  try {
    const res = await safeFetch(`${origin}/robots.txt`, fetchOpts(cfg, 500_000));
    if (res.status >= 200 && res.status < 300) return res.body.toString('utf8').slice(0, 100_000);
    if (res.status === 429 || res.status >= 500) throw new RetryableCrawlError('robots_unavailable');
    return '';
  } catch (e) {
    if (e instanceof RetryableCrawlError) throw e;
    if (e instanceof FetchError && (e.code === 'forbidden_address' || e.code === 'bad_port' || e.code === 'bad_scheme')) throw e;
    if (e instanceof FetchError && e.code === 'too_large') return '';
    throw new RetryableCrawlError('robots_unreachable');
  }
}

// incomplete = një sitemap ekzistues nuk u lexua dot (5xx, timeout): pamja e site-it
// është e paplotë, ndaj ky crawl nuk duhet të fshijë faqe "të zhdukura".
export type Discovery = { robots: Robots; robotsText: string; sitemapUrls: string[]; sitemapsRead: number; incomplete: boolean };

// Zbulon URL-të nga sitemap-et (ato të robots.txt, ose vendet standarde, përfshirë
// /wp-sitemap.xml të WordPress). Indekset ndiqen në gjerësi, me kufi numri dhe madhësie.
export async function discover(rootUrl: string, host: string, robotsText: string, limit: number, cfg: CrawlerConfig): Promise<Discovery> {
  const origin = new URL(rootUrl).origin;
  const robots = parseRobots(robotsText, cfg.robotsAgent);
  const declared = robots.sitemaps.map((s) => normalizeUrl(s, origin)).filter((s): s is string => !!s && inScope(s, host));
  const queue = declared.length ? declared : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`];
  const seen = new Set<string>(queue);
  const urls: string[] = [];
  const found = new Set<string>();
  let read = 0;
  let incomplete = false;

  while (queue.length && read < cfg.maxSitemaps && urls.length < limit) {
    const sm = queue.shift()!;
    let xml: string;
    try {
      const res = await safeFetch(sm, fetchOpts(cfg, Math.max(cfg.maxBytes, 10_000_000)));
      if (res.status === 429 || res.status >= 500) incomplete = true;
      if (res.status !== 200 || !inScope(res.url, host)) continue;
      let body = res.body;
      if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body, { maxOutputLength: 20_000_000 });
      xml = body.toString('utf8');
    } catch (e) {
      // Sitemap i paarritshëm: vazhdojmë me lidhjet e brendshme.
      if (e instanceof FetchError && ['timeout', 'network', 'dns_failed'].includes(e.code)) incomplete = true;
      continue;
    }
    const parsed = parseSitemap(xml);
    if (parsed.kind === 'unknown') continue;
    read++;
    for (const entry of parsed.entries) {
      const u = normalizeUrl(entry.loc, origin);
      if (!u || !inScope(u, host)) continue;
      if (parsed.kind === 'index') {
        if (!seen.has(u)) {
          seen.add(u);
          queue.push(u);
        }
      } else if (!found.has(u)) {
        found.add(u);
        urls.push(u);
        if (urls.length >= limit) break;
      }
    }
  }
  return { robots, robotsText, sitemapUrls: urls, sitemapsRead: read, incomplete };
}
