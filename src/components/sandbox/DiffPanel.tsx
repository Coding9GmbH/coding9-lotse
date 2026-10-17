'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { parseDiff, type DiffFile } from '@/lib/diff-parse';
import type { TaskDiff } from '@/lib/protocol';
import { useT } from '@/lib/i18n/I18nProvider';
import { IconChevron, IconRefresh } from '@/components/ui/icons';
import styles from './Sandbox.module.css';

const anchor = (i: number) => `sbx-diff-${i}`;

/** "Änderungen": the workspace against the base branch (redacted on the server), per file with +/− counts and line numbers.
 *  Reloads by itself when `refresh` changes (a file card arrived, a turn ended); the icon reloads by hand. */
export function DiffPanel({ taskId, refresh }: { taskId: string; refresh: number }) {
  const t = useT().sandbox.code.diff;
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  useEffect(() => {
    let off = false;
    api.sandbox.diff(taskId).then(d => { if (!off) { setDiff(d); setError(null); } }, e => { if (!off) setError(errorText(e)); }).finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [taskId, refresh, tick]);
  const patch = diff?.diff ?? '';
  const files = useMemo(() => (patch ? parseDiff(patch) : []), [patch]);
  const toggle = (p: string, open?: boolean) => setClosed(c => { const n = new Set(c); if (open ?? n.has(p)) n.delete(p); else n.add(p); return n; });
  const jump = (i: number, p: string) => { toggle(p, true); requestAnimationFrame(() => document.getElementById(anchor(i))?.scrollIntoView({ block: 'start', behavior: 'smooth' })); };

  return (
    <div className={styles.diff}>
      <div className={styles.dfBar}>
        <span className={styles.muted} role="status">{loading && !diff ? t.loading : diff?.files.length ? t.files(diff.files.length) : diff ? t.empty : ''}</span>
        <button type="button" className={styles.iconBtn} onClick={() => { setLoading(true); setTick(n => n + 1); }} aria-label={t.refresh} title={t.refresh} aria-busy={loading || undefined}>
          <IconRefresh size={16} className={loading ? styles.spinning : undefined} />
        </button>
      </div>
      {error && <p className={styles.bad} role="alert">{t.failed(error)}</p>}
      {!!diff?.files.length && (
        <ul className={styles.dfFiles}>
          {diff.files.map(f => {
            const i = files.findIndex(x => x.path === f.path);
            return (
              <li key={f.path}>
                {i >= 0 ? <button type="button" className={styles.dfJump} onClick={() => jump(i, f.path)} title={t.jump(f.path)}><code>{f.path}</code></button> : <code>{f.path}</code>}
                {f.status !== 'modified' && <span className={styles.dfBadge} data-status={f.status}>{t.status[f.status]}</span>}
                <span className={styles.dfAdd}>+{f.added}</span> <span className={styles.dfDel}>−{f.removed}</span>
              </li>
            );
          })}
        </ul>
      )}
      {files.map((f, i) => <FileDiff key={`${f.path}-${i}`} id={anchor(i)} file={f} open={!closed.has(f.path)} onToggle={() => toggle(f.path)} />)}
      {diff?.truncated && <p className={styles.muted}>{t.truncated}</p>}
    </div>
  );
}

function FileDiff({ id, file: f, open, onToggle }: { id: string; file: DiffFile; open: boolean; onToggle: () => void }) {
  const t = useT().sandbox.code.diff;
  return (
    <section id={id} className={styles.dfFile} aria-label={f.path}>
      <button type="button" className={styles.dfHead} aria-expanded={open} onClick={onToggle} title={open ? t.collapse : t.expand}>
        <IconChevron size={14} className={styles.dfChevron} />
        <code>{f.path}</code>
        {f.status !== 'modified' && <span className={styles.dfBadge} data-status={f.status}>{t.status[f.status]}</span>}
        <span className={styles.dfCounts}><span className={styles.dfAdd}>+{f.added}</span> <span className={styles.dfDel}>−{f.removed}</span></span>
      </button>
      {open && (
        <div className={styles.dfBody}>
          {f.oldPath && <p className={styles.dfNote}>{t.renamedFrom(f.oldPath)}</p>}
          {!f.hunks.length && <p className={styles.dfNote}>{t.binary}</p>}
          {f.hunks.map((h, hi) => (
            <table key={hi} className={styles.dfTable}>
              <tbody>
                <tr className={styles.dfHunk}><td colSpan={3}>{h.header}</td></tr>
                {h.lines.map((l, li) => (
                  <tr key={li} className={l.kind === 'add' ? styles.dfRowAdd : l.kind === 'del' ? styles.dfRowDel : l.kind === 'note' ? styles.dfRowNote : undefined}>
                    <td className={styles.dfNo} aria-hidden="true">{l.old ?? ''}</td>
                    <td className={styles.dfNo} aria-hidden="true">{l.new ?? ''}</td>
                    <td className={styles.dfCode}><span className={styles.dfSign}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>{l.text || ' '}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      )}
    </section>
  );
}
