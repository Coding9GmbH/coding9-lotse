import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PageSpec } from '../../src/server/cms';

// Draft in the real theme (HTML platforms): target page of the shop as the frame, the published HTML inserted into the content area
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-theme-preview-'));
const { mainArea, spliceMain, themePreview, descriptionArea, spliceDescription, rewriteProtocolRelative } = await import('../../src/server/theme-preview');

const DAWN = `<!doctype html><html><head><title>Wohnen</title><link rel="stylesheet" href="https://haus-holm.test/cdn/shop/t/1/assets/base.css"><script src="https://tracking.example/t.js"></script></head>
<body><header>Kopf</header><main id="MainContent"><div class="collection-grid">Produktliste des Themes</div></main><footer>Fuß</footer></body></html>`;
const LUMA = '<html><body><header class="page-header">Kopf</header><main id="maincontent" class="page-main"><div class="columns">Luma</div></main></body></html>';
const RWD = '<html><body><div class="header">Kopf</div><div class="main"><div class="col-main"><div class="category-products">rwd</div></div><div class="col-right">Seite</div></div></body></html>';

test('content area: <main> (Shopify, Magento 2) or .col-main (OpenMage), none on foreign markup', () => {
  for (const h of [DAWN, LUMA]) { const m = mainArea(h)!; assert.match(h.slice(m.openEnd, m.close), /^<div class="(collection-grid|columns)"/); }
  const r = mainArea(RWD)!; assert.equal(RWD.slice(r.openEnd, r.close), '<div class="category-products">rwd</div>');
  assert.equal(mainArea('<html><body><div>nichts</div></body></html>'), null);
});

test('splice: above and below the theme content, or replacing it (landing page); header and footer stay', () => {
  const both = spliceMain(DAWN, { before: '<p>Oben</p>', after: '<p>Unten</p>', replace: false })!;
  assert.match(both, /<main id="MainContent"><div class="lotse-draft"><p>Oben<\/p><\/div><div class="collection-grid">Produktliste des Themes<\/div><div class="lotse-draft"><p>Unten<\/p><\/div><\/main><footer>Fuß/);
  assert.match(both, /<header>Kopf<\/header>/);
  const only = spliceMain(DAWN, { before: '<p>Oben</p>', after: '', replace: false })!;
  assert.doesNotMatch(only, /<div class="lotse-draft"><\/div>/, 'no empty wrapper');
  const lp = spliceMain(RWD, { before: '<p>Landing</p>', after: '', replace: true })!;
  assert.match(lp, /<div class="col-main"><div class="lotse-draft"><p>Landing<\/p><\/div><\/div><div class="col-right">Seite/);
  assert.equal(spliceMain('<html><body>x</body></html>', { before: 'a', after: '', replace: true }), null);
});

const spec = (o: Partial<PageSpec>): PageSpec => ({ name: 'Wohnen', type: 'product_list', sections: [{ blocks: [{ type: 'text', html: '<h2>Ruhige Dinge</h2><p>Für jeden Raum.</p>' }, { type: 'theme-main' }, { type: 'text', html: '<p>Pflegehinweise</p>' }] }], ...o } as PageSpec);

test('themePreview: real collection page as the frame, published parts inserted, shop URLs to /shop, foreign scripts out, cached for streaming', async () => {
  const fetched: string[] = [];
  const session = { id: 'chat-theme', lookup: { entityPaths: async (kind: string, id: string) => ({ paths: [`collections/${id}`], urls: [`https://haus-holm.test/collections/${id}`] }) },
    storefrontFetch: async (u: string) => { fetched.push(u); return new Response(DAWN, { headers: { 'content-type': 'text/html; charset=utf-8' } }); } } as never;
  const p = { storefront: { base: async () => 'https://haus-holm.test' } } as never;
  const html = (await themePreview(session, p, spec({ previewCategoryId: 'wohnen' }), { imageUrl: () => null }))!;
  assert.deepEqual(fetched, ['https://haus-holm.test/collections/wohnen']);
  assert.match(html, /<div class="lotse-draft">.*Ruhige Dinge.*<\/div><div class="collection-grid">Produktliste des Themes<\/div><div class="lotse-draft">.*Pflegehinweise/s, 'above and below the theme product list');
  assert.match(html, /href="\/shop\/cdn\/shop\/t\/1\/assets\/base\.css"/, 'theme CSS via the /shop proxy');
  assert.doesNotMatch(html, /tracking\.example/, 'foreign scripts removed');
  assert.match(html, /<script>/, 'frame script for marking and scroll');
  // streaming: from the cache, no further request
  const partial = await themePreview(session, p, spec({ previewCategoryId: 'wohnen', sections: [{ blocks: [{ type: 'text', html: '<p>Neu</p>' }] }] } as never), { imageUrl: () => null }, true);
  assert.match(String(partial), /Neu/); assert.equal(fetched.length, 1);
  // landing page: the home page as the frame, content replaced
  const lp = (await themePreview(session, p, spec({ type: 'landingpage', sections: [{ blocks: [{ type: 'text', html: '<h1>Herbst</h1>' }] }] } as never), { imageUrl: () => null }))!;
  assert.equal(fetched.at(-1), 'https://haus-holm.test/');
  assert.match(lp, /<main id="MainContent"><div class="lotse-draft">.*Herbst.*<\/div><\/main>/s);
  assert.doesNotMatch(lp, /Produktliste des Themes/);
});

