'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useTaskEvents } from '@/hooks/useTaskEvents';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { DumpPicker } from './DumpPicker';
import { SandboxOff } from './SandboxOff';
import { useShell } from '@/components/shell/ShellProvider';
import { StepTimeline } from './StepTimeline';
import { TaskStatus } from './TaskList';
import styles from './Sandbox.module.css';

type Action = 'start' | 'stop' | 'pause' | 'resume' | 'finish';

/** Overview of one sandbox task. The work happens in the chat it is attached to: an active task with a chat opens that chat
 *  (the workspace shows the sandbox on the right); a finished one stays here as a record (header, steps, remove). */
export function TaskView({ id, idleMinutes }: { id: string; idleMinutes: number }) {
  const { t: all } = useI18n();
  const t = all.sandbox.task;
  const router = useRouter();
  const { nav } = useShell();
  const { task, setTask, error, gone, off } = useTaskEvents(id);
  const toChat = !!task?.chatId && task.status !== 'done';
  useEffect(() => { if (toChat && task?.chatId) nav.openChat(task.chatId); }, [toChat]); // eslint-disable-line react-hooks/exhaustive-deps -- once the task is known
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [replacing, setReplacing] = useState(false);
  const [newDump, setNewDump] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function replaceDb() {
    if (!newDump) return;
    setBusy(true); setNotice(null);
    try { setTask((await api.sandbox.replaceDb(id, newDump)).task); setReplacing(false); setNewDump(null); } catch (e) { setNotice(all.sandbox.task.actionFailed(errorText(e))); } finally { setBusy(false); }
  }
  async function act(action: Action, body: { fromStep?: string; ignoreVersion?: boolean } = {}) {
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

  if (toChat) return <div className={styles.page}><main className={styles.wrap}>{back}<p className={styles.muted} role="status">{t.redirecting}</p></main></div>;

  const s = task.status, hint = t.hints[s];
  return (
    <div className={styles.page}>
      <main className={`${styles.wrap} ${styles.wrapWide}`}>
        {back}
        <header className={styles.taskHead}>
          <h1 className={styles.h1}>{task.title}</h1>
          <TaskStatus task={task} />
        </header>
        <p className={styles.taskMeta}>
          <b>{task.repo}</b> {t.branchInfo(task.baseBranch, task.branch)} · {all.sandbox.templates[task.template] ?? task.template}
          {' · '}{task.container ? (task.container.running ? t.container.running : t.container.stopped) : t.container.none}
          {task.layout && <> · {task.layout.pluginDir}</>}
          {task.dump && <> · {(task.dump.library ? all.sandbox.dump.infoStored : all.sandbox.dump.info)(task.dump.name, task.dump.size)} ({task.dump.restored ? all.sandbox.dump.restored : task.dump.imported ? all.sandbox.dump.imported : task.dump.deleted ? all.sandbox.dump.deleted : all.sandbox.dump.waiting})</>}
        </p>
        <p className={styles.hint} role="status">{typeof hint === 'function' ? hint(idleMinutes) : hint}</p>
        {error && <p className={styles.muted}>{t.connection(error)}</p>}

        <div className={styles.actions}>
          {s === 'setting_up' && <Button onClick={() => void act('stop')} disabled={busy}>{t.actions.stop}</Button>}
          {s === 'ready' && <Button onClick={() => void act('pause')} disabled={busy}>{t.actions.pause}</Button>}
          {s === 'paused' && <Button variant="primary" onClick={() => void act('resume')} disabled={busy}>{t.actions.resume}</Button>}
          {(s === 'failed' || s === 'interrupted') && <Button variant="primary" onClick={() => void act('start')} disabled={busy}>{t.actions.retry}</Button>}
          {['ready', 'paused', 'failed', 'interrupted'].includes(s) && <Button onClick={() => setReplacing(true)} disabled={busy}>{all.sandbox.dump.replace}</Button>}
          {s !== 'done' && <Button variant="danger" onClick={() => void act('finish')} disabled={busy}>{t.actions.finish}</Button>}
          {s === 'done' && <Button variant="danger" onClick={() => void remove()} disabled={busy}>{t.actions.remove}</Button>}
          {notice && <span className={styles.bad} role="alert">{notice}</span>}
        </div>

        {task.chatId && <p><button type="button" className={styles.linkBtn} onClick={() => nav.openChat(task.chatId!)}>{t.toChat}</button></p>}
        {task.goal && (
          <section className={styles.card} aria-labelledby="sbx-goal">
            <div className={styles.cardHead}><h2 id="sbx-goal">{t.goal}</h2></div>
            <p className={styles.goal}>{task.goal}</p>
          </section>
        )}
        <section className={styles.card} aria-labelledby="sbx-steps">
          <div className={styles.cardHead}><h2 id="sbx-steps">{t.steps}</h2></div>
          <StepTimeline task={task} busy={busy} onRetry={stepId => void act('start', { fromStep: stepId })} onIgnoreVersion={() => void act('start', { fromStep: 'version-check', ignoreVersion: true })} />
        </section>
        <Dialog open={replacing} onClose={() => { setReplacing(false); setNewDump(null); }} title={all.sandbox.dump.replaceTitle} wide footer={
          <>
            <Button variant="ghost" onClick={() => { setReplacing(false); setNewDump(null); }}>{all.sandbox.create.cancel}</Button>
            <Button variant="primary" onClick={() => void replaceDb()} busy={busy} disabled={!newDump || uploading || busy}>{all.sandbox.dump.replaceSubmit}</Button>
          </>
        }>
          <div className={styles.form}>
            <p className={styles.hint}>{all.sandbox.dump.replaceLead}</p>
            {replacing && <DumpPicker allowNone={false} onChange={setNewDump} onBusy={setUploading} disabled={busy} />}
          </div>
        </Dialog>
      </main>
    </div>
  );
}
