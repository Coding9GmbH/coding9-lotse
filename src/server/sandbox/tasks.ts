import 'server-only';
// Code tasks: one row per task (code_tasks), one container per task, a workspace with the clone and a separate git dir.
// This module holds the model, persistence, live listeners and creation. Running the setup and the container
// lifecycle (pause, wake, finish) live in jobs.ts, startup cleanup and the idle sweeper in reconcile.ts.
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { DEFAULT_LOCALE, messages, type Locale } from '@/lib/i18n';
import type { ChatEvent, CodeTaskPublic, CodeTaskStatus, TaskDumpPublic, CommandPhase, SandboxMode, ShotDevice, TaskEvent, TaskLayout, TaskPublish, TaskRepoFile, TaskShotSet, TaskStep } from '@/lib/protocol';
import { PLUGIN_NAME, PREVIEW_PATH, pluginNameFromRepo, suggestTargetPath, targetPathProblem } from '@/lib/sandbox-task';
import { codeTaskByChat, codeTaskGet, codeTaskList, codeTaskPut, dataDir, macOf, type CodeTaskRow } from '../db';
import { assertLotseBranch } from '../git';
import { singleton } from '../state';
import { attachDump, deleteDump } from './dumps';
import { customImage } from './custom-image';
import { checkCommands, checkTaskEnv, cleanNotes, getSandboxConfig, imageTag } from './env';
import type { NetworkMode } from './network';
import { getRunner } from './runner';
import { canonicalTemplateId, getTemplate } from './templates';

export const TASK_ID = /^t_[a-z0-9]{12}$/;
export const LOG_LINES = 200;
const LINE_MAX = 2000;

/** A step as stored: own setup commands carry their command (user-authored environment, never AI input) and time limit. */
export interface StoredStep extends TaskStep { phase?: CommandPhase; command?: string; timeoutSec?: number }
/** What the user chose in "Sandbox starten" (A20). source 'none' = "Ohne Projekt starten": no repository, a local git only (a new plugin
 *  in the worktree), "Als GitHub-Projekt anlegen" later. commands/env: own commands and plain variables of this sandbox only (user input,
 *  never AI input). skipRepoHash: the repository file's commands the user declined ("Ohne diese Befehle"). */
export interface StoredSetup {
  source: 'repo' | 'none'; mode: SandboxMode; targetPath?: string;
  commands: { id: string; label: string; command: string; phase: CommandPhase; timeoutSec: number }[];
  env: { key: string; value: string }[]; skipRepoHash?: string;
  /** A22 (start dialog / quick start): another image tag, the preview's first page and notes for the AI of this sandbox; each wins over
   *  the repository file's */
  image?: string; previewPath?: string; notes?: string;
}
/** The task's dump: id of the file in code_dumps while it waits for the import; afterwards only the facts remain (a stored database,
 *  library, stays in code_dumps). restored: the task's data volume was filled from the snapshot of this database for that image. */
export interface StoredDump { id: string; name: string; size: number; sha256: string | null; imported: boolean; deletedAt: string | null; ignoreVersion: boolean; versionMismatch?: { dump: string; image: string };
  library?: boolean; restored?: { image: string; at: string } | null }
