import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { columnDecimal, columnInfo, decodeText, detectDelimiter, detectHeaderRow, headerSignature, parseCsv, parseNumber, parseTable } from '../../../src/server/features/import-parse';
import { checkMapping, describeMapping, suggestMapping } from '../../../src/server/features/import-mapping';

// Test data as from Excel "CSV (Trennzeichen-getrennt)" on Windows: „ “ € as Windows-1252 bytes
const cp1252 = (s: string) => Buffer.from([...s].map(ch => ({ '€': 0x80, '„': 0x84, '“': 0x93, '–': 0x96 } as Record<string, number>)[ch] ?? ch.charCodeAt(0)));

test('Encoding: UTF-8, UTF-8 with BOM, Windows-1252 (umlauts)', () => {
  assert.deepEqual(decodeText(Buffer.from('Größe;Preis', 'utf8')), { text: 'Größe;Preis', encoding: 'UTF-8' });
  assert.deepEqual(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Maß', 'utf8')])), { text: 'Maß', encoding: 'UTF-8 (BOM)' });
  const w = decodeText(Buffer.from('Größe;Übergröße;€', 'latin1'));
  assert.equal(w.encoding, 'Windows-1252'); assert.equal(w.text.slice(0, 15), 'Größe;Übergröße');
  assert.equal(decodeText(cp1252('„Wärme“ – 9 €')).text, '„Wärme“ – 9 €');
});

test('CSV: detect delimiter, quotes, line breaks inside a field', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2,5;3\n4;5;6'), ';');
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('"x;y",b\n"1;2",3\n"4;5",6'), ',');
  const rows = parseCsv('Nr;Name;Text\r\n1;"Vase ""Kiesel""";"Zeile 1\nZeile 2"\n2;Becher; mit ; Rest\n', ';');
  assert.deepEqual(rows[1], ['1', 'Vase "Kiesel"', 'Zeile 1\nZeile 2']);
  assert.deepEqual(rows[2], ['2', 'Becher', 'mit', 'Rest']);
  assert.equal(rows.length, 3);
});

test('Numbers: decimal comma, thousands separator, currency, percent', () => {
  assert.equal(parseNumber('12,50'), 12.5);
  assert.equal(parseNumber('1.234,56 €'), 1234.56);
  assert.equal(parseNumber('1,234.56', '.'), 1234.56);
  assert.equal(parseNumber('19 %'), 19);
  assert.equal(parseNumber('1.500'), 1500);
  assert.equal(parseNumber('1.5', '.'), 1.5);
  assert.equal(parseNumber('12.5'), 12.5);
  assert.equal(parseNumber('abc'), null);
  assert.equal(parseNumber(''), null);
  assert.equal(columnDecimal(['12,50', '3,99', '7']), ',');
  assert.equal(columnDecimal(['12.50', '3.99']), '.');
  // "1.250" is ambiguous: German (semicolon) = thousands separator, comma-separated file = decimal point
  assert.equal(columnDecimal(['1.250', '2.500']), ','); assert.equal(parseNumber('1.250', columnDecimal(['1.250'], ';')), 1250);
  assert.equal(columnDecimal(['1.250', '2.500'], ','), '.'); assert.equal(columnDecimal(['1.250', '12.99']), '.');
});

test('Header row: title rows before it are skipped', () => {
  assert.equal(detectHeaderRow([['Preisliste Nordlicht GmbH'], ['Stand: 01.10.2026'], [], ['Art.-Nr.', 'Bezeichnung', 'VK brutto'], ['N-1', 'Plaid', '89,00']]), 3);
  assert.equal(detectHeaderRow([['Nr', 'Name'], ['1', 'x']]), 0);
});

test('CSV file (Windows-1252, semicolon, decimal comma) → table with column types', async () => {
  const csv = 'Lieferant Nordlicht;;\nArtikelnummer;Bezeichnung;VK brutto;EAN;Bild\nN-1;Plaid „Fjord“ Größe L;89,90;4012345678901;https://x.test/a.jpg\nN-2;Kissen Wärme;24,50;4012345678918;\n';
  const t = await parseTable(cp1252(csv), 'liste.csv');
  assert.equal(t.encoding, 'Windows-1252'); assert.equal(t.delimiter, ';'); assert.equal(t.headerRow, 2);
  assert.deepEqual(t.headers, ['Artikelnummer', 'Bezeichnung', 'VK brutto', 'EAN', 'Bild']);
  assert.equal(t.rows.length, 2); assert.equal(t.rows[0][1], 'Plaid „Fjord“ Größe L');
  const cols = columnInfo(t);
  assert.deepEqual(cols.map(c => c.type), ['text', 'text', 'preis', 'ean', 'url']);
});

