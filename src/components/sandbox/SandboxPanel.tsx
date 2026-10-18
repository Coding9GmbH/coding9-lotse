'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { ChatEvent, CodeTaskPublic, InternetPolicy, PublishResult } from '@/lib/protocol';
import { canRetryFrom, middleTruncate, newerTask } from '@/lib/sandbox-task';
import { useTaskEvents } from '@/hooks/useTaskEvents';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { IconClose, IconCopy, IconGlobe } from '@/components/ui/icons';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import pp from '@/components/preview/PreviewPane.module.css';
import { DiffPanel } from './DiffPanel';
import { DumpUpload } from './DumpUpload';
import { PrCard } from './PrCard';
import { PublishCard, type PrProposal } from './PublishCard';
import { SandboxOff } from './SandboxOff';
import { SandboxPreview } from './SandboxPreview';
import { ShotList } from './ShotList';
import { StepTimeline } from './StepTimeline';
import { TaskStatus } from './TaskList';
import { ZipCard, zipAvailable } from './ZipCard';
import styles from './Sandbox.module.css';

type Tab = 'preview' | 'setup' | 'changes' | 'pr';
type Action = 'start' | 'stop' | 'pause' | 'resume' | 'finish';
/** Statuses in which the setup tab is the interesting one */
const SETUP = new Set(['setting_up', 'failed', 'interrupted']);

/**
 * Right panel of a chat with an attached sandbox (instead of the draft preview). Header in two lines: title and status, then the
 * repository (shortened in the middle, full in the tooltip) with the working branch and a copy button; on the right the internet state,
 * the one lifecycle action that fits the status and a "⋯" menu (finish, replace the database, all sandboxes).
 * Tabs: Vorschau (the task's storefront, full width, full screen; "Screenshot" while switched on), Einrichtung (step timeline),
 * Änderungen (the AI's commits, what is not committed yet, diff per file) and Freigabe (= pull request: status, form with a sticky
 * button, the screenshots the user took, "Plugin als ZIP" for the Shopware admin). Plain words first, technical terms as tooltip. During the setup it shows "Einrichtung" and switches to
 * "Vorschau" once the sandbox is ready. `files`: file cards so far (refreshes the diff); `openPr` changing opens the PR tab.
 */
