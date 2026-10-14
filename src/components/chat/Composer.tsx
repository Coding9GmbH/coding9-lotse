'use client';

import { useLayoutEffect, useRef } from 'react';
import type { PendingAttachment } from '@/hooks/useAttachments';
import { stopControl } from '@/lib/chat-state';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/lib/i18n/I18nProvider';
import styles from './Composer.module.css';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** Cancel the running turn */
  onStop?: () => void;
  /** Approval is sent: the shop write is running and cannot be cancelled */
  writing?: boolean;
  busy: boolean;
  placeholder: string;
  home: boolean;
  atts: PendingAttachment[];
  onFiles: (files: File[]) => void;
  onRemoveAtt: (key: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Disabled (e.g. while shop or AI are missing) */
  disabled?: boolean;
  /** Row below the text field, aligned with it (e.g. the context) */
  extra?: React.ReactNode;
}

const MAX_H = 140;

/** Input: growing text field, Enter sends (Shift+Enter = line break), images via button/paste. */
export function Composer({ value, onChange, onSubmit, onStop, writing, busy, placeholder, home, atts, onFiles, onRemoveAtt, inputRef, extra, disabled = false }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { locale, t: m } = useI18n(), t = m.chat.composer;
  const stop = stopControl(!!writing, locale);

  useLayoutEffect(() => {
    const t = inputRef.current;
    if (!t) return;
    // Empty: height from the CSS (as in the server HTML); otherwise the field grows to the placeholder length after load and the page jumps
    if (!value) { t.style.height = ''; return; }
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight + 2, MAX_H)}px`;
  }, [value, home, inputRef]);

  return (
    <>
      {atts.length > 0 && (
        <div className={styles.atts} aria-label={t.attachments}>
          {atts.map(a => (
            <div key={a.key} className={`${styles.att} ${a.uploading ? styles.up : ''}`} aria-busy={a.uploading}>
              {a.local
                // eslint-disable-next-line @next/next/no-img-element -- lokale Vorschau (blob:)
                ? <img src={a.local} alt={a.name} />
                : <span className={styles.doc} title={a.name}>📄<small>{a.name}</small></span>}
              <button type="button" title={t.remove} aria-label={t.removeAria(a.name)} onClick={() => onRemoveAtt(a.key)}>×</button>
            </div>
          ))}
        </div>
      )}
      <form className={`${styles.form} ${home ? styles.home : ''}`} onSubmit={e => { e.preventDefault(); onSubmit(); }}>
        <Button className={styles.attach} disabled={disabled} title={t.attachTitle} aria-label={t.attachAria}
          onClick={() => fileRef.current?.click()}>📎</Button>
        <input ref={fileRef} type="file" accept="image/*,.csv,.tsv,.txt,.md,.json,.xlsx,.xls,.pdf,.docx" multiple hidden
          onChange={e => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) onFiles(f); }} />
        <textarea ref={inputRef} rows={1} value={value} placeholder={placeholder} aria-label={t.inputAria} disabled={disabled}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSubmit(); } }}
          onPaste={e => { const f = [...(e.clipboardData?.files ?? [])]; if (f.length) { e.preventDefault(); onFiles(f); } }} />
        {busy && onStop
          ? <Button className={styles.send} onClick={stop.stops ? onStop : undefined} disabled={!stop.stops} title={stop.title}>{stop.label}</Button>
          : <Button type="submit" variant="primary" busy={busy} disabled={disabled} className={styles.send}>{busy ? t.running : t.send}</Button>}
        {extra && <div className={styles.extra}>{extra}</div>}
      </form>
    </>
  );
}
