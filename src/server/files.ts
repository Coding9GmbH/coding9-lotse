import 'server-only';
// File attachments from the chat (CSV, Excel, PDF, text …): stored locally in the data directory, never in the shop.
// Feature modules read them via getFile(fileId), e.g. supplier import or knowledge base.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './db';

export interface StoredFile { fileId: string; name: string; mime: string; size: number; createdAt: string }

export const FILE_TYPES: Record<string, string> = {
  csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export const FILE_LIMIT = 25 * 1024 * 1024;
export const FILE_TOO_LARGE = `Datei größer als ${FILE_LIMIT / 1024 / 1024} MB`;

const dir = () => path.join(dataDir(), 'files');
const ID = /^f_[0-9a-f]{20}$/;
const ext = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();

/** Type by extension (browsers often send empty or wrong MIME types for CSV/Excel). null = not allowed. */
export function fileType(name: string): string | null { return FILE_TYPES[ext(name)] ?? null; }

export function saveFile(buf: Buffer, name: string): StoredFile {
  const mime = fileType(name); if (!mime) throw new Error(`Dateityp .${ext(name) || '?'} wird nicht unterstützt (erlaubt: ${Object.keys(FILE_TYPES).join(', ')})`);
  if (buf.length > FILE_LIMIT) throw new Error(FILE_TOO_LARGE);
  const fileId = `f_${crypto.randomBytes(10).toString('hex')}`, d = path.join(dir(), fileId);
  fs.mkdirSync(d, { recursive: true });
  const meta: StoredFile = { fileId, name: path.basename(name).slice(0, 200), mime, size: buf.length, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(d, 'data'), buf); fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta));
  return meta;
}

export function fileMeta(fileId: string): StoredFile | null {
  if (!ID.test(fileId)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir(), fileId, 'meta.json'), 'utf8')); } catch { return null; }
}

export function getFile(fileId: string): (StoredFile & { buf: Buffer }) | null {
  const m = fileMeta(fileId); if (!m) return null;
  return { ...m, buf: fs.readFileSync(path.join(dir(), fileId, 'data')) };
}

/** Remove a file permanently (e.g. when a knowledge base document is deleted). */
export function deleteFile(fileId: string): boolean {
  if (!ID.test(fileId)) return false;
  fs.rmSync(path.join(dir(), fileId), { recursive: true, force: true });
  return true;
}
