import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  basePriceCandidate, basePriceText, contrastRatio, evaluateLegalPage, footerLinks, gpsrManufacturer, gpsrProduct, htmlA11y, isLinked, LEGAL_PAGES,
  parseQuantity, resolveTheme, suggestColor, themeContrast, unitKeyOf, validateGpsrValue,
} from '../../../src/server/features/legal-rules';
import { buildBasePriceChangeSet, buildGpsrChangeSet, basePriceRow, basePriceRows, LEGAL_CHECKS } from '../../../src/server/features/legal';
import { applyChangeSet } from '../../../src/server/changes';
import { perRun } from '../../../src/server/shopcheck-run';
import type { Shopware, ShopReader, SwEntity } from '../../../src/server/shopware';

function fakeReader(db: Record<string, SwEntity[]>): ShopReader {
  const search = async (entity: string, c: Record<string, unknown> = {}) => {
    let rows = db[entity] ?? [];
    if (Array.isArray(c.ids)) rows = rows.filter(r => (c.ids as string[]).includes(r.id));
    return { data: rows, total: rows.length };
  };
  return { base: 'http://shop', search, get: async (e, id) => (await search(e, { ids: [id] })).data[0] ?? null, salesChannels: async () => [], req: async () => null };
}

test('Füllmenge: Gewicht, Volumen, Mehrfachpackung; Maße sind kein Grundpreis-Fall', () => {
  assert.deepEqual(parseQuantity('Cold Brew „Ebbe“, grob gemahlen, 250 g'), { amount: 0.25, unit: 'kg', raw: '250 g', source: 'name' });
  assert.equal(parseQuantity('Probierset „Drei Häfen“, 3 × 250 g')?.amount, 0.75);
  assert.equal(parseQuantity('Olivenöl 0,75 l')?.unit, 'l');
  assert.equal(parseQuantity('Plaid „Düne“, Leinen-Baumwolle, 130 × 170 cm'), null);
  assert.equal(parseQuantity('Vase „Kiesel“, Steinzeug matt, 22 cm'), null);
  assert.deepEqual(parseQuantity('Jutekordel Meterware 5 m')?.unit, 'm');
  assert.equal(parseQuantity('Tee', '<p>Inhalt: 100 g loser Tee.</p>')?.amount, 0.1);
});

test('Grundpreis-Kandidat: Gefäß = prüfen, 1 kg = nicht nötig, Text', () => {
  const mug = basePriceCandidate('Becher „Morgen“, Steinzeug gesprenkelt, 350 ml')!;
  assert.equal(mug.confidence, 'prüfen'); assert.match(mug.reasons[0], /Fassungsvermögen/);
  assert.equal(basePriceCandidate('Espresso, 500 g')!.confidence, 'sicher');
  assert.match(basePriceCandidate('Crema, ganze Bohne, 1 kg')!.exempt ?? '', /entspricht dem Preis/);
  assert.equal(basePriceText(15.9, 0.35, 1, 'l'), '45,43 € / 1 l (Inhalt 0,35 l)');
  assert.equal(basePriceText(9.9, null, 1, 'kg'), 'fehlt');
  assert.equal(unitKeyOf({ shortCode: 'm²' }), 'm2');
});

test('Grundpreis-Status je Produkt', () => {
  const units = [{ id: 'u-kg', shortCode: 'kg', name: 'Kilogramm' }];
  const p = { id: 'p', name: 'Espresso, 500 g', productNumber: 'E', price: [{ currencyId: 'b7d2554b0ce847cd82f3ac9bd1c0dfca', gross: 12.9 }] };
  assert.equal(basePriceRow(p, units)?.status, 'fehlt');
  assert.equal(basePriceRow(p, units)?.proposal?.text, '25,80 € / 1 kg (Inhalt 0,5 kg)');
  assert.equal(basePriceRow({ ...p, purchaseUnit: 0.5, referenceUnit: 1, unitId: 'u-kg' }, units)?.status, 'ok');
  assert.equal(basePriceRow({ ...p, purchaseUnit: 0.25, referenceUnit: 1, unitId: 'u-kg' }, units)?.status, 'abweichend');
  assert.equal(basePriceRow({ ...p, name: 'Vase, 22 cm' }, units), null);
});

