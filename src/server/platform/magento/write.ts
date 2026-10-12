import 'server-only';
// Schreib-Bausteine (nur Executor, nach Freigabe): Store-View-genaues Schreiben mit exakten Rückgängig-Schritten und Undo-Ausführung.
// Magento speichert Texte je Ebene: global (Store „all“) oder je Store-View. Hat die View einen eigenen Wert, wird dort geschrieben,
// sonst global (gilt dann für alle Views ohne eigenen Wert). Rückgängig schreibt exakt die vorherigen Werte der Ebene zurück;
// null entfernt einen Wert der Ebene wieder („Standardwert verwenden“).
import type { UndoOp } from '@/lib/protocol';
import { applierRegistry } from '../appliers';
import { MagentoClient, MagentoError, skuPath } from './client';
import { attr, sameValue, writeBody, type MRecord } from './map';

export const reg = applierRegistry<MagentoClient>('magento');
export type Ent = 'product' | 'category';

const restPath = (e: Ent, ref: string, store: string) => `/${store}/V1/${e === 'product' ? `products/${skuPath(ref)}` : `categories/${Number(ref)}`}`;
const wrap = (e: Ent, ref: string, body: MRecord) => (e === 'product' ? { product: { sku: ref, ...body } } : { category: { id: Number(ref), ...body } });
export const getEnt = (c: MagentoClient, e: Ent, ref: string, store: string): Promise<MRecord | null> => c.req('GET', restPath(e, ref, store), undefined, { nullOn404: true });
/** PUT eines Produkts/einer Kategorie auf einer Ebene; extra = zusätzliche custom_attributes (z. B. save_rewrites_history) */
export async function putEnt(c: MagentoClient, e: Ent, ref: string, store: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<UndoOp['body']> {
  const body = wrap(e, ref, writeBody({ ...values, ...extra }));
  await c.req('PUT', restPath(e, ref, store), body);
  return body;
}
export const reqOp = (entity: string, id: string, method: string, path: string, body?: unknown): UndoOp => ({ op: 'req', entity, id, method, path, ...(body !== undefined ? { body } : {}) });
const undoPut = (e: Ent, ref: string, store: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}): UndoOp =>
  reqOp(e, ref, 'PUT', restPath(e, ref, store), wrap(e, ref, writeBody({ ...values, ...extra })));

/**
 * Werte in der Store-View `store` schreiben (scoped: eigener Wert der View → View, sonst global) plus globale Werte (global).
 * Prüft danach, ob die View den neuen Wert zeigt (eigener, zufällig gleicher Wert der View), und zieht ihn dort sonst nach.
 */
export async function writeScoped(c: MagentoClient, e: Ent, ref: string, store: string, scoped: Record<string, unknown>, global: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<UndoOp[]> {
  // Nicht die Haupt-Store-View (z. B. eine Sprach-View): Texte nur dort schreiben, nie global (sonst ändern sich alle Views)
  if (store !== 'all' && Object.keys(scoped).length && store !== await mainStoreCode(c)) {
    const undo = Object.keys(global).length || Object.keys(extra).length ? await writeScoped(c, e, ref, 'all', {}, global) : [];
    return [...undo, ...await writeStore(c, e, ref, store, scoped, extra)];
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
  if (Object.keys(allW).length) { await putEnt(c, e, ref, 'all', allW, extra); undo.push(undoPut(e, ref, 'all', allU, extra)); }
  if (Object.keys(stW).length) { await putEnt(c, e, ref, store, stW, extra); fixCategoryUndo(e, stU, glob); undo.push(undoPut(e, ref, store, stU, extra)); }
  const check = Object.keys(scoped).filter(k => k in allW);
  if (store !== 'all' && check.length) {
    const after = await getEnt(c, e, ref, store), fix: Record<string, unknown> = {}, fixU: Record<string, unknown> = {};
    for (const k of check) if (!sameValue(attr(after, k), allW[k])) { fix[k] = allW[k]; fixU[k] = attr(cur, k) ?? null; }
    if (Object.keys(fix).length) { await putEnt(c, e, ref, store, fix, extra); fixCategoryUndo(e, fixU, glob); undo.push(undoPut(e, ref, store, fixU, extra)); }
  }
  return undo;
}

/** Werte gezielt in einer Store-View schreiben (Übersetzungen). Rückgängig: vorheriger eigener Wert bzw. null (= wieder erben) */
export async function writeStore(c: MagentoClient, e: Ent, ref: string, store: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<UndoOp[]> {
  const [cur, glob] = await Promise.all([getEnt(c, e, ref, store), getEnt(c, e, ref, 'all')]);
  if (!cur || !glob) throw new MagentoError(`${e === 'product' ? 'Produkt' : 'Kategorie'} ${ref} nicht mehr vorhanden`, 404);
  const back: Record<string, unknown> = {};
  for (const k of Object.keys(values)) back[k] = sameValue(attr(cur, k), attr(glob, k)) ? null : attr(cur, k) ?? null; // gleich wie global = geerbt
  await putEnt(c, e, ref, store, values, extra);
  fixCategoryUndo(e, back, glob);
  return [undoPut(e, ref, store, back, extra)];
}

/**
 * Haupt-Store-View = Standard-View der Website, zu der die Store-View aus den Einstellungen gehört (Website → Standard-Gruppe →
 * Standard-View); deren geerbte Texte schreibt Lotse global. Eine „Standard-Website“ liefert die REST-API nicht.
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

/** Kategorien: „Standardwert verwenden“ lässt sich per REST für name/is_active nicht setzen (Magento verwirft null) – Rückgängig schreibt dann den globalen Wert */
const CATEGORY_NO_NULL = new Set(['name', 'is_active']);
function fixCategoryUndo(e: Ent, undo: Record<string, unknown>, glob: MRecord) {
  if (e !== 'category') return;
  for (const k of Object.keys(undo)) if (undo[k] === null && CATEGORY_NO_NULL.has(k)) undo[k] = attr(glob, k) ?? null;
}

const isDelete = (op: UndoOp) => op.op === 'delete' || (op.op === 'req' && (op.method ?? 'DELETE') === 'DELETE');
/** Rückgängig-Schritte in umgekehrter Reihenfolge; Löschen von schon Gelöschtem (404) gilt als erledigt */
export async function undoMagento(c: MagentoClient, ops: UndoOp[]): Promise<{ ok: boolean; error?: string }[]> {
  const out: { ok: boolean; error?: string }[] = [];
  for (const op of [...ops].reverse()) {
    try {
      if (op.op === 'req' || op.op === 'delete') {
        if (!op.path) throw new Error('Rückgängig-Schritt ohne Pfad');
        await c.req(op.op === 'delete' ? 'DELETE' : op.method ?? 'DELETE', op.path, op.body);
      } else throw new Error(`Rückgängig-Art ${op.op} wird für Magento nicht unterstützt`);
      out.push({ ok: true });
    } catch (e) { out.push(isDelete(op) && (e as { status?: number }).status === 404 ? { ok: true } : { ok: false, error: e instanceof Error ? e.message : String(e) }); }
  }
  return out;
}
