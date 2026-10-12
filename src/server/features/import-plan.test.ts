import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Table } from './import-parse';
import type { PlanResult } from './import-plan';
import { commonName, isSelected, planImport, resolveCategories, toHtml, type CreatePlan, type ImportCatalog, type UpdatePlan, type VariantPlan } from './import-plan';
import type { ImportMapping } from './import-mapping';

process.env.AICB_DATA ??= fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-import-'));

const table = (headers: string[], rows: string[][]): Table => ({ format: 'csv', headers, rows, headerRow: 1, truncated: false });
let n = 0;
const genId = () => `id${String(++n).padStart(30, '0')}`;
const META = { title: 'Import', reason: 'Lieferant Nordlicht', fileName: 'nordlicht.csv' };

const vase = { id: 'pVase', productNumber: 'HH-VASE-22', name: 'Vase „Kiesel“', ean: '4000000000001', description: '<p>alt</p>', stock: 40, price: [{ currencyId: 'eur', gross: 49, net: 41.18, linked: true }], tax: { taxRate: 19 }, manufacturerId: 'mHH', properties: [], categories: [{ id: 'cWohn' }], media: [{ id: 'pm1' }] };
const plaid = { id: 'pPlaid', productNumber: 'HH-PLAID', name: 'Plaid', price: [{ currencyId: 'eur', gross: 89 }], tax: { taxRate: 19 }, configuratorSettings: [{ optionId: 'oSand' }], children: [{ id: 'k1', options: [{ id: 'oSand', group: { name: 'Farbe' } }] }] };
const cat = (): ImportCatalog => ({
  products: [vase, plaid],
  categories: [{ id: 'cWohn', path: ['Wohnaccessoires'] }, { id: 'cVasen', path: ['Wohnaccessoires', 'Vasen'] }, { id: 'cK1', path: ['Küche', 'Kissen'] }, { id: 'cK2', path: ['Wohnen', 'Kissen'] }],
  manufacturers: [{ id: 'mHH', name: 'Haus Holm' }],
  groups: [{ id: 'gFarbe', name: 'Farbe', options: [{ id: 'oSand', name: 'Sand' }] }],
  taxes: [{ id: 't19', taxRate: 19 }, { id: 't7', taxRate: 7 }],
  deliveryTimes: [{ id: 'd13', name: '1-3 days' }],
  currencyId: 'eur',
});
const M: ImportMapping = { productNumber: 'Nr', ean: 'EAN', name: 'Name', description: 'Text', priceNet: 'Netto', taxRate: 'MwSt', stock: 'Bestand', manufacturer: 'Marke', category: 'Kategorie', properties: [{ group: 'Farbe', column: 'Farbe' }] };
const H = ['Nr', 'EAN', 'Name', 'Text', 'Netto', 'MwSt', 'Bestand', 'Marke', 'Kategorie', 'Farbe'];

test('Neue Produkte: Entwurf, Netto → Brutto, Kategorie-Pfad, neuer Hersteller und neue Ausprägung', () => {
  const t = table(H, [
    ['NL-1', '', 'Kissen „Fjord“', 'Weich.\n\nZweiter Absatz', '20,00', '19 %', '', 'Nordlicht', 'Wohnaccessoires > Vasen', 'Sand, Taupe'],
    ['NL-2', '', 'Decke', '', '', '', '5', 'Haus Holm', 'Garten > Töpfe', ''],
    ['NL-1', '', 'doppelt', '', '1', '', '', '', '', ''],
  ]);
  const { cs, payload, stats } = planImport(t, M, cat(), {}, META, genId);
  const p = payload.plans[0] as CreatePlan;
  assert.equal(p.kind, 'create'); assert.equal(stats.create, 1);
  assert.deepEqual(p.product.price, [{ currencyId: 'eur', gross: 23.8, net: 20, linked: true }]);
  assert.equal(p.product.active, false); assert.equal(p.product.stock, 0); assert.equal(p.product.taxId, 't19');
  assert.equal(p.product.description, '<p>Weich.</p><p>Zweiter Absatz</p>');
  assert.deepEqual(p.product.categories, [{ id: 'cVasen' }]);
  const man = payload.creates.find(c => c.entity === 'product-manufacturer')!, taupe = payload.creates.find(c => c.entity === 'property-group-option')!;
  assert.equal(man.data.name, 'Nordlicht'); assert.equal(p.product.manufacturerId, man.id);
  assert.deepEqual(taupe.data, { groupId: 'gFarbe', name: 'Taupe', position: 2 });
  assert.deepEqual(p.product.properties, [{ id: 'oSand' }, { id: taupe.id }]);
  assert.deepEqual([...p.uses].sort(), [man.id, taupe.id].sort());
  assert.match(cs.items[0].after, /23,80 € · inaktiv \(Entwurf\) · Bestand 0 · Wohnaccessoires > Vasen · Nordlicht \(neu\)/);
  assert.deepEqual(cs.items.filter(i => i.entity === 'info').map(i => i.label), ['Hersteller „Nordlicht“', 'Ausprägung „Farbe: Taupe“']);
  assert.match(cs.skipped.map(s => s.reason).join('\n'), /Zeile 3 \(NL-2\): Preis fehlt[\s\S]*Zeile 4 \(NL-1\): doppelt/);
});

