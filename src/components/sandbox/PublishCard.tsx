'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { CodeTaskPublic, PublishResult, TaskDiff } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import styles from './Sandbox.module.css';

export interface PrProposal { key: string; title: string; body: string }

/** "Pull Request" tab: the changed files, branch → base, title and description (the AI's proposal prefilled, editable) and the
 *  button. Only this click publishes; progress and errors come with the task (task.publish), so a reload shows them too. */
export function PublishCard({ task, proposal, onPublished }: { task: CodeTaskPublic; proposal: PrProposal | null; onPublished: (r: PublishResult) => void }) {
  const t = useI18n().t.sandbox.code.pr;
  const [title, setTitle] = useState(proposal?.title ?? task.pr?.title ?? task.title);
  const [body, setBody] = useState(proposal?.body ?? task.goal);
  const [taken, setTaken] = useState(proposal?.key ?? null);
  const [files, setFiles] = useState<TaskDiff['files'] | null>(null);
  const [tick, setTick] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // a newer proposal of the AI replaces the fields (the user reviews it before clicking)
  if (proposal && proposal.key !== taken) { setTaken(proposal.key); setTitle(proposal.title); setBody(proposal.body); }
  useEffect(() => {
    let off = false;
    api.sandbox.diff(task.id).then(d => { if (!off) setFiles(d.files); }, e => { if (!off) setError(errorText(e)); });
    return () => { off = true; };
  }, [task.id, tick]);

  const running = sending || task.publish?.state === 'running';
  const progress = task.publish?.state === 'running' ? t.steps[task.publish.step] : sending ? t.steps.check : null;
  const last = !sending && !error && task.publish ? (task.publish.state === 'interrupted' ? t.interrupted : task.publish.state === 'failed' ? t.failed(task.publish.error ?? '') : null) : null;
  async function publish() {
    setSending(true); setError(null);
    try { onPublished(await api.sandbox.publish(task.id, { title, body })); setTick(n => n + 1); }
    catch (e) { setError(t.failed(errorText(e))); }
    finally { setSending(false); }
  }

  return (
    <form className={styles.form} aria-label={t.heading} onSubmit={e => { e.preventDefault(); void publish(); }}>
      <p className={styles.hint}>{t.lead}</p>
      <p className={styles.taskMeta}><code>{t.branch(task.branch, task.baseBranch)}</code></p>
      <div className={styles.field}>
        <span className={styles.label}>{t.files}</span>
        {files === null ? <p className={styles.muted}>{t.filesLoading}</p> : !files.length ? <p className={styles.muted}>{t.noFiles}</p> : (
          <ul className={styles.dfFiles}>{files.map(f => <li key={f.path}><code>{f.path}</code> <span className={styles.dfAdd}>+{f.added}</span> <span className={styles.dfDel}>−{f.removed}</span></li>)}</ul>
        )}
      </div>
      <label className={styles.field}>
        <span className={styles.label}>{t.title}</span>
        <input value={title} maxLength={200} required onChange={e => setTitle(e.target.value)} disabled={running} />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>{t.body}</span>
        <textarea value={body} rows={7} maxLength={20_000} onChange={e => setBody(e.target.value)} disabled={running} />
        <span className={styles.fieldHint}>{taken ? `${t.fromProposal} ` : ''}{t.bodyHint}</span>
      </label>
      <div className={styles.actions}>
        <Button variant="primary" type="submit" busy={running} disabled={running || !title.trim() || (files !== null && !files.length && !task.pr)}>{task.pr ? t.update : t.create}</Button>
        {progress && <span className={styles.muted} role="status">{progress}</span>}
      </div>
      {(error ?? last) && <p className={styles.bad} role="alert">{error ?? last}</p>}
    </form>
  );
}
