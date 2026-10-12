'use client';

import { useState } from 'react';
import type { QuestionOption } from '@/lib/chat-state';
import { Button } from '@/components/ui/Button';
import { Markdown } from './Message';
import styles from './QuestionCard.module.css';

interface Props { question: string; options: QuestionOption[]; answer?: string; interactive: boolean; onAnswer: (a: string) => void }

/** Rückfrage der KI mit anklickbaren Antworten oder freier Eingabe. */
export function QuestionCard({ question, options, answer, interactive, onAnswer }: Props) {
  const [own, setOwn] = useState('');
  return (
    <section className={styles.q} aria-label="Rückfrage">
      <div className={styles.lbl}>Rückfrage</div>
      <Markdown text={question} className={styles.qt} />
      {interactive && (
        <>
          <div className={styles.qo}>
            {options.map((o, i) => (
              <span key={o.label} className={styles.opt}>
                <Button variant={i === 0 ? 'primary' : 'default'} onClick={() => onAnswer(o.label)}>{o.label}</Button>
                {o.description && <small>{o.description}</small>}
              </span>
            ))}
          </div>
          <form className={styles.qf} onSubmit={e => { e.preventDefault(); const a = own.trim(); if (a) onAnswer(a); }}>
            <input value={own} onChange={e => setOwn(e.target.value)} placeholder="Oder eigene Antwort …" aria-label="Eigene Antwort" />
            <Button type="submit" disabled={!own.trim()}>Senden</Button>
          </form>
        </>
      )}
      {answer !== undefined && <div className={styles.qa}>→ {answer}</div>}
    </section>
  );
}
