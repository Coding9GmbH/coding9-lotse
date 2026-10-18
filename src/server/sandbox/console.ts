import 'server-only';
// Console of a sandbox (tab "Konsole"): an interactive shell in the task container for the user – never for the AI (no tool, no MCP).
// Next.js route handlers have no WebSockets, so the server holds the hijacked exec stream per console session: the browser reads the
// output as NDJSON (numbered base64 chunks, the last ones buffered for a reconnect after a reload) and sends input and resizes by POST.
// - session ids are random and bound to the task and the actor (the login name; null without LOTSE_PASSWORD)
// - at most CONSOLE_MAX open per task; closed after CONSOLE_IDLE_MINUTES without input, and with pause, finish, a new setup and when
//   Sandbox Coding is switched off; a Lotse restart ends the shells it no longer holds (killOrphanConsoles)
// - only containers Lotse manages (the runner checks the label), only the template's own shell; audit: opened/closed, never keystrokes
// - opening wakes a paused sandbox, input counts as activity (the idle sweeper keeps the container running)
import crypto from 'node:crypto';
import { CONSOLE_IDLE_MINUTES, CONSOLE_MAX, type ConsoleCloseReason, type ConsoleEvent, type ConsoleSessionPublic } from '@/lib/protocol';
import { withActor } from '../actor';
import { auditAdd } from '../db';
import { log } from '../log';
import { singleton } from '../state';
import { ensureAwake, touchTask } from './jobs';
import { getRunner, type TtySession } from './runner';
import { getTemplate } from './templates';
import type { ConsoleSpec } from './templates/types';
import { getTask, listTasks, mustTask, type CodeTask } from './tasks';

export const CONSOLE_IDLE_MS = CONSOLE_IDLE_MINUTES * 60_000;
/** one POST of input (a paste) */
export const INPUT_MAX = 64 * 1024;
/** output kept per session for a reconnect (the end of it) */
const BUFFER_BYTES = 256 * 1024;
/** an ended session still tells a reconnecting view why, for this long */
const ENDED_MS = 10 * 60_000;
const SID = /^[a-f0-9]{24}$/;
const COLS = { min: 10, max: 500 }, ROWS = { min: 4, max: 200 };

interface Session {
  id: string; taskId: string; actor: string | null; containerId: string; spec: ConsoleSpec; pidFile: string; tty: TtySession;
  openedAt: string; lastInput: number; cols: number; rows: number;
  seq: number; chunks: { seq: number; data: Buffer }[]; size: number; listeners: Set<(ev: ConsoleEvent) => void>;
  /** why it is being closed (set before the stream ends); unset when the shell ended by itself */ closing?: ConsoleCloseReason;
}
interface Registry { open: Map<string, Session>; ended: Map<string, { taskId: string; actor: string | null; reason: ConsoleCloseReason; at: number }>; opening: Map<string, number> }
const reg = () => singleton<Registry>('sandboxConsoles', () => ({ open: new Map(), ended: new Map(), opening: new Map() }));

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const pidFileOf = (sid: string) => `/tmp/.lotse-console-${sid}.pid`;
const publicOf = (s: Session): ConsoleSessionPublic => ({ id: s.id, openedAt: s.openedAt, cols: s.cols, rows: s.rows });
const ofTask = (taskId: string) => [...reg().open.values()].filter(s => s.taskId === taskId);
/** The template's console, or null (a template without one, e.g. a containerless one). */
export function consoleSpec(t: Pick<CodeTask, 'template'>): ConsoleSpec | null {
  try { return getTemplate(t.template).console ?? null; } catch { return null; }
}
function size(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const ok = (v: unknown, r: { min: number; max: number }) => typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max;
  if (!ok(cols, COLS) || !ok(rows, ROWS)) throw fail(400, `Ungültige Größe (Spalten ${COLS.min}–${COLS.max}, Zeilen ${ROWS.min}–${ROWS.max}).`);
  return { cols: cols as number, rows: rows as number };
}

function audit(s: Pick<Session, 'id' | 'taskId' | 'actor'>, event: 'open' | 'close', extra: Record<string, unknown> = {}) {
  const t = getTask(s.taskId);
  if (!t) return;
  withActor(s.actor, () => auditAdd({ decision: 'changed', kind: 'sandbox-task', taskId: t.id, action: 'console', event, session: s.id.slice(0, 8), title: `Sandbox-Aufgabe: ${t.title}`, repo: t.repo, branch: t.branch, ...(t.chatId ? { chatId: t.chatId } : {}), ...extra }));
}

