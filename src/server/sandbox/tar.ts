// Minimal tar writer (ustar + PAX path records for long names) for Docker's archive API.
// Regular files, directories and symlinks; owner, group and mtime are fixed by the caller. Plus a minimal reader (screenshots, tests).
import { Readable } from 'node:stream';

export interface TarEntry { path: string; type: 'file' | 'dir' | 'symlink'; data?: Buffer; mode?: number; linkTarget?: string }
export interface TarOwner { uid: number; gid: number; uname: string; gname: string; mtime?: number }

const BLOCK = 512;
const oct = (n: number, len: number) => `${n.toString(8).padStart(len - 1, '0')}\0`;
const pad = (n: number) => (n % BLOCK ? BLOCK - (n % BLOCK) : 0);

/** One header block; name/prefix split at a '/' when the path fits ustar, otherwise the caller writes a PAX record first. */
function header(name: string, prefix: string, size: number, typeflag: string, mode: number, o: TarOwner, link = ''): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(oct(mode & 0o7777, 8), 100, 'ascii');
  h.write(oct(o.uid, 8), 108, 'ascii');
  h.write(oct(o.gid, 8), 116, 'ascii');
  h.write(oct(size, 12), 124, 'ascii');
  h.write(oct(Math.floor(o.mtime ?? Date.now() / 1000), 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(typeflag, 156, 'ascii');
  h.write(link, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(o.uname, 265, 32, 'utf8');
  h.write(o.gname, 297, 32, 'utf8');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

/** ustar split: name ≤ 100 bytes, prefix ≤ 155 bytes; null = needs a PAX record. */
function split(p: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(p) <= 100) return { name: p, prefix: '' };
  for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) {
    const prefix = p.slice(0, i), name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { name, prefix };
  }
  return null;
}
/** PAX record "<len> key=value\n", where len counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len++;
  return `${len}${body}`;
}

export function writeTar(entries: TarEntry[], owner: TarOwner): Buffer {
  const out: Buffer[] = [];
  for (const e of entries) {
    const p = e.type === 'dir' ? `${e.path.replace(/\/+$/, '')}/` : e.path;
    const data = e.type === 'file' ? e.data ?? Buffer.alloc(0) : Buffer.alloc(0);
    const link = e.linkTarget ?? '';
    const s = split(p);
    if (!s || Buffer.byteLength(link) > 100) {
      const pax = Buffer.from((s ? '' : paxRecord('path', p)) + (Buffer.byteLength(link) > 100 ? paxRecord('linkpath', link) : ''), 'utf8');
      out.push(header('PaxHeader', '', pax.length, 'x', 0o644, owner), pax, Buffer.alloc(pad(pax.length)));
    }
    const { name, prefix } = s ?? { name: p.slice(-100), prefix: '' };
    const type = e.type === 'file' ? '0' : e.type === 'dir' ? '5' : '2';
    const mode = e.mode ?? (e.type === 'dir' ? 0o755 : e.type === 'symlink' ? 0o777 : 0o644);
    out.push(header(name, prefix, data.length, type, mode, owner, Buffer.byteLength(link) > 100 ? '' : link));
    if (data.length) out.push(data, Buffer.alloc(pad(data.length)));
  }
  out.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(out);
}

/** A directory with one large file, streamed (the file is never held in memory): `<dir>/` + `<dir>/<name>`. length = exact archive size. */
export function streamFileTar(dir: string, name: string, size: number, src: AsyncIterable<Buffer>, owner: TarOwner, mode = 0o600): { stream: Readable; length: number } {
  const d = `${dir.replace(/\/+$/, '')}/`, f = `${d}${name}`;
  if (Buffer.byteLength(f) > 100) throw new Error('Pfad im Archiv zu lang.');
  const head = Buffer.concat([header(d, '', 0, '5', 0o700, owner), header(f, '', size, '0', mode, owner)]);
  const tail = Buffer.alloc(pad(size) + BLOCK * 2);
  async function* gen() {
    yield head;
    let n = 0;
    for await (const c of src) { n += c.length; if (n > size) throw new Error('Datei ist größer als angegeben.'); yield c; }
    if (n !== size) throw new Error('Datei ist kleiner als angegeben.');
    yield tail;
  }
  return { stream: Readable.from(gen(), { objectMode: false }), length: head.length + size + tail.length };
}

export interface TarRecord { path: string; type: 'file' | 'dir' | 'symlink' | 'other'; data: Buffer; uid: number; gid: number; mode: number; linkTarget: string }
/** Minimal tar reader (ustar + PAX path/linkpath): every entry with owner and mode. */
export function readTarEntries(tar: Buffer): TarRecord[] {
  const out: TarRecord[] = [];
  let pax: Record<string, string> = {};
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const str = (a: number, b: number) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const num = (a: number, b: number) => parseInt(str(a, b).trim() || '0', 8);
    const name = str(0, 100), prefix = str(345, 500), size = num(124, 136), type = String.fromCharCode(h[156] || 48);
    const data = Buffer.from(tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = Object.fromEntries(data.toString('utf8').split('\n').filter(Boolean).map(l => { const kv = l.slice(l.indexOf(' ') + 1); const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; })); continue; }
    const full = pax.path ?? (prefix ? `${prefix}/${name}` : name);
    out.push({ path: full.replace(/\/$/, ''), type: type === '0' ? 'file' : type === '5' ? 'dir' : type === '2' ? 'symlink' : 'other', data, uid: num(108, 116), gid: num(116, 124), mode: num(100, 108), linkTarget: pax.linkpath ?? str(157, 257) });
    pax = {};
  }
  return out;
}
/** Regular files only. */
export const readTar = (tar: Buffer): { path: string; data: Buffer }[] => readTarEntries(tar).filter(e => e.type === 'file').map(({ path, data }) => ({ path, data }));

