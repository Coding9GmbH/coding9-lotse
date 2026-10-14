'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { AccessLogRow, AuditRow } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { useI18n } from '@/lib/i18n/I18nProvider';
import styles from './Settings.module.css';

type Which = 'access' | 'audit';

/** Zugriffsprotokoll (was die KI gelesen hat) und Änderungsprotokoll (was geschrieben wurde). */
export function LogsPanel() {
  const { t: all, locale } = useI18n();
  const t = all.settings.logs;
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
        <Segmented label={t.label} className={styles.logSeg} value={which} onChange={setWhich} options={[
          { value: 'access', label: t.access(deniedCount) },
          { value: 'audit', label: t.audit },
        ]} />
        {which === 'access' && (
          <label className={styles.filter}>
            <input type="checkbox" checked={onlyDenied} onChange={e => setOnlyDenied(e.target.checked)} /> {t.onlyDenied}
          </label>
        )}
        <Button size="sm" onClick={() => void load(which)}>{t.refresh}</Button>
      </div>
      <p className={styles.hint}>
        {which === 'access'
          ? t.accessHint
          : t.auditHint}
      </p>
      {error && <div className={styles.alert} role="alert">{error}</div>}

      {which === 'access' && (access === null ? <p className={styles.muted}>{all.settings.loading}</p> : rows.length === 0 ? <p className={styles.muted}>{t.noEntries}</p> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>{t.time}</th><th>{t.op}</th><th>{t.area}</th><th className={styles.num}>{t.records}</th><th className={styles.num}>{t.scrubbed}</th><th>{t.result}</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.ts}-${i}`} className={r.denied ? styles.denied : undefined}>
                  <td className={styles.nowrap}>{dateTime(r.ts, locale)}</td>
                  <td>{r.op}</td>
                  <td><code>{r.entity}</code></td>
                  <td className={styles.num}>{r.n}</td>
                  <td className={styles.num}>{r.scrubbed || ''}</td>
                  <td>{r.denied ? <span className={styles.deniedTag}>{t.denied(r.denied)}</span> : <span className={styles.ok}>{t.read}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {which === 'audit' && (audit === null ? <p className={styles.muted}>{all.settings.loading}</p> : audit.length === 0 ? <p className={styles.muted}>{t.noChanges}</p> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>{t.time}</th><th>{t.changeSet}</th><th>{t.decisionHead}</th><th>{t.result}</th></tr></thead>
            <tbody>
              {audit.map((r, i) => (
                <tr key={`${r.ts}-${i}`}>
                  <td className={styles.nowrap}>{dateTime(r.ts, locale)}{typeof r.recoveredFrom === 'string' && <small className={styles.sub}>{t.recovered(dateTime(r.recoveredFrom, locale))}</small>}</td>
                  <td>{r.title ?? r.changeSet ?? t.untitled}{r.kind && <small className={styles.sub}>{r.kind}</small>}</td>
                  <td><span className={`${styles.decision} ${styles[`d_${r.decision}`] ?? ''}`}>{t.decision[r.decision] ?? r.decision}</span>{typeof r.actor === 'string' && r.actor && <small className={styles.sub}>{t.actor(r.actor)}</small>}</td>
                  <td>
                    {r.status ? t.status[r.status] ?? r.status : ''}
                    {typeof r.applied === 'number' && <small className={styles.sub}>{t.applied(r.applied, r.failed ?? 0)}</small>}
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
