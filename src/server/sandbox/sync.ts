import 'server-only';
// Workspace → container: Lotse mirrors the cloned repository into the plugin directory as a tar archive (Docker archive API),
// owned by www-data. No host paths are mounted. Never synced: .git (the git dir lives outside the worktree anyway),
// secret files (.env, keys, auth.json …), node_modules and symlinks that point outside the workspace.
// Deletions in the container only with the fixed argv ['rm', '-f', '--', <target>/<guarded relative path>].
// A full Shopware project (project.ts) is synced into the shop's root instead, only its plugin and app folders, config files and src/.
import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_STAGE, PROJECT_PARSE_PHP, SYNC_MANIFEST, isProjectConfig, isUncheckedConfig, overrideFile, overrideYaml, parseConfigOutput, planConfig, projectSyncPath, realDir,
  type ConfigPlan, type ProjectRuntime, type Quarantine,
} from './project';
import { isEmptyRepoListing, targetPathProblem } from '@/lib/sandbox-task';
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

/** What one sync may transfer in total – for a project all plugin and app folders, config files and src/ together. Charged before a
 *  file is read, so a huge repository fails before Lotse holds it in memory. */
export interface SyncBudget { files: number; bytes: number }
export const syncBudget = (): SyncBudget => ({ files: 0, bytes: 0 });
function charge(b: SyncBudget, bytes: number) {
  b.files++; b.bytes += bytes;
  if (b.files > MAX_FILES) throw new Error(`Zu viele Dateien im Repository (mehr als ${MAX_FILES}).`);
  if (b.bytes > MAX_BYTES) throw new Error(`Repository zu groß für die Sandbox (mehr als ${MAX_BYTES / 1024 / 1024} MB).`);
}