test('Vorhandene Produkte: nur geänderte zugeordnete Felder; Preise/Bestand nur mit Freigabe-Option', () => {
  const t = table(H, [['HH-VASE-22', '4000000000001', 'Vase „Kiesel“', 'neu', '50,00', '19', '0', 'Haus Holm', 'Wohnaccessoires', 'Sand']]);
  const a = planImport(t, M, cat(), {}, META, genId);
  const u = a.payload.plans[0] as UpdatePlan;
  assert.equal(u.kind, 'update'); assert.equal(u.id, 'pVase');
  assert.deepEqual(u.set, { description: '<p>neu</p>' }); assert.equal(u.price, undefined); assert.equal(u.stock, undefined);
  assert.deepEqual(u.addProperties, ['oSand']); assert.deepEqual(u.addCategories, []);
  assert.equal(a.cs.items[0].fieldLabel, 'Beschreibung, Eigenschaften');
  const b = planImport(t, M, cat(), { updatePrices: true, updateStock: true, updateFields: ['priceNet', 'stock'] }, META, genId);
  const v = b.payload.plans[0] as UpdatePlan;
  assert.deepEqual(v.set, {}); assert.deepEqual(v.price, { gross: 59.5 }); assert.equal(v.stock, 0);
  assert.deepEqual(b.cs.items[0].warn, ['Bestand auf 0']);
  assert.equal(b.cs.items[0].before, '49,00 € · 40'); assert.equal(b.cs.items[0].after, '59,50 € · 0');
  // Modus „nur neue“: vorhandenes Produkt wird übersprungen
  assert.throws(() => planImport(t, M, cat(), { mode: 'create' }, META, genId), /existiert bereits/);
});

test('Abgleich per EAN ohne Produktnummer; unbekannte Kategorie wird nie angelegt', () => {
  const m: ImportMapping = { ean: 'EAN', name: 'Name', category: 'Kategorie' };
  const t = table(['EAN', 'Name', 'Kategorie'], [['4000000000001', 'Vase „Kiesel“ groß', 'Kissen']]);
  const { payload, cs } = planImport(t, m, cat(), {}, META, genId);
  const u = payload.plans[0] as UpdatePlan;
  assert.equal(u.id, 'pVase'); assert.deepEqual(u.set, { name: 'Vase „Kiesel“ groß' });
  assert.match(cs.items[0].warn.join(' '), /Kategorie „Kissen \(mehrdeutig\)“ nicht gefunden/);
  assert.equal(cs.skipped.length, 0); // Produkt wird trotzdem aktualisiert: Warnung statt übersprungen
  assert.equal(payload.creates.length, 0);
});

