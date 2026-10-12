'use client';

import { useEffect, useRef } from 'react';
import type { CategoryRow, Target } from '@/lib/protocol';
import { IconClose, IconTarget } from '@/components/ui/icons';
import { ContextPicker } from './ContextPicker';
import styles from './ContextPanel.module.css';

interface Props { open: boolean; onClose: () => void; categories: CategoryRow[] | null; target: Target | null; onSelect: (t: Target | null) => void }

/** Ausklappbares Panel neben der Navigation: Kontext (Kategorie, Produkt, Landingpage) wählen. */
export function ContextPanel({ open, onClose, categories, target, onSelect }: Props) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      {open && <div className={styles.scrim} onClick={onClose} aria-hidden="true" />}
      <aside ref={ref} className={styles.panel} data-open={open || undefined} aria-label="Kontext wählen" aria-hidden={!open} inert={!open}>
        <div className={styles.head}>
          <span className={styles.icon}><IconTarget size={17} /></span>
          <div className={styles.title}>
            <b>Kontext</b>
            <small>Worauf soll sich der Chat beziehen? Optional.</small>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Kontext schließen"><IconClose size={18} /></button>
        </div>
        {target && (
          <div className={styles.current}>
            <span>Gewählt: <b>{target.name ?? 'Neue Landingpage'}</b></span>
            <button type="button" onClick={() => onSelect(null)}>Entfernen</button>
          </div>
        )}
        <ContextPicker id="context-picker" categories={categories} target={target} onSelect={t => { onSelect(t); onClose(); }} />
      </aside>
    </>
  );
}
