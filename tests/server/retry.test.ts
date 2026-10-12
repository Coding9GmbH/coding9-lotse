import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchWithRetry, retryDelay } from '../../src/server/retry';

// Lokaler Server mit abgespielten Antworten: je Aufruf der nächste Eintrag (der letzte wiederholt sich)
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

test('429 und 5xx werden wiederholt, danach Erfolg', async () => {
  assert.deepEqual(await run([{ status: 429, headers: { 'retry-after': '0' } }, { status: 200 }]), { status: 200, calls: 2 });
  assert.deepEqual(await run([{ status: 503 }, { status: 500 }, { status: 200 }]), { status: 200, calls: 3 });
});

test('höchstens 3 Versuche, dann kommt die letzte Fehlerantwort zurück', async () => {
  assert.deepEqual(await run([{ status: 502 }]), { status: 502, calls: 3 });
  assert.deepEqual(await run([{ status: 429, headers: { 'retry-after': '0' } }]), { status: 429, calls: 3 });
});

test('4xx außer 429 und Erfolg werden nie wiederholt', async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) assert.deepEqual(await run([{ status }, { status: 200 }]), { status, calls: 1 }, String(status));
  assert.deepEqual(await run([{ status: 200 }]), { status: 200, calls: 1 });
});

test('Retry-After wird beachtet (Sekunden und HTTP-Datum), zu lange Wünsche brechen ab', async () => {
  const t0 = Date.now();
  assert.deepEqual(await run([{ status: 429, headers: { 'retry-after': '1' } }, { status: 200 }]), { status: 200, calls: 2 });
  assert.ok(Date.now() - t0 >= 950, 'wartet die angegebene Sekunde');
  assert.deepEqual(await run([{ status: 429, headers: { 'retry-after': '3600' } }, { status: 200 }]), { status: 429, calls: 1 }, 'eine Stunde: kein Warten, Fehler sofort');
  const r = (h: Record<string, string>) => new Response(null, { status: 429, headers: h });
  assert.equal(retryDelay(r({ 'retry-after': '2' }), 0), 2000);
  const d = retryDelay(r({ 'retry-after': new Date(Date.now() + 3000).toUTCString() }), 0);
  assert.ok(d != null && d > 1000 && d <= 3000, `HTTP-Datum: ${d}`);
  assert.equal(retryDelay(r({ 'retry-after': new Date(Date.now() - 5000).toUTCString() }), 0), 0, 'Datum in der Vergangenheit = sofort');
});

test('Backoff ohne Header verdoppelt sich und ist begrenzt', () => {
  const r = new Response(null, { status: 503 });
  assert.deepEqual([0, 1, 2].map(i => retryDelay(r, i, 100)), [100, 200, 400]);
  assert.equal(retryDelay(r, 10, 500), null, 'über der Obergrenze');
});
