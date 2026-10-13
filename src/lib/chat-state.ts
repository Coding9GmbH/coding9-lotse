// Zustand des Chats als reine Funktion über die Ereignisliste.
// Derselbe Reducer verarbeitet live gestreamte Ereignisse UND das Wiederabspielen eines gespeicherten Chats –
// so sieht ein geöffneter Chat exakt so aus wie während des Live-Laufs (nur ohne aktive Knöpfe).

import { parseAttachments, type Attachment, type FileAttachment } from './attachments';
import { toolLabel } from './labels';
import type { ChangeSet, ChatDetail, ChatEvent, DraftAudit, PublishedInfo, Styleguide, Target, UndoOutcome } from './protocol';
import { asList, shopProxyPath } from './urls';

export type StepState = 'run' | 'done' | 'bad';
/** stale: beim Nachladen als abgeschlossen angenommen; läuft die Runde doch noch, wird er mit „resume“ wieder offen */
export interface Step { id: string; name: string; input: unknown; state: StepState; preview?: string; stale?: boolean }
export interface QuestionOption { label: string; description?: string }
export type ChangesetResultEvent = Extract<ChatEvent, { t: 'changeset_result' }>;
export type UndoPhase = 'idle' | 'running' | 'done' | 'failed';

export type LogItem =
  | { kind: 'user'; key: string; text: string; attachments: Attachment[]; files?: FileAttachment[] }
  | { kind: 'ai'; key: string; text: string }
  | { kind: 'error'; key: string; text: string }
  | { kind: 'steps'; key: string; steps: Step[] }
  | { kind: 'image'; key: string; url: string; alt: string; fileName: string }
  | { kind: 'question'; key: string; approvalId: string; question: string; options: QuestionOption[]; answer?: string; interactive: boolean }
  | {
    kind: 'changeset'; key: string; approvalId: string; cs: ChangeSet; interactive: boolean; decision?: boolean;
    sent?: { allow: boolean; selected?: string[] }; result?: ChangesetResultEvent; undo: UndoPhase;
    /** Fortschritt beim Anwenden großer Sets (nur live) */
    progress?: { done: number; total: number };
  }
  | { kind: 'published'; key: string; info: PublishedInfo; target: Target | null }
  | { kind: 'styleguide'; key: string; sg: Styleguide };

export type LogItemKind = LogItem['kind'];

export interface DraftView { html: string; name: string; pageType: string; partial: boolean; spec: unknown; audit: DraftAudit | null; rev: number }
export type PreviewTab = 'live' | 'prev' | 'spec';

export interface ChatState {
  items: LogItem[];
  seq: number;
  /** Antwort-Blase, in die weitere Text-Stücke laufen. */
  curText: string | null;
  /** Schritt-Box, in die weitere Werkzeug-Aufrufe laufen. */
  stepBox: string | null;
  target: Target | null;
  draft: DraftView | null;
  liveOverride: string | null;
  liveBust: number;
  tab: PreviewTab;
  /** Aktueller Styleguide des Shops (nur durch Live-Ereignisse oder Laden/Speichern geändert). */
  styleguide: Styleguide | null;
  /** Layout-Namen, die in dieser Sitzung veröffentlicht wurden (Kategorie-ID → Layout). */
  cmsOverrides: Record<string, string>;
  busy: boolean;
  status: string | null;
}

export type Mode = 'live' | 'replay';

export type ChatAction =
  | { type: 'event'; event: ChatEvent; mode?: Mode }
  | { type: 'replay'; chat: Pick<ChatDetail, 'target' | 'events'> }
  | { type: 'reset' }
  | { type: 'run_start'; text: string }
  | { type: 'run_end' }
  /** Der Server hat die Nachricht nicht angenommen (409: dort läuft schon eine Runde): Blase wieder entfernen */
  | { type: 'unsend' }
  /** Wieder verbunden mit einer Runde, die noch läuft (Status aus dem letzten Ereignis) */
  | { type: 'resume'; last?: ChatEvent }
  | { type: 'error'; text: string }
  | { type: 'status'; text: string | null }
  | { type: 'answer'; approvalId: string; answer: string }
  | { type: 'decide'; approvalId: string; allow: boolean; selected?: string[] }
  /** undoResults: Ausgang je Rückgängig-Schritt vom Server (teilweise zurückgesetzt: Karte zeigt „x von y“, Button bleibt nutzbar) */
  | { type: 'undo'; csId: string; phase: UndoPhase; undoResults?: UndoOutcome[] }
  | { type: 'select_target'; target: Target | null }
  | { type: 'set_tab'; tab: PreviewTab }
  | { type: 'set_styleguide'; sg: Styleguide | null };

