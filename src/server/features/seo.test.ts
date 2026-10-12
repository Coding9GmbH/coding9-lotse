import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Shopware, SwEntity } from '../shopware';
import type { ChangeSet } from '@/lib/protocol';

process.env.AICB_DATA ??= fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-seo-'));
const { seo, anchorFor, keywords } = await import('./seo');

const SC = 'sc1', DE = '2fbb5fe2e29a4d70aa5854ce7ce3e20b', NAV = 'n'.repeat(32), A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32), K1 = '1'.repeat(32), K2 = '2'.repeat(32), M = 'm'.repeat(32);
// Mini-Shop: equals/contains/multi auch über Listen-Pfade; page/limit wie Shopware; term wird ignoriert (alle Treffer)
function fakeShop(db: Record<string, SwEntity[]>) {
  const at = (o: SwEntity, f: string): unknown[] => f.split('.').reduce<unknown[]>((vs, k) => vs.flatMap(v => { const x = (v as SwEntity)?.[k]; return Array.isArray(x) ? x : [x]; }), [o]);
  const match = (o: SwEntity, f: SwEntity): boolean => f.type === 'multi' ? f.queries.some((q: SwEntity) => match(o, q))
    : f.type === 'contains' ? at(o, f.field).some(v => String(v ?? '').includes(f.value)) : f.type === 'equalsAny' ? at(o, f.field).some(v => f.value.includes(v)) : at(o, f.field).some(v => (v ?? null) === f.value);
  const sw = {
    base: 'http://api.test', searches: [] as SwEntity[], db,
    async search(entity: string, c: SwEntity = {}) {
      sw.searches.push({ entity, ...c });
      let rows = db[entity] ?? [];
      if (c.ids) rows = rows.filter(r => c.ids.includes(r.id));
      for (const f of c.filter ?? []) rows = rows.filter(r => match(r, f));
      const limit = c.limit ?? 500, page = c.page ?? 1;
      return { data: rows.slice((page - 1) * limit, page * limit), total: rows.length };
    },
    async get(entity: string, id: string) { return (db[entity] ?? []).find(r => r.id === id) ?? null; },
    async salesChannels() { return db['sales-channel']; },
    async req() { throw new Error('nicht erlaubt'); },
  };
  return sw;
}
const shop = (extraProducts: SwEntity[] = []) => fakeShop({
  'sales-channel': [{ id: SC, name: 'Storefront', languageId: DE, navigationCategoryId: NAV, domains: [{ url: 'https://shop.test', languageId: DE }] }],
  language: [{ id: DE, name: 'Deutsch' }],
  product: [
    { id: A, name: 'Vase „Kiesel“, 22 cm, Steinzeug matt', productNumber: 'HH-1', active: true, parentId: null, coverId: 'm', categoryIds: [K2], visibilities: [{ salesChannelId: SC }] },
    { id: B, name: 'Nicht im Kanal', productNumber: 'HH-2', active: true, parentId: null, coverId: 'm', visibilities: [] },
    ...extraProducts,
  ],
  category: [
    { id: K1, name: 'Wohnen', active: true, type: 'page', path: `|${NAV}|`, translated: { name: 'Wohnen', metaTitle: 'Wohnen | Haus Holm', breadcrumb: ['Start', 'Wohnen'] } },
    { id: K2, name: 'Vasen', active: true, type: 'page', path: `|${NAV}|${K1}|`, translated: { name: 'Vasen', breadcrumb: ['Start', 'Wohnen', 'Vasen'] } },
  ],
  'seo-url': [
    { id: 's1', foreignKey: A, routeName: 'frontend.detail.page', seoPathInfo: 'vase/HH-1', salesChannelId: SC, languageId: DE, isCanonical: true, isDeleted: false, isModified: true },
    { id: 's2', foreignKey: K2, routeName: 'frontend.navigation.page', seoPathInfo: 'Wohnen/Vasen/', salesChannelId: SC, languageId: DE, isCanonical: true, isDeleted: false },
  ],
});
const call = async (sw: ReturnType<typeof shop>, name: string, args: SwEntity) => {
  const t = seo.tools({ sw } as never).find(x => x.name === name)!;
  const r = await t.handler(args as never, {});
  const text = (r.content[0] as { text: string }).text;
  return { isError: !!r.isError, body: r.isError ? text : JSON.parse(text) };
};
const audit = (sw: ReturnType<typeof shop>, args: SwEntity) => call(sw, 'seo_audit', args);

