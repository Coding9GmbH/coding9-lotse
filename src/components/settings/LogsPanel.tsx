'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { AccessLogRow, AuditRow } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import styles from './Settings.module.css';

type Which = 'access' | 'audit';

const DECISION: Record<AuditRow['decision'], string> = { approved: 'freigegeben', rejected: 'abgelehnt', undo: 'rückgängig', changed: 'geändert' };
const STATUS: Record<string, string> = { started: 'gestartet', applied: 'angewendet', partial: 'teilweise', failed: 'fehlgeschlagen', rejected: 'abgelehnt' };

/** Zugriffsprotokoll (was die KI gelesen hat) und Änderungsprotokoll (was geschrieben wurde). */
export function LogsPanel() {
  const [which, setWhich] = useState<Which>('access');
  const [access, setAccess] = useState<AccessLogRow[] | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyDenied, setOnlyDenied] = useState(false);

  const load = useCallback(async (w: Which) => {
    try {
      if (w === 'access') setAccess(await api.accessLog()); else setAudit(await api.audit());
      setError(null);
    } catch (e) { setError(errorText(e)); }
  }, []);

  useEffect(() => {
    let off = false;
    Promise.allSettled([api.accessLog(), api.audit()]).then(([a, b]) => {
      if (off) return;
      if (a.status === 'fulfilled') setAccess(a.value);
      if (b.status === 'fulfilled') setAudit(b.value);
      const fail = [a, b].find(r => r.status === 'rejected');
      if (fail) setError(errorText(fail.reason));
    });
    return () => { off = true; };
  }, []);

  const deniedCount = access?.filter(r => r.denied).length ?? 0;
  const rows = (access ?? []).filter(r => !onlyDenied || r.denied);

  return (
    <div>
      <div className={styles.logBar}>
        <Segmented label="Protokoll" className={styles.logSeg} value={which} onChange={setWhich} options={[
          { value: 'access', label: `Zugriffe${deniedCount ? ` · ${deniedCount} abgewiesen` : ''}` },
          { value: 'audit', label: 'Änderungen' },
        ]} />
        {which === 'access' && (
          <label className={styles.filter}>
            <input type="checkbox" checked={onlyDenied} onChange={e => setOnlyDenied(e.target.checked)} /> nur abgewiesene
          </label>
        )}
        <Button size="sm" onClick={() => void load(which)}>Aktualisieren</Button>
      </div>
      <p className={styles.hint}>
        {which === 'access'
          ? 'Was die KI im Shop gelesen hat. Abgewiesene Versuche (gesperrte Bereiche oder Daten) sind markiert; „geschwärzt“ zählt entfernte sensible Felder.'
          : 'Alle freigegebenen, abgelehnten und rückgängig gemachten Änderungssets.'}
      </p>
      {error && <div className={styles.alert} role="alert">{error}</div>}

      {which === 'access' && (access === null ? <p className={styles.muted}>Lade …</p> : rows.length === 0 ? <p className={styles.muted}>Noch keine Einträge.</p> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Zeit</th><th>Vorgang</th><th>Bereich</th><th className={styles.num}>Datensätze</th><th className={styles.num}>geschwärzt</th><th>Ergebnis</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.ts}-${i}`} className={r.denied ? styles.denied : undefined}>
                  <td className={styles.nowrap}>{dateTime(r.ts)}</td>
                  <td>{r.op}</td>
                  <td><code>{r.entity}</code></td>
                  <td className={styles.num}>{r.n}</td>
                  <td className={styles.num}>{r.scrubbed || ''}</td>
                  <td>{r.denied ? <span className={styles.deniedTag}>abgewiesen: {r.denied}</span> : <span className={styles.ok}>gelesen</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {which === 'audit' && (audit === null ? <p className={styles.muted}>Lade …</p> : audit.length === 0 ? <p className={styles.muted}>Noch keine Änderungen.</p> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Zeit</th><th>Änderungsset</th><th>Entscheidung</th><th>Ergebnis</th></tr></thead>
            <tbody>
              {audit.map((r, i) => (
                <tr key={`${r.ts}-${i}`}>
                  <td className={styles.nowrap}>{dateTime(r.ts)}{typeof r.recoveredFrom === 'string' && <small className={styles.sub}>Vorfall {dateTime(r.recoveredFrom)}, beim Laden nachgetragen</small>}</td>
                  <td>{r.title ?? r.changeSet ?? '(ohne)'}{r.kind && <small className={styles.sub}>{r.kind}</small>}</td>
                  <td><span className={`${styles.decision} ${styles[`d_${r.decision}`] ?? ''}`}>{DECISION[r.decision] ?? r.decision}</span></td>
                  <td>
                    {r.status ? STATUS[r.status] ?? r.status : ''}
                    {typeof r.applied === 'number' && <small className={styles.sub}>{r.applied} angewendet{r.failed ? `, ${r.failed} fehlgeschlagen` : ''}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
