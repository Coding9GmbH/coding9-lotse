import 'server-only';
// Datei-Anhänge aus dem Chat (CSV, Excel, PDF, Text …): liegen lokal im Datenverzeichnis, nie im Shop.
// Feature-Module lesen sie über getFile(fileId) – z. B. Lieferanten-Import oder Wissensbasis.
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

const dir = () => path.join(dataDir(), 'files');
const ID = /^f_[0-9a-f]{20}$/;
const ext = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();

/** Typ anhand der Endung (Browser liefern für CSV/Excel oft leere oder falsche MIME-Typen). null = nicht erlaubt. */
export function fileType(name: string): string | null { return FILE_TYPES[ext(name)] ?? null; }

export function saveFile(buf: Buffer, name: string): StoredFile {
  const mime = fileType(name); if (!mime) throw new Error(`Dateityp .${ext(name) || '?'} wird nicht unterstützt (erlaubt: ${Object.keys(FILE_TYPES).join(', ')})`);
  if (buf.length > FILE_LIMIT) throw new Error('Datei größer als 25 MB');
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

/** Datei endgültig entfernen (z. B. wenn ein Wissensdokument gelöscht wird). */
export function deleteFile(fileId: string): boolean {
  if (!ID.test(fileId)) return false;
  fs.rmSync(path.join(dir(), fileId), { recursive: true, force: true });
  return true;
}
