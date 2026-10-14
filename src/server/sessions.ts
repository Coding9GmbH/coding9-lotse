import 'server-only';
// Chat-Sessions: Verlauf (SQLite), Freigabe-Workflow (Rückfragen + Änderungssets) und der Lese-Client der KI (über den Plattform-Adapter).
import type { ChangeSet, ChangeStatus, ChatDetail, ChatEvent, ChatStatus, ChatSummary, Target } from '@/lib/protocol';
import type { PlatformKind } from '@/lib/platforms';
import { auditLog, notifyApplied, type ApplyPartial, type ApplyResult } from './changes';
import type { PageSpec, PreviewCtx } from './cms';
import { chatGet, chatList, chatPut, runDelete, runPut, runsOpen, type ChangeRun, type StoredChat } from './db';
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
  /** Shop-Plattform dieser Session (beim Anlegen aus den Einstellungen) */
  platform: PlatformKind;
  /** geschützter Lese-Client der Plattform (Shopware: dasselbe Objekt wie sw); Adapter-Werkzeuge casten auf ihren Typ */
  reader: unknown;
  /** plattform-neutrale Lesefunktionen für Kern-Funktionen (Wissensbasis, Search Console, view_image) */
  lookup: ShopLookup;
  /** Shopware-Lese-Client (nur Shopware-Werkzeuge; auf anderen Plattformen gesperrt) */
  sw: ReadOnlyShopware;                 // KI: nur lesen, nur freigegebene Bereiche
  storefrontFetch: Fetcher;
  themeCss: () => Promise<string | null>;
  draft: PageSpec | null;
  sdkSessionId: string | null;
  /** Codex-Thread (ChatGPT-Abo) – getrennt von der Claude-Sitzung, falls der Anbieter gewechselt wird */
  codexThreadId: string | null;
  title: string | null;
  target: Target | null;
  createdAt: string;
  events: ChatEvent[];
  emit: (ev: ChatEvent) => void;
  /** Läuft gerade eine KI-Runde? Sie läuft unabhängig von der Verbindung weiter (Chat-Wechsel, Neuladen). */
  running: boolean;
  /** letzter Zugriff (ruhende Sessions ohne Zuhörer werden nach einer Weile freigegeben) */
  lastUsed: number;
  abort: AbortController | null;
  /** Antwortsprache der KI (Sprache der Oberfläche bei der letzten Nachricht) */
  locale: Locale;
  /** Verbundene Oberflächen, die Live-Ereignisse empfangen */
  listeners: Set<(ev: ChatEvent) => void>;
  approvals: Map<string, (r: ApprovalReply) => void>;
  askUser: (q: Question) => Promise<string>;
  requestChange: (cs: ChangeSet, payload?: unknown) => Promise<ChangeOutcome>;
  renderDraft?: (spec: PageSpec, partial?: boolean) => Promise<string>;
  lastCtx?: PreviewCtx;
  /** Chat wurde gelöscht, während eine Runde lief: nichts mehr speichern (sonst legt die Runde ihn wieder an) */
  deleted?: boolean;
}

const sessions = () => singleton('sessions', () => new Map<string, Session>()); // chatId -> Session
export const dropSession = (id: string) => { const s = peekSession(id); if (s) { s.deleted = true; cancelPersist(s); } stopChat(id); sessions().delete(id); };

// Sprache der Oberfläche bei der letzten Chat-Nachricht: für Texte, die ohne Anfrage-Sprache entstehen (neue Session, Neustart-Aufräumen)
const ui = () => singleton('sessions-ui-locale', () => ({ locale: DEFAULT_LOCALE as Locale }));
export const noteUiLocale = (l: Locale) => { ui().locale = l; };

// Ruhende Sessions ohne Zuhörer nach 30 Minuten freigeben: der Verlauf liegt in der DB, getSession baut sie bei Bedarf neu auf.
// Laufende Runden und verbundene Oberflächen bleiben unberührt.
const IDLE_MS = 30 * 60_000;
export function sweepIdleSessions(now = Date.now()): number {
  let n = 0;
  for (const [id, s] of sessions()) if (!s.running && !s.listeners.size && now - s.lastUsed > IDLE_MS) { persist(s); sessions().delete(id); n++; }
  return n;
}
const sweeper = () => singleton('sessions-sweeper', () => { const t = setInterval(sweepIdleSessions, 5 * 60_000); t.unref?.(); return t; });
/** Session nur, wenn sie schon im Speicher ist (legt keine neue an). */
export const peekSession = (id: string) => sessions().get(id) ?? null;

