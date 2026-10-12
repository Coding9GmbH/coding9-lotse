'use client';

import { AREA_LABEL, groupAudit } from '@/lib/audit';
import type { DraftAudit } from '@/lib/protocol';
import { Dialog } from '@/components/ui/Dialog';
import styles from './dialogs.module.css';

/** Qualitäts-Check (SEO · Conversion · Design) des aktuellen Entwurfs. */
export function AuditDialog({ audit, open, onClose }: { audit: DraftAudit | null; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open && !!audit} onClose={onClose} title={audit ? `Qualitäts-Check · ${audit.score}/100` : 'Qualitäts-Check'}>
      {audit && (
        <>
          {groupAudit(audit).map(g => (
            <div key={g.area} className={styles.sec}>
              <h3>{AREA_LABEL[g.area]}</h3>
              {g.rows.map((c, i) => (
                <div key={i} className={styles.chk}>
                  <span className={c.ok ? styles.ok : styles.no} aria-label={c.ok ? 'erfüllt' : 'offen'}>{c.ok ? '✓' : '✗'}</span>
                  <small>{c.important ? 'wichtig' : ''}</small>
                  <span>{c.text}{c.hint && <small className={styles.hint}>{c.hint}</small>}</span>
                </div>
              ))}
            </div>
          ))}
          {audit.warnings.length > 0 && (
            <div className={styles.sec}>
              <h3>Hinweise</h3>
              {audit.warnings.map(w => (
                <div key={w} className={styles.chk}><span className={styles.no}>!</span><small /><span>{w}</span></div>
              ))}
            </div>
          )}
          <p className={styles.stats}>{audit.stats.words} Wörter · {audit.stats.h1}× H1 · {audit.stats.internalLinks} interne Links</p>
        </>
      )}
    </Dialog>
  );
}
