'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useAttachments } from '@/hooks/useAttachments';
import { useChatStream } from '@/hooks/useChatStream';
import { api, ApiError, errorText } from '@/lib/api';
import { approveError } from '@/lib/approve-error';
import { annotationMessage, type Annotation } from '@/lib/annotations';
import { attachmentMessage, parseAttachments } from '@/lib/attachments';
import { fixForChat, loadFixes, rememberFix, sentFix, type FixMap } from '@/lib/fixes';
import { chatReducer, initialChatState, isHome, isStillRunning, pendingQuestion, showPreview, stopControl, writeInFlight } from '@/lib/chat-state';
import { defaultPlaceholder, placeholderFor, suggestions } from '@/lib/labels';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { CHAT_COOKIE, setupReady } from '@/lib/nav';
import type { AppConfig, CategoryRow, ChatDetail, ChatEvent, CheckFinding, CodeTaskPublic, Health, LibraryDumpPublic, PublishResult, QuickStartPublic, QuickStartSetup, Target } from '@/lib/protocol';
import { liveSrc, withBust } from '@/lib/urls';
import { demoRequest, displayStatus, statusTone, type StartChoice } from '@/lib/sandbox-task';
import { INTL_LOCALE } from '@/lib/i18n';
import Link from 'next/link';
import { useShell, type WorkspaceBridge } from '@/components/shell/ShellProvider';
import { ContextChip } from '@/components/context/ContextChip';
import { ContextPanel } from '@/components/context/ContextPanel';
import { ChatLog } from '@/components/chat/ChatLog';
import { Chips } from '@/components/chat/Chips';
import { Composer } from '@/components/chat/Composer';
import { Button } from '@/components/ui/Button';
import { IconClose, IconCode } from '@/components/ui/icons';
import { Menu } from '@/components/ui/Menu';
import { HomeContent, HomeHead } from '@/components/chat/Home';
import { StatusLine } from '@/components/chat/StatusLine';
import { TargetCard } from '@/components/chat/TargetCard';
import { PreviewPane } from '@/components/preview/PreviewPane';
import { AuditDialog } from '@/components/dialogs/AuditDialog';
import { StyleguideDialog } from '@/components/dialogs/StyleguideDialog';
import { AttachSandboxDialog } from '@/components/sandbox/AttachSandboxDialog';
import { SandboxPanel } from '@/components/sandbox/SandboxPanel';
import { envSummary, startChoiceItems } from '@/components/sandbox/StartChoices';
import btnStyles from '@/components/ui/Button.module.css';
import { offerTitle, type SandboxOfferActions } from '@/components/sandbox/CommandCard';
import type { PrFeedbackActions } from '@/components/sandbox/PrFeedbackCard';
import type { PrProposal } from '@/components/sandbox/PublishCard';
import styles from './Workspace.module.css';

// Active chat in a cookie: on the next load the server renders it right away
function rememberChatId(id: string): string {
  document.cookie = `${CHAT_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`;
  return id;
}

const pickTarget = (t: Target | null): Target | null =>
  t && { kind: t.kind, id: t.id, name: t.name, path: t.path, cmsPage: t.cmsPage };

/** Narrow viewport (tablet, split window): the preview lies as an overlay above the chat (see Workspace.module.css). */
const narrow = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches;

