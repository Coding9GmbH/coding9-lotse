import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { NeutralProduct } from '../../src/lib/custom-checks';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-custom-checks-'));
const cc = await import('../../src/server/custom-checks');
const { runChecks } = await import('../../src/server/shopcheck-run');
const { registerCheck } = await import('../../src/server/checks');

const row = (id: string, o: Partial<NeutralProduct> = {}): NeutralProduct => ({ id, label: `Produkt ${id}`, name: `Produkt ${id}`, description: 'kurz', metaTitle: 't', metaDescription: '', price: 10, listPrice: null, stock: 3, hasImage: true, ...o });
const scan = { rows: [row('1'), row('2', { description: 'x'.repeat(3000), stock: 10 }), row('3', { stock: 0 })], total: 3, capped: false };

test('Eigene Prüfungen: anlegen, ändern, löschen, Grenzen', () => {
  const a = cc.addCustom({ title: 'Beschreibung unter 2000 Zeichen', severity: 'hoch', conditions: [{ field: 'descriptionChars', op: 'lt', value: 2000 }] });
  assert.equal(a.id, 'custom.beschreibung-unter-2000-zeichen');
  assert.equal(cc.addCustom({ title: 'Beschreibung unter 2000 Zeichen', conditions: [{ field: 'stock', op: 'lt', value: 1 }] }).id, 'custom.beschreibung-unter-2000-zeichen-2');
  const u = cc.updateCustom(a.id, { title: 'Zu kurz', conditions: [{ field: 'descriptionChars', op: 'lt', value: 1500 }] });
  assert.equal(u.title, 'Zu kurz'); assert.equal(u.id, a.id); assert.equal(u.severity, 'hoch', 'nicht genannte Felder bleiben');
  assert.throws(() => cc.updateCustom('custom.gibt-es-nicht', { title: 'x' }), /nicht gefunden/);
  assert.ok(cc.removeCustom(a.id)); assert.equal(cc.removeCustom(a.id), false);
  for (const c of cc.listCustom()) cc.removeCustom(c.id);
  for (let i = 0; i < 20; i++) cc.addCustom({ title: `Prüfung ${i}`, conditions: [{ field: 'price', op: 'lt', value: i }] });
  assert.throws(() => cc.addCustom({ title: 'zu viel', conditions: [{ field: 'price', op: 'lt', value: 1 }] }), /Höchstens 20/);
  for (const c of cc.listCustom()) cc.removeCustom(c.id);
});

test('Befund einer eigenen Prüfung: Anzahl, „mindestens“ bei gedecktem Scan, nichts bei null Treffern', () => {
  const c = cc.addCustom({ title: 'Wenig Bestand', severity: 'niedrig', area: 'Daten', conditions: [{ field: 'stock', op: 'lt', value: 5 }] });
  const f = cc.customFinding(c, scan)!;
  assert.equal(f.id, c.id); assert.equal(f.count, 2); assert.equal(f.total, 3); assert.equal(f.severity, 'niedrig'); assert.equal(f.area, 'Daten');
  assert.match(f.fixPrompt, /Bestand < 5/); assert.match(f.fixPrompt, /list_products, get_product/);
  assert.equal(cc.customFinding(c, { ...scan, capped: true })!.atLeast, true);
  assert.equal(cc.customFinding(c, { rows: [row('9', { stock: 20 })], total: 1, capped: false }), null);
  cc.removeCustom(c.id);
});

test('Durchlauf: eigene Prüfungen laufen mit, ausgeschaltete nicht; Liste zeigt Zustand', async () => {
  registerCheck({ id: 'shopcheck.price-zero', area: 'Preise', platforms: 'all', run: async () => null });
  const c = cc.addCustom({ title: 'Ohne Bild', conditions: [{ field: 'hasImage', op: 'eq', value: false }] });
  const lowStock = cc.addCustom({ title: 'Wenig Bestand', conditions: [{ field: 'stock', op: 'lt', value: 5 }] });
  let scans = 0;
  const checks = cc.customShopChecks(async () => { scans++; return { ...scan, rows: [...scan.rows, row('4', { hasImage: false })], total: 4 }; });
  const run = await runChecks({ base: 'x' } as never, checks, { perRun: false });
  assert.deepEqual(run.errors, []);
  assert.equal(run.findings.find(f => f.id === c.id)?.count, 1);
  assert.equal(run.findings.find(f => f.id === lowStock.id)?.count, 3, 'Produkte 1, 3 und 4 haben weniger als 5 im Bestand');
  assert.equal(scans, 2, 'jede Prüfung fragt den Scan an; die Plattform liefert ihn je Durchlauf memoisiert');

  const list = cc.checkList('shopware');
  assert.ok(list.some(x => x.id === 'shopcheck.price-zero' && x.title === 'Preis ist 0' && x.enabled && !x.custom));
  assert.ok(list.some(x => x.id === c.id && x.custom && x.rule === 'Hat ein Bild: nein'));
  cc.setCheckEnabled('shopcheck.price-zero', false); cc.setCheckEnabled(c.id, false);
  assert.deepEqual([...cc.disabledChecks()].sort(), ['shopcheck.price-zero', c.id].sort());
  assert.equal(cc.checkList('shopware').find(x => x.id === c.id)!.enabled, false);
  cc.removeCustom(c.id);
  assert.ok(!cc.disabledChecks().has(c.id), 'Löschen räumt die Aus-Liste auf');
  cc.setCheckEnabled('shopcheck.price-zero', true);
  cc.removeCustom(lowStock.id);
});
