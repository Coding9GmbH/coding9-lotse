import 'server-only';
// Hersteller (Marken): Details lesen sowie anlegen und bearbeiten (Name, Beschreibung, Link, Logo) als Änderungsset mit Freigabe und Rückgängig.
// Produkt-Zuordnungen laufen weiter über propose_product_data (manufacturer).
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { applyEach, assertFresh, cut, MAX_ITEMS, registerApplier } from '../changes';
import { HEX32, newId, type ShopReader, type SwEntity } from '../shopware';
import { fail, guard, ok, type AnyTool } from '../tool-kit';
import type { Session } from '../sessions';
import type { Feature } from './types';

export const KIND_HERSTELLER = 'manufacturers';
const ENTITY = 'product-manufacturer';
const NOUN = { one: 'Hersteller', many: 'Hersteller' };
export const MANUFACTURER_TOOLS = ['get_manufacturer', 'propose_manufacturer_changes'];

export interface ManufacturerIn { name?: string; description?: string | null; link?: string | null; mediaId?: string | null }
export interface ManufacturerArgs { title: string; reason: string; create?: (ManufacturerIn & { name: string })[]; update?: (ManufacturerIn & { id: string })[] }
type FieldKey = 'name' | 'description' | 'link' | 'mediaId';
const FIELDS: Record<FieldKey, { label: string; html?: boolean }> = { name: { label: 'Name' }, description: { label: 'Beschreibung', html: true }, link: { label: 'Webseite' }, mediaId: { label: 'Logo' } };
const KEYS = Object.keys(FIELDS) as FieldKey[];

/** Aktueller Wert eines Feldes (übersetzte Texte in der Standardsprache); leer = null */
const valueOf = (m: SwEntity, f: FieldKey): string | null => { const v = f === 'name' || f === 'description' ? (m.translated?.[f] ?? m[f]) : m[f]; return v === undefined || v === '' ? null : (v as string | null); };
const nameOf = (m: SwEntity) => String(m.translated?.name ?? m.name ?? m.id);
const same = (a: unknown, b: unknown) => String(a ?? '').trim() === String(b ?? '').trim();

/** Link muss eine http(s)-Adresse sein; leer/null = entfernen */
export function cleanLink(v: string): string {
  const s = v.trim();
  if (!/^https?:\/\/[^\s/]+\.[^\s/]{2,}/i.test(s)) throw new Error(`Link „${v}“ ungültig: vollständige Adresse mit https:// angeben.`);
  return s;
}

