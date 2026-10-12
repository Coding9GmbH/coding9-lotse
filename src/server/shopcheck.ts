import 'server-only';
// Shop-Check (Startseite): führt alle registrierten Prüfungen mit einem geschützten Lese-Client aus und hält das Ergebnis im kv-Speicher.
// Veraltet nach 6 Std. → beim Besuch im Hintergrund neu; „Neu prüfen“ startet sofort. Es läuft immer höchstens ein Durchlauf.
import type { CheckRun, ShopCheckState } from '@/lib/protocol';
import { errMsg } from './changes';
import { listChecks } from './checks';
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

// Ergebnis gilt nur für denselben Shop und dieselben freigegebenen Bereiche (sonst könnte ein gesperrter Bereich sichtbar bleiben)
const signature = () => { const g = getSettings(); return JSON.stringify(g.platform === 'shopware' ? [g.shopware.url, g.scopes] : [g.platform, g[g.platform].url || g[g.platform].storeDomain, g.scopes]); };

/** Lese-Client wie im Chat (über den Adapter der aktiven Plattform): Freigabeliste, Bereiche aus den Einstellungen, Zugriffsprotokoll unter „shop-check“. */
export const checkReader = (): ShopReader => activePlatform().openSession('shop-check').reader as ShopReader;

export function cachedRun(): CheckRun | null {
  const c = kvGet<Cached>(KEY);
  return c && c.sig === signature() ? c.run : null;
}
// Unvollständiger Durchlauf (mind. die Hälfte gescheitert, z. B. Shop nicht erreichbar): nach 5 Min. erneut versuchen
export const isStale = (r: CheckRun | null) => !r || Date.now() - new Date(r.checkedAt).getTime() > (runHealth(r) === 'unvollstaendig' ? 5 * 60_000 : STALE_MS);
/** Fehlermeldungen ohne Zugangsdaten (gehen an Oberfläche und KI) */
export const redactRun = (r: CheckRun): CheckRun => (r.errors.length ? { ...r, errors: r.errors.map(e => ({ check: e.check, error: redact(e.error) })) } : r);

/** Startet einen Durchlauf (oder liefert den laufenden). Feature-Module werden vorher geladen, damit alle Prüfungen registriert sind. */
export function startShopCheck(reader?: ShopReader): Promise<CheckRun> {
  const s = st();
  if (s.running) return s.running;
  const sig = signature();
  s.running = (async () => {
    const p = activePlatform();
    await import('./features'); await p.loadChecks();
    // Lese-Client je Durchlauf frisch vom Adapter; Shopware hüllt ihn zusätzlich ein (perRun), damit Zwischenspeicher nur für diesen Durchlauf gelten
    const run = await runChecks(reader ?? checkReader(), listChecks(p.kind), { scopes: getSettings().scopes, concurrency: 3, timeoutMs: 90_000, ctx: r => ({ platform: p.kind, reader: r, lookup: p.lookup(r) }), perRun: p.kind === 'shopware' });
    if (sig === signature()) kvSet(KEY, { sig, run } satisfies Cached);
    s.error = null;
    return run;
  })().catch(e => { s.error = errMsg(e); throw e; }).finally(() => { s.running = null; });
  return s.running;
}

/**
 * Nach angewendeten Änderungen neu prüfen: Behobene Punkte verschwinden, ohne dass jemand „Neu prüfen“ klickt.
 * Läuft gerade ein Durchlauf, hat er womöglich noch den alten Stand gelesen → direkt danach noch einmal.
 */
export function recheckShopCheck(): void {
  const p = activePlatform(), s = st();
  // Ohne bisheriges Ergebnis nichts anstoßen: die Startseite prüft dann ohnehin beim nächsten Besuch
  if (!p.configured() || !p.settings.available || (!s.running && !cachedRun())) return;
  if (s.running) { s.again = true; return; }
  startShopCheck().catch(() => {}).finally(() => {
    if (!s.again) return;
    s.again = false;
    recheckShopCheck();
  });
}

/** Stand für die Startseite; veraltet/fehlend → Hintergrundlauf anstoßen. */
export function shopCheckState({ refresh = false }: { refresh?: boolean } = {}): ShopCheckState {
  const p = activePlatform(), enabled = p.configured() && p.settings.available;
  if (!enabled) return { enabled, running: false, stale: false, run: null };
  const run = cachedRun(), stale = isStale(run);
  if (refresh || stale) startShopCheck().catch(() => {}); // Fehler je Prüfung stehen im Ergebnis; Totalausfall (Shop weg) → beim nächsten Besuch erneut
  const error = st().error;
  return { enabled, running: !!st().running, stale, run: run && redactRun(run), ...(error ? { error: redact(error) } : {}) };
}

/** Für das KI-Werkzeug: frisches Ergebnis aus dem Speicher oder jetzt prüfen. Immer mit eigenem Lese-Client wie die Startseite
 *  (nicht dem langlebigen des Chats), damit das gespeicherte Ergebnis für beide gleich entsteht und unter „shop-check“ protokolliert wird. */
export async function latestShopCheck(refresh = false): Promise<CheckRun> {
  const run = cachedRun();
  if (!refresh && run && !isStale(run)) return redactRun(run);
  return redactRun(await startShopCheck());
}
