import { z } from 'zod';
import { PLATFORM_KINDS, platformFields, type PlatformKind } from '@/lib/platforms';
import { auditAdd } from '@/server/db';
import { jsonError, parseJson } from '@/server/http';
import { reconfigureAll } from '@/server/platform';
import { writesInProgress } from '@/server/sessions';
import { connectionChanges, publicSettings, updateSettings } from '@/server/settings';

export const dynamic = 'force-dynamic';

// Secret: undefined/'' = unchanged, null = delete
const secret = z.string().max(4000).nullable().optional();
const plain = z.string().max(2000).optional();
// Shopify/Magento/OpenMage: exactly the fields from lib/platforms.ts (secrets as above)
const platformSchema = (kind: PlatformKind) => z.object(Object.fromEntries(platformFields(kind).map(f => [f.key, f.secret ? secret : plain]))).optional();
const patchSchema = z.object({
  platform: z.enum(PLATFORM_KINDS as [PlatformKind, ...PlatformKind[]]).optional(),
  shopify: platformSchema('shopify'),
  magento: platformSchema('magento'),
  openmage: platformSchema('openmage'),
  shopware: z.object({ url: plain, publicUrl: plain, user: plain, clientId: plain, password: secret, clientSecret: secret }).optional(),
  ai: z.object({ provider: z.enum(['claude', 'codex']).optional(), model: plain, codexModel: plain, budget: z.string().trim().regex(/^(\d{1,7}([.,]\d{1,2})?)?$/, 'Budget: Betrag in US-Dollar, z. B. 50 oder 49,90').refine(v => v === '' || Number(v.replace(',', '.')) > 0, 'Budget: mehr als 0 US-Dollar, oder leer für keine Grenze').optional(), apiKey: secret }).optional(),
  image: z.object({ model: plain, openaiKey: secret }).optional(),
  scopes: z.record(z.string(), z.boolean()).optional(),
});

export function GET() {
  return Response.json(publicSettings());
}

export async function PUT(req: Request) {
  const body = await parseJson(req, patchSchema);
  if (!body.ok) return body.res;
  const fields = connectionChanges(body.data);
  // Don't switch the shop connection while an approved change is being written or undone (the rest would otherwise run against the wrong shop)
  if (fields.length && writesInProgress()) return jsonError(409, 'Gerade wird eine freigegebene Änderung in den Shop geschrieben. Bitte warte, bis sie abgeschlossen ist, und speichere die Shop-Verbindung danach erneut.');
  updateSettings(body.data);
  reconfigureAll();
  if (fields.length) auditAdd({ decision: 'changed', kind: 'settings', title: 'Shop-Verbindung geändert', fields: Object.fromEntries(fields.map(f => [f, 'geändert'])) }); // field names only, never values
  return Response.json(publicSettings());
}
