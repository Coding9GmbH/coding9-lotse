import 'server-only';
// Magento: Varianten = konfigurierbare Produkte (configurable) mit einfachen Einzelprodukten je Ausprägung.
// Lesen: Achsen (Attribute) und Kinder. Anlegen: neues Einzelprodukt mit vorhandener Ausprägung + Verknüpfung; Rückgängig löscht es wieder.
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { errMsg, newIdSafe, partialTicker, pool, WRITE_CONCURRENCY, type ApplyResult } from './kit';
import { skuPath, type MagentoClient } from './client';
import { attr, attrStr, basisWord, money, needBasis, priceState, urlKey, type MProduct, type MRecord } from './map';
import type { MagentoReader } from './reader';
import { productLabel, stockSource } from './catalog';
import { sourceItemDelete } from './images';
import { reg, reqOp } from './write';

/** Achse: values = von Varianten genutzte Ausprägungen, options = alle Ausprägungen des Attributs (für neue Varianten) */
export interface Axis { attributeId: string; code: string; label: string; values: { id: string; label: string }[]; options: { id: string; label: string }[] }
/** Achsen eines konfigurierbaren Produkts mit Ausprägungen (Label aus den Attribut-Optionen) */
export async function variantAxes(ro: MagentoReader, sku: string): Promise<Axis[]> {
  const opts = await ro.configurableOptions(sku), out: Axis[] = [];
  for (const o of opts) {
    const a = (await ro.attributes({ filters: [[{ field: 'attribute_id', value: o.attribute_id }]], pageSize: 1 })).items[0];
    const labels = new Map(((a?.options ?? []) as { label: string; value: string }[]).map(x => [String(x.value), x.label]));
    out.push({ attributeId: String(o.attribute_id), code: String(a?.attribute_code ?? o.attribute_id), label: String(o.label ?? a?.default_frontend_label ?? ''), values: ((o.values ?? []) as { value_index: number }[]).map(v => ({ id: String(v.value_index), label: labels.get(String(v.value_index)) ?? String(v.value_index) })), options: [...labels].filter(([id]) => id !== '').map(([id, label]) => ({ id, label })) });
  }
  return out;
}

export async function readVariants(ro: MagentoReader, ref: string) {
  const p = await ro.productByRef(ref);
  if (!p) throw new Error('Produkt nicht gefunden');
  if (p.type_id !== 'configurable') return { id: String(p.id), sku: p.sku, name: p.name, type: p.type_id, note: 'Kein konfigurierbares Produkt (keine Varianten). Bei einem Einzelprodukt einer Variante die ID des Hauptprodukts verwenden.' };
  const [axes, kids] = await Promise.all([variantAxes(ro, p.sku), ro.configurableChildren(p.sku)]);
  const stock = await ro.sourceItems(kids.map(k => k.sku)).catch(() => []);
  const label = (code: string, v: unknown) => axes.find(a => a.code === code)?.values.find(x => x.id === String(v))?.label ?? String(v ?? '–');
  return {
    id: String(p.id), sku: p.sku, name: p.name, status: Number(p.status) === 1 ? 'aktiv' : 'inaktiv', priceBasis: basisWord(ro.priceBasis),
    axes: axes.map(a => ({ code: a.code, label: a.label, values: a.values.map(v => v.label), available: a.options.map(v => v.label).filter(l => !a.values.some(v => v.label === l)) })),
    variants: kids.map(k => { const s = priceState(k); return { id: String(k.id), sku: k.sku, name: k.name, options: Object.fromEntries(axes.map(a => [a.label || a.code, label(a.code, attr(k, a.code))])), price: money(s.selling), listPrice: s.list, active: Number(k.status) === 1, stock: stock.filter(x => x.sku === k.sku).reduce((n, x) => n + Number(x.quantity ?? 0), 0) }; }),
  };
}

export interface VariantArgs { title: string; reason: string; productId: string; add: { options: Record<string, string>; sku?: string; price?: number; stock?: number; active?: boolean; weight?: number }[] }
interface ChildPlan { parentSku: string; sku: string; name: string; attributeSetId: number; websiteIds: number[]; taxClassId: string | null; price: number; weight: number | null; active: boolean; stock: number; source: string | null; values: Record<string, string>; urlKey: string }

