import 'server-only';
// Container → worktree (A24 "Aus dem Container übernehmen"): files made or changed inside the task container – in the user's console or by
// the AI's sandbox_bash (bin/console plugin:create, composer require in a plugin, generated migrations, build output the repository
// keeps) – are compared with the worktree and, on a click (or the AI's pull_from_container), written into it. Then the normal flow
// follows: commit ("Änderung speichern" / git_commit) and publish.
// The container is untrusted (code running as www-data there, with sudo, can create anything), so:
// - only the folders Lotse syncs are compared (the plugin folder, a project's plugin/app folders, config/packages, config/services*.yaml
//   and src/, an own setup's target folder); .git, node_modules, vendor, var and public are skipped unless the repository tracks files there
// - the listing (a fixed script: find + sha256sum, NUL-separated) and the archive are parsed defensively: counts, sizes and paths capped
//   and checked (no absolute paths, no "..", no control characters), links, hard links, devices and FIFOs are never taken over (tar.ts)
// - every file goes through the commit checks (publish.ts commitCheck: protected files, workflows, a project's allowed paths, size, the
//   secret scan) before it may enter the worktree; .env*, keys and .git never do
// - writing never follows a link on the host: every parent must be a real directory below the worktree, the file is opened with
//   O_NOFOLLOW; modes are normalized to 0644/0755, the owner is Lotse's
// - what the user (or the AI) saw is what is taken over: the container's sha256 of each file is checked again on the fetched bytes
// - a deletion is only inferred where the listing saw the whole folder: below a link, a device, an unreadable folder, a file in place of
//   a folder or an unusual name nothing counts as deleted; a root find could not walk completely counts as not listed at all
// - texts for the user in the request's language (messages(locale).server.pull/check); the AI's tool reads German
// What a fresh container had after its setup (baseline, kept in the task's workspace folder) is not offered: files of the image, of the
// setup and of the user's setup commands are not changes – neither are repository files the setup changed or removed, as long as
// neither side touched them since. Without a baseline (a sandbox set up before) the AI may only take over named paths.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ContainerChange, ContainerChanges, ContainerSkipReason, ContainerTakeOver } from '@/lib/protocol';
import { DEFAULT_LOCALE, messages, type Locale } from '@/lib/i18n';
import { auditAdd } from '../db';
import { runGit } from '../git';
import { log } from '../log';
import { redact } from '../settings';
import { pool } from '../util';
import { SYNC_MANIFEST, overrideFile, projectBase, projectSyncPath, realDir, underRoot, withRoot } from './project';
import { commitVerdict } from './publish';
import { getRunner, type SandboxRunner } from './runner';
import { IMAGE_BACKUP, isExcluded, isSecretPath } from './sync';
import { TarError, archivePath, readTarStrict } from './tar';
import { unifiedDiff } from './line-diff';
import { getTemplate } from './templates';
import { noteInSync, rootOf as projectRoot, syncTaskAll } from './task-sync';
import { publishRunning, taskPaths, type CodeTask } from './tasks';
import { isBinary, isDenied } from './workspace-fs';

/** files, fileBytes and totalBytes are publishing's limits (PUBLISH_LIMITS; literal here: publish.ts and jobs.ts import each other) */
export const PULL_LIMITS = {
  /** entries of one listing (all roots) */ entries: 20_000,
  /** files one comparison offers (more are named as skipped) */ files: 300,
  fileBytes: 5 * 1024 * 1024, totalBytes: 25 * 1024 * 1024,
  /** bytes of the listing's output */ listing: 16 * 1024 * 1024,
  /** patch shown in the "Änderungen" tab */ diff: 400 * 1024,
  /** folders the repository tracks inside a skipped folder (vendor/ …) that are compared anyway */ keep: 200,
} as const;
/** Folder names whose content is dependencies, caches or build output: compared only where the repository tracks files */
const SKIP_DIRS = ['vendor', 'var', 'public'];
const NEVER_DIRS = ['.git', 'node_modules'];

// ---- The fixed scripts (arguments only: paths Lotse composed and checked) ----
/** Per root: "R\0<root>\0", then P(runed dir)/U(nreadable dir)/D(ir)/F(ile: size, mode)/O(ther: type) records with the path relative
 *  to the root, "I\0" when find could not walk everything (an error: nothing below this root may count as deleted), then "H\0" and
 *  "<sha256>  <path>\0" for every file below the size limit; at the very end "E\0" (a missing marker = the output was cut). A root that
 *  is missing, a link or cannot be read prints nothing but its R record. */