test('GPSR: Herstellerstatus, EU-Verantwortliche, Produkte, Lebensmittel', () => {
  const m = gpsrManufacturer({ id: 'm', name: 'Haus Holm', link: 'https://haus-holm.de' });
  assert.equal(m.complete, false); assert.ok(m.missing.includes('Postanschrift')); assert.equal(m.euResponsibleNeeded, 'prüfen'); assert.match(m.notes[0], /Nur Website/);
  const cn = gpsrManufacturer({ id: 'c', name: 'X', customFields: { lotse_gpsr_address: 'Road 1, 518000 Shenzhen, China', lotse_gpsr_country: 'CN', lotse_gpsr_contact: 'info@x.cn' } });
  assert.equal(cn.euResponsibleNeeded, true); assert.deepEqual(cn.missing, ['Verantwortliche Person in der EU']);
  const de = gpsrManufacturer({ id: 'd', name: 'D', translated: { customFields: { lotse_gpsr_company: 'D GmbH', lotse_gpsr_address: 'Hafenstr. 1, 20457 Hamburg', lotse_gpsr_country: 'de', lotse_gpsr_contact: 'info@d.de' } } });
  assert.equal(de.complete, true);
  const p = gpsrProduct({ id: 'p', name: 'Duftkerze Sand', productNumber: 'K1' }, ['Wohnaccessoires'], de);
  assert.deepEqual(p.missing, ['Hersteller', 'Kennnummer (EAN oder Hersteller-Nr.)', 'Sicherheitshinweise (prüfen)']);
  const food = gpsrProduct({ id: 'f', name: 'Espresso „Hafenblick“, ganze Bohne, 500 g', manufacturerId: 'm' });
  assert.equal(food.food, true); assert.deepEqual(food.missing, []);
  assert.deepEqual(gpsrProduct({ id: 'v', name: 'Vase', manufacturerId: 'd', ean: '4006381333931' }, [], de).missing, []);
});

test('GPSR-Werte: Validierung, Platzhalter werden abgewiesen', () => {
  assert.equal(validateGpsrValue('lotse_gpsr_country', 'de'), 'DE');
  assert.throws(() => validateGpsrValue('lotse_gpsr_country', 'Deutschland'), /ISO-Code/);
  assert.equal(validateGpsrValue('lotse_gpsr_contact', 'service@haus-holm.de'), 'service@haus-holm.de');
  assert.throws(() => validateGpsrValue('lotse_gpsr_contact', 'Telefon 040'), /E-Mail/);
  assert.throws(() => validateGpsrValue('lotse_gpsr_address', 'Musterstraße 1, 12345 Musterstadt'), /Platzhalter/);
  assert.throws(() => validateGpsrValue('lotse_gpsr_address', 'Hamburg'), /Postanschrift/);
  assert.equal(validateGpsrValue('lotse_gpsr_safety', null), null);
});

test('BFSG-Texte: Linktexte, Überschriften, Buttons, Bilder', () => {
  const types = (h: string, embedded = true) => htmlA11y(h, { embedded }).map(i => i.type);
  assert.deepEqual(types('<p>Infos <a href="/x">hier</a> und <a href="/y">Pflegehinweise lesen</a></p>'), ['link-vague']);
  assert.deepEqual(types('<a href="/x"><img src="a.jpg" alt="Vase Kiesel"></a><a href="/y"><i class="icon"></i></a>'), ['link-empty']);
  assert.deepEqual(types('<h1>Titel</h1><h2>A</h2><h4>B</h4>'), ['heading-h1', 'heading-skip']);
  assert.deepEqual(types('<h2>A</h2><h4>B</h4>', false), ['heading-skip']);
  assert.deepEqual(types('<button><svg></svg></button><button aria-label="Schließen"></button><img src="x.png"><img src="d.png" alt="">'), ['button-empty', 'img-alt']);
  assert.deepEqual(types(`<p>${'Wort '.repeat(320)}</p>`), ['no-headings']);
  assert.deepEqual(types('<h2>Pflege</h2><p><a href="/p">Mehr erfahren »</a></p>'), ['link-vague']);
});

