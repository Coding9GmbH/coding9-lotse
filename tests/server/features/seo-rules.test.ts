import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShopReader, SwEntity } from '../../../src/server/shopware';

process.env.AICB_DATA ??= fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-seo-'));
const { slugify, evaluate, duplicates, summarize, wordCount, buildSeoUrlChangeSet, applySeoUrl } = await import('../../../src/server/features/seo-rules');

const SC = 'sc1', DE = 'de', P1 = 'a'.repeat(32), P2 = 'b'.repeat(32), C1 = 'c'.repeat(32), P3 = 'd'.repeat(32), V1 = 'e'.repeat(32);
// Mini shop for seo-url: equals/equalsAny (case-insensitive like MySQL), ids; writes are logged
function fake(db: Record<string, SwEntity[]>) {
  const eq = (v: unknown, x: unknown) => (typeof v === 'string' && typeof x === 'string' ? v.toLowerCase() === x.toLowerCase() : (v ?? null) === x);
  const writes: string[] = [];
  const sw = {
    base: 'http://api.test', writes,
    async search(entity: string, c: SwEntity = {}) {
      let rows = db[entity] ?? [];
      if (c.ids) rows = rows.filter(r => c.ids.includes(r.id));
      const at = (r: SwEntity, f: string): unknown[] => f.split('.').reduce<unknown[]>((vs, k) => vs.flatMap(v => { const x = (v as SwEntity)?.[k]; return Array.isArray(x) ? x : [x]; }), [r]);
      for (const f of c.filter ?? []) rows = rows.filter(r => at(r, f.field).some(v => f.type === 'equalsAny' ? f.value.some((x: unknown) => eq(v, x)) : eq(v, f.value)));
      return { data: rows.map(r => ({ ...r })), total: rows.length };
    },
    async get(entity: string, id: string) { return (db[entity] ?? []).find(r => r.id === id) ?? null; },
    async salesChannels() { return db['sales-channel']; },
    async req(method: string, p: string) { writes.push(`${method} ${p}`); },
    async create(entity: string, data: SwEntity) { writes.push(`create ${entity} ${JSON.stringify(data)}`); (db[entity] ||= []).push(data); },
    async update(entity: string, id: string, data: SwEntity) { writes.push(`update ${id} ${JSON.stringify(data)}`); Object.assign(db[entity].find(r => r.id === id)!, data); },
  };
  return sw;
}
const seoRow = (id: string, fk: string, route: string, p: string, canonical: boolean | null, extra: SwEntity = {}) => ({ id, foreignKey: fk, routeName: route, seoPathInfo: p, salesChannelId: SC, languageId: DE, isCanonical: canonical, isModified: false, isDeleted: false, ...extra });
const db = () => ({
  'sales-channel': [{ id: SC, name: 'Storefront', languageId: DE, navigationCategoryId: null, domains: [{ url: 'https://shop.test', languageId: DE }] }],
  language: [{ id: DE, name: 'Deutsch' }],
  product: [{ id: P1, name: 'Vase „Kiesel“', productNumber: 'HH-1', active: true, visibilities: [{ salesChannelId: SC }] }, { id: P2, name: 'Becher', productNumber: 'HH-2', active: false, visibilities: [{ salesChannelId: SC }] },
    { id: P3, name: 'Unsichtbar', productNumber: 'HH-3', active: true, visibilities: [] }, { id: V1, parentId: P1, name: null, productNumber: 'HH-1.1', active: null, visibilities: [] }],
  category: [{ id: C1, name: 'Wohnen', active: true, type: 'page' }],
  'seo-url': [seoRow('s1', P1, 'frontend.detail.page', 'Vase-Kiesel/HH-1', true), seoRow('s1old', P1, 'frontend.detail.page', 'vase-alt/hh-1', null), seoRow('s2', P2, 'frontend.detail.page', 'becher/hh-2', true), seoRow('s3', C1, 'frontend.navigation.page', 'Wohnen/', true)],
});

test('slugify: lowercase, umlauts, hyphens, categories with "/", errors for IDs/reserved paths', () => {
  assert.deepEqual(slugify('  Größe & Übermaß: Vasen  aus Steinzeug! ', 'product'), { slug: 'groesse-und-uebermass-vasen-aus-steinzeug' });
  assert.deepEqual(slugify('/Wohnen//Vasen_Krüge/', 'category'), { slug: 'wohnen/vasen-kruege/' });
  assert.equal(slugify('https://shop.test/Café Crème', 'product').slug, 'cafe-creme');
  assert.match(slugify('---', 'product').error!, /leer/);
  assert.match(slugify(`produkt/${P1}`, 'product').error!, /technische ID/);
  assert.match(slugify('detail/vase', 'product').error!, /reserviert/);
  assert.match(slugify('Checkout', 'category').error!, /reserviert/);
});

