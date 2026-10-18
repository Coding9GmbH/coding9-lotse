import 'server-only';
// Setup job and container lifecycle of code tasks. Everything runs detached from the HTTP request (like a chat turn):
// - runSteps: the template's steps in order, each persisted at once, with a time limit and an AbortController per task
// - one lock per task: setup steps, wake-up and sandbox_bash never run in the same container at the same time
// - LOTSE_SANDBOX_MAX running containers: one more stops a failed task's container or pauses the least recently used ready task, otherwise 409
// - pause = docker stop (code, database and changes stay), wake = docker start + wait + full sync (no new setup)
// - finish = container, its database volume, workspace, git dir, dump and screenshots removed; the task stays as a record (done)
// - a stored database (db-snapshots.ts): the container keeps MySQL in a volume of the task, filled from a snapshot when one exists
// - internet (internet.ts) ends with every stop, a new setup and finish; a woken container starts offline
// - the user's consoles (console.ts) close with every stop, a new setup and finish
import fs from 'node:fs';
import path from 'node:path';
import { messages, type Locale } from '@/lib/i18n';
import type { ChatEvent, CodeTaskStatus } from '@/lib/protocol';
import { errorSummary } from '@/lib/sandbox-task';
import { codeTaskDelete } from '../db';
import { cloneRepo, initLocalRepo, localCommits, pendingChanges } from '../git';
import { log } from '../log';
import { chatExists, noteChatEvent } from '../sessions';
import { redact } from '../settings';
import { singleton } from '../state';
import { errMsg, pool } from '../util';
import { closeAllConsoles, closeTaskConsoles, endConsoleShells } from './console';
import { prepareTaskDb, saveSnapshot } from './db-snapshots';
import { taskDbVolume } from './db-snapshot-spec';
import { assertAttachable, deleteDump, deleteTaskDumps, dumpPathFor, dumpShopwareVersion } from './dumps';
import { STOP_CONCURRENCY, getSandboxConfig, maxRunning, sandboxEnabled, sandboxStatus } from './env';
import { revokeInternet, type RevokeReason } from './internet';
import { SANDBOX_NETWORK, ensureNetwork, networkMode, openHostPorts, probeRoute } from './network';
import { clearJar, forgetUpstream } from './preview';
import { getRunner } from './runner';
import { captureRunning, removeShotFiles } from './screenshots';
import { TASK_LABEL } from './labels';
import { syncTaskAll } from './task-sync';
import { streamFileTar, writeTar } from './tar';
import { getTemplate, resolveCommand } from './templates';
import { waitReady } from './templates/dockware';
import type { StepCtx } from './templates/types';
import { REPO_FILE, RepoFileError, readRepoFile, repoFileApproved, repoFileImage } from './repo-config';
import { appendLog, commandDir, effectiveMode, effectiveTarget, emitTask, getTask, httpStatusOf, listTasks, markStopping, mustTask, now, placeRepoSteps, publicTask, publishRunning, sandboxOrigin, saveTask, setTaskDump, taskImage, taskPaths, turnRunning, type CodeTask, type StoredStep } from './tasks';
/** Author of the empty start commit of a sandbox without a project (the same identity publishing commits with) */
const LOTSE_AUTHOR = { name: 'Lotse', email: 'lotse@users.noreply.github.com' };

export class TaskConflict extends Error { readonly status = 409; }
/** Statuses in which the task's container is about to run even if it is not started yet. */
const STARTING: CodeTaskStatus[] = ['setting_up', 'waking'];
/** Counts against LOTSE_SANDBOX_MAX: starting, or a running container (also failed/interrupted). A paused one is being stopped. */
const occupies = (t: CodeTask) => STARTING.includes(t.status) || (!!t.containerId && t.containerRunning && t.status !== 'paused' && t.status !== 'done');
const MAX_OUTPUT = 256 * 1024;

interface Job { ac: AbortController; done: Promise<void> }
interface Jobs { setup: Map<string, Job>; wakes: Map<string, Job>; locks: Map<string, Promise<unknown>>; finishing: Set<string> }
const jobs = () => singleton<Jobs>('sandboxJobs', () => ({ setup: new Map(), wakes: new Map(), locks: new Map(), finishing: new Set() }));
export const setupRunning = (id: string) => jobs().setup.has(id);
/** A setup or a finish is touching the workspace (publishing must wait). */
export const setupBusy = (id: string) => setupRunning(id) || jobs().finishing.has(id);
/** Resolves when the task's running setup (if any) has ended, successfully or not. */
export const setupSettled = (id: string): Promise<void> => jobs().setup.get(id)?.done ?? Promise.resolve();
const abortAndWait = async (j: Job | undefined) => { if (!j) return; j.ac.abort(); await j.done.catch(() => {}); };

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
/** Synchronously decides whose containers are stopped for `self`: first failed/interrupted tasks, then the least recently
 *  used ready ones (marked paused at once). The containers are stopped afterwards. */
