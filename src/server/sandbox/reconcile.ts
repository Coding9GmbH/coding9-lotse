import 'server-only';
// After a Lotse restart: steps that were running become "interrupted"; labelled containers without a task (or of a finished task)
// are removed; the containers of the other tasks keep their state (a running one stays ready, a stopped one is paused).
// Also starts the idle sweeper (one interval per process, unref: never keeps the process alive), which also deletes stale dumps.
// Dumps are swept at startup whether Sandbox Coding is on or not: a leftover file must never outlive its 24 h.
import { log } from '../log';
import { singleton } from '../state';
import { errMsg } from '../util';
import { sweepDumps } from './dumps';
import { sandboxEnabled } from './env';
import { pauseIdle } from './jobs';
import { TASK_LABEL } from './labels';
import { getRunner } from './runner';
import { getTask, hasListeners, listTasks, saveTask, turnRunning, type CodeTask } from './tasks';

const SWEEP_MS = 60_000, DUMP_SWEEP_MS = 10 * 60_000;
const state = () => singleton<{ done: Promise<void> | null; sweeper: NodeJS.Timeout | null }>('sandboxReconcile', () => ({ done: null, sweeper: null }));

/** Database part: no job survives a restart. */
export function interruptStale(tasks: CodeTask[] = listTasks()): string[] {
  const changed: string[] = [];
  for (const t of tasks) {
    if (t.status !== 'setting_up' && t.status !== 'waking') continue;
    for (const s of t.steps) if (s.state === 'running') { s.state = 'interrupted'; s.error = 'Lotse wurde neu gestartet.'; }
    t.status = t.status === 'waking' ? 'paused' : 'interrupted';
    saveTask(t, false); changed.push(t.id);
  }
  return changed;
}

/** Docker part: orphans removed, container state taken over. */
export async function reconcileContainers(): Promise<{ removed: string[] }> {
  const r = getRunner(), tasks = new Map(listTasks().map(t => [t.id, t])), removed: string[] = [];
  for (const c of await r.list()) {
    const t = tasks.get(c.labels[TASK_LABEL] ?? '');
    if (t && t.status !== 'done' && t.containerId === c.id) continue;
    await r.remove(c.id).then(() => removed.push(c.name), e => log.warn('Verwaisten Sandbox-Container nicht entfernt', { container: c.name, error: e }));
  }
  for (const t of tasks.values()) {
    if (!t.containerId || t.status === 'done') continue;
    const info = await r.inspect(t.containerId);
    if (!info) {
      t.containerId = null; t.containerRunning = false;
      if (t.status === 'ready' || t.status === 'paused') { t.status = 'failed'; t.error = 'Der Container fehlt – ab „Container starten“ erneut versuchen.'; }
    } else {
      t.containerRunning = info.running;
      if (t.status === 'ready' && !info.running) t.status = 'paused';
      else if (t.status === 'paused' && info.running) t.status = 'ready';
    }
    saveTask(t, false);
  }
  return { removed };
}

/** Expired dumps, dumps of finished or deleted tasks and leftover files (never throws). */
export function sweepDumpsNow(now = Date.now()): string[] {
  try {
    const removed = sweepDumps(id => getTask(id)?.status ?? null, now);
    if (removed.length) log.info('Datenbank-Dumps gelöscht', { dumps: removed.join(', ') });
    return removed;
  } catch (e) { log.warn('Dump-Aufräumen fehlgeschlagen', { error: errMsg(e) }); return []; }
}

/** Once per process (first sandbox request or startup). Docker unreachable: only the database part, retried on the next start. */
export function ensureReconciled(): Promise<void> {
  const s = state();
  if (!s.sweeper) sweepDumpsNow();
  startSweeper();
  if (!sandboxEnabled()) { if (!s.done) interruptStale(); return Promise.resolve(); } // Docker part once it is switched on
  s.done ??= (async () => {
    interruptStale();
    try {
      const { removed } = await reconcileContainers();
      if (removed.length) log.info('Verwaiste Sandbox-Container entfernt', { containers: removed.join(', ') });
    } catch (e) { log.warn('Sandbox-Abgleich mit Docker nicht möglich', { error: errMsg(e) }); }
  })();
  return s.done;
}

export function startSweeper() {
  const s = state();
  if (s.sweeper) return;
  let lastDumps = Date.now();
  s.sweeper = setInterval(() => {
    void pauseIdle(Date.now(), id => hasListeners(id) || turnRunning(id)).catch(e => log.warn('Sandbox-Leerlauf-Prüfung fehlgeschlagen', { error: e }));
    if (Date.now() - lastDumps >= DUMP_SWEEP_MS) { lastDumps = Date.now(); sweepDumpsNow(); }
  }, SWEEP_MS);
  s.sweeper.unref?.();
}
/** Tests: forget the per-process state. */
export const resetReconcile = () => { const s = state(); if (s.sweeper) clearInterval(s.sweeper); s.sweeper = null; s.done = null; };