export async function buildVariantsChangeSet(ro: MagentoReader, a: VariantArgs): Promise<{ cs: ChangeSet; payload: null }> {
  const p = await ro.productByRef(a.productId);
  if (!p) throw new Error('Produkt nicht gefunden');
  if (p.type_id !== 'configurable') throw new Error('Nur für konfigurierbare Produkte (Hauptprodukt mit Varianten)');
  if (!a.add?.length) throw new Error('add ist leer');
  if (a.add.length > 50) throw new Error('Maximal 50 neue Varianten pro Änderungsset');
  const [axes, kids, stock] = await Promise.all([variantAxes(ro, p.sku), ro.configurableChildren(p.sku), stockSource(ro)]);
  const full = await ro.product(p.sku, 'all') as MProduct | null;
  const prices = [...new Set(kids.map(k => priceState(k).regular))];
  const taken = new Set((await ro.productsBySkus(a.add.map(x => x.sku ?? '').filter(Boolean))).map(x => x.sku));
  const combos = new Set(kids.map(k => axes.map(ax => String(attr(k, ax.code))).join('|')));
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [];
  for (const [i, x] of a.add.entries()) {
    const key = `var-${i + 1}`;
    try {
      const values: Record<string, string> = {}, labels: string[] = [];
      for (const ax of axes) {
        const want = Object.entries(x.options ?? {}).find(([k]) => k.toLowerCase() === ax.code.toLowerCase() || k.toLowerCase() === ax.label.toLowerCase())?.[1];
        if (want == null) throw new Error(`Ausprägung für „${ax.label || ax.code}“ fehlt`);
        const v = ax.options.find(o => o.label.toLowerCase() === String(want).trim().toLowerCase());
        if (!v) throw new Error(`„${want}“ ist keine Ausprägung von ${ax.label || ax.code} (vorhanden: ${ax.options.map(o => o.label).join(', ')}). Neue Ausprägungen bitte in Magento anlegen.`);
        values[ax.code] = v.id; labels.push(v.label);
      }
      const combo = axes.map(ax => values[ax.code]).join('|');
      if (combos.has(combo)) throw new Error(`Variante ${labels.join(' / ')} gibt es schon`);
      let price = x.price; const warn: string[] = [];
      if (price == null) { if (prices.length === 1 && prices[0] != null) { price = prices[0]; warn.push(`Preis wie die übrigen Varianten (${money(price)} ${basisWord(ro.priceBasis)})`); } else throw new Error('Preis fehlt (Varianten haben unterschiedliche Preise), beim Nutzer erfragen'); }
      if (!(price >= 0)) throw new Error('Preis ungültig');
      const basis = needBasis(ro.priceBasis);
      const sku = x.sku?.trim() || `${p.sku}-${labels.map(l => urlKey(l).toUpperCase()).join('-')}`;
      if (taken.has(sku) || kids.some(k => k.sku === sku)) throw new Error(`SKU ${sku} ist schon vergeben`);
      combos.add(combo); taken.add(sku);
      const stockN = Number.isInteger(x.stock) && x.stock! >= 0 ? x.stock! : 0;
      if ('reason' in stock && stockN > 0) warn.push(`Bestand nicht gesetzt: ${stock.reason}`);
      const name = `${p.name} ${labels.join(' ')}`;
      const plan: ChildPlan = { parentSku: p.sku, sku, name, attributeSetId: Number(p.attribute_set_id), websiteIds: (full?.extension_attributes?.website_ids as number[] | undefined) ?? [1], taxClassId: attrStr(full, 'tax_class_id'), price, weight: x.weight ?? (p.weight != null ? Number(p.weight) : null), active: x.active ?? Number(p.status) === 1, stock: stockN, source: 'source' in stock ? stock.source : null, values, urlKey: urlKey(`${name}-${sku}`) };
      items.push({ id: key, entity: 'product', label: `${name} (${sku})`, field: 'create', fieldLabel: 'Neue Variante', before: '–', after: `${labels.join(' / ')} · ${money(price)} ${basisWord(basis)} · Bestand ${stockN} · ${plan.active ? 'aktiv' : 'inaktiv'}`, afterRaw: plan, warn });
    } catch (e) { skipped.push({ id: key, reason: errMsg(e) }); }
  }
  if (!items.length) throw new Error(`Keine Variante anlegbar: ${skipped.map(s => s.reason).join('; ')}`);
  return { cs: { id: newIdSafe(), kind: 'variants', entity: 'product', noun: { one: 'Variante', many: 'Varianten' }, title: a.title, reason: a.reason, items: [...items, { id: 'info:parent', entity: 'info', label: productLabel(p), fieldLabel: '', before: '', after: `Hauptprodukt (Achsen: ${axes.map(ax => ax.label || ax.code).join(', ')})`, warn: [] }], skipped, atomic: false }, payload: null };
}

async function createChild(c: MagentoClient, x: ChildPlan): Promise<UndoOp[]> {
  const ca: MRecord[] = [...Object.entries(x.values).map(([attribute_code, value]) => ({ attribute_code, value })), { attribute_code: 'url_key', value: x.urlKey }, ...(x.taxClassId ? [{ attribute_code: 'tax_class_id', value: x.taxClassId }] : [])];
  await c.req('POST', '/V1/products', { product: { sku: x.sku, name: x.name, attribute_set_id: x.attributeSetId, price: x.price, status: x.active ? 1 : 2, visibility: 1, type_id: 'simple', ...(x.weight != null ? { weight: x.weight } : {}), extension_attributes: { website_ids: x.websiteIds }, custom_attributes: ca } }, { store: 'all' });
  const undo = [reqOp('product', x.sku, 'DELETE', `/all/V1/products/${skuPath(x.sku)}`)];
  try {
    await c.req('POST', `/V1/configurable-products/${skuPath(x.parentSku)}/child`, { childSku: x.sku }, { store: 'all' });
    if (x.source) { await c.req('POST', '/V1/inventory/source-items', { sourceItems: [{ sku: x.sku, source_code: x.source, quantity: x.stock, status: x.stock > 0 ? 1 : 0 }] }, { store: 'all' }); undo.unshift(sourceItemDelete(x.sku, x.source)); }
  } catch (e) { throw Object.assign(new Error(errMsg(e)), { undo }); }
  return undo;
}
reg.register('variants', async (c, cs, _p, selected, ctx) => {
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], list = cs.items.filter(i => selected.has(i.id) && i.entity !== 'info'), tick = partialTicker(ctx, list.length, { results, undo });
  await pool(list, WRITE_CONCURRENCY, async it => {
    try { undo.push(...await createChild(c, it.afterRaw as ChildPlan)); results.push({ itemId: it.id, ok: true }); }
    catch (e) { undo.push(...((e as { undo?: UndoOp[] }).undo ?? [])); results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
    finally { tick(); }
  });
  return { results, undo };
});
