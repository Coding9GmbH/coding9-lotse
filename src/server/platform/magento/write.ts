import 'server-only';
// Write building blocks (executor only, after approval): store-view-precise writes with exact undo steps and undo execution.
// Magento stores texts per scope: global (store "all") or per store view. If the view has its own value, it is written there,
// otherwise globally (then applies to all views without their own value). Undo writes back exactly the previous values of the scope;
// null removes a value from the scope again ("Standardwert verwenden", use default value).
import type { UndoOp } from '@/lib/protocol';
import { applierRegistry } from '../appliers';
import { MagentoClient, MagentoError, skuPath } from './client';
import { attr, sameValue, writeBody, type MRecord } from './map';

export const reg = applierRegistry<MagentoClient>('magento');
export type Ent = 'product' | 'category';

const restPath = (e: Ent, ref: string, store: string) => `/${store}/V1/${e === 'product' ? `products/${skuPath(ref)}` : `categories/${Number(ref)}`}`;
const wrap = (e: Ent, ref: string, body: MRecord) => (e === 'product' ? { product: { sku: ref, ...body } } : { category: { id: Number(ref), ...body } });
export const getEnt = (c: MagentoClient, e: Ent, ref: string, store: string): Promise<MRecord | null> => c.req('GET', restPath(e, ref, store), undefined, { nullOn404: true });
/** PUT of a product/category on one scope; extra = additional custom_attributes (e.g. save_rewrites_history) */
export async function putEnt(c: MagentoClient, e: Ent, ref: string, store: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<UndoOp['body']> {
  const body = wrap(e, ref, writeBody({ ...values, ...extra }));
  await c.req('PUT', restPath(e, ref, store), body);
  return body;
}
export const reqOp = (entity: string, id: string, method: string, path: string, body?: unknown): UndoOp => ({ op: 'req', entity, id, method, path, ...(body !== undefined ? { body } : {}) });
/** Pass the error on and attach steps that already succeeded (a later PUT must not swallow them). */
const failWithUndo = (e: unknown, undo: UndoOp[]): never => {
  const prev = (e as { undo?: UndoOp[] }).undo;
  const merged = !prev?.length || prev === undo ? undo : [...undo, ...prev];
  throw Object.assign(e instanceof Error ? e : new Error(String(e)), { undo: merged });
};
const undoPut = (e: Ent, ref: string, store: string, before: Record<string, unknown>, wrote: Record<string, unknown>, extra: Record<string, unknown> = {}): UndoOp =>
  ({ ...reqOp(e, ref, 'PUT', restPath(e, ref, store), wrap(e, ref, writeBody({ ...before, ...extra }))), ...(Object.keys(wrote).length ? { wrote } : {}) });

/**
 * Write values in store view `store` (scoped: view's own value → view, otherwise global) plus global values (global).
 * Then checks whether the view shows the new value (its own value that happens to be equal) and otherwise writes it there too.
 */
export async function writeScoped(c: MagentoClient, e: Ent, ref: string, store: string, scoped: Record<string, unknown>, global: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<UndoOp[]> {
  // Not the main store view (e.g. a language view): write texts only there, never globally (otherwise all views change)
  if (store !== 'all' && Object.keys(scoped).length && store !== await mainStoreCode(c)) {
    const undo = Object.keys(global).length || Object.keys(extra).length ? await writeScoped(c, e, ref, 'all', {}, global) : [];
    try { return [...undo, ...await writeStore(c, e, ref, store, scoped, extra)]; }
    catch (e2) { return failWithUndo(e2, undo); }
  }
  const [cur, glob] = await Promise.all([store === 'all' ? null : getEnt(c, e, ref, store), getEnt(c, e, ref, 'all')]);
  if (!glob || (store !== 'all' && !cur)) throw new MagentoError(`${e === 'product' ? 'Produkt' : 'Kategorie'} ${ref} nicht mehr vorhanden`, 404);
  const allW: Record<string, unknown> = { ...global }, allU: Record<string, unknown> = {}, stW: Record<string, unknown> = {}, stU: Record<string, unknown> = {};
  for (const k of Object.keys(global)) allU[k] = attr(glob, k) ?? null;
  for (const [k, v] of Object.entries(scoped)) {
    if (store !== 'all' && !sameValue(attr(cur, k), attr(glob, k))) { stW[k] = v; stU[k] = attr(cur, k) ?? null; }
    else { allW[k] = v; allU[k] = attr(glob, k) ?? null; }
  }
  const undo: UndoOp[] = [];
  try {
    if (Object.keys(allW).length) { await putEnt(c, e, ref, 'all', allW, extra); undo.push(undoPut(e, ref, 'all', allU, allW, extra)); }
    if (Object.keys(stW).length) { await putEnt(c, e, ref, store, stW, extra); fixCategoryUndo(e, stU, glob); undo.push(undoPut(e, ref, store, stU, stW, extra)); }
    const check = Object.keys(scoped).filter(k => k in allW);
    if (store !== 'all' && check.length) {
      const after = await getEnt(c, e, ref, store), fix: Record<string, unknown> = {}, fixU: Record<string, unknown> = {};
      for (const k of check) if (!sameValue(attr(after, k), allW[k])) { fix[k] = allW[k]; fixU[k] = attr(cur, k) ?? null; }
      if (Object.keys(fix).length) { await putEnt(c, e, ref, store, fix, extra); fixCategoryUndo(e, fixU, glob); undo.push(undoPut(e, ref, store, fixU, fix, extra)); }
    }
    return undo;
  } catch (e2) { return failWithUndo(e2, undo); }
}

/** Write values specifically in one store view (translations). Undo: previous own value or null (= inherit again) */
export async function writeStore(c: MagentoClient, e: Ent, ref: string, store: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<UndoOp[]> {
  const [cur, glob] = await Promise.all([getEnt(c, e, ref, store), getEnt(c, e, ref, 'all')]);
  if (!cur || !glob) throw new MagentoError(`${e === 'product' ? 'Produkt' : 'Kategorie'} ${ref} nicht mehr vorhanden`, 404);
  const back: Record<string, unknown> = {};
  for (const k of Object.keys(values)) back[k] = sameValue(attr(cur, k), attr(glob, k)) ? null : attr(cur, k) ?? null; // same as global = inherited
  await putEnt(c, e, ref, store, values, extra);
  fixCategoryUndo(e, back, glob);
  return [undoPut(e, ref, store, back, values, extra)];
}

/**
 * Main store view = default view of the website the configured store view belongs to (website → default group →
 * default view); Lotse writes its inherited texts globally. The REST API doesn't expose a "default website".
 */
const mainStore = new WeakMap<MagentoClient, Promise<string>>();
export const resetMainStore = (c: MagentoClient) => { mainStore.delete(c); };
export function mainStoreCode(c: MagentoClient): Promise<string> {
  if (!mainStore.has(c)) mainStore.set(c, (async () => {
    const [sites, groups, views] = await Promise.all([c.req('GET', '/V1/store/websites', undefined, { store: 'all' }), c.req('GET', '/V1/store/storeGroups', undefined, { store: 'all' }).catch(() => []), c.req('GET', '/V1/store/storeViews', undefined, { store: 'all' })]) as MRecord[][];
    const own = views.find(v => v.code === c.storeCode);
    const site = (own && sites.find(w => Number(w.id) === Number(own.website_id))) ?? sites.find(w => Number(w.id) > 0);
    const group = groups.find(g => Number(g.id) === Number(site?.default_group_id));
    return String(views.find(v => Number(v.id) === Number(group?.default_store_id))?.code ?? views.find(v => Number(v.id) > 0 && Number(v.website_id) === Number(site?.id))?.code ?? 'default');
  })().catch(() => { mainStore.delete(c); return 'default'; }));
  return mainStore.get(c)!;
}

/** Categories: "Standardwert verwenden" (use default value) can't be set via REST for name/is_active (Magento discards null), so undo writes the global value */
const CATEGORY_NO_NULL = new Set(['name', 'is_active']);
function fixCategoryUndo(e: Ent, undo: Record<string, unknown>, glob: MRecord) {
  if (e !== 'category') return;
  for (const k of Object.keys(undo)) if (undo[k] === null && CATEGORY_NO_NULL.has(k)) undo[k] = attr(glob, k) ?? null;
}

const isDelete = (op: UndoOp) => op.op === 'delete' || (op.op === 'req' && (op.method ?? 'DELETE') === 'DELETE');
const MOVED = 'Feld inzwischen geändert, Rückgängig übersprungen';
function valueMoved(c: MagentoClient, op: UndoOp): Promise<boolean> {
  if (!op.wrote || (op.method !== 'PUT' && op.method !== 'PATCH') || (op.entity !== 'product' && op.entity !== 'category')) return Promise.resolve(false);
  const store = /^\/([a-z][a-z0-9_]*)\/V1\//.exec(op.path ?? '')?.[1] ?? 'all';
  const body = op.body as { product?: MRecord; category?: MRecord } | undefined;
  const before = body?.product ?? body?.category;
  return getEnt(c, op.entity, op.id, store).then(cur => !!cur && Object.keys(op.wrote!).some(k => !sameValue(attr(cur, k), op.wrote![k]) && !sameValue(attr(cur, k), attr(before, k))));
}
/** Undo steps in reverse order; deleting something already deleted (404) counts as done */
export async function undoMagento(c: MagentoClient, ops: UndoOp[]): Promise<{ ok: boolean; error?: string }[]> {
  const out: { ok: boolean; error?: string }[] = [];
  for (const op of [...ops].reverse()) {
    try {
      if (await valueMoved(c, op)) { out.push({ ok: false, error: MOVED }); continue; }
      if (op.op === 'req' || op.op === 'delete') {
        if (!op.path) throw new Error('Rückgängig-Schritt ohne Pfad');
        await c.req(op.op === 'delete' ? 'DELETE' : op.method ?? 'DELETE', op.path, op.body);
      } else throw new Error(`Rückgängig-Art ${op.op} wird für Magento nicht unterstützt`);
      out.push({ ok: true });
    } catch (e) { out.push(isDelete(op) && (e as { status?: number }).status === 404 ? { ok: true } : { ok: false, error: e instanceof Error ? e.message : String(e) }); }
  }
  return out;
}
