import 'server-only';
// Custom checks + on/off per check (stored locally in the kv store). Custom checks evaluate the platform's neutral product rows
// (platform.scanProducts), run in the same pass as the built-in ones and appear as normal findings.
import { builtinTitle, conditionsText, CUSTOM_MAX, CUSTOM_PREFIX, evaluate, parseCheckInput, slugify, type CheckListItem, type CustomCheck, type NeutralProduct } from '@/lib/custom-checks';
import type { PlatformKind } from '@/lib/platforms';
import type { CheckFinding } from '@/lib/protocol';
import { listChecks, type ShopCheck } from './checks';
import { kvGet, kvSet } from './db';
import { makeFinding, type FindingDef } from './features/shopcheck-rules';

const CUSTOM_KEY = 'custom_checks', OFF_KEY = 'checks_disabled';

export const listCustom = (): CustomCheck[] => kvGet<CustomCheck[]>(CUSTOM_KEY) ?? [];
const saveCustom = (l: CustomCheck[]) => kvSet(CUSTOM_KEY, l);
export const disabledChecks = (): Set<string> => new Set(kvGet<string[]>(OFF_KEY) ?? []);

export function addCustom(raw: unknown): CustomCheck {
  const list = listCustom();
  if (list.length >= CUSTOM_MAX) throw new Error(`Höchstens ${CUSTOM_MAX} eigene Prüfungen`);
  const input = parseCheckInput(raw);
  const base = slugify(input.title) || 'pruefung';
  let id = CUSTOM_PREFIX + base;
  for (let i = 2; list.some(c => c.id === id); i++) id = `${CUSTOM_PREFIX}${base}-${i}`;
  const chk: CustomCheck = { ...input, id, createdAt: new Date().toISOString() };
  saveCustom([...list, chk]);
  return chk;
}
export function updateCustom(id: string, patch: Record<string, unknown>): CustomCheck {
  const list = listCustom(), cur = list.find(c => c.id === id);
  if (!cur) throw new Error('Prüfung nicht gefunden');
  const next: CustomCheck = { ...cur, ...parseCheckInput({ ...cur, ...patch }), id: cur.id, createdAt: cur.createdAt };
  saveCustom(list.map(c => (c.id === id ? next : c)));
  return next;
}
export function removeCustom(id: string): boolean {
  const list = listCustom();
  if (!list.some(c => c.id === id)) return false;
  saveCustom(list.filter(c => c.id !== id));
  setCheckEnabled(id, true); // also remove the entry from the off list
  return true;
}
export function setCheckEnabled(id: string, enabled: boolean) {
  const off = disabledChecks();
  if (enabled) off.delete(id); else off.add(id);
  kvSet(OFF_KEY, [...off]);
}

const asDef = (c: CustomCheck): FindingDef => ({
  id: c.id, area: c.area, title: c.title, severity: c.severity, unit: 'Produkten', noun: ['Produkt', 'Produkte'],
  hint: c.hint ?? `Eigene Prüfung: ${conditionsText(c)}.`,
  fix: n => `Behebe „${c.title}“ (betrifft ${n}). Die Prüfung trifft zu, wenn: ${conditionsText(c)}. Finde die betroffenen Produkte mit den Lese-Werkzeugen (list_products, get_product), zeig sie mir und frag mich, was ich ändern soll, bevor du Änderungen vorschlägst.`,
});

/** Finding of a custom check from read products (pure) */
export function customFinding(c: CustomCheck, scan: { rows: NeutralProduct[]; total: number; capped: boolean }): CheckFinding | null {
  const e = evaluate(scan.rows, c);
  return makeFinding(asDef(c), e.count, scan.total, e.sample, { atLeast: scan.capped });
}

/** Custom checks as ShopCheck; scan reads the products of the active platform (once per pass, the caller memoizes) */
export function customShopChecks(scan: (reader: unknown) => Promise<{ rows: NeutralProduct[]; total: number; capped: boolean }>): ShopCheck[] {
  return listCustom().map(c => ({
    id: c.id, area: c.area, scopes: ['products'], platforms: 'all',
    run: async (_sw, ctx) => customFinding(c, await scan(ctx?.reader)),
  }));
}

/** All checks of the platform for management and pass (built-in + custom, with state) */
export function checkList(platform: PlatformKind): CheckListItem[] {
  const off = disabledChecks();
  const builtin = listChecks(platform).map((c): CheckListItem => ({ id: c.id, title: builtinTitle(c.id), area: c.area, enabled: !off.has(c.id), custom: false }));
  const custom = listCustom().map((c): CheckListItem => ({ id: c.id, title: c.title, area: c.area, enabled: !off.has(c.id), custom: true, severity: c.severity, rule: conditionsText(c) }));
  return [...builtin, ...custom];
}
