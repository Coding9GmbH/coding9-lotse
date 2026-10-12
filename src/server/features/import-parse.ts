// Lieferantendateien lesen (rein, ohne Shop-Zugriff → testbar): CSV/TSV (Trennzeichen, Anführungszeichen, Kodierung),
// XLSX (erstes oder gewähltes Blatt), Kopfzeilen-Erkennung, Zahlen mit Dezimalkomma, Spaltentypen und Zuordnungs-Vorschlag.
import crypto from 'node:crypto';

export const MAX_ROWS = 20_000;
export interface Table {
  format: 'csv' | 'xlsx';
  headers: string[];
  rows: string[][];
  /** 1-basierte Zeile der Kopfzeile in der Datei/im Blatt */
  headerRow: number;
  delimiter?: string; encoding?: string;
  sheet?: string; sheets?: string[];
  /** Datei hatte mehr als MAX_ROWS Datenzeilen */
  truncated: boolean;
}

// ---- Kodierung ----
export function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'UTF-8 (BOM)' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' }; }
  catch { return { text: Array.from(buf, b => (b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80] : String.fromCharCode(b))).join(''), encoding: 'Windows-1252' }; }
}
// Node dekodiert „windows-1252“ wie Latin-1 – die Zeichen 0x80–0x9F (€, „, “, – …) daher selbst abbilden
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';

// ---- CSV ----
const DELIMS = [';', ',', '\t', '|'];
/** Trennzeichen: das in den ersten Zeilen (außerhalb von Anführungszeichen) häufigste und gleichmäßigste */
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

/** RFC-4180-Parser: Anführungszeichen, verdoppelte "" und Zeilenumbrüche in Feldern */
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
/** Zellwert von exceljs → Text (Zahlen mit Punkt, Datum als JJJJ-MM-TT, Formeln mit Ergebnis, Rich-Text, Links) */
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
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheets = wb.worksheets.map(w => w.name);
  const ws = sheet ? wb.worksheets.find(w => w.name === sheet || w.name.toLowerCase() === sheet.trim().toLowerCase()) : wb.worksheets.find(w => w.actualRowCount > 0) ?? wb.worksheets[0];
  if (!ws) throw new Error(sheet ? `Blatt „${sheet}“ nicht gefunden (vorhanden: ${sheets.join(', ')})` : 'Die Arbeitsmappe enthält kein Blatt');
  const rows: string[][] = [];
  const last = Math.min(ws.rowCount, MAX_ROWS + 20);
  for (let r = 1; r <= last; r++) {
    const vals = ws.getRow(r).values as Cell[]; // 1-basiert
    rows.push(Array.isArray(vals) ? Array.from({ length: Math.max(0, vals.length - 1) }, (_, i) => cellText(vals[i + 1])) : []);
  }
  if (ws.rowCount > last) rows.push(['…']); // Marker für „gekürzt“
  return { rows, sheet: ws.name, sheets };
}

// ---- Kopfzeile ----
const isNumeric = (s: string) => /^[-+]?[\d.,\s]+(€|%)?$/.test(s) && /\d/.test(s);
/** Erste Zeile, die wie eine Kopfzeile aussieht (viele Texte, kaum Zahlen); Titelzeilen davor werden übersprungen */
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
  // leere Spalten am Ende ohne Überschrift weglassen
  while (headers.length && /^Spalte \d+$/.test(headers[headers.length - 1]) && all.slice(h + 1).every(r => !r[headers.length - 1])) headers.pop();
  const body = all.slice(h + 1).filter(r => r.some(c => c !== '')).map(r => headers.map((_, i) => r[i] ?? ''));
  return { ...base, headers, rows: body.slice(0, MAX_ROWS), headerRow: h + 1, truncated: !!truncatedMark || body.length > MAX_ROWS };
}

const ext = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
/** Datei → Tabelle. XLSX über exceljs; .xls nur, wenn sie eigentlich Text/CSV oder XLSX ist (altes Binärformat: bitte als XLSX/CSV speichern). */
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

// ---- Zahlen ----
/** Dezimaltrennzeichen einer Spalte: „,“ wenn Werte wie 12,50 / 1.234,56 vorkommen, sonst „.“.
 *  „1.250“ (ein Punkt, genau drei Stellen) ist mehrdeutig und zählt nicht; nur solche Werte → Tausenderpunkt,
 *  außer die Datei ist mit Komma getrennt (englisches Format). */
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
/** „1.234,56 €“, „12,5“, „19 %“, „1,234.56“ → Zahl; leer/ungültig → null */
export function parseNumber(raw: string | null | undefined, decimal: ',' | '.' = ','): number | null {
  let s = String(raw ?? '').replace(/\s|€|EUR|%/gi, '').replace(/^\+/, '');
  if (!s || !/\d/.test(s)) return null;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = decimal === '.' && /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  else if (s.includes('.') && decimal === ',' && /^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

// ---- Spalten ----
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

/** Normalisierter Spaltenname für Abgleich und Signatur: klein, Umlaute ausgeschrieben, nur Buchstaben/Ziffern */
export const normHeader = (h: string) => h.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '');
/** Signatur der Kopfzeile (Reihenfolge egal) – erkennt dieselbe Lieferantendatei wieder */
export const headerSignature = (headers: string[]) => crypto.createHash('sha1').update([...new Set(headers.map(normHeader).filter(Boolean))].sort().join('|')).digest('hex').slice(0, 16);
