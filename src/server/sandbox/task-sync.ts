import 'server-only';
// Workspace → container for one task (sync.ts does the transfer): a plugin's folder, or a full project's synced parts together with its
// config plan (project.ts). What the plan decided – quarantined config files, what the override switched – is kept on the task's
// layout, so the setup log, get_environment and the agent's prompt can say it. Callers hold the task lock.
import type { ProjectInfo } from '@/lib/protocol';
import { redact } from '../settings';
import type { ConfigPlan, ProjectRuntime } from './project';
import { getRunner } from './runner';
import { syncAll, syncPaths, type SyncTarget } from './sync';
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
    ...(t.layout.kind === 'project' ? { project: { runtime: projectRuntime(p), held: Object.fromEntries((p?.held ?? []).map(h => [h.file, h.reason])) } } : {}),
  };
}

/** Keeps the plan on the task (saved only when it changed) */
function note(t: CodeTask, plan: ConfigPlan | null | undefined) {
  const p = t.layout?.project;
  if (!plan || !p) return;
  const quarantined = [...plan.quarantine].map(([file, reason]) => ({ file, reason: redact(reason) }));
  const overrides = [...plan.notes, ...(plan.envDefaults.length ? [`Umgebungsvariablen ohne Wert in der Sandbox: ${plan.envDefaults.join(', ')}`] : [])];
  if (JSON.stringify([quarantined, overrides]) === JSON.stringify([p.quarantined ?? [], p.overrides ?? []])) return;
  p.quarantined = quarantined; p.overrides = overrides;
  saveTask(t);
}

/** Full sync (setup, wake-up, before sandbox_bash). Returns the number of files and, for a project, the config plan. */
export async function syncTaskAll(t: CodeTask, signal?: AbortSignal): Promise<{ files: number; config: ConfigPlan | null }> {
  const r = await syncAll(target(t, signal));
  note(t, r.config);
  return { files: r.files, config: r.config ?? null };
}
/** Changed paths only (the agent's edits). For a project: quarantined config files newly found are named in `note` for the agent. */
export async function syncTaskPaths(t: CodeTask, rels: string[]): Promise<{ note: string }> {
  const before = new Set((t.layout?.project?.quarantined ?? []).map(q => q.file));
  const r = await syncPaths(target(t), rels);
  note(t, r.config);
  const fresh = r.config ? [...r.config.quarantine].filter(([f]) => rels.includes(f) && !before.has(f)) : [];
  return { note: fresh.length ? ` – in der Sandbox NICHT geladen: ${fresh.map(([f, why]) => `${f} (${why})`).join('; ')}` : '' };
}