test('BFSG-Kontrast: Verhältnis, Vorschlag, Theme-Verweise', () => {
  assert.equal(contrastRatio('#000', '#fff'), 21);
  assert.equal(contrastRatio('#777777', '#ffffff'), 4.48);
  const s = suggestColor('#777777', '#ffffff')!;
  assert.ok((contrastRatio(s, '#ffffff') ?? 0) >= 4.5);
  assert.equal(resolveTheme({ 'sw-color-buy-button': '$sw-color-brand-primary', 'sw-color-brand-primary': '#3E3A35' })['sw-color-buy-button'], '#3E3A35');
  const r = themeContrast({ 'sw-text-color': '#999', 'sw-background-color': '#fff', 'sw-color-buy-button': '#ffcc00', 'sw-color-buy-button-text': '#fff' });
  assert.deepEqual(r.map(x => [x.key, x.ok]), [['text', false], ['buy', false]]);
  assert.ok(r[0].suggestion);
});

test('Rechtstexte: Platzhalter, fehlende Zuordnung, Footer-Link', () => {
  const imp = LEGAL_PAGES[0];
  assert.deepEqual(evaluateLegalPage(imp, { cmsPageId: null, exists: false, text: '', linked: false, reachable: null }).problems, ['Keine Seite zugeordnet (Einstellungen › Stammdaten)']);
  assert.deepEqual(evaluateLegalPage(imp, { cmsPageId: 'p', exists: true, text: '<h2>Imprint</h2><p>Lorem ipsum dolor sit amet</p>', linked: false, reachable: true }).problems, ['Enthält Platzhaltertext (Lorem ipsum)', 'Nicht im Footer der Startseite verlinkt']);
  const links = footerLinks('<header><a href="/impressum">Impressum</a></header><footer><a href="/page/cms/abc">Datenschutz</a><a href="/agb/">AGB</a></footer>');
  assert.equal(links.length, 2);
  assert.equal(isLinked(imp, 'x', links), false);
  assert.equal(isLinked(LEGAL_PAGES[1], 'zzz', links), true);
  assert.equal(isLinked(LEGAL_PAGES[2], null, links), true);
});

test('GPSR-Änderungsset: Quelle Pflicht, Vorher/Nachher, Einrichtungshinweis', async () => {
  const ro = fakeReader({ 'product-manufacturer': [{ id: 'm1', name: 'Haus Holm', customFields: { lotse_gpsr_country: 'DE' } }], product: [{ id: 'p1', name: 'Kerze', productNumber: 'K1' }] });
  const cs = await buildGpsrChangeSet(ro, { title: 'GPSR', reason: 'r', manufacturers: [
    { manufacturerId: 'm1', source: 'Nutzerangabe im Chat', address: 'Hafenstraße 3, 20457 Hamburg, Deutschland', country: 'DE', contact: 'service@haus-holm.de' },
    { manufacturerId: 'm1', source: 'geschätzt', company: 'Haus Holm GmbH' },
  ], products: [{ productId: 'p1', source: 'Datenblatt.pdf', safety: 'Nie unbeaufsichtigt brennen lassen.' }, { productId: 'nope', source: 'x', safety: 'y' }] });
  assert.equal(cs.kind, 'gpsr');
  assert.deepEqual(cs.items.map(i => i.field), ['lotse_gpsr_address', 'lotse_gpsr_contact', 'lotse_gpsr_safety']);
  assert.match(cs.items[0].warn.join(), /Zusatzfelder „lotse_gpsr“/);
  assert.equal(cs.unchanged, 1);
  assert.match(cs.items[0].after, /Quelle: Nutzerangabe/);
  assert.equal(cs.skipped.length, 2);
  await assert.rejects(buildGpsrChangeSet(ro, { title: 't', reason: 'r', manufacturers: [{ manufacturerId: 'm1', source: 'Nutzer', address: 'Musterstraße 1, 12345 Musterstadt' }] }), /Nichts zu ändern/);
});

