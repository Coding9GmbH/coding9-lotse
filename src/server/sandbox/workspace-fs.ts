import 'server-only';
// File access of the coding agent, confined to one task's worktree. No side effects on import; every call checks again.
// - a path is resolved with realpath (of the target, or of the nearest existing parent for new files) and must stay below the
//   real worktree; symlinks are never followed out of it and never written through
// - denied everywhere: .git (directory or gitfile), secrets (.env*, auth.json, keys …), config/jwt; vendor/ and node_modules/ are read-only
// - limits: read 256 KB, write 512 KB, no binary files, at most 5,000 listing entries; walks never follow symlinks
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import type { FileChangeKind } from '@/lib/protocol';
import { isSecretPath } from './sync';

export const FS_LIMITS = { read: 256 * 1024, write: 512 * 1024, list: 5000, searchHits: 200, searchMs: 3000, line: 300 } as const;

const segs = (rel: string) => rel.split('/');
/** Never readable or writable: .git, secrets, the JWT keys of a full project. */
export const isDenied = (rel: string) => segs(rel).some(s => s.toLowerCase() === '.git') || isSecretPath(rel) || /(^|\/)config\/jwt(\/|$)/.test(rel);
/** Readable, but the AI does not change dependencies. */
export const isReadOnly = (rel: string) => segs(rel).some(s => s === 'vendor' || s === 'node_modules');

const inside = (child: string, root: string) => child === root || child.startsWith(root + path.sep);
const lstat = (p: string) => { try { return fs.lstatSync(p); } catch { return null; } };

export interface Resolved {
  /** normalized relative path ('' = the worktree itself) */ rel: string;
  /** real parent directory + name: the entry itself (not followed if it is a symlink) */ abs: string;
  /** real path of the target (symlinks resolved), for reading */ real: string;
  exists: boolean;
}

/** Relative path → absolute path inside the worktree, or an error in plain German. */
export function resolveInWorkspace(root: string, relIn: string, o: { forWrite?: boolean } = {}): Resolved {
  if (typeof relIn !== 'string' || relIn.includes('\0') || relIn.includes('\\') || path.isAbsolute(relIn) || /^[a-z]:/i.test(relIn)) throw new Error('Ungültiger Pfad: nur relative Pfade im Repository (ohne „..“).');
  const n = path.posix.normalize(relIn.trim() || '.').replace(/\/+$/, '');
  const rel = n === '.' ? '' : n;
  if (rel === '..' || rel.startsWith('../') || segs(rel).includes('..')) throw new Error('Pfad außerhalb des Repositorys.');
  if (rel && isDenied(rel)) throw new Error(`Zugriff auf „${rel.slice(0, 120)}“ ist gesperrt (.git, geheime Datei oder Schlüssel).`);
  if (o.forWrite && (!rel || isReadOnly(rel))) throw new Error(rel ? `„${rel.slice(0, 120)}“ liegt in vendor/ oder node_modules/ und ist schreibgeschützt.` : 'Ungültiger Pfad.');
  const realRoot = fs.realpathSync(root);
  const abs = path.join(realRoot, rel);
  // nearest existing ancestor (for new files) must resolve inside the worktree
  let base = rel ? path.dirname(abs) : realRoot;
  const rest: string[] = [];
  while (!lstat(base)) { rest.unshift(path.basename(base)); base = path.dirname(base); }
  let realBase: string;
  try { realBase = fs.realpathSync(base); } catch { throw new Error('Pfad außerhalb des Repositorys (Symlink).'); }
  const realParent = path.join(realBase, ...rest);
  if (!inside(realParent, realRoot)) throw new Error('Pfad außerhalb des Repositorys (Symlink).');
  const entry = rel ? path.join(realParent, path.basename(abs)) : realRoot;
  const st = lstat(entry);
  let real = entry;
  if (st?.isSymbolicLink()) {
    if (o.forWrite) throw new Error(`„${rel.slice(0, 120)}“ ist ein Symlink und wird nicht geschrieben.`);
    try { real = fs.realpathSync(entry); } catch { throw new Error(`„${rel.slice(0, 120)}“ ist ein Symlink ins Leere.`); }
    if (!inside(real, realRoot)) throw new Error('Pfad außerhalb des Repositorys (Symlink).');
  }
  const realRel = path.relative(realRoot, real).split(path.sep).join('/');
  if (realRel && (isDenied(realRel) || (o.forWrite && isReadOnly(realRel)))) throw new Error(`Zugriff auf „${rel.slice(0, 120)}“ ist gesperrt.`);
  return { rel, abs: entry, real, exists: !!st };
}

/** A NUL byte in the first 8 KB counts as binary. */
export const isBinary = (buf: Buffer) => buf.subarray(0, 8192).includes(0);

