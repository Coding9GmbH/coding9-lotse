'use client';

import Link from 'next/link';
import type { CodeTaskPublic } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { statusTone } from '@/lib/sandbox-task';
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

export function TaskList({ tasks }: { tasks: CodeTaskPublic[] }) {
  const t = useI18n().t.sandbox.tasks;
  if (!tasks.length) return <p className={styles.empty}>{t.empty}</p>;
  return (
    <ul className={styles.taskList}>
      {tasks.map(task => (
        <li key={task.id}>
          <Link href={`/sandbox-coding/${task.id}`} className={styles.taskRow}>
            <span className={styles.taskTitle}>{task.title}</span>
            <span className={styles.taskMeta}>{task.repo} @ {task.baseBranch}</span>
            <TaskStatus task={task} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
