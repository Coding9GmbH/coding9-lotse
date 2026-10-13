'use client';

import { useId } from 'react';
import type { SecretInput } from '@/lib/settings-form';
import { useT } from '@/lib/i18n/I18nProvider';
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
  const t = useT().settings.secret;
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={styles.field}>
      <span className={styles.labelRow}>
        <label htmlFor={id} className={styles.label}>{label}</label>
        {has && !state.remove && <span className={styles.savedTag}>{t.saved}</span>}
        {state.remove && <span className={styles.removeTag}>{t.removing}</span>}
      </span>
      <span className={styles.secretRow}>
        <input id={id} type="password" autoComplete={autoComplete} spellCheck={false} aria-describedby={hint ? hintId : undefined}
          value={state.value} disabled={state.remove}
          placeholder={state.remove ? t.removingPlaceholder : has ? t.keepPlaceholder : placeholder}
          onChange={e => onChange({ value: e.target.value, remove: false })} />
        {has && (state.remove
          ? <button type="button" onClick={() => onChange({ value: '', remove: false })}>{t.keep}</button>
          : <button type="button" className={styles.danger} onClick={() => { if (window.confirm(t.confirmRemove(label))) onChange({ value: '', remove: true }); }}>{t.remove}</button>)}
      </span>
      {hint && <small id={hintId} className={styles.fieldHint}>{hint}</small>}
    </div>
  );
}
