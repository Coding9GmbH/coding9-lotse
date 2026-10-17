'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { TaskDiff } from '@/lib/protocol';
import { useT } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import styles from './Sandbox.module.css';

/** One line of a unified diff → class for +/−/hunk. */
const lineClass = (l: string) => (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff --git') || l.startsWith('index ') ? styles.dfMeta
  : l.startsWith('@@') ? styles.dfHunk : l.startsWith('+') ? styles.dfAdd : l.startsWith('-') ? styles.dfDel : undefined);

/** "Änderungen": the workspace against the base branch (redacted on the server). Reloads when `refresh` changes (a file card arrived). */
export function DiffPanel({ taskId, refresh }: { taskId: string; refresh: number }) {
  const t = useT().sandbox.code.diff;
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let off = false;
    api.sandbox.diff(taskId).then(d => { if (!off) { setDiff(d); setError(null); } }, e => { if (!off) setError(errorText(e)); }).finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [taskId, refresh, tick]);
  const reload = () => { setLoading(true); setTick(n => n + 1); };

  return (
    <div className={styles.diff}>
      <div className={styles.dfBar}>
        <span className={styles.muted} role="status">{loading && !diff ? t.loading : diff?.files.length ? t.files(diff.files.length) : diff ? t.empty : ''}</span>
        <Button size="sm" onClick={reload} busy={loading}>{t.refresh}</Button>
      </div>
      {error && <p className={styles.bad} role="alert">{t.failed(error)}</p>}
      {!!diff?.files.length && (
        <ul className={styles.dfFiles}>
          {diff.files.map(f => (
            <li key={f.path}><code>{f.path}</code> <small>{t.status[f.status]}</small> <span className={styles.dfAdd}>+{f.added}</span> <span className={styles.dfDel}>−{f.removed}</span></li>
          ))}
        </ul>
      )}
      {!!diff?.diff && (
        <pre className={styles.dfPatch} tabIndex={0}>
          {diff.diff.split('\n').map((l, i) => <span key={i} className={lineClass(l)}>{l || ' '}</span>)}
        </pre>
      )}
      {diff?.truncated && <p className={styles.muted}>{t.truncated}</p>}
    </div>
  );
}