export const LIST_SH = `exec 2>/dev/null
export LC_ALL=C
max=$1; shift
for r in "$@"; do
  printf 'R\\0%s\\0' "$r"
  if [ -L "$r" ] || [ ! -d "$r" ] || [ ! -r "$r" ] || [ ! -x "$r" ]; then continue; fi
  cd -- "$r" 2>/dev/null || continue
  find -P . -mindepth 1 -xdev \\( -type d \\( -name .git -o -name node_modules -o -name vendor -o -name var -o -name public \\) -printf 'P\\0%P\\0' -prune \\) -o \\( -type d ! \\( -readable -executable \\) -printf 'U\\0%P\\0' -prune \\) -o \\( -type d -printf 'D\\0%P\\0' \\) -o \\( -type f -printf 'F\\0%s\\0%m\\0%P\\0' \\) -o -printf 'O\\0%y\\0%P\\0' 2>/dev/null || printf 'I\\0'
  printf 'H\\0'
  find -P . -mindepth 1 -xdev \\( -type d \\( -name .git -o -name node_modules -o -name vendor -o -name var -o -name public \\) -prune \\) -o \\( -type f -size -"$max"c -printf '%P\\0' \\) 2>/dev/null | xargs -0 -r sha256sum -z -- 2>/dev/null
done
printf 'E\\0'`;
/** Copies the given files (absolute) to <dir>/0, <dir>/1 … for one archive; a file that cannot be copied is missing, one larger than
 *  `max` bytes (grown since the listing, e.g. a log being written) is left out with an empty marker <dir>/<i>.big instead. Only regular
 *  files; cp -dR never follows a link and copies a FIFO or device that replaced a file meanwhile as such (reading a FIFO would block),
 *  and a time limit per file ends anything else that hangs. What arrives is checked again on the host anyway (type, size, sha256). */
export const STAGE_SH = `exec 2>/dev/null
max=$1; d=$2; shift 2
rm -rf -- "$d" && mkdir -m 700 -- "$d" || exit 1
big() { s=$(stat -c %s -- "$1") && [ "$s" -gt "$max" ]; }
i=0
for f in "$@"; do
  if [ -f "$f" ] && [ ! -L "$f" ]; then
    if big "$f"; then : > "$d/$i.big"
    else timeout 30 cp -dR --preserve=mode -- "$f" "$d/$i" || :; if [ -f "$d/$i" ] && [ ! -L "$d/$i" ] && big "$d/$i"; then rm -f -- "$d/$i"; : > "$d/$i.big"; fi
    fi
  fi
  i=$((i+1))
done`;
const STAGE_PREFIX = '/tmp/lotse-pull-';
/** The image sets BASH_ENV (dockware: ~/.bashrc, which may print): the fixed scripts run without it, their output is only theirs */
const NO_RC = ['BASH_ENV='];

// ---- Listing ----
export type CEntry = { kind: 'file'; size: number; mode: number; sha: string | null } | { kind: 'dir' } | { kind: 'pruned' } | { kind: 'link' } | { kind: 'special' } | { kind: 'unreadable' };
export interface Root { /** absolute in the container */ container: string; /** prefix in the worktree ('' = its root) */ rel: string }
export interface Listing { entries: Map<string, CEntry>; /** roots that exist in the container and were listed completely (absolute) */ present: Set<string>; skipped: { path: string; reason: ContainerSkipReason }[] }
type Pull = ReturnType<typeof messages>['server']['pull'];
const pullText = (locale: Locale): Pull => messages(locale).server.pull;
const join = (a: string, b: string) => (a ? (b ? `${a}/${b}` : a) : b);

