'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { useT } from '@/lib/i18n/I18nProvider';
import type { CodeTaskPublic, PluginZipCheck } from '@/lib/protocol';
import { Button } from '@/components/ui/Button';
import styles from './Sandbox.module.css';

/** Only Shopware tasks with a working copy can be downloaded as a plugin ZIP. */
export const zipAvailable = (task: Pick<CodeTaskPublic, 'status' | 'layout' | 'template'>) => task.status !== 'done' && !!task.layout && task.template === 'dockware';

/** "Plugin als ZIP" in the "Freigabe" tab: what the ZIP would contain (name, version, size), what is still missing in composer.json
 *  (with "KI bitten, das zu ergänzen" sending the list to the chat), notes, the download and where to upload it in the Shopware admin.
 *  `refresh` changing (a file card, a finished turn) checks again. */
export function ZipCard({ task, refresh = 0, onAskAi }: { task: CodeTaskPublic; refresh?: number; onAskAi?: (text: string) => void }) {
  const t = useT().sandbox.code.zip;
  const [check, setCheck] = useState<PluginZipCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  // a full project: which of its plugins (folder); undefined = the server's default (the first)
  const [plugin, setPlugin] = useState<string | undefined>(undefined);
  useEffect(() => {
    let off = false;
    api.sandbox.zipCheck(task.id, plugin).then(c => { if (!off) setCheck(c); }, e => { if (!off) { setCheck(null); setNote({ ok: false, text: t.failed(errorText(e)) }); } });
    return () => { off = true; };
  }, [task.id, refresh, tick, t, plugin]);

  async function download() {
    setBusy(true); setNote(null);
    try { setNote({ ok: true, text: t.saved(await api.sandbox.zipDownload(task.id, check?.plugin ?? plugin)) }); }
    catch (e) { setNote({ ok: false, text: t.failed(errorText(e)) }); setTick(n => n + 1); }
    finally { setBusy(false); }
  }
  const missing = check ? check.problems.map(p => t.problems[p]) : [];
  const hints = check ? check.warnings.map(w => t.warnings[w]) : [];

  return (
    <section className={styles.zipBox} aria-labelledby="sbx-zip-h">
      <h3 id="sbx-zip-h" className={styles.label}>{t.heading}</h3>
      <p className={styles.fieldHint}>{check?.plugins ? t.leadProject : t.lead}</p>
      {check?.plugins && check.plugins.length > 0 && (
        <label className={styles.zipPick}>
          <span className={styles.label}>{t.pick}</span>
          <select value={check.plugin ?? ''} disabled={busy} onChange={e => { setNote(null); setPlugin(e.target.value); }}>
            {check.plugins.map(p => <option key={p.dir} value={p.dir}>{p.name} ({p.dir})</option>)}
          </select>
        </label>
      )}
      {check?.plugins && check.plugins.length === 0 && <p className={styles.muted}>{t.noPlugins}</p>}
      {!check && !note && <p className={styles.muted} role="status">{t.checking}</p>}
      {check && !check.ok && (
        <div className={styles.zipMissing}>
          <p className={styles.label}>{t.missing}</p>
          <ul>{missing.map(m => <li key={m}>{m}</li>)}</ul>
          {check.secretFile && <p className={styles.fieldHint}><code>{check.secretFile}</code></p>}
          {onAskAi && !check.problems.includes('tooLarge') && <Button size="sm" onClick={() => onAskAi(t.askAiText([...missing, ...hints]))}>{t.askAi}</Button>}
        </div>
      )}
      {check?.ok && (
        <>
          <p className={styles.taskMeta}>{t.ready(check.name ?? '', check.version, check.files, check.bytes)}{check.vendor ? ` · ${t.vendor}` : ''}</p>
          {hints.length > 0 && (
            <div className={styles.zipHints}>
              <p className={styles.label}>{t.hints}</p>
              <ul>{hints.map(h => <li key={h}>{h}</li>)}</ul>
            </div>
          )}
          <div className={styles.footRow}>
            <Button onClick={() => void download()} busy={busy} disabled={busy}>{busy ? t.busy : t.button}</Button>
          </div>
          <p className={styles.fieldHint}>{t.upload}</p>
        </>
      )}
      {note && <p className={note.ok ? styles.okBox : styles.bad} role={note.ok ? 'status' : 'alert'}>{note.text}</p>}
    </section>
  );
}