/** One workspace entry as tar entry below `prefix`; null = skipped (excluded, outside symlink, special file). */
function entryFor(root: string, rel: string, prefix: string, b: SyncBudget = syncBudget()): TarEntry | null {
  const abs = path.join(root, rel);
  const st = fs.lstatSync(abs);
  const p = `${prefix}/${rel}`;
  charge(b, st.isFile() ? st.size : 0);
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

/** All transferable entries of the workspace (directories first, sorted), within the limits (`b`: shared by the caller's other
 *  folders). Symlinks are kept only when they point inside `root`. */
export function collectAll(root: string, prefix: string, b: SyncBudget = syncBudget()): TarEntry[] {
  const out: TarEntry[] = [{ path: prefix, type: 'dir' }];
  const walk = (dir: string) => {
    for (const d of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (isExcluded(rel)) continue;
      const e = entryFor(root, rel, prefix, b);
      if (!e) continue;
      out.push(e);
      if (e.type === 'dir') walk(rel);
    }
  };
  walk('');
  return out;
}

export interface SyncTarget { runner: SandboxRunner; containerId: string; worktree: string; /** absolute directory in the container, e.g. /var/www/html/custom/plugins/AcmeTheme */ target: string; user: string; signal?: AbortSignal;
  /** a full project (target = the shop's root): what the container said during the setup (null = not asked yet: config files are not
   *  synced) and the files the boot check took out */
  project?: { runtime: ProjectRuntime | null; held: Record<string, Quarantine> };
  /** "Eigenes Setup": target is the user's folder (below /var/www, /opt or /srv); the repository is laid over it, nothing else there is removed */
  custom?: boolean;
  /** a new plugin (empty repository): its folder appears in the container only with the repository's first file beyond README, LICENSE
   *  and .gitignore – until then `bin/console plugin:create <Name>` can make it (Shopware refuses an existing folder, even an empty one) */
  lazy?: boolean }

const checkTarget = (t: string, custom = false) => {
  if (custom ? targetPathProblem(t) !== null : !/^\/var\/www\/html\/custom\/plugins\/[A-Z][A-Za-z0-9]{1,60}$/.test(t)) throw new Error('Ungültiges Zielverzeichnis im Container.');
  return { parent: path.posix.dirname(t), base: path.posix.basename(t) };
};
/** What the last full sync of an own setup wrote (first line: the target): files the repository no longer has are removed next time */
export const CUSTOM_MANIFEST = '/var/tmp/lotse-custom-sync.txt';
/** The target's parent folders as root (an own setup may name /opt/app, which www-data cannot create); the target itself comes with the archive */
const ensureParent = async (s: SyncTarget, parent: string) => {
  const r = await s.runner.exec(s.containerId, ['mkdir', '-p', '--', parent], { user: 'root', timeoutMs: 30_000, signal: s.signal });
  if (r.exitCode !== 0) throw new Error(`Ordner ${parent} im Container nicht angelegt: ${r.output.trim().slice(-200)}`);
};
const rm = (s: SyncTarget, flags: '-f' | '-rf', ...abs: string[]) =>
  s.runner.exec(s.containerId, ['rm', flags, '--', ...abs], { user: s.user, timeoutMs: 120_000, signal: s.signal }).then(r => {
    if (r.exitCode !== 0) throw new Error(`Löschen im Container fehlgeschlagen: ${r.output.trim().slice(-200)}`);
  });

/** Whether the plugin folder exists in the container (a lazy target, see SyncTarget.lazy) */
const targetExists = async (s: SyncTarget) =>
  (await s.runner.exec(s.containerId, ['test', '-d', s.target], { user: s.user, timeoutMs: 30_000, signal: s.signal })).exitCode === 0;
/** The worktree has nothing a plugin folder needs yet: README, LICENSE, .gitignore at most */
const scaffoldOnly = (worktree: string) => isEmptyRepoListing(fs.readdirSync(worktree));

/** Full mirror: the plugin directory is removed and written again from the workspace. A project: see syncProjectAll.
 *  A lazy target with only README & co.: `deferred` – nothing is created; a folder made in the container meanwhile (plugin:create)
 *  only gets those files, nothing there is removed. */
export async function syncAll(s: SyncTarget): Promise<{ files: number; bytes: number; config?: ConfigPlan | null; deferred?: boolean }> {
  if (s.project) return syncProjectAll(s);
  if (s.custom) return syncCustomAll(s);
  const { parent, base } = checkTarget(s.target);
  const entries = collectAll(s.worktree, base);
  const tar = writeTar(entries, WWW_DATA);
  if (s.lazy && scaffoldOnly(s.worktree)) {
    if (!(await targetExists(s))) return { files: 0, bytes: 0, deferred: true };
    await s.runner.putArchive(s.containerId, parent, tar);
    return { files: entries.filter(e => e.type === 'file').length, bytes: tar.length };
  }
  await rm(s, '-rf', s.target);
  await s.runner.putArchive(s.containerId, parent, tar);
  return { files: entries.filter(e => e.type === 'file').length, bytes: tar.length };
}

/** Changed paths only: existing files are uploaded (with their parent directories), missing ones are deleted in the container.
 *  A lazy target the container does not have yet: `deferred` while the worktree has only README & co., else the whole worktree. */
export async function syncPaths(s: SyncTarget, rels: string[]): Promise<{ put: number; removed: number; config?: ConfigPlan | null; deferred?: boolean }> {
  if (s.project) return syncProjectPaths(s, rels);
  const { parent, base } = checkTarget(s.target, s.custom);
  if (s.custom) await ensureParent(s, parent);
  else if (s.lazy && !(await targetExists(s))) {
    if (scaffoldOnly(s.worktree)) return { put: 0, removed: 0, deferred: true };
    // the first real file: the folder comes with everything the worktree has (the README the AI wrote before, too)
    const entries = collectAll(s.worktree, base);
    await s.runner.putArchive(s.containerId, parent, writeTar(entries, WWW_DATA));
    return { put: entries.filter(e => e.type !== 'dir').length, removed: 0 };
  }
  const entries: TarEntry[] = [], dirs = new Set<string>(), gone: string[] = [], b = syncBudget();
  for (const raw of rels) {
    const rel = guardRel(raw);
    const abs = path.join(s.worktree, rel);
    if (!inside(path.resolve(abs), path.resolve(s.worktree))) throw new Error('Pfad außerhalb des Arbeitsordners.');
    // below a symlinked folder (or gone): nothing to read, the container's copy goes
    if (!realDir(s.worktree, path.posix.dirname(rel)) || (!fs.existsSync(abs) && !isLink(abs))) { gone.push(rel); continue; }
    const segs = rel.split('/');
    for (let i = 1; i < segs.length; i++) { const d = segs.slice(0, i).join('/'); if (!dirs.has(d)) { dirs.add(d); entries.push({ path: `${base}/${d}`, type: 'dir' }); } }
    const e = entryFor(s.worktree, rel, base, b);
    if (e?.type === 'dir') { entries.push(...collectAll(path.join(s.worktree, rel), `${base}/${rel}`, b)); continue; }
    if (e) entries.push(e);
  }
  if (entries.length) await s.runner.putArchive(s.containerId, parent, writeTar([{ path: base, type: 'dir' }, ...entries], WWW_DATA));
  for (const rel of gone) await rm(s, '-f', `${s.target}/${rel}`);
  return { put: entries.filter(e => e.type !== 'dir').length, removed: gone.length };
}

/** Full sync of an own setup: every file of the repository is written over the target folder (created if missing, owned by www-data);
 *  what the previous full sync wrote there and the repository no longer has is removed – nothing else in the target. */
export async function syncCustomAll(s: SyncTarget): Promise<{ files: number; bytes: number }> {
  const { parent, base } = checkTarget(s.target, true);
  const entries = collectAll(s.worktree, base);
  const written = entries.filter(e => e.type !== 'dir').map(e => e.path.slice(base.length + 1));
  const old = await s.runner.exec(s.containerId, ['cat', CUSTOM_MANIFEST], { user: s.user, timeoutMs: 30_000, signal: s.signal }).catch(() => ({ exitCode: 1, output: '' }));
  const [oldTarget, ...oldFiles] = old.exitCode === 0 ? old.output.split('\n').map(l => l.trim()) : [];
  const now = new Set(written);
  const stale = oldTarget === s.target ? oldFiles.filter(r => r && !now.has(r)).flatMap(r => { try { return [guardRel(r)]; } catch { return []; } }) : [];
  await ensureParent(s, parent);
  const tar = writeTar(entries, WWW_DATA);
  await s.runner.putArchive(s.containerId, parent, tar);
  for (let i = 0; i < stale.length; i += 200) await rm(s, '-f', ...stale.slice(i, i + 200).map(r => `${s.target}/${r}`));
  await s.runner.putArchive(s.containerId, path.posix.dirname(CUSTOM_MANIFEST), writeTar([{ path: path.posix.basename(CUSTOM_MANIFEST), type: 'file', data: Buffer.from(`${[s.target, ...written].join('\n')}\n`), mode: 0o644 }], WWW_DATA));
  return { files: written.length, bytes: tar.length };
}
const isLink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

// ---- Full Shopware projects (project.ts): the shop's root, only what projectSyncPath allows ----
const ROOT = '/var/www/html';
const checkRoot = (t: string) => { if (t !== ROOT) throw new Error('Ungültiges Zielverzeichnis im Container.'); };
const lstatOr = (p: string) => { try { return fs.lstatSync(p); } catch { return null; } };

/** What a project syncs right now: the plugin and app folders (units) and the single files (config, src/), relative paths, sorted.
 *  Folders the repository has as symlinks (custom/plugins -> /root/.config, src -> /home …) are never read: every path component
 *  from the worktree down must be a real directory; units and folders below are taken only as real directories (lstat). */
export function projectContent(worktree: string): { units: string[]; files: string[] } {
  const units: string[] = [], files: string[] = [];
  for (const base of ['custom/plugins', 'custom/static-plugins', 'custom/apps']) {
    let names: fs.Dirent[] = [];
    if (realDir(worktree, base)) try { names = fs.readdirSync(path.join(worktree, base), { withFileTypes: true }); } catch { /* none */ }
    for (const d of names.sort((a, b) => a.name.localeCompare(b.name))) { const r = `${base}/${d.name}`; if (d.isDirectory() && projectSyncPath(`${r}/x`)?.kind === 'unit') units.push(r); }
  }
  const walk = (rel: string) => {
    let names: fs.Dirent[] = [];
    if (!realDir(worktree, rel)) return;
    try { names = fs.readdirSync(path.join(worktree, rel), { withFileTypes: true }); } catch { return; }
    for (const d of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = `${rel}/${d.name}`;
      if (isExcluded(r)) continue;
      if (d.isDirectory()) walk(r);
      else if ((d.isFile() || d.isSymbolicLink()) && projectSyncPath(r)?.kind === 'file') files.push(r);
      if (files.length > MAX_FILES) throw new Error(`Zu viele Dateien im Repository (mehr als ${MAX_FILES}).`);
    }
  };
  walk('config/packages'); walk('src');
  if (realDir(worktree, 'config')) try { for (const n of fs.readdirSync(path.join(worktree, 'config')).sort()) { const r = `config/${n}`; if (projectSyncPath(r)?.kind === 'file' && lstatOr(path.join(worktree, r))?.isFile()) files.push(r); } } catch { /* no config/ */ }
  return { units, files };
}

/** Parent directory entries of `rel` (once each) */
const parents = (rel: string, seen: Set<string>, out: TarEntry[]) => {
  const segs = rel.split('/');
  for (let i = 1; i < segs.length; i++) { const d = segs.slice(0, i).join('/'); if (!seen.has(d)) { seen.add(d); out.push({ path: d, type: 'dir' }); } }
};
/** Where the first project sync keeps the image's own config/ and src/ (a project file of the same name overwrites them) */
export const IMAGE_BACKUP = 'var/lotse-image';
/** Removes paths of the shop's root (arguments, relative, checked by projectSyncPath) and puts the image's own version back where it
 *  had one – a quarantined or deleted project file must not take the image's file (e.g. config/packages/lock.yaml) with it. The first
 *  call keeps the image's config/ and src/ in IMAGE_BACKUP (before any project file is written). Constant script, run in /var/www/html. */
export const RESTORE_SH = `B=${IMAGE_BACKUP}
if [ ! -e "$B/.complete" ]; then rm -rf "$B" && mkdir -p "$B" || exit 1; for d in config src; do if [ -e "$d" ]; then cp -a "$d" "$B/" || exit 1; fi; done; touch "$B/.complete" || exit 1; fi
s=0
for r in "$@"; do
  rm -rf -- "$r" || s=1
  if [ -e "$B/$r" ]; then mkdir -p -- "$(dirname -- "$r")" && cp -a -- "$B/$r" "$r" || s=1; fi
done
exit $s`;
const restoreAll = async (s: SyncTarget, rels: string[]) => {
  for (let i = 0; i === 0 || i < rels.length; i += 200) {
    const r = await s.runner.exec(s.containerId, ['bash', '-c', RESTORE_SH, 'lotse-restore', ...rels.slice(i, i + 200)], { user: s.user, workdir: ROOT, timeoutMs: 120_000, signal: s.signal });
    if (r.exitCode !== 0) throw new Error(`Löschen im Container fehlgeschlagen: ${r.output.trim().slice(-200)}`);
  }
};
/** Size limit of one config file Lotse reads to check it */
const CONFIG_MAX = 1024 * 1024;

/** The project's YAML config, parsed by the container's Symfony (staged below /tmp, never loaded by Shopware), planned (project.ts).
 *  null = the container was not asked yet (setup before the probe): no config file is synced then. */
async function planProjectConfig(s: SyncTarget): Promise<{ plan: ConfigPlan; yaml: string[] } | null> {
  const rt = s.project?.runtime;
  if (!rt) return null;
  const content = projectContent(s.worktree);
  const sized = (r: string) => { const st = lstatOr(path.join(s.worktree, r)); return !!st?.isFile() && st.size <= CONFIG_MAX; };
  const yaml = content.files.filter(isProjectConfig).filter(sized);
  const raw: Record<string, string> = {};
  for (const r of yaml) raw[r] = fs.readFileSync(path.join(s.worktree, r), 'utf8');
  // too large to check: not loaded either
  const tooLarge = content.files.filter(r => isProjectConfig(r) && !yaml.includes(r));
  let parsed = {};
  if (yaml.length) {
    const seen = new Set<string>(), entries: TarEntry[] = [{ path: 'lotse-config', type: 'dir' }];
    for (const r of yaml) { parents(`lotse-config/${r}`, seen, entries); entries.push({ path: `lotse-config/${r}`, type: 'file', data: Buffer.from(raw[r]), mode: 0o644 }); }
    await s.runner.exec(s.containerId, ['rm', '-rf', '--', CONFIG_STAGE], { user: s.user, timeoutMs: 30_000, signal: s.signal });
    await s.runner.putArchive(s.containerId, path.posix.dirname(CONFIG_STAGE), writeTar(entries, WWW_DATA));
    try {
      const r = await s.runner.exec(s.containerId, ['php', '-r', PROJECT_PARSE_PHP, '--', ...yaml], { user: s.user, workdir: ROOT, timeoutMs: 60_000, maxOutput: 8 * 1024 * 1024, signal: s.signal });
      if (r.exitCode !== 0) throw new Error(`Die Konfiguration des Projekts ließ sich im Container nicht lesen (Exit-Code ${r.exitCode}): ${r.output.trim().slice(-300)}`);
      parsed = parseConfigOutput(r.output);
    } finally { await s.runner.exec(s.containerId, ['rm', '-rf', '--', CONFIG_STAGE], { user: s.user, timeoutMs: 30_000 }).catch(() => {}); }
  }
  for (const r of tooLarge) parsed = { ...parsed, [r]: { error: `größer als ${CONFIG_MAX / 1024 / 1024} MB` } };
  return { plan: planConfig(parsed, raw, rt, s.project?.held ?? {}, content.files.filter(isUncheckedConfig)), yaml };
}
/** Lotse's own files written with every project sync: the sandbox override and the list of what was synced */
function lotseFiles(s: SyncTarget, plan: ConfigPlan | null, content: { units: string[]; files: string[] }, seen: Set<string>, out: TarEntry[]) {
  const rt = s.project?.runtime;
  // the list may name more than was written (a quarantined file of an unchanged config): the next full sync only removes those again
  if (plan && rt) { const f = overrideFile(rt.appEnv); parents(f, seen, out); out.push({ path: f, type: 'file', data: Buffer.from(overrideYaml(plan, rt.appEnv)), mode: 0o644 }); }
  const listed = [...content.units.map(u => `u ${u}`), ...content.files.filter(f => !plan?.quarantine.has(f) && (rt || !f.startsWith('config/'))).map(f => `f ${f}`)];
  out.push({ path: SYNC_MANIFEST, type: 'file', data: Buffer.from(`${listed.join('\n')}\n`), mode: 0o644 });
}
const syncedFile = (s: SyncTarget, plan: ConfigPlan | null, rel: string) => !(plan?.quarantine.has(rel)) && (!!s.project?.runtime || !rel.startsWith('config/'));

/**
 * Full sync of a project: every plugin and app folder of the repository is mirrored (removed and written again), config files and src/
 * are written over the image's files, quarantined config files are removed, and whatever the previous sync wrote that the repository
 * no longer has (the list in var/) is removed too. The sandbox override is written in the same archive.
 */
export async function syncProjectAll(s: SyncTarget): Promise<{ files: number; bytes: number; config: ConfigPlan | null }> {
  checkRoot(s.target);
  const content = projectContent(s.worktree);
  const planned = await planProjectConfig(s), plan = planned?.plan ?? null;
  const old = await s.runner.exec(s.containerId, ['cat', `${ROOT}/${SYNC_MANIFEST}`], { user: s.user, timeoutMs: 30_000, signal: s.signal }).catch(() => ({ exitCode: 1, output: '' }));
  const now = new Set([...content.units, ...content.files.filter(f => syncedFile(s, plan, f))]);
  const stale = old.exitCode === 0 ? old.output.split('\n').map(l => /^[uf] (.+)$/.exec(l.trim())?.[1]).filter((r): r is string => !!r && !!projectSyncPath(r) && !now.has(r)) : [];
  // read (within one budget for everything) before anything in the container is removed
  const seen = new Set<string>(), entries: TarEntry[] = [], b = syncBudget();
  for (const u of content.units) { parents(`${u}/x`, seen, entries); entries.push(...collectAll(path.join(s.worktree, u), u, b)); }
  for (const f of content.files) {
    if (!syncedFile(s, plan, f)) continue;
    const e = entryFor(s.worktree, f, '.', b);
    if (!e || e.type === 'dir') continue;
    parents(f, seen, entries); entries.push({ ...e, path: f });
  }
  lotseFiles(s, plan, content, seen, entries);
  // units: a mirror; quarantined files: Shopware must not load them (synced before); the image's own file of that name comes back
  await restoreAll(s, [...content.units, ...stale, ...(plan ? [...plan.quarantine.keys()] : [])]);
  const tar = writeTar(entries, WWW_DATA);
  await s.runner.putArchive(s.containerId, ROOT, tar);
  return { files: entries.filter(e => e.type === 'file').length, bytes: tar.length, config: plan };
}

/** Changed paths of a project: synced ones are written or removed; a changed config file plans the config again (override, quarantine).
 *  Paths outside what a project syncs (README, composer.json …) are left alone. */
export async function syncProjectPaths(s: SyncTarget, rels: string[]): Promise<{ put: number; removed: number; config: ConfigPlan | null }> {
  checkRoot(s.target);
  const guarded = rels.map(guardRel).filter(r => projectSyncPath(r) || (lstatOr(path.join(s.worktree, r))?.isDirectory() && /^(custom\/(plugins|static-plugins|apps)\/[^/]+|src|config\/packages)(\/|$)/.test(r)));
  if (!guarded.length) return { put: 0, removed: 0, config: null };
  const planned = guarded.some(r => r.startsWith('config/')) ? await planProjectConfig(s) : null, plan = planned?.plan ?? null;
  const seen = new Set<string>(), entries: TarEntry[] = [], gone: string[] = [], b = syncBudget();
  for (const rel of guarded) {
    const abs = path.join(s.worktree, rel);
    if (!inside(path.resolve(abs), path.resolve(s.worktree))) throw new Error('Pfad außerhalb des Arbeitsordners.');
    // below a symlinked folder (or gone): nothing to read, the container's copy goes
    if (!realDir(s.worktree, path.posix.dirname(rel)) || (!fs.existsSync(abs) && !isLink(abs))) { gone.push(rel); continue; }
    if (plan?.quarantine.has(rel) || (!s.project?.runtime && rel.startsWith('config/'))) continue;
    const e = entryFor(s.worktree, rel, '.', b);
    if (!e) continue;
    parents(rel, seen, entries);
    if (e.type === 'dir') { for (const x of collectAll(abs, rel, b)) if (x.type !== 'file' || projectSyncPath(x.path)) entries.push(x); continue; }
    entries.push({ ...e, path: rel });
  }
  lotseFiles(s, plan, projectContent(s.worktree), seen, entries);
  // a changed file that is quarantined now: its earlier version must not stay loaded (removed first: the override may have its name)
  const remove = [...gone, ...(plan ? [...plan.quarantine.keys()].filter(f => guarded.includes(f)) : [])];
  if (remove.length) await restoreAll(s, remove);
  await s.runner.putArchive(s.containerId, ROOT, writeTar(entries, WWW_DATA));
  const own = s.project?.runtime ? overrideFile(s.project.runtime.appEnv) : null;
  return { put: entries.filter(e => e.type !== 'dir' && e.path !== SYNC_MANIFEST && e.path !== own).length, removed: gone.length, config: plan };
}

/** What the container got of the worktree, per entry: path → mode, size and modification time ('d' for a folder; nothing is read).
 *  Compared with the worktree later, it names exactly the paths changed since (by the tools, on the host, by a crash between writing
 *  and syncing), so only those are transferred again. */
export type TreeManifest = Record<string, string>;
const entryStamp = (st: fs.Stats | null) => (!st ? '-' : st.isDirectory() ? 'd' : `${st.mode}:${st.size}:${st.mtimeMs}`);

/** The manifest of what a full project sync would transfer. Within the same limits as the sync. */
export function projectManifest(worktree: string): TreeManifest {
  const out: TreeManifest = {}, b = syncBudget(), content = projectContent(worktree);
  const add = (rel: string) => { out[rel] = entryStamp(lstatOr(path.join(worktree, rel))); charge(b, 0); };
  const walk = (unit: string, dir: string) => {
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(path.join(worktree, unit, dir), { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (isExcluded(rel)) continue;
      add(`${unit}/${rel}`);
      if (d.isDirectory()) walk(unit, rel);
    }
  };
  for (const u of content.units) { add(u); walk(u, ''); }
  for (const f of content.files) add(f);
  return out;
}

/** The same manifest for a plugin or an own setup: every transferable entry of the worktree (what collectAll would read). */
export function treeManifest(worktree: string): TreeManifest {
  const out: TreeManifest = {}, b = syncBudget();
  const walk = (dir: string) => {
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(path.join(worktree, dir), { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (isExcluded(rel)) continue;
      out[rel] = entryStamp(lstatOr(path.join(worktree, rel))); charge(b, 0);
      if (d.isDirectory()) walk(rel);
    }
  };
  walk('');
  return out;
}
