import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBlocks, findDivByClass, injectIntoHead, REAL_BLOCK_TYPES, spliceSections, stripScripts } from '../../src/server/real-page';
import { renderPreview } from '../../src/server/cms';
import type { PageSpec } from '../../src/server/cms';

const PAGE = `<!doctype html><html><head><title>Vase</title><link rel="stylesheet" href="/shop/theme/a.css"><link rel="preload" as="script" href="/x.js"><link rel="preload" as="script" href="https://cdn.tracker.test/t.js"><script>shopInit()</script><script async src="https://www.googletagmanager.com/gtm.js?id=X"></script></head>
<body class="is-ctl-product"><header><nav>Header</nav></header><main class="content-main"><div class="cms-page"><!-- kommentar -->
<div class="cms-sections"><div class="cms-section pos-0"><section><div class="cms-block pos-0 cms-block-product-heading"><div class="cms-block-container"><h1>Echte Vase</h1></div></div>
<div class="cms-block pos-1 cms-block-gallery-buybox position-relative"><div class="cms-block-container"><div class="buy"><div class="price">49,00 €</div><button>In den Warenkorb</button></div></div></div>
<div class="cms-block pos-2 cms-block-text"><div><p>Alter Text</p></div></div></section></div></div></div></main><footer>Footer</footer><script src="/a.js"></script></body></html>`;

test('real page: shop scripts stay, foreign domains and comments removed, layout parts stay', () => {
  const s = stripScripts(PAGE);
  assert.match(s, /<script>shopInit\(\)<\/script>/, 'shop inline script stays');
  assert.match(s, /<script src="\/a\.js"><\/script>/, 'shop script (relative after rewriting) stays');
  assert.match(s, /<link rel="preload" as="script" href="\/x\.js">/);
  assert.doesNotMatch(s, /googletagmanager|tracker\.test|kommentar/);
  assert.match(s, /<header><nav>Header/); assert.match(s, /Footer<\/footer>/);
});

test('findDivByClass counts nested divs and matches only whole class names', () => {
  const html = stripScripts(PAGE);
  const el = findDivByClass(html, 'cms-sections')!;
  const outer = html.slice(el.start, el.end);
  assert.ok(outer.startsWith('<div class="cms-sections">') && outer.endsWith('</div>') && outer.includes('Alter Text'));
  assert.equal(html.slice(el.end, el.end + 6), '</div>', 'cms-page closes after it');
  assert.ok(findDivByClass(html, 'cms-section')!.start > el.start, 'cms-section is not cms-sections');
  assert.equal(findDivByClass('<div class="a">offen', 'a'), null);
  assert.equal(findDivByClass('<div class="cms-sections-x">x</div>', 'cms-sections'), null);
});