function makeRoom(self: string): CodeTask[] {
  const max = maxRunning();
  const others = listTasks().filter(t => t.id !== self && occupies(t));
  const victims: CodeTask[] = [];
  const free = (t: CodeTask) => !setupRunning(t.id) && !jobs().wakes.has(t.id) && !turnRunning(t.id) && !publishRunning(t.id) && !captureRunning(t.id); // never under an agent turn, a publish or a screenshot
  const byAge = (a: CodeTask, b: CodeTask) => a.lastActiveAt.localeCompare(b.lastActiveAt);
  const candidates = [
    ...others.filter(t => (t.status === 'failed' || t.status === 'interrupted') && free(t)).sort(byAge),
    ...others.filter(t => t.status === 'ready' && free(t)).sort(byAge),
  ];
  while (others.length - victims.length >= max) {
    const v = candidates.shift();
    if (!v) throw new TaskConflict(`Es laufen bereits ${others.length} Sandboxes (höchstens ${max}, LOTSE_SANDBOX_MAX). Warte, bis eine Einrichtung fertig ist, oder pausiere eine Aufgabe.`);
    victims.push(v);
  }
  for (const v of victims) if (v.status === 'ready') { v.status = 'paused'; saveTask(v); }
  return victims;
}
const stopVictims = (victims: CodeTask[]) => Promise.all(victims.map(v => withTaskLock(v.id, () => stopContainer(v)).catch(e => log.warn('Sandbox pausieren fehlgeschlagen', { task: v.id, error: e }))));

/** The container is stopped (or stopping failed): the task is no longer "stopping", the views learn it. */
function stopped(id: string) {
  markStopping(id, false);
  const t = getTask(id);
  if (t) emitTask(id, { t: 'task', task: publicTask(t) });
}
async function stopContainer(t: CodeTask, why: RevokeReason = 'pause') {
  if (!t.containerId) return;
  markStopping(t.id, true); // a paused task whose container still runs: the views show "Pausiere …", no "Fortsetzen" yet
  try {
    await closeTaskConsoles(t.id, 'pause'); // the stop ends the shells anyway; the views learn why
    // internet ends with the stop; a failed detach does not keep the container running (waking detaches again before the start)
    await revokeInternet(t.id, why).catch(e => log.warn('Internetzugang nicht gesperrt', { task: t.id, error: e }));
    // services first (the template's clean shutdown, e.g. MySQL), then docker stop with the template's grace period; a failure only costs time
    const g = getTemplate(t.template).gracefulStop;
    if (g) await getRunner().exec(t.containerId, g.argv, { user: g.user, workdir: '/', timeoutMs: g.timeoutMs }).catch(e => log.warn('Dienste im Container nicht sauber beendet', { task: t.id, error: e }));
    // a failed stop leaves the container running: the console shells closed above (without ending them) must not run on unheld
    await getRunner().stop(t.containerId, g?.stopTimeoutSec).catch(async (e: unknown) => { await endConsoleShells(t.id); throw e; });
    forgetUpstream(t.containerId);
    const fresh = getTask(t.id);
    if (fresh) { fresh.containerRunning = false; saveTask(fresh, false); }
  } finally { stopped(t.id); }
}

// ---- Setup ----
/** Starts (or resumes) the setup from `fromStep` (default: the first step not done). Returns at once; the job runs detached. */
export function runSteps(id: string, fromStep?: string, o: { ignoreVersion?: boolean; dumpId?: string } = {}): CodeTask {
  assertOn();
  const t = mustTask(id);
  if (setupRunning(id) || jobs().wakes.has(id) || jobs().finishing.has(id)) throw new TaskConflict('Für diese Aufgabe läuft bereits ein Vorgang.');
  if (publishRunning(id)) throw new TaskConflict('Gerade wird veröffentlicht – bitte warten, bis der Pull Request angelegt ist.'); // the clone step wipes the worktree
  if (t.status === 'done') throw new TaskConflict('Die Aufgabe ist abgeschlossen.');
  if (o.dumpId) { assertAttachable(o.dumpId, id); fromStep ??= 'version-check'; } // "Datenbank ersetzen"
  const from = fromStep ? t.steps.findIndex(s => s.id === fromStep) : t.steps.findIndex(s => s.state !== 'done' && s.state !== 'skipped');
  if (fromStep && from < 0) throw Object.assign(new Error('Unbekannter Schritt.'), { status: 400 });
  if (from < 0) throw new TaskConflict('Die Einrichtung ist bereits fertig.');
  const victims = makeRoom(id);
  // Only now (nothing can throw any more): binding the new dump deletes the previous one
  if (o.dumpId) setTaskDump(t, o.dumpId);
  if (o.ignoreVersion && t.dump && !t.dump.deletedAt) t.dump.ignoreVersion = true;
  // "Trotzdem fortfahren" after the project's Shopware version did not match the image (step detect-layout)
  if (o.ignoreVersion && t.steps[from]?.key === 'detect-layout') t.ignoreProjectVersion = true;
  for (const s of t.steps.slice(from)) { s.state = 'pending'; s.log = []; delete s.startedAt; delete s.endedAt; delete s.error; }
  t.status = 'setting_up'; t.error = null; t.lastActiveAt = now();
  saveTask(t);
  void closeTaskConsoles(id, 'restart', true); // a new setup may recreate the container: consoles start again afterwards
  const ac = new AbortController();
  const done = stopVictims(victims).then(() => withTaskLock(id, () => execute(id, from, ac.signal)))
    .catch(e => log.error('Sandbox-Einrichtung abgebrochen', { task: id, error: e }))
    .finally(() => { jobs().setup.delete(id); });
  jobs().setup.set(id, { ac, done });
  return t;
}

