// Website-e të imituara për testin e crawl-it. Një server, disa host-e (sipas header-it
// Host); crawler-i i arrin vetëm përmes CRAWLER_DEV_HOST_MAP, sepse 127.0.0.1 është i ndaluar.
import { createServer } from 'node:http';
import type { Server } from 'node:http';

type Page = { status?: number; body?: string; type?: string; headers?: Record<string, string>; delayMs?: number };

export const requests: { host: string; path: string; headers: Record<string, string | string[] | undefined> }[] = [];
const sites = new Map<string, Map<string, Page>>();
const down = new Set<string>();

export function setPage(host: string, path: string, page: Page | null): void {
  if (!sites.has(host)) sites.set(host, new Map());
  if (page) sites.get(host)!.set(path, page);
  else sites.get(host)!.delete(path);
}
export function getPage(host: string, path: string): Page | undefined {
  return sites.get(host)?.get(path);
}
// "Site i rënë": çdo faqe (përveç robots.txt) kthen 500.
export function setDown(host: string, isDown: boolean): void {
  if (isDown) down.add(host);
  else down.delete(host);
}
export const hits = (host: string, path: string) => requests.filter((r) => r.host === host && r.path === path);

// Faqe HTML me menu, footer dhe një paragraf që përsëritet në çdo faqe (boilerplate).
export function html(title: string, body: string, extra: { head?: string; links?: string[]; tagline?: string } = {}): string {
  const nav = (extra.links ?? []).map((l) => `<a href="${l}">${l}</a>`).join(' ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${extra.head ?? ''}</head>
<body><header class="site-header"><nav class="main-navigation">${nav}<a href="/">Home</a></nav></header>
<main><h1>${title}</h1>${body}
<p>${extra.tagline ?? 'Kafe Alba is your neighbourhood cafe since 2015, call us any time.'}</p></main>
<footer class="site-footer"><p>Copyright Kafe Alba, all rights reserved. Privacy policy.</p></footer></body></html>`;
}

export function sitemap(urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((u) => `<url><loc>${u}</loc><lastmod>2026-10-01</lastmod></url>`)
    .join('')}</urlset>`;
}

export function startSite(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0]!.toLowerCase();
    const url = new URL(req.url || '/', `http://${host}`);
    const path = `${url.pathname}${url.search}`;
    requests.push({ host, path, headers: req.headers });
    if (down.has(host) && url.pathname !== '/robots.txt') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('down');
      return;
    }
    const page = sites.get(host)?.get(path) ?? sites.get(host)?.get(url.pathname);
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<h1>Not found</h1>');
      return;
    }
    const send = () => {
      const etag = page.headers?.etag;
      if (etag && req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      res.writeHead(page.status ?? 200, { 'content-type': page.type ?? 'text/html; charset=utf-8', ...page.headers });
      res.end(page.body ?? '');
    };
    if (page.delayMs) setTimeout(send, page.delayMs);
    else send();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
