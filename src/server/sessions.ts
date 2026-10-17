import 'server-only';
// Chat sessions: history (SQLite), approval workflow (questions + change sets) and the AI's read client (via the platform adapter).
import type { ChangeSet, ChangeStatus, ChatDetail, ChatEvent, ChatStatus, ChatSummary, Target } from '@/lib/protocol';
import type { PlatformKind } from '@/lib/platforms';
import { auditLog, notifyApplied, type ApplyPartial, type ApplyResult } from './changes';
import type { PageSpec, PreviewCtx } from './cms';
import { chatGet, chatList, chatPut, runDelete, runPut, runsOpen, type ChangeRun, type StoredChat } from './db';
import { attachedTask } from './sandbox/tasks';
import { activeKind, getPlatform, undoWithPlatform } from './platform';
import type { ShopLookup } from './platform/types';
import { ReadOnlyShopware, type ShopReader } from './shopware';
import { singleton } from './state';
import type { Fetcher } from './styleguide';
import { errMsg } from './util';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/locales';
import { messages } from '@/lib/i18n';
import { log } from './log';

export interface ApprovalReply { answer?: string; allow?: boolean; selected?: string[] }
export interface Question { question: string; options: { label: string; description?: string }[] }
export interface ChangeOutcome { status: ChangeStatus; message: string; applied?: number; failed?: { item: string; error?: string }[]; error?: string; [k: string]: unknown }

export interface Session {
  id: string;
  /** Sandbox attached to this chat (Sandbox Coding), as of the start of the last turn: then the AI works only in the sandbox
   *  (workspace + container tools, no live-shop tools). null = a normal shop chat. */
  taskId: string | null;
  /** sandbox task the AI session (sdkSessionId/codexThreadId) belongs to; a different one at the next turn starts a new AI session */
  agentScope: string | null;
  /** Shop platform of this session (taken from the settings on creation) */
  platform: PlatformKind;
  /** protected read client of the platform (Shopware: the same object as sw); adapter tools cast to their type */
  reader: unknown;
  /** platform-neutral read functions for core features (knowledge base, Search Console, view_image) */
  lookup: ShopLookup;
  /** Shopware read client (Shopware tools only; locked on other platforms) */
  sw: ReadOnlyShopware;                 // AI: read-only, enabled areas only
  storefrontFetch: Fetcher;
  themeCss: () => Promise<string | null>;
  draft: PageSpec | null;
  sdkSessionId: string | null;
  /** Cumulative cost the Agent SDK reported for this chat's session (the next turn's cost = new total minus this, usage.ts) */
  costTotal?: number | null;
  /** SDK session the costTotal belongs to (a new session counts as a whole) */
  costSession?: string | null;
  /** Codex thread (ChatGPT subscription), separate from the Claude session in case the provider is switched */
  codexThreadId: string | null;
  title: string | null;
  target: Target | null;
  createdAt: string;
  events: ChatEvent[];
  emit: (ev: ChatEvent) => void;
  /** Is an AI turn running? It continues independently of the connection (chat switch, reload). */
  running: boolean;
  /** last access (idle sessions without listeners are released after a while) */
  lastUsed: number;
  abort: AbortController | null;
  /** The AI's response language (UI language at the last message) */
  locale: Locale;
  /** Connected UIs that receive live events */
  listeners: Set<(ev: ChatEvent) => void>;
  approvals: Map<string, (r: ApprovalReply) => void>;
  askUser: (q: Question) => Promise<string>;
  requestChange: (cs: ChangeSet, payload?: unknown) => Promise<ChangeOutcome>;
  renderDraft?: (spec: PageSpec, partial?: boolean) => Promise<string>;
  lastCtx?: PreviewCtx;
  /** Chat was deleted while a turn was running: don't save anything anymore (otherwise the turn would recreate it) */
  deleted?: boolean;
}

const sessions = () => singleton('sessions', () => new Map<string, Session>()); // chatId -> Session
export const dropSession = (id: string) => { const s = peekSession(id); if (s) { s.deleted = true; cancelPersist(s); } stopChat(id); sessions().delete(id); };

// UI language at the last chat message: for texts created without a request language (new session, restart cleanup)
const ui = () => singleton('sessions-ui-locale', () => ({ locale: DEFAULT_LOCALE as Locale }));
export const noteUiLocale = (l: Locale) => { ui().locale = l; };

