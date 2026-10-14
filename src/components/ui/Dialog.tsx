'use client';

import { useEffect, useId, useRef } from 'react';
import { useT } from '@/lib/i18n/I18nProvider';
import styles from './Dialog.module.css';

interface Props { open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }

/** Modal dialog based on the native <dialog> (focus trap, Esc and backdrop handled by the browser). */
export function Dialog({ open, onClose, title, children, footer, wide }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const t = useT();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className={[styles.dialog, wide && styles.wide].filter(Boolean).join(' ')} aria-labelledby={titleId}
      onClose={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      {open && (
        <>
          <div className={styles.head}>
            <h2 id={titleId}>{title}</h2>
            <button type="button" onClick={onClose}>{t.common.close}</button>
          </div>
          <div className={styles.body}>{children}</div>
          {footer && <div className={styles.foot}>{footer}</div>}
        </>
      )}
    </dialog>
  );
}
