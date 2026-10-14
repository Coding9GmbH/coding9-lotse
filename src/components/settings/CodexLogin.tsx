'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import type { CodexLoginState } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import { useT } from '@/lib/i18n/I18nProvider';
import { rich } from './Rich';
import styles from './Settings.module.css';

interface Props { loggedIn: boolean; onChange: () => void }

/** ChatGPT sign-in for Codex via device code: open link, enter code, done. Also works in the Docker container. */
export function CodexLogin({ loggedIn, onChange }: Props) {
  const t = useT();
  const tc = t.settings.codex;
  const [st, setSt] = useState<CodexLoginState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // While sign-in is in progress: poll every 2 s whether it was confirmed in the browser
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
    try { await navigator.clipboard.writeText(st.code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the code is shown anyway */ }
  };

  if (loggedIn && st.status !== 'pending') {
    return (
      <div className={styles.codexBox}>
        <p>{rich(tc.loggedIn)}</p>
        <Button size="sm" onClick={() => void logout()} disabled={busy}>{tc.logout}</Button>
      </div>
    );
  }

  if (st.status === 'pending' && st.code) {
    return (
      <div className={styles.codexBox} aria-live="polite">
        <ol className={styles.codexSteps}>
          <li>{rich(tc.open, { href: st.url ?? '', text: st.url?.replace(/^https:\/\//, '') })}</li>
          <li>
            {tc.enterCode}
            <span className={styles.codexCode}>{st.code}</span>
            <Button size="sm" onClick={() => void copy()}>{copied ? tc.copied : tc.copy}</Button>
          </li>
        </ol>
        <p className={styles.codexWait}><i aria-hidden="true" /> {tc.waiting}</p>
        <Button size="sm" variant="ghost" onClick={cancel}>{t.common.cancel}</Button>
      </div>
    );
  }

  return (
    <div className={styles.codexBox}>
      <p>{rich(tc.intro)}</p>
      {st.status === 'error' && <p className={styles.codexErr} role="alert">{st.message}</p>}
      <Button variant="primary" onClick={() => void start()} busy={busy} disabled={busy}>{tc.login}</Button>
    </div>
  );
}
