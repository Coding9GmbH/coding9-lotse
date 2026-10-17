// Chat state as a pure function over the event list.
// The same reducer handles live-streamed events AND the replay of a saved chat,
// so an opened chat looks exactly like it did during the live run (just without active buttons).

import { DEFAULT_LOCALE, INTL_LOCALE, messages, type Locale } from './i18n';
import { parseAttachments, type Attachment, type FileAttachment } from './attachments';
import { toolLabel } from './labels';
import type { ChangeSet, ChatDetail, ChatEvent, DraftAudit, FileChangeKind, PrFeedbackItem, PublishedInfo, Styleguide, Target, UndoOutcome } from './protocol';
import { asList, shopProxyPath } from './urls';

export type StepState = 'run' | 'done' | 'bad';
/** stale: assumed finished on reload; if the turn is still running, "resume" reopens it */
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
    /** Progress while applying large sets (live only) */
    progress?: { done: number; total: number };
  }
  | { kind: 'published'; key: string; info: PublishedInfo; target: Target | null }
  | { kind: 'styleguide'; key: string; sg: Styleguide }
  // chats with an attached sandbox (Sandbox Coding)
  | { kind: 'file'; key: string; path: string; change: FileChangeKind; added: number; removed: number }
  | { kind: 'command'; key: string; id: string; command: string; args?: Record<string, string>; status: 'running' | 'ok' | 'failed'; exitCode?: number; tail?: string; ms?: number }
  | { kind: 'sandbox'; key: string; state: 'waking' | 'ready' | 'failed' | 'finished'; message?: string }
  | { kind: 'publish'; key: string; title: string; body: string }
  | { kind: 'pr'; key: string; taskId: string; number: number; url: string; title: string; action: 'created' | 'updated'; files: number }
  | { kind: 'sandbox_offer'; key: string; id: string; repo: string; baseBranch: string; reason: string; pluginName?: string }
  | { kind: 'sandbox_attached'; key: string; repo: string; baseBranch: string }
  /** feedback on the sandbox's pull request (pr-watch.ts) or its merge/close; handedOver: given to the AI ("An KI übergeben") */
  | { kind: 'pr_feedback'; key: string; id: string; taskId: string; number: number; url: string; items: PrFeedbackItem[]; more?: number; state?: 'merged' | 'closed'; handedOver?: boolean }
  /** request_internet: the AI asks for internet in the task container; decision = the user's click (sent: clicked, answer pending) */
  | { kind: 'internet'; key: string; approvalId: string; reason: string; decision?: boolean; error?: string; restart?: boolean; interactive: boolean };

export type LogItemKind = LogItem['kind'];

export interface DraftView { html: string; name: string; pageType: string; partial: boolean; spec: unknown; audit: DraftAudit | null; rev: number }
export type PreviewTab = 'live' | 'prev' | 'spec';

export interface ChatState {
  items: LogItem[];
  seq: number;
  /** Reply bubble that further text chunks flow into. */
  curText: string | null;
  /** Step box that further tool calls flow into. */
  stepBox: string | null;
  target: Target | null;
  draft: DraftView | null;
  liveOverride: string | null;
  liveBust: number;
  tab: PreviewTab;
  /** The shop's current styleguide (changed only by live events or load/save). */
  styleguide: Styleguide | null;
  /** Layout names published in this session (category ID → layout). */
  cmsOverrides: Record<string, string>;
  busy: boolean;
  status: string | null;
  /** Language of the status texts (UI language); kept when the history is cleared */
  locale: Locale;
  /** Sandbox: counts storefront changes (theme compiled …); the sandbox preview reloads when it changes */
  previewReload: number;
}

export type Mode = 'live' | 'replay';

export type ChatAction =
  | { type: 'event'; event: ChatEvent; mode?: Mode }
  | { type: 'replay'; chat: Pick<ChatDetail, 'target' | 'events'> }
  | { type: 'reset' }
  | { type: 'run_start'; text: string }
  | { type: 'run_end' }
  /** The server rejected the message (409: a turn is already running there): remove the bubble again */
  | { type: 'unsend' }
  /** Reconnected to a turn that is still running (status from the last event) */
  | { type: 'resume'; last?: ChatEvent }
  | { type: 'error'; text: string }
  | { type: 'status'; text: string | null }
  | { type: 'answer'; approvalId: string; answer: string }
  | { type: 'decide'; approvalId: string; allow: boolean; selected?: string[] }
  /** undoResults: outcome per undo step from the server (partially reverted: card shows "x of y", button stays usable) */
  | { type: 'undo'; csId: string; phase: UndoPhase; undoResults?: UndoOutcome[] }
  | { type: 'select_target'; target: Target | null }
  | { type: 'set_tab'; tab: PreviewTab }
  | { type: 'set_styleguide'; sg: Styleguide | null }
  | { type: 'set_locale'; locale: Locale };

export const initialChatState: ChatState = {
  items: [], seq: 0, curText: null, stepBox: null, target: null, draft: null, liveOverride: null, liveBust: 0,
  tab: 'live', styleguide: null, cmsOverrides: {}, busy: false, status: null, locale: DEFAULT_LOCALE, previewReload: 0,
};

