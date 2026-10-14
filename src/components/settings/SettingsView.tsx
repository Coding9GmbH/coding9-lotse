'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { PublicSettings, ScopeKey, TestResult } from '@/lib/protocol';
import { PLATFORM_KINDS, platformSettings, scopeDisplay, type PlatformField, type PlatformKind } from '@/lib/platforms';
import { egressNotice } from '@/lib/privacy-copy';
import { aiModels, authOf, autosaveDirty, autosavePatch, connectionTestBlock, fieldValue, formFromSettings, hasSecret, platformAvailable, platformPending, savedConfigured, secretsDropped, secretState, withAuth, withFieldValue, withSecret, type SecretKey, type SettingsForm } from '@/lib/settings-form';
import { useShell } from '@/components/shell/ShellProvider';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { LanguageSwitch } from '@/components/i18n/LanguageSwitch';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { Locale } from '@/lib/i18n/locales';
import { CodexLogin } from './CodexLogin';
import { GscSettings } from './GscSettings';
import { SistrixSettings } from './SistrixSettings';
import { LogsPanel } from './LogsPanel';
import { SecretField } from './SecretField';
import { rich as markup } from './Rich';
import styles from './Settings.module.css';

type TestTarget = 'shop' | 'ai';
type TestState = { running: boolean; result: TestResult | null };

const SCOPE_ORDER: ScopeKey[] = ['products', 'manufacturers', 'categories', 'cms', 'media', 'marketing', 'shop'];
const INTEGRATION_SCOPES: ScopeKey[] = ['gsc', 'sistrix'];

/** Unterseiten der Einstellungen (Routen unter /settings) */
export type SettingsSection = 'general' | 'access' | 'integrations' | 'logs';
const SECTION_PATH: Record<SettingsSection, string> = { general: '/settings', access: '/settings/ki-zugriff', integrations: '/settings/integrationen', logs: '/settings/protokolle' };