// Release idle sessions without listeners after 30 minutes: the history is in the DB, getSession rebuilds them when needed.
// Running turns and connected UIs stay untouched.
const IDLE_MS = 30 * 60_000;
export function sweepIdleSessions(now = Date.now()): number {
  let n = 0;
  for (const [id, s] of sessions()) if (!s.running && !s.listeners.size && now - s.lastUsed > IDLE_MS) { persist(s); sessions().delete(id); n++; }
  return n;
}
const sweeper = () => singleton('sessions-sweeper', () => { const t = setInterval(sweepIdleSessions, 5 * 60_000); t.unref?.(); return t; });
/** Session only if it is already in memory (does not create a new one). */
export const peekSession = (id: string) => sessions().get(id) ?? null;

export const chatStatus = (s: Session | null): ChatStatus | undefined => (!s?.running ? undefined : s.approvals.size ? 'waiting' : 'running');

/** History with live status from memory (running / waiting for the human). */
export const chatListLive = (): ChatSummary[] => chatList().map(c => {
  const status = chatStatus(peekSession(c.id));
  return status ? { ...c, status } : c;
});

/** Current state of a chat: from memory (also while running) or persisted. `locale`: language for restart notices (otherwise the last one used). */
export function chatSnapshot(id: string, locale?: Locale): ChatDetail | null {
  const s = peekSession(id);
  const sbx = () => { const t = attachedTask(id); return t ? { taskId: t.id } : {}; };
  if (s && (s.running || s.events.length)) return { id, title: s.title ?? '', target: s.target, events: s.events, ...sbx() };
  const c = loadChat(id, locale);
  return c ? { id: c.id, title: c.title ?? '', target: c.target, events: c.events, ...sbx() } : null;
}

/** A sandbox was attached to the chat (by the user): a line in the history, live to open views; the next turn works in the sandbox.
 *  A chat without messages yet is stored now (title from the task), so it appears in the history. */
export function noteSandboxAttached(chatId: string, t: { id: string; title: string; repo: string; baseBranch: string }) {
  const s = getSession(chatId);
  const ev: ChatEvent = { t: 'sandbox_attached', taskId: t.id, repo: t.repo, baseBranch: t.baseBranch };
  s.title ??= t.title.slice(0, 70);
  s.events.push(ev);
  if (!s.running) s.taskId = t.id;
  persist(s);
  for (const l of s.listeners) { try { l(ev); } catch { s.listeners.delete(l); } }
}

/** An event from outside a turn (e.g. the pull request the user published): saved in the history at once and sent to open views. */
export function noteChatEvent(chatId: string, ev: ChatEvent) {
  const s = getSession(chatId);
  s.events.push(ev);
  persist(s);
  for (const l of s.listeners) { try { l(ev); } catch { s.listeners.delete(l); } }
}

/** Aborts a running turn; open questions/approvals count as rejected. */
export function stopChat(id: string): boolean {
  const s = peekSession(id);
  if (!s?.running) return false;
  for (const [approvalId, resolve] of s.approvals) {
    const q = s.events.find(e => e.t === 'question' && e.approvalId === approvalId);
    if (q?.t === 'question' && q.answer === undefined) q.answer = messages(s.locale).server.cancelled; // otherwise it counts as "Nicht beantwortet (Neustart)" (not answered, restart) on the next load
    resolve({ allow: false, answer: '' });
  }
  s.approvals.clear(); persist(s);
  log.info('Runde abgebrochen', { chatId: id });
  s.abort?.abort();
  return true;
}

const evType = (e: ChatEvent) => (e as { t: string }).t;

// ---- Persistent chats (SQLite) ----
// The whole chat is stored as one JSON row. Two paths:
// - persist: immediately (questions, change sets and their results, decisions, end of turn, abort, errors). Takes a pending batched one along.
// - persistSoon: batched, at most every PERSIST_MS per chat (streaming: text, tool calls). Before process exit, flushPersists writes everything pending.
// Approvals/change sets never go through persistSoon: a crash loses at most the last PERSIST_MS of text, never an approval.
const PERSIST_MS = 500;
const pendingPersists = () => singleton('sessions-persist-pending', () => new Map<Session, { cancel(): void }>());
const lastPersist = new WeakMap<Session, number>();
const cancelPersist = (s: Session) => { const p = pendingPersists(), t = p.get(s); if (t) { t.cancel(); p.delete(s); } };

