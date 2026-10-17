'use client';

import { useEffect, useState } from 'react';
import type { CodeTaskPublic, TaskStep } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { canRetryFrom, formatSeconds, stepSeconds } from '@/lib/sandbox-task';
import { Button } from '@/components/ui/Button';
import styles from './Sandbox.module.css';

const ICON: Record<TaskStep['state'], string> = { pending: '○', running: '◐', done: '✓', failed: '✗', skipped: '–', interrupted: '‖' };

/** Setup steps with state, duration, error and a collapsible log; "Ab hier erneut versuchen" on a failed/interrupted step. */
export function StepTimeline({ task, onRetry, onIgnoreVersion, busy }: { task: CodeTaskPublic; onRetry: (stepId: string) => void; onIgnoreVersion: () => void; busy: boolean }) {
  const { t: all } = useI18n();
  const t = all.sandbox.task, td = all.sandbox.dump;
  const running = task.steps.some(s => s.state === 'running');
  const [, tick] = useState(0);
  useEffect(() => { if (!running) return; const i = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(i); }, [running]);

  return (
    <ol className={styles.timeline}>
      {task.steps.map(s => {
        const sec = stepSeconds(s), label = s.key === 'custom' ? s.label ?? s.id : all.sandbox.steps[s.key];
        return (
          <li key={s.id} className={styles.tlStep} data-state={s.state}>
            <span className={styles.tlIcon} aria-hidden="true">{ICON[s.state]}</span>
            <div className={styles.tlBody}>
              <div className={styles.tlHead}>
                <span className={styles.tlLabel}>{label}</span>
                <span className={styles.muted}>{t.stepState[s.state]}{sec !== null && s.state !== 'skipped' ? ` · ${formatSeconds(sec)}` : ''}</span>
                {canRetryFrom(task, s) && <Button size="sm" onClick={() => onRetry(s.id)} disabled={busy}>{t.retryFrom}</Button>}
              </div>
              {s.error && <pre className={styles.tlError}>{s.error}</pre>}
              {s.key === 'version-check' && s.state === 'failed' && task.dump?.versionMismatch && !task.dump.deleted && (
                <div className={styles.dumpWarn}>
                  <span>{td.mismatch(task.dump.versionMismatch.dump, task.dump.versionMismatch.image)}</span>
                  <Button size="sm" onClick={onIgnoreVersion} disabled={busy}>{td.ignoreVersion}</Button>
                </div>
              )}
              {s.key === 'import-db' && task.dump?.deleted && s.state !== 'pending' && <p className={styles.dumpNote}>{td.deleted}</p>}
              {(s.log.length > 0 || s.state === 'running') && (
                <details className={styles.tlLog} open={s.state === 'running' || s.state === 'failed' || undefined}>
                  <summary>{t.log} ({s.log.length})</summary>
                  <pre>{s.log.length ? s.log.join('\n') : t.noLog}</pre>
                </details>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
