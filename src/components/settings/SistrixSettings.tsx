'use client';

import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { sistrixDataNotice } from '@/lib/privacy-copy';
import { connectionTestBlock, sistrixKeyComplete as keyComplete } from '@/lib/settings-form';
import type { SistrixPublic, SistrixTestResult } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { rich } from './Rich';
import styles from './Settings.module.css';

/** Sistrix: API-Schlüssel (nur hinein, nie zurück) + Domain + Land. Eigene Speicherung, unabhängig vom übrigen Formular. */
export function SistrixSettings() {
  const { t: all, locale } = useI18n();
  const ts = all.settings, t = ts.sistrix;
  const [pub, setPub] = useState<SistrixPublic | null>(null);
  const [key, setKey] = useState('');
  const [replace, setReplace] = useState(false);
  const [domain, setDomain] = useState('');
  const [country, setCountry] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'off' | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [test, setTest] = useState<SistrixTestResult | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    let off = false;
    api.sistrix().then(p => { if (!off) { setPub(p); setDomain(p.domain); setCountry(p.country); } }).catch(e => { if (!off) setNotice({ ok: false, text: errorText(e) }); });
    return () => { off = true; };
  }, []);

  // Automatisch speichern: Domain/Land kurz nach der Eingabe, Schlüssel sobald er plausibel ist
  const keyReady = keyComplete(key);
  const dirtyFields = !!pub && (domain.trim() !== pub.domain || country.trim() !== pub.country);
  useEffect(() => {
    if (!pub || (!keyReady && !dirtyFields) || notice?.ok === false) return;
    const timer = setTimeout(() => { if (!saving.current) void save(); }, keyReady ? 0 : 800);
    return () => clearTimeout(timer);
  }, [pub, keyReady, dirtyFields, domain, country, notice]); // eslint-disable-line react-hooks/exhaustive-deps -- save liest den aktuellen Stand

  if (!pub) return <Card connected={null}><p className={styles.hint}>{notice?.text ?? ts.loading}</p></Card>;
  const showKey = !pub.hasKey || replace;
  const dirty = !!key.trim() || domain.trim() !== pub.domain || country.trim() !== pub.country;

  async function save(): Promise<boolean> {
    saving.current = true;
    setBusy('save'); setNotice(null); setTest(null);
    try {
      const p = await api.saveSistrix({ ...(keyComplete(key) ? { key: key.trim() } : {}), domain, country });
      setPub(p); setDomain(p.domain); setCountry(p.country); if (keyComplete(key)) { setKey(''); setReplace(false); }
      setNotice({ ok: true, text: ts.saved });
      return true;
    } catch (e) { setNotice({ ok: false, text: ts.notSaved(errorText(e)) }); return false; }
    finally { saving.current = false; setBusy(null); }
  }
  const runTest = async () => {
    if (connectionTestBlock(dirty, locale)) return;
    setBusy('test'); setNotice(null); setTest(null);
    try { setTest(await api.testSistrix()); } catch (e) { setTest({ ok: false, message: errorText(e), credits: null }); }
    finally { setBusy(null); }
  };
  const disconnect = async () => {
    setBusy('off'); setNotice(null); setTest(null);
    try { const p = await api.disconnectSistrix(); setPub(p); setDomain(''); setCountry(''); setKey(''); setReplace(false); setNotice({ ok: true, text: t.disconnected }); }
    catch (e) { setNotice({ ok: false, text: errorText(e) }); }
    finally { setBusy(null); }
  };

  return (
    <Card connected={pub.hasKey ? pub.connected : null}>
      <p className={styles.hint}>{t.intro} {sistrixDataNotice(locale)}</p>
      <ol className={styles.steps}>
        <li>{rich(t.step1)}</li>
        <li>{rich(t.step2)}</li>
      </ol>

      {showKey ? (
        <div className={styles.field}>
          <span className={styles.labelRow}>
            <label htmlFor="sistrix-key" className={styles.label}>{t.keyLabel}</label>
            {pub.hasKey && <button type="button" className={styles.linkBtn} onClick={() => { setReplace(false); setKey(''); }}>{all.common.cancel}</button>}
          </span>
          <input id="sistrix-key" type="password" spellCheck={false} autoComplete="off" value={key} onChange={e => { setKey(e.target.value); setNotice(null); }} />
          <small className={styles.fieldHint}>{t.keyHint}</small>
        </div>
      ) : (
        <div className={styles.keyBox}>
          <span className={styles.keyMail}>
            <span className={styles.label}>{t.keyLabel}</span>
            <span className={styles.savedTag}>{t.keySaved}</span>
          </span>
          <span className={styles.keyBtns}>
            {confirmOff ? (
              <>
                <span className={styles.fieldHint}>{t.confirmDisconnect}</span>
                <Button size="sm" variant="danger" busy={busy === 'off'} onClick={() => void disconnect()}>{t.disconnect}</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmOff(false)}>{all.common.cancel}</Button>
              </>
            ) : (
              <>
                <Button size="sm" onClick={() => setReplace(true)}>{t.replace}</Button>
                <Button size="sm" variant="danger" onClick={() => setConfirmOff(true)}>{t.disconnect}</Button>
              </>
            )}
          </span>
        </div>
      )}

      <label className={styles.field}>
        <span className={styles.label}>{t.domain}</span>
        <input spellCheck={false} placeholder={t.domainPlaceholder} value={domain} onChange={e => { setDomain(e.target.value); setNotice(null); }} />
        <small className={styles.fieldHint}>{rich(t.domainHint)}</small>
      </label>
      <label className={styles.field}>
        <span className={styles.label}>{t.country}</span>
        <input spellCheck={false} maxLength={2} placeholder={t.countryPlaceholder} value={country} onChange={e => { setCountry(e.target.value); setNotice(null); }} />
        <small className={styles.fieldHint}>{rich(t.countryHint)}</small>
      </label>

      <div className={styles.testRow}>
        <Button onClick={() => void runTest()} busy={busy === 'test'} disabled={!!busy || !!connectionTestBlock(dirty, locale) || (!pub.hasKey && !key.trim())} title={connectionTestBlock(dirty, locale) ?? undefined}>{busy === 'test' ? ts.testing : ts.test}</Button>
        {busy === 'save' ? <span className={styles.muted} role="status">{ts.saving}</span>
          : notice && <span className={notice.ok ? styles.ok : styles.bad} role="status">{notice.text}{!notice.ok && <> · <button type="button" className={styles.linkBtn} onClick={() => { setNotice(null); void save(); }}>{all.common.retry}</button></>}</span>}
        {test && <span className={test.ok ? styles.ok : styles.bad} role="status">{test.ok ? '✓' : '✗'} {test.message}</span>}
      </div>
    </Card>
  );
}

function Card({ connected, children }: { connected: boolean | null; children: React.ReactNode }) {
  const t = useI18n().t.settings;
  return (
    <section id="sistrix" className={styles.card} aria-labelledby="sistrix-h">
      <div className={styles.cardHead}>
        <h2 id="sistrix-h">Sistrix <span className={styles.opt}>{t.optional}</span></h2>
        {connected !== null && <span className={`${styles.state} ${connected ? styles.stateOk : styles.stateNo}`}>{connected ? t.configured : t.sistrix.domainMissing}</span>}
      </div>
      {children}
    </section>
  );
}