/** A sandbox without a project and not yet bound to a GitHub project ("Als GitHub-Projekt anlegen") has its work only locally: a setup
 *  from "Repository klonen" (or before) would wipe it and start an empty repository again. Refused while there are commits or changes on top
 *  of the start commit; the start route asks before runSteps (git is async). */
export async function assertLocalWorkKept(id: string, fromStep: string | undefined, locale: Locale): Promise<void> {
  const t = mustTask(id);
  if (t.setup?.source !== 'none' || t.repo) return;
  const clone = t.steps.findIndex(s => s.key === 'clone');
  if (clone < 0 || t.steps[clone].state !== 'done') return;
  const from = fromStep ? t.steps.findIndex(s => s.id === fromStep) : t.steps.findIndex(s => s.state !== 'done' && s.state !== 'skipped');
  if (from < 0 || from > clone) return;
  const p = taskPaths(id);
  if (!fs.existsSync(p.gitDir)) return;
  const [commits, pending] = await Promise.all([localCommits(p.worktree, p.gitDir, t.baseBranch).catch(() => []), pendingChanges(p.worktree, p.gitDir).catch(() => [])]);
  if (commits.length || pending.length) throw new TaskConflict(messages(locale).server.localWorkOnly);
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
  await revokeInternet(id, 'setup').catch(e => log.warn('Internetzugang nicht gesperrt', { task: id, error: e })); // the setup runs offline
  const t = mustTask(id);
  if (t.status !== 'setting_up') return; // finished (or otherwise taken over) while queued on the lock
  const tpl = getTemplate(t.template);
  const startIdx = t.steps.findIndex(s => s.key === 'start-container');
  for (let i = from; i < t.steps.length; i++) {
    const step = t.steps[i];
    const def = step.key === 'custom' ? null : tpl.steps.find(s => s.id === step.key);
    const limit = step.key === 'custom' ? (step.timeoutSec ?? 600) * 1000 : def?.timeoutFor?.(t.layout) ?? def?.timeoutMs ?? 60_000;
    const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(limit)]);
    step.state = 'running'; step.startedAt = now(); step.log = []; delete step.endedAt; delete step.error;
    saveTask(t);
    try {
      if (signal.aborted) throw new Error('Abgebrochen.');
      const ctx = stepCtx(t, step, stepSignal, limit);
      if (startIdx >= 0 && i > startIdx) await ensureRunning(t, ctx);
      if (step.key === 'detect-layout') await applyRepoFile(t, ctx);
      const r = step.key === 'custom' ? await ctx.run(['bash', '-lc', step.command ?? 'false'], { timeoutMs: limit, workdir: commandDir(t, step, tpl.workdir) }) : await def?.run?.(ctx);
      step.state = r === 'skipped' ? 'skipped' : 'done';
    } catch (e) {
      const stopped = signal.aborted, timedOut = !stopped && stepSignal.aborted;
      const msg = stopped ? 'Abgebrochen.' : timedOut ? `Zeitüberschreitung nach ${Math.round(limit / 60_000) || 1} Min.` : redact(errMsg(e)).slice(0, 3000);
      step.state = stopped ? 'interrupted' : 'failed'; step.error = msg; step.endedAt = now();
      t.status = stopped ? 'interrupted' : 'failed';
      t.error = stopped ? null : msg;
      saveTask(t);
      // the chat says so too (a waiting agent turn reports it itself); the repository file's commands waiting for a decision are no error
      if (!stopped && t.chatId && !turnRunning(t.id) && chatExists(t.chatId)) {
        const ev: ChatEvent = t.repoFile?.state === 'pending' && step.key === 'detect-layout'
          ? { t: 'sandbox_status', state: 'approval' }
          : { t: 'sandbox_status', state: 'failed', message: errorSummary(msg).slice(0, 400) };
        noteChatEvent(t.chatId, ev); emitTask(t.id, { t: 'chat', event: ev });
      }
      return;
    }
    step.endedAt = now();
    saveTask(t);
  }
  t.status = 'ready'; t.lastActiveAt = now();
  saveTask(t);
}

/** The repository's .lotse/sandbox.json (repo-config.ts), read before the layout is detected: mode, target, image, preview path and notes
 *  apply at once; its commands become steps only when a human approved exactly this content – otherwise the step stops and the views
 *  show the commands with "Erlauben" / "Ohne diese Befehle" (POST …/repo-file). A sandbox without a project has no such file. */
