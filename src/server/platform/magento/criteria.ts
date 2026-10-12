// Magento searchCriteria als Query-String (REST: GET …?searchCriteria[filter_groups][0][filters][0][field]=…).
// filters: Gruppen werden UND-verknüpft, Filter innerhalb einer Gruppe ODER-verknüpft (Magento-Semantik).

export type Condition = 'eq' | 'neq' | 'like' | 'nlike' | 'in' | 'nin' | 'gt' | 'gteq' | 'lt' | 'lteq' | 'null' | 'notnull' | 'finset' | 'from' | 'to';
export interface Filter { field: string; value?: string | number | boolean | (string | number)[]; condition_type?: Condition }
export interface Criteria { filters?: Filter[][]; pageSize?: number; currentPage?: number; sort?: { field: string; direction?: 'ASC' | 'DESC' }[] }

const enc = (s: string) => encodeURIComponent(s).replace(/%5B/g, '[').replace(/%5D/g, ']');
const val = (v: Filter['value']) => (Array.isArray(v) ? v.join(',') : v === true ? '1' : v === false ? '0' : String(v ?? ''));

export function criteriaQuery(c: Criteria = {}, prefix = 'searchCriteria'): string {
  const out: string[] = [];
  (c.filters ?? []).forEach((group, g) => group.forEach((f, i) => {
    const k = `${prefix}[filter_groups][${g}][filters][${i}]`;
    out.push(`${enc(`${k}[field]`)}=${encodeURIComponent(f.field)}`);
    if (f.condition_type !== 'null' && f.condition_type !== 'notnull') out.push(`${enc(`${k}[value]`)}=${encodeURIComponent(val(f.value))}`);
    else out.push(`${enc(`${k}[value]`)}=1`);
    if (f.condition_type && f.condition_type !== 'eq') out.push(`${enc(`${k}[condition_type]`)}=${f.condition_type}`);
  }));
  (c.sort ?? []).forEach((s, i) => { out.push(`${enc(`${prefix}[sortOrders][${i}][field]`)}=${encodeURIComponent(s.field)}`, `${enc(`${prefix}[sortOrders][${i}][direction]`)}=${s.direction ?? 'ASC'}`); });
  // Ohne pageSize liefert Magento ALLE Treffer – darum immer begrenzen
  out.push(`${enc(`${prefix}[pageSize]`)}=${Math.max(1, Math.min(c.pageSize ?? 20, 500))}`, `${enc(`${prefix}[currentPage]`)}=${Math.max(1, c.currentPage ?? 1)}`);
  return out.join('&');
}

/** Alle Feldnamen der Kriterien (Prüfung gegen die Freigabeliste) */
export const criteriaFields = (c: Criteria = {}) => [...(c.filters ?? []).flat().map(f => f.field), ...(c.sort ?? []).map(s => s.field)];

/** Suchbegriff für like-Filter: % und _ maskieren, Wildcards außen */
export const likeTerm = (t: string) => `%${t.trim().replace(/[\\%_]/g, m => `\\${m}`)}%`;
