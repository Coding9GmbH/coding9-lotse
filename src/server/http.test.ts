import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseJson, readBodyLimited, chatIdSchema } from './http';

const post = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request('http://lotse.test/api/x', { method: 'POST', body, headers, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
const chunks = (n: number, size: number) => new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(size).fill(97)); c.close(); } });

test('readBodyLimited: content-length über dem Limit → null ohne zu lesen', async () => {
  assert.equal(await readBodyLimited(post('{}', { 'content-length': '5000000' }), 1024), null);
  assert.equal((await readBodyLimited(post('hallo'), 1024))?.toString(), 'hallo');
  assert.equal((await readBodyLimited(new Request('http://lotse.test/'), 10))?.length, 0, 'kein Body = leer');
});

test('readBodyLimited: Strom ohne content-length wird beim Überschreiten abgebrochen (cancel), darunter vollständig gelesen', async () => {
  let cancelled = false;
  const big = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024).fill(98)); }, cancel() { cancelled = true; } });
  assert.equal(await readBodyLimited(post(big), 2 * 1024 * 1024 + 10), null);
  assert.equal(cancelled, true, 'Rest nicht weitergelesen');
  const ok = await readBodyLimited(post(chunks(3, 1000)), 3000);
  assert.equal(ok?.length, 3000);
  assert.equal(await readBodyLimited(post(chunks(3, 1000)), 2999), null);
});

test('parseJson: zu groß → 413, kein JSON → 400, Schema-Fehler → 400 mit deutschem Feldpfad, sonst Daten', async () => {
  const schema = z.object({ chatId: chatIdSchema, allow: z.boolean(), n: z.number().int().optional() });
  const big = await parseJson(post('{}', { 'content-length': String(3 * 1024 * 1024) }), schema);
  assert.ok(!big.ok && big.res.status === 413); assert.match((await big.res.json()).error, /zu groß/);
  const bad = await parseJson(post('{'), schema);
  assert.ok(!bad.ok && bad.res.status === 400); assert.match((await bad.res.json()).error, /kein gültiges JSON/);
  const wrong = await parseJson(post(JSON.stringify({ chatId: 'c1', allow: 'false' })), schema);
  assert.ok(!wrong.ok && wrong.res.status === 400);
  const msg = (await wrong.res.json()).error as string;
  assert.match(msg, /^Ungültige Anfrage: allow: /); assert.doesNotMatch(msg, /expected boolean/i, 'deutsche zod-Meldung');
  const missing = await parseJson(post(JSON.stringify({ allow: true })), schema);
  assert.ok(!missing.ok); assert.match((await missing.res.json()).error, /chatId: /);
  const empty = await parseJson(post(''), schema);
  assert.ok(!empty.ok); assert.match((await empty.res.json()).error, /Body: /);
  const good = await parseJson(post(JSON.stringify({ chatId: 'c1', allow: false, n: 2 })), schema);
  assert.ok(good.ok); assert.deepEqual(good.ok && good.data, { chatId: 'c1', allow: false, n: 2 });
  let custom = 0;
  const c = await parseJson(post('{'), schema, (m, s) => { custom = s; return new Response(m, { status: 418 }); });
  assert.ok(!c.ok && c.res.status === 418 && custom === 400);
});
