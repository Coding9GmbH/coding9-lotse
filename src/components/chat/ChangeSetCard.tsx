'use client';

import { useId, useMemo, useState } from 'react';
import type { ChangesetResultEvent, UndoPhase } from '@/lib/chat-state';
import type { ChangeItem, ChangeSet } from '@/lib/protocol';
import { applyHint, undoPlannedFor } from '@/lib/apply-hint';
import { plural, sampleSummary } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import styles from './ChangeSetCard.module.css';

interface Props {
  cs: ChangeSet;
  interactive: boolean;
  decision?: boolean;
  sent?: { allow: boolean; selected?: string[] };
  result?: ChangesetResultEvent;
  progress?: { done: number; total: number };
  undo: UndoPhase;
  onDecide: (allow: boolean, selected?: string[]) => void;
  onUndo: () => void;
}

const UNDO_TEXT: Record<UndoPhase, string> = { idle: 'Rückgängig machen', running: 'Wird zurückgesetzt …', done: 'Rückgängig gemacht ✓', failed: 'Rückgängig fehlgeschlagen' };
const fmt = (n: number) => n.toLocaleString('de-DE');
/** Stapelverarbeitung: Anzahl Produkte einer Gruppe (afterRaw.count), sonst 1 */
const groupCount = (i: ChangeItem) => ((i.afterRaw as { count?: number } | undefined)?.count ?? 1);

// Leere Seite eines Vergleichs: neu angelegt bzw. entfernt statt „– → …“
const EMPTY = new Set(['', '–', '-', '—', '(leer)', 'leer', 'keine', 'kein']);
const isAdded = (i: ChangeItem) => EMPTY.has(i.before.trim());
function Diff({ i, groupNew }: { i: ChangeItem; groupNew?: boolean }) {
  const added = isAdded(i), removed = !added && EMPTY.has(i.after.trim());
  return (
    <div className={styles.diff}>
      <span className={styles.fl}>{i.fieldLabel}</span>
      {added ? !groupNew && <span className={styles.badge}>neu</span> : <span className={styles.old}>{i.before}</span>}
      {!added && !removed && <span aria-hidden="true" className={styles.arrow}>→</span>}
      {removed ? <span className={`${styles.badge} ${styles.badgeOff}`}>entfernt</span> : <span className={styles.new}>{i.after}</span>}
      {(i.warn ?? []).map(w => <span key={w} className={styles.wn}>⚠ {w}</span>)}
    </div>
  );
}