export const chatStatus = (s: Session | null): ChatStatus | undefined => (!s?.running ? undefined : s.approvals.size ? 'waiting' : 'running');

/** Verlauf mit Live-Status aus dem Speicher (läuft / wartet auf den Menschen). */
export const chatListLive = (): ChatSummary[] => chatList().map(c => {
  const status = chatStatus(peekSession(c.id));
  return status ? { ...c, status } : c;
});

/** Aktueller Stand eines Chats: aus dem Speicher (auch während er läuft) oder gespeichert. `locale`: Sprache für Neustart-Hinweise (sonst die zuletzt genutzte). */
export function chatSnapshot(id: string, locale?: Locale): ChatDetail | null {
  const s = peekSession(id);
  if (s && (s.running || s.events.length)) return { id, title: s.title ?? '', target: s.target, events: s.events };
  const c = loadChat(id, locale);
  return c ? { id: c.id, title: c.title ?? '', target: c.target, events: c.events } : null;
}

/** Bricht eine laufende Runde ab; offene Rückfragen/Freigaben gelten als abgelehnt. */
export function stopChat(id: string): boolean {
  const s = peekSession(id);
  if (!s?.running) return false;
  for (const [approvalId, resolve] of s.approvals) {
    const q = s.events.find(e => e.t === 'question' && e.approvalId === approvalId);
    if (q?.t === 'question' && q.answer === undefined) q.answer = messages(s.locale).server.cancelled; // sonst gilt sie beim nächsten Laden als „Nicht beantwortet (Neustart)“
    resolve({ allow: false, answer: '' });
  }
  s.approvals.clear(); persist(s);
  log.info('Runde abgebrochen', { chatId: id });
  s.abort?.abort();
  return true;
}

const evType = (e: ChatEvent) => (e as { t: string }).t;

// ---- Persistente Chats (SQLite) ----
// Gespeichert wird der ganze Chat als eine JSON-Zeile. Zwei Wege:
// - persist: sofort (Rückfragen, Änderungssets und ihre Ergebnisse, Entscheidungen, Rundenende, Abbruch, Fehler). Nimmt einen offenen gebündelten mit.
// - persistSoon: gebündelt, höchstens alle PERSIST_MS je Chat (Streaming: Text, Werkzeugaufrufe). Vor dem Prozessende schreibt flushPersists alles Offene.
// Freigaben/Änderungssets laufen nie über persistSoon: ein Absturz verliert höchstens die letzten PERSIST_MS Text, nie eine Freigabe.
const PERSIST_MS = 500;
const pendingPersists = () => singleton('sessions-persist-pending', () => new Map<Session, { cancel(): void }>());
const lastPersist = new WeakMap<Session, number>();
const cancelPersist = (s: Session) => { const p = pendingPersists(), t = p.get(s); if (t) { t.cancel(); p.delete(s); } };

/** Sofort speichern (wichtige Zustände). */
export function persist(s: Session) {
  cancelPersist(s); lastPersist.set(s, runClock.now());
  if (s.deleted || !s.events.length) return;
  let lastDraft = -1; s.events.forEach((e, i) => { if (e.t === 'draft') lastDraft = i; });
  const events = s.events.map((e, i) => (e.t === 'draft' && i !== lastDraft ? { ...e, html: undefined } : e)); // nur letzte Vorschau behalten
  const c: StoredChat = { id: s.id, title: s.title, target: s.target, createdAt: s.createdAt, updatedAt: new Date().toISOString(), sdkSessionId: s.sdkSessionId, codexThreadId: s.codexThreadId, draft: s.draft, events };
  chatPut(c);
}

