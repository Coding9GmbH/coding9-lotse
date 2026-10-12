import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PageSpec } from './cms';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-pagehtml-'));
const { renderPageHtml, unsupportedBlocks } = await import('./page-html');

const spec: PageSpec = {
  name: 'Ratgeber Vasen', type: 'landingpage',
  sections: [{ blocks: [
    { type: 'text-hero', html: '<h1>Vasen aus Steinzeug</h1>' },
    { type: 'image-text', image: { mediaId: 'm1', alt: 'Vase auf Eichentisch' }, html: '<p>Matt & robust.</p>' },
    { type: 'product-slider', title: 'Beliebt', productIds: ['p1', 'p2', 'fehlt'] },
    { type: 'pattern', pattern: 'faq', data: { title: 'Fragen', items: [{ q: 'Spülmaschine?', a: 'Nein.' }, { q: 'Wasserdicht?', a: 'Ja.' }] } },
  ] }],
};

test('renderPageHtml: generische Blöcke + Patterns als eigenständiges HTML mit begrenztem CSS', () => {
  const html = renderPageHtml(spec, {
    imageUrl: im => (typeof im === 'string' ? im : im.mediaId === 'm1' ? 'https://cdn.test/vase.jpg' : null),
    products: { p1: { name: 'Vase „Kiesel“', price: '49,00 €', img: 'https://cdn.test/p1.jpg', url: 'https://shop.test/products/kiesel' }, p2: { name: 'Becher <Holm>', price: null } },
    scope: 'lp-x',
  });
  assert.match(html, /^<div class="lp-x"><style>/);
  assert.match(html, /<h1>Vasen aus Steinzeug<\/h1>/);
  assert.match(html, /<img src="https:\/\/cdn\.test\/vase\.jpg" alt="Vase auf Eichentisch"/);
  assert.match(html, /<a class="lp-card" href="https:\/\/shop\.test\/products\/kiesel">/);
  assert.match(html, /Becher &lt;Holm&gt;/, 'Produktnamen escaped');
  assert.ok(!html.includes('fehlt'));
  assert.match(html, /Spülmaschine\?/, 'Pattern ist aufgelöst');
  assert.ok(!html.includes('<html') && !html.includes('<body'));
});

test('Shopware-only-Blöcke: werden erkannt und abgewiesen', () => {
  const bad: PageSpec = { name: 'x', type: 'product_list', sections: [{ blocks: [{ type: 'text', html: '<p>a</p>' }, { type: 'product-listing' }, { type: 'reuse', cmsPageId: 'a', blockIndex: 0 }] }] };
  assert.deepEqual(unsupportedBlocks(bad).sort(), ['product-listing', 'reuse']);
  assert.deepEqual(unsupportedBlocks(spec), []);
  assert.throws(() => renderPageHtml(bad, { imageUrl: () => null }), /nur in Shopware-Einkaufswelten/);
});

test('renderPageParts: Teilung am theme-main (Inhalt davor/danach), weitere Sections danach, leere Teile sind leer', async () => {
  const { renderPageParts } = await import('./page-html');
  const ctx = { imageUrl: () => null, scope: 'lp-y' };
  const mk = (blocks: PageSpec['sections'][0]['blocks'], more: PageSpec['sections'] = []): PageSpec => ({ name: 'K', type: 'product_list', sections: [{ blocks }, ...more] });
  const r = renderPageParts(mk([{ type: 'text', html: '<p>EINS</p>' }, { type: 'theme-main' }, { type: 'text', html: '<p>DREI</p>' }], [{ blocks: [{ type: 'text', html: '<p>VIER</p>' }] }]), ctx);
  assert.equal(r.themeMain, true);
  assert.match(r.before, /^<div class="lp-y"><style>/); assert.match(r.before, /EINS/); assert.ok(!r.before.includes('DREI') && !r.before.includes('VIER'));
  assert.match(r.after, /DREI/); assert.match(r.after, /VIER/); assert.ok(!r.after.includes('EINS'));
  assert.equal(r.after.indexOf('DREI') < r.after.indexOf('VIER'), true, 'Reihenfolge bleibt');
  const first = renderPageParts(mk([{ type: 'theme-main' }, { type: 'text', html: '<p>B</p>' }]), ctx);
  assert.equal(first.before, ''); assert.match(first.after, /B/);
  const none = renderPageParts(mk([{ type: 'text', html: '<p>A</p>' }]), ctx);
  assert.equal(none.themeMain, false); assert.equal(none.after, ''); assert.match(none.before, /A/);
  const empty = renderPageParts(mk([{ type: 'theme-main' }]), ctx);
  assert.equal(empty.before, ''); assert.equal(empty.after, ''); assert.equal(empty.themeMain, true);
  assert.throws(() => renderPageParts(mk([{ type: 'product-listing' }]), ctx), /product-listing/);
});