/** Parses LIST_SH's output for `roots` (in that order). Throws on anything malformed; unusual names are skipped, never interpreted. */
export function parseListing(out: string, roots: Root[], locale: Locale = DEFAULT_LOCALE): Listing {
  const L = pullText(locale), bad = (why: keyof Pull['listingWhy'] | { duplicate: string }) => new Error(L.badListing(typeof why === 'string' ? L.listingWhy[why] : L.duplicate(why.duplicate)));
  const tok = out.split('\0');
  if (tok.at(-1) !== '' || tok.at(-2) !== 'E') throw bad('incomplete');
  tok.length -= 2;
  const entries = new Map<string, CEntry>(), present = new Set<string>(), skipped: Listing['skipped'] = [];
  let i = 0, ri = -1, count = 0;
  const next = () => { if (i >= tok.length) throw bad('cut'); return tok[i++]; };
  const relOf = (raw: string): string | null => {
    const p = archivePath(raw);
    if (!p || p !== raw || Buffer.byteLength(p) > 1024) return null;
    return join(roots[ri].rel, p);
  };
  const put = (raw: string, e: CEntry) => {
    if (++count > PULL_LIMITS.entries) throw new Error(L.tooManyContainer(PULL_LIMITS.entries));
    const rel = relOf(raw);
    if (!rel) { if (skipped.length < 200) skipped.push({ path: raw.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 200), reason: 'name' }); return; }
    if (entries.has(rel) && !(e.kind === 'dir' && entries.get(rel)!.kind === 'dir')) throw bad({ duplicate: rel.slice(0, 80) });
    entries.set(rel, e);
  };
  while (i < tok.length) {
    const t = next();
    if (t === 'R') {
      const r = next();
      if (roots[ri + 1]?.container !== r) throw bad('root');
      ri++;
      // a root that exists prints its records (maybe none) before H; a missing one is followed by the next R or the end
      if (tok[i] !== 'R' && i < tok.length) present.add(r);
      continue;
    }
    if (ri < 0) throw bad('start');
    if (t === 'P') { put(next(), { kind: 'pruned' }); continue; }
    if (t === 'D') { put(next(), { kind: 'dir' }); continue; }
    if (t === 'U') { put(next(), { kind: 'unreadable' }); continue; }
    if (t === 'I') { present.delete(roots[ri].container); continue; } // not walked completely: nothing below it counts as deleted
    if (t === 'F') {
      const size = next(), mode = next(), p = next();
      if (!/^\d{1,15}$/.test(size) || !/^[0-7]{1,4}$/.test(mode)) throw bad('sizeMode');
      put(p, { kind: 'file', size: Number(size), mode: parseInt(mode, 8), sha: null });
      continue;
    }
    if (t === 'O') { const y = next(), p = next(); if (!/^[a-zA-Z]$/.test(y)) throw bad('type'); put(p, { kind: y === 'l' ? 'link' : 'special' }); continue; }
    if (t === 'H') {
      while (i < tok.length && tok[i] !== 'R') {
        const m = /^([0-9a-f]{64}) {2}(.+)$/s.exec(tok[i++]);
        if (!m) throw bad('checksum');
        const rel = relOf(m[2]), e = rel ? entries.get(rel) : undefined;
        if (e?.kind === 'file') e.sha = m[1];
      }
      continue;
    }
    throw bad('unknown');
  }
  if (ri !== roots.length - 1) throw bad('roots');
  return { entries, present, skipped };
}

export async function listContainer(runner: SandboxRunner, containerId: string, user: string, roots: Root[], signal?: AbortSignal, locale: Locale = DEFAULT_LOCALE): Promise<Listing> {
  const L = pullText(locale);
  const r = await runner.exec(containerId, ['bash', '-c', LIST_SH, 'lotse-list', String(PULL_LIMITS.fileBytes + 1), ...roots.map(x => x.container)],
    { user, workdir: '/', env: NO_RC, timeoutMs: 120_000, maxOutput: PULL_LIMITS.listing, signal });
  if (r.truncated) throw new Error(L.listingTooBig(PULL_LIMITS.listing / 1024 / 1024));
  if (r.exitCode !== 0) throw new Error(L.listFailed(r.exitCode, redact(r.output).trim().slice(-200)));
  return parseListing(r.output, roots, locale);
}

// ---- What is compared, per kind of task ----
const ROOT = '/var/www/html';
/** The folder of the worktree the container's files are compared with: a project's subfolder (layout.root) or the worktree itself.
 *  Everything below is relative to it (= to /var/www/html); what the user and the AI see carries the subfolder in front (repository paths). */
const workBase = (t: CodeTask) => projectBase(taskPaths(t.id).worktree, projectRoot(t));
const PROJECT_ROOTS = ['custom/plugins', 'custom/static-plugins', 'custom/apps', 'config', 'src'];
export interface Scope { roots: Root[]; /** a worktree path this kind of task syncs (and may take over) */ accept: (rel: string) => boolean;
  /** paths left out on both sides (Lotse's own files, project config the sandbox does not load) */ ignore: (rel: string) => boolean }

/** Folders with a skipped name (vendor/, var/, public/) that hold files the repository tracks: compared too (at most PULL_LIMITS.keep). */
async function keptDirs(t: CodeTask): Promise<string[]> {
  const p = taskPaths(t.id);
  let out = '';
  try { out = (await runGit(['-c', 'core.quotePath=false', 'ls-files', '-z'], { cwd: p.worktree, gitDir: p.gitDir })).stdout; } catch { return []; }
  const keep = new Set<string>();
  const root = projectRoot(t);
  for (const f of out.split('\0')) {
    const inner = underRoot(root, f);
    if (inner === null) continue;
    const segs = inner.split('/');
    for (let i = 0; i < segs.length - 1; i++) if (SKIP_DIRS.includes(segs[i])) { keep.add(segs.slice(0, i + 1).join('/')); }
    if (keep.size > PULL_LIMITS.keep) break;
  }
  return [...keep].filter(k => archivePath(k) === k && !k.split('/').some(s => NEVER_DIRS.includes(s))).sort().slice(0, PULL_LIMITS.keep);
}

