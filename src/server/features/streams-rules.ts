// Product streams: readable rule (groups/conditions) ⇄ Shopware filter tree (product-stream-filter). Pure logic, no shop access.

export const COND_FIELDS = ['category', 'manufacturer', 'property', 'tag', 'productNumber', 'price', 'onSale', 'stock', 'active', 'releaseDate'] as const;
export type CondField = typeof COND_FIELDS[number];
export type IdKind = 'category' | 'manufacturer' | 'property' | 'tag' | 'product';

/** A condition as the AI phrases it (ids OR names for category/manufacturer/property/tag). */
export interface CondSpec {
  field: CondField; ids?: string[]; names?: string[]; values?: string[];
  min?: number; max?: number; value?: boolean; from?: string; to?: string;
  includeSubcategories?: boolean; negate?: boolean;
}
/** Groups are OR-combined, conditions within a group AND-combined (the Shopware Administration builds streams the same way). */
export interface GroupSpec { conditions: CondSpec[] }

/** Node in the filter tree (Admin API format, also used for the stream preview) */
export interface FilterNode { type: string; field?: string | null; operator?: string | null; value?: string | null; parameters?: Record<string, unknown> | null; queries?: FilterNode[] }
/** Stored row of product-stream-filter (flat, nested via parentId) */
export interface FilterRow { id: string; type: string; field?: string | null; operator?: string | null; value?: string | null; parameters?: Record<string, unknown> | null; position: number; parentId: string | null }

export const MAX_GROUPS = 10, MAX_CONDS = 20;
const ID_FIELD: Record<string, string> = { category: 'categoriesRo.id', manufacturer: 'manufacturerId', property: 'properties.id', tag: 'tags.id' };
// Known fields (also streams created in the Administration) → display
const ID_FIELDS: Record<string, { kind: IdKind; label: string }> = {
  'categoriesRo.id': { kind: 'category', label: 'Kategorie (inkl. Unterkategorien)' }, 'categories.id': { kind: 'category', label: 'Kategorie' }, categoryIds: { kind: 'category', label: 'Kategorie' },
  manufacturerId: { kind: 'manufacturer', label: 'Hersteller' }, 'manufacturer.id': { kind: 'manufacturer', label: 'Hersteller' },
  'properties.id': { kind: 'property', label: 'Eigenschaft' }, propertyIds: { kind: 'property', label: 'Eigenschaft' }, 'options.id': { kind: 'property', label: 'Variantenoption' }, optionIds: { kind: 'property', label: 'Variantenoption' },
  'tags.id': { kind: 'tag', label: 'Tag' }, tagIds: { kind: 'tag', label: 'Tag' }, id: { kind: 'product', label: 'Produkt' }, parentId: { kind: 'product', label: 'Hauptprodukt' },
};
const LABEL: Record<string, string> = {
  productNumber: 'Produktnummer', cheapestPrice: 'Preis', price: 'Preis', 'cheapestPrice.percentage': 'Rabatt (Streichpreis)', 'price.percentage.gross': 'Rabatt (Streichpreis)',
  'cheapestPrice.listPrice': 'Streichpreis', 'price.listPrice': 'Streichpreis', stock: 'Bestand', availableStock: 'Verfügbarer Bestand', active: 'Aktiv', releaseDate: 'Erscheinungsdatum',
  createdAt: 'Angelegt am', sales: 'Verkäufe', ratingAverage: 'Bewertung', shippingFree: 'Versandkostenfrei', isCloseout: 'Abverkauf', markAsTopseller: 'Topseller', weight: 'Gewicht', ean: 'EAN', name: 'Name',
};
const PRICE_FIELDS = new Set(['cheapestPrice', 'price', 'cheapestPrice.listPrice', 'price.listPrice']), PERCENT_FIELDS = new Set(['cheapestPrice.percentage', 'price.percentage.gross']);
const BOOL_FIELDS = new Set(['active', 'shippingFree', 'isCloseout', 'markAsTopseller']);
const OPS: Record<string, string> = { gte: '≥', lte: '≤', gt: '>', lt: '<' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const eur = (v: unknown) => `${Number(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const deDate = (v: unknown) => { const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v); };
const num = (v: unknown, what: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${what}: Zahl ≥ 0 erwartet`); return v; };
const strip = (f: string | null | undefined) => (f ?? '').replace(/^product\./, '');

