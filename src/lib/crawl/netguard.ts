import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Transform } from 'node:stream';

// ---------------------------------------------------------------------------
// Mbrojtja SSRF. Crawler-i merr URL nga klienti dhe nga faqet e tij, pra nga
// burime të pabesueshme. Rregullat zbatohen në ÇDO hop (edhe pas ridrejtimeve):
//   * vetëm http/https, vetëm portet e lejuara, pa user:pass në URL;
//   * host-i zgjidhet me DNS dhe REFUZOHET nëse ndonjë adresë është private,
//     loopback, link-local (169.254.169.254 = metadata e cloud-it), CGNAT, multicast…;
//   * lidhja hapet me adresën që sapo u verifikua (lookup i "ngulur"): një DNS
//     rebinding midis kontrollit dhe lidhjes nuk ka efekt.
// robots.txt NUK është kontroll sigurie; këto rregulla zbatohen pavarësisht prej tij.
// ---------------------------------------------------------------------------

export type FetchErrorCode =
  | 'bad_url'
  | 'bad_scheme'
  | 'bad_port'
  | 'credentials_in_url'
  | 'forbidden_address'
  | 'dns_failed'
  | 'timeout'
  | 'too_large'
  | 'too_many_redirects'
  | 'network';

export class FetchError extends Error {
  code: FetchErrorCode;
  url: string;

