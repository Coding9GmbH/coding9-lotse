import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Shopware, ShopReader, SwEntity } from '../../../src/server/shopware';
import type { Criteria } from '../../../src/server/policy';
import type { ChangeItem } from '@/lib/protocol';
import { buildPageTranslationChangeSet, buildTranslationChangeSet, fallbackChain, languageOverview, ownOf, planTranslationWrite, readPageTexts, readTranslations, resolveLang, resolveRaw, SYSTEM_LANGUAGE, type Lang, type SlotRaw, type TrRaw } from '../../../src/server/features/translations';

const EN = SYSTEM_LANGUAGE, DE = 'de'.padEnd(32, '0'), FR = 'f'.padEnd(32, '0');
const LANGS = [{ id: EN, name: 'English', locale: { code: 'en-GB' }, parentId: null }, { id: DE, name: 'Deutsch', locale: { code: 'de-DE' }, parentId: null }, { id: FR, name: 'Français', locale: { code: 'fr-FR' }, parentId: null }];
const P = 'a'.repeat(32);

// Fake-Shop: eigene Werte je Sprache; translated = mit Rückfall auf die Systemsprache (wie Shopware mit sw-language-id)
function fakeShop(own: Record<string, Record<string, SwEntity>>, extra: (entity: string, c: Criteria, lang: string) => SwEntity[] | null = () => null): ShopReader {
  const row = (entity: string, id: string, lang: string) => {
    const o = own[`${entity}:${id}`]; if (!o) return null;
    const mine = o[lang] ?? {}, sys = o[EN] ?? {}, fields = new Set([...Object.keys(sys), ...Object.keys(mine)]);
    return { id, ...Object.fromEntries([...fields].map(f => [f, mine[f] ?? null])), translated: Object.fromEntries([...fields].map(f => [f, mine[f] ?? sys[f] ?? null])) };
  };
  const search = async (entity: string, c: Criteria = {}, o?: { languageId?: string }) => {
    const lang = o?.languageId ?? EN, x = extra(entity, c, lang);
    if (x) return { data: x, total: x.length };
    if (entity === 'language') return { data: LANGS, total: 3 };
    const ids = (c.ids as string[] | undefined) ?? [];
    const data = ids.map(id => row(entity, id, lang)).filter(Boolean) as SwEntity[];
    return { data, total: data.length };
  };
  return { base: 'http://shop.test', search, get: async (e, id, c, o) => (await search(e, { ...c, ids: [id] }, o)).data[0] ?? null, salesChannels: async () => [], req: async () => null };
}
const L = (id: string): Lang => ({ id, name: id, locale: '', parentId: null, system: id === EN });

test('resolveLang: per ID, Locale, Sprachkürzel oder Name; Rückfallkette endet in der Systemsprache', () => {
  const langs: Lang[] = LANGS.map(l => ({ id: l.id, name: l.name, locale: l.locale.code, parentId: l.parentId, system: l.id === EN }));
  assert.equal(resolveLang(langs, 'de-DE').id, DE);
  assert.equal(resolveLang(langs, 'fr').id, FR);
  assert.equal(resolveLang(langs, 'english').id, EN);
  assert.equal(resolveLang(langs, DE).id, DE);
  assert.throws(() => resolveLang(langs, 'it-IT'), /unbekannt.*Deutsch \(de-DE\)/);
  const ch = [L(EN), { ...L('at'), parentId: DE }, L(DE)];
  assert.deepEqual(fallbackChain(ch, ch[1]).map(l => l.id), ['at', DE, EN]);
});

test('planTranslationWrite: vorhandene Zeile → alte Werte zurück (Zusatzfelder leeren + vollständig setzen), neue Zeile → Zeile löschen', () => {
  const rows = [{ languageId: EN, name: 'Vase', metaTitle: null, customFields: { aicb_blocks: { faq: [{ q: 'a', a: 'b' }], other: 1 } } }];
  const raws: TrRaw[] = [
    { languageId: EN, field: 'metaTitle', value: 'Vase Pebble | Haus Holm' },
    { languageId: EN, field: 'faq', value: { title: 'FAQ', items: [{ q: 'Is it watertight?', a: 'Yes.' }, { q: 'Size?', a: '22 cm.' }] } },
    { languageId: DE, field: 'name', value: 'Vase „Kiesel“' },
  ];
  const { data, undo } = planTranslationWrite('product', P, rows, raws);
  const tr = data.translations as Record<string, Record<string, unknown>>;
  assert.equal(tr[EN].metaTitle, 'Vase Pebble | Haus Holm');
  const blocks = (tr[EN].customFields as { aicb_blocks: { faq: unknown[]; faq_html: string; other: number } }).aicb_blocks;
  assert.equal(blocks.other, 1); assert.equal(blocks.faq.length, 2); assert.match(blocks.faq_html, /Is it watertight\?/);
  assert.deepEqual(tr[DE], { name: 'Vase „Kiesel“' });
  // Rückwärts ausgeführt: Systemsprache zuerst wiederherstellen, die neue DE-Zeile zuletzt löschen (sonst erbt DE kurz den neuen Text → SEO-URL-Reste)
  assert.deepEqual(undo, [
    { op: 'req', entity: 'product', id: P, method: 'DELETE', path: `/product/${P}/translations/${DE}` },
    { op: 'patch', entity: 'product', id: P, data: { translations: { [EN]: { metaTitle: null, customFields: rows[0].customFields } } } },
    { op: 'patch', entity: 'product', id: P, data: { translations: { [EN]: { customFields: null } } } },
  ]);
});

