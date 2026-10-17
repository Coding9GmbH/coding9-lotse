'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { CodeTaskPublic, CommandPhase, InternetPolicy, SandboxEnvPatch, SandboxEnvView } from '@/lib/protocol';
import { SANDBOX_DOCS, isBusy } from '@/lib/sandbox-task';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useShell } from '@/components/shell/ShellProvider';
import { Button } from '@/components/ui/Button';
import { IconArrowUp, IconClose, IconPlus } from '@/components/ui/icons';
import { SandboxOff } from './SandboxOff';
import { TaskList } from './TaskList';
import styles from './Sandbox.module.css';


interface VarRow { key: string; secret: boolean; value: string; hasValue: boolean; /** stored as secret with a value: unticking needs a new value */ wasSecret?: boolean }
interface CmdRow { id?: string; label: string; command: string; phase: CommandPhase; timeoutSec: string }
interface Form { image: string; defaultRepo: string; defaultBranch: string; internet: InternetPolicy; shots: string; vars: VarRow[]; cmds: CmdRow[] }
const formOf = (v: SandboxEnvView): Form => ({
  image: v.env.image, defaultRepo: v.env.defaultRepo, defaultBranch: v.env.defaultBranch, internet: v.env.internet, shots: v.env.screenshotPaths.join('\n'),
  vars: v.env.envVars.map(x => ({ ...x, wasSecret: x.secret && x.hasValue })),
  cmds: v.env.commands.map(c => ({ id: c.id, label: c.label, command: c.command, phase: c.phase, timeoutSec: String(c.timeoutSec) })),
});
const patchOf = (f: Form): SandboxEnvPatch => ({
  image: f.image.trim(), defaultRepo: f.defaultRepo.trim(), defaultBranch: f.defaultBranch.trim(), internet: f.internet,
  screenshotPaths: f.shots.split('\n').map(x => x.trim()).filter(Boolean),
  envVars: f.vars.filter(v => v.key.trim() || v.value).map(v => ({ key: v.key.trim(), secret: v.secret, ...(v.secret && !v.value ? {} : { value: v.value }) })),
  commands: f.cmds.filter(c => c.label.trim() || c.command.trim()).map(c => ({ ...(c.id ? { id: c.id } : {}), label: c.label, command: c.command, phase: c.phase, timeoutSec: Number(c.timeoutSec) || undefined })),
});
const same = (a: Form, b: Form) => JSON.stringify(patchOf(a)) === JSON.stringify(patchOf(b));

/** Tab "Sandbox Coding" as a dashboard: readiness (one line when everything is fine), the sandboxes, then the environment (collapsible:
 *  template, image, variables, own commands, check). Resources and the idle pause live in Settings → Sandbox (linked both ways). */
export function SandboxView() {
  const { t: all, locale } = useI18n();
  const t = all.sandbox;
  const { health, refreshHealth } = useShell();
  const [view, setView] = useState<SandboxEnvView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => api.sandbox.env().then(v => { setView(v); setLoadError(null); return v; }).catch(e => { setLoadError(errorText(e)); return null; }), []);
  useEffect(() => { void reload(); }, [reload]);

  const on = view?.env.status.enabled;
  // "#sbx-env" (a link from a failed setup command, the readiness list) opens the collapsed environment
  const openEnv = () => { const d = document.getElementById('sbx-env'); if (d instanceof HTMLDetailsElement) d.open = true; };
  useEffect(() => { if (view && window.location.hash === '#sbx-env') { openEnv(); document.getElementById('sbx-env')?.scrollIntoView(); } }, [view]);
  return (
    <div className={styles.page}>
      <main className={styles.wrap}>
        <h1 className={styles.h1}>{t.title}</h1>
        <p className={styles.lead}>{t.lead}</p>
        {loadError && <p className={styles.alert} role="alert">{t.env.loadFailed(loadError)}</p>}
        {!view && !loadError && <p className={styles.muted}>{all.settings.loading}</p>}

        {view && !on && (
          <SandboxOff status={view.env.status} />
        )}

        {view && on && (
          <>
            <Readiness checks={[
              { key: 'ai', ok: health ? health.ai.configured : null, label: t.ready.ai, fix: <Link href="/settings">{t.ready.fixAi}</Link> },
              { key: 'github', ok: health ? !!health.integrations?.github : null, label: t.ready.github, fix: <Link href="/settings/integrationen#github">{t.ready.fixGithub}</Link> },
              { key: 'docker', ok: view.docker?.reachable ?? null, label: t.ready.docker, fix: <a href={SANDBOX_DOCS[locale]} target="_blank" rel="noreferrer">{t.ready.fixDocker}</a> },
              { key: 'image', ok: view.imagePresent, label: t.ready.image, fix: <a href="#sbx-env" onClick={() => openEnv()}>{t.ready.fixImage}</a> },
            ]} />

            <Tasks />

            <Environment view={view} onSaved={setView} onChecked={() => { void reload(); refreshHealth(); }} />
          </>
        )}
      </main>
    </div>
  );
}

