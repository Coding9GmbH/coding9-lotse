'use client';

import { useMemo, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { parseDiff } from '@/lib/diff-parse';
import type { ContainerChanges, ContainerTakeOver } from '@/lib/protocol';
import { useT } from '@/lib/i18n/I18nProvider';
import { Button } from '@/components/ui/Button';
import { FileDiff } from './DiffPanel';
import styles from './Sandbox.module.css';

/** "Aus dem Container übernehmen" at the top of "Änderungen": compares the task container's synced folders with the project (files made
 *  in the console or by the AI's commands), shows each difference with its diff and takes the chosen ones over – exactly the versions
 *  shown (the server refuses a file that changed since). Files the commit checks refuse (protected, workflow, secret, size) cannot be chosen. */
export function ContainerPull({ taskId, onTaken }: { taskId: string; onTaken: () => void }) {
  const t = useT().sandbox.code.pull, td = useT().sandbox.code.diff;
  const [res, setRes] = useState<ContainerChanges | null>(null);
  const [busy, setBusy] = useState<'compare' | 'take' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ContainerTakeOver | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const files = useMemo(() => (res?.diff ? parseDiff(res.diff) : []), [res]);
  const open = res?.changes.filter(c => !c.blocked) ?? [];

  async function compare(keepDone = false) {
    setBusy('compare'); setError(null); if (!keepDone) setDone(null);
    try {
      const r = await api.sandbox.containerChanges(taskId);
      setRes(r); setPicked(new Set(r.changes.filter(c => !c.blocked).map(c => c.path)));
    } catch (e) { setRes(null); setError(t.failed(errorText(e))); }
    finally { setBusy(null); }
  }
  async function take() {
    if (!res) return;
    setBusy('take'); setError(null); setDone(null);
    try {
      const r = await api.sandbox.takeOver(taskId, res.changes.filter(c => picked.has(c.path)).map(c => ({ path: c.path, sha: c.sha })));
      setDone(r);
      if (r.taken.length) onTaken();
    } catch (e) { setError(t.takeFailed(errorText(e))); }
    finally { setBusy(null); }
    await compare(true);
  }
  const toggle = (p: string) => setPicked(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const all = open.length > 0 && open.every(c => picked.has(c.path));

  return (
    <section className={styles.zipBox} aria-labelledby="sbx-pull-h">
      <h3 id="sbx-pull-h" className={styles.label}>{t.heading}</h3>
      <p className={styles.fieldHint}>{t.lead}</p>
      <div className={styles.footRow}>
        <Button size="sm" onClick={() => void compare()} busy={busy === 'compare'} disabled={!!busy}>{busy === 'compare' ? t.comparing : t.compare}</Button>
      </div>
      {error && <p className={styles.bad} role="alert">{error}</p>}
      {done && done.taken.length > 0 && <p className={styles.okBox} role="status">{t.taken(done.taken.length)}</p>}
      {done && done.refused.length > 0 && (
        <div className={styles.zipMissing} role="alert">
          <p className={styles.label}>{t.refused}</p>
          <ul>{done.refused.map(r => <li key={r.path}><code>{r.path}</code>: {r.reason}</li>)}</ul>
        </div>
      )}
      {res && (
        <>
          <p className={styles.muted} role="status">{res.changes.length ? t.found(res.changes.length) : t.none}</p>
          {res.noBaseline && res.changes.length > 0 && <p className={styles.fieldHint}>{t.noBaseline}</p>}
          {res.changes.length > 0 && (
            <>
              {open.length > 1 && (
                <label className={styles.check}>
                  <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(open.map(c => c.path)))} disabled={!!busy} />
                  {t.all}
                </label>
              )}
              <ul className={styles.pullList}>
                {res.changes.map(c => (
                  <li key={c.path}>
                    <label className={styles.check}>
                      <input type="checkbox" aria-label={c.path} checked={!c.blocked && picked.has(c.path)} disabled={!!c.blocked || !!busy} onChange={() => toggle(c.path)} />
                      <code>{c.path}</code>
                      <span className={styles.dfBadge} data-status={c.status}>{td.status[c.status]}</span>
                      {!c.binary && <span><span className={styles.dfAdd}>+{c.added}</span> <span className={styles.dfDel}>−{c.removed}</span></span>}
                    </label>
                    {c.blocked && <p className={styles.bad}>{t.blocked}: {c.blocked}</p>}
                  </li>
                ))}
              </ul>
              <div className={styles.footRow}>
                <Button onClick={() => void take()} busy={busy === 'take'} disabled={!!busy || !picked.size}>{busy === 'take' ? t.taking : t.take(open.filter(c => picked.has(c.path)).length)}</Button>
              </div>
              {files.map((f, i) => <FileDiff key={`${f.path}-${i}`} id={`sbx-pull-${i}`} file={f} open={!closed.has(f.path)} onToggle={() => setClosed(s => { const n = new Set(s); if (n.has(f.path)) n.delete(f.path); else n.add(f.path); return n; })} />)}
              {res.truncated && <p className={styles.muted}>{td.truncated}</p>}
            </>
          )}
          {res.skipped.length > 0 && (
            <details className={styles.dfOpen}>
              <summary>{t.skippedHeading(res.skipped.length)}</summary>
              <ul className={styles.dfFiles}>{res.skipped.map(s => <li key={`${s.path}-${s.reason}`}><code>{s.path}</code> <span className={styles.fieldHint}>{t.skipped[s.reason]}</span></li>)}</ul>
            </details>
          )}
          <p className={styles.fieldHint}>{t.folders(res.roots.join(', '))}</p>
        </>
      )}
    </section>
  );
}
