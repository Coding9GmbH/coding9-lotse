'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { FixMap } from '@/lib/fixes';
import type { SeoItem, SeoOverview } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import styles from './ShopCheck.module.css';
import own from './SeoCard.module.css';

const TOP = 3;
/** Urgency: real losses, then technical errors, own pages competing, just short of page 1, other levers, warnings last */
const rank = (i: SeoItem) => (i.kind === 'decline' ? 0 : i.kind === 'site' ? (i.impact >= 20_000 ? 1 : i.impact >= 5_000 ? 4 : 5) : i.kind === 'onpage' ? (i.impact >= 10_000 ? 1 : 5) : i.kind === 'cannibal' ? 2 : i.kind === 'striking' ? 3 : 4);

export interface FixTask { id: string; title: string; prompt: string }

/** Workspace: the most important open SEO levers from the saved state of the SEO section (never refetches, costs no credits). */
export function SeoCard({ onTask, fixes, onOpenChat }: { onTask: (t: FixTask) => void; fixes: FixMap; onOpenChat: (id: string) => void }) {
  const { t: all } = useI18n(), t = all.seo;
  const [o, setO] = useState<SeoOverview | null | undefined>(undefined);
  useEffect(() => {
    let off = false;
    api.seoStored().then(r => { if (!off) setO(r); }, () => { if (!off) setO(null); });
    return () => { off = true; };
  }, []);
  if (o === undefined) return null;
  // open = not done/ignored, by urgency, then by impact
  const open = (o?.items ?? []).filter(i => !i.mark).sort((a, b) => rank(a) - rank(b) || b.impact - a.impact);
  const row = (i: SeoItem) => {
    const fix = fixes[i.id];
    return (
      <div key={i.id} className={`${styles.row} ${own.row}`}>
        <span className={`${styles.sev} ${styles[rank(i) <= 1 ? 'hoch' : i.kind === 'onpage' || (i.kind === 'site' && rank(i) === 4) ? 'mittel' : 'niedrig']}`}>{t.kinds[i.kind]}</span>
        <div className={styles.body}>
          <div className={styles.line}><b>{i.title}</b></div>
          <p className={styles.hint}>{i.detail}</p>
        </div>
        {fix ? (
          <span className={styles.fixing}>
            <span className={styles.badge}>{t.inProgress}</span>
            <Button size="sm" className={styles.fix} onClick={() => onOpenChat(fix.chatId)} title={fix.title}>{t.openChat}</Button>
          </span>
        ) : <Button size="sm" className={styles.fix} onClick={() => onTask({ id: i.id, title: i.title, prompt: i.prompt })} title={t.optimizeTitle}>{t.optimize}</Button>}
      </div>
    );
  };
  return (
    <section className={styles.card} aria-labelledby="seo-card-h">
      <header className={styles.head}>
        <div className={styles.title}>
          <b id="seo-card-h">{t.home.title}</b>
          {o && <span className={open.length ? styles.sum : `${styles.sum} ${styles.sumOk}`}>{open.length ? t.home.summary(open.length) : t.home.allDone}</span>}
        </div>
        <div className={styles.meta}>
          <Link href="/seo" className={styles.more}>{o ? t.home.all : t.home.fetch}</Link>
        </div>
      </header>
      {open.length > 0 && <div className={styles.group}>{open.slice(0, TOP).map(row)}</div>}
    </section>
  );
}
