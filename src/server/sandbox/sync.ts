import 'server-only';
// Workspace → container: Lotse mirrors the cloned repository into the plugin directory as a tar archive (Docker archive API),
// owned by www-data. No host paths are mounted. Never synced: .git (the git dir lives outside the worktree anyway),
// secret files (.env, keys, auth.json …), node_modules and symlinks that point outside the workspace.
// Deletions in the container only with the fixed argv ['rm', '-f', '--', <target>/<guarded relative path>].
import fs from 'node:fs';
import path from 'node:path';
import type { SandboxRunner } from './runner';
import { writeTar, type TarEntry } from './tar';

export const WWW_DATA = { uid: 33, gid: 33, uname: 'www-data', gname: 'www-data' } as const;
const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;

const SECRET_NAMES = /^(\.env(\..+)?|auth\.json|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.+\.(pem|key|p12|pfx|jks|keystore))$/i;
const SAFE_ENV = /^\.env\.(dist|example|sample|template)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** Files that never leave the workspace (also denied to the AI later): .env*, keys, credentials. */
export const isSecretPath = (rel: string) => rel.split('/').some(seg => SECRET_NAMES.test(seg) && !SAFE_ENV.test(seg));
/** .git, node_modules or a secret anywhere in the path. */
export const isExcluded = (rel: string) => rel.split('/').some(seg => SKIP_DIRS.has(seg)) || isSecretPath(rel);

/** Relative path inside the workspace: normalized, no "..", not absolute, no NUL, not excluded. Throws otherwise. */
export function guardRel(rel: string): string {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.startsWith('/') || rel.includes('\\')) throw new Error('Ungültiger Pfad.');
  const n = path.posix.normalize(rel).replace(/\/+$/, '');
  if (!n || n === '.' || n === '..' || n.startsWith('../') || n.split('/').includes('..')) throw new Error('Pfad außerhalb des Arbeitsordners.');
  if (isExcluded(n)) throw new Error(`Pfad „${n.slice(0, 120)}“ wird nicht übertragen (.git, node_modules oder geheime Datei).`);
  return n;
}

const inside = (child: string, parent: string) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

/** One workspace entry as tar entry below `prefix`; null = skipped (excluded, outside symlink, special file). */
function entryFor(root: string, rel: string, prefix: string): TarEntry | null {
  const abs = path.join(root, rel);
  const st = fs.lstatSync(abs);
  const p = `${prefix}/${rel}`;
  if (st.isSymbolicLink()) {
    const link = fs.readlinkSync(abs);
    let real: string;
    try { real = fs.realpathSync(abs); } catch { return null; } // dangling
    const realRoot = fs.realpathSync(root);
    if (path.isAbsolute(link) || !inside(real, realRoot) || isExcluded(path.relative(realRoot, real))) return null;
    return { path: p, type: 'symlink', linkTarget: link };
  }
  if (st.isDirectory()) return { path: p, type: 'dir' };
  if (!st.isFile()) return null;
  return { path: p, type: 'file', data: fs.readFileSync(abs), mode: st.mode & 0o111 ? 0o755 : 0o644 };
}

/** All transferable entries of the workspace (directories first, sorted), with limits. */
export function collectAll(root: string, prefix: string): TarEntry[] {
  const out: TarEntry[] = [{ path: prefix, type: 'dir' }];
  let bytes = 0;
  const walk = (dir: string) => {
    for (const d of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (isExcluded(rel)) continue;
      const e = entryFor(root, rel, prefix);
      if (!e) continue;
      out.push(e);
      bytes += e.data?.length ?? 0;
      if (out.length > MAX_FILES) throw new Error(`Zu viele Dateien im Repository (mehr als ${MAX_FILES}).`);
      if (bytes > MAX_BYTES) throw new Error(`Repository zu groß für die Sandbox (mehr als ${MAX_BYTES / 1024 / 1024} MB).`);
      if (e.type === 'dir') walk(rel);
    }
  };
  walk('');
  return out;
}

export interface SyncTarget { runner: SandboxRunner; containerId: string; worktree: string; /** absolute directory in the container, e.g. /var/www/html/custom/plugins/AcmeTheme */ target: string; user: string; signal?: AbortSignal }

const checkTarget = (t: string) => {
  if (!/^\/var\/www\/html\/custom\/plugins\/[A-Z][A-Za-z0-9]{1,60}$/.test(t)) throw new Error('Ungültiges Zielverzeichnis im Container.');
  return { parent: path.posix.dirname(t), base: path.posix.basename(t) };
};
const rm = (s: SyncTarget, flags: '-f' | '-rf', abs: string) =>
  s.runner.exec(s.containerId, ['rm', flags, '--', abs], { user: s.user, timeoutMs: 120_000, signal: s.signal }).then(r => {
    if (r.exitCode !== 0) throw new Error(`Löschen im Container fehlgeschlagen: ${r.output.trim().slice(-200)}`);
  });

/** Full mirror: the plugin directory is removed and written again from the workspace. */
export async function syncAll(s: SyncTarget): Promise<{ files: number; bytes: number }> {
  const { parent, base } = checkTarget(s.target);
  const entries = collectAll(s.worktree, base);
  const tar = writeTar(entries, WWW_DATA);
  await rm(s, '-rf', s.target);
  await s.runner.putArchive(s.containerId, parent, tar);
  return { files: entries.filter(e => e.type === 'file').length, bytes: tar.length };
}

/** Changed paths only: existing files are uploaded (with their parent directories), missing ones are deleted in the container. */
export async function syncPaths(s: SyncTarget, rels: string[]): Promise<{ put: number; removed: number }> {
  const { parent, base } = checkTarget(s.target);
  const entries: TarEntry[] = [], dirs = new Set<string>(), gone: string[] = [];
  for (const raw of rels) {
    const rel = guardRel(raw);
    const abs = path.join(s.worktree, rel);
    if (!inside(path.resolve(abs), path.resolve(s.worktree))) throw new Error('Pfad außerhalb des Arbeitsordners.');
    if (!fs.existsSync(abs) && !isLink(abs)) { gone.push(rel); continue; }
    const segs = rel.split('/');
    for (let i = 1; i < segs.length; i++) { const d = segs.slice(0, i).join('/'); if (!dirs.has(d)) { dirs.add(d); entries.push({ path: `${base}/${d}`, type: 'dir' }); } }
    const e = entryFor(s.worktree, rel, base);
    if (e?.type === 'dir') { entries.push(...collectAll(path.join(s.worktree, rel), `${base}/${rel}`)); continue; }
    if (e) entries.push(e);
  }
  if (entries.length) await s.runner.putArchive(s.containerId, parent, writeTar([{ path: base, type: 'dir' }, ...entries], WWW_DATA));
  for (const rel of gone) await rm(s, '-f', `${s.target}/${rel}`);
  return { put: entries.filter(e => e.type !== 'dir').length, removed: gone.length };
}
const isLink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