/** Range min/max → parameters (at least one bound, min ≤ max) */
function range(c: CondSpec, what: string, int = false): Record<string, number> {
  const p: Record<string, number> = {};
  if (c.min != null) p.gte = num(c.min, what);
  if (c.max != null) p.lte = num(c.max, what);
  if (!Object.keys(p).length) throw new Error(`${what}: min und/oder max angeben`);
  if (int && Object.values(p).some(v => !Number.isInteger(v))) throw new Error(`${what}: ganze Zahlen erwartet`);
  if (p.gte != null && p.lte != null && p.gte > p.lte) throw new Error(`${what}: min ist größer als max`);
  return p;
}

/** Condition (with resolved ids) → filter node. Throws on invalid input. */
export function condToNode(c: CondSpec): FilterNode {
  let n: FilterNode;
  switch (c.field) {
    case 'category': case 'manufacturer': case 'property': case 'tag': {
      const ids = [...new Set(c.ids ?? [])];
      if (!ids.length) throw new Error(`${c.field}: keine IDs (nicht aufgelöst)`);
      if (ids.some(i => !/^[0-9a-f]{32}$/.test(i))) throw new Error(`${c.field}: ungültige ID`);
      n = { type: 'equalsAny', field: c.field === 'category' && c.includeSubcategories === false ? 'categories.id' : ID_FIELD[c.field], value: ids.join('|') };
      break;
    }
    case 'productNumber': {
      const v = [...new Set((c.values ?? []).map(s => String(s).trim()).filter(Boolean))];
      if (!v.length) throw new Error('productNumber: values (Produktnummern) angeben');
      if (v.some(s => s.includes('|'))) throw new Error('productNumber: „|“ ist nicht erlaubt');
      n = { type: 'equalsAny', field: 'productNumber', value: v.join('|') };
      break;
    }
    case 'price': n = { type: 'range', field: 'cheapestPrice', parameters: range(c, 'Preis') }; break;
    case 'stock': n = { type: 'range', field: 'stock', parameters: range(c, 'Bestand', true) }; break;
    case 'onSale': { // List price present (optionally minimum discount in %); value:false = NOT on sale
      if (c.min != null && (num(c.min, 'Rabatt') > 100)) throw new Error('Rabatt: höchstens 100 %');
      n = { type: 'range', field: 'cheapestPrice.percentage', parameters: c.min != null && c.min > 0 ? { gte: c.min } : { gt: 0 } };
      if (c.value === false) n = { type: 'not', operator: 'AND', queries: [n] };
      break;
    }
    case 'active':
      if (typeof c.value !== 'boolean') throw new Error('active: value true/false angeben');
      n = { type: 'equals', field: 'active', value: c.value ? '1' : '0' };
      break;
    case 'releaseDate': {
      const p: Record<string, string> = {};
      for (const [k, op] of [['from', 'gte'], ['to', 'lte']] as const) if (c[k] != null) { if (!DATE.test(c[k]!)) throw new Error(`releaseDate: ${k} als JJJJ-MM-TT`); p[op] = c[k]!; }
      if (!Object.keys(p).length) throw new Error('releaseDate: from und/oder to angeben');
      if (p.gte && p.lte && p.gte > p.lte) throw new Error('releaseDate: from liegt nach to');
      n = { type: 'range', field: 'releaseDate', parameters: p };
      break;
    }
    default: throw new Error(`Unbekanntes Feld „${(c as { field: string }).field}“ (erlaubt: ${COND_FIELDS.join(', ')})`);
  }
  return c.negate ? { type: 'not', operator: 'AND', queries: [n] } : n;
}

/** Rule → tree: OR (root) → AND groups → conditions */
export function specToTree(groups: GroupSpec[]): FilterNode {
  if (!groups?.length) throw new Error('Regel ist leer – mindestens eine Gruppe mit einer Bedingung angeben');
  if (groups.length > MAX_GROUPS) throw new Error(`Höchstens ${MAX_GROUPS} ODER-Gruppen`);
  return { type: 'multi', operator: 'OR', queries: groups.map((g, i) => {
    if (!g.conditions?.length) throw new Error(`Gruppe ${i + 1} hat keine Bedingung`);
    if (g.conditions.length > MAX_CONDS) throw new Error(`Gruppe ${i + 1}: höchstens ${MAX_CONDS} Bedingungen`);
    return { type: 'multi', operator: 'AND', queries: g.conditions.map(condToNode) };
  }) };
}

