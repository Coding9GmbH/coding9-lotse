'use client';

import { useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { SeoImpact, SeoImpactList } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { INTL_LOCALE } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { useShell } from '@/components/shell/ShellProvider';
import styles from './Seo.module.css';

const COLLAPSED = 5;
const SEV: Partial<Record<NonNullable<SeoImpact['verdict']>, 'hoch' | 'niedrig'>> = { worse: 'hoch', better: 'niedrig' };

/** Impact of applied changes (Search Console): stored measurements; "Jetzt messen" asks Google for the open ones. */
export function ImpactSection({ data, onChange }: { data: SeoImpactList; onChange: (d: SeoImpactList) => void }) {
  const { t: all, locale } = useI18n(), t = all.seo.impact;
  const shell = useShell();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [open, setOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString(INTL_LOCALE[locale], { timeZone: 'UTC' });
  const num = (n: number) => n.toLocaleString(INTL_LOCALE[locale], { maximumFractionDigits: 2 });
  const measure = async () => {
    setBusy(true); setError(''); setInfo('');
    try { const r = await api.seoImpactMeasure(); onChange(r); setInfo(t.measured(r.measured)); if (r.failed.length) setError(r.failed[0].error); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const dismiss = async (id: string, dismissed: boolean) => {
    try { onChange(await api.seoImpactDismiss(id, dismissed)); } catch (e) { setError(errorText(e)); }
  };

  const hiddenCount = data.items.filter(i => i.dismissed).length;
  const list = data.items.filter(i => showHidden || !i.dismissed), cut = !open && list.length > COLLAPSED ? list.slice(0, COLLAPSED) : list;
  const due = data.items.some(i => !i.dismissed && i.status === 'preliminary');

  const row = (i: SeoImpact) => {
    const sev = i.verdict && i.status !== 'superseded' ? SEV[i.verdict] : undefined;
    const fields = [...new Set(i.fields.map(f => t.fields[f] ?? f))].join(', ');
    const status = i.status === 'too-early' ? `${t.measurableFrom(day(i.measurableFrom))}, ${t.completeFrom(day(i.completeFrom))}`
      : i.status === 'preliminary' ? `${t.status.preliminary} · ${t.completeFrom(day(i.completeFrom))}` : t.status[i.status];
    return (
      <li key={i.id} className={`${styles.item}${i.dismissed ? ` ${styles.marked}` : ''}`}>
        <div className={styles.main}>
          <span className={styles.kindRow}>
            {i.verdict && i.status !== 'superseded' && <span className={`${styles.sev} ${styles[sev ?? 'mittel']}`}>{t.verdict[i.verdict]}</span>}
            <span className={styles.kind}>{t.kinds[i.kind]}</span>
            <span className={styles.markTag}>{status}</span>
          </span>
          <b>{i.label}</b>
          <span className={styles.detail}>{t.changed(day(i.changedAt))} · {fields}</span>
          <ul className={styles.metrics}>
            <li><small>{t.before}</small> <span>{num(i.before.clicksPerDay)} {t.clicksPerDay}</span></li>
            {i.change && <>
              <li><small>{t.clicksPerDay}</small> <span>{i.change.clicksPerDay}</span></li>
              <li><small>{t.ctr}</small> <span>{i.change.ctr}</span></li>
              <li><small>{t.position}</small> <span>{i.change.position > 0 ? '+' : i.change.position === 0 ? '±' : ''}{num(i.change.position)}</span></li>
            </>}
          </ul>
          {i.status === 'superseded' && <span className={styles.detail}>{t.supersededHint}</span>}
          {i.drift && <span className={styles.detail}>{t.drift}</span>}
          {i.verdict === 'worse' && i.status !== 'superseded' && !i.drift && <span className={styles.detail}>{t.worseHint}</span>}
        </div>
        <div className={styles.actions}>
          {i.chatId && <Button size="sm" variant={i.verdict === 'worse' && !i.dismissed ? 'primary' : 'default'} title={t.toChatTitle} onClick={() => shell.nav.openChat(i.chatId!)}>{t.toChat}</Button>}
          <span className={styles.quiet}>
            <button type="button" onClick={() => void dismiss(i.id, !i.dismissed)}>{i.dismissed ? t.restore : t.dismiss}</button>
          </span>
        </div>
      </li>
    );
  };

  return (
    <section className={styles.card} aria-labelledby="seo-impact">
      <div className={styles.cardHead}>
        <h2 id="seo-impact">{t.title} <span className={styles.count}>{data.items.filter(i => !i.dismissed).length}</span></h2>
        <span className={styles.hint}>{t.hint}</span>
        <Button size="sm" className={styles.headAction} variant={due ? 'primary' : 'default'} onClick={() => void measure()} busy={busy} disabled={busy || !data.items.length} title={t.measureTitle}>{busy ? t.measuring : t.measure}</Button>
      </div>
      {error && <p className={styles.bad} role="alert">{error}</p>}
      {info && !error && <p className={styles.muted} role="status">{info}</p>}
      {cut.length ? <ul className={styles.list}>{cut.map(row)}</ul> : <p className={styles.muted}>{t.empty}</p>}
      {list.length > COLLAPSED && <button type="button" className={styles.more} onClick={() => setOpen(o => !o)}>{open ? all.seo.showLess : all.seo.showAll(list.length)}</button>}
      <p className={styles.foot}>
        {hiddenCount > 0 && <button type="button" className={styles.more} onClick={() => setShowHidden(s => !s)}>{showHidden ? t.hideHidden : t.hidden(hiddenCount)}</button>}
        <span>{t.note}</span>
      </p>
    </section>
  );
}
