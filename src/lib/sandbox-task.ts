// Code tasks in the UI: applying live events, status groups and durations (pure, shared by hook, list and tests).
import type { CodeTaskPublic, CodeTaskStatus, TaskEvent, TaskStep } from './protocol';

const LOG_LINES = 200;

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
