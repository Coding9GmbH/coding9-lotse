'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { IconMenu } from '@/components/ui/icons';
import { useShell } from './ShellProvider';
import { SideNav } from './SideNav';
import styles from './AppShell.module.css';

/** App-Hülle: Navigation links (ein-/ausklappbar), Inhalt rechts; mobil Kopfzeile + Schublade. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { collapsed, mobileOpen, setMobileOpen } = useShell();
  const path = usePathname();

  useEffect(() => { setMobileOpen(false); }, [path, setMobileOpen]);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, setMobileOpen]);

  return (
    <div className={styles.shell} data-collapsed={collapsed || undefined}>
      <header className={styles.mobileBar}>
        <button type="button" className={styles.menu} onClick={() => setMobileOpen(true)} aria-label="Navigation öffnen"
          aria-expanded={mobileOpen} aria-controls="lotse-nav"><IconMenu size={20} /></button>
        <Link href="/" className={styles.mobileBrand}>
          {/* eslint-disable-next-line @next/next/no-img-element -- kleines SVG-Logo */}
          <img src="/lotse-mark.svg" alt="" width={26} height={26} />Lotse
        </Link>
      </header>
      <SideNav />
      {mobileOpen && <div className={styles.backdrop} onClick={() => setMobileOpen(false)} aria-hidden="true" />}
      <div className={styles.content}>{children}</div>
    </div>
  );
}