/** Fake-Schreiber: merkt sich Schreibzugriffe */
function fakeWriter(db: Record<string, SwEntity[]>) {
  const log: string[] = [];
  const sw = {
    ...fakeReader(db),
    search: async (entity: string, c: Record<string, unknown> = {}) => { let rows = db[entity] ?? []; if (Array.isArray(c.ids)) rows = rows.filter(r => (c.ids as string[]).includes(r.id)); return { data: rows, total: rows.length }; },
    get: async (entity: string, id: string) => (db[entity] ?? []).find(r => r.id === id) ?? null,
    create: async (entity: string, data: SwEntity) => { log.push(`create ${entity}`); (db[entity] ||= []).push(data); },
    update: async (entity: string, id: string, data: SwEntity) => { log.push(`update ${entity} ${id} ${JSON.stringify(data)}`); },
  };
  return { sw: sw as unknown as Shopware, log };
}

test('Grundpreis-Änderungsset: Einheit wird mit angelegt, Rückgängig exakt', async () => {
  const db: Record<string, SwEntity[]> = { unit: [], product: [{ id: 'p1', name: 'Espresso „Hafenblick“, ganze Bohne, 500 g', productNumber: 'HB-ESP-500', price: [{ currencyId: 'b7d2554b0ce847cd82f3ac9bd1c0dfca', gross: 14.9 }], purchaseUnit: null, referenceUnit: null, unitId: null }] };
  const cs = await buildBasePriceChangeSet(fakeReader(db), { title: 'Grundpreise', reason: 'PAngV', products: [{ productId: 'p1' }] });
  assert.deepEqual(cs.items.map(i => i.id), ['unit:kg', 'p1:baseprice']);
  assert.equal(cs.items[1].before, 'fehlt');
  assert.equal(cs.items[1].after, '29,80 € / 1 kg (Inhalt 0,5 kg)');
  const { sw, log } = fakeWriter(db);
  const res = await applyChangeSet(sw, cs, undefined, new Set(cs.items.map(i => i.id)));
  assert.ok(res.results.every(r => r.ok));
  assert.equal(log[0], 'create unit');
  const unitId = db.unit[0].id;
  assert.equal(log[1], `update product p1 ${JSON.stringify({ purchaseUnit: 0.5, referenceUnit: 1, unitId })}`);
  assert.deepEqual(res.undo, [{ op: 'delete', entity: 'unit', id: unitId }, { op: 'patch', entity: 'product', id: 'p1', data: { purchaseUnit: null, referenceUnit: null, unitId: null } }]);
  // ohne freigegebene Einheit scheitert das Produkt sauber
  db.unit = [];
  const res2 = await applyChangeSet(sw, cs, undefined, new Set(['p1:baseprice']));
  assert.match(res2.results[0].error ?? '', /Maßeinheit/);
});

test('GPSR-Applier: Zusatzfelder anlegen, je Datensatz ein Schreibzugriff, Rückgängig mit alten Werten', async () => {
  const db: Record<string, SwEntity[]> = { 'custom-field-set': [], 'product-manufacturer': [{ id: 'm1', name: 'Haus Holm', customFields: { lotse_gpsr_contact: 'alt@haus-holm.de', other: 1 } }] };
  const cs = await buildGpsrChangeSet(fakeReader(db), { title: 'GPSR', reason: 'r', manufacturers: [{ manufacturerId: 'm1', source: 'Nutzer', address: 'Hafenstraße 3, 20457 Hamburg', contact: 'service@haus-holm.de' }] });
  const { sw, log } = fakeWriter(db);
  const res = await applyChangeSet(sw, cs, undefined, new Set(cs.items.map(i => i.id)));
  assert.equal(log[0], 'create custom-field-set');
  assert.equal(log.length, 2);
  assert.equal(res.undo[0].op, 'delete');
  assert.deepEqual(res.undo[1], { op: 'patch', entity: 'product-manufacturer', id: 'm1', data: { customFields: { lotse_gpsr_address: null, lotse_gpsr_contact: 'alt@haus-holm.de' } } });
});