/** The stream ended (closed by Lotse, the shell exited, the container stopped): tell the views, remember why, audit. */
function ended(s: Session) {
  const R = reg();
  if (R.open.get(s.id) !== s) return;
  R.open.delete(s.id);
  const reason = s.closing ?? 'exit';
  R.ended.set(s.id, { taskId: s.taskId, actor: s.actor, reason, at: Date.now() });
  for (const fn of s.listeners) { try { fn({ t: 'end', reason }); } catch { /* view gone */ } }
  s.listeners.clear();
  audit(s, 'close', { reason, seconds: Math.round((Date.now() - Date.parse(s.openedAt)) / 1000) });
}

/** "Neue Konsole": wakes a paused sandbox, then starts the template's shell in the task container. */
export async function openConsole(taskId: string, actor: string | null, want: { cols: unknown; rows: unknown }): Promise<ConsoleSessionPublic> {
  const t = mustTask(taskId), dims = size(want.cols, want.rows), spec = consoleSpec(t);
  if (!spec) throw fail(409, 'Diese Umgebung hat keine Konsole.');
  if (t.status === 'done') throw fail(409, 'Die Aufgabe ist abgeschlossen.');
  const R = reg(), pending = R.opening.get(taskId) ?? 0;
  if (ofTask(taskId).length + pending >= CONSOLE_MAX) throw fail(409, `Höchstens ${CONSOLE_MAX} Konsolen je Sandbox – schließe zuerst eine.`);
  R.opening.set(taskId, pending + 1); // counted while waking and starting: two quick clicks never make a fourth
  try {
    // a running container (also while setting up or after a failed step: useful for looking around) is used as is; a paused one is woken
    const running = !!t.containerId && t.containerRunning && t.status !== 'paused' && t.status !== 'waking';
    if (!running) await ensureAwake(taskId);
    const cur = mustTask(taskId);
    if (!cur.containerId || !cur.containerRunning || cur.status === 'paused' || cur.status === 'done') throw fail(409, cur.error ?? 'Der Container läuft nicht – die Konsole braucht eine laufende Sandbox.');
    const id = crypto.randomBytes(12).toString('hex'), pidFile = pidFileOf(id);
    const tty = await getRunner().openTty(cur.containerId, spec.shell(pidFile), { user: spec.user, workdir: spec.workdir, env: spec.env, ...dims });
    const s: Session = { id, taskId, actor, containerId: cur.containerId, spec, pidFile, tty, openedAt: new Date().toISOString(), lastInput: Date.now(), ...dims, seq: 0, chunks: [], size: 0, listeners: new Set() };
    R.open.set(id, s);
    tty.onData(data => {
      const ev: ConsoleEvent = { t: 'out', seq: s.seq, data: data.toString('base64') };
      s.chunks.push({ seq: s.seq++, data }); s.size += data.length;
      while (s.size > BUFFER_BYTES && s.chunks.length > 1) s.size -= s.chunks.shift()!.data.length;
      for (const fn of s.listeners) { try { fn(ev); } catch { /* view gone */ } }
    });
    tty.onEnd(() => ended(s));
    audit(s, 'open', { user: spec.user });
    touchTask(taskId);
    return publicOf(s);
  } finally {
    const n = (R.opening.get(taskId) ?? 1) - 1;
    if (n > 0) R.opening.set(taskId, n); else R.opening.delete(taskId);
  }
}

/** The actor's open consoles of a task (a reloaded view reattaches to them). */
export const listConsoles = (taskId: string, actor: string | null): ConsoleSessionPublic[] =>
  ofTask(taskId).filter(s => s.actor === actor).sort((a, b) => a.openedAt.localeCompare(b.openedAt)).map(publicOf);

/** A session of this task and actor; anything else is "not found" (no hint that the id exists). */
function owned(taskId: string, sid: string, actor: string | null): Session {
  const s = SID.test(sid) ? reg().open.get(sid) : undefined;
  if (!s || s.taskId !== taskId || s.actor !== actor) throw fail(404, 'Konsole nicht gefunden.');
  return s;
}

/** Output from chunk `from` on (buffered ones first), then live, then the end. An ended session reports its reason once.
 *  Returns the function that detaches the listener. */