test('themePreview: unusable target page → null (the simple preview takes over)', async () => {
  const p = { storefront: { base: async () => 'https://other.test' } } as never;
  const mk = (r: () => Response) => ({ id: 'chat-x', lookup: { entityPaths: async () => ({ paths: [], urls: [] }) }, storefrontFetch: async () => r() }) as never;
  assert.equal(await themePreview(mk(() => new Response('nope', { status: 500, headers: { 'content-type': 'text/html' } })), p, spec({ type: 'landingpage' } as never), { imageUrl: () => null }), null);
  assert.equal(await themePreview(mk(() => new Response('{}', { headers: { 'content-type': 'application/json' } })), p, spec({ type: 'landingpage', name: 'b' } as never), { imageUrl: () => null }), null);
  const offsite = { id: 'chat-y', lookup: {}, storefrontFetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }) } as never;
  assert.equal(await themePreview(offsite, { storefront: { base: async () => 'https://third.test' } } as never, spec({ type: 'landingpage' } as never), { imageUrl: () => null }), null, 'redirect out of the shop is not followed');
});

test('review fixes: custom elements are not the content area, protocol-relative shop assets stay, product content in the description', () => {
  const html = '<main-menu><a href="/">Menü</a></main-menu><main id="MainContent">x</main>';
  const m = mainArea(html)!; assert.equal(html.slice(m.openEnd, m.close), 'x', '<main-menu> is not <main>');
  const dawn = '<link href="//haus-holm.test/cdn/shop/t/1/assets/base.css" rel="stylesheet"><script src="//haus-holm.test/cdn/shop/t/1/assets/global.js" defer></script><img src="//other.test/x.png"><a href="//haus-holm.test.evil/x">';
  const out = rewriteProtocolRelative(dawn, 'https://haus-holm.test');
  assert.match(out, /href="\/shop\/cdn\/shop\/t\/1\/assets\/base\.css"/);
  assert.match(out, /src="\/shop\/cdn\/shop\/t\/1\/assets\/global\.js"/, 'theme scripts stay (Dawn needs them, e.g. reveal on scroll)');
  assert.match(out, /\/\/other\.test\/x\.png/, 'foreign hosts untouched');
  assert.match(out, /\/\/haus-holm\.test\.evil\/x/, 'no prefix match on a longer host');
  const luma = '<main id="maincontent"><div class="product info"><div class="product attribute description"><div class="value"><p>Alt</p></div></div></div><div class="reviews">R</div></main>';
  const d = descriptionArea(luma)!; assert.equal(luma.slice(d.openEnd, d.close), '<p>Alt</p>');
  assert.match(spliceDescription(luma, '<p>Neu</p>')!, /<div class="value"><div class="lotse-draft"><p>Neu<\/p><\/div><\/div><\/div><\/div><div class="reviews">R/);
  const rwd = '<div class="col-main"><div class="box-collateral box-description"><h2>Details</h2><div class="std">Alt</div></div></div>';
  assert.match(spliceDescription(rwd, 'Neu')!, /<div class="std"><div class="lotse-draft">Neu<\/div><\/div>/);
  assert.equal(spliceDescription('<main>x</main>', 'Neu'), null);
});

test('themePreview: product page of Magento/OpenMage → draft in the description; Shopify product (theme-main) → around the theme content', async () => {
  const PDP = '<html><head></head><body><main id="maincontent"><div class="product attribute description"><div class="value"><p>Alte Beschreibung</p></div></div></main></body></html>';
  const session = { id: 'chat-pdp', lookup: { entityPaths: async () => ({ paths: ['vase.html'], urls: ['https://luma.test/vase.html'] }) }, storefrontFetch: async () => new Response(PDP, { headers: { 'content-type': 'text/html' } }) } as never;
  const p = { storefront: { base: async () => 'https://luma.test' } } as never;
  const pdp = { name: 'Vase', type: 'product_detail', previewProductId: '1', sections: [{ blocks: [{ type: 'text', html: '<p>Neuer Text</p>' }] }] } as unknown as PageSpec;
  const html = (await themePreview(session, p, pdp, { imageUrl: () => null }))!;
  assert.match(html, /<div class="value"><div class="lotse-draft">.*Neuer Text.*<\/div><\/div>/s);
  assert.doesNotMatch(html, /Alte Beschreibung/, 'the description is replaced, as when publishing');
});
