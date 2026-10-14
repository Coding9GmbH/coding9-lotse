// Schutz vor Zip-Bomben: xlsx/docx sind ZIP-Archive. exceljs/mammoth (JSZip) entpacken ohne Obergrenze im Speicher.
// Vor dem Parsen: zentrales Verzeichnis lesen (Anzahl, angegebene Größen) und jeden Eintrag einmal zählend entpacken
// (gestreamt, ohne Speichern) – angegebene Größen können lügen, die tatsächlich entpackte Menge nicht. Keine Abhängigkeiten.
import zlib from 'node:zlib';

export const ZIP_LIMITS = { total: 200 * 1024 * 1024, entries: 10_000, ratio: 200, ratioMin: 50 * 1024 * 1024 };
type Limits = typeof ZIP_LIMITS;
interface Entry { name: string; method: number; comp: number; size: number; local: number }

const bad = (msg: string) => new Error(`Datei abgelehnt: ${msg}`);
const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** Einträge aus dem zentralen Verzeichnis (inkl. ZIP64) */
export function zipEntries(buf: Buffer, maxEntries = ZIP_LIMITS.entries): Entry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad('kein gültiges ZIP-Archiv (Ende des Verzeichnisses fehlt)');
  let count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  if ((count === 0xffff || cdOff === 0xffffffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) { // ZIP64
    const z = Number(buf.readBigUInt64LE(eocd - 12));
    if (z + 56 > buf.length || buf.readUInt32LE(z) !== 0x06064b50) throw bad('ZIP64-Verzeichnis beschädigt');
    count = Number(buf.readBigUInt64LE(z + 32)); cdOff = Number(buf.readBigUInt64LE(z + 48));
  }
  if (count > maxEntries) throw bad(`zu viele Einträge im Archiv (${count}, höchstens ${maxEntries})`);
  const out: Entry[] = [];
  for (let p = cdOff, i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('ZIP-Verzeichnis beschädigt');
    const method = buf.readUInt16LE(p + 10), nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    let comp = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24), local = buf.readUInt32LE(p + 42);
    // ZIP64-Zusatzfeld (0x0001): Werte nur für die Felder, die 0xFFFFFFFF sind, in fester Reihenfolge
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end && x + 4 <= buf.length; ) {
      const id = buf.readUInt16LE(x), len = buf.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4; const next = () => { const v = q + 8 <= x + 4 + len && q + 8 <= buf.length ? Number(buf.readBigUInt64LE(q)) : 0; q += 8; return v; };
        if (size === 0xffffffff) size = next(); if (comp === 0xffffffff) comp = next(); if (local === 0xffffffff) local = next();
      }
      x += 4 + len;
    }
    out.push({ name: buf.toString('utf8', p + 46, Math.min(buf.length, p + 46 + nameLen)), method, comp, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Entpackt einen Deflate-Strom zählend (nichts wird behalten); bricht beim Überschreiten von limit ab */
function inflatedSize(data: Buffer, limit: number, tooBig: () => Error): Promise<number> {
  return new Promise((resolve, reject) => {
    const z = zlib.createInflateRaw(); let n = 0, done = false;
    const fin = (e: Error | null, v = 0) => { if (done) return; done = true; if (e) { z.destroy(); reject(e); } else resolve(v); };
    z.on('data', (c: Buffer) => { n += c.length; if (n > limit) fin(tooBig()); });
    z.on('end', () => fin(null, n));
    z.on('error', () => fin(bad('ZIP-Eintrag beschädigt')));
    z.end(data);
  });
}

/** Wirft, wenn das Archiv entpackt zu groß wird, zu viele Einträge hat oder absurd stark komprimiert ist. */
export async function assertSafeZip(buf: Buffer, lim: Limits = ZIP_LIMITS): Promise<void> {
  const entries = zipEntries(buf, lim.entries);
  const declared = entries.reduce((n, e) => n + e.size, 0);
  if (declared > lim.total) throw bad(`entpackt ${MB(declared)}, höchstens ${MB(lim.total)} erlaubt`);
  let total = 0; const tooBig = () => bad(`entpackt größer als ${MB(lim.total)} (Zip-Bombe?)`);
  for (const e of entries) {
    if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw bad('ZIP-Eintrag beschädigt');
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28), data = buf.subarray(start, start + e.comp);
    if (e.method === 0) total += data.length;
    else if (e.method === 8) total += await inflatedSize(data, lim.total - total, tooBig);
    else throw bad(`unbekannte Kompression (${e.method}) in ${e.name}`);
    if (total > lim.total) throw tooBig();
  }
  if (total > lim.ratioMin && total / Math.max(1, buf.length) > lim.ratio) throw bad(`ungewöhnlich stark komprimiert (${Math.round(total / buf.length)}:1)`);
}
