// Lexim i thjeshtë dhe tolerant i sitemap.xml (urlset dhe sitemapindex), pa parser XML:
// na duhen vetëm <loc> dhe <lastmod>. Përmbajtja e pabesueshme nuk ekzekutohet kurrë.
export type SitemapEntry = { loc: string; lastmod: string | null };
export type ParsedSitemap = { kind: 'urlset' | 'index' | 'unknown'; entries: SitemapEntry[] };

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

export function parseSitemap(xml: string, maxEntries = 50_000): ParsedSitemap {
  const head = xml.slice(0, 2000).toLowerCase();
  const kind = /<(?:\w+:)?sitemapindex[\s>]/.test(head) ? 'index' : /<(?:\w+:)?urlset[\s>]/.test(head) ? 'urlset' : 'unknown';
  const tag = kind === 'index' ? 'sitemap' : 'url';
  const entries: SitemapEntry[] = [];
  const blockRe = new RegExp(`<(?:\\w+:)?${tag}[\\s>]([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) && entries.length < maxEntries) {
    const block = m[1]!;
    const loc = /<(?:\w+:)?loc>([\s\S]*?)<\/(?:\w+:)?loc>/i.exec(block)?.[1];
    if (!loc) continue;
    const lastmod = /<(?:\w+:)?lastmod>([\s\S]*?)<\/(?:\w+:)?lastmod>/i.exec(block)?.[1];
    entries.push({ loc: decodeXml(loc), lastmod: lastmod ? decodeXml(lastmod) : null });
  }
  return { kind, entries };
}
