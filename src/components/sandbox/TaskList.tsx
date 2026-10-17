'use client';

import Link from 'next/link';
import type { CodeTaskPublic } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { statusTone } from '@/lib/sandbox-task';
import { useShell } from '@/components/shell/ShellProvider';
import styles from './Sandbox.module.css';

/** Status pip + text; done with a pull request reads "Veröffentlicht". */
export function TaskStatus({ task }: { task: Pick<CodeTaskPublic, 'status' | 'prUrl'> }) {
  const t = useI18n().t.sandbox.tasks;
  return (
    <span className={styles.status} data-tone={statusTone(task.status)}>
      <i className={styles.pip} aria-hidden="true" />{task.status === 'done' && task.prUrl ? t.published : t.status[task.status]}
    </span>
  );
}

/** Sandboxes with status, repository and pull request (#number, links to GitHub). A row opens the chat the sandbox is attached to (the workspace shows it on the right);
 *  a finished one without its chat opens the task's overview. */
export function TaskList({ tasks }: { tasks: CodeTaskPublic[] }) {
  const t = useI18n().t.sandbox.tasks;
  const { nav } = useShell();
  if (!tasks.length) return <p className={styles.empty}>{t.empty}</p>;
  return (
    <ul className={styles.taskList}>
      {tasks.map(task => {
        const inner = (
          <>
            <span className={styles.taskTitle}>{task.title}</span>
            <span className={styles.taskMeta}>{task.repo} @ {task.baseBranch}</span>
            <TaskStatus task={task} />
          </>
        );
        return (
          <li key={task.id}>
            {task.chatId
              ? <Link href="/" className={styles.taskRow} title={t.openChat} onClick={e => { e.preventDefault(); nav.openChat(task.chatId!); }}>{inner}</Link>
              : <Link href={`/sandbox-coding/${task.id}`} className={styles.taskRow}>{inner}</Link>}
            {task.pr && <a className={styles.taskPr} href={task.pr.url} target="_blank" rel="noopener noreferrer" title={task.pr.title}>#{task.pr.number}</a>}
          </li>
        );
      })}
    </ul>
  );
}
