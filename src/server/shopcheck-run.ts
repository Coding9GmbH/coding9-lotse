import 'server-only';
// Shop check (pure): run registered checks with a time limit, limited concurrency and error isolation.
import type { CheckFinding, CheckRun, CheckSeverity, ScopeKey } from '@/lib/protocol';
import { errMsg, pool } from './changes';
import type { CheckCtx, ShopCheck } from './checks';
import type { ShopReader } from './shopware';

export const SEVERITY_ORDER: Record<CheckSeverity, number> = { hoch: 0, mittel: 1, niedrig: 2 };
export const SAMPLE_MAX = 5;

/** ctx: context per run (gets this run's read client); perRun: false = don't wrap the read client (other platforms provide a fresh one per run) */
export interface RunOpts { scopes?: Partial<Record<ScopeKey, boolean>>; timeoutMs?: number; concurrency?: number; now?: () => number; ctx?: (reader: ShopReader) => CheckCtx; perRun?: boolean }

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const to = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: Zeitlimit (${Math.round(ms / 1000)} s) überschritten`)), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}

/** Clean up a finding: area from the check, integer numbers, max. 5 examples. null = nothing to report. */
export function normalizeFinding(f: CheckFinding | null | undefined, check: Pick<ShopCheck, 'area'>): CheckFinding | null {
  if (!f || !f.id || !f.title || !f.fixPrompt) return null;
  const count = Math.max(0, Math.round(Number(f.count) || 0));
  if (!count) return null;
  const total = f.total != null && Number.isFinite(Number(f.total)) ? Math.max(count, Math.round(Number(f.total))) : undefined;
  const severity: CheckSeverity = f.severity in SEVERITY_ORDER ? f.severity : 'mittel';
  return {
    ...f, area: f.area || check.area, severity, count, total,
    sample: (f.sample ?? []).filter(s => s?.id).slice(0, SAMPLE_MAX).map(s => ({ id: String(s.id), label: String(s.label ?? s.id).slice(0, 120) })),
  };
}

/** Important first, then by count */
export const sortFindings = (list: CheckFinding[]) => [...list].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count || a.title.localeCompare(b.title));

/** Own object per run: the checks' caches (WeakMap per read client) thus only apply to this run,
 *  even if the same read client is checked several times. */
export const perRun = (sw: ShopReader): ShopReader => ({
  get base() { return sw.base; },
  search: (...a) => sw.search(...a), get: (...a) => sw.get(...a), salesChannels: () => sw.salesChannels(), req: (...a) => sw.req(...a),
});

const isDenied = (e: unknown) => !!(e && typeof e === 'object' && (e as { denied?: unknown }).denied === true);

export async function runChecks(reader: ShopReader, checks: ShopCheck[], o: RunOpts = {}): Promise<CheckRun> {
  const sw = o.perRun === false ? reader : perRun(reader), ctx = o.ctx?.(sw);
  const now = o.now ?? Date.now, t0 = now();
  const allowed = (c: ShopCheck) => !c.scopes?.some(s => o.scopes && o.scopes[s] === false);
  const run = checks.filter(allowed), skipped = checks.filter(c => !allowed(c)).map(c => c.id);
  const errors: CheckRun['errors'] = [], findings: CheckFinding[] = [];
  await pool(run, Math.max(1, o.concurrency ?? 3), async c => {
    try {
      const out = await withTimeout(Promise.resolve().then(() => c.run(sw, ctx)), o.timeoutMs ?? 90_000, c.id);
      for (const f of [out ?? []].flat()) { const n = normalizeFinding(f, c); if (n) findings.push(n); }
    } catch (e) {
      if (isDenied(e)) skipped.push(c.id); // area locked: not an error, just not checked
      else errors.push({ check: c.id, error: errMsg(e).slice(0, 300) });
    }
  });
  const seen = new Set<string>();
  const unique = findings.filter(f => (seen.has(f.id) ? false : (seen.add(f.id), true)));
  return { checkedAt: new Date(now()).toISOString(), findings: sortFindings(unique), errors, durationMs: Math.max(0, now() - t0), checks: run.length, ...(skipped.length ? { skipped } : {}) };
}