/** Gebündelt speichern: höchstens einmal je PERSIST_MS (das erste Mal nach einer Pause sofort, danach am Ende des Fensters). */
export function persistSoon(s: Session) {
  const p = pendingPersists(); if (p.has(s) || s.deleted) return;
  const wait = PERSIST_MS - (runClock.now() - (lastPersist.get(s) ?? -Infinity));
  if (wait <= 0) return persist(s);
  p.set(s, runClock.later(() => { p.delete(s); try { persist(s); } catch (e) { log.error('Chat konnte nicht gespeichert werden', { chatId: s.id, error: e }); } }, wait));
  exitFlush();
}

/** Alle offenen gebündelten Speicherungen jetzt schreiben (Prozessende, Tests). Liefert die Anzahl. */
export function flushPersists(): number {
  let n = 0;
  for (const s of [...pendingPersists().keys()]) { try { persist(s); n++; } catch (e) { cancelPersist(s); log.error('Chat konnte nicht gespeichert werden', { chatId: s.id, error: e }); } }
  return n;
}

// Prozessende: Next beendet bei SIGTERM/SIGINT über process.exit → 'exit' (synchron, node:sqlite schreibt synchron). 'beforeExit': Ereignisschleife leer
// (Timer sind unref). Eigene Signal-Handler nur zum Schreiben; sind wir der einzige Handler, wird das Signal danach erneut ausgelöst (Standardverhalten).
const exitFlush = () => singleton('sessions-exit-flush', () => {
  const flush = () => { const n = flushPersists(); if (n) log.info('Offene Chats vor dem Beenden gespeichert', { chats: n }); };
  process.on('exit', flush); process.on('beforeExit', flush);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    const h = () => { flush(); if (process.listenerCount(sig) === 1) { process.removeListener(sig, h); process.kill(process.pid, sig); } };
    process.on(sig, h);
  }
  return true;
});

/** Gespeicherter Chat ohne Session im Speicher: offene Vorgänge aus der Zeit vor einem Neustart werden dabei abgeschlossen (siehe recoverChat). */
function loadChat(id: string, locale: Locale = ui().locale): StoredChat | null {
  const c = chatGet(id);
  if (c && recoverChat(c, locale)) chatPut(c); // updatedAt bleibt: der Chat rückt in der Liste nicht nach oben
  return c;
}

const RESTART = 'Neustart, bitte erneut vorschlagen'; // Grund im Audit (stabil, deutsch); im Chat steht der Text in der Sprache der Oberfläche
/**
 * Nach einem Neustart (Absturz, Deploy): Freigaben leben nur im Speicher, ein unterbrochenes Anwenden hat seine Spur in changeset_runs.
 * - Set wurde angewendet und unterbrochen: Ergebnis „partial/failed“ mit den bis dahin gesicherten Rückgängig-Schritten (Rückgängig funktioniert)
 * - Set wartete noch auf die Freigabe: „rejected“ mit Grund (wie stopChat), Rückfragen bekommen eine Markierung
 * Jeweils mit Audit-Zeile. Liefert true, wenn sich etwas geändert hat (dann speichern). Zweiter Aufruf ändert nichts mehr.
 */
