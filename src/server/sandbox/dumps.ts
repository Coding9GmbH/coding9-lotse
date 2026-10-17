import 'server-only';
// Uploaded database dumps for Sandbox Coding: a sanitized .sql/.sql.gz, uploaded in resumable chunks, imported into one task's
// container and deleted right afterwards (also on failure, on task finish, after 24 h and by the startup sweep).
// Files live in <data>/dumps/<d_…>/data (mode 0600, outside every workspace, excluded from backups); nothing returns their content.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { DumpPublic } from '@/lib/protocol';
import { codeDumpGet, codeDumpPut, codeDumpsLive, dataDir, type CodeDumpRow } from '../db';
import { singleton } from '../state';

export const DUMP_ID = /^d_[a-z0-9]{16}$/;
/** File name as shown (never a path): letters, digits, . _ -, ending in .sql or .sql.gz */
const DUMP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
export const CHUNK_MAX = 16 * 1024 * 1024;
export const DUMP_TTL_MS = 24 * 3600_000;
const MAX_LIVE = 10;

export class DumpError extends Error { constructor(message: string, readonly status: number, readonly extra: Record<string, unknown> = {}) { super(message); } }

/** LOTSE_DUMP_MAX_MB: largest dump (default 2048 MB). */
export const dumpMaxBytes = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.LOTSE_DUMP_MAX_MB);
  return (env.LOTSE_DUMP_MAX_MB?.trim() && Number.isFinite(n) && n >= 1 ? Math.min(n, 65536) : 2048) * 1024 * 1024;
};

