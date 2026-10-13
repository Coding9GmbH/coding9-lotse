'use client';

import { useEffect, useRef, useState } from 'react';
import type { Annotation } from '@/lib/annotations';
import { markKeySelects } from '@/lib/a11y';
import { popoverLeft } from '@/lib/popover';
import { scoreClass } from '@/lib/audit';
import type { DraftView, PreviewTab } from '@/lib/chat-state';
import { Button } from '@/components/ui/Button';
import { IconClose, IconPin } from '@/components/ui/icons';
import { Segmented } from '@/components/ui/Segmented';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { attachAnnotator, drawPins, type FrameTarget, type Pick } from './annotator';
import { DraftFrame, PREVIEW_SANDBOX } from './DraftFrame';
import styles from './PreviewPane.module.css';

interface Props {
  tab: PreviewTab;
  onTab: (t: PreviewTab) => void;
  draft: DraftView | null;
  liveUrl: string | null;
  onOpenAudit: () => void;
  className?: string;
  /** Gesammelte Änderungswünsche (in der Vorschau markiert) */
  notes: Annotation[];
  onAddNote: (a: Omit<Annotation, 'id'>) => void;
  onRemoveNote: (id: string) => void;
  onClearNotes: () => void;
  onSubmitNotes: (where: 'draft' | 'live') => void;
  /** Lotse arbeitet gerade – Absenden erst danach */
  busy: boolean;
  /** Vorschau liegt als Überlagerung über dem Chat (schmaler Viewport): Schließen-Knopf */
  onClose?: () => void;
}

