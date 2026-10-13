'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { PublicSettings, ScopeKey, TestResult } from '@/lib/protocol';
import { PLATFORM_KINDS, PLATFORM_SETTINGS, scopeDisplay, type PlatformField, type PlatformKind } from '@/lib/platforms';
import { EGRESS_NOTICE } from '@/lib/privacy-copy';
import { AI_MODELS, authOf, autosaveDirty, autosavePatch, connectionTestBlock, fieldValue, formFromSettings, hasSecret, platformAvailable, platformPending, savedConfigured, secretState, withAuth, withFieldValue, withSecret, type SecretKey, type SettingsForm } from '@/lib/settings-form';
import { useShell } from '@/components/shell/ShellProvider';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { CodexLogin } from './CodexLogin';
import { GscSettings } from './GscSettings';
import { LogsPanel } from './LogsPanel';
import { SecretField } from './SecretField';
import styles from './Settings.module.css';

type TestTarget = 'shop' | 'ai';
type TestState = { running: boolean; result: TestResult | null };

const SCOPE_ORDER: ScopeKey[] = ['products', 'categories', 'cms', 'media', 'marketing', 'shop'];

/** Einstellungen: Shop & KI verbinden, Bild-KI, KI-Zugriffsbereiche, Protokolle. */
export function SettingsView() {
  const { refreshHealth } = useShell();
  const [saved, setSaved] = useState<PublicSettings | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [tests, setTests] = useState<Record<TestTarget, TestState>>({ shop: { running: false, result: null }, ai: { running: false, result: null } });


  useEffect(() => {
    let off = false;
    api.settings()
      .then(s => { if (!off) { setSaved(s); setForm(formFromSettings(s)); } })
      .catch(e => { if (!off) setLoadError(errorText(e)); });
    return () => { off = true; };
  }, []);

  const dirty = !!form && !!saved && autosaveDirty(form, saved);
  const pending = !!form && !!saved && platformPending(form, saved);

  // Automatisch speichern: kurz nach der letzten Eingabe. In einem Geheimnis-Feld erst beim Verlassen
  // (sonst landet ein halb eingetippter Schlüssel im Speicher und das Feld leert sich mitten im Tippen).
  const formRef = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const [kick, setKick] = useState(0);
  const save = useCallback(async (sent: SettingsForm, base: PublicSettings) => {
    inFlight.current = true;
    setSaving(true); setNotice(null);
    try {
      const s = await api.saveSettings(autosavePatch(sent, base));
      setSaved(s);
      // Nur zurücksetzen, wenn seither nichts mehr eingegeben wurde; gewählte Plattform und KI bleiben (auch wenn sie noch nicht aktiv sind)
      setForm(cur => { if (cur !== sent) return cur; const next = formFromSettings(s); return { ...next, platform: sent.platform, ai: { ...next.ai, provider: sent.ai.provider } }; });
      setNotice({ ok: true, text: 'Gespeichert' });
      refreshHealth();
    } catch (e) {
      setNotice({ ok: false, text: `Nicht gespeichert: ${errorText(e)}` });
    } finally { inFlight.current = false; setSaving(false); }
  }, [refreshHealth]);

  useEffect(() => {
    if (!form || !saved || !dirty || saving || notice?.ok === false) return;
    const t = setTimeout(() => {
      const active = document.activeElement;
      if (inFlight.current || (active instanceof HTMLInputElement && active.type === 'password' && formRef.current?.contains(active))) return;
      void save(form, saved);
    }, 700);
    return () => clearTimeout(t);
  }, [form, saved, dirty, saving, notice, kick, save]);

  const test = async (target: TestTarget) => {
    if (connectionTestBlock(dirty)) return;
    setTests(t => ({ ...t, [target]: { running: true, result: null } }));
    let result: TestResult;
    try { result = await api.testSettings(target); } catch (e) { result = { ok: false, message: errorText(e) }; }
    setTests(t => ({ ...t, [target]: { running: false, result } }));
    refreshHealth();
  };

  const set = (fn: (f: SettingsForm) => SettingsForm) => { setForm(f => (f ? fn(f) : f)); setNotice(n => (n?.ok ? n : null)); };
  const setSecret = (k: SecretKey, v: { value: string; remove: boolean }) => set(f => ({ ...f, secrets: { ...f.secrets, [k]: v } }));
  const setAi = (patch: Partial<SettingsForm['ai']>) => set(f => ({ ...f, ai: { ...f.ai, ...patch } }));
  // Nach ChatGPT-An-/Abmeldung nur den Anmeldestatus übernehmen (ungespeicherte Eingaben bleiben erhalten)
  const reloadAiState = useCallback(() => {
    api.settings().then(s => setSaved(p => (p ? { ...p, ai: { ...p.ai, codexLoggedIn: s.ai.codexLoggedIn } } : s))).catch(() => {});
    refreshHealth();
  }, [refreshHealth]);

  return (
    <div className={styles.page}>

      <div className={styles.wrap}>
        <Toc items={[
          { id: 'shop', label: 'Shop verbinden', state: saved ? (savedConfigured(saved, saved.platform ?? 'shopware') ? 'ok' : 'todo') : undefined },
          { id: 'ai', label: 'KI verbinden', state: saved ? ((saved.ai.provider === 'codex' ? saved.ai.codexLoggedIn : saved.ai.hasApiKey || saved.ai.viaEnv) ? 'ok' : 'todo') : undefined },
          { id: 'image', label: 'Bild-KI', note: 'optional' },
          { id: 'scopes', label: 'KI-Zugriff' },
          { id: 'gsc', label: 'Search Console', note: 'optional' },
          { id: 'protokolle', label: 'Protokolle' },
        ]} loaded={!!form && !!saved} />

        <main className={styles.content}>
          <div className={styles.titleRow}>
            <h1 className={styles.h1}>Einstellungen</h1>
            {form && saved && <SaveState saving={saving} dirty={dirty} notice={notice} onRetry={() => { setNotice(null); void save(form, saved); }} />}
          </div>
          <p className={styles.lead}>Änderungen werden automatisch gespeichert. Zugangsdaten werden verschlüsselt lokal gespeichert und nie an die KI weitergegeben. Gespeicherte Schlüssel werden hier nicht angezeigt.</p>
          <p className={styles.lead}>{EGRESS_NOTICE}</p>

          {loadError && <div className={styles.alert} role="alert">Einstellungen konnten nicht geladen werden: {loadError}</div>}
          {!form && !loadError && <p className={styles.lead}>Lade …</p>}

          {form && saved && (
            <form ref={formRef} onSubmit={e => e.preventDefault()} onBlur={() => setKick(k => k + 1)} noValidate>
              {/* ---- Shop ---- */}
              <ShopSection form={form} saved={saved} set={set} test={tests.shop} onTest={() => void test('shop')} saving={saving} dirty={dirty} pending={pending} />

              {/* ---- KI ---- */}
              <section id="ai" className={styles.card} aria-labelledby="ai-h">
                <div className={styles.cardHead}>
                  <h2 id="ai-h">KI verbinden</h2>
                  <State ok={saved.ai.provider === 'codex' ? saved.ai.codexLoggedIn : saved.ai.hasApiKey || saved.ai.viaEnv} />
                </div>
                <Segmented label="KI-Anbieter" className={`${styles.authSeg} ${styles.providerSeg}`} value={form.ai.provider} onChange={provider => setAi({ provider })}
                  options={[{ value: 'claude', label: 'Claude (API-Schlüssel)' }, { value: 'codex', label: 'ChatGPT-Abo' }]} />
                {form.ai.provider !== saved.ai.provider && <p className={styles.info}>{form.ai.provider === 'codex' ? 'Nach der Anmeldung' : 'Sobald der API-Schlüssel hinterlegt ist'} wird diese KI für neue Nachrichten verwendet.</p>}

                {form.ai.provider === 'claude' ? (
                  <>
                    {saved.ai.viaEnv && <p className={styles.info}>Ein API-Schlüssel ist bereits über die Umgebungsvariable ANTHROPIC_API_KEY gesetzt. Ein hier hinterlegter Schlüssel hat Vorrang.</p>}
                    <SecretField label="Anthropic-API-Schlüssel" has={saved.ai.hasApiKey} state={form.secrets.apiKey} onChange={v => setSecret('apiKey', v)}
                      placeholder="sk-ant-api…" hint={<>Erstellen unter <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>, Abrechnung nach Verbrauch. Ein Claude-Abo (Pro/Max) kann Lotse nicht nutzen.</>} />
                    <Field label="Modell">
                      <select value={form.ai.model} onChange={e => setAi({ model: e.target.value })}>
                        {AI_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                        {!AI_MODELS.some(m => m.value === form.ai.model) && <option value={form.ai.model}>{form.ai.model}</option>}
                      </select>
                    </Field>
                  </>
                ) : (
                  <>
                    <CodexLogin loggedIn={saved.ai.codexLoggedIn} onChange={reloadAiState} />
                    <Field label="Modell (optional)" hint="Leer lassen für den Codex-Standard deines Abos.">
                      <input value={form.ai.codexModel} onChange={e => setAi({ codexModel: e.target.value })} placeholder="Standard" spellCheck={false} />
                    </Field>
                    <p className={styles.hint}>Codex bekommt in Lotse nur die Shop-Werkzeuge: keine Befehle, kein Dateizugriff, keine Websuche. Kunden- und Bestelldaten bleiben wie bei Claude gesperrt.</p>
                  </>
                )}
                <TestRow state={tests.ai} onTest={() => void test('ai')} disabled={saving || dirty || (form.ai.provider === 'codex' && !saved.ai.codexLoggedIn)} title={connectionTestBlock(dirty) ?? undefined} />
              </section>

              {/* ---- Bild-KI ---- */}
              <section id="image" className={styles.card} aria-labelledby="image-h">
                <div className={styles.cardHead}>
                  <h2 id="image-h">Bild-KI <span className={styles.opt}>optional</span></h2>
                  {saved.image.hasKey && <State ok />}
                </div>
                <p className={styles.hint}>Damit kann Lotse passende Bilder für Seiten erzeugen. Ohne Schlüssel nutzt Lotse vorhandene Medien und Grafiken.</p>
                <div className={styles.grid}>
                  <SecretField label="OpenAI-API-Schlüssel" has={saved.image.hasKey} state={form.secrets.openaiKey} onChange={v => setSecret('openaiKey', v)} placeholder="sk-…" />
                  <Field label="Bild-Modell" hint="Leer = gpt-image-1">
                    <input placeholder="gpt-image-1" value={form.image.model} onChange={e => set(f => ({ ...f, image: { model: e.target.value } }))} />
                  </Field>
                </div>
              </section>

              {/* ---- KI-Zugriff ---- */}
              <section id="scopes" className={styles.card} aria-labelledby="scopes-h">
                <div className={styles.cardHead}><h2 id="scopes-h">KI-Zugriff</h2></div>
                <p className={styles.hint}>Welche Bereiche des Shops darf die KI <b>lesen</b>? Geschrieben wird ohnehin nur nach deiner Freigabe.</p>
                <ul className={styles.scopes}>
                  {SCOPE_ORDER.filter(k => k in form.scopes).map(k => {
                    const info = scopeDisplay(form.platform, k, saved.scopeInfo?.[k] ?? { label: k, hint: '' });
                    return (
                      <li key={k}>
                        <label className={styles.scope}>
                          <input type="checkbox" role="switch" checked={form.scopes[k]} onChange={e => set(f => ({ ...f, scopes: { ...f.scopes, [k]: e.target.checked } }))} />
                          <span className={styles.switch} aria-hidden="true" />
                          <span><b>{info.label}</b><small>{info.hint}</small></span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <p className={styles.locked}>🔒 Kunden-, Bestell- und Zahlungsdaten sowie Zugangsdaten sind immer gesperrt, unabhängig von diesen Schaltern.</p>
              </section>

            </form>
          )}

          {form && saved && <GscSettings />}

          <section id="protokolle" className={styles.card} aria-labelledby="logs-h">
            <div className={styles.cardHead}><h2 id="logs-h">Protokolle</h2></div>
            <LogsPanel />
          </section>
        </main>
      </div>
    </div>
  );
}

/** Shop verbinden: Plattform wählen (Shopware / Shopify / Magento / OpenMage), dann deren Felder laut lib/platforms.ts. */
function ShopSection({ form, saved, set, test, onTest, saving, dirty, pending }: { form: SettingsForm; saved: PublicSettings; set: (fn: (f: SettingsForm) => SettingsForm) => void; test: TestState; onTest: () => void; saving: boolean; dirty: boolean; pending: boolean }) {
  const kind = form.platform, d = PLATFORM_SETTINGS[kind], available = platformAvailable(saved, kind);
  const mode = d.auth.find(m => m.key === authOf(form, kind)) ?? d.auth[0];
  const input = (f: PlatformField) => f.secret
    ? <SecretField key={`${kind}.${f.key}`} label={f.label} has={hasSecret(saved, kind, f.key)} state={secretState(form, kind, f.key)} onChange={v => set(x => withSecret(x, kind, f.key, v))}
      placeholder={f.placeholder} hint={f.hint ? rich(f.hint) : undefined} autoComplete={f.autoComplete} />
    : (
      <Field key={`${kind}.${f.key}`} label={f.label} hint={f.hint ? rich(f.hint) : undefined}>
        {f.options ? <select value={fieldValue(form, kind, f.key)} onChange={e => set(x => withFieldValue(x, kind, f.key, e.target.value))}>
          {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select> : <input type={f.type === 'url' ? 'url' : 'text'} inputMode={f.type === 'url' ? 'url' : undefined} autoComplete={f.autoComplete} spellCheck={f.type === 'url' ? undefined : false}
          placeholder={f.placeholder} value={fieldValue(form, kind, f.key)} onChange={e => set(x => withFieldValue(x, kind, f.key, e.target.value))} />}
      </Field>
    );
  return (
    <section id="shop" className={styles.card} aria-labelledby="shop-h">
      <div className={styles.cardHead}>
        <h2 id="shop-h">Shop verbinden</h2>
        <State ok={savedConfigured(saved, kind)} />
      </div>
      <Segmented<PlatformKind> label="Shop-Plattform" className={`${styles.authSeg} ${styles.providerSeg} ${PLATFORM_KINDS.length > 3 ? styles.authSegLong : ''}`} value={kind} onChange={platform => set(f => ({ ...f, platform }))}
        options={PLATFORM_KINDS.map(k => ({ value: k, label: PLATFORM_SETTINGS[k].label, title: PLATFORM_SETTINGS[k].product }))} />
      {pending && <p className={styles.info}>Sobald die Zugangsdaten vollständig sind, ist {d.label} der verbundene Shop. Bis dahin bleibt {PLATFORM_SETTINGS[saved.platform ?? 'shopware'].label} verbunden. Es ist immer genau ein Shop verbunden.</p>}
      {!available && <p className={styles.info}>Die {d.label}-Anbindung ist in Vorbereitung. Du kannst die Zugangsdaten schon hinterlegen; die Werkzeuge für {d.label} folgen.</p>}
      <div className={styles.grid}>{d.fields.map(input)}</div>

      {d.auth.length > 1 && (
        <div className={styles.authHead}>
          <span className={styles.label}>Zugang</span>
          <Segmented label={d.authLabel ?? 'Art des Zugangs'} className={`${styles.authSeg} ${d.auth.some(m => m.label.length > 24) ? styles.authSegLong : ''}`} value={mode.key} onChange={auth => set(f => withAuth(f, kind, auth))}
            options={d.auth.map(m => ({ value: m.key, label: m.label }))} />
        </div>
      )}
      {mode.hint && <p className={styles.hint}>{rich(mode.hint)}</p>}
      <div className={styles.grid}>{mode.fields.map(input)}</div>
      <TestRow state={test} onTest={onTest} disabled={saving || !available || dirty || pending} title={pending ? 'Erst die Zugangsdaten vollständig eingeben.' : connectionTestBlock(dirty) ?? undefined} />
    </section>
  );
}

/** **fett** in Hilfetexten aus lib/platforms.ts */
const rich = (t: string) => t.split('**').map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactElement }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
      {hint && <small className={styles.fieldHint}>{hint}</small>}
    </label>
  );
}

type TocItem = { id: string; label: string; state?: 'ok' | 'todo'; note?: string };

/** Abschnitte links: markiert den sichtbaren Abschnitt und zeigt, was eingerichtet ist und was noch fehlt. */
function Toc({ items, loaded }: { items: TocItem[]; /** Abschnitte gerendert (Einstellungen geladen) */ loaded: boolean }) {
  const [current, setCurrent] = useState(items[0]?.id);
  const ids = items.map(i => i.id).join(',');
  useEffect(() => {
    const read = () => { const h = window.location.hash.slice(1); if (h) setCurrent(h); };
    read();
    const els = ids.split(',').map(id => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    const root = els[0]?.closest(`.${styles.page}`) ?? null;
    // Der Abschnitt, dessen Kopf zuletzt unter die Überschrift gewandert ist
    const pick = () => {
      const top = root?.getBoundingClientRect().top ?? 0, line = Math.max(160, ((root as HTMLElement | null)?.clientHeight ?? window.innerHeight) / 3);
      let best: string | undefined = els[0]?.id;
      for (const el of els) if (el.getBoundingClientRect().top - top < line) best = el.id;
      const page = root as HTMLElement | null;
      // Ganz unten (nach echtem Scrollen): letzter Abschnitt. Nicht beim Laden, wenn die Seite noch kurz ist und nicht scrollt.
      if (page && page.scrollTop > 0 && page.scrollTop + page.clientHeight >= page.scrollHeight - 4) best = els.at(-1)?.id;
      if (best) setCurrent(best);
    };
    // Beim Scrollen (je Frame höchstens einmal) neu bestimmen
    let frame = 0;
    const onScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(pick); };
    const target: HTMLElement | Window = (root as HTMLElement | null) ?? window;
    if (!window.location.hash) pick(); // mit Sprungmarke zählt die (read), bis gescrollt wird
    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('hashchange', read);
    return () => { cancelAnimationFrame(frame); target.removeEventListener('scroll', onScroll); window.removeEventListener('hashchange', read); };
  }, [ids, loaded]); // erst nach dem Laden gibt es alle Abschnitte
  return (
    <nav className={styles.toc} aria-label="Abschnitte">
      <span className={styles.tocHead}>Auf dieser Seite</span>
      {items.map(i => (
        <a key={i.id} href={`#${i.id}`} aria-current={current === i.id ? 'true' : undefined} onClick={() => setCurrent(i.id)}>
          <span>{i.label}</span>
          {i.state === 'ok' && <i className={styles.tocOk} aria-label="eingerichtet" />}
          {i.state === 'todo' && <i className={styles.tocTodo} aria-label="fehlt noch" />}
          {i.note && !i.state && <small>{i.note}</small>}
        </a>
      ))}
    </nav>
  );
}

/** Speicherstand oben neben der Überschrift: speichert … / gespeichert / Fehler mit „Erneut versuchen“. */
function SaveState({ saving, dirty, notice, onRetry }: { saving: boolean; dirty: boolean; notice: { ok: boolean; text: string } | null; onRetry: () => void }) {
  const failed = notice && !notice.ok;
  return (
    <span className={`${styles.saveState} ${failed ? styles.saveBad : saving || dirty ? '' : styles.saveOk}`} role="status" aria-live="polite">
      {failed ? <>{notice.text}<button type="button" onClick={onRetry}>Erneut versuchen</button></>
        : saving || dirty ? 'Speichert …' : 'Alles gespeichert'}
    </span>
  );
}

function State({ ok }: { ok: boolean }) {
  return <span className={`${styles.state} ${ok ? styles.stateOk : styles.stateNo}`}>{ok ? 'eingerichtet' : 'nicht eingerichtet'}</span>;
}

function TestRow({ state, onTest, disabled, title }: { state: TestState; onTest: () => void; disabled: boolean; title?: string }) {
  return (
    <div className={styles.testRow}>
      <Button onClick={onTest} busy={state.running} disabled={disabled} title={title}>{state.running ? 'Teste …' : 'Verbindung testen'}</Button>
      {state.result && (
        <span className={state.result.ok ? styles.ok : styles.bad} role="status">{state.result.ok ? '✓' : '✗'} {state.result.message}</span>
      )}
    </div>
  );
}