export async function scopeOf(t: CodeTask, locale: Locale = DEFAULT_LOCALE): Promise<Scope> {
  if (!t.layout) throw new Error(pullText(locale).notReady);
  const target = getTemplate(t.template).syncTarget(t.layout), kept = await keptDirs(t);
  const okChars = (abs: string) => /^\/[A-Za-z0-9._/-]{1,1000}$/.test(abs) && !abs.split('/').includes('..');
  const withKept = (base: Root[]) => {
    const extra = kept.flatMap(k => base.filter(b => !b.rel || k.startsWith(`${b.rel}/`)).slice(0, 1).map(b => ({ container: `${b.container}/${b.rel ? k.slice(b.rel.length + 1) : k}`, rel: k })));
    return [...base, ...extra.filter(e => okChars(e.container))];
  };
  if (t.layout.kind === 'project') {
    const p = t.layout.project, runtime = !!(p?.appEnv && p.extensions && p.envNames);
    const quarantined = new Set([...(p?.quarantined ?? []), ...(p?.held ?? [])].map(q => q.file));
    const own = p?.appEnv ? overrideFile(p.appEnv) : null;
    return {
      roots: withKept(PROJECT_ROOTS.map(r => ({ container: `${ROOT}/${r}`, rel: r }))),
      accept: rel => !!projectSyncPath(rel),
      ignore: rel => rel === own || rel === SYNC_MANIFEST || rel.startsWith(`${IMAGE_BACKUP}/`) || quarantined.has(rel) || (!runtime && rel.startsWith('config/')),
    };
  }
  if (!okChars(target)) throw new Error(pullText(locale).badTarget);
  return { roots: withKept([{ container: target, rel: '' }]), accept: rel => !isExcluded(rel), ignore: () => false };
}

