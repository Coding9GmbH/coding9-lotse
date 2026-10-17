import 'server-only';
// Code tasks: one row per task (code_tasks), one container per task, a workspace with the clone and a separate git dir.
// This module holds the model, persistence, live listeners and creation. Running the setup and the container
// lifecycle (pause, wake, finish) live in jobs.ts, startup cleanup and the idle sweeper in reconcile.ts.
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import type { CodeTaskPublic, CodeTaskStatus, TaskDumpPublic, CommandPhase, TaskEvent, TaskLayout, TaskPublish, TaskStep } from '@/lib/protocol';
import { codeTaskByChat, codeTaskGet, codeTaskList, codeTaskPut, dataDir, macOf, type CodeTaskRow } from '../db';
import { assertLotseBranch } from '../git';
import { singleton } from '../state';
import { attachDump, deleteDump } from './dumps';
import { getSandboxConfig } from './env';
import type { NetworkMode } from './network';
import { getRunner } from './runner';
import { canonicalTemplateId, getTemplate } from './templates';

export const TASK_ID = /^t_[a-z0-9]{12}$/;
export const LOG_LINES = 200;
const LINE_MAX = 2000;

/** A step as stored: own setup commands carry their command (user-authored environment, never AI input) and time limit. */
export interface StoredStep extends TaskStep { phase?: CommandPhase; command?: string; timeoutSec?: number }
/** The task's dump: id of the file in code_dumps while it waits for the import; afterwards only the facts remain. */
export interface StoredDump { id: string; name: string; size: number; sha256: string | null; imported: boolean; deletedAt: string | null; ignoreVersion: boolean; versionMismatch?: { dump: string; image: string } }
export interface CodeTask extends CodeTaskRow {
  title: string; goal: string; status: CodeTaskStatus; steps: StoredStep[]; layout: TaskLayout | null; error: string | null;
  /** container state as Lotse last set or saw it */ containerRunning: boolean;
  /** where Lotse ran when the container was created; port: only containers from before the internal network (refused) */ mode: NetworkMode | null; port: number | null;
  lastActiveAt: string; finishedAt: string | null;
  /** missing in rows from before dumps existed */ dump?: StoredDump | null;
  /** title of the pull request (number, URL and pushed SHA are columns) */ prTitle?: string | null;
  /** publishing (running, failed or interrupted by a restart); null after success */ publish?: TaskPublish | null;
  /** internet a human allowed (container attached to lotse-sandbox-egress, internet.ts); null/missing = offline */ internet?: { since: string; via: 'chat' | 'panel' } | null;
}

export const now = () => new Date().toISOString();
export const newTaskId = () => `t_${Array.from(crypto.randomBytes(12), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;

/** Branch name lotse/<slug>-<6 chars of the id>: lower case, umlauts transliterated, at most 40 characters of title. */
export function branchFor(title: string, id: string): string {
  const slug = title.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'aufgabe';
  return assertLotseBranch(`lotse/${slug}-${id.slice(2, 8)}`);
}

// ---- Paths: <data>/workspaces/<id>/repo (worktree), <data>/git/<id> (git dir, never synced) ----
const assertTaskId = (id: string) => { if (!TASK_ID.test(id)) throw new Error('Ungültige Aufgaben-ID.'); return id; };
export const taskPaths = (id: string) => {
  const d = dataDir(); assertTaskId(id);
  return { workspace: path.join(d, 'workspaces', id), worktree: path.join(d, 'workspaces', id, 'repo'), gitDir: path.join(d, 'git', id),
    /** later: screenshots; removed with the task (dumps: dumps.ts) */ screenshots: path.join(d, 'screenshots', id) };
};

// ---- Store + live listeners ----
interface Live { listeners: Map<string, Set<(ev: TaskEvent) => void>>; saveTimers: Map<string, NodeJS.Timeout> }
const live = () => singleton<Live>('sandboxTasksLive', () => ({ listeners: new Map(), saveTimers: new Map() }));

/** Rows of tasks created before a template rename carry the old id. */
const loaded = (t: CodeTask) => { t.template = canonicalTemplateId(t.template); return t; };
export const getTask = (id: string): CodeTask | null => { const t = TASK_ID.test(id) ? codeTaskGet<CodeTask>(id) : null; return t && loaded(t); };
export const listTasks = (): CodeTask[] => codeTaskList<CodeTask>().map(loaded);
export function mustTask(id: string): CodeTask {
  const t = getTask(id);
  if (!t) throw Object.assign(new Error('Aufgabe nicht gefunden.'), { status: 404 });
  return t;
}

/** Persist now (every status and step transition) and tell the listeners. */
export function saveTask(t: CodeTask, emit = true) {
  const timer = live().saveTimers.get(t.id);
  if (timer) { clearTimeout(timer); live().saveTimers.delete(t.id); }
  t.updatedAt = now();
  codeTaskPut(t);
  if (emit) emitTask(t.id, { t: 'task', task: publicTask(t) });
}
/** Log lines: persisted batched (1 s), streamed at once. */
function saveSoon(t: CodeTask) {
  const L = live();
  if (L.saveTimers.has(t.id)) return;
  const timer = setTimeout(() => { L.saveTimers.delete(t.id); codeTaskPut(t); }, 1000);
  timer.unref?.();
  L.saveTimers.set(t.id, timer);
}
export function appendLog(t: CodeTask, step: StoredStep, text: string, redact: (s: string) => string) {
  const lines = redact(text).replace(/\r\n?/g, '\n').split('\n').map(l => l.trimEnd()).filter(Boolean).map(l => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)} …` : l));
  if (!lines.length) return;
  step.log.push(...lines);
  if (step.log.length > LOG_LINES) step.log.splice(0, step.log.length - LOG_LINES);
  for (const line of lines.slice(-LOG_LINES)) emitTask(t.id, { t: 'log', step: step.id, line });
  saveSoon(t);
}

