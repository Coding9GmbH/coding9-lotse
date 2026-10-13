import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CheckFinding } from '../../src/lib/protocol';
import { countText, findingsView, groupByArea, runHealth, summaryText } from '../../src/lib/shopcheck';

const f = (severity: CheckFinding['severity']): CheckFinding => ({ id: severity + Math.random(), area: 'SEO', title: 't', severity, count: 1, fixPrompt: 'x' });

test('summaryText: Zusammenfassung oben in der Karte', () => {
  assert.equal(summaryText([]), 'Alles im grünen Bereich');
  assert.equal(summaryText([f('hoch')]), '1 Punkt, wichtig');
  assert.equal(summaryText([f('mittel'), f('niedrig')]), '2 Punkte');
  assert.equal(summaryText([f('hoch'), f('hoch')]), '2 Punkte, alle wichtig');
  assert.equal(summaryText([f('hoch'), f('hoch'), f('hoch'), f('mittel'), f('mittel'), f('niedrig'), f('niedrig')]), '7 Punkte, 3 davon wichtig');
});

test('countText: „34 von 120 Produkten“, gedeckelt „mindestens“', () => {
  assert.equal(countText({ count: 34, total: 120, unit: 'Produkten' }), '34 von 120 Produkten');
  assert.equal(countText({ count: 2500, total: 12000, unit: 'Produkten', atLeast: true }), 'mindestens 2.500 von 12.000 Produkten');
  assert.equal(countText({ count: 3 }), '3 betroffen');
});

test('runHealth: ab der Hälfte gescheiterter Prüfungen unvollständig', () => {
  const e = (n: number) => Array.from({ length: n }, (_, i) => ({ check: `c${i}`, error: 'x' }));
  assert.equal(runHealth({ errors: [], checks: 16 }), 'ok');
  assert.equal(runHealth({ errors: e(2), checks: 16 }), 'teilweise');
  assert.equal(runHealth({ errors: e(8), checks: 16 }), 'unvollstaendig');
  assert.equal(runHealth({ errors: e(15), checks: 16 }), 'unvollstaendig');
  assert.equal(runHealth({ errors: e(1) }), 'unvollstaendig');
});

const at = (area: string, id: string) => ({ id, area });

test('groupByArea: Reihenfolge der Bereiche = erster (wichtigster) Befund', () => {
  const g = groupByArea([at('SEO', 'a'), at('Bilder', 'b'), at('SEO', 'c')]);
  assert.deepEqual(g.map(([a, l]) => [a, l.map(x => x.id)]), [['SEO', ['a', 'c']], ['Bilder', ['b']]]);
  assert.deepEqual(groupByArea([]), []);
});

test('findingsView: kompakt die wichtigsten, Reiter je Bereich, „Alle zeigen“', () => {
  const list = [at('SEO', 's1'), at('Bilder', 'b1'), at('SEO', 's2'), at('SEO', 's3'), at('Sprachen', 'l1'), at('SEO', 's4')];
  const v = findingsView(list, null, false, 3);
  assert.deepEqual(v.tabs, [{ area: 'SEO', count: 4 }, { area: 'Bilder', count: 1 }, { area: 'Sprachen', count: 1 }]);
  assert.deepEqual(v.shown.map(f => f.id), ['s1', 'b1', 's2'], 'Reihenfolge bleibt (schon nach Wichtigkeit sortiert)');
  assert.equal(v.total, 6); assert.equal(v.more, true); assert.equal(v.area, null);
  assert.equal(findingsView(list, null, true, 3).shown.length, 6, 'aufgeklappt: alle');

  const seo = findingsView(list, 'SEO', false, 3);
  assert.equal(seo.area, 'SEO');
  assert.deepEqual(seo.shown.map(f => f.id), ['s1', 's2', 's3']);
  assert.equal(seo.total, 4); assert.equal(seo.more, true);
  const img = findingsView(list, 'Bilder', false, 3);
  assert.deepEqual(img.shown.map(f => f.id), ['b1']); assert.equal(img.more, false);
  assert.equal(img.tabs.length, 3, 'Reiter zeigen immer alle Bereiche');
});

test('findingsView: verschwundener Bereich fällt auf „Alle“ zurück, ein einziger Bereich braucht keine Reiter', () => {
  const after = findingsView([at('SEO', 's1')], 'Bilder', false, 3);
  assert.equal(after.area, null); assert.deepEqual(after.shown.map(f => f.id), ['s1']);
  assert.deepEqual(after.tabs, [], 'nur ein Bereich: keine Reiter');
  const none = findingsView([], 'SEO', false, 3);
  assert.deepEqual(none, { tabs: [], area: null, total: 0, shown: [], more: false });
});
