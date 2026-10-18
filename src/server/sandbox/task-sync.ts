import 'server-only';
// Workspace → container for one task (sync.ts does the transfer): a plugin's folder, or a full project's synced parts together with its
// config plan (project.ts). What the plan decided – quarantined config files, what the override switched – is kept on the task's
// layout, so the setup log, get_environment and the agent's prompt can say it. Callers hold the task lock.
import type { ProjectInfo } from '@/lib/protocol';
import { redact } from '../settings';
import { reasonText, type ConfigPlan, type ProjectRuntime } from './project';
import { getRunner } from './runner';
import { projectStamp, syncAll, syncPaths, type SyncTarget } from './sync';
import { getTemplate } from './templates';
import { saveTask, taskPaths, type CodeTask } from './tasks';

/** The project's runtime as the setup read it from the container; null before that */
export const projectRuntime = (p: ProjectInfo | undefined): ProjectRuntime | null =>
  p?.appEnv && p.extensions && p.envNames ? { appEnv: p.appEnv, extensions: p.extensions, envNames: p.envNames, ...(p.extraEnv?.length ? { extraEnv: p.extraEnv } : {}) } : null;

function target(t: CodeTask, signal?: AbortSignal): SyncTarget {
  if (!t.layout) throw new Error('Plugin noch nicht erkannt.');
  if (!t.containerId) throw new Error('Kein Container für diese Aufgabe.');
  const tpl = getTemplate(t.template), p = t.layout.project;
  return {
    runner: getRunner(), containerId: t.containerId, worktree: taskPaths(t.id).worktree, target: tpl.syncTarget(t.layout), user: tpl.execUser, signal,
    ...(t.layout.kind === 'project' ? { project: { runtime: projectRuntime(p), held: Object.fromEntries((p?.held ?? []).map(({ file, ...q }) => [file, q])) } } : {}),
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

/** Per task: what its container got with the last full project sync (container, runtime, held files, the worktree's stamp) */
const lastFull = new Map<string, string>();
/**
 * Full sync (setup, wake-up, before sandbox_bash). Returns the number of files and, for a project, the config plan. `ifChanged`
 * (sandbox_bash): a project whose synced parts did not change since its last full sync into the same container is not mirrored again
 * (a project with many plugins would otherwise upload them all before every command); the agent's edits went through syncTaskPaths.
 */
export async function syncTaskAll(t: CodeTask, signal?: AbortSignal, o: { ifChanged?: boolean } = {}): Promise<{ files: number; config: ConfigPlan | null; skipped?: boolean }> {
  const tg = target(t, signal);
  const key = tg.project ? `${t.containerId}\0${JSON.stringify(tg.project)}\0${projectStamp(tg.worktree)}` : null;
  if (o.ifChanged && key && lastFull.get(t.id) === key) return { files: 0, config: null, skipped: true };
  lastFull.delete(t.id);
  const r = await syncAll(tg);
  note(t, r.config);
  if (key) lastFull.set(t.id, key);
  return { files: r.files, config: r.config ?? null };
}
/** Changed paths only (the agent's edits). For a project: quarantined config files newly found are named in `note` for the agent. */
export async function syncTaskPaths(t: CodeTask, rels: string[]): Promise<{ note: string }> {
  const before = new Set((t.layout?.project?.quarantined ?? []).map(q => q.file));
  const r = await syncPaths(target(t), rels);
  note(t, r.config);
  const fresh = r.config ? [...r.config.quarantine].filter(([f]) => rels.includes(f) && !before.has(f)) : [];
  return { note: fresh.length ? ` – in der Sandbox NICHT geladen: ${fresh.map(([f, q]) => `${f} (${redact(reasonText(q))})`).join('; ')}` : '' };
}
