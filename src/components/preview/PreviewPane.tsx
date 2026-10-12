'use client';

import { useEffect, useRef, useState } from 'react';
import type { Annotation } from '@/lib/annotations';
import { scoreClass } from '@/lib/audit';
import type { DraftView, PreviewTab } from '@/lib/chat-state';
import { Button } from '@/components/ui/Button';
import { IconClose, IconPin } from '@/components/ui/icons';
import { Segmented } from '@/components/ui/Segmented';
import { attachAnnotator, drawPins, type Pick } from './annotator';
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
  const [text, setText] = useState('');
  const viewRef = useRef<HTMLDivElement>(null);
  const canMark = (tab === 'prev' && !!draft && !draft.partial) || (tab === 'live' && !!liveUrl);
  const where = tab === 'live' ? 'live' : 'draft';
  const frame = () => viewRef.current?.querySelector<HTMLIFrameElement>(`iframe[data-kind="${tab}"]`) ?? null;

  // Markier-Modus: Element in der Vorschau anklicken → Eingabe „Was soll anders sein?“ an der Klickstelle
  useEffect(() => {
    const f = marking && canMark ? frame() : null;
    if (!f) return;
    return attachAnnotator(f, p => {
      const fr = f.getBoundingClientRect(), vr = viewRef.current!.getBoundingClientRect();
      setText('');
      setPick({ ...p, left: Math.min(Math.max(8, fr.left - vr.left + p.x - 20), vr.width - 340), top: Math.min(fr.top - vr.top + p.y + 14, vr.height - 190) });
    });
  }, [marking, canMark, tab, draft?.rev, liveUrl]); // eslint-disable-line react-hooks/exhaustive-deps -- frame() liest nur das DOM

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
    <section className={[styles.right, className].filter(Boolean).join(' ')} aria-label="Vorschau">
      <div className={styles.bar}>
        <div className={styles.ttl}>
          {draft ? (
            <>
              {draft.name || 'Entwurf'}<small>{draft.pageType}</small>
              {draft.partial
                ? <span className={styles.badge}><i aria-hidden="true" />wird geschrieben …</span>
                : audit && (
                  <button type="button" className={`${styles.score} ${styles[scoreClass(audit.score)]}`} title="SEO-, Conversion- und Design-Check" onClick={onOpenAudit}>
                    SEO/CRO {audit.score}
                  </button>
                )}
            </>
          ) : 'Vorschau'}
        </div>
        <Segmented label="Ansicht" className={styles.seg} value={tab === 'spec' ? 'prev' : tab} onChange={onTab} options={[
          { value: 'live', label: 'Aktuell', title: 'Die echte Seite im Shop' },
          { value: 'prev', label: 'Entwurf', title: 'Entwurf mit dem Theme des Shops' },
        ]} />
        <Button size="sm" className={`${styles.mark} ${marking ? styles.markOn : ''}`} aria-pressed={marking} disabled={!canMark && !marking}
          title="Elemente in der Vorschau anklicken und notieren, was anders sein soll. Gesammelt an Lotse senden."
          onClick={() => { setMarking(m => !m); setPick(null); }}>
          <IconPin size={15} />{marking ? 'Markieren beenden' : 'Anmerken'}
        </Button>
        <button type="button" className={styles.vp} onClick={() => setMobile(m => !m)} aria-pressed={mobile}
          title={mobile ? 'Desktop-Ansicht' : 'Mobil-Ansicht'} aria-label={mobile ? 'Desktop-Ansicht' : 'Mobil-Ansicht'}>
          {mobile ? '🖥️' : '📱'}
        </button>
        {onClose && <button type="button" className={styles.close} onClick={onClose} aria-label="Vorschau schließen" title="Zurück zum Chat"><IconClose size={18} /></button>}
      </div>
      <div ref={viewRef} className={`${styles.view} ${mobile ? styles.m : ''} ${marking ? styles.marking : ''}`}>
        {marking && !pick && <div className={styles.markHint}>Klicke auf ein Element, das anders sein soll</div>}
        {pick && (
          <form className={styles.pop} style={{ left: pick.left, top: pick.top }} onSubmit={e => { e.preventDefault(); save(); }}>
            <b>{pick.label}</b>
            {pick.section && <small>Abschnitt „{pick.section}“</small>}
            <textarea autoFocus rows={3} value={text} onChange={e => setText(e.target.value)} placeholder="Was soll anders sein? z. B. „dunkler und größer“"
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') setPick(null); }} />
            <div className={styles.popBtns}>
              <Button size="sm" onClick={() => setPick(null)}>Abbrechen</Button>
              <Button size="sm" variant="primary" type="submit" disabled={!text.trim()}>Merken</Button>
            </div>
          </form>
        )}
        {notes.length > 0 && (
          <section className={styles.notes} aria-label="Änderungswünsche">
            <header><b>Änderungswünsche</b><span>{notes.length}</span></header>
            <ol>
              {notes.map((n, i) => (
                <li key={n.id}>
                  <i>{i + 1}</i>
                  <div><small>{n.label}</small>{n.note}</div>
                  <button type="button" aria-label={`Wunsch ${i + 1} entfernen`} title="Entfernen" onClick={() => onRemoveNote(n.id)}>×</button>
                </li>
              ))}
            </ol>
            <footer>
              <Button size="sm" variant="ghost" onClick={onClearNotes}>Verwerfen</Button>
              <Button size="sm" variant="primary" disabled={busy} title={busy ? 'Lotse arbeitet noch, danach senden' : undefined}
                onClick={() => { onSubmitNotes(where); setMarking(false); setPick(null); }}>
                {busy ? 'Lotse arbeitet …' : `${notes.length === 1 ? 'Wunsch' : `${notes.length} Wünsche`} an Lotse senden`}
              </Button>
            </footer>
          </section>
        )}
        {empty && (
          <div className={styles.empty}>
            {tab === 'live'
              ? <div><b>Noch keine Seite</b>Wähle ein Ziel, dann siehst du hier die echte Seite aus dem Shop.</div>
              : <div><b>Noch kein Entwurf</b>Der Entwurf baut sich hier live auf, während Lotse schreibt.</div>}
          </div>
        )}
        {liveUrl && <iframe className={styles.frame} src={liveUrl} hidden={tab !== 'live'} data-kind="live" title="Aktuelle Seite im Shop" sandbox={PREVIEW_SANDBOX} />}
        <DraftFrame draft={draft} className={styles.frame} hidden={(tab !== 'prev' && tab !== 'spec') || !draft} />
      </div>
    </section>
  );
}
