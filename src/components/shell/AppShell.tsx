'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { inertExcept } from '@/lib/a11y';
import { IconMenu } from '@/components/ui/icons';
import { useT } from '@/lib/i18n/I18nProvider';
import { useShell } from './ShellProvider';
import { SideNav } from './SideNav';
import styles from './AppShell.module.css';

/** App shell: navigation on the left (collapsible), content on the right; on mobile a header bar + drawer. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { collapsed, mobileOpen, setMobileOpen } = useShell();
  const path = usePathname();
  const menuRef = useRef<HTMLButtonElement>(null);
  const t = useT();

  useEffect(() => { setMobileOpen(false); }, [path, setMobileOpen]);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, setMobileOpen]);
  useEffect(() => {
    if (!mobileOpen) return;
    const nav = document.getElementById('lotse-nav');
    if (!nav) return;
    const release = inertExcept(nav);
    const menu = menuRef.current;
    nav.querySelector<HTMLElement>('a, button')?.focus();
    return () => {
      release();
      menu?.focus();
    };
  }, [mobileOpen]);

  return (
    <div className={styles.shell} data-collapsed={collapsed || undefined}>
      <header className={styles.mobileBar}>
        <button type="button" ref={menuRef} className={styles.menu} onClick={() => setMobileOpen(true)} aria-label={t.nav.open}
          aria-expanded={mobileOpen} aria-controls="lotse-nav"><IconMenu size={20} /></button>
        <Link href="/" className={styles.mobileBrand}>
          {/* eslint-disable-next-line @next/next/no-img-element -- small SVG logo */}
          <img src="/lotse-mark.svg" alt="" width={26} height={26} />Lotse
        </Link>
      </header>
      <SideNav />
      {mobileOpen && <div className={styles.backdrop} data-dismiss="" onClick={() => setMobileOpen(false)} aria-hidden="true" />}
      <div className={styles.content}>{children}</div>
    </div>
  );
}
