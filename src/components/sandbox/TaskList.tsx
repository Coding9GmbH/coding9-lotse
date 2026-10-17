'use client';

import Link from 'next/link';
import type { CodeTaskPublic } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { middleTruncate, statusTone } from '@/lib/sandbox-task';
import { useShell } from '@/components/shell/ShellProvider';
import { Spinner } from '@/components/ui/Spinner';
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

/** Sandboxes with status, repository and pull request (#number, links to GitHub). A row opens the chat the sandbox is attached to (the workspace shows it on the right);
 *  a finished one without its chat opens the task's overview. */
export function TaskList({ tasks }: { tasks: CodeTaskPublic[] }) {
  const { t: all } = useI18n();
  const t = all.sandbox.tasks, prState = all.sandbox.code.pr.state;
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
            {task.pr && <a className={styles.taskPr} href={task.pr.url} target="_blank" rel="noopener noreferrer" title={task.pr.title}>PR #{task.pr.number}{task.pr.state ? ` · ${prState[task.pr.state]}` : ''}</a>}
          </li>
        );
      })}
    </ul>
  );
}
