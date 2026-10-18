import 'server-only';
// Workspace → container: Lotse mirrors the cloned repository into the plugin directory as a tar archive (Docker archive API),
// owned by www-data. No host paths are mounted. Never synced: .git (the git dir lives outside the worktree anyway),
// secret files (.env, keys, auth.json …), node_modules and symlinks that point outside the workspace.
// Deletions in the container only with the fixed argv ['rm', '-f', '--', <target>/<guarded relative path>].
// A full Shopware project (project.ts) is synced into the shop's root instead, only its plugin and app folders, config files and src/.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_STAGE, PROJECT_PARSE_PHP, SYNC_MANIFEST, isProjectConfig, overrideFile, overrideYaml, parseConfigOutput, planConfig, projectSyncPath, type ConfigPlan, type ProjectRuntime } from './project';
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

export interface SyncTarget { runner: SandboxRunner; containerId: string; worktree: string; /** absolute directory in the container, e.g. /var/www/html/custom/plugins/AcmeTheme */ target: string; user: string; signal?: AbortSignal;
  /** a full project (target = the shop's root): what the container said during the setup (null = not asked yet: config files are not
   *  synced) and the files the boot check took out */
  project?: { runtime: ProjectRuntime | null; held: Record<string, string> } }

const checkTarget = (t: string) => {
  if (!/^\/var\/www\/html\/custom\/plugins\/[A-Z][A-Za-z0-9]{1,60}$/.test(t)) throw new Error('Ungültiges Zielverzeichnis im Container.');
  return { parent: path.posix.dirname(t), base: path.posix.basename(t) };
};
const rm = (s: SyncTarget, flags: '-f' | '-rf', abs: string) =>
  s.runner.exec(s.containerId, ['rm', flags, '--', abs], { user: s.user, timeoutMs: 120_000, signal: s.signal }).then(r => {
    if (r.exitCode !== 0) throw new Error(`Löschen im Container fehlgeschlagen: ${r.output.trim().slice(-200)}`);
  });

/** Full mirror: the plugin directory is removed and written again from the workspace. A project: see syncProjectAll. */
export async function syncAll(s: SyncTarget): Promise<{ files: number; bytes: number; config?: ConfigPlan | null }> {
  if (s.project) return syncProjectAll(s);
  const { parent, base } = checkTarget(s.target);
  const entries = collectAll(s.worktree, base);
  const tar = writeTar(entries, WWW_DATA);
  await rm(s, '-rf', s.target);
  await s.runner.putArchive(s.containerId, parent, tar);
  return { files: entries.filter(e => e.type === 'file').length, bytes: tar.length };
}

