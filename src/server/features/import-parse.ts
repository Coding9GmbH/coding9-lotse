// Read supplier files (pure, no shop access → testable): CSV/TSV (delimiter, quotes, encoding),
// XLSX (first or selected sheet), header row detection, numbers with decimal comma, column types and mapping suggestion.
import crypto from 'node:crypto';
import { assertSafeZip } from '../zip-guard';

export const MAX_ROWS = 20_000;
export interface Table {
  format: 'csv' | 'xlsx';
  headers: string[];
  rows: string[][];
  /** 1-based line of the header row in the file/sheet */
  headerRow: number;
  delimiter?: string; encoding?: string;
  sheet?: string; sheets?: string[];
  /** file had more than MAX_ROWS data rows */
  truncated: boolean;
}

// ---- Encoding ----
export function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'UTF-8 (BOM)' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' }; }
  catch { return { text: Array.from(buf, b => (b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80] : String.fromCharCode(b))).join(''), encoding: 'Windows-1252' }; }
}
// Node decodes "windows-1252" like Latin-1, so map the characters 0x80–0x9F (€, „, “, – …) ourselves
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';

// ---- CSV ----
const DELIMS = [';', ',', '\t', '|'];
/** Delimiter: the most frequent and most even one in the first lines (outside quotes) */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 30);
  let best = ';', score = -1;
  for (const d of DELIMS) {
    const counts = lines.map(l => { let n = 0, q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === d && !q) n++; } return n; });
    const top = counts.filter(c => c > 0);
    if (!top.length) continue;
    const mode = [...top].sort((a, b) => top.filter(x => x === b).length - top.filter(x => x === a).length)[0];
    const s = counts.filter(c => c === mode).length * 10 + mode;
    if (s > score) { score = s; best = d; }
  }
  return best;
}

/** RFC 4180 parser: quotes, doubled "" and line breaks in fields */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"' && field.trim() === '') { q = true; field = ''; }
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map(r => r.map(c => c.trim()));
}

// ---- XLSX ----
type Cell = unknown;
/** exceljs cell value → text (numbers with dot, date as YYYY-MM-DD, formulas with result, rich text, links) */
export function cellText(v: Cell): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'boolean') return v ? 'ja' : 'nein';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { richText?: { text: string }[]; result?: Cell; text?: Cell; hyperlink?: string; error?: string };
    if (o.richText) return o.richText.map(r => r.text).join('').trim();
    if ('result' in o) return cellText(o.result);
    if (o.text != null) return cellText(o.text);
    if (o.hyperlink) return o.hyperlink;
    if (o.error) return '';
  }
  return String(v).trim();
}

async function readXlsx(buf: Buffer, sheet?: string): Promise<{ rows: string[][]; sheet: string; sheets: string[] }> {
  await assertSafeZip(buf); // zip bomb: before exceljs (unpacks without limit)
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheets = wb.worksheets.map(w => w.name);
  const ws = sheet ? wb.worksheets.find(w => w.name === sheet || w.name.toLowerCase() === sheet.trim().toLowerCase()) : wb.worksheets.find(w => w.actualRowCount > 0) ?? wb.worksheets[0];
  if (!ws) throw new Error(sheet ? `Blatt „${sheet}“ nicht gefunden (vorhanden: ${sheets.join(', ')})` : 'Die Arbeitsmappe enthält kein Blatt');
  const rows: string[][] = [];
  const last = Math.min(ws.rowCount, MAX_ROWS + 20);
  for (let r = 1; r <= last; r++) {
    const vals = ws.getRow(r).values as Cell[]; // 1-based
    rows.push(Array.isArray(vals) ? Array.from({ length: Math.max(0, vals.length - 1) }, (_, i) => cellText(vals[i + 1])) : []);
  }
  if (ws.rowCount > last) rows.push(['…']); // marker for "truncated"
  return { rows, sheet: ws.name, sheets };
}

// ---- Header row ----
const isNumeric = (s: string) => /^[-+]?[\d.,\s]+(€|%)?$/.test(s) && /\d/.test(s);
/** First row that looks like a header row (many texts, few numbers); title rows before it are skipped */
export function detectHeaderRow(rows: string[][]): number {
  const head = rows.slice(0, 15), width = Math.max(0, ...head.map(r => r.filter(Boolean).length));
  for (let i = 0; i < head.length; i++) {
    const cells = head[i].filter(Boolean);
    if (cells.length >= Math.max(2, Math.ceil(width * 0.6)) && cells.filter(c => !isNumeric(c)).length / cells.length >= 0.7 && new Set(cells).size === cells.length) return i;
  }
  return 0;
}

function toTable(raw: string[][], base: Omit<Table, 'headers' | 'rows' | 'headerRow' | 'truncated'>): Table {
  const truncatedMark = raw.length && raw[raw.length - 1].length === 1 && raw[raw.length - 1][0] === '…';
  const all = truncatedMark ? raw.slice(0, -1) : raw;
  const h = detectHeaderRow(all);
  const width = Math.max(0, ...all.slice(h, h + 200).map(r => r.length));
  const seen = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, i) => {
    const name = (all[h]?.[i] ?? '').replace(/\s+/g, ' ').trim() || `Spalte ${i + 1}`;
    const n = (seen.get(name) ?? 0) + 1; seen.set(name, n);
    return n > 1 ? `${name} (${n})` : name;
  });
  // drop empty trailing columns without a heading
  while (headers.length && /^Spalte \d+$/.test(headers[headers.length - 1]) && all.slice(h + 1).every(r => !r[headers.length - 1])) headers.pop();
  const body = all.slice(h + 1).filter(r => r.some(c => c !== '')).map(r => headers.map((_, i) => r[i] ?? ''));
  return { ...base, headers, rows: body.slice(0, MAX_ROWS), headerRow: h + 1, truncated: !!truncatedMark || body.length > MAX_ROWS };
}

