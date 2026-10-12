import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, renderPreview, resolveReuse, reuseRefs, validateSpec, type PageSpec, type RawBlock } from './cms';

const S = (v: unknown) => ({ source: 'static', value: v });
const SRC: RawBlock[] = [
  { type: 'acme-trust-bar', backgroundColor: '#f3f3f3', marginTop: '0', slots: [{ slot: 'content', type: 'acme-trust-bar', config: {} }] },
  { type: 'image-text', slots: [{ slot: 'left', type: 'image', config: { media: S('0123456789abcdef0123456789abcdef') } }, { slot: 'right', type: 'text', config: { content: S('<h2>Beratung</h2><p>Persönlich.</p>') } }] },
  { type: 'product-listing', slots: [{ slot: 'content', type: 'product-listing', config: {} }] },
  { type: 'product-slider', slots: [{ slot: 'productSlider', type: 'product-slider', config: { products: S(['p1', 'p2']), title: S('Schon entdeckt?') } }] },
];
const loader = async (id: string) => { if (id !== 'page1') throw new Error('nicht gefunden'); return SRC; };
const spec = (blocks: PageSpec['sections'][0]['blocks'], type: PageSpec['type'] = 'landingpage'): PageSpec => ({ name: 'T', type, sections: [{ blocks }] });

test('reuse: Quellblock wird kopiert, Text für den Qualitäts-Check übernommen, Verweise für die Vorschau gesammelt', async () => {
  const s = spec([{ type: 'reuse', cmsPageId: 'page1', blockIndex: 1 }, { type: 'reuse', cmsPageId: 'page1', blockIndex: 3 }]);
  assert.deepEqual(await resolveReuse(s, loader), []);
  const [a, b] = s.sections[0].blocks;
  assert.equal(a.cmsType, 'image-text');
  assert.match(String(a.html), /Beratung/);
  assert.deepEqual(reuseRefs(a), { mediaIds: ['0123456789abcdef0123456789abcdef'], productIds: [] });
  assert.equal(b.like, 'product-slider');
  assert.deepEqual(reuseRefs(b).productIds, ['p1', 'p2']);
});

test('reuse: Fehler nennen Seite und verfügbare Blöcke', async () => {
  assert.match((await resolveReuse(spec([{ type: 'reuse', cmsPageId: 'page1', blockIndex: 9 }]), loader))[0], /nur 4 Blöcke .*0=acme-trust-bar/);
  assert.match((await resolveReuse(spec([{ type: 'reuse', cmsPageId: 'nope', blockIndex: 0 }]), loader))[0], /nicht gefunden/);
  assert.match((await resolveReuse(spec([{ type: 'reuse' }]), loader))[0], /cmsPageId und blockIndex/);
  assert.match(validateSpec(spec([{ type: 'reuse' }]))[0], /cmsPageId und blockIndex/);
});

test('reuse: übernommenes Listing zählt als product-listing der Kategorie-Seite', async () => {
  const s = spec([{ type: 'reuse', cmsPageId: 'page1', blockIndex: 2 }], 'product_list');
  await resolveReuse(s, loader);
  assert.deepEqual(validateSpec(s), []);
  assert.match(validateSpec(spec([{ type: 'reuse', cmsPageId: 'page1', blockIndex: 2, like: 'product-listing' }]))[0], /nur bei type=product_list/);
});

test('reuse: Veröffentlichung schreibt eine Kopie mit neuen IDs und gleicher Konfiguration', async () => {
  const s = spec([{ type: 'reuse', cmsPageId: 'page1', blockIndex: 0, marginBottom: '40px' }]);
  await resolveReuse(s, loader);
  const page = await compile(s, async () => null);
  const b = page.sections[0].blocks[0] as Record<string, unknown> & { slots: { id: string; type: string }[] };
  assert.equal(b.type, 'acme-trust-bar');
  assert.equal(b.backgroundColor, '#f3f3f3');
  assert.equal(b.marginTop, '0'); assert.equal(b.marginBottom, '40px');
  assert.equal(b.slots[0].type, 'acme-trust-bar');
  assert.match(b.slots[0].id, /^[0-9a-f]{32}$/);
  await assert.rejects(compile(spec([{ type: 'reuse', cmsPageId: 'page1', blockIndex: 0 }]), async () => null), /nicht aufgelöst/);
});

