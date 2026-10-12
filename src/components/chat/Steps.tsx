'use client';

import type { Step } from '@/lib/chat-state';
import { toolLabel } from '@/lib/labels';
import styles from './Steps.module.css';

const STATE_LABEL = { run: 'läuft', done: 'erledigt', bad: 'Fehler' } as const;

/** Arbeitsschritte der KI. Der Zustand bleibt für assistive Technik lesbar, das Roh-JSON nicht in der normalen Ansicht. */
export function Steps({ steps }: { steps: Step[] }) {
  return (
    <ul className={styles.steps} aria-label="Arbeitsschritte">
      {steps.map(s => (
        <li key={s.id} className={`${styles.step} ${styles[s.state]}`}>
          <span className={styles.line}>
            <i aria-hidden="true" />
            <span>{toolLabel(s.name)}</span>
            <span className="visually-hidden"> ({STATE_LABEL[s.state]})</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
