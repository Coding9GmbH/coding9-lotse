'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useAttachments } from '@/hooks/useAttachments';
import { useChatStream } from '@/hooks/useChatStream';
import { api, ApiError, errorText } from '@/lib/api';
import { approveError } from '@/lib/approve-error';
import { annotationMessage, type Annotation } from '@/lib/annotations';
import { attachmentMessage, parseAttachments } from '@/lib/attachments';
import { chatReducer, initialChatState, isHome, isStillRunning, pendingQuestion, showPreview, stopControl, writeInFlight } from '@/lib/chat-state';
import { DEFAULT_PLACEHOLDER, placeholderFor, SUGGESTIONS } from '@/lib/labels';
import { CHAT_COOKIE } from '@/lib/nav';
import type { AppConfig, CategoryRow, ChatDetail, ChatEvent, Health, Target } from '@/lib/protocol';
import { liveSrc, withBust } from '@/lib/urls';
import { useShell, type WorkspaceBridge } from '@/components/shell/ShellProvider';
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

// Aktiver Chat im Cookie: beim nächsten Laden rendert der Server ihn direkt mit
function rememberChatId(id: string): string {
  document.cookie = `${CHAT_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`;
  return id;
}

const pickTarget = (t: Target | null): Target | null =>
  t && { kind: t.kind, id: t.id, name: t.name, path: t.path, cmsPage: t.cmsPage };

/** Schmaler Viewport (Tablet, geteiltes Fenster): die Vorschau liegt als Überlagerung über dem Chat (siehe Workspace.module.css). */
const narrow = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches;

