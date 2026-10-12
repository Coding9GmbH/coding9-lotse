import 'server-only';
// Wissensbasis: Text aus Dateien holen (PDF, Word, Excel, CSV, Text) und in zitierbare Abschnitte teilen.
import ExcelJS from 'exceljs';

/** Textabschnitt einer Quelle: page = PDF-Seite, label = z. B. Tabellenblatt. */
export interface Segment { text: string; page?: number; label?: string }
export interface Chunk { idx: number; text: string; page?: number; label?: string }

export const MAX_TEXT = 2_000_000, MAX_CHUNKS = 4000;
export const CHUNK = { min: 800, target: 1100, max: 1200, overlap: 150 };

const ext = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
const clean = (s: string) => s.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// ---------- CSV/TSV ----------
export function parseDelimited(text: string): string[][] {
  const first = text.split('\n', 1)[0] ?? '';
  const sep = ['\t', ';', ','].map(c => [c, first.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

/** Tabellenzeilen als lesbarer Text: „Spalte: Wert; Spalte: Wert“ (Kopfzeile = erste Zeile). */
export function rowsToText(rows: string[][]): string {
  if (!rows.length) return '';
  const head = rows[0].map((h, i) => h.trim() || `Spalte ${i + 1}`);
  if (rows.length === 1) return head.join('; ');
  return rows.slice(1).map(r => r.map((v, i) => (v.trim() ? `${head[i] ?? `Spalte ${i + 1}`}: ${v.trim()}` : '')).filter(Boolean).join('; ')).filter(Boolean).join('\n\n');
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map(t => t.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return v.result == null ? '' : cellText(v.result as ExcelJS.CellValue);
    if ('error' in v) return '';
    return '';
  }
  return String(v);
}

/** Text aus einer Datei (nach Endung). Wirft verständliche Fehler, z. B. bei gescannten PDFs. */
export async function extractSegments(buf: Buffer, name: string): Promise<{ segments: Segment[]; pages?: number }> {
  const e = ext(name);
  if (['txt', 'md', 'json'].includes(e)) return { segments: [{ text: clean(buf.toString('utf8')) }] };
  if (e === 'csv' || e === 'tsv') return { segments: [{ text: rowsToText(parseDelimited(clean(buf.toString('utf8')))) }] };
  if (e === 'xls') throw new Error('Das alte Excel-Format .xls kann nicht gelesen werden. Bitte als .xlsx speichern und erneut hochladen.');
  if (e === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const segments: Segment[] = [];
    wb.eachSheet(ws => {
      const rows: string[][] = [];
      ws.eachRow({ includeEmpty: false }, r => { const vals: string[] = []; r.eachCell({ includeEmpty: true }, (c, col) => { vals[col - 1] = cellText(c.value); }); rows.push(Array.from(vals, v => v ?? '')); });
      const text = rowsToText(rows);
      if (text) segments.push({ text, label: `Blatt ${ws.name}` });
    });
    return { segments };
  }
  if (e === 'pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const r = await extractText(pdf, { mergePages: false });
    const segments = r.text.map((t, i) => ({ text: clean(t), page: i + 1 })).filter(s => s.text);
    if (!segments.length) throw new Error('Das PDF enthält keinen lesbaren Text (vermutlich gescannt). Bitte eine PDF mit Text oder die Angaben als Text hochladen.');
    return { segments, pages: r.totalPages };
  }
  if (e === 'docx') {
    const mammoth = (await import('mammoth')).default;
    const r = await mammoth.extractRawText({ buffer: buf });
    return { segments: [{ text: clean(r.value) }] };
  }
  throw new Error(`Dateityp .${e || '?'} wird für die Wissensbasis nicht unterstützt.`);
}

// ---------- Abschnitte ----------
/** Zerlegt Text in Einheiten (Absätze, zu lange Absätze in Sätze, zu lange Sätze in Wortgruppen). */
function units(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim(); if (!p) continue;
    if (p.length <= CHUNK.max) { out.push(p); continue; }
    for (const sent of p.split(/(?<=[.!?:;])\s+|\n/)) {
      if (sent.length <= CHUNK.max) { if (sent.trim()) out.push(sent.trim()); continue; }
      let cur = '';
      for (const w of sent.split(/\s+/)) {
        if (w.length > CHUNK.max) { if (cur) out.push(cur); for (let i = 0; i < w.length; i += CHUNK.max) out.push(w.slice(i, i + CHUNK.max)); cur = ''; continue; }
        if (cur && cur.length + 1 + w.length > CHUNK.target) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
      }
      if (cur) out.push(cur);
    }
  }
  return out;
}

/** Ende eines Abschnitts als Überlappung für den nächsten (an Wortgrenze). */
function tail(s: string, n = CHUNK.overlap): string {
  if (s.length <= n) return s;
  const t = s.slice(-n); const sp = t.indexOf(' ');
  return (sp >= 0 && sp < n - 20 ? t.slice(sp + 1) : t).trim();
}

/** Abschnitte von ca. 800 bis 1200 Zeichen mit Überlappung; Seiten/Blätter werden nie gemischt (Zitat bleibt korrekt). */
export function chunkSegments(segments: Segment[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const seg of segments) {
    const us = units(seg.text);
    let cur = '', fresh = false; // fresh = cur enthält neuen Text (nicht nur Überlappung)
    const push = () => { if (fresh && cur.trim()) chunks.push({ idx: chunks.length, text: cur.trim(), ...(seg.page ? { page: seg.page } : {}), ...(seg.label ? { label: seg.label } : {}) }); };
    for (const u of us) {
      if (cur && fresh && cur.length + 2 + u.length > CHUNK.max) {
        push(); const ov = tail(cur);
        cur = ov.length + 2 + u.length <= CHUNK.max ? `${ov}\n\n${u}` : u;
      } else cur = cur ? `${cur}\n\n${u}` : u;
      fresh = true;
      if (chunks.length >= MAX_CHUNKS) return chunks;
    }
    push();
  }
  return chunks.slice(0, MAX_CHUNKS);
}

/** Zitierbare Quelle: „Datenblatt.pdf, S. 2“ bzw. „Preise.xlsx, Blatt Preise“. */
export const citation = (title: string, c: { page?: number | null; label?: string | null }) =>
  `${title}${c.page ? `, S. ${c.page}` : c.label ? `, ${c.label}` : ''}`;
