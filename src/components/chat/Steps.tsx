'use client';

import type { Step } from '@/lib/chat-state';
import { toolLabel } from '@/lib/labels';
import { useI18n } from '@/lib/i18n/I18nProvider';
import styles from './Steps.module.css';

/** Arbeitsschritte der KI. Der Zustand bleibt für assistive Technik lesbar, das Roh-JSON nicht in der normalen Ansicht. */
export function Steps({ steps }: { steps: Step[] }) {
  const { locale, t } = useI18n();
  return (
    <ul className={styles.steps} aria-label={t.chat.steps.aria}>
      {steps.map(s => (
        <li key={s.id} className={`${styles.step} ${styles[s.state]}`}>
          <span className={styles.line}>
            <i aria-hidden="true" />
            <span>{toolLabel(s.name, locale)}</span>
            <span className="visually-hidden"> ({t.chat.steps.state[s.state]})</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
