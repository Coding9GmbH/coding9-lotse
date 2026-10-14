import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinTitle, conditionsText, evaluate, fieldValue, parseCheckInput, slugify, type NeutralProduct } from '../../src/lib/custom-checks';

const p = (o: Partial<NeutralProduct> & { id: string }): NeutralProduct => ({
  label: `P ${o.id}`, name: `P ${o.id}`, description: '', metaTitle: '', metaDescription: '', price: 10, listPrice: null, stock: 5, hasImage: true, ...o,
});

test('fields: words/characters without HTML, unknown values stay null', () => {
  const x = p({ id: '1', description: '<p>Ein <b>kurzer</b> Text&nbsp;hier</p><script>x()</script>', stock: null });
  assert.equal(fieldValue(x, 'descriptionWords'), 4);
  assert.equal(fieldValue(x, 'descriptionChars'), 'Ein kurzer Text hier'.length);
  assert.equal(fieldValue(x, 'stock'), null);
  assert.equal(fieldValue(p({ id: '2' }), 'descriptionWords'), 0);
});

test('evaluation: and/or, unknown values never match, samples show the value', () => {
  const rows = [
    p({ id: '1', description: 'x'.repeat(100) }), p({ id: '2', description: 'x'.repeat(2500) }), p({ id: '3', description: 'x'.repeat(10), stock: null, hasImage: false }), p({ id: '4', description: '', stock: 2 }),
  ];
  const short = evaluate(rows, { match: 'all', conditions: [{ field: 'descriptionChars', op: 'lt', value: 2000 }] });
  assert.equal(short.count, 3);
  assert.match(short.sample[0].label, /Zeichen der Beschreibung \(ohne HTML\) 100/);
  assert.equal(evaluate(rows, { match: 'all', conditions: [{ field: 'descriptionChars', op: 'lt', value: 2000 }, { field: 'stock', op: 'lt', value: 5 }] }).count, 1, 'unknown stock (3) does not match');
  assert.equal(evaluate(rows, { match: 'any', conditions: [{ field: 'stock', op: 'lt', value: 5 }, { field: 'hasImage', op: 'eq', value: false }] }).count, 2);
  assert.equal(evaluate(rows, { match: 'all', conditions: [] }).count, 0, 'no condition, no matches');
  assert.equal(evaluate([p({ id: '9', metaDescription: '' })], { match: 'all', conditions: [{ field: 'metaDescriptionChars', op: 'eq', value: 0 }] }).count, 1);
});

test('input validation: clear errors, cleanup, defaults', () => {
  const ok = parseCheckInput({ title: '  Beschreibung  zu kurz ', conditions: [{ field: 'descriptionChars', op: 'lt', value: '2000' }] });
  assert.deepEqual(ok, { title: 'Beschreibung zu kurz', severity: 'mittel', area: 'Eigene Prüfungen', match: 'all', conditions: [{ field: 'descriptionChars', op: 'lt', value: 2000 }] });
  assert.throws(() => parseCheckInput({ title: '', conditions: [] }), /Titel fehlt/);
  assert.throws(() => parseCheckInput({ title: 'x' }), /Mindestens eine Bedingung/);
  assert.throws(() => parseCheckInput({ title: 'x', conditions: [{ field: 'farbe', op: 'eq', value: 1 }] }), /unbekanntes Feld/);
  assert.throws(() => parseCheckInput({ title: 'x', conditions: [{ field: 'price', op: 'ähnlich', value: 1 }] }), /unbekannter Vergleich/);
  assert.throws(() => parseCheckInput({ title: 'x', conditions: [{ field: 'price', op: 'lt', value: 'viel' }] }), /braucht eine Zahl/);
  assert.throws(() => parseCheckInput({ title: 'x', conditions: [{ field: 'hasImage', op: 'lt', value: true }] }), /nur eq oder neq/);
  assert.throws(() => parseCheckInput({ title: 'x', conditions: [{ field: 'hasImage', op: 'eq', value: 1 }] }), /true oder false/);
  assert.throws(() => parseCheckInput({ title: 'x'.repeat(81), conditions: [{ field: 'price', op: 'lt', value: 1 }] }), /zu lang/);
});

test('texts: rule in words, slug, titles of built-in checks', () => {
  assert.equal(conditionsText({ match: 'any', conditions: [{ field: 'stock', op: 'lt', value: 5 }, { field: 'hasImage', op: 'eq', value: false }] }), 'Bestand < 5 ODER Hat ein Bild: nein');
  assert.equal(slugify('Beschreibung kürzer als 2000 Zeichen!'), 'beschreibung-kuerzer-als-2000-zeichen');
  assert.equal(builtinTitle('shopify.meta-title-long'), 'Zu lange Meta-Titles');
  assert.equal(builtinTitle('shopcheck.price-zero'), 'Preis ist 0');
  assert.equal(builtinTitle('recht.gpsr'), 'GPSR-Pflichtangaben');
  assert.equal(builtinTitle('xyz.unbekannt'), 'xyz.unbekannt');
});

test('fields: pathological description HTML (unclosed <script>) does not freeze', () => {
  const t = Date.now(); fieldValue({ description: '<script'.repeat(100_000) } as NeutralProduct, 'descriptionWords'); const d = Date.now() - t;
  assert.ok(d < 1000, `${d} ms`);
});
