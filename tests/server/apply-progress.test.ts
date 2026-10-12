import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UndoOp } from '@/lib/protocol';
import { partialTicker, trackedUndo, type ApplyPartial } from '../../src/server/changes';

// Zwischenstand-Helfer für Executor ohne applyEach: jeder Tick trägt die bisherigen Ergebnisse und Rückgängig-Schritte (Absturzsicherheit, B1)
const op = (id: string): UndoOp => ({ op: 'patch', entity: 'product', id, data: {} });

test('partialTicker: done = Zahl der Ergebnisse, partial ist dasselbe (wachsende) Objekt', () => {
  const seen: [number, number, ApplyPartial | undefined][] = [];
  const results: ApplyPartial['results'] = [], undo: UndoOp[] = [], tick = partialTicker({ progress: (d, t, p) => seen.push([d, t, p]) }, 2, { results, undo });
  undo.push(op('a')); results.push({ itemId: 'i1', ok: true }); tick();
  results.push({ itemId: 'i2', ok: false, error: 'x' }); tick();
  assert.deepEqual(seen.map(([d, t]) => [d, t]), [[1, 2], [2, 2]]);
  assert.equal(seen[1][2]?.undo.length, 1); assert.equal(seen[1][2]?.results.length, 2);
  partialTicker(undefined, 1, { results, undo })(); // ohne ctx: nichts passiert
});

test('trackedUndo: jeder push meldet sofort; ohne ctx ein normales Array', () => {
  const seen: ApplyPartial[] = [], results: ApplyPartial['results'] = [];
  const undo = trackedUndo({ progress: (_d, _t, p) => { if (p) seen.push({ results: [...p.results], undo: [...p.undo] }); } }, 3, results);
  undo.push(op('a')); results.push({ itemId: 'i1', ok: true });
  undo.push(op('b'), op('c'));
  assert.equal(undo.length, 3); assert.deepEqual(seen.map(p => p.undo.length), [1, 3]);
  assert.deepEqual(seen.map(p => p.results.length), [0, 1], 'done folgt den Ergebnissen');
  assert.deepEqual(JSON.parse(JSON.stringify(undo)), [op('a'), op('b'), op('c')], 'serialisiert wie ein Array');
  const plain = trackedUndo(undefined, 1); plain.push(op('x')); assert.equal(plain.length, 1);
});
