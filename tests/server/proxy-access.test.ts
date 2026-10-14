import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { NextRequest } from 'next/server';
import { clientKey, hostAllowed, loginBlocked, loginFailed, loginLimitSize, passwordOk, proxy, resetLoginLimit } from '../../src/proxy';
import { allowedHostsWarning } from '../../src/instrumentation';
import { PEER_HEADER, installPeerStamp, normalizeIp, openWithoutPassword } from '../../src/server/access';

// Host check with the real socket address, UTF-8 passwords, login throttle, warning for ALLOWED_HOSTS without password.
const prev = { pw: process.env.LOTSE_PASSWORD, hosts: process.env.ALLOWED_HOSTS };
delete process.env.LOTSE_PASSWORD; process.env.ALLOWED_HOSTS = '';
test.after(() => {
  if (prev.pw === undefined) delete process.env.LOTSE_PASSWORD; else process.env.LOTSE_PASSWORD = prev.pw;
  if (prev.hosts === undefined) delete process.env.ALLOWED_HOSTS; else process.env.ALLOWED_HOSTS = prev.hosts;
  resetLoginLimit();
});

const basic = (pw: string, user = 'lotse') => 'Basic ' + Buffer.from(`${user}:${pw}`, 'utf8').toString('base64');
const call = async (path: string, headers: Record<string, string>, method = 'GET') => proxy(new NextRequest(`http://127.0.0.1:3333${path}`, { method, headers }));

test('forged X-Forwarded-For: 127.0.0.1 does not help if the socket address is public', async () => {
  assert.equal(hostAllowed('localhost', '127.0.0.1'), true, 'without peer (tests, old path) only X-Forwarded-For counts');
  assert.equal(hostAllowed('localhost', '127.0.0.1', '203.0.113.5'), false, 'spoof: Next passes the client header through unchanged');
  assert.equal(hostAllowed('localhost:3333', null, '203.0.113.5'), false);
  assert.equal(hostAllowed('localhost', '127.0.0.1', '127.0.0.1'), true);
  assert.equal(hostAllowed('localhost', null, '::1'), true);
  assert.equal(hostAllowed('localhost', '::ffff:127.0.0.1', '::ffff:127.0.0.1'), true, 'Dual-Stack-Bind: IPv4 in IPv6');
  assert.equal(hostAllowed('localhost', '203.0.113.5', '127.0.0.1'), false, 'local reverse proxy forwards a public address');
  assert.equal(hostAllowed('[::1]', '', ''), true, 'empty peer (unknown) same as none');
  process.env.ALLOWED_HOSTS = 'lotse.example';
  assert.equal(hostAllowed('lotse.example', '127.0.0.1', '203.0.113.5'), true, 'allowed names may come from outside');
  process.env.ALLOWED_HOSTS = '';
  assert.equal((await call('/api/chats', { host: 'localhost:3333', 'x-forwarded-for': '127.0.0.1', [PEER_HEADER]: '203.0.113.5' })).status, 403);
  assert.equal((await call('/api/chats', { host: 'localhost:3333', 'x-forwarded-for': '127.0.0.1', [PEER_HEADER]: '127.0.0.1' })).status, 200);
  assert.equal(normalizeIp(' [::FFFF:10.0.0.1] '), '10.0.0.1');
});

test('peer stamp on the HTTP server overrides a value sent by the client', async () => {
  class Fake extends EventEmitter {}
  installPeerStamp(Fake.prototype); installPeerStamp(Fake.prototype); // once is enough, twice does no harm
  const fake = new Fake(); let seen: unknown;
  fake.on('request', (req: { headers: Record<string, string> }) => { seen = req.headers[PEER_HEADER]; });
  fake.emit('request', { headers: { [PEER_HEADER]: '127.0.0.1' }, socket: { remoteAddress: '::ffff:198.51.100.7' } });
  assert.equal(seen, '198.51.100.7');
  fake.emit('request', { headers: { [PEER_HEADER]: '127.0.0.1' }, socket: {} });
  assert.equal(seen, '', 'unknown address: empty, never the client value');

  installPeerStamp(http.Server.prototype); // like instrumentation.ts
  const server = http.createServer((req, res) => res.end(String(req.headers[PEER_HEADER])));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as { port: number };
    const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { [PEER_HEADER]: '8.8.8.8' } });
    assert.equal(await r.text(), '127.0.0.1');
  } finally { server.close(); }
});

