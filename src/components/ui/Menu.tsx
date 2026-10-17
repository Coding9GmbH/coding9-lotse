'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { IconMore } from './icons';
import styles from './Menu.module.css';

export interface MenuItem {
  key: string;
  label: React.ReactNode;
  onSelect?: () => void;
  /** a link instead of an action */ href?: string;
  /** opens in a new tab (only with href) */ external?: boolean;
  disabled?: boolean;
  danger?: boolean;
}

/** Overflow menu ("⋯"): a button with a popup list of actions or links. Closes on Escape, a click outside and after a choice. */
export function Menu({ label, items, className, align = 'end' }: { label: string; items: MenuItem[]; className?: string; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    ref.current?.querySelector<HTMLElement>('[role=menuitem]:not([aria-disabled=true])')?.focus();
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  const move = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([aria-disabled=true])') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  };
  if (!items.length) return null;
  return (
    <div ref={ref} className={[styles.menu, className].filter(Boolean).join(' ')}>
      <button ref={btn} type="button" className={styles.trigger} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={label} title={label} onClick={() => setOpen(o => !o)}><IconMore size={18} /></button>
      {open && (
        <ul id={id} role="menu" aria-label={label} className={styles.list} data-align={align} onKeyDown={move}>
          {items.map(it => (
            <li key={it.key} role="none">
              {it.href
                ? <a role="menuitem" href={it.href} className={styles.item} {...(it.external ? { target: '_blank', rel: 'noopener' } : {})} onClick={() => setOpen(false)}>{it.label}</a>
                : <button type="button" role="menuitem" className={`${styles.item} ${it.danger ? styles.danger : ''}`} aria-disabled={it.disabled || undefined}
                  onClick={() => { if (it.disabled) return; setOpen(false); it.onSelect?.(); }}>{it.label}</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
