import 'server-only';
// Composer credentials entered while a setup waits for them: kept as the secret variable COMPOSER_AUTH of the sandbox environment
// (an auth.json as JSON, sealed like every secret) and handed to the composer process at run time, so no new container is needed.
import { getSecretVar, setSecretVar } from './env';

export const COMPOSER_AUTH_VAR = 'COMPOSER_AUTH';
export const SHOPWARE_PACKAGES_HOST = 'packages.shopware.com';

/** `existing` (the JSON of COMPOSER_AUTH, or null) with a bearer token for `host`; other credentials stay. An unreadable value is replaced. */
export function mergeComposerAuth(existing: string | null, host: string, token: string): string {
  let auth: Record<string, unknown> = {};
  try { const j = JSON.parse(existing ?? '{}'); if (j && typeof j === 'object' && !Array.isArray(j)) auth = j; } catch { /* replaced */ }
  const bearer = auth.bearer && typeof auth.bearer === 'object' && !Array.isArray(auth.bearer) ? auth.bearer as Record<string, unknown> : {};
  return JSON.stringify({ ...auth, bearer: { ...bearer, [host]: token } });
}

/** Stores the token for packages.shopware.com in COMPOSER_AUTH; throws a German message for an empty or unusable token. */
export function saveShopwareToken(token: string): void {
  const t = token.trim();
  if (!t) throw new Error('Bitte den Token eingeben.');
  if (t.length > 2000 || /[\s"\\\x00-\x1f]/.test(t)) throw new Error('Der Token enthält ungültige Zeichen (Leerzeichen, Anführungszeichen oder Zeilenumbrüche).');
  setSecretVar(COMPOSER_AUTH_VAR, mergeComposerAuth(getSecretVar(COMPOSER_AUTH_VAR), SHOPWARE_PACKAGES_HOST, t));
}
