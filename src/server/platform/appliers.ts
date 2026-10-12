import 'server-only';
// Applier-Register je Plattform (Shopware nutzt weiter registerApplier in changes.ts): kind des Änderungssets → Schreibfunktion
// mit dem privilegierten Client der Plattform. Nur der Adapter ruft apply() auf, nach menschlicher Freigabe.
import type { ChangeSet } from '@/lib/protocol';
import type { PlatformKind } from '@/lib/platforms';
import type { ApplyCtx, ApplyResult } from '../changes';
import { singleton } from '../state';

export type PlatformApplier<C> = (client: C, cs: ChangeSet, payload: unknown, selected: Set<string>, ctx?: ApplyCtx) => Promise<ApplyResult>;

export function applierRegistry<C>(platform: PlatformKind) {
  const map = singleton(`appliers:${platform}`, () => new Map<string, PlatformApplier<C>>());
  return {
    register: (kind: string, fn: PlatformApplier<C>) => { map.set(kind, fn); },
    has: (kind: string) => map.has(kind),
    kinds: () => [...map.keys()],
    /** unbekannte Art = Fehler (nie still nichts tun) */
    apply(client: C, cs: ChangeSet, payload: unknown, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
      const fn = map.get(cs.kind);
      if (!fn) throw new Error(`Für Änderungsart „${cs.kind}“ gibt es auf ${platform} keinen Executor.`);
      return fn(client, cs, payload, selected, ctx);
    },
  };
}