test('seo_audit product: nur im Kanal sichtbare Produkte, keine falschen „Keine SEO-URL“-Meldungen', async () => {
  const sw = shop(), { body } = await audit(sw, { entity: 'product' });
  assert.equal(body.total, 1); assert.equal(body.checked, 1);
  assert.equal(body.ids['seoUrl.missing'], undefined);
  assert.ok(!JSON.stringify(body).includes(B));
  const prod = sw.searches.filter(s => s.entity === 'product');
  assert.ok(prod.length >= 2 && prod.every(s => JSON.stringify(s.filter).includes('"visibilities.salesChannelId"')), 'Liste und Doppelte-Scan mit gleichem Kanal-Filter');
  assert.equal(body.languageNote, undefined);
});

test('seo_audit: offset wird auf die Seite gerundet und als offsetNote gemeldet (wie find_image_gaps)', async () => {
  const r = await audit(shop(), { entity: 'product', limit: 10, offset: 15 });
  assert.equal(r.isError, false); assert.equal(r.body.offset, 10); assert.match(r.body.offsetNote, /auf 10 gerundet/); assert.equal(r.body.checked, 0); assert.equal(r.body.nextOffset, null);
  const ok = await audit(shop(), { entity: 'product', limit: 10, offset: 10 });
  assert.equal(ok.body.offsetNote, undefined);
  const pg = await audit(shop(), { entity: 'pages', limit: 20, offset: 5 });
  assert.equal(pg.isError, false); assert.equal(pg.body.offset, 0); assert.match(pg.body.offsetNote, /gerundet/);
});

test('seo_audit: Doppelte-Scan läuft auf der ersten Seite, Folgeseiten nutzen den Zwischenspeicher je Filter', async () => {
  const sw = shop();
  const scans = () => sw.searches.filter(s => s.entity === 'product' && s.limit === 500).length;
  await audit(sw, { entity: 'product', limit: 10 }); assert.equal(scans(), 1);
  await audit(sw, { entity: 'product', limit: 10, offset: 10 }); assert.equal(scans(), 1, 'Folgeseite ohne neuen Scan');
  await audit(sw, { entity: 'product', limit: 10, offset: 10, categoryId: 'k'.repeat(32) }); assert.equal(scans(), 2, 'anderer Filter: eigener Scan');
  await audit(sw, { entity: 'product', limit: 10 }); assert.equal(scans(), 3, 'erste Seite liest immer frisch');
});

test('seo_audit: doppelte Meta-Titles shopweit; Alt-Text nur Dateiname zählt wie leer', async () => {
  const becher = { id: C, name: 'Becher', productNumber: 'HH-3', active: true, parentId: null, coverId: 'm', visibilities: [{ salesChannelId: SC }], metaTitle: 'Haus Holm', translated: { metaTitle: 'Haus Holm' },
    media: [{ id: 'pm1', mediaId: M, media: { id: M, alt: 'IMG_1234', fileName: 'IMG_1234-ab12c' } }, { id: 'pm2', mediaId: M, media: { id: M, alt: 'Becher aus Steinzeug', fileName: 'becher' } }] };
  const first = (await audit(shop([becher]), { entity: 'product', limit: 250 })).body;
  assert.deepEqual(first.ids['image.alt'], [C], 'Dateinamen-Alt zählt wie leer (wie get_product_images/find_image_gaps)');
  assert.equal(first.ids['metaTitle.duplicate'], undefined);
  // zweites Produkt mit gleichem Meta-Title (Groß/klein, Leerraum egal): beide doppelt
  const D = 'd'.repeat(32);
  const body = (await audit(shop([becher, { id: D, name: 'Plaid', productNumber: 'HH-4', active: true, parentId: null, coverId: 'm', visibilities: [{ salesChannelId: SC }], metaTitle: ' haus  holm ', translated: { metaTitle: ' haus  holm ' } }]), { entity: 'product', limit: 250 })).body;
  assert.deepEqual([...body.ids['metaTitle.duplicate']].sort(), [C, D]);
  assert.deepEqual(body.duplicates.metaTitle, [{ value: 'haus holm', ids: [C, D] }]);
});