/** The sandbox attached to a chat: its task that is not finished yet (one per chat), or null. Finishing detaches it. */
export function attachedTask(chatId: string): CodeTask | null {
  if (!chatId) return null;
  for (const id of codeTaskByChat(chatId)) { const t = getTask(id); if (t && t.status !== 'done') return t; }
  return null;
}

// ---- Chat turns running for a task (count as activity: the idle sweeper does not pause the container meanwhile) ----
const turns = () => singleton<Set<string>>('sandboxTaskTurns', () => new Set());
export const markTurn = (id: string, on: boolean) => { if (on) turns().add(id); else turns().delete(id); };
export const turnRunning = (id: string) => turns().has(id);

// ---- Publishing running for a task (publish.ts): no agent turn, finish or second publish meanwhile ----
const publishing = () => singleton<Map<string, Promise<unknown>>>('sandboxTaskPublishing', () => new Map());
export const publishRunning = (id: string) => publishing().has(id);
/** Resolves when the task's running publish (if any) has ended. */
export const publishSettled = (id: string): Promise<void> => (publishing().get(id) ?? Promise.resolve()).then(() => {}, () => {});
export function markPublishing<T>(id: string, p: Promise<T>): Promise<T> {
  publishing().set(id, p);
  void p.finally(() => { if (publishing().get(id) === p) publishing().delete(id); }).catch(() => {});
  return p;
}

export function listen(id: string, fn: (ev: TaskEvent) => void): () => void {
  const L = live().listeners;
  let set = L.get(id);
  if (!set) L.set(id, (set = new Set()));
  set.add(fn);
  return () => { set.delete(fn); if (!set.size) L.delete(id); };
}
export const hasListeners = (id: string) => (live().listeners.get(id)?.size ?? 0) > 0;
export function emitTask(id: string, ev: TaskEvent) { for (const fn of live().listeners.get(id) ?? []) { try { fn(ev); } catch { /* listener gone */ } } }

/** Preview path /sbx/<id>.<key>: the key (keyed hash of the id) makes the URL unguessable. The preview runs in an opaque origin
 *  whose requests carry neither cookies nor a Referer, so the key is what ties a request (form post, ajax) to this task. */
export const previewKey = (id: string) => macOf('sandbox-preview', assertTaskId(id)).slice(0, 20);
export const previewPath = (id: string) => `/sbx/${id}.${previewKey(id)}`;

/** What the browser sees: no stored commands; without logs for the list. */
export function publicTask(t: CodeTask, o: { logs?: boolean } = {}): CodeTaskPublic {
  return {
    id: t.id, title: t.title, goal: t.goal, repo: t.repo, baseBranch: t.baseBranch, branch: t.branch, template: t.template,
    status: t.status, layout: t.layout, error: t.error,
    steps: t.steps.map(({ id, key, label, state, startedAt, endedAt, log, error }) => ({ id, key, ...(label ? { label } : {}), state, ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}), log: o.logs === false ? [] : log, ...(error ? { error } : {}) })),
    container: t.containerId ? { running: t.containerRunning } : null,
    preview: previewPath(t.id), dump: t.dump ? publicTaskDump(t.dump) : null, prUrl: t.prUrl, createdAt: t.createdAt, updatedAt: t.updatedAt, lastActiveAt: t.lastActiveAt, finishedAt: t.finishedAt,
    chatId: t.chatId, pr: t.prNumber && t.prUrl ? { number: t.prNumber, url: t.prUrl, title: t.prTitle ?? t.title } : null, publish: t.publish ?? null,
    internet: t.internet ? { since: t.internet.since } : null,
  };
}