/** Einstellungen: Unterseiten Allgemein (Shop, KI, Bild-KI), KI-Zugriff, Integrationen (Search Console, Sistrix), Protokolle. */
export function SettingsView({ section = 'general' }: { section?: SettingsSection }) {
  const { refreshHealth } = useShell();
  const { t, locale } = useI18n();
  const ts = t.settings;
  const [saved, setSaved] = useState<PublicSettings | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [tests, setTests] = useState<Record<TestTarget, TestState>>({ shop: { running: false, result: null }, ai: { running: false, result: null } });
  const [secretsReset, setSecretsReset] = useState<PlatformKind | null>(null); // Shop-Adresse auf anderen Server: Zugangsdaten verworfen


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
      if (secretsDropped(base, s, sent, sent.platform)) setSecretsReset(sent.platform);
      // Nur zurücksetzen, wenn seither nichts mehr eingegeben wurde; gewählte Plattform und KI bleiben (auch wenn sie noch nicht aktiv sind)
      setForm(cur => { if (cur !== sent) return cur; const next = formFromSettings(s); return { ...next, platform: sent.platform, ai: { ...next.ai, provider: sent.ai.provider } }; });
      setNotice({ ok: true, text: ts.saved });
      refreshHealth();
    } catch (e) {
      setNotice({ ok: false, text: ts.notSaved(errorText(e)) });
    } finally { inFlight.current = false; setSaving(false); }
  }, [refreshHealth, ts]);

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
    if (connectionTestBlock(dirty, locale)) return;
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
        <SubNav active={section} general={saved ? (savedConfigured(saved, saved.platform ?? 'shopware') && (saved.ai.provider === 'codex' ? saved.ai.codexLoggedIn : saved.ai.hasApiKey || saved.ai.viaEnv) ? 'ok' : 'todo') : undefined} />

        <main className={styles.content}>
          <div className={styles.titleRow}>
            <h1 className={styles.h1}>{ts.sections[section].title}</h1>
            {form && saved && (section === 'general' || section === 'access') && <SaveState saving={saving} dirty={dirty} notice={notice} onRetry={() => { setNotice(null); void save(form, saved); }} />}
          </div>
          <p className={styles.lead}>{ts.sections[section].lead}</p>
          {section === 'general' && <p className={styles.lead}>{ts.lead}</p>}
          {section === 'general' && <p className={styles.lead}>{egressNotice(locale)}</p>}

          {section === "general" && (
          <section id="language" className={styles.card} aria-labelledby="language-h">
            <div className={styles.cardHead}><h2 id="language-h">{ts.languageHeading}</h2></div>
            <p className={styles.hint}>{t.common.languageHint}</p>
            <LanguageSwitch className={styles.langSeg} />
          </section>
          )}

          {saved?.openWithoutPassword && <div className={styles.alert} role="alert">{ts.openWithoutPassword}</div>}
          {loadError && <div className={styles.alert} role="alert">{ts.loadFailed(loadError)}</div>}
          {!form && !loadError && <p className={styles.lead}>{ts.loading}</p>}

          {form && saved && section === 'general' && (
            <form ref={formRef} onSubmit={e => e.preventDefault()} onBlur={() => setKick(k => k + 1)} noValidate>
              {/* ---- Shop ---- */}
              <ShopSection form={form} saved={saved} set={set} test={tests.shop} onTest={() => void test('shop')} saving={saving} dirty={dirty} pending={pending} secretsReset={secretsReset === form.platform} />

              <section id="ai" className={styles.card} aria-labelledby="ai-h">
                <div className={styles.cardHead}>
                  <h2 id="ai-h">{ts.ai.heading}</h2>
                  <State ok={saved.ai.provider === 'codex' ? saved.ai.codexLoggedIn : saved.ai.hasApiKey || saved.ai.viaEnv} />
                </div>
                <Segmented label={ts.ai.provider} className={`${styles.authSeg} ${styles.providerSeg}`} value={form.ai.provider} onChange={provider => setAi({ provider })}
                  options={[{ value: 'claude', label: ts.ai.claude }, { value: 'codex', label: ts.ai.codex }]} />
                {form.ai.provider !== saved.ai.provider && <p className={styles.info}>{form.ai.provider === 'codex' ? ts.ai.switchCodex : ts.ai.switchClaude}</p>}

                {form.ai.provider === 'claude' ? (
                  <>
                    {saved.ai.viaEnv && <p className={styles.info}>{ts.ai.viaEnv}</p>}
                    <SecretField label={ts.ai.apiKey} has={saved.ai.hasApiKey} state={form.secrets.apiKey} onChange={v => setSecret('apiKey', v)}
                      placeholder="sk-ant-api…" hint={markup(ts.ai.apiKeyHint, { href: 'https://console.anthropic.com/settings/keys' })} />
                    <Field label={ts.ai.model}>
                      <select value={form.ai.model} onChange={e => setAi({ model: e.target.value })}>
                        {aiModels(locale).map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                        {!aiModels(locale).some(m => m.value === form.ai.model) && <option value={form.ai.model}>{form.ai.model}</option>}
                      </select>
                    </Field>
                  </>
                ) : (
                  <>
                    <CodexLogin loggedIn={saved.ai.codexLoggedIn} onChange={reloadAiState} />
                    <Field label={ts.ai.codexModel} hint={ts.ai.codexModelHint}>
                      <input value={form.ai.codexModel} onChange={e => setAi({ codexModel: e.target.value })} placeholder={ts.ai.codexModelPlaceholder} spellCheck={false} />
                    </Field>
                    <p className={styles.hint}>{ts.ai.codexTools}</p>
                  </>
                )}
                <TestRow state={tests.ai} onTest={() => void test('ai')} disabled={saving || dirty || (form.ai.provider === 'codex' && !saved.ai.codexLoggedIn)} title={connectionTestBlock(dirty, locale) ?? undefined} />
              </section>

              <section id="image" className={styles.card} aria-labelledby="image-h">
                <div className={styles.cardHead}>
                  <h2 id="image-h">{ts.image.heading} <span className={styles.opt}>{ts.optional}</span></h2>
                  {saved.image.hasKey && <State ok />}
                </div>
                <p className={styles.hint}>{ts.image.hint}</p>
                <div className={styles.grid}>
                  <SecretField label={ts.image.apiKey} has={saved.image.hasKey} state={form.secrets.openaiKey} onChange={v => setSecret('openaiKey', v)} placeholder="sk-…" />
                  <Field label={ts.image.model} hint={ts.image.modelHint}>
                    <input placeholder="gpt-image-1" value={form.image.model} onChange={e => set(f => ({ ...f, image: { model: e.target.value } }))} />
                  </Field>
                </div>
              </section>
            </form>
          )}

          {form && saved && section === 'access' && (
            <form ref={formRef} onSubmit={e => e.preventDefault()} onBlur={() => setKick(k => k + 1)} noValidate>
              <section id="scopes" className={styles.card} aria-labelledby="scopes-h">
                <div className={styles.cardHead}><h2 id="scopes-h">{ts.scopes.heading}</h2></div>
                <p className={styles.hint}>{markup(ts.scopes.hint)}</p>
                <ul className={styles.scopes}>
                  {SCOPE_ORDER.filter(k => k in form.scopes && (k !== 'manufacturers' || form.platform === 'shopware')).map(k => (
                    <ScopeSwitch key={k} k={k} form={form} saved={saved} set={set} locale={locale} />
                  ))}
                </ul>
                <p className={styles.locked}>{ts.scopes.locked}</p>
              </section>

              <section id="scopes-integrations" className={styles.card} aria-labelledby="scopes-int-h">
                <div className={styles.cardHead}><h2 id="scopes-int-h">{ts.scopes.integrationsHeading}</h2></div>
                <p className={styles.hint}>{ts.scopes.integrationsHint}</p>
                <ul className={styles.scopes}>
                  {INTEGRATION_SCOPES.filter(k => k in form.scopes).map(k => (
                    <ScopeSwitch key={k} k={k} form={form} saved={saved} set={set} locale={locale} />
                  ))}
                </ul>
              </section>

              <section id="scopes-web" className={styles.card} aria-labelledby="scopes-web-h">
                <div className={styles.cardHead}><h2 id="scopes-web-h">{ts.scopes.webHeading}</h2></div>
                <p className={styles.hint}>{markup(ts.scopes.webHint)}</p>
                <ul className={styles.scopes}>
                  {'web' in form.scopes && <ScopeSwitch k="web" form={form} saved={saved} set={set} locale={locale} />}
                </ul>
              </section>
            </form>
          )}

          {section === 'integrations' && (
            <>
              <p className={styles.hint}>{ts.integrations.hint}</p>
              <GscSettings />
              <SistrixSettings />
            </>
          )}

          {section === 'logs' && (
            <section id="protokolle" className={styles.card} aria-labelledby="logs-h">
              <div className={styles.cardHead}><h2 id="logs-h">{ts.logs.heading}</h2></div>
              <LogsPanel />
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

/** Shop verbinden: Plattform wählen (Shopware / Shopify / Magento / OpenMage), dann deren Felder laut lib/platforms.ts. */
function ShopSection({ form, saved, set, test, onTest, saving, dirty, pending, secretsReset }: { form: SettingsForm; saved: PublicSettings; set: (fn: (f: SettingsForm) => SettingsForm) => void; test: TestState; onTest: () => void; saving: boolean; dirty: boolean; pending: boolean; secretsReset: boolean }) {
  const { t, locale } = useI18n();
  const ts = t.settings.shop;
  const kind = form.platform, d = platformSettings(kind, locale), available = platformAvailable(saved, kind);
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
        <h2 id="shop-h">{ts.heading}</h2>
        <State ok={savedConfigured(saved, kind)} />
      </div>
      <Segmented<PlatformKind> label={ts.platform} className={`${styles.authSeg} ${styles.providerSeg} ${PLATFORM_KINDS.length > 3 ? styles.authSegLong : ''}`} value={kind} onChange={platform => set(f => ({ ...f, platform }))}
        options={PLATFORM_KINDS.map(k => { const p = platformSettings(k, locale); return { value: k, label: p.alpha ? <>{p.label}<span className={styles.alphaTag}>{ts.alphaTag}</span></> : p.label, title: p.alpha ? `${p.product} (${ts.alphaTag})` : p.product }; })} />
      {pending && <p className={styles.info}>{ts.pending(d.label, platformSettings(saved.platform ?? 'shopware', locale).label)}</p>}
      {!available && <p className={styles.info}>{ts.coming(d.label)}</p>}
      {available && d.alpha && <p className={styles.alert}>{ts.alpha(d.label)}</p>}
      {secretsReset && !savedConfigured(saved, kind) && <p className={styles.info} role="status">{ts.secretsReset}</p>}
      <div className={styles.grid}>{d.fields.map(input)}</div>

      {d.auth.length > 1 && (
        <div className={styles.authHead}>
          <span className={styles.label}>{ts.access}</span>
          <Segmented label={d.authLabel ?? ts.accessKind} className={`${styles.authSeg} ${d.auth.some(m => m.label.length > 24) ? styles.authSegLong : ''}`} value={mode.key} onChange={auth => set(f => withAuth(f, kind, auth))}
            options={d.auth.map(m => ({ value: m.key, label: m.label }))} />
        </div>
      )}
      {mode.hint && <p className={styles.hint}>{rich(mode.hint)}</p>}
      <div className={styles.grid}>{mode.fields.map(input)}</div>
      <TestRow state={test} onTest={onTest} disabled={saving || !available || dirty || pending} title={pending ? ts.incomplete : connectionTestBlock(dirty, locale) ?? undefined} />
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

/** Unterseiten links: Allgemein, KI-Zugriff, Integrationen, Protokolle (eigene Routen); Allgemein zeigt, ob Shop und KI eingerichtet sind. */
function SubNav({ active, general }: { active: SettingsSection; general?: 'ok' | 'todo' }) {
  const t = useI18n().t.settings;
  const items: { key: SettingsSection; label: string; state?: 'ok' | 'todo' }[] = [
    { key: 'general', label: t.sections.general.nav, state: general },
    { key: 'access', label: t.sections.access.nav },
    { key: 'integrations', label: t.sections.integrations.nav },
    { key: 'logs', label: t.sections.logs.nav },
  ];
  return (
    <nav className={styles.toc} aria-label={t.toc.label}>
      <span className={styles.tocHead}>{t.toc.head}</span>
      {items.map(i => (
        <Link key={i.key} href={SECTION_PATH[i.key]} aria-current={active === i.key ? 'page' : undefined}>
          <span>{i.label}</span>
          {i.state === 'ok' && <i className={styles.tocOk} aria-label={t.toc.ok} />}
          {i.state === 'todo' && <i className={styles.tocTodo} aria-label={t.toc.todo} />}
        </Link>
      ))}
    </nav>
  );
}

/** Ein Schalter für einen KI-Zugriffsbereich (Shop-Daten oder Integration) */
function ScopeSwitch({ k, form, saved, set, locale }: { k: ScopeKey; form: SettingsForm; saved: PublicSettings; set: (fn: (f: SettingsForm) => SettingsForm) => void; locale: Locale }) {
  const info = scopeDisplay(form.platform, k, saved.scopeInfo?.[k] ?? { label: k, hint: '' }, locale);
  return (
    <li>
      <label className={styles.scope}>
        <input type="checkbox" role="switch" checked={form.scopes[k]} onChange={e => set(f => ({ ...f, scopes: { ...f.scopes, [k]: e.target.checked } }))} />
        <span className={styles.switch} aria-hidden="true" />
        <span><b>{info.label}</b><small>{info.hint}</small></span>
      </label>
    </li>
  );
}

/** Speicherstand oben neben der Überschrift: speichert … / gespeichert / Fehler mit „Erneut versuchen“. */
function SaveState({ saving, dirty, notice, onRetry }: { saving: boolean; dirty: boolean; notice: { ok: boolean; text: string } | null; onRetry: () => void }) {
  const t = useI18n().t;
  const failed = notice && !notice.ok;
  return (
    <span className={`${styles.saveState} ${failed ? styles.saveBad : saving || dirty ? '' : styles.saveOk}`} role="status" aria-live="polite">
      {failed ? <>{notice.text}<button type="button" onClick={onRetry}>{t.common.retry}</button></>
        : saving || dirty ? t.settings.saving : t.settings.allSaved}
    </span>
  );
}

function State({ ok }: { ok: boolean }) {
  const t = useI18n().t.settings;
  return <span className={`${styles.state} ${ok ? styles.stateOk : styles.stateNo}`}>{ok ? t.configured : t.notConfigured}</span>;
}

function TestRow({ state, onTest, disabled, title }: { state: TestState; onTest: () => void; disabled: boolean; title?: string }) {
  const t = useI18n().t.settings;
  return (
    <div className={styles.testRow}>
      <Button onClick={onTest} busy={state.running} disabled={disabled} title={title}>{state.running ? t.testing : t.test}</Button>
      {state.result && (
        <span className={state.result.ok ? styles.ok : styles.bad} role="status">{state.result.ok ? '✓' : '✗'} {state.result.message}</span>
      )}
    </div>
  );
}
