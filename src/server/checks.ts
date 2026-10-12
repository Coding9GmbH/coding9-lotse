import 'server-only';
// Register der Shop-Prüfungen (Startseite „Shop-Check“). Feature-Module registrieren ihre Prüfungen beim Import:
// registerCheck({ id, area, run }) – run liest NUR über den geschützten Lese-Client und liefert Befunde (CheckFinding).
// platforms: für welche Shop-Plattformen die Prüfung gilt (Standard Shopware; 'all' = nutzt nur ctx.lookup bzw. nichts Shop-Spezifisches).
import type { CheckFinding, ScopeKey } from '@/lib/protocol';
import type { PlatformKind } from '@/lib/platforms';
import type { ShopLookup } from './platform/types';
import type { ShopReader } from './shopware';
import { singleton } from './state';

/** Je Durchlauf: Plattform + neutrale Lesefunktionen + Lese-Client der Plattform (Shopware: derselbe wie der erste Parameter) */
export interface CheckCtx { platform: PlatformKind; lookup: ShopLookup; reader: unknown }

export interface ShopCheck {
  id: string;
  area: string;
  /** benötigte KI-Zugriffsbereiche; ist einer in den Einstellungen aus, wird die Prüfung übersprungen */
  scopes?: ScopeKey[];
  /** Standard ['shopware'] */
  platforms?: PlatformKind[] | 'all';
  /** null/[] = nichts zu melden (z. B. nicht konfiguriert). sw: Shopware-Lese-Client (andere Plattformen: ctx.reader) */
  run: (sw: ShopReader, ctx?: CheckCtx) => Promise<CheckFinding | CheckFinding[] | null>;
}

const CHECKS = singleton('shop-checks', () => new Map<string, ShopCheck>());
export const registerCheck = (c: ShopCheck) => { CHECKS.set(c.id, c); };
export const checkPlatforms = (c: Pick<ShopCheck, 'platforms'>) => c.platforms ?? ['shopware'];
/** Alle registrierten Prüfungen bzw. die einer Plattform */
export const listChecks = (platform?: PlatformKind): ShopCheck[] => [...CHECKS.values()].filter(c => { const p = checkPlatforms(c); return !platform || p === 'all' || p.includes(platform); });
/** Prüfung einer anderen Plattform: run bekommt deren Lese-Client (Typ R) und den Kontext */
export const registerPlatformCheck = <R>(platform: PlatformKind, c: Omit<ShopCheck, 'run' | 'platforms'> & { run: (reader: R, ctx: CheckCtx) => Promise<CheckFinding | CheckFinding[] | null> }) =>
  registerCheck({ ...c, platforms: [platform], run: (_sw, ctx) => { if (!ctx) throw new Error(`${c.id}: Kontext fehlt`); return c.run(ctx.reader as R, ctx); } });
