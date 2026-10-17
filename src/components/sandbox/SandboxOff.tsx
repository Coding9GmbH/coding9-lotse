'use client';

import Link from 'next/link';
import type { SandboxStatus } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import styles from './Sandbox.module.css';

/** Notice while Sandbox Coding is off; the server message only when it says more than "switched off in the settings". */
export function SandboxOff({ status }: { status: SandboxStatus }) {
  const t = useI18n().t.sandbox.off;
  return (
    <section className={styles.card} aria-labelledby="sbx-off">
      <div className={styles.cardHead}><h2 id="sbx-off">{t.title}</h2></div>
      <p className={styles.hint}>{t.text}</p>
      {status.reason !== 'off' && status.message && <p className={styles.alert}>{status.message}</p>}
      <Link className={styles.linkBtn} href="/settings/sandbox">{t.open}</Link>
    </section>
  );
}
