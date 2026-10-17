// Minimal tar writer (ustar + PAX path records for long names) for Docker's archive API.
// Regular files, directories and symlinks; owner, group and mtime are fixed by the caller.

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
