import 'server-only';
// Workspace → container for one task (sync.ts does the transfer): a plugin's folder, or a full project's synced parts together with its
// config plan (project.ts). What the plan decided – quarantined config files, what the override switched – is kept on the task's
// layout, so the setup log, get_environment and the agent's prompt can say it. Callers hold the task lock.
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectInfo } from '@/lib/protocol';
import { redact } from '../settings';
import { singleton } from '../state';
import { projectBase, reasonText, underRoot, withRoot, type ConfigPlan, type ProjectRuntime } from './project';
import { getRunner } from './runner';
import { projectManifest, syncAll, syncPaths, treeManifest, type SyncTarget, type TreeManifest } from './sync';
import { getTemplate } from './templates';
import { saveTask, taskPaths, type CodeTask } from './tasks';

/** The project's runtime as the setup read it from the container; null before that */
export const projectRuntime = (p: ProjectInfo | undefined): ProjectRuntime | null =>
  p?.appEnv && p.extensions && p.envNames ? { appEnv: p.appEnv, extensions: p.extensions, envNames: p.envNames, ...(p.extraEnv?.length ? { extraEnv: p.extraEnv } : {}) } : null;

/** The folder of the repository a full project syncs from: its subfolder (layout.root), '' = the repository's root */
export const rootOf = (t: Pick<CodeTask, 'layout'>): string => (t.layout?.kind === 'project' ? t.layout.root ?? '' : '');
/** Repository paths → paths inside the synced folder (the container's view); what lies outside the project's subfolder is no business of the container */
export const projectRels = (t: Pick<CodeTask, 'layout'>, rels: string[]): string[] => {
  const root = rootOf(t);
  return root ? rels.flatMap(r => { const u = underRoot(root, r); return u ? [u] : []; }) : rels;
};

export function target(t: CodeTask, signal?: AbortSignal): SyncTarget {
  if (!t.layout) throw new Error('Plugin noch nicht erkannt.');
  if (!t.containerId) throw new Error('Kein Container für diese Aufgabe.');
  const tpl = getTemplate(t.template), p = t.layout.project;
  return {
    runner: getRunner(), containerId: t.containerId, worktree: projectBase(taskPaths(t.id).worktree, rootOf(t)), target: tpl.syncTarget(t.layout), user: tpl.execUser, signal,
    ...(t.layout.kind === 'project' ? { project: { runtime: projectRuntime(p), held: Object.fromEntries((p?.held ?? []).map(({ file, ...q }) => [file, q])) } } : {}),
    ...(t.layout.kind === 'custom' ? { custom: true } : {}),
    // a new plugin, also once it settled into an ordinary one: the folder may still be missing (made by plugin:create or the first file)
    ...(t.layout.kind !== 'project' && t.layout.kind !== 'custom' && (t.layout.isNew || t.pluginName) ? { lazy: true } : {}),
  };
}

/** Keeps the plan on the task (saved only when it changed) */
function note(t: CodeTask, plan: ConfigPlan | null | undefined) {
  const p = t.layout?.project;
  if (!plan || !p) return;
  const quarantined = [...plan.quarantine].map(([file, q]) => ({ file, code: q.code, ...(q.detail ? { detail: redact(q.detail) } : {}) }));
  if (JSON.stringify([quarantined, plan.notes, plan.envDefaults]) === JSON.stringify([p.quarantined ?? [], p.overrides ?? [], p.envDefaults ?? []])) return;
  p.quarantined = quarantined; p.overrides = plan.notes; p.envDefaults = plan.envDefaults;
  saveTask(t);
}

// ---- What the container already has ----
// Per task: the container and project settings of the last full sync and the manifest of the worktree the container matches (sync.ts
// TreeManifest; patched for exactly the paths a path sync transferred or that were taken over from the container, container-pull.ts),
// plus the paths changed while the container was paused (null = too many to track). Kept in the task's workspace folder, so a Lotse
// restart does not mirror everything again: a full mirror removes what was made only inside the container (e.g. composer require,
// bin/console plugin:create) before the user could take it over. A change that did not come through the tools (made on the host, a
// crash between writing and syncing) differs from the manifest and is transferred on the next sync – never masked.
interface SyncState { container: string; project: string; files: TreeManifest; pending: string[] | null }
const PENDING_MAX = 2000;
const stateFile = (id: string) => path.join(taskPaths(id).workspace, 'sync-state.json');
const memo = () => singleton<Map<string, SyncState | null>>('sandboxSyncState', () => new Map());
const isManifest = (v: unknown): v is TreeManifest => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'string');
function readState(id: string): SyncState | null {
  const m = memo();
  if (m.has(id)) return m.get(id) ?? null;
  let s: SyncState | null = null;
  try {
    const v = JSON.parse(fs.readFileSync(stateFile(id), 'utf8')) as Partial<SyncState>;
    if (typeof v.container === 'string' && typeof v.project === 'string' && isManifest(v.files) && (v.pending === null || (Array.isArray(v.pending) && v.pending.every(p => typeof p === 'string'))))
      s = { container: v.container, project: v.project, files: v.files, pending: v.pending };
  } catch { /* none yet */ }
  m.set(id, s);
  return s;
}
function writeState(id: string, s: SyncState | null) {
  memo().set(id, s);
  try {
    if (!s) fs.rmSync(stateFile(id), { force: true });
    else if (fs.existsSync(taskPaths(id).workspace)) fs.writeFileSync(stateFile(id), JSON.stringify(s), { mode: 0o600 });
  } catch { /* memory still has it */ }
}
const projectKey = (tg: SyncTarget) => JSON.stringify(tg.project ?? null);
const manifestOf = (tg: SyncTarget) => (tg.project ? projectManifest(tg.worktree) : treeManifest(tg.worktree));
const current = (t: CodeTask, tg: SyncTarget): SyncState | null => { const s = readState(t.id); return s && s.container === t.containerId && s.project === projectKey(tg) ? s : null; };
/** Paths whose entry differs between what the container got and the worktree now (a folder that only appeared: its entries count) */
export function manifestChanges(had: TreeManifest, now: TreeManifest): string[] {
  const out: string[] = [];
  for (const [rel, v] of Object.entries(now)) if (had[rel] !== v && !(v === 'd' && had[rel] === undefined)) out.push(rel);
  for (const rel of Object.keys(had)) if (!(rel in now)) out.push(rel);
  return out.sort();
}
const under = (rel: string, p: string) => rel === p || rel.startsWith(`${p}/`);