const texts = (s: Pick<ChatState, 'locale'>) => messages(s.locale).lib.chat;
const thinking = (s: Pick<ChatState, 'locale'>) => texts(s).thinking;

function liveStatus(ev: ChatEvent, locale: Locale): string | null {
  const t = messages(locale).lib.chat, n = (x: number) => x.toLocaleString(INTL_LOCALE[locale]);
  switch (ev.t) {
    case 'text_start': return t.writing;
    case 'draft_partial': return t.building;
    case 'question': return t.waitingAnswer;
    case 'changeset': return t.waitingApproval;
    case 'internet_request': return ev.decision === undefined ? t.waitingApproval : t.thinking;
    case 'tool': return t.tool(toolLabel(ev.name, locale));
    case 'changeset_progress': return t.applyProgress(n(ev.done), n(ev.total));
    case 'changeset_result': case 'tool_result': case 'image': case 'file_change': return t.thinking;
    case 'command': return ev.status === 'running' ? t.command(ev.command) : t.thinking;
    case 'sandbox_status': return ev.state === 'waking' ? t.waking : t.thinking;
    default: return null;
  }
}

/** Options of a question: string[] (+ optionHints); older chats contain { label, description }. */
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
  // A new entry ends running reply bubbles/step boxes (unless it IS one of them).
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

/** Close steps without a result (turn over, aborted or result never arrived), otherwise they blink "running" forever */
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
  if (live && s.busy) { const st = liveStatus(ev, s.locale); if (st) s = { ...s, status: st }; }

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
        draft: { html: ev.html, name: ev.name ?? prev?.name ?? texts(s).draft, pageType: ev.pageType ?? prev?.pageType ?? '', partial: true, spec: prev?.spec ?? null, audit: prev?.audit ?? null, rev: (prev?.rev ?? 0) + 1 },
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
      if (next === s) return s; // unknown set (as before: ignore)
      return ev.published ? applyPublished(next, ev.published, live) : next;
    }
    case 'focus':
      if (s.target?.id === ev.id) return s;
      return { ...s, target: { kind: ev.kind, id: ev.id, name: ev.name, path: ev.path ?? null, cmsPage: ev.cmsPage }, liveOverride: null };
    case 'styleguide': {
      const [next] = push(s, { kind: 'styleguide', sg: ev.sg });
      return live ? { ...next, styleguide: ev.sg } : next;
    }
    case 'file_change': return push(s, { kind: 'file', path: ev.path, change: ev.kind, added: ev.added, removed: ev.removed })[0];
    case 'command': {
      const item = { id: ev.id, command: ev.command, args: ev.args, status: ev.status, exitCode: ev.exitCode, tail: ev.tail, ms: ev.ms };
      const next = update(s, 'command', i => i.id === ev.id, i => ({ ...i, ...item }));
      return next !== s ? next : push(s, { kind: 'command', ...item })[0];
    }
    case 'sandbox_status': {
      // waking → ready/failed: one line that changes, not two
      const next = update(s, 'sandbox', i => i.state === 'waking' && s.items.at(-1)?.key === i.key, i => ({ ...i, state: ev.state, message: ev.message }));
      return next !== s ? next : push(s, { kind: 'sandbox', state: ev.state, message: ev.message })[0];
    }
    case 'preview_reload': return live ? { ...s, previewReload: s.previewReload + 1 } : s;
    case 'publish_proposal': return push(s, { kind: 'publish', title: ev.title, body: ev.body })[0];
    case 'pr': return push(s, { kind: 'pr', taskId: ev.taskId, number: ev.number, url: ev.url, title: ev.title, action: ev.action, files: ev.files })[0];
    case 'sandbox_offer': return push(s, { kind: 'sandbox_offer', id: ev.id, repo: ev.repo, baseBranch: ev.baseBranch, reason: ev.reason, ...(ev.pluginName ? { pluginName: ev.pluginName } : {}) })[0];
    case 'sandbox_attached': return push(s, { kind: 'sandbox_attached', repo: ev.repo, baseBranch: ev.baseBranch })[0];
    case 'pr_feedback': {
      // the same card can arrive twice (chat stream and the sandbox panel) or again marked as handed over: one card
      if (s.items.some(i => i.kind === 'pr_feedback' && i.id === ev.id)) return ev.handedOver ? update(s, 'pr_feedback', i => i.id === ev.id, i => ({ ...i, handedOver: true })) : s;
      return push(s, { kind: 'pr_feedback', id: ev.id, taskId: ev.taskId, number: ev.number, url: ev.url, items: ev.items, more: ev.more, state: ev.state, handedOver: ev.handedOver })[0];
    }
    case 'internet_request': {
      // the same approvalId again = the outcome after the click (attaching failed): the card changes, no second card
      const next = update(s, 'internet', i => i.approvalId === ev.approvalId, i => ({ ...i, decision: ev.decision, error: ev.error, interactive: false }));
      return next !== s ? next : push(s, { kind: 'internet', approvalId: ev.approvalId, reason: ev.reason, decision: ev.decision, error: ev.error, restart: ev.restart, interactive: live && ev.decision === undefined })[0];
    }
    case 'done': {
      const settled = settleSteps(s, ev.error ? 'bad' : 'done');
      return ev.error ? push(settled, { kind: 'error', text: ev.error })[0] : settled;
    }
    default:
      return s;
  }
}