test('SEO URL change set: normalized, duplicates in channel/proposal skipped, unchanged counted', async () => {
  const sw = fake(db());
  const cs = await buildSeoUrlChangeSet(sw as unknown as ShopReader, { title: 'URLs', reason: 'r', changes: [
    { entity: 'product', id: P1, slug: 'Vase Kiesel Steinzeug' }, { entity: 'category', id: C1, slug: 'wohnen' },
    { entity: 'product', id: P2, slug: 'vase-alt/hh-1' }, { entity: 'product', id: 'x'.repeat(32), slug: 'neu' },
  ] });
  assert.equal(cs.kind, 'seo-urls'); assert.deepEqual(cs.noun, { one: 'SEO-URL', many: 'SEO-URLs' });
  assert.deepEqual(cs.items.map(i => [i.id, i.before, i.after]), [
    [`product:${P1}`, 'https://shop.test/Vase-Kiesel/HH-1', 'https://shop.test/vase-kiesel-steinzeug'],
    [`category:${C1}`, 'https://shop.test/Wohnen/', 'https://shop.test/wohnen/'],
  ]);
  assert.deepEqual(cs.items[0].afterRaw, { salesChannelId: SC, languageId: DE, foreignKey: P1, routeName: 'frontend.detail.page', pathInfo: `/detail/${P1}`, seoPathInfo: 'vase-kiesel-steinzeug' });
  assert.match(cs.items[0].warn.join(), /normalisiert.*Weiterleitung/); assert.doesNotMatch(cs.items[1].warn.join(), /Weiterleitung/);
  assert.match(cs.items[1].warn.join(), /Nur Schreibweise geändert \(„Wohnen\/“ → „wohnen\/“\)/);
  assert.match(cs.items[0].fieldLabel, /Storefront · Deutsch/);
  assert.deepEqual(cs.skipped.map(s => s.reason.replace(/ \(.*?\):/, ':')), ['Becher: „vase-alt/hh-1“ ist im Verkaufskanal schon vergeben (Produkt ' + P1 + ')', 'Produkt nicht gefunden']);
  const dup = await buildSeoUrlChangeSet(sw as unknown as ShopReader, { title: 't', reason: 'r', changes: [{ entity: 'product', id: P1, slug: 'gleich' }, { entity: 'category', id: C1, slug: 'Gleich' }] });
  assert.equal(dup.items.length, 1); assert.match(dup.skipped[0].reason, /im Vorschlag schon/);
  const d2 = db(); Object.assign(d2['seo-url'][0], { seoPathInfo: 'vase', isModified: true });
  await assert.rejects(buildSeoUrlChangeSet(fake(d2) as unknown as ShopReader, { title: 't', reason: 'r', changes: [{ entity: 'product', id: P1, slug: 'vase' }] }), /1 unverändert/);
});

test('SEO URL change set: same URL is only pinned → visible notice instead of an empty change', async () => {
  const cs = await buildSeoUrlChangeSet(fake(db()) as unknown as ShopReader, { title: 't', reason: 'r', changes: [{ entity: 'product', id: P2, slug: 'becher/hh-2' }] });
  assert.equal(cs.items.length, 1); assert.equal(cs.items[0].before, cs.items[0].after);
  assert.ok(cs.items[0].warn.includes('URL bleibt gleich und wird als eigene URL festgeschrieben (Shopware generiert sie nicht mehr neu)'), cs.items[0].warn.join());
});

test('SEO URL change set: only products visible in the channel (variants via the parent product)', async () => {
  const cs = await buildSeoUrlChangeSet(fake(db()) as unknown as ShopReader, { title: 't', reason: 'r', changes: [{ entity: 'product', id: P3, slug: 'unsichtbar' }, { entity: 'product', id: V1, slug: 'vase-kiesel-variante' }] });
  assert.deepEqual(cs.items.map(i => i.entityId), [V1]);
  assert.match(cs.skipped[0].reason, /Unsichtbar \(HH-3\): im Verkaufskanal Storefront nicht sichtbar/);
});

test('applySeoUrl: new canonical URL, old one non-canonical; undo deletes the new one and restores the old one', async () => {
  const d = db(), sw = fake(d);
  const undo = await applySeoUrl(sw as never, { salesChannelId: SC, languageId: DE, foreignKey: P1, routeName: 'frontend.detail.page', pathInfo: `/detail/${P1}`, seoPathInfo: 'vase-neu' });
  assert.equal(sw.writes[0], 'update s1 {"isCanonical":null}', 'make room first (unique canonical entry)');
  const created = d['seo-url'].find(s => s.seoPathInfo === 'vase-neu')!;
  assert.equal(created.isCanonical, true); assert.equal(created.isModified, true);
  assert.deepEqual(undo, [{ op: 'patch', entity: 'seo-url', id: 's1', data: { isCanonical: true } }, { op: 'delete', entity: 'seo-url', id: created.id }]);
});

