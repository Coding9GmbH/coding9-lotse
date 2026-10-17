import 'server-only';
// Setup job and container lifecycle of code tasks. Everything runs detached from the HTTP request (like a chat turn):
// - runSteps: the template's steps in order, each persisted at once, with a time limit and an AbortController per task
// - one lock per task: setup steps, wake-up and (later) run_command never run in the same container at the same time
// - LOTSE_SANDBOX_MAX running containers: one more pauses the least recently used ready task, otherwise 409
// - pause = docker stop (code, database and changes stay), wake = docker start + wait + full sync (no new setup)
// - finish = container, workspace, git dir, dump and screenshots removed; the task stays as a record (done)
import fs from 'node:fs';
import type { CodeTaskStatus } from '@/lib/protocol';
import { codeTaskDelete } from '../db';
import { cloneRepo } from '../git';
import { log } from '../log';
import { redact } from '../settings';
import { singleton } from '../state';
import { errMsg } from '../util';
import { getSandboxConfig, maxRunning, sandboxEnabled, sandboxStatus } from './env';
import { allocateLocalPort, ensureNetwork, networkMode } from './network';
import { getRunner } from './runner';
import { TASK_LABEL } from './labels';
import { syncAll } from './sync';
import { getTemplate, resolveCommand } from './templates';
import { waitReady } from './templates/dockware-play';
import type { StepCtx } from './templates/types';
import { appendLog, emitTask, getTask, httpStatusOf, listTasks, mustTask, now, sandboxOrigin, saveTask, taskPaths, type CodeTask, type StoredStep } from './tasks';

export class TaskConflict extends Error { readonly status = 409; }
/** Statuses in which the task's container runs (or is about to): they count against LOTSE_SANDBOX_MAX. */
const RUNNING: CodeTaskStatus[] = ['setting_up', 'waking', 'ready'];
const MAX_OUTPUT = 256 * 1024;

interface Jobs { setup: Map<string, { ac: AbortController; done: Promise<void> }>; wakes: Map<string, Promise<void>>; locks: Map<string, Promise<unknown>> }
const jobs = () => singleton<Jobs>('sandboxJobs', () => ({ setup: new Map(), wakes: new Map(), locks: new Map() }));
export const setupRunning = (id: string) => jobs().setup.has(id);

/** Serializes everything that execs in one task container. */
export function withTaskLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const L = jobs().locks;
  const prev = L.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  L.set(id, tail);
  void tail.then(() => { if (L.get(id) === tail) L.delete(id); });
  return next;
}

function assertOn() {
  const s = sandboxStatus();
  if (!s.enabled) throw Object.assign(new Error(s.message ?? 'Sandbox Coding ist ausgeschaltet.'), { status: 403 });
}

/** Marks the task active (idle timer starts again). */
export function touchTask(id: string) {
  const t = getTask(id);
  if (!t || t.status === 'done' || setupRunning(id)) return; // a running setup holds its own copy of the row and is active anyway
  if (Date.now() - Date.parse(t.lastActiveAt) < 30_000) return; // a heartbeat does not need a write every time
  t.lastActiveAt = now(); saveTask(t, false);
}

// ---- Capacity: LOTSE_SANDBOX_MAX ----
/** Synchronously decides which ready tasks are paused for `self` and marks them; the containers are stopped afterwards. */
function makeRoom(self: string): CodeTask[] {
  const max = maxRunning();
  const others = listTasks().filter(t => t.id !== self && RUNNING.includes(t.status));
  const victims: CodeTask[] = [];
  const idle = others.filter(t => t.status === 'ready' && !setupRunning(t.id)).sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt));
  while (others.length - victims.length >= max) {
    const v = idle.shift();
    if (!v) throw new TaskConflict(`Es laufen bereits ${others.length} Sandboxes (höchstens ${max}, LOTSE_SANDBOX_MAX). Warte, bis eine Einrichtung fertig ist, oder pausiere eine Aufgabe.`);
    victims.push(v);
  }
  for (const v of victims) { v.status = 'paused'; saveTask(v); }
  return victims;
}
const stopVictims = (victims: CodeTask[]) => Promise.all(victims.map(v => withTaskLock(v.id, () => stopContainer(v)).catch(e => log.warn('Sandbox pausieren fehlgeschlagen', { task: v.id, error: e }))));

