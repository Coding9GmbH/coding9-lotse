import 'server-only';
// Write building blocks (executor only, after approval): store-view-exact writing via PATCH {attributes} with exact undo steps.
// OpenMage stores attributes globally (store 0) or per store view. The API's store_overrides names the attributes with their own value in the
// view: if the view has its own value, Lotse writes there, otherwise globally (then applies to all views without their own value). In store
// views other than the main view, writing happens only there. Undo writes the level's previous values; null = "Use Default Value".
import type { UndoOp } from '@/lib/protocol';
import { applierRegistry } from '../appliers';
import { idPath, isGlobal, OmClient, OmError, skuPath } from './client';
import { globalEmpty, hasOverride, omAttr, same, type OmCategory, type OmProduct, type OmRecord } from './map';

export const reg = applierRegistry<OmClient>('openmage');
export type Ent = 'product' | 'category';

/** API path of an entity (products by SKU, categories by ID) */
export const entPath = (e: Ent, ref: string) => (e === 'product' ? `/v1/products/${skuPath(ref)}` : `/v1/categories/${Number(ref)}`);
/** Path with store query for stored undo steps ('admin' = global, without query) */
export const storePath = (path: string, store: string) => (isGlobal(store) ? path : `${path}${path.includes('?') ? '&' : '?'}store=${encodeURIComponent(store)}`);
export const reqOp = (entity: string, id: string, method: string, path: string, body?: unknown): UndoOp => ({ op: 'req', entity, id, method, path, ...(body !== undefined ? { body } : {}) });
/** Pass the error on and attach the already successful steps (a later PATCH must not swallow them). */
const failWithUndo = (e: unknown, undo: UndoOp[]): never => {
  const prev = (e as { undo?: UndoOp[] }).undo;
  const merged = !prev?.length || prev === undo ? undo : [...undo, ...prev];
  throw Object.assign(e instanceof Error ? e : new Error(String(e)), { undo: merged });
};

export const getEnt = (c: OmClient, e: Ent, ref: string, store: string): Promise<OmRecord | null> => c.req('GET', entPath(e, ref), undefined, { store, nullOn404: true });
export const getProduct = (c: OmClient, sku: string, store = 'admin'): Promise<OmProduct | null> => getEnt(c, 'product', sku, store) as Promise<OmProduct | null>;
export const getProductById = (c: OmClient, id: string | number, store = 'admin'): Promise<OmProduct | null> => c.req('GET', `/v1/products/${idPath(id)}`, undefined, { store, nullOn404: true });
export const getCategory = (c: OmClient, id: string, store = 'admin'): Promise<OmCategory | null> => getEnt(c, 'category', id, store) as Promise<OmCategory | null>;

/** PATCH {attributes} of one level; null is not allowed in the global scope (clear = ""). Returns the new state. */
export async function patchAttrs(c: OmClient, e: Ent, ref: string, store: string, values: Record<string, unknown>): Promise<OmRecord> {
  const attributes = isGlobal(store) ? Object.fromEntries(Object.entries(values).map(([k, v]) => [k, globalEmpty(v)])) : values;
  return c.req('PATCH', entPath(e, ref), { attributes }, { store });
}
const undoPatch = (e: Ent, ref: string, store: string, before: Record<string, unknown>, wrote: Record<string, unknown> = {}): UndoOp =>
  ({ ...reqOp(e, ref, 'PATCH', storePath(entPath(e, ref), store), { attributes: isGlobal(store) ? Object.fromEntries(Object.entries(before).map(([k, v]) => [k, globalEmpty(v)])) : before }), ...(Object.keys(wrote).length ? { wrote } : {}) });
/** 301 rewrites created after a url_key write ("Save Rewrites History"): delete on undo */
export const rewriteUndo = (res: OmRecord | null | undefined): UndoOp[] => ((res?._write?.rewrites_added ?? []) as number[]).map(id => reqOp('url-rewrite', String(id), 'DELETE', `/v1/urlrewrites/${Number(id)}`));

/**
 * Write values in store view `store` (scoped: view's own value → view, otherwise global) plus global values (global).
 * In a store view other than the main view, scoped values are written only there (undo: inherit again).
 * After a global write, checks whether the view shows the new value and otherwise applies it there as well.
 */
