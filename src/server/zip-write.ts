// Minimal ZIP writer (no dependencies): directories and files, deflated (or stored when that is not smaller), UTF-8 names,
// Unix permissions. Produced entry by entry as a web stream, so a route can send it while it is built. No ZIP64: callers keep
// archives far below 4 GB (and below 65,535 entries).
import fs from 'node:fs';
import zlib from 'node:zlib';

export interface ZipEntry {
  /** path inside the archive with "/" separators; a directory ends with "/" */ name: string;
  /** file contents on demand (read when the entry is written); absent for a directory */ data?: () => Buffer;
  mtime?: Date;
}
export const ZIP_MAX_ENTRIES = 65_000;

/** MS-DOS date and time (local time, 2-second resolution, 1980 at the earliest). */
function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

/** The archive as a stream of chunks: one local header + data per entry, then the central directory. Throws (errors the stream)
 *  for invalid names; an entry whose data() throws errors the stream too. */
export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error(`Zu viele Einträge für ein ZIP (${entries.length}).`);
  const central: Buffer[] = [];
  let offset = 0, i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= entries.length) {
        const cd = Buffer.concat(central), end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
        end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
        controller.enqueue(new Uint8Array(Buffer.concat([cd, end])));
        controller.close();
        return;
      }
      const e = entries[i++];
      const name = Buffer.from(e.name, 'utf8');
      if (!e.name || e.name.startsWith('/') || e.name.split('/').includes('..') || e.name.includes('\\') || name.length > 0xffff) throw new Error('Ungültiger Name im ZIP.');
      const dir = e.name.endsWith('/');
      const raw = dir ? Buffer.alloc(0) : (e.data?.() ?? Buffer.alloc(0));
      const deflated = raw.length ? zlib.deflateRawSync(raw, { level: 6 }) : raw;
      const method = deflated.length < raw.length ? 8 : 0, body = method === 8 ? deflated : raw;
      const crc = zlib.crc32(raw) >>> 0, { time, date } = dosTime(e.mtime ?? new Date());
      if (offset + 30 + name.length + body.length > 0xfffffffe) throw new Error('ZIP zu groß.');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE((3 << 8) | 20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
      cen.writeUInt16LE(method, 10); cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14); cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(name.length, 28);
      cen.writeUInt32LE((((dir ? 0o40755 : 0o100644) << 16) | (dir ? 0x10 : 0)) >>> 0, 38); cen.writeUInt32LE(offset, 42);
      central.push(cen, name);
      offset += 30 + name.length + body.length;
      controller.enqueue(new Uint8Array(Buffer.concat([local, name, body])));
    },
  });
}

/** A file entry read from disk when it is written. */
export const fileEntry = (name: string, abs: string, mtime?: Date): ZipEntry => ({ name, data: () => fs.readFileSync(abs), mtime });