test('GPSR: Geräte und Zubehör sind keine Lebensmittel, auch in Kaffee-/Tee-Kategorien', () => {
  const g = (name: string, cats: string[] = []) => gpsrProduct({ id: 'x', name, manufacturerId: 'm' }, cats);
  for (const [name, cats] of [['Elektrische Kaffeemühle, 150 W', []], ['Espressokocher Edelstahl', []], ['Wasserkocher 1,7 l', ['Tee']], ['Kerze Bienenwachs', ['Honig & Wachs']]] as const) {
    const p = g(name, [...cats]);
    assert.equal(p.food, false, name); assert.equal(p.risky, true, name); assert.ok(p.missing.includes('Sicherheitshinweise (prüfen)'), name);
  }
  const mug = g('Becher', ['Kaffee & Zubehör']);
  assert.equal(mug.food, false); assert.ok(mug.missing.length > 0);
  assert.equal(g('Espresso „Hafenblick“, ganze Bohne, 500 g', ['Kaffee']).food, true);
  assert.equal(g('Grüner Tee Sencha, 100 g').food, true);
  assert.equal(g('Filterkaffee „Morgenwache“, Äthiopien, 500 g').food, true); assert.equal(g('Kaffeefilter Gr. 4, 100 Stück').food, false);
  // nur die Kategorie klingt nach Lebensmittel: ausgenommen, aber als „prüfen“ markiert; Sortennamen wie „Leuchtfeuer“ sind keine Gefahr
  assert.equal(g('Crema „Leuchtfeuer“, 1 kg', ['Kaffee']).food, true);
  const cat = g('Röstung „Nachtwache“, 500 g', ['Kaffee']);
  assert.equal(cat.food, true); assert.match(cat.notes.join(' '), /Laut Kategorie ein Lebensmittel \(prüfen\)/);
  assert.equal(g('Milchkännchen Steinzeug', ['Kaffee & Zubehör']).food, false);
  assert.equal(g('Becher', [], ).risky, false);
  assert.equal(gpsrProduct({ id: 'b', name: 'Becher', description: 'Spülmaschinenfest.' }).risky, false);
});

test('GPSR: Kennnummern an den Varianten zählen für das Hauptprodukt', () => {
  const parent = { id: 'p', name: 'Shirt', manufacturerId: 'm' };
  assert.deepEqual(gpsrProduct(parent, [], null, [{ ean: '4006381333931' }, { manufacturerNumber: 'S-2' }]).missing, []);
  const some = gpsrProduct(parent, [], null, [{ ean: '4006381333931' }, { ean: null }]);
  assert.ok(some.missing[0].startsWith('Kennnummer')); assert.match(some.notes.join(' '), /1 von 2 Varianten/);
  assert.ok(gpsrProduct(parent, [], null, [{}, {}]).missing[0].startsWith('Kennnummer'));
  assert.deepEqual(gpsrProduct({ ...parent, ean: '4006381333931' }, [], null, [{}]).missing, []);
});

