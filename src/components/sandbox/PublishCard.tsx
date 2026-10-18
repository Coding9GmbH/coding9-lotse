'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { CodeTaskPublic, PublishResult, TaskDiff } from '@/lib/protocol';
import { PUBLISH_STEPS, publishSteps } from '@/lib/sandbox-task';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Term } from './Term';
import styles from './Sandbox.module.css';

export interface PrProposal { key: string; title: string; body: string }

/** First line as the message, the rest (git's or GitHub's report) folded below. */
export function ErrorText({ text, details }: { text: string; details: string }) {
  const [head, ...rest] = text.split('\n');
  const more = rest.join('\n').trim();
  return (
    <div className={styles.bad} role="alert">
      <p className={styles.badHead}>{head}</p>
      {more && <details className={styles.tlLog}><summary>{details}</summary><pre>{more}</pre></details>}
    </div>
  );
}

/** "Freigabe" tab (zur Prüfung freigeben = pull request; plain words first, the technical terms small or as tooltip): the changed files, branch → base, title and description (the AI's proposal prefilled, editable), `children`
 *  (the screenshots the user took, if any) and a footer that sticks to the bottom of the tab with the button and the steps Commit (only
 *  what is not committed yet; the AI's commits are pushed as they are) → Push → Pull Request. Only this click publishes; progress and errors come with the task (task.publish), so a reload shows them too.
 *  Published already: "aktualisieren" only when something changed since the last push (or title/description were edited).
 *  Blocked by the secret scan: the findings with file and line; when all may be false positives, "Trotzdem veröffentlichen" (audited). */
export function PublishCard({ task, proposal, onPublished, children }: { task: CodeTaskPublic; proposal: PrProposal | null; onPublished: (r: PublishResult) => void; children?: React.ReactNode }) {
  const tc = useI18n().t.sandbox.code, t = tc.pr;
  const [title, setTitle] = useState(proposal?.title ?? task.pr?.title ?? task.title);
  const [body, setBody] = useState(proposal?.body ?? task.goal);
  const [taken, setTaken] = useState(proposal?.key ?? null);
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [edited, setEdited] = useState(false);
  const [tick, setTick] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // a newer proposal of the AI replaces the fields (the user reviews it before clicking)
  if (proposal && proposal.key !== taken) { setTaken(proposal.key); setTitle(proposal.title); setBody(proposal.body); setEdited(true); }
  useEffect(() => {
    let off = false;
    api.sandbox.diff(task.id).then(d => { if (!off) setDiff(d); }, e => { if (!off) setError(errorText(e)); });
    return () => { off = true; };
  }, [task.id, tick]);

  const running = sending || task.publish?.state === 'running';
  const progress = task.publish?.state === 'running' ? t.steps[task.publish.step] : sending ? t.steps.check : null;
  const failed = !sending && task.publish?.state === 'failed';
  const last = !sending && !error && task.publish ? (task.publish.state === 'interrupted' ? t.interrupted : failed ? t.failed(task.publish.error ?? '') : null) : null;
  const steps = publishSteps(task.publish);
  const files = diff?.files ?? null;
  const findings = failed ? task.publish?.findings ?? [] : [];
  const canOverride = findings.length > 0 && findings.every(f => f.overridable);
  // published and nothing new since the last push: no button that would only re-send the same state
  const upToDate = !!task.pr && diff?.unpublished === false && !edited && !failed;
  async function publish(allowFindings?: string[]) {
    setSending(true); setError(null);
    try { onPublished(await api.sandbox.publish(task.id, { title, body, ...(allowFindings ? { allowFindings } : {}) })); setEdited(false); setTick(n => n + 1); }
    catch (e) { setError(t.failed(errorText(e))); }
    finally { setSending(false); }
  }
  const override = () => { if (window.confirm(t.overrideConfirm(findings.length))) void publish(findings.map(f => f.id)); };

  return (
    <form className={styles.form} aria-label={t.heading} onSubmit={e => { e.preventDefault(); void publish(); }}>
      <p className={styles.hint}>{t.lead}</p>
      <p className={styles.taskMeta}><code>{t.branch(task.branch, task.baseBranch)}</code> <small className={styles.tech}>{tc.tech.branch}</small></p>
      <div className={styles.field}>
        <span className={styles.label}>{t.files}</span>
        {files === null ? <p className={styles.muted}>{t.filesLoading}</p> : !files.length ? <p className={styles.muted}>{t.noFiles}</p> : (
          <ul className={styles.dfFiles}>{files.map(f => <li key={f.path}><code>{f.path}</code> <span className={styles.dfAdd}>+{f.added}</span> <span className={styles.dfDel}>−{f.removed}</span></li>)}</ul>
        )}
      </div>
      <label className={styles.field}>
        <span className={styles.label}>{t.title}</span>
        <input value={title} maxLength={200} required onChange={e => { setTitle(e.target.value); setEdited(true); }} disabled={running} />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>{t.body}</span>
        <textarea value={body} rows={7} maxLength={20_000} onChange={e => { setBody(e.target.value); setEdited(true); }} disabled={running} />
        <span className={styles.fieldHint}>{taken ? `${t.fromProposal} ` : ''}{t.bodyHint}</span>
      </label>
      {children}
      <div className={styles.stickyFoot}>
        {(running || failed) && (
          <ol className={styles.stepper} aria-label={t.progress}>
            {PUBLISH_STEPS.map(k => (
              <li key={k} data-state={steps[k]}>
                <span aria-hidden="true">{steps[k] === 'running' ? <Spinner size={12} /> : steps[k] === 'done' ? '✓' : steps[k] === 'failed' ? '✗' : '○'}</span>
                <Term tech={tc.tech[k]}>{t.stepper[k]}</Term>
              </li>
            ))}
          </ol>
        )}
        <div className={styles.footRow}>
          {upToDate
            ? <span className={styles.muted} role="status">{t.upToDate}</span>
            : <Button variant="primary" type="submit" busy={running} title={task.pr ? t.updateTech : t.createTech} disabled={running || !title.trim() || (files !== null && !files.length && !task.pr)}>{task.pr ? t.update : t.create}</Button>}
          {progress && <span className={styles.muted} role="status">{progress}</span>}
        </div>
        {(error ?? last) && <ErrorText text={(error ?? last)!} details={t.details} />}
        {findings.length > 0 && (
          <div className={styles.findings}>
            <p className={styles.label}>{t.findings}</p>
            <ul>{findings.map(f => <li key={f.id}><code>{f.file}:{f.line}</code> {f.kind}</li>)}</ul>
            {canOverride
              ? <p className={styles.footRow}><Button variant="danger" size="sm" onClick={override} disabled={running}>{t.override}</Button><span className={styles.fieldHint}>{t.overrideNote}</span></p>
              : <p className={styles.fieldHint}>{t.noOverride}</p>}
          </div>
        )}
      </div>
    </form>
  );
}