export async function buildManufacturerChangeSet(ro: ShopReader, a: ManufacturerArgs): Promise<{ cs: ChangeSet; payload: null }> {
  const create = a.create ?? [], update = a.update ?? [];
  if (!create.length && !update.length) throw new Error('Weder create noch update angegeben.');
  if (create.length + update.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Hersteller pro Änderungsset. Bitte aufteilen.`);
  const items: ChangeItem[] = [], skipped: ChangeSet['skipped'] = [];
  const mediaOf = async (id: string) => { if (!HEX32.test(id)) throw new Error(`mediaId „${id}“ ungültig (search_media/import_image liefert die ID).`); const m = await ro.get('media', id); if (!m) throw new Error(`Medium ${id} nicht gefunden.`); return m; };

  // vorhandene Namen (Groß-/Kleinschreibung egal), damit nichts doppelt angelegt wird
  const names = [...new Set(create.map(c => c.name.trim()).filter(Boolean))];
  const existing = names.length ? (await ro.search(ENTITY, { limit: 500, filter: [{ type: 'equalsAny', field: 'name', value: names }] })).data : [];
  const seen = new Set<string>();
  for (const c of create) {
    const name = c.name.trim(), key = name.toLowerCase();
    if (!name) { skipped.push({ id: '(ohne Name)', reason: 'Name fehlt' }); continue; }
    const dup = existing.find(e => nameOf(e).toLowerCase() === key);
    if (dup) { skipped.push({ id: name, reason: `gibt es schon (${dup.id}); mit update ändern oder per ID verwenden` }); continue; }
    if (seen.has(key)) { skipped.push({ id: name, reason: 'im selben Set doppelt' }); continue; }
    seen.add(key);
    const data: Record<string, unknown> = { name };
    if (c.description) data.description = c.description;
    if (c.link) data.link = cleanLink(c.link);
    if (c.mediaId) { await mediaOf(c.mediaId); data.mediaId = c.mediaId; }
    const id = newId(), parts = [c.description ? 'Beschreibung' : null, c.link ? `Webseite ${data.link}` : null, c.mediaId ? 'Logo' : null].filter(Boolean);
    items.push({ id: `new:${id}`, entity: ENTITY, entityId: id, label: `Hersteller „${name}“`, fieldLabel: 'Neu anlegen', before: '–', after: parts.length ? `Neu mit ${parts.join(', ')}` : 'Neu', afterRaw: { create: data }, warn: [] });
  }

  const ids = [...new Set(update.map(u => u.id))];
  const rows = ids.length ? (await ro.search(ENTITY, { ids, limit: ids.length })).data : [];
  for (const u of update) {
    const m = rows.find(r => r.id === u.id);
    if (!m) { skipped.push({ id: u.id, reason: 'Hersteller nicht gefunden' }); continue; }
    const label = `Hersteller „${nameOf(m)}“`;
    let any = false;
    for (const f of KEYS) {
      if (!(f in u) || u[f] === undefined) continue;
      let next: string | null = u[f] === null ? null : String(u[f]).trim();
      if (next === '') next = null;
      if (f === 'name' && !next) throw new Error(`${label}: Name darf nicht leer sein.`);
      if (f === 'link' && next) next = cleanLink(next);
      if (f === 'mediaId' && next) await mediaOf(next);
      const before = valueOf(m, f);
      if (same(before, next)) continue;
      const warn: string[] = [];
      if (f === 'name' && next) { const clash = (await ro.search(ENTITY, { limit: 1, filter: [{ type: 'equals', field: 'name', value: next }] })).data[0]; if (clash && clash.id !== m.id) warn.push(`Es gibt schon einen Hersteller „${next}“ (${clash.id}).`); }
      items.push({ id: `${m.id}:${f}`, entity: ENTITY, entityId: m.id, label, field: f, fieldLabel: FIELDS[f].label, before: f === 'mediaId' ? (before ? 'Logo gesetzt' : '–') : cut(before), after: f === 'mediaId' ? (next ? 'Neues Logo' : 'Logo entfernen') : cut(next),
        afterRaw: next, beforeRaw: before, ...(FIELDS[f].html ? { html: { before: before ?? '', after: next ?? '' } } : {}), warn });
      any = true;
    }
    if (!any) skipped.push({ id: nameOf(m), reason: 'keine Änderung' });
  }
  if (!items.length) throw new Error(`Nichts zu ändern: ${skipped.map(s => `${s.id}: ${s.reason}`).join('; ') || 'keine Änderungen'}`);
  const n = new Set(items.map(i => i.entityId)).size;
  return { cs: { id: newId(), kind: KIND_HERSTELLER, entity: ENTITY, noun: NOUN, applyLabel: `${n} Hersteller übernehmen`, title: a.title, reason: a.reason ?? null, items, skipped, atomic: false }, payload: null };
}

registerApplier(KIND_HERSTELLER, (swW, cs, _payload, selected, ctx) => applyEach(cs, selected, async (it): Promise<UndoOp> => {
  const raw = it.afterRaw as { create: Record<string, unknown> } | string | null;
  if (raw && typeof raw === 'object' && 'create' in raw) {
    await swW.create(ENTITY, { id: it.entityId, ...raw.create });
    return { op: 'delete', entity: ENTITY, id: it.entityId! };
  }
  const field = it.field as FieldKey, cur = await swW.get(ENTITY, it.entityId!);
  if (!cur) throw new Error('Hersteller nicht mehr vorhanden');
  assertFresh(it.fieldLabel, valueOf(cur, field), it.beforeRaw ?? null); // inzwischen anders geändert: nicht überschreiben
  await swW.update(ENTITY, it.entityId!, { [field]: raw });
  return { op: 'patch', entity: ENTITY, id: it.entityId!, data: { [field]: (it.beforeRaw as string | null) ?? null } };
}, ctx));

function tools(session: Session): AnyTool[] {
  const { sw } = session;
  const media = (id: unknown) => (typeof id === 'string' && id ? id : null);
  return [
    tool('get_manufacturer', 'Einen Hersteller LESEN (per id oder Name): Name, Beschreibung, Webseite, Logo und Anzahl zugeordneter Produkte. Ändert nichts. Die Liste aller Hersteller liefert list_manufacturers.',
      { id: z.string().optional(), name: z.string().optional().describe('Name (ohne Beachtung der Groß-/Kleinschreibung)') },
      guard(async a => {
        if (!a.id && !a.name) return fail('id oder name angeben');
        const m = a.id ? (await sw.search(ENTITY, { ids: [a.id], limit: 1, associations: { media: {} } })).data[0]
          : (await sw.search(ENTITY, { limit: 5, filter: [{ type: 'contains', field: 'name', value: a.name!.trim() }], associations: { media: {} } })).data.find(x => nameOf(x).toLowerCase() === a.name!.trim().toLowerCase());
        if (!m) return fail('Hersteller nicht gefunden: mit list_manufacturers suchen, oder per propose_manufacturer_changes (create) anlegen.');
        const products = (await sw.search('product', { limit: 1, 'total-count-mode': 1, filter: [{ type: 'equals', field: 'manufacturerId', value: m.id }] })).total;
        return ok({ id: m.id, name: nameOf(m), description: valueOf(m, 'description'), link: valueOf(m, 'link'), logo: m.media ? { mediaId: m.mediaId ?? m.media.id, url: media(m.media.url) } : null, products });
      })),

    tool('propose_manufacturer_changes', `SCHLÄGT vor, Hersteller (Marken) ANZULEGEN (create) und/oder zu ÄNDERN (update): Name, Beschreibung (HTML), Webseite (Link), Logo (mediaId aus search_media/import_image). Es wird NICHTS geschrieben: Der Nutzer sieht einen Alt→Neu-Vergleich, wählt aus und gibt frei; erst dann schreibt der Server (mit Rückgängig). Der Aufruf kehrt erst nach der Entscheidung zurück. Höchstens ${MAX_ITEMS} Hersteller je Aufruf.
create: neue Hersteller (Name Pflicht; vorhandene Namen werden übersprungen). update: bestehende per id; null entfernt Beschreibung, Link oder Logo. Beschreibung nur mit belegten Fakten (Datenblatt, Webseite, Wissensbasis), nie erfinden. Produkte einem Hersteller zuordnen: propose_product_data (manufacturer).`,
      { title: z.string().describe('Kurzer Titel, z. B. „Hersteller 3M Peltor anlegen“'), reason: z.string().describe('Absicht in 1 bis 2 Sätzen'),
        create: z.array(z.object({ name: z.string().min(1).max(255), description: z.string().max(20000).optional(), link: z.string().max(500).optional(), mediaId: z.string().optional() })).optional(),
        update: z.array(z.object({ id: z.string(), name: z.string().min(1).max(255).optional(), description: z.string().max(20000).nullable().optional(), link: z.string().max(500).nullable().optional(), mediaId: z.string().nullable().optional() })).optional() },
      guard(async a => { const { cs, payload } = await buildManufacturerChangeSet(sw, a as ManufacturerArgs); return ok(await session.requestChange(cs, payload)); })),
  ] as AnyTool[];
}

export const hersteller: Feature = { key: 'hersteller', platforms: ['shopware'], toolNames: MANUFACTURER_TOOLS, tools };
