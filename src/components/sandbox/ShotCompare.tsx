'use client';

import { useI18n } from '@/lib/i18n/I18nProvider';
import type { CodeTaskPublic, ShotDevice, TaskShot } from '@/lib/protocol';
import styles from './Sandbox.module.css';

/** "Vorher / Nachher" in the "Pull Request" tab (below the form, collapsible): per page and device the before screenshot (end of the setup) next to the after
 *  screenshot (last publish). The images stay in Lotse; a click opens one in full size. */
export function ShotCompare({ task, enabled = true }: { task: CodeTaskPublic; /** pages are configured in the environment */ enabled?: boolean }) {
  const { t: all, locale } = useI18n();
  const t = all.sandbox.code.shots;
  const { before, after } = task.shots;
  const rows: { path: string; device: ShotDevice }[] = [];
  for (const s of [...(before?.shots ?? []), ...(after?.shots ?? [])]) if (!rows.some(r => r.path === s.path && r.device === s.device)) rows.push({ path: s.path, device: s.device });
  const at = (iso: string) => new Date(iso).toLocaleString(locale === 'en' ? 'en-GB' : 'de-DE', { dateStyle: 'short', timeStyle: 'short' });
  const errors = [before?.error && t.failed(t.before, before.error), after?.error && t.failed(t.after, after.error)].filter(Boolean) as string[];
  const shot = (kind: 'before' | 'after', s: TaskShot | undefined, row: { path: string; device: ShotDevice }) => {
    const label = kind === 'before' ? t.before : t.after;
    const set = kind === 'before' ? before : after;
    return (
      <figure className={styles.shot}>
        <figcaption>{label}{set && <small> · {at(set.at)}</small>}</figcaption>
        {/* eslint-disable-next-line @next/next/no-img-element -- stored screenshots of the sandbox, served by Lotse */}
        {s ? <a href={s.url} target="_blank" rel="noopener noreferrer" title={t.open}><img src={s.url} alt={t.alt(label, t.device[row.device], row.path)} loading="lazy" /></a>
          : <div className={styles.shotMissing}>{kind === 'after' && !after ? t.pending : t.missing}</div>}
      </figure>
    );
  };
  return (
    <section className={styles.shots} aria-labelledby="sbx-shots-h">
      <details open>
      <summary className={styles.shotsHead}><h3 id="sbx-shots-h" className={styles.h3}>{t.heading}</h3>{rows.length > 0 && <small className={styles.muted}>{t.count(new Set(rows.map(r => r.path)).size)}</small>}</summary>
      <p className={styles.hint}>{t.lead}</p>
      {!rows.length && !errors.length && <p className={styles.muted}>{enabled ? t.none : t.off}</p>}
      {errors.map(e => <p key={e} className={styles.bad}>{e}</p>)}
      {rows.map(row => (
        <div key={`${row.path}|${row.device}`} className={styles.shotRow}>
          <p className={styles.taskMeta}><code>{row.path}</code> · {t.device[row.device]}</p>
          <div className={`${styles.shotPair} ${row.device === 'mobile' ? styles.shotPairMobile : ''}`}>
            {shot('before', before?.shots.find(s => s.path === row.path && s.device === row.device), row)}
            {shot('after', after?.shots.find(s => s.path === row.path && s.device === row.device), row)}
          </div>
        </div>
      ))}
      </details>
    </section>
  );
}
