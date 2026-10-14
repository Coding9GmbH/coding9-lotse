import 'server-only';
// OpenMage: SEO inventory (read-only) for products and categories, paged for large catalogs.
// With ?fields= and ?with=images the list returns everything needed without single fetches; the pure check comes from magento/audit.ts.
import { auditRecords, type AuditIssue } from '../magento/audit';
import { mrec, type OmRecord } from './map';
import { LIST_FIELDS, type OmReader } from './reader';

const ISSUES: AuditIssue[] = [
  { key: 'metaTitleMissing', label: 'Meta-Title fehlt', level: 'wichtig' }, { key: 'metaTitleLong', label: 'Meta-Title über 60 Zeichen', level: 'empfohlen' }, { key: 'metaTitleShort', label: 'Meta-Title unter 30 Zeichen', level: 'empfohlen' },
  { key: 'metaTitleDuplicate', label: 'Meta-Title doppelt', level: 'wichtig' }, { key: 'metaDescriptionMissing', label: 'Meta-Description fehlt', level: 'wichtig' },
  { key: 'metaDescriptionLength', label: 'Meta-Description außerhalb 120 bis 158 Zeichen', level: 'empfohlen' }, { key: 'metaDescriptionDuplicate', label: 'Meta-Description doppelt', level: 'wichtig' },
  { key: 'thinDescription', label: 'Beschreibung unter 50 Wörtern', level: 'wichtig' }, { key: 'noImage', label: 'Kein sichtbares Bild', level: 'wichtig' }, { key: 'imageWithoutAlt', label: 'Bild ohne Alt-Text', level: 'empfohlen' },
];

/** Category record in Magento 2 shape (meta_* and description at the top level) */
export const catRec = (c: OmRecord) => ({ id: c.id, name: c.name, custom_attributes: ['description', 'meta_title', 'meta_description', 'display_mode', 'landing_page'].map(code => ({ attribute_code: code, value: c[code] ?? c.attributes?.[code] ?? null })) });

export async function seoAudit(ro: OmReader, a: { entity: 'product' | 'category'; limit?: number; offset?: number }) {
  const limit = Math.max(10, Math.min(Math.floor(a.limit ?? 200), 200)), page = Math.floor(Math.max(0, a.offset ?? 0) / limit) + 1;
  let rows: OmRecord[], total: number;
  if (a.entity === 'product') {
    const r = await ro.products({ status: 1, visibility: '2,3,4', limit, page, sort: 'entity_id', dir: 'asc', fields: LIST_FIELDS.join(','), with: 'images' });
    rows = r.items.map(mrec); total = r.meta.total;
  } else {
    const all = (await ro.categoriesFlat()).filter(c => Number(c.level) >= 2 && c.is_active);
    total = all.length;
    const ids = all.slice((page - 1) * limit, page * limit);
    rows = []; for (const c of ids) { const d = await ro.category(c.id); if (d) rows.push(catRec(d)); }
  }
  const res = auditRecords(rows, a.entity), name = new Map(rows.map(x => [String(x.id), x.name]));
  const issues = ISSUES.filter(i => res[i.key].length && (a.entity === 'product' || !['noImage', 'imageWithoutAlt'].includes(i.key)))
    .sort((x, y) => (x.level === y.level ? res[y.key].length - res[x.key].length : x.level === 'wichtig' ? -1 : 1))
    .map(i => ({ issue: i.label, level: i.level, count: res[i.key].length, ids: res[i.key].slice(0, 50) }));
  const score = new Map<string, number>();
  for (const i of ISSUES) for (const id of res[i.key]) score.set(id, (score.get(id) ?? 0) + (i.level === 'wichtig' ? 2 : 1));
  return {
    entity: a.entity, checked: rows.length, total, offset: (page - 1) * limit, ...(page * limit < total ? { nextOffset: page * limit } : {}),
    note: a.entity === 'product' ? 'Geprüft werden aktive, einzeln sichtbare Produkte; Doppelte nur innerhalb dieser Seite.' : 'Geprüft werden aktive Kategorien; Doppelte nur innerhalb dieser Seite.',
    issues, weakest: [...score].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([id, s]) => ({ id, name: name.get(id), score: s })),
  };
}