export const initialChatState: ChatState = {
  items: [], seq: 0, curText: null, stepBox: null, target: null, draft: null, liveOverride: null, liveBust: 0,
  tab: 'live', styleguide: null, cmsOverrides: {}, busy: false, status: null,
};

const THINKING = 'Lotse denkt nach …';

function liveStatus(ev: ChatEvent): string | null {
  switch (ev.t) {
    case 'text_start': return 'Schreibt Antwort …';
    case 'draft_partial': return 'Baut die Seite auf …';
    case 'question': return 'Wartet auf deine Antwort';
    case 'changeset': return 'Wartet auf deine Freigabe';
    case 'tool': return `${toolLabel(ev.name)} …`;
    case 'changeset_progress': return `Wendet an: ${ev.done.toLocaleString('de-DE')} / ${ev.total.toLocaleString('de-DE')}`;
    case 'changeset_result': case 'tool_result': case 'image': return THINKING;
    default: return null;
  }
}

/** Optionen einer Rückfrage: string[] (+ optionHints); ältere Chats enthalten { label, description }. */
export function normalizeOptions(options: unknown, hints?: unknown): QuestionOption[] {
  if (!Array.isArray(options)) return [];
  const hint = (i: number) => (Array.isArray(hints) && typeof hints[i] === 'string' && hints[i] ? (hints[i] as string) : undefined);
  return options.flatMap((o, i): QuestionOption[] => {
    if (typeof o === 'string') return [{ label: o, description: hint(i) }];
    if (o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string') {
      const { label, description } = o as { label: string; description?: unknown };
      return [{ label, description: typeof description === 'string' ? description : undefined }];
    }
    return [];
  });
}

type NewItem = LogItem extends infer I ? (I extends LogItem ? Omit<I, 'key'> : never) : never;

function push(s: ChatState, item: NewItem): [ChatState, string] {
  const key = `i${s.seq + 1}`;
  const items = [...s.items, { ...item, key } as LogItem];
  // Ein neuer Eintrag beendet laufende Antwort-Blasen/Schritt-Boxen (außer er IST eine davon).
  return [{ ...s, items, seq: s.seq + 1, curText: item.kind === 'ai' ? key : null, stepBox: item.kind === 'steps' ? key : null }, key];
}

function update<K extends LogItemKind>(s: ChatState, kind: K, match: (i: Extract<LogItem, { kind: K }>) => boolean, fn: (i: Extract<LogItem, { kind: K }>) => Extract<LogItem, { kind: K }>): ChatState {
  let hit = false;
  const items = s.items.map(i => {
    if (hit || i.kind !== kind || !match(i as Extract<LogItem, { kind: K }>)) return i;
    hit = true;
    return fn(i as Extract<LogItem, { kind: K }>);
  });
  return hit ? { ...s, items } : s;
}

/** Schritte ohne Ergebnis abschließen (Runde zu Ende, abgebrochen oder Ergebnis nie angekommen), sonst blinken sie ewig auf „läuft“ */
function settleSteps(s: ChatState, state: 'done' | 'bad', stale = false): ChatState {
  if (!s.items.some(i => i.kind === 'steps' && i.steps.some(x => x.state === 'run'))) return s;
  return { ...s, items: s.items.map(i => (i.kind === 'steps' && i.steps.some(x => x.state === 'run')
    ? { ...i, steps: i.steps.map(x => (x.state === 'run' ? { ...x, state, ...(stale ? { stale: true } : {}) } : x)) } : i)) };
}

function applyPublished(s: ChatState, info: PublishedInfo, live: boolean): ChatState {
  let [next] = push(s, { kind: 'published', info, target: s.target });
  const t = next.target;
  if (t?.kind === 'landing') next = { ...next, liveOverride: shopProxyPath(asList(info.storefront)[0]) ?? next.liveOverride };
  next = { ...next, liveBust: next.liveBust + 1, tab: live ? 'live' : next.tab };
  if (live && t && t.kind !== 'landing' && t.id) {
    const name = typeof info.name === 'string' && info.name ? info.name : 'AI-Layout';
    next = { ...next, target: { ...t, cmsPage: name }, cmsOverrides: { ...next.cmsOverrides, [t.id]: name } };
  }
  return next;
}

