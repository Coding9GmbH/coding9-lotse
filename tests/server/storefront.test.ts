import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ShopReader } from '../../src/server/shopware';
import { assertShopUrl, cmsOutline, fetchShopPage, mapPublicToInternal, pageKind, parseStorefront, resolveCmsTarget } from '../../src/server/storefront';

const HTML = `<!doctype html><html><head><title>Gartenduschen &amp; Co | Shop</title><meta name="description" content="Gartenduschen für Terrasse und Pool"><link rel="canonical" href="https://shop.test/gartenduschen/"></head>
<body class="is-ctl-product is-act-index">
<header><nav class="main-navigation"><a href="/zubehoer/">Zubehör</a></nav></header>
<main class="content-main">
<div class="cms-section pos-0 cms-section-default"><section class="cms-section-default boxed">
  <div class="cms-block pos-0 cms-block-text-hero position-relative"><div class="cms-block-container"><div class="cms-element-text"><h1>Solar-Gartenduschen</h1><p>Warmes Wasser ohne Stromanschluss.</p></div></div></div>
  <div class="cms-block pos-1 cms-block-acme-trust-bar"><div class="cms-block-container"><div class="cms-element-acme-trust-bar"></div></div></div>
</section></div>
<div class="cms-section pos-1 cms-section-sidebar"><div class="cms-block pos-0 cms-block-product-listing"><div class="cms-element-product-listing cms-element-plugin-listing cms-element-magazine-teaser">
  <div class="product-box"><a class="product-image-link" href="/detail/0123"><img src="/media/a.jpg" alt="Gartendusche"></a><a class="btn btn-primary" href="/detail/0123">Kaufen</a></div>
  <a class="btn btn-outline-primary" href="https://other.test/x">Extern</a></div></div></div>
</main><footer><h2>Footer</h2><a href="/impressum">Impressum</a></footer></body></html>`;

test('storefront: Shopping Experience structure from the markup (sections → blocks → elements, plugin blocks)', () => {
  const { sections, componentClasses } = cmsOutline(HTML);
  assert.deepEqual(sections.map(s => s.section), ['default', 'sidebar']);
  assert.deepEqual(sections[0].blocks.map(b => b.block), ['text-hero', 'acme-trust-bar']);
  assert.deepEqual(sections[0].blocks[0].elements, ['text']);
  assert.deepEqual(sections[1].blocks[0].elements, ['product-listing (magazine-teaser)']);
  assert.equal(componentClasses['btn'], 2);
  assert.equal(componentClasses['product-box'], 1);
  assert.equal(pageKind(HTML), 'Produktseite');
});

test('storefront: text, headings, images and only internal links from the main area', () => {
  const p = parseStorefront(HTML, 'https://shop.test/gartenduschen/');
  assert.equal(p.title, 'Gartenduschen & Co | Shop');
  assert.equal(p.metaDescription, 'Gartenduschen für Terrasse und Pool');
  assert.equal(p.canonical, 'https://shop.test/gartenduschen/');
  assert.deepEqual(p.headings, [{ level: 1, text: 'Solar-Gartenduschen' }]); // footer H2 is not included
  assert.match(p.text, /Warmes Wasser ohne Stromanschluss/);
  assert.doesNotMatch(p.text, /Impressum/);
  assert.deepEqual(p.images, [{ src: 'https://shop.test/media/a.jpg', alt: 'Gartendusche' }]);
  assert.deepEqual(p.links.map(l => l.href), ['https://shop.test/detail/0123']);
  assert.deepEqual(p.blockSequence, ['text-hero', 'acme-trust-bar', 'product-listing']);
});

test('resolveCmsTarget: percent-encoded path (umlauts from the browser) finds the SEO URL stored decoded', async () => {
  const seen: unknown[] = [];
  const sw: ShopReader = {
    base: 'http://shop',
    search: async (entity, c) => {
      seen.push(c?.filter);
      const vals = ((c?.filter as { field: string; value: string[] }[]).find(f => f.field === 'seoPathInfo')?.value) ?? [];
      return { data: entity === 'seo-url' && vals.includes('Küchen/') ? [{ id: 's', isCanonical: true, seoPathInfo: 'Küchen/', routeName: 'frontend.navigation.page', foreignKey: 'cat1', isDeleted: false }] : [] };
    },
    get: async (entity, id) => (entity === 'category' && id === 'cat1' ? { id: 'cat1', translated: { name: 'Küchen' }, cmsPageId: 'cms1' } : entity === 'cms-page' ? { id, name: 'Layout', type: 'product_list' } : null),
    salesChannels: async () => [], req: async () => null,
  };
  const t = await resolveCmsTarget(sw, 'https://shop.test/K%C3%BCchen/');
  assert.deepEqual(t, { kind: 'category', id: 'cat1', name: 'Küchen', cmsPage: { id: 'cms1', name: 'Layout', type: 'product_list' } });
  const vals = (seen[0] as { field: string; value: string[] }[]).find(f => f.field === 'seoPathInfo')!.value;
  assert.ok(vals.includes('Küchen') && vals.includes('K%C3%BCchen/'), 'both variants are searched');
  assert.equal(await resolveCmsTarget(sw, 'https://shop.test/%E0%A4%A/'), null, 'invalid encoding: raw value, no crash');
  // technical paths need no SEO lookup
  const direct = await resolveCmsTarget(sw, 'https://shop.test/navigation/' + 'c'.repeat(32));
  assert.equal(direct, null); assert.equal(seen.length, 2);
});