// ---- The worktree side ----
type WEntry = { kind: 'file'; size: number; abs: string } | { kind: 'link' };
/** Regular files and links of the worktree below the roots (never following a link; skipped folders only where kept). */
function worktreeEntries(worktree: string, roots: Root[], locale: Locale = DEFAULT_LOCALE): Map<string, WEntry> {
  const out = new Map<string, WEntry>(), keptRels = new Set(roots.map(r => r.rel).filter(Boolean));
  const walk = (rel: string) => {
    if (!realDir(worktree, rel)) return;
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(path.join(worktree, rel), { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const r = join(rel, d.name);
      if (NEVER_DIRS.includes(d.name) || isExcluded(r)) continue;
      if (d.isSymbolicLink()) { out.set(r, { kind: 'link' }); continue; }
      if (d.isDirectory()) { if (!SKIP_DIRS.includes(d.name) || keptRels.has(r)) walk(r); continue; }
      if (!d.isFile()) continue;
      const abs = path.join(worktree, r), st = fs.lstatSync(abs);
      out.set(r, { kind: 'file', size: st.size, abs });
      if (out.size > PULL_LIMITS.entries) throw new Error(pullText(locale).tooManyRepo(PULL_LIMITS.entries));
    }
  };
  // the outermost roots only: the walk descends into the kept folders below them itself
  for (const r of roots) if (!roots.some(o => o !== r && (!o.rel || r.rel.startsWith(`${o.rel}/`)))) walk(r.rel);
  return out;
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// ---- Baseline: what a fresh container had after its setup ----
/** files: the container's (sha256, or the kind of a link, device, unreadable folder); work: the worktree's files at the same moment */
interface Baseline { container: string; files: Record<string, string>; work?: Record<string, string> }
const baselineFile = (id: string) => path.join(taskPaths(id).workspace, 'container-baseline.json');
const isStrings = (v: unknown): v is Record<string, string> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'string');
function readBaseline(id: string): Baseline | null {
  try {
    const v = JSON.parse(fs.readFileSync(baselineFile(id), 'utf8')) as Baseline;
    return typeof v.container === 'string' && isStrings(v.files) ? { container: v.container, files: v.files, ...(isStrings(v.work) ? { work: v.work } : {}) } : null;
  } catch { return null; }
}
/** After the setup: the container's files in the compared folders (sha256, "link" for links …) and the worktree's files (sha256) – what
 *  differs between the two then is the setup's doing – unless this container has one already. */
export async function captureBaseline(t: CodeTask, signal?: AbortSignal): Promise<void> {
  if (!t.containerId || !t.layout) return;
  if (readBaseline(t.id)?.container === t.containerId) return;
  const scope = await scopeOf(t), tpl = getTemplate(t.template);
  const l = await listContainer(getRunner(), t.containerId, tpl.execUser, scope.roots, signal);
  const files: Record<string, string> = {}, work: Record<string, string> = {};
  for (const [rel, e] of l.entries) if (e.kind === 'file' && e.sha) files[rel] = e.sha; else if (e.kind === 'link' || e.kind === 'special' || e.kind === 'unreadable') files[rel] = e.kind;
  for (const [rel, w] of worktreeEntries(workBase(t), scope.roots)) if (w.kind === 'file' && w.size <= PULL_LIMITS.fileBytes) work[rel] = sha(fs.readFileSync(w.abs));
  fs.mkdirSync(taskPaths(t.id).workspace, { recursive: true });
  fs.writeFileSync(baselineFile(t.id), JSON.stringify({ container: t.containerId, files, work } satisfies Baseline), { mode: 0o600 });
}

// ---- Fetching the container's bytes ----
interface Fetched { data: Map<string, Buffer>; /** grown beyond the size limit since the listing: left out */ tooLarge: Set<string> }
/** The container's bytes of `rels` (worktree paths) via one archive of a staging folder; missing = could not be read (or not a file).
 *  A file that grew beyond the limit meanwhile is named in tooLarge (the others are still fetched); a broken archive throws. */
export async function fetchFiles(runner: SandboxRunner, containerId: string, user: string, roots: Root[], rels: string[], signal?: AbortSignal, locale: Locale = DEFAULT_LOCALE): Promise<Fetched> {
  const out: Fetched = { data: new Map(), tooLarge: new Set() }, L = pullText(locale);
  if (!rels.length) return out;
  const abs = rels.map(r => containerPath(roots, r, locale));
  const dir = `${STAGE_PREFIX}${randomBytes(8).toString('hex')}`;
  try {
    const st = await runner.exec(containerId, ['bash', '-c', STAGE_SH, 'lotse-stage', String(PULL_LIMITS.fileBytes), dir, ...abs], { user, workdir: '/', env: NO_RC, timeoutMs: 120_000, signal });
    if (st.exitCode !== 0) throw new Error(L.stageFailed(redact(st.output).trim().slice(-200)));
    const tar = await runner.getArchive(containerId, dir, { maxBytes: PULL_LIMITS.totalBytes + (rels.length * 2 + 2) * 3 * 1024, timeoutMs: 120_000 });
    const base = path.posix.basename(dir);
    try {
      const { entries } = readTarStrict(tar, { entries: rels.length * 2 + 1, fileBytes: PULL_LIMITS.fileBytes, totalBytes: PULL_LIMITS.totalBytes });
      for (const e of entries) {
        if (e.type !== 'file') continue;
        const m = new RegExp(`^${base}/(\\d{1,5})(\\.big)?$`).exec(e.path);
        const idx = m ? Number(m[1]) : -1, rel = rels[idx];
        if (idx < 0 || idx >= rels.length || out.data.has(rel) || out.tooLarge.has(rel)) throw new TarError(`Archiv: unerwarteter Eintrag „${e.path.slice(0, 80)}“.`);
        if (m![2]) out.tooLarge.add(rel); else out.data.set(rel, e.data);
      }
    } catch (e) { throw e instanceof TarError ? new TarError(L.archive(e.message)) : e; }
  } finally {
    await runner.exec(containerId, ['rm', '-rf', '--', dir], { user, workdir: '/', timeoutMs: 30_000 }).catch(() => {});
  }
  return out;
}
/** Container path of a worktree path: below the most specific root */
function containerPath(roots: Root[], rel: string, locale: Locale = DEFAULT_LOCALE): string {
  const r = rootOf(roots, rel);
  if (!r) throw new Error(pullText(locale).outside(rel.slice(0, 120)));
  return r.rel ? `${r.container}${rel.slice(r.rel.length)}` : `${r.container}/${rel}`;
}
const rootOf = (roots: Root[], rel: string): Root | undefined => roots.filter(x => !x.rel || rel === x.rel || rel.startsWith(`${x.rel}/`)).sort((a, b) => b.rel.length - a.rel.length)[0];

// ---- Comparing ----
interface Candidate { path: string; status: ContainerChange['status']; sha: string | null; size: number; mode: number }
interface Compared { candidates: Candidate[]; skipped: ContainerChanges['skipped']; noBaseline: boolean; scope: Scope; work: Map<string, WEntry> }

/** Under the task lock: the container has what the worktree has (a sync if something is missing), then both sides are listed and compared. */
async function compare(t: CodeTask, signal?: AbortSignal, locale: Locale = DEFAULT_LOCALE): Promise<Compared> {
  if (!t.containerId || !t.containerRunning) throw new Error(pullText(locale).notRunning);
  await syncTaskAll(t, signal, { ifChanged: true }); // the worktree's own changes are no container changes
  const scope = await scopeOf(t, locale), tpl = getTemplate(t.template), worktree = workBase(t);
  const listing = await listContainer(getRunner(), t.containerId, tpl.execUser, scope.roots, signal, locale);
  const work = worktreeEntries(worktree, scope.roots, locale), baseline = readBaseline(t.id);
  const own = baseline?.container === t.containerId ? baseline : null, base = own?.files ?? null, baseWork = own?.work ?? null;
  const skipped = [...listing.skipped], candidates: Candidate[] = [];
  const skip = (p: string, reason: ContainerSkipReason) => { if (skipped.length < 500) skipped.push({ path: p, reason }); };
  const hashCache = new Map<string, string>();
  const workSha = (w: Extract<WEntry, { kind: 'file' }>, rel: string) => { let h = hashCache.get(rel); if (!h) { h = sha(fs.readFileSync(w.abs)); hashCache.set(rel, h); } return h; };
  /** the repository's file is what it was right after the setup (so a difference to the container's version then is the setup's) */
  const workAsSetUp = (rel: string, w: WEntry | undefined) => !!baseWork && (w?.kind === 'file' ? baseWork[rel] === workSha(w, rel) : !w && !(rel in baseWork));
  for (const [rel, e] of [...listing.entries].sort(([a], [b]) => a.localeCompare(b))) {
    if (e.kind === 'dir' || e.kind === 'pruned' || scope.ignore(rel)) continue;
    // secrets and .git are named as skipped (never taken over); anything else outside what this kind of task syncs is not compared
    const secret = isDenied(rel) || isSecretPath(rel);
    if (!secret && !scope.accept(rel)) continue;
    const w = work.get(rel);
    if (e.kind === 'link' || e.kind === 'special' || e.kind === 'unreadable') {
      if ((e.kind === 'link' && w?.kind === 'link') || base?.[rel] === e.kind) continue; // the repository's own link, or one the setup made
      skip(rel, e.kind === 'link' ? 'symlink' : e.kind); continue;
    }
    if (e.kind !== 'file') continue;
    if (w?.kind === 'file' && w.size === e.size && e.sha && workSha(w, rel) === e.sha) continue;
    // the image's or the setup's file, unchanged since – or a repository file the setup changed, untouched on both sides since
    if (e.sha && base?.[rel] === e.sha && (!w || workAsSetUp(rel, w))) continue;
    if (secret) { skip(rel, 'protected'); continue; }
    if (w?.kind === 'link') { skip(rel, 'symlink'); continue; }
    if (e.size > PULL_LIMITS.fileBytes) { skip(rel, 'too-large'); continue; }
    if (!e.sha) { skip(rel, 'unreadable'); continue; }
    candidates.push({ path: rel, status: w ? 'modified' : 'added', sha: e.sha, size: e.size, mode: e.mode });
  }
  /** Whether the listing saw everything where `rel` would be: its root listed completely and every folder above it a plain folder up
   *  to one that is gone as a whole (deleted with its content). Below a link, a device, an unreadable folder, a file in place of a folder
   *  or a folder the listing pruned (vendor/ …) nothing counts as deleted. */
  const seen = (rel: string) => {
    const r = rootOf(scope.roots, rel);
    if (!r || !listing.present.has(r.container)) return false;
    const segs = rel.split('/'), from = r.rel ? r.rel.split('/').length : 0;
    for (let i = from + 1; i < segs.length; i++) {
      const e = listing.entries.get(segs.slice(0, i).join('/'));
      if (!e) return true; // gone, with everything below it
      if (e.kind !== 'dir') return false;
    }
    return true;
  };
  for (const [rel, w] of [...work].sort(([a], [b]) => a.localeCompare(b))) {
    if (w.kind !== 'file' || listing.entries.has(rel) || scope.ignore(rel) || !scope.accept(rel) || isDenied(rel)) continue;
    // a name the listing would have skipped (control characters, too long): whether the container still has it is unknown
    if (archivePath(rel) !== rel || Buffer.byteLength(rel) > 1024) { skip(rel, 'name'); continue; }
    if (!seen(rel)) continue;
    // removed by the setup (the repository's file unchanged since): no change of the container
    if (base && !(rel in base) && workAsSetUp(rel, w)) continue;
    candidates.push({ path: rel, status: 'deleted', sha: null, size: 0, mode: 0 });
  }
  return { candidates, skipped, noBaseline: !base, scope, work };
}

const textOf = (b: Buffer | null) => (b && !isBinary(b) ? b.toString('utf8') : null);
async function head(t: CodeTask): Promise<string> {
  const p = taskPaths(t.id);
  return runGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: p.worktree, gitDir: p.gitDir }).then(r => r.stdout.trim(), () => '');
}
/** Per candidate the reason (in `locale`) the commit checks refuse it (with the container's bytes as the staged ones), or nothing. */
async function checks(t: CodeTask, cands: Candidate[], got: Fetched, locale: Locale): Promise<Map<string, string>> {
  const h = await head(t), out = new Map<string, string>(), L = pullText(locale), kind = messages(locale).server.check.secretKind;
  await pool(cands, 4, async c => {
    const bytes = got.data.get(c.path) ?? null;
    if (got.tooLarge.has(c.path)) { out.set(c.path, L.grewTooLarge(PULL_LIMITS.fileBytes / 1024 / 1024)); return; }
    if (c.status !== 'deleted' && !bytes) { out.set(c.path, L.unreadable); return; }
    if (bytes && sha(bytes) !== c.sha) { out.set(c.path, L.changedMeanwhile); return; }
    const v = await commitVerdict(t, [{ path: withRoot(projectRoot(t), c.path), status: c.status === 'added' ? 'A' : c.status === 'deleted' ? 'D' : 'M' }], h, async () => bytes, locale);
    if (v?.why) out.set(c.path, v.why);
    else if (v?.findings) { const [f] = v.findings; out.set(c.path, L.secret(f.file.slice(0, 120), f.line, kind(f.kind), v.findings.length - 1)); }
  });
  return out;
}