test('applySeoUrl: earlier custom URL becomes canonical again (patch instead of duplicate), same URL only marked, conflict throws', async () => {
  const d = db(), sw = fake(d);
  const undo = await applySeoUrl(sw as never, { salesChannelId: SC, languageId: DE, foreignKey: P1, routeName: 'frontend.detail.page', pathInfo: `/detail/${P1}`, seoPathInfo: 'vase-alt/hh-1' });
  assert.deepEqual(undo, [{ op: 'patch', entity: 'seo-url', id: 's1', data: { isCanonical: true } }, { op: 'patch', entity: 'seo-url', id: 's1old', data: { seoPathInfo: 'vase-alt/hh-1', isCanonical: null, isModified: false, isDeleted: false } }]);
  assert.equal(d['seo-url'].length, 4);
  const d2 = db(), u2 = await applySeoUrl(fake(d2) as never, { salesChannelId: SC, languageId: DE, foreignKey: C1, routeName: 'frontend.navigation.page', pathInfo: `/navigation/${C1}`, seoPathInfo: 'wohnen/' });
  assert.deepEqual(u2, [{ op: 'patch', entity: 'seo-url', id: 's3', data: { seoPathInfo: 'Wohnen/', isModified: false } }]);
  assert.equal(d2['seo-url'][3].seoPathInfo, 'wohnen/');
  await assert.rejects(applySeoUrl(fake(db()) as never, { salesChannelId: SC, languageId: DE, foreignKey: P1, routeName: 'frontend.detail.page', pathInfo: `/detail/${P1}`, seoPathInfo: 'becher/hh-2' }), /vergeben/);
});

test('SEO audit: check items, duplicates, report sorted (important first)', () => {
  const desc = '<p>' + 'Wort '.repeat(49) + '</p>';
  assert.equal(wordCount(desc), 49); assert.equal(wordCount('<h2>Vase „Kiesel“</h2><p>Steinzeug-Vase, 22 cm</p>'), 5);
  const dups = duplicates([{ id: '1', value: 'Vasen | Haus Holm' }, { id: '2', value: ' vasen  | haus holm' }, { id: '3', value: 'Becher' }, { id: '4', value: null }]);
  assert.deepEqual([...dups], [['vasen | haus holm', ['1', '2']]]);
  const d = { title: new Set(dups.keys()), desc: new Set<string>() };
  const good = { id: 'g', isProduct: true, metaTitle: 'Vase „Kiesel“ aus Steinzeug, 22 cm | Haus Holm', metaDescription: 'x'.repeat(140), description: '<p>' + 'Wort '.repeat(60) + '</p>', hasCover: true, imagesWithoutAlt: 0, seoPath: 'vase-kiesel/hh-1' };
  assert.deepEqual(evaluate(good, d), []);
  assert.deepEqual(evaluate({ id: 'b', isProduct: true, metaTitle: 'Vasen | Haus Holm', metaDescription: 'kurz', description: desc, hasCover: false, imagesWithoutAlt: 2, seoPath: null, brokenLinks: 1 }, d),
    ['seoUrl.missing', 'links.broken', 'metaTitle.short', 'metaTitle.duplicate', 'metaDescription.length', 'description.thin', 'image.cover', 'image.alt']);
  assert.deepEqual(evaluate({ id: 'c', isProduct: false, metaTitle: 'T'.repeat(61), description: '', seoPath: `x/${P1}/` }, d), ['seoUrl.technical', 'metaTitle.long', 'metaDescription.missing', 'description.thin']);
  assert.deepEqual(evaluate({ id: 'i', isProduct: true, metaTitle: good.metaTitle, metaDescription: good.metaDescription, description: good.description, hasCover: true, seoPath: undefined }, d), [], 'SEO URL not checked → no finding');
  const rep = summarize([{ ...good, issues: [] }, { id: 'b', name: 'B', isProduct: true, issues: ['description.thin', 'metaTitle.missing'] }, { id: 'c', name: 'C', isProduct: true, issues: ['description.thin'] }], 'propose_product_changes');
  assert.deepEqual(rep.summary.map(s => [s.issue, s.level, s.count, s.fix]), [['metaTitle.missing', 'wichtig', 1, 'propose_product_changes fields.metaTitle'], ['description.thin', 'empfohlen', 2, 'propose_product_changes fields.description']]);
  assert.deepEqual(rep.ids['description.thin'], ['b', 'c']); assert.deepEqual(rep.worst.map(w => w.id), ['b', 'c']);
});
