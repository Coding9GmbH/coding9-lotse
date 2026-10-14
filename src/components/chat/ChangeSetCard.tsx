'use client';

import { useId, useMemo, useState } from 'react';
import type { ChangesetResultEvent, UndoPhase } from '@/lib/chat-state';
import type { ChangeItem, ChangeSet } from '@/lib/protocol';
import { applyHint, undoPlannedFor } from '@/lib/apply-hint';
import { scriptRisk } from '@/lib/script-scan';
import { plural, sampleSummary } from '@/lib/format';
import { formatNumber } from '@/lib/i18n';
import { useI18n, useT } from '@/lib/i18n/I18nProvider';
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

/** Bulk edit: number of products in a group (afterRaw.count), otherwise 1 */
const groupCount = (i: ChangeItem) => ((i.afterRaw as { count?: number } | undefined)?.count ?? 1);

// Empty side of a comparison: newly created or removed instead of "– → …"
const EMPTY = new Set(['', '–', '-', '—', '(leer)', 'leer', 'keine', 'kein']);
const isAdded = (i: ChangeItem) => EMPTY.has(i.before.trim());
function Diff({ i, groupNew }: { i: ChangeItem; groupNew?: boolean }) {
  const t = useT().chat.changeset;
  const added = isAdded(i), removed = !added && EMPTY.has(i.after.trim());
  return (
    <div className={styles.diff}>
      <span className={styles.fl}>{i.fieldLabel}</span>
      {added ? !groupNew && <span className={styles.badge}>{t.isNew}</span> : <span className={styles.old}>{i.before}</span>}
      {!added && !removed && <span aria-hidden="true" className={styles.arrow}>→</span>}
      {removed ? <span className={`${styles.badge} ${styles.badgeOff}`}>{t.removed}</span> : <span className={styles.new}>{i.after}</span>}
      {(i.warn ?? []).map(w => <span key={w} className={styles.wn}>⚠ {w}</span>)}
    </div>
  );
}

