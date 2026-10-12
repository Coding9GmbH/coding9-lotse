'use client';

import { useLayoutEffect, useRef } from 'react';
import type { PendingAttachment } from '@/hooks/useAttachments';
import { stopControl } from '@/lib/chat-state';
import { Button } from '@/components/ui/Button';
import styles from './Composer.module.css';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** Laufende Runde abbrechen */
  onStop?: () => void;
  /** Freigabe ist raus: der Shop-Schreibvorgang läuft und lässt sich nicht abbrechen */
  writing?: boolean;
  busy: boolean;
  placeholder: string;
  home: boolean;
  atts: PendingAttachment[];
  onFiles: (files: File[]) => void;
  onRemoveAtt: (key: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Gesperrt (z. B. solange Shop oder KI fehlen) */
  disabled?: boolean;
  /** Zeile unter dem Textfeld, bündig mit ihm (z. B. der Kontext) */
  extra?: React.ReactNode;
}

const MAX_H = 140;

/** Eingabe: wachsendes Textfeld, Enter sendet (Umschalt+Enter = Zeilenumbruch), Bilder per Knopf/Einfügen. */
export function Composer({ value, onChange, onSubmit, onStop, writing, busy, placeholder, home, atts, onFiles, onRemoveAtt, inputRef, extra, disabled = false }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const stop = stopControl(!!writing);

  useLayoutEffect(() => {
    const t = inputRef.current;
    if (!t) return;
    // Leer: Höhe aus dem CSS (wie im Server-HTML) – sonst wächst das Feld nach dem Laden auf die Platzhalter-Länge und die Seite springt
    if (!value) { t.style.height = ''; return; }
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight + 2, MAX_H)}px`;
  }, [value, home, inputRef]);

  return (
    <>
      {atts.length > 0 && (
        <div className={styles.atts} aria-label="Anhänge">
          {atts.map(a => (
            <div key={a.key} className={`${styles.att} ${a.uploading ? styles.up : ''}`} aria-busy={a.uploading}>
              {a.local
                // eslint-disable-next-line @next/next/no-img-element -- lokale Vorschau (blob:)
                ? <img src={a.local} alt={a.name} />
                : <span className={styles.doc} title={a.name}>📄<small>{a.name}</small></span>}
              <button type="button" title="Entfernen" aria-label={`${a.name} entfernen`} onClick={() => onRemoveAtt(a.key)}>×</button>
            </div>
          ))}
        </div>
      )}
      <form className={`${styles.form} ${home ? styles.home : ''}`} onSubmit={e => { e.preventDefault(); onSubmit(); }}>
        <Button className={styles.attach} disabled={disabled} title="Bilder oder Dateien anhängen: CSV, Excel, PDF, Text (auch per Einfügen oder Drag & Drop)" aria-label="Bilder oder Dateien anhängen"
          onClick={() => fileRef.current?.click()}>📎</Button>
        <input ref={fileRef} type="file" accept="image/*,.csv,.tsv,.txt,.md,.json,.xlsx,.xls,.pdf,.docx" multiple hidden
          onChange={e => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) onFiles(f); }} />
        <textarea ref={inputRef} rows={1} value={value} placeholder={placeholder} aria-label="Nachricht an Lotse" disabled={disabled}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSubmit(); } }}
          onPaste={e => { const f = [...(e.clipboardData?.files ?? [])]; if (f.length) { e.preventDefault(); onFiles(f); } }} />
        {busy && onStop
          ? <Button className={styles.send} onClick={stop.stops ? onStop : undefined} disabled={!stop.stops} title={stop.title}>{stop.label}</Button>
          : <Button type="submit" variant="primary" busy={busy} disabled={disabled} className={styles.send}>{busy ? 'Läuft …' : 'Senden'}</Button>}
        {extra && <div className={styles.extra}>{extra}</div>}
      </form>
    </>
  );
}
