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
/** Dringlichkeit: echte Verluste, dann technische Fehler, eigene Seiten im Wettbewerb, kurz vor Seite 1, übrige Hebel, zuletzt Warnungen */
const rank = (i: SeoItem) => (i.kind === 'decline' ? 0 : i.kind === 'onpage' ? (i.impact >= 10_000 ? 1 : 5) : i.kind === 'cannibal' ? 2 : i.kind === 'striking' ? 3 : 4);

export interface FixTask { id: string; title: string; prompt: string }

/** Arbeitsfläche: die wichtigsten offenen SEO-Hebel aus dem gespeicherten Stand des SEO-Bereichs (holt nie neu, kostet keine Credits). */
export function SeoCard({ onTask, fixes, onOpenChat }: { onTask: (t: FixTask) => void; fixes: FixMap; onOpenChat: (id: string) => void }) {
  const { t: all } = useI18n(), t = all.seo;
  const [o, setO] = useState<SeoOverview | null | undefined>(undefined);
  useEffect(() => {
    let off = false;
    api.seoStored().then(r => { if (!off) setO(r); }, () => { if (!off) setO(null); });
    return () => { off = true; };
  }, []);
  if (o === undefined) return null;
  // offen = nicht erledigt/ignoriert, nach Dringlichkeit, dann nach Wirkung
  const open = (o?.items ?? []).filter(i => !i.mark).sort((a, b) => rank(a) - rank(b) || b.impact - a.impact);
  const row = (i: SeoItem) => {
    const fix = fixes[i.id];
    return (
      <div key={i.id} className={`${styles.row} ${own.row}`}>
        <span className={`${styles.sev} ${styles[(i.kind === 'onpage' && i.impact >= 10_000) || i.kind === 'decline' ? 'hoch' : i.kind === 'onpage' ? 'mittel' : 'niedrig']}`}>{t.kinds[i.kind]}</span>
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
