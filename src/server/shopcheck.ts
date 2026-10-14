import 'server-only';
// Shop check (home page): runs all registered checks with a protected read client and keeps the result in the kv store.
// Stale after 6 h → rerun in the background on visit; "Neu prüfen" (check again) starts immediately. At most one run at a time.
import type { CheckRun, ShopCheckState } from '@/lib/protocol';
import { errMsg } from './changes';
import { listChecks } from './checks';
import { customShopChecks, disabledChecks } from './custom-checks';
import { kvGet, kvSet } from './db';
import { activePlatform } from './platform';
import { runHealth } from '@/lib/shopcheck';
import { getSettings, redact } from './settings';
import type { ShopReader } from './shopware';
import { runChecks } from './shopcheck-run';
import { singleton } from './state';

export const STALE_MS = 6 * 3600_000;
const KEY = 'shopcheck_run';
interface Cached { sig: string; run: CheckRun }
const st = () => singleton('shopcheck', () => ({ running: null as Promise<CheckRun> | null, error: null as string | null, again: false }));

// Result only applies to the same shop and the same enabled areas (otherwise a locked area could stay visible)
const signature = () => { const g = getSettings(); return JSON.stringify(g.platform === 'shopware' ? [g.shopware.url, g.scopes] : [g.platform, g[g.platform].url || g[g.platform].storeDomain, g.scopes]); };

/** Read client as in the chat (via the active platform's adapter): allowlist, areas from the settings, access log under "shop-check". */
export const checkReader = (): ShopReader => activePlatform().openSession('shop-check').reader as ShopReader;

export function cachedRun(): CheckRun | null {
  const c = kvGet<Cached>(KEY);
  return c && c.sig === signature() ? c.run : null;
}
// Incomplete run (at least half failed, e.g. shop unreachable): retry after 5 min
export const isStale = (r: CheckRun | null) => !r || Date.now() - new Date(r.checkedAt).getTime() > (runHealth(r) === 'unvollstaendig' ? 5 * 60_000 : STALE_MS);
/** Error messages without credentials (go to the UI and the AI) */
export const redactRun = (r: CheckRun): CheckRun => (r.errors.length ? { ...r, errors: r.errors.map(e => ({ check: e.check, error: redact(e.error) })) } : r);

/** Starts a run (or returns the running one). Feature modules are loaded first so all checks are registered. */
export function startShopCheck(reader?: ShopReader): Promise<CheckRun> {
  const s = st();
  if (s.running) return s.running;
  const sig = signature();
  s.running = (async () => {
    const p = activePlatform();
    await import('./features'); await p.loadChecks();
    // Read client fresh from the adapter per run; Shopware additionally wraps it (perRun) so caches only apply to this run
    // On/off per check and custom checks (the platform provides the neutral product rows)
    const off = disabledChecks(), checks = [...listChecks(p.kind), ...customShopChecks(r => p.scanProducts(r))].filter(c => !off.has(c.id));
    const run = await runChecks(reader ?? checkReader(), checks, { scopes: getSettings().scopes, concurrency: 3, timeoutMs: 90_000, ctx: r => ({ platform: p.kind, reader: r, lookup: p.lookup(r) }), perRun: p.kind === 'shopware' });
    if (sig === signature()) kvSet(KEY, { sig, run } satisfies Cached);
    s.error = null;
    return run;
  })().catch(e => { s.error = errMsg(e); throw e; }).finally(() => { s.running = null; });
  return s.running;
}

/**
 * Recheck after applied changes: fixed items disappear without anyone clicking "Neu prüfen" (check again).
 * If a run is in progress, it may have read the old state → run once more right after.
 */
export async function recheckShopCheck(reader?: ShopReader): Promise<void> {
  const p = activePlatform(), s = st();
  // Without a previous result, trigger nothing: the home page checks on the next visit anyway
  if (!p.configured() || !p.settings.available || (!s.running && !cachedRun())) return;
  if (s.running) {
    if (s.again) return; // a follow-up run is already queued
    s.again = true;
    await s.running.catch(() => {});
    s.again = false;
    return recheckShopCheck(reader);
  }
  await startShopCheck(reader).catch(() => {});
}

/** State for the home page; stale/missing → trigger a background run. */
export function shopCheckState({ refresh = false }: { refresh?: boolean } = {}): ShopCheckState {
  const p = activePlatform(), enabled = p.configured() && p.settings.available;
  if (!enabled) return { enabled, running: false, stale: false, run: null };
  const run = cachedRun(), stale = isStale(run);
  if (refresh || stale) startShopCheck().catch(() => {}); // errors per check are in the result; total failure (shop gone) → retry on the next visit
  const error = st().error;
  return { enabled, running: !!st().running, stale, run: run && redactRun(run), ...(error ? { error: redact(error) } : {}) };
}

/** For the AI tool: fresh result from storage or check now. Always with its own read client like the home page
 *  (not the chat's long-lived one), so the stored result is produced the same way for both and logged under "shop-check". */
export async function latestShopCheck(refresh = false): Promise<CheckRun> {
  const run = cachedRun();
  if (!refresh && run && !isStale(run)) return redactRun(run);
  return redactRun(await startShopCheck());
}
