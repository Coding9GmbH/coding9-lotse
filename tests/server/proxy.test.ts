import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { hostAllowed, proxy } from '../../src/proxy';
import { bindWarning } from '../../src/instrumentation';

delete process.env.LOTSE_PASSWORD;
const prevAllowed = process.env.ALLOWED_HOSTS;
process.env.ALLOWED_HOSTS = '';
test.after(() => {
  if (prevAllowed === undefined) delete process.env.ALLOWED_HOSTS;
  else process.env.ALLOWED_HOSTS = prevAllowed;
});

const status = async (path: string, headers: Record<string, string>, method = 'GET') =>
  (await proxy(new NextRequest(`http://127.0.0.1:3333${path}`, { method, headers }))).status;

test('loopback host only without X-Forwarded-For or when every hop is loopback', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', '::1', '127.0.0.1:3333']) {
    assert.equal(hostAllowed(host, null), true, host);
    assert.equal(hostAllowed(host, ''), true, `${host} empty header`);
    assert.equal(hostAllowed(host, '127.0.0.1, ::1, localhost'), true, host);
  }
  assert.equal(hostAllowed('127.0.0.1', '203.0.113.5'), false, 'public hop');
  assert.equal(hostAllowed('localhost', '127.0.0.1, 203.0.113.5'), false, 'public hop in the chain');
  assert.equal(hostAllowed('[::1]', '8.8.8.8'), false);
  assert.equal(hostAllowed('127.0.0.1', '203.0.113.5, 127.0.0.1'), false);
});

test('container with loopback publish: Docker gateway (private) ok, public hop not', () => {
  const prev = { d: process.env.AICB_DOCKER, b: process.env.LOTSE_BIND };
  try {
    assert.equal(hostAllowed('localhost:3333', '192.168.215.1'), false, 'outside Docker');
    process.env.AICB_DOCKER = '1'; process.env.LOTSE_BIND = '127.0.0.1';
    for (const hop of ['192.168.215.1', '172.17.0.1', '10.0.0.2', '198.19.249.1']) assert.equal(hostAllowed('localhost:3333', hop), true, hop);
    assert.equal(hostAllowed('localhost:3333', '203.0.113.5'), false);
    assert.equal(hostAllowed('localhost:3333', '192.168.215.1, 203.0.113.5'), false);
    process.env.LOTSE_BIND = '0.0.0.0';
    assert.equal(hostAllowed('localhost:3333', '192.168.215.1'), false, 'port not published on loopback only');
  } finally {
    if (prev.d === undefined) delete process.env.AICB_DOCKER; else process.env.AICB_DOCKER = prev.d;
    if (prev.b === undefined) delete process.env.LOTSE_BIND; else process.env.LOTSE_BIND = prev.b;
  }
});

test('other hosts only via ALLOWED_HOSTS, also with public X-Forwarded-For', () => {
  assert.equal(hostAllowed('lotse.example', null), false);
  assert.equal(hostAllowed('lotse.example', '203.0.113.5'), false);
  process.env.ALLOWED_HOSTS = 'lotse.example, shop.example';
  assert.equal(hostAllowed('lotse.example', '203.0.113.5'), true);
  assert.equal(hostAllowed('shop.example:3333', null), true);
  assert.equal(hostAllowed('fremd.example', null), false);
  process.env.ALLOWED_HOSTS = '127.0.0.1';
  assert.equal(hostAllowed('127.0.0.1', '203.0.113.5'), false, 'loopback stays bound to the hops');
  process.env.ALLOWED_HOSTS = '';
});

test('proxy: direct loopback request passes, public hop to 127.0.0.1 gets 403', async () => {
  assert.equal(await status('/api/chats', { host: '127.0.0.1:3333' }), 200, 'without X-Forwarded-For');
  assert.equal(await status('/api/chats', { host: 'localhost:3333', 'x-forwarded-for': '::1' }), 200);
  assert.equal(await status('/api/chats', { host: '127.0.0.1:3333', 'x-forwarded-for': '203.0.113.5' }), 403);
  assert.equal(await status('/api/ping', { host: '127.0.0.1:3333', 'x-forwarded-for': '203.0.113.5' }, 'POST'), 200, 'health check skips the host check');
  assert.equal(await status('/api/approve', { host: '127.0.0.1:3333', origin: 'null', 'x-lotse': '1' }, 'POST'), 403, 'origin null stays blocked');
  assert.equal(await status('/api/approve', { host: '127.0.0.1:3333', origin: 'http://127.0.0.1:3333' }, 'POST'), 403, 'marker header stays mandatory');
});

test('bindWarning: outside Docker on non-loopback, in the container when LOTSE_BIND is missing or not loopback', () => {
  const offen = 'WARNUNG: Lotse lauscht auf 0.0.0.0 ohne LOTSE_PASSWORD – jeder im Netzwerk könnte Änderungen am Shop freigeben.';
  assert.equal(bindWarning({ HOSTNAME: '0.0.0.0' }), offen);
  assert.equal(bindWarning({ HOST: '192.168.1.10' }), offen.replace('0.0.0.0', '192.168.1.10'));
  assert.equal(bindWarning({ HOSTNAME: '127.0.0.1' }), null);
  assert.equal(bindWarning({ HOSTNAME: 'localhost' }), null);
  assert.equal(bindWarning({}), null);
  assert.equal(bindWarning({ HOSTNAME: '0.0.0.0', LOTSE_PASSWORD: 'geheim' }), null);
  assert.equal(bindWarning({ AICB_DOCKER: '1', LOTSE_BIND: '127.0.0.1', HOSTNAME: '0.0.0.0' }), null, 'Compose bind stays silent');
  const missing = bindWarning({ AICB_DOCKER: '1', HOSTNAME: '0.0.0.0' });
  assert.ok(missing, 'LOTSE_BIND missing');
  assert.match(missing ?? '', /LOTSE_BIND/);
  assert.doesNotMatch(missing ?? '', /lauscht auf/, 'the previous warning is reserved for running outside Docker');
  const published = bindWarning({ AICB_DOCKER: '1', LOTSE_BIND: '0.0.0.0', LOTSE_PASSWORD: 'geheim' });
  assert.match(published ?? '', /LOTSE_BIND/);
  assert.equal(bindWarning({ AICB_DOCKER: '1', LOTSE_BIND: '127.0.0.1', HOSTNAME: '0.0.0.0' }), null);
  assert.equal(bindWarning({ AICB_DOCKER: '1', LOTSE_BIND: 'localhost' }), null);
  assert.equal(bindWarning({ AICB_DOCKER: '1', LOTSE_BIND: '::1' }), null);
  assert.match(bindWarning({ AICB_DOCKER: '1', LOTSE_BIND: '[::1]' }) ?? '', /LOTSE_BIND/);
});
