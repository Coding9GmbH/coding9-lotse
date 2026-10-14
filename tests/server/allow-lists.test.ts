import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET_ALLOW, SCOPES } from '../../src/server/policy';
import { ROOTS } from '../../src/server/platform/shopify/reader';
import { ALLOW as MAGENTO_ALLOW } from '../../src/server/platform/magento/reader';
import { ALLOW as OPENMAGE_ALLOW } from '../../src/server/platform/openmage/reader';

// Exakte Freigabelisten: ein zusätzlicher Eintrag macht den Vergleich rot. Sortiert, damit nur der Inhalt zählt.
const reKey = (re: RegExp) => `${re.flags}\0${re.source}`;
const sortRe = (list: readonly RegExp[]) => [...list].sort((a, b) => reKey(a).localeCompare(reKey(b)));
type Row = { re: RegExp; scope: string; entity: string; method?: string };
const sortRows = (list: readonly Row[]) => [...list].sort((a, b) => reKey(a.re).localeCompare(reKey(b.re)) || a.entity.localeCompare(b.entity) || (a.method ?? '').localeCompare(b.method ?? ''));
const entitiesOf = (scopes: { [k: string]: { entities: readonly string[] } }) => Object.fromEntries(Object.keys(scopes).sort().map(k => [k, [...scopes[k].entities].sort()]));
const entriesOf = (roots: Record<string, string | null>) => Object.entries(roots).sort(([a], [b]) => a.localeCompare(b));

const SHOPWARE_ENTITIES = {
  products: ['product', 'product-media', 'tax', 'property-group', 'property-group-option', 'product-configurator-setting', 'product-visibility', 'product-cross-selling', 'product-cross-selling-assigned-products', 'product-stream', 'product-stream-filter', 'delivery-time', 'tag', 'unit'],
  // Hersteller haben einen eigenen Schalter; Integrationen (gsc, sistrix) sind reine Daten-Schalter ohne Shop-Entitäten
  manufacturers: ['product-manufacturer'],
  categories: ['category'],
  cms: ['cms-page', 'cms-section', 'cms-block', 'cms-slot', 'landing-page', 'seo-url'],
  media: ['media', 'media-folder', 'media-default-folder'],
  marketing: ['promotion', 'promotion-discount', 'promotion-discount-prices', 'promotion-sales-channel', 'promotion-setgroup', 'promotion-individual-code', 'rule', 'rule-condition'],
  shop: ['sales-channel', 'sales-channel-domain', 'theme', 'language', 'locale', 'currency'],
  gsc: [],
  sistrix: [],
  web: [],
};

const SHOPWARE_GET_ALLOW = [/^\/_info\/version$/, /^\/_action\/theme\/[0-9a-f]{32}\/configuration$/];

const SHOPIFY_ROOTS: Record<string, string | null> = {
  shop: 'shop', shopLocales: 'shop', publications: 'shop', locations: 'shop',
  products: 'products', product: 'products', productsCount: 'products', productVariants: 'products', productVariant: 'products',
  collections: 'categories', collection: 'categories', collectionsCount: 'categories',
  files: 'media',
  pages: 'cms', page: 'cms', urlRedirects: 'cms',
  codeDiscountNodes: 'marketing', codeDiscountNode: 'marketing',
  nodes: null, translatableResourcesByIds: null,
};