test('basic auth: password as UTF-8 (umlauts, emoji), colon in password, no header is no failed attempt', async () => {
  assert.equal(await passwordOk(basic('pässwört'), 'pässwört'), true);
  assert.equal(await passwordOk(basic('🔒geheim:mit:doppelpunkt'), '🔒geheim:mit:doppelpunkt'), true);
  assert.equal(await passwordOk(basic('passwort'), 'pässwört'), false);
  assert.equal(await passwordOk('basic ' + Buffer.from('x:abc').toString('base64'), 'abc'), true, 'scheme case-insensitive');
  assert.equal(await passwordOk('Basic %%%', 'abc'), false, 'broken Base64');
  assert.equal(await passwordOk(null, 'abc'), null);
  assert.equal(await passwordOk('Bearer xyz', 'abc'), null);
});

test('login throttle: 429 after 10 failed attempts (even with the right password), other addresses unaffected, free again afterwards', async () => {
  resetLoginLimit();
  process.env.LOTSE_PASSWORD = 'pässwört';
  try {
    const from = (peer: string, auth?: string) => call('/api/chats', { host: 'localhost:3333', [PEER_HEADER]: peer, ...(auth ? { authorization: auth } : {}) });
    process.env.ALLOWED_HOSTS = 'lotse.example';
    const remote = (auth?: string) => call('/api/chats', { host: 'lotse.example', [PEER_HEADER]: '203.0.113.9', ...(auth ? { authorization: auth } : {}) });
    for (let i = 0; i < 20; i++) assert.equal((await remote()).status, 401, 'without credentials does not count');
    assert.equal((await remote(basic('pässwört'))).status, 200, 'UTF-8 password through the proxy');
    for (let i = 0; i < 9; i++) assert.equal((await remote(basic('falsch' + i))).status, 401);
    const blocked = await remote(basic('falsch'));
    assert.equal(blocked.status, 401, '10th failed attempt itself still 401');
    const r = await remote(basic('pässwört'));
    assert.equal(r.status, 429, 'blocked, even with the right password');
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal((await from('127.0.0.1', basic('pässwört'))).status, 200, 'other address');
    const key = clientKey('203.0.113.9', null);
    assert.ok(loginBlocked(key) > 0);
    assert.equal(loginBlocked(key, Date.now() + 5 * 60_000 + 1), 0, 'free again after 5 minutes');
  } finally { delete process.env.LOTSE_PASSWORD; process.env.ALLOWED_HOSTS = ''; resetLoginLimit(); }
});

test('login throttle: key per client, window expires, memory bounded', () => {
  resetLoginLimit();
  assert.equal(clientKey('203.0.113.5', '127.0.0.1'), '203.0.113.5', 'public peer counts, not the header');
  assert.equal(clientKey('127.0.0.1', '198.51.100.1, 203.0.113.5'), '203.0.113.5', 'local reverse proxy: last hop');
  assert.equal(clientKey('127.0.0.1', null), '127.0.0.1');
  assert.equal(clientKey(null, null), 'unbekannt');
  process.env.LOTSE_TRUSTED_PROXIES = '10.0.5.0/24, 192.0.2.7';
  try {
    assert.equal(clientKey('10.0.5.9', '198.51.100.1, 203.0.113.8'), '203.0.113.8', 'trusted proxy (CIDR): last hop');
    assert.equal(clientKey('192.0.2.7', '203.0.113.9'), '203.0.113.9', 'trusted proxy (IP)');
    assert.equal(clientKey('10.0.6.9', '203.0.113.8'), '10.0.6.9', 'outside the network: peer counts');
  } finally { delete process.env.LOTSE_TRUSTED_PROXIES; }
  const t0 = 1_000_000;
  for (let i = 0; i < 9; i++) loginFailed('a', t0);
  loginFailed('a', t0 + 16 * 60_000); // window expired: counts anew
  assert.equal(loginBlocked('a', t0 + 16 * 60_000), 0);
  for (let i = 0; i < 6000; i++) loginFailed(`ip-${i}`, t0);
  assert.ok(loginLimitSize() <= 5000, `bounded: ${loginLimitSize()}`);
  resetLoginLimit();
});

test('warning: ALLOWED_HOSTS without LOTSE_PASSWORD (loopback names do not count)', () => {
  assert.match(allowedHostsWarning({ ALLOWED_HOSTS: 'lotse.example, 127.0.0.1' }) ?? '', /ALLOWED_HOSTS \(lotse\.example\).*LOTSE_PASSWORD/);
  assert.equal(allowedHostsWarning({ ALLOWED_HOSTS: 'lotse.example', LOTSE_PASSWORD: 'x' }), null);
  assert.equal(allowedHostsWarning({}), null, 'Docker smoke test without either stays silent');
  assert.equal(allowedHostsWarning({ ALLOWED_HOSTS: 'localhost, ::1' }), null);
  assert.equal(openWithoutPassword({ ALLOWED_HOSTS: 'a.example' }), true);
});