export interface CodeTask extends CodeTaskRow {
  title: string; goal: string; status: CodeTaskStatus; steps: StoredStep[]; layout: TaskLayout | null; error: string | null;
  /** container state as Lotse last set or saw it */ containerRunning: boolean;
  /** where Lotse ran when the container was created; port: only containers from before the internal network (refused) */ mode: NetworkMode | null; port: number | null;
  lastActiveAt: string; finishedAt: string | null;
  /** missing in rows from before dumps existed */ dump?: StoredDump | null;
  /** technical name for a new plugin, used when the cloned repository is empty (validated PLUGIN_NAME) */ pluginName?: string | null;
  /** a full project on another Shopware version than the image: the user chose "Trotzdem fortfahren" */ ignoreProjectVersion?: boolean;
  /** the container keeps MySQL's data in the task's own volume (stored databases, db-snapshots.ts) */ dbVolume?: boolean;
  /** title of the pull request (number, URL and pushed SHA are columns) */ prTitle?: string | null;
  /** publishing (running, failed or interrupted by a restart); null after success */ publish?: TaskPublish | null;
  /** internet a human allowed (container attached to lotse-sandbox-egress, internet.ts); null/missing = offline */ internet?: { since: string; via: 'chat' | 'panel' } | null;
  /** the running setup waits for a human to allow internet (installProjectFull); cleared when the step ends */ awaitingInternet?: boolean;
  /** what the PR watcher (pr-watch.ts) knows about the PR: state, head, feedback ids already reported */ prWatch?: PrWatch | null;
  /** screenshots the user took by hand (screenshots.ts), oldest first; files in taskPaths().screenshots. not an array = none (rows from before) */ shots?: StoredShotSet[];
  /** the start dialog's choices (A20); missing in rows from before = a repository, mode auto */ setup?: StoredSetup;
  /** the repository's .lotse/sandbox.json as the setup read it (repo-config.ts) */ repoFile?: TaskRepoFile | null;
  /** another image tag the repository file asked for (allowed by the template); null = the environment's */ image?: string | null;
  /** first page of the preview (repository file) */ previewPath?: string | null;
  /** "Als GitHub-Projekt anlegen": repository created but its base not pushed yet (the next try reuses it); null once bound to repo */ createdRepo?: string | null;
}
const setupOf = (t: Pick<CodeTask, 'setup'>): StoredSetup => t.setup ?? { source: 'repo', mode: 'auto', commands: [], env: [] };
/** The Dockware image of this task: the repository file's tag, else the environment's */
export const taskBaseImage = (t: Pick<CodeTask, 'image'>): string => t.image || getSandboxConfig().image;
/** The image this task runs: the base image, or the one built from the environment's Dockerfile on top of it */
export const taskImage = (t: Pick<CodeTask, 'image'>): string => { const base = taskBaseImage(t); return customImage(base, getSandboxConfig().dockerfile)?.name ?? base; };
/** How the code goes into the container: the dialog's choice, else the repository file's, else detected (auto) */
export const effectiveMode = (t: Pick<CodeTask, 'setup' | 'repoFile'>): SandboxMode => { const m = setupOf(t).mode; return m !== 'auto' ? m : t.repoFile?.mode ?? 'auto'; };
/** Target folder of an own setup: the dialog's, else the repository file's, else /opt/<repository name> */
export const effectiveTarget = (t: Pick<CodeTask, 'setup' | 'repoFile' | 'repo'>): string => setupOf(t).targetPath || t.repoFile?.targetPath || suggestTargetPath(t.repo);
/** Working directory of own commands: the target folder of an own setup (except the environment's commands), else the template's */
export const commandDir = (t: Pick<CodeTask, 'layout'>, step: Pick<StoredStep, 'source'>, workdir: string): string =>
  t.layout?.kind === 'custom' && t.layout.targetPath && step.source !== 'env' ? t.layout.targetPath : workdir;
export interface PrWatch { number: number; state: 'open' | 'merged' | 'closed'; headSha: string | null; seen: string[] }
export interface StoredShotSet { id: string; at: string; items: { path: string; device: ShotDevice; file: string }[]; error?: string }

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
    /** screenshots taken by hand (screenshots.ts); removed with the task (dumps: dumps.ts) */ screenshots: path.join(d, 'screenshots', id) };
};

// ---- Store + live listeners ----
interface Live { listeners: Map<string, Set<(ev: TaskEvent) => void>>; saveTimers: Map<string, NodeJS.Timeout> }
const live = () => singleton<Live>('sandboxTasksLive', () => ({ listeners: new Map(), saveTimers: new Map() }));
/** Tasks whose container is being stopped right now (pause, idle, room for another task): memory only, a restart reconciles with Docker. */
const stopping = () => singleton<Set<string>>('sandboxTasksStopping', () => new Set());
export const markStopping = (id: string, on: boolean) => { if (on) stopping().add(id); else stopping().delete(id); };

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
/** Chat events for a view that does not listen yet (a sandbox that starts pauses others before its start request answers, so the
 *  panel subscribes only after that): the task's next listener gets them right after its snapshot, once; kept a minute at most. */