/** Width of the chat column next to a preview: dragged by the handle, kept per browser. */
const CHAT_WIDTH_KEY = 'lotse.chatWidth', SBX_HINT_KEY = 'lotse.sandboxHintHidden';
const CHAT_MIN = 300, CHAT_MAX = 760, PREVIEW_MIN = 420;
const readStored = (key: string): string | null => { try { return window.localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string) => { try { window.localStorage.setItem(key, value); } catch { /* private mode: not remembered */ } };

/** Workspace: start screen → chat (+ history/context) → chat + preview. */
export function Workspace({ initialChatId, initialChat }: { initialChatId: string; initialChat: ChatDetail | null }) {
  const shell = useShell();
  const { health, setup, chats, reloadChats: loadHistory, setActiveChatId, setContextName, setStyleguide: shareStyleguide } = shell;
  const { locale, t: all } = useI18n();
  const { workspace: t, context: tc, sandbox: { code: tsb, task: tst, quick: tsq } } = all;
  // Initial state straight from the server data (stored chat, styleguide), so nothing jumps on load
  const [state, dispatch] = useReducer(chatReducer, null, () => {
    const base = { ...initialChatState, locale, styleguide: shell.styleguide };
    return initialChat?.events?.length ? chatReducer(base, { type: 'replay', chat: initialChat }) : base;
  });
  const [chatId, setChatId] = useState<string | null>(initialChatId);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [categories, setCategories] = useState<CategoryRow[] | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [sgLoaded, setSgLoaded] = useState(shell.styleguideKnown);
  const [exampleProduct, setExampleProduct] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sgOpen, setSgOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [notes, setNotes] = useState<Annotation[]>([]); // change requests from the preview
  const [previewOpen, setPreviewOpen] = useState(false); // narrow viewport: preview above the chat
  const [fixes, setFixes] = useState<FixMap>({}); // shop check findings being worked on in a chat
  // Sandbox Coding: the sandbox attached to this chat (then the right side shows it), the "Sandbox starten" dialog and its preset
  const [taskId, setTaskId] = useState<string | null>(initialChat?.taskId ?? null);
  const [sbxTask, setSbxTask] = useState<CodeTaskPublic | null>(null);
  const [sbxDialog, setSbxDialog] = useState<{ repo: string; baseBranch: string; title?: string; pluginName?: string } | null | false>(false);
  const [sbxBusy, setSbxBusy] = useState(false);
  // saved environments (A22/A23): the choice list of "Sandbox starten" and the AI's card, and one that could not start as saved (the
  // dialog opens prefilled with why)
  const [quicks, setQuicks] = useState<{ list: QuickStartPublic[]; dumps: LibraryDumpPublic[] } | null>(null);
  const [sbxQuick, setSbxQuick] = useState<{ id: string; name: string; setup: QuickStartSetup; message: string; problems: string[]; step: number } | null>(null);
  // "Prüfen und veröffentlichen" on a proposal card: that proposal (otherwise the latest) in the "Pull Request" tab, opened
  const [picked, setPicked] = useState<PrProposal | null>(null);
  const [openPr, setOpenPr] = useState(0);
  // chat column next to a preview: width (null = default) and collapsed (the sandbox preview gets the whole width)
  const [chatWidth, setChatWidth] = useState<number | null>(null);
  const [chatHidden, setChatHidden] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sbxHint, setSbxHint] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const pendingFix = useRef<{ id: string; title: string; prompt: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sentApprovals = useRef(new Set<string>());
  const runGen = useRef(0);
  const busyRef = useRef(false);
  const lastRunEnd = useRef(0);
  const stream = useChatStream();
  const reportError = useCallback((text: string) => dispatch({ type: 'error', text }), []);
  const attachments = useAttachments(reportError);

  // ---- Start: configuration, categories (the server already delivers chat and styleguide) ----
  useEffect(() => {
    let off = false;
    rememberChatId(initialChatId);
    (async () => {
      const [c, sg] = await Promise.allSettled([api.config(), shell.styleguideKnown ? Promise.resolve(undefined) : api.styleguide()]);
      if (off) return;
      setFixes(loadFixes()); // only after loading: localStorage does not exist during server rendering
      const w = Number(readStored(CHAT_WIDTH_KEY));
      if (w >= CHAT_MIN && w <= CHAT_MAX) setChatWidth(w);
      setSbxHint(readStored(SBX_HINT_KEY) !== '1');
      if (c.status === 'fulfilled') setCfg(c.value);
      if (sg.status === 'fulfilled' && sg.value !== undefined) dispatch({ type: 'set_styleguide', sg: sg.value && typeof sg.value === 'object' ? sg.value : null });
      setSgLoaded(true);
      api.categories().then(l => { if (!off) { setCategoryError(null); setCategories(l); } }).catch(e => { if (!off) setCategoryError(errorText(e) || 'error'); }); // code + cause; the translated hint is what gets shown
      api.products('').then(l => { if (!off && l[0]) setExampleProduct(l[0].name); }).catch(() => {});
    })();
    return () => { off = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once on start

  // Language changed: the chat's status texts follow it
  useEffect(() => { dispatch({ type: 'set_locale', locale }); }, [locale]);
  // back to a wide viewport (rotated, window resized): the overlay state ends, so its close button does not stay in the side panel
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1100px)');
    const on = () => { if (!mq.matches) setPreviewOpen(false); };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const { target, busy, styleguide: sg } = state;
  // After a turn: fetch the cost brake state again (budget notice above the input)
  const wasBusy = useRef(busy), { refreshHealth } = shell;
  useEffect(() => { if (wasBusy.current && !busy) refreshHealth(); wasBusy.current = busy; }, [busy, refreshHealth]);
  // As long as shop or AI are missing, there is nothing to send (unknown state or load error: don't block)
  // a chat with a sandbox needs only the AI, not the shop
  const locked = !shell.healthFailed && (taskId ? !!setup && !setup.ai : !setupReady(setup));
  // For the setup card, "set up yes/no" is enough; the server already knows that on first render
  const homeHealth: Health | null = shell.healthFailed ? null : (health ?? (setup && { shopware: { url: '', ok: false, configured: setup.shopware }, ai: { configured: setup.ai } }));

  // Feed the navigation (left) with the workspace state
  useEffect(() => { setActiveChatId(chatId); return () => setActiveChatId(null); }, [chatId, setActiveChatId]);
  useEffect(() => { setContextName(target ? (target.name ?? tc.newLanding) : null); return () => setContextName(null); }, [target, setContextName, tc.newLanding]);
  useEffect(() => { if (sgLoaded) shareStyleguide(sg); }, [sg, sgLoaded, shareStyleguide]);
  const home = isHome(state) && !taskId;
  const pv = !!taskId || showPreview(state);
  const question = pendingQuestion(state);

  const cats = useMemo(() => {
    const o = state.cmsOverrides;
    return categories && Object.keys(o).length ? categories.map(c => (o[c.id] ? { ...c, cmsPage: o[c.id] } : c)) : categories;
  }, [categories, state.cmsOverrides]);
  const exampleCategory = cats?.find(c => c.parentId && c.active)?.name ?? t.exampleCategory;
  const live = liveSrc(target, state.liveOverride, cfg?.paths);
  const liveUrl = live ? withBust(live, state.liveBust) : null;

  // Live event of a run; on narrow viewports the finished draft opens the preview, questions/approvals bring the chat back
  const liveEvent = useCallback((event: ChatEvent) => {
    dispatch({ type: 'event', event, mode: 'live' });
    if (event.t === 'sandbox_attached') setTaskId(event.taskId); // attached meanwhile (other tab)
    if (!narrow()) return;
    if (event.t === 'draft') setPreviewOpen(true);
    else if (event.t === 'question' || event.t === 'changeset' || event.t === 'internet_request') setPreviewOpen(false);
  }, []);

  // ---- Run chat ----
  // extra.chatId: start a run in a just-created chat (the state doesn't know the new ID yet)
  const run = async (message: string, extra: { onboarding?: boolean; chatId?: string; prFeedback?: string } = {}) => {
    const id = extra.chatId ?? chatId;
    if (busyRef.current || !id) return;
    busyRef.current = true;
    const gen = ++runGen.current;
    let conflict = false;
    dispatch({ type: 'run_start', text: message });
    await stream.run({ chatId: id, message, target: extra.chatId ? null : pickTarget(target), onboarding: extra.onboarding, prFeedback: extra.prFeedback }, {
      onEvent: event => {
        if (gen !== runGen.current) return;
        liveEvent(event);
        // The chat is stored from now on: show it in the history on the left right away (as "running"), not only after the run
        if (event.t === 'start') loadHistory();
      },
      onError: (msg, status) => { if (gen !== runGen.current) return; if (status === 409) conflict = true; else dispatch({ type: 'error', text: msg }); },
    });
    if (gen !== runGen.current) return; // meanwhile a different chat; the run continues there in the background
    busyRef.current = false;
    if (conflict) {
      // A run is already active there (second tab, double click): message never arrived → back into the input, attach to the running run
      dispatch({ type: 'unsend' });
      setInput(parseAttachments(message).text);
      handlers.current?.openChat(id);
      return;
    }
    dispatch({ type: 'run_end' });
    lastRunEnd.current = Date.now();
    loadHistory();
    inputRef.current?.focus();
  };

  const stop = () => {
    if (!chatId) return;
    if (writeInFlight(state)) {
      dispatch({ type: 'status', text: stopControl(true, locale).title });
      return;
    }
    dispatch({ type: 'status', text: t.stopping });
    api.stop(chatId).catch(e => reportError(t.stopFailed(errorText(e))));
  };

  /** Other view: disconnect from the running chat (the run continues on the server). */
  const detach = (nextId?: string) => {
    if (nextId !== chatId) setNotes([]); // requests belong to the chat being left
    stream.abort();
    runGen.current++;
    busyRef.current = false;
  };

  const answer = useCallback((approvalId: string, a: string) => {
    if (!chatId || !a) return;
    dispatch({ type: 'answer', approvalId, answer: a });
    api.answer(chatId, approvalId, a).catch(e => reportError(t.answerFailed(errorText(e))));
  }, [chatId, reportError, t]);

  const send = (text = input) => {
    const message = text.trim();
    if (question && message) { setInput(''); answer(question.approvalId, message); return; }
    if ((!message && !attachments.atts.length) || busyRef.current || locked) return;
    if (attachments.uploading) { dispatch({ type: 'status', text: t.uploading }); return; }
    // Task from the shop check: link the finding with this chat ("in progress" on the start page)
    const fix = pendingFix.current;
    if (fix && chatId && sentFix(fix.prompt, message)) setFixes(m => rememberFix(m, fix.id, { chatId, title: fix.title, at: new Date().toISOString() }));
    pendingFix.current = null;
    const full = attachmentMessage(message, attachments.done, attachments.files, locale);
    attachments.clear();
    setInput('');
    void run(full);
  };

  // Styleguide onboarding always gets a fresh chat: new context, nothing from the previous history
  const onboard = () => { const id = newChat(); void run(t.onboard, { onboarding: true, chatId: id }); };

  const decide = (approvalId: string, allow: boolean, selected?: string[]) => {
    if (!chatId) return;
    const alreadySent = sentApprovals.current.has(approvalId) || writeInFlight(state);
    if (sentApprovals.current.has(approvalId)) return;
    sentApprovals.current.add(approvalId);
    dispatch({ type: 'decide', approvalId, allow, selected });
    api.approve(chatId, approvalId, allow, selected).catch(e => {
      const status = e instanceof ApiError ? e.status : 0;
      const text = approveError(status, alreadySent, locale);
      if (!text) return;
      reportError(status === 404 ? text : `${text}: ${errorText(e)}`);
    });
  };

  const undo = async (csId: string) => {
    if (!chatId || !window.confirm(t.undoConfirm)) return;
    dispatch({ type: 'undo', csId, phase: 'running' });
    try {
      const r = await api.undo(chatId, csId);
      dispatch({ type: 'undo', csId, phase: r.ok ? 'done' : r.undoResults ? 'idle' : 'failed', undoResults: r.undoResults }); // partial: clicking again reverts the rest
      if (!r.ok && r.error) reportError(t.undoResult(r.undoResults ? t.undoPartial(r.done ?? 0, r.total ?? 0) : t.undoFailedWord, r.error));
    } catch (e) {
      dispatch({ type: 'undo', csId, phase: 'failed' });
      reportError(t.undoFailed(errorText(e)));
    }
  };

  const newChat = () => {
    detach();
    const id = rememberChatId(crypto.randomUUID());
    setChatId(id);
    dispatch({ type: 'reset' });
    setTaskId(null); setSbxTask(null); setChatHidden(false);
    setInput('');
    setPreviewOpen(false);
    attachments.clear();
    loadHistory();
    return id;
  };

  // Open chat, even while another one is running. If the opened one is still running, it continues live.
  const openChat = async (id: string) => {
    detach(id);
    const gen = runGen.current;
    let running = false, found = false;
    await stream.listen(id, {
      onEvent: event => {
        if (gen !== runGen.current) return;
        if (event.t === 'snapshot') {
          found = true; running = isStillRunning(event);
          setChatId(rememberChatId(event.chat.id));
          setTaskId(event.chat.taskId ?? null); setSbxTask(null);
          dispatch({ type: 'replay', chat: event.chat });
          if (running) { busyRef.current = true; dispatch({ type: 'resume', last: event.chat.events.at(-1) }); }
          loadHistory();
          return;
        }
        liveEvent(event);
      },
      onError: msg => {
        if (gen !== runGen.current) return;
        if (/not found/i.test(msg)) { reportError(t.chatGone); loadHistory(); }
        else reportError(t.chatLoadFailed(msg));
      },
    });
    if (gen !== runGen.current || !found) return;
    if (running) { busyRef.current = false; dispatch({ type: 'run_end' }); lastRunEnd.current = Date.now(); loadHistory(); }
  };

  const deleteChat = async (id: string) => {
    try { await api.deleteChat(id); } catch (e) { reportError(t.deleteFailed(errorText(e))); }
    if (id === chatId) newChat(); else loadHistory();
  };

  const selectTarget = (t: Target | null) => {
    // Different context in a chat with history → new chat for this context (chats stay cleanly separated per page)
    const other = t && !home && (t.kind !== target?.kind || t.id !== target?.id);
    if (other) newChat();
    dispatch({ type: 'select_target', target: t });
    if (t) inputRef.current?.focus();
  };

  const onDrop = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
    if (e.type === 'drop') void attachments.addFiles(Array.from(e.dataTransfer.files));
  };

  // ---- Sandbox: attach (dialog or the AI's card), follow its status, detach when finished ----
  const attached = (task: CodeTaskPublic) => {
    setTaskId(task.id); setSbxTask(task);
    dispatch({ type: 'event', event: { t: 'sandbox_attached', taskId: task.id, repo: task.repo, baseBranch: task.baseBranch }, mode: 'live' });
    loadHistory();
  };
  const onSandboxTask = (task: CodeTaskPublic) => {
    setSbxTask(task);
    if (task.status === 'done') {
      setTaskId(null); setPreviewOpen(false); setChatHidden(false);
      dispatch({ type: 'event', event: { t: 'sandbox_status', state: 'finished' }, mode: 'live' }); // a static line, not a spinner
      loadHistory();
    }
  };
  const loadQuicks = () => Promise.all([api.sandbox.quickStarts(), api.sandbox.storedDbs().catch(() => ({ dumps: [] as LibraryDumpPublic[] }))])
    .then(([q, d]) => { const v = { list: q.quickStarts, dumps: d.dumps }; setQuicks(v); return v; },
      // a failed load must not lock the choices: keep what was there, else offer Demo-Shop and "Neu einrichten …"
      e => { reportError(errorText(e)); setQuicks(prev => prev ?? { list: [], dumps: [] }); return null; });
  // the AI's card shows the same choices: load them once a card is waiting for a decision
  const offerOpen = !!shell.sandbox && !taskId && state.items.some(i => i.kind === 'sandbox_offer');
  useEffect(() => { if (offerOpen) void loadQuicks(); }, [offerOpen, chatId]); // eslint-disable-line react-hooks/exhaustive-deps -- once per chat with a card
  /** One click on a saved environment: a NEW sandbox from it in this chat; if it cannot start as saved, the dialog opens prefilled */
  const startEnv = async (id: string, cid: string, title?: string) => {
    const known = quicks?.list.find(q => q.id === id) ? quicks : await loadQuicks();
    const q = known?.list.find(x => x.id === id);
    const name = q?.name ?? id;
    setSbxBusy(true);
    dispatch({ type: 'status', text: tsq.starting(name) });
    try {
      const r = await api.sandbox.startQuickStart(id, cid, title);
      if ('broken' in r) {
        dispatch({ type: 'status', text: null });
        const fields = r.broken.problems.map(p => p.field);
        setSbxQuick({ id, name: r.broken.quickStart.name, setup: r.broken.quickStart.setup, message: r.broken.lead, problems: r.broken.problems.map(p => p.message), step: fields.every(f => f === 'dump') ? 2 : 1 });
        setSbxDialog(null);
        return;
      }
      attached(r.task);
      dispatch({ type: 'status', text: tsq.started(name, q ? envSummary(q, all, known?.dumps ?? null) : r.task.title) });
      for (const w of r.warnings) reportError(w);
    } catch (e) { dispatch({ type: 'status', text: null }); reportError(errorText(e)); }
    finally { setSbxBusy(false); }
  };
  /** "Demo-Shop ohne Projekt": dockware's demo data, no repository, one click */
  const startDemo = (cid: string, title?: string) => {
    setSbxBusy(true);
    dispatch({ type: 'status', text: tsq.demoStarting });
    api.sandbox.createTask(demoRequest(cid, title || tsq.demoTitle)).then(r => { dispatch({ type: 'status', text: null }); attached(r.task); },
      e => { dispatch({ type: 'status', text: null }); reportError(errorText(e)); }).finally(() => setSbxBusy(false));
  };
  /** The choice list's click (menu, the AI's card, the Sandbox Coding page): every start from a saved environment is a fresh sandbox */
  const startChoice = (c: StartChoice, o: { chatId?: string; title?: string; initial?: { repo: string; baseBranch: string; title?: string; pluginName?: string } } = {}) => {
    const cid = o.chatId ?? chatId;
    if (c.type === 'new' || !cid) { setSbxQuick(null); setSbxDialog(o.initial ?? null); return; }
    if (c.type === 'env') void startEnv(c.id, cid, o.title);
    else startDemo(cid, o.title);
  };
  // Docker known to be down: starting a sandbox would fail at its first step
  const sbxBlocked = shell.health?.sandbox?.docker === false ? tsb.buttonDockerDown : null;
  const sandboxActions: SandboxOfferActions | undefined = shell.sandbox ? {
    attached: !!taskId, busy: sbxBusy, blocked: sbxBlocked, environments: quicks?.list ?? null, dumps: quicks?.dumps ?? null,
    start: (o, c) => {
      const title = o.reason ? offerTitle(o.reason) : undefined;
      startChoice(c, { title, initial: { repo: o.repo, baseBranch: o.baseBranch, title, ...(o.pluginName ? { pluginName: o.pluginName } : {}) } });
    },
  } : undefined;
  // Bridge for the navigation: always the current handlers, registered stably
  const handlers = useRef<WorkspaceBridge | null>(null);
  useEffect(() => {
    handlers.current = {
      newChat,
      openChat: id => void openChat(id),
      deleteChat: id => void deleteChat(id),
      openContext: () => setContextOpen(true),
      openStyleguide: () => { if (sg) setSgOpen(true); else if (sgLoaded && !busy) onboard(); },
      openRules: () => setSgOpen(true),
      prefill: (text, fix) => { pendingFix.current = fix ? { ...fix, prompt: text } : null; setInput(text); inputRef.current?.focus(); },
      openSandbox: () => { if (shell.sandbox && !taskId) setSbxDialog(null); },
      sandboxFrom: choice => { if (!shell.sandbox) return; const id = newChat(); startChoice(choice, { chatId: id }); },
    };
  });
  useEffect(() => {
    shell.registerWorkspace({
      newChat: () => handlers.current?.newChat(),
      openChat: id => handlers.current?.openChat(id),
      deleteChat: id => handlers.current?.deleteChat(id),
      openContext: () => handlers.current?.openContext(),
      openStyleguide: () => handlers.current?.openStyleguide(),
      openRules: () => handlers.current?.openRules(),
      prefill: (text, fix) => handlers.current?.prefill(text, fix),
      openSandbox: () => handlers.current?.openSandbox(),
      sandboxFrom: choice => handlers.current?.sandboxFrom(choice),
    });
    return () => shell.registerWorkspace(null);
  }, [shell.registerWorkspace]); // eslint-disable-line react-hooks/exhaustive-deps -- only on mount/unmount

  // Run a task from another page's navigation (e.g. "Neuer Chat" (new chat) in settings) after loading
  useEffect(() => {
    const intent = shell.takeIntent();
    if (!intent) return;
    const h = handlers.current;
    if (!h) return;
    if (intent.type === 'new') h.newChat();
    else if (intent.type === 'new-context') { h.newChat(); h.openContext(); }
    else if (intent.type === 'open') h.openChat(intent.id);
    else if (intent.type === 'context') h.openContext();
    else if (intent.type === 'rules') h.openRules();
    else if (intent.type === 'prompt') { h.newChat(); h.prefill(intent.text, intent.fix); }
    else if (intent.type === 'sandbox') { if (intent.choice && intent.choice.type !== 'new') h.sandboxFrom(intent.choice); else { h.newChat(); h.openSandbox(); } }
    else h.openStyleguide();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once on start

  // Self-healing: the history reports the open chat as running, but the view is not attached to any run
  // (e.g. reload right while sending) → reconnect. Not right after the run ends: a fetch from the
  // window between `done` and the run's cleanup still reports "running" although nothing more comes.
  const activeStatus = chats?.find(c => c.id === chatId)?.status;
  useEffect(() => {
    if (activeStatus && !busyRef.current && chatId && Date.now() - lastRunEnd.current > 2500) handlers.current?.openChat(chatId);
  }, [activeStatus, chatId]);

  // Stored chat is still running (e.g. after reload) → keep following live
  useEffect(() => {
    if (initialChat?.running) handlers.current?.openChat(initialChatId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once on start

  // PR feedback of the attached sandbox not handed to the AI yet (a dot on the "Pull Request" tab, a warning when finishing)
  const feedbackOpen = taskId ? state.items.filter(i => i.kind === 'pr_feedback' && i.taskId === taskId && i.items.length > 0 && !i.handedOver).length : 0;
  // PR feedback (pr-watch.ts): hand it to the AI (the server wraps it as data), or finish the task once the PR is merged/closed
  const prFeedback: PrFeedbackActions | undefined = shell.sandbox ? {
    attachedTaskId: taskId, busy: busy || sbxBusy,
    handOff: f => {
      if (busyRef.current) return;
      // the card is marked by the server's pr_feedback event once the AI run really starts (a blocked turn leaves it to hand over again)
      void run(tsb.feedback.handOffText(f.number, f.items.length), { prFeedback: f.id });
    },
    finish: id => {
      if (!window.confirm(tst.finishConfirm(sbxTask?.title ?? '') + (feedbackOpen ? tst.feedbackOpen(feedbackOpen) : ''))) return;
      setSbxBusy(true);
      api.sandbox.taskAction(id, 'finish').then(r => onSandboxTask(r.task), e => reportError(errorText(e))).finally(() => setSbxBusy(false));
    },
  } : undefined;
  const sandboxSetup = !!taskId && (!sbxTask || sbxTask.status === 'setting_up');
  const latestProposal = useMemo(() => {
    const p = state.items.findLast(i => i.kind === 'publish');
    return p?.kind === 'publish' ? { key: p.key, title: p.title, body: p.body } : null;
  }, [state.items]);
  const proposal = picked && state.items.some(i => i.key === picked.key) ? picked : latestProposal;
  const reviewPublish = (p: PrProposal) => { setPicked(p); setOpenPr(n => n + 1); if (narrow()) setPreviewOpen(true); };
  // the publish response carries the PR (the chat stream is not connected between turns): the card comes from here
  const published = (r: PublishResult) => {
    setSbxTask(r.task);
    dispatch({ type: 'event', event: { t: 'pr', taskId: r.task.id, ...r.pr, action: r.action, files: r.files }, mode: 'live' });
    loadHistory();
  };

  const fixTask = (f: { id: string; title: string; prompt: string }) => { pendingFix.current = f; setInput(f.prompt); inputRef.current?.focus(); };
  const fixFinding = (f: CheckFinding) => fixTask({ id: f.id, title: f.title, prompt: f.fixPrompt });
  const fixLink = !home ? fixForChat(fixes, chatId) : null;
  const placeholder = locked ? t.lockedPlaceholder : question ? t.answerPlaceholder : taskId ? (sandboxSetup ? tsb.setupPlaceholder : tsb.placeholder) : target ? placeholderFor(target.kind, target.name, locale) : defaultPlaceholder(locale);
  // an empty sandbox chat: examples of what a shop operator can ask for (a banner, a checkout field, an own plugin)
  const sandboxEmpty = !!taskId && !state.items.some(i => i.kind === 'user');
  const chips = busy ? [] : taskId ? (sandboxEmpty && !locked ? tsb.examples : []) : target ? suggestions(target.kind, locale) : [];
  const mode = home ? 'home' : pv ? 'pv' : 'work';
  const overlay = pv && previewOpen; // narrow viewport: preview above the chat (desktop shows it on the right anyway)

  const contextChip = <ContextChip target={target} onPick={() => setContextOpen(true)} onClear={() => selectTarget(null)} />;
  // A23: "Sandbox starten" opens the choice list – saved environments (default first), "Demo-Shop ohne Projekt", "Neu einrichten …"
  const sandboxButton = shell.sandbox && !taskId && (
    <Menu label={tsb.button} title={sbxBlocked ?? tsq.menuTitle} up align="start" onOpen={() => void loadQuicks()} disabled={!chatId || !!sbxBlocked || sbxBusy}
      triggerClassName={`${btnStyles.sm} ${styles.sbxBtn}`} trigger={<><IconCode size={15} />{tsb.button}</>}
      items={startChoiceItems({ list: quicks?.list ?? null, dumps: quicks?.dumps ?? null, all, disabled: sbxBusy, onPick: c => startChoice(c), manage: '/sandbox-coding#sbx-quick' })} />
  );
  const hideSbxHint = () => { setSbxHint(false); store(SBX_HINT_KEY, '1'); };
  const sandboxHint = home && shell.sandbox && sbxHint && !locked && (
    <div className={styles.sbxHint} role="note">
      <IconCode size={16} />
      <span>{tsb.homeHint}</span>
      <button type="button" className={styles.sbxHintX} onClick={hideSbxHint} aria-label={tsb.homeHintDismiss} title={tsb.homeHintDismiss}><IconClose size={14} /></button>
    </div>
  );
  // ---- Resizable split (desktop, chat + preview) ----
  const clampWidth = (w: number) => {
    const total = mainRef.current?.clientWidth ?? 1400;
    return Math.round(Math.max(CHAT_MIN, Math.min(CHAT_MAX, total - PREVIEW_MIN, w)));
  };
  const setWidth = (w: number, keep = false) => { const v = clampWidth(w); setChatWidth(v); if (keep) store(CHAT_WIDTH_KEY, String(v)); };
  const defaultWidth = taskId ? 360 : 420;
  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const left = mainRef.current?.getBoundingClientRect().left ?? 0;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent) => setWidth(ev.clientX - left);
    const up = (ev: PointerEvent) => { setWidth(ev.clientX - left, true); setDragging(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onHandleKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 60 : 20, w = chatWidth ?? defaultWidth;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setWidth(w - step, true); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(w + step, true); }
    else if (e.key === 'Home') { e.preventDefault(); setChatWidth(null); store(CHAT_WIDTH_KEY, ''); }
  };
  const budget = shell.health?.ai.budget, usd = (n: number) => n.toLocaleString(INTL_LOCALE[locale], { style: 'currency', currency: 'USD' });
  const budgetNote = budget?.warn && (
    <div className={`${styles.budgetBar}${budget.blocked ? ` ${styles.budgetBlocked}` : ''}`} role="status">
      <span>{budget.blocked ? t.budgetBlocked(usd(budget.spent), usd(budget.limit)) : t.budgetWarn(usd(budget.spent), usd(budget.limit), Math.round((budget.spent / budget.limit) * 100))}</span>
      <Link href="/settings#ai">{t.budgetSettings}</Link>
    </div>
  );
  const composer = (
    <>{budgetNote}<Composer value={input} onChange={setInput} onSubmit={() => send()} onStop={stop} writing={writeInFlight(state)} busy={busy} placeholder={placeholder} home={home}
      atts={attachments.atts} onFiles={f => void attachments.addFiles(f)} onRemoveAtt={attachments.remove} inputRef={inputRef} disabled={locked} noAttach={!!taskId}
      extra={!taskId && <>{!locked && (home || !target) && contextChip}{sandboxButton}</>} />{sandboxHint}</>
  );
  const status = <div className={styles.statusRow}><StatusLine text={state.status} /></div>;

  return (
    <div className={styles.app} data-mode={mode} data-show={overlay ? 'preview' : undefined} data-chat={pv && chatHidden ? 'hidden' : undefined} data-dragging={dragging || undefined}
      style={{ '--chat-w': `${chatWidth ?? defaultWidth}px` } as React.CSSProperties}>

      <main ref={mainRef} className={styles.main}>
        <ContextPanel open={contextOpen} onClose={() => setContextOpen(false)} categories={cats} categoryError={categoryError} target={target} onSelect={selectTarget} />

        <section className={styles.chat} aria-label={t.chat} onDragOver={onDrop} onDrop={onDrop}>
          {home ? (
            <>
              <HomeHead />
              {composer}
              {status}
              <ChatLog className={styles.homeLog} items={state.items} cfg={cfg} busy={busy} onAnswer={answer} onDecide={decide} onUndo={id => void undo(id)} onOpenStyleguide={() => setSgOpen(true)}>
                <HomeContent health={homeHealth} loadFailed={shell.healthFailed} hasStyleguide={sgLoaded ? !!sg : null} product={exampleProduct ?? t.exampleProduct} category={exampleCategory}
                  recent={chats ?? []} onExample={t => { setInput(t); inputRef.current?.focus(); }} onFix={fixFinding} onTask={fixTask} fixes={fixes} onOpenChat={id => void openChat(id)} onOnboard={onboard} />
              </ChatLog>
            </>
          ) : (
            <>
              {pv && (
                <div className={styles.pvBar}>
                  <Button size="sm" onClick={() => setPreviewOpen(true)}>
                    {taskId && <i className={styles.pvPip} data-tone={sbxTask ? statusTone(displayStatus(sbxTask)) : 'busy'} aria-hidden="true" />}
                    {taskId ? tsb.view : state.draft ? t.viewDraft : t.preview}
                  </Button>
                </div>
              )}
              {fixLink && (
                <div className={styles.fixBar}>
                  <span>{t.fromShopCheck} <b>{fixLink.title}</b></span>
                  <button type="button" onClick={() => newChat()}>{t.overview}</button>
                </div>
              )}
              {target && !taskId && <TargetCard target={target} cfg={cfg} onClear={() => selectTarget(null)} />}
              <ChatLog items={state.items} cfg={cfg} busy={busy} onAnswer={answer} onDecide={decide} onUndo={id => void undo(id)} onOpenStyleguide={() => setSgOpen(true)} sandbox={sandboxActions} onReviewPublish={taskId ? reviewPublish : undefined} prFeedback={prFeedback}
                sandboxInternet={taskId && sbxTask ? !!sbxTask.internet : undefined} />
              {status}
              <Chips items={chips} onPick={s => { setInput(s); inputRef.current?.focus(); }} />
              {composer}
            </>
          )}
        </section>

        {pv && !chatHidden && (
          <div className={styles.split} role="separator" aria-orientation="vertical" aria-label={t.resizeChat} title={t.resizeChat} tabIndex={0}
            aria-valuemin={CHAT_MIN} aria-valuemax={CHAT_MAX} aria-valuenow={chatWidth ?? defaultWidth}
            onPointerDown={onHandleDown} onKeyDown={onHandleKey} onDoubleClick={() => { setChatWidth(null); store(CHAT_WIDTH_KEY, ''); }} />
        )}

        {taskId ? (
          <SandboxPanel key={taskId} taskId={taskId} className={styles.right} reload={state.previewReload} busy={busy} files={state.items.filter(i => i.kind === 'file').length}
            onClose={overlay ? () => setPreviewOpen(false) : undefined} onTask={onSandboxTask} onChatEvent={liveEvent} proposal={proposal} openPr={openPr} onPublished={published}
            feedbackOpen={feedbackOpen} chatHidden={chatHidden} onToggleChat={overlay ? undefined : () => setChatHidden(h => !h)}
            onSendNotes={text => { if (busyRef.current) setInput(text); else { setPreviewOpen(false); void run(text); } }} />
        ) : <PreviewPane className={styles.right} tab={state.tab} onTab={t => dispatch({ type: 'set_tab', tab: t })} draft={state.draft}
          liveUrl={liveUrl} onOpenAudit={() => setAuditOpen(true)} busy={busy} onClose={overlay ? () => setPreviewOpen(false) : undefined}
          notes={notes} onAddNote={a => setNotes(l => [...l, { ...a, id: crypto.randomUUID() }])} onRemoveNote={id => setNotes(l => l.filter(n => n.id !== id))}
          onClearNotes={() => setNotes([])} onSubmitNotes={where => { if (busyRef.current || !notes.length) return; const msg = annotationMessage(notes, where, locale); setNotes([]); void run(msg); }} />}
      </main>

      <AuditDialog audit={state.draft?.audit ?? null} open={auditOpen} onClose={() => setAuditOpen(false)} />
      {chatId && shell.sandbox && <AttachSandboxDialog open={sbxDialog !== false} onClose={() => { setSbxDialog(false); setSbxQuick(null); }} chatId={chatId} initial={sbxDialog || null} quick={sbxQuick} onCreated={attached} dockerDown={!!sbxBlocked} />}
      <StyleguideDialog sg={sg} open={sgOpen} onClose={() => setSgOpen(false)}
        onSaved={s => dispatch({ type: 'set_styleguide', sg: s })} onReanalyze={onboard} />
    </div>
  );
}
