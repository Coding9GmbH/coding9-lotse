'use client';

import { areaLabel, groupAudit } from '@/lib/audit';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { DraftAudit } from '@/lib/protocol';
import { Dialog } from '@/components/ui/Dialog';
import styles from './dialogs.module.css';

/** Qualitäts-Check (SEO · Conversion · Design) des aktuellen Entwurfs. */
export function AuditDialog({ audit, open, onClose }: { audit: DraftAudit | null; open: boolean; onClose: () => void }) {
  const { locale, t: { dialogs: { audit: t } } } = useI18n();
  return (
    <Dialog open={open && !!audit} onClose={onClose} title={audit ? t.titleScore(audit.score) : t.title}>
      {audit && (
        <>
          {groupAudit(audit).map(g => (
            <div key={g.area} className={styles.sec}>
              <h3>{areaLabel(g.area, locale)}</h3>
              {g.rows.map((c, i) => (
                <div key={i} className={styles.chk}>
                  <span className={c.ok ? styles.ok : styles.no} aria-label={c.ok ? t.passed : t.open}>{c.ok ? '✓' : '✗'}</span>
                  <small>{c.important ? t.important : ''}</small>
                  <span>{c.text}{c.hint && <small className={styles.hint}>{c.hint}</small>}</span>
                </div>
              ))}
            </div>
          ))}
          {audit.warnings.length > 0 && (
            <div className={styles.sec}>
              <h3>{t.warnings}</h3>
              {audit.warnings.map(w => (
                <div key={w} className={styles.chk}><span className={styles.no}>!</span><small /><span>{w}</span></div>
              ))}
            </div>
          )}
          <p className={styles.stats}>{t.stats(audit.stats.words, audit.stats.h1, audit.stats.internalLinks)}</p>
        </>
      )}
    </Dialog>
  );
}
