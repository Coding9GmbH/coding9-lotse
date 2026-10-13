'use client';

import { useEffect, useRef } from 'react';
import { inertExcept } from '@/lib/a11y';
import { useT } from '@/lib/i18n/I18nProvider';
import type { CategoryRow, Target } from '@/lib/protocol';
import { IconClose, IconTarget } from '@/components/ui/icons';
import { ContextPicker } from './ContextPicker';
import styles from './ContextPanel.module.css';

interface Props { open: boolean; onClose: () => void; categories: CategoryRow[] | null; categoryError?: string | null; target: Target | null; onSelect: (t: Target | null) => void }

/** Ausklappbares Panel neben der Navigation: Kontext (Kategorie, Produkt, Landingpage) wählen. */
export function ContextPanel({ open, onClose, categories, categoryError = null, target, onSelect }: Props) {
  const ref = useRef<HTMLElement>(null);
  const t = useT().context;

  useEffect(() => {
    if (!open) return;
    const trigger = document.getElementById('lotse-context');
    const panel = ref.current;
    panel?.querySelector<HTMLElement>('input, button')?.focus();
    const release = panel ? inertExcept(panel) : () => {};
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      release();
      if (trigger instanceof HTMLElement) trigger.focus();
    };
  }, [open, onClose]);

  return (
    <>
      {open && <div className={styles.scrim} data-dismiss="" onClick={onClose} aria-hidden="true" />}
      <aside ref={ref} className={styles.panel} data-open={open || undefined} aria-label={t.panel.aria} aria-hidden={!open} inert={!open}>
        <div className={styles.head}>
          <span className={styles.icon}><IconTarget size={17} /></span>
          <div className={styles.title}>
            <b>{t.label}</b>
            <small>{t.panel.sub}</small>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label={t.panel.close}><IconClose size={18} /></button>
        </div>
        {target && (
          <div className={styles.current}>
            <span>{t.panel.selected} <b>{target.name ?? t.newLanding}</b></span>
            <button type="button" onClick={() => onSelect(null)}>{t.panel.remove}</button>
          </div>
        )}
        <ContextPicker id="context-picker" categories={categories} categoryError={categoryError} target={target} onSelect={x => { onSelect(x); onClose(); }} />
      </aside>
    </>
  );
}
