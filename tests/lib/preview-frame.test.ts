import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FRAME_CSP, withFrameCsp } from '../../src/lib/preview-frame';

test('Entwurfs-Vorschau: CSP sperrt Senden nach außen (fetch/XHR/Beacon, Formulare), Bilder/CSS/Skripte bleiben erlaubt', () => {
  assert.match(FRAME_CSP, /connect-src 'none'/); assert.match(FRAME_CSP, /form-action 'none'/);
  assert.doesNotMatch(FRAME_CSP, /default-src|img-src|style-src|font-src|script-src/, 'Theme-CSS, Bilder und Schriften über /shop sowie custom-html-JS laufen weiter');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`;
  // Doctype bleibt vorn (sonst Quirks-Modus), CSP steht vor allem anderen Inhalt
  assert.equal(withFrameCsp('<!doctype html><meta charset="utf-8"><style>a{}</style><body><p>x</p>'), `<!doctype html>${meta}<meta charset="utf-8"><style>a{}</style><body><p>x</p>`);
  assert.equal(withFrameCsp('<!DOCTYPE html>\n<html lang="de"><head><script>fetch("https://evil")</script></head>'), `<!DOCTYPE html>${meta}\n<html lang="de"><head><script>fetch("https://evil")</script></head>`);
  assert.equal(withFrameCsp('<html><body>x</body></html>'), `${meta}<html><body>x</body></html>`);
});

test('DraftFrame setzt die CSP auf jedes Vorschau-Dokument', () => {
  const src = fs.readFileSync(new URL('../../src/components/preview/DraftFrame.tsx', import.meta.url), 'utf8');
  assert.match(src, /f\.srcdoc = withFrameCsp\(draft\.html\)/);
  assert.doesNotMatch(src, /f\.srcdoc = draft\.html/);
});
