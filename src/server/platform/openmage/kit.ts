import 'server-only';
// Gemeinsame Kern-Hilfen für den OpenMage-Adapter (aus changes.ts), an einer Stelle gebündelt.
export { applyEach, errMsg, MAX_ITEMS, partialTicker, pool, resolvePrice, trackedUndo, WRITE_CONCURRENCY, type ApplyCtx, type ApplyResult, type PriceSpec } from '../../changes';
export { newId as newIdSafe } from '../../shopware';
