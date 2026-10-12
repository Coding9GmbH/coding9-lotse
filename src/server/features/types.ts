import 'server-only';
import type { PlatformKind } from '@/lib/platforms';
import type { Session } from '../sessions';
import type { AnyTool } from '../tool-kit';

/**
 * Feature-Modul: bündelt Werkzeuge eines Fachbereichs (z. B. Produktbilder, Promotionen).
 * Lesen über den geschützten Lese-Client (Shopware: session.sw, andere Plattformen: session.reader; Kern: session.lookup), Schreiben NUR über ein Änderungsset:
 * build…ChangeSet → session.requestChange(cs, payload) → registrierter Applier (registerApplier in changes.ts).
 */
export interface Feature {
  key: string;
  /** Plattformen, für die das Modul gilt: 'all' = Kern (nur plattform-neutrale Schnittstellen wie session.lookup), sonst z. B. ['shopware'] (liest über session.sw) */
  platforms: PlatformKind[] | 'all';
  /** Namen aller Werkzeuge dieses Moduls (ohne mcp__shop__-Präfix), muss zu tools() passen */
  toolNames: string[];
  tools: (session: Session) => AnyTool[];
}