// ---- Untrusted archives (container → host) ----
export interface StrictLimits { /** entries (directories included) */ entries: number; /** bytes of one file */ fileBytes: number; /** bytes of all files */ totalBytes: number }
/** One entry of an untrusted archive: a regular file or a directory with a clean relative path; anything else is `refused` with its type. */
export interface StrictEntry { path: string; type: 'file' | 'dir'; data: Buffer; mode: number }
export interface StrictRefused { path: string; type: 'symlink' | 'hardlink' | 'device' | 'fifo' | 'other' }
export class TarError extends Error {}
/** A clean relative archive path: no absolute path, no "..", no empty or "." segments inside, no NUL/control characters, no backslash. */
export function archivePath(raw: string): string | null {
  const p = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!p || p.length > 4096 || p.startsWith('/') || p.includes('\\') || /[\x00-\x1f\x7f]/.test(p) || p.includes('�')) return null;
  return p.split('/').some(s => !s || s === '.' || s === '..') ? null : p;
}
const KINDS: Record<string, StrictRefused['type']> = { 1: 'hardlink', 2: 'symlink', 3: 'device', 4: 'device', 6: 'fifo' };
/**
 * Reader for archives whose content the other side controls (getArchive of a task container: code running as www-data there can create
 * anything). Every header's checksum is verified, sizes are plain octal (no base-256), the counts and sizes are capped before data is
 * copied, PAX records only for path/linkpath (size, uid … in PAX are refused), GNU long names, global headers and sparse files are refused.
 * Paths must be clean and relative (archivePath); links, devices and FIFOs are never returned as content, only listed as refused.
 */