test('Übersetzungs-Set: Vorher/Nachher je Sprache, SEO-Hinweise, unverändert, unbekannte Felder', async () => {
  const ro = fakeShop({ [`product:${P}`]: { [EN]: { name: 'Vase „Kiesel“', productNumber: 'HH-VASE-22', description: '<p>Bauchige Vase.</p>', metaTitle: null }, [DE]: {}, [FR]: { name: 'Vase « Galet »' } } });
  const cs = await buildTranslationChangeSet(ro, { title: 'FR', reason: 'Übersetzung', entity: 'product', changes: [
    { id: P, language: 'fr-FR', fields: { name: 'Vase « Galet »', description: '<p>Bauchige Vase.</p>', metaTitle: 'Vase « Galet » en grès mat, 22 cm – un objet calme pour le buffet | Haus Holm', color: 'x' } },
  ] });
  assert.equal(cs.kind, 'translations'); assert.equal(cs.unchanged, 1);
  assert.deepEqual(cs.items.map(i => i.id), [`${P}:${FR}:description`, `${P}:${FR}:metaTitle`]);
  const [d, m] = cs.items;
  assert.equal(d.before, 'erbt: Bauchige Vase.'); assert.match(d.warn.join(), /identisch mit English/);
  assert.equal(m.fieldLabel, 'Meta-Title (fr-FR)'); assert.match(m.warn.join(), /Meta-Title \d+ Zeichen/);
  assert.deepEqual(m.afterRaw, { languageId: FR, field: 'metaTitle', value: 'Vase « Galet » en grès mat, 22 cm – un objet calme pour le buffet | Haus Holm' });
  assert.match(cs.skipped[0].reason, /„color“ nicht übersetzbar/);
});

test('Übersetzungs-Set: Systemsprache ändern sichert den Text erbender Sprachen – explizite Werte haben Vorrang', async () => {
  const ro = fakeShop({ [`product:${P}`]: { [EN]: { name: 'Vase „Kiesel“', description: '<p>Bauchige Vase.</p>' }, [DE]: {}, [FR]: {} } });
  const cs = await buildTranslationChangeSet(ro, { title: 'EN', reason: 'r', entity: 'product', changes: [
    { id: P, language: 'en-GB', fields: { description: '<p>Bulbous vase.</p>' } },
    { id: P, language: 'fr-FR', fields: { description: '<p>Vase bombé.</p>' } },
  ] });
  assert.deepEqual(cs.items.map(i => [i.id, (i.afterRaw as TrRaw).value]), [
    [`${P}:${EN}:description`, '<p>Bulbous vase.</p>'],
    [`${P}:${DE}:description`, '<p>Bauchige Vase.</p>'],
    [`${P}:${FR}:description`, '<p>Vase bombé.</p>'],
  ]);
  assert.match(cs.items[0].warn.join(), /^Deutsch erbt dieses Feld: bisheriger Text wird dort gesichert$/); // Französisch kommt explizit mit
  const off = await buildTranslationChangeSet(ro, { title: 'EN', reason: 'r', entity: 'product', keepInherited: false, changes: [{ id: P, language: 'en', fields: { description: '<p>Bulbous vase.</p>' } }] });
  assert.equal(off.items.length, 1); assert.match(off.items[0].warn.join(), /Deutsch, Français erben dieses Feld und ändern sich mit/);
  await assert.rejects(buildTranslationChangeSet(ro, { title: 'x', reason: 'r', entity: 'product', changes: [{ id: P, language: 'en', fields: { name: null } }] }), /Systemsprache darf nicht leer/);
  await assert.rejects(buildTranslationChangeSet(ro, { title: 'x', reason: 'r', entity: 'product', changes: [{ id: P, language: 'fr', fields: { faq: [{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }] } }] }), /title in der Zielsprache/);
});

