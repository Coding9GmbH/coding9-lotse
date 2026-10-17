'use client';

import { useState } from 'react';
import type { CodeTaskPublic } from '@/lib/protocol';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { sandboxSrc } from '@/lib/urls';
import { Button } from '@/components/ui/Button';
import { PREVIEW_SANDBOX } from '@/components/preview/DraftFrame';
import styles from './Sandbox.module.css';

/** Remounts the frame after the theme was compiled (setup or later a run): the end time of a successful theme-compile step. */
export const previewBust = (task: CodeTaskPublic) => task.steps.filter(s => s.key === 'theme-compile' && s.state === 'done').map(s => s.endedAt ?? '').join('|');

/** The task's storefront through /sbx/<id>/: usable for testing (navigation, cart, checkout), in an opaque origin like the shop preview.
 *  A paused task starts again only on request ("Vorschau laden"); while it starts, /sbx shows a page that reloads itself. */
export function SandboxPreview({ task }: { task: CodeTaskPublic }) {
  const { t: all } = useI18n();
  const t = all.sandbox.preview;
  const [path, setPath] = useState('/');
  const [typed, setTyped] = useState('/');
  const [mobile, setMobile] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [wake, setWake] = useState(false);
  const [seen, setSeen] = useState(task.status);
  const s = task.status;
  if (s !== seen) { setSeen(s); if (s === 'paused') setWake(false); } // paused again (button, idle): wait for a new request
  const running = !!task.container?.running && s !== 'done' && s !== 'paused';
  const show = s === 'ready' || s === 'waking' || (running && (s === 'failed' || s === 'interrupted')) || (wake && s === 'paused');
  const src = sandboxSrc(task.preview, path);

  return (
    <section className={styles.card} aria-labelledby="sbx-preview">
      <div className={styles.cardHead}><h2 id="sbx-preview">{t.heading}</h2></div>
      <form className={styles.pvBar} onSubmit={e => { e.preventDefault(); setPath(typed || '/'); setReloads(n => n + 1); }}>
        <input value={typed} onChange={e => setTyped(e.target.value)} aria-label={t.path} spellCheck={false} />
        <Button size="sm" type="submit" disabled={!show}>{t.go}</Button>
        <Button size="sm" onClick={() => setReloads(n => n + 1)} disabled={!show}>{t.reload}</Button>
        <button type="button" className={styles.pvToggle} onClick={() => setMobile(m => !m)} aria-pressed={mobile} title={mobile ? t.desktop : t.mobile} aria-label={mobile ? t.desktop : t.mobile}>
          {mobile ? '🖥️' : '📱'}
        </button>
        {show && <a className={styles.linkBtn} href={src} target="_blank" rel="noopener">{t.newTab}</a>}
        {show && <a className={styles.pvAdmin} href={sandboxSrc(task.preview, '/admin')} target="_blank" rel="noopener" title={t.adminTitle}>{t.admin}</a>}
      </form>
      <div className={`${styles.pvView} ${mobile ? styles.pvMobile : ''}`}>
        {show
          ? <iframe key={`${src}|${previewBust(task)}|${reloads}`} className={styles.pvFrame} src={src} title={t.frame} sandbox={PREVIEW_SANDBOX} data-kind="live" />
          : s === 'paused'
            ? <div className={styles.pvEmpty}><p>{t.loadHint}</p><Button variant="primary" onClick={() => setWake(true)}>{t.load}</Button></div>
            : <div className={styles.pvEmpty}><p>{t.none}</p></div>}
      </div>
    </section>
  );
}
