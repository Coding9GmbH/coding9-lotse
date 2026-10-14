import 'server-only';
// Shared executor helpers for the Magento and OpenMage catalog change sets (field validation, stale check, grouped apply).
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { assertFresh } from '../../changes';
import { errMsg, partialTicker, pool, WRITE_CONCURRENCY, type ApplyCtx, type ApplyResult } from './kit';
import { VISIBILITY_IN } from './map';

export type Kind = 'str' | 'html' | 'price' | 'date' | 'int' | 'bool' | 'visibility' | 'num';
export interface FieldDef { label: string; kind: Kind; attr?: string }
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validate(def: FieldDef, v: unknown): unknown {
  switch (def.kind) {
    case 'str': case 'html': if (typeof v !== 'string') throw new Error(`${def.label}: Text erwartet`); if (def.kind === 'str' && v.length > 255) throw new Error(`${def.label}: max. 255 Zeichen`); if (def.attr === 'name' && !v.trim()) throw new Error('Name darf nicht leer sein'); return v;
    case 'int': if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`${def.label}: ganze Zahl ≥ 0 erwartet`); return v;
    case 'num': if (typeof v !== 'number' || !(v >= 0)) throw new Error(`${def.label}: Zahl ≥ 0 erwartet`); return v;
    case 'bool': if (typeof v !== 'boolean') throw new Error(`${def.label}: true/false erwartet`); return v;
    case 'visibility': { const n = typeof v === 'number' ? v : VISIBILITY_IN[String(v)]; if (![1, 2, 3, 4].includes(n)) throw new Error('Sichtbarkeit: none, catalog, search oder both'); return n; }
    case 'date': if (v !== null && !(typeof v === 'string' && DATE_RE.test(v))) throw new Error(`${def.label}: Datum JJJJ-MM-TT oder null`); return v;
  }
  return v;
}

export type ApplyPiece = { undo: UndoOp[]; failed?: { id: string; error: string }[] };

/** Fresh attribute value. Price and stock have their own checks (price format, stock source). Without beforeRaw no check. */
export function splitStale(its: ChangeItem[], freshOf: (it: ChangeItem) => unknown): { live: ChangeItem[]; failed: { id: string; error: string }[] } {
  const live: ChangeItem[] = [], failed: { id: string; error: string }[] = [];
  for (const it of its) {
    if (it.beforeRaw === undefined || !it.field || it.field === 'price' || it.field === 'stock') { live.push(it); continue; }
    try { assertFresh(it.fieldLabel, freshOf(it), it.beforeRaw); live.push(it); }
    catch (e) { failed.push({ id: it.id, error: errMsg(e) }); }
  }
  return { live, failed };
}
export const withFailed = (e: unknown, undo: UndoOp[], failed: { id: string; error: string }[]): never => {
  const prev = (e as { undo?: UndoOp[] }).undo;
  throw Object.assign(e instanceof Error ? e : new Error(String(e)), { undo: !prev?.length || prev === undo ? undo : [...undo, ...prev], ...(failed.length ? { failed } : {}) });
};

/** Groups the rows per record. Stale fields (failed) apply only to their row, the rest is written. */
export async function applyGrouped(cs: ChangeSet, selected: Set<string>, fn: (id: string, its: ChangeItem[]) => Promise<UndoOp[] | ApplyPiece>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const groups = new Map<string, ChangeItem[]>();
  let n = 0;
  for (const it of cs.items) if (selected.has(it.id) && it.entity !== 'info') { groups.set(it.entityId ?? '', [...(groups.get(it.entityId ?? '') ?? []), it]); n++; }
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], tick = partialTicker(ctx, n, { results, undo });
  const mark = (its: ChangeItem[], failed: { id: string; error: string }[] | undefined, okIds: string[] | undefined, msg: string) => {
    const bad = new Map((failed ?? []).map(f => [f.id, f.error]));
    its.forEach(i => {
      if (okIds?.includes(i.id)) results.push({ itemId: i.id, ok: true });
      else if (bad.has(i.id)) results.push({ itemId: i.id, ok: false, error: bad.get(i.id) });
      else results.push({ itemId: i.id, ok: !msg, ...(msg ? { error: msg } : {}) });
    });
  };
  await pool([...groups], WRITE_CONCURRENCY, async ([id, its]) => {
    try {
      const out = await fn(id, its);
      if (Array.isArray(out)) { undo.push(...out); its.forEach(i => results.push({ itemId: i.id, ok: true })); }
      else { undo.push(...out.undo); mark(its, out.failed, undefined, ''); }
    } catch (e) {
      const extra = (e as { undo?: UndoOp[] }).undo ?? [], okIds = (e as { okIds?: string[] }).okIds, msg = errMsg(e);
      undo.push(...extra); // partially written: keep the undo steps; okIds = rows already written
      mark(its, (e as { failed?: { id: string; error: string }[] }).failed, okIds, msg);
    }
    finally { tick(); }
  });
  return { results, undo };
}