/** Clear the history view (styleguide and published layouts stay known). */
const cleared = (s: ChatState): ChatState => ({
  ...initialChatState, styleguide: s.styleguide, cmsOverrides: s.cmsOverrides, liveBust: s.liveBust, locale: s.locale, previewReload: s.previewReload,
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
      return { ...s, status: thinking(s) };
    }
    case 'run_end': return { ...settleSteps(state, 'done'), busy: false, status: null, curText: null, stepBox: null };
    case 'unsend': {
      const last = state.items.at(-1);
      return { ...state, items: last?.kind === 'user' ? state.items.slice(0, -1) : state.items, busy: false, status: null, curText: null, stepBox: null };
    }
    case 'resume': {
      // Turn still running: make open questions/approvals usable again (the server is waiting for them)
      const items = state.items.map(i =>
        (i.kind === 'question' && i.answer === undefined) || (i.kind === 'changeset' && i.decision === undefined && !i.result) || (i.kind === 'internet' && i.decision === undefined) ? { ...i, interactive: true } : i);
      // steps assumed finished keep running if the turn is still running
      const reopened = items.map(i => (i.kind === 'steps' && i.steps.some(x => x.stale)
        ? { ...i, steps: i.steps.map(x => (x.stale ? { ...x, state: 'run' as const, stale: undefined } : x)) } : i));
      return { ...state, items: reopened, busy: true, status: (action.last && liveStatus(action.last, state.locale)) || thinking(state) };
    }
    case 'error': return push(state, { kind: 'error', text: action.text })[0];
    case 'status': return { ...state, status: action.text };
    case 'answer':
      return {
        ...update(state, 'question', i => i.approvalId === action.approvalId, i => ({ ...i, answer: action.answer, interactive: false })),
        status: state.busy ? thinking(state) : state.status,
      };
    case 'decide':
      return {
        ...update(update(state, 'changeset', i => i.approvalId === action.approvalId, i => ({ ...i, interactive: false, decision: action.allow, sent: { allow: action.allow, selected: action.selected } })),
          'internet', i => i.approvalId === action.approvalId, i => ({ ...i, interactive: false, decision: action.allow })),
        status: state.busy ? (action.allow && !state.items.some(i => i.kind === 'internet' && i.approvalId === action.approvalId) ? texts(state).applying : thinking(state)) : state.status,
      };
    case 'undo': return update(state, 'changeset', i => i.cs.id === action.csId, i => ({ ...i, undo: action.phase, result: action.undoResults && i.result ? { ...i.result, undoResults: action.undoResults, undone: action.phase === 'done' } : i.result }));
    case 'select_target':
      return { ...state, target: action.target, liveOverride: null, draft: action.target ? null : state.draft, tab: 'live' };
    case 'set_tab': return { ...state, tab: action.tab };
    case 'set_styleguide': return { ...state, styleguide: action.sg };
    case 'set_locale': return { ...state, locale: action.locale };
  }
}

// ---- Derived values ----

/** Home screen while the history is still empty. */
export const isHome = (s: ChatState): boolean => s.items.length === 0;

/** Show the preview column when there is a draft or a real target page. */
export const showPreview = (s: ChatState): boolean =>
  !isHome(s) && (!!s.draft || !!(s.target?.id && s.target.kind !== 'landing'));

/**
 * Snapshot on reconnect: is the turn really still running? The server reports `running` until the turn is fully
 * cleaned up; if there is already a `done` at the end of the history, nothing more is to be expected.
 */
export const isStillRunning = (snap: { running: boolean; chat: Pick<ChatDetail, 'events'> }): boolean =>
  snap.running && snap.chat.events.at(-1)?.t !== 'done';

/** Open question that the input field answers. */
export const pendingQuestion = (s: ChatState) =>
  [...s.items].reverse().find((i): i is Extract<LogItem, { kind: 'question' }> => i.kind === 'question' && i.interactive) ?? null;

/** Approval sent, result still missing: the shop write is running and is not affected by stopping. */
export const writeInFlight = (s: ChatState): boolean =>
  s.items.some(i => i.kind === 'changeset' && !!i.sent?.allow && !i.result);

/** Stopping before approval declines and writes nothing. While writing, the button stays visible but aborts nothing. */
export function stopControl(writing: boolean, locale: Locale = DEFAULT_LOCALE): { label: string; title: string; stops: boolean } {
  const t = messages(locale).lib.chat;
  return writing
    ? { label: t.writeRunning, title: t.writeRunningTitle, stops: false }
    : { label: t.stop, title: t.stopTitle, stops: true };
}
