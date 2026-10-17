'use client';

import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { githubTokenComplete, type SecretInput } from '@/lib/settings-form';
import type { GithubPublic, GithubTestResult } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { rich } from './Rich';
import { SecretField } from './SecretField';
import styles from './Settings.module.css';

/** GitHub: fine-grained token (write-only, never returned). Saved and tested as soon as it looks complete; removal disconnects. */
export function GithubSettings() {
  const { t: all } = useI18n();
  const ts = all.settings, t = ts.github;
  const [pub, setPub] = useState<GithubPublic | null>(null);
  const [token, setToken] = useState<SecretInput>({ value: '', remove: false });
  const [busy, setBusy] = useState<'save' | 'test' | 'off' | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [test, setTest] = useState<GithubTestResult | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    let off = false;
    api.github.get().then(p => { if (!off) setPub(p); }).catch(e => { if (!off) setNotice({ ok: false, text: errorText(e) }); });
    return () => { off = true; };
  }, []);

  const runTest = async () => {
    setBusy('test'); setTest(null);
    try { const r = await api.github.test(); setTest(r); if (r.login) setPub(p => (p ? { ...p, login: r.login } : p)); }
    catch (e) { setTest({ ok: false, message: errorText(e), login: null, repos: null, readOnly: [] }); }
    finally { setBusy(null); }
  };
  async function save(value: string) {
    if (saving.current) return;
    saving.current = true;
    setBusy('save'); setNotice(null); setTest(null);
    try {
      setPub(await api.github.save(value.trim()));
      setToken({ value: '', remove: false });
      setNotice({ ok: true, text: ts.saved });
    } catch (e) { setNotice({ ok: false, text: ts.notSaved(errorText(e)) }); return; }
    finally { saving.current = false; setBusy(null); }
    await runTest();
  }
  async function disconnect() {
    if (saving.current) return;
    saving.current = true;
    setBusy('off'); setNotice(null); setTest(null);
    try { setPub(await api.github.disconnect()); setToken({ value: '', remove: false }); setNotice({ ok: true, text: t.disconnected }); }
    catch (e) { setNotice({ ok: false, text: errorText(e) }); }
    finally { saving.current = false; setBusy(null); }
  }

  // Auto-save: as soon as the token looks complete; removal (confirmed in SecretField) disconnects right away
  const apply = (s: SecretInput) => { if (s.remove) void disconnect(); else if (githubTokenComplete(s.value)) void save(s.value); };

  if (!pub) return <Card pub={null}><p className={styles.hint}>{notice?.text ?? ts.loading}</p></Card>;

  return (
    <Card pub={pub}>
      <p className={styles.hint}>{t.intro}</p>
      <ol className={styles.steps}>
        <li>{rich(t.step1)}</li>
        <li>{rich(t.step2)}</li>
        <li>{rich(t.step3)}</li>
      </ol>
      <SecretField label={t.tokenLabel} has={pub.hasToken} state={token} placeholder={t.tokenPlaceholder} hint={t.tokenHint}
        onChange={s => { setToken(s); setNotice(null); apply(s); }} />
      <p className={styles.fieldHint}>{t.permissions}</p>

      <div className={styles.testRow}>
        <Button onClick={() => void runTest()} busy={busy === 'test'} disabled={!!busy || !pub.hasToken}>{busy === 'test' ? ts.testing : ts.test}</Button>
        {busy === 'save' ? <span className={styles.muted} role="status">{ts.saving}</span>
          : notice && <span className={notice.ok ? styles.ok : styles.bad} role="status">{notice.text}{!notice.ok && <> · <button type="button" className={styles.linkBtn} onClick={() => { setNotice(null); apply(token); }}>{all.common.retry}</button></>}</span>}
        {test && <span className={test.ok ? styles.ok : styles.bad} role="status">{test.ok ? '✓' : '✗'} {test.message}</span>}
      </div>
      {!!test?.readOnly.length && <p className={styles.fieldHint}>{t.readOnly(test.readOnly.length, test.readOnly.join(', '))}</p>}
    </Card>
  );
}

function Card({ pub, children }: { pub: GithubPublic | null; children: React.ReactNode }) {
  const t = useI18n().t.settings;
  return (
    <section id="github" className={styles.card} aria-labelledby="github-h">
      <div className={styles.cardHead}>
        <h2 id="github-h">GitHub <span className={styles.opt}>{t.optional}</span></h2>
        {pub?.hasToken && <span className={`${styles.state} ${pub.login ? styles.stateOk : styles.stateNo}`}>{pub.login ? t.github.connectedAs(pub.login) : t.github.notTested}</span>}
      </div>
      {children}
    </section>
  );
}
