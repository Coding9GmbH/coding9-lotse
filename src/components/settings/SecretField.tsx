'use client';

import { useId } from 'react';
import type { SecretInput } from '@/lib/settings-form';
import styles from './Settings.module.css';

interface Props {
  label: string;
  has: boolean;
  state: SecretInput;
  onChange: (s: SecretInput) => void;
  placeholder?: string;
  hint?: React.ReactNode;
  autoComplete?: string;
}

/** Geheimnis-Eingabe: nie vorbefüllt; zeigt „gespeichert“, leeres Feld lässt den Wert unverändert, „Entfernen“ löscht (nach Rückfrage, gespeichert wird automatisch). */
export function SecretField({ label, has, state, onChange, placeholder, hint, autoComplete = 'off' }: Props) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={styles.field}>
      <span className={styles.labelRow}>
        <label htmlFor={id} className={styles.label}>{label}</label>
        {has && !state.remove && <span className={styles.savedTag}>gespeichert</span>}
        {state.remove && <span className={styles.removeTag}>wird entfernt</span>}
      </span>
      <span className={styles.secretRow}>
        <input id={id} type="password" autoComplete={autoComplete} spellCheck={false} aria-describedby={hint ? hintId : undefined}
          value={state.value} disabled={state.remove}
          placeholder={state.remove ? 'wird gelöscht …' : has ? '•••••••• (unverändert lassen)' : placeholder}
          onChange={e => onChange({ value: e.target.value, remove: false })} />
        {has && (state.remove
          ? <button type="button" onClick={() => onChange({ value: '', remove: false })}>Behalten</button>
          : <button type="button" className={styles.danger} onClick={() => { if (window.confirm(`${label} wirklich entfernen?`)) onChange({ value: '', remove: true }); }}>Entfernen</button>)}
      </span>
      {hint && <small id={hintId} className={styles.fieldHint}>{hint}</small>}
    </div>
  );
}
