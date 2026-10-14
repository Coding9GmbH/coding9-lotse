import 'server-only';
// Shared core helpers for the OpenMage adapter (from changes.ts), bundled in one place.
export { applyEach, errMsg, MAX_ITEMS, partialTicker, pool, resolvePrice, trackedUndo, WRITE_CONCURRENCY, type ApplyCtx, type ApplyResult, type PriceSpec } from '../../changes';
export { newId as newIdSafe } from '../../shopware';
