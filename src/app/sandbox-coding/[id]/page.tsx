import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SandboxOff } from '@/components/sandbox/SandboxOff';
import { TaskView } from '@/components/sandbox/TaskView';
import { getMessages } from '@/lib/i18n/server';
import { sandboxPublic, sandboxStatus } from '@/server/sandbox/env';
import { getTask } from '@/server/sandbox/tasks';
import styles from '@/components/sandbox/Sandbox.module.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const t = (await getMessages()).sandbox;
  const task = sandboxStatus().enabled ? getTask((await params).id) : null; // switched off: no task data, not even the title
  return { title: task ? `${task.title} · ${t.title}` : t.title };
}

/** Task view: the data comes live from the events route (snapshot + updates). Switched off: only the notice. */
export default async function SandboxTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^t_[a-z0-9]{12}$/.test(id)) notFound();
  const status = sandboxStatus();
  if (!status.enabled) {
    const back = (await getMessages()).sandbox.task.back;
    return <div className={styles.page}><main className={styles.wrap}><Link className={styles.back} href="/sandbox-coding">← {back}</Link><SandboxOff status={status} /></main></div>;
  }
  return <TaskView id={id} idleMinutes={sandboxPublic().idleMinutes} />;
}