/** Tree → flat rows for product-stream-filter (new IDs) */
export function treeToRows(roots: FilterNode[], newId: () => string): FilterRow[] {
  const out: FilterRow[] = [];
  const walk = (n: FilterNode, parentId: string | null, position: number) => {
    const id = newId();
    out.push({ id, type: n.type, field: n.field ?? null, operator: n.operator ?? null, value: n.value ?? null, parameters: n.parameters ?? null, position, parentId });
    (n.queries ?? []).forEach((q, i) => walk(q, id, i));
  };
  roots.forEach((r, i) => walk(r, null, i));
  return out;
}

/** Stored rows → tree (roots by position) */
export function rowsToTree(rows: Partial<FilterRow>[]): FilterNode[] {
  const kids = new Map<string | null, Partial<FilterRow>[]>();
  for (const r of rows) { const k = r.parentId ?? null; if (!kids.has(k)) kids.set(k, []); kids.get(k)!.push(r); }
  const build = (r: Partial<FilterRow>, depth: number): FilterNode => {
    if (depth > 20) throw new Error('Filterbaum zu tief verschachtelt');
    const ch = (kids.get(r.id!) ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return { type: r.type!, ...(r.field ? { field: r.field } : {}), ...(r.operator ? { operator: r.operator } : {}), ...(r.value != null ? { value: r.value } : {}), ...(r.parameters ? { parameters: r.parameters } : {}), ...(ch.length ? { queries: ch.map(c => build(c, depth + 1)) } : {}) };
  };
  return (kids.get(null) ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(r => build(r, 0));
}

/** Tree → rule (only if it maps losslessly; otherwise null, e.g. for custom fields from the Administration) */
export function treeToSpec(roots: FilterNode[]): GroupSpec[] | null {
  if (roots.length !== 1) return null;
  const root = roots[0];
  const groups = root.type === 'multi' && root.operator === 'OR' ? root.queries ?? [] : [root];
  const out: GroupSpec[] = [];
  for (const g of groups) {
    const leaves = g.type === 'multi' && g.operator === 'AND' ? g.queries ?? [] : [g];
    const conds: CondSpec[] = [];
    for (const l of leaves) { const c = nodeToCond(l); if (!c) return null; conds.push(c); }
    if (!conds.length) return null;
    out.push({ conditions: conds });
  }
  return out.length ? out : null;
}
function nodeToCond(n: FilterNode): CondSpec | null {
  if (n.type === 'not' && n.queries?.length === 1) {
    const c = nodeToCond(n.queries[0]); if (!c || c.negate) return null;
    return c.field === 'onSale' && c.value !== false ? { ...c, value: false } : { ...c, negate: true };
  }
  const f = strip(n.field), ids = String(n.value ?? '').split('|').filter(Boolean), p = (n.parameters ?? {}) as Record<string, number | string>;
  const minMax = () => { if (Object.keys(p).some(k => k !== 'gte' && k !== 'lte')) return null; return { ...(p.gte != null ? { min: Number(p.gte) } : {}), ...(p.lte != null ? { max: Number(p.lte) } : {}) }; };
  if (n.type === 'equalsAny' || n.type === 'equals') {
    if (f === 'categoriesRo.id') return { field: 'category', ids };
    if (f === 'categories.id') return { field: 'category', ids, includeSubcategories: false };
    const k = Object.entries(ID_FIELD).find(([, v]) => v === f)?.[0] as CondField | undefined;
    if (k) return { field: k, ids };
    if (f === 'productNumber') return { field: 'productNumber', values: ids };
    if (f === 'active' && n.type === 'equals') return { field: 'active', value: n.value === '1' || n.value === 'true' };
    return null;
  }
  if (n.type === 'range') {
    if (f === 'cheapestPrice') { const m = minMax(); return m ? { field: 'price', ...m } : null; }
    if (f === 'stock') { const m = minMax(); return m ? { field: 'stock', ...m } : null; }
    if (f === 'cheapestPrice.percentage') return p.gt === 0 && Object.keys(p).length === 1 ? { field: 'onSale' } : p.gte != null && Object.keys(p).length === 1 ? { field: 'onSale', min: Number(p.gte) } : null;
    if (f === 'releaseDate' && Object.keys(p).every(k => k === 'gte' || k === 'lte')) return { field: 'releaseDate', ...(p.gte ? { from: String(p.gte).slice(0, 10) } : {}), ...(p.lte ? { to: String(p.lte).slice(0, 10) } : {}) };
  }
  return null;
}

/** All referenced IDs per kind (for name resolution) */
export function collectIds(roots: FilterNode[], acc: Record<IdKind, Set<string>> = { category: new Set(), manufacturer: new Set(), property: new Set(), tag: new Set(), product: new Set() }) {
  const walk = (n: FilterNode) => {
    const def = ID_FIELDS[strip(n.field)];
    if (def && n.value) for (const id of String(n.value).split('|')) if (/^[0-9a-f]{32}$/.test(id)) acc[def.kind].add(id);
    n.queries?.forEach(walk);
  };
  roots.forEach(walk);
  return acc;
}

/** Readable rule, e.g. "Kategorie (inkl. Unterkategorien) = Wohnaccessoires UND Preis ≤ 50,00 €" */
export function renderRule(roots: FilterNode[], names: Record<string, string> = {}): string {
  if (!roots.length) return 'alle Produkte (keine Bedingung)';
  const name = (id: string) => names[id] ?? `unbekannt (${id.slice(0, 8)}…)`;
  const leaf = (n: FilterNode, neg: boolean): string => {
    const f = strip(n.field), def = ID_FIELDS[f], label = def?.label ?? LABEL[f] ?? f;
    if (n.type === 'equalsAny' || n.type === 'equals') {
      const vals = String(n.value ?? '').split('|').filter(Boolean);
      if (BOOL_FIELDS.has(f) && n.type === 'equals') { const yes = n.value === '1' || n.value === 'true'; return `${label} = ${yes !== neg ? 'ja' : 'nein'}`; }
      const shown = vals.map(v => (def ? name(v) : v));
      return `${label} ${neg ? '≠' : '='} ${shown.length > 8 ? `${shown.slice(0, 8).join(' oder ')} … (+${shown.length - 8})` : shown.join(' oder ') || '–'}`;
    }
    if (n.type === 'range') {
      const p = (n.parameters ?? {}) as Record<string, unknown>;
      if (PERCENT_FIELDS.has(f) && p.gt === 0 && Object.keys(p).length === 1) return neg ? 'Nicht im Angebot (kein Streichpreis)' : 'Im Angebot (mit Streichpreis)';
      const fmt = (v: unknown) => (PRICE_FIELDS.has(f) ? eur(v) : PERCENT_FIELDS.has(f) ? `${v} %` : /Date|At$/.test(f) ? deDate(v) : String(v));
      const parts = Object.entries(p).filter(([k]) => OPS[k]).map(([k, v]) => `${OPS[k]} ${fmt(v)}`);
      return `${neg ? 'NICHT ' : ''}${label} ${parts.join(' und ')}`;
    }
    if (n.type === 'contains') return `${label} ${neg ? 'enthält nicht' : 'enthält'} „${n.value}“`;
    if (n.type === 'since' || n.type === 'until') return `${neg ? 'NICHT ' : ''}${label}: relativ ${n.type === 'since' ? 'seit' : 'bis'} ${n.value} (${(n.parameters as { operator?: string } | null)?.operator ?? '?'})`;
    return `${neg ? 'NICHT ' : ''}${label} ${n.type} ${n.value ?? JSON.stringify(n.parameters ?? {})}`;
  };
  const node = (n: FilterNode, nested: boolean, neg = false): string => {
    if (n.type === 'not') {
      const q = n.queries ?? [];
      if (q.length === 1 && q[0].type !== 'multi' && q[0].type !== 'not') return leaf(q[0], !neg);
      return `NICHT (${q.map(x => node(x, false)).join(n.operator === 'OR' ? ' ODER ' : ' UND ')})`;
    }
    if (n.type === 'multi') {
      const qs = n.queries ?? [];
      if (!qs.length) return 'alle Produkte';
      const s = qs.map(x => node(x, qs.length > 1)).join(n.operator === 'OR' ? ' ODER ' : ' UND ');
      return nested && qs.length > 1 ? `(${s})` : s;
    }
    return leaf(n, neg);
  };
  // Shopware combines multiple roots with AND; parentheses only where several parts are combined
  return roots.map(r => node(r, roots.length > 1)).join(' UND ');
}

/** Structural comparison of two trees (without IDs/positions) */
export const sameTree = (a: FilterNode[], b: FilterNode[]) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const norm = (ns: FilterNode[]): unknown => ns.map(n => [n.type, strip(n.field) || null, n.operator ?? null, n.value ?? null, n.parameters ? Object.entries(n.parameters).sort() : null, norm(n.queries ?? [])]);