/** Änderungsset: Vergleich vorher/nachher → Auswahl → Freigabe → Ergebnis → Rückgängig. */
export function ChangeSetCard({ cs, interactive, decision, sent, result, progress, undo, onDecide, onUndo }: Props) {
  const real = useMemo(() => cs.items.filter(i => i.entity !== 'info'), [cs]); // Hinweiszeilen zählen und wählen nicht mit
  const selectable = real.length > 0;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(real.map(i => i.id)));
  const [clickLocked, setClickLocked] = useState(false);
  const allId = useId();
  const n = selected.size;
  const entities = new Set(real.map(i => i.entityId)).size;
  const warns = cs.items.filter(i => i.warn?.length).length;
  const locked = !interactive;
  const bulk = cs.total != null;
  const resultMap = useMemo(() => new Map((result?.results ?? []).map(r => [r.itemId, r])), [result]);
  const resultFor = (id: string) => resultMap.get(id);
  const applied = result && result.status !== 'rejected' && !result.error;

  const isOff = (i: ChangeItem) => {
    const id = i.id;
    if (!selectable || i.entity === 'info') return false;
    if (interactive) return !selected.has(id);
    if (sent?.selected) return !sent.selected.includes(id);
    if (bulk && !result?.counts) return false; // ältere Stapel-Ergebnisse ohne Gruppenzeilen
    return !!applied && !!result?.results && !resultFor(id); // gespeicherter Chat: nicht ausgewählte Zeilen haben kein Ergebnis
  };
  const bulkSel = bulk ? real.filter(i => !isOff(i)).reduce((m, i) => m + groupCount(i), 0) : 0;

  const choose = (allow: boolean) => {
    if (clickLocked) return;
    setClickLocked(true);
    onDecide(allow, allow && selectable ? cs.items.filter(i => selected.has(i.id)).map(i => i.id) : undefined);
  };
  const toggle = (id: string, on: boolean) => setSelected(prev => { const s = new Set(prev); if (on) s.add(id); else s.delete(id); return s; });
  const toggleAll = (on: boolean) => setSelected(on ? new Set(real.map(i => i.id)) : new Set());

  let res: React.ReactNode = null;
  if (result) {
    if (result.status === 'rejected') res = result.error ? `✗ ${result.error}` : '✗ Abgelehnt. Es wurde nichts geschrieben.'; // error: Grund (z. B. Neustart)
    else if (result.error) res = `✗ ${result.error}`;
    else {
      const ok = result.counts?.applied ?? (result.results ?? []).filter(r => r.ok).length;
      const bad = result.counts?.failed ?? (result.results ?? []).filter(r => !r.ok).length;
      const off = real.filter(isOff).reduce((m, i) => m + (bulk ? groupCount(i) : 1), 0);
      res = `${bad ? '⚠' : '✓'} ${fmt(ok)} angewendet${bad ? `, ${fmt(bad)} fehlgeschlagen` : ''}${off ? `, ${fmt(off)} nicht ausgewählt` : ''}`;
    }
  } else if (progress) res = progress.total > 1 ? `${fmt(progress.done)} / ${fmt(progress.total)} angewendet …` : 'Wird angewendet …'; // auch nach erneutem Verbinden (ohne sent); Einzelsätze zählen nicht mit
  else if (sent) res = sent.allow ? 'Wird angewendet …' : 'Wird abgelehnt …';
  else if (locked && decision === undefined) res = 'offen';

  const undoPhase: UndoPhase = result?.undone && undo === 'idle' ? 'done' : undo;
  const undoTotal = result?.undo?.length ?? 0, undoOk = result?.undoResults?.filter(x => x.ok).length;
  const undoPartial = undoOk !== undefined && !result?.undone && undoPhase === 'idle'; // teilweise zurückgesetzt: Rest ist erneut klickbar

  return (
    <section className={styles.cs} aria-label={`Änderungsset: ${cs.title}`}>
      <div className={styles.head}>
        <span className={styles.tag}>
          {bulk ? `${fmt(cs.total!)} ${plural(cs.total!, cs.noun?.one ?? 'Datensatz', cs.noun?.many ?? 'Datensätze')} · Stapelverarbeitung` : cs.kind === 'new-products' ? `${cs.items.length} ${plural(cs.items.length, 'neues Produkt', 'neue Produkte')}` : cs.noun ? `${cs.items.length} ${plural(cs.items.length, 'Änderung', 'Änderungen')} · ${entities} ${plural(entities, cs.noun.one, cs.noun.many)}` : selectable ? `${cs.items.length} Änderungen · ${entities} ${cs.entity === 'category' ? 'Kategorien' : 'Produkte'}` : 'Veröffentlichung'}
        </span>
        <b>{cs.title}</b>
        {cs.reason && <p>{cs.reason}</p>}
      </div>

      {!!cs.assets?.length && (
        <div className={styles.assets}>
          {cs.assets.map(a => (
            <span key={a.url} className={styles.asset}>
              {/* eslint-disable-next-line @next/next/no-img-element -- vorgemerkte Bilder */}
              <img src={a.url} alt={a.alt ?? ''} />
              <span><small>{a.note}</small>{a.name}</span>
            </span>
          ))}
        </div>
      )}

      <div className={styles.rows}>
        {cs.items.map((i, k) => {
          const r = resultFor(i.id);
          const head = k === 0 || cs.items[k - 1].label !== i.label; // gleicher Eintrag: Name nur einmal
          const group = cs.items.filter(x => x.label === i.label), groupNew = group.length > 1 && group.every(isAdded); // ganz neu: „neu“ einmal am Namen
          return (
            <div key={i.id} className={`${styles.row} ${head ? '' : styles.cont} ${isOff(i) ? styles.off : ''}`}>
              <span>
                {i.entity !== 'info' && <input type="checkbox" checked={interactive ? selected.has(i.id) : !isOff(i)} disabled={locked}
                  onChange={e => toggle(i.id, e.target.checked)} aria-label={`${i.label}: ${i.fieldLabel} übernehmen`} />}
              </span>
              <div className={styles.main}>
                {head && <span className={styles.lb} title={i.label}>{i.label}{groupNew && <span className={styles.badge}>neu</span>}</span>}
                <Diff i={i} groupNew={groupNew} />
                {i.html && (
                  <details>
                    <summary>Text vergleichen</summary>
                    <div className={styles.cmp}>
                      <div aria-label="Vorher">{i.html.before || <span className={styles.none}>(leer)</span>}</div>
                      <div aria-label="Nachher">{i.html.after}</div>
                    </div>
                  </details>
                )}
              </div>
              <span className={styles.st}>{r && (r.ok ? <span className={styles.ok} aria-label="angewendet">✓</span> : <span className={styles.bad} title={r.error}>✗ {r.error}</span>)}</span>
            </div>
          );
        })}
      </div>

      {!!cs.sample?.length && (
        <details className={styles.sample} open={!result}>
          <summary>{sampleSummary(cs.sample.length, cs.total ?? cs.sample.length)}</summary>
          <div className={styles.rows}>
            {cs.sample.map(i => {
              const r = resultFor(i.id);
              return (
                <div key={i.id} className={styles.srow}>
                  <span className={styles.lb} title={i.label}>{i.label}</span>
                  <Diff i={i} />
                  {r && (r.ok ? <span className={styles.ok}>✓</span> : <span className={styles.bad} title={r.error}>✗ {r.error}</span>)}
                </div>
              );
            })}
          </div>
        </details>
      )}

      {!result && progress && progress.total > 5 && ( // Balken erst bei größeren Sets: kleine melden nur den Text
        <div className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label="Fortschritt">
          <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
        </div>
      )}

      {cs.skipped?.length > 0 && (
        <details className={styles.skipped}>
          <summary>⚠ {cs.skipped.length} {plural(cs.skipped.length, 'Angabe', 'Angaben')} übersprungen (ungültig oder nicht erlaubt)</summary>
          <ul>{cs.skipped.map((x, k) => <li key={`${x.id}-${k}`}>{x.reason}</li>)}</ul>
        </details>
      )}

      <div className={styles.foot}>
        {interactive && selectable && (
          <label htmlFor={allId}>
            <input id={allId} type="checkbox" checked={n === real.length} onChange={e => toggleAll(e.target.checked)} />
            {bulk ? <>{fmt(bulkSel)} von {fmt(cs.total!)} ausgewählt</> : <>alle <span>{n}</span> ausgewählt</>}{warns > 0 && <> · <span className={styles.wn}>{warns}× Warnung</span></>}
          </label>
        )}
        {interactive && <span className={styles.res}>{applyHint({ selectable, undoPlanned: undoPlannedFor(cs) })}</span>}
        {interactive && (
          <>
            <Button variant="primary" disabled={clickLocked || (selectable && (bulk ? !bulkSel : !n))} onClick={() => choose(true)}>
              {bulk ? `${fmt(bulkSel)} ${plural(bulkSel, cs.noun?.one ?? 'Datensatz', cs.noun?.many ?? 'Datensätze')} ändern` : cs.applyLabel ? cs.applyLabel : cs.kind === 'new-products' ? `${n} ${plural(n, 'Produkt', 'Produkte')} anlegen` : selectable ? `${n} ${plural(n, 'Änderung', 'Änderungen')} anwenden` : 'Freigeben & veröffentlichen'}
            </Button>
            <Button disabled={clickLocked} onClick={() => choose(false)}>Ablehnen</Button>
          </>
        )}
        {res && <span className={styles.res} role="status">{res}</span>}
        {undoPartial && <span className={styles.res} role="status">⚠ {fmt(undoOk)} von {fmt(undoTotal)} {plural(undoTotal, 'Schritt', 'Schritten')} zurückgesetzt</span>}
        {!!undoTotal && (
          <Button disabled={undoPhase !== 'idle'} onClick={onUndo}>{undoPartial ? (undoOk ? 'Rest rückgängig machen' : 'Erneut versuchen') : UNDO_TEXT[undoPhase]}</Button>
        )}
      </div>
    </section>
  );
}
