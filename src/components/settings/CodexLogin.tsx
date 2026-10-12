'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { CodexLoginState } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import styles from './Settings.module.css';

interface Props { loggedIn: boolean; onChange: () => void }

/** ChatGPT-Anmeldung für Codex per Gerätecode: Link öffnen, Code eingeben, fertig – funktioniert auch im Docker-Container. */
export function CodexLogin({ loggedIn, onChange }: Props) {
  const [st, setSt] = useState<CodexLoginState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Während die Anmeldung läuft: alle 2 s nachfragen, ob sie im Browser bestätigt wurde
  useEffect(() => {
    if (st.status !== 'pending') return;
    const t = setInterval(() => {
      api.codexLoginState().then(s => {
        if (s.status === 'pending') return;
        setSt(s);
        if (s.status === 'done') onChange();
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [st.status, onChange]);

  const start = async () => {
    setBusy(true);
    try { setSt(await api.codexLogin()); } catch (e) { setSt({ status: 'error', message: errorText(e) }); } finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true);
    try { setSt(await api.codexLogout()); onChange(); } finally { setBusy(false); }
  };
  const cancel = () => { void api.codexLogout(true).then(setSt); };
  const copy = async () => {
    if (!st.code) return;
    try { await navigator.clipboard.writeText(st.code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* Code steht ja da */ }
  };

  if (loggedIn && st.status !== 'pending') {
    return (
      <div className={styles.codexBox}>
        <p><b>Mit ChatGPT angemeldet.</b> Lotse nutzt dein ChatGPT-Abo über Codex.</p>
        <Button size="sm" onClick={() => void logout()} disabled={busy}>Abmelden</Button>
      </div>
    );
  }

  if (st.status === 'pending' && st.code) {
    return (
      <div className={styles.codexBox} aria-live="polite">
        <ol className={styles.codexSteps}>
          <li>Öffne <a href={st.url} target="_blank" rel="noreferrer">{st.url?.replace(/^https:\/\//, '')}</a> und melde dich mit deinem ChatGPT-Konto an.</li>
          <li>
            Gib diesen Code ein:
            <span className={styles.codexCode}>{st.code}</span>
            <Button size="sm" onClick={() => void copy()}>{copied ? 'Kopiert' : 'Kopieren'}</Button>
          </li>
        </ol>
        <p className={styles.codexWait}><i aria-hidden="true" /> Warte auf deine Bestätigung … (Code gilt 15 Minuten)</p>
        <Button size="sm" variant="ghost" onClick={cancel}>Abbrechen</Button>
      </div>
    );
  }

  return (
    <div className={styles.codexBox}>
      <p>Melde dich mit deinem <b>ChatGPT-Abo</b> (Plus, Pro, Business …) an. Es fallen keine zusätzlichen API-Kosten an; es gelten die Nutzungsgrenzen deines Abos.</p>
      {st.status === 'error' && <p className={styles.codexErr} role="alert">{st.message}</p>}
      <Button variant="primary" onClick={() => void start()} busy={busy} disabled={busy}>Mit ChatGPT anmelden</Button>
    </div>
  );
}
