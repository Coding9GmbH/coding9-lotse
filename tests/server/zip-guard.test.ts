import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { assertSafeZip, zipEntries, ZIP_LIMITS } from '../../src/server/zip-guard';

// Minimales ZIP (lokale Header + zentrales Verzeichnis + EOCD); size = angegebene Größe (zum Lügen)
function mkZip(files: { name: string; data: Buffer; store?: boolean; size?: number }[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let off = 0;
  for (const f of files) {
    const comp = f.store ? f.data : zlib.deflateRawSync(f.data), name = Buffer.from(f.name), method = f.store ? 0 : 8, size = f.size ?? f.data.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, comp); central.push(ch, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const small = { ...ZIP_LIMITS, total: 1024 * 1024, ratioMin: 100 * 1024 };

test('zipEntries/assertSafeZip: normales Archiv wird gelesen und angenommen', async () => {
  const z = mkZip([{ name: 'a.xml', data: Buffer.from('<a>hallo</a>') }, { name: 'b.txt', data: Buffer.from('x'), store: true }]);
  assert.deepEqual(zipEntries(z).map(e => [e.name, e.method, e.size]), [['a.xml', 8, 12], ['b.txt', 0, 1]]);
  await assertSafeZip(z);
  await assert.rejects(assertSafeZip(Buffer.from('kein zip')), /kein gültiges ZIP/);
});

test('assertSafeZip: Zip-Bombe (auch mit gelogener Größe), zu viele Einträge, absurde Kompression', async () => {
  const zeros = Buffer.alloc(2 * 1024 * 1024);
  await assert.rejects(assertSafeZip(mkZip([{ name: 'bomb.xml', data: zeros }]), small), /entpackt 2 MB, höchstens 1 MB/);
  await assert.rejects(assertSafeZip(mkZip([{ name: 'bomb.xml', data: zeros, size: 10 }]), small), /Zip-Bombe/, 'angegebene Größe lügt: tatsächliches Entpacken zählt');
  await assert.rejects(assertSafeZip(mkZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') }))), { ...small, entries: 5 }), /zu viele Einträge im Archiv \(6, höchstens 5\)/);
  await assert.rejects(assertSafeZip(mkZip([{ name: 'z.xml', data: Buffer.alloc(512 * 1024) }]), small), /ungewöhnlich stark komprimiert/);
});

test('Dateien mit Zip-Bombe werden vor exceljs/mammoth abgewiesen (Import und Wissensbasis); echte XLSX geht weiter', async () => {
  const { parseTable } = await import('../../src/server/features/import-parse');
  const { extractSegments } = await import('../../src/server/knowledge-text');
  const many = mkZip(Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => ({ name: `x/${i}`, data: Buffer.alloc(0), store: true })));
  await assert.rejects(parseTable(many, 'liste.xlsx'), /zu viele Einträge/);
  await assert.rejects(extractSegments(many, 'wissen.xlsx'), /zu viele Einträge/);
  await assert.rejects(extractSegments(many, 'wissen.docx'), /zu viele Einträge/);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Daten'); ws.addRow(['Nr', 'Name']); ws.addRow(['A-1', 'Vase']);
  const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
  await assertSafeZip(xlsx);
  assert.deepEqual((await parseTable(xlsx, 'liste.xlsx')).rows, [['A-1', 'Vase']]);
  assert.match((await extractSegments(xlsx, 'wissen.xlsx')).segments[0].text, /Vase/);
});
