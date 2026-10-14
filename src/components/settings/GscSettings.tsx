'use client';

import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { gscQueryNotice } from '@/lib/privacy-copy';
import { connectionTestBlock, gscKeyComplete as keyComplete } from '@/lib/settings-form';
import type { GscPublic, GscTestResult } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { rich } from './Rich';
import styles from './Settings.module.css';

/** Google Search Console: service account key (write-only, never returned) + property. Saved separately, independent of the rest of the form. */
export function GscSettings() {
  const { t: all, locale } = useI18n();
  const ts = all.settings, t = ts.gsc;
  const [pub, setPub] = useState<GscPublic | null>(null);
  const [key, setKey] = useState('');
  const [replace, setReplace] = useState(false);
  const [property, setProperty] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'off' | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [test, setTest] = useState<GscTestResult | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const saving = useRef(false);

  useEffect(() => {
    let off = false;
    api.gsc().then(p => { if (!off) { setPub(p); setProperty(p.property); } }).catch(e => { if (!off) setNotice({ ok: false, text: errorText(e) }); });
    return () => { off = true; };
  }, []);

  // Auto-save: property shortly after input, key as soon as it is complete JSON (paste or file)
  const keyReady = keyComplete(key);
  const propDirty = !!pub && property.trim() !== pub.property;
  useEffect(() => {
    if (!pub || (!keyReady && !propDirty) || notice?.ok === false) return;
    const t = setTimeout(() => { if (!saving.current) void save(); }, keyReady ? 0 : 800);
    return () => clearTimeout(t);
  }, [pub, keyReady, propDirty, property, notice]); // eslint-disable-line react-hooks/exhaustive-deps -- save reads the current state

  if (!pub) return <Card connected={null}><p className={styles.hint}>{notice?.text ?? ts.loading}</p></Card>;
  const showKey = !pub.hasKey || replace;
  const dirty = !!key.trim() || property.trim() !== pub.property;

  async function save(): Promise<boolean> {
    saving.current = true;
    setBusy('save'); setNotice(null); setTest(null);
    try {
      const p = await api.saveGsc({ ...(keyComplete(key) ? { key } : {}), property });
      setPub(p); setProperty(p.property); if (keyComplete(key)) { setKey(''); setReplace(false); }
      setNotice({ ok: true, text: ts.saved });
      return true;
    } catch (e) { setNotice({ ok: false, text: ts.notSaved(errorText(e)) }); return false; }
    finally { saving.current = false; setBusy(null); }
  }
  const runTest = async () => {
    if (connectionTestBlock(dirty, locale)) return;
    setBusy('test'); setNotice(null); setTest(null);
    try { setTest(await api.testGsc()); } catch (e) { setTest({ ok: false, message: errorText(e), sites: [] }); }
    finally { setBusy(null); }
  };
  const disconnect = async () => {
    setBusy('off'); setNotice(null); setTest(null);
    try { const p = await api.disconnectGsc(); setPub(p); setProperty(''); setKey(''); setReplace(false); setNotice({ ok: true, text: t.disconnected }); }
    catch (e) { setNotice({ ok: false, text: errorText(e) }); }
    finally { setBusy(null); }
  };
  const readFile = async (f?: File) => { if (f) { setKey(await f.text()); setNotice(null); } };

  return (
    <Card connected={pub.hasKey ? pub.connected : null}>
      <p className={styles.hint}>{t.intro} {gscQueryNotice(locale)}</p>
      <ol className={styles.steps}>
        <li>{rich(t.step1, { href: 'https://console.cloud.google.com/' })}</li>
        <li>{rich(t.step2)}</li>
        <li>{t.step3}</li>
      </ol>

      {showKey ? (
        <div className={styles.field}>
          <span className={styles.labelRow}>
            <label htmlFor="gsc-key" className={styles.label}>{t.keyLabel}</label>
            {pub.hasKey && <button type="button" className={styles.linkBtn} onClick={() => { setReplace(false); setKey(''); }}>{all.common.cancel}</button>}
          </span>
          <textarea id="gsc-key" className={styles.keyArea} rows={4} spellCheck={false} autoComplete="off" value={key} onChange={e => { setKey(e.target.value); setNotice(null); }}
            placeholder={'{ "type": "service_account", "client_email": "…", "private_key": "…" }'} />
          <span className={styles.keyActions}>
            <Button size="sm" onClick={() => file.current?.click()}>{t.chooseFile}</Button>
            <input ref={file} type="file" accept=".json,application/json" hidden onChange={e => { void readFile(e.target.files?.[0]); e.target.value = ''; }} />
            <small className={styles.fieldHint}>{t.keyHint}</small>
          </span>
        </div>
      ) : (
        <div className={styles.keyBox}>
          <span className={styles.keyMail}>
            <span className={styles.label}>{t.serviceAccount}</span>
            <code>{pub.clientEmail}</code>
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
        <span className={styles.label}>{t.property}</span>
        <input spellCheck={false} placeholder={t.propertyPlaceholder} value={property} onChange={e => { setProperty(e.target.value); setNotice(null); }} />
        <small className={styles.fieldHint}>{rich(t.propertyHint)}</small>
      </label>
      {!!test?.sites.length && (
        <div className={styles.sites}>
          <span className={styles.fieldHint}>{t.sites}</span>
          {test.sites.map(s => <button key={s} type="button" className={`${styles.siteChip} ${s === property ? styles.siteOn : ''}`} onClick={() => { setProperty(s); setNotice(null); }}>{s}</button>)}
        </div>
      )}

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
    <section id="gsc" className={styles.card} aria-labelledby="gsc-h">
      <div className={styles.cardHead}>
        <h2 id="gsc-h">Google Search Console <span className={styles.opt}>{t.optional}</span></h2>
        {connected !== null && <span className={`${styles.state} ${connected ? styles.stateOk : styles.stateNo}`}>{connected ? t.configured : t.gsc.propertyMissing}</span>}
      </div>
      {children}
    </section>
  );
}