/** Save immediately (important states). */
export function persist(s: Session) {
  cancelPersist(s); lastPersist.set(s, runClock.now());
  if (s.deleted || !s.events.length) return;
  let lastDraft = -1; s.events.forEach((e, i) => { if (e.t === 'draft') lastDraft = i; });
  const events = s.events.map((e, i) => (e.t === 'draft' && i !== lastDraft ? { ...e, html: undefined } : e)); // keep only the last preview
  const c: StoredChat = { id: s.id, title: s.title, target: s.target, createdAt: s.createdAt, updatedAt: new Date().toISOString(), sdkSessionId: s.sdkSessionId, costTotal: s.costTotal ?? null, costSession: s.costSession ?? null, codexThreadId: s.codexThreadId, draft: s.draft, events, agentScope: s.agentScope };
  chatPut(c);
}

/** Batched save: at most once per PERSIST_MS (the first time after a pause immediately, then at the end of the window). */
export function persistSoon(s: Session) {
  const p = pendingPersists(); if (p.has(s) || s.deleted) return;
  const wait = PERSIST_MS - (runClock.now() - (lastPersist.get(s) ?? -Infinity));
  if (wait <= 0) return persist(s);
  p.set(s, runClock.later(() => { p.delete(s); try { persist(s); } catch (e) { log.error('Chat konnte nicht gespeichert werden', { chatId: s.id, error: e }); } }, wait));
  exitFlush();
}

/** Write all pending batched saves now (process exit, tests). Returns the count. */
export function flushPersists(): number {
  let n = 0;
  for (const s of [...pendingPersists().keys()]) { try { persist(s); n++; } catch (e) { cancelPersist(s); log.error('Chat konnte nicht gespeichert werden', { chatId: s.id, error: e }); } }
  return n;
}

// Process exit: on SIGTERM/SIGINT Next exits via process.exit → 'exit' (synchronous, node:sqlite writes synchronously). 'beforeExit': event loop empty
// (timers are unref'd). Own signal handlers only for writing; if we are the only handler, the signal is re-raised afterwards (default behavior).
const exitFlush = () => singleton('sessions-exit-flush', () => {
  const flush = () => { const n = flushPersists(); if (n) log.info('Offene Chats vor dem Beenden gespeichert', { chats: n }); };
  process.on('exit', flush); process.on('beforeExit', flush);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    const h = () => { flush(); if (process.listenerCount(sig) === 1) { process.removeListener(sig, h); process.kill(process.pid, sig); } };
    process.on(sig, h);
  }
  return true;
});

/** Persisted chat without a session in memory: open operations from before a restart are closed in the process (see recoverChat). */
function loadChat(id: string, locale: Locale = ui().locale): StoredChat | null {
  const c = chatGet(id);
  if (c && recoverChat(c, locale)) chatPut(c); // updatedAt stays: the chat does not move up in the list
  return c;
}

const RESTART = 'Neustart, bitte erneut vorschlagen'; // reason in the audit (stable, German); the chat shows the text in the UI language
/**
 * After a restart (crash, deploy): approvals live only in memory, an interrupted apply leaves its trace in changeset_runs.
 * - Set was being applied and got interrupted: result "partial/failed" with the undo steps saved so far (undo works)
 * - Set was still waiting for approval: "rejected" with a reason (like stopChat), questions get a marker
 * Each with an audit row. Returns true if something changed (then save). A second call changes nothing.
 */
