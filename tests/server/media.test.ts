import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-test-'));
for (const k of Object.keys(process.env)) if (/^(SHOPWARE|SHOPIFY|MAGENTO|OPENMAGE)_/.test(k)) delete process.env[k];
const { stagedFile, stagedMeta, stageImage, sanitizeSvg, downloadImage, setTrustedOrigins, trustedOrigins } = await import('../../src/server/media');
const { updateSettings } = await import('../../src/server/settings');

test('stagedFile: Pfad-Ausbruch wird abgewiesen', () => {
  for (const segs of [['..', 'aicb.db'], ['..%2Faicb.db'], ['../secret.key'], ['..'], ['sub', 'a.png'], ['a.png/..'], ['/etc/passwd'], ['abc.json'], ['abc'], ['.png'], ['a b.png'], ['abc.png\0.json']])
    assert.equal(stagedFile(segs), null, JSON.stringify(segs));
});

test('stagedFile: gültige Bilddatei liegt im Staging-Ordner', () => {
  const f = stagedFile(['abc123.png']);
  assert.ok(f);
  assert.equal(f.mime, 'image/png');
  assert.equal(path.dirname(f.path), path.resolve(process.env.AICB_DATA!, 'staging'));
  assert.equal(stagedFile(['x1.svg'])?.mime, 'image/svg+xml');
});

test('stagedMeta: nur einfache IDs', () => {
  assert.equal(stagedMeta('../aicb'), null);
  const m = stageImage(Buffer.from(sanitizeSvg('<svg viewBox="0 0 1 1"><rect width="1" height="1" fill="#000"/></svg>')), 'image/svg+xml', { name: 'Test', alt: 'Alt' });
  const id = m.mediaId.slice('staged:'.length);
  assert.equal(stagedMeta(id)?.alt, 'Alt');
  const f = stagedFile([m.fileName]);
  assert.ok(f && fs.readFileSync(f.path, 'utf8').includes('xmlns='));
});

