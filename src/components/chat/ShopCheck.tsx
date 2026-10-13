'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { ago } from '@/lib/format';
import type { FixMap } from '@/lib/fixes';
import type { CheckFinding, ShopCheckState } from '@/lib/protocol';
import { countText, findingsView, groupByArea, runHealth, severityLabel, summaryText } from '@/lib/shopcheck';
import { INTL_LOCALE, type Locale, type Messages } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import { IconCheck } from '@/components/ui/icons';
import { CheckManager } from './CheckManager';
import styles from './ShopCheck.module.css';

const COLLAPSED = 3;
// Einmal je Bereich statt in jedem Befund
const AREA_NOTE = new Set(['Recht', 'Barrierefreiheit']); // Bereichsnamen kommen vom Server
const checkedText = (iso: string, locale: Locale, t: Messages['chat']['shopcheck']) => {
  const a = ago(iso, undefined, locale);
  return a === new Date(iso).toLocaleDateString(INTL_LOCALE[locale]) ? t.checkedOn(a) : t.checkedAgo(a);
};

interface Props {
  /** „Als Auftrag ins Feld“: füllt nur das Eingabefeld, es wird nichts gesendet */
  onFix: (f: CheckFinding) => void;
  /** Befunde, die schon in einem Chat bearbeitet werden */
  fixes?: FixMap;
  onOpenChat?: (id: string) => void;
  /** „Neue Prüfung im Chat“: füllt nur das Eingabefeld mit einem Anfang, gesendet wird nichts */
  onNewCheck?: (prompt: string) => void;
}

