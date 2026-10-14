import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { STOREFRONT_PREFIX_HEADER } from '@/lib/platforms';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-shop-proxy-'));
for (const k of Object.keys(process.env)) if (/^(SHOPWARE_|SHOPIFY_|MAGENTO_|OPENMAGE_|SHOP_PLATFORM$)/.test(k)) delete process.env[k];

const { ADAPTERS } = await import('../../src/server/platform');
const { GET } = await import('../../src/app/shop/[[...path]]/route');

const BASE = 'https://shop.de';
const calls: { url: string; init: RequestInit }[] = [];
let reply: () => Response = () => new Response('');
// Storefront fake instead of a real shop: the adapter supplies base URL and fetch
const real = ADAPTERS.shopware.storefront;
ADAPTERS.shopware.storefront = { base: async () => BASE, fetch: async (url, init) => { calls.push({ url, init: init ?? {} }); return reply(); } };
test.after(() => { ADAPTERS.shopware.storefront = real; });

const req = (p: string, headers: Record<string, string> = {}) => new NextRequest(`http://127.0.0.1:3333${p}`, { headers: { accept: 'text/html', cookie: 'session=geheim', ...headers } });

test('storefront proxy: HTML is rewritten, without scripts and without cookies, never cached', async () => {
  reply = () => new Response(`<a href="${BASE}/x">x</a><script>var u="https:\\/\\/shop.de\\/y"</script>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sw=1', 'x-frame-options': 'deny' } });
  const r = await GET(req('/shop/navigation/abc?p=2'));
  assert.equal(r.status, 200);
  assert.equal(calls.at(-1)?.url, `${BASE}/navigation/abc?p=2`);
  assert.equal((calls.at(-1)?.init as { redirect?: string }).redirect, 'manual');
  const sent = calls.at(-1)?.init.headers as Record<string, string>;
  assert.equal(sent.cookie, undefined, 'browser cookies do not go to the shop');
  assert.equal(sent.accept, 'text/html');
  const body = await r.text();
  assert.ok(body.endsWith('<a href="/shop/x">x</a><script>var u="\\/shop\\/y"</script>'), 'URLs rewritten, shop scripts stay');
  assert.match(body, /^<style>[\s\S]*<\/style><script>\(function\(\)\{var P=window\.parent/, 'frame script for highlighting/scrolling');
  const csp = r.headers.get('content-security-policy') ?? '';
  assert.match(csp, /^sandbox allow-scripts allow-forms;/, 'opaque origin, also on direct navigation');
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /script-src 'self' 'unsafe-inline'/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(r.headers.get('x-frame-options'), null);
});

test('storefront proxy: redirects stay in the /shop prefix, status without body, assets without CSP', async () => {
  reply = () => new Response(null, { status: 302, headers: { location: `${BASE}/neu/` } });
  const red = await GET(req('/shop/alt'));
  assert.equal(red.status, 302);
  assert.equal(red.headers.get('location'), '/shop/neu/');
  reply = () => new Response(null, { status: 301, headers: { location: '/relativ?x=1' } });
  assert.equal((await GET(req('/shop/alt'))).headers.get('location'), '/shop/relativ?x=1');

  reply = () => new Response(null, { status: 304, headers: { 'content-type': 'text/html' } });
  const nb = await GET(req('/shop/x'));
  assert.equal(nb.status, 304);
  assert.equal(nb.body, null);

  reply = () => new Response('body{}', { headers: { 'content-type': 'text/css' } });
  const css = await GET(req('/shop/theme/a.css'));
  assert.match(css.headers.get('content-security-policy') ?? '', /^sandbox; default-src 'none'/, 'CSS opened directly: no scripts, opaque origin');
  assert.equal(css.headers.get('content-type'), 'text/css');
  assert.equal(await css.text(), 'body{}');
});

test('storefront proxy: CORS wildcard only for images and fonts', async () => {
  const cors = async (type: string, body: BodyInit = 'x') => {
    reply = () => new Response(body, { headers: { 'content-type': type } });
    return (await GET(req('/shop/theme/asset'))).headers.get('access-control-allow-origin');
  };
  assert.equal(await cors('image/png', new Uint8Array([137, 80, 78, 71])), '*');
  assert.equal(await cors('image/jpeg'), '*');
  assert.equal(await cors('font/woff2', new Uint8Array([0, 1])), '*');
  assert.equal(await cors('application/font-woff'), '*');
  assert.equal(await cors('application/font-woff2'), '*');
  assert.equal(await cors('application/json', '{}'), null);
  assert.equal(await cors('text/css', 'body{}'), null);
  assert.equal(await cors('text/plain', 'hinweis'), null);
  assert.equal(await cors('application/javascript', 'var x=1'), null);
  reply = () => new Response('<p>ok</p>', { headers: { 'content-type': 'text/html' } });
  const html = await GET(req('/shop/'));
  assert.equal(html.headers.get('access-control-allow-origin'), null);
  assert.match(html.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts/);
});

test('storefront proxy: assets with CORS allowance (fonts in the sandboxed draft), HTML without', async () => {
  reply = () => new Response(new Uint8Array([0, 1]), { headers: { 'content-type': 'font/woff2' } });
  const font = await GET(req('/shop/theme/abc/assets/font/Inter.woff2'));
  assert.equal(font.headers.get('access-control-allow-origin'), '*', 'opaque origin of the draft may load @font-face');
  assert.match(font.headers.get('content-security-policy') ?? '', /^sandbox; default-src 'none'/);
  reply = () => new Response('<p>ok</p>', { headers: { 'content-type': 'text/html' } });
  const html = await GET(req('/shop/'));
  assert.equal(html.headers.get('access-control-allow-origin'), null, 'shop HTML stays without CORS allowance');
  assert.match(html.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts/);
});

test('storefront proxy: SVG/XML/XHTML and other non-HTML responses never run in Lotse\'s origin; MIME case-insensitive', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/approve",{method:"POST"})</script></svg>';
  for (const type of ['image/svg+xml', 'IMAGE/SVG+XML', 'application/xml', 'text/xml', 'application/xhtml+xml', 'application/json', 'text/plain', 'application/octet-stream', 'image/png']) {
    reply = () => new Response(svg, { headers: { 'content-type': type } });
    const r = await GET(req('/media/x.svg', { [STOREFRONT_PREFIX_HEADER]: 'media' }));
    const csp = r.headers.get('content-security-policy') ?? '';
    assert.match(csp, /^sandbox;/, `${type}: sandbox without allow-scripts`);
    assert.doesNotMatch(csp, /allow-scripts|allow-same-origin/, type);
    assert.match(csp, /default-src 'none'/, type);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', type);
  }
  reply = () => new Response(null, { headers: {} }); // without Content-Type: application/octet-stream
  assert.match((await GET(req('/shop/x'))).headers.get('content-security-policy') ?? '', /^sandbox;/);
  // Uppercase HTML gets the HTML CSP (sandbox without allow-same-origin) instead of none at all
  for (const type of ['TEXT/HTML; charset=UTF-8', 'Text/Html']) {
    reply = () => new Response(`<html><head></head><a href="${BASE}/x">x</a></html>`, { headers: { 'content-type': type } });
    const r = await GET(req('/shop/'));
    const csp = r.headers.get('content-security-policy') ?? '';
    assert.match(csp, /^sandbox allow-scripts allow-forms;/, type);
    assert.doesNotMatch(csp, /allow-same-origin/, type);
    assert.match(await r.text(), /href="\/shop\/x"/, `${type}: rewritten like HTML`);
  }
});

test('storefront proxy: foreign redirect is not passed through', async () => {
  for (const location of ['https://evil.example/phish', 'https://shop.de.evil.example/x', 'https://user:pass@shop.de/x', '//evil.example/phish']) {
    reply = () => new Response(null, { status: 302, headers: { location } });
    const r = await GET(req('/shop/alt'));
    assert.equal(r.status, 502, location);
    assert.equal(r.headers.get('location'), null, location);
    assert.match(await r.text(), /außerhalb/);
  }
  reply = () => new Response(null, { status: 302, headers: { location: `${BASE}/ok/` } });
  const ok = await GET(req('/shop/alt'));
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/shop/ok/');
});

test('storefront proxy: without /shop only prefixes of the active platform; shop unreachable → 502', async () => {
  reply = () => new Response('<p>ok</p>', { headers: { 'content-type': 'text/html' } });
  const n = calls.length;
  const foreign = await GET(req('/shop/cdn/x.js', { [STOREFRONT_PREFIX_HEADER]: 'cdn' }));
  assert.equal(foreign.status, 404, 'Shopify prefix with Shopware active');
  assert.equal(calls.length, n, 'no call to the shop');
  const own = await GET(req('/shop/widgets/menu', { [STOREFRONT_PREFIX_HEADER]: 'widgets' }));
  assert.equal(own.status, 200);
  assert.equal(calls.at(-1)?.url, `${BASE}/widgets/menu`);

  reply = () => { throw new Error('ECONNREFUSED'); };
  const down = await GET(req('/shop/'));
  assert.equal(down.status, 502);
  assert.match(await down.text(), /Shop nicht erreichbar/);
});
