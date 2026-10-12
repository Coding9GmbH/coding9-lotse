import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByDay } from '../../src/lib/format';

test('groupByDay: Heute, Gestern, Letzte 7 Tage, Älter – leere Gruppen entfallen', () => {
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