const publicTaskDump = (d: StoredDump): TaskDumpPublic => ({
  name: d.name, size: d.size, sha256: d.sha256, imported: d.imported, deleted: !!d.deletedAt, ignoreVersion: d.ignoreVersion, ...(d.versionMismatch ? { versionMismatch: d.versionMismatch } : {}),
});
/** A complete uploaded dump becomes the task's dump (an older one that was not imported yet is deleted). */
export function setTaskDump(t: CodeTask, dumpId: string): void {
  const d = attachDump(dumpId, t.id);
  if (t.dump && t.dump.id !== d.id && !t.dump.deletedAt) deleteDump(t.dump.id);
  t.dump = { id: d.id, name: d.name, size: d.size, sha256: d.sha256, imported: false, deletedAt: null, ignoreVersion: false };
}

/** Steps of a new task: the template's steps; each slot for own commands becomes one step per configured command of that phase. */
export function planSteps(templateId: string, commands: { id: string; label: string; command: string; phase: CommandPhase; timeoutSec: number }[]): StoredStep[] {
  const out: StoredStep[] = [];
  for (const s of getTemplate(templateId).steps) {
    if (!s.custom) { out.push({ id: s.id, key: s.id, state: 'pending', log: [] }); continue; }
    for (const c of commands.filter(x => x.phase === s.custom)) out.push({ id: `${s.id}:${c.id}`, key: 'custom', label: c.label, phase: c.phase, command: c.command, timeoutSec: c.timeoutSec, state: 'pending', log: [] });
  }
  return out;
}

export interface NewTask { chatId: string; title?: string; goal?: string; repo: string; baseBranch: string; dumpId?: string }
/** Creates the row only (not running yet: runSteps sets setting_up), bound to the chat it was started from.
 *  Title (branch name, list): given, otherwise the repository's name. Own commands are taken from the environment now. */
export const ATTACHED_MSG = 'An diesem Chat hängt schon eine Sandbox. Erst „Aufgabe abschließen“, dann eine neue starten.';
export function createTask(p: NewTask): CodeTask {
  const cfg = getSandboxConfig(), id = newTaskId(), ts = now();
  if (!p.chatId) throw new Error('Chat fehlt.');
  // checked again here, without an await before codeTaskPut: two overlapping requests never attach two sandboxes to one chat
  if (attachedTask(p.chatId)) throw Object.assign(new Error(ATTACHED_MSG), { status: 409 });
  const title = (p.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || `Sandbox ${p.repo.split('/').pop() ?? p.repo}`;
  const t: CodeTask = {
    id, chatId: p.chatId, template: cfg.templateId, repo: p.repo, baseBranch: p.baseBranch, branch: branchFor(title, id),
    status: 'interrupted', containerId: null, prNumber: null, prUrl: null, pushedSha: null, createdAt: ts, updatedAt: ts,
    title, goal: (p.goal ?? '').trim().slice(0, 4000), steps: planSteps(cfg.templateId, cfg.commands), layout: null, error: null,
    containerRunning: false, mode: null, port: null, lastActiveAt: ts, finishedAt: null, dump: null,
  };
  if (p.dumpId) setTaskDump(t, p.dumpId);
  codeTaskPut(t);
  return t;
}

/** Where Lotse reaches the task's storefront: the container's address on the internal network lotse-sandbox, as Docker reports it
 *  (never from a request). Containers from before the internal network (published port on the default bridge) are refused. */
export async function sandboxOrigin(t: CodeTask): Promise<string> {
  if (!t.containerId) throw new Error('Kein Container für diese Aufgabe.');
  if (t.port) throw Object.assign(new Error('Dieser Container wurde noch mit Internetzugang angelegt. Einrichtung ab „Container starten“ erneut versuchen.'), { code: 'ELEGACY' });
  const info = await getRunner().inspect(t.containerId);
  if (!info?.running || !info.address) throw Object.assign(new Error('Der Container läuft nicht.'), { code: 'ENOTRUNNING' });
  return `http://${info.address.host}:${info.address.port}`;
}

/** Status of a storefront path, with Host: localhost (Dockware answers other hosts with 400). No redirects followed. */
export function httpStatusOf(origin: string, p: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(p, origin), { method: 'GET', headers: { host: 'localhost' }, timeout: 15_000, signal }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
    req.end();
  });
}
