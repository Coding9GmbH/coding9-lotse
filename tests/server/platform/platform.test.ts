import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UndoOp } from '@/lib/protocol';
import { PLATFORM_KINDS, PLATFORM_SETTINGS, platformFields, type PlatformKind } from '@/lib/platforms';
import { TOOL_LABELS } from '@/lib/labels';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-platform-'));
delete process.env.SHOP_PLATFORM;

const { ADAPTERS, getPlatform, undoWithPlatform, opPlatform } = await import('../../../src/server/platform/index');
const { GENERIC_BLOCKS, BLOCKS, blocksFor } = await import('../../../src/server/cms');
const { toolNamesFor, CORE_TOOL_NAMES, featuresFor } = await import('../../../src/server/tools');
const { listChecks, registerCheck, registerPlatformCheck } = await import('../../../src/server/checks');
const { runChecks } = await import('../../../src/server/shopcheck-run');

test('Register: alle Plattformen vorhanden, unbekannte Plattform wirft, Standard ist Shopware', () => {
  assert.deepEqual(Object.keys(ADAPTERS).sort(), [...PLATFORM_KINDS].sort());
  for (const k of PLATFORM_KINDS) { assert.equal(getPlatform(k).kind, k); assert.equal(getPlatform(k).settings, PLATFORM_SETTINGS[k]); }
  assert.throws(() => getPlatform('woocommerce' as PlatformKind), /Unbekannte Shop-Plattform/);
  assert.equal(getPlatform().kind, 'shopware');
  assert.equal(getPlatform({ platform: 'magento' }).kind, 'magento');
});

test('Fähigkeiten: Shopware kann alles, HTML-Plattformen nur generische Blöcke und passende Ziele', () => {
  const sw = getPlatform('shopware').capabilities;
  assert.equal(sw.blocks, 'all'); assert.equal(sw.pageFormat, 'cms'); assert.equal(sw.reuse, true);
  assert.deepEqual([...sw.publishTargets].sort(), ['category', 'landingpage', 'product']);
  assert.ok(GENERIC_BLOCKS.includes('custom-html') && GENERIC_BLOCKS.includes('product-slider') && GENERIC_BLOCKS.includes('text'));
  for (const b of ['pdp-faq', 'product-listing', 'sidebar-filter', 'reuse']) assert.ok(!GENERIC_BLOCKS.includes(b), b);
  for (const k of ['shopify', 'magento', 'openmage'] as const) {
    const c = getPlatform(k).capabilities;
    assert.equal(c.pageFormat, 'html');
    assert.ok(c.blocks !== 'all' && c.blocks.every(b => BLOCKS[b]?.generic || (k === 'shopify' && b === 'theme-main')), `${k}: nur generische Blöcke (Shopify + theme-main)`);
    assert.ok(c.publishTargets.includes('product') && c.pageTypes.includes('product_detail'), `${k}: Produktinhalt`);
    assert.ok(c.pageTypes.includes('landingpage'));
  }
  // Shopify: Produktvorlagen im Theme (product_detail mit theme-main); Magento: Produktbeschreibung aus generischen Blöcken, kein theme-main
  for (const k of ['magento', 'openmage'] as const) { const mg = getPlatform(k).capabilities; assert.ok(mg.blocks !== 'all' && !mg.blocks.includes('theme-main'), `${k} kennt theme-main nicht`); assert.deepEqual([...mg.publishTargets].sort(), ['category', 'landingpage', 'product']); }
  const sh = getPlatform('shopify').capabilities;
  assert.deepEqual([...sh.publishTargets].sort(), ['category', 'landingpage', 'product']);
  assert.deepEqual([...sh.pageTypes].sort(), ['landingpage', 'product_detail', 'product_list']);
  assert.ok(!blocksFor('all').includes('theme-main'), 'Shopware kennt theme-main nicht');
});

