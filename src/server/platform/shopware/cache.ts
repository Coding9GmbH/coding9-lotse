import 'server-only';
// Shopware-Cache nach dem Schreiben leeren: veröffentlichte Seiten, Metas und Preise sollen sofort im Shop stehen und nicht erst, wenn der
// HTTP-Cache abläuft. Best-Effort: ein Fehler (z. B. dem Integrationszugang fehlt das Recht system:clear:cache) macht das Anwenden nie ungültig.
// Abschaltbar mit LOTSE_CLEAR_CACHE=0 (große Shops, bei denen ein vollständiger Cache-Lauf die Seite spürbar verlangsamt).
import { log } from '../../log';
import { errMsg } from '../../util';

export const clearCacheEnabled = (env: Record<string, string | undefined> = process.env) => !/^(0|false|off|no)$/i.test((env.LOTSE_CLEAR_CACHE ?? '').trim());

/** Leert den Shopware-Cache (Admin-API DELETE /_action/cache). Liefert true bei Erfolg, nie eine Ausnahme. */
export async function clearShopCache(sw: { req(method: string, path: string): Promise<unknown> }, why: string): Promise<boolean> {
  if (!clearCacheEnabled()) return false;
  try { await sw.req('DELETE', '/_action/cache'); log.info('Shopware-Cache geleert', { why }); return true; }
  catch (e) { log.warn('Shopware-Cache konnte nicht geleert werden', { why, error: errMsg(e) }); return false; }
}