const HELD_MS = 60_000;
const held = () => singleton<Map<string, { ev: ChatEvent; at: number }[]>>('sandboxHeldChat', () => new Map());
/** To the task's open views now, or held for the next one */
export function emitChatToViews(id: string, ev: ChatEvent) {
  if (hasListeners(id)) { emitTask(id, { t: 'chat', event: ev }); return; }
  const at = Date.now(), list = (held().get(id) ?? []).filter(x => at - x.at < HELD_MS);
  held().set(id, [...list, { ev, at }].slice(-10));
}
export function takeHeldChat(id: string): ChatEvent[] {
  const list = held().get(id) ?? [];
  held().delete(id);
  return list.filter(x => Date.now() - x.at < HELD_MS).map(x => x.ev);
}

/** Preview path /sbx/<id>.<key>: the key (keyed hash of the id) makes the URL unguessable. The preview runs in an opaque origin
 *  whose requests carry neither cookies nor a Referer, so the key is what ties a request (form post, ajax) to this task. */
export const previewKey = (id: string) => macOf('sandbox-preview', assertTaskId(id)).slice(0, 20);
export const previewPath = (id: string) => `/sbx/${id}.${previewKey(id)}`;

/** What the browser sees: no stored commands; without logs for the list. */
export function publicTask(t: CodeTask, o: { logs?: boolean } = {}): CodeTaskPublic {
  return {
    id: t.id, title: t.title, goal: t.goal, repo: t.repo, baseBranch: t.baseBranch, branch: t.branch, template: t.template,
    status: t.status, layout: t.layout, error: t.error,
    steps: t.steps.map(({ id, key, label, source, state, startedAt, endedAt, log, error }) => ({ id, key, ...(label ? { label } : {}), ...(source ? { source } : {}), state, ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}), log: o.logs === false ? [] : log, ...(error ? { error } : {}) })),
    container: t.containerId ? { running: t.containerRunning } : null, ...(stopping().has(t.id) ? { stopping: true } : {}),
    preview: previewPath(t.id), dump: t.dump ? publicTaskDump(t.dump) : null, prUrl: t.prUrl, createdAt: t.createdAt, updatedAt: t.updatedAt, lastActiveAt: t.lastActiveAt, finishedAt: t.finishedAt,
    chatId: t.chatId, pluginName: t.pluginName ?? null, pr: t.prNumber && t.prUrl ? { number: t.prNumber, url: t.prUrl, title: t.prTitle ?? t.title, ...(t.prWatch?.number === t.prNumber && t.prWatch.state !== 'open' ? { state: t.prWatch.state } : {}) } : null, publish: t.publish ?? null,
    internet: t.internet ? { since: t.internet.since } : null,
    ...(t.awaitingInternet && t.status === 'setting_up' ? { awaitingInternet: true as const } : {}),
    shots: (Array.isArray(t.shots) ? t.shots : []).map(s => publicShots(t.id, s)),
    ...(hasConsole(t.template) ? { console: true as const } : {}),
    ...(t.setup ? { setup: { source: t.setup.source, mode: t.setup.mode, ...(t.setup.targetPath ? { targetPath: t.setup.targetPath } : {}), commands: t.setup.commands.length, env: t.setup.env.map(v => v.key) } } : {}),
    repoFile: t.repoFile ?? null, image: t.image ?? null, ...(t.previewPath ? { startPath: t.previewPath } : {}),
  };
}
const hasConsole = (template: string) => { try { return !!getTemplate(template).console; } catch { return false; } };
const publicShots = (id: string, s: StoredShotSet): TaskShotSet => ({
  id: s.id, at: s.at, ...(s.error ? { error: s.error } : {}),
  shots: s.items.map(i => ({ path: i.path, device: i.device, url: `/api/sandbox/tasks/${id}/screenshots/${i.file}` })),
});

const publicTaskDump = (d: StoredDump): TaskDumpPublic => ({
  name: d.name, size: d.size, sha256: d.sha256, imported: d.imported, deleted: !!d.deletedAt, ignoreVersion: d.ignoreVersion, ...(d.versionMismatch ? { versionMismatch: d.versionMismatch } : {}),
  ...(d.library ? { library: true } : {}), ...(d.restored ? { restored: true } : {}),
});
/** A complete uploaded dump or a stored database becomes the task's dump (an older one-off dump that was not imported yet is deleted;
 *  a stored database stays). */