test('Varianten: Hauptprodukt aus den Zeilen gebildet, gleicher Preis wird geerbt, abweichender Preis eigen', () => {
  const m: ImportMapping = { productNumber: 'Nr', parentNumber: 'Haupt', name: 'Name', priceGross: 'Preis', variantOptions: [{ group: 'Farbe', column: 'Farbe' }, { group: 'Größe', column: 'Größe' }] };
  const t = table(['Nr', 'Haupt', 'Name', 'Preis', 'Farbe', 'Größe'], [
    ['NL-SH.1', 'NL-SH', 'Shirt Nordlicht, Sand, M', '29,90', 'Sand', 'M'],
    ['NL-SH.2', 'NL-SH', 'Shirt Nordlicht, Sand, L', '29,90', 'Sand', 'L'],
    ['NL-SH.3', 'NL-SH', 'Shirt Nordlicht, Sand, XL', '32,90', 'Sand', 'XL'],
    ['NL-SH.4', 'NL-SH', 'Shirt ohne Größe', '29,90', '', ''],
  ]);
  const { payload, cs } = planImport(t, m, cat(), {}, META, genId);
  const p = payload.plans[0] as CreatePlan;
  assert.equal(p.product.productNumber, 'NL-SH'); assert.equal(p.product.name, 'Shirt Nordlicht');
  assert.equal((p.product.price as { gross: number }[])[0].gross, 29.9);
  const kids = p.product.children as Record<string, unknown>[];
  assert.deepEqual(kids.map(k => [k.productNumber, !!k.price]), [['NL-SH.1', false], ['NL-SH.2', false], ['NL-SH.3', true]]);
  assert.equal(p.childIds.length, 3);
  const groupGr = payload.creates.find(c => c.entity === 'property-group')!;
  assert.equal(groupGr.data.name, 'Größe');
  assert.equal(payload.creates.filter(c => c.entity === 'property-group-option').length, 3); // M, L, XL (Sand gibt es)
  assert.equal((p.product.configuratorSettings as unknown[]).length, 4);
  assert.match(cs.items[0].fieldLabel, /Neues Produkt mit 3 Varianten/);
  assert.ok(cs.items[0].warn.includes('Hauptprodukt aus den Variantenzeilen gebildet'));
  assert.match(cs.skipped.map(s => s.reason).join(' '), /NL-SH\.4.*keine Varianten-Ausprägung/);
});

test('Varianten: neue Varianten unter vorhandenem Hauptprodukt ergänzen den Konfigurator', () => {
  const m: ImportMapping = { productNumber: 'Nr', parentNumber: 'Haupt', priceGross: 'Preis', variantOptions: [{ group: 'Farbe', column: 'Farbe' }] };
  const c = cat(); c.products[1] = { ...plaid, configuratorSettings: [{ optionId: 'oSand' }], children: [] }; // Sand im Konfigurator, noch ohne Variante
  const t = table(['Nr', 'Haupt', 'Preis', 'Farbe'], [['HH-PLAID.7', 'HH-PLAID', '89', 'Sand'], ['HH-PLAID.8', 'HH-PLAID', '95', 'Nebel']]);
  const { payload } = planImport(t, m, c, {}, META, genId);
  const v = payload.plans[0] as VariantPlan;
  assert.equal(v.kind, 'variants'); assert.equal(v.id, 'pPlaid');
  assert.deepEqual(v.children.map(c => [c.productNumber, c.parentId, !!c.price]), [['HH-PLAID.7', 'pPlaid', false], ['HH-PLAID.8', 'pPlaid', true]]);
  assert.equal(v.configurator.length, 1); // nur „Nebel“ ist neu im Konfigurator
});

test('Große Dateien: Gruppen + Stichprobe, Auswahl je Gruppe; Abschnitte trennen keine Variantenfamilie', () => {
  const rows = Array.from({ length: 130 }, (_, i) => [`B-${i}`, '', `Becher ${i}`, '', i === 5 ? '0' : '10', '', '', '', 'Wohnaccessoires', '']);
  const { cs, payload, stats } = planImport(table(H, rows), M, cat(), {}, META, genId);
  assert.equal(cs.total, 130); assert.equal(stats.create, 130);
  assert.deepEqual(cs.items.map(i => [i.id, (i.afterRaw as { count: number }).count]), [['grp:create', 129], ['grp:create-warn', 1]]);
  assert.ok(cs.sample!.length >= 50 && cs.sample!.every(s => s.entity === 'info'));
  const sel = new Set(['grp:create-warn']);
  assert.equal(payload.plans.filter(p => isSelected(p, sel)).length, 1);
  const m: ImportMapping = { productNumber: 'Nr', parentNumber: 'Haupt', priceGross: 'Preis', name: 'Name', variantOptions: [{ group: 'Farbe', column: 'Farbe' }] };
  const fam = table(['Nr', 'Haupt', 'Preis', 'Name', 'Farbe'], [['A', '', '1', 'A', ''], ['F.1', 'F', '2', 'F', 'Rot'], ['F.2', 'F', '2', 'F', 'Blau'], ['C', '', '1', 'C', '']]);
  const part = planImport(fam, m, cat(), { limit: 2 }, META, genId);
  assert.equal(part.stats.rows, 3); assert.equal(part.stats.nextOffset, 3);
});