test('reuse: Vorschau zeigt statische Inhalte und benennt dynamische Elemente', async () => {
  const s = spec([{ type: 'reuse', cmsPageId: 'page1', blockIndex: 1 }, { type: 'reuse', cmsPageId: 'page1', blockIndex: 0 }]);
  await resolveReuse(s, loader);
  const html = renderPreview(s, { imageUrl: im => (typeof im === 'object' && im.mediaId ? `https://cdn/${im.mediaId}.jpg` : null) });
  assert.match(html, /<h2>Beratung<\/h2>/);
  assert.match(html, /https:\/\/cdn\/0123456789abcdef0123456789abcdef\.jpg/);
  assert.match(html, /acme-trust-bar: wie im Shop/);
  assert.match(html, /data-type="reuse: image-text"/);
});

test('validateSpec: product_list ohne product-listing nur ohne Layout-Regeln (HTML-Plattformen)', () => {
  const s: PageSpec = { name: 'Liste', type: 'product_list', sections: [{ blocks: [{ type: 'text', html: '<p>x</p>' }] }] };
  assert.match(validateSpec(s).join(), /genau einen product-listing/);
  assert.deepEqual(validateSpec(s, { layoutRules: false }), []);
  assert.match(validateSpec({ ...s, sections: [{ blocks: [{ type: 'product-listing' }] }], type: 'landingpage' }, { layoutRules: false }).join(), /nur bei type=product_list/);
});

test('wrapCustom: Scope-Klasse ersetzt .scope, JS bekommt root des Blocks, ohne js kein <script>', async () => {
  const { wrapCustom, BLOCKS } = await import('./cms');
  const h = wrapCustom({ html: '<p class="x">Hi</p>', css: '.scope .x{color:red}.scope>p{margin:0}', js: 'root.querySelector(".x").textContent="Hallo"' }, 'aicb-test');
  assert.match(h, /^<div class="aicb-test"><style>/);
  assert.match(h, /\.aicb-test \.x\{color:red\}\.aicb-test>p\{margin:0\}/); assert.ok(!h.includes('.scope'));
  assert.match(h, /<script>.*querySelector\('\.aicb-test'\).*root\.querySelector\("\.x"\)/s);
  const plain = wrapCustom({ html: '<p>Hi</p>' }, 'aicb-p');
  assert.ok(!plain.includes('<script') && !plain.includes('<style'));
  assert.match(wrapCustom({ html: 'x' }), /^<div class="aicb-[a-z0-9]{6}">/, 'zufällige Scope-ID');
  for (const [k, b] of Object.entries(BLOCKS)) assert.doesNotMatch(b.desc, /[–—]/, `Blockkatalog ${k}`);
});

test('renderPreview: Vorschau-Dokument bringt das Skript für Teil-Updates/Markieren mit (läuft im sandboxed iframe)', async () => {
  const { FRAME_SCRIPT, FRAME_CSS } = await import('../lib/preview-frame');
  assert.doesNotThrow(() => new Function(FRAME_SCRIPT), 'Skript ist gültiges JavaScript');
  assert.ok(!FRAME_SCRIPT.includes('</script'));
  assert.ok(!/parent\.document|parent\.location|top\./.test(FRAME_SCRIPT), 'kein Zugriff auf das Elterndokument');
  const html = renderPreview(spec([{ type: 'text', html: '<p>x</p>' }]));
  assert.ok(html.includes(`<script>${FRAME_SCRIPT}</script><body`)); assert.ok(html.includes(FRAME_CSS));
  const themed = renderPreview(spec([{ type: 'text', html: '<p>x</p>' }]), { themeCss: '/shop/theme/all.css' });
  assert.ok(themed.includes(`<script>${FRAME_SCRIPT}</script><body class="is-ctl-navigation`));
});