const root = () => path.join(dataDir(), 'dumps');
const assertDumpId = (id: string) => { if (typeof id !== 'string' || !DUMP_ID.test(id)) throw new DumpError('Ungültige Dump-ID.', 400); return id; };
export const dumpFile = (id: string) => path.join(root(), assertDumpId(id), 'data');
const newDumpId = () => `d_${Array.from(crypto.randomBytes(16), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;
const fileSize = (id: string) => { try { return fs.statSync(dumpFile(id)).size; } catch { return 0; } };

export function getDump(id: string): CodeDumpRow {
  const d = codeDumpGet(assertDumpId(id));
  if (!d) throw new DumpError('Dump nicht gefunden.', 404);
  return d;
}
/** Metadata for the browser: never the content, never the host path. */
export const publicDump = (d: CodeDumpRow): DumpPublic => ({
  id: d.id, name: d.name, size: d.size, received: d.status === 'uploading' ? fileSize(d.id) : d.status === 'ready' ? d.size : 0,
  status: d.status, sha256: d.sha256, taskId: d.taskId, expiresAt: d.expiresAt,
});

export function createDump(name: string, size: number, now = Date.now()): CodeDumpRow {
  const n = String(name ?? '').trim();
  if (!DUMP_NAME.test(n) || n.includes('..') || !/\.sql(\.gz)?$/i.test(n)) throw new DumpError('Ungültiger Dateiname: erwartet wird eine .sql- oder .sql.gz-Datei (Buchstaben, Ziffern, . _ -).', 400);
  if (!Number.isInteger(size) || size < 1) throw new DumpError('Ungültige Dateigröße.', 400);
  const max = dumpMaxBytes();
  if (size > max) throw new DumpError(`Dump zu groß (höchstens ${Math.round(max / 1048576)} MB, LOTSE_DUMP_MAX_MB).`, 413);
  if (codeDumpsLive().length >= MAX_LIVE) throw new DumpError(`Es liegen bereits ${MAX_LIVE} Dumps bereit – erst importieren oder verwerfen.`, 409);
  const id = newDumpId(), file = dumpFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(file, 'wx', 0o600));
  fs.chmodSync(file, 0o600);
  const d: CodeDumpRow = { id, taskId: null, name: n, size, sha256: null, status: 'uploading', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + DUMP_TTL_MS).toISOString(), deletedAt: null };
  codeDumpPut(d);
  return d;
}

const busy = () => singleton('sandboxDumpUploads', () => new Set<string>());

/** One chunk at `offset` (must equal the bytes received so far, else 409). Streams to disk without buffering; the chunk limit
 *  (16 MB) and the declared size are enforced while streaming (413). Optional sha256 of the chunk (hex). On any error the file is
 *  cut back to `offset`, so the upload can resume there. */
export async function appendChunk(id: string, offset: number, body: ReadableStream<Uint8Array> | Readable | null, o: { length?: number | null; sha256?: string | null } = {}): Promise<{ received: number }> {
  const d = getDump(id);
  if (d.status !== 'uploading') throw new DumpError('Dieser Dump nimmt keine Daten mehr an.', 409);
  const received = fileSize(id);
  if (!Number.isInteger(offset) || offset !== received) throw new DumpError(`Falscher Offset: ${received} Bytes sind bereits angekommen.`, 409, { received });
  if (o.length != null && o.length > CHUNK_MAX) throw new DumpError('Teilstück zu groß (höchstens 16 MB).', 413, { received });
  if (o.length != null && offset + o.length > d.size) throw new DumpError('Mehr Daten als angekündigt.', 413, { received });
  if (o.sha256 != null && !/^[0-9a-f]{64}$/.test(o.sha256)) throw new DumpError('Ungültige Prüfsumme.', 400, { received });
  if (!body) throw new DumpError('Keine Daten.', 400, { received });
  const B = busy();
  if (B.has(id)) throw new DumpError('Für diesen Dump läuft bereits ein Teil-Upload.', 409, { received });
  B.add(id);
  const hash = crypto.createHash('sha256');
  let n = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > CHUNK_MAX) return cb(new DumpError('Teilstück zu groß (höchstens 16 MB).', 413, { received }));
      if (offset + n > d.size) return cb(new DumpError('Mehr Daten als angekündigt.', 413, { received }));
      hash.update(chunk); cb(null, chunk);
    },
  });
  try {
    const src = body instanceof Readable ? body : Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
    await pipeline(src, limit, fs.createWriteStream(dumpFile(id), { flags: 'r+', start: offset, mode: 0o600 }));
    if (o.length != null && n !== o.length) throw new DumpError('Teilstück unvollständig angekommen.', 400, { received });
    if (o.sha256 && hash.digest('hex') !== o.sha256) throw new DumpError('Prüfsumme des Teilstücks stimmt nicht.', 422, { received });
    return { received: offset + n };
  } catch (e) {
    try { fs.truncateSync(dumpFile(id), offset); } catch { /* deleted meanwhile */ }
    if (e instanceof DumpError) throw e;
    throw new DumpError(`Upload abgebrochen: ${(e as Error).message}`, 400, { received });
  } finally { B.delete(id); }
}

/** Plain SQL text as mysqldump/mariadb-dump writes it (comments, SET, CREATE …), no binary. */
export function looksLikeSql(head: Buffer): boolean {
  if (!head.length || head.includes(0)) return false;
  return /^\s*(--|\/\*|SET\s|CREATE\s|DROP\s|INSERT\s|USE\s|LOCK\s|START\s|BEGIN)/i.test(head.subarray(0, 4096).toString('utf8'));
}
const isGzip = (b: Buffer) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/** The decompressed (if gzip) beginning of a dump file. */
async function sqlHead(file: string, bytes = 8192): Promise<Buffer> {
  const fd = fs.openSync(file, 'r');
  const magic = Buffer.alloc(2);
  try { fs.readSync(fd, magic, 0, 2, 0); } finally { fs.closeSync(fd); }
  const src = fs.createReadStream(file);
  const stream = isGzip(magic) ? src.pipe(zlib.createGunzip()) : src;
  const parts: Buffer[] = []; let n = 0;
  try {
    for await (const c of stream as AsyncIterable<Buffer>) { parts.push(c); n += c.length; if (n >= bytes) break; }
  } catch { /* broken gzip: what was read so far is checked */ } finally { src.destroy(); }
  return Buffer.concat(parts).subarray(0, bytes);
}

/** All bytes there: size, optional sha256 of the whole file and the magic (gzip or SQL) are checked. Bad content deletes the dump. */
export async function completeDump(id: string, sha256?: string | null): Promise<CodeDumpRow> {
  const d = getDump(id);
  if (d.status === 'ready') return d;
  if (d.status !== 'uploading') throw new DumpError('Dump ist bereits gelöscht.', 409);
  if (busy().has(id)) throw new DumpError('Ein Teil-Upload läuft noch.', 409);
  const received = fileSize(id);
  if (received !== d.size) throw new DumpError(`Unvollständig: ${received} von ${d.size} Bytes.`, 409, { received });
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(dumpFile(id)), new Transform({ transform(c: Buffer, _e, cb) { hash.update(c); cb(); } }));
  const sum = hash.digest('hex');
  if (sha256 && sha256.toLowerCase() !== sum) { deleteDump(id); throw new DumpError('Prüfsumme stimmt nicht – Dump verworfen, bitte erneut hochladen.', 422); }
  if (!looksLikeSql(await sqlHead(dumpFile(id)))) { deleteDump(id); throw new DumpError('Kein SQL-Dump: erwartet wird eine .sql- oder .sql.gz-Datei aus mysqldump/mariadb-dump.', 415); }
  const done: CodeDumpRow = { ...d, sha256: sum, status: 'ready' };
  codeDumpPut(done);
  return done;
}

/** Deletes the file and marks the row deleted. Idempotent; unknown or invalid ids are ignored. */
export function deleteDump(id: string, now = Date.now()): void {
  if (!DUMP_ID.test(id)) return;
  fs.rmSync(path.join(root(), id), { recursive: true, force: true });
  const d = codeDumpGet(id);
  if (d && d.status !== 'deleted') codeDumpPut({ ...d, status: 'deleted', deletedAt: new Date(now).toISOString() });
}
export const deleteTaskDumps = (taskId: string) => { for (const d of codeDumpsLive(taskId)) deleteDump(d.id); };

/** Binds a complete dump to a task (a dump belongs to at most one task). */
export function attachDump(id: string, taskId: string): CodeDumpRow {
  const d = getDump(id);
  if (d.status !== 'ready') throw new DumpError(d.status === 'uploading' ? 'Der Dump ist noch nicht vollständig hochgeladen.' : 'Der Dump ist bereits gelöscht.', 409);
  if (d.taskId && d.taskId !== taskId) throw new DumpError('Der Dump gehört zu einer anderen Aufgabe.', 409);
  const next = { ...d, taskId };
  codeDumpPut(next);
  return next;
}

/** The task that held it was not created after all: the upload can be used again. */
export function releaseDump(id: string): void {
  const d = codeDumpGet(id);
  if (d && d.status === 'ready') codeDumpPut({ ...d, taskId: null });
}

/** Host path of a ready dump of this task (server only: the import step streams it into the container). */
export function dumpPathFor(id: string, taskId: string): string {
  const d = getDump(id);
  if (d.status !== 'ready' || d.taskId !== taskId) throw new DumpError('Der Dump ist nicht mehr vorhanden – bitte erneut hochladen („Datenbank ersetzen“).', 409);
  return dumpFile(id);
}

/** Shopware major.minor from the core migrations recorded in the dump (Shopware\Core\Migration\V6_6\… → "6.6"). null = unknown. */
export async function dumpShopwareVersion(file: string): Promise<string | null> {
  const fd = fs.openSync(file, 'r');
  const magic = Buffer.alloc(2);
  try { fs.readSync(fd, magic, 0, 2, 0); } finally { fs.closeSync(fd); }
  const src = fs.createReadStream(file);
  const stream: AsyncIterable<Buffer> = isGzip(magic) ? src.pipe(zlib.createGunzip()) : src;
  const RE = /Core\\+Migration\\+V(\d+)_(\d+)\\+/g;
  let best: [number, number] | null = null, inMigration = false, rest = '';
  try {
    for await (const c of stream) {
      const text = rest + c.toString('latin1');
      const lines = text.split('\n');
      rest = lines.pop() ?? '';
      if (rest.length > 4 * 1024 * 1024) rest = rest.slice(-1024); // a very long line is never the migration table's
      for (const l of lines) {
        if (!l.startsWith('INSERT INTO `migration`')) { if (inMigration && l.startsWith('INSERT INTO')) return fmt(best); continue; }
        inMigration = true;
        for (const m of l.matchAll(RE)) { const v: [number, number] = [Number(m[1]), Number(m[2])]; if (!best || v[0] > best[0] || (v[0] === best[0] && v[1] > best[1])) best = v; }
      }
    }
  } finally { src.destroy(); }
  return fmt(best);
}
const fmt = (v: [number, number] | null) => (v ? `${v[0]}.${v[1]}` : null);

/** Startup and interval: expired dumps, dumps of finished or deleted tasks, directories without a row and rows without a file. */
export function sweepDumps(taskStatus: (taskId: string) => string | null, now = Date.now()): string[] {
  const removed: string[] = [];
  for (const d of codeDumpsLive()) {
    const status = d.taskId ? taskStatus(d.taskId) : 'none';
    const gone = !fs.existsSync(dumpFile(d.id));
    if (gone || Date.parse(d.expiresAt) <= now || status === null || status === 'done') { deleteDump(d.id, now); removed.push(d.id); }
  }
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root()); } catch { /* no dumps yet */ }
  for (const name of dirs) {
    const row = DUMP_ID.test(name) ? codeDumpGet(name) : null;
    if (!row || row.status === 'deleted') { fs.rmSync(path.join(root(), name), { recursive: true, force: true }); if (!removed.includes(name)) removed.push(name); }
  }
  return removed;
}
