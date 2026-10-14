import 'server-only';
// Produkt-Stammdaten: Executor (schreibt nur nach Freigabe, mit dem privilegierten Client) + exakte Rückgängig-Schritte.
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { assertFresh, errMsg, partialTicker, pool, registerApplier, WRITE_CONCURRENCY, type ApplyCtx, type ApplyResult } from '../changes';
import { newId, type Shopware, type SwEntity } from '../shopware';
import { cleanPrices, KIND_PRODUCT_DATA, snapshot, type ItemRaw, type NewEntity } from './product-data-plan';

export interface ProductDataPayload { creates: NewEntity[] }
const CREATE_ORDER: NewEntity['entity'][] = ['property-group', 'property-group-option', 'product-manufacturer', 'tag'];
export const APPLY_ASSOC = { properties: {}, categories: {}, tags: {}, visibilities: {}, prices: {}, crossSellings: { associations: { assignedProducts: {}, translations: {} } } };

/** Welche vorgemerkten Neuanlagen die ausgewählten Items brauchen (inkl. Gruppe einer neuen Option), in Anlage-Reihenfolge */
export function neededCreates(items: ChangeItem[], creates: NewEntity[]): NewEntity[] {
  const used = new Set(items.flatMap(i => (i.afterRaw as ItemRaw).uses ?? []));
  for (const c of creates) if (used.has(c.id) && c.needs) used.add(c.needs);
  return creates.filter(c => used.has(c.id)).sort((a, b) => CREATE_ORDER.indexOf(a.entity) - CREATE_ORDER.indexOf(b.entity));
}

const del = (entity: string, id: string): UndoOp => ({ op: 'delete', entity, id });
const patch = (entity: string, id: string, data: Record<string, unknown>): UndoOp => ({ op: 'patch', entity, id, data });

/** Undo-Daten zum Wiederanlegen eines gelöschten Cross-Sellings (gleiche IDs, Übersetzungen, Zuordnungen) */
export function crossRecreate(productId: string, c: SwEntity): Record<string, unknown> {
  const tr = (c.translations ?? []).filter((t: SwEntity) => t.name).map((t: SwEntity) => ({ languageId: t.languageId, name: t.name }));
  return {
    productId, type: c.type, position: c.position, active: c.active, limit: c.limit, sortBy: c.sortBy, sortDirection: c.sortDirection, productStreamId: c.productStreamId ?? null,
    ...(tr.length ? { translations: tr } : { name: c.name ?? c.translated?.name }),
    assignedProducts: (c.assignedProducts ?? []).map((a: SwEntity) => ({ id: a.id, productId: a.productId, position: a.position ?? 0 })),
  };
}

