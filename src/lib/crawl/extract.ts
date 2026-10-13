import { createHash } from 'node:crypto';
import { normalizeUrl } from './url.ts';

// Nxjerrja e përmbajtjes nga HTML pa varësi (tokenizer i vogël dhe tolerant).
// Qëllimi nuk është një DOM i plotë, por teksti që lexon një njeri në faqe:
//   * hidhen skriptet, stilet, navigimi, header/footer i faqes, format, reklamat,
//     banner-at e cookies dhe elementet e fshehura (vektor i zakonshëm prompt injection);
//   * nëse ka <main>/<article>, merret vetëm ajo pjesë;
//   * mbahen titulli, përshkrimi, canonical, gjuha, datat dhe lidhjet.

export type ExtractedPage = {
  title: string;
  description: string;
  canonical: string | null;
  lang: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
  paragraphs: string[];
  links: string[];
  noindex: boolean;
  nofollow: boolean;
};

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Përmbajtja e tyre nuk është tekst i faqes.
const RAW_TEXT = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'xmp', 'iframe', 'object', 'svg', 'math', 'canvas']);
const SKIP = new Set(['nav', 'footer', 'aside', 'form', 'button', 'select', 'option', 'dialog', 'menu']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table',
  'tbody', 'thead', 'tfoot', 'tr', 'ul', 'caption', 'details', 'summary',
]);
const SKIP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog', 'menu', 'menubar', 'tablist']);
// Klasa/id që tregojnë pjesë jashtë përmbajtjes. Krahasohet FILLIMI i çdo token-i, që
// "has-sidebar" ose "entry-content" të mos e fshijnë artikullin.
const SKIP_CLASS = /^(nav|navbar|navigation|menu|mega-menu|footer|site-footer|site-header|main-navigation|sidebar|widget-area|breadcrumbs?|cookie|cookies|consent|gdpr|cmplz|advert|advertisement|ads|ad|adsbygoogle|sponsored|banner|popup|modal|newsletter|subscribe|share|sharing|social|comments?|comment-respond|related-posts|skip-link|screen-reader-text|wp-block-navigation|visually-hidden|sr-only)([-_]|$)/i;

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', euro: '€',
  pound: '£', yen: '¥', cent: '¢', deg: '°', middot: '·', bull: '•', times: '×', divide: '÷', shy: '',
  euml: 'ë', Euml: 'Ë', ccedil: 'ç', Ccedil: 'Ç', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á',
  ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß', oacute: 'ó', iacute: 'í', uacute: 'ú', ntilde: 'ñ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const name = m[1]!.toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function isHidden(tag: string, a: Record<string, string>): boolean {
  if ('hidden' in a) return true;
  if (a['aria-hidden'] === 'true') return true;
  if (tag === 'input' && a.type === 'hidden') return true;
  const style = (a.style || '').toLowerCase().replace(/\s+/g, '');
  if (/display:none|visibility:hidden|opacity:0(?![.\d])|font-size:0(?![.\d])|(?:^|;)(?:height|max-height):0(?:px)?(?:;|$)/.test(style)) return true;
  if (/(?:^|;)(?:left|top):-\d{3,}px/.test(style)) return true;
  return false;
}

function isBoilerplate(tag: string, a: Record<string, string>, insideContent: boolean): boolean {
  if (SKIP.has(tag)) return true;
  // <header> i faqes është menu/logo; <header> brenda artikullit mban titullin.
  if (tag === 'header' && !insideContent) return true;
  if (a.role && SKIP_ROLES.has(a.role.toLowerCase())) return true;
  if (tag === 'body' || tag === 'main' || tag === 'article' || tag === 'html') return false;
  const tokens = `${a.class || ''} ${a.id || ''}`.split(/\s+/).filter(Boolean);
  return tokens.some((t) => SKIP_CLASS.test(t));
}

const clean = (s: string) => s.replace(/[\s ​]+/g, ' ').trim();