test('keywords: Inhaltswörter ohne Stoppwörter, längste zuerst, höchstens 6', () => {
  assert.equal(keywords('Die bauchige Vase aus Steinzeug für das Sideboard'), 'steinzeug sideboard bauchige vase');
  assert.equal(keywords('eins zwei drei vier fünf sechs sieben acht').split(' ').length, 6);
  assert.equal(keywords('Vase, Vase; VASE!'), 'vase');
  assert.equal(keywords('ab und zu'), '');
});

test('anchorFor: Produktname bis zum zweiten Komma, Kategorie aus dem Meta-Title-Kern', () => {
  assert.equal(anchorFor('product', { name: 'Vase „Kiesel“, 22 cm, Steinzeug matt' }), 'Vase „Kiesel“, 22 cm');
  assert.equal(anchorFor('product', { translated: { name: `${'Sehr langer Produktname mit vielen Worten darin'}, ${'und einem ebenso langen Zusatz'}` } }), 'Sehr langer Produktname mit vielen Worten darin');
  assert.equal(anchorFor('category', { name: 'Wohnen', translated: { name: 'Wohnen', metaTitle: 'Wohnen | Haus Holm' } }), 'Wohnen');
  assert.equal(anchorFor('category', { name: 'Wohnen', translated: { name: 'Wohnen', metaTitle: 'Wohnaccessoires fürs Wohnen – Haus Holm' } }), 'Wohnaccessoires fürs Wohnen');
  assert.equal(anchorFor('category', { name: 'Wohnen', translated: { name: 'Wohnen', metaTitle: 'Schöne Dinge | Haus Holm' } }), 'Wohnen');
});

test('suggest_internal_links: sichtbare Produkte mit Ankertext und SEO-URL, Kategorien aus den Produktkategorien aufgefüllt, excludeIds fehlen', async () => {
  const { body } = await call(shop(), 'suggest_internal_links', { topic: 'Steinzeug Vase', excludeIds: [K1] });
  assert.equal(body.term, 'Steinzeug Vase');
  assert.deepEqual(body.products.map((p: SwEntity) => [p.id, p.anchor, p.href, p.url, p.hasSeoUrl]), [[A, 'Vase „Kiesel“, 22 cm', '/vase/HH-1', 'https://shop.test/vase/HH-1', true]]);
  assert.ok(!JSON.stringify(body.products).includes(B), 'nicht im Kanal sichtbar');
  assert.deepEqual(body.categories.map((c: SwEntity) => [c.id, c.anchor, c.href, c.path]), [[K2, 'Vasen', '/Wohnen/Vasen/', 'Wohnen > Vasen']]);
  const noLinks = await call(shop(), 'suggest_internal_links', { text: 'und oder' });
  assert.equal(noLinks.isError, true); assert.match(String(noLinks.body), /topic, text, productId oder categoryId/);
});

test('get_seo_urls: SEO-URL je Kanal-Domain, ohne SEO-URL technischer Pfad mit hasSeoUrl:false', async () => {
  const { body } = await call(shop(), 'get_seo_urls', { productIds: [A, B], categoryIds: [K2] });
  assert.equal(body.length, 3);
  assert.deepEqual(body[0].urls, [{ salesChannel: 'Storefront', salesChannelId: SC, language: 'Deutsch', url: 'https://shop.test/vase/HH-1', hasSeoUrl: true, seoPath: 'vase/HH-1', isModified: true }]);
  assert.equal(body[0].number, 'HH-1'); assert.equal(body[0].active, true);
  assert.deepEqual(body[1].urls, [{ salesChannel: 'Storefront', salesChannelId: SC, language: 'Deutsch', url: `https://shop.test/detail/${B}`, hasSeoUrl: false }]);
  assert.equal(body[2].urls[0].url, 'https://shop.test/Wohnen/Vasen/');
  assert.equal((await call(shop(), 'get_seo_urls', {})).isError, true);
});

// Privilegierter Client auf derselben Datenbank: create/update/DELETE wie die Admin-API
const writerFor = (sw: ReturnType<typeof shop>) => ({
  ...sw,
  async search(entity: string, c?: SwEntity) { const r = await sw.search(entity, c); return { ...r, data: r.data.map(x => ({ ...x })) }; }, // Kopien wie echte API-Antworten
  async get(entity: string, id: string) { const r = await sw.get(entity, id); return r ? { ...r } : null; },
  async create(entity: string, data: SwEntity) { (sw.db[entity] ||= []).push({ ...data }); },
  async update(entity: string, id: string, data: SwEntity) { const r = sw.db[entity]?.find(x => x.id === id); if (!r) throw Object.assign(new Error('404'), { status: 404 }); Object.assign(r, data); },
  async req(m: string, path: string) { const [, entity, id] = path.split('/'); if (m === 'DELETE') sw.db[entity] = (sw.db[entity] ?? []).filter(x => x.id !== id); },
}) as unknown as Shopware;