export function attachConsole(taskId: string, sid: string, actor: string | null, from: number, send: (ev: ConsoleEvent) => void): () => void {
  const gone = SID.test(sid) ? reg().ended.get(sid) : undefined;
  if (gone && gone.taskId === taskId && gone.actor === actor) { send({ t: 'end', reason: gone.reason }); return () => {}; }
  const s = owned(taskId, sid, actor);
  for (const c of s.chunks) if (c.seq >= from) send({ t: 'out', seq: c.seq, data: c.data.toString('base64') });
  s.listeners.add(send);
  return () => { s.listeners.delete(send); };
}

/** Keystrokes or pasted text (at most INPUT_MAX bytes per call); counts as activity. */
export function consoleInput(taskId: string, sid: string, actor: string | null, data: unknown): void {
  const s = owned(taskId, sid, actor);
  if (typeof data !== 'string') throw fail(400, 'Eingabe fehlt.');
  if (Buffer.byteLength(data) > INPUT_MAX) throw fail(413, `Eingabe zu groß (höchstens ${INPUT_MAX / 1024} KB auf einmal).`);
  s.tty.write(data);
  s.lastInput = Date.now();
  touchTask(taskId);
}

export async function resizeConsole(taskId: string, sid: string, actor: string | null, want: { cols: unknown; rows: unknown }): Promise<void> {
  const s = owned(taskId, sid, actor), dims = size(want.cols, want.rows);
  if (dims.cols === s.cols && dims.rows === s.rows) return;
  Object.assign(s, dims);
  await s.tty.resize(dims.cols, dims.rows);
}

/** Close one console: the template's stop command ends the shell's session in the container (unless the container is about to stop
 *  anyway, `kill: false`), then the connection is dropped. */
async function close(s: Session, reason: ConsoleCloseReason, kill: boolean): Promise<void> {
  if (s.closing) return;
  s.closing = reason;
  if (kill) {
    const stop = s.spec.stop(s.pidFile);
    await getRunner().exec(s.containerId, stop.argv, { user: stop.user, workdir: '/', timeoutMs: 15_000 })
      .catch(e => log.warn('Konsole im Container nicht beendet', { task: s.taskId, error: e }));
  }
  s.tty.close();
  ended(s); // in case the runner never reports the end of a dropped stream
}
export async function closeConsole(taskId: string, sid: string, actor: string | null): Promise<void> {
  await close(owned(taskId, sid, actor), 'user', true);
}
/** Lifecycle: every console of the task. `kill`: end the shells first (the container keeps running, e.g. a new setup). */
export async function closeTaskConsoles(taskId: string, reason: ConsoleCloseReason, kill = false): Promise<number> {
  const list = ofTask(taskId);
  await Promise.all(list.map(s => close(s, reason, kill)));
  return list.length;
}
/** Sandbox Coding switched off: every console (the containers are stopped right after). */
export async function closeAllConsoles(reason: ConsoleCloseReason): Promise<number> {
  const list = [...reg().open.values()];
  await Promise.all(list.map(s => close(s, reason, false)));
  return list.length;
}

/** Idle sweeper: consoles without input for CONSOLE_IDLE_MS are closed (their shells ended); forgets old end reasons. */
export async function sweepConsoles(now = Date.now()): Promise<string[]> {
  const R = reg(), idle = [...R.open.values()].filter(s => now - s.lastInput >= CONSOLE_IDLE_MS);
  await Promise.all(idle.map(s => close(s, 'idle', true)));
  for (const [id, e] of R.ended) if (now - e.at > ENDED_MS) R.ended.delete(id);
  return idle.map(s => s.id);
}

/** After a Lotse restart: shells of consoles nobody holds any more are ended in every running task container (best effort);
 *  returns how many. */
export async function killOrphanConsoles(): Promise<number> {
  const open = new Set([...reg().open.values()].map(s => s.containerId));
  let n = 0;
  for (const t of listTasks()) {
    const spec = consoleSpec(t);
    if (!spec || !t.containerId || !t.containerRunning || t.status === 'done' || open.has(t.containerId)) continue;
    await getRunner().exec(t.containerId, spec.stopAll.argv, { user: spec.stopAll.user, workdir: '/', timeoutMs: 15_000 }).then(r => {
      const ended = Number.parseInt(r.output.trim(), 10) || 0;
      if (!ended) return;
      n += ended; // who had opened them is gone with the restart: audited without a user
      audit({ id: 'orphaned', taskId: t.id, actor: null }, 'close', { reason: 'lotse-restart', shells: ended });
    }, e => log.warn('Verwaiste Konsolen nicht beendet', { task: t.id, error: e }));
  }
  return n;
}

/** Tests: open consoles of a task (also other actors'). */
export const consoleCount = (taskId: string) => ofTask(taskId).length;