// Einkaufswelt mit Text-Element (inkl. Plugin-Schlüssel „phone“, der nie ins Änderungsset gehört) und Bild-Element; eigene Config nur in der Systemsprache
const S1 = '1'.repeat(32), S2 = '2'.repeat(32), M = 'e'.repeat(32), C = 'c'.repeat(32);
const HTML = '<h2>Drei Objekte</h2><p>Zur <a href="http://shop.test/Wohnaccessoires/">Kategorie</a></p>';
const S1_CFG = { content: { source: 'static', value: HTML }, phone: { source: 'static', value: '+49 40 123' } };
const cmsPage = (lang: string) => ({ id: 'pg', name: 'Haus Holm', translated: { name: 'Haus Holm' }, type: 'product_list', sections: [{ position: 0, blocks: [
  { position: 0, type: 'html', slots: [{ id: S1, slot: 'content', type: 'html', config: lang === EN ? S1_CFG : null, translated: { config: S1_CFG } }] },
  { position: 1, type: 'image', slots: [{ id: S2, slot: 'image', type: 'image', config: lang === EN ? { media: { source: 'static', value: M } } : null, translated: { config: { media: { source: 'static', value: M } } } }] },
] }] });
function pageShop() {
  const ro = fakeShop({ [`media:${M}`]: { [EN]: { alt: 'Vase auf Sideboard', fileName: 'vase' } } }, (entity, c, lang) => {
    if (entity === 'cms-page') return [cmsPage(lang)];
    if (entity === 'seo-url') return (c.filter as { field: string }[]).some(f => f.field === 'seoPathInfo')
      ? [{ seoPathInfo: 'Wohnaccessoires/', routeName: 'frontend.navigation.page', foreignKey: C, salesChannelId: 'sc', languageId: DE, isCanonical: true }]
      : [{ seoPathInfo: 'Home-accessories/', routeName: 'frontend.navigation.page', foreignKey: C, salesChannelId: 'sc', languageId: FR }];
    return null;
  });
  ro.salesChannels = async () => [{ id: 'sc', domains: [{ url: 'http://shop.test', languageId: DE }, { url: 'http://shop.test/fr', languageId: FR }] }];
  return ro;
}