test('propose_seo_urls: Werkzeug baut das Änderungsset, der Applier schreibt die kanonische URL, Rückgängig stellt den alten Stand her', async () => {
  const { applyChangeSet, undoOps } = await import('../changes');
  const sw = shop(); let captured: ChangeSet | undefined;
  const session = { sw, requestChange: async (cs: ChangeSet) => { captured = cs; return { status: 'applied', applied: cs.items.length, failed: [] }; } };
  const t = seo.tools(session as never).find(x => x.name === 'propose_seo_urls')!;
  const r = await t.handler({ title: 'Sprechende URLs', reason: 'SEO', changes: [{ entity: 'product', id: A, slug: 'Vase Kiesel Steinzeug 22 cm' }, { entity: 'category', id: K2, slug: 'wohnen/vasen-und-schalen' }] } as never, {});
  assert.equal(!!r.isError, false, (r.content[0] as { text: string }).text);
  const cs = captured!;
  assert.equal(cs.kind, 'seo-urls');
  assert.deepEqual(cs.items.map(i => [i.id, i.before, i.after]), [[`product:${A}`, 'https://shop.test/vase/HH-1', 'https://shop.test/vase-kiesel-steinzeug-22-cm'], [`category:${K2}`, 'https://shop.test/Wohnen/Vasen/', 'https://shop.test/wohnen/vasen-und-schalen/']]);
  // Anwenden mit dem privilegierten Client
  const w = writerFor(sw), res = await applyChangeSet(w, cs, null, new Set(cs.items.map(i => i.id)));
  assert.deepEqual(res.results.map(x => x.ok), [true, true]);
  const urls = () => sw.db['seo-url'], byId = (id: string) => urls().find(u => u.id === id)!;
  const neuP = urls().find(u => u.seoPathInfo === 'vase-kiesel-steinzeug-22-cm')!, neuK = urls().find(u => u.seoPathInfo === 'wohnen/vasen-und-schalen/')!;
  assert.equal(byId('s1').isCanonical, null, 'alte Produkt-URL nicht mehr kanonisch (bleibt als Weiterleitung)');
  assert.deepEqual([neuP.foreignKey, neuP.routeName, neuP.isCanonical, neuP.isModified, neuP.salesChannelId, neuP.languageId], [A, 'frontend.detail.page', true, true, SC, DE]);
  assert.equal(byId('s2').isCanonical, null);
  assert.deepEqual([neuK.foreignKey, neuK.routeName, neuK.pathInfo, neuK.isCanonical], [K2, 'frontend.navigation.page', `/navigation/${K2}`, true]);
  assert.equal(res.undo.length, 4);
  assert.deepEqual(res.undo.map(u => `${u.op} ${u.entity}`).sort(), ['delete seo-url', 'delete seo-url', 'patch seo-url', 'patch seo-url']);
  // Rückgängig: neue URLs gelöscht, alte wieder kanonisch, sonst nichts verändert
  const back = await undoOps(w, res.undo);
  assert.deepEqual(back.map(b => b.ok), [true, true, true, true]);
  assert.deepEqual(urls().map(u => [u.id, u.seoPathInfo, u.isCanonical]), [['s1', 'vase/HH-1', true], ['s2', 'Wohnen/Vasen/', true]]);
  // Konflikt beim Anwenden (Slug inzwischen vergeben): Element fehlgeschlagen, nichts geschrieben
  sw.db['seo-url'].push({ id: 's9', foreignKey: B, routeName: 'frontend.detail.page', seoPathInfo: 'vase-kiesel-steinzeug-22-cm', salesChannelId: SC, languageId: DE, isCanonical: true });
  const res2 = await applyChangeSet(w, cs, null, new Set([`product:${A}`]));
  assert.equal(res2.results[0].ok, false); assert.match(res2.results[0].error!, /inzwischen vergeben/);
  assert.deepEqual([byId('s1').isCanonical, res2.undo], [true, []]);
});
