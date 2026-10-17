'use client';

import Link from 'next/link';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useChatStream } from '@/hooks/useChatStream';
import { api, errorText } from '@/lib/api';
import { chatReducer, initialChatState, isStillRunning, pendingQuestion } from '@/lib/chat-state';
import { INTL_LOCALE } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { CodeTaskPublic } from '@/lib/protocol';
import { useShell } from '@/components/shell/ShellProvider';
import { ChatLog } from '@/components/chat/ChatLog';
import { Composer } from '@/components/chat/Composer';
import { StatusLine } from '@/components/chat/StatusLine';
import ws from '@/components/workspace/Workspace.module.css';
import { DiffPanel } from './DiffPanel';
import { SandboxPreview } from './SandboxPreview';
import styles from './Sandbox.module.css';

type Tab = 'preview' | 'changes';
const CHATTABLE = new Set(['ready', 'paused', 'waking']);

/**
 * The task's code chat next to its preview: same chat log, input and stream as the shop workspace (Workspace.tsx is not forked),
 * plus file and command cards, a preview that reloads after the theme was compiled, and the "Änderungen" tab.
 */
export function CodeWorkspace({ task }: { task: CodeTaskPublic }) {
  const shell = useShell();
  const { locale, t: all } = useI18n();
  const t = all.sandbox.code;
  const [state, dispatch] = useReducer(chatReducer, null, () => ({ ...initialChatState, locale }));
  const [input, setInput] = useState('');
  const [tab, setTab] = useState<Tab>('preview');
  const stream = useChatStream();
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatId = task.chatId;
  const report = useCallback((text: string) => dispatch({ type: 'error', text }), []);
  useEffect(() => { dispatch({ type: 'set_locale', locale }); }, [locale]);

  // History of the task chat (404 = no message yet); a turn still running continues live
  useEffect(() => {
    if (!chatId) return;
    let running = false;
    void stream.listen(chatId, {
      onEvent: ev => {
        if (ev.t === 'snapshot') {
          dispatch({ type: 'replay', chat: ev.chat });
          running = isStillRunning(ev);
          if (running) { busyRef.current = true; dispatch({ type: 'resume', last: ev.chat.events.at(-1) }); }
          return;
        }
        dispatch({ type: 'event', event: ev, mode: 'live' });
      },
      onError: (msg, status) => { if (status !== 404) report(msg); },
    }).then(() => { if (running) { busyRef.current = false; dispatch({ type: 'run_end' }); } });
    return () => stream.abort();
  }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps -- stream and report are stable

  const { refreshHealth, reloadChats } = shell;
  const wasBusy = useRef(state.busy);
  useEffect(() => { if (wasBusy.current && !state.busy) { refreshHealth(); reloadChats(); } wasBusy.current = state.busy; }, [state.busy, refreshHealth, reloadChats]);

  const question = pendingQuestion(state);
  const locked = !CHATTABLE.has(task.status) || !chatId;

  const run = async (message: string) => {
    if (busyRef.current || !chatId) return;
    busyRef.current = true;
    dispatch({ type: 'run_start', text: message });
    let conflict = false;
    await stream.run({ chatId, message, taskId: task.id }, {
      onEvent: ev => { dispatch({ type: 'event', event: ev, mode: 'live' }); if (ev.t === 'start') reloadChats(); },
      onError: (msg, status) => { if (status === 409) conflict = true; else report(msg); },
    });
    busyRef.current = false;
    if (conflict) { dispatch({ type: 'unsend' }); setInput(message); return; }
    dispatch({ type: 'run_end' });
    inputRef.current?.focus();
  };
  const answer = (approvalId: string, a: string) => {
    if (!chatId || !a) return;
    dispatch({ type: 'answer', approvalId, answer: a });
    api.answer(chatId, approvalId, a).catch(e => report(errorText(e)));
  };
  const send = (text = input) => {
    const message = text.trim();
    if (question && message) { setInput(''); answer(question.approvalId, message); return; }
    if (!message || busyRef.current || locked) return;
    setInput('');
    void run(message);
  };
  const stop = () => {
    if (!chatId) return;
    dispatch({ type: 'status', text: all.workspace.stopping });
    api.stop(chatId).catch(e => report(all.workspace.stopFailed(errorText(e))));
  };

  const ai = shell.health?.ai, budget = ai?.budget;
  const usd = (n: number) => n.toLocaleString(INTL_LOCALE[locale], { style: 'currency', currency: 'USD' });
  const providerNote = ai?.provider === 'codex'
    ? <span className={styles.badge}>{t.codexBudget}</span>
    : ai?.provider === 'claude' ? <span className={styles.badge}>{t.provider('Claude')}</span> : null;
  const budgetNote = ai?.provider !== 'codex' && budget?.warn && (
    <div className={`${ws.budgetBar}${budget.blocked ? ` ${ws.budgetBlocked}` : ''}`} role="status">
      <span>{budget.blocked ? all.workspace.budgetBlocked(usd(budget.spent), usd(budget.limit)) : all.workspace.budgetWarn(usd(budget.spent), usd(budget.limit), Math.round((budget.spent / budget.limit) * 100))}</span>
      <Link href="/settings#ai">{all.workspace.budgetSettings}</Link>
    </div>
  );
  const files = state.items.filter(i => i.kind === 'file').length;
  const placeholder = task.status === 'done' ? t.doneNote : locked ? t.lockedPlaceholder : question ? all.workspace.answerPlaceholder : t.placeholder;

  return (
    <div className={styles.codeGrid}>
      <section className={`${styles.card} ${styles.codeChat}`} aria-labelledby="sbx-chat">
        <div className={styles.cardHead}><h2 id="sbx-chat">{t.heading}</h2>{providerNote}</div>
        <ChatLog className={styles.codeLog} items={state.items} cfg={null} busy={state.busy} onAnswer={answer} onDecide={() => {}} onUndo={() => {}} onOpenStyleguide={() => {}}>
          {!state.items.length && (
            <div className={styles.codeIntro}>
              <p className={styles.muted}>{t.intro}</p>
              {task.goal && !locked && <button type="button" className={styles.linkBtn} onClick={() => { setInput(task.goal); inputRef.current?.focus(); }}>{t.useGoal}</button>}
            </div>
          )}
        </ChatLog>
        <StatusLine text={state.status} />
        {budgetNote}
        <Composer value={input} onChange={setInput} onSubmit={() => send()} onStop={stop} busy={state.busy} placeholder={placeholder} home={false}
          atts={[]} onFiles={() => {}} onRemoveAtt={() => {}} inputRef={inputRef} disabled={locked || !!budget?.blocked && ai?.provider !== 'codex'} noAttach />
      </section>
      <div className={styles.codeSide}>
        <div className={styles.tabs} role="tablist" aria-label={t.tabs.label}>
          {(['preview', 'changes'] as Tab[]).map(k => (
            <button key={k} type="button" role="tab" id={`sbx-tab-${k}`} aria-selected={tab === k} aria-controls={`sbx-panel-${k}`} onClick={() => setTab(k)}>
              {t.tabs[k]}{k === 'changes' && files > 0 && <span className={styles.tabCount}>{files}</span>}
            </button>
          ))}
        </div>
        <div role="tabpanel" id="sbx-panel-preview" aria-labelledby="sbx-tab-preview" hidden={tab !== 'preview'}>
          <SandboxPreview task={task} reload={state.previewReload} inTabs onSendNotes={locked ? undefined : text => { if (!busyRef.current) void run(text); else setInput(text); }} />
        </div>
        <section role="tabpanel" id="sbx-panel-changes" aria-labelledby="sbx-tab-changes" hidden={tab !== 'changes'} className={styles.card}>
          {tab === 'changes' && <DiffPanel taskId={task.id} refresh={files + (state.busy ? 0 : 1)} />}
        </section>
      </div>
    </div>
  );
}
