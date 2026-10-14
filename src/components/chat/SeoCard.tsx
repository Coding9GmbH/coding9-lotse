'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { FixMap } from '@/lib/fixes';
import type { SeoItem, SeoOverview } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import { seoGroup } from '@/components/seo/groups';
import styles from './ShopCheck.module.css';

const TOP = 3;
const ORDER = { tech: 0, keyword: 1, content: 2, check: 3 } as const;

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
  // offen = nicht erledigt/ignoriert; technische Fehler zuerst, dann Keywords, dann Search Console (je Quelle nach Wirkung)
  const open = (o?.items ?? []).filter(i => !i.mark).map((i, n) => ({ i, n }))
    .sort((a, b) => ORDER[seoGroup(a.i)] - ORDER[seoGroup(b.i)] || (b.i.impact >= 10_000 ? 1 : 0) - (a.i.impact >= 10_000 ? 1 : 0) || a.n - b.n).map(x => x.i);
  const row = (i: SeoItem) => {
    const fix = fixes[i.id];
    return (
      <div key={i.id} className={styles.row}>
        <span className={`${styles.sev} ${styles[i.kind === 'onpage' ? (i.impact >= 10_000 ? 'hoch' : 'mittel') : 'niedrig']}`}>{t.kinds[i.kind]}</span>
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
