import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-test-'));
for (const k of Object.keys(process.env)) if (/^(SHOPWARE|SHOPIFY|MAGENTO|OPENMAGE)_/.test(k)) delete process.env[k];
const { downloadImage, setTrustedOrigins, setFetcher, setPublicFetcher, pinnedFetch, pinnedLookup, readCapped, isMetadataIp } = await import('../../src/server/media');
const { updateSettings } = await import('../../src/server/settings');

const serve = (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) => new Promise<{ port: number; close: () => void }>(resolve => {
  const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as { port: number }).port, close: () => srv.close() }));
});
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

// ---- DNS-Rebinding: fremde Hosts werden über eine geprüfte DNS-Auflösung des Sockets selbst geladen ----
test('pinnedLookup: jede aufgelöste Adresse wird geprüft (auch beim zweiten, „umgebogenen“ Lookup)', async () => {
  let n = 0;
  const lk = pinnedLookup(async () => (n++ === 0 ? [{ address: '93.184.215.14', family: 4 }] : [{ address: '93.184.215.14', family: 4 }, { address: '169.254.169.254', family: 4 }]));
  const call = (all: boolean) => new Promise<unknown>((res, rej) => lk('rebind.example', { all }, (e, a) => (e ? rej(e) : res(a))));
  assert.equal(await call(false), '93.184.215.14');
  await assert.rejects(call(true), /interne oder lokale Adressen/);
  const empty = pinnedLookup(async () => []);
  await assert.rejects(new Promise((res, rej) => empty('x', {}, (e, a) => (e ? rej(e) : res(a)))), /nicht auflösbar/);
});

test('pinnedFetch: Hostname, der auf Loopback auflöst, wird beim Verbinden abgewiesen; geprüfte Auflösung lädt', async () => {
  const srv = await serve((req, res) => { res.setHeader('content-type', 'image/png'); res.end(PNG); });
  try {
    await assert.rejects(pinnedFetch(`http://localhost:${srv.port}/a.png`), /interne oder lokale Adressen/);
    await assert.rejects(pinnedFetch(`http://127.0.0.1:${srv.port}/a.png`), /interne oder lokale Adressen/);
    // Test-Lookup meldet das Ziel ohne Prüfung → Verbindung zum lokalen Testserver
    const r = await pinnedFetch(`http://bilder.example:${srv.port}/a.png`, {}, (h, o, cb) => (typeof o === 'object' && o?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)));
    assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
  } finally { srv.close(); }
});

test('downloadImage: fremde Hosts laufen über den gepinnten Fetcher, Größe ist begrenzt (Content-Length und Stream)', async () => {
  const seen: string[] = [];
  setPublicFetcher(async u => { seen.push(String(u)); return new Response(PNG, { headers: { 'content-type': 'image/png' } }); });
  try {
    const ok = await downloadImage('http://93.184.215.14/a.png');
    assert.deepEqual(ok.buf, PNG); assert.deepEqual(seen, ['http://93.184.215.14/a.png']);
    setPublicFetcher(async () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) } }));
    await assert.rejects(downloadImage('http://93.184.215.14/gross.png'), /größer als 20 MB/);
  } finally { setPublicFetcher((u, i) => pinnedFetch(u, { headers: i?.headers as Record<string, string>, signal: i?.signal ?? undefined })); }
  const chunk = new Uint8Array(1024);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { sent++; c.enqueue(chunk); } }); // endlos, ohne Content-Length
  await assert.rejects(readCapped(new Response(stream), 10 * 1024), /größer als/);
  assert.ok(sent < 20, 'Stream wird abgebrochen statt bis zum Ende gelesen');
  assert.equal((await readCapped(new Response(PNG), 10)).length, PNG.length);
});

test('Verkaufskanal-Domains: Cloud-Metadaten immer abgewiesen, Docker-intern erlaubt; Shop-URL aus den Einstellungen voll vertrauenswürdig', async () => {
  for (const ip of ['169.254.169.254', '169.254.0.1', 'fe80::1', 'fd00:ec2::254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe']) assert.ok(isMetadataIp(ip), ip);
  for (const ip of ['127.0.0.1', '10.0.0.1', '8.8.8.8', '::1', 'fd00::1']) assert.ok(!isMetadataIp(ip), ip);
  const got: string[] = [];
  setFetcher(async u => { got.push(String(u)); return new Response(PNG, { headers: { 'content-type': 'image/png' } }); });
  setTrustedOrigins(async () => ['http://169.254.169.254', 'http://10.1.2.3']);
  try {
    await assert.rejects(downloadImage('http://169.254.169.254/latest/meta-data/x.png'), /interne oder lokale Adressen/);
    assert.equal((await downloadImage('http://10.1.2.3/a.png')).mime, 'image/png');
    updateSettings({ shopware: { url: 'http://localhost:8000', publicUrl: '' } });
    assert.equal((await downloadImage('http://localhost:8000/media/a.png')).mime, 'image/png');
    assert.deepEqual(got, ['http://10.1.2.3/a.png', 'http://localhost:8000/media/a.png']);
  } finally { setTrustedOrigins(async () => []); setFetcher(fetch); updateSettings({ shopware: { url: '', publicUrl: '' } }); }
});
