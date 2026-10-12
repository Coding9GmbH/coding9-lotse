'use client';

import { useState } from 'react';
import type { Step } from '@/lib/chat-state';
import { toolLabel } from '@/lib/labels';
import styles from './Steps.module.css';

const STATE_LABEL = { run: 'läuft', done: 'erledigt', bad: 'Fehler' } as const;

/** Arbeitsschritte der KI (Werkzeug-Aufrufe); Klick zeigt Eingabe und Ergebnis-Vorschau. */
export function Steps({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <ul className={styles.steps} aria-label="Arbeitsschritte">
      {steps.map(s => {
        const isOpen = open.has(s.id);
        return (
          <li key={s.id} className={`${styles.step} ${styles[s.state]}`}>
            <button type="button" aria-expanded={isOpen} onClick={() => toggle(s.id)}>
              <i aria-hidden="true" />
              <span>{toolLabel(s.name)}</span>
              <span className="visually-hidden"> ({STATE_LABEL[s.state]})</span>
            </button>
            {isOpen && (
              <code>{JSON.stringify(s.input, null, 1)}{s.preview !== undefined ? `\n→ ${s.preview}` : ''}</code>
            )}
          </li>
        );
      })}
    </ul>
  );
}
