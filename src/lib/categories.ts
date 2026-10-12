import type { CategoryRow } from './protocol';

export interface TreeRow { cat: CategoryRow; depth: number; hasKids: boolean; open: boolean }

/** Sichtbare Zeilen des Kategoriebaums (Suche öffnet alle passenden Zweige). */
export function categoryRows(cats: CategoryRow[], query: string, collapsed: ReadonlySet<string>): TreeRow[] {
  const q = query.trim().toLowerCase();
  const byParent = new Map<string, CategoryRow[]>();
  for (const c of cats) { const k = c.parentId ?? 'root'; let a = byParent.get(k); if (!a) byParent.set(k, a = []); a.push(c); }
  const ids = new Set(cats.map(c => c.id));
  const memo = new Map<string, boolean>();
  const has = (c: CategoryRow): boolean => {
    const hit = memo.get(c.id);
    if (hit !== undefined) return hit;
    memo.set(c.id, false); // Schutz vor Zyklen
    const r = !q || c.name.toLowerCase().includes(q) || (byParent.get(c.id) ?? []).some(has);
    memo.set(c.id, r);
    return r;
  };
  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (c: CategoryRow, depth: number) => {
    if (seen.has(c.id) || !has(c)) return;
    seen.add(c.id);
    const kids = (byParent.get(c.id) ?? []).filter(has);
    const open = !!q || !collapsed.has(c.id);
    out.push({ cat: c, depth, hasKids: kids.length > 0, open });
    if (open) kids.forEach(k => walk(k, depth + 1));
  };
  const reach = new Set<string>(); // von einer Wurzel aus erreichbar (unabhängig vom Einklappen)
  const mark = (c: CategoryRow) => { if (reach.has(c.id)) return; reach.add(c.id); (byParent.get(c.id) ?? []).forEach(mark); };
  const start = (c: CategoryRow) => { mark(c); walk(c, 0); };
  cats.filter(c => !c.parentId || !ids.has(c.parentId)).forEach(start);
  for (const c of cats) if (!reach.has(c.id)) start(c); // Zyklen ohne Wurzel (kaputter Import): trotzdem zeigen, genau einmal
  return out;
}

/** Ab dieser Größe startet der Baum eingeklappt (nur Wurzeln und erste Ebene offen) und die Liste wird gekappt. */
export const BIG_TREE = 150;
export const MAX_ROWS = 300;

/** Anfangszustand: große Bäume (Magento, OpenMage ohne Obergrenze) nur bis zur ersten Ebene aufklappen. */
export function initialCollapsed(cats: CategoryRow[]): Set<string> {
  if (cats.length <= BIG_TREE) return new Set();
  const ids = new Set(cats.map(c => c.id));
  const roots = new Set(cats.filter(c => !c.parentId || !ids.has(c.parentId)).map(c => c.id));
  return new Set(cats.filter(c => !roots.has(c.id) && cats.some(k => k.parentId === c.id)).map(c => c.id));
}

/** Breadcrumb ohne Wurzel („Herren › Schuhe“). */
export function categoryPath(cats: CategoryRow[], c: CategoryRow): string {
  const m = new Map(cats.map(x => [x.id, x]));
  const p: string[] = [];
  for (let x: CategoryRow | undefined = c; x && p.length < 50; x = x.parentId ? m.get(x.parentId) : undefined) p.unshift(x.name);
  return p.slice(1).join(' › ') || c.name;
}