/** Sandbox list (polled while one starts); a new sandbox is started in a new chat of the workspace. */
function Tasks() {
  const t = useI18n().t.sandbox.tasks;
  const { nav } = useShell();
  const [tasks, setTasks] = useState<CodeTaskPublic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = !!tasks?.some(x => isBusy(x.status));
  useEffect(() => {
    let live = true;
    const load = () => api.sandbox.tasks().then(r => { if (live) { setTasks(r.tasks); setError(null); } }).catch(e => { if (live) setError(errorText(e)); });
    void load();
    const i = busy ? setInterval(load, 3000) : null;
    return () => { live = false; if (i) clearInterval(i); };
  }, [busy]);
  return (
    <section className={styles.card} aria-labelledby="sbx-tasks">
      <div className={styles.cardHead}>
        <h2 id="sbx-tasks">{t.heading}</h2>
        <Button size="sm" variant="primary" className={styles.headBtn} onClick={() => nav.sandboxChat()}><IconPlus size={14} /> {t.add}</Button>
      </div>
      {error && <p className={styles.alert} role="alert">{t.loadFailed(error)}</p>}
      {tasks && <TaskList tasks={tasks} />}
    </section>
  );
}

interface ReadyCheck { key: string; ok: boolean | null; label: string; fix: React.ReactNode }
/** Readiness: one green line when everything is set up (details on click), otherwise a banner with the count and the list. */
function Readiness({ checks }: { checks: ReadyCheck[] }) {
  const t = useI18n().t.sandbox.ready;
  const missing = checks.filter(c => c.ok === false).length, allOk = checks.every(c => c.ok);
  const [open, setOpen] = useState(false);
  const list = (
    <ul className={styles.checklist}>
      {checks.map(c => (
        <li key={c.key} className={styles.check}>
          <i className={`${styles.pip} ${c.ok ? styles.pipOk : c.ok === false ? styles.pipTodo : ''}`} aria-hidden="true" />
          <span>{c.label}</span>
          <span className={c.ok === false ? styles.badgeWarn : styles.muted}>{c.ok ? t.ok : c.ok === false ? t.todo : t.unknown}</span>
          {!c.ok && <span className={styles.fix}>{c.fix}</span>}
        </li>
      ))}
    </ul>
  );
  if (allOk) {
    return (
      <section className={`${styles.card} ${styles.readyOk}`} aria-labelledby="sbx-ready">
        <h2 id="sbx-ready" className="visually-hidden">{t.heading}</h2>
        <p className={styles.readyLine}><i className={`${styles.pip} ${styles.pipOk}`} aria-hidden="true" />{t.allOk}
          <button type="button" className={styles.textBtn} aria-expanded={open} onClick={() => setOpen(o => !o)}>{t.details}</button></p>
        {open && list}
      </section>
    );
  }
  return (
    <section className={styles.card} aria-labelledby="sbx-ready">
      <div className={styles.cardHead}><h2 id="sbx-ready">{t.heading}</h2></div>
      {missing > 0 && <p className={styles.alert} role="status">{t.blocked(missing)}</p>}
      {list}
    </section>
  );
}

/** A one-line hint with the details behind "Mehr dazu". */
function Hint({ text, more, small = false }: { text: string; more?: string; small?: boolean }) {
  const t = useI18n().t.sandbox.env;
  const body = <>{text}{more && <details className={styles.more}><summary>{t.more}</summary>{more}</details>}</>;
  return small ? <small className={styles.fieldHint}>{body}</small> : <div className={styles.hint}>{body}</div>;
}

