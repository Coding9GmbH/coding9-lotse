import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetHint } from '../../src/server/target-hint';

const HTML_CAPABILITIES = { pageTypes: ['landingpage', 'product_list'], publishTargets: ['landingpage', 'category'], pageFormat: 'html' } as const; // like HTML_CAPABILITIES (stub.ts)
const SW = { pageTypes: ['landingpage', 'product_list', 'product_detail'], publishTargets: ['category', 'product', 'landingpage'], pageFormat: 'cms' } as const;

test('targetHint: Shopware unchanged (product_list/product_detail with preview ID)', () => {
  assert.equal(targetHint({ kind: 'category', id: 'c1', name: 'Vasen' }, SW), '[Ziel: Kategorie "Vasen" (categoryId=c1) – Layout-Typ product_list, previewCategoryId=c1]');
  assert.equal(targetHint({ kind: 'product', id: 'p1', name: 'Vase' }, SW), '[Ziel: Produkt "Vase" (productId=p1) – Layout-Typ product_detail, previewProductId=p1]');
  assert.equal(targetHint({ kind: 'landing' }, SW), '[Ziel: neue freie Landingpage (landingpage)]');
  assert.equal(targetHint(null, SW), '');
});

test('targetHint: HTML platform never suggests product_detail, category as content without product-listing', () => {
  const p = targetHint({ kind: 'product', id: 'p1', name: 'Vase' }, HTML_CAPABILITIES);
  assert.doesNotMatch(p, /previewProductId|Layout-Typ product_detail/);
  assert.match(p, /Landingpage \(landingpage\)/); assert.match(p, /productIds=\["p1"\]/);
  const c = targetHint({ kind: 'category', id: 'c1', name: 'Vasen' }, HTML_CAPABILITIES);
  assert.match(c, /product_list/); assert.match(c, /kein product-listing-Block/); assert.match(c, /target=category/);
  const noList = targetHint({ kind: 'category', id: 'c1', name: 'Vasen' }, { ...HTML_CAPABILITIES, pageTypes: ['landingpage'] });
  assert.doesNotMatch(noList, /product_list/);
  for (const h of [p, c, noList]) assert.doesNotMatch(h, /[–—]/);
});

test('targetHint: HTML platform with product content (Magento) names product_detail without pdp blocks', () => {
  const MG = { pageTypes: ['landingpage', 'product_list', 'product_detail'], publishTargets: ['landingpage', 'category', 'product'], pageFormat: 'html' } as const;
  const p = targetHint({ kind: 'product', id: '7', name: 'Vase' }, MG);
  assert.match(p, /product_detail/); assert.match(p, /previewProductId=7/); assert.match(p, /keine pdp-Blöcke/); assert.match(p, /target=product/);
  assert.doesNotMatch(p, /[–—]/);
});

test('targetHint: Shopify (theme-main) and Magento (without) differ for category and product', () => {
  const caps = { pageTypes: ['landingpage', 'product_list', 'product_detail'], publishTargets: ['landingpage', 'category', 'product'], pageFormat: 'html' } as const;
  const SH = { ...caps, blocks: ['text', 'theme-main'] }, MG = { ...caps, blocks: ['text'] };
  assert.match(targetHint({ kind: 'product', id: '1', name: 'Vase' }, SH), /genau ein theme-main-Block markiert Galerie/);
  assert.match(targetHint({ kind: 'category', id: '2', name: 'Vasen' }, SH), /theme-main-Block markiert die Stelle der Produktliste/);
  assert.doesNotMatch(targetHint({ kind: 'product', id: '1', name: 'Vase' }, MG), /theme-main/);
  assert.doesNotMatch(targetHint({ kind: 'category', id: '2', name: 'Vasen' }, MG), /theme-main/);
});
