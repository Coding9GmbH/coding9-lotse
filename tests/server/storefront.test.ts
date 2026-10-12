import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ShopReader } from '../../src/server/shopware';
import { assertShopUrl, cmsOutline, pageKind, parseStorefront, resolveCmsTarget } from '../../src/server/storefront';

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

test('Storefront: Aufbau der Einkaufswelt aus dem Markup (Sections → Blöcke → Elemente, Plugin-Blöcke)', () => {
  const { sections, componentClasses } = cmsOutline(HTML);
  assert.deepEqual(sections.map(s => s.section), ['default', 'sidebar']);
  assert.deepEqual(sections[0].blocks.map(b => b.block), ['text-hero', 'acme-trust-bar']);
  assert.deepEqual(sections[0].blocks[0].elements, ['text']);
  assert.deepEqual(sections[1].blocks[0].elements, ['product-listing (magazine-teaser)']);
  assert.equal(componentClasses['btn'], 2);
  assert.equal(componentClasses['product-box'], 1);
  assert.equal(pageKind(HTML), 'Produktseite');
});

test('Storefront: Text, Überschriften, Bilder und nur interne Links aus dem Hauptbereich', () => {
  const p = parseStorefront(HTML, 'https://shop.test/gartenduschen/');
  assert.equal(p.title, 'Gartenduschen & Co | Shop');
  assert.equal(p.metaDescription, 'Gartenduschen für Terrasse und Pool');
  assert.equal(p.canonical, 'https://shop.test/gartenduschen/');
  assert.deepEqual(p.headings, [{ level: 1, text: 'Solar-Gartenduschen' }]); // Footer-H2 gehört nicht dazu
  assert.match(p.text, /Warmes Wasser ohne Stromanschluss/);
  assert.doesNotMatch(p.text, /Impressum/);
  assert.deepEqual(p.images, [{ src: 'https://shop.test/media/a.jpg', alt: 'Gartendusche' }]);
  assert.deepEqual(p.links.map(l => l.href), ['https://shop.test/detail/0123']);
  assert.deepEqual(p.blockSequence, ['text-hero', 'acme-trust-bar', 'product-listing']);
});

test('resolveCmsTarget: prozent-kodierter Pfad (Umlaute aus dem Browser) findet die dekodiert gespeicherte SEO-URL', async () => {
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
  assert.ok(vals.includes('Küchen') && vals.includes('K%C3%BCchen/'), 'beide Varianten werden gesucht');
  assert.equal(await resolveCmsTarget(sw, 'https://shop.test/%E0%A4%A/'), null, 'ungültige Kodierung: Rohwert, kein Absturz');
  // technische Pfade brauchen keine SEO-Suche
  const direct = await resolveCmsTarget(sw, 'https://shop.test/navigation/' + 'c'.repeat(32));
  assert.equal(direct, null); assert.equal(seen.length, 2);
});

test('read_page: nur Domains des eigenen Shops', () => {
  const allowed = ['https://shop.test/', 'http://shopware'];
  assert.equal(assertShopUrl('https://shop.test/gartenduschen/?x=1', allowed).pathname, '/gartenduschen/');
  assert.equal(assertShopUrl('http://shopware/navigation/abc', allowed).host, 'shopware');
  assert.throws(() => assertShopUrl('https://evil.test/', allowed), /nur Seiten des eigenen Shops/);
  assert.throws(() => assertShopUrl('ftp://shop.test/', allowed), /http/);
  assert.throws(() => assertShopUrl('kaputt', allowed), /gültige URL/);
});