async function stopContainer(t: CodeTask) {
  if (!t.containerId) return;
  await getRunner().stop(t.containerId);
  const fresh = getTask(t.id);
  if (fresh) { fresh.containerRunning = false; saveTask(fresh); }
}

// ---- Setup ----
/** Starts (or resumes) the setup from `fromStep` (default: the first step not done). Returns at once; the job runs detached. */
export function runSteps(id: string, fromStep?: string): CodeTask {
  assertOn();
  const t = mustTask(id);
  if (setupRunning(id) || jobs().wakes.has(id)) throw new TaskConflict('Für diese Aufgabe läuft bereits ein Vorgang.');
  if (t.status === 'done') throw new TaskConflict('Die Aufgabe ist abgeschlossen.');
  const from = fromStep ? t.steps.findIndex(s => s.id === fromStep) : t.steps.findIndex(s => s.state !== 'done' && s.state !== 'skipped');
  if (fromStep && from < 0) throw Object.assign(new Error('Unbekannter Schritt.'), { status: 400 });
  if (from < 0) throw new TaskConflict('Die Einrichtung ist bereits fertig.');
  const victims = makeRoom(id);
  for (const s of t.steps.slice(from)) { s.state = 'pending'; s.log = []; delete s.startedAt; delete s.endedAt; delete s.error; }
  t.status = 'setting_up'; t.error = null; t.lastActiveAt = now();
  saveTask(t);
  const ac = new AbortController();
  const done = stopVictims(victims).then(() => withTaskLock(id, () => execute(id, from, ac.signal)))
    .catch(e => log.error('Sandbox-Einrichtung abgebrochen', { task: id, error: e }))
    .finally(() => { jobs().setup.delete(id); });
  jobs().setup.set(id, { ac, done });
  return t;
}

/** Stop the running setup: the current step becomes "interrupted", the container is stopped (retry continues there). */
export async function stopSetup(id: string): Promise<CodeTask> {
  const t = mustTask(id);
  const job = jobs().setup.get(id);
  if (!job) throw new TaskConflict('Es läuft keine Einrichtung.');
  job.ac.abort();
  await job.done;
  const fresh = mustTask(id);
  if (fresh.containerId && fresh.containerRunning) await withTaskLock(id, () => stopContainer(fresh)).catch(() => {});
  return getTask(id) ?? t;
}

async function execute(id: string, from: number, signal: AbortSignal) {
  const t = mustTask(id);
  const tpl = getTemplate(t.template);
  const startIdx = t.steps.findIndex(s => s.key === 'start-container');
  for (let i = from; i < t.steps.length; i++) {
    const step = t.steps[i];
    const def = step.key === 'custom' ? null : tpl.steps.find(s => s.id === step.key);
    const limit = step.key === 'custom' ? (step.timeoutSec ?? 600) * 1000 : def?.timeoutMs ?? 60_000;
    const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(limit)]);
    step.state = 'running'; step.startedAt = now(); step.log = []; delete step.endedAt; delete step.error;
    saveTask(t);
    try {
      if (signal.aborted) throw new Error('Abgebrochen.');
      const ctx = stepCtx(t, step, stepSignal, limit);
      if (startIdx >= 0 && i > startIdx) await ensureRunning(t, ctx);
      const r = step.key === 'custom' ? await ctx.run(['bash', '-lc', step.command ?? 'false'], { timeoutMs: limit }) : await def?.run?.(ctx);
      step.state = r === 'skipped' ? 'skipped' : 'done';
    } catch (e) {
      const stopped = signal.aborted, timedOut = !stopped && stepSignal.aborted;
      const msg = stopped ? 'Abgebrochen.' : timedOut ? `Zeitüberschreitung nach ${Math.round(limit / 60_000) || 1} Min.` : redact(errMsg(e)).slice(0, 1500);
      step.state = stopped ? 'interrupted' : 'failed'; step.error = msg; step.endedAt = now();
      t.status = stopped ? 'interrupted' : 'failed';
      t.error = stopped ? null : msg;
      saveTask(t);
      return;
    }
    step.endedAt = now();
    saveTask(t);
  }
  t.status = 'ready'; t.lastActiveAt = now();
  saveTask(t);
}

