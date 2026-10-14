import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Layout only for categories of type "page" (listing): structure element ("folder") and link ("link") show none
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-cattype-'));
const { assertLayoutCategory } = await import('../../src/server/changes');

test('listing and missing type are allowed', () => {
  assert.doesNotThrow(() => assertLayoutCategory({ id: 'c1', name: 'Vasen', type: 'page' }));
  assert.doesNotThrow(() => assertLayoutCategory({ id: 'c2', name: 'Alt' }));
  assert.doesNotThrow(() => assertLayoutCategory({ id: 'c3', name: 'Null', type: null }));
});

test('structure element and link are rejected with an understandable reason', () => {
  assert.throws(() => assertLayoutCategory({ id: 'c4', name: 'Sortiment', translated: { name: 'Unser Sortiment' }, type: 'folder' }), /„Unser Sortiment“.*Strukturelement.*zeigt kein Layout/);
  assert.throws(() => assertLayoutCategory({ id: 'c5', name: 'Zum Blog', type: 'link' }), /„Zum Blog“.*Link \(leitet weiter\)/);
});