/** "Aus dem Container übernehmen" → "Vergleichen": what differs, with a diff of the text files and why some cannot be taken over. */
export async function containerChanges(t: CodeTask, signal?: AbortSignal, locale: Locale = DEFAULT_LOCALE): Promise<ContainerChanges> {
  const c = await compare(t, signal, locale);
  const tpl = getTemplate(t.template), cands = c.candidates.slice(0, PULL_LIMITS.files), root = projectRoot(t), P = (p: string) => withRoot(root, p);
  for (const x of c.candidates.slice(PULL_LIMITS.files)) c.skipped.push({ path: x.path, reason: 'more' });
  const got = await fetchFiles(getRunner(), t.containerId!, tpl.execUser, c.scope.roots, cands.filter(x => x.status !== 'deleted').map(x => x.path), signal, locale);
  const blocked = await checks(t, cands, got, locale);
  const changes: ContainerChange[] = [], patches: string[] = [];
  let bytes = 0, truncated = false;
  for (const x of cands) {
    const w = c.work.get(x.path), old = w?.kind === 'file' ? fs.readFileSync(w.abs) : null, now = got.data.get(x.path) ?? null;
    const binary = (!!old && isBinary(old)) || (!!now && isBinary(now));
    let added = 0, removed = 0;
    if (!binary) {
      const d = unifiedDiff(P(x.path), textOf(old), x.status === 'deleted' ? null : textOf(now));
      added = d.added; removed = d.removed;
      const patch = redact(d.patch);
      if (bytes + Buffer.byteLength(patch) > PULL_LIMITS.diff) truncated = true;
      else { patches.push(patch); bytes += Buffer.byteLength(patch); }
    } else patches.push(`diff --git a/${P(x.path)} b/${P(x.path)}\nBinary files differ\n`);
    const why = blocked.get(x.path);
    changes.push({ path: P(x.path), status: x.status, added, removed, size: x.size, sha: x.sha, ...(binary ? { binary: true } : {}), ...(why ? { blocked: redact(why).slice(0, 400) } : {}) });
  }
  return { changes, skipped: c.skipped.map(x => ({ ...x, path: P(x.path) })), diff: patches.join(''), truncated, ...(c.noBaseline ? { noBaseline: true } : {}), roots: c.scope.roots.map(r => r.container), checkedAt: new Date().toISOString() };
}

