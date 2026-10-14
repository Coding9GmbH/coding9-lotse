import 'server-only';
// Knowledge base: extract text from files (PDF, Word, Excel, CSV, text) and split it into citable chunks.
import ExcelJS from 'exceljs';
import { assertSafeZip } from './zip-guard';

/** Text chunk of a source: page = PDF page, label = e.g. worksheet. */
export interface Segment { text: string; page?: number; label?: string }
export interface Chunk { idx: number; text: string; page?: number; label?: string }

export const MAX_TEXT = 2_000_000, MAX_CHUNKS = 4000;
/** Limits when reading (memory): table rows across all sheets, PDF pages */
export const MAX_SHEET_ROWS = 100_000, MAX_PDF_PAGES = 1000;
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

/** Table rows as readable text: "Column: value; Column: value" (header = first row). */
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

/** Text from a file (by extension). Throws understandable errors, e.g. for scanned PDFs. */
export async function extractSegments(buf: Buffer, name: string): Promise<{ segments: Segment[]; pages?: number }> {
  const e = ext(name);
  if (['txt', 'md', 'json'].includes(e)) return { segments: [{ text: clean(buf.toString('utf8')) }] };
  if (e === 'csv' || e === 'tsv') return { segments: [{ text: rowsToText(parseDelimited(clean(buf.toString('utf8')))) }] };
  if (e === 'xls') throw new Error('Das alte Excel-Format .xls kann nicht gelesen werden. Bitte als .xlsx speichern und erneut hochladen.');
  if (e === 'xlsx') {
    await assertSafeZip(buf);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const segments: Segment[] = [];
    let left = MAX_SHEET_ROWS; // rows across all sheets
    wb.eachSheet(ws => {
      const rows: string[][] = [];
      ws.eachRow({ includeEmpty: false }, r => { if (left-- <= 0) return; const vals: string[] = []; r.eachCell({ includeEmpty: true }, (c, col) => { vals[col - 1] = cellText(c.value); }); rows.push(Array.from(vals, v => v ?? '')); });
      const text = rowsToText(rows);
      if (text) segments.push({ text, label: `Blatt ${ws.name}` });
    });
    return { segments };
  }
  if (e === 'pdf') {
    const { getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const segments: Segment[] = [];
    try { // pages one by one and limited (page count, text amount) instead of all at once
      for (let p = 1, len = 0; p <= Math.min(pdf.numPages, MAX_PDF_PAGES) && len <= MAX_TEXT; p++) {
        const items = (await (await pdf.getPage(p)).getTextContent()).items as { str?: string; hasEOL?: boolean }[];
        const text = clean(items.filter(i => i.str != null).map(i => i.str + (i.hasEOL ? '\n' : '')).join(''));
        if (text) { segments.push({ text, page: p }); len += text.length; }
      }
    } finally { await pdf.loadingTask.destroy().catch(() => {}); }
    if (!segments.length) throw new Error('Das PDF enthält keinen lesbaren Text (vermutlich gescannt). Bitte eine PDF mit Text oder die Angaben als Text hochladen.');
    return { segments, pages: pdf.numPages };
  }
  if (e === 'docx') {
    await assertSafeZip(buf);
    const mammoth = (await import('mammoth')).default;
    const r = await mammoth.extractRawText({ buffer: buf });
    return { segments: [{ text: clean(r.value) }] };
  }
  throw new Error(`Dateityp .${e || '?'} wird für die Wissensbasis nicht unterstützt.`);
}

// ---------- Chunks ----------
/** Splits text into units (paragraphs, overlong paragraphs into sentences, overlong sentences into word groups). */
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

/** End of a chunk as overlap for the next one (at a word boundary). */
function tail(s: string, n = CHUNK.overlap): string {
  if (s.length <= n) return s;
  const t = s.slice(-n); const sp = t.indexOf(' ');
  return (sp >= 0 && sp < n - 20 ? t.slice(sp + 1) : t).trim();
}

/** Chunks of about 800 to 1200 characters with overlap; pages/sheets are never mixed (citation stays correct). */
export function chunkSegments(segments: Segment[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const seg of segments) {
    const us = units(seg.text);
    let cur = '', fresh = false; // fresh = cur contains new text (not just overlap)
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

/** Citable source: "Datenblatt.pdf, S. 2" or "Preise.xlsx, Blatt Preise". */
export const citation = (title: string, c: { page?: number | null; label?: string | null }) =>
  `${title}${c.page ? `, S. ${c.page}` : c.label ? `, ${c.label}` : ''}`;