export function SandboxPanel({ taskId, className, reload, files, busy, proposal, openPr = 0, feedbackOpen = 0, chatHidden, onToggleChat, onPublished, onSendNotes, onClose, onTask, onChatEvent }: {
  taskId: string; className?: string; reload: number; files: number; busy: boolean;
  proposal?: PrProposal | null; openPr?: number; onPublished?: (r: PublishResult) => void;
  /** PR feedback in the chat not handed to the AI yet: a dot on the tab and a warning when finishing */ feedbackOpen?: number;
  /** the workspace's chat column is collapsed (the preview gets the whole width) */ chatHidden?: boolean; onToggleChat?: () => void;
  onSendNotes?: (text: string) => void; onClose?: () => void; onTask?: (task: CodeTaskPublic) => void;
  /** events the server added to the chat between turns (PR feedback, a failed setup) */ onChatEvent?: (ev: ChatEvent) => void;
}) {
  const { t: all } = useI18n();
  const t = all.sandbox.task, tc = all.sandbox.code;
  const router = useRouter();
  const { task, setTask: replaceTask, error, gone, off } = useTaskEvents(taskId, onChatEvent);
  const setTask = (next: CodeTaskPublic) => replaceTask(cur => newerTask(cur, next));
  const [tab, setTab] = useState<Tab | null>(null); // null = automatic (setup while setting up, then preview)
  const [seen, setSeen] = useState<string | null>(null);
  const [acting, setActing] = useState<Action | 'internet' | 'db' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [newDump, setNewDump] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [idle, setIdle] = useState(30);
  const [policy, setPolicy] = useState<InternetPolicy>('approval');
  const [shotPages, setShotPages] = useState<string[] | null>(null); // null = screenshots switched off
  const [prSeen, setPrSeen] = useState(openPr);
  const [prTick, setPrTick] = useState(0);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [phone, setPhone] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const on = () => setPhone(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  if (openPr !== prSeen) { setPrSeen(openPr); setTab('pr'); }
  useEffect(() => { api.sandbox.env().then(v => { setIdle(v.env.idleMinutes); setPolicy(v.env.internet); setShotPages(v.env.screenshots ? v.env.screenshotPaths : null); }, () => {}); }, []);
  useEffect(() => {
    if (!full) return;
    // an Escape that closes a menu or a dialog does only that
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !(e.target as HTMLElement | null)?.closest('[role=menu], [aria-haspopup][aria-expanded=true], dialog')) setFull(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [full]);

  // setup → ready switches to the preview (also when the setup tab was picked by hand meanwhile)
  const status = task?.status ?? null;
  if (status !== seen) {
    if (seen === 'setting_up' && status === 'ready' && tab === 'setup') setTab(null);
    setSeen(status);
  }
  // the workspace follows the status (finished = detached) and the internet state (the chat's request cards)
  const net = !!task?.internet;
  useEffect(() => { if (task) onTask?.(task); }, [status, net]); // eslint-disable-line react-hooks/exhaustive-deps -- only on status/internet changes
  const shown: Tab = tab ?? (status && SETUP.has(status) ? 'setup' : 'preview');

  async function act(action: Action, extra: { fromStep?: string; ignoreVersion?: boolean } = {}) {
    if (!task) return;
    if (action === 'finish' && !window.confirm(t.finishConfirm(task.title) + (feedbackOpen ? t.feedbackOpen(feedbackOpen) : ''))) return;
    setActing(action); setNotice(null);
    try { setTask((await api.sandbox.taskAction(task.id, action, extra)).task); } catch (e) { setNotice(t.actionFailed(errorText(e))); } finally { setActing(null); }
  }
  async function toggleInternet(on: boolean) {
    if (!task || (on && !window.confirm(t.internet.confirm))) return;
    setActing('internet'); setNotice(null);
    try { setTask((await api.sandbox.internet(task.id, on)).task); } catch (e) { setNotice(t.actionFailed(errorText(e))); } finally { setActing(null); }
  }
  async function replaceDb() {
    if (!newDump || !task) return;
    setActing('db'); setNotice(null);
    try { setTask((await api.sandbox.replaceDb(task.id, newDump)).task); setReplacing(false); setNewDump(null); } catch (e) { setNotice(t.actionFailed(errorText(e))); } finally { setActing(null); }
  }
  const copyBranch = () => {
    if (!task) return;
    void navigator.clipboard?.writeText(task.branch).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  };

  const close = onClose && <button type="button" className={pp.close} onClick={onClose} aria-label={tc.close} title={tc.close}><IconClose size={18} /></button>;
  const frame = (content: React.ReactNode) => (
    <section className={[pp.right, styles.panel, className].filter(Boolean).join(' ')} aria-label={tc.heading} data-full={full || undefined}>
      {content}
    </section>
  );
  if (off) return frame(<><div className={pp.bar}><span className={pp.ttl}>{tc.heading}</span>{close}</div><div className={styles.panelBody}><SandboxOff status={off} /></div></>);
  if (gone || !task) return frame(<><div className={pp.bar}><span className={pp.ttl}>{tc.heading}</span>{close}</div><div className={styles.panelBody}><p className={styles.muted}>{gone ? t.gone : error ? t.connection(error) : t.loading}</p></div></>);

  const s = task.status, busyAct = acting !== null;
  // "paused" is stored before the container is stopped: until it is, header and body say "Pausiere …" and offer no "Fortsetzen"
  const stopping = s === 'paused' && !!task.stopping;
  const hint = stopping ? t.pending.pause : t.hints[s];
  const pending = acting && acting !== 'internet' && acting !== 'db' ? t.pending[acting] : stopping ? t.pending.pause : null;
  // the one lifecycle action of the header; a failed or interrupted setup is retried at its step ("Ab hier erneut versuchen")
  const stepRetry = task.steps.some(x => canRetryFrom(task, x));
  const life: Action | null = pending ? null // an action is running: its spinner in the status is enough, no button that contradicts it
    : s === 'setting_up' ? 'stop' : s === 'ready' ? 'pause' : s === 'paused' ? 'resume' : (s === 'failed' || s === 'interrupted') && !stepRetry ? 'start' : null;
  const lifeLabel = life === 'start' ? t.actions.retry : life ? t.actions[life] : '';
  const primary = life && !phone && <Button size="sm" variant={life === 'resume' || life === 'start' ? 'primary' : 'default'} onClick={() => void act(life)} disabled={busyAct}>{lifeLabel}</Button>;
  const canReplace = !!task.container && ['ready', 'paused', 'failed', 'interrupted'].includes(s);
  const menu: MenuItem[] = [
    // phones: one compact row (title, status, ⋯), the lifecycle action moves into the menu
    ...(life && phone ? [{ key: 'life', label: lifeLabel, onSelect: () => void act(life), disabled: busyAct }] : []),
    ...(canReplace ? [{ key: 'db', label: all.sandbox.dump.replace, onSelect: () => setReplacing(true), disabled: busyAct }] : []),
    { key: 'all', label: t.back, onSelect: () => router.push('/sandbox-coding') },
    ...(s !== 'done' ? [{ key: 'finish', label: t.actions.finish, onSelect: () => void act('finish'), disabled: busyAct, danger: true }] : []),
  ];
  const internetShown = s === 'ready' || !!task.internet;
  const attention: Partial<Record<Tab, boolean>> = { setup: s === 'failed', pr: feedbackOpen > 0 || task.publish?.state === 'failed' };

  return frame(
    <>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <div className={styles.headLine}>
            <h2 className={styles.headTitle} title={task.title}>{task.title}</h2>
            <TaskStatus task={task} pending={pending} />
          </div>
          <p className={styles.headWhere} title={t.where(task.repo, task.branch, task.baseBranch)}>
            <span className={styles.headRepo}>{middleTruncate(task.repo, 32)}</span>
            <span className={styles.headBranch}>{task.branch}</span>
            <button type="button" className={styles.copyBtn} onClick={copyBranch} aria-label={t.copyBranch} title={copied ? t.copied : t.copyBranch}><IconCopy size={13} /></button>
            {copied && <span className={styles.copied} role="status">{t.copied}</span>}
          </p>
        </div>
        <div className={styles.headActions}>
          {internetShown && (task.internet
            ? <span className={styles.netOn}>
              <span className={styles.netBadge}><IconGlobe size={14} />{t.internet.on}</span>
              <button type="button" className={styles.textBtn} aria-pressed="true" aria-label={t.internet.revoke} title={t.internet.revoke} disabled={busyAct} onClick={() => void toggleInternet(false)}>{t.internet.block}</button>
            </span>
            : <button type="button" className={styles.netOff} aria-pressed="false" disabled={busyAct || policy === 'never'}
              title={policy === 'never' ? t.internet.never : t.internet.allow} onClick={() => void toggleInternet(true)}><IconGlobe size={14} />{t.internet.off}</button>)}
          {primary}
          <Menu label={t.more} items={menu} />
          {close}
        </div>
      </header>
      <div className={styles.panelTabs} role="tablist" aria-label={tc.tabs.label}>
        {(['preview', 'setup', 'changes', 'pr'] as Tab[]).map(k => (
          <button key={k} type="button" role="tab" id={`sbx-tab-${k}`} aria-selected={shown === k} aria-controls={`sbx-panel-${k}`} onClick={() => setTab(k)} title={k === 'pr' ? tc.tech.pr : undefined}>
            {tc.tabs[k]}
            {k === 'changes' && files > 0 && <span className={styles.tabCount}>{files}</span>}
            {k === 'pr' && task.pr && <span className={styles.tabCount}>#{task.pr.number}</span>}
            {attention[k] && <i className={styles.tabDot} role="img" aria-label={tc.attention} />}
          </button>
        ))}
      </div>
      {notice && <p className={`${styles.bad} ${styles.panelNote}`} role="alert">{notice}</p>}
      <div ref={body} className={styles.panelBody} data-tab={shown}>
        <div role="tabpanel" id="sbx-panel-preview" aria-labelledby="sbx-tab-preview" hidden={shown !== 'preview'} className={styles.pvPanel}>
          <SandboxPreview task={task} reload={reload} inTabs onSendNotes={onSendNotes}
            layout={{ full, onFull: () => setFull(f => !f), chatHidden, onToggleChat: full ? undefined : onToggleChat }}
            shots={shotPages ? { pages: shotPages, onTaken: setTask } : undefined} />
        </div>
        <section role="tabpanel" id="sbx-panel-setup" aria-labelledby="sbx-tab-setup" hidden={shown !== 'setup'} className={styles.tabBody}>
          <p className={styles.hint} role="status">{typeof hint === 'function' ? hint(idle) : hint}</p>
          <p className={styles.taskMeta}>
            {t.branchInfo(task.baseBranch, task.branch)} · {all.sandbox.templates[task.template] ?? task.template}
            {' · '}{task.container ? (task.container.running ? t.container.running : t.container.stopped) : t.container.none}
            {task.layout && <> · {task.layout.pluginDir}</>}
            {task.dump && <> · {all.sandbox.dump.info(task.dump.name, task.dump.size)} ({task.dump.imported ? all.sandbox.dump.imported : task.dump.deleted ? all.sandbox.dump.deleted : all.sandbox.dump.waiting})</>}
          </p>
          {error && <p className={styles.muted}>{t.connection(error)}</p>}
          <StepTimeline task={task} busy={busyAct} onRetry={stepId => void act('start', { fromStep: stepId })} onIgnoreVersion={() => void act('start', { fromStep: 'version-check', ignoreVersion: true })} />
        </section>
        <section role="tabpanel" id="sbx-panel-changes" aria-labelledby="sbx-tab-changes" hidden={shown !== 'changes'} className={styles.tabBody}>
          {shown === 'changes' && <DiffPanel taskId={task.id} refresh={files + (busy ? 0 : 1)} />}
        </section>
        <section role="tabpanel" id="sbx-panel-pr" aria-labelledby="sbx-tab-pr" hidden={shown !== 'pr'} className={styles.tabBody}>
          {task.pr && (
            <div className={styles.prBox}>
              {published && published.pr.number === task.pr.number && <p className={styles.okBox} role="status">✓ {tc.pr.success[published.action](published.pr.number)}</p>}
              <PrCard taskId={task.id} pr={task.pr} refresh={prTick} />
            </div>
          )}
          {/* screenshots (only those the user took) sit inside the form, above its footer: the button stays at the bottom of the tab while scrolling */}
          {shown === 'pr' && (s !== 'done'
            ? <PublishCard task={task} proposal={proposal ?? null} onPublished={r => {
              setTask(r.task); setPrTick(n => n + 1); setPublished(r); onPublished?.(r);
              requestAnimationFrame(() => body.current?.scrollTo({ top: 0, behavior: 'smooth' }));
            }}><ShotList task={task} /></PublishCard>
            : <ShotList task={task} />)}
          {shown === 'pr' && zipAvailable(task) && <ZipCard task={task} refresh={files + (busy ? 0 : 1)} onAskAi={onSendNotes} />}
        </section>
      </div>
      <Dialog open={replacing} onClose={() => { setReplacing(false); setNewDump(null); }} title={all.sandbox.dump.replaceTitle} wide footer={
        <>
          <Button variant="ghost" onClick={() => { setReplacing(false); setNewDump(null); }}>{all.sandbox.create.cancel}</Button>
          <Button variant="primary" onClick={() => void replaceDb()} busy={acting === 'db'} disabled={!newDump || uploading || busyAct}>{all.sandbox.dump.replaceSubmit}</Button>
        </>
      }>
        <div className={styles.form}>
          <p className={styles.hint}>{all.sandbox.dump.replaceLead}</p>
          <DumpUpload onChange={d => setNewDump(d?.id ?? null)} onBusy={setUploading} disabled={busyAct} />
        </div>
      </Dialog>
    </>,
  );
}