/** Retry after a restart or a pause: a later step needs the container running and Shopware answering. */
async function ensureRunning(t: CodeTask, ctx: StepCtx) {
  if (!t.containerId) throw new Error('Kein Container – ab „Container starten“ erneut versuchen.');
  const info = await getRunner().inspect(t.containerId);
  if (!info) { t.containerId = null; t.containerRunning = false; saveTask(t); throw new Error('Der Container fehlt – ab „Container starten“ erneut versuchen.'); }
  if (info.running) return;
  ctx.log('Container ist gestoppt – starte ihn …');
  await getRunner().start(t.containerId);
  t.containerRunning = true; saveTask(t);
  await waitReady(ctx);
}

/** The restricted context a template step runs in. */
function stepCtx(t: CodeTask, step: StoredStep, signal: AbortSignal, limit: number): StepCtx {
  const tpl = getTemplate(t.template), runner = getRunner(), p = taskPaths(t.id);
  const lg = (line: string) => appendLog(t, step, line, redact);
  const container = () => { if (!t.containerId) throw new Error('Kein Container für diese Aufgabe.'); return t.containerId; };
  return {
    taskId: t.id, repo: t.repo, baseBranch: t.baseBranch, image: getSandboxConfig().image, worktree: p.worktree, signal, log: lg,
    layout: () => t.layout,
    setLayout: l => { t.layout = l; saveTask(t, false); },
    run: async (cmd, o = {}) => {
      const r = Array.isArray(cmd) ? { argv: cmd as readonly string[], user: tpl.execUser, workdir: tpl.workdir, timeoutMs: o.timeoutMs ?? limit, maxOutput: MAX_OUTPUT }
        : resolveCommand(tpl, (cmd as { command: string }).command, (cmd as { args?: Record<string, string> }).args, { pluginDir: t.layout?.pluginDir ?? '' });
      if (!o.quiet) lg(`$ ${step.key === 'custom' && step.command ? step.command.split('\n')[0].slice(0, 200) : r.argv.map(a => (a.length > 80 ? `${a.slice(0, 77)}…` : a)).join(' ')}`);
      const res = await runner.exec(container(), r.argv, { user: r.user, workdir: r.workdir, timeoutMs: Math.min(o.timeoutMs ?? r.timeoutMs, limit), maxOutput: r.maxOutput, signal });
      if (!o.quiet) lg(res.output);
      if (!(o.okCodes ?? [0]).includes(res.exitCode)) {
        const tail = redact(res.output).trim().split('\n').slice(-15).join('\n');
        throw new Error(`${step.key === 'custom' ? `„${step.label}“` : `„${r.argv.slice(0, 3).join(' ')}“`} fehlgeschlagen (Exit-Code ${res.exitCode})${tail ? `:\n${tail}` : '.'}`);
      }
      return { exitCode: res.exitCode, output: res.output };
    },
    ensureImage: async () => {
      let last = 0;
      const { pulled } = await runner.ensureImage(getSandboxConfig().image, pr => { if (Date.now() - last > 2000 || pr.pct === 100) { last = Date.now(); lg(`${pr.text}${pr.pct !== undefined ? ` (${pr.pct} %)` : ''}`); } }, signal);
      lg(pulled ? 'Image geladen.' : 'Image ist vorhanden.');
    },
    clone: async () => {
      fs.rmSync(p.workspace, { recursive: true, force: true });
      fs.rmSync(p.gitDir, { recursive: true, force: true });
      return cloneRepo(t.repo, t.baseBranch, p.worktree, p.gitDir, { signal });
    },
    createContainer: async () => {
      const cfg = getSandboxConfig(), mode = networkMode();
      for (const c of await runner.list({ [TASK_LABEL]: t.id })) { lg(`Alten Container ${c.name} entfernen …`); await runner.remove(c.id); }
      t.containerId = null; t.containerRunning = false;
      if (mode === 'network') await ensureNetwork(runner);
      const port = mode === 'local' ? await allocateLocalPort() : undefined;
      const spec = tpl.buildSpec({ taskId: t.id, image: cfg.image, memoryMb: cfg.memoryMb, cpus: cfg.cpus, env: cfg.env, mode, port });
      t.containerId = await runner.create(spec);
      t.mode = mode; t.port = port ?? null;
      saveTask(t, false);
      await runner.start(t.containerId);
      t.containerRunning = true; saveTask(t);
      lg(`Container ${spec.name} gestartet (${mode === 'local' ? `127.0.0.1:${port}` : 'Netzwerk lotse-sandbox'}).`);
    },
    httpStatus: async path => httpStatusOf(await sandboxOrigin(t), path, signal),
    syncAll: async () => {
      if (!t.layout) throw new Error('Plugin noch nicht erkannt.');
      const r = await syncAll({ runner, containerId: container(), worktree: p.worktree, target: tpl.syncTarget(t.layout), user: tpl.execUser, signal });
      lg(`${r.files} Dateien nach ${tpl.syncTarget(t.layout)} übertragen.`);
    },
  };
}

