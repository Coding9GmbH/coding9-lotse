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
import type { AppConfig, CategoryRow, ChatDetail, ChatEvent, CheckFinding, Health, Target } from '@/lib/protocol';
import { liveSrc, withBust } from '@/lib/urls';
import { useShell, type WorkspaceBridge } from '@/components/shell/ShellProvider';
import { ContextChip } from '@/components/context/ContextChip';
import { ContextPanel } from '@/components/context/ContextPanel';
import { ChatLog } from '@/components/chat/ChatLog';
import { Chips } from '@/components/chat/Chips';
import { Composer } from '@/components/chat/Composer';
import { Button } from '@/components/ui/Button';
import { HomeContent, HomeHead } from '@/components/chat/Home';
import { StatusLine } from '@/components/chat/StatusLine';
import { TargetCard } from '@/components/chat/TargetCard';
import { PreviewPane } from '@/components/preview/PreviewPane';
import { AuditDialog } from '@/components/dialogs/AuditDialog';
import { StyleguideDialog } from '@/components/dialogs/StyleguideDialog';
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

/** Workspace: start screen → chat (+ history/context) → chat + preview. */
export function Workspace({ initialChatId, initialChat }: { initialChatId: string; initialChat: ChatDetail | null }) {
  const shell = useShell();
  const { health, setup, chats, reloadChats: loadHistory, setActiveChatId, setContextName, setStyleguide: shareStyleguide } = shell;
  const { locale, t: { workspace: t, context: tc } } = useI18n();
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

  const { target, busy, styleguide: sg } = state;
  // As long as shop or AI are missing, there is nothing to send (unknown state or load error: don't block)
  const locked = !shell.healthFailed && !setupReady(setup);
  // For the setup card, "set up yes/no" is enough; the server already knows that on first render
  const homeHealth: Health | null = shell.healthFailed ? null : (health ?? (setup && { shopware: { url: '', ok: false, configured: setup.shopware }, ai: { configured: setup.ai } }));

  // Feed the navigation (left) with the workspace state
  useEffect(() => { setActiveChatId(chatId); return () => setActiveChatId(null); }, [chatId, setActiveChatId]);
  useEffect(() => { setContextName(target ? (target.name ?? tc.newLanding) : null); return () => setContextName(null); }, [target, setContextName, tc.newLanding]);
  useEffect(() => { if (sgLoaded) shareStyleguide(sg); }, [sg, sgLoaded, shareStyleguide]);
  const home = isHome(state);
  const pv = showPreview(state);
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
    if (!narrow()) return;
    if (event.t === 'draft') setPreviewOpen(true);
    else if (event.t === 'question' || event.t === 'changeset') setPreviewOpen(false);
  }, []);

  // ---- Run chat ----
  // extra.chatId: start a run in a just-created chat (the state doesn't know the new ID yet)
  const run = async (message: string, extra: { onboarding?: boolean; chatId?: string } = {}) => {
    const id = extra.chatId ?? chatId;
    if (busyRef.current || !id) return;
    busyRef.current = true;
    const gen = ++runGen.current;
    let conflict = false;
    dispatch({ type: 'run_start', text: message });
    await stream.run({ chatId: id, message, target: extra.chatId ? null : pickTarget(target), onboarding: extra.onboarding }, {
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

  const onDrop = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
    if (e.type === 'drop') void attachments.addFiles(Array.from(e.dataTransfer.files));
  };

  const fixTask = (f: { id: string; title: string; prompt: string }) => { pendingFix.current = f; setInput(f.prompt); inputRef.current?.focus(); };
  const fixFinding = (f: CheckFinding) => fixTask({ id: f.id, title: f.title, prompt: f.fixPrompt });
  const fixLink = !home ? fixForChat(fixes, chatId) : null;
  const placeholder = locked ? t.lockedPlaceholder : question ? t.answerPlaceholder : target ? placeholderFor(target.kind, target.name, locale) : defaultPlaceholder(locale);
  const chips = !busy && target ? suggestions(target.kind, locale) : [];
  const mode = home ? 'home' : pv ? 'pv' : 'work';
  const overlay = pv && previewOpen; // narrow viewport: preview above the chat (desktop shows it on the right anyway)

  const contextChip = <ContextChip target={target} onPick={() => setContextOpen(true)} onClear={() => selectTarget(null)} />;
  const composer = (
    <Composer value={input} onChange={setInput} onSubmit={() => send()} onStop={stop} writing={writeInFlight(state)} busy={busy} placeholder={placeholder} home={home}
      atts={attachments.atts} onFiles={f => void attachments.addFiles(f)} onRemoveAtt={attachments.remove} inputRef={inputRef} disabled={locked}
      extra={!locked && (home || !target) && contextChip} />
  );
  const status = <div className={styles.statusRow}><StatusLine text={state.status} /></div>;

  return (
    <div className={styles.app} data-mode={mode} data-show={overlay ? 'preview' : undefined}>

      <main className={styles.main}>
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
                  <Button size="sm" onClick={() => setPreviewOpen(true)}>{state.draft ? t.viewDraft : t.preview}</Button>
                </div>
              )}
              {fixLink && (
                <div className={styles.fixBar}>
                  <span>{t.fromShopCheck} <b>{fixLink.title}</b></span>
                  <button type="button" onClick={() => newChat()}>{t.overview}</button>
                </div>
              )}
              {target && <TargetCard target={target} cfg={cfg} onClear={() => selectTarget(null)} />}
              <ChatLog items={state.items} cfg={cfg} busy={busy} onAnswer={answer} onDecide={decide} onUndo={id => void undo(id)} onOpenStyleguide={() => setSgOpen(true)} />
              {status}
              <Chips items={chips} onPick={s => { setInput(s); inputRef.current?.focus(); }} />
              {composer}
            </>
          )}
        </section>

        <PreviewPane className={styles.right} tab={state.tab} onTab={t => dispatch({ type: 'set_tab', tab: t })} draft={state.draft}
          liveUrl={liveUrl} onOpenAudit={() => setAuditOpen(true)} busy={busy} onClose={overlay ? () => setPreviewOpen(false) : undefined}
          notes={notes} onAddNote={a => setNotes(l => [...l, { ...a, id: crypto.randomUUID() }])} onRemoveNote={id => setNotes(l => l.filter(n => n.id !== id))}
          onClearNotes={() => setNotes([])} onSubmitNotes={where => { if (busyRef.current || !notes.length) return; const msg = annotationMessage(notes, where, locale); setNotes([]); void run(msg); }} />
      </main>

      <AuditDialog audit={state.draft?.audit ?? null} open={auditOpen} onClose={() => setAuditOpen(false)} />
      <StyleguideDialog sg={sg} open={sgOpen} onClose={() => setSgOpen(false)}
        onSaved={s => dispatch({ type: 'set_styleguide', sg: s })} onReanalyze={onboard} />
    </div>
  );
}
