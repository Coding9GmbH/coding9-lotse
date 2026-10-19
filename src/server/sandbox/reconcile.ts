import 'server-only';
// After a Lotse restart: steps (and a publish) that were running become "interrupted"; labelled containers without a task (or of a finished task)
// are removed; the containers of the other tasks keep their state (a running one stays ready, a stopped one is paused) and their
// internet access only if it was allowed and the container still runs.
// Also starts the idle sweeper (one interval per process, unref: never keeps the process alive), which also deletes stale dumps
// and closes idle consoles,
// and the watcher of open pull requests (pr-watch.ts).
// Dumps are swept at startup whether Sandbox Coding is on or not: a leftover file must never outlive its 24 h.
// While it is on, the same sweep removes database volumes nobody needs any more (db-snapshots.ts: snapshots of deleted stored databases
// or of another image, data volumes of finished tasks).
import { codeDumpsLibraryEver } from '../db';
import { log } from '../log';
import { singleton } from '../state';
import { errMsg } from '../util';
import { killOrphanConsoles, sweepConsoles } from './console';
import { sweepDbVolumes } from './db-snapshots';
import { sweepDumps } from './dumps';
import { environmentImage, sandboxEnabled } from './env';
import { reconcileInternet } from './internet';
import { pauseIdle } from './jobs';
import { resetPrWatch, startPrWatch } from './pr-watch';
import { TASK_LABEL } from './labels';
import { getRunner } from './runner';
import { getTask, hasListeners, listTasks, publishRunning, saveTask, turnRunning, type CodeTask } from './tasks';

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
  for (const t of tasks) { // a publish cut off by the restart: the retry continues idempotently (publish.ts)
    if (t.publish?.state !== 'running' || publishRunning(t.id)) continue;
    t.publish = { ...t.publish, state: 'interrupted', error: 'Lotse wurde beim Veröffentlichen neu gestartet – bitte erneut veröffentlichen.' };
    saveTask(t, false); if (!changed.includes(t.id)) changed.push(t.id);
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
      t.containerId = null; t.containerRunning = false; t.internet = null;
      if (t.status === 'ready' || t.status === 'paused') { t.status = 'failed'; t.error = 'Der Container fehlt – ab „Container starten“ erneut versuchen.'; }
    } else {
      t.containerRunning = info.running;
      if (t.status === 'ready' && !info.running) t.status = 'paused';
      else if (t.status === 'paused' && info.running) t.status = 'ready';
    }
    saveTask(t, false);
    // internet only while the stored approval and Docker agree (and the container runs)
    if (info) await reconcileInternet(t, info).catch(e => log.warn('Internetzugang nicht abgeglichen', { task: t.id, error: e }));
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

/** Database volumes of stored databases nobody needs any more (never throws; only while Sandbox Coding is on). */
export async function sweepDbVolumesNow(): Promise<string[]> {
  // without any stored database there are no such volumes (and a socket proxy of an older setup may not pass volume calls)
  if (!sandboxEnabled() || !codeDumpsLibraryEver()) return [];
  try {
    const removed = await sweepDbVolumes(environmentImage(), id => getTask(id)?.status ?? null);
    if (removed.length) log.info('Datenbank-Volumes gelöscht', { volumes: removed.join(', ') });
    return removed;
  } catch (e) { log.warn('Datenbank-Volumes nicht aufgeräumt', { error: errMsg(e) }); return []; }
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
      await killOrphanConsoles(); // shells of consoles from before the restart (nobody can reach them any more)
      await sweepDbVolumesNow(); // after the containers: a removed container no longer holds its volume
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
    void sweepConsoles().catch(e => log.warn('Konsolen-Leerlauf-Prüfung fehlgeschlagen', { error: e }));
    if (Date.now() - lastDumps >= DUMP_SWEEP_MS) { lastDumps = Date.now(); sweepDumpsNow(); void sweepDbVolumesNow(); }
  }, SWEEP_MS);
  s.sweeper.unref?.();
  startPrWatch(); // feedback on open pull requests (pr-watch.ts); does nothing while switched off or without GitHub
}
/** Tests: forget the per-process state. */
export const resetReconcile = () => { const s = state(); if (s.sweeper) clearInterval(s.sweeper); s.sweeper = null; s.done = null; resetPrWatch(); };