function applyEvent(state: ChatState, ev: ChatEvent, mode: Mode): ChatState {
  const live = mode === 'live';
  let s = state;
  if (live && s.busy) { const st = liveStatus(ev); if (st) s = { ...s, status: st }; }

  switch (ev.t) {
    case 'start': return s;
    case 'user': {
      const { text, attachments, files } = parseAttachments(ev.text);
      return push(s, { kind: 'user', text, attachments, ...(files.length ? { files } : {}) })[0];
    }
    case 'text_start': return push(s, { kind: 'ai', text: '' })[0];
    case 'text': {
      const cur = s.curText;
      if (cur && s.items.some(i => i.key === cur)) return update(s, 'ai', i => i.key === cur, i => ({ ...i, text: i.text + ev.text }));
      return push(s, { kind: 'ai', text: ev.text })[0];
    }
    case 'tool': {
      const step: Step = { id: ev.id, name: ev.name, input: ev.input, state: 'run' };
      const box = s.stepBox;
      if (box && s.items.some(i => i.key === box)) return { ...update(s, 'steps', i => i.key === box, i => ({ ...i, steps: [...i.steps, step] })), curText: null };
      return push(s, { kind: 'steps', steps: [step] })[0];
    }
    case 'tool_result':
      return update(s, 'steps', i => i.steps.some(x => x.id === ev.id), i => ({
        ...i, steps: i.steps.map(x => (x.id === ev.id ? { ...x, state: ev.error ? 'bad' : 'done', preview: ev.preview } : x)),
      }));
    case 'image': {
      const fileName = typeof ev.fileName === 'string' ? ev.fileName : ev.name ?? '';
      return push(s, { kind: 'image', url: ev.url, alt: ev.alt ?? '', fileName })[0];
    }
    case 'draft_partial': {
      const prev = s.draft;
      return {
        ...s, tab: live ? 'prev' : s.tab,
        draft: { html: ev.html, name: ev.name ?? prev?.name ?? 'Entwurf', pageType: ev.pageType ?? prev?.pageType ?? '', partial: true, spec: prev?.spec ?? null, audit: prev?.audit ?? null, rev: (prev?.rev ?? 0) + 1 },
      };
    }
    case 'draft': {
      if (!ev.html) return s;
      const prev = s.draft;
      return {
        ...s, tab: live ? 'prev' : s.tab,
        draft: { html: ev.html, name: ev.name, pageType: ev.pageType, partial: false, spec: ev.spec ?? prev?.spec ?? null, audit: ev.audit ?? prev?.audit ?? null, rev: (prev?.rev ?? 0) + 1 },
      };
    }
    case 'question':
      return push(s, {
        kind: 'question', approvalId: ev.approvalId, question: ev.question, options: normalizeOptions(ev.options, ev.optionHints),
        answer: ev.answer, interactive: live && ev.answer === undefined,
      })[0];
    case 'changeset':
      return push(s, { kind: 'changeset', approvalId: ev.approvalId, cs: ev.cs, decision: ev.decision, interactive: live && ev.decision === undefined, undo: 'idle' })[0];
    case 'changeset_progress':
      return update(s, 'changeset', i => i.cs.id === ev.csId && !i.result, i => ({ ...i, progress: { done: ev.done, total: ev.total } }));
    case 'changeset_result': {
      const next = update(s, 'changeset', i => i.cs.id === ev.csId, i => ({ ...i, result: ev, interactive: false, undo: ev.undone ? 'done' : i.undo }));
      if (next === s) return s; // unbekanntes Set (wie bisher: ignorieren)
      return ev.published ? applyPublished(next, ev.published, live) : next;
    }
    case 'focus':
      if (s.target?.id === ev.id) return s;
      return { ...s, target: { kind: ev.kind, id: ev.id, name: ev.name, path: ev.path ?? null, cmsPage: ev.cmsPage }, liveOverride: null };
    case 'styleguide': {
      const [next] = push(s, { kind: 'styleguide', sg: ev.sg });
      return live ? { ...next, styleguide: ev.sg } : next;
    }
    case 'done': {
      const settled = settleSteps(s, ev.error ? 'bad' : 'done');
      return ev.error ? push(settled, { kind: 'error', text: ev.error })[0] : settled;
    }
    default:
      return s;
  }
}

