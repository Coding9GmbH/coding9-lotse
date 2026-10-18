'use client';

import { useEffect, useRef, useState } from 'react';
import type { CodeTaskPublic } from '@/lib/protocol';
import { api, errorText } from '@/lib/api';
import { annotationMessage, type Annotation } from '@/lib/annotations';
import { markKeySelects } from '@/lib/a11y';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { popoverLeft } from '@/lib/popover';
import { sandboxSrc, sandboxWakeSrc } from '@/lib/urls';
import { Button } from '@/components/ui/Button';
import { IconCamera, IconExpand, IconExternal, IconMonitor, IconPanel, IconPhone, IconPin, IconRefresh, IconShrink } from '@/components/ui/icons';
import { Menu } from '@/components/ui/Menu';
import { attachAnnotator, drawPins, type FrameTarget, type Pick } from '@/components/preview/annotator';
import { PREVIEW_SANDBOX } from '@/components/preview/DraftFrame';
import { ErrorText } from './PublishCard';
import pp from '@/components/preview/PreviewPane.module.css';
import styles from './Sandbox.module.css';

/** Remounts the frame after the theme was compiled (setup or later a run): the end time of a successful theme-compile step. */
export const previewBust = (task: CodeTaskPublic) => task.steps.filter(s => s.key === 'theme-compile' && s.state === 'done').map(s => s.endedAt ?? '').join('|');

/** The task's storefront through /sbx/<id>/: usable for testing (navigation, cart, checkout), in an opaque origin like the shop preview.
 *  A paused task starts again only on request ("Vorschau laden"); while it starts, /sbx shows a page that reloads itself.
 *  Mark mode as in the shop preview (frame script via postMessage); the requests go to the task chat (onSendNotes) or are copied as text.
 *  `reload` changes when the chat compiled the theme or cleared the cache: the frame loads again.
 *  The frame fills the tab; narrower than Shopware's desktop breakpoint, "Desktop" scales a 1280 px viewport into it, so the storefront
 *  really shows its desktop layout. `layout`: collapse the chat and full screen (the workspace and the panel own that state). */
/** Shopware's storefront switches to its desktop layout at 992 px; narrower frames get a scaled 1280 px viewport. Below MOBILE_BELOW
 *  the scaled desktop would be unreadable (about a third of its size): the frame starts in mobile width there, "Desktop" still scales. */
const DESKTOP_WIDTH = 1280, DESKTOP_BREAK = 992, MOBILE_BELOW = 700;

export interface PreviewLayout { full: boolean; onFull: () => void; chatHidden?: boolean; onToggleChat?: () => void }
/** "Screenshot" (only while switched on in the environment): the configured pages, desktop and mobile, on the user's click */
export interface PreviewShots { pages: string[]; onTaken: (task: CodeTaskPublic) => void }

