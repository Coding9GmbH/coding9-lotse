'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { announceAnswer } from '@/lib/a11y';
import type { LogItem } from '@/lib/chat-state';
import type { AppConfig } from '@/lib/protocol';
import { ChangeSetCard } from './ChangeSetCard';
import { ImageCard, PublishedCard, StyleguideCard } from './Cards';
import { AiMessage, ErrorMessage, UserMessage } from './Message';
import { QuestionCard } from './QuestionCard';
import { Steps } from './Steps';
import styles from './ChatLog.module.css';

interface Props {
  items: LogItem[];
  cfg: AppConfig | null;
  onAnswer: (approvalId: string, answer: string) => void;
  onDecide: (approvalId: string, allow: boolean, selected?: string[]) => void;
  onUndo: (csId: string) => void;
  onOpenStyleguide: () => void;
  /** true, solange eine Runde läuft. Die Ansage kommt erst, wenn sie fertig ist. */
  busy?: boolean;
  className?: string;
  children?: React.ReactNode;
}

function AnswerStatus({ busy, hasAnswer }: { busy: boolean; hasAnswer: boolean }) {
  const [snap, setSnap] = useState({ busy: false, text: null as string | null });
  if (busy !== snap.busy) {
    const text = snap.busy && !busy && hasAnswer ? announceAnswer(true) : null;
    setSnap({ busy, text });
  }
  return snap.text ? <p className="visually-hidden" role="status">{snap.text}</p> : null;
}

const NEAR_END = 140;
/** Diese Einträge holen den Verlauf immer ans Ende (eigene Nachricht, Entscheidung nötig). */
const FORCE_FOLLOW = new Set<LogItem['kind']>(['user', 'question', 'changeset']);

/** Chat-Verlauf. Bleibt am Ende „kleben“, solange man nicht hochgescrollt hat. */
export function ChatLog({ items, cfg, onAnswer, onDecide, onUndo, onOpenStyleguide, busy = false, className, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastKey = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const last = items.at(-1);
    const isNew = !!last && last.key !== lastKey.current;
    lastKey.current = last?.key ?? null;
    if (stick.current || (isNew && FORCE_FOLLOW.has(last.kind))) { el.scrollTop = el.scrollHeight; stick.current = true; }
  }, [items]);

  const last = items.at(-1);
  const hasAnswer = last?.kind === 'ai' && !!last.text;

  return (
    <div ref={ref} className={[styles.log, className].filter(Boolean).join(' ')} role="log" aria-live="polite" aria-relevant="additions"
      onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END; }}>
      <AnswerStatus busy={busy} hasAnswer={hasAnswer} />
      {children}
      {items.map(item => {
        switch (item.kind) {
          case 'user': return <UserMessage key={item.key} text={item.text} attachments={item.attachments} files={item.files} />;
          case 'ai': return item.text ? <AiMessage key={item.key} text={item.text} /> : null;
          case 'error': return <ErrorMessage key={item.key} text={item.text} />;
          case 'steps': return <Steps key={item.key} steps={item.steps} />;
          case 'image': return <ImageCard key={item.key} url={item.url} alt={item.alt} fileName={item.fileName} />;
          case 'question':
            return <QuestionCard key={item.key} question={item.question} options={item.options} answer={item.answer} interactive={item.interactive}
              onAnswer={a => onAnswer(item.approvalId, a)} />;
          case 'changeset':
            return <ChangeSetCard key={item.key} cs={item.cs} interactive={item.interactive} decision={item.decision} sent={item.sent}
              result={item.result} progress={item.progress} undo={item.undo} onDecide={(allow, sel) => onDecide(item.approvalId, allow, sel)} onUndo={() => onUndo(item.cs.id)} />;
          case 'published': return <PublishedCard key={item.key} info={item.info} target={item.target} cfg={cfg} />;
          case 'styleguide': return <StyleguideCard key={item.key} sg={item.sg} onOpen={onOpenStyleguide} />;
        }
      })}
    </div>
  );
}