test('Grundpreis: Geräte, Taschen, Elektronik und Teppiche sind „prüfen“; Packungen werden eingerechnet', () => {
  for (const n of ['Wasserkocher 1,7 l', 'Rucksack 20 l', 'Laptop 15,6 Zoll 1,5 kg', 'Teppich 2 m²', 'Kurzhantel 5 kg']) assert.equal(basePriceCandidate(n)?.confidence, 'prüfen', n);
  assert.equal(parseQuantity('Duschgel 250 ml, 3er-Pack')?.amount, 0.75);
  assert.equal(parseQuantity('Duschgel 250 ml x 3')?.amount, 0.75);
  assert.equal(parseQuantity('Riegel, 6 Stück à 50 g')?.amount, 0.3);
  assert.equal(parseQuantity('Tomaten 3 × 400 g, 2er-Pack')?.amount, 1.2);
  const c = basePriceCandidate('Duschgel Meeresbrise 250 ml, 3er-Pack')!;
  assert.equal(c.confidence, 'sicher'); assert.match(c.reasons[0], /Packungsanzahl 3/);
});

test('Grundpreis: Varianten mit Mengen-Ausprägung werden einzeln bewertet, sonst das Hauptprodukt', () => {
  const units = [{ id: 'u-kg', shortCode: 'kg', name: 'Kilogramm' }];
  const price = [{ currencyId: 'b7d2554b0ce847cd82f3ac9bd1c0dfca', gross: 10 }];
  const products = [
    { id: 'e', name: 'Espresso Hafenblick', productNumber: 'E', childCount: 2, price },
    { id: 'e1', parentId: 'e', productNumber: 'E.1', name: null, price: null, options: [{ name: '250 g' }] },
    { id: 'e2', parentId: 'e', productNumber: 'E.2', name: null, price: [{ currencyId: 'b7d2554b0ce847cd82f3ac9bd1c0dfca', gross: 18 }], options: [{ name: '500 g' }], unitId: 'u-kg', purchaseUnit: 0.5, referenceUnit: 1 },
    { id: 's', name: 'Kaffee Crema, 750 g', productNumber: 'S', childCount: 1, price },
    { id: 's1', parentId: 's', productNumber: 'S.1', options: [{ name: 'Rot' }] },
  ];
  const rows = basePriceRows(products, units);
  assert.deepEqual(rows.map(r => [r.id, r.status]), [['e1', 'fehlt'], ['e2', 'ok'], ['s', 'fehlt']]);
  assert.equal(rows[0].label, 'Espresso Hafenblick (250 g) (E.1)');
  assert.equal(rows[0].proposal?.text, '40,00 € / 1 kg (Inhalt 0,25 kg)');
  assert.equal(rows[0].parentId, 'e');
});

test('Grundpreis-Änderungsset: Variante erbt Name/Preis, Menge aus der Ausprägung', async () => {
  const db: Record<string, SwEntity[]> = { unit: [{ id: 'u-kg', shortCode: 'kg', name: 'Kilogramm' }], product: [
    { id: 'e', name: 'Espresso Hafenblick', productNumber: 'E', childCount: 1, price: [{ currencyId: 'b7d2554b0ce847cd82f3ac9bd1c0dfca', gross: 10 }] },
    { id: 'e1', parentId: 'e', productNumber: 'E.1', name: null, price: null, options: [{ name: '250 g' }], purchaseUnit: null, referenceUnit: null, unitId: null },
  ] };
  const cs = await buildBasePriceChangeSet(fakeReader(db), { title: 'G', reason: 'r', products: [{ productId: 'e1' }] });
  assert.equal(cs.items.length, 1);
  assert.equal(cs.items[0].label, 'Espresso Hafenblick (250 g) (E.1)');
  assert.equal(cs.items[0].after, '40,00 € / 1 kg (Inhalt 0,25 kg)');
  assert.deepEqual(cs.items[0].afterRaw, { purchaseUnit: 0.25, referenceUnit: 1, unitKey: 'kg', unitId: 'u-kg' });
});