export interface ListEntry { path: string; type: 'file' | 'dir' | 'link'; size?: number }
/** Entries below `dir` (depth levels deep), sorted; denied entries are left out, vendor/node_modules are not descended into unless asked for. */
export function listFiles(root: string, dir = '', depth = 3): { entries: ListEntry[]; truncated: boolean } {
  const start = resolveInWorkspace(root, dir);
  const st = fs.statSync(start.real);
  if (!st.isDirectory()) throw new Error(`„${start.rel}“ ist kein Ordner.`);
  const entries: ListEntry[] = [];
  let truncated = false;
  const walk = (absDir: string, relDir: string, level: number) => {
    for (const d of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= FS_LIMITS.list) { truncated = true; return; }
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (isDenied(rel)) continue;
      const abs = path.join(absDir, d.name);
      if (d.isSymbolicLink()) { entries.push({ path: rel, type: 'link' }); continue; }
      if (d.isDirectory()) {
        entries.push({ path: `${rel}/`, type: 'dir' });
        if (level < depth && (!isReadOnly(rel) || isReadOnly(start.rel))) walk(abs, rel, level + 1);
      } else if (d.isFile()) entries.push({ path: rel, type: 'file', size: fs.statSync(abs).size });
    }
  };
  walk(start.real, start.rel, 1);
  return { entries, truncated };
}