test('Hilfen: Kategorien, gemeinsamer Name, HTML bereinigen', () => {
  const cats = cat().categories;
  assert.deepEqual(resolveCategories('Vasen | Küche > Kissen', cats), { ids: ['cVasen', 'cK1'], missing: [], raw: [] });
  assert.deepEqual(resolveCategories('Garten/Töpfe', cats, { 'Garten/Töpfe': 'cWohn' }), { ids: ['cWohn'], missing: [], raw: [] });
  assert.equal(commonName(['Plaid Düne, Sand', 'Plaid Düne, Grau']), 'Plaid Düne');
  assert.equal(toHtml('<p onclick="x()">Hallo<script>alert(1)</script> <a href="javascript:evil()">x</a></p>'), '<p>Hallo <a href="#">x</a></p>');
  assert.equal(toHtml('a < b'), '<p>a &lt; b</p>');
  // getarnte javascript:-Links (Entities, Steuerzeichen, Groß-/Kleinschreibung), data:/vbscript: und Formulare/Meta
  for (const h of ['&#106;avascript:fetch(1)', 'java&#9;script:alert(1)', 'javascript&#58;alert(1)', ' &#x6A;avascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html;base64,AA', 'vbscript:msgbox'])
    assert.equal(toHtml(`<p>Infos <a href="${h}">hier</a></p>`), '<p>Infos <a href="#">hier</a></p>', h);
  assert.equal(toHtml("<a href='javascript:x()'>a</a><img src=javascript:x()>"), '<a href="#">a</a><img src="#">');
  assert.equal(toHtml('<form action="https://evil"><input name="pw"></form><meta http-equiv="refresh" content="0;url=https://evil"><base href="https://evil/"><link rel="stylesheet" href="x.css"><p>t</p>'), '<input name="pw"><p>t</p>');
  const okHtml = '<a href="https://shop.de/x?a=1&amp;b=2">ok</a> <a href="/pflege">rel</a> <a href="pflege.html">datei</a> <a href="#top">anker</a> <a href="mailto:a@b.de">m</a> <a href="tel:+4940">t</a> <img src="https://cdn/x.jpg" alt="x">';
  assert.equal(toHtml(okHtml), okHtml);
});

test('Executor: legt an, aktualisiert, sammelt exaktes Rückgängig (Fake-Shop)', async () => {
  const { applyImport, takeReport } = await import('./import-apply');
  const t = table(H, [
    ['NL-9', '', 'Kissen', '', '10', '7', '3', 'Nordlicht', 'Wohnaccessoires', ''],
    ['HH-VASE-22', '', '', 'neu', '', '', '', '', '', 'Sand'],
  ]);
  const { cs, payload } = planImport(t, M, cat(), {}, META, genId);
  const calls: string[] = [];
  const sw = {
    create: async (e: string, d: Record<string, unknown>) => { calls.push(`create ${e} ${d.id}`); },
    update: async (e: string, id: string, d: Record<string, unknown>) => { calls.push(`update ${e} ${id} ${Object.keys(d).sort().join(',')}`); },
    get: async () => ({ ...vase, translated: {}, coverId: 'pm1' }),
    search: async () => ({ data: [] }),
    salesChannels: async () => [{ id: 'sc1', domains: [{ url: 'http://x' }] }],
    req: async () => null,
  } as unknown as Parameters<typeof applyImport>[0];
  const progress: number[] = [];
  const res = await applyImport(sw, cs, payload, new Set(cs.items.map(i => i.id)), { progress: d => progress.push(d) });
  assert.deepEqual(res.results.map(r => r.ok), [true, true]);
  assert.deepEqual(progress, [0, 1, 2]);
  const created = (payload.plans[0] as CreatePlan).id, man = payload.creates[0].id;
  assert.deepEqual(calls.slice(0, 2), [`create product-manufacturer ${man}`, `create product ${created}`]);
  assert.ok(calls.includes('update product pVase description,properties'));
  // Rückgängig (rückwärts ausgeführt): Felder zurück, Zuordnung lösen, Produkt löschen, Hersteller zuletzt
  assert.deepEqual(res.undo.map(u => `${u.op} ${u.entity} ${u.id}${u.path ? ` ${u.path}` : ''}`), [
    `delete product-manufacturer ${man}`, `delete product ${created}`,
    'req product pVase /product/pVase/properties/oSand', 'patch product pVase',
  ]);
  assert.deepEqual(res.undo[3].data, { description: '<p>alt</p>' });
  const rep = takeReport(cs.id)!;
  assert.deepEqual(rep.created.map(c => c.number), ['NL-9']); assert.deepEqual(rep.updated.map(c => c.number), ['HH-VASE-22']);
  assert.equal(takeReport(cs.id), null);
});

