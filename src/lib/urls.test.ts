import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminUrl, liveSrc, storefrontUrl } from './urls';

test('Links: ohne Plattform-Pfade wie bisher Shopware, sonst Vorlagen der Plattform', () => {
  const sw = { admin: 'https://shop.test', storefront: 'https://shop.test' };
  assert.equal(adminUrl(sw, 'category', 'c1'), 'https://shop.test/admin#/sw/category/index/c1');
  assert.equal(adminUrl(sw, 'product', 'p1'), 'https://shop.test/admin#/sw/product/detail/p1/base');
  assert.equal(adminUrl(sw, 'cms', 'x'), 'https://shop.test/admin#/sw/cms/detail/x');
  assert.equal(storefrontUrl(sw, { kind: 'category', id: 'c1' }), 'https://shop.test/navigation/c1');
  assert.equal(liveSrc({ kind: 'product', id: 'p1' }, null), '/shop/detail/p1');
  assert.equal(liveSrc({ kind: 'landing' }, null), null);
  const paths = { adminCategory: '/admin/collections/{id}', adminProduct: '/admin/products/{id}', adminCms: '/admin/pages/{id}', category: '/collections/{id}', product: '/products/{id}' };
  const sh = { admin: 'https://holm.myshopify.com', storefront: 'https://holm.de', paths };
  assert.equal(adminUrl(sh, 'product', '42'), 'https://holm.myshopify.com/admin/products/42');
  assert.equal(storefrontUrl(sh, { kind: 'category', id: 'sommer' }), 'https://holm.de/collections/sommer');
  assert.equal(liveSrc({ kind: 'category', id: 'sommer' }, null, paths), '/shop/collections/sommer');
});

test('storefrontPrefix: Präfixe aller Plattformen, Zuordnung je Plattform', async () => {
  const { storefrontPrefix, isStorefrontPathOf } = await import('./platforms');
  assert.equal(storefrontPrefix('/widgets/checkout/info'), 'widgets');
  assert.equal(storefrontPrefix('/store-api'), 'store-api');
  assert.equal(storefrontPrefix('/cdn/shop/t/1/assets/base.css'), 'cdn');
  assert.equal(storefrontPrefix('/collections/vasen'), 'collections');
  assert.equal(storefrontPrefix('/customer/section/load'), 'customer/section');
  assert.equal(storefrontPrefix('/static/version1/frontend/x.js'), 'static');
  assert.equal(storefrontPrefix('/skin/frontend/rwd/default/css/styles.css'), 'skin'); assert.equal(storefrontPrefix('/js/prototype/prototype.js'), 'js'); assert.equal(storefrontPrefix('/index.php/catalogsearch/result/'), 'index.php');
  for (const p of ['/', '/api/products', '/settings', '/wissen', '/shop/x', '/staged/a.png', '/customer/account', '/mediathek']) assert.equal(storefrontPrefix(p), null, p);
  assert.ok(isStorefrontPathOf('shopware', 'widgets')); assert.ok(!isStorefrontPathOf('shopware', 'cdn'));
  assert.ok(isStorefrontPathOf('shopify', 'cdn')); assert.ok(isStorefrontPathOf('magento', 'customer/section')); assert.ok(isStorefrontPathOf('magento', 'media'));
  assert.ok(isStorefrontPathOf('openmage', 'skin') && isStorefrontPathOf('openmage', 'media') && !isStorefrontPathOf('openmage', 'cdn'));
});
