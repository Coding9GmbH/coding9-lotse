import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunks } from '../../src/server/util';

test('chunks: splits into consecutive slices of at most n items', () => {
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunks([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
  assert.deepEqual(chunks([], 3), []);
});
