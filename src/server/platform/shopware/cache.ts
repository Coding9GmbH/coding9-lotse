import 'server-only';
// Clear the Shopware cache after writing: published pages, metas and prices should appear in the shop immediately, not only when the
// HTTP cache expires. Best effort: an error (e.g. the integration lacks the system:clear:cache permission) never invalidates the apply.
// Can be disabled with LOTSE_CLEAR_CACHE=0 (large shops where a full cache run noticeably slows down the site).
import { log } from '../../log';
import { errMsg } from '../../util';

export const clearCacheEnabled = (env: Record<string, string | undefined> = process.env) => !/^(0|false|off|no)$/i.test((env.LOTSE_CLEAR_CACHE ?? '').trim());

/** Clears the Shopware cache (Admin API DELETE /_action/cache). Returns true on success, never throws. */
export async function clearShopCache(sw: { req(method: string, path: string): Promise<unknown> }, why: string): Promise<boolean> {
  if (!clearCacheEnabled()) return false;
  try { await sw.req('DELETE', '/_action/cache'); log.info('Shopware-Cache geleert', { why }); return true; }
  catch (e) { log.warn('Shopware-Cache konnte nicht geleert werden', { why, error: errMsg(e) }); return false; }
}