/** Jede Datenzeile taucht genau einmal auf: neu, aktualisiert, als Variante, unverändert oder übersprungen */
function balance({ cs, payload, stats }: PlanResult) {
  const planned = payload.plans.reduce((n, p) => n + (p.kind === 'create' ? (p.synthetic ? 0 : 1) + p.childIds.length : p.kind === 'update' ? 1 : p.children.length), 0);
  const lines = cs.skipped.map(x => x.reason.match(/^Zeile (\d+)/)?.[1]);
  assert.equal(new Set(lines).size, lines.length, `doppelt übersprungen: ${lines.join(',')}`);
  assert.equal(stats.rows, planned + stats.unchanged + stats.skipped);
  assert.equal(stats.rows, stats.create - stats.synthetic + stats.update + stats.variantRows + stats.unchanged + stats.skipped);
}

test('Varianten: scheitert das Hauptprodukt, stehen alle Variantenzeilen mit Grund in skipped', () => {
  const m: ImportMapping = { productNumber: 'Nr', parentNumber: 'Haupt', name: 'Name', priceGross: 'Preis', taxRate: 'MwSt', variantOptions: [{ group: 'Farbe', column: 'Farbe' }] };
  const h = ['Nr', 'Haupt', 'Name', 'Preis', 'MwSt', 'Farbe'];
  // Hauptprodukt mit eigener Zeile ohne Preis
  const a = planImport(table(h, [['P', '', 'Plaid', '', '', ''], ['P.1', 'P', 'Plaid Sand', '10', '', 'Sand'], ['P.2', 'P', 'Plaid Rot', '10', '', 'Rot'], ['X', '', 'Becher', '5', '', '']]), m, cat(), {}, META, genId);
  assert.deepEqual(a.cs.skipped.map(x => x.reason), ['Zeile 2 (P): Preis fehlt (für neue Produkte Pflicht)', 'Zeile 3 (P.1): Hauptprodukt P konnte nicht angelegt werden: Preis fehlt (für neue Produkte Pflicht)', 'Zeile 4 (P.2): Hauptprodukt P konnte nicht angelegt werden: Preis fehlt (für neue Produkte Pflicht)']);
  assert.equal(a.stats.create, 1); balance(a);
  // aus den Varianten gebildetes Hauptprodukt mit unbekanntem Steuersatz
  const b = planImport(table(h, [['Q.1', 'Q', 'Kissen Sand', '10', '5', 'Sand'], ['Q.2', 'Q', 'Kissen Rot', '10', '5', 'Rot'], ['X', '', 'Becher', '5', '', '']]), m, cat(), {}, META, genId);
  assert.equal(b.cs.skipped.length, 2); assert.match(b.cs.skipped[1].reason, /^Zeile 3 \(Q\.2\): Hauptprodukt Q konnte nicht angelegt werden: Steuersatz 5 %/); balance(b);
  // alle Varianten ungültig: jede Zeile genau einmal mit eigenem Grund
  const c = planImport(table(h, [['R', '', 'Decke', '10', '', ''], ['R.1', 'R', 'Decke', '10', '', ''], ['X', '', 'Becher', '5', '', '']]), m, cat(), {}, META, genId);
  assert.deepEqual(c.cs.skipped.map(x => x.reason), ['Zeile 2 (R): keine gültige Variante', 'Zeile 3 (R.1): keine Varianten-Ausprägung (z. B. Farbe/Größe) angegeben']); balance(c);
  // vorhandenes Hauptprodukt, alle neuen Varianten ungültig: erste Zeile nicht doppelt
  const d = planImport(table(h, [['HH-PLAID.7', 'HH-PLAID', '', '89', '', ''], ['HH-PLAID.8', 'HH-PLAID', '', '89', '', ''], ['X', '', 'Becher', '5', '', '']]), m, cat(), {}, META, genId);
  assert.equal(d.cs.skipped.length, 2); balance(d);
  // Hauptprodukt-Zeile ist selbst eine Variante
  const e = planImport(table(h, [['S.1', 'S', 'Shirt', '10', '', 'Sand'], ['S.1.a', 'S.1', 'Shirt', '10', '', 'Rot']]), m, cat(), {}, META, genId);
  assert.match(e.cs.skipped.map(x => x.reason).join(' '), /Zeile 3 \(S\.1\.a\): Hauptprodukt S\.1 ist selbst eine Variante/); balance(e);
});