/**
 * Full sync (setup, wake-up, before sandbox_bash). Returns the number of files and, for a project, the config plan. `ifChanged`
 * (wake-up, sandbox_bash, taking files over): when the worktree did not change since the container got it, nothing is mirrored again;
 * otherwise just the changed paths (and the ones edited while the container was paused) are synced. A full mirror only without a
 * record of what the container has, or with too many changes.
 */
export async function syncTaskAll(t: CodeTask, signal?: AbortSignal, o: { ifChanged?: boolean } = {}): Promise<{ files: number; config: ConfigPlan | null; skipped?: boolean; deferred?: boolean }> {
  const tg = target(t, signal);
  const s = o.ifChanged ? current(t, tg) : null;
  if (s?.pending) {
    // read before the transfer: a change while it runs differs next time instead of being taken as transferred
    const now = manifestOf(tg), paths = [...new Set([...s.pending, ...manifestChanges(s.files, now)])];
    if (!paths.length) return { files: 0, config: null, skipped: true };
    if (paths.length <= PENDING_MAX) {
      writeState(t.id, null); // a failure below leaves the next call a full sync
      const r = await syncPaths(tg, paths);
      note(t, r.config);
      // a new plugin's folder not made yet: the paths still differ and go along once it exists
      writeState(t.id, r.deferred ? { ...s, pending: paths } : { ...s, files: now, pending: [] });
      return { files: r.put, config: r.config ?? null, ...(r.deferred ? { deferred: true } : {}) };
    }
  }
  writeState(t.id, null);
  const now = manifestOf(tg);
  const r = await syncAll(tg);
  note(t, r.config);
  // deferred (a new plugin's folder not made yet): the container has none of the worktree's files
  writeState(t.id, { container: t.containerId ?? '', project: projectKey(tg), files: r.deferred ? {} : now, pending: [] });
  return { files: r.files, config: r.config ?? null, ...(r.deferred ? { deferred: true } : {}) };
}
/** The container now has the worktree's state of exactly `rels` (files or folders; after a path sync or after taking files over from
 *  it): only their entries (and their parent folders) are updated, so any other change still differs and is transferred later.
 *  `now`: the worktree's manifest read before that transfer. */
export function noteInSync(t: CodeTask, rels: string[], now?: TreeManifest) {
  if (!t.layout || !t.containerId || !rels.length) return;
  const tg = target(t), s = current(t, tg);
  if (!s?.pending) return;
  const m = now ?? manifestOf(tg), files = { ...s.files };
  for (const r of rels) {
    for (const k of Object.keys(files)) if (under(k, r)) delete files[k];
    for (const [k, v] of Object.entries(m)) if (under(k, r)) files[k] = v;
    const segs = r.split('/');
    for (let i = 1; i < segs.length; i++) { const d = segs.slice(0, i).join('/'); if (m[d]) files[d] = m[d]; }
  }
  writeState(t.id, { ...s, files, pending: s.pending.filter(p => !rels.some(r => under(p, r))) });
}
/** Paths changed while the container is paused: synced alone when it wakes (too many: a full sync). */
export function notePending(id: string, rels: string[]) {
  const s = readState(id);
  if (!s || !s.pending) return;
  const all = [...new Set([...s.pending, ...rels])];
  writeState(id, { ...s, pending: all.length > PENDING_MAX ? null : all });
}
/** Forget what the container had (a new container, a new clone). */
export const forgetSync = (id: string) => writeState(id, null);
/** Changed paths only (the agent's edits). For a project: quarantined config files newly found are named in `note` for the agent. */
export async function syncTaskPaths(t: CodeTask, repoRels: string[]): Promise<{ note: string }> {
  const rels = projectRels(t, repoRels);
  if (!rels.length) return { note: '' }; // only files outside the project's folder: nothing in the container to update
  const before = new Set((t.layout?.project?.quarantined ?? []).map(q => q.file));
  const tg = target(t), now = manifestOf(tg);
  let r: Awaited<ReturnType<typeof syncPaths>>;
  try { r = await syncPaths(tg, rels); } catch (e) { forgetSync(t.id); throw e; }
  note(t, r.config);
  if (!r.deferred) noteInSync(t, rels, now);
  const fresh = r.config ? [...r.config.quarantine].filter(([f]) => rels.includes(f) && !before.has(f)) : [];
  return { note: fresh.length ? ` – in der Sandbox NICHT geladen: ${fresh.map(([f, q]) => `${withRoot(rootOf(t), f)} (${redact(reasonText(q))})`).join('; ')}` : '' };
}