export async function writeScoped(c: OmClient, e: Ent, ref: string, store: string, scoped: Record<string, unknown>, global: Record<string, unknown> = {}): Promise<UndoOp[]> {
  const main = await c.mainStore();
  if (!isGlobal(store) && Object.keys(scoped).length && store !== main) {
    const undo = Object.keys(global).length ? await writeScoped(c, e, ref, 'admin', {}, global) : [];
    try { return [...undo, ...await writeStore(c, e, ref, store, scoped)]; }
    catch (e2) { return failWithUndo(e2, undo); }
  }
  const [cur, glob] = await Promise.all([isGlobal(store) ? null : getEnt(c, e, ref, store), getEnt(c, e, ref, 'admin')]);
  if (!glob || (!isGlobal(store) && !cur)) throw new OmError(`${e === 'product' ? 'Produkt' : 'Kategorie'} ${ref} nicht mehr vorhanden`, 404);
  const allW: Record<string, unknown> = { ...global }, allU: Record<string, unknown> = {}, stW: Record<string, unknown> = {}, stU: Record<string, unknown> = {};
  for (const k of Object.keys(global)) allU[k] = omAttr(glob, k) ?? null;
  for (const [k, v] of Object.entries(scoped)) {
    if (cur && hasOverride(cur, k)) { stW[k] = v; stU[k] = omAttr(cur, k) ?? null; }
    else { allW[k] = v; allU[k] = omAttr(glob, k) ?? null; }
  }
  const undo: UndoOp[] = [];
  try {
    if (Object.keys(allW).length) { const r = await patchAttrs(c, e, ref, 'admin', allW); undo.push(undoPatch(e, ref, 'admin', allU, allW), ...rewriteUndo(r)); }
    if (Object.keys(stW).length) { const r = await patchAttrs(c, e, ref, store, stW); undo.push(undoPatch(e, ref, store, stU, stW), ...rewriteUndo(r)); }
    // Written globally, but hidden in the store view by its own value (e.g. old special price)? Then set it there too
    const check = Object.keys(allW);
    if (cur && check.length) {
      const after = await getEnt(c, e, ref, store), fix: Record<string, unknown> = {}, fixU: Record<string, unknown> = {};
      for (const k of check) if (after && !same(omAttr(after, k), allW[k])) { fix[k] = allW[k]; fixU[k] = hasOverride(after, k) ? omAttr(after, k) ?? null : null; }
      if (Object.keys(fix).length) { const r = await patchAttrs(c, e, ref, store, fix); undo.push(undoPatch(e, ref, store, fixU, fix), ...rewriteUndo(r)); }
    }
    return undo;
  } catch (e2) { return failWithUndo(e2, undo); }
}

/** Write values specifically in one store view (translations). Undo: previous own value or null (= "Use Default Value" again) */
export async function writeStore(c: OmClient, e: Ent, ref: string, store: string, values: Record<string, unknown>): Promise<UndoOp[]> {
  const cur = await getEnt(c, e, ref, store);
  if (!cur) throw new OmError(`${e === 'product' ? 'Produkt' : 'Kategorie'} ${ref} nicht mehr vorhanden`, 404);
  const back: Record<string, unknown> = {};
  for (const k of Object.keys(values)) back[k] = hasOverride(cur, k) ? omAttr(cur, k) ?? null : null;
  const r = await patchAttrs(c, e, ref, store, values);
  return [undoPatch(e, ref, store, back, values), ...rewriteUndo(r)];
}

const isDelete = (op: UndoOp) => op.op === 'delete' || (op.op === 'req' && (op.method ?? 'DELETE') === 'DELETE');
const MOVED = 'Feld inzwischen geändert, Rückgängig übersprungen';
function valueMoved(c: OmClient, op: UndoOp): Promise<boolean> {
  if (!op.wrote || (op.method !== 'PUT' && op.method !== 'PATCH') || (op.entity !== 'product' && op.entity !== 'category')) return Promise.resolve(false);
  const store = new URLSearchParams((op.path ?? '').split('?')[1] ?? '').get('store') || 'admin';
  const before = (op.body as { attributes?: Record<string, unknown> } | undefined)?.attributes ?? {};
  return getEnt(c, op.entity, op.id, store).then(cur => !!cur && Object.keys(op.wrote!).some(k => !same(omAttr(cur, k), op.wrote![k]) && !same(omAttr(cur, k), before[k])));
}
/** Undo steps in reverse order; deleting something already deleted (404) counts as done */
export async function undoOpenmage(c: OmClient, ops: UndoOp[]): Promise<{ ok: boolean; error?: string }[]> {
  const out: { ok: boolean; error?: string }[] = [];
  for (const op of [...ops].reverse()) {
    try {
      if (await valueMoved(c, op)) { out.push({ ok: false, error: MOVED }); continue; }
      if (op.op === 'req' || op.op === 'delete') {
        if (!op.path) throw new Error('Rückgängig-Schritt ohne Pfad');
        const r = await c.req(op.op === 'delete' ? 'DELETE' : op.method ?? 'DELETE', op.path, op.body) as OmRecord | null;
        // A reverted url_key creates a redirect itself with "Save Rewrites History": undo leaves nothing new behind
        for (const id of (r?._write?.rewrites_added ?? []) as number[]) await c.req('DELETE', `/v1/urlrewrites/${Number(id)}`).catch(() => {});
      } else throw new Error(`Rückgängig-Art ${op.op} wird für OpenMage nicht unterstützt`);
      out.push({ ok: true });
    } catch (e) { out.push(isDelete(op) && (e as { status?: number }).status === 404 ? { ok: true } : { ok: false, error: e instanceof Error ? e.message : String(e) }); }
  }
  return out;
}
