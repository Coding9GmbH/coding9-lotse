import 'server-only';
// Registry of shop platforms. Exactly one shop is connected: getSettings().platform (default shopware, env SHOP_PLATFORM).
// Each session remembers its platform (session.platform); change sets and undo steps carry it along (platform field).
import type { UndoOp } from '@/lib/protocol';
import { isPlatformKind, PLATFORM_KINDS, type PlatformKind } from '@/lib/platforms';
import { storedPlatform, type Settings } from '../settings';
import { magento } from './magento';
import { openmage } from './openmage';
import { shopify } from './shopify';
import { shopware } from './shopware';
import type { PlatformAdapter } from './types';

export const ADAPTERS: Record<PlatformKind, PlatformAdapter> = { shopware, shopify, magento, openmage };

/** Adapter of a platform, or of the one selected in the settings */
export function getPlatform(x: PlatformKind | Pick<Settings, 'platform'> = storedPlatform()): PlatformAdapter { // default without decrypting the credentials
  const kind = typeof x === 'string' ? x : x.platform;
  if (!isPlatformKind(kind)) throw new Error(`Unbekannte Shop-Plattform „${String(kind)}“ (erlaubt: ${PLATFORM_KINDS.join(', ')})`);
  return ADAPTERS[kind];
}
export const activePlatform = () => getPlatform();
/** After saving the settings: reconfigure all adapters (Shopware: client + image AI config) */
export const reconfigureAll = () => { for (const a of Object.values(ADAPTERS)) a.reconfigure(); };
export const activeKind = (): PlatformKind => storedPlatform(); // without decrypting the credentials

/** Platform of an undo step (legacy entries without the field = shopware) */
export const opPlatform = (op: Pick<UndoOp, 'platform'>): PlatformKind => op.platform ?? 'shopware';

/**
 * Undo via the adapter of the platform the steps belong to. If they do not belong to the currently connected shop
 * (platform switched), nothing is executed; otherwise a different shop would be modified.
 */
export async function undoWithPlatform(ops: UndoOp[], active: PlatformKind = activeKind(), adapters: Record<PlatformKind, Pick<PlatformAdapter, 'undo' | 'label'>> = ADAPTERS): Promise<{ ok: boolean; error?: string }[]> {
  const kinds = [...new Set(ops.map(opPlatform))];
  if (kinds.length > 1) return ops.map(() => ({ ok: false, error: `Rückgängig-Schritte mehrerer Plattformen (${kinds.join(', ')}): nicht ausführbar.` }));
  const kind = kinds[0] ?? active;
  if (kind !== active) return ops.map(() => ({ ok: false, error: `Die Änderung wurde in ${adapters[kind].label} gemacht, verbunden ist jetzt ${adapters[active].label}. Rückgängig ist nur mit dem ursprünglichen Shop möglich.` }));
  return adapters[kind].undo(ops);
}

export type { PlatformAdapter } from './types';
