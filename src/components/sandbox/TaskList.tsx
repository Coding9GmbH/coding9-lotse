'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { CodeTaskPublic, PrStatus, TaskPr } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { middleTruncate, statusTone } from '@/lib/sandbox-task';
import { useShell } from '@/components/shell/ShellProvider';
import { Spinner } from '@/components/ui/Spinner';
import { zipAvailable } from './ZipCard';
import styles from './Sandbox.module.css';

/** Status badge: pip + text; while an action of the user runs (`pending`, e.g. "Pausiere …") a spinner with that text instead. */
export function TaskStatus({ task, pending }: { task: Pick<CodeTaskPublic, 'status'>; pending?: string | null }) {
  const t = useI18n().t.sandbox.tasks;
  if (pending) return <span className={styles.status} data-tone="busy" role="status"><Spinner size={11} />{pending}</span>;
  return (
    <span className={styles.status} data-tone={statusTone(task.status)}>
      {statusTone(task.status) === 'busy' ? <Spinner size={11} /> : <i className={styles.pip} aria-hidden="true" />}{t.status[task.status]}
    </span>
  );
}

/** "PR #n · offen/gemergt/geschlossen": the state the PR watcher recorded (merged, closed), else GitHub's live state (cached on the
 *  server; the watcher stops when a sandbox is finished, so a finished one may have been merged later). Unknown: the number only. */
function PrLink({ taskId, pr }: { taskId: string; pr: TaskPr }) {
  const prState = useI18n().t.sandbox.code.pr.state;
  const [live, setLive] = useState<PrStatus['state'] | null>(null);
  useEffect(() => {
    if (pr.state) return;
    let off = false;
    api.sandbox.prStatus(taskId).then(r => { if (!off && r.pr) setLive(r.pr.state); }, () => {});
    return () => { off = true; };
  }, [taskId, pr.number, pr.state]);
  const state = pr.state ?? live;
  return <a className={styles.taskPr} href={pr.url} target="_blank" rel="noopener noreferrer" title={pr.title}>PR #{pr.number}{state ? ` · ${prState[state]}` : ''}</a>;
}

/** "ZIP" next to a Shopware sandbox: checks the plugin and downloads it for the Shopware admin; what is missing shows below the row. */
function ZipLink({ taskId }: { taskId: string }) {
  const t = useI18n().t.sandbox.code.zip;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true); setError(null);
    try {
      const c = await api.sandbox.zipCheck(taskId);
      if (!c.ok) setError(t.failed(c.problems.map(p => t.problems[p]).join(' ')));
      else await api.sandbox.zipDownload(taskId);
    } catch (e) { setError(t.failed(errorText(e))); } finally { setBusy(false); }
  }
  return (
    <>
      <button type="button" className={`${styles.textBtn} ${styles.zipLink}`} onClick={() => void go()} disabled={busy} title={t.shortTitle} aria-label={t.button} aria-busy={busy || undefined}>
        {busy ? <Spinner size={11} /> : null}{t.short}
      </button>
      {error && <p className={`${styles.bad} ${styles.taskNote}`} role="alert">{error}</p>}
    </>
  );
}

/** Sandboxes with status, repository and pull request (#number and its state, links to GitHub). A row opens the chat the sandbox is attached to (the workspace shows it on the right);
 *  a finished one without its chat opens the task's overview. A Shopware sandbox that is not finished offers its plugin as ZIP. */
export function TaskList({ tasks }: { tasks: CodeTaskPublic[] }) {
  const { t: all } = useI18n();
  const t = all.sandbox.tasks;
  const { nav } = useShell();
  if (!tasks.length) return <p className={styles.empty}>{t.empty}</p>;
  return (
    <ul className={styles.taskList}>
      {tasks.map(task => {
        const inner = (
          <>
            <span className={styles.taskTitle}>{task.title}</span>
            <span className={styles.taskMeta} title={`${task.repo} @ ${task.baseBranch}`}>{middleTruncate(task.repo, 40)} @ {task.baseBranch}</span>
            <TaskStatus task={task} />
          </>
        );
        return (
          <li key={task.id}>
            {task.chatId
              ? <Link href="/" className={styles.taskRow} title={t.openChat} onClick={e => { e.preventDefault(); nav.openChat(task.chatId!); }}>{inner}</Link>
              : <Link href={`/sandbox-coding/${task.id}`} className={styles.taskRow}>{inner}</Link>}
            {task.pr && <PrLink taskId={task.id} pr={task.pr} />}
            {zipAvailable(task) && <ZipLink taskId={task.id} />}
          </li>
        );
      })}
    </ul>
  );
}