test('XLSX: sheet selection, title row, numbers, rich text, formula', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Info').addRow(['nur Hinweise']);
  const ws = wb.addWorksheet('Artikel');
  ws.addRow(['Preisliste Herbst 2026']);
  ws.addRow(['Art.-Nr.', 'Bezeichnung', 'Preis netto', 'MwSt', 'Bestand', 'Farbe', 'Gewicht (g)']);
  ws.addRow(['HH-T-1', { richText: [{ text: 'Teller ' }, { text: 'Ø 27 cm' }] }, 16.81, 0.19, 12, 'Sand', 540]);
  ws.addRow(['HH-T-2', 'Schale', { formula: 'C3*2', result: 33.62 }, 19, 0, 'Grün', 320]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const t = await parseTable(buf, 'lieferant.xlsx', 'artikel');
  assert.equal(t.format, 'xlsx'); assert.equal(t.sheet, 'Artikel'); assert.deepEqual(t.sheets, ['Info', 'Artikel']); assert.equal(t.headerRow, 2);
  assert.deepEqual(t.rows[0], ['HH-T-1', 'Teller Ø 27 cm', '16.81', '0.19', '12', 'Sand', '540']);
  assert.equal(t.rows[1][2], '33.62');
  const first = await parseTable(buf, 'lieferant.xlsx');
  assert.equal(first.sheet, 'Info');
  await assert.rejects(parseTable(buf, 'lieferant.xlsx', 'Fehlt'), /Blatt „Fehlt“ nicht gefunden/);
  // Mapping: net + VAT, grams, property color
  const m = suggestMapping(columnInfo(t));
  assert.equal(m.productNumber, 'Art.-Nr.'); assert.equal(m.name, 'Bezeichnung'); assert.equal(m.priceNet, 'Preis netto'); assert.equal(m.taxRate, 'MwSt');
  assert.equal(m.stock, 'Bestand'); assert.equal(m.weight, 'Gewicht (g)'); assert.deepEqual(m.units, { weight: 'g' });
  assert.deepEqual(m.properties, [{ group: 'Farbe', column: 'Farbe' }]);
  assert.ok(describeMapping(m).includes('Gewicht in Gramm (wird in kg umgerechnet)'));
});

test('Old .xls binary format and wrong file types are clearly rejected', async () => {
  await assert.rejects(parseTable(Buffer.from('d0cf11e0a1b11ae1', 'hex'), 'alt.xls'), /als \.xlsx oder \.csv speichern/);
  await assert.rejects(parseTable(Buffer.from('%PDF'), 'liste.pdf'), /CSV-, TSV- oder Excel-Datei/);
});

test('Mapping suggestion: net before gross, manufacturer no. before product number, variants', () => {
  const cols = ['Artikelnummer', 'Hauptartikel', 'Hersteller-Artikelnummer', 'Artikelbezeichnung', 'Langtext', 'VK-Preis', 'UVP', 'EK netto', 'Lagerbestand', 'Marke', 'Warengruppe', 'Farbe', 'Größe', 'Material', 'Bild 1', 'Bild 2', 'Lieferzeit', 'Breite (cm)']
    .map(name => ({ name, type: 'text' as const, filled: 1, distinct: 1, samples: [] }));
  const m = suggestMapping(cols);
  assert.equal(m.productNumber, 'Artikelnummer'); assert.equal(m.parentNumber, 'Hauptartikel'); assert.equal(m.manufacturerNumber, 'Hersteller-Artikelnummer');
  assert.equal(m.name, 'Artikelbezeichnung'); assert.equal(m.description, 'Langtext'); assert.equal(m.priceGross, 'VK-Preis'); assert.equal(m.listPrice, 'UVP');
  assert.equal(m.purchasePrice, 'EK netto'); assert.equal(m.stock, 'Lagerbestand'); assert.equal(m.manufacturer, 'Marke'); assert.equal(m.category, 'Warengruppe');
  assert.deepEqual(m.images, ['Bild 1', 'Bild 2']); assert.equal(m.deliveryTime, 'Lieferzeit'); assert.equal(m.width, 'Breite (cm)'); assert.equal(m.units?.dimensions, 'cm');
  assert.deepEqual(m.variantOptions, [{ group: 'Farbe', column: 'Farbe' }, { group: 'Größe', column: 'Größe' }]);
  assert.deepEqual(m.properties, [{ group: 'Material', column: 'Material' }]);
  assert.deepEqual(checkMapping(m, cols.map(c => c.name)), []);
  assert.match(checkMapping({ name: 'Fehlt' }, ['A']).join(' '), /Spalte „Fehlt“ gibt es nicht.*Produktnummer oder EAN/);
});

test('Header row signature: order and spelling do not matter', () => {
  assert.equal(headerSignature(['Art.-Nr.', 'Größe', 'Preis']), headerSignature(['preis', 'GRÖSSE', 'Art Nr']));
  assert.notEqual(headerSignature(['A', 'B']), headerSignature(['A', 'C']));
});