// ---- Writing into the worktree (never through a link) ----
function writeFileSafe(worktree: string, rel: string, data: Buffer, exec: boolean, L: Pull) {
  const realRoot = fs.realpathSync(worktree), segs = rel.split('/');
  let dir = realRoot;
  for (const s of segs.slice(0, -1)) {
    const next = path.join(dir, s);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(next); } catch { /* missing */ }
    if (!st) fs.mkdirSync(next, { mode: 0o755 });
    else if (!st.isDirectory()) throw new Error(L.notDir(rel.slice(0, 120), s));
    dir = next;
  }
  const abs = path.join(dir, segs.at(-1)!);
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(abs); } catch { /* new */ }
  if (st && !st.isFile()) throw new Error(L.notFile(rel.slice(0, 120)));
  const mode = exec ? 0o755 : 0o644;
  const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeSync(fd, data); fs.fchmodSync(fd, mode); } finally { fs.closeSync(fd); }
}
function deleteFileSafe(worktree: string, rel: string, L: Pull) {
  const abs = path.join(fs.realpathSync(worktree), rel);
  if (!realDir(worktree, path.posix.dirname(rel))) throw new Error(L.underLink(rel.slice(0, 120)));
  const st = fs.lstatSync(abs);
  if (!st.isFile()) throw new Error(L.notFileDel(rel.slice(0, 120)));
  fs.unlinkSync(abs);
}

/** The AI asked for everything, but the sandbox has no baseline: the image's and the setup's files would come along */
export const NO_BASELINE_ALL = 'Diese Sandbox wurde eingerichtet, bevor Lotse sich den Ausgangsstand des Containers merkte: Ohne paths würden auch Dateien des Images und der Einrichtung übernommen. Nichts übernommen – pull_from_container mit paths aufrufen (nur die Dateien/Ordner, die du im Container erzeugt oder geändert hast).';

