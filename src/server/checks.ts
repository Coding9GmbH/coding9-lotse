import 'server-only';
// Registry of shop checks (home page "Shop-Check"). Feature modules register their checks on import:
// registerCheck({ id, area, run }): run reads ONLY via the protected read client and returns findings (CheckFinding).
// platforms: which shop platforms the check applies to (default Shopware; 'all' = uses only ctx.lookup or nothing shop-specific).
import type { CheckFinding, ScopeKey } from '@/lib/protocol';
import type { PlatformKind } from '@/lib/platforms';
import type { ShopLookup } from './platform/types';
import type { ShopReader } from './shopware';
import { singleton } from './state';

/** Per run: platform + neutral read functions + the platform's read client (Shopware: same as the first parameter) */
export interface CheckCtx { platform: PlatformKind; lookup: ShopLookup; reader: unknown }

export interface ShopCheck {
  id: string;
  area: string;
  /** required AI access scopes; if one is disabled in the settings, the check is skipped */
  scopes?: ScopeKey[];
  /** Default ['shopware'] */
  platforms?: PlatformKind[] | 'all';
  /** null/[] = nothing to report (e.g. not configured). sw: Shopware read client (other platforms: ctx.reader) */
  run: (sw: ShopReader, ctx?: CheckCtx) => Promise<CheckFinding | CheckFinding[] | null>;
}

const CHECKS = singleton('shop-checks', () => new Map<string, ShopCheck>());
export const registerCheck = (c: ShopCheck) => { CHECKS.set(c.id, c); };
export const checkPlatforms = (c: Pick<ShopCheck, 'platforms'>) => c.platforms ?? ['shopware'];
/** All registered checks, or those of one platform */
export const listChecks = (platform?: PlatformKind): ShopCheck[] => [...CHECKS.values()].filter(c => { const p = checkPlatforms(c); return !platform || p === 'all' || p.includes(platform); });
/** Check for another platform: run receives its read client (type R) and the context */
export const registerPlatformCheck = <R>(platform: PlatformKind, c: Omit<ShopCheck, 'run' | 'platforms'> & { run: (reader: R, ctx: CheckCtx) => Promise<CheckFinding | CheckFinding[] | null> }) =>
  registerCheck({ ...c, platforms: [platform], run: (_sw, ctx) => { if (!ctx) throw new Error(`${c.id}: Kontext fehlt`); return c.run(ctx.reader as R, ctx); } });