test('Varianten: doppelte Ausprägungs-Kombination (in der Datei oder schon im Shop) wird übersprungen', () => {
  const m: ImportMapping = { productNumber: 'Nr', parentNumber: 'Haupt', name: 'Name', priceGross: 'Preis', variantOptions: [{ group: 'Farbe', column: 'Farbe' }] };
  const h = ['Nr', 'Haupt', 'Name', 'Preis', 'Farbe'];
  const a = planImport(table(h, [['HH-PLAID.7', 'HH-PLAID', '', '89', 'Sand'], ['HH-PLAID.8', 'HH-PLAID', '', '89', 'Nebel'], ['HH-PLAID.9', 'HH-PLAID', '', '89', 'nebel']]), m, cat(), {}, META, genId);
  assert.deepEqual((a.payload.plans[0] as VariantPlan).children.map(c => c.productNumber), ['HH-PLAID.8']);
  assert.match(a.cs.skipped.map(x => x.reason).join('\n'), /HH-PLAID\.7\): Variante Farbe: Sand gibt es schon[\s\S]*HH-PLAID\.9\): Variante Farbe: nebel gibt es schon/);
  balance(a);
});

test('Variante ohne Hauptartikel-Spalte erbt den Steuersatz des Hauptprodukts', () => {
  const kid = { id: 'k7', parentId: 'pBuch', productNumber: 'BU.1', price: null, tax: null };
  const buch = { id: 'pBuch', productNumber: 'BU', name: 'Buch', price: [{ currencyId: 'eur', gross: 10.7 }], tax: { taxRate: 7 } };
  const c = { ...cat(), products: [kid, buch] };
  const r = planImport(table(['Nr', 'Netto'], [['BU.1', '20']]), { productNumber: 'Nr', priceNet: 'Netto' }, c, { updatePrices: true }, META, genId);
  const u = r.payload.plans[0] as UpdatePlan;
  assert.equal(u.taxRate, 7); assert.deepEqual(u.price, { gross: 21.4 });
  assert.match(r.cs.items[0].before, /10,70 € \(geerbt\)/);
});

test('Große Dateien: neue Hersteller/Ausprägungen als eine Sammelzeile', () => {
  const rows = Array.from({ length: 120 }, (_, i) => [`G-${i}`, '', `Glas ${i}`, '', '10', '', '', `Marke ${i}`, '', `Ton ${i}`]);
  const r = planImport(table(H, rows), M, cat(), {}, META, genId);
  const infos = r.cs.items.filter(i => i.entity === 'info');
  assert.equal(infos.length, 1); assert.match(infos[0].label, /^120 Hersteller, 120 Ausprägungen neu$/); assert.match(infos[0].after, /^z. B. „Marke 0“, „Farbe: Ton 0“, /);
  balance(r);
});