export interface TakeItem { path: string; sha: string | null }
/**
 * Takes container files into the worktree: exactly `items` (the path and the container version the user saw) – or, with `all`, every
 * change that can be taken over (the AI, optionally only below `under`; without a baseline only below `under`). Compared again first:
 * a file changed since is refused. Audited with actor and paths. The caller holds the task lock. Reasons in `locale`.
 */
export async function takeOver(t: CodeTask, sel: { items: TakeItem[] } | { all: true; under?: string[] }, o: { signal?: AbortSignal; via: 'panel' | 'ai'; locale?: Locale }): Promise<ContainerTakeOver & { skipped: ContainerChanges['skipped']; noBaseline?: boolean }> {
  const locale = o.locale ?? DEFAULT_LOCALE, L = pullText(locale);
  if (publishRunning(t.id)) throw Object.assign(new Error(L.publishing), { status: 409 });
  const c = await compare(t, o.signal, locale), worktree = workBase(t), tpl = getTemplate(t.template), root = projectRoot(t), P = (p: string) => withRoot(root, p);
  const byPath = new Map(c.candidates.map(x => [x.path, x]));
  const refused: ContainerTakeOver['refused'] = [];
  let chosen: Candidate[], skipped = c.skipped;
  if ('items' in sel) {
    chosen = [];
    for (const it of sel.items) {
      const x = byPath.get(underRoot(root, it.path) ?? '');
      if (!x) refused.push({ path: it.path, reason: L.noDifference });
      else if (x.sha !== it.sha) refused.push({ path: it.path, reason: L.changedSince });
      else chosen.push(x);
    }
  } else {
    const given = sel.under?.map(u => u.replace(/^\.\/+/, '').replace(/\/+$/, '')).filter(Boolean) ?? [];
    // paths the AI names are repository paths; below a project's subfolder only the ones inside it count (an empty "under" then matches nothing)
    const under = given.flatMap(u => { const r = underRoot(root, u); return r === null ? (root && root.startsWith(`${u}/`) || u === root ? [''] : []) : [r]; });
    if (c.noBaseline && !given.length) throw Object.assign(new Error(NO_BASELINE_ALL), { status: 409 });
    const inside = (p: string) => !given.length || under.some(u => !u || p === u || p.startsWith(`${u}/`));
    // only the asked-for paths: what was skipped elsewhere is not this call's business
    chosen = c.candidates.filter(x => inside(x.path)); skipped = skipped.filter(x => inside(x.path));
  }
  for (const x of chosen.slice(PULL_LIMITS.files)) refused.push({ path: P(x.path), reason: L.tooManyAtOnce(PULL_LIMITS.files) });
  chosen = chosen.slice(0, PULL_LIMITS.files);
  const got = await fetchFiles(getRunner(), t.containerId!, tpl.execUser, c.scope.roots, chosen.filter(x => x.status !== 'deleted').map(x => x.path), o.signal, locale);
  const blocked = await checks(t, chosen, got, locale);
  const taken: ContainerTakeOver['taken'] = [];
  for (const x of chosen) {
    const why = blocked.get(x.path);
    if (why) { refused.push({ path: P(x.path), reason: redact(why).slice(0, 400) }); continue; }
    const w = c.work.get(x.path), old = w?.kind === 'file' ? fs.readFileSync(w.abs) : null, now = got.data.get(x.path) ?? null;
    try {
      if (x.status === 'deleted') deleteFileSafe(worktree, x.path, L);
      else writeFileSafe(worktree, x.path, now!, (x.mode & 0o111) !== 0, L);
    } catch (e) { refused.push({ path: P(x.path), reason: redact(e instanceof Error ? e.message : String(e)).slice(0, 400) }); continue; }
    const d = (old && isBinary(old)) || (now && isBinary(now)) ? { added: 0, removed: 0 } : unifiedDiff(P(x.path), textOf(old), x.status === 'deleted' ? null : textOf(now));
    taken.push({ path: P(x.path), status: x.status, added: d.added, removed: d.removed });
  }
  // the container had these already: nothing to transfer back (any other change of the worktree is still transferred)
  noteInSync(t, taken.map(x => underRoot(root, x.path)!));
  auditAdd({ decision: 'changed', kind: 'sandbox-pull', taskId: t.id, chatId: t.chatId, via: o.via, title: `Aus dem Container übernommen: ${t.title}`, repo: t.repo,
    files: taken.map(x => x.path).slice(0, 50), ...(taken.length > 50 ? { moreFiles: taken.length - 50 } : {}), refused: refused.length });
  if (refused.length) log.info('Nicht alles aus dem Container übernommen', { task: t.id, refused: refused.length });
  return { taken, refused, skipped: skipped.map(x => ({ ...x, path: P(x.path) })), ...(c.noBaseline ? { noBaseline: true } : {}) };
}