function recoverChat(c: StoredChat, locale: Locale): boolean {
  const t = messages(locale).server;
  const open = new Map(runsOpen(c.id).map(r => [r.csId, r]));
  const resolved = new Set(c.events.flatMap(e => (e.t === 'changeset_result' ? [e.csId] : [])));
  const lastDone = c.events.findLastIndex(e => e.t === 'done'); // Rückfragen davor wurden schon aufgelöst (stopChat/Antwort), nur offene der letzten Runde markieren
  let changed = false;
  for (const [i, e] of [...c.events].entries()) {
    if (e.t === 'question' && e.answer === undefined && i > lastDone) { e.answer = t.unansweredRestart; changed = true; }
    if (e.t !== 'changeset' || resolved.has(e.cs.id)) continue;
    const cs = e.cs, run = open.get(cs.id);
    const base = { chatId: c.id, changeSet: cs.id, kind: cs.kind, title: cs.title, recoveredFrom: run?.startedAt ?? c.updatedAt }; // Zeitpunkt des Vorfalls, nicht des Ladens
    if (run) {
      const applied = run.results.filter(r => r.ok).length, failed = run.results.length - applied, status: ChangeStatus = applied ? 'partial' : 'failed';
      const counted = run.total != null && run.results.length >= run.total, results = run.results.length > 300 ? run.results.filter(r => !r.ok).slice(0, 100) : run.results; // Stapel: Karte klein halten
      // Ehrlich bleiben: der Zwischenstand wird gebündelt gesichert, was danach noch geschrieben wurde, weiß niemand. Ohne Zwischenstand ist alles offen.
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
  for (const r of open.values()) runDelete(r.csId); // auch Reste, deren Ergebnis schon gespeichert war
  return changed;
}

// Absturzsicherheit beim Anwenden: Zwischenstand (Ergebnisse + Rückgängig-Schritte) gebündelt in die DB, höchstens alle RUN_FLUSH_MS
// (kein Schreibsturm je Element). finish() erst nach dem Speichern des Ergebnisses: bis dahin gilt der Lauf als unterbrochen.
const RUN_FLUSH_MS = 250;
type RunClock = { now(): number; later(fn: () => void, ms: number): { cancel(): void } };
const realRunClock = (): RunClock => ({
  now: () => Date.now(),
  later(fn, ms) { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; },
});
let runClock: RunClock = realRunClock();
/** Nur Tests: Uhr der gebündelten Lauf-Sicherung. null stellt Date.now und setTimeout wieder her. */
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
    /** letzter gemeldeter Zwischenstand: wirft der Executor mittendrin, bleiben die bis dahin gemeldeten Rückgängig-Schritte erhalten */
    latest: () => (latest ? snap(latest) : null),
    finish() { done = true; if (timer) timer.cancel(); runDelete(cs.id); },
  };
}

// Andere Plattform als Shopware: Shopware-Lese-Client gesperrt (Shopware-Werkzeuge werden dort ohnehin nicht gebaut)
const shopwareOnly = (kind: PlatformKind): ShopReader => {
  const no = () => { throw new Error(`Dieses Werkzeug gibt es nur für Shopware (verbunden: ${getPlatform(kind).label}).`); };
  return { base: '', search: async () => no(), get: async () => no(), salesChannels: async () => no(), req: async () => no() };
};

export function getSession(id: string): Session {
  const all = sessions();
  const existing = all.get(id);
  if (existing) existing.lastUsed = Date.now();
  // Plattform gewechselt: ruhende Session neu aufbauen (Verlauf kommt aus der DB), laufende behält ihre Plattform bis zum Ende der Runde
  if (existing && (existing.platform === activeKind() || existing.running)) return existing;
  if (existing) { persist(existing); all.delete(id); }
  const kind = activeKind(), platform = getPlatform(kind);
  const parts = platform.openSession(id); // privilegierter Client bleibt im Adapter, wird NIE an die KI gegeben
  const saved = loadChat(id);
  const ss: Session = {
    id, platform: kind, reader: parts.reader, lookup: parts.lookup,
    sw: parts.reader instanceof ReadOnlyShopware ? parts.reader : new ReadOnlyShopware(shopwareOnly(kind)),
    storefrontFetch: parts.storefrontFetch, themeCss: parts.themeCss, draft: saved?.draft ?? null, sdkSessionId: saved?.sdkSessionId ?? null, codexThreadId: saved?.codexThreadId ?? null, title: saved?.title ?? null, target: saved?.target ?? null,
    createdAt: saved?.createdAt ?? new Date().toISOString(), events: saved?.events ?? [], emit: () => {}, running: false, lastUsed: Date.now(), abort: null, locale: ui().locale, listeners: new Set(), approvals: new Map(),
    askUser: async q => {
      const approvalId = Math.random().toString(36).slice(2);
      ss.emit({ t: 'question', approvalId, question: q.question, options: q.options.map(o => o.label), optionHints: q.options.map(o => o.description ?? '') });
      const r = await new Promise<ApprovalReply>(res => ss.approvals.set(approvalId, res)); ss.approvals.delete(approvalId);
      return r.answer ?? '';
    },
    // Einziger Weg zu Schreibzugriffen: Änderungsset zeigen → Mensch entscheidet → Executor (privilegierter Client) schreibt → Audit-Log
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
        const kind = platformOf(ss, cs); // anderer Shop verbunden: Fehler, ohne „started“ und Lauf-Zeile (es wird garantiert nichts geschrieben)
        auditLog({ ...base, status: 'started' }); // vor dem ersten Schreibzugriff: ein Absturz mittendrin hinterlässt eine Spur
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
      void notifyApplied(cs, res, { ro: ss.sw, lookup: ss.lookup, platform: ss.platform, chatId: ss.id }); // läuft im Hintergrund (z. B. Search-Console-Ausgangswerte)
      return { status, applied, failed: failed.map(f => ({ item: f.itemId, error: f.error })), ...(res.counts ? { failedTotal: failedN } : {}), error: res.error, ...(res.published ?? {}), message: status === 'applied' ? 'Vom Nutzer freigegeben und angewendet.' : 'Teilweise/nicht angewendet: siehe failed.' };
    },
  };
  if (existing) for (const l of existing.listeners) ss.listeners.add(l); // verbundene Oberflächen bleiben verbunden
  all.set(id, ss);
  sweeper();
  return ss;
}

