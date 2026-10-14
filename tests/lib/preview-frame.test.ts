import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FRAME_CSP, withFrameCsp } from '../../src/lib/preview-frame';

test('Draft preview: CSP blocks outbound sending (fetch/XHR/beacon, forms), images/CSS/scripts stay allowed', () => {
  assert.match(FRAME_CSP, /connect-src 'none'/); assert.match(FRAME_CSP, /form-action 'none'/);
  assert.doesNotMatch(FRAME_CSP, /default-src|img-src|style-src|font-src|script-src/, 'theme CSS, images and fonts via /shop as well as custom-html JS keep working');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`;
  // Doctype stays first (otherwise quirks mode), CSP comes before all other content
  assert.equal(withFrameCsp('<!doctype html><meta charset="utf-8"><style>a{}</style><body><p>x</p>'), `<!doctype html>${meta}<meta charset="utf-8"><style>a{}</style><body><p>x</p>`);
  assert.equal(withFrameCsp('<!DOCTYPE html>\n<html lang="de"><head><script>fetch("https://evil")</script></head>'), `<!DOCTYPE html>${meta}\n<html lang="de"><head><script>fetch("https://evil")</script></head>`);
  assert.equal(withFrameCsp('<html><body>x</body></html>'), `${meta}<html><body>x</body></html>`);
});

test('DraftFrame sets the CSP on every preview document', () => {
  const src = fs.readFileSync(new URL('../../src/components/preview/DraftFrame.tsx', import.meta.url), 'utf8');
  assert.match(src, /f\.srcdoc = withFrameCsp\(draft\.html\)/);
  assert.doesNotMatch(src, /f\.srcdoc = draft\.html/);
});
