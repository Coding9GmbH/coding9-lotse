'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { ago } from '@/lib/format';
import type { FixMap } from '@/lib/fixes';
import type { CheckFinding, ShopCheckState } from '@/lib/protocol';
import { countText, findingsView, groupByArea, runHealth, SEVERITY_LABEL, summaryText } from '@/lib/shopcheck';
import { Button } from '@/components/ui/Button';
import { IconCheck } from '@/components/ui/icons';
import styles from './ShopCheck.module.css';

const COLLAPSED = 3;
// Einmal je Bereich statt in jedem Befund
const AREA_NOTE: Record<string, string> = { Recht: 'Technische Prüfung, keine Rechtsberatung', Barrierefreiheit: 'Technische Prüfung, keine Rechtsberatung' };
const checkedText = (iso: string) => { const a = ago(iso); return /^(vor|gerade)/.test(a) ? `geprüft ${a}` : `geprüft am ${a}`; };

interface Props {
  /** „Als Auftrag ins Feld“: füllt nur das Eingabefeld, es wird nichts gesendet */
  onFix: (f: CheckFinding) => void;
  /** Befunde, die schon in einem Chat bearbeitet werden */
  fixes?: FixMap;
  onOpenChat?: (id: string) => void;
}

/** Startseite: was im Shop gerade nicht stimmt – kompakt (wichtigste zuerst), nach Bereich filterbar. */
export function ShopCheck({ onFix, fixes = {}, onOpenChat }: Props) {
  const [st, setSt] = useState<ShopCheckState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [area, setArea] = useState<string | null>(null);

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
    <section className={styles.card} aria-label="Shop-Check" aria-busy={running || undefined}>
      <header className={styles.head}>
        <div className={styles.title}>
          <b>Shop-Check</b>
          {run && (findings.length || health === 'ok'
            ? <span className={findings.length ? styles.sum : `${styles.sum} ${styles.sumOk}`}>{summaryText(findings)}</span>
            : <span className={`${styles.sum} ${styles.sumWarn}`}>unvollständig</span>)}
        </div>
        <div className={styles.meta}>
          {running ? <span className={styles.runningTxt}><span className={styles.spin} aria-hidden />prüfe den Shop …</span>
            : run && <time dateTime={run.checkedAt} suppressHydrationWarning>{checkedText(run.checkedAt)}</time>}
          <Button size="sm" onClick={() => void load(true)} disabled={running || !st} busy={running}>Neu prüfen</Button>
        </div>
      </header>

      {!run && running && (
        <div className={styles.skeleton} aria-label="Prüfung läuft">
          {[0, 1, 2].map(i => <div key={i}><span /><span /><span /></div>)}
        </div>
      )}
      {!st && !err && <div className={styles.skeleton} aria-hidden><div><span /><span /><span /></div></div>}

      {fatal && (
        <div className={styles.error}>
          Der Shop-Check konnte nicht laufen: {err || st?.error}
          <Button size="sm" onClick={() => void load(!err)}>Erneut versuchen</Button>
        </div>
      )}

      {run && (health === 'unvollstaendig' || (failed > 0 && !findings.length)) && (
        <div className={styles.warn} title={errTitle}>
          <span><b>Shop-Check unvollständig:</b> {failed} von {run.checks ?? failed} Prüfungen fehlgeschlagen{findings.length ? ', weitere Punkte sind möglich.' : '. Ohne diese Prüfungen lässt sich nicht sagen, ob alles stimmt.'}</span>
          <Button size="sm" onClick={() => void load(true)} disabled={running}>Erneut versuchen</Button>
        </div>
      )}

      {run && !findings.length && !failed && (
        <div className={styles.ok}>
          <span className={styles.okIcon}><IconCheck size={18} /></span>
          <div><b>Alles im grünen Bereich</b><p>{`${run.checks ?? 0} Prüfungen ohne Befund.`}</p></div>
        </div>
      )}

      {view.tabs.length > 0 && (
        <div className={styles.tabs} role="tablist" aria-label="Bereiche">
          <button type="button" role="tab" aria-selected={!view.area} onClick={() => { setArea(null); setAll(false); }}>Alle <span>{findings.length}</span></button>
          {view.tabs.map(t => (
            <button key={t.area} type="button" role="tab" aria-selected={view.area === t.area} onClick={() => { setArea(t.area); setAll(false); }}>{t.area} <span>{t.count}</span></button>
          ))}
        </div>
      )}

      {shown.length > 0 && groupByArea(shown).map(([group, list]) => (
        <div key={group} className={styles.group}>
          <h4>{group}{AREA_NOTE[group] && <small>{AREA_NOTE[group]}</small>}</h4>
          {list.map(f => {
            const fix = fixes[f.id];
            return (
            <div key={f.id} className={styles.row}>
              <span className={`${styles.sev} ${styles[f.severity]}`}>{SEVERITY_LABEL[f.severity]}</span>
              <div className={styles.body}>
                <div className={styles.line}><b>{f.title}</b><span className={styles.count}>{countText(f)}</span></div>
                {f.hint && <p className={styles.hint} title={f.hint}>{f.hint}</p>}
                {!!f.sample?.length && (
                  <details className={styles.samples}>
                    <summary>{f.sample.length === 1 ? 'Beispiel' : `${f.sample.length} Beispiele`}</summary>
                    <ul>{f.sample.map(s => <li key={s.id}>{s.label}</li>)}</ul>
                  </details>
                )}
              </div>
              {fix && onOpenChat ? (
                <span className={styles.fixing}>
                  <span className={styles.badge} title={`Seit ${ago(fix.at)} in Arbeit`} suppressHydrationWarning>in Arbeit</span>
                  <Button size="sm" className={styles.fix} onClick={() => onOpenChat(fix.chatId)} title={`Chat „${fix.title}“ öffnen`}>Chat öffnen</Button>
                </span>
              ) : (
                <Button size="sm" variant={f === findings[0] ? 'primary' : undefined} className={styles.fix} onClick={() => onFix(f)} title="Legt den Auftrag ins Feld. Senden bleibt ein eigener Klick.">Als Auftrag ins Feld</Button>
              )}
            </div>
            );
          })}
        </div>
      ))}

      {(view.more || (health === 'teilweise' && findings.length > 0)) && (
        <footer className={styles.foot}>
          {view.more && <button type="button" className={styles.more} onClick={() => setAll(!all)}>{all ? 'Weniger zeigen' : `Alle ${view.total} Punkte zeigen`}</button>}
          {health === 'teilweise' && findings.length > 0 && <small title={errTitle}>{failed === 1 ? '1 Prüfung' : `${failed} Prüfungen`} ohne Ergebnis</small>}
        </footer>
      )}
    </section>
  );
}
