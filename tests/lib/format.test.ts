import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, groupByDay, sampleSummary, stripHtml } from '../../src/lib/format';

test('groupByDay: today, yesterday, last 7 days, older; empty groups are dropped', () => {
  const now = new Date(2026, 9, 9, 15, 0);
  const at = (d: number, h = 12) => ({ id: `${d}-${h}`, updatedAt: new Date(2026, 9, 9 - d, h).toISOString() });
  const g = groupByDay([at(0, 14), at(0, 1), at(1), at(5), at(30), { id: 'kaputt', updatedAt: 'x' }], now);
  assert.deepEqual(g.map(x => [x.label, x.items.map(i => i.id)]), [
    ['Heute', ['0-14', '0-1']],
    ['Gestern', ['1-12']],
    ['Letzte 7 Tage', ['5-12']],
    ['Älter', ['30-12', 'kaputt']],
  ]);
  assert.deepEqual(groupByDay([], now), []);
});

test('sampleSummary: approval applies to the groups, the list is only a sample', () => {
  const text = sampleSummary(50, 10_000);
  assert.equal(text, 'Stichprobe: 50 von 10.000. Die Freigabe gilt für die angehakten Gruppen, nicht für jede einzelne Zeile.');
});

test('esc: escapes &, <, >, " and apostrophes; null/undefined become empty', () => {
  assert.equal(esc(`<a href="x">Tom's & Jerry</a>`), '&lt;a href=&quot;x&quot;&gt;Tom&#39;s &amp; Jerry&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
});

test('stripHtml: tags become spaces, whitespace collapses, no entity decoding', () => {
  assert.equal(stripHtml('<p>Hallo<br>Welt</p>\n  <b>fett</b> &amp;'), 'Hallo Welt fett &amp;');
  assert.equal(stripHtml(null), '');
});
