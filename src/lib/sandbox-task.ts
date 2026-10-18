// Code tasks in the UI: applying live events, status groups and durations (pure, shared by hook, list and tests).
import type { Messages } from './i18n';
import type { CodeTaskPublic, CodeTaskStatus, CommandPhase, NewSandboxRequest, QuickStartPublic, QuickStartSetup, StartKind, TaskEvent, TaskStep } from './protocol';

const LOG_LINES = 200;

/** Self-hosting guide, section on enabling Sandbox Coding (Docker socket, compose). */
export const SANDBOX_DOCS = { de: 'https://github.com/Coding9GmbH/coding9-lotse/blob/main/docs/self-hosting.md#sandbox-coding-aktivieren', en: 'https://github.com/Coding9GmbH/coding9-lotse/blob/main/docs/en/self-hosting.md#enable-sandbox-coding' } as const;

/** Snapshot/transition replaces the task; a log line is appended to its step (at most 200 lines, like the server). */
export function applyTaskEvent(task: CodeTaskPublic | null, ev: TaskEvent): CodeTaskPublic | null {
  if (ev.t === 'task') return ev.task;
  if (ev.t === 'deleted' || !task) return ev.t === 'deleted' ? null : task;
  if (ev.t === 'chat') return task; // for the chat log, not the task
  return { ...task, steps: task.steps.map(s => (s.id === ev.step ? { ...s, log: [...s.log, ev.line].slice(-LOG_LINES) } : s)) };
}

/** The setup stopped at "Plugin erkennen" for the user's decision on the repository's .lotse/sandbox.json commands: stored as failed
 *  (so the step can continue), but it waits for the user – not an error. */
export const awaitsApproval = (t: Pick<CodeTaskPublic, 'status' | 'repoFile'>) => t.status === 'failed' && t.repoFile?.state === 'pending';
/** What status line, pip and hints show: the stored status, or 'approval' while the setup waits for that decision. */
export type TaskDisplayStatus = CodeTaskStatus | 'approval';
export const displayStatus = (t: Pick<CodeTaskPublic, 'status' | 'repoFile'>): TaskDisplayStatus => (awaitsApproval(t) ? 'approval' : t.status);

/** Pip in list and header: starting (setting up / waking), ready, waiting for the user, error, stopped (paused, interrupted), published/done. */
export type StatusTone = 'busy' | 'ok' | 'wait' | 'bad' | 'idle' | 'done';
export const statusTone = (s: TaskDisplayStatus): StatusTone =>
  s === 'setting_up' || s === 'waking' ? 'busy' : s === 'ready' ? 'ok' : s === 'approval' ? 'wait' : s === 'failed' ? 'bad' : s === 'done' ? 'done' : 'idle';

/** The preview's path when the start page (.lotse/sandbox.json "previewPath", known only once the setup read the file) changes: the new
 *  start page while the user stays on the previous one (or "/"), otherwise where the user went. */
export const followStartPath = (current: string, before: string | undefined, now: string | undefined): string =>
  current === (before ?? '/') ? now ?? '/' : current;
/** Something is happening on the server: the list keeps polling. */
export const isBusy = (s: CodeTaskStatus) => statusTone(s) === 'busy';