/** Change set: before/after comparison → selection → approval → result → undo. */
export function ChangeSetCard({ cs, interactive, decision, sent, result, progress, undo, onDecide, onUndo }: Props) {
  const { locale, t: m } = useI18n();
  const t = m.chat.changeset;
  const fmt = (x: number) => formatNumber(x, locale);
  const real = useMemo(() => cs.items.filter(i => i.entity !== 'info'), [cs]); // info rows are not counted or selectable
  const selectable = real.length > 0;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(real.map(i => i.id)));
  const [clickLocked, setClickLocked] = useState(false);
  const allId = useId();
  const n = selected.size;
  const entities = new Set(real.map(i => i.entityId)).size;
  const warns = cs.items.filter(i => i.warn?.length).length;
  // JavaScript in the change (page spec from the server, otherwise the rows' new values): show clearly BEFORE applying
  const script = useMemo(() => cs.script ?? scriptRisk(cs.items.map(i => [i.after, i.afterRaw, i.html?.after])), [cs]);
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
    if (bulk && !result?.counts) return false; // older bulk results without group rows
    return !!applied && !!result?.results && !resultFor(id); // saved chat: unselected rows have no result
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
    if (result.status === 'rejected') res = result.error ? `✗ ${result.error}` : t.rejected; // error: reason (e.g. restart)
    else if (result.error) res = `✗ ${result.error}`;
    else {
      const ok = result.counts?.applied ?? (result.results ?? []).filter(r => r.ok).length;
      const bad = result.counts?.failed ?? (result.results ?? []).filter(r => !r.ok).length;
      const off = real.filter(isOff).reduce((m, i) => m + (bulk ? groupCount(i) : 1), 0);
      res = `${bad ? '⚠' : '✓'} ${t.applied(fmt(ok))}${bad ? t.failedPart(fmt(bad)) : ''}${off ? t.unselectedPart(fmt(off)) : ''}`;
    }
  } else if (progress) res = progress.total > 1 ? t.progress(fmt(progress.done), fmt(progress.total)) : t.applying; // also after reconnecting (without sent); single records are not counted
  else if (sent) res = sent.allow ? t.applying : t.rejecting;
  else if (locked && decision === undefined) res = t.open;

  const undoPhase: UndoPhase = result?.undone && undo === 'idle' ? 'done' : undo;
  const undoTotal = result?.undo?.length ?? 0, undoOk = result?.undoResults?.filter(x => x.ok).length;
  const undoPartial = undoOk !== undefined && !result?.undone && undoPhase === 'idle'; // partially undone: the rest is clickable again

  return (
    <section className={styles.cs} aria-label={t.aria(cs.title)}>
      <div className={styles.head}>
        <span className={styles.tag}>
          {bulk ? t.bulkTag(fmt(cs.total!), plural(cs.total!, cs.noun?.one ?? t.record.one, cs.noun?.many ?? t.record.many)) : cs.kind === 'new-products' ? t.newProducts(cs.items.length) : cs.noun ? t.changesOf(cs.items.length, entities, plural(entities, cs.noun.one, cs.noun.many)) : selectable ? t.changesEntities(cs.items.length, entities, cs.entity === 'category') : t.publication}
        </span>
        <b>{cs.title}</b>
        {cs.reason && <p>{cs.reason}</p>}
      </div>

      {!!cs.assets?.length && (
        <div className={styles.assets}>
          {cs.assets.map(a => (
            <span key={a.url} className={styles.asset}>
              {/* eslint-disable-next-line @next/next/no-img-element -- staged images */}
              <img src={a.url} alt={a.alt ?? ''} />
              <span><small>{a.note}</small>{a.name}</span>
            </span>
          ))}
        </div>
      )}

      <div className={styles.rows}>
        {cs.items.map((i, k) => {
          const r = resultFor(i.id);
          const head = k === 0 || cs.items[k - 1].label !== i.label; // same entry: name only once
          const group = cs.items.filter(x => x.label === i.label), groupNew = group.length > 1 && group.every(isAdded); // entirely new: "neu" (new) once at the name
          return (
            <div key={i.id} className={`${styles.row} ${head ? '' : styles.cont} ${isOff(i) ? styles.off : ''}`}>
              <span>
                {i.entity !== 'info' && <input type="checkbox" checked={interactive ? selected.has(i.id) : !isOff(i)} disabled={locked}
                  onChange={e => toggle(i.id, e.target.checked)} aria-label={t.rowAria(i.label, i.fieldLabel)} />}
              </span>
              <div className={styles.main}>
                {head && <span className={styles.lb} title={i.label}>{i.label}{groupNew && <span className={styles.badge}>{t.isNew}</span>}</span>}
                <Diff i={i} groupNew={groupNew} />
                {i.html && (
                  <details>
                    <summary>{t.compare}</summary>
                    <div className={styles.cmp}>
                      <div role="region" aria-label={t.before}>{i.html.before || <span className={styles.none}>{t.empty}</span>}</div>
                      <div role="region" aria-label={t.after}>{i.html.after}</div>
                    </div>
                  </details>
                )}
              </div>
              <span className={styles.st}>{r && (r.ok ? <span className={styles.ok} aria-label={t.appliedAria}>✓</span> : <span className={styles.bad} title={r.error}>✗ {r.error}</span>)}</span>
            </div>
          );
        })}
      </div>

      {!!cs.sample?.length && (
        <details className={styles.sample} open={!result}>
          <summary>{sampleSummary(cs.sample.length, cs.total ?? cs.sample.length, locale)}</summary>
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

      {!result && progress && progress.total > 5 && ( // bar only for larger sets: small ones just report the text
        <div className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label={t.progressAria}>
          <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
        </div>
      )}

      {cs.skipped?.length > 0 && (
        <details className={styles.skipped}>
          <summary>⚠ {t.skipped(cs.skipped.length)}</summary>
          <ul>{cs.skipped.map((x, k) => <li key={`${x.id}-${k}`}>{x.reason}</li>)}</ul>
        </details>
      )}

      {script && (
        <div className={styles.script} role="alert">
          <b>{t.script.title}</b>
          <span>{script.kinds.map(k => t.script.kinds[k]).join(' · ')}</span>
          <span>{script.hosts.length ? t.script.loads(script.hosts.join(', ')) : t.script.noHosts}</span>
          <small>{t.script.body}</small>
        </div>
      )}

      <div className={styles.foot}>
        {interactive && selectable && (
          <label htmlFor={allId}>
            <input id={allId} type="checkbox" checked={n === real.length} onChange={e => toggleAll(e.target.checked)} />
            {bulk ? <>{t.bulkSelected(fmt(bulkSel), fmt(cs.total!))}</> : <>{t.allBefore} <span>{n}</span> {t.allAfter}</>}{warns > 0 && <> · <span className={styles.wn}>{t.warnings(warns)}</span></>}
          </label>
        )}
        {interactive && <span className={styles.res}>{applyHint({ selectable, undoPlanned: undoPlannedFor(cs) }, locale)}</span>}
        {interactive && (
          <>
            <Button variant="primary" disabled={clickLocked || (selectable && (bulk ? !bulkSel : !n))} onClick={() => choose(true)}>
              {bulk ? t.changeRecords(fmt(bulkSel), plural(bulkSel, cs.noun?.one ?? t.record.one, cs.noun?.many ?? t.record.many)) : cs.applyLabel ? cs.applyLabel : cs.kind === 'new-products' ? t.createProducts(n) : selectable ? t.applyChanges(n) : t.publish}
            </Button>
            <Button disabled={clickLocked} onClick={() => choose(false)}>{t.reject}</Button>
          </>
        )}
        {res && <span className={styles.res} role="status">{res}</span>}
        {undoPartial && <span className={styles.res} role="status">{t.undoPartial(fmt(undoOk), fmt(undoTotal), undoTotal)}</span>}
        {!!undoTotal && (
          <Button disabled={undoPhase !== 'idle'} onClick={onUndo}>{undoPartial ? (undoOk ? t.undoRest : m.common.retry) : t.undo[undoPhase]}</Button>
        )}
      </div>
    </section>
  );
}
