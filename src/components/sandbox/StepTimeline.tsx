'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { CodeTaskPublic, TaskStep } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { canRetryFrom, composerAuthWanted, errorSummary, formatSeconds, setupProgress, setupSeconds, skipReason, stepSeconds } from '@/lib/sandbox-task';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { RepoFileCard } from './RepoFileCard';
import styles from './Sandbox.module.css';

const ICON: Record<TaskStep['state'], string> = { pending: '○', running: '', done: '✓', failed: '✗', skipped: '–', interrupted: '‖' };

/**
 * Setup steps: a progress header while it runs, one line per step with state and duration. The log opens by itself only for the running
 * and a failed step (the others on click); a failed step shows one summary line (the full output stays in its log) and the one
 * "Ab hier erneut versuchen". Steps after a failure are folded. Once everything is done the list folds into "Eingerichtet in …".
 */
export function StepTimeline({ task, onRetry, onIgnoreVersion, onRepoFile, onComposerAuth, busy }: { task: CodeTaskPublic; onRetry: (stepId: string) => void; /** saves the packages.shopware.com token, then retries from this step */ onComposerAuth?: (stepId: string, token: string) => void; /** "Trotzdem fortfahren" from this step */ onIgnoreVersion: (stepId: string) => void;
  /** the setup waits at "Plugin erkennen" for a decision on the repository file's commands */ onRepoFile?: (decision: 'approve' | 'skip', hash: string) => void; busy: boolean }) {
  const { t: all } = useI18n();
  const t = all.sandbox.task, td = all.sandbox.dump;
  const running = task.steps.some(s => s.state === 'running');
  const [, tick] = useState(0);
  const [details, setDetails] = useState(false);
  const [rest, setRest] = useState(false);
  const [logs, setLogs] = useState<Set<string>>(new Set());
  const [token, setToken] = useState('');
  useEffect(() => { if (!running) return; const i = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(i); }, [running]);

  const took = setupSeconds(task);
  const { current, total, done } = setupProgress(task);
  const stopAt = task.steps.findIndex(s => s.state === 'failed' || s.state === 'interrupted');
  const later = stopAt >= 0 ? task.steps.slice(stopAt + 1).filter(s => s.state === 'pending') : [];
  const shown = stopAt >= 0 && !rest ? task.steps.filter(s => !later.includes(s)) : task.steps;
  const toggleLog = (id: string) => setLogs(l => { const n = new Set(l); if (!n.delete(id)) n.add(id); return n; });

  if (took !== null && !details) {
    return (
      <div className={styles.tlDone}>
        <b role="status">{t.setupDone(formatSeconds(took))}</b>
        <button type="button" className={styles.textBtn} aria-expanded={false} onClick={() => setDetails(true)}>{t.showDetails}</button>
      </div>
    );
  }
  return (
    <>
      {took === null && task.status === 'setting_up' && (
        <div className={styles.tlProgress}>
          <p><b>{t.setupTitle}</b> · {t.progress(current, total)} · {t.eta}</p>
          <div className={styles.bar} role="progressbar" aria-label={t.setupTitle} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}><i style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} /></div>
        </div>
      )}
      {took !== null && <div className={styles.tlDone}><b>{t.setupDone(formatSeconds(took))}</b><button type="button" className={styles.textBtn} aria-expanded onClick={() => setDetails(false)}>{t.hideDetails}</button></div>}
      <ol className={styles.timeline}>
        {shown.map(s => {
          // before the layout is detected the chosen mode tells (a project otherwise shows the plugin labels until then)
          const kind = task.layout?.kind ?? task.setup?.mode, project = kind === 'project', own = kind === 'custom';
          const sec = stepSeconds(s), label = s.key === 'custom' ? s.label ?? s.id
            : (project && task.dump && all.sandbox.projectDumpSteps[s.key]) || (project && all.sandbox.projectSteps[s.key]) || (own && all.sandbox.customSteps[s.key]) || all.sandbox.steps[s.key];
          const waitsForFile = s.key === 'detect-layout' && s.state === 'failed' && task.repoFile?.state === 'pending';
          const pmm = s.key === 'detect-layout' && s.state === 'failed' ? task.layout?.project?.versionMismatch : undefined;
          const skip = skipReason(task, s), state = skip ? 'skipped' : s.state;
          const autoLog = s.state === 'running' || s.state === 'failed';
          const hasLog = s.log.length > 0;
          const summary = s.error ? errorSummary(s.error) : null;
          return (
            <li key={s.id} className={styles.tlStep} data-state={state}>
              <span className={styles.tlIcon} aria-hidden="true">{s.state === 'running' ? <Spinner size={13} /> : ICON[state]}</span>
              <div className={styles.tlBody}>
                <div className={styles.tlHead}>
                  <span className={styles.tlLabel}>{label}</span>
                  <span className={styles.muted}>{skip ? t.willSkip[skip] : t.stepState[s.state]}{sec !== null && s.state !== 'skipped' ? ` · ${formatSeconds(sec)}` : ''}</span>
                  {!autoLog && hasLog && <button type="button" className={styles.tlLogBtn} aria-expanded={logs.has(s.id)} onClick={() => toggleLog(s.id)}>{t.log} ({s.log.length})</button>}
                  {canRetryFrom(task, s) && !(waitsForFile && onRepoFile) && <Button size="sm" variant="primary" onClick={() => onRetry(s.id)} disabled={busy}>{t.retryFrom}</Button>}
                </div>
                {summary && <p className={styles.tlError}>{summary}</p>}
                {s.error && summary !== s.error.trim() && !hasLog && <details className={styles.tlLog}><summary>{t.fullError}</summary><pre>{s.error}</pre></details>}
                {waitsForFile && task.repoFile && onRepoFile && <RepoFileCard file={task.repoFile} state="pending" busy={busy} onApprove={() => onRepoFile('approve', task.repoFile!.hash)} onSkip={() => onRepoFile('skip', task.repoFile!.hash)} />}
                {s.key === 'custom' && s.state === 'failed' && (!s.source || s.source === 'env') && <p className={styles.tlFix}><Link href="/sandbox-coding#sbx-env">{t.editCommand}</Link></p>}
                {s.key === 'version-check' && s.state === 'failed' && task.dump?.versionMismatch && !task.dump.deleted && (
                  <div className={styles.dumpWarn}>
                    <span>{td.mismatch(task.dump.versionMismatch.dump, task.dump.versionMismatch.image)}</span>
                    <Button size="sm" onClick={() => onIgnoreVersion(s.id)} disabled={busy}>{td.ignoreVersion}</Button>
                  </div>
                )}
                {pmm && (
                  <div className={styles.dumpWarn}>
                    <span>{all.sandbox.project.mismatch(pmm.project, pmm.image, pmm.suggest)}</span>
                    <Button size="sm" onClick={() => onIgnoreVersion(s.id)} disabled={busy}>{td.ignoreVersion}</Button>
                  </div>
                )}
                {onComposerAuth && s.key === 'install-plugin' && s.state === 'failed' && !!s.error && /packages\.shopware\.com/.test(s.error) && composerAuthWanted(s.error) && (
                  <form className={styles.dumpWarn} onSubmit={e => { e.preventDefault(); if (token.trim()) { onComposerAuth(s.id, token.trim()); setToken(''); } }}>
                    <span>{t.composerAuthHint}</span>
                    <label className={styles.fieldTight}><span className={styles.cap}>{t.composerAuthLabel}</span>
                      <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={e => setToken(e.target.value)} disabled={busy} /></label>
                    <Button size="sm" variant="primary" type="submit" disabled={busy || !token.trim()}>{t.composerAuthSubmit}</Button>
                  </form>
                )}
                {s.key === 'import-db' && task.dump?.deleted && s.state !== 'pending' && <p className={styles.dumpNote}>{td.deleted}</p>}
                {(autoLog || logs.has(s.id)) && (hasLog || s.state === 'running') && (
                  autoLog
                    ? <details className={styles.tlLog} open><summary>{t.log} ({s.log.length})</summary><pre>{hasLog ? s.log.join('\n') : t.noLog}</pre></details>
                    : <pre className={styles.tlLogPre}>{s.log.join('\n')}</pre>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {later.length > 0 && <button type="button" className={styles.textBtn} aria-expanded={rest} onClick={() => setRest(r => !r)}>{rest ? t.hideDetails : t.moreSteps(later.length)}</button>}
    </>
  );
}