test('read_page: only domains of the own shop', () => {
  const allowed = ['https://shop.test/', 'http://shopware'];
  assert.equal(assertShopUrl('https://shop.test/gartenduschen/?x=1', allowed).pathname, '/gartenduschen/');
  assert.equal(assertShopUrl('http://shopware/navigation/abc', allowed).host, 'shopware');
  assert.throws(() => assertShopUrl('https://evil.test/', allowed), /nur Seiten des eigenen Shops/);
  assert.throws(() => assertShopUrl('ftp://shop.test/', allowed), /http/);
  assert.throws(() => assertShopUrl('kaputt', allowed), /gültige URL/);
});

test('mapPublicToInternal: path under the public prefix maps to the internal base, host tricks do not', () => {
  const pub = 'https://mein-shop.de/de', base = 'http://172.17.0.2';
  assert.equal(mapPublicToInternal(pub, base, 'https://mein-shop.de/de/produkt'), 'http://172.17.0.2/produkt');
  assert.equal(mapPublicToInternal(`${pub}/`, `${base}/`, 'https://mein-shop.de/de/produkt'), 'http://172.17.0.2/produkt');
  assert.equal(mapPublicToInternal(pub, base, pub), 'http://172.17.0.2/');
  assert.equal(mapPublicToInternal(pub, base, `${pub}?x=1`), 'http://172.17.0.2/?x=1');
  assert.equal(mapPublicToInternal(pub, base, `${pub}#oben`), 'http://172.17.0.2/#oben');
  // Remainder does not start with /, ? or #: the public URL stays, the internal host is not rewritten
  const at = mapPublicToInternal(pub, base, 'https://mein-shop.de/de@169.254.169.254/latest/meta-data');
  assert.equal(new URL(at).hostname, 'mein-shop.de');
  assert.equal(at, 'https://mein-shop.de/de@169.254.169.254/latest/meta-data');
  const dot = mapPublicToInternal(pub, base, 'https://mein-shop.de/de.evil.example/x');
  assert.equal(new URL(dot).hostname, 'mein-shop.de');
  // //evil must not become a new host through concatenation
  assert.equal(new URL(mapPublicToInternal(pub, base, 'https://mein-shop.de/de//evil.example/x')).hostname, '172.17.0.2');
  assert.equal(mapPublicToInternal(base, base, `${base}/x`), `${base}/x`);
  assert.equal(mapPublicToInternal(pub, base, 'https://other.test/x'), 'https://other.test/x');
  assert.equal(mapPublicToInternal(pub, 'http://user:pass@172.17.0.2', `${pub}/produkt`), `${pub}/produkt`);
});

test('fetchShopPage: only allowed hosts, each redirect separately, public target mapped back to internal', async () => {
  const seen: { url: string; redirect?: RequestRedirect }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = String(url);
    seen.push({ url: u, redirect: init?.redirect });
    if (u.endsWith('/produkt')) return new Response(null, { status: 302, headers: { location: 'https://mein-shop.de/de/neu' } });
    if (u.endsWith('/neu')) return new Response('<html><title>Neu</title></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.endsWith('/weg')) return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    if (u.endsWith('/relativ')) return new Response(null, { status: 302, headers: { location: '/anderes' } });
    if (u.endsWith('/anderes')) return new Response('<html><title>Anderes</title></html>', { status: 200 });
    return new Response('<html><title>Ok</title></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const allowed = ['https://mein-shop.de/de', 'http://172.17.0.2'];
  const opts = { publicUrl: 'https://mein-shop.de/de', internalBase: 'http://172.17.0.2', fetchImpl };
  const r = await fetchShopPage('https://mein-shop.de/de/produkt', allowed, opts);
  assert.equal(r.status, 200);
  assert.deepEqual(seen.map(s => s.url), ['http://172.17.0.2/produkt', 'http://172.17.0.2/neu']);
  assert.equal(seen[0].redirect, 'manual');
  seen.length = 0;
  const rel = await fetchShopPage('https://mein-shop.de/de/relativ', allowed, opts);
  assert.equal(rel.status, 200);
  assert.deepEqual(seen.map(s => s.url), ['http://172.17.0.2/relativ', 'http://172.17.0.2/anderes']);
  seen.length = 0;
  await assert.rejects(() => fetchShopPage('https://mein-shop.de/de/weg', allowed, opts), /169\.254\.169\.254|eigenen Shops/);
  assert.deepEqual(seen.map(s => s.url), ['http://172.17.0.2/weg'], 'the metadata address is not fetched');
  seen.length = 0;
  await assert.rejects(() => fetchShopPage('https://evil.test/x', allowed, opts), /eigenen Shops/);
  assert.equal(seen.length, 0);
  const attack = 'https://mein-shop.de/de@169.254.169.254/latest/meta-data';
  const kept = await fetchShopPage(attack, allowed, opts);
  assert.equal(kept.status, 200);
  assert.equal(new URL(seen[0].url).hostname, 'mein-shop.de');
  assert.equal(seen[0].url, attack);
});
