import 'server-only';
import type { PlatformKind } from '@/lib/platforms';
import type { Session } from '../sessions';
import type { AnyTool } from '../tool-kit';

/**
 * Feature module: bundles the tools of one domain (e.g. product images, promotions).
 * Reads via the protected read client (Shopware: session.sw, other platforms: session.reader; core: session.lookup), writes ONLY via a change set:
 * build…ChangeSet → session.requestChange(cs, payload) → registered applier (registerApplier in changes.ts).
 */
export interface Feature {
  key: string;
  /** Platforms the module applies to: 'all' = core (only platform-neutral interfaces like session.lookup), otherwise e.g. ['shopware'] (reads via session.sw) */
  platforms: PlatformKind[] | 'all';
  /** Names of all tools of this module (without mcp__shop__ prefix), must match tools() */
  toolNames: string[];
  tools: (session: Session) => AnyTool[];
}