function recoverChat(c: StoredChat, locale: Locale): boolean {
  const t = messages(locale).server;
  const open = new Map(runsOpen(c.id).map(r => [r.csId, r]));
  const resolved = new Set(c.events.flatMap(e => (e.t === 'changeset_result' ? [e.csId] : [])));
  const lastDone = c.events.findLastIndex(e => e.t === 'done'); // questions before that were already resolved (stopChat/answer), only mark open ones of the last turn
  let changed = false;
  for (const [i, e] of [...c.events].entries()) {
    if (e.t === 'question' && e.answer === undefined && i > lastDone) { e.answer = t.unansweredRestart; changed = true; }
    if (e.t !== 'changeset' || resolved.has(e.cs.id)) continue;
    const cs = e.cs, run = open.get(cs.id);
    const base = { chatId: c.id, changeSet: cs.id, kind: cs.kind, title: cs.title, recoveredFrom: run?.startedAt ?? c.updatedAt }; // time of the incident, not of loading
    if (run) {
      const applied = run.results.filter(r => r.ok).length, failed = run.results.length - applied, status: ChangeStatus = applied ? 'partial' : 'failed';
      const counted = run.total != null && run.results.length >= run.total, results = run.results.length > 300 ? run.results.filter(r => !r.ok).slice(0, 100) : run.results; // bulk: keep the card small
      // Stay honest: the progress is saved in batches, nobody knows what was written after that. Without saved progress everything is open.
      const error = run.results.length ? t.restartInterrupted(applied, failed, counted) : run.undo.length ? t.restartInterruptedUndo(run.undo.length) : t.restartInterruptedUnknown;
      c.events.push({ t: 'changeset_result', csId: cs.id, status, results, ...(run.results.length ? { counts: { applied, failed } } : {}), undo: run.undo, error });
      auditLog({ ...base, decision: 'approved', status, applied, failed, undo: run.undo, interrupted: true, ...(run.results.length ? {} : { unknown: true }) });
      log.warn('Änderungsset durch Neustart unterbrochen', { chatId: c.id, changeSet: cs.id, kind: cs.kind, status, applied, failed, undo: run.undo.length });
    } else {
      e.decision = false;
      c.events.push({ t: 'changeset_result', csId: cs.id, status: 'rejected', error: t.restartRejected });
      auditLog({ ...base, decision: 'rejected', reason: RESTART });
    }
    changed = true;
  }
  for (const r of open.values()) runDelete(r.csId); // also leftovers whose result was already saved
  return changed;
}

// Crash safety while applying: progress (results + undo steps) batched into the DB, at most every RUN_FLUSH_MS
// (no write storm per item). finish() only after the result is saved: until then the run counts as interrupted.
const RUN_FLUSH_MS = 250;
type RunClock = { now(): number; later(fn: () => void, ms: number): { cancel(): void } };
const realRunClock = (): RunClock => ({
  now: () => Date.now(),
  later(fn, ms) { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; },
});
let runClock: RunClock = realRunClock();
/** Tests only: clock of the batched run backup. null restores Date.now and setTimeout. */
export function setRunClockForTests(clock: RunClock | null): void { runClock = clock ?? realRunClock(); }
function trackRun(ss: Session, cs: ChangeSet, kind: PlatformKind, total: number) {
  const run: ChangeRun = { csId: cs.id, chatId: ss.id, kind: cs.kind, title: cs.title, startedAt: new Date().toISOString(), total, results: [], undo: [] };
  runPut(run);
  let pending: ApplyPartial | null = null, latest: ApplyPartial | null = null, timer: { cancel(): void } | null = null, last = 0, done = false;
  const snap = (p: ApplyPartial): ApplyPartial => ({ results: [...p.results], undo: p.undo.map(op => ({ ...op, platform: op.platform ?? kind })) });
  const flush = () => {
    timer = null; if (done || !pending) return;
    runPut({ ...run, ...snap(pending) });
    pending = null; last = runClock.now();
  };
  return {
    tick(p: ApplyPartial) { pending = latest = p; const wait = RUN_FLUSH_MS - (runClock.now() - last); if (wait <= 0) flush(); else if (!timer) timer = runClock.later(flush, wait); },
    /** last reported progress: if the executor throws midway, the undo steps reported so far are kept */
    latest: () => (latest ? snap(latest) : null),
    finish() { done = true; if (timer) timer.cancel(); runDelete(cs.id); },
  };
}

// Platform other than Shopware: Shopware read client locked (Shopware tools are not built there anyway)
const shopwareOnly = (kind: PlatformKind): ShopReader => {
  const no = () => { throw new Error(`Dieses Werkzeug gibt es nur für Shopware (verbunden: ${getPlatform(kind).label}).`); };
  return { base: '', search: async () => no(), get: async () => no(), salesChannels: async () => no(), req: async () => no() };
};

/** AI-session scope of a stored chat: rows of the former separate code chats ran in an empty working directory ('legacy-code'). */
const scopeOf = (c: StoredChat | null): string | null => c?.agentScope ?? (c?.mode === 'code' ? 'legacy-code' : null);