  constructor(code: FetchErrorCode, url: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.url = url;
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (ipv4ToInt(base) & mask);
}

const V4_BLOCKED: [string, number, string][] = [
  ['0.0.0.0', 8, 'this_network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link_local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'ietf'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmark'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

// 8 grupe 16-bit nga çdo shkrim IPv6 (::, IPv4 i futur në fund).
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    if (isIP(maybeV4) !== 4) return null;
    const n = ipv4ToInt(maybeV4);
    tail = [n >>> 16, n & 0xffff];
    s = `${s.slice(0, lastColon + 1)}${tail.length ? '0:0' : ''}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':').map((h) => parseInt(h, 16)) : []);
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...new Array<number>(Math.max(fill, 0)).fill(0), ...rest];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  if (tail.length) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

// Kthen arsyen e bllokimit, ose null nëse adresa është publike.
export function forbiddenAddressReason(ip: string): string | null {
  const family = isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    if (n === 0xffffffff) return 'broadcast';
    for (const [base, bits, reason] of V4_BLOCKED) if (inV4(n, base, bits)) return reason;
    return null;
  }
  if (family === 6) {
    const g = expandV6(ip);
    if (!g) return 'invalid';
    if (g.every((x) => x === 0)) return 'unspecified';
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
    const embeddedV4 = `${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`;
    // ::ffff:a.b.c.d (IPv4-mapped) dhe ::a.b.c.d (i vjetruar): vlen rregulli i IPv4.
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      return forbiddenAddressReason(embeddedV4) ?? (g[5] === 0 ? 'deprecated' : null);
    }
    // NAT64 64:ff9b::/96 — IPv4 i përkthyer.
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
      return forbiddenAddressReason(embeddedV4);
    }
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return 'nat64_local';
    if ((g[0]! & 0xfe00) === 0xfc00) return 'unique_local';
    if ((g[0]! & 0xffc0) === 0xfe80) return 'link_local';
    if ((g[0]! & 0xffc0) === 0xfec0) return 'site_local';
    if ((g[0]! & 0xff00) === 0xff00) return 'multicast';
    if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation';
    if (g[0] === 0x2001 && g[1] === 0) return 'teredo';
    if (g[0] === 0x2002) return '6to4';
    if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return 'discard';
    // Vetëm adresat globale unicast (2000::/3) lejohen.
    if ((g[0]! & 0xe000) !== 0x2000) return 'not_global';
    return null;
  }
  return 'invalid';
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

export type NetPolicy = {
  allowedPorts: number[];
  resolver?: Resolver;
  // VETËM për teste lokale: host -> "ip:port". Anashkalon kontrollin e adresës për
  // këta host-e. Nuk lexohet kurrë në production (shih crawl/config.ts).
  hostMap?: Record<string, string>;
};

export type CheckedTarget = { url: URL; address: string; family: number; port: number };

// Validon URL-në dhe zgjidh host-in në një adresë publike. Hedh FetchError.
export async function checkTarget(raw: string, policy: NetPolicy): Promise<CheckedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError('bad_url', raw);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('bad_scheme', raw);
  if (url.username || url.password) throw new FetchError('credentials_in_url', raw);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!policy.allowedPorts.includes(port)) throw new FetchError('bad_port', raw, String(port));

  // URL e parsuar normalizon edhe shkrime si http://2130706433/ ose http://0x7f.1/ në IPv4.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) throw new FetchError('bad_url', raw);

  const mapped = policy.hostMap?.[hostname];
  if (mapped) {
    const i = mapped.lastIndexOf(':');
    return { url, address: mapped.slice(0, i), family: isIP(mapped.slice(0, i)) || 4, port: Number(mapped.slice(i + 1)) };
  }

  if (isIP(hostname)) {
    const reason = forbiddenAddressReason(hostname);
    if (reason) throw new FetchError('forbidden_address', raw, reason);
    return { url, address: hostname, family: isIP(hostname), port };
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || !hostname.includes('.')) {
    throw new FetchError('forbidden_address', raw, 'local_name');
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await (policy.resolver ?? systemResolver)(hostname);
  } catch {
    throw new FetchError('dns_failed', raw);
  }
  if (!addresses.length) throw new FetchError('dns_failed', raw);
  // Nëse EDHE NJË adresë është e ndaluar, refuzo: përndryshe sulmuesi përzien
  // një IP publike me 127.0.0.1 dhe shpreson që lidhja të bjerë te e dyta.
  for (const a of addresses) {
    const reason = forbiddenAddressReason(a.address);
    if (reason) throw new FetchError('forbidden_address', raw, reason);
  }
  return { url, address: addresses[0]!.address, family: addresses[0]!.family, port };
}

export type SafeResponse = {
  status: number;
  url: string; // URL-ja përfundimtare pas ridrejtimeve
  redirects: string[];
  headers: Record<string, string>;
  body: Buffer;
};

export type SafeFetchOptions = NetPolicy & {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  headers?: Record<string, string>;
};

function decoder(encoding: string | undefined): Transform | null {
  switch ((encoding || '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      return null;
  }
}

function oneHop(target: CheckedTarget, opts: SafeFetchOptions): Promise<{ res: IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const { url } = target;
    const raw = url.toString();
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const fail = (e: FetchError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(e);
    };

    const req = requestFn({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: target.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      // Lidhja shkon VETËM te adresa e verifikuar (kundër DNS rebinding).
      lookup: ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
        if (options?.all) cb(null, [{ address: target.address, family: target.family }]);
        else cb(null, target.address, target.family);
      }) as unknown as LookupFunction,
      headers: {
        // Host nga URL-ja, jo nga adresa/porti ku lidhemi (hostMap në teste).
        host: url.host,
        'user-agent': opts.userAgent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'accept-encoding': 'gzip, deflate, br',
        // Pa cookies, pa autentikim: lexojmë vetëm atë që është publike.
        ...opts.headers,
      },
      agent: false,
    });

    const timer = setTimeout(() => fail(new FetchError('timeout', raw)), opts.timeoutMs);

    req.on('error', (e) => fail(e instanceof FetchError ? e : new FetchError('network', raw, (e as Error).message)));
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        settled = true;
        clearTimeout(timer);
        resolve({ res, body: Buffer.alloc(0) });
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        fail(new FetchError('too_large', raw));
        return;
      }
      // Kufiri zbatohet pas dekompresimit: një "zip bomb" i vogël nuk e kalon dot.
      const dec = decoder(res.headers['content-encoding']);
      const stream = dec ? res.pipe(dec) : res;
      const parts: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > opts.maxBytes) {
          dec?.destroy();
          fail(new FetchError('too_large', raw));
          return;
        }
        parts.push(chunk);
      });
      stream.on('error', (e: Error) => fail(new FetchError('network', raw, e.message)));
      stream.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ res, body: Buffer.concat(parts) });
      });
    });
    req.end();
  });
}

function flatHeaders(res: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

// GET me kontrollet e mësipërme në çdo hop. Ridrejtimet ndiqen manualisht.
export async function safeFetch(raw: string, opts: SafeFetchOptions): Promise<SafeResponse> {
  const redirects: string[] = [];
  let current = raw;
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const target = await checkTarget(current, opts);
    const { res, body } = await oneHop(target, opts);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      let next: string;
      try {
        next = new URL(location, target.url).toString();
      } catch {
        throw new FetchError('bad_url', location);
      }
      redirects.push(next);
      current = next;
      continue;
    }
    return { status, url: target.url.toString(), redirects, headers: flatHeaders(res), body };
  }
  throw new FetchError('too_many_redirects', raw);
}