/** Verlaufs-Ansicht leeren (Styleguide und veröffentlichte Layouts bleiben bekannt). */
const cleared = (s: ChatState): ChatState => ({
  ...initialChatState, styleguide: s.styleguide, cmsOverrides: s.cmsOverrides, liveBust: s.liveBust,
});

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'event': return applyEvent(state, action.event, action.mode ?? 'live');
    case 'replay': {
      let s: ChatState = { ...cleared(state), target: action.chat.target ?? null };
      for (const ev of action.chat.events) s = applyEvent(s, ev, 'replay');
      return { ...settleSteps(s, 'done', true), tab: s.draft ? 'prev' : 'live', busy: false, status: null };
    }
    case 'reset': return cleared(state);
    case 'run_start': {
      const s = applyEvent({ ...state, busy: true, curText: null, stepBox: null }, { t: 'user', text: action.text }, 'live');
      return { ...s, status: THINKING };
    }
    case 'run_end': return { ...settleSteps(state, 'done'), busy: false, status: null, curText: null, stepBox: null };
    case 'unsend': {
      const last = state.items.at(-1);
      return { ...state, items: last?.kind === 'user' ? state.items.slice(0, -1) : state.items, busy: false, status: null, curText: null, stepBox: null };
    }
    case 'resume': {
      // Runde läuft noch: offene Rückfragen/Freigaben wieder bedienbar machen (der Server wartet auf sie)
      const items = state.items.map(i =>
        (i.kind === 'question' && i.answer === undefined) || (i.kind === 'changeset' && i.decision === undefined && !i.result) ? { ...i, interactive: true } : i);
      // als abgeschlossen angenommene Schritte laufen weiter, wenn die Runde noch läuft
      const reopened = items.map(i => (i.kind === 'steps' && i.steps.some(x => x.stale)
        ? { ...i, steps: i.steps.map(x => (x.stale ? { ...x, state: 'run' as const, stale: undefined } : x)) } : i));
      return { ...state, items: reopened, busy: true, status: (action.last && liveStatus(action.last)) || THINKING };
    }
    case 'error': return push(state, { kind: 'error', text: action.text })[0];
    case 'status': return { ...state, status: action.text };
    case 'answer':
      return {
        ...update(state, 'question', i => i.approvalId === action.approvalId, i => ({ ...i, answer: action.answer, interactive: false })),
        status: state.busy ? THINKING : state.status,
      };
    case 'decide':
      return {
        ...update(state, 'changeset', i => i.approvalId === action.approvalId, i => ({ ...i, interactive: false, decision: action.allow, sent: { allow: action.allow, selected: action.selected } })),
        status: state.busy ? (action.allow ? 'Wendet Änderungen an …' : THINKING) : state.status,
      };
    case 'undo': return update(state, 'changeset', i => i.cs.id === action.csId, i => ({ ...i, undo: action.phase, result: action.undoResults && i.result ? { ...i.result, undoResults: action.undoResults, undone: action.phase === 'done' } : i.result }));
    case 'select_target':
      return { ...state, target: action.target, liveOverride: null, draft: action.target ? null : state.draft, tab: 'live' };
    case 'set_tab': return { ...state, tab: action.tab };
    case 'set_styleguide': return { ...state, styleguide: action.sg };
  }
}

// ---- Abgeleitete Werte ----

/** Startbildschirm, solange noch nichts im Verlauf steht. */
export const isHome = (s: ChatState): boolean => s.items.length === 0;

/** Vorschau-Spalte zeigen, wenn es einen Entwurf oder eine echte Zielseite gibt. */
export const showPreview = (s: ChatState): boolean =>
  !isHome(s) && (!!s.draft || !!(s.target?.id && s.target.kind !== 'landing'));

/**
 * Snapshot beim Wiederverbinden: läuft die Runde wirklich noch? Der Server meldet `running` bis die Runde ganz
 * abgeräumt ist; steht schon ein `done` am Ende des Verlaufs, ist nichts mehr zu erwarten.
 */
export const isStillRunning = (snap: { running: boolean; chat: Pick<ChatDetail, 'events'> }): boolean =>
  snap.running && snap.chat.events.at(-1)?.t !== 'done';

/** Offene Rückfrage, auf die das Eingabefeld antwortet. */
export const pendingQuestion = (s: ChatState) =>
  [...s.items].reverse().find((i): i is Extract<LogItem, { kind: 'question' }> => i.kind === 'question' && i.interactive) ?? null;

/** Freigabe ist raus, das Ergebnis fehlt noch: der Shop-Schreibvorgang läuft und hängt nicht am Stoppen. */
export const writeInFlight = (s: ChatState): boolean =>
  s.items.some(i => i.kind === 'changeset' && !!i.sent?.allow && !i.result);

/** Stoppen vor der Freigabe lehnt ab und schreibt nichts. Während des Schreibens bleibt der Knopf stehen, bricht aber nichts ab. */
export function stopControl(writing: boolean): { label: string; title: string; stops: boolean } {
  return writing
    ? { label: 'Schreiben läuft', title: 'Der Shop wird gerade geschrieben. Das läuft weiter und lässt sich nicht abbrechen.', stops: false }
    : { label: 'Stoppen', title: 'Laufende Anfrage abbrechen. Es wird nichts geschrieben.', stops: true };
}