/** Duration of a step in seconds (running: until now), null before it started. */
export function stepSeconds(s: Pick<TaskStep, 'startedAt' | 'endedAt'>, now = Date.now()): number | null {
  if (!s.startedAt) return null;
  const end = s.endedAt ? Date.parse(s.endedAt) : now;
  return Math.max(0, Math.round((end - Date.parse(s.startedAt)) / 1000));
}
export const formatSeconds = (sec: number) => (sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} min`);

/** Retry is possible from a failed or interrupted step (and the task is not running or finished). */
export const canRetryFrom = (task: CodeTaskPublic, step: TaskStep) => (task.status === 'failed' || task.status === 'interrupted') && (step.state === 'failed' || step.state === 'interrupted');

/** Lines of console output that do not say why (stack frames, "In File.php line 12:", exception class names, the command echo). */
const NOISE = /^(#\d+\s|In \S+ line \d+:?$|\[[\w\\]+(Exception|Error)\]$|at \S+[:(]|Stack trace:|Exception trace:|\$ |[-=*]+$)/i;
/** One line for a failed step: its first line ("„X“ fehlgeschlagen (Exit-Code 1)") and the first output line that says why.
 *  The full output stays in the step's log. */
export function errorSummary(error: string): string {
  const [head = '', ...rest] = error.split('\n').map(l => l.trim()).filter(Boolean);
  const why = rest.find(l => !NOISE.test(l));
  return why ? `${head.replace(/[:.]$/, '')}: ${why}` : head;
}

/** "coding9/…-theme": keeps the start (owner) and the end of a long name, the middle becomes "…". */
export function middleTruncate(s: string, max = 28): string {
  if (s.length <= max || max < 5) return s;
  const head = Math.ceil((max - 1) / 2), tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
/** A path shortened in the middle at "/" boundaries: "src/…/header/header.html.twig" (the file name always stays). */
export function shortPath(p: string, max = 44): string {
  if (p.length <= max) return p;
  const parts = p.split('/'), file = parts.pop() ?? p;
  let tail = file;
  for (let i = parts.length - 1; i > 0 && `${parts[0]}/…/${parts[i]}/${tail}`.length <= max; i--) tail = `${parts[i]}/${tail}`;
  return parts.length ? `${parts[0]}/…/${tail}` : file;
}

/** Why a pending step will be skipped anyway: no dump (version check, import), a new plugin from an empty repository (nothing to
 *  install, nor to compile unless a dump was imported) or an own setup (Lotse neither tidies the shop nor compiles its theme). Shown as "wird übersprungen" from the start; null = it runs. */
export function skipReason(task: Pick<CodeTaskPublic, 'dump'> & { layout?: CodeTaskPublic['layout'] }, s: Pick<TaskStep, 'key' | 'state'>): 'noDump' | 'newPlugin' | 'custom' | null {
  if (s.state !== 'pending') return null;
  if (!task.dump && (s.key === 'version-check' || s.key === 'import-db')) return 'noDump';
  if (task.layout?.kind === 'custom' && (s.key === 'preview-tidy' || s.key === 'theme-compile')) return 'custom';
  if (task.layout?.isNew && (s.key === 'install-plugin' || (s.key === 'theme-compile' && !task.dump))) return 'newPlugin';
  return null;
}
export const willSkip = (task: Parameters<typeof skipReason>[0], s: Pick<TaskStep, 'key' | 'state'>) => skipReason(task, s) !== null;

// ---- New plugins from an (almost) empty repository ----
/** Technical name of a Shopware plugin (its class name and folder below custom/plugins), e.g. CoNineHeaderBanner. */
export const PLUGIN_NAME = /^[A-Z][A-Za-z0-9]{1,60}$/;
/** Name of a new repository (without the owner) as GitHub accepts it: letters, digits, . _ -, at most 100, not "." or "..", not ending in .git. */
export const REPO_NAME = /^(?!\.{1,2}$)(?!.*\.git$)[A-Za-z0-9._-]{1,100}$/i;
/** Files an "empty" repository may contain: what GitHub creates with a new repository (README, LICENSE, .gitignore) and similar. */
const SCAFFOLD_ONLY = /^(readme(\.[a-z]{1,8})?|licen[cs]e(\.[a-z]{1,8})?|copying|\.gitignore|\.gitattributes|\.editorconfig)$/i;
/** The names in a repository's root say "nothing to install yet": only the files above (and the worktree's .git). */
export const isEmptyRepoListing = (names: string[]) => names.filter(n => n !== '.git').every(n => SCAFFOLD_ONLY.test(n));
/** Suggested technical name from the repository name: "coding9/shopware-header-banner" → "ShopwareHeaderBanner"; '' if none fits. */
export function pluginNameFromRepo(repo: string): string {
  const words = (repo.split('/').pop() ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  let name = words.map(w => w[0].toUpperCase() + w.slice(1)).join('');
  if (/^[0-9]/.test(name)) name = `Plugin${name}`;
  name = name.slice(0, 61);
  return PLUGIN_NAME.test(name) ? name : '';
}

/** Progress of the setup: the current (running or next) step's number among the steps that will run, and their count. */
export function setupProgress(task: Pick<CodeTaskPublic, 'steps' | 'dump'> & { layout?: CodeTaskPublic['layout'] }): { current: number; total: number; done: number } {
  const counted = task.steps.filter(s => s.state !== 'skipped' && !willSkip(task, s));
  const done = counted.filter(s => s.state === 'done').length;
  const at = counted.findIndex(s => s.state !== 'done');
  return { current: at < 0 ? counted.length : at + 1, total: counted.length, done };
}

/** How long the setup took (first start to last end, in seconds), null while it never finished. */
export function setupSeconds(task: Pick<CodeTaskPublic, 'steps'>): number | null {
  const starts = task.steps.map(s => s.startedAt).filter(Boolean).map(x => Date.parse(x!));
  const ends = task.steps.map(s => s.endedAt).filter(Boolean).map(x => Date.parse(x!));
  if (!starts.length || !ends.length || task.steps.some(s => s.state !== 'done' && s.state !== 'skipped')) return null;
  return Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000));
}

/** Publish stepper (Commit → Push → Pull Request): the state of each step from task.publish. */
export const PUBLISH_STEPS = ['commit', 'push', 'pr'] as const;
export type PublishStepState = 'pending' | 'running' | 'done' | 'failed';
export function publishSteps(p: CodeTaskPublic['publish']): Record<(typeof PUBLISH_STEPS)[number], PublishStepState> {
  const at = p ? PUBLISH_STEPS.indexOf(p.step as (typeof PUBLISH_STEPS)[number]) : -1; // 'check' = before the first
  const state = (i: number): PublishStepState => {
    if (!p || at < 0) return 'pending';
    if (i < at) return 'done';
    if (i > at) return 'pending';
    return p.state === 'running' ? 'running' : p.state === 'failed' ? 'failed' : 'pending';
  };
  return { commit: state(0), push: state(1), pr: state(2) };
}

/** An action's response vs. the live stream: the stream may already carry a newer state (resume answers "waking" while the
 *  stream says "ready"), so an older snapshot never replaces a newer one. */
export const newerTask = (cur: CodeTaskPublic | null, next: CodeTaskPublic): CodeTaskPublic =>
  cur && cur.id === next.id && Date.parse(cur.updatedAt) > Date.parse(next.updatedAt) ? cur : next;

// ---- "Eigenes Setup" (A20): where the code goes in the container ----
/** Roots below which an own setup may place the code (a folder strictly below one of them) */
export const TARGET_ROOTS = ['/var/www', '/opt', '/srv'] as const;
/** Why a target path is not accepted ('absolute': not absolute or not normalized, 'chars': characters outside letters, digits . _ -,
 *  'root': not below an allowed root), null = fine */
export function targetPathProblem(p: string): 'absolute' | 'chars' | 'root' | null {
  if (!p.startsWith('/') || p.length > 200 || p.endsWith('/') || p.includes('//')) return 'absolute';
  const segs = p.slice(1).split('/');
  if (segs.some(s => s === '.' || s === '..')) return 'absolute';
  if (segs.some(s => !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(s))) return 'chars';
  if (segs.length > 8 || !TARGET_ROOTS.some(r => p.startsWith(`${r}/`))) return 'root';
  return null;
}
/** Suggested target for an own setup: /opt/<repository name> (lower case, safe characters), /opt/app without one */
export function suggestTargetPath(repo: string): string {
  const name = (repo.split('/').pop() ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9_]+/, '').slice(0, 60);
  return `/opt/${name || 'app'}`;
}
/** A preview start path (.lotse/sandbox.json "previewPath"): a storefront path beginning with "/", without host, spaces or backslashes */
export const PREVIEW_PATH = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,299}$/;

// ---- Saved environments (A22/A23, internally quick starts): a saved request of the start dialog ----
/** The dialog's request → what a quick start keeps: no chat, title or decision on the repository file's commands; a one-off upload is not
 *  kept (keepDump false: demo data). The server checks it again like a start. */
export function quickSetupOf(kind: StartKind, req: Omit<NewSandboxRequest, 'chatId'>, keepDump: boolean, envRefs: string[] = []): QuickStartSetup {
  const { title: _title, skipRepoHash: _skip, dumpId, ...rest } = req; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
  // envRefs always sent (also []): the server keeps a quick start's references only while the setup carries them
  return { kind, ...rest, ...(dumpId && keepDump ? { dumpId } : {}), envRefs: kind === 'none' ? [] : envRefs };
}
/** What the dialog shows for a quick start (prefill): its first step, project, plugin name, own setup, "Erweitert" and the data */
export interface StartDraft {
  kind: StartKind; repo: string; baseBranch: string; pluginName: string;
  /** "ändern" → own setup of an existing project */ custom: boolean; targetPath: string | null;
  commands: { label: string; command: string; phase: CommandPhase }[]; vars: { key: string; value: string }[];
  /** variables taken from the environment by name only (their value was or is secret) */ envRefs: string[];
  dumpId: string | null; image: string; previewPath: string; notes: string;
  /** "Erweitert" opens: something in it is set */ advanced: boolean;
}
export function draftOf(s: QuickStartSetup): StartDraft {
  const none = s.kind === 'none' || s.source === 'none';
  const kind: StartKind = none ? 'none' : s.kind;
  const d: Omit<StartDraft, 'advanced'> = {
    kind, repo: none ? '' : s.repo, baseBranch: none ? '' : s.baseBranch, pluginName: s.pluginName ?? '',
    custom: kind === 'existing' && s.mode === 'custom', targetPath: s.mode === 'custom' || kind === 'custom' ? s.targetPath ?? null : null,
    commands: (s.commands ?? []).map(c => ({ label: c.label, command: c.command, phase: c.phase })), vars: (s.env ?? []).map(v => ({ key: v.key, value: v.value })),
    envRefs: none ? [] : [...(s.envRefs ?? [])],
    dumpId: s.dumpId ?? null, image: s.image ?? '', previewPath: s.previewPath ?? '', notes: s.notes ?? '',
  };
  return { ...d, advanced: kind === 'custom' || d.custom || !!(d.commands.length || d.vars.length || d.envRefs.length || d.image || d.previewPath || d.notes) };
}

/** "Als Umgebung „X“ gespeichert." plus the variables kept by name only (the server turned a secret value into a reference) */
export const savedText = (q: QuickStartPublic, all: Messages) =>
  `${all.sandbox.quick.saved(q.name)}${q.setup.envRefs?.length ? ` ${all.sandbox.quick.savedRefs(q.setup.envRefs.join(', '))}` : ''}`;

/** What a saved environment will use, in one line: "Bestehendes Projekt · acme/shop @ main · Demo-Daten · Image 6.7.14.0" (the stored
 *  database by its name, if known) */
export function quickSummary(s: QuickStartSetup, all: Messages, dumpName: (id: string) => string | null | undefined = () => null): string {
  const ts = all.sandbox.start;
  const source = s.kind === 'none' ? ts.localSource(s.pluginName || 'SandboxPlugin') : `${s.repo} @ ${s.baseBranch}`;
  const data = s.dumpId ? dumpName(s.dumpId) ?? ts.dataStored : ts.dataDemo;
  const line = ts.summary(ts.kinds[s.kind].title, source, data);
  return s.image ? `${line} · ${all.sandbox.quick.image(s.image.slice(s.image.lastIndexOf(':') + 1))}` : line;
}

// ---- A23: one choice list at every entry point (the "Sandbox starten" menu, the AI's card, the Sandbox Coding page) ----
/** What starts a sandbox: a saved environment, the demo shop without a project (one click) or "Neu einrichten …" (the start dialog) */
export type StartChoice = { type: 'env'; id: string } | { type: 'demo' } | { type: 'new' };
export const choiceKey = (c: StartChoice) => (c.type === 'env' ? c.id : c.type);
/** Saved environments in the order every list shows them: the default first, then by name */
export function orderedEnvironments<T extends { name: string; default: boolean }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name, 'de'));
}
/** The choices top to bottom: saved environments (default first) → "Demo-Shop ohne Projekt" → "Neu einrichten …" */
export function startChoices(list: readonly QuickStartPublic[]): StartChoice[] {
  return [...orderedEnvironments(list).map((q): StartChoice => ({ type: 'env', id: q.id })), { type: 'demo' }, { type: 'new' }];
}
/** "Demo-Shop ohne Projekt": dockware's demo data, no repository (the changes stay in the local git), started with one click */
export const demoRequest = (chatId: string, title: string): NewSandboxRequest => ({ chatId, repo: '', baseBranch: '', source: 'none', title });
/** The choice the AI's card starts with: the environment it suggested (if still saved); else "Neu einrichten …" for a repository it
 *  proposed; else the default environment; else the demo shop */
export function offerChoice(offer: { quickStartId?: string; repo: string }, list: readonly QuickStartPublic[]): StartChoice {
  if (offer.quickStartId && list.some(q => q.id === offer.quickStartId)) return { type: 'env', id: offer.quickStartId };
  if (offer.repo) return { type: 'new' };
  const def = list.find(q => q.default);
  return def ? { type: 'env', id: def.id } : { type: 'demo' };
}
