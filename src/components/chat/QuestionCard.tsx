'use client';

import { useState } from 'react';
import type { QuestionOption } from '@/lib/chat-state';
import { Button } from '@/components/ui/Button';
import { useT } from '@/lib/i18n/I18nProvider';
import { Markdown } from './Message';
import styles from './QuestionCard.module.css';

interface Props { question: string; options: QuestionOption[]; answer?: string; interactive: boolean; onAnswer: (a: string) => void }

/** AI follow-up question with clickable answers or free-text input. */
export function QuestionCard({ question, options, answer, interactive, onAnswer }: Props) {
  const t = useT().chat.question;
  const [own, setOwn] = useState('');
  return (
    <section className={styles.q} aria-label={t.label}>
      <div className={styles.lbl}>{t.label}</div>
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
            <input value={own} onChange={e => setOwn(e.target.value)} placeholder={t.ownPlaceholder} aria-label={t.ownAria} />
            <Button type="submit" disabled={!own.trim()}>{t.send}</Button>
          </form>
        </>
      )}
      {answer !== undefined && <div className={styles.qa}>→ {answer}</div>}
    </section>
  );
}
