import 'server-only';
// Schreib-Bausteine (nur Executor, nach Freigabe): Store-View-genaues Schreiben über PATCH {attributes} mit exakten Rückgängig-Schritten.
// OpenMage speichert Attribute global (Store 0) oder je Store-View. store_overrides der API nennt die Attribute mit eigenem Wert in der
// View: Hat die View einen eigenen Wert, schreibt Lotse dort, sonst global (gilt dann für alle Views ohne eigenen Wert). In anderen
// Store-Views als der Haupt-View wird nur dort geschrieben. Rückgängig schreibt die Vorher-Werte der Ebene; null = „Standardwert verwenden“.
import type { UndoOp } from '@/lib/protocol';
import { applierRegistry } from '../appliers';
import { idPath, isGlobal, OmClient, OmError, skuPath } from './client';
import { globalEmpty, hasOverride, omAttr, same, type OmCategory, type OmProduct, type OmRecord } from './map';

export const reg = applierRegistry<OmClient>('openmage');
export type Ent = 'product' | 'category';

/** API-Pfad einer Entität (Produkte per SKU, Kategorien per ID) */
export const entPath = (e: Ent, ref: string) => (e === 'product' ? `/v1/products/${skuPath(ref)}` : `/v1/categories/${Number(ref)}`);
/** Pfad mit Store-Query für gespeicherte Rückgängig-Schritte ('admin' = global, ohne Query) */
export const storePath = (path: string, store: string) => (isGlobal(store) ? path : `${path}${path.includes('?') ? '&' : '?'}store=${encodeURIComponent(store)}`);
export const reqOp = (entity: string, id: string, method: string, path: string, body?: unknown): UndoOp => ({ op: 'req', entity, id, method, path, ...(body !== undefined ? { body } : {}) });
/** Fehler weiterreichen und schon erfolgreiche Schritte dranhängen (ein späterer PATCH darf sie nicht verschlucken). */
const failWithUndo = (e: unknown, undo: UndoOp[]): never => {
  const prev = (e as { undo?: UndoOp[] }).undo;
  const merged = !prev?.length || prev === undo ? undo : [...undo, ...prev];
  throw Object.assign(e instanceof Error ? e : new Error(String(e)), { undo: merged });
};

export const getEnt = (c: OmClient, e: Ent, ref: string, store: string): Promise<OmRecord | null> => c.req('GET', entPath(e, ref), undefined, { store, nullOn404: true });
export const getProduct = (c: OmClient, sku: string, store = 'admin'): Promise<OmProduct | null> => getEnt(c, 'product', sku, store) as Promise<OmProduct | null>;
export const getProductById = (c: OmClient, id: string | number, store = 'admin'): Promise<OmProduct | null> => c.req('GET', `/v1/products/${idPath(id)}`, undefined, { store, nullOn404: true });
export const getCategory = (c: OmClient, id: string, store = 'admin'): Promise<OmCategory | null> => getEnt(c, 'category', id, store) as Promise<OmCategory | null>;

/** PATCH {attributes} einer Ebene; im globalen Scope ist null nicht erlaubt (leeren = ""). Liefert den neuen Stand. */
export async function patchAttrs(c: OmClient, e: Ent, ref: string, store: string, values: Record<string, unknown>): Promise<OmRecord> {
  const attributes = isGlobal(store) ? Object.fromEntries(Object.entries(values).map(([k, v]) => [k, globalEmpty(v)])) : values;
  return c.req('PATCH', entPath(e, ref), { attributes }, { store });
}
const undoPatch = (e: Ent, ref: string, store: string, before: Record<string, unknown>, wrote: Record<string, unknown> = {}): UndoOp =>
  ({ ...reqOp(e, ref, 'PATCH', storePath(entPath(e, ref), store), { attributes: isGlobal(store) ? Object.fromEntries(Object.entries(before).map(([k, v]) => [k, globalEmpty(v)])) : before }), ...(Object.keys(wrote).length ? { wrote } : {}) });
/** Nach einem url_key-Schreiben angelegte 301-Rewrites („Save Rewrites History“): beim Rückgängig löschen */
export const rewriteUndo = (res: OmRecord | null | undefined): UndoOp[] => ((res?._write?.rewrites_added ?? []) as number[]).map(id => reqOp('url-rewrite', String(id), 'DELETE', `/v1/urlrewrites/${Number(id)}`));

/**
 * Werte in der Store-View `store` schreiben (scoped: eigener Wert der View → View, sonst global) plus globale Werte (global).
 * In einer anderen Store-View als der Haupt-View werden scoped-Werte nur dort geschrieben (Rückgängig: wieder erben).
 * Prüft nach einem globalen Schreiben, ob die View den neuen Wert zeigt, und zieht ihn dort sonst nach.
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
    // Global geschrieben, aber in der Store-View durch einen eigenen Wert verdeckt (z. B. alter Sonderpreis)? Dann auch dort setzen
    const check = Object.keys(allW);
    if (cur && check.length) {
      const after = await getEnt(c, e, ref, store), fix: Record<string, unknown> = {}, fixU: Record<string, unknown> = {};
      for (const k of check) if (after && !same(omAttr(after, k), allW[k])) { fix[k] = allW[k]; fixU[k] = hasOverride(after, k) ? omAttr(after, k) ?? null : null; }
      if (Object.keys(fix).length) { const r = await patchAttrs(c, e, ref, store, fix); undo.push(undoPatch(e, ref, store, fixU, fix), ...rewriteUndo(r)); }
    }
    return undo;
  } catch (e2) { return failWithUndo(e2, undo); }
}

/** Werte gezielt in einer Store-View schreiben (Übersetzungen). Rückgängig: vorheriger eigener Wert bzw. null (= wieder „Standardwert verwenden“) */
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
/** Rückgängig-Schritte in umgekehrter Reihenfolge; Löschen von schon Gelöschtem (404) gilt als erledigt */
export async function undoOpenmage(c: OmClient, ops: UndoOp[]): Promise<{ ok: boolean; error?: string }[]> {
  const out: { ok: boolean; error?: string }[] = [];
  for (const op of [...ops].reverse()) {
    try {
      if (await valueMoved(c, op)) { out.push({ ok: false, error: MOVED }); continue; }
      if (op.op === 'req' || op.op === 'delete') {
        if (!op.path) throw new Error('Rückgängig-Schritt ohne Pfad');
        const r = await c.req(op.op === 'delete' ? 'DELETE' : op.method ?? 'DELETE', op.path, op.body) as OmRecord | null;
        // Ein zurückgesetzter url_key legt mit „Save Rewrites History“ selbst eine Weiterleitung an: Rückgängig lässt nichts Neues zurück
        for (const id of (r?._write?.rewrites_added ?? []) as number[]) await c.req('DELETE', `/v1/urlrewrites/${Number(id)}`).catch(() => {});
      } else throw new Error(`Rückgängig-Art ${op.op} wird für OpenMage nicht unterstützt`);
      out.push({ ok: true });
    } catch (e) { out.push(isDelete(op) && (e as { status?: number }).status === 404 ? { ok: true } : { ok: false, error: e instanceof Error ? e.message : String(e) }); }
  }
  return out;
}