/** Rechte Spalte: echte Seite (Aktuell), Entwurf mit Shop-Theme, JSON-Spezifikation; Mobil/Desktop. */
export function PreviewPane({ tab, onTab, draft, liveUrl, onOpenAudit, className, notes, onAddNote, onRemoveNote, onClearNotes, onSubmitNotes, busy, onClose }: Props) {
  const [mobile, setMobile] = useState(false);
  const [marking, setMarking] = useState(false);
  const [pick, setPick] = useState<(Pick & { left: number; top: number }) | null>(null);
  const [targets, setTargets] = useState<FrameTarget[]>([]);
  const [wasMarking, setWasMarking] = useState(false);
  const [text, setText] = useState('');
  const { locale, t: { common: c, preview: t } } = useI18n();
  if (marking !== wasMarking) {
    setWasMarking(marking);
    if (!marking) setTargets([]);
  }
  const viewRef = useRef<HTMLDivElement>(null);
  const canMark = (tab === 'prev' && !!draft && !draft.partial) || (tab === 'live' && !!liveUrl);
  const where = tab === 'live' ? 'live' : 'draft';
  const frame = () => viewRef.current?.querySelector<HTMLIFrameElement>(`iframe[data-kind="${tab}"]`) ?? null;

  // Markier-Modus: Element in der Vorschau anklicken → Eingabe „Was soll anders sein?“ an der Klickstelle
  const place = (p: Pick) => {
    const f = frame();
    const vr = viewRef.current?.getBoundingClientRect();
    const fr = f?.getBoundingClientRect();
    setText('');
    const width = vr ? Math.min(320, Math.max(0, vr.width - 16)) : 320;
    const left = fr && vr ? popoverLeft(fr.left - vr.left + p.x - 20, width, vr.width) : 16;
    const top = fr && vr ? Math.min(fr.top - vr.top + p.y + 14, vr.height - 190) : 48;
    setPick({ ...p, left, top });
  };

  useEffect(() => {
    if (!marking) return;
    const f = canMark ? frame() : null;
    if (!f) return;
    return attachAnnotator(f, place, setTargets, locale);
  }, [marking, canMark, tab, draft?.rev, liveUrl, locale]); // eslint-disable-line react-hooks/exhaustive-deps -- frame() und place lesen nur das DOM

  // Nummern an den markierten Elementen (auch nach dem Neuladen des Entwurfs)
  useEffect(() => {
    const f = frame();
    if (!f) return;
    const draw = () => drawPins(f, marking ? notes.map(n => n.path) : []);
    draw();
    f.addEventListener('load', draw);
    return () => f.removeEventListener('load', draw);
  }, [notes, marking, tab, draft?.rev]); // eslint-disable-line react-hooks/exhaustive-deps -- frame() liest nur das DOM

  const save = () => {
    if (!pick || !text.trim()) return;
    onAddNote({ label: pick.label, section: pick.section, path: pick.path, note: text.trim() });
    setPick(null);
  };
  const audit = draft?.audit;
  const empty = (tab === 'live' && !liveUrl) || (tab === 'prev' && !draft);

  return (
    <section className={[styles.right, className].filter(Boolean).join(' ')} aria-label={t.aria}>
      <div className={styles.bar}>
        <div className={styles.ttl}>
          {draft ? (
            <>
              {draft.name || t.draft}<small>{draft.pageType}</small>
              {draft.partial
                ? <span className={styles.badge}><i aria-hidden="true" />{t.writing}</span>
                : audit && (
                  <button type="button" className={`${styles.score} ${styles[scoreClass(audit.score)]}`} title={t.scoreTitle} onClick={onOpenAudit}>
                    SEO/CRO {audit.score}
                  </button>
                )}
            </>
          ) : t.title}
        </div>
        <Segmented label={t.view} className={styles.seg} value={tab === 'spec' ? 'prev' : tab} onChange={onTab} options={[
          { value: 'live', label: t.live, title: t.liveTitle },
          { value: 'prev', label: t.draft, title: t.draftTitle },
        ]} />
        <Button size="sm" className={`${styles.mark} ${marking ? styles.markOn : ''}`} aria-pressed={marking} disabled={!canMark && !marking}
          title={t.markTitle}
          onClick={() => { setMarking(m => !m); setPick(null); }}>
          <IconPin size={15} />{marking ? t.markStop : t.mark}
        </Button>
        <button type="button" className={styles.vp} onClick={() => setMobile(m => !m)} aria-pressed={mobile}
          title={mobile ? t.desktop : t.mobile} aria-label={mobile ? t.desktop : t.mobile}>
          {mobile ? '🖥️' : '📱'}
        </button>
        {onClose && <button type="button" className={styles.close} onClick={onClose} aria-label={t.close} title={t.backToChat}><IconClose size={18} /></button>}
      </div>
      <div ref={viewRef} className={`${styles.view} ${mobile ? styles.m : ''} ${marking ? styles.marking : ''}`}>
        {marking && !pick && <div className={styles.markHint}>{t.markHint}</div>}
        {marking && !pick && targets.length > 0 && (
          <ul className={styles.targets} aria-label={t.targets}>
            {targets.map((x, i) => (
              <li key={`${x.path}-${i}`}>
                <button type="button" onClick={() => place({ ...x, x: 24, y: 24 })}
                  onKeyDown={e => { if (!markKeySelects(e.key)) return; e.preventDefault(); place({ ...x, x: 24, y: 24 }); }}>
                  {x.label}
                </button>
              </li>
            ))}
          </ul>
        )}
        {pick && (
          <form className={styles.pop} style={{ left: pick.left, top: pick.top }} onSubmit={e => { e.preventDefault(); save(); }}>
            <b>{pick.label}</b>
            {pick.section && <small>{t.section(pick.section)}</small>}
            <textarea autoFocus rows={3} value={text} onChange={e => setText(e.target.value)} aria-label={t.whatDifferent} placeholder={t.whatDifferentPlaceholder}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') setPick(null); }} />
            <div className={styles.popBtns}>
              <Button size="sm" onClick={() => setPick(null)}>{c.cancel}</Button>
              <Button size="sm" variant="primary" type="submit" disabled={!text.trim()}>{t.keep}</Button>
            </div>
          </form>
        )}
        {notes.length > 0 && (
          <section className={styles.notes} aria-label={t.notes}>
            <header><b>{t.notes}</b><span>{notes.length}</span></header>
            <ol>
              {notes.map((n, i) => (
                <li key={n.id}>
                  <i>{i + 1}</i>
                  <div><small>{n.label}</small>{n.note}</div>
                  <button type="button" aria-label={t.removeNote(i + 1)} title={t.remove} onClick={() => onRemoveNote(n.id)}>×</button>
                </li>
              ))}
            </ol>
            <footer>
              <Button size="sm" variant="ghost" onClick={onClearNotes}>{t.discard}</Button>
              <Button size="sm" variant="primary" disabled={busy} title={busy ? t.busyTitle : undefined}
                onClick={() => { onSubmitNotes(where); setMarking(false); setPick(null); }}>
                {busy ? t.busy : t.send(notes.length)}
              </Button>
            </footer>
          </section>
        )}
        {empty && (
          <div className={styles.empty}>
            {tab === 'live'
              ? <div><b>{t.noPage}</b>{t.noPageText}</div>
              : <div><b>{t.noDraft}</b>{t.noDraftText}</div>}
          </div>
        )}
        {liveUrl && <iframe className={styles.frame} src={liveUrl} hidden={tab !== 'live'} data-kind="live" title={t.liveFrame} sandbox={PREVIEW_SANDBOX} />}
        <DraftFrame draft={draft} className={styles.frame} hidden={(tab !== 'prev' && tab !== 'spec') || !draft} title={t.draftFrame} />
      </div>
    </section>
  );
}
