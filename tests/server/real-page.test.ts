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

test('Echte Seite: Skripte des Shops bleiben, fremde Domains und Kommentare raus, Layout-Teile bleiben', () => {
  const s = stripScripts(PAGE);
  assert.match(s, /<script>shopInit\(\)<\/script>/, 'Inline-Skript des Shops bleibt');
  assert.match(s, /<script src="\/a\.js"><\/script>/, 'Skript des Shops (relativ nach Umschreiben) bleibt');
  assert.match(s, /<link rel="preload" as="script" href="\/x\.js">/);
  assert.doesNotMatch(s, /googletagmanager|tracker\.test|kommentar/);
  assert.match(s, /<header><nav>Header/); assert.match(s, /Footer<\/footer>/);
});

test('findDivByClass zählt verschachtelte divs und trifft nur ganze Klassennamen', () => {
  const html = stripScripts(PAGE);
  const el = findDivByClass(html, 'cms-sections')!;
  const outer = html.slice(el.start, el.end);
  assert.ok(outer.startsWith('<div class="cms-sections">') && outer.endsWith('</div>') && outer.includes('Alter Text'));
  assert.equal(html.slice(el.end, el.end + 6), '</div>', 'dahinter schließt cms-page');
  assert.ok(findDivByClass(html, 'cms-section')!.start > el.start, 'cms-section ist nicht cms-sections');
  assert.equal(findDivByClass('<div class="a">offen', 'a'), null);
  assert.equal(findDivByClass('<div class="cms-sections-x">x</div>', 'cms-sections'), null);
});

test('Einsetzen ersetzt nur den CMS-Inhalt; Blöcke der Seite werden je Typ gefunden', () => {
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

test('Vorschau auf der echten Seite: Entwurf ersetzt den Inhalt, Kaufbox und Überschrift sind die echten Blöcke', () => {
  const html = stripScripts(PAGE);
  const spec = { name: 'x', type: 'product_detail', sections: [{ blocks: [
    { type: 'pdp-heading' }, { type: 'pdp-gallery-buybox' }, { type: 'text', html: '<p>Neuer Storytelling-Text</p>' }, { type: 'pdp-cross-selling' },
  ] }] } as unknown as PageSpec;
  const out = renderPreview(spec, { realPage: html, realBlocks: extractBlocks(html, REAL_BLOCK_TYPES), products: { p1: { id: 'p1', name: 'Anderes Produkt', price: '9,00 €' } } });
  assert.match(out, /<header><nav>Header/); assert.match(out, /Footer<\/footer>/, 'Kopf und Fuß der echten Seite');
  assert.match(out, /Echte Vase/); assert.match(out, /49,00 €/, 'echte Kaufbox');
  assert.match(out, /Neuer Storytelling-Text/); assert.doesNotMatch(out, /Alter Text/);
  assert.match(out, /Anderes Produkt/, 'Cross-Selling mit echten Produkten');
  assert.match(out, /<style>[\s\S]*\.blk[\s\S]*<\/style><script>/, 'Rahmen-CSS/-Skript für Auswahl und Anmerken');
  assert.match(out, /<link rel="stylesheet" href="\/shop\/theme\/a\.css">/, 'Theme-CSS der echten Seite');
  const plain = renderPreview(spec, { realPage: '<html><body>Fehler</body></html>', themeCss: '/shop/t.css' });
  assert.match(plain, /<main class="content-main">/); assert.doesNotMatch(plain, /Fehler/);
});

test('Theme mit eigenen Blocktypen: Kaufbox per Typ oder Markup gefunden, Überschrift des Entwurfs entfällt', () => {
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
  assert.equal(out.match(/Echt/g)?.length, 1, 'Überschrift nicht doppelt');
});

test('Seitentyp: Produktkarten einer Liste gelten nicht als Kaufbox', () => {
  const list = '<div class="cms-sections"><div class="cms-block cms-block-product-listing"><div class="product-box"><div class="buy-widget">Kaufen</div></div></div></div>';
  const only = Object.fromEntries(Object.entries(REAL_BLOCK_TYPES).filter(([k]) => !k.startsWith('pdp-')));
  assert.deepEqual(Object.keys(extractBlocks(list, only)), ['product-listing']);
});

test('Kopf-Einsatz wertet $-Muster im Skript nicht aus', () => {
  const script = `<script>var a="$&";var b="$1";var c="$'"</script>`;
  assert.ok(injectIntoHead('<head></head><body></body>', script).includes(script));
});
