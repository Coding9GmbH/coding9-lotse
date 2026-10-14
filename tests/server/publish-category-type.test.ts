import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Layout nur für Kategorien vom Typ „page“ (Listing): Strukturelement („folder“) und Link („link“) zeigen keines
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-cattype-'));
const { assertLayoutCategory } = await import('../../src/server/changes');

test('Listing und fehlender Typ sind erlaubt', () => {
  assert.doesNotThrow(() => assertLayoutCategory({ id: 'c1', name: 'Vasen', type: 'page' }));
  assert.doesNotThrow(() => assertLayoutCategory({ id: 'c2', name: 'Alt' }));
  assert.doesNotThrow(() => assertLayoutCategory({ id: 'c3', name: 'Null', type: null }));
});

test('Strukturelement und Link werden mit verständlichem Grund abgelehnt', () => {
  assert.throws(() => assertLayoutCategory({ id: 'c4', name: 'Sortiment', translated: { name: 'Unser Sortiment' }, type: 'folder' }), /„Unser Sortiment“.*Strukturelement.*zeigt kein Layout/);
  assert.throws(() => assertLayoutCategory({ id: 'c5', name: 'Zum Blog', type: 'link' }), /„Zum Blog“.*Link \(leitet weiter\)/);
});