export function readTarStrict(tar: Buffer, lim: StrictLimits): { entries: StrictEntry[]; refused: StrictRefused[] } {
  const entries: StrictEntry[] = [], refused: StrictRefused[] = [];
  let pax: Record<string, string> = {}, total = 0, count = 0, off = 0, ended = false;
  const octal = (h: Buffer, a: number, b: number, what: string) => {
    if (h[a] & 0x80) throw new TarError(`Archiv: ${what} im Binärformat wird nicht gelesen.`);
    const s = h.subarray(a, b).toString('latin1').replace(/\0.*$/s, '').trim();
    if (!/^[0-7]*$/.test(s) || s.length > 12) throw new TarError(`Archiv: ungültiges Feld ${what}.`);
    return s ? parseInt(s, 8) : 0;
  };
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every(b => b === 0)) { ended = true; break; }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (octal(h, 148, 156, 'Prüfsumme') !== sum) throw new TarError('Archiv: Prüfsumme eines Eintrags stimmt nicht.');
    const type = String.fromCharCode(h[156] || 48), size = octal(h, 124, 136, 'Größe');
    if (++count > lim.entries * 2 + 4) throw new TarError(`Archiv: zu viele Einträge (höchstens ${lim.entries}).`);
    const end = off + BLOCK + size;
    if (end > tar.length) throw new TarError('Archiv ist abgeschnitten.');
    const str = (a: number, b: number) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    if (type === 'x') {
      if (size > 64 * 1024) throw new TarError('Archiv: PAX-Kopf zu groß.');
      pax = {};
      const text = tar.subarray(off + BLOCK, end).toString('utf8');
      for (let i = 0; i < text.length;) {
        const sp = text.indexOf(' ', i), len = Number(text.slice(i, sp));
        if (sp < 0 || !Number.isInteger(len) || len <= 0 || i + len > text.length) throw new TarError('Archiv: ungültiger PAX-Kopf.');
        const rec = text.slice(sp + 1, i + len - 1), eq = rec.indexOf('=');
        const k = rec.slice(0, eq), v = rec.slice(eq + 1);
        if (eq < 0) throw new TarError('Archiv: ungültiger PAX-Kopf.');
        if (k === 'path' || k === 'linkpath') pax[k] = v;
        else if (!/^(mtime|atime|ctime|uname|gname|uid|gid|comment|SCHILY\.[a-z.]+|LIBARCHIVE\.[a-z.]+)$/.test(k)) throw new TarError(`Archiv: PAX-Feld „${k.slice(0, 40)}“ wird nicht unterstützt.`);
        i += len;
      }
      off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    const name = str(0, 100), prefix = str(345, 500);
    const raw = pax.path ?? (prefix ? `${prefix}/${name}` : name);
    pax = {};
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    const p = archivePath(raw);
    if (!p) throw new TarError(`Archiv: unsicherer Pfad „${raw.slice(0, 120).replace(/[\x00-\x1f\x7f]/g, '?')}“.`);
    if (entries.length + refused.length >= lim.entries) throw new TarError(`Archiv: zu viele Einträge (höchstens ${lim.entries}).`);
    if (type === '0' || type === '7') {
      if (size > lim.fileBytes) throw new TarError(`Archiv: „${p.slice(0, 120)}“ ist zu groß.`);
      total += size;
      if (total > lim.totalBytes) throw new TarError('Archiv: Inhalt zu groß.');
      entries.push({ path: p, type: 'file', data: Buffer.from(tar.subarray(end - size, end)), mode: octal(h, 100, 108, 'Modus') & 0o7777 });
    } else if (type === '5') {
      if (size) throw new TarError('Archiv: Ordner mit Inhalt.');
      entries.push({ path: p, type: 'dir', data: Buffer.alloc(0), mode: octal(h, 100, 108, 'Modus') & 0o7777 });
    } else if (KINDS[type]) refused.push({ path: p, type: KINDS[type] });
    else throw new TarError(`Archiv: Eintragstyp „${type.replace(/[^\x20-\x7e]/g, '?')}“ wird nicht gelesen.`);
  }
  if (!ended && off < tar.length) throw new TarError('Archiv ist abgeschnitten.');
  return { entries, refused };
}