test('Seiten-Übersetzung: alle keys Pflicht, nur geänderte Config-Schlüssel als Patch, Links und Alt-Texte', async () => {
  const ro = pageShop();
  await assert.rejects(buildPageTranslationChangeSet(ro, { cmsPageId: 'pg', target: 'fr', texts: { 's0.0': 'Trois objets' } }), /Ohne Übersetzung.*s0\.1.*s1\.alt/);
  await assert.rejects(buildPageTranslationChangeSet(ro, { cmsPageId: 'pg', target: 'fr', texts: { 's0.0': 'Trois objets', 's0.1': 'Vers la catégorie', 's1.alt': 'x', 's9.0': 'y' } }), /s0\.1: Inline-Tags.*Unbekannte keys: s9\.0/);
  const cs = await buildPageTranslationChangeSet(ro, { cmsPageId: 'pg', target: 'fr', texts: { 's0.0': 'Trois objets', 's0.1': 'Vers la <a href="http://shop.test/Wohnaccessoires/">catégorie</a>', 's1.alt': 'Vase sur un buffet' } });
  assert.equal(cs.kind, 'page-translation');
  const slot = cs.items.find(i => i.entity === 'cms-slot')!, alt = cs.items.find(i => i.entity === 'media')!;
  assert.deepEqual(slot.afterRaw, { languageId: FR, field: 'config', patch: { content: { source: 'static', value: '<h2>Trois objets</h2><p>Vers la <a href="http://shop.test/fr/Home-accessories/">catégorie</a></p>' } }, baseLanguageId: EN });
  assert.ok(!JSON.stringify(cs).includes('+49'), 'nicht übersetzte Config-Schlüssel bleiben dem Änderungsset fern');
  assert.match(slot.before, /^erbt English/); assert.match(slot.warn.join(), /Link → http:\/\/shop.test\/fr\/Home-accessories\//);
  assert.deepEqual(alt.afterRaw, { languageId: FR, field: 'alt', value: 'Vase sur un buffet' });
  assert.equal(cs.items[0].entity, 'info');
  // Systemsprache als Ziel: erbende Sprachen sichern ihren Stand (leerer Patch, Basis = eigene Sprache)
  const sys = await buildPageTranslationChangeSet(ro, { cmsPageId: 'pg', target: 'en', source: 'de', texts: { 's0.0': 'Three objects', 's0.1': 'To the <a href="http://shop.test/Wohnaccessoires/">category</a>', 's1.alt': 'Vase on a sideboard' } });
  const saved = sys.items.filter(i => i.entity === 'cms-slot' && /sichern/.test(i.fieldLabel));
  assert.deepEqual(saved.map(i => i.afterRaw), [{ languageId: DE, field: 'config', patch: {}, baseLanguageId: DE }, { languageId: FR, field: 'config', patch: {}, baseLanguageId: FR }]);
});

test('resolveRaw: Element-Config kommt beim Schreiben frisch und ungekürzt aus dem Shop, nur der Patch wird eingemischt', async () => {
  const get = async (_e: string, _id: string, _c: unknown, o: { languageId?: string }) => ({ translated: { config: { content: { source: 'static', value: `<p>${o.languageId}</p>` }, phone: { source: 'static', value: '+49 40 1' } } } });
  const sw = { get } as unknown as Pick<Shopware, 'get'>;
  const r = await resolveRaw(sw, 'cms-slot', S1, { languageId: FR, field: 'config', patch: { content: { source: 'static', value: '<p>fr</p>' } }, baseLanguageId: EN });
  assert.deepEqual(r, { languageId: FR, field: 'config', value: { content: { source: 'static', value: '<p>fr</p>' }, phone: { source: 'static', value: '+49 40 1' } } });
  assert.deepEqual((await resolveRaw(sw, 'cms-slot', S1, { languageId: DE, field: 'config', patch: {}, baseLanguageId: DE })).value, { content: { source: 'static', value: `<p>${DE}</p>` }, phone: { source: 'static', value: '+49 40 1' } });
  const plainRaw: TrRaw = { languageId: FR, field: 'alt', value: 'x' };
  assert.equal(await resolveRaw(sw, 'media', M, plainRaw), plainRaw);
});

// ---- Executor applyTranslations (über applyChangeSet) mit Fake-Writer ----
function writer(rows: Record<string, SwEntity[]>) {
  const calls: unknown[][] = [], searched: string[] = [];
  const w = {
    search: async (entity: string, c: { ids?: string[] }) => { searched.push(entity); if (entity === 'custom-field-set') return { data: [{ id: 'cfs' }] }; const id = c.ids?.[0] ?? ''; return { data: rows[`${entity}:${id}`] ? [{ id, translations: rows[`${entity}:${id}`] }] : [] }; },
    update: async (e: string, id: string, data: unknown) => { calls.push(['update', e, id, data]); },
    create: async () => { throw new Error('nicht erwartet'); },
    get: async () => ({ translated: { config: { content: { source: 'static', value: '<p>en</p>' }, phone: { source: 'static', value: '+49' } } } }),
  };
  return { w: w as unknown as Shopware, calls, searched };
}
const item = (entity: string, id: string, field: string, afterRaw: TrRaw | SlotRaw): ChangeItem => ({ id: `${id}:${afterRaw.languageId}:${field}`, entity, entityId: id, label: '', field, fieldLabel: '', before: '', after: '', afterRaw, warn: [] });
const set = (kind: string, entity: string, items: ChangeItem[]) => ({ id: 'cs', kind, entity, title: 't', reason: null, skipped: [], atomic: false, items });
const all = (items: ChangeItem[]) => new Set(items.map(i => i.id));

test('applyTranslations: je Datensatz ein Schreibzugriff, Undo genau einmal, FAQ-Feldset nur bei Produkt-FAQ mit Wert', async () => {
  const { applyChangeSet } = await import('../../../src/server/changes');
  // Kategorie: kein Zusatzfeld-Set; neue Übersetzungszeile → Undo löscht die Zeile
  const cat = writer({ [`category:${C}`]: [{ languageId: EN, name: 'Living' }] }), ci = [item('category', C, 'name', { languageId: DE, field: 'name', value: 'Wohnen' }), item('category', C, 'metaTitle', { languageId: DE, field: 'metaTitle', value: 'Wohnen | Haus Holm' })];
  const r1 = await applyChangeSet(cat.w, set('translations', 'category', ci) as never, null, all(ci));
  assert.deepEqual(r1.results.map(x => x.ok), [true, true]);
  assert.deepEqual(cat.calls, [['update', 'category', C, { translations: { [DE]: { name: 'Wohnen', metaTitle: 'Wohnen | Haus Holm' } } }]]);
  assert.deepEqual(r1.undo, [{ op: 'req', entity: 'category', id: C, method: 'DELETE', path: `/category/${C}/translations/${DE}` }]);
  assert.ok(!cat.searched.includes('custom-field-set'));
  // Produkt mit FAQ-Wert: Feldset wird sichergestellt
  const faq = { title: 'FAQ', items: [{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }] };
  const pr = writer({ [`product:${P}`]: [{ languageId: EN, metaTitle: 'alt', customFields: null }] }), pi = [item('product', P, 'faq', { languageId: EN, field: 'faq', value: faq }), item('product', P, 'metaTitle', { languageId: EN, field: 'metaTitle', value: 'neu' })];
  const r2 = await applyChangeSet(pr.w, set('translations', 'product', pi) as never, null, all(pi));
  assert.ok(pr.searched.includes('custom-field-set'));
  assert.equal(pr.calls.length, 1);
  const data = (pr.calls[0][3] as { translations: Record<string, { metaTitle: string; customFields: { aicb_blocks: { faq: unknown[] } } }> }).translations[EN];
  assert.equal(data.metaTitle, 'neu'); assert.equal(data.customFields.aicb_blocks.faq.length, 2);
  assert.deepEqual(r2.undo, [{ op: 'patch', entity: 'product', id: P, data: { translations: { [EN]: { metaTitle: 'alt', customFields: null } } } }]);
  // FAQ entfernen neben anderen Zusatzfeldern: erst leeren (pre), dann Rest setzen; Undo trotzdem nur einmal
  const rows = [{ languageId: DE, customFields: { aicb_blocks: { faq: [{ q: 'x', a: 'y' }], faq_html: 'h' }, color: 'blau' } }];
  const rm = writer({ [`product:${P}`]: rows }), ri = [item('product', P, 'faq', { languageId: DE, field: 'faq', value: null })];
  const r3 = await applyChangeSet(rm.w, set('translations', 'product', ri) as never, null, all(ri));
  assert.deepEqual(rm.calls.map(c => c[3]), [{ translations: { [DE]: { customFields: null } } }, { translations: { [DE]: { customFields: { color: 'blau' } } } }]);
  assert.deepEqual(r3.undo, planTranslationWrite('product', P, rows, ri.map(i => i.afterRaw as TrRaw)).undo);
  // Datensatz weg → alle Items des Datensatzes fehlgeschlagen
  const gone = await applyChangeSet(writer({}).w, set('translations', 'product', pi) as never, null, all(pi));
  assert.deepEqual(gone.results.map(x => x.error), ['Datensatz nicht mehr vorhanden', 'Datensatz nicht mehr vorhanden']);
});

test('applyTranslations: Element-Patch wird in die frische Config gemischt, Alt-Texte laufen über denselben Applier', async () => {
  const { applyChangeSet } = await import('../../../src/server/changes');
  const sl = writer({ [`cms-slot:${S1}`]: [{ languageId: EN, config: S1_CFG }], [`media:${M}`]: [{ languageId: EN, alt: 'Vase' }] });
  const items = [
    item('cms-slot', S1, 'config', { languageId: FR, field: 'config', patch: { content: { source: 'static', value: '<p>fr</p>' } }, baseLanguageId: EN }),
    item('media', M, 'alt', { languageId: FR, field: 'alt', value: 'Vase sur un buffet' }),
  ];
  const r = await applyChangeSet(sl.w, set('page-translation', 'cms-slot', items) as never, null, all(items));
  assert.deepEqual(r.results.map(x => x.ok), [true, true]);
  assert.deepEqual(sl.calls.sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [
    ['update', 'cms-slot', S1, { translations: { [FR]: { config: { content: { source: 'static', value: '<p>fr</p>' }, phone: { source: 'static', value: '+49' } } } } }],
    ['update', 'media', M, { translations: { [FR]: { alt: 'Vase sur un buffet' } } }],
  ]);
  assert.deepEqual(r.undo.map(u => u.path).sort(), [`/cms-slot/${S1}/translations/${FR}`, `/media/${M}/translations/${FR}`]);
});

// ---- Lesefunktionen ----
test('readTranslations: ids-Paginierung, Hinweis hinter der Liste, onlyMissing, eigene/geerbte/leere Felder, doppelte Locale', async () => {
  const Q = 'b'.repeat(32);
  const own = { [`product:${P}`]: { [EN]: { name: 'Vase', productNumber: 'HH-1', description: '<p>Bulbous</p>' }, [DE]: {}, [FR]: { name: 'Vase FR' } }, [`product:${Q}`]: { [EN]: { name: 'Mug', productNumber: 'HH-2' }, [DE]: { name: 'Becher' }, [FR]: { name: 'Tasse' } } };
  const ro = fakeShop(own);
  const r = await readTranslations(ro, { entity: 'product', ids: [P, Q], limit: 1, offset: 1 });
  assert.equal(r.total, 2); assert.equal(r.offset, 1); assert.equal(r.returned, 1); assert.equal(r.items[0].id, Q);
  const beyond = await readTranslations(ro, { entity: 'product', ids: [P, Q], offset: 5 });
  assert.equal(beyond.returned, 0); assert.match(beyond.hint!, /offset 5 liegt hinter den 2 ids/);
  const m = await readTranslations(ro, { entity: 'product', ids: [P, Q], onlyMissing: true });
  assert.equal(m.scanned, 2); assert.deepEqual(m.items.map(i => i.id), [P], 'Q ist in allen Sprachen übersetzt (leere Felder zählen nicht als Lücke)');
  const de = (m.items[0].languages as Record<string, { values: Record<string, unknown>; inherited?: string[]; empty?: string[] }>)['de-DE'];
  assert.deepEqual(de.values, {}); assert.deepEqual(de.inherited, ['name', 'description']); assert.deepEqual(de.empty, ['metaTitle', 'metaDescription', 'keywords', 'faq']);
  assert.deepEqual((m.items[0].languages as Record<string, { values: Record<string, unknown> }>)['fr-FR'].values, { name: 'Vase FR' });
  assert.match(m.hint, /onlyMissing filtert nur die gelesene Seite/);
  // zwei Sprachen mit derselben Locale: Schlüssel mit ID
  const AT = 'a7'.padEnd(32, '0');
  const dup = await readTranslations(fakeShop(own, e => (e === 'language' ? [...LANGS, { id: AT, name: 'Schweiz', locale: { code: 'de-DE' }, parentId: null }] : null)), { entity: 'product', ids: [P], languages: ['de-DE', AT] });
  assert.deepEqual(Object.keys(dup.items[0].languages).sort(), [`de-DE (${AT})`, `de-DE (${DE})`]);
  await assert.rejects(readTranslations(ro, { entity: 'category', categoryId: C }), /categoryId nur bei entity=product/);
});

test('readPageTexts: keys je Element, Alt-Text des Bildes, Zielsprache und Standard-Quellsprache', async () => {
  const ro = pageShop();
  const r = await readPageTexts(ro, { cmsPageId: 'pg', target: 'fr' });
  assert.equal(r.sourceLanguage, 'English (en-GB)'); assert.equal(r.targetLanguage, 'Français (fr-FR)'); assert.equal(r.segments, 3);
  assert.deepEqual(r.slots.map(s => [s.key, s.element, s.targetHasOwn, s.texts.map(t => [t.key, t.kind, t.text]), s.links]), [
    ['s0', 'content (html)', false, [['s0.0', 'text', 'Drei Objekte'], ['s0.1', 'text', 'Zur <a href="http://shop.test/Wohnaccessoires/">Kategorie</a>']], ['http://shop.test/Wohnaccessoires/']],
    ['s1', 'image (image)', false, [['s1.alt', 'mediaAlt', 'Vase auf Sideboard']], []],
  ]);
  assert.equal((r.slots[1] as { targetAlt?: string | null }).targetAlt, null);
  assert.ok(!JSON.stringify(r).includes('+49'), 'nicht übersetzbare Config-Werte werden nicht ausgegeben');
  // Ziel = Systemsprache → Quelle ist eine andere Sprache (Standardsprache der Storefront bzw. erste Nicht-Systemsprache)
  const sys = await readPageTexts(ro, { cmsPageId: 'pg', target: 'en' });
  assert.equal(sys.sourceLanguage, 'Deutsch (de-DE)');
  await assert.rejects(readPageTexts(ro, { cmsPageId: 'pg', target: 'it' }), /Sprache „it“ unbekannt/);
});

test('languageOverview: Sprachen mit Kanälen, Domains, Vererbung und hreflang-Status', async () => {
  const ro = fakeShop({}, e => (e === 'sales-channel' ? [{ id: 'sc', name: 'Storefront', typeId: '8a243080f92e4c719546314b577cf82b', languageId: EN, languages: [{ id: EN }, { id: DE }], domains: [{ id: 'd1', url: 'http://shop.test', languageId: EN }, { id: 'd2', url: 'http://shop.test/de', languageId: DE }], hreflangActive: true, hreflangDefaultDomainId: 'd1' }] : null));
  const o = await languageOverview(ro);
  assert.equal(o.systemLanguage, 'English');
  const en = o.languages.find(l => l.id === EN)!, fr = o.languages.find(l => l.id === FR)!, de = o.languages.find(l => l.id === DE)!;
  assert.equal(en.systemDefault, true); assert.deepEqual(en.salesChannels, [{ name: 'Storefront', type: 'Storefront', defaultLanguage: true }]); assert.deepEqual(en.inheritsFrom, []);
  assert.deepEqual(de.domains, [{ salesChannel: 'Storefront', url: 'http://shop.test/de' }]); assert.deepEqual(de.inheritsFrom, ['English']); assert.equal(de.storefrontReachable, true);
  assert.deepEqual(fr.salesChannels, []); assert.equal(fr.storefrontReachable, false);
  assert.deepEqual(o.hreflang, [{ salesChannel: 'Storefront', active: true, defaultDomain: 'http://shop.test', domains: [{ url: 'http://shop.test', language: 'en-GB' }, { url: 'http://shop.test/de', language: 'de-DE' }], hint: 'ok' }]);
});

test('planTranslationWrite: FAQ null entfernt aicb_blocks der Sprache (erbt dann wieder) – andere Zusatzfelder bleiben', () => {
  const faq = [{ q: 'Wasserdicht?', a: 'Ja.' }, { q: 'Größe?', a: '22 cm.' }];
  const only = [{ languageId: DE, customFields: { aicb_blocks: { faq, faq_html: '<h2>FAQ</h2>' } } }];
  const a = planTranslationWrite('product', P, only, [{ languageId: DE, field: 'faq', value: null }]);
  assert.equal(a.pre, null);
  assert.deepEqual(a.data, { translations: { [DE]: { customFields: null } } });
  assert.deepEqual(a.undo, [
    { op: 'patch', entity: 'product', id: P, data: { translations: { [DE]: { customFields: only[0].customFields } } } },
    { op: 'patch', entity: 'product', id: P, data: { translations: { [DE]: { customFields: null } } } },
  ]);
  const mixed = [{ languageId: DE, customFields: { aicb_blocks: { faq: null, faq_html: null }, color: 'blau' } }];
  const b = planTranslationWrite('product', P, mixed, [{ languageId: DE, field: 'faq', value: null }]);
  assert.deepEqual(b.pre, { translations: { [DE]: { customFields: null } } });
  assert.deepEqual(b.data, { translations: { [DE]: { customFields: { color: 'blau' } } } });
  assert.deepEqual(b.undo[0], { op: 'patch', entity: 'product', id: P, data: { translations: { [DE]: { customFields: mixed[0].customFields } } } });
  const keep = planTranslationWrite('product', P, [{ languageId: DE, customFields: { aicb_blocks: { faq, faq_html: 'x', video: 'v' } } }], [{ languageId: DE, field: 'faq', value: null }]);
  assert.deepEqual(keep.data, { translations: { [DE]: { customFields: { aicb_blocks: { video: 'v' } } } } });
});

test('Übersetzungs-Set: FAQ null zeigt den geerbten Wert der Rückfallkette; altes {faq:null} lässt sich entfernen', async () => {
  const faq = (q: string) => [{ q, a: 'a' }, { q: q + '2', a: 'b' }];
  const ro = fakeShop({ [`product:${P}`]: { [EN]: { name: 'Vase', customFields: { aicb_blocks: { faq: faq('Watertight?') } } }, [DE]: { customFields: { aicb_blocks: { faq: faq('Wasserdicht?') } } }, [FR]: { customFields: { aicb_blocks: { faq: null, faq_html: null } } } } });
  const cs = await buildTranslationChangeSet(ro, { title: 'x', reason: 'r', entity: 'product', changes: [{ id: P, language: 'de', fields: { faq: null } }, { id: P, language: 'fr', fields: { faq: null } }] });
  assert.deepEqual(cs.items.map(i => i.id), [`${P}:${DE}:faq`, `${P}:${FR}:faq`]);
  assert.equal(cs.items[0].after, 'eigene Übersetzung entfernen (erbt English: 2 Fragen)');
});

test('Übersetzungs-Set: Systemsprache bekommt ein bisher leeres Feld → erbende Sprachen werden gewarnt, nichts „gesichert“', async () => {
  const ro = fakeShop({ [`product:${P}`]: { [EN]: { name: 'Vase', metaTitle: null }, [DE]: { name: 'Vase DE' }, [FR]: {} } });
  const cs = await buildTranslationChangeSet(ro, { title: 'EN', reason: 'r', entity: 'product', changes: [{ id: P, language: 'en-GB', fields: { metaTitle: 'Stoneware vase Pebble | Haus Holm' } }] });
  assert.equal(cs.items.length, 1);
  const w = cs.items[0].warn.join(' ');
  assert.doesNotMatch(w, /gesichert/);
  assert.match(w, /Deutsch, Français erben dieses Feld und zeigen danach diesen Text \(English\)\. Eigene Fassung in Deutsch, Français mitliefern/);
  // mit eigener deutscher Fassung im selben Set: nur noch Französisch betroffen
  const cs2 = await buildTranslationChangeSet(ro, { title: 'EN', reason: 'r', entity: 'product', changes: [{ id: P, language: 'en-GB', fields: { metaTitle: 'Stoneware vase Pebble | Haus Holm' } }, { id: P, language: 'de', fields: { metaTitle: 'Steinzeug-Vase Kiesel | Haus Holm' } }] });
  assert.match(cs2.items[0].warn.join(' '), /^Français erbt dieses Feld und zeigt danach/);
});

test('Übersetzungs-Set: Sprache mit Elternsprache (eigener Wert) erbt nicht von der Systemsprache – kein Sichern', async () => {
  const AT = 'a7'.padEnd(32, '0');
  const langs = [...LANGS, { id: AT, name: 'Österreich', locale: { code: 'de-AT' }, parentId: DE }];
  const ro = fakeShop({ [`product:${P}`]: { [EN]: { name: 'Vase', description: '<p>Bauchige Vase.</p>' }, [DE]: { description: '<p>Bauchige Vase (DE).</p>' }, [FR]: {}, [AT]: {} } }, e => (e === 'language' ? langs : null));
  const cs = await buildTranslationChangeSet(ro, { title: 'EN', reason: 'r', entity: 'product', changes: [{ id: P, language: 'en', fields: { description: '<p>Bulbous vase.</p>' } }] });
  assert.deepEqual(cs.items.map(i => i.id), [`${P}:${EN}:description`, `${P}:${FR}:description`]);
  assert.match(cs.items[0].warn.join(), /^Français erbt dieses Feld: bisheriger Text wird dort gesichert$/);
});

test('Übersetzungs-Set: Landingpage-URL muss ein Pfad ohne Leerzeichen/Großbuchstaben sein', async () => {
  const ro = fakeShop({ [`landing-page:${P}`]: { [EN]: { name: 'Sommer', url: 'sommer' }, [DE]: {}, [FR]: {} } });
  const run = (url: string) => buildTranslationChangeSet(ro, { title: 'x', reason: 'r', entity: 'landing-page', changes: [{ id: P, language: 'fr', fields: { url } }] });
  for (const bad of ['/ete', 'Été déco', 'ete/']) await assert.rejects(run(bad), /URL-Pfad/);
  assert.equal((await run('ete-deco')).items[0].after, 'ete-deco');
});

test('applyTranslations: Stale-Write-Guard – Sprache inzwischen anders übersetzt → nur dieses Item fehlgeschlagen, übrige Felder und Altbestand ohne beforeRaw werden geschrieben', async () => {
  const { applyChangeSet } = await import('../../../src/server/changes');
  const rows = [{ languageId: DE, name: 'Wohnen (Admin)', metaTitle: 'Wohnen' }];
  const w = writer({ [`category:${C}`]: rows });
  const items: ChangeItem[] = [
    { ...item('category', C, 'name', { languageId: DE, field: 'name', value: 'Wohnen & Leben' }), fieldLabel: 'Name (de-DE)', beforeRaw: 'Wohnen' }, // inzwischen „Wohnen (Admin)“
    { ...item('category', C, 'metaTitle', { languageId: DE, field: 'metaTitle', value: 'Wohnen | Haus Holm' }), beforeRaw: 'Wohnen' },         // unverändert
    item('category', C, 'description', { languageId: DE, field: 'description', value: '<p>x</p>' }),                                             // Altbestand ohne Snapshot
  ];
  const r = await applyChangeSet(w.w, set('translations', 'category', items) as never, null, all(items));
  assert.deepEqual(r.results, [{ itemId: items[0].id, ok: false, error: 'Name (de-DE): inzwischen geändert, bitte neu vorschlagen' }, { itemId: items[1].id, ok: true }, { itemId: items[2].id, ok: true }]);
  assert.deepEqual(w.calls, [['update', 'category', C, { translations: { [DE]: { metaTitle: 'Wohnen | Haus Holm', description: '<p>x</p>' } } }]]);
  assert.deepEqual(r.undo, [{ op: 'patch', entity: 'category', id: C, data: { translations: { [DE]: { metaTitle: 'Wohnen', description: null } } } }]);
  // ownOf: FAQ aus aicb_blocks, Element-Config nur in den gepatchten Schlüsseln, leerer Patch = ganze eigene Config
  assert.deepEqual(ownOf({ customFields: { aicb_blocks: { faq: [{ q: 'a', a: 'b' }] } } }, { languageId: DE, field: 'faq', value: null }), [{ q: 'a', a: 'b' }]);
  assert.deepEqual(ownOf({ config: S1_CFG }, { languageId: FR, field: 'config', patch: { content: {} }, baseLanguageId: EN }), { content: S1_CFG.content });
  assert.equal(ownOf(undefined, { languageId: FR, field: 'config', patch: {}, baseLanguageId: EN }), null);
  // „Texte sichern“ (leerer Patch) für eine Sprache, die beim Vorschlag noch erbte: eigene Config inzwischen da → nicht überschreiben
  const sl = writer({ [`cms-slot:${S1}`]: [{ languageId: FR, config: S1_CFG }] });
  const si: ChangeItem[] = [{ ...item('cms-slot', S1, 'config', { languageId: FR, field: 'config', patch: {}, baseLanguageId: EN }), fieldLabel: 'Texte (fr-FR) sichern', beforeRaw: null }];
  const r2 = await applyChangeSet(sl.w, set('page-translation', 'cms-slot', si) as never, null, all(si));
  assert.deepEqual([r2.results[0].ok, r2.results[0].error, sl.calls, r2.undo], [false, 'Texte (fr-FR) sichern: inzwischen geändert, bitte neu vorschlagen', [], []]);
});

test('Builder merkt je Übersetzungs-Item den eigenen Wert der Sprache (beforeRaw)', async () => {
  const ro = fakeShop({ [`product:${P}`]: { [EN]: { name: 'Vase', metaTitle: 'Vase | Shop', productNumber: 'HH-1' }, [DE]: { name: 'Vase', metaTitle: null } } });
  const cs = await buildTranslationChangeSet(ro, { title: 't', reason: 'r', entity: 'product', changes: [{ id: P, language: 'de-DE', fields: { name: 'Steinzeug-Vase', metaTitle: 'Steinzeug-Vase | Shop' } }] });
  assert.deepEqual(cs.items.map(i => [i.field, i.beforeRaw]), [['name', 'Vase'], ['metaTitle', null]]);
});
