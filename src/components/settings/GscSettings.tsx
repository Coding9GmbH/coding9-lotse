'use client';

import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { connectionTestBlock } from '@/lib/settings-form';
import type { GscPublic, GscTestResult } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import styles from './Settings.module.css';

/** Google Search Console: Service-Konto-Schlüssel (nur hinein, nie zurück) + Property. Eigene Speicherung, unabhängig vom übrigen Formular. */
export function GscSettings() {
  const [pub, setPub] = useState<GscPublic | null>(null);
  const [key, setKey] = useState('');
  const [replace, setReplace] = useState(false);
  const [property, setProperty] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'off' | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [test, setTest] = useState<GscTestResult | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let off = false;
    api.gsc().then(p => { if (!off) { setPub(p); setProperty(p.property); } }).catch(e => { if (!off) setNotice({ ok: false, text: errorText(e) }); });
    return () => { off = true; };
  }, []);

  if (!pub) return <Card connected={null}><p className={styles.hint}>{notice?.text ?? 'Lade …'}</p></Card>;
  const showKey = !pub.hasKey || replace;
  const dirty = !!key.trim() || property.trim() !== pub.property;

  const save = async (): Promise<boolean> => {
    setBusy('save'); setNotice(null); setTest(null);
    try {
      const p = await api.saveGsc({ ...(key.trim() ? { key } : {}), property });
      setPub(p); setProperty(p.property); setKey(''); setReplace(false);
      setNotice({ ok: true, text: 'Gespeichert ✓' });
      return true;
    } catch (e) { setNotice({ ok: false, text: errorText(e) }); return false; }
    finally { setBusy(null); }
  };
  const runTest = async () => {
    if (connectionTestBlock(dirty)) return;
    setBusy('test'); setNotice(null); setTest(null);
    try { setTest(await api.testGsc()); } catch (e) { setTest({ ok: false, message: errorText(e), sites: [] }); }
    finally { setBusy(null); }
  };
  const disconnect = async () => {
    setBusy('off'); setNotice(null); setTest(null);
    try { const p = await api.disconnectGsc(); setPub(p); setProperty(''); setKey(''); setReplace(false); setNotice({ ok: true, text: 'Verbindung getrennt' }); }
    catch (e) { setNotice({ ok: false, text: errorText(e) }); }
    finally { setBusy(null); }
  };
  const readFile = async (f?: File) => { if (f) { setKey(await f.text()); setNotice(null); } };

  return (
    <Card connected={pub.hasKey ? pub.connected : null}>
      <p className={styles.hint}>Echte Suchdaten (Klicks, Impressionen, Position) für bessere Meta-Daten, Inhaltslücken und die Erfolgsmessung deiner Änderungen. Lotse liest nur.</p>
      <ol className={styles.steps}>
        <li>In der <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console</a> die <b>Google Search Console API</b> aktivieren und ein <b>Service-Konto</b> mit JSON-Schlüssel anlegen.</li>
        <li>In der Search Console unter <b>Einstellungen → Nutzer und Berechtigungen</b> die E-Mail des Service-Kontos als Nutzer hinzufügen. Die Berechtigung „Eingeschränkt“ genügt.</li>
        <li>Schlüssel hier einfügen, Property eintragen, speichern und dann die Verbindung testen.</li>
      </ol>

      {showKey ? (
        <div className={styles.field}>
          <span className={styles.labelRow}>
            <label htmlFor="gsc-key" className={styles.label}>JSON-Schlüssel des Service-Kontos</label>
            {pub.hasKey && <button type="button" className={styles.linkBtn} onClick={() => { setReplace(false); setKey(''); }}>Abbrechen</button>}
          </span>
          <textarea id="gsc-key" className={styles.keyArea} rows={4} spellCheck={false} autoComplete="off" value={key} onChange={e => { setKey(e.target.value); setNotice(null); }}
            placeholder={'{ "type": "service_account", "client_email": "…", "private_key": "…" }'} />
          <span className={styles.keyActions}>
            <Button size="sm" onClick={() => file.current?.click()}>JSON-Datei wählen</Button>
            <input ref={file} type="file" accept=".json,application/json" hidden onChange={e => { void readFile(e.target.files?.[0]); e.target.value = ''; }} />
            <small className={styles.fieldHint}>Wird verschlüsselt gespeichert und danach nie wieder angezeigt, auch nicht der KI.</small>
          </span>
        </div>
      ) : (
        <div className={styles.keyBox}>
          <span className={styles.keyMail}>
            <span className={styles.label}>Service-Konto</span>
            <code>{pub.clientEmail}</code>
            <span className={styles.savedTag}>Schlüssel gespeichert</span>
          </span>
          <span className={styles.keyBtns}>
            <Button size="sm" onClick={() => setReplace(true)}>Ersetzen</Button>
            <Button size="sm" variant="danger" busy={busy === 'off'} onClick={() => void disconnect()}>Trennen</Button>
          </span>
        </div>
      )}

      <label className={styles.field}>
        <span className={styles.label}>Property</span>
        <input spellCheck={false} placeholder="sc-domain:mein-shop.de" value={property} onChange={e => { setProperty(e.target.value); setNotice(null); }} />
        <small className={styles.fieldHint}>Domain-Property <code>sc-domain:mein-shop.de</code> oder URL-Präfix <code>https://www.mein-shop.de/</code>, genau wie in der Search Console.</small>
      </label>
      {!!test?.sites.length && (
        <div className={styles.sites}>
          <span className={styles.fieldHint}>Für das Service-Konto freigegeben:</span>
          {test.sites.map(s => <button key={s} type="button" className={`${styles.siteChip} ${s === property ? styles.siteOn : ''}`} onClick={() => { setProperty(s); setNotice(null); }}>{s}</button>)}
        </div>
      )}

      <div className={styles.testRow}>
        <Button variant="primary" onClick={() => void save()} busy={busy === 'save'} disabled={!dirty || !!busy}>Speichern</Button>
        <Button onClick={() => void runTest()} busy={busy === 'test'} disabled={!!busy || !!connectionTestBlock(dirty) || (!pub.hasKey && !key.trim())} title={connectionTestBlock(dirty) ?? undefined}>{busy === 'test' ? 'Teste …' : 'Verbindung testen'}</Button>
        {notice && <span className={notice.ok ? styles.ok : styles.bad} role="status">{notice.text}</span>}
        {test && <span className={test.ok ? styles.ok : styles.bad} role="status">{test.ok ? '✓' : '✗'} {test.message}</span>}
      </div>
    </Card>
  );
}

function Card({ connected, children }: { connected: boolean | null; children: React.ReactNode }) {
  return (
    <section id="gsc" className={styles.card} aria-labelledby="gsc-h">
      <div className={styles.cardHead}>
        <h2 id="gsc-h">Google Search Console <span className={styles.opt}>optional</span></h2>
        {connected !== null && <span className={`${styles.state} ${connected ? styles.stateOk : styles.stateNo}`}>{connected ? 'eingerichtet' : 'Property fehlt'}</span>}
      </div>
      {children}
    </section>
  );
}