async function applyRepoFile(t: CodeTask, ctx: StepCtx): Promise<void> {
  placeRepoSteps(t, t.template, []); // the file decides again (it may have changed or gone)
  if (t.setup?.source === 'none') { t.repoFile = null; return; }
  let f;
  try { f = readRepoFile(taskPaths(t.id).worktree); } catch (e) {
    if (e instanceof RepoFileError) throw new Error(`${e.message}\nDatei im Projekt korrigieren (oder entfernen) und die Einrichtung ab „Plugin erkennen“ wiederholen.`);
    throw e;
  }
  const cfg = getSandboxConfig(), tpl = getTemplate(t.template);
  if (!f) { t.repoFile = null; t.image = null; t.previewPath = null; saveTask(t, false); return; }
  ctx.log(`${REPO_FILE} gefunden${f.mode ? ` – Modus „${f.mode}“` : ''}${f.commands.length ? `, ${f.commands.length} Einrichtungsbefehl(e)` : ''}.`);
  if (f.ignored.length) ctx.log(`Hinweis: Unbekannte Angaben in ${REPO_FILE} werden ignoriert: ${f.ignored.join(', ')}`);
  const image = f.image ? repoFileImage(f.image, cfg.image, tpl) : null;
  t.image = image && image !== cfg.image ? image : null;
  t.previewPath = f.previewPath ?? null;
  const known = new Set([...cfg.envVars.map(v => v.key), ...(t.setup?.env ?? []).map(v => v.key)]);
  const missing = f.env.filter(n => !known.has(n));
  if (missing.length) ctx.log(`Warnung: Das Projekt erwartet diese Umgebungsvariablen, sie fehlen in der Umgebung: ${missing.join(', ')} (Sandbox Coding → Umgebung → Umgebungsvariablen).`);
  let state: NonNullable<CodeTask['repoFile']>['state'] = 'none';
  if (f.commands.length) {
    if (repoFileApproved(t.repo, f.hash)) state = 'approved';
    else if (t.setup?.skipRepoHash === f.hash) state = 'skipped';
    else state = 'pending';
  }
  t.repoFile = { ...f, state };
  saveTask(t);
  if (state === 'pending') throw new Error(`Das Projekt möchte beim Einrichten ${f.commands.length === 1 ? 'einen Befehl' : `${f.commands.length} Befehle`} ausführen (${REPO_FILE}). Befehle prüfen und erlauben – oder ohne sie fortfahren.`);
  if (state === 'skipped') ctx.log(`Die Befehle aus ${REPO_FILE} laufen nicht („Ohne diese Befehle“ gewählt).`);
  placeRepoSteps(t, t.template, state === 'approved' ? f.commands : []);
  if (state === 'approved') ctx.log(`Befehle aus ${REPO_FILE} erlaubt – sie laufen als eigene Schritte.`);
  if (t.image) { ctx.log(`Image laut ${REPO_FILE}: ${t.image}`); saveTask(t); await ctx.ensureImage(); }
  else saveTask(t);
}

/** docker start, with the template's boot file written first (also into containers created before it existed). */
async function startTaskContainer(t: CodeTask, id: string) {
  const runner = getRunner(), f = getTemplate(t.template).bootFile;
  if (f) await runner.putArchive(id, f.dir, writeTar([{ path: f.name, type: 'file', data: Buffer.from(f.content), mode: f.mode }], { uid: 33, gid: 33, uname: 'www-data', gname: 'www-data' }));
  await runner.start(id); forgetUpstream(id);
}

/** Why the container is not running any more (it exited while starting): exit code, memory limit, the line of its log that says why
 *  (in the first line: summaries and the chat show that one) and its last 20 lines (redacted). */
