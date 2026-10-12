import 'server-only';
// Register der Shop-Plattformen. Genau ein Shop ist verbunden: getSettings().platform (Standard shopware, Umgebung SHOP_PLATFORM).
// Jede Session merkt sich ihre Plattform (session.platform); Änderungssets und Rückgängig-Schritte tragen sie mit (platform-Feld).
import type { UndoOp } from '@/lib/protocol';
import { isPlatformKind, PLATFORM_KINDS, type PlatformKind } from '@/lib/platforms';
import { storedPlatform, type Settings } from '../settings';
import { magento } from './magento';
import { openmage } from './openmage';
import { shopify } from './shopify';
import { shopware } from './shopware';
import type { PlatformAdapter } from './types';

export const ADAPTERS: Record<PlatformKind, PlatformAdapter> = { shopware, shopify, magento, openmage };

/** Adapter einer Plattform bzw. der in den Einstellungen gewählten */
export function getPlatform(x: PlatformKind | Pick<Settings, 'platform'> = storedPlatform()): PlatformAdapter { // Standard ohne Entschlüsseln der Zugangsdaten
  const kind = typeof x === 'string' ? x : x.platform;
  if (!isPlatformKind(kind)) throw new Error(`Unbekannte Shop-Plattform „${String(kind)}“ (erlaubt: ${PLATFORM_KINDS.join(', ')})`);
  return ADAPTERS[kind];
}
export const activePlatform = () => getPlatform();
/** Nach dem Speichern der Einstellungen: alle Adapter neu konfigurieren (Shopware: Client + Bild-KI-Konfiguration) */
export const reconfigureAll = () => { for (const a of Object.values(ADAPTERS)) a.reconfigure(); };
export const activeKind = (): PlatformKind => storedPlatform(); // ohne Entschlüsseln der Zugangsdaten

/** Plattform eines Rückgängig-Schritts (Altbestand ohne Feld = shopware) */
export const opPlatform = (op: Pick<UndoOp, 'platform'>): PlatformKind => op.platform ?? 'shopware';

/**
 * Rückgängig über den Adapter der Plattform, zu der die Schritte gehören. Gehören sie nicht zum aktuell verbundenen Shop
 * (Plattform gewechselt), wird nichts ausgeführt – sonst würde ein fremder Shop verändert.
 */
export async function undoWithPlatform(ops: UndoOp[], active: PlatformKind = activeKind(), adapters: Record<PlatformKind, Pick<PlatformAdapter, 'undo' | 'label'>> = ADAPTERS): Promise<{ ok: boolean; error?: string }[]> {
  const kinds = [...new Set(ops.map(opPlatform))];
  if (kinds.length > 1) return ops.map(() => ({ ok: false, error: `Rückgängig-Schritte mehrerer Plattformen (${kinds.join(', ')}): nicht ausführbar.` }));
  const kind = kinds[0] ?? active;
  if (kind !== active) return ops.map(() => ({ ok: false, error: `Die Änderung wurde in ${adapters[kind].label} gemacht, verbunden ist jetzt ${adapters[active].label}. Rückgängig ist nur mit dem ursprünglichen Shop möglich.` }));
  return adapters[kind].undo(ops);
}

export type { PlatformAdapter } from './types';