test('Einstellungsfelder: eindeutige Schlüssel, Geheimnisse markiert, Umgebungsvariablen mit Plattform-Präfix', () => {
  for (const k of PLATFORM_KINDS) {
    const f = platformFields(k), keys = f.map(x => x.key);
    assert.equal(new Set(keys).size, keys.length, k);
    assert.ok(f.some(x => x.secret), `${k}: mindestens ein Geheimnis`);
    for (const x of f) if (x.env) assert.match(x.env, new RegExp(`^${k.toUpperCase()}_`), `${k}.${x.key}`);
    assert.ok(PLATFORM_SETTINGS[k].auth.length >= 1);
  }
  assert.equal(PLATFORM_SETTINGS.shopware.available, true);
});

test('Werkzeuge je Plattform: Kern + Plattform + Features, ohne Doppelte; Shopware-Fachbereiche nur bei Shopware', () => {
  for (const k of PLATFORM_KINDS) {
    const names = toolNamesFor(k);
    assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], k);
    for (const n of CORE_TOOL_NAMES) assert.ok(names.includes(n), `${k}: ${n}`);
    for (const n of ['run_shop_check', 'gsc_performance', 'sistrix_visibility', 'seo_site_check', 'search_knowledge']) assert.ok(names.includes(n), `${k}: Kern-Feature ${n}`);
  }
  assert.ok(toolNamesFor('shopware').includes('propose_promotion'));
  for (const n of ['list_sales_channels', 'get_cms_page', 'propose_product_data']) assert.ok(!toolNamesFor('shopify').includes(n), `Shopware-Werkzeug ${n} nicht bei Shopify`);
  assert.ok(!toolNamesFor('magento').includes('list_sales_channels'), 'Shopware-Werkzeug nicht bei Magento');
  // Lieferanten-Import: gleiche Werkzeugnamen, aber eigenes Feature je Plattform (Adapter.features bzw. Magento-Werkzeuge)
  assert.ok(toolNamesFor('shopify').includes('propose_import') && toolNamesFor('magento').includes('propose_import'));
  assert.ok(toolNamesFor('magento').includes('get_cms_page'), 'Magento: CMS-Seiten');
  assert.ok(toolNamesFor('openmage').includes('propose_import') && toolNamesFor('openmage').includes('propose_cms_page_changes') && !toolNamesFor('openmage').includes('list_sales_channels'), 'OpenMage: Import, CMS, keine Shopware-Werkzeuge');
  assert.deepEqual(getPlatform('openmage').features?.map(f => f.key), ['import-openmage']);
  assert.deepEqual(getPlatform('shopify').features?.map(f => f.key), ['shopify-import']);
  for (const n of ['search_products', 'get_product', 'list_products', 'search_categories', 'get_category', 'search_media', 'propose_product_changes', 'propose_new_products', 'propose_category_changes', 'propose_product_images', 'propose_alt_texts', 'propose_translations', 'propose_promotion', 'seo_audit', 'find_image_gaps'])
    assert.ok(toolNamesFor('shopify').includes(n), `Shopify: gemeinsamer Name ${n}`);
  assert.deepEqual(featuresFor(getPlatform('shopify')).map(f => f.key).sort(), ['gsc', 'shopcheck', 'shopify-import', 'sistrix', 'site-check', 'wissen']);
  // keine doppelten Werkzeugnamen je Plattform (Kern + Adapter + Features)
  for (const k of PLATFORM_KINDS) { const names = toolNamesFor(k); assert.equal(new Set(names).size, names.length, `${k}: doppelte Werkzeugnamen ${names.filter((n, i) => names.indexOf(n) !== i).join(', ')}`); }
  // jedes Werkzeug hat eine Anzeige im Chat (TOOL_LABELS)
  for (const k of PLATFORM_KINDS) assert.deepEqual(toolNamesFor(k).filter(n => !TOOL_LABELS[n]), [], `${k}: Werkzeuge ohne Anzeigenamen`);
});

