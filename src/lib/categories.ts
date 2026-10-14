import type { CategoryRow } from './protocol';

export interface TreeRow { cat: CategoryRow; depth: number; hasKids: boolean; open: boolean }

/** Visible rows of the category tree (search expands all matching branches). */
export function categoryRows(cats: CategoryRow[], query: string, collapsed: ReadonlySet<string>): TreeRow[] {
  const q = query.trim().toLowerCase();
  const byParent = new Map<string, CategoryRow[]>();
  for (const c of cats) { const k = c.parentId ?? 'root'; let a = byParent.get(k); if (!a) byParent.set(k, a = []); a.push(c); }
  const ids = new Set(cats.map(c => c.id));
  const memo = new Map<string, boolean>();
  const has = (c: CategoryRow): boolean => {
    const hit = memo.get(c.id);
    if (hit !== undefined) return hit;
    memo.set(c.id, false); // guard against cycles
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
  const reach = new Set<string>(); // reachable from a root (regardless of collapsing)
  const mark = (c: CategoryRow) => { if (reach.has(c.id)) return; reach.add(c.id); (byParent.get(c.id) ?? []).forEach(mark); };
  const start = (c: CategoryRow) => { mark(c); walk(c, 0); };
  cats.filter(c => !c.parentId || !ids.has(c.parentId)).forEach(start);
  for (const c of cats) if (!reach.has(c.id)) start(c); // cycles without a root (broken import): show anyway, exactly once
  return out;
}

/** From this size on, the tree starts collapsed (only roots and first level open) and the list is capped. */
export const BIG_TREE = 150;
export const MAX_ROWS = 300;

/** Initial state: expand large trees (Magento, OpenMage without upper limit) only to the first level. */
export function initialCollapsed(cats: CategoryRow[]): Set<string> {
  if (cats.length <= BIG_TREE) return new Set();
  const ids = new Set(cats.map(c => c.id));
  const roots = new Set(cats.filter(c => !c.parentId || !ids.has(c.parentId)).map(c => c.id));
  return new Set(cats.filter(c => !roots.has(c.id) && cats.some(k => k.parentId === c.id)).map(c => c.id));
}

/** Breadcrumb without root ("Herren › Schuhe"). */
export function categoryPath(cats: CategoryRow[], c: CategoryRow): string {
  const m = new Map(cats.map(x => [x.id, x]));
  const p: string[] = [];
  for (let x: CategoryRow | undefined = c; x && p.length < 50; x = x.parentId ? m.get(x.parentId) : undefined) p.unshift(x.name);
  return p.slice(1).join(' › ') || c.name;
}
