'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { SandboxEnvPatch, SandboxEnvView } from '@/lib/protocol';
import { useShell } from '@/components/shell/ShellProvider';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { rich } from './Rich';
import styles from './Settings.module.css';

type Res = { memoryMb: string; cpus: string; idleMinutes: string };
const resOf = (v: SandboxEnvView): Res => ({ memoryMb: String(v.env.memoryMb), cpus: String(v.env.cpus), idleMinutes: String(v.env.idleMinutes) });

/** Settings → Sandbox: the on/off switch (off by default), Docker state, resources and idle pause per container. */
export function SandboxSettings() {
  const { refreshHealth } = useShell();
  const { t: all } = useI18n();
  const ts = all.settings, t = ts.sandbox;
  const [view, setView] = useState<SandboxEnvView | null>(null);
  const [res, setRes] = useState<Res | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    let off = false;
    api.sandbox.env().then(v => { if (!off) { setView(v); setRes(resOf(v)); } }).catch(e => { if (!off) setNotice({ ok: false, text: errorText(e) }); });
    return () => { off = true; };
  }, []);

  async function save(patch: SandboxEnvPatch) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setNotice(null);
    try {
      const v = await api.sandbox.save(patch);
      setView(v); setRes(resOf(v)); setNotice({ ok: true, text: ts.saved });
      if (patch.enabled !== undefined) refreshHealth();
    } catch (e) { setNotice({ ok: false, text: ts.notSaved(errorText(e)) }); }
    finally { saving.current = false; setBusy(false); }
  }
  const saveRes = () => {
    if (!view || !res) return;
    const patch: SandboxEnvPatch = {};
    for (const k of ['memoryMb', 'cpus', 'idleMinutes'] as const) { const n = Number(res[k].replace(',', '.')); if (res[k] !== String(view.env[k])) patch[k] = n; }
    if (Object.keys(patch).length) void save(patch);
  };

  if (!view || !res) return <Card on={false}><p className={styles.hint}>{notice?.text ?? ts.loading}</p></Card>;
  const { env, docker } = view, st = env.status;
  const blocked = st.reason === 'env' || st.reason === 'open-bind';

  return (
    <Card on={st.enabled}>
      <ul className={styles.scopes}>
        <li>
          <label className={styles.scope}>
            <input type="checkbox" role="switch" checked={env.enabled} disabled={busy || (blocked && !env.enabled)} onChange={e => void save({ enabled: e.target.checked })} />
            <span className={styles.switch} aria-hidden="true" />
            <span><b>{t.toggle}</b><small>{t.toggleHint}</small></span>
          </label>
        </li>
      </ul>
      {st.reason === 'env' && <p className={styles.alert} role="alert">{t.envOff}</p>}
      {st.reason === 'open-bind' && <p className={styles.alert} role="alert">{t.openBind}</p>}
      {st.enabled && docker && (docker.reachable
        ? <p className={styles.ok} role="status">✓ {t.dockerOk(docker.version ?? '?')}</p>
        : <p className={styles.alert} role="alert">{t.dockerDown}{docker.error ? ` (${docker.error})` : ''}</p>)}

      <h3 className={styles.label}>{t.resources}</h3>
      <div className={styles.grid} onBlur={saveRes}>
        <Field label={t.memory}><input inputMode="numeric" value={res.memoryMb} onChange={e => setRes({ ...res, memoryMb: e.target.value })} /></Field>
        <Field label={t.cpus}><input inputMode="decimal" value={res.cpus} onChange={e => setRes({ ...res, cpus: e.target.value })} /></Field>
        <Field label={t.idle} hint={t.idleHint}><input inputMode="numeric" value={res.idleMinutes} onChange={e => setRes({ ...res, idleMinutes: e.target.value })} /></Field>
      </div>
      <p className={styles.fieldHint}>{t.maxRunning(env.maxRunning)}</p>
      <p className={styles.hint}>{rich(t.environment)}{st.enabled && <> <Link href="/sandbox-coding">{t.openTab}</Link></>}</p>
      {(busy || notice) && <p className={busy ? styles.muted : notice?.ok ? styles.ok : styles.bad} role="status">{busy ? ts.saving : notice?.text}</p>}
    </Card>
  );
}

function Card({ on, children }: { on: boolean; children: React.ReactNode }) {
  const t = useI18n().t.settings;
  return (
    <section id="sandbox" className={styles.card} aria-labelledby="sandbox-h">
      <div className={styles.cardHead}>
        <h2 id="sandbox-h">{t.sandbox.heading} <span className={styles.opt}>{t.optional}</span></h2>
        <span className={`${styles.state} ${on ? styles.stateOk : styles.stateNo}`}>{on ? t.configured : t.notConfigured}</span>
      </div>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactElement }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
      {hint && <small className={styles.fieldHint}>{hint}</small>}
    </label>
  );
}