test('sanitizeSvg: einfache Vektorgrafik (Verlauf, use, style-Attribut, Kommentar, Text mit Doppelpunkt) wird angenommen, xmlns ergänzt', () => {
  const svg = '<svg viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1d4ed8"/><stop offset="100%" stop-color="#9333ea" stop-opacity="0.8"/></linearGradient></defs>'
    + '<rect x="0" y="0" width="100" height="100" rx="8" fill="url(#g)"/><circle cx="50" cy="50" r="20" style="fill:#fff;stroke:#000;stroke-width:2"/><text x="10" y="90" font-family="system-ui" font-size="12" text-anchor="start">Preis: 10 €</text>'
    + '<g transform="rotate(45 50 50)"><path d="M10 10 L90 90" stroke="#000"/></g><use href="#g" xlink:href="#g" xmlns:xlink="http://www.w3.org/1999/xlink"/><!-- Kommentar --><title>Hallo &amp; Co</title></svg>';
  const out = sanitizeSvg(svg);
  assert.ok(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(!out.includes('<!--'));
  assert.ok(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" aria-label="Icon: Haus" role="img"><path d="M1 1h8v8H1z" fill-rule="evenodd"/></svg>').includes('aria-label'));
  assert.throws(() => sanitizeSvg('<?xml version="1.0"?><svg/>'), /muss mit <svg beginnen/);
});

test('sanitizeSvg: lehnt ab statt zu strippen (Script, Handler, Entities, Animation, Style, externe Verweise, Tag-Splitting)', () => {
  const bad: [string, RegExp][] = [
    ['<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>', /<script/],
    ['<svg onload=alert(1)></svg>', /onload/],
    ['<svg><rect ONCLICK="alert(1)"/></svg>', /ONCLICK/],
    ['<svg><use href="&#106;avascript:alert(1)"/></svg>', /javascript:|href/],
    ['<svg><use href="jav&#x61;script:alert(1)"/></svg>', /javascript:|href/],
    ['<svg><use href="ja\tvascript:alert(1)"/></svg>', /javascript:|href/],
    ['<svg><a href="https://evil/">x</a></svg>', /<a/],
    ['<svg><set attributeName="onmouseover" to="alert(1)"/></svg>', /<set/],
    ['<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>', /<animate/],
    ['<svg><style>@import url(https://evil)</style></svg>', /<style/],
    ['<svg><image href="//evil/x.png"/></svg>', /<image/],
    ['<svg><use xlink:href="data:image/svg+xml;base64,PHN2Zz4="/></svg>', /data:/],
    ['<svg><use href="https://evil/#x"/></svg>', /#id/],
    ['<svg><script >alert(1)</script ></svg>', /<script/],
    ['<svg><scr<script>ipt>alert(1)</script></svg>', /<script/],
    ['<svg><foreignObject><body onload="x"/></foreignObject></svg>', /<foreignObject/],
    ['<svg><rect style="fill:url(https://evil/x)"/></svg>', /url\(/],
    ['<svg><rect fill="url(&quot;https://evil&quot;)"/></svg>', /url\(/],
    ['<svg><![CDATA[<script>]]></svg>', /<script|Markup/],
    ['<svg><!DOCTYPE x [<!ENTITY e "x">]><rect/></svg>', /Markup/],
    ['<svg><rect foo="bar"/></svg>', /Attribut foo/],
    ['<svg><video src="x"/></svg>', /<video/],
  ];
  for (const [svg, re] of bad) assert.throws(() => sanitizeSvg(svg), re, svg);
});

// ---- Bild-Download: kein Zugriff ins interne Netz (SSRF), eigener Shop ausgenommen, Weiterleitungen einzeln geprüft ----
const serve = (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) => new Promise<{ port: number; close: () => void }>(resolve => {
  const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as { port: number }).port, close: () => srv.close() }));
});
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

test('downloadImage: lokale/interne Adressen und Nicht-http werden abgewiesen, Fehlertext ohne Status', async () => {
  const srv = await serve((req, res) => { res.statusCode = 401; res.end('x'); });
  try {
    for (const u of [`http://127.0.0.1:${srv.port}/latest/meta-data/`, `http://localhost:${srv.port}/a.png`, `http://[::1]:${srv.port}/a.png`, 'http://10.0.0.5/a.png', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.1/a.png', 'http://172.16.0.1/a.png', 'http://0.0.0.0/a.png', 'http://[fd00::1]/a.png', 'http://[::ffff:10.0.0.1]/a.png'])
      await assert.rejects(downloadImage(u), /interne oder lokale Adressen/, u);
    await assert.rejects(downloadImage('ftp://example.com/a.png'), /nur http\(s\)/);
    await assert.rejects(downloadImage('nicht-url'), /keine gültige URL/);
    setTrustedOrigins(async () => [`http://127.0.0.1:${srv.port}`]);
    await assert.rejects(downloadImage(`http://127.0.0.1:${srv.port}/a.png`), /HTTP 401/); // eigener Shop: Status darf genannt werden
  } finally { setTrustedOrigins(async () => []); srv.close(); }
});

test('downloadImage: Weiterleitung vom eigenen Shop auf eine interne Adresse wird nicht gefolgt, auf den Shop selbst schon', async () => {
  const inner = await serve((req, res) => { res.setHeader('content-type', 'image/png'); res.end(PNG); });
  const shop = await serve((req, res) => {
    if (req.url === '/intern') { res.statusCode = 302; res.setHeader('location', `http://127.0.0.1:${inner.port}/secret.png`); res.end(); }
    else if (req.url === '/weiter') { res.statusCode = 302; res.setHeader('location', '/bild.png'); res.end(); }
    else if (req.url === '/loop') { res.statusCode = 302; res.setHeader('location', '/loop'); res.end(); }
    else if (req.url === '/text') { res.setHeader('content-type', 'text/html'); res.end('<html>'); }
    else { res.setHeader('content-type', 'image/png'); res.end(PNG); }
  });
  setTrustedOrigins(async () => [`http://127.0.0.1:${shop.port}`]);
  try {
    const base = `http://127.0.0.1:${shop.port}`;
    await assert.rejects(downloadImage(`${base}/intern`), /interne oder lokale Adressen/);
    const ok = await downloadImage(`${base}/weiter`);
    assert.equal(ok.mime, 'image/png'); assert.deepEqual(ok.buf, PNG);
    await assert.rejects(downloadImage(`${base}/loop`), /Weiterleitungen/);
    await assert.rejects(downloadImage(`${base}/text`), /kein Bild/);
  } finally { setTrustedOrigins(async () => []); shop.close(); inner.close(); }
});

test('trustedOrigins: Shop-URLs aus den Einstellungen gelten als eigener Shop', async () => {
  updateSettings({ shopware: { url: 'http://shopware', publicUrl: 'http://localhost:8888/' }, shopify: { storeDomain: 'demo.myshopify.com' } });
  const t = await trustedOrigins();
  assert.ok(t.has('http://shopware') && t.has('http://localhost:8888') && t.has('https://demo.myshopify.com'));
  updateSettings({ shopware: { url: '', publicUrl: '' }, shopify: { storeDomain: '' } });
});
