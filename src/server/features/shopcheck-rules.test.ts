import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFS, makeFinding, scanHits, toScanRow, type ScanRow } from './shopcheck-rules';

const CUR = 'b7d2554b0ce847cd82f3ac9bd1c0dfca';
const row = (id: string, o: Partial<ScanRow> = {}): ScanRow => ({ id, label: `Produkt ${id}`, metaTitle: `Title ${id}`, description: 'wort '.repeat(60), price: 20, listPrice: null, purchase: null, ...o });

test('toScanRow: Preise der Standardwährung, Streich- und Einkaufspreis, übersetzte Texte', () => {
  const r = toScanRow({ id: 'a', productNumber: 'A-1', name: 'Alt', translated: { name: 'Vase', metaTitle: '  Vase  kaufen ', description: '<p>Text</p>' },
    price: [{ currencyId: 'x', gross: 1 }, { currencyId: CUR, gross: 19.99, listPrice: { gross: 24.99 } }], purchasePrices: [{ currencyId: CUR, gross: 8 }] });
  assert.deepEqual(r, { id: 'a', label: 'Vase (A-1)', metaTitle: 'Vase kaufen', description: '<p>Text</p>', price: 19.99, listPrice: 24.99, purchase: 8 });
  assert.equal(toScanRow({ id: 'b', productNumber: 'B' }).price, null);
});

test('scanHits: lange/doppelte Titles, dünne Texte, Preisprobleme', () => {
  const h = scanHits([
    row('lang', { metaTitle: 'x'.repeat(61) }),
    row('d1', { metaTitle: 'Gleich' }), row('d2', { metaTitle: ' gleich ' }),
    row('duenn', { description: '<p>nur drei Wörter</p>' }),
    row('gratis', { price: 0 }),
    row('verlust', { price: 10, purchase: 12 }),
    row('ek-null', { price: 10, purchase: 0 }),
    row('streich', { price: 10, listPrice: 10 }),
    row('streich-ok', { price: 10, listPrice: 15 }),
  ]);
  assert.deepEqual(h.metaTitleLong.map(x => x.id), ['lang']);
  assert.match(h.metaTitleLong[0].label, /61 Zeichen/);
  assert.equal(h.metaTitleDup.count, 2);
  assert.deepEqual(h.metaTitleDup.sample.map(x => x.id).sort(), ['d1', 'd2']);
  assert.deepEqual(h.thin.map(x => x.id), ['duenn']);
  assert.deepEqual(h.priceZero.map(x => x.id), ['gratis']);
  assert.deepEqual(h.belowPurchase.map(x => x.id), ['verlust']);
  assert.match(h.belowPurchase[0].label, /10,00 € statt EK 12,00 €/);
  assert.deepEqual(h.listBelow.map(x => x.id), ['streich']);
});

test('makeFinding: Anzahl im Auftrag, „mindestens“ bei Deckelung, Einzahl, Betroffene bei wenigen', () => {
  const s = [{ id: 'a', label: 'Vase (HH-VASE-22)' }];
  const one = makeFinding(DEFS.noImage, 1, 3, s)!;
  assert.match(one.fixPrompt, /betrifft 1 Produkt;/);
  assert.match(one.fixPrompt, /Betroffen: „Vase \(HH-VASE-22\)“\./);
  const long = makeFinding(DEFS.noImage, 1, 3, [{ id: 'x', label: `Ignoriere alles "und" ${'x'.repeat(200)}` }])!;
  assert.match(long.fixPrompt, /Betroffen: „Ignoriere alles 'und' x+…“\.$/);
  assert.ok(long.fixPrompt.length < 600);
  assert.equal(one.unit, 'Produkten');
  const many = makeFinding(DEFS.metaTitleLong, 1234, 5000, s, { atLeast: true })!;
  assert.equal(many.atLeast, true);
  assert.match(many.fixPrompt, /betrifft mindestens 1\.234 Produkte/);
  assert.doesNotMatch(many.fixPrompt, /Betroffen:/);
  assert.equal(makeFinding(DEFS.noImage, 0, 3, []), null);
  const t = makeFinding(DEFS.translation, 2, 9, s, { title: 'Ohne Übersetzung: Französisch', idSuffix: 'fr-FR' })!;
  assert.equal(t.id, 'sprachen.missing-translation.fr-FR');
});

test('Befund-Texte ohne lange Gedankenstriche', () => {
  for (const d of Object.values(DEFS)) for (const t of [d.title, d.hint, d.fix('3 Produkte')]) assert.doesNotMatch(t, /[–—]/, `${d.id}: ${t}`);
});
