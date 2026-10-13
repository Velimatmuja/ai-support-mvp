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

// Skanim linear me indexOf (pa regex me [\s\S]*? mbi gjithë skedarin): një sitemap
// armiqësor me mijëra etiketa të pambyllura nuk e bllokon worker-in.
export function parseSitemap(xml: string, maxEntries = 50_000): ParsedSitemap {
  const head = xml.slice(0, 2000).toLowerCase();
  const kind = /<(?:\w+:)?sitemapindex[\s>]/.test(head) ? 'index' : /<(?:\w+:)?urlset[\s>]/.test(head) ? 'urlset' : 'unknown';
  const entries: SitemapEntry[] = [];
  if (kind === 'unknown') return { kind, entries };

  const locRe = /<(\w+:)?loc>/g;
  const starts: { at: number; end: number; prefix: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(xml)) && starts.length < maxEntries) {
    starts.push({ at: m.index, end: locRe.lastIndex, prefix: (m[1] ?? '').toLowerCase() });
  }
  let close = -1;
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]!;
    // <image:loc>, <video:loc> etj. janë media, jo faqe.
    if (['image:', 'video:', 'news:', 'xhtml:'].includes(s.prefix)) continue;
    // Treguesi i mbylljes vetëm ecën përpara: gjithsej një kalim mbi skedarin.
    if (close < s.end) close = xml.indexOf('</', s.end);
    if (close === -1) break;
    if (close - s.end > 4000) continue;
    const loc = decodeXml(xml.slice(s.end, close));
    if (!loc) continue;
    const nextAt = i + 1 < starts.length ? starts[i + 1]!.at : xml.length;
    // <lastmod> i takon këtij <url>: blloku pritet te hapja e <url>/<sitemap> tjetër.
    let block = xml.slice(close, Math.min(nextAt, close + 2000));
    const nextEntry = block.search(/<(?:\w+:)?(?:url|sitemap)[\s>]/);
    if (nextEntry !== -1) block = block.slice(0, nextEntry);
    const lastmod = /<(?:\w+:)?lastmod>([^<]{0,100})<\/(?:\w+:)?lastmod>/i.exec(block)?.[1];
    entries.push({ loc, lastmod: lastmod ? decodeXml(lastmod) : null });
  }
  return { kind, entries };
}
