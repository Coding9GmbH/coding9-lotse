'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorText } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useTaskEvents } from '@/hooks/useTaskEvents';
import { Button } from '@/components/ui/Button';
import { SandboxOff } from './SandboxOff';
import { StepTimeline } from './StepTimeline';
import { TaskStatus } from './TaskList';
import styles from './Sandbox.module.css';

type Action = 'start' | 'stop' | 'pause' | 'resume' | 'finish';

/** One code task: header (repo, branch, template, container), lifecycle buttons, goal and the live step timeline. */
export function TaskView({ id, idleMinutes }: { id: string; idleMinutes: number }) {
  const { t: all } = useI18n();
  const t = all.sandbox.task;
  const router = useRouter();
  const { task, setTask, error, gone, off } = useTaskEvents(id);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function act(action: Action, body: { fromStep?: string } = {}) {
    if (!task) return;
    if (action === 'finish' && !window.confirm(t.finishConfirm(task.title))) return;
    setBusy(true); setNotice(null);
    try { setTask((await api.sandbox.taskAction(id, action, body)).task); } catch (e) { setNotice(t.actionFailed(errorText(e))); } finally { setBusy(false); }
  }
  async function remove() {
    if (!task || !window.confirm(t.removeConfirm(task.title))) return;
    setBusy(true);
    try { await api.sandbox.deleteTask(id); router.push('/sandbox-coding'); } catch (e) { setNotice(t.actionFailed(errorText(e))); setBusy(false); }
  }

  const back = <Link className={styles.back} href="/sandbox-coding">← {t.back}</Link>;
  if (off) return <div className={styles.page}><main className={styles.wrap}>{back}<SandboxOff status={off} /></main></div>;
  if (gone) return <div className={styles.page}><main className={styles.wrap}>{back}<p className={styles.alert}>{t.gone}</p></main></div>;
  if (!task) return <div className={styles.page}><main className={styles.wrap}>{back}<p className={styles.muted}>{error ? t.connection(error) : t.loading}</p></main></div>;

  const s = task.status, hint = t.hints[s];
  return (
    <div className={styles.page}>
      <main className={styles.wrap}>
        {back}
        <header className={styles.taskHead}>
          <h1 className={styles.h1}>{task.title}</h1>
          <TaskStatus task={task} />
        </header>
        <p className={styles.taskMeta}>
          <b>{task.repo}</b> {t.branchInfo(task.baseBranch, task.branch)} · {all.sandbox.templates[task.template] ?? task.template}
          {' · '}{task.container ? (task.container.running ? t.container.running : t.container.stopped) : t.container.none}
          {task.layout && <> · {task.layout.pluginDir}</>}
        </p>
        <p className={styles.hint} role="status">{typeof hint === 'function' ? hint(idleMinutes) : hint}</p>
        {error && <p className={styles.muted}>{t.connection(error)}</p>}

        <div className={styles.actions}>
          {s === 'setting_up' && <Button onClick={() => void act('stop')} disabled={busy}>{t.actions.stop}</Button>}
          {s === 'ready' && <Button onClick={() => void act('pause')} disabled={busy}>{t.actions.pause}</Button>}
          {s === 'paused' && <Button variant="primary" onClick={() => void act('resume')} disabled={busy}>{t.actions.resume}</Button>}
          {(s === 'failed' || s === 'interrupted') && <Button variant="primary" onClick={() => void act('start')} disabled={busy}>{t.actions.retry}</Button>}
          {s !== 'done' && <Button variant="danger" onClick={() => void act('finish')} disabled={busy}>{t.actions.finish}</Button>}
          {s === 'done' && <Button variant="danger" onClick={() => void remove()} disabled={busy}>{t.actions.remove}</Button>}
          {notice && <span className={styles.bad} role="alert">{notice}</span>}
        </div>

        {task.goal && (
          <section className={styles.card} aria-labelledby="sbx-goal">
            <div className={styles.cardHead}><h2 id="sbx-goal">{t.goal}</h2></div>
            <p className={styles.goal}>{task.goal}</p>
          </section>
        )}
        <section className={styles.card} aria-labelledby="sbx-steps">
          <div className={styles.cardHead}><h2 id="sbx-steps">{t.steps}</h2></div>
          <StepTimeline task={task} busy={busy} onRetry={stepId => void act('start', { fromStep: stepId })} />
        </section>
      </main>
    </div>
  );
}