// Laufende Schreibzugriffe (Anwenden/Rückgängig über den privilegierten Client): solange einer läuft, darf die Shop-Verbindung nicht gewechselt werden (api/settings)
const writes = () => singleton('sessions-writes', () => ({ n: 0 }));
export const writesInProgress = () => writes().n;
async function writing<T>(fn: () => Promise<T>): Promise<T> { writes().n++; try { return await fn(); } finally { writes().n--; } }

// Schreiben über den Adapter der Plattform des Sets; jeder Rückgängig-Schritt bekommt die Plattform mit (Rückgängig läuft über denselben Adapter)
function platformOf(ss: Session, cs: ChangeSet): PlatformKind {
  const kind = cs.platform ?? ss.platform;
  if (kind !== activeKind()) throw new Error(messages(ss.locale).server.wrongPlatform(getPlatform(kind).label, getPlatform(activeKind()).label));
  return kind;
}
async function applyFor(ss: Session, cs: ChangeSet, kind: PlatformKind, payload: unknown, selected: Set<string>, tick: (p: ApplyPartial) => void): Promise<ApplyResult> {
  const res = await writing(() => getPlatform(kind).apply(cs, payload, selected, { progress: (done, total, partial) => { ss.emit({ t: 'changeset_progress', csId: cs.id, done, total }); if (partial) tick(partial); } }));
  return { ...res, undo: res.undo.map(op => ({ ...op, platform: op.platform ?? kind })) };
}

// ---- Antworten aus der Oberfläche (lösen die wartenden Promises auf) ----
// Offene Rückfragen/Freigaben gibt es nur im Speicher: für unbekannte Chats keine Session anlegen (peekSession statt getSession)
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

// Rückgängig: nutzerinitiiert (Klick) → stellt die gespeicherten Vorher-Werte wieder her.
// Je Schritt wird der Ausgang gemerkt (undoResults); ein zweiter Klick wiederholt nur die fehlgeschlagenen Schritte
// (sonst scheitert z. B. ein „create“ am doppelten Datensatz).
export async function undoChangeSet(chatId: string, csId: string) {
  const ss = getSession(chatId);
  const r = [...ss.events].reverse().find(e => e.t === 'changeset_result' && e.csId === csId);
  if (!r || r.t !== 'changeset_result' || !r.undo?.length || r.undone) return null;
  const prev = r.undoResults ?? [], todo = r.undo.flatMap((_, i) => (prev[i]?.ok ? [] : [i]));
  const ops = todo.map(i => r.undo![i]), out = await writing(() => undoWithPlatform(ops));
  const merged = r.undo.map((_, i) => prev[i] ?? { ok: false });
  out.forEach((o, k) => { merged[todo[todo.length - 1 - k]] = o; }); // Adapter arbeiten rückwärts (letzter Schritt zuerst) und melden in dieser Reihenfolge
  const done = merged.filter(x => x.ok).length, total = r.undo.length;
  r.undoResults = merged; r.undone = done === total; persist(ss);
  auditLog({ chatId, changeSet: csId, decision: 'undo', results: out, done, total, ...(prev.length ? { retry: true } : {}) });
  log[r.undone ? 'info' : 'warn']('Änderungsset rückgängig gemacht', { chatId, changeSet: csId, done, total, ...(prev.length ? { retry: true } : {}) });
  return { ok: r.undone, results: out, undoResults: merged, done, total, error: out.find(x => !x.ok)?.error };
}
