import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePartial } from './partial-json';

test('parsePartial: vollständiges JSON', () => {
  assert.deepEqual(parsePartial('{"a":1,"b":[1,2]}'), { a: 1, b: [1, 2] });
});

test('parsePartial: offene Strings, Objekte und Arrays werden geschlossen', () => {
  assert.deepEqual(parsePartial('{"name":"Somm'), { name: 'Somm' });
  assert.deepEqual(parsePartial('{"sections":[{"blocks":[{"type":"text","html":"<p>Hal'), { sections: [{ blocks: [{ type: 'text', html: '<p>Hal' }] }] });
});

test('parsePartial: unvollständige Werte werden verworfen', () => {
  assert.deepEqual(parsePartial('{"a":1,"b":'), { a: 1 });
  assert.deepEqual(parsePartial('{"a":1,"b":tr'), { a: 1 });
  assert.deepEqual(parsePartial('{"a":"x\\"y'), { a: 'x"y' });
});

test('parsePartial: Unbrauchbares liefert null', () => {
  assert.equal(parsePartial(''), null);
  assert.equal(parsePartial('abc'), null);
});