export function getSession(id: string): Session {
  const all = sessions();
  const existing = all.get(id);
  if (existing) existing.lastUsed = Date.now();
  // Platform switched: rebuild an idle session (history comes from the DB), a running one keeps its platform until the end of the turn
  if (existing && (existing.platform === activeKind() || existing.running)) return existing;
  if (existing) { persist(existing); all.delete(id); }
  const saved = loadChat(id);
  const kind = activeKind();
  const parts = getPlatform(kind).openSession(id); // privileged client stays in the adapter, is NEVER given to the AI
  const ss: Session = {
    id, taskId: attachedTask(id)?.id ?? null, agentScope: scopeOf(saved), platform: kind, reader: parts.reader, lookup: parts.lookup,
    sw: parts.reader instanceof ReadOnlyShopware ? parts.reader : new ReadOnlyShopware(shopwareOnly(kind)),
    storefrontFetch: parts.storefrontFetch, themeCss: parts.themeCss, draft: saved?.draft ?? null, sdkSessionId: saved?.sdkSessionId ?? null, costTotal: saved?.costTotal ?? null, costSession: saved?.costSession ?? null, codexThreadId: saved?.codexThreadId ?? null, title: saved?.title ?? null, target: saved?.target ?? null,
    createdAt: saved?.createdAt ?? new Date().toISOString(), events: saved?.events ?? [], emit: () => {}, running: false, lastUsed: Date.now(), abort: null, locale: ui().locale, listeners: new Set(), approvals: new Map(),
    askUser: async q => {
      const approvalId = Math.random().toString(36).slice(2);
      ss.emit({ t: 'question', approvalId, question: q.question, options: q.options.map(o => o.label), optionHints: q.options.map(o => o.description ?? '') });
      const r = await new Promise<ApprovalReply>(res => ss.approvals.set(approvalId, res)); ss.approvals.delete(approvalId);
      return r.answer ?? '';
    },
    // The only path to write access: show change set → human decides → executor (privileged client) writes → audit log
    requestChange: async (cs, payload) => {
      cs.platform ??= ss.platform;
      const approvalId = Math.random().toString(36).slice(2);
      ss.emit({ t: 'changeset', approvalId, cs });
      const dec = await new Promise<ApprovalReply>(r => ss.approvals.set(approvalId, r)); ss.approvals.delete(approvalId);
      if (!dec.allow) { ss.emit({ t: 'changeset_result', csId: cs.id, status: 'rejected' }); auditLog({ chatId: ss.id, changeSet: cs.id, kind: cs.kind, title: cs.title, decision: 'rejected' }); log.info('Änderungsset abgelehnt', { chatId: ss.id, changeSet: cs.id, kind: cs.kind }); return { status: 'rejected', message: 'Der Nutzer hat das Änderungsset abgelehnt. Es wurde nichts geschrieben.' }; }
      const selected = new Set(dec.selected ?? cs.items.map(i => i.id));
      const chosen = cs.items.filter(i => selected.has(i.id) && i.entity !== 'info');
      const base = { chatId: ss.id, changeSet: cs.id, kind: cs.kind, title: cs.title, decision: 'approved' as const, items: chosen.map(i => ({ entity: i.entity, id: i.entityId, field: i.field, before: i.before, after: i.after })) };
      let res: ApplyResult, run: ReturnType<typeof trackRun> | null = null; const t0 = Date.now();
      try {
        const kind = platformOf(ss, cs); // another shop connected: error, without "started" and run row (guaranteed nothing is written)
        auditLog({ ...base, status: 'started' }); // before the first write: a crash midway leaves a trace
        run = trackRun(ss, cs, kind, chosen.length);
        res = await applyFor(ss, cs, kind, payload, selected, run.tick);
      } catch (e) { res = { ...(run?.latest() ?? { results: [], undo: [] }), error: errMsg(e) }; }
      const failed = res.results.filter(r => !r.ok), applied = res.counts?.applied ?? res.results.filter(r => r.ok).length, failedN = res.counts?.failed ?? failed.length;
      const status: ChangeStatus = res.error ? 'failed' : failedN ? (applied ? 'partial' : 'failed') : 'applied';
      ss.emit({ t: 'changeset_result', csId: cs.id, status, results: res.results, ...(res.counts ? { counts: res.counts } : {}), undo: res.undo, error: res.error, published: res.published });
      auditLog({ ...base, status, applied, failed: failedN, undo: res.undo });
      persist(ss);
      log[status === 'applied' ? 'info' : 'warn'](status === 'applied' ? 'Änderungsset angewendet' : 'Änderungsset nicht vollständig angewendet', { chatId: ss.id, changeSet: cs.id, kind: cs.kind, platform: cs.platform, status, applied, failed: failedN, ms: Date.now() - t0, ...(res.error ? { error: res.error } : {}) });
      run?.finish();
      void notifyApplied(cs, res, { ro: ss.sw, lookup: ss.lookup, platform: ss.platform, chatId: ss.id }); // runs in the background (e.g. Search Console baseline values)
      return { status, applied, failed: failed.map(f => ({ item: f.itemId, error: f.error })), ...(res.counts ? { failedTotal: failedN } : {}), error: res.error, ...(res.published ?? {}), message: status === 'applied' ? 'Vom Nutzer freigegeben und angewendet.' : 'Teilweise/nicht angewendet: siehe failed.' };
    },
  };
  if (existing) for (const l of existing.listeners) ss.listeners.add(l); // connected UIs stay connected
  all.set(id, ss);
  sweeper();
  return ss;
}

