import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UndoOp } from '@/lib/protocol';
import { partialTicker, trackedUndo, type ApplyPartial } from '../../src/server/changes';

// Progress helpers for executors without applyEach: each tick carries the results and undo steps so far (crash safety, B1)
const op = (id: string): UndoOp => ({ op: 'patch', entity: 'product', id, data: {} });

test('partialTicker: done = number of results, partial is the same (growing) object', () => {
  const seen: [number, number, ApplyPartial | undefined][] = [];
  const results: ApplyPartial['results'] = [], undo: UndoOp[] = [], tick = partialTicker({ progress: (d, t, p) => seen.push([d, t, p]) }, 2, { results, undo });
  undo.push(op('a')); results.push({ itemId: 'i1', ok: true }); tick();
  results.push({ itemId: 'i2', ok: false, error: 'x' }); tick();
  assert.deepEqual(seen.map(([d, t]) => [d, t]), [[1, 2], [2, 2]]);
  assert.equal(seen[1][2]?.undo.length, 1); assert.equal(seen[1][2]?.results.length, 2);
  partialTicker(undefined, 1, { results, undo })(); // without ctx: nothing happens
});

test('trackedUndo: every push reports immediately; without ctx a plain array', () => {
  const seen: ApplyPartial[] = [], results: ApplyPartial['results'] = [];
  const undo = trackedUndo({ progress: (_d, _t, p) => { if (p) seen.push({ results: [...p.results], undo: [...p.undo] }); } }, 3, results);
  undo.push(op('a')); results.push({ itemId: 'i1', ok: true });
  undo.push(op('b'), op('c'));
  assert.equal(undo.length, 3); assert.deepEqual(seen.map(p => p.undo.length), [1, 3]);
  assert.deepEqual(seen.map(p => p.results.length), [0, 1], 'done follows the results');
  assert.deepEqual(JSON.parse(JSON.stringify(undo)), [op('a'), op('b'), op('c')], 'serializes like an array');
  const plain = trackedUndo(undefined, 1); plain.push(op('x')); assert.equal(plain.length, 1);
});
