import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePartial } from '../../src/server/partial-json';

test('parsePartial: complete JSON', () => {
  assert.deepEqual(parsePartial('{"a":1,"b":[1,2]}'), { a: 1, b: [1, 2] });
});

test('parsePartial: open strings, objects and arrays are closed', () => {
  assert.deepEqual(parsePartial('{"name":"Somm'), { name: 'Somm' });
  assert.deepEqual(parsePartial('{"sections":[{"blocks":[{"type":"text","html":"<p>Hal'), { sections: [{ blocks: [{ type: 'text', html: '<p>Hal' }] }] });
});

test('parsePartial: incomplete values are discarded', () => {
  assert.deepEqual(parsePartial('{"a":1,"b":'), { a: 1 });
  assert.deepEqual(parsePartial('{"a":1,"b":tr'), { a: 1 });
  assert.deepEqual(parsePartial('{"a":"x\\"y'), { a: 'x"y' });
});

test('parsePartial: unusable input returns null', () => {
  assert.equal(parsePartial(''), null);
  assert.equal(parsePartial('abc'), null);
});
