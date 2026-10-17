import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TaskView } from '@/components/sandbox/TaskView';
import { getMessages } from '@/lib/i18n/server';
import { sandboxPublic } from '@/server/sandbox/env';
import { getTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const t = (await getMessages()).sandbox;
  const task = getTask((await params).id);
  return { title: task ? `${task.title} · ${t.title}` : t.title };
}

/** Task view: the data comes live from the events route (snapshot + updates). */
export default async function SandboxTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^t_[a-z0-9]{12}$/.test(id)) notFound();
  return <TaskView id={id} idleMinutes={sandboxPublic().idleMinutes} />;
}