/** Text file (or lines from..to, 1-based inclusive) with line numbers. */
export function readText(root: string, rel: string, o: { from?: number; to?: number } = {}): { path: string; text: string; lines: number; from: number; to: number } {
  const r = resolveInWorkspace(root, rel);
  const st = r.exists ? fs.statSync(r.real) : null;
  if (!st) throw new Error(`Datei „${r.rel}“ gibt es nicht.`);
  if (!st.isFile()) throw new Error(`„${r.rel}“ ist keine Datei.`);
  if (st.size > FS_LIMITS.read) throw new Error(`„${r.rel}“ ist zu groß (${Math.round(st.size / 1024)} KB, höchstens ${FS_LIMITS.read / 1024} KB) – search_files nutzen.`);
  const buf = fs.readFileSync(r.real);
  if (isBinary(buf)) throw new Error(`„${r.rel}“ ist eine Binärdatei.`);
  const all = buf.toString('utf8').split('\n');
  const from = Math.max(1, Math.floor(o.from ?? 1)), to = Math.min(all.length, Math.floor(o.to ?? all.length));
  const width = String(to).length;
  const text = all.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(width)}│${l}`).join('\n');
  return { path: r.rel, text, lines: all.length, from, to };
}

/** Current text of a file that may be changed, or null if it does not exist yet. */
function currentText(r: Resolved): string | null {
  if (!r.exists) return null;
  const st = fs.statSync(r.real);
  if (!st.isFile()) throw new Error(`„${r.rel}“ ist keine Datei.`);
  if (st.size > FS_LIMITS.write) throw new Error(`„${r.rel}“ ist zu groß zum Bearbeiten.`);
  const buf = fs.readFileSync(r.real);
  if (isBinary(buf)) throw new Error(`„${r.rel}“ ist eine Binärdatei.`);
  return buf.toString('utf8');
}

/** Added and removed lines between two texts (multiset of lines: cheap and good enough for a card). */
export function lineDelta(before: string | null, after: string | null): { added: number; removed: number } {
  const count = (t: string | null) => { const m = new Map<string, number>(); if (t) for (const l of t.replace(/\n$/, '').split('\n')) m.set(l, (m.get(l) ?? 0) + 1); return m; };
  const a = count(before), b = count(after);
  let added = 0, removed = 0;
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) ?? 0));
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) ?? 0));
  return { added, removed };
}

export interface Change { path: string; kind: FileChangeKind; added: number; removed: number }
function writeChecked(r: Resolved, text: string) {
  if (Buffer.byteLength(text) > FS_LIMITS.write) throw new Error(`Inhalt zu groß (höchstens ${FS_LIMITS.write / 1024} KB).`);
  if (text.includes('\0')) throw new Error('Inhalt enthält NUL-Zeichen.');
  fs.mkdirSync(path.dirname(r.abs), { recursive: true });
  fs.writeFileSync(r.abs, text);
}

/** Create or overwrite a file. */
export function writeText(root: string, rel: string, content: string): Change {
  const r = resolveInWorkspace(root, rel, { forWrite: true });
  const before = currentText(r);
  writeChecked(r, content);
  return { path: r.rel, kind: before === null ? 'create' : 'edit', ...lineDelta(before, content) };
}

/** Replace old by new: old must occur exactly once (or replaceAll). */
export function editText(root: string, rel: string, oldStr: string, newStr: string, replaceAll = false): Change & { replaced: number } {
  const r = resolveInWorkspace(root, rel, { forWrite: true });
  const before = currentText(r);
  if (before === null) throw new Error(`Datei „${r.rel}“ gibt es nicht – write_file zum Anlegen nutzen.`);
  if (!oldStr) throw new Error('old_str ist leer.');
  const n = before.split(oldStr).length - 1;
  if (!n) throw new Error(`old_str kommt in „${r.rel}“ nicht vor (Leerzeichen und Zeilenumbrüche müssen exakt stimmen; vorher read_file).`);
  if (n > 1 && !replaceAll) throw new Error(`old_str kommt in „${r.rel}“ ${n}-mal vor – mehr Kontext angeben oder replace_all setzen.`);
  const after = replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, () => newStr);
  writeChecked(r, after);
  return { path: r.rel, kind: 'edit', replaced: replaceAll ? n : 1, ...lineDelta(before, after) };
}

/** Delete one file (no directories). */
export function deleteText(root: string, rel: string): Change {
  const r = resolveInWorkspace(root, rel, { forWrite: true });
  if (!r.exists) throw new Error(`Datei „${r.rel}“ gibt es nicht.`);
  const st = fs.lstatSync(r.abs);
  if (!st.isFile()) throw new Error(`„${r.rel}“ ist keine Datei (Ordner werden nicht gelöscht).`);
  const before = st.size <= FS_LIMITS.write ? fs.readFileSync(r.abs) : null;
  fs.unlinkSync(r.abs);
  return { path: r.rel, kind: 'delete', ...lineDelta(before && !isBinary(before) ? before.toString('utf8') : null, null) };
}

// The AI picks the pattern: a catastrophic one ((a+)+$ on "aaa…!") would block the event loop inside one RegExp#test call.
// Matching therefore runs in a vm context whose timeout interrupts V8 even mid-backtracking.
const scanScript = new vm.Script('(() => { const out = []; for (let i = 0; i < lines.length && out.length < max; i++) if (re.test(lines[i])) out.push(i); return out; })()');
function matchLines(re: RegExp, lines: string[], max: number, timeoutMs: number): number[] | null {
  try { return scanScript.runInContext(vm.createContext({ re, lines, max }), { timeout: Math.max(1, Math.floor(timeoutMs)) }) as number[]; }
  catch (e) { if ((e as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return null; throw e; }
}

/** Regex search over text files below `dir` (no symlinks, no denied or binary files, vendor/node_modules only if asked for).
 *  Time cap: between entries and, via matchLines, inside a single match. */
export function searchFiles(root: string, pattern: string, o: { dir?: string; glob?: string; ignoreCase?: boolean; now?: () => number } = {}): { hits: string[]; truncated: boolean; files: number } {
  if (!pattern || pattern.length > 500) throw new Error('Suchmuster fehlt oder ist zu lang.');
  let re: RegExp;
  try { re = new RegExp(pattern, o.ignoreCase ? 'i' : ''); } catch (e) { throw new Error(`Ungültiger regulärer Ausdruck: ${(e as Error).message}`); }
  const nameRe = o.glob ? globRe(o.glob) : null;
  const start = resolveInWorkspace(root, o.dir ?? '');
  const now = o.now ?? Date.now, end = now() + FS_LIMITS.searchMs;
  const hits: string[] = [];
  let truncated = false, files = 0;
  const walk = (absDir: string, relDir: string) => {
    for (const d of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      if (now() > end) { truncated = true; return; }
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (isDenied(rel) || d.isSymbolicLink()) continue;
      const abs = path.join(absDir, d.name);
      if (d.isDirectory()) { if (!isReadOnly(rel) || isReadOnly(start.rel)) walk(abs, rel); continue; }
      if (!d.isFile() || (nameRe && !nameRe.test(rel))) continue;
      if (fs.statSync(abs).size > FS_LIMITS.read) continue;
      const buf = fs.readFileSync(abs);
      if (isBinary(buf)) continue;
      files++;
      const lines = buf.toString('utf8').split('\n').map(l => (l.length > 2000 ? l.slice(0, 2000) : l));
      const found = matchLines(re, lines, FS_LIMITS.searchHits - hits.length + 1, end - now());
      if (!found) { truncated = true; return; }
      for (const i of found) {
        if (hits.length >= FS_LIMITS.searchHits) { truncated = true; return; }
        hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, FS_LIMITS.line)}`);
      }
    }
  };
  const st = fs.statSync(start.real);
  if (st.isDirectory()) walk(start.real, start.rel);
  else throw new Error(`„${start.rel}“ ist kein Ordner.`);
  return { hits, truncated, files };
}

/** Simple glob on the relative path: * (no slash), ** (anything), ? (one character); without a slash it matches the file name. */
export function globRe(glob: string): RegExp {
  const src = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  return new RegExp(glob.includes('/') ? `^${src}$` : `(^|/)${src}$`);
}
