import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('files: save, read, type check', async () => {
  process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-files-'));
  const { saveFile, getFile, fileMeta, fileType } = await import('../../src/server/files');
  assert.equal(fileType('Lieferant.XLSX'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(fileType('x.exe'), null);
  assert.throws(() => saveFile(Buffer.from('x'), 'evil.exe'), /nicht unterstützt/);
  const m = saveFile(Buffer.from('a;b\n1;2'), '../liste.csv');
  assert.equal(m.name, 'liste.csv'); assert.equal(m.mime, 'text/csv');
  assert.equal(getFile(m.fileId)?.buf.toString(), 'a;b\n1;2');
  assert.equal(fileMeta('../../etc'), null);
});