// ---- Lifecycle: pause, wake, finish ----
export async function pauseTask(id: string): Promise<CodeTask> {
  const t = mustTask(id);
  if (setupRunning(id)) throw new TaskConflict('Die Einrichtung läuft noch – erst „Stoppen“.');
  if (t.status !== 'ready') throw new TaskConflict('Nur eine bereite Aufgabe kann pausiert werden.');
  t.status = 'paused'; saveTask(t);
  await withTaskLock(id, () => stopContainer(t));
  return mustTask(id);
}

/** "Fortsetzen": starts waking a paused task (start, wait for Shopware, full sync) and returns at once. Throws on conflicts. */
export function startWake(id: string): CodeTask {
  assertOn();
  const t = mustTask(id);
  if ((t.status === 'ready' && t.containerRunning) || jobs().wakes.has(id)) { touchTask(id); return t; }
  if (t.status !== 'paused') throw new TaskConflict(t.status === 'setting_up' ? 'Die Umgebung wird noch eingerichtet.' : 'Die Umgebung ist nicht bereit – Einrichtung erneut versuchen.');
  const victims = makeRoom(id);
  t.status = 'waking'; t.error = null; t.lastActiveAt = now(); saveTask(t);
  const p = stopVictims(victims).then(() => withTaskLock(id, () => wake(id))).finally(() => { jobs().wakes.delete(id); });
  p.catch(() => {}); // the error is on the task
  jobs().wakes.set(id, p);
  return t;
}
/** Make sure the task's container runs; shared by concurrent callers. Later used by the chat (before the agent turn) and the preview. */
export async function ensureAwake(id: string): Promise<void> {
  startWake(id);
  await jobs().wakes.get(id);
}
async function wake(id: string) {
  const t = mustTask(id);
  const step: StoredStep = { id: 'wake', key: 'wait-ready', state: 'running', log: [] }; // log target only, not stored in the task
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 5 * 60_000);
  try {
    if (!t.containerId || !t.layout) throw new Error('Kein Container – Einrichtung erneut versuchen.');
    const ctx = stepCtx(t, step, ac.signal, 5 * 60_000);
    await getRunner().start(t.containerId);
    t.containerRunning = true; saveTask(t);
    await waitReady(ctx);
    await ctx.syncAll();
    t.status = 'ready'; t.lastActiveAt = now(); saveTask(t);
  } catch (e) {
    const fresh = getTask(id) ?? t;
    fresh.status = 'paused'; fresh.error = `Fortsetzen fehlgeschlagen: ${redact(errMsg(e)).slice(0, 500)}`;
    saveTask(fresh);
    throw e;
  } finally { clearTimeout(timer); }
}

