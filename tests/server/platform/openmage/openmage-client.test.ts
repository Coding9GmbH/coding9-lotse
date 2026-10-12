// OpenMage-Client: Schutz des Shops gegen einen kleinen HTTP-Server (Wiederholung bei 429, kein Retry schreibender Aufrufe bei 503,
// Parallelitätsgrenze, serielle Schreibaufrufe, Timeout-Meldung).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.LOTSE_SHOP_TIMEOUT_MS = '5000'; // kleinster erlaubter Wert; vor dem Import, der Client liest ihn beim Laden
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
    if (mode === 'hang') return; // antwortet nie (Timeout)
    if (mode === '429-once' && first) { first = false; return done(429, { error: { code: 'busy', message: 'Zu viele Anfragen' } }, { 'retry-after': '0' }); }
    if (mode === '503') return done(503, { error: { code: 'maintenance', message: 'Wartung' } });
    setTimeout(() => done(200, { data: { ok: true, path: req.url }, meta: {} }), mode === 'slow' ? 40 : 0);
  });
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const c = new OmClient({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 't' });
test.after(() => new Promise<void>(r => server.close(() => r())));

test('429 mit Retry-After: 0 wird wiederholt (ein Ergebnis, zwei Anfragen)', async () => {
  mode = '429-once'; first = true; hits.length = 0;
  const r = await c.req('GET', '/v1/info');
  assert.equal(r.ok, true);
  assert.equal(hits.length, 2);
});

test('503 bei POST wird NICHT wiederholt (sonst doppelte Produkte/Blöcke), bei GET schon', async () => {
  mode = '503'; hits.length = 0;
  await assert.rejects(c.req('POST', '/v1/cms/blocks', { title: 'x' }), (e: Error & { status: number }) => e.status === 503 && /Wartung/.test(e.message));
  assert.equal(hits.length, 1, 'genau eine POST-Anfrage');
  hits.length = 0;
  await assert.rejects(c.req('GET', '/v1/info'), (e: Error & { status: number }) => e.status === 503);
  assert.equal(hits.length, 3, 'GET: Erstversuch + 2 Wiederholungen');
});

test('höchstens LOTSE_OPENMAGE_CONCURRENCY Anfragen gleichzeitig; Schreibaufrufe nacheinander', async () => {
  mode = 'slow'; hits.length = 0; maxActive = 0;
  await Promise.all(Array.from({ length: 10 }, (_, i) => c.req('GET', `/v1/products/P${i}`)));
  assert.equal(hits.length, 10); assert.ok(maxActive <= 3 && maxActive >= 2, `maximal 3 gleichzeitig (war ${maxActive})`);
  hits.length = 0;
  await Promise.all([c.req('PATCH', '/v1/products/A', { attributes: { name: 'a' } }), c.req('PATCH', '/v1/products/B', { attributes: { name: 'b' } }), c.req('PUT', '/v1/products/C/stock', { qty: 1 })]);
  const w = [...hits].sort((a, b) => a.t0 - b.t0);
  assert.equal(w.length, 3);
  for (let i = 1; i < w.length; i++) assert.ok(w[i].t0 >= w[i - 1].t1, `Schreibaufruf ${i} beginnt erst nach dem vorherigen (${w[i].t0} < ${w[i - 1].t1})`);
});

test('Timeout: verständliche Meldung „antwortet nicht“ (LOTSE_SHOP_TIMEOUT_MS)', async () => {
  mode = 'hang';
  await assert.rejects(c.req('GET', '/v1/info'), /OpenMage antwortet nicht \(Timeout nach 5s\)/);
  mode = 'ok';
});

test('nicht erreichbar: Meldung mit Fehlercode, Status 0', async () => {
  const dead = new OmClient({ url: 'http://127.0.0.1:1', token: 't' });
  await assert.rejects(dead.req('GET', '/v1/info'), (e: Error & { status: number }) => e.status === 0 && /^OpenMage nicht erreichbar: /.test(e.message));
});
