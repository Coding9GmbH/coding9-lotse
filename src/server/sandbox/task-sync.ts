import 'server-only';
// Workspace → container for one task (sync.ts does the transfer): a plugin's folder, or a full project's synced parts together with its
// config plan (project.ts). What the plan decided – quarantined config files, what the override switched – is kept on the task's
// layout, so the setup log, get_environment and the agent's prompt can say it. Callers hold the task lock.
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectInfo } from '@/lib/protocol';
import { redact } from '../settings';
import { singleton } from '../state';
import { reasonText, type ConfigPlan, type ProjectRuntime } from './project';
import { getRunner } from './runner';
import { projectStamp, syncAll, syncPaths, treeStamp, type SyncTarget } from './sync';
import { getTemplate } from './templates';
import { saveTask, taskPaths, type CodeTask } from './tasks';

/** The project's runtime as the setup read it from the container; null before that */
export const projectRuntime = (p: ProjectInfo | undefined): ProjectRuntime | null =>
  p?.appEnv && p.extensions && p.envNames ? { appEnv: p.appEnv, extensions: p.extensions, envNames: p.envNames, ...(p.extraEnv?.length ? { extraEnv: p.extraEnv } : {}) } : null;

export function target(t: CodeTask, signal?: AbortSignal): SyncTarget {
  if (!t.layout) throw new Error('Plugin noch nicht erkannt.');
  if (!t.containerId) throw new Error('Kein Container für diese Aufgabe.');
  const tpl = getTemplate(t.template), p = t.layout.project;
  return {
    runner: getRunner(), containerId: t.containerId, worktree: taskPaths(t.id).worktree, target: tpl.syncTarget(t.layout), user: tpl.execUser, signal,
    ...(t.layout.kind === 'project' ? { project: { runtime: projectRuntime(p), held: Object.fromEntries((p?.held ?? []).map(({ file, ...q }) => [file, q])) } } : {}),
    ...(t.layout.kind === 'custom' ? { custom: true } : {}),
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
// Per task: the container and project settings of the last full sync and the worktree's fingerprint the container matches (updated by
// every successful path sync and by taking files over from the container, container-pull.ts), plus the paths changed while the container
// was paused (null = too many to track). Kept in the task's workspace folder, so a Lotse restart does not mirror everything again:
// a full mirror removes what was made only inside the container (e.g. composer require, bin/console plugin:create) before the user
// could take it over.
interface SyncState { container: string; project: string; stamp: string; pending: string[] | null }
const PENDING_MAX = 2000;
const stateFile = (id: string) => path.join(taskPaths(id).workspace, 'sync-state.json');
const memo = () => singleton<Map<string, SyncState | null>>('sandboxSyncState', () => new Map());
function readState(id: string): SyncState | null {
  const m = memo();
  if (m.has(id)) return m.get(id) ?? null;
  let s: SyncState | null = null;
  try {
    const v = JSON.parse(fs.readFileSync(stateFile(id), 'utf8')) as Partial<SyncState>;
    if (typeof v.container === 'string' && typeof v.project === 'string' && typeof v.stamp === 'string' && (v.pending === null || (Array.isArray(v.pending) && v.pending.every(p => typeof p === 'string'))))
      s = { container: v.container, project: v.project, stamp: v.stamp, pending: v.pending };
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
const stampOf = (tg: SyncTarget) => (tg.project ? projectStamp(tg.worktree) : treeStamp(tg.worktree));
const current = (t: CodeTask, tg: SyncTarget): SyncState | null => { const s = readState(t.id); return s && s.container === t.containerId && s.project === projectKey(tg) ? s : null; };

/**
 * Full sync (setup, wake-up, before sandbox_bash). Returns the number of files and, for a project, the config plan. `ifChanged`
 * (wake-up, sandbox_bash, taking files over): when the worktree did not change since the container got it, nothing is mirrored again;
 * when only paths edited while the container was paused changed, just those are synced. Everything else mirrors in full.
 */
export async function syncTaskAll(t: CodeTask, signal?: AbortSignal, o: { ifChanged?: boolean } = {}): Promise<{ files: number; config: ConfigPlan | null; skipped?: boolean }> {
  const tg = target(t, signal);
  const s = o.ifChanged ? current(t, tg) : null;
  if (s) {
    const stamp = stampOf(tg);
    if (s.stamp === stamp && !s.pending?.length) return { files: 0, config: null, skipped: true };
    if (s.pending?.length) {
      writeState(t.id, null); // a failure below leaves the next call a full sync
      const r = await syncPaths(tg, s.pending);
      note(t, r.config);
      writeState(t.id, { ...s, stamp: stampOf(tg), pending: [] });
      return { files: r.put, config: r.config ?? null };
    }
  }
  writeState(t.id, null);
  const r = await syncAll(tg);
  note(t, r.config);
  writeState(t.id, { container: t.containerId ?? '', project: projectKey(tg), stamp: stampOf(tg), pending: [] });
  return { files: r.files, config: r.config ?? null };
}
/** The container now has exactly the worktree's state for the synced parts (after a path sync or after taking files over from it). */
export function noteInSync(t: CodeTask) {
  if (!t.layout || !t.containerId) return;
  const tg = target(t), s = current(t, tg);
  if (s && !s.pending?.length) writeState(t.id, { ...s, stamp: stampOf(tg) });
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
export async function syncTaskPaths(t: CodeTask, rels: string[]): Promise<{ note: string }> {
  const before = new Set((t.layout?.project?.quarantined ?? []).map(q => q.file));
  let r: Awaited<ReturnType<typeof syncPaths>>;
  try { r = await syncPaths(target(t), rels); } catch (e) { forgetSync(t.id); throw e; }
  note(t, r.config);
  noteInSync(t);
  const fresh = r.config ? [...r.config.quarantine].filter(([f]) => rels.includes(f) && !before.has(f)) : [];
  return { note: fresh.length ? ` – in der Sandbox NICHT geladen: ${fresh.map(([f, q]) => `${f} (${redact(reasonText(q))})`).join('; ')}` : '' };
}