/** Changed paths only: existing files are uploaded (with their parent directories), missing ones are deleted in the container. */
export async function syncPaths(s: SyncTarget, rels: string[]): Promise<{ put: number; removed: number; config?: ConfigPlan | null }> {
  if (s.project) return syncProjectPaths(s, rels);
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

// ---- Full Shopware projects (project.ts): the shop's root, only what projectSyncPath allows ----
const ROOT = '/var/www/html';
const checkRoot = (t: string) => { if (t !== ROOT) throw new Error('Ungültiges Zielverzeichnis im Container.'); };
const lstatOr = (p: string) => { try { return fs.lstatSync(p); } catch { return null; } };

/** What a project syncs right now: the plugin and app folders (units) and the single files (config, src/), relative paths, sorted */
export function projectContent(worktree: string): { units: string[]; files: string[] } {
  const units: string[] = [], files: string[] = [];
  for (const base of ['custom/plugins', 'custom/static-plugins', 'custom/apps']) {
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(path.join(worktree, base), { withFileTypes: true }); } catch { /* none */ }
    for (const d of names.sort((a, b) => a.name.localeCompare(b.name))) { const r = `${base}/${d.name}`; if (d.isDirectory() && projectSyncPath(`${r}/x`)?.kind === 'unit') units.push(r); }
  }
  const walk = (rel: string) => {
    let names: fs.Dirent[] = [];
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
  try { for (const n of fs.readdirSync(path.join(worktree, 'config')).sort()) { const r = `config/${n}`; if (projectSyncPath(r)?.kind === 'file' && lstatOr(path.join(worktree, r))?.isFile()) files.push(r); } } catch { /* no config/ */ }
  return { units, files };
}

/** Parent directory entries of `rel` (once each) */
const parents = (rel: string, seen: Set<string>, out: TarEntry[]) => {
  const segs = rel.split('/');
  for (let i = 1; i < segs.length; i++) { const d = segs.slice(0, i).join('/'); if (!seen.has(d)) { seen.add(d); out.push({ path: d, type: 'dir' }); } }
};
const rmAll = async (s: SyncTarget, rels: string[]) => {
  for (let i = 0; i < rels.length; i += 200) {
    const r = await s.runner.exec(s.containerId, ['rm', '-rf', '--', ...rels.slice(i, i + 200).map(x => `${ROOT}/${x}`)], { user: s.user, timeoutMs: 120_000, signal: s.signal });
    if (r.exitCode !== 0) throw new Error(`Löschen im Container fehlgeschlagen: ${r.output.trim().slice(-200)}`);
  }
};

/** The project's YAML config, parsed by the container's Symfony (staged below /tmp, never loaded by Shopware), planned (project.ts).
 *  null = the container was not asked yet (setup before the probe): no config file is synced then. */
async function planProjectConfig(s: SyncTarget): Promise<{ plan: ConfigPlan; yaml: string[] } | null> {
  const rt = s.project?.runtime;
  if (!rt) return null;
  const yaml = projectContent(s.worktree).files.filter(isProjectConfig).filter(r => lstatOr(path.join(s.worktree, r))?.isFile());
  const raw: Record<string, string> = {};
  for (const r of yaml) raw[r] = fs.readFileSync(path.join(s.worktree, r), 'utf8');
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
  return { plan: planConfig(parsed, raw, rt, s.project?.held ?? {}), yaml };
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
  // units first: a mirror; quarantined files: Shopware must not load them (synced before, or the image's own file of that name)
  await rmAll(s, [...content.units, ...stale, ...(plan ? [...plan.quarantine.keys()] : [])]);
  const seen = new Set<string>(), entries: TarEntry[] = [];
  let bytes = 0;
  for (const u of content.units) { parents(`${u}/x`, seen, entries); for (const e of collectAll(path.join(s.worktree, u), u)) { entries.push(e); bytes += e.data?.length ?? 0; } }
  for (const f of content.files) {
    if (!syncedFile(s, plan, f)) continue;
    const e = entryFor(s.worktree, f, '.');
    if (!e || e.type === 'dir') continue;
    parents(f, seen, entries); entries.push({ ...e, path: f }); bytes += e.data?.length ?? 0;
    if (entries.length > MAX_FILES) throw new Error(`Zu viele Dateien im Repository (mehr als ${MAX_FILES}).`);
    if (bytes > MAX_BYTES) throw new Error(`Repository zu groß für die Sandbox (mehr als ${MAX_BYTES / 1024 / 1024} MB).`);
  }
  lotseFiles(s, plan, content, seen, entries);
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
  const seen = new Set<string>(), entries: TarEntry[] = [], gone: string[] = [];
  for (const rel of guarded) {
    const abs = path.join(s.worktree, rel);
    if (!inside(path.resolve(abs), path.resolve(s.worktree))) throw new Error('Pfad außerhalb des Arbeitsordners.');
    if (!fs.existsSync(abs) && !isLink(abs)) { gone.push(rel); continue; }
    if (plan?.quarantine.has(rel) || (!s.project?.runtime && rel.startsWith('config/'))) continue;
    const e = entryFor(s.worktree, rel, '.');
    if (!e) continue;
    parents(rel, seen, entries);
    if (e.type === 'dir') { for (const x of collectAll(abs, rel)) if (x.type !== 'file' || projectSyncPath(x.path)) entries.push(x); continue; }
    entries.push({ ...e, path: rel });
  }
  lotseFiles(s, plan, projectContent(s.worktree), seen, entries);
  await s.runner.putArchive(s.containerId, ROOT, writeTar(entries, WWW_DATA));
  // a changed file that is quarantined now: its earlier version must not stay loaded
  const remove = [...gone, ...(plan ? [...plan.quarantine.keys()].filter(f => guarded.includes(f)) : [])];
  if (remove.length) await rmAll(s, remove);
  return { put: entries.filter(e => e.type !== 'dir' && e.path !== SYNC_MANIFEST && !e.path.endsWith('/zz_lotse_sandbox.yaml')).length, removed: gone.length, config: plan };
}