// Schreibt ein Item; Rückgängig-Schritte werden sofort nach jedem Schreibzugriff gesammelt (auch bei Teilfehlern vollständig)
export async function applyItem(swW: Shopware, cur: SwEntity, raw: ItemRaw, undo: UndoOp[]) {
  const pid = cur.id as string;
  switch (raw.kind) {
    case 'assoc': {
      const have = new Set((cur[raw.assoc] ?? []).map((x: SwEntity) => x.id));
      const add = raw.add.filter(id => !have.has(id)), rem = raw.remove.filter(id => have.has(id));
      if (add.length) {
        await swW.update('product', pid, { [raw.assoc]: add.map(id => ({ id })) });
        for (const id of add) undo.push({ op: 'req', entity: 'product', id: pid, method: 'DELETE', path: `/product/${pid}/${raw.assoc}/${id}` });
      }
      for (const id of rem) { await swW.req('DELETE', `/product/${pid}/${raw.assoc}/${id}`); undo.push(patch('product', pid, { [raw.assoc]: [{ id }] })); }
      return;
    }
    case 'scalar': {
      const old = Object.fromEntries(Object.keys(raw.data).map(k => [k, cur[k] ?? null]));
      await swW.update('product', pid, raw.data); undo.push(patch('product', pid, old));
      return;
    }
    case 'tax': {
      // Brutto bleibt, Netto neu: am Produkt, an erweiterten Preisen und an Varianten mit eigenem Preis, die den Steuersatz erben
      const retax = async (p: SwEntity, taxId?: string) => {
        const data: Record<string, unknown> = taxId ? { taxId } : {}, old: Record<string, unknown> = taxId ? { taxId: p.taxId ?? null } : {};
        if (p.price) { data.price = cleanPrices(p.price, raw.taxRate); old.price = cleanPrices(p.price); }
        if (p.prices?.length) { data.prices = p.prices.map((x: SwEntity) => ({ id: x.id, price: cleanPrices(x.price, raw.taxRate) })); old.prices = p.prices.map((x: SwEntity) => ({ id: x.id, price: cleanPrices(x.price) })); }
        if (!Object.keys(data).length) return;
        await swW.update('product', p.id, data); undo.push(patch('product', p.id, old));
      };
      await retax(cur, raw.taxId);
      for (let page = 1; ; page++) { // alle Varianten, seitenweise
        const kids = (await swW.search('product', { limit: 500, page, filter: [{ type: 'equals', field: 'parentId', value: pid }, { type: 'equals', field: 'taxId', value: null }], associations: { prices: {} }, includes: { product: ['id', 'price', 'prices', 'taxId'] } })).data;
        for (const k of kids) await retax(k);
        if (kids.length < 500) break;
      }
      return;
    }
    case 'visibility': {
      const curVis: SwEntity[] = cur.visibilities ?? [];
      for (const a of raw.add) {
        const ex = curVis.find(v => v.salesChannelId === a.salesChannelId);
        if (ex) { if (ex.visibility !== a.visibility) { await swW.update('product-visibility', ex.id, { visibility: a.visibility }); undo.push(patch('product-visibility', ex.id, { visibility: ex.visibility })); } continue; }
        const id = newId();
        await swW.create('product-visibility', { id, productId: pid, salesChannelId: a.salesChannelId, visibility: a.visibility }); undo.push(del('product-visibility', id));
      }
      for (const sc of raw.remove) {
        const ex = curVis.find(v => v.salesChannelId === sc); if (!ex) continue;
        await swW.req('DELETE', `/product-visibility/${ex.id}`);
        undo.push({ op: 'create', entity: 'product-visibility', id: ex.id, data: { productId: pid, salesChannelId: sc, visibility: ex.visibility } });
      }
      return;
    }
    case 'cross': {
      if (raw.action === 'create') {
        await swW.create('product-cross-selling', { id: raw.id, ...raw.data, assignedProducts: raw.productIds.map((productId, position) => ({ id: newId(), productId, position })) });
        undo.push(del('product-cross-selling', raw.id));
        return;
      }
      const c = (cur.crossSellings ?? []).find((x: SwEntity) => x.id === raw.id);
      if (!c) throw new Error('Cross-Selling ist nicht mehr vorhanden');
      if (raw.action === 'delete') {
        await swW.req('DELETE', `/product-cross-selling/${c.id}`);
        undo.push({ op: 'create', entity: 'product-cross-selling', id: c.id, data: crossRecreate(pid, c) });
        return;
      }
      const curA: SwEntity[] = c.assignedProducts ?? [];
      const old: Record<string, unknown> = Object.fromEntries(Object.keys(raw.set).map(k => [k, k === 'name' ? (c.name ?? c.translated?.name) : (c[k] ?? null)]));
      const data: Record<string, unknown> = { ...raw.set };
      if (raw.productIds) {
        const target = raw.productIds;
        for (const a of curA.filter(a => !target.includes(a.productId))) {
          await swW.req('DELETE', `/product-cross-selling-assigned-products/${a.id}`);
          undo.push({ op: 'create', entity: 'product-cross-selling-assigned-products', id: a.id, data: { crossSellingId: c.id, productId: a.productId, position: a.position ?? 0 } });
        }
        const assigned: Record<string, unknown>[] = [], keptOld: Record<string, unknown>[] = [], created: string[] = [];
        target.forEach((productId, position) => {
          const ex = curA.find(a => a.productId === productId);
          if (ex) { if (ex.position !== position) { assigned.push({ id: ex.id, position }); keptOld.push({ id: ex.id, position: ex.position ?? 0 }); } }
          else { const id = newId(); assigned.push({ id, productId, position }); created.push(id); }
        });
        if (assigned.length) data.assignedProducts = assigned;
        if (keptOld.length) old.assignedProducts = keptOld;
        if (!Object.keys(data).length) return;
        await swW.update('product-cross-selling', c.id, data);
        if (Object.keys(old).length) undo.push(patch('product-cross-selling', c.id, old));
        for (const id of created) undo.push(del('product-cross-selling-assigned-products', id));
        return;
      }
      if (!Object.keys(data).length) return;
      await swW.update('product-cross-selling', c.id, data); undo.push(patch('product-cross-selling', c.id, old));
      return;
    }
  }
}

export async function applyProductData(swW: Shopware, cs: ChangeSet, payload: ProductDataPayload, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const items = cs.items.filter(i => selected.has(i.id) && i.entity !== 'info');
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], tick = partialTicker(ctx, items.length, { results, undo });
  // 1) Gemeinsame Neuanlagen (Eigenschaften, Hersteller, Tags), nur was ausgewählte Items brauchen
  for (const c of neededCreates(items, payload?.creates ?? [])) {
    try { await swW.create(c.entity, { id: c.id, ...c.data }); undo.push(del(c.entity, c.id)); tick(); }
    catch (e) { return { results, undo, error: `${c.label} konnte nicht angelegt werden: ${errMsg(e)}` }; }
  }
  // 2) Je Produkt: frischer Stand, Items nacheinander (Produkte schonend parallel)
  const groups = new Map<string, ChangeItem[]>();
  for (const it of items) groups.set(it.entityId!, [...(groups.get(it.entityId!) ?? []), it]);
  await pool([...groups], WRITE_CONCURRENCY, async ([pid, its]) => {
    let cur: SwEntity | null = null;
    try { cur = await swW.get('product', pid, { associations: APPLY_ASSOC }); } catch (e) { its.forEach(i => results.push({ itemId: i.id, ok: false, error: errMsg(e) })); tick(); return; }
    if (!cur) { its.forEach(i => results.push({ itemId: i.id, ok: false, error: 'Produkt nicht mehr vorhanden' })); tick(); return; }
    for (const it of its) {
      const u: UndoOp[] = [], raw = it.afterRaw as ItemRaw;
      // inzwischen geändert (anderer Chat, Admin): dieses Item nicht schreiben, die übrigen laufen weiter
      try { assertFresh(it.fieldLabel, snapshot(cur, raw), it.beforeRaw); await applyItem(swW, cur, raw, u); results.push({ itemId: it.id, ok: true }); }
      catch (e) { results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
      undo.push(...u); tick();
    }
  });
  return { results, undo };
}

registerApplier(KIND_PRODUCT_DATA, (swW, cs, payload, selected, ctx) => applyProductData(swW, cs, payload as ProductDataPayload, selected, ctx));
