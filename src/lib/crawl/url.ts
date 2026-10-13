// Normalizimi i URL-ve: e njëjta faqe duhet të ketë një çelës të vetëm, përndryshe
// crawl-i dyfishon dokumente (dhe kosto embeddings) ose rrotullohet në cikle.

// Parametra që nuk ndryshojnë përmbajtjen (gjurmim, sesione).
const DROP_PARAMS = /^(utm_[a-z0-9_]*|gclid|dclid|fbclid|msclkid|yclid|mc_cid|mc_eid|_ga|_gl|_hs[a-z]*|ref|ref_src|igshid|phpsessid|jsessionid|sid|sessionid|replytocom|share|amp)$/i;

// Skedarë që nuk janë faqe HTML (PDF-të mund të shtohen më vonë si hap më vete).
const NON_HTML_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp[34]|m4a|mov|avi|webm|ogg|wav|zip|rar|7z|gz|tgz|tar|exe|dmg|apk|msi|iso|bin|css|js|mjs|json|xml|rss|atom|txt|csv|xlsx?|docx?|pptx?|odt|ods|woff2?|ttf|eot|otf)$/i;

// Seksione që për një site tipik (sidomos WordPress) janë pa vlerë ose private.
export const DEFAULT_EXCLUDES = [
  '/wp-admin/',
  '/wp-login.php',
  '/wp-json/',
  '/xmlrpc.php',
  '/wp-content/',
  '/wp-includes/',
  '/feed/',
  '*/feed/$',
  '/cart/',
  '/checkout/',
  '/my-account/',
  '/login/',
  '/logout/',
  '/?s=',
  '*?s=*',
  '*add-to-cart=*',
  '*/trackback/',
  '/cdn-cgi/',
];

export const MAX_URL_LENGTH = 2000;
const MAX_QUERY_PARAMS = 5;

// Host-i "bazë" i një site-i: pa www. Crawl-i lejon host-in dhe variantin www.
export function siteHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = base ? new URL(raw.trim(), base) : new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';

  // Rrugë: pa // të përsëritura, pa index.html/php në fund.
  let path = url.pathname.replace(/\/{2,}/g, '/');
  path = path.replace(/\/index\.(html?|php)$/i, '/');
  url.pathname = path || '/';

  const kept = [...url.searchParams.entries()].filter(([k]) => !DROP_PARAMS.test(k));
  if (kept.length > MAX_QUERY_PARAMS) return null; // filtra/kombinime pa fund (faceted navigation)
  kept.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  url.search = kept.length ? `?${new URLSearchParams(kept).toString()}` : '';

  const out = url.toString();
  return out.length > MAX_URL_LENGTH ? null : out;
}

export function inScope(url: string, host: string): boolean {
  try {
    return siteHost(new URL(url).hostname) === host;
  } catch {
    return false;
  }
}

export function looksLikeHtml(url: string): boolean {
  try {
    return !NON_HTML_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// Model: prefiks rruge ("/blog/"), me * si "çdo gjë" ("*/tag/*") dhe $ për fund të
// saktë ("/cart/$"). Krahasohet me path+query, pa dallim shkronjash.
export function matchesPattern(url: string, pattern: string): boolean {
  let target: string;
  try {
    const u = new URL(url);
    target = `${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return false;
  }
  let p = pattern.trim().toLowerCase();
  const exact = p.endsWith('$');
  if (exact) p = p.slice(0, -1);
  if (!p) return false;
  if (!p.includes('*')) return exact ? target === p : target.startsWith(p);
  const body = p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${exact ? '$' : ''}`).test(target);
}

export function isExcluded(url: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(url, p));
}

// Validim i modeleve që vendos administratori (UI/plugin).
export function cleanPatterns(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    let p = raw.trim();
    if (!p) continue;
    // Pranohet edhe URL e plotë: mbahet vetëm rruga.
    if (/^https?:\/\//i.test(p)) {
      try {
        const u = new URL(p);
        p = `${u.pathname}${u.search}`;
      } catch {
        return null;
      }
    }
    if (p.length > 300 || !/^[\x21-\x7e]+$/.test(p)) return null;
    if (!p.startsWith('/') && !p.startsWith('*')) p = `/${p}`;
    if (!out.includes(p)) out.push(p);
  }
  return out.length <= 100 ? out : null;
}