/** "Aufgabe abschließen": stops everything and removes container, volumes, workspace, git dir, dump and screenshots. The row stays. */
export async function finishTask(id: string): Promise<CodeTask> {
  mustTask(id);
  const job = jobs().setup.get(id);
  if (job) { job.ac.abort(); await job.done; }
  await jobs().wakes.get(id)?.catch(() => {});
  await withTaskLock(id, async () => {
    const fresh = mustTask(id);
    if (fresh.containerId) await getRunner().remove(fresh.containerId);
    for (const c of await getRunner().list({ [TASK_LABEL]: id }).catch(() => [])) await getRunner().remove(c.id);
    const p = taskPaths(id);
    for (const d of [p.workspace, p.gitDir, p.dumps, p.screenshots]) fs.rmSync(d, { recursive: true, force: true });
    for (const s of fresh.steps) if (s.state === 'running') s.state = 'interrupted';
    Object.assign(fresh, { status: 'done', containerId: null, containerRunning: false, finishedAt: now(), error: null } satisfies Partial<CodeTask>);
    saveTask(fresh);
  });
  return mustTask(id);
}

/** Remove the task completely (also its record). Containers and files go first; Docker unreachable = error, nothing deleted. */
export async function deleteTask(id: string): Promise<void> {
  const t = mustTask(id);
  if (t.status !== 'done' || t.containerId) await finishTask(id);
  else for (const d of Object.values(taskPaths(id))) fs.rmSync(d, { recursive: true, force: true });
  codeTaskDelete(id);
  emitTask(id, { t: 'deleted' });
}

/** Sandbox Coding switched off: abort setups, stop (not remove) every running task container. Switching on again resumes on demand. */
export async function suspendAll(): Promise<number> {
  for (const j of jobs().setup.values()) j.ac.abort();
  await Promise.all([...jobs().setup.values()].map(j => j.done));
  let n = 0;
  for (const t of listTasks()) {
    if (t.status === 'ready' || t.status === 'waking') { t.status = 'paused'; saveTask(t); }
    if (t.containerId && t.containerRunning) await withTaskLock(t.id, () => stopContainer(t)).then(() => n++, () => {});
  }
  return n;
}

/** Idle sweeper body: ready tasks without activity for idleMinutes (and nobody watching) are paused; containers of failed tasks stopped. */
export async function pauseIdle(nowMs = Date.now(), watching: (id: string) => boolean = () => false): Promise<string[]> {
  if (!sandboxEnabled()) return [];
  const idleMs = getSandboxConfig().idleMinutes * 60_000, paused: string[] = [];
  for (const t of listTasks()) {
    if (!t.containerId || !t.containerRunning || setupRunning(t.id) || jobs().wakes.has(t.id) || watching(t.id)) continue;
    if (!['ready', 'failed', 'interrupted'].includes(t.status) || nowMs - Date.parse(t.lastActiveAt) < idleMs) continue;
    if (t.status === 'ready') { t.status = 'paused'; saveTask(t); }
    await withTaskLock(t.id, () => stopContainer(t)).then(() => paused.push(t.id), e => log.warn('Sandbox pausieren fehlgeschlagen', { task: t.id, error: e }));
  }
  return paused;
}