const ext = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
/** File → table. XLSX via exceljs; .xls only if it is actually text/CSV or XLSX (old binary format: please save as XLSX/CSV). */
export async function parseTable(buf: Buffer, name: string, sheet?: string): Promise<Table> {
  const e = ext(name);
  const zip = buf[0] === 0x50 && buf[1] === 0x4b, ole = buf.subarray(0, 4).toString('hex') === 'd0cf11e0';
  if (zip && (e === 'xlsx' || e === 'xls')) { const x = await readXlsx(buf, sheet); return toTable(x.rows, { format: 'xlsx', sheet: x.sheet, sheets: x.sheets }); }
  if (ole) throw new Error('Altes Excel-Format (.xls, Excel 97–2003) kann nicht gelesen werden. Bitte in Excel als .xlsx oder .csv speichern und erneut hochladen.');
  if (!['csv', 'tsv', 'txt', 'xls'].includes(e)) throw new Error(`Für den Import bitte eine CSV-, TSV- oder Excel-Datei (.xlsx) anhängen (nicht .${e || '?'})`);
  const { text, encoding } = decodeText(buf);
  if (/^\s*<(html|table|!doctype)/i.test(text)) throw new Error('Die Datei ist eine HTML-Tabelle mit .xls-Endung. Bitte in Excel als .xlsx oder .csv speichern.');
  const delimiter = e === 'tsv' ? '\t' : detectDelimiter(text);
  return toTable(parseCsv(text, delimiter), { format: 'csv', delimiter, encoding });
}

// ---- Numbers ----
/** Decimal separator of a column: "," if values like 12,50 / 1.234,56 occur, otherwise ".".
 *  "1.250" (one dot, exactly three digits) is ambiguous and doesn't count; only such values → thousands dot,
 *  unless the file is comma-delimited (English format). */
export function columnDecimal(values: string[], delimiter?: string): ',' | '.' {
  let comma = 0, dot = 0;
  for (const v of values) {
    const s = v.replace(/[\s€%]|EUR/gi, '');
    if (/^-?\d{1,3}\.\d{3}$/.test(s)) continue;
    if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(s) || /^-?\d+,\d{1,2}$/.test(s)) comma++;
    else if (/^-?\d{1,3}(,\d{3})*\.\d+$/.test(s) || /^-?\d+\.\d{1,2}$/.test(s)) dot++;
  }
  if (!comma && !dot) return delimiter === ',' ? '.' : ',';
  return comma >= dot ? ',' : '.';
}
/** "1.234,56 €", "12,5", "19 %", "1,234.56" → number; empty/invalid → null */
export function parseNumber(raw: string | null | undefined, decimal: ',' | '.' = ','): number | null {
  let s = String(raw ?? '').replace(/\s|€|EUR|%/gi, '').replace(/^\+/, '');
  if (!s || !/\d/.test(s)) return null;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = decimal === '.' && /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  else if (s.includes('.') && decimal === ',' && /^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

// ---- Columns ----
export type ColType = 'leer' | 'ganzzahl' | 'zahl' | 'preis' | 'ean' | 'url' | 'html' | 'text';
export interface ColumnInfo { name: string; type: ColType; filled: number; distinct: number; samples: string[] }
const URL_RE = /^https?:\/\/\S+$/i;
export function inferType(values: string[]): ColType {
  const v = values.filter(Boolean);
  if (!v.length) return 'leer';
  const all = (re: RegExp | ((s: string) => boolean)) => v.every(s => (typeof re === 'function' ? re(s) : re.test(s)));
  if (all(s => s.split(/[\s,;|]+/).filter(Boolean).every(u => URL_RE.test(u)))) return 'url';
  if (all(/^\d{8}$|^\d{12,14}$/)) return 'ean';
  if (all(/^-?\d+$/)) return 'ganzzahl';
  if (all(s => parseNumber(s) != null)) return v.some(s => /€|EUR/i.test(s)) || v.every(s => /[.,]\d{2}\s*(€|EUR)?$/i.test(s)) ? 'preis' : 'zahl';
  if (v.some(s => /<\/?(p|br|ul|li|b|strong|div)\b/i.test(s))) return 'html';
  return 'text';
}
export function columnInfo(t: Table): ColumnInfo[] {
  return t.headers.map((name, i) => {
    const vals = t.rows.map(r => r[i] ?? '');
    const filled = vals.filter(Boolean), distinct = new Set(filled);
    return { name, type: inferType(filled.slice(0, 500)), filled: filled.length, distinct: distinct.size, samples: [...distinct].slice(0, 3).map(s => (s.length > 80 ? s.slice(0, 80) + '…' : s)) };
  });
}

/** Normalized column name for matching and signature: lowercase, umlauts spelled out, letters/digits only */
export const normHeader = (h: string) => h.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '');
/** Signature of the header row (order irrelevant): recognizes the same supplier file again */
export const headerSignature = (headers: string[]) => crypto.createHash('sha1').update([...new Set(headers.map(normHeader).filter(Boolean))].sort().join('|')).digest('hex').slice(0, 16);
