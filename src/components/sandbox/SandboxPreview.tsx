'use client';

import { useEffect, useRef, useState } from 'react';
import type { CodeTaskPublic } from '@/lib/protocol';
import { annotationMessage, type Annotation } from '@/lib/annotations';
import { markKeySelects } from '@/lib/a11y';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { popoverLeft } from '@/lib/popover';
import { sandboxSrc } from '@/lib/urls';
import { Button } from '@/components/ui/Button';
import { IconPin } from '@/components/ui/icons';
import { attachAnnotator, drawPins, type FrameTarget, type Pick } from '@/components/preview/annotator';
import { PREVIEW_SANDBOX } from '@/components/preview/DraftFrame';
import pp from '@/components/preview/PreviewPane.module.css';
import styles from './Sandbox.module.css';

/** Remounts the frame after the theme was compiled (setup or later a run): the end time of a successful theme-compile step. */
export const previewBust = (task: CodeTaskPublic) => task.steps.filter(s => s.key === 'theme-compile' && s.state === 'done').map(s => s.endedAt ?? '').join('|');

/** The task's storefront through /sbx/<id>/: usable for testing (navigation, cart, checkout), in an opaque origin like the shop preview.
 *  A paused task starts again only on request ("Vorschau laden"); while it starts, /sbx shows a page that reloads itself.
 *  Mark mode as in the shop preview (frame script via postMessage); the requests are copied as text until the task chat takes them. */
export function SandboxPreview({ task }: { task: CodeTaskPublic }) {
  const { locale, t: all } = useI18n();
  const t = all.sandbox.preview, tp = all.preview;
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
  const frameKey = `${src}|${previewBust(task)}|${reloads}`;

  const [marking, setMarking] = useState(false);
  const [pick, setPick] = useState<(Pick & { left: number; top: number }) | null>(null);
  const [targets, setTargets] = useState<FrameTarget[]>([]);
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const frame = () => viewRef.current?.querySelector<HTMLIFrameElement>('iframe[data-kind="live"]') ?? null;
  const place = (p: Pick) => {
    const vr = viewRef.current?.getBoundingClientRect(), fr = frame()?.getBoundingClientRect();
    const width = vr ? Math.min(320, Math.max(0, vr.width - 16)) : 320;
    setText('');
    setPick({ ...p, left: fr && vr ? popoverLeft(fr.left - vr.left + p.x - 20, width, vr.width) : 16, top: fr && vr ? Math.min(fr.top - vr.top + p.y + 14, vr.height - 190) : 48 });
  };
  useEffect(() => {
    const f = marking && show ? frame() : null;
    if (!f) return;
    const off = attachAnnotator(f, place, setTargets, locale);
    return () => { off(); setTargets([]); };
  }, [marking, show, frameKey, locale]); // eslint-disable-line react-hooks/exhaustive-deps -- frame() and place only read the DOM
  useEffect(() => {
    const f = show ? frame() : null;
    if (!f) return;
    const draw = () => drawPins(f, marking ? notes.map(n => n.path) : []);
    draw();
    f.addEventListener('load', draw);
    return () => f.removeEventListener('load', draw);
  }, [notes, marking, show, frameKey]);
  const save = () => {
    if (!pick || !text.trim()) return;
    setNotes(l => [...l, { id: crypto.randomUUID(), label: pick.label, section: pick.section, path: pick.path, note: text.trim() }]);
    setPick(null);
  };
  const copy = () => {
    void navigator.clipboard?.writeText(annotationMessage(notes, 'sandbox', locale)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  };

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
        <Button size="sm" className={marking ? styles.pvMarkOn : undefined} aria-pressed={marking} disabled={!show && !marking} title={t.markTitle}
          onClick={() => { setMarking(m => !m); setPick(null); }}>
          <IconPin size={15} />{marking ? t.markStop : t.mark}
        </Button>
        {show && <a className={styles.linkBtn} href={src} target="_blank" rel="noopener">{t.newTab}</a>}
        {show && <a className={styles.pvAdmin} href={sandboxSrc(task.preview, '/admin')} target="_blank" rel="noopener" title={t.adminTitle}>{t.admin}</a>}
      </form>
      <div ref={viewRef} className={`${styles.pvView} ${mobile ? styles.pvMobile : ''} ${marking && show ? styles.pvMarking : ''}`}>
        {marking && show && !pick && <div className={pp.markHint}>{tp.markHint}</div>}
        {marking && show && !pick && targets.length > 0 && (
          <ul className={pp.targets} aria-label={tp.targets}>
            {targets.map((x, i) => (
              <li key={`${x.path}-${i}`}>
                <button type="button" onClick={() => place({ ...x, x: 24, y: 24 })}
                  onKeyDown={e => { if (!markKeySelects(e.key)) return; e.preventDefault(); place({ ...x, x: 24, y: 24 }); }}>{x.label}</button>
              </li>
            ))}
          </ul>
        )}
        {pick && (
          <form className={pp.pop} style={{ left: pick.left, top: pick.top }} onSubmit={e => { e.preventDefault(); save(); }}>
            <b>{pick.label}</b>
            {pick.section && <small>{tp.section(pick.section)}</small>}
            <textarea autoFocus rows={3} value={text} onChange={e => setText(e.target.value)} aria-label={tp.whatDifferent} placeholder={tp.whatDifferentPlaceholder}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') setPick(null); }} />
            <div className={pp.popBtns}>
              <Button size="sm" onClick={() => setPick(null)}>{all.common.cancel}</Button>
              <Button size="sm" variant="primary" type="submit" disabled={!text.trim()}>{tp.keep}</Button>
            </div>
          </form>
        )}
        {notes.length > 0 && (
          <section className={pp.notes} aria-label={tp.notes}>
            <header><b>{tp.notes}</b><span>{notes.length}</span></header>
            <ol>
              {notes.map((n, i) => (
                <li key={n.id}>
                  <i>{i + 1}</i>
                  <div><small>{n.label}</small>{n.note}</div>
                  <button type="button" aria-label={tp.removeNote(i + 1)} title={tp.remove} onClick={() => setNotes(l => l.filter(x => x.id !== n.id))}>×</button>
                </li>
              ))}
            </ol>
            <footer>
              <Button size="sm" variant="ghost" onClick={() => setNotes([])}>{tp.discard}</Button>
              <Button size="sm" variant="primary" title={t.copyTitle} onClick={copy}>{copied ? t.copied : t.copy(notes.length)}</Button>
            </footer>
          </section>
        )}
        {show
          ? <iframe key={frameKey} className={styles.pvFrame} src={src} title={t.frame} sandbox={PREVIEW_SANDBOX} data-kind="live" />
          : s === 'paused'
            ? <div className={styles.pvEmpty}><p>{t.loadHint}</p><Button variant="primary" onClick={() => setWake(true)}>{t.load}</Button></div>
            : <div className={styles.pvEmpty}><p>{t.none}</p></div>}
      </div>
    </section>
  );
}
