import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Token i widget-it: payload.base64url + '.' + HMAC-SHA256.
// Lidh shfletuesin e një vizitori me NJË bisedë të NJË tenant-i.
// ---------------------------------------------------------------------------
export type WidgetToken = {
  t: string; // tenant id
  c: string; // conversation id
  exp: number; // unix seconds
};

function hmac(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function signWidgetToken(payload: WidgetToken, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body, secret).toString('base64url')}`;
}

export function verifyWidgetToken(token: unknown, secret: string): WidgetToken | null {
  if (typeof token !== 'string' || token.length > 600) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;

  const expected = hmac(body, secret);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as WidgetToken;
    if (typeof p.t !== 'string' || typeof p.c !== 'string' || typeof p.exp !== 'number') return null;
    if (p.exp < Date.now() / 1000) return null;
    return p;
  } catch {
    return null;
  }
}

// Krahasim në kohë konstante për sekrete me gjatësi të ndryshme.
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// Enkriptim i sekreteve të kanaleve (token i bot-it) para se të ruhen në DB.
// AES-256-GCM, format: v1.<iv>.<tag>.<ciphertext> (base64url).
// Çelësi (CHANNEL_ENCRYPTION_KEY, 64 hex) rri vetëm në env të Vercel:
// një dump i DB-së pa çelësin nuk i jep askujt kontrollin e bot-eve.
// ---------------------------------------------------------------------------
function key(keyHex: string): Buffer {
  const k = Buffer.from(keyHex, 'hex');
  if (k.length !== 32) throw new Error('CHANNEL_ENCRYPTION_KEY duhet të jetë 64 karaktere hex (openssl rand -hex 32)');
  return k;
}

export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(keyHex), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptSecret(enc: string, keyHex: string): string {
  const [v, iv, tag, data] = enc.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('format i panjohur sekreti');
  const decipher = createDecipheriv('aes-256-gcm', key(keyHex), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