const MAGENTO: Row[] = [
  { re: /^\/V1\/products$/, scope: 'products', entity: 'product' },
  { re: /^\/V1\/products\/attributes\/[a-z][a-z0-9_]{0,59}$/, scope: 'products', entity: 'product-attribute' },
  { re: /^\/V1\/products\/attributes$/, scope: 'products', entity: 'product-attribute' },
  { re: /^\/V1\/products\/[^/]+$/, scope: 'products', entity: 'product' },
  { re: /^\/V1\/products\/attribute-sets\/sets\/list$/, scope: 'products', entity: 'attribute-set' },
  { re: /^\/V1\/configurable-products\/[^/]+\/(children|options\/all)$/, scope: 'products', entity: 'configurable' },
  { re: /^\/V1\/inventory\/source-items$/, scope: 'products', entity: 'source-item' },
  { re: /^\/V1\/inventory\/sources$/, scope: 'products', entity: 'source' },
  { re: /^\/V1\/products\/(base-prices|special-price)-information$/, scope: 'products', entity: 'price', method: 'POST' },
  { re: /^\/V1\/categories$/, scope: 'categories', entity: 'category' },
  { re: /^\/V1\/categories\/list$/, scope: 'categories', entity: 'category' },
  { re: /^\/V1\/categories\/\d+$/, scope: 'categories', entity: 'category' },
  { re: /^\/V1\/categories\/\d+\/products$/, scope: 'categories', entity: 'category-product' },
  { re: /^\/V1\/cmsPage\/search$/, scope: 'cms', entity: 'cms-page' },
  { re: /^\/V1\/cmsPage\/\d+$/, scope: 'cms', entity: 'cms-page' },
  { re: /^\/V1\/cmsBlock\/search$/, scope: 'cms', entity: 'cms-block' },
  { re: /^\/V1\/cmsBlock\/\d+$/, scope: 'cms', entity: 'cms-block' },
  { re: /^\/V1\/salesRules\/search$/, scope: 'marketing', entity: 'sales-rule' },
  { re: /^\/V1\/salesRules\/\d+$/, scope: 'marketing', entity: 'sales-rule' },
  { re: /^\/V1\/coupons\/search$/, scope: 'marketing', entity: 'coupon' },
  { re: /^\/V1\/store\/(storeViews|storeConfigs|websites|storeGroups)$/, scope: 'shop', entity: 'store' },
];

const OPENMAGE: Row[] = [
  { re: /^\/v1\/info$/, scope: 'shop', entity: 'shop' },
  { re: /^\/v1\/products$/, scope: 'products', entity: 'product' },
  { re: /^\/v1\/products\/attributes$/, scope: 'products', entity: 'product-attribute' },
  { re: /^\/v1\/products\/[^/]+$/, scope: 'products', entity: 'product' },
  { re: /^\/v1\/products\/[^/]+\/stock$/, scope: 'products', entity: 'stock' },
  { re: /^\/v1\/products\/[^/]+\/categories$/, scope: 'products', entity: 'category-product' },
  { re: /^\/v1\/(products\/[^/]+\/images|media\/[^/]+)$/, scope: 'media', entity: 'product-image' },
  { re: /^\/v1\/categories$/, scope: 'categories', entity: 'category' },
  { re: /^\/v1\/categories\/\d+$/, scope: 'categories', entity: 'category' },
  { re: /^\/v1\/cms\/pages(\/\d+)?$/, scope: 'cms', entity: 'cms-page' },
  { re: /^\/v1\/cms\/blocks(\/\d+)?$/, scope: 'cms', entity: 'cms-block' },
  { re: /^\/v1\/salesrules(\/\d+)?$/, scope: 'marketing', entity: 'sales-rule' },
  { re: /^\/v1\/salesrules\/\d+\/coupons$/, scope: 'marketing', entity: 'coupon' },
  { re: /^\/v1\/urlrewrites(\/\d+)?$/, scope: 'shop', entity: 'url-rewrite' },
];

test('Shopware: SCOPES-Entitäten und GET_ALLOW exakt', () => {
  const expected = Object.fromEntries(Object.entries(SHOPWARE_ENTITIES).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()]));
  assert.deepEqual(entitiesOf(SCOPES), expected);
  assert.deepEqual(sortRe(GET_ALLOW), sortRe(SHOPWARE_GET_ALLOW));
});

test('Shopify: ROOTS exakt', () => {
  assert.deepEqual(entriesOf(ROOTS), entriesOf(SHOPIFY_ROOTS));
});

test('Magento: ALLOW exakt', () => {
  assert.deepEqual(sortRows(MAGENTO_ALLOW), sortRows(MAGENTO));
});

test('OpenMage: ALLOW exakt', () => {
  assert.deepEqual(sortRows(OPENMAGE_ALLOW), sortRows(OPENMAGE));
});