export function SandboxPreview({ task, reload = 0, onSendNotes, inTabs = false, layout, shots }: { task: CodeTaskPublic; reload?: number; onSendNotes?: (text: string) => void; inTabs?: boolean; layout?: PreviewLayout; shots?: PreviewShots }) {
  const { locale, t: all } = useI18n();
  const t = all.sandbox.preview, tp = all.preview;
  // the repository file may name the first page (.lotse/sandbox.json "previewPath")
  const [path, setPath] = useState(task.startPath ?? '/');
  const [typed, setTyped] = useState(task.startPath ?? '/');
  const [device, setDevice] = useState<'auto' | 'desktop' | 'mobile'>('auto'); // auto = by the frame's width
  const [reloads, setReloads] = useState(0);
  const [wake, setWake] = useState(false);
  const [seen, setSeen] = useState(task.status);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const s = task.status;
  if (s !== seen) { setSeen(s); if (s === 'paused') setWake(false); } // paused again (button, idle): wait for a new request
  const running = !!task.container?.running && s !== 'done' && s !== 'paused';
  const show = s === 'ready' || s === 'waking' || (running && (s === 'failed' || s === 'interrupted')) || (wake && s === 'paused');
  const src = sandboxSrc(task.preview, path);
  // after "Vorschau laden" the frame goes through the wake path: an explicit start, also when the last one failed (plain preview
  // requests no longer retry then); once running that path only redirects to the page
  const frameSrc = wake ? sandboxWakeSrc(task.preview, path) : src;
  const frameKey = `${frameSrc}|${previewBust(task)}|${reloads}|${reload}`;
  const mobile = device === 'mobile' || (device === 'auto' && box.w > 0 && box.w < MOBILE_BELOW);
  // Lotse's status pages ("Umgebung startet …") stay unscaled: only the running storefront gets the desktop viewport
  const scale = !mobile && s === 'ready' && box.w > 0 && box.w < DESKTOP_BREAK ? box.w / DESKTOP_WIDTH : 1;

  const [marking, setMarking] = useState(false);
  const [pick, setPick] = useState<(Pick & { left: number; top: number }) | null>(null);
  const [targets, setTargets] = useState<FrameTarget[]>([]);
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const [shooting, setShooting] = useState(false);
  const [shotNote, setShotNote] = useState<{ ok: boolean; text: string } | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(scale);
  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => {
    const el = viewRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const frame = () => viewRef.current?.querySelector<HTMLIFrameElement>('iframe[data-kind="live"]') ?? null;
  const place = (p: Pick) => {
    const vr = viewRef.current?.getBoundingClientRect(), fr = frame()?.getBoundingClientRect(), k = scaleRef.current;
    const width = vr ? Math.min(320, Math.max(0, vr.width - 16)) : 320;
    setText('');
    setPick({ ...p, left: fr && vr ? popoverLeft(fr.left - vr.left + p.x * k - 20, width, vr.width) : 16, top: fr && vr ? Math.min(fr.top - vr.top + p.y * k + 14, vr.height - 190) : 48 });
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
  // a screenshot needs the running storefront; it takes a while (browser container), the result lands in the "Pull Request" tab
  const canShoot = !!shots && s === 'ready' && !!task.container?.running && !shooting;
  const shoot = async () => {
    if (!shots || shooting) return;
    setShooting(true); setShotNote(null);
    try { shots.onTaken((await api.sandbox.screenshot(task.id)).task); setShotNote({ ok: true, text: t.screenshotDone }); setTimeout(() => setShotNote(n => (n?.ok ? null : n)), 4000); }
    catch (e) { setShotNote({ ok: false, text: t.screenshotFailed(errorText(e)) }); }
    finally { setShooting(false); }
  };
  const shotTitle = shots ? t.screenshotTitle(shots.pages.join(', ') || '/') : '';
  const toggleMark = () => { setMarking(m => !m); setPick(null); };
  const frameStyle: React.CSSProperties | undefined = scale < 1 ? { width: DESKTOP_WIDTH, height: box.h / scale, transform: `scale(${scale})` } : undefined;

  return (
    <section className={inTabs ? styles.pvTab : styles.card} aria-labelledby="sbx-preview">
      <div className={inTabs ? 'visually-hidden' : styles.cardHead}><h2 id="sbx-preview">{t.heading}</h2></div>
      <form className={styles.pvBar} onSubmit={e => { e.preventDefault(); setPath(typed || '/'); setReloads(n => n + 1); }}>
        {layout?.onToggleChat && (
          <button type="button" className={`${styles.iconBtn} ${styles.pvWide}`} onClick={layout.onToggleChat} aria-pressed={!!layout.chatHidden}
            aria-label={layout.chatHidden ? t.showChat : t.hideChat} title={layout.chatHidden ? t.showChat : t.hideChat}><IconPanel size={17} /></button>
        )}
        <input value={typed} onChange={e => setTyped(e.target.value)} aria-label={t.path} spellCheck={false} />
        <Button size="sm" type="submit" disabled={!show}>{t.go}</Button>
        <button type="button" className={`${styles.iconBtn} ${styles.pvWide}`} onClick={() => setReloads(n => n + 1)} disabled={!show} aria-label={t.reload} title={t.reload}><IconRefresh size={16} /></button>
        <div className={`${styles.seg} ${styles.pvWide}`} role="group" aria-label={t.device}>
          <button type="button" aria-pressed={!mobile} onClick={() => setDevice('desktop')} aria-label={t.desktop} title={scale < 1 ? t.scaled(Math.round(scale * 100)) : t.desktop}><IconMonitor size={16} /></button>
          <button type="button" aria-pressed={mobile} onClick={() => setDevice('mobile')} aria-label={t.mobile} title={t.mobile}><IconPhone size={16} /></button>
        </div>
        <Button size="sm" className={`${styles.pvMark} ${marking ? styles.pvMarkOn : ''}`} aria-pressed={marking} disabled={!show && !marking} title={t.markTitle} onClick={toggleMark}>
          <IconPin size={15} /><span>{marking ? t.markStop : t.mark}</span>
        </Button>
        {shots && (
          <button type="button" className={`${styles.iconBtn} ${styles.pvWide}`} onClick={() => void shoot()} disabled={!canShoot} aria-busy={shooting || undefined}
            aria-label={shooting ? t.screenshotBusy : t.screenshot} title={shooting ? t.screenshotBusy : shotTitle}><IconCamera size={16} className={shooting ? styles.pulsing : undefined} /></button>
        )}
        {show && <a className={`${styles.iconBtn} ${styles.pvWide}`} href={src} target="_blank" rel="noopener" aria-label={t.newTab} title={t.newTab}><IconExternal size={16} /></a>}
        {show && <a className={`${styles.pvAdmin} ${styles.pvWide}`} href={sandboxSrc(task.preview, '/admin')} target="_blank" rel="noopener" title={t.adminTitle}>{t.admin}</a>}
        {layout && (
          <button type="button" className={`${styles.iconBtn} ${styles.pvWide}`} onClick={layout.onFull} aria-pressed={layout.full}
            aria-label={layout.full ? t.exitFull : t.full} title={layout.full ? t.exitFull : t.full}>{layout.full ? <IconShrink size={16} /> : <IconExpand size={16} />}</button>
        )}
        <Menu className={styles.pvNarrow} label={t.tools} items={[
          { key: 'reload', label: t.reload, onSelect: () => setReloads(n => n + 1), disabled: !show },
          { key: 'device', label: mobile ? t.desktop : t.mobile, onSelect: () => setDevice(mobile ? 'desktop' : 'mobile') },
          ...(shots ? [{ key: 'shot', label: shooting ? t.screenshotBusy : t.screenshot, onSelect: () => void shoot(), disabled: !canShoot }] : []),
          ...(show ? [{ key: 'tab', label: t.newTab, href: src, external: true }, { key: 'admin', label: t.admin, href: sandboxSrc(task.preview, '/admin'), external: true }] : []),
          ...(layout ? [{ key: 'full', label: layout.full ? t.exitFull : t.full, onSelect: layout.onFull }] : []),
        ]} />
      </form>
      {(shooting || shotNote) && <p className={`${styles.pvNote} ${shotNote && !shotNote.ok ? styles.bad : ''}`} role={shotNote && !shotNote.ok ? 'alert' : 'status'}>{shooting ? t.screenshotBusy : shotNote?.text}</p>}
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
              {onSendNotes
                ? <><Button size="sm" title={t.copyTitle} onClick={copy}>{copied ? t.copied : t.copy(notes.length)}</Button>
                  <Button size="sm" variant="primary" title={all.sandbox.code.sendNotesTitle} onClick={() => { onSendNotes(annotationMessage(notes, 'sandbox', locale)); setNotes([]); setMarking(false); }}>{all.sandbox.code.sendNotes(notes.length)}</Button></>
                : <Button size="sm" variant="primary" title={t.copyTitle} onClick={copy}>{copied ? t.copied : t.copy(notes.length)}</Button>}
            </footer>
          </section>
        )}
        {show
          ? <iframe key={frameKey} className={styles.pvFrame} style={frameStyle} src={frameSrc} title={t.frame} sandbox={PREVIEW_SANDBOX} data-kind="live" />
          : s === 'paused' && task.stopping // stored as paused, the container is still being stopped
            ? <div className={styles.pvEmpty}><p role="status">{t.pausing}</p></div>
            : s === 'paused'
              ? <div className={styles.pvEmpty}>{task.error && <ErrorText text={task.error} details={t.errorDetails} />}<p>{t.loadHint}</p><Button onClick={() => setWake(true)}>{t.load}</Button></div>
            : <div className={styles.pvEmpty}><p>{t.none}</p></div>}
      </div>
    </section>
  );
}