function isoDate(v: string | undefined): string | null {
  if (!v) return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const meta: Record<string, string> = {};
  let title = '';
  let canonical: string | null = null;
  let lang: string | null = null;
  let firstTime: string | null = null;
  let h1 = '';
  let baseHref = pageUrl;
  const links = new Set<string>();

  // Dy buffer-a: gjithë faqja dhe vetëm <main>/<article>.
  const all: string[] = [];
  const content: string[] = [];
  let allCur = '';
  let contentCur = '';
  let sawContent = false;

  // Stack i elementeve të hapura: [tag, skip, content]
  const stack: { tag: string; skip: boolean; content: boolean }[] = [];
  const skipping = () => stack.some((e) => e.skip);
  const inContent = () => stack.some((e) => e.content);

  const flush = () => {
    const a = clean(allCur);
    if (a) all.push(a);
    allCur = '';
    const c = clean(contentCur);
    if (c) content.push(c);
    contentCur = '';
  };
  const addText = (text: string) => {
    if (skipping()) return;
    allCur += text;
    if (inContent()) contentCur += text;
  };

  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>?|<\?[^>]*>?|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|[^<]+|</g;
  let m: RegExpExecArray | null;
  let currentText: 'title' | 'h1' | null = null;

  while ((m = re.exec(html))) {
    const token = m[0];
    if (token.startsWith('<!') || token.startsWith('<?')) continue;

    if (m[2]) {
      // Etiketë hapëse
      const tag = m[2].toLowerCase();
      const a = parseAttrs(m[3] ?? '');
      const selfClosing = /\/\s*$/.test(m[3] ?? '') || VOID.has(tag);

      if (tag === 'html' && a.lang) lang = a.lang;
      if (tag === 'base' && a.href) baseHref = new URL(a.href, pageUrl).toString();
      if (tag === 'meta') {
        const key = (a.name || a.property || a.itemprop || a['http-equiv'] || '').toLowerCase();
        if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
      }
      if (tag === 'link' && a.href && (a.rel || '').toLowerCase().split(/\s+/).includes('canonical')) {
        canonical = normalizeUrl(a.href, baseHref);
      }
      if (tag === 'time' && a.datetime && !firstTime) firstTime = a.datetime;
      if (tag === 'a' && a.href && !(a.rel || '').toLowerCase().includes('nofollow')) {
        const u = normalizeUrl(decodeEntities(a.href), baseHref);
        if (u && links.size < 2000) links.add(u);
      }

      if (RAW_TEXT.has(tag) && !(selfClosing && tag !== 'script' && tag !== 'style')) {
        // Kalo direkt te etiketa mbyllëse; asgjë brenda nuk është tekst i faqes.
        const close = new RegExp(`</\\s*${tag}\\s*>`, 'i');
        const rest = html.slice(re.lastIndex);
        const end = rest.search(close);
        re.lastIndex = end === -1 ? html.length : re.lastIndex + end + (close.exec(rest)?.[0].length ?? 0);
        continue;
      }
      if (tag === 'title') {
        currentText = title ? null : 'title';
        continue;
      }
      if (tag === 'h1' && !h1) currentText = 'h1';
      if (tag === 'br' || tag === 'hr') {
        flush();
        continue;
      }
      if (selfClosing) {
        if (tag === 'img' && a.alt && !skipping() && clean(a.alt).length > 15) addText(` ${a.alt} `);
        continue;
      }

      const contentRoot = tag === 'main' || tag === 'article' || (a.role || '').toLowerCase() === 'main';
      const skip = isHidden(tag, a) || isBoilerplate(tag, a, inContent() || contentRoot);
      if (BLOCK.has(tag)) flush();
      stack.push({ tag, skip, content: contentRoot && !skip });
      if (contentRoot && !skip) sawContent = true;
      if (tag === 'li' && !skipping()) addText('- ');
      continue;
    }

    if (m[1]) {
      // Etiketë mbyllëse: mbyll deri te elementi përkatës (HTML i keq toleruhet).
      const tag = m[1].toLowerCase();
      if (tag === 'title' || tag === 'h1') currentText = null;
      const idx = stack.map((e) => e.tag).lastIndexOf(tag);
      if (idx !== -1) {
        if (BLOCK.has(tag)) flush();
        stack.length = idx;
      }
      if (tag === 'td' || tag === 'th') addText(' | ');
      continue;
    }

    // Tekst
    const text = decodeEntities(token);
    if (currentText === 'title') {
      title += text;
      continue;
    }
    if (currentText === 'h1' && !skipping()) h1 += text;
    addText(text);
  }
  flush();

  const robots = `${meta.robots || ''},${meta.anespbot || ''}`.toLowerCase();
  const pickContent = sawContent && content.join(' ').length >= 200;
  const seen = new Set<string>();
  const paragraphs = (pickContent ? content : all)
    .map((p) => p.replace(/^-\s*$/, '').replace(/(\s*\|\s*)+$/, '').trim())
    .filter((p) => {
      if (!p || /^[-|•·\s]+$/.test(p)) return false;
      const key = p.toLowerCase();
      if (seen.has(key)) return false; // paragraf i përsëritur brenda faqes
      seen.add(key);
      return true;
    });

  const cleanLang = lang ? String(lang).trim().toLowerCase().split(/[-_]/)[0]! : null;
  return {
    title: clean(title) || clean(meta['og:title'] || '') || clean(h1),
    description: clean(meta.description || meta['og:description'] || '').slice(0, 500),
    canonical,
    lang: cleanLang && /^[a-z]{2,3}$/.test(cleanLang) ? cleanLang : null,
    publishedAt: isoDate(meta['article:published_time'] || meta.datepublished || meta['dc.date'] || firstTime || undefined),
    modifiedAt: isoDate(meta['article:modified_time'] || meta['og:updated_time'] || meta.datemodified || undefined),
    paragraphs,
    links: [...links],
    noindex: /\b(noindex|none)\b/.test(robots),
    nofollow: /\b(nofollow|none)\b/.test(robots),
  };
}

// Hash i shkurtër i një paragrafi (për boilerplate midis faqeve).
export function paragraphHash(p: string): string {
  return createHash('sha256').update(p.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

// Kodimi i HTML: header-i Content-Type, pastaj <meta charset>, ndryshe UTF-8.
export function decodeHtml(body: Buffer, contentType: string | undefined): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  const head = body.subarray(0, 2048).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  const charset = (fromHeader || fromMeta || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset === 'iso-8859-1' ? 'windows-1252' : charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}