test('inserting replaces only the CMS content; page blocks are found per type', () => {
  const html = stripScripts(PAGE);
  const out = spliceSections(html, '<div class="neu">Entwurf</div>')!;
  assert.match(out, /<header><nav>Header<\/nav><\/header>/);
  assert.match(out, /<div class="cms-sections"><div class="neu">Entwurf<\/div><\/div><\/div><\/main><footer>Footer/);
  assert.doesNotMatch(out, /Alter Text/);
  assert.equal(spliceSections('<html><body>Fehlerseite</body></html>', 'x'), null);
  const blocks = extractBlocks(html, REAL_BLOCK_TYPES);
  assert.deepEqual(Object.keys(blocks).sort(), ['pdp-gallery-buybox', 'pdp-heading']);
  assert.match(blocks['pdp-gallery-buybox'], /^<div class="cms-block pos-1 cms-block-gallery-buybox/);
  assert.match(blocks['pdp-gallery-buybox'], /49,00 €/);
  assert.doesNotMatch(blocks['pdp-gallery-buybox'], /Alter Text|cms-block-text/);
  assert.match(injectIntoHead('<html><head></head><body></body></html>', '<style>x</style>'), /<style>x<\/style><\/head>/);
  assert.equal(injectIntoHead('<p>x</p>', '<i></i>'), '<i></i><p>x</p>');
});

test('preview on the real page: draft replaces the content, buy box and heading are the real blocks', () => {
  const html = stripScripts(PAGE);
  const spec = { name: 'x', type: 'product_detail', sections: [{ blocks: [
    { type: 'pdp-heading' }, { type: 'pdp-gallery-buybox' }, { type: 'text', html: '<p>Neuer Storytelling-Text</p>' }, { type: 'pdp-cross-selling' },
  ] }] } as unknown as PageSpec;
  const out = renderPreview(spec, { realPage: html, realBlocks: extractBlocks(html, REAL_BLOCK_TYPES), products: { p1: { id: 'p1', name: 'Anderes Produkt', price: '9,00 €' } } });
  assert.match(out, /<header><nav>Header/); assert.match(out, /Footer<\/footer>/, 'header and footer of the real page');
  assert.match(out, /Echte Vase/); assert.match(out, /49,00 €/, 'real buy box');
  assert.match(out, /Neuer Storytelling-Text/); assert.doesNotMatch(out, /Alter Text/);
  assert.match(out, /Anderes Produkt/, 'cross-selling with real products');
  assert.match(out, /<style>[\s\S]*\.blk[\s\S]*<\/style><script>/, 'frame CSS/script for selecting and annotating');
  assert.match(out, /<link rel="stylesheet" href="\/shop\/theme\/a\.css">/, 'theme CSS of the real page');
  const plain = renderPreview(spec, { realPage: '<html><body>Fehler</body></html>', themeCss: '/shop/t.css' });
  assert.match(plain, /<main class="content-main">/); assert.doesNotMatch(plain, /Fehler/);
});

test('theme with custom block types: buy box found by type or markup, draft heading is dropped', () => {
  const zen = '<main><div class="cms-sections"><div class="cms-block pos-0 cms-block-zen-gallery-heading-buybox"><h1>Echt</h1><div class="product-detail-buy">Kaufen</div></div></div></main>';
  const a = extractBlocks(zen, REAL_BLOCK_TYPES);
  assert.match(a['pdp-gallery-buybox'], /Echt[\s\S]*Kaufen/); assert.equal(a['pdp-heading'], '');
  const custom = '<div class="cms-sections"><div class="cms-block cms-block-meine-box"><div class="cms-block-container"><div class="product-detail-buybox">Warenkorb</div></div></div><div class="cms-block cms-block-text">x</div></div>';
  const b = extractBlocks(custom, REAL_BLOCK_TYPES);
  assert.match(b['pdp-gallery-buybox'], /^<div class="cms-block cms-block-meine-box">[\s\S]*Warenkorb[\s\S]*<\/div>$/);
  assert.doesNotMatch(b['pdp-gallery-buybox'], /cms-block-text/);
  assert.equal('pdp-heading' in b, false);
  const spec = { name: 'x', type: 'product_detail', sections: [{ blocks: [{ type: 'pdp-heading' }, { type: 'pdp-gallery-buybox' }] }] } as unknown as PageSpec;
  const out = renderPreview(spec, { realPage: `<html><head></head><body>${zen}</body></html>`, realBlocks: a });
  assert.equal(out.match(/Echt/g)?.length, 1, 'heading not duplicated');
});

test('page type: product cards of a list do not count as a buy box', () => {
  const list = '<div class="cms-sections"><div class="cms-block cms-block-product-listing"><div class="product-box"><div class="buy-widget">Kaufen</div></div></div></div>';
  const only = Object.fromEntries(Object.entries(REAL_BLOCK_TYPES).filter(([k]) => !k.startsWith('pdp-')));
  assert.deepEqual(Object.keys(extractBlocks(list, only)), ['product-listing']);
});

test('head injection does not evaluate $ patterns in the script', () => {
  const script = `<script>var a="$&";var b="$1";var c="$'"</script>`;
  assert.ok(injectIntoHead('<head></head><body></body>', script).includes(script));
});
