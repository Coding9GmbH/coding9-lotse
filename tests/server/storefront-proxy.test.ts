import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayResponse, rewriteOrigin, rewriteRootRelative } from '../../src/server/storefront-proxy';
import '../isolate-data';
import { jarCookie, previewShim, sandboxLocation, scriptCookies, storeCookies, taskOfSegment } from '../../src/server/sandbox/preview';
import { sandboxReferer, sandboxSrc } from '../../src/lib/urls';

const P = '/sbx/t_abcdefghijk1';

test('origin rewrite: plain and JSON-escaped, any prefix', () => {
  assert.equal(rewriteOrigin('<a href="http://localhost/x">', 'http://localhost', P), `<a href="${P}/x">`);
  assert.equal(rewriteOrigin('{"u":"http:\\/\\/localhost\\/x"}', 'http://localhost', P), `{"u":"\\/sbx\\/t_abcdefghijk1\\/x"}`);
  assert.equal(rewriteOrigin('"https://shop.de/a"', 'https://shop.de', '/shop'), '"/shop/a"');
});

test('root-relative URLs: attributes, srcset and CSS url() get the prefix; protocol-relative, absolute and prefixed ones stay', () => {
  const html = `<link href="/theme/a.css"><script src='/bundles/x.js'></script><form action="/checkout/line-item/add"></form><div data-url="/widgets/x" data-offcanvas-cart-url="/checkout/offcanvas"></div>`
    + `<img src="//cdn.test/a.png" srcset="/media/a.png 1x, https://x.test/b.png 2x"><a href="${P}/x">x</a><a href="https://x.test/">y</a><p>/not/an/attribute</p><div style="background:url(/media/bg.png)"></div>`;
  assert.equal(rewriteRootRelative(html, P),
    `<link href="${P}/theme/a.css"><script src='${P}/bundles/x.js'></script><form action="${P}/checkout/line-item/add"></form><div data-url="${P}/widgets/x" data-offcanvas-cart-url="${P}/checkout/offcanvas"></div>`
    + `<img src="//cdn.test/a.png" srcset="${P}/media/a.png 1x, https://x.test/b.png 2x"><a href="${P}/x">x</a><a href="https://x.test/">y</a><p>/not/an/attribute</p><div style="background:url(${P}/media/bg.png)"></div>`);
  assert.equal(rewriteRootRelative(`@font-face{src:url("/fonts/a.woff2")}.x{background:url( '/media/b.png' )}.y{background:url(${P}/c.png)}.z{background:url(data:x)}`, P, 'text/css'),
    `@font-face{src:url("${P}/fonts/a.woff2")}.x{background:url( '${P}/media/b.png' )}.y{background:url(${P}/c.png)}.z{background:url(data:x)}`);
});

test('relay: own headers only, frame script in HTML, CSP extra appended', async () => {
  const up = new Response('<html><head></head><body>x</body></html>', { headers: { 'content-type': 'text/html', 'set-cookie': 'a=1', 'x-frame-options': 'deny', 'cache-control': 'public' } });
  const r = await relayResponse(up, { rewrite: t => t, extraCsp: "form-action 'self'", headers: { 'referrer-policy': 'no-referrer-when-downgrade' } });
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(r.headers.get('x-frame-options'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts allow-forms;.*; form-action 'self'$/);
  assert.match(await r.text(), /<script>\(function\(\)\{var P=window\.parent[\s\S]*<\/script><\/head>/);
  const js = await relayResponse(new Response('var u="http://localhost/x"', { headers: { 'content-type': 'application/javascript' } }), { rewrite: t => t.replace('http://localhost', P), allText: true });
  assert.equal(await js.text(), `var u="${P}/x"`);
  assert.match(js.headers.get('content-security-policy') ?? '', /^sandbox; default-src 'none'/);
});

test('sandbox redirects stay on the sandbox; cookie jar honours expiry and HttpOnly', async () => {
  const { previewPath } = await import('../../src/server/sandbox/tasks');
  const id = 't_abcdefghijk1', origin = 'http://127.0.0.1:41234', pre = previewPath(id);
  assert.equal(sandboxLocation('http://localhost/checkout/cart#top', origin, id), `${pre}/checkout/cart#top`);
  assert.equal(sandboxLocation('/account', origin, id), `${pre}/account`);
  assert.equal(sandboxLocation(`${origin}/x`, origin, id), `${pre}/x`);
  for (const bad of ['https://shop.example/', 'http://127.0.0.1:1/x', 'http://a:b@localhost/', 'ftp://localhost/x', 'javascript:alert(1)']) assert.equal(sandboxLocation(bad, origin, id), null, bad);
  storeCookies(id, ['a=1; Path=/', 'b=2; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'bad name=3', 'c=x\r\ny', 's=1; HttpOnly']);
  assert.equal(jarCookie(id), 'a=1; s=1');
  storeCookies(id, ['a=2', 's=2'], { fromScript: true });
  assert.equal(jarCookie(id), 's=1; a=2', 'scripts cannot replace an HttpOnly cookie');
  assert.deepEqual(scriptCookies(id), [['a', '2']]);
  assert.equal(taskOfSegment(`${id}.${pre.split('.')[1]}`), id);
  for (const seg of [id, `${id}.${'0'.repeat(20)}`, `${id}.${pre.split('.')[1]}x`, 'x']) assert.equal(taskOfSegment(seg), null, seg);
  const shim = previewShim(pre, [['a', '</script>']]);
  assert.ok(!shim.slice(8, -9).includes('</script>'), 'cookie values cannot end the script');
});

test('sandbox URLs in the UI stay below the prefix; Referer → preview segment only on the same host and with a key', () => {
  const seg = 't_abcdefghijk1.0123456789abcdef0123', pre = `/sbx/${seg}`;
  assert.equal(sandboxSrc(pre), `${pre}/`);
  assert.equal(sandboxSrc(pre, 'checkout/cart'), `${pre}/checkout/cart`);
  assert.equal(sandboxSrc(pre, '/../../api/settings'), `${pre}/api/settings`);
  assert.equal(sandboxSrc(pre, 'https://evil.test/x?y=1'), `${pre}/x?y=1`);
  assert.equal(sandboxSrc(pre, '//evil.test/x'), `${pre}/x`);
  assert.equal(sandboxReferer(`http://localhost:3333${pre}/detail/1`, 'localhost:3333'), seg);
  assert.equal(sandboxReferer(`http://localhost:3333${pre}`, 'localhost:3333'), seg);
  assert.equal(sandboxReferer(`http://evil.test${pre}/`, 'localhost:3333'), null);
  assert.equal(sandboxReferer('http://localhost:3333/sbx/t_abcdefghijk1/', 'localhost:3333'), null);
  assert.equal(sandboxReferer('http://localhost:3333/sandbox-coding/t_abcdefghijk1', 'localhost:3333'), null);
});
