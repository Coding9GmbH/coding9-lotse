import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CheckFinding } from '../../src/lib/protocol';
import { countText, runHealth, summaryText } from '../../src/lib/shopcheck';

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
