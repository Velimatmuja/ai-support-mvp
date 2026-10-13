import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { checkTarget, FetchError, forbiddenAddressReason, safeFetch } from '../../src/lib/crawl/netguard.ts';
import type { Resolver, SafeFetchOptions } from '../../src/lib/crawl/netguard.ts';

test('adresat private, loopback, link-local, metadata cloud, CGNAT, multicast refuzohen', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.10', '198.18.0.1', '240.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254',
    '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2001:db8::1', '2002:7f00:1::1', 'fec0::1', '::127.0.0.1',
  ];
  for (const ip of blocked) assert.ok(forbiddenAddressReason(ip), `${ip} duhej bllokuar`);
  for (const ip of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
    assert.equal(forbiddenAddressReason(ip), null, `${ip} është publike`);
  }
  assert.equal(forbiddenAddressReason('jo-ip'), 'invalid');
});

const policy = (resolver?: Resolver) => ({ allowedPorts: [80, 443], resolver });
const resolveTo = (...ips: string[]): Resolver => async () => ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    assert.ok(e instanceof FetchError, String(e));
    return e.code;
  }
}

test('checkTarget: skema, porte, kredenciale, IP literale dhe shkrime të maskuara të IP-ve', async () => {
  const pub = resolveTo('93.184.216.34');
  assert.equal(await code(checkTarget('file:///etc/passwd', policy(pub))), 'bad_scheme');
  assert.equal(await code(checkTarget('gopher://x.com/', policy(pub))), 'bad_scheme');
  assert.equal(await code(checkTarget('http://x.com:22/', policy(pub))), 'bad_port');
  assert.equal(await code(checkTarget('http://u:p@x.com/', policy(pub))), 'credentials_in_url');
  assert.equal(await code(checkTarget('not a url', policy(pub))), 'bad_url');
  for (const u of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://localhost/', 'http://intranet/', 'http://a.localhost/']) {
    assert.equal(await code(checkTarget(u, policy(pub))), 'forbidden_address', u);
  }
  assert.equal(await code(checkTarget('https://x.com/', policy(pub))), 'ok');
});

test('checkTarget: DNS që kthen adresë private (ose një publike + një private) refuzohet', async () => {
  assert.equal(await code(checkTarget('https://evil.example/', policy(resolveTo('10.0.0.5')))), 'forbidden_address');
  assert.equal(await code(checkTarget('https://evil.example/', policy(resolveTo('93.184.216.34', '127.0.0.1')))), 'forbidden_address');
  assert.equal(await code(checkTarget('https://evil.example/', policy(resolveTo('fd00::1')))), 'forbidden_address');
  const failing: Resolver = async () => {
    throw new Error('ENOTFOUND');
  };
  assert.equal(await code(checkTarget('https://nope.example/', policy(failing))), 'dns_failed');
});

// Server lokal; arrihet VETËM përmes hostMap (si në e2e), sepse 127.0.0.1 është i ndaluar.
let port = 0;
let lastHost = '';
const server = createServer((req, res) => {
  lastHost = req.headers.host || '';
  const path = req.url || '/';
  if (path === '/ok') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"' });
    res.end('<p>ok</p>');
  } else if (path === '/gzip') {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(gzipSync('<p>' + 'a'.repeat(5000) + '</p>'));
  } else if (path === '/bomb') {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(gzipSync(Buffer.alloc(5_000_000, 97)));
  } else if (path === '/big') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('x'.repeat(300_000));
  } else if (path === '/slow') {
    setTimeout(() => res.end('late'), 3000);
  } else if (path === '/to-meta') {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  } else if (path === '/to-ok') {
    res.writeHead(301, { location: '/ok' });
    res.end();
  } else if (path === '/loop') {
    res.writeHead(302, { location: '/loop' });
    res.end();
  } else if (path === '/to-private-name') {
    res.writeHead(302, { location: 'http://internal.example/' });
    res.end();
  } else {
    res.writeHead(404);
    res.end();
  }
});

before(() => new Promise<void>((r) => server.listen(0, '127.0.0.1', () => ((port = (server.address() as AddressInfo).port), r()))));
after(() => new Promise<void>((r) => server.close(() => r())));

const opts = (extra: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
  allowedPorts: [80, 443],
  hostMap: { 'site.test': `127.0.0.1:${port}` },
  resolver: resolveTo('10.9.9.9'), // çdo host tjetër "zgjidhet" në adresë private
  userAgent: 'ANESPBot-test',
  timeoutMs: 1000,
  maxBytes: 100_000,
  maxRedirects: 3,
  ...extra,
});

test('safeFetch: përgjigje normale, Host header i saktë, gzip, ridrejtim i brendshëm', async () => {
  const r = await safeFetch('http://site.test/ok', opts());
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), '<p>ok</p>');
  assert.equal(r.headers.etag, '"v1"');
  assert.equal(lastHost, 'site.test');
  assert.equal((await safeFetch('http://site.test/gzip', opts())).body.length, 5007);
  const red = await safeFetch('http://site.test/to-ok', opts());
  assert.equal(red.url, 'http://site.test/ok');
  assert.deepEqual(red.redirects, ['http://site.test/ok']);
  assert.equal((await safeFetch('http://site.test/missing', opts())).status, 404);
});

test('safeFetch: ridrejtim drejt metadata-s së cloud-it ose host-i privat bllokohet', async () => {
  assert.equal(await code(safeFetch('http://site.test/to-meta', opts())), 'forbidden_address');
  assert.equal(await code(safeFetch('http://site.test/to-private-name', opts())), 'forbidden_address');
  assert.equal(await code(safeFetch('http://site.test/loop', opts())), 'too_many_redirects');
});

test('safeFetch: kufiri i madhësisë (edhe pas dekompresimit) dhe timeout', async () => {
  assert.equal(await code(safeFetch('http://site.test/big', opts())), 'too_large');
  assert.equal(await code(safeFetch('http://site.test/bomb', opts())), 'too_large');
  const started = Date.now();
  assert.equal(await code(safeFetch('http://site.test/slow', opts({ timeoutMs: 300 }))), 'timeout');
  assert.ok(Date.now() - started < 2000);
});

test('safeFetch: pa hostMap, 127.0.0.1 nuk arrihet dot as direkt', async () => {
  assert.equal(await code(safeFetch(`http://127.0.0.1:${port}/ok`, opts({ allowedPorts: [port] }))), 'forbidden_address');
});
