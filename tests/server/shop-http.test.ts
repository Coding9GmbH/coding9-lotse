// Shared shop protection: concurrency limiter, retry on 429/503 with Retry-After, body cancelled before retry, error type.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLimiter, shopFetch } from '../../src/server/shop-http';

type Step = { status: number; headers?: Record<string, string>; big?: boolean };
let script: Step[] = [], calls = 0, closed = 0;
const server = http.createServer((req, res) => {
  const s = script[Math.min(calls++, script.length - 1)];
  res.writeHead(s.status, { 'content-type': 'application/json', ...s.headers });
  if (!s.big) { res.end(JSON.stringify({ n: calls })); return; }
  // Endless body: only finishes when the client cancels (closes the connection)
  res.on('close', () => closed++);
  const t = setInterval(() => res.write('x'.repeat(65_536)), 1);
  res.on('close', () => clearInterval(t));
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
after(() => { server.closeAllConnections(); server.close(); });
const opts = { shop: 'test', name: 'Testshop', timeoutMs: 5_000 };
const run = async (steps: Step[], init: RequestInit = {}) => { script = steps; calls = 0; const r = await shopFetch(url, init, opts); await r.text(); return { status: r.status, calls }; };

test('limiter caps concurrency and runs every call', async () => {
  const slot = createLimiter(2);
  let active = 0, peak = 0;
  const job = (i: number) => slot(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 10)); active--; return i; });
  assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map(job)), [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  await assert.rejects(slot(() => Promise.reject(new Error('x'))), /x/);
  peak = 0; await Promise.all([1, 2, 3].map(job)); assert.equal(peak, 2, 'a failed call releases its slot');
});

test('429 is retried honouring Retry-After, at most 2 retries', async () => {
  let t = Date.now();
  assert.deepEqual(await run([{ status: 429, headers: { 'retry-after': '1' } }, { status: 200 }]), { status: 200, calls: 2 });
  assert.ok(Date.now() - t >= 950, 'waited ~1 s as demanded by Retry-After');
  t = Date.now();
  assert.deepEqual(await run([{ status: 429, headers: { 'retry-after': '0' } }]), { status: 429, calls: 3 });
  assert.ok(Date.now() - t < 900, 'Retry-After: 0 = no pause');
});

test('503 is retried for reads only, writes only on 429', async () => {
  assert.deepEqual(await run([{ status: 503, headers: { 'retry-after': '0' } }, { status: 200 }]), { status: 200, calls: 2 });
  assert.deepEqual(await run([{ status: 503, headers: { 'retry-after': '0' } }, { status: 200 }], { method: 'POST' }), { status: 503, calls: 1 });
  assert.deepEqual(await run([{ status: 429, headers: { 'retry-after': '0' } }, { status: 200 }], { method: 'POST' }), { status: 200, calls: 2 });
});

test('the discarded 429 body is cancelled before the retry', async () => {
  closed = 0;
  assert.deepEqual(await run([{ status: 429, headers: { 'retry-after': '0' }, big: true }, { status: 200 }]), { status: 200, calls: 2 });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(closed, 1, 'connection of the endless 429 body was closed');
});

test('network errors throw the error type from toError with the shop name', async () => {
  const tmp = http.createServer(); await new Promise<void>(r => tmp.listen(0, '127.0.0.1', r));
  const dead = `http://127.0.0.1:${(tmp.address() as AddressInfo).port}/`; await new Promise(r => tmp.close(r));
  class ShopErr extends Error { constructor(m: string, public status: number) { super(m); } }
  const e = await shopFetch(dead, {}, { ...opts, toError: m => new ShopErr(m, 0) }).catch(x => x);
  assert.ok(e instanceof ShopErr); assert.equal(e.status, 0); assert.match(e.message, /^Testshop nicht erreichbar: ECONNREFUSED/);
  await assert.rejects(shopFetch(dead, {}, opts), (x: Error) => x.constructor === Error && /^Testshop nicht erreichbar/.test(x.message));
});