/** Startseite: was im Shop gerade nicht stimmt – kompakt (wichtigste zuerst), nach Bereich filterbar. */
export function ShopCheck({ onFix, fixes = {}, onOpenChat, onNewCheck }: Props) {
  const { locale, t: m } = useI18n(), t = m.chat.shopcheck;
  const [st, setSt] = useState<ShopCheckState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [area, setArea] = useState<string | null>(null);
  const [manage, setManage] = useState(false);

  const load = useCallback((start = false) => (start ? api.runShopCheck() : api.shopCheck())
    .then(s => { setSt(s); setErr(null); }, e => setErr(errorText(e))), []);

  // Erster Abruf; läuft eine Prüfung (auch im Hintergrund nach dem Besuch), regelmäßig nachsehen
  const running = !!st?.running;
  useEffect(() => {
    if (st && !running) return;
    const t = setTimeout(() => void load(), st ? 2500 : 0);
    return () => clearTimeout(t);
  }, [st, running, load]);

  if (st && !st.enabled) return null;
  const run = st?.run ?? null;
  const findings = run?.findings ?? [];
  const view = findingsView(findings, area, all, COLLAPSED), shown = view.shown;
  const failed = run?.errors.length ?? 0;
  const health = run ? runHealth(run) : 'ok';
  const fatal = !run && !running && (err || st?.error);
  const errTitle = run?.errors.map(e => `${e.check}: ${e.error}`).join('\n');

  return (
    <section className={styles.card} aria-label={t.title} aria-busy={running || undefined}>
      <header className={styles.head}>
        <div className={styles.title}>
          <b>{t.title}</b>
          {run && (findings.length || health === 'ok'
            ? <span className={findings.length ? styles.sum : `${styles.sum} ${styles.sumOk}`}>{summaryText(findings, locale)}</span>
            : <span className={`${styles.sum} ${styles.sumWarn}`}>{t.incomplete}</span>)}
        </div>
        <div className={styles.meta}>
          {running ? <span className={styles.runningTxt}><span className={styles.spin} aria-hidden />{t.running}</span>
            : run && <time dateTime={run.checkedAt} suppressHydrationWarning>{checkedText(run.checkedAt, locale, t)}</time>}
          <Button size="sm" variant="ghost" onClick={() => setManage(true)} disabled={!st}>{t.manage}</Button>
          <Button size="sm" onClick={() => void load(true)} disabled={running || !st} busy={running}>{t.recheck}</Button>
        </div>
      </header>

      {!run && running && (
        <div className={styles.skeleton} aria-label={t.runningAria}>
          {[0, 1, 2].map(i => <div key={i}><span /><span /><span /></div>)}
        </div>
      )}
      {!st && !err && <div className={styles.skeleton} aria-hidden><div><span /><span /><span /></div></div>}

      {fatal && (
        <div className={styles.error}>
          {t.fatal} {err || st?.error}
          <Button size="sm" onClick={() => void load(!err)}>{m.common.retry}</Button>
        </div>
      )}

      {run && (health === 'unvollstaendig' || (failed > 0 && !findings.length)) && (
        <div className={styles.warn} title={errTitle}>
          <span><b>{t.incompleteLabel}</b> {t.failedOf(failed, run.checks ?? failed)}{findings.length ? t.morePossible : t.cannotTell}</span>
          <Button size="sm" onClick={() => void load(true)} disabled={running}>{m.common.retry}</Button>
        </div>
      )}

      {run && !findings.length && !failed && (
        <div className={styles.ok}>
          <span className={styles.okIcon}><IconCheck size={18} /></span>
          <div><b>{t.allGood}</b><p>{t.noFindings(run.checks ?? 0)}</p></div>
        </div>
      )}

      {view.tabs.length > 0 && (
        <div className={styles.tabs} role="tablist" aria-label={t.areasAria}>
          <button type="button" role="tab" aria-selected={!view.area} onClick={() => { setArea(null); setAll(false); }}>{t.all} <span>{findings.length}</span></button>
          {view.tabs.map(t => (
            <button key={t.area} type="button" role="tab" aria-selected={view.area === t.area} onClick={() => { setArea(t.area); setAll(false); }}>{t.area} <span>{t.count}</span></button>
          ))}
        </div>
      )}

      {shown.length > 0 && groupByArea(shown).map(([group, list]) => (
        <div key={group} className={styles.group}>
          <h4>{group}{AREA_NOTE.has(group) && <small>{t.legalNote}</small>}</h4>
          {list.map(f => {
            const fix = fixes[f.id];
            return (
            <div key={f.id} className={styles.row}>
              <span className={`${styles.sev} ${styles[f.severity]}`}>{severityLabel(f.severity, locale)}</span>
              <div className={styles.body}>
                <div className={styles.line}><b>{f.title}</b><span className={styles.count}>{countText(f, locale)}</span></div>
                {f.hint && <p className={styles.hint} title={f.hint}>{f.hint}</p>}
                {!!f.sample?.length && (
                  <details className={styles.samples}>
                    <summary>{t.samples(f.sample.length)}</summary>
                    <ul>{f.sample.map(s => <li key={s.id}>{s.label}</li>)}</ul>
                  </details>
                )}
              </div>
              {fix && onOpenChat ? (
                <span className={styles.fixing}>
                  <span className={styles.badge} title={t.inProgressSince(ago(fix.at, undefined, locale))} suppressHydrationWarning>{t.inProgress}</span>
                  <Button size="sm" className={styles.fix} onClick={() => onOpenChat(fix.chatId)} title={t.openChatTitle(fix.title)}>{t.openChat}</Button>
                </span>
              ) : (
                <Button size="sm" variant={f === findings[0] ? 'primary' : undefined} className={styles.fix} onClick={() => onFix(f)} title={t.fixTitle}>{t.fix}</Button>
              )}
            </div>
            );
          })}
        </div>
      ))}

      {(view.more || (health === 'teilweise' && findings.length > 0)) && (
        <footer className={styles.foot}>
          {view.more && <button type="button" className={styles.more} onClick={() => setAll(!all)}>{all ? t.showLess : t.showAll(view.total)}</button>}
          {health === 'teilweise' && findings.length > 0 && <small title={errTitle}>{t.noResult(failed)}</small>}
        </footer>
      )}
      <CheckManager open={manage} onClose={() => setManage(false)} onChanged={() => void load()}
        onNew={() => onNewCheck?.(t.newCheckPrompt)} />
    </section>
  );
}
