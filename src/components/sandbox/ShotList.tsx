'use client';

import { useI18n } from '@/lib/i18n/I18nProvider';
import type { CodeTaskPublic } from '@/lib/protocol';
import styles from './Sandbox.module.css';

/** "Screenshots" in the "Pull Request" tab: the sets the user took with "Screenshot" in the preview, newest first (per page desktop
 *  and mobile). Nothing at all when there are none – neither the setup nor publishing takes any. The images stay in Lotse; a click
 *  opens one in full size. */
export function ShotList({ task }: { task: CodeTaskPublic }) {
  const { t: all, locale } = useI18n();
  const t = all.sandbox.code.shots;
  const sets = [...task.shots].reverse();
  if (!sets.length) return null;
  const at = (iso: string) => new Date(iso).toLocaleString(locale === 'en' ? 'en-GB' : 'de-DE', { dateStyle: 'short', timeStyle: 'short' });
  return (
    <section className={styles.shots} aria-labelledby="sbx-shots-h">
      <details open>
        <summary className={styles.shotsHead}><h3 id="sbx-shots-h" className={styles.h3}>{t.heading}</h3><small className={styles.muted}>{t.count(sets.length)}</small></summary>
        <p className={styles.hint}>{t.lead}</p>
        {sets.map(set => (
          <div key={set.id} className={styles.shotRow}>
            <p className={styles.taskMeta}>{at(set.at)}</p>
            {set.error && <p className={styles.bad}>{set.error}</p>}
            <div className={styles.shotGrid}>
              {set.shots.map(s => (
                <figure key={s.url} className={`${styles.shot} ${s.device === 'mobile' ? styles.shotMobile : ''}`}>
                  <figcaption><code>{s.path}</code> · {t.device[s.device]}</figcaption>
                  {/* eslint-disable-next-line @next/next/no-img-element -- stored screenshots of the sandbox, served by Lotse */}
                  <a href={s.url} target="_blank" rel="noopener noreferrer" title={t.open}><img src={s.url} alt={t.alt(t.device[s.device], s.path, at(set.at))} loading="lazy" /></a>
                </figure>
              ))}
            </div>
          </div>
        ))}
      </details>
    </section>
  );
}
