// OpenMage client: shop protection against a small HTTP server (retry on 429, no retry of writing calls on 503,
// concurrency limit, serial writing calls, timeout message).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.LOTSE_SHOP_TIMEOUT_MS = '5000'; // smallest allowed value; before the import, the client reads it on load
process.env.LOTSE_OPENMAGE_CONCURRENCY = '3';
const { OmClient } = await import('../../../../src/server/platform/openmage/client');

type Hit = { method: string; path: string; t0: number; t1: number };
const hits: Hit[] = [];
let active = 0, maxActive = 0;
let mode: 'ok' | '429-once' | '503' | 'hang' | 'slow' = 'ok';
let first = true;
const server = http.createServer((req, res) => {
  const t0 = Date.now(); active++; maxActive = Math.max(maxActive, active);
  const done = (status: number, body: unknown, headers: Record<string, string> = {}) => { active--; hits.push({ method: req.method ?? '', path: req.url ?? '', t0, t1: Date.now() }); res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  req.on('data', () => {}); req.on('end', () => {
    if (mode === 'hang') return; // never responds (timeout)
    if (mode === '429-once' && first) { first = false; return done(429, { error: { code: 'busy', message: 'Zu viele Anfragen' } }, { 'retry-after': '0' }); }
    if (mode === '503') return done(503, { error: { code: 'maintenance', message: 'Wartung' } });
    setTimeout(() => done(200, { data: { ok: true, path: req.url }, meta: {} }), mode === 'slow' ? 40 : 0);
  });
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const c = new OmClient({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 't' });
test.after(() => new Promise<void>(r => server.close(() => r())));

test('429 with Retry-After: 0 is retried (one result, two requests)', async () => {
  mode = '429-once'; first = true; hits.length = 0;
  const r = await c.req('GET', '/v1/info');
  assert.equal(r.ok, true);
  assert.equal(hits.length, 2);
});

test('503 on POST is NOT retried (otherwise duplicate products/blocks), on GET it is', async () => {
  mode = '503'; hits.length = 0;
  await assert.rejects(c.req('POST', '/v1/cms/blocks', { title: 'x' }), (e: Error & { status: number }) => e.status === 503 && /Wartung/.test(e.message));
  assert.equal(hits.length, 1, 'exactly one POST request');
  hits.length = 0;
  await assert.rejects(c.req('GET', '/v1/info'), (e: Error & { status: number }) => e.status === 503);
  assert.equal(hits.length, 3, 'GET: first attempt + 2 retries');
});

test('at most LOTSE_OPENMAGE_CONCURRENCY requests at once; writing calls one after another', async () => {
  mode = 'slow'; hits.length = 0; maxActive = 0;
  await Promise.all(Array.from({ length: 10 }, (_, i) => c.req('GET', `/v1/products/P${i}`)));
  assert.equal(hits.length, 10); assert.ok(maxActive <= 3 && maxActive >= 2, `at most 3 at once (was ${maxActive})`);
  hits.length = 0;
  await Promise.all([c.req('PATCH', '/v1/products/A', { attributes: { name: 'a' } }), c.req('PATCH', '/v1/products/B', { attributes: { name: 'b' } }), c.req('PUT', '/v1/products/C/stock', { qty: 1 })]);
  const w = [...hits].sort((a, b) => a.t0 - b.t0);
  assert.equal(w.length, 3);
  for (let i = 1; i < w.length; i++) assert.ok(w[i].t0 >= w[i - 1].t1, `writing call ${i} starts only after the previous one (${w[i].t0} < ${w[i - 1].t1})`);
});

test('timeout: understandable message "antwortet nicht" (not responding) (LOTSE_SHOP_TIMEOUT_MS)', async () => {
  mode = 'hang';
  await assert.rejects(c.req('GET', '/v1/info'), /OpenMage antwortet nicht \(Timeout nach 5s\)/);
  mode = 'ok';
});

test('unreachable: message with error code, status 0', async () => {
  const dead = new OmClient({ url: 'http://127.0.0.1:1', token: 't' });
  await assert.rejects(dead.req('GET', '/v1/info'), (e: Error & { status: number }) => e.status === 0 && /^OpenMage nicht erreichbar: /.test(e.message));
});
