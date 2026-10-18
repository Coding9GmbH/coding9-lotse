// Code tasks in the UI: applying live events, status groups and durations (pure, shared by hook, list and tests).
import type { CodeTaskPublic, CodeTaskStatus, TaskEvent, TaskStep } from './protocol';

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

/** Pip in list and header: starting (setting up / waking), ready, error, stopped (paused, interrupted), published/done. */
export type StatusTone = 'busy' | 'ok' | 'bad' | 'idle' | 'done';
export const statusTone = (s: CodeTaskStatus): StatusTone =>
  s === 'setting_up' || s === 'waking' ? 'busy' : s === 'ready' ? 'ok' : s === 'failed' ? 'bad' : s === 'done' ? 'done' : 'idle';
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
