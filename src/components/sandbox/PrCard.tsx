'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { PrStatus, TaskPr } from '@/lib/protocol';
import styles from './CodeCards.module.css';

/** A task's pull request: "#42 Titel – offen", checks of the head commit and the link. The state comes from GitHub (cached on
 *  the server); until it arrives, or if GitHub cannot be asked, the card shows what Lotse knows. `refresh` reloads it. */
export function PrCard({ taskId, pr, done, refresh = 0 }: { taskId: string; pr: TaskPr; /** chat card: what the click did */ done?: { action: 'created' | 'updated'; files: number }; refresh?: number }) {
  const t = useI18n().t.sandbox.code.pr;
  const [live, setLive] = useState<PrStatus | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let off = false;
    api.sandbox.prStatus(taskId).then(r => { if (!off) { setLive(r.pr?.number === pr.number ? r.pr : null); setStale(false); } }, () => { if (!off) setStale(true); });
    return () => { off = true; };
  }, [taskId, pr.number, refresh]);
  const state = live?.state ?? 'open', title = live?.title || pr.title, c = live?.checks;
  return (
    <section className={styles.pr} aria-label={t.aria(pr.number, title)}>
      {done && <h3>{t.done[done.action]} · {t.changedFiles(done.files)}</h3>}
      <p className={styles.prHead}>
        <b>#{pr.number}</b> <span className={styles.prTitle}>{title}</span>
        <span className={`${styles.prState} ${styles[`pr_${state}`]}`}>{t.state[state]}{live?.draft ? ` · ${t.draft}` : ''}</span>
      </p>
      {c && <p className={styles.pubNote}>{t.checksLabel}: {t.checks(c.success, c.failure, c.pending)}</p>}
      {stale && <p className={styles.pubNote}>{t.stale}</p>}
      <a className={styles.prLink} href={live?.url ?? pr.url} target="_blank" rel="noopener noreferrer">{t.open}</a>
    </section>
  );
}