export function setTaskDump(t: CodeTask, dumpId: string): void {
  const d = attachDump(dumpId, t.id);
  if (t.dump && t.dump.id !== d.id && !t.dump.deletedAt && !t.dump.library) deleteDump(t.dump.id);
  t.dump = { id: d.id, name: d.name, size: d.size, sha256: d.sha256, imported: false, deletedAt: null, ignoreVersion: false, ...(d.library ? { library: true } : {}) };
}

type OwnCommand = { id: string; label: string; command: string; phase: CommandPhase; timeoutSec: number };
/** Steps of a new task: the template's steps; each slot for own commands becomes one step per command of that phase – the environment's
 *  first, then this sandbox's own (start dialog). */
export function planSteps(templateId: string, commands: OwnCommand[], own: OwnCommand[] = []): StoredStep[] {
  const out: StoredStep[] = [];
  for (const s of getTemplate(templateId).steps) {
    if (!s.custom) { out.push({ id: s.id, key: s.id, state: 'pending', log: [] }); continue; }
    for (const [source, list] of [['env', commands], ['task', own]] as const)
      for (const c of list.filter(x => x.phase === s.custom)) out.push({ id: `${s.id}:${source === 'env' ? '' : 't'}${c.id}`, key: 'custom', label: c.label, source, phase: c.phase, command: c.command, timeoutSec: c.timeoutSec, state: 'pending', log: [] });
  }
  return out;
}

/** The repository file's commands as steps (approved ones only): replaces earlier ones, each phase after the other own commands of that
 *  phase (before the template step that follows the slot). Steps before `from` stay as they are. */
export function placeRepoSteps(t: CodeTask, templateId: string, commands: { label: string; command: string; phase: CommandPhase; timeoutSec: number }[]): void {
  t.steps = t.steps.filter(s => s.source !== 'repo');
  const tpl = getTemplate(templateId).steps;
  for (const phase of ['after-db', 'final'] as const) {
    const slot = tpl.findIndex(s => s.custom === phase), next = tpl.slice(slot + 1).find(s => !s.custom)?.id;
    let at = next ? t.steps.findIndex(s => s.key === next) : t.steps.length;
    if (at < 0) at = t.steps.length;
    const add: StoredStep[] = commands.filter(c => c.phase === phase).map((c, i) => ({ id: `custom-${phase}:r${i}`, key: 'custom', label: c.label, source: 'repo', phase, command: c.command, timeoutSec: c.timeoutSec, state: 'pending', log: [] }));
    t.steps.splice(at, 0, ...add);
  }
}

export interface NewTask {
  chatId: string; title?: string; goal?: string; repo: string; baseBranch: string; dumpId?: string; pluginName?: string;
  /** A20: no repository ("Ohne Projekt starten"), the mode, an own setup's target, own commands and variables, declined repository commands */
  source?: 'repo' | 'none'; mode?: SandboxMode; targetPath?: string; commands?: { label: string; command: string; phase: CommandPhase; timeoutSec?: number }[];
  env?: { key: string; value: string }[]; skipRepoHash?: string;
  /** A22: another image tag (or the full name) of the configured image repository, the preview's first page, notes for the AI */
  image?: string; previewPath?: string; notes?: string;
}
/** What the start dialog chose, checked: the same rules for a new task and for a quick start (A22). Throws status 400 with a German
 *  message. image: the full name, only when it differs from the environment's. */
