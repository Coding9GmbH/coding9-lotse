// Style guide onboarding on every platform: get_brand_signals is a core tool; the adapters provide theme settings and text samples
// via their protected read client (Shopify additionally the design values of settings_data.json), against the platform fakes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-brand-'));
delete process.env.SHOP_PLATFORM;
const { startFakeShopify } = await import('../../support/shopify-fake/server');
const { startFakeMagento } = await import('../../support/magento-fake');
const { startFakeOpenmage } = await import('../../support/openmage-fake');
const mprod = (id: number, sku: string, v: Record<string, unknown>) => ({ id, sku, type_id: 'simple', attribute_set_id: 4, website_ids: [1], media: [], vals: { 0: { status: 1, visibility: 4, ...v } } });
const oprod = (id: number, sku: string, v: Record<string, unknown>) => ({ id, sku, type_id: 'simple', attribute_set_id: 4, website_ids: [1], images: [], categories: [], stock: { qty: 10, is_in_stock: true, manage_stock: true }, vals: { 0: { status: 1, visibility: 4, url_key: sku.toLowerCase(), ...v } } });
const shop = await startFakeShopify({ port: 0 });
const om = await startFakeOpenmage({
  products: [oprod(1, 'VASE', { name: 'Vase', description: '<p>Vase aus Steinzeug.</p>' }), oprod(2, 'AUS', { name: 'Aus', status: 2 })],
  categories: [
    { id: 1, parent_id: 0, level: 0, path: '1', position: 0, vals: { 0: { name: 'Root Catalog', is_active: true } } },
    { id: 2, parent_id: 1, level: 1, path: '1/2', position: 1, vals: { 0: { name: 'Default Category', is_active: true } } },
    { id: 3, parent_id: 2, level: 2, path: '1/2/3', position: 1, vals: { 0: { name: 'Wohnen', is_active: true, description: '<p>Ruhige Dinge.</p>' } } },
    { id: 4, parent_id: 2, level: 2, path: '1/2/4', position: 2, vals: { 0: { name: 'Alt', is_active: false } } },
  ],
} as never);
const mage = await startFakeMagento({
  products: [mprod(1, 'VASE', { name: 'Vase', description: '<p>Bauchige Vase aus Steinzeug.</p>' }), mprod(2, 'AUS', { name: 'Aus', status: 2 }), mprod(3, 'NV', { name: 'Unsichtbar', visibility: 1 })],
  categories: [
    { id: 2, parent_id: 1, level: 1, path: '1/2', vals: { 0: { name: 'Root', is_active: true } }, products: [] },
    { id: 3, parent_id: 2, level: 2, path: '1/2/3', vals: { 0: { name: 'Wohnen', is_active: true, description: '<p>Ruhige Dinge.</p>' } }, products: [] },
  ],
} as never);
after(() => Promise.all([shop.close(), mage.close(), om.close()]));

const { updateSettings } = await import('../../../src/server/settings');
const { getPlatform, reconfigureAll, PLATFORM_KINDS } = await import('../../../src/server/platform/index').then(async m => ({ ...m, PLATFORM_KINDS: (await import('../../../src/lib/platforms')).PLATFORM_KINDS }));
const { toolNamesFor, CORE_TOOL_NAMES } = await import('../../../src/server/tools');
const { themeDesign } = await import('../../../src/server/platform/shopify/brand');
const { MagentoClient } = await import('../../../src/server/platform/magento/client');
const { MagentoReader } = await import('../../../src/server/platform/magento/reader');
const { OmClient } = await import('../../../src/server/platform/openmage/client');
const { OmReader } = await import('../../../src/server/platform/openmage/reader');

test('get_brand_signals is a core tool on every platform (onboarding works everywhere)', () => {
  assert.ok(CORE_TOOL_NAMES.includes('get_brand_signals'));
  for (const k of PLATFORM_KINDS) assert.equal(toolNamesFor(k).filter(n => n === 'get_brand_signals').length, 1, k);
  for (const k of PLATFORM_KINDS) assert.equal(typeof getPlatform(k).brand, 'function', `${k}: brand sources`);
});

test('Shopify settings_data.json: only design values of the current settings, presets and color schemes resolved', () => {
  const raw = `/* auto-generated */ ${JSON.stringify({ current: { type_header_font: 'assistant_n4', buttons_radius: 6, colors_accent_1: '#121212', some_app_api_key: 'geheim', social_instagram_link: 'https://x', color_schemes: { 'scheme-1': { settings: { background: '#fff8f0', button: '#0b6e4f' } } }, sections: { header: {} } } })}`;
  assert.deepEqual(themeDesign(raw), { type_header_font: 'assistant_n4', buttons_radius: 6, colors_accent_1: '#121212', 'color_schemes.scheme-1.background': '#fff8f0', 'color_schemes.scheme-1.button': '#0b6e4f' });
  assert.deepEqual(themeDesign(JSON.stringify({ current: 'Ocean', presets: { Ocean: { colors_text: '#003' } } })), { colors_text: '#003' });
});

test('Shopify: theme name + design values from the published theme, product and collection texts via the read client', async () => {
  updateSettings({ platform: 'shopify', shopify: { storeDomain: shop.url, accessToken: shop.token, apiVersion: '2026-10' } });
  reconfigureAll();
  const p = getPlatform('shopify'), src = p.brand!(p.openSession('brand').reader);
  const theme = await src.theme!();
  assert.ok(theme?.name, 'theme name');
  assert.equal(theme?.fields.colors_solid_button_labels, '#ffffff');
  const s = await src.samples!();
  assert.ok(s.products.length > 0 && s.products.every(x => x.name && typeof x.text === 'string' && x.text.length <= 280));
  assert.ok(Array.isArray(s.categories));
  updateSettings({ scopes: { shop: false } });
  assert.equal(await src.theme!(), null, 'area "Shop-Grunddaten" off: no theme settings');
  updateSettings({ scopes: { shop: true } });
});

test('Magento 2 and OpenMage: text samples of active products and categories (no theme interface)', async () => {
  const m = getPlatform('magento').brand!(new MagentoReader(new MagentoClient({ url: mage.base, accessToken: mage.token })));
  assert.equal(m.theme, undefined);
  const ms = await m.samples!();
  assert.deepEqual(ms.products, [{ name: 'Vase', text: 'Bauchige Vase aus Steinzeug.' }], 'only active, visible products; plain text');
  assert.deepEqual(ms.categories, [{ name: 'Wohnen', text: 'Ruhige Dinge.' }], 'not the root category');
  const o = getPlatform('openmage').brand!(new OmReader(new OmClient({ url: om.base, token: om.token })));
  assert.equal(o.theme, undefined);
  const os2 = await o.samples!();
  assert.deepEqual(os2.products, [{ name: 'Vase', text: 'Vase aus Steinzeug.' }], 'only enabled products');
  assert.deepEqual(os2.categories, [{ name: 'Wohnen', text: 'Ruhige Dinge.' }], 'active categories below the root, with text');
});