async function exitedError(id: string, info: { exitCode?: number; oomKilled?: boolean }): Promise<Error> {
  const lines = await getRunner().logs(id, { tail: 20 }).then(l => redact(l).split('\n').map(x => x.trimEnd()).filter(x => x.trim()).slice(-20), () => [] as string[]);
  const at = lines.findLastIndex(l => /error|fail|fatal|abort|denied|killed|cannot|can't|unable|no space/i.test(l));
  // "   ...fail!" alone says little: together with the line before it ("* Starting MySQL database server mysqld")
  const reason = at < 0 ? '' : (at > 0 && /^\s*\.{2,}/.test(lines[at]) ? `${lines[at - 1].trim()} ${lines[at].trim()}` : lines[at].trim()).slice(0, 200);
  const head = `Der Container hat sich beim Starten beendet (Exit-Code ${info.exitCode ?? '?'})${info.oomKilled ? ', das Arbeitsspeicher-Limit der Umgebung reichte nicht' : ''}${reason ? ` – „${reason}“` : ''}.`;
  return new Error(`${head}\n„Erneut versuchen“ bzw. „Fortsetzen“ startet ihn neu${info.oomKilled ? ' (vorher den Arbeitsspeicher in der Umgebung erhöhen)' : ''}.${lines.length ? `\nLetzte Zeilen aus dem Container-Log:\n${lines.join('\n')}` : ''}`);
}

/** Retry after a restart or a pause: a later step needs the container running and Shopware answering. */
async function ensureRunning(t: CodeTask, ctx: StepCtx) {
  if (!t.containerId) throw new Error('Kein Container – ab „Container starten“ erneut versuchen.');
  const info = await getRunner().inspect(t.containerId);
  if (!info) { t.containerId = null; t.containerRunning = false; saveTask(t); throw new Error('Der Container fehlt – ab „Container starten“ erneut versuchen.'); }
  if (info.running) return;
  ctx.log('Container ist gestoppt – starte ihn …');
  await startTaskContainer(t, t.containerId);
  t.containerRunning = true; saveTask(t);
  await waitReady(ctx);
}

/** The restricted context a template step runs in. `signal` ends the step (setup abort or step time limit). */
function stepCtx(t: CodeTask, step: StoredStep, signal: AbortSignal, limit: number): StepCtx {
  const tpl = getTemplate(t.template), runner = getRunner(), p = taskPaths(t.id);
  const lg = (line: string) => appendLog(t, step, line, redact);
  const container = () => { if (!t.containerId) throw new Error('Kein Container für diese Aufgabe.'); return t.containerId; };
  return {
    taskId: t.id, repo: t.repo, baseBranch: t.baseBranch, get image() { return taskImage(t); }, worktree: p.worktree, signal, log: lg,
    layout: () => t.layout,
    mode: () => effectiveMode(t),
    targetPath: () => effectiveTarget(t),
    setLayout: l => { t.layout = l; saveTask(t, false); },
    newPluginName: t.pluginName ?? null,
    ignoreProjectVersion: !!t.ignoreProjectVersion,
    run: async (cmd, o = {}) => {
      const r = Array.isArray(cmd) ? { argv: cmd as readonly string[], user: tpl.execUser, workdir: o.workdir ?? tpl.workdir, timeoutMs: o.timeoutMs ?? limit, maxOutput: MAX_OUTPUT }
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
      const { pulled } = await runner.ensureImage(taskImage(t), pr => { if (Date.now() - last > 2000 || pr.pct === 100) { last = Date.now(); lg(`${pr.text}${pr.pct !== undefined ? ` (${pr.pct} %)` : ''}`); } }, signal);
      lg(pulled ? 'Image geladen.' : 'Image ist vorhanden.');
    },
    clone: async () => {
      removeShotFiles(t.id); t.shots = []; // a fresh base: earlier screenshots no longer show it
      fs.rmSync(p.workspace, { recursive: true, force: true });
      fs.rmSync(p.gitDir, { recursive: true, force: true });
      // without a project an empty local repository – until "Als GitHub-Projekt anlegen" bound the task: from then on GitHub has its base
      if (t.setup?.source === 'none' && !t.repo) return initLocalRepo(t.baseBranch, p.worktree, p.gitDir, LOTSE_AUTHOR);
      return cloneRepo(t.repo, t.baseBranch, p.worktree, p.gitDir, { signal });
    },
    createContainer: async () => {
      const cfg = getSandboxConfig(), mode = networkMode();
      for (const c of await runner.list({ [TASK_LABEL]: t.id })) { lg(`Alten Container ${c.name} entfernen …`); await runner.remove(c.id); }
      t.containerId = null; t.containerRunning = false; t.port = null; clearJar(t.id); // a new shop: the old storefront session is meaningless
      await ensureNetwork(runner); // both modes: the internal network only, no internet, no live shop
      // a stored database: MySQL's data in a fresh volume of the task, filled from the snapshot for this image if there is one
      let dbVolume: string | undefined;
      if (tpl.database && t.dbVolume && !t.dump?.library) await runner.removeVolume(taskDbVolume(t.id)); // its stored database was replaced
      if (tpl.database && t.dump?.library && !t.dump.deletedAt) {
        Object.assign(t.dump, { imported: false, restored: null }); // a new container: its database is the image's until imported or restored
        const r = await prepareTaskDb({ taskId: t.id, dumpId: t.dump.id, image: taskImage(t), log: lg, signal });
        dbVolume = r.volume;
        if (r.restored) t.dump.restored = { image: taskImage(t), at: now() };
      }
      t.dbVolume = !!dbVolume; saveTask(t, false);
      // the sandbox's own variables (start dialog) win over the environment's of the same name
      const own = t.setup?.env ?? [], env = [...cfg.env.filter(e => !own.some(v => e.startsWith(`${v.key}=`))), ...own.map(v => `${v.key}=${v.value}`)];
      const spec = tpl.buildSpec({ taskId: t.id, image: taskImage(t), memoryMb: cfg.memoryMb, cpus: cfg.cpus, env, ...(dbVolume ? { dbVolume } : {}) });
      t.containerId = await runner.create(spec);
      t.mode = mode;
      saveTask(t, false);
      await startTaskContainer(t, t.containerId);
      t.containerRunning = true; saveTask(t);
      const addr = (await runner.inspect(t.containerId))?.address;
      if (!addr) throw new Error('Der Container hat keine Adresse im Netzwerk lotse-sandbox.');
      if (mode === 'local') {
        await probeRoute(addr.host, addr.port, { signal });
        const gw = (await runner.inspectNetwork(SANDBOX_NETWORK))?.gateway;
        const open = gw ? await openHostPorts(runner, container(), gw, tpl.execUser).catch(() => []) : [];
        if (open.length) lg(`Warnung: Aus dem Container sind auf dem Host (${gw}) die Ports ${open.join(', ')} erreichbar. Dienste auf diesem Rechner, die nicht nur auf 127.0.0.1 lauschen (z. B. ein Live-Shop oder seine Datenbank), kann Code in der Sandbox ansprechen – Firewall-Regel aus der Anleitung „Sandbox Coding“ einrichten oder Lotse in Docker betreiben.`);
      }
      lg(`Container ${spec.name} gestartet (internes Netzwerk lotse-sandbox, ${addr.host}, ohne Internetzugang).`);
    },
    httpStatus: async path => httpStatusOf(await sandboxOrigin(t), path, signal),
    checkAlive: async () => {
      const id = container();
      const info = await runner.inspect(id).catch(() => undefined); // Docker briefly unreachable: keep waiting (the time limit still applies)
      if (info === undefined || info?.running) return;
      if (!info) { t.containerId = null; t.containerRunning = false; saveTask(t); throw new Error('Der Container fehlt – Einrichtung ab „Container starten“ erneut versuchen.'); }
      t.containerRunning = false; saveTask(t, false); // no longer counts against LOTSE_SANDBOX_MAX
      throw await exitedError(id, info);
    },
    dump: () => {
      const d = t.dump;
      if (!d || d.imported) return null;
      if (d.deletedAt) throw new Error('Der Dump wurde nach dem fehlgeschlagenen Import gelöscht – bitte erneut hochladen („Datenbank ersetzen“).');
      return { name: d.name, size: d.size, ignoreVersion: d.ignoreVersion, library: !!d.library, restored: !!d.restored };
    },
    hasDump: () => !!t.dump,
    dumpVersion: async () => (t.dump ? dumpShopwareVersion(dumpPathFor(t.dump.id, t.id)) : null),
    setVersionMismatch: v => { if (!t.dump) return; if (v) t.dump.versionMismatch = v; else delete t.dump.versionMismatch; saveTask(t); },
    copyDump: async dir => {
      if (!t.dump) throw new Error('Kein Dump.');
      const file = dumpPathFor(t.dump.id, t.id), size = fs.statSync(file).size;
      const archive = streamFileTar(path.posix.basename(dir), 'dump', size, fs.createReadStream(file), { uid: 33, gid: 33, uname: 'www-data', gname: 'www-data' });
      await runner.putArchive(container(), path.posix.dirname(dir), archive, { timeoutMs: limit, signal });
    },
    discardDump: async (imported, dir) => {
      // a stored database stays for further sandboxes; a one-off dump is gone after its import (also a failed one)
      if (t.dump?.library) { t.dump.imported = imported; saveTask(t); }
      else if (t.dump) { deleteDump(t.dump.id); Object.assign(t.dump, { imported, deletedAt: now() }); saveTask(t); }
      // the import command removes it itself; this also covers a failed or aborted transfer (own time limit: the step's signal may be aborted)
      if (dir) await runner.exec(container(), ['rm', '-rf', '--', dir], { user: tpl.execUser, workdir: '/', timeoutMs: 30_000 }).catch(e => lg(`Aufräumen im Container fehlgeschlagen: ${errMsg(e)}`));
    },
    saveDbSnapshot: async () => {
      const d = t.dump;
      if (!tpl.database || !d?.library || d.deletedAt) { lg('Keine gespeicherte Datenbank – kein Snapshot nötig.'); return 'skipped'; }
      if (d.restored) { lg('Die Datenbank kam schon aus dem Snapshot.'); return 'skipped'; }
      if (!d.imported) { lg('Die Datenbank wurde nicht importiert – kein Snapshot.'); return 'skipped'; }
      if (!t.dbVolume) { lg('Diese Sandbox hält ihre Datenbank nicht in einem eigenen Volume – der Snapshot entsteht bei der nächsten neuen Sandbox mit dieser Datenbank.'); return 'skipped'; }
      // the image the container was created with (the environment may name another one by now)
      const image = (await runner.inspect(container()))?.image || getSandboxConfig().image;
      return saveSnapshot({ taskId: t.id, dumpId: d.id, image, db: tpl.database, containerId: container(), log: lg, signal });
    },
    syncAll: async () => {
      if (!t.layout) throw new Error('Plugin noch nicht erkannt.');
      container();
      const r = await syncTaskAll(t, signal);
      lg(`${r.files} Dateien nach ${tpl.syncTarget(t.layout)} übertragen.`);
      return r.config;
    },
  };
}

// ---- Lifecycle: pause, wake, finish ----
export async function pauseTask(id: string): Promise<CodeTask> {
  const t = mustTask(id);
  if (setupRunning(id)) throw new TaskConflict('Die Einrichtung läuft noch – erst „Stoppen“.');
  if (t.status !== 'ready') throw new TaskConflict('Nur eine bereite Aufgabe kann pausiert werden.');
  t.status = 'paused';
  markStopping(id, true); saveTask(t); // "Pausiere …" from the first event on, until stopContainer is done (publicTask.stopping)
  try { await withTaskLock(id, () => stopContainer(t)); } finally { stopped(id); }
  return mustTask(id);
}

/** "Fortsetzen": starts waking a paused task (start, wait for Shopware, full sync) and returns at once. Throws on conflicts.
 *  Before that the container state is checked with Docker: one stopped outside Lotse (daemon restart, OOM, docker stop) is woken too. */
export async function startWake(id: string): Promise<CodeTask> {
  assertOn();
  const t = mustTask(id);
  if (t.status === 'ready' && !jobs().wakes.has(id)) await syncContainerState(t);
  return beginWake(id);
}
function beginWake(id: string): CodeTask {
  const t = mustTask(id);
  if ((t.status === 'ready' && t.containerRunning) || jobs().wakes.has(id)) { touchTask(id); return t; }
  if (jobs().finishing.has(id)) throw new TaskConflict('Die Aufgabe wird gerade abgeschlossen.');
  if (t.status !== 'paused' && !(t.status === 'ready' && !t.containerRunning)) throw new TaskConflict(t.status === 'setting_up' ? 'Die Umgebung wird noch eingerichtet.' : 'Die Umgebung ist nicht bereit – Einrichtung erneut versuchen.');
  const victims = makeRoom(id);
  t.status = 'waking'; t.error = null; t.lastActiveAt = now(); saveTask(t);
  const ac = new AbortController();
  const done = stopVictims(victims).then(() => withTaskLock(id, () => wake(id, ac.signal))).finally(() => { jobs().wakes.delete(id); });
  done.catch(() => {}); // the error is on the task
  jobs().wakes.set(id, { ac, done });
  return t;
}
/** Make sure the task's container runs; shared by concurrent callers. Later used by the chat (before the agent turn) and the preview. */
export async function ensureAwake(id: string): Promise<void> {
  await startWake(id);
  await jobs().wakes.get(id)?.done;
}
/** A ready task whose container is not running (any more) according to Docker becomes paused. Docker unreachable: unchanged. */
async function syncContainerState(t: CodeTask): Promise<void> {
  if (!t.containerId || !t.containerRunning) return;
  const info = await getRunner().inspect(t.containerId).catch(() => undefined);
  if (info === undefined || info?.running) return;
  const fresh = getTask(t.id);
  if (!fresh || fresh.containerId !== t.containerId || !fresh.containerRunning) return;
  fresh.containerRunning = false;
  if (!info) fresh.containerId = null;
  void closeTaskConsoles(t.id, 'stopped');
  if (fresh.status === 'ready') { fresh.status = info ? 'paused' : 'failed'; fresh.error = info ? null : 'Der Container fehlt – Einrichtung ab „Container starten“ erneut versuchen.'; }
  saveTask(fresh);
  // stopped outside Lotse (OOM, docker stop): internet ends like on a pause, flag and audit included
  if (fresh.internet) await revokeInternet(t.id, 'pause').catch(e => log.warn('Internetzugang nicht gesperrt', { task: t.id, error: e }));
}
async function wake(id: string, abort: AbortSignal) {
  const t = mustTask(id);
  const step: StoredStep = { id: 'wake', key: 'wait-ready', state: 'running', log: [] }; // log target only, not stored in the task
  const signal = AbortSignal.any([abort, AbortSignal.timeout(5 * 60_000)]);
  try {
    if (t.status !== 'waking') return; // finished while queued on the lock
    if (abort.aborted) throw new Error('Abgebrochen.');
    if (!t.containerId || !t.layout) throw new Error('Kein Container – Einrichtung erneut versuchen.');
    // a woken container starts offline (also one stopped outside Lotse while internet was allowed); not detachable = not started
    await revokeInternet(id, 'wake'); t.internet = null;
    const ctx = stepCtx(t, step, signal, 5 * 60_000);
    await startTaskContainer(t, t.containerId);
    t.containerRunning = true; saveTask(t);
    await waitReady(ctx);
    await ctx.syncAll();
    // The sync replaced the plugin's files, so Shopware recompiles its templates on the next storefront request (several seconds on a
    // just started container). That request is made here: "ready" means the preview loads at once – until then /sbx answers with
    // "Umgebung startet …", which reloads itself; otherwise the first real load kept that page on screen for those seconds.
    const warm = await ctx.httpStatus('/').catch(() => 0);
    if (warm !== 200) ctx.log(`Storefront nach dem Start: ${warm ? `HTTP ${warm}` : 'keine Antwort'}`);
    if (abort.aborted || getTask(id)?.status !== 'waking') throw new Error('Abgebrochen.');
    t.status = 'ready'; t.lastActiveAt = now(); saveTask(t);
  } catch (e) {
    const fresh = getTask(id);
    if (!fresh || fresh.status === 'done') throw e;
    // what Docker says, not what the wake assumed: a container that exited while starting (e.g. its database failed) is not running
    const info = t.containerId ? await getRunner().inspect(t.containerId).catch(() => undefined) : undefined;
    fresh.status = 'paused'; fresh.containerRunning = info === undefined ? t.containerRunning : !!info?.running;
    fresh.error = abort.aborted ? null : `Fortsetzen fehlgeschlagen: ${redact(errMsg(e)).slice(0, 2500)}`;
    saveTask(fresh);
    throw e;
  }
}

/** "Aufgabe abschließen": stops everything and removes container, volumes, workspace, git dir, dump and screenshots. The row stays. */
export async function finishTask(id: string): Promise<CodeTask> {
  mustTask(id);
  const J = jobs();
  if (J.finishing.has(id)) throw new TaskConflict('Die Aufgabe wird bereits abgeschlossen.');
  if (publishRunning(id)) throw new TaskConflict('Gerade wird veröffentlicht – bitte warten, bis der Pull Request angelegt ist.');
  J.finishing.add(id); // from here no new setup or wake-up can start
  try {
    await abortAndWait(J.setup.get(id));
    await abortAndWait(J.wakes.get(id));
    await closeTaskConsoles(id, 'finish');
    await withTaskLock(id, async () => {
      await revokeInternet(id, 'finish'); // Docker unreachable: nothing is removed (as below)
      const fresh = mustTask(id);
      if (fresh.containerId) await getRunner().remove(fresh.containerId);
      for (const c of await getRunner().list({ [TASK_LABEL]: id }).catch(() => [])) await getRunner().remove(c.id);
      if (fresh.dbVolume) await getRunner().removeVolume(taskDbVolume(id)); // its database (stored databases; the sweep catches the rest)
      const p = taskPaths(id);
      for (const d of [p.workspace, p.gitDir, p.screenshots]) fs.rmSync(d, { recursive: true, force: true });
      deleteTaskDumps(id);
      if (fresh.dump && !fresh.dump.deletedAt && !fresh.dump.library) fresh.dump.deletedAt = now(); // a stored database stays
      for (const s of fresh.steps) if (s.state === 'running') s.state = 'interrupted';
      clearJar(id);
      Object.assign(fresh, { status: 'done', containerId: null, containerRunning: false, finishedAt: now(), error: null, internet: null, shots: [] } satisfies Partial<CodeTask>);
      saveTask(fresh);
      if (fresh.chatId && chatExists(fresh.chatId)) noteChatEvent(fresh.chatId, { t: 'sandbox_status', state: 'finished' }); // the chat's record (the open view adds its own line)
    });
  } finally { J.finishing.delete(id); }
  return mustTask(id);
}

/** Remove the task completely (also its record, not the chat). Containers and files go first; Docker unreachable = error, nothing deleted. */
export async function deleteTask(id: string): Promise<void> {
  const t = mustTask(id);
  if (t.status !== 'done' || t.containerId) await finishTask(id);
  else { for (const d of Object.values(taskPaths(id))) fs.rmSync(d, { recursive: true, force: true }); deleteTaskDumps(id); }
  codeTaskDelete(id); // the chat stays: it is a normal chat of the workspace
  emitTask(id, { t: 'deleted' });
}

/** Sandbox Coding switched off: abort setups, stop (not remove) every running task container. Switching on again resumes on demand.
 *  The containers stop in parallel (at most STOP_CONCURRENCY at once): each one takes seconds (clean MySQL shutdown, docker stop). */
export async function suspendAll(): Promise<number> {
  await Promise.all([...jobs().setup.values(), ...jobs().wakes.values()].map(abortAndWait));
  await closeAllConsoles('disabled');
  const running: CodeTask[] = [];
  for (const t of listTasks()) {
    if (t.status === 'ready' || t.status === 'waking') { t.status = 'paused'; saveTask(t); }
    if (t.containerId && t.containerRunning) running.push(t);
  }
  const ok = await pool(running, STOP_CONCURRENCY, t => withTaskLock(t.id, () => stopContainer(t)).then(() => true, () => false));
  return ok.filter(Boolean).length;
}

/** Idle sweeper body: ready tasks without activity for idleMinutes (and nobody watching) are paused; containers of failed tasks stopped.
 *  Ready tasks whose container stopped outside Lotse are marked paused (so "Fortsetzen" is offered again). */
export async function pauseIdle(nowMs = Date.now(), watching: (id: string) => boolean = () => false): Promise<string[]> {
  if (!sandboxEnabled()) return [];
  const idleMs = getSandboxConfig().idleMinutes * 60_000, paused: string[] = [];
  for (const t of listTasks()) {
    if (!t.containerId || !t.containerRunning || setupRunning(t.id) || jobs().wakes.has(t.id) || publishRunning(t.id) || captureRunning(t.id)) continue; // never under a publish or a screenshot
    if (t.status === 'ready') { await syncContainerState(t); if (!getTask(t.id)?.containerRunning) continue; }
    if (watching(t.id)) continue;
    if (!['ready', 'failed', 'interrupted'].includes(t.status) || nowMs - Date.parse(t.lastActiveAt) < idleMs) continue;
    if (t.status === 'ready') { t.status = 'paused'; saveTask(t); }
    await withTaskLock(t.id, () => stopContainer(t)).then(() => paused.push(t.id), e => log.warn('Sandbox pausieren fehlgeschlagen', { task: t.id, error: e }));
  }
  return paused;
}