export function checkSetup(p: Omit<NewTask, 'chatId'>, locale: Locale = DEFAULT_LOCALE): Omit<StoredSetup, 'skipRepoHash'> {
  const bad = (m: string) => Object.assign(new Error(m), { status: 400 });
  if (p.pluginName && !PLUGIN_NAME.test(p.pluginName)) throw bad(pluginNameMsg(locale));
  const none = p.source === 'none', cfg = getSandboxConfig();
  const mode: SandboxMode = none ? 'plugin' : p.mode ?? 'auto';
  const targetPath = mode === 'custom' && p.targetPath?.trim() ? p.targetPath.trim() : undefined;
  if (targetPath && targetPathProblem(targetPath)) throw bad(messages(locale).server.targetPathInvalid);
  const previewPath = p.previewPath?.trim() || undefined;
  if (previewPath && !PREVIEW_PATH.test(previewPath)) throw bad(messages(locale).server.previewPathInvalid);
  let commands: StoredSetup['commands'] = [], env: StoredSetup['env'] = [], image: string | undefined, notes = '';
  try {
    commands = p.commands?.length ? checkCommands(p.commands, 10) : [];
    env = p.env?.length ? checkTaskEnv(p.env) : [];
    image = p.image?.trim() ? imageTag(p.image, cfg.image, cfg.template) : undefined;
    notes = p.notes ? cleanNotes(p.notes) : '';
  } catch (e) { throw bad((e as Error).message); }
  return { source: none ? 'none' : 'repo', mode, ...(targetPath ? { targetPath } : {}), commands, env,
    ...(image && image !== cfg.image ? { image } : {}), ...(previewPath ? { previewPath } : {}), ...(notes ? { notes } : {}) };
}
/** Branch base of a sandbox without a project: its local git starts with an empty commit on main */
export const NO_REPO_BASE = 'main';
/** Creates the row only (not running yet: runSteps sets setting_up), bound to the chat it was started from.
 *  Title (branch name, list): given, otherwise the repository's name. Own commands are taken from the environment now. */
export const attachedMsg = (locale: Locale = DEFAULT_LOCALE) => messages(locale).server.sandboxAttached;
export const pluginNameMsg = (locale: Locale = DEFAULT_LOCALE) => messages(locale).server.pluginNameInvalid;
export function createTask(p: NewTask, locale: Locale = DEFAULT_LOCALE): CodeTask {
  const cfg = getSandboxConfig(), id = newTaskId(), ts = now();
  if (!p.chatId) throw new Error('Chat fehlt.');
  // checked again here, without an await before codeTaskPut: two overlapping requests never attach two sandboxes to one chat
  if (attachedTask(p.chatId)) throw Object.assign(new Error(attachedMsg(locale)), { status: 409 });
  const setup = checkSetup(p, locale), none = setup.source === 'none';
  const title = (p.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || (none ? messages(locale).server.noRepoTitle : `Sandbox ${p.repo.split('/').pop() ?? p.repo}`);
  // without a project: a new plugin in the local git; its name as given, else one from the title
  const pluginName = none ? p.pluginName || pluginNameFromRepo(title.replace(/^Sandbox\s+/i, '')) || 'SandboxPlugin' : p.pluginName || null;
  const t: CodeTask = {
    id, chatId: p.chatId, template: cfg.templateId, repo: none ? '' : p.repo, baseBranch: none ? NO_REPO_BASE : p.baseBranch, branch: branchFor(title, id),
    status: 'interrupted', containerId: null, prNumber: null, prUrl: null, pushedSha: null, createdAt: ts, updatedAt: ts,
    title, goal: (p.goal ?? '').trim().slice(0, 4000), steps: planSteps(cfg.templateId, cfg.commands, setup.commands), layout: null, error: null,
    containerRunning: false, mode: null, port: null, lastActiveAt: ts, finishedAt: null, dump: null, pluginName,
    setup: { ...setup, ...(p.skipRepoHash && /^[0-9a-f]{64}$/.test(p.skipRepoHash) ? { skipRepoHash: p.skipRepoHash } : {}) },
    repoFile: null, image: setup.image ?? null, previewPath: setup.previewPath ?? null,
  };
  if (p.dumpId) setTaskDump(t, p.dumpId);
  codeTaskPut(t);
  return t;
}

/** A new plugin (empty repository) becomes an ordinary one once the AI has written composer.json and the plugin class: the layout
 *  then says what the repository is (plugin or theme, the class's name). The folder in the container stays where the setup put it,
 *  so the running sandbox keeps syncing to the same place; a new setup detects everything from scratch. No change while the
 *  repository is still incomplete. Returns the (possibly updated) task. */
export function settleNewPlugin(t: CodeTask): CodeTask {
  if (!t.layout?.isNew) return t;
  let found: TaskLayout;
  try { found = getTemplate(t.template).detectLayout(taskPaths(t.id).worktree); } catch { return t; }
  if (found.isNew) return t;
  t.layout = { kind: found.kind, name: found.name, pluginDir: t.layout.pluginDir };
  saveTask(t);
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