// Running writes (apply/undo via the privileged client): while one is running, the shop connection must not be switched (api/settings)
const writes = () => singleton('sessions-writes', () => ({ n: 0 }));
export const writesInProgress = () => writes().n;
async function writing<T>(fn: () => Promise<T>): Promise<T> { writes().n++; try { return await fn(); } finally { writes().n--; } }

// Write via the adapter of the set's platform; each undo step carries the platform (undo runs via the same adapter)
function platformOf(ss: Session, cs: ChangeSet): PlatformKind {
  const kind = cs.platform ?? ss.platform;
  if (kind !== activeKind()) throw new Error(messages(ss.locale).server.wrongPlatform(getPlatform(kind).label, getPlatform(activeKind()).label));
  return kind;
}
async function applyFor(ss: Session, cs: ChangeSet, kind: PlatformKind, payload: unknown, selected: Set<string>, tick: (p: ApplyPartial) => void): Promise<ApplyResult> {
  const res = await writing(() => getPlatform(kind).apply(cs, payload, selected, { progress: (done, total, partial) => { ss.emit({ t: 'changeset_progress', csId: cs.id, done, total }); if (partial) tick(partial); } }));
  return { ...res, undo: res.undo.map(op => ({ ...op, platform: op.platform ?? kind })) };
}

// ---- Answers from the UI (resolve the waiting promises) ----
// Open questions/approvals exist only in memory: don't create a session for unknown chats (peekSession instead of getSession)
export function answerQuestion(chatId: string, approvalId: string, answer: string): boolean {
  const ss = peekSession(chatId); if (!ss) return false;
  const ev = ss.events.find(e => e.t === 'question' && e.approvalId === approvalId); if (ev && ev.t === 'question') { ev.answer = answer; persist(ss); }
  const p = ss.approvals.get(approvalId); if (!p) return false;
  p({ answer }); return true;
}

export function decideChange(chatId: string, approvalId: string, allow: boolean, selected?: string[]): boolean {
  const ss = peekSession(chatId); if (!ss) return false;
  const ev = ss.events.find(e => (e.t === 'changeset' || evType(e) === 'approval') && (e as { approvalId?: string }).approvalId === approvalId);
  if (ev) { (ev as { decision?: boolean }).decision = allow; persist(ss); }
  const p = ss.approvals.get(approvalId);
  if (!p) return false;
  p({ allow, selected }); return true;
}

// Undo: user-initiated (click) → restores the saved before values.
// The outcome of each step is remembered (undoResults); a second click only retries the failed steps
// (otherwise e.g. a "create" would fail on the duplicate record).
export async function undoChangeSet(chatId: string, csId: string) {
  const ss = getSession(chatId);
  const r = [...ss.events].reverse().find(e => e.t === 'changeset_result' && e.csId === csId);
  if (!r || r.t !== 'changeset_result' || !r.undo?.length || r.undone) return null;
  const prev = r.undoResults ?? [], todo = r.undo.flatMap((_, i) => (prev[i]?.ok ? [] : [i]));
  const ops = todo.map(i => r.undo![i]), out = await writing(() => undoWithPlatform(ops));
  const merged = r.undo.map((_, i) => prev[i] ?? { ok: false });
  out.forEach((o, k) => { merged[todo[todo.length - 1 - k]] = o; }); // adapters work in reverse (last step first) and report in that order
  const done = merged.filter(x => x.ok).length, total = r.undo.length;
  r.undoResults = merged; r.undone = done === total; persist(ss);
  auditLog({ chatId, changeSet: csId, decision: 'undo', results: out, done, total, ...(prev.length ? { retry: true } : {}) });
  log[r.undone ? 'info' : 'warn']('Änderungsset rückgängig gemacht', { chatId, changeSet: csId, done, total, ...(prev.length ? { retry: true } : {}) });
  return { ok: r.undone, results: out, undoResults: merged, done, total, error: out.find(x => !x.ok)?.error };
}
