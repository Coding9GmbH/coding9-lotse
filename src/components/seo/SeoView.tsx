'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { SeoItem, SeoOverview } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { INTL_LOCALE } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { useShell } from '@/components/shell/ShellProvider';
import styles from './Seo.module.css';

/** SEO-Übersicht: Hebel aus Search Console und Sistrix; „Optimieren“ legt den fertigen Auftrag in einen neuen Chat. */
export function SeoView() {
  const { t: all, locale } = useI18n(), t = all.seo;
  const shell = useShell();
  const [data, setData] = useState<SeoOverview | null>(null);
  const [error, setError] = useState('');
  const [run, setRun] = useState(0);
  useEffect(() => {
    let off = false;
    api.seoOverview().then(r => { if (!off) setData(r); }).catch(e => { if (!off) setError(errorText(e)); });
    return () => { off = true; };
  }, [run]);
  const load = () => { setError(''); setData(null); setRun(n => n + 1); };

  const none = data && !data.gsc && !data.sistrix;
  const groups = (['gsc', 'sistrix'] as const).filter(k => data?.[k]).map(k => ({ k, items: data!.items.filter(i => i.source === k) }));
  const card = (i: SeoItem) => (
    <li key={i.id} className={styles.item}>
      <div className={styles.main}>
        <span className={styles.kind}>{t.kinds[i.kind]}</span>
        <b>{i.title}</b>
        <span className={styles.detail}>{i.detail}</span>
        {!!i.metrics.length && <ul className={styles.metrics}>{i.metrics.map(m => <li key={m.label}><small>{m.label}</small> {m.value}</li>)}</ul>}
      </div>
      <Button variant="primary" size="sm" title={t.optimizeTitle} onClick={() => shell.nav.promptChat(i.prompt)}>{t.optimize}</Button>
    </li>
  );
  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <div className={styles.titleRow}>
          <h1 className={styles.h1}>{t.title}</h1>
          <Button size="sm" onClick={load}>{t.refresh}</Button>
        </div>
        <p className={styles.lead}>{t.lead}</p>
        {error && <p className={styles.bad} role="alert">{t.failed(error)}</p>}
        {!data && !error && <p className={styles.muted}>{t.loading}</p>}
        {none && <div className={styles.card}><p>{t.noSource}</p><Link href="/settings" className={styles.link}>{t.toSettings}</Link></div>}
        {data?.errors.map(e => <p key={e.source} className={styles.bad} role="alert">{t.sourceFailed(t.sources[e.source], e.error)}</p>)}
        {groups.map(g => (
          <section key={g.k} className={styles.card} aria-labelledby={`seo-${g.k}`}>
            <div className={styles.cardHead}><h2 id={`seo-${g.k}`}>{t.groups[g.k].title}</h2><span className={styles.hint}>{t.groups[g.k].hint}</span></div>
            {g.items.length ? <ul className={styles.list}>{g.items.map(card)}</ul> : <p className={styles.muted}>{t.empty}</p>}
          </section>
        ))}
        {data && !none && (
          <p className={styles.foot}>{t.disclaimer} {t.generated(new Date(data.generatedAt).toLocaleTimeString(INTL_LOCALE[locale], { hour: '2-digit', minute: '2-digit' }))}</p>
        )}
      </div>
    </div>
  );
}