test('Vorschau-Adapter (stubAdapter für künftige Plattformen): Werkzeuge melden ehrlich „noch nicht verfügbar“, Verbindungstest schlägt fehl, Rückgängig tut nichts', async () => {
  const { stubAdapter, HTML_CAPABILITIES } = await import('../../../src/server/platform/stub');
  const p = stubAdapter('magento', { capabilities: HTML_CAPABILITIES, promptVars: {}, paths: { adminCategory: '', adminProduct: '', adminCms: '', category: '', product: '' } });
  const t = p.tools({} as never).find(x => x.name === 'search_products')!;
  const r = await t.handler({}, {}) as { isError?: boolean; content: { text: string }[] };
  assert.equal(r.isError, true); assert.match(r.content[0].text, /Magento-Anbindung ist in Lotse noch nicht verfügbar/);
  assert.equal((await p.testConnection()).ok, false);
  assert.deepEqual((await p.undo([{ op: 'delete', entity: 'x', id: '1' }]))[0].ok, false);
  await assert.rejects(p.apply({ id: 'c', kind: 'products', title: '', reason: null, items: [], skipped: [], atomic: false }, null, new Set()), /noch nicht verfügbar/);
  await assert.rejects(p.lookup({}).findProducts({ ids: ['1'] }), /noch nicht verfügbar/);
});

test('Rückgängig: Altbestand ohne Plattform = Shopware, fremde Plattform wird nicht ausgeführt, gemischte Schritte abgewiesen', async () => {
  const calls: { kind: string; ops: UndoOp[] }[] = [];
  const fake = Object.fromEntries(PLATFORM_KINDS.map(k => [k, { label: PLATFORM_SETTINGS[k].label, undo: async (ops: UndoOp[]) => { calls.push({ kind: k, ops }); return ops.map(() => ({ ok: true })); } }])) as unknown as Parameters<typeof undoWithPlatform>[2];
  const legacy: UndoOp[] = [{ op: 'patch', entity: 'product', id: 'p1', data: { price: null } }];
  assert.equal(opPlatform(legacy[0]), 'shopware');
  assert.deepEqual(await undoWithPlatform(legacy, 'shopware', fake), [{ ok: true }]);
  assert.equal(calls.at(-1)?.kind, 'shopware');

  const shopifyOps: UndoOp[] = [{ op: 'patch', entity: 'product', id: 'gid://shopify/Product/1', data: { title: 'A' }, platform: 'shopify' }];
  const n = calls.length;
  const wrong = await undoWithPlatform(shopifyOps, 'shopware', fake);
  assert.equal(calls.length, n, 'nichts ausgeführt'); assert.equal(wrong[0].ok, false); assert.match(wrong[0].error!, /in Shopify gemacht, verbunden ist jetzt Shopware/);
  assert.deepEqual(await undoWithPlatform(shopifyOps, 'shopify', fake), [{ ok: true }]);
  assert.equal(calls.at(-1)?.kind, 'shopify');

  const mixed = await undoWithPlatform([...legacy, ...shopifyOps], 'shopware', fake);
  assert.ok(mixed.every(r => !r.ok)); assert.equal(calls.length, n + 1);
});

test('Shop-Checks je Plattform: Standard Shopware, „all“ überall, Plattform-Prüfung bekommt ihren Lese-Client', async () => {
  registerCheck({ id: 'test.sw', area: 'Test', run: async () => null });
  registerCheck({ id: 'test.all', area: 'Test', platforms: 'all', run: async () => null });
  let seen: unknown = null;
  registerPlatformCheck<{ shop: string }>('magento', { id: 'test.mage', area: 'Test', run: async (r, ctx) => { seen = r; return { id: 'test.mage', area: 'Test', title: `${ctx.platform}`, severity: 'niedrig', count: 1, fixPrompt: 'x' }; } });
  const ids = (k: PlatformKind) => listChecks(k).map(c => c.id).filter(i => i.startsWith('test.'));
  assert.deepEqual(ids('shopware').sort(), ['test.all', 'test.sw']);
  assert.deepEqual(ids('magento').sort(), ['test.all', 'test.mage']);
  assert.deepEqual(ids('shopify'), ['test.all']);
  const reader = { shop: 'magento-reader' };
  const run = await runChecks(reader as never, listChecks('magento').filter(c => c.id.startsWith('test.')), { perRun: false, ctx: r => ({ platform: 'magento', reader: r, lookup: getPlatform('magento').lookup(r) }) });
  assert.equal(seen, reader, 'unveränderter Lese-Client (kein Shopware-Einhüllen)');
  assert.equal(run.findings[0].title, 'magento');
});
