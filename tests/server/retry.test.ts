import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchWithRetry, retryDelay } from '../../src/server/retry';

// Local server with replayed responses: each call gets the next entry (the last one repeats)
type Step = { status: number; headers?: Record<string, string> };
let script: Step[] = [], calls = 0;
const server = http.createServer((req, res) => {
  const s = script[Math.min(calls++, script.length - 1)];
  res.writeHead(s.status, { 'content-type': 'application/json', ...s.headers }); res.end(JSON.stringify({ n: calls }));
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
after(() => server.close());
const run = async (steps: Step[], o: { attempts?: number; baseMs?: number } = { baseMs: 1 }) => { script = steps; calls = 0; const r = await fetchWithRetry(() => fetch(url), o); return { status: r.status, calls }; };

test('429 and 5xx are retried, then success', async () => {
  assert.deepEqual(await run([{ status: 429, headers: { 'retry-after': '0' } }, { status: 200 }]), { status: 200, calls: 2 });
  assert.deepEqual(await run([{ status: 503 }, { status: 500 }, { status: 200 }]), { status: 200, calls: 3 });
});

test('at most 3 attempts, then the last error response is returned', async () => {
  assert.deepEqual(await run([{ status: 502 }]), { status: 502, calls: 3 });
  assert.deepEqual(await run([{ status: 429, headers: { 'retry-after': '0' } }]), { status: 429, calls: 3 });
});

test('4xx except 429 and success are never retried', async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) assert.deepEqual(await run([{ status }, { status: 200 }]), { status, calls: 1 }, String(status));
  assert.deepEqual(await run([{ status: 200 }]), { status: 200, calls: 1 });
});

test('Retry-After is honored (seconds and HTTP date), overly long requests abort', async () => {
  assert.deepEqual(await run([{ status: 429, headers: { 'retry-after': '0' } }, { status: 200 }]), { status: 200, calls: 2 });
  assert.deepEqual(await run([{ status: 429, headers: { 'retry-after': '3600' } }, { status: 200 }]), { status: 429, calls: 1 }, 'one hour: no waiting, fail immediately');
  const r = (h: Record<string, string>) => new Response(null, { status: 429, headers: h });
  assert.equal(retryDelay(r({ 'retry-after': '1' }), 0), 1000, 'one second from the header, without waiting');
  assert.equal(retryDelay(r({ 'retry-after': '2' }), 0), 2000);
  const d = retryDelay(r({ 'retry-after': new Date(Date.now() + 3000).toUTCString() }), 0);
  assert.ok(d != null && d > 1000 && d <= 3000, `HTTP date: ${d}`);
  assert.equal(retryDelay(r({ 'retry-after': new Date(Date.now() - 5000).toUTCString() }), 0), 0, 'date in the past = immediately');
});

test('backoff without header doubles and is capped', () => {
  const r = new Response(null, { status: 503 });
  assert.deepEqual([0, 1, 2].map(i => retryDelay(r, i, 100)), [100, 200, 400]);
  assert.equal(retryDelay(r, 10, 500), null, 'above the upper limit');
});