test('Recht-Prüfungen: ein Katalog-Scan je Durchlauf mit Feldauswahl; GPSR, Grundpreis und Texte lesen daraus', async () => {
  const EUR = 'b7d2554b0ce847cd82f3ac9bd1c0dfca';
  const db: Record<string, SwEntity[]> = {
    product: [
      { id: 'e', productNumber: 'E', translated: { name: 'Espresso Hafenblick', description: '<p>Kaffee <a href="/x">hier</a></p>' }, childCount: 2, manufacturerId: 'm1', price: [{ currencyId: EUR, gross: 10 }], categories: [{ id: 'c1', translated: { name: 'Kaffee' } }] },
      { id: 'e1', parentId: 'e', productNumber: 'E.1', options: [{ translated: { name: '250 g' } }], ean: '4006381333931' },
      { id: 'e2', parentId: 'e', productNumber: 'E.2', options: [{ translated: { name: '500 g' } }] },
      { id: 'k', productNumber: 'K', translated: { name: 'Duftkerze Sand' }, manufacturerId: 'm1', price: [{ currencyId: EUR, gross: 12 }], categories: [{ id: 'c2', translated: { name: 'Wohnaccessoires' } }] },
    ],
    'product-manufacturer': [{ id: 'm1', name: 'Haus Holm' }], unit: [],
    category: [{ id: 'c2', translated: { name: 'Wohnaccessoires', description: '<p><a href="/y">mehr</a></p>' } }],
    'cms-page': [{ id: 'cms', translated: { name: 'Start' }, sections: [{ blocks: [{ slots: [{ id: 's1', type: 'text', config: { content: { source: 'static', value: '<h2>A</h2><h4>B</h4>' } } }] }] }] }],
  };
  const calls: { entity: string; c: Record<string, unknown> }[] = [];
  const ro: ShopReader = {
    base: 'http://shop',
    search: async (entity, c = {}) => { calls.push({ entity, c }); let rows = db[entity] ?? []; if (Array.isArray(c.ids)) rows = rows.filter(r => (c.ids as string[]).includes(r.id)); return { data: rows, total: rows.length }; },
    get: async () => null, salesChannels: async () => [], req: async () => null,
  };
  type F = { id: string; count: number; total: number; severity: string };
  const sw = perRun(ro), run = async (id: string, r: ShopReader = sw) => [await LEGAL_CHECKS.find(c => c.id === id)!.run(r) ?? []].flat() as F[];
  const [gpsr, grund, texte] = await Promise.all([run('recht.gpsr'), run('recht.grundpreis'), run('bfsg.texte')]);
  assert.equal(calls.filter(x => x.entity === 'product').length, 1, 'ein Produkt-Scan für drei Prüfungen');
  const scans = calls.filter(x => x.entity !== 'unit');
  assert.ok(scans.every(x => x.c.includes), `alle Scans mit Feldauswahl: ${scans.filter(x => !x.c.includes).map(x => x.entity).join(', ')}`);
  const by = Object.fromEntries([...gpsr, ...grund, ...texte].map(f => [f.id, f]));
  assert.deepEqual([by['recht.gpsr-hersteller'].count, by['recht.gpsr-produkte'].count, by['recht.gpsr-produkte'].total], [1, 1, 1], 'Kerze ohne Kennnummer; Espresso ist Lebensmittel');
  assert.deepEqual([by['recht.grundpreis'].count, by['recht.grundpreis'].severity, by['recht.grundpreis'].total], [2, 'hoch', 4], 'beide Mengen-Varianten ohne Grundpreis');
  assert.deepEqual([by['bfsg.linktexte'].count, by['bfsg.struktur'].count, by['bfsg.linktexte'].total], [2, 1, 3], 'Produkt + Kategorie mit „hier/mehr“, Layout mit Überschriftensprung');
  // dasselbe Lese-Client-Objekt liest nicht erneut, ein neues (nächster Durchlauf/Aufruf) schon
  await run('recht.grundpreis');
  assert.equal(calls.filter(x => x.entity === 'product').length, 1);
  await run('recht.grundpreis', perRun(ro));
  assert.equal(calls.filter(x => x.entity === 'product').length, 2);
});
