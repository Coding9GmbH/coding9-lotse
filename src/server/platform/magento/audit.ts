import 'server-only';
// Magento: SEO inventory (read-only) for products and categories, paged for large catalogs.
import { attr, attrStr, plain, type MRecord } from './map';
import type { MagentoReader } from './reader';

export interface AuditIssue { key: string; label: string; level: 'wichtig' | 'empfohlen' }
const ISSUES: AuditIssue[] = [
  { key: 'metaTitleMissing', label: 'Meta-Title fehlt', level: 'wichtig' }, { key: 'metaTitleLong', label: 'Meta-Title über 60 Zeichen', level: 'empfohlen' }, { key: 'metaTitleShort', label: 'Meta-Title unter 30 Zeichen', level: 'empfohlen' },
  { key: 'metaTitleDuplicate', label: 'Meta-Title doppelt', level: 'wichtig' }, { key: 'metaDescriptionMissing', label: 'Meta-Description fehlt', level: 'wichtig' },
  { key: 'metaDescriptionLength', label: 'Meta-Description außerhalb 120 bis 158 Zeichen', level: 'empfohlen' }, { key: 'metaDescriptionDuplicate', label: 'Meta-Description doppelt', level: 'wichtig' },
  { key: 'thinDescription', label: 'Beschreibung unter 50 Wörtern', level: 'wichtig' }, { key: 'noImage', label: 'Kein sichtbares Bild', level: 'wichtig' }, { key: 'imageWithoutAlt', label: 'Bild ohne Alt-Text', level: 'empfohlen' },
];
const words = (t: unknown) => plain(t).split(/\s+/).filter(Boolean).length;

/** Checks a list of records (pure, tested): returns the IDs per problem */
export function auditRecords(rows: MRecord[], entity: 'product' | 'category'): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(ISSUES.map(i => [i.key, []]));
  const add = (k: string, id: string) => out[k].push(id);
  const titles = new Map<string, string[]>(), descs = new Map<string, string[]>();
  for (const r of rows) {
    const id = String(r.id), mt = plain(attrStr(r, 'meta_title')), md = plain(attrStr(r, 'meta_description'));
    if (!mt) add('metaTitleMissing', id); else { if (mt.length > 60) add('metaTitleLong', id); if (mt.length < 30) add('metaTitleShort', id); titles.set(mt.toLowerCase(), [...(titles.get(mt.toLowerCase()) ?? []), id]); }
    if (!md) add('metaDescriptionMissing', id); else { if (md.length < 120 || md.length > 158) add('metaDescriptionLength', id); descs.set(md.toLowerCase(), [...(descs.get(md.toLowerCase()) ?? []), id]); }
    if (words(attr(r, 'description')) < 50) add('thinDescription', id);
    if (entity === 'product') {
      const vis = ((r.media_gallery_entries ?? []) as MRecord[]).filter(e => !e.disabled);
      if (!vis.length) add('noImage', id); else if (vis.some(e => !plain(e.label))) add('imageWithoutAlt', id);
    }
  }
  for (const ids of titles.values()) if (ids.length > 1) out.metaTitleDuplicate.push(...ids);
  for (const ids of descs.values()) if (ids.length > 1) out.metaDescriptionDuplicate.push(...ids);
  return out;
}

export async function seoAudit(ro: MagentoReader, a: { entity: 'product' | 'category'; limit?: number; offset?: number }) {
  const limit = Math.max(10, Math.min(Math.floor(a.limit ?? 200), 500)), page = Math.floor(Math.max(0, a.offset ?? 0) / limit) + 1;
  const r = a.entity === 'product'
    ? await ro.products({ filters: [[{ field: 'visibility', value: [2, 3, 4], condition_type: 'in' }], [{ field: 'status', value: 1 }]], pageSize: limit, currentPage: page, sort: [{ field: 'entity_id', direction: 'ASC' }] })
    : await ro.categories({ filters: [[{ field: 'level', value: 2, condition_type: 'gteq' }], [{ field: 'is_active', value: 1 }]], pageSize: limit, currentPage: page });
  const res = auditRecords(r.items, a.entity), name = new Map(r.items.map(x => [String(x.id), x.name]));
  const issues = ISSUES.filter(i => res[i.key].length && (a.entity === 'product' || !['noImage', 'imageWithoutAlt'].includes(i.key)))
    .sort((x, y) => (x.level === y.level ? res[y.key].length - res[x.key].length : x.level === 'wichtig' ? -1 : 1))
    .map(i => ({ issue: i.label, level: i.level, count: res[i.key].length, ids: res[i.key].slice(0, 50) }));
  const score = new Map<string, number>();
  for (const i of ISSUES) for (const id of res[i.key]) score.set(id, (score.get(id) ?? 0) + (i.level === 'wichtig' ? 2 : 1));
  return {
    entity: a.entity, checked: r.items.length, total: r.total_count, offset: (page - 1) * limit, ...(page * limit < r.total_count ? { nextOffset: page * limit } : {}),
    note: a.entity === 'product' ? 'Geprüft werden aktive, einzeln sichtbare Produkte; Doppelte nur innerhalb dieser Seite.' : 'Geprüft werden aktive Kategorien; Doppelte nur innerhalb dieser Seite.',
    issues, weakest: [...score].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([id, s]) => ({ id, name: name.get(id), score: s })),
  };
}
