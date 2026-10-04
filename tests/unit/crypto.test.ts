import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decryptSecret,
  encryptSecret,
  randomToken,
  safeEqual,
  signWidgetToken,
  verifyWidgetToken,
} from '../../src/lib/crypto.ts';

const SECRET = 'a'.repeat(64);
const future = () => Math.floor(Date.now() / 1000) + 3600;

test('token i vlefshëm verifikohet', () => {
  const token = signWidgetToken({ t: 'tenant', c: 'conv', exp: future() }, SECRET);
  assert.deepEqual(verifyWidgetToken(token, SECRET), { t: 'tenant', c: 'conv', exp: verifyWidgetToken(token, SECRET)!.exp });
});

test('token i skaduar refuzohet', () => {
  const token = signWidgetToken({ t: 't', c: 'c', exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
  assert.equal(verifyWidgetToken(token, SECRET), null);
});

test('payload i ndryshuar (tenant tjetër) refuzohet', () => {
  const token = signWidgetToken({ t: 'tenant-a', c: 'conv', exp: future() }, SECRET);
  const forged = Buffer.from(JSON.stringify({ t: 'tenant-b', c: 'conv', exp: future() })).toString('base64url');
  assert.equal(verifyWidgetToken(`${forged}.${token.split('.')[1]}`, SECRET), null);
});

test('sekret tjetër, format i gabuar, tipe të gabuara -> null', () => {
  const token = signWidgetToken({ t: 't', c: 'c', exp: future() }, SECRET);
  assert.equal(verifyWidgetToken(token, 'b'.repeat(64)), null);
  assert.equal(verifyWidgetToken('abc', SECRET), null);
  assert.equal(verifyWidgetToken('a.b.c', SECRET), null);
  assert.equal(verifyWidgetToken(null, SECRET), null);
  assert.equal(verifyWidgetToken(undefined, SECRET), null);
  assert.equal(verifyWidgetToken('x'.repeat(5000), SECRET), null);
});

test('enkriptimi i sekretit: vajtje-ardhje, IV i rastësishëm, zbulim ndryshimi', () => {
  const key = randomToken(32);
  const plain = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
  const a = encryptSecret(plain, key);
  const b = encryptSecret(plain, key);
  assert.notEqual(a, b);
  assert.ok(!a.includes(plain));
  assert.equal(decryptSecret(a, key), plain);
  assert.throws(() => decryptSecret(a, randomToken(32)));
  const parts = a.split('.');
  parts[3] = Buffer.from('tjetër').toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.'), key));
  assert.throws(() => encryptSecret(plain, 'shkurt'));
});

test('safeEqual', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('', 'abc'));
});