/** Arbeitsfläche: Startbildschirm → Chat (+ Verlauf/Kontext) → Chat + Vorschau. */
export function Workspace({ initialChatId, initialChat }: { initialChatId: string; initialChat: ChatDetail | null }) {
  const shell = useShell();
  const { health, setup, chats, reloadChats: loadHistory, setActiveChatId, setContextName, setStyleguide: shareStyleguide } = shell;
  // Startzustand direkt aus den Server-Daten (gespeicherter Chat, Styleguide) – so springt beim Laden nichts
  const [state, dispatch] = useReducer(chatReducer, null, () => {
    const base = { ...initialChatState, styleguide: shell.styleguide };
    return initialChat?.events?.length ? chatReducer(base, { type: 'replay', chat: initialChat }) : base;
  });
  const [chatId, setChatId] = useState<string | null>(initialChatId);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [categories, setCategories] = useState<CategoryRow[] | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [sgLoaded, setSgLoaded] = useState(shell.styleguideKnown);
  const [exampleProduct, setExampleProduct] = useState('Produkt XY');
  const [input, setInput] = useState('');
  const [sgOpen, setSgOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [notes, setNotes] = useState<Annotation[]>([]); // Änderungswünsche aus der Vorschau
  const [previewOpen, setPreviewOpen] = useState(false); // schmaler Viewport: Vorschau über dem Chat
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sentApprovals = useRef(new Set<string>());
  const runGen = useRef(0);
  const busyRef = useRef(false);
  const lastRunEnd = useRef(0);
  const stream = useChatStream();
  const reportError = useCallback((text: string) => dispatch({ type: 'error', text }), []);
  const attachments = useAttachments(reportError);

  // ---- Start: Konfiguration, Kategorien (Chat und Styleguide liefert der Server schon mit) ----
  useEffect(() => {
    let off = false;
    rememberChatId(initialChatId);
    (async () => {
      const [c, sg] = await Promise.allSettled([api.config(), shell.styleguideKnown ? Promise.resolve(undefined) : api.styleguide()]);
      if (off) return;
      if (c.status === 'fulfilled') setCfg(c.value);
      if (sg.status === 'fulfilled' && sg.value !== undefined) dispatch({ type: 'set_styleguide', sg: sg.value && typeof sg.value === 'object' ? sg.value : null });
      setSgLoaded(true);
      api.categories().then(l => { if (!off) { setCategoryError(null); setCategories(l); } }).catch(() => { if (!off) setCategoryError('nicht geladen'); });
      api.products('').then(l => { if (!off && l[0]) setExampleProduct(l[0].name); }).catch(() => {});
    })();
    return () => { off = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- einmalig beim Start

  const { target, busy, styleguide: sg } = state;
  // Für die Einrichtungs-Karte genügt „eingerichtet ja/nein“ – das kennt der Server schon beim ersten Rendern
  const homeHealth: Health | null = shell.healthFailed ? null : (health ?? (setup && { shopware: { url: '', ok: false, configured: setup.shopware }, ai: { configured: setup.ai } }));

  // Navigation (links) mit dem Zustand der Arbeitsfläche versorgen
  useEffect(() => { setActiveChatId(chatId); return () => setActiveChatId(null); }, [chatId, setActiveChatId]);
  useEffect(() => { setContextName(target ? (target.name ?? 'Neue Landingpage') : null); return () => setContextName(null); }, [target, setContextName]);
  useEffect(() => { if (sgLoaded) shareStyleguide(sg); }, [sg, sgLoaded, shareStyleguide]);
  const home = isHome(state);
  const pv = showPreview(state);
  const question = pendingQuestion(state);

  const cats = useMemo(() => {
    const o = state.cmsOverrides;
    return categories && Object.keys(o).length ? categories.map(c => (o[c.id] ? { ...c, cmsPage: o[c.id] } : c)) : categories;
  }, [categories, state.cmsOverrides]);
  const exampleCategory = cats?.find(c => c.parentId && c.active)?.name ?? 'Kategorie';
  const live = liveSrc(target, state.liveOverride, cfg?.paths);
  const liveUrl = live ? withBust(live, state.liveBust) : null;

  // Live-Ereignis einer Runde; auf schmalen Viewports öffnet der fertige Entwurf die Vorschau, Rückfragen/Freigaben holen den Chat zurück
  const liveEvent = useCallback((event: ChatEvent) => {
    dispatch({ type: 'event', event, mode: 'live' });
    if (!narrow()) return;
    if (event.t === 'draft') setPreviewOpen(true);
    else if (event.t === 'question' || event.t === 'changeset') setPreviewOpen(false);
  }, []);

  // ---- Chat ausführen ----
  // extra.chatId: Runde in einem gerade erst angelegten Chat starten (der State kennt die neue ID noch nicht)
  const run = async (message: string, extra: { onboarding?: boolean; chatId?: string } = {}) => {
    const id = extra.chatId ?? chatId;
    if (busyRef.current || !id) return;
    busyRef.current = true;
    const gen = ++runGen.current;
    let conflict = false;
    dispatch({ type: 'run_start', text: message });
    await stream.run({ chatId: id, message, target: extra.chatId ? null : pickTarget(target), onboarding: extra.onboarding }, {
      onEvent: event => { if (gen === runGen.current) liveEvent(event); },
      onError: (msg, status) => { if (gen !== runGen.current) return; if (status === 409) conflict = true; else dispatch({ type: 'error', text: msg }); },
    });
    if (gen !== runGen.current) return; // inzwischen anderer Chat – die Runde läuft dort im Hintergrund weiter
    busyRef.current = false;
    if (conflict) {
      // Dort läuft schon eine Runde (zweiter Tab, Doppelklick): Nachricht kam nie an → zurück ins Eingabefeld, an die laufende Runde hängen
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
      dispatch({ type: 'status', text: stopControl(true).title });
      return;
    }
    dispatch({ type: 'status', text: 'Wird abgebrochen …' });
    api.stop(chatId).catch(e => reportError(`Abbrechen fehlgeschlagen: ${errorText(e)}`));
  };

  /** Andere Ansicht: Verbindung zum laufenden Chat trennen (die Runde läuft auf dem Server weiter). */
  const detach = (nextId?: string) => {
    if (nextId !== chatId) setNotes([]); // Wünsche gehören zum Chat, den man verlässt
    stream.abort();
    runGen.current++;
    busyRef.current = false;
  };

  const answer = useCallback((approvalId: string, a: string) => {
    if (!chatId || !a) return;
    dispatch({ type: 'answer', approvalId, answer: a });
    api.answer(chatId, approvalId, a).catch(e => reportError(`Antwort konnte nicht gesendet werden: ${errorText(e)}`));
  }, [chatId, reportError]);

  const send = (text = input) => {
    const message = text.trim();
    if (question && message) { setInput(''); answer(question.approvalId, message); return; }
    if ((!message && !attachments.atts.length) || busyRef.current) return;
    if (attachments.uploading) { dispatch({ type: 'status', text: 'Anhänge werden noch hochgeladen …' }); return; }
    const full = attachmentMessage(message, attachments.done, attachments.files);
    attachments.clear();
    setInput('');
    void run(full);
  };

  // Styleguide-Onboarding bekommt immer einen frischen Chat: neuer Kontext, nichts aus dem bisherigen Verlauf
  const onboard = () => { const id = newChat(); void run('Erstelle den Styleguide für meinen Shop.', { onboarding: true, chatId: id }); };

  const decide = (approvalId: string, allow: boolean, selected?: string[]) => {
    if (!chatId) return;
    const alreadySent = sentApprovals.current.has(approvalId) || writeInFlight(state);
    if (sentApprovals.current.has(approvalId)) return;
    sentApprovals.current.add(approvalId);
    dispatch({ type: 'decide', approvalId, allow, selected });
    api.approve(chatId, approvalId, allow, selected).catch(e => {
      const status = e instanceof ApiError ? e.status : 0;
      const text = approveError(status, alreadySent);
      if (!text) return;
      reportError(status === 404 ? text : `${text}: ${errorText(e)}`);
    });
  };

  const undo = async (csId: string) => {
    if (!chatId || !window.confirm('Alle Änderungen dieses Sets auf die vorherigen Werte zurücksetzen?')) return;
    dispatch({ type: 'undo', csId, phase: 'running' });
    try {
      const r = await api.undo(chatId, csId);
      dispatch({ type: 'undo', csId, phase: r.ok ? 'done' : r.undoResults ? 'idle' : 'failed', undoResults: r.undoResults }); // teilweise: erneut klicken setzt den Rest zurück
      if (!r.ok && r.error) reportError(`Rückgängig ${r.undoResults ? `unvollständig (${r.done ?? 0} von ${r.total ?? 0} Schritten)` : 'fehlgeschlagen'}: ${r.error}`);
    } catch (e) {
      dispatch({ type: 'undo', csId, phase: 'failed' });
      reportError(`Rückgängig fehlgeschlagen: ${errorText(e)}`);
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

  // Chat öffnen – auch während ein anderer läuft. Läuft der geöffnete selbst noch, geht es live weiter.
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
        if (/not found/i.test(msg)) { reportError('Dieser Chat existiert nicht mehr.'); loadHistory(); }
        else reportError(`Chat konnte nicht geladen werden: ${msg}`);
      },
    });
    if (gen !== runGen.current || !found) return;
    if (running) { busyRef.current = false; dispatch({ type: 'run_end' }); lastRunEnd.current = Date.now(); loadHistory(); }
  };

  const deleteChat = async (id: string) => {
    try { await api.deleteChat(id); } catch (e) { reportError(`Löschen fehlgeschlagen: ${errorText(e)}`); }
    if (id === chatId) newChat(); else loadHistory();
  };

  const selectTarget = (t: Target | null) => {
    // Anderer Kontext in einem Chat mit Verlauf → neuer Chat für diesen Kontext (Chats bleiben je Seite sauber getrennt)
    const other = t && !home && (t.kind !== target?.kind || t.id !== target?.id);
    if (other) newChat();
    dispatch({ type: 'select_target', target: t });
    if (t) inputRef.current?.focus();
  };

  // Brücke für die Navigation: immer die aktuellen Handler, stabil registriert
  const handlers = useRef<WorkspaceBridge | null>(null);
  useEffect(() => {
    handlers.current = {
      newChat,
      openChat: id => void openChat(id),
      deleteChat: id => void deleteChat(id),
      openContext: () => setContextOpen(true),
      openStyleguide: () => { if (sg) setSgOpen(true); else if (sgLoaded && !busy) onboard(); },
    };
  });
  useEffect(() => {
    shell.registerWorkspace({
      newChat: () => handlers.current?.newChat(),
      openChat: id => handlers.current?.openChat(id),
      deleteChat: id => handlers.current?.deleteChat(id),
      openContext: () => handlers.current?.openContext(),
      openStyleguide: () => handlers.current?.openStyleguide(),
    });
    return () => shell.registerWorkspace(null);
  }, [shell.registerWorkspace]); // eslint-disable-line react-hooks/exhaustive-deps -- nur bei Mount/Unmount

  // Auftrag aus der Navigation einer anderen Seite (z. B. „Neuer Chat“ in den Einstellungen) nach dem Laden ausführen
  useEffect(() => {
    const intent = shell.takeIntent();
    if (!intent) return;
    const h = handlers.current;
    if (!h) return;
    if (intent.type === 'new') h.newChat();
    else if (intent.type === 'open') h.openChat(intent.id);
    else if (intent.type === 'context') h.openContext();
    else h.openStyleguide();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- einmalig beim Start

  // Selbstheilung: Der Verlauf meldet den offenen Chat als laufend, die Ansicht hängt aber an keiner Runde
  // (z. B. Neuladen genau beim Absenden) → wieder verbinden. Nicht direkt nach dem Rundenende: ein Abruf aus dem
  // Fenster zwischen `done` und dem Abräumen der Runde meldet noch „läuft“, obwohl nichts mehr kommt.
  const activeStatus = chats?.find(c => c.id === chatId)?.status;
  useEffect(() => {
    if (activeStatus && !busyRef.current && chatId && Date.now() - lastRunEnd.current > 2500) handlers.current?.openChat(chatId);
  }, [activeStatus, chatId]);

  // Gespeicherter Chat läuft noch (z. B. nach Neuladen) → live weiterverfolgen
  useEffect(() => {
    if (initialChat?.running) handlers.current?.openChat(initialChatId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- einmalig beim Start

  const onDrop = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
    if (e.type === 'drop') void attachments.addFiles(Array.from(e.dataTransfer.files));
  };

  const placeholder = question ? 'Antwort eintippen oder oben anklicken …' : target ? placeholderFor(target.kind, target.name) : DEFAULT_PLACEHOLDER;
  const chips = !busy && target ? SUGGESTIONS[target.kind] : [];
  const mode = home ? 'home' : pv ? 'pv' : 'work';
  const overlay = pv && previewOpen; // schmaler Viewport: Vorschau über dem Chat (Desktop zeigt sie ohnehin rechts)

  const composer = (
    <Composer value={input} onChange={setInput} onSubmit={() => send()} onStop={stop} writing={writeInFlight(state)} busy={busy} placeholder={placeholder} home={home}
      atts={attachments.atts} onFiles={f => void attachments.addFiles(f)} onRemoveAtt={attachments.remove} inputRef={inputRef} />
  );
  const status = <div className={styles.statusRow}><StatusLine text={state.status} /></div>;

  return (
    <div className={styles.app} data-mode={mode} data-show={overlay ? 'preview' : undefined}>

      <main className={styles.main}>
        <ContextPanel open={contextOpen} onClose={() => setContextOpen(false)} categories={cats} categoryError={categoryError} target={target} onSelect={selectTarget} />

        <section className={styles.chat} aria-label="Chat" onDragOver={onDrop} onDrop={onDrop}>
          {home ? (
            <>
              <HomeHead />
              {composer}
              {status}
              <ChatLog className={styles.homeLog} items={state.items} cfg={cfg} onAnswer={answer} onDecide={decide} onUndo={id => void undo(id)} onOpenStyleguide={() => setSgOpen(true)}>
                <HomeContent health={homeHealth} loadFailed={shell.healthFailed} hasStyleguide={sgLoaded ? !!sg : null} product={exampleProduct} category={exampleCategory}
                  recent={chats ?? []} onExample={t => { setInput(t); inputRef.current?.focus(); }} onOpenChat={id => void openChat(id)} onOnboard={onboard} />
              </ChatLog>
            </>
          ) : (
            <>
              {pv && (
                <div className={styles.pvBar}>
                  <Button size="sm" onClick={() => setPreviewOpen(true)}>{state.draft ? 'Entwurf ansehen' : 'Vorschau'}</Button>
                </div>
              )}
              {target && <TargetCard target={target} cfg={cfg} onClear={() => selectTarget(null)} />}
              <ChatLog items={state.items} cfg={cfg} onAnswer={answer} onDecide={decide} onUndo={id => void undo(id)} onOpenStyleguide={() => setSgOpen(true)} />
              {status}
              <Chips items={chips} onPick={s => { setInput(s); inputRef.current?.focus(); }} />
              {composer}
            </>
          )}
        </section>

        <PreviewPane className={styles.right} tab={state.tab} onTab={t => dispatch({ type: 'set_tab', tab: t })} draft={state.draft}
          liveUrl={liveUrl} onOpenAudit={() => setAuditOpen(true)} busy={busy} onClose={overlay ? () => setPreviewOpen(false) : undefined}
          notes={notes} onAddNote={a => setNotes(l => [...l, { ...a, id: crypto.randomUUID() }])} onRemoveNote={id => setNotes(l => l.filter(n => n.id !== id))}
          onClearNotes={() => setNotes([])} onSubmitNotes={where => { if (busyRef.current || !notes.length) return; const msg = annotationMessage(notes, where); setNotes([]); void run(msg); }} />
      </main>

      <AuditDialog audit={state.draft?.audit ?? null} open={auditOpen} onClose={() => setAuditOpen(false)} />
      <StyleguideDialog sg={sg} open={sgOpen} onClose={() => setSgOpen(false)}
        onSaved={s => dispatch({ type: 'set_styleguide', sg: s })} onReanalyze={onboard} />
    </div>
  );
}