/** Template (fixed), image, environment variables, own setup commands; "Umgebung prüfen" pulls the image if needed. */
function Environment({ view, onSaved, onChecked }: { view: SandboxEnvView; onSaved: (v: SandboxEnvView) => void; onChecked: () => void }) {
  const { t: all } = useI18n();
  const t = all.sandbox.env, ts = all.sandbox;
  const [saved, setSaved] = useState<Form>(() => formOf(view));
  const [envOpen, setEnvOpen] = useState(() => view.imagePresent === false); // open on the first setup, otherwise folded below the sandboxes
  const [form, setForm] = useState<Form>(saved);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [check, setCheck] = useState<{ running: boolean; progress: string | null; result: { ok: boolean; text: string } | null }>({ running: false, progress: null, result: null });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const dirty = !same(form, saved);
  const template = view.templates.find(x => x.id === view.env.templateId);
  const set = (fn: (f: Form) => Form) => { setForm(fn); setNotice(null); };
  const setVar = (i: number, p: Partial<VarRow>) => set(f => ({ ...f, vars: f.vars.map((v, j) => (j === i ? { ...v, ...p } : v)) }));
  const setCmd = (i: number, p: Partial<CmdRow>) => set(f => ({ ...f, cmds: f.cmds.map((c, j) => (j === i ? { ...c, ...p } : c)) }));

  async function save() {
    const unsecret = form.vars.find(v => v.wasSecret && !v.secret && !v.value);
    if (unsecret) { setNotice({ ok: false, text: t.notSaved(t.unsecretNeedsValue(unsecret.key)) }); return; }
    setSaving(true); setNotice(null);
    try {
      const v = await api.sandbox.save(patchOf(form));
      const next = formOf(v);
      setSaved(next); setForm(next); onSaved(v); setNotice({ ok: true, text: t.saved });
    } catch (e) { setNotice({ ok: false, text: t.notSaved(errorText(e)) }); }
    finally { setSaving(false); }
  }
  async function runCheck() {
    abort.current?.abort();
    const ac = new AbortController(); abort.current = ac;
    setCheck({ running: true, progress: null, result: null });
    try {
      await api.sandbox.check(ev => {
        if (ev.t === 'progress') setCheck(c => ({ ...c, progress: t.pulling(ev.text, ev.pct) }));
        else setCheck({ running: false, progress: null, result: { ok: ev.ok, text: ev.message } });
      }, ac.signal);
    } catch (e) { if (!ac.signal.aborted) setCheck({ running: false, progress: null, result: { ok: false, text: errorText(e) } }); return; }
    setCheck(c => ({ ...c, running: false }));
    onChecked();
  }

  return (
    <details id="sbx-env" className={`${styles.card} ${styles.envCard}`} open={envOpen} onToggle={e => setEnvOpen(e.currentTarget.open)}>
      <summary className={styles.envHead}><h2 id="sbx-env-h">{t.heading}</h2><span className={styles.muted}>{t.summary}</span></summary>
      <p className={styles.fieldHint}><Link href="/settings/sandbox">{t.resources}</Link></p>

      <div className={styles.row}>
        <span className={styles.label}>{t.template}</span>
        <b>{ts.templates[view.env.templateId] ?? view.env.templateId}</b>
      </div>
      <Hint text={t.templateHint} />
      {template && (
        <details className={styles.details}>
          <summary>{t.steps}</summary>
          <ol className={styles.stepList}>{template.steps.map(s => <li key={s.id}>{ts.steps[s.id]}</li>)}</ol>
        </details>
      )}

      <label className={styles.field}>
        <span className={styles.label}>{t.image}</span>
        <input value={form.image} onChange={e => set(f => ({ ...f, image: e.target.value }))} spellCheck={false} placeholder={template?.defaultImage} />
        <Hint small text={t.imageHint} more={t.imageMore} />
      </label>
      <p className={styles.muted} role="status">
        {view.docker && (view.docker.reachable ? t.docker(view.docker.version ?? '?', view.docker.mode) : t.dockerDown)}
        {view.docker?.reachable && view.imagePresent !== null && <> · {view.imagePresent ? t.present : t.missing}</>}
      </p>

      <h3 className={styles.h3}>{t.defaultsHeading}</h3>
      <p className={styles.hint}>{t.defaultsHint}</p>
      <div className={styles.defaultsRow}>
        <label className={styles.fieldTight}><span className={styles.label}>{t.defaultRepo}</span>
          <input placeholder={t.defaultRepoPlaceholder} value={form.defaultRepo} spellCheck={false} onChange={e => set(f => ({ ...f, defaultRepo: e.target.value }))} /></label>
        <label className={styles.fieldTight}><span className={styles.label}>{t.defaultBranch}</span>
          <input placeholder="main" value={form.defaultBranch} spellCheck={false} onChange={e => set(f => ({ ...f, defaultBranch: e.target.value }))} /></label>
      </div>

      <label className={styles.field}>
        <span className={styles.label}>{t.internet}</span>
        <select value={form.internet} onChange={e => set(f => ({ ...f, internet: e.target.value as InternetPolicy }))}>
          {(['approval', 'never'] as const).map(p => <option key={p} value={p}>{t.internetPolicy[p]}</option>)}
        </select>
        <Hint small text={t.internetHint} more={t.internetMore} />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>{t.shots}</span>
        <textarea rows={3} value={form.shots} spellCheck={false} placeholder="/" onChange={e => set(f => ({ ...f, shots: e.target.value }))} />
        <Hint small text={t.shotsHint} more={t.shotsMore} />
      </label>

      <h3 className={styles.h3}>{t.vars}</h3>
      <Hint text={t.varsHint} more={t.varsMore} />
      {form.vars.map((v, i) => (
        <div key={i} className={styles.varRow}>
          <input aria-label={t.key} placeholder={t.key} value={v.key} spellCheck={false} onChange={e => setVar(i, { key: e.target.value.toUpperCase() })} />
          <input aria-label={`${t.value} ${v.key}`} placeholder={v.secret && v.hasValue ? t.secretSaved : v.wasSecret ? t.unsecret : t.value} type={v.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false}
            value={v.value} onChange={e => setVar(i, { value: e.target.value })} />
          <label className={styles.secret} title={t.secretHint}><input type="checkbox" checked={v.secret} onChange={e => setVar(i, { secret: e.target.checked })} /> {t.secret}</label>
          <button type="button" className={styles.x} aria-label={t.removeVar(v.key)} onClick={() => set(f => ({ ...f, vars: f.vars.filter((_, j) => j !== i) }))}><IconClose size={16} /></button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => set(f => ({ ...f, vars: [...f.vars, { key: '', secret: false, value: '', hasValue: false }] }))}><IconPlus size={14} /> {t.addVar}</Button>

      <h3 className={styles.h3}>{t.commandsHeading}</h3>
      <Hint text={t.commandsHint} more={t.commandsMore} />
      {form.cmds.map((c, i) => (
        <div key={c.id ?? `new-${i}`} className={styles.cmd}>
          <div className={styles.cmdHead}>
            <input aria-label={t.commandLabel} placeholder={t.commandLabel} value={c.label} onChange={e => setCmd(i, { label: e.target.value })} />
            <select aria-label={t.phase} value={c.phase} onChange={e => setCmd(i, { phase: e.target.value as CommandPhase })}>
              {(['after-db', 'final'] as const).map(p => <option key={p} value={p}>{t.phases[p]}</option>)}
            </select>
            <span className={styles.unitField}><input aria-label={t.timeout} title={t.timeout} className={styles.num} inputMode="numeric" value={c.timeoutSec} onChange={e => setCmd(i, { timeoutSec: e.target.value })} /><span aria-hidden="true">{t.timeoutUnit}</span></span>
            <button type="button" className={styles.x} disabled={i === 0} aria-label={t.moveUp(c.label)} title={t.moveUp(c.label)} onClick={() => set(f => { const cmds = [...f.cmds]; [cmds[i - 1], cmds[i]] = [cmds[i], cmds[i - 1]]; return { ...f, cmds }; })}><IconArrowUp size={16} /></button>
            <button type="button" className={styles.x} aria-label={t.removeCommand(c.label)} onClick={() => set(f => ({ ...f, cmds: f.cmds.filter((_, j) => j !== i) }))}><IconClose size={16} /></button>
          </div>
          <textarea aria-label={`${t.command} ${c.label}`} placeholder="bin/console …" rows={2} spellCheck={false} value={c.command} onChange={e => setCmd(i, { command: e.target.value })} />
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => set(f => ({ ...f, cmds: [...f.cmds, { label: '', command: '', phase: 'after-db', timeoutSec: '600' }] }))}><IconPlus size={14} /> {t.addCommand}</Button>

      <div className={styles.actions}>
        <Button variant="primary" onClick={() => void save()} busy={saving} disabled={saving || !dirty}>{saving ? t.saving : t.save}</Button>
        <Button onClick={() => void runCheck()} busy={check.running} disabled={check.running || dirty} title={dirty ? t.unsaved : undefined}>{check.running ? t.checking : t.check}</Button>
        {dirty && !notice && <span className={styles.muted}>{t.unsaved}</span>}
        {notice && <span className={notice.ok ? styles.ok : styles.bad} role="status">{notice.text}</span>}
      </div>
      {(check.progress || check.result) && (
        <p className={check.result ? (check.result.ok ? styles.ok : styles.bad) : styles.muted} role="status">
          {check.result ? `${check.result.ok ? '✓' : '✗'} ${check.result.text}` : check.progress}
        </p>
      )}
    </details>
  );
}
