'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { CodeTaskPublic } from '@/lib/protocol';
import { useTaskEvents } from '@/hooks/useTaskEvents';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { IconClose } from '@/components/ui/icons';
import pp from '@/components/preview/PreviewPane.module.css';
import { DiffPanel } from './DiffPanel';
import { DumpUpload } from './DumpUpload';
import { SandboxOff } from './SandboxOff';
import { SandboxPreview } from './SandboxPreview';
import { StepTimeline } from './StepTimeline';
import { TaskStatus } from './TaskList';
import styles from './Sandbox.module.css';

type Tab = 'preview' | 'setup' | 'changes';
type Action = 'start' | 'stop' | 'pause' | 'resume' | 'finish';
/** Statuses in which the setup tab is the interesting one */
const SETUP = new Set(['setting_up', 'failed', 'interrupted']);

/**
 * Right panel of a chat with an attached sandbox (instead of the draft preview): a compact status line with the lifecycle buttons and
 * the tabs Vorschau (the task's storefront), Einrichtung (step timeline) and Änderungen (diff). During the setup it shows
 * "Einrichtung" and switches to "Vorschau" once the sandbox is ready. `files`: file cards so far (refreshes the diff).
 */
export function SandboxPanel({ taskId, className, reload, files, busy, onSendNotes, onClose, onTask }: {
  taskId: string; className?: string; reload: number; files: number; busy: boolean;
  onSendNotes?: (text: string) => void; onClose?: () => void; onTask?: (task: CodeTaskPublic) => void;
}) {
  const { t: all } = useI18n();
  const t = all.sandbox.task, tc = all.sandbox.code;
  const { task, setTask, error, gone, off } = useTaskEvents(taskId);
  const [tab, setTab] = useState<Tab | null>(null); // null = automatic (setup while setting up, then preview)
  const [seen, setSeen] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [newDump, setNewDump] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [idle, setIdle] = useState(30);
  useEffect(() => { api.sandbox.env().then(v => setIdle(v.env.idleMinutes), () => {}); }, []);

  // setup → ready switches to the preview (also when the setup tab was picked by hand meanwhile)
  const status = task?.status ?? null;
  if (status !== seen) {
    if (seen === 'setting_up' && status === 'ready' && tab === 'setup') setTab(null);
    setSeen(status);
  }
  // the workspace follows the status (finished = detached)
  useEffect(() => { if (task) onTask?.(task); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps -- only on status changes
  const shown: Tab = tab ?? (status && SETUP.has(status) ? 'setup' : 'preview');

  async function act(action: Action, body: { fromStep?: string; ignoreVersion?: boolean } = {}) {
    if (!task) return;
    if (action === 'finish' && !window.confirm(t.finishConfirm(task.title))) return;
    setActing(true); setNotice(null);
    try { setTask((await api.sandbox.taskAction(task.id, action, body)).task); } catch (e) { setNotice(t.actionFailed(errorText(e))); } finally { setActing(false); }
  }
  async function replaceDb() {
    if (!newDump || !task) return;
    setActing(true); setNotice(null);
    try { setTask((await api.sandbox.replaceDb(task.id, newDump)).task); setReplacing(false); setNewDump(null); } catch (e) { setNotice(t.actionFailed(errorText(e))); } finally { setActing(false); }
  }

  const close = onClose && <button type="button" className={pp.close} onClick={onClose} aria-label={tc.close} title={tc.close}><IconClose size={18} /></button>;
  const frame = (body: React.ReactNode) => (
    <section className={[pp.right, className].filter(Boolean).join(' ')} aria-label={tc.heading}>
      {body}
    </section>
  );
  if (off) return frame(<><div className={pp.bar}><span className={pp.ttl}>{tc.heading}</span>{close}</div><div className={styles.panelBody}><SandboxOff status={off} /></div></>);
  if (gone || !task) return frame(<><div className={pp.bar}><span className={pp.ttl}>{tc.heading}</span>{close}</div><div className={styles.panelBody}><p className={styles.muted}>{gone ? t.gone : error ? t.connection(error) : t.loading}</p></div></>);

  const s = task.status, hint = t.hints[s];
  return frame(
    <>
      <div className={pp.bar}>
        <span className={pp.ttl} title={`${task.repo} · ${task.branch}`}>{task.title}<small>{task.repo} @ {task.baseBranch}</small></span>
        <TaskStatus task={task} />
        {s === 'setting_up' && <Button size="sm" onClick={() => void act('stop')} disabled={acting}>{t.actions.stop}</Button>}
        {s === 'ready' && <Button size="sm" onClick={() => void act('pause')} disabled={acting}>{t.actions.pause}</Button>}
        {s === 'paused' && <Button size="sm" variant="primary" onClick={() => void act('resume')} disabled={acting}>{t.actions.resume}</Button>}
        {(s === 'failed' || s === 'interrupted') && <Button size="sm" variant="primary" onClick={() => void act('start')} disabled={acting}>{t.actions.retry}</Button>}
        {s !== 'done' && <Button size="sm" variant="danger" onClick={() => void act('finish')} disabled={acting}>{t.actions.finish}</Button>}
        {close}
      </div>
      <div className={styles.panelTabs} role="tablist" aria-label={tc.tabs.label}>
        {(['preview', 'setup', 'changes'] as Tab[]).map(k => (
          <button key={k} type="button" role="tab" id={`sbx-tab-${k}`} aria-selected={shown === k} aria-controls={`sbx-panel-${k}`} onClick={() => setTab(k)}>
            {tc.tabs[k]}{k === 'changes' && files > 0 && <span className={styles.tabCount}>{files}</span>}
          </button>
        ))}
        <Link href="/sandbox-coding" className={styles.panelLink}>{t.back}</Link>
      </div>
      {notice && <p className={`${styles.bad} ${styles.panelNote}`} role="alert">{notice}</p>}
      <div className={styles.panelBody}>
        <div role="tabpanel" id="sbx-panel-preview" aria-labelledby="sbx-tab-preview" hidden={shown !== 'preview'}>
          <SandboxPreview task={task} reload={reload} inTabs onSendNotes={onSendNotes} />
        </div>
        <section role="tabpanel" id="sbx-panel-setup" aria-labelledby="sbx-tab-setup" hidden={shown !== 'setup'} className={styles.card}>
          <p className={styles.hint} role="status">{typeof hint === 'function' ? hint(idle) : hint}</p>
          <p className={styles.taskMeta}>
            {t.branchInfo(task.baseBranch, task.branch)} · {all.sandbox.templates[task.template] ?? task.template}
            {' · '}{task.container ? (task.container.running ? t.container.running : t.container.stopped) : t.container.none}
            {task.layout && <> · {task.layout.pluginDir}</>}
            {task.dump && <> · {all.sandbox.dump.info(task.dump.name, task.dump.size)} ({task.dump.imported ? all.sandbox.dump.imported : task.dump.deleted ? all.sandbox.dump.deleted : all.sandbox.dump.waiting})</>}
          </p>
          {error && <p className={styles.muted}>{t.connection(error)}</p>}
          <StepTimeline task={task} busy={acting} onRetry={stepId => void act('start', { fromStep: stepId })} onIgnoreVersion={() => void act('start', { fromStep: 'version-check', ignoreVersion: true })} />
          {['ready', 'paused', 'failed', 'interrupted'].includes(s) && <div className={styles.actions}><Button size="sm" onClick={() => setReplacing(true)} disabled={acting}>{all.sandbox.dump.replace}</Button></div>}
        </section>
        <section role="tabpanel" id="sbx-panel-changes" aria-labelledby="sbx-tab-changes" hidden={shown !== 'changes'} className={styles.card}>
          {shown === 'changes' && <DiffPanel taskId={task.id} refresh={files + (busy ? 0 : 1)} />}
        </section>
      </div>
      <Dialog open={replacing} onClose={() => { setReplacing(false); setNewDump(null); }} title={all.sandbox.dump.replaceTitle} wide footer={
        <>
          <Button variant="ghost" onClick={() => { setReplacing(false); setNewDump(null); }}>{all.sandbox.create.cancel}</Button>
          <Button variant="primary" onClick={() => void replaceDb()} busy={acting} disabled={!newDump || uploading || acting}>{all.sandbox.dump.replaceSubmit}</Button>
        </>
      }>
        <div className={styles.form}>
          <p className={styles.hint}>{all.sandbox.dump.replaceLead}</p>
          <DumpUpload onChange={d => setNewDump(d?.id ?? null)} onBusy={setUploading} disabled={acting} />
        </div>
      </Dialog>
    </>,
  );
}
