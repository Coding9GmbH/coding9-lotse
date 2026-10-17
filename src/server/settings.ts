import 'server-only';
// Settings: shop platform + access (Shopware, Shopify, Magento, OpenMage), AI access, image AI, AI access scopes. Secrets are stored encrypted in the DB (db.ts); they never leave the server towards the AI.
import type { AiProvider, PlatformPublic, PublicSettings, ScopeInfo, ScopeKey, SettingsPatch } from '@/lib/protocol';
import { DEFAULT_PLATFORM, isPlatformKind, PLATFORM_KINDS, PLATFORM_SETTINGS, platformConfigured, platformFields, plainKeys, secretKeys, type PlatformKind } from '@/lib/platforms';
import { openWithoutPassword } from './access';
import { codexLoggedIn } from './codex';
import path from 'node:path';
import { dataDir, kvGet, kvSet, seal, unseal } from './db';
import { DEFAULT_SCOPES, SCOPES, SCOPE_KEYS, type Scopes } from './policy';
import type { ShopwareConfig } from './shopware';

const env = process.env;
export const inDocker = () => env.AICB_DOCKER === '1';

type Section = Record<string, string>;
interface StoredSettings { platform?: string; shopware?: Section; shopify?: Section; magento?: Section; openmage?: Section; ai?: Section; image?: Section; scopes?: Partial<Scopes> }
/** Access of a platform as key → value (fields per lib/platforms.ts, secrets decrypted) */
export type PlatformConfig = Record<string, string>;
type GenericKind = Exclude<PlatformKind, 'shopware'>;
const stored = () => kvGet<StoredSettings>('settings') ?? {};
const pick = (...v: (string | null | undefined)[]): string => v.find(x => x !== undefined && x !== null && x !== '') ?? '';

export interface Settings {
  /** active platform: exactly one shop is connected (stored, else SHOP_PLATFORM, else shopware) */
  platform: PlatformKind;
  shopware: ShopwareConfig;
  shopify: PlatformConfig;
  magento: PlatformConfig;
  openmage: PlatformConfig;
  /** budget: monthly cost limit in USD (text as entered, '' = none; usage.ts parses it) */
  ai: { provider: AiProvider; apiKey: string; model: string; codexModel: string; budget: string };
  image: { openaiKey: string; model: string };
  scopes: Scopes;
}

const kindOf = (s: StoredSettings): PlatformKind => (isPlatformKind(s.platform) ? s.platform : isPlatformKind(env.SHOP_PLATFORM) ? env.SHOP_PLATFORM : DEFAULT_PLATFORM);
/** Connected platform without decrypting the credentials (runs on every session access) */
export const storedPlatform = (): PlatformKind => kindOf(stored());

export const getSettings = (): Settings => settingsOf(stored()); // decrypted, use only inside the server
function settingsOf(s: StoredSettings): Settings {
  const sw = s.shopware ?? {}, ai = s.ai ?? {}, im = s.image ?? {};
  return {
    platform: kindOf(s),
    shopify: genericConfig('shopify', s.shopify), magento: genericConfig('magento', s.magento), openmage: genericConfig('openmage', s.openmage),
    shopware: { url: pick(sw.url, env.SHOPWARE_URL), publicUrl: pick(sw.publicUrl, env.SHOPWARE_PUBLIC_URL), user: pick(sw.user, env.SHOPWARE_USER), password: pick(unseal(sw.password), envSecret('shopware', sw, 'SHOPWARE_PASSWORD')), clientId: pick(sw.clientId, env.SHOPWARE_CLIENT_ID), clientSecret: pick(unseal(sw.clientSecret), envSecret('shopware', sw, 'SHOPWARE_CLIENT_SECRET')) },
    ai: { provider: pick(ai.provider, env.AI_PROVIDER) === 'codex' ? 'codex' : 'claude', apiKey: pick(unseal(ai.apiKey)), model: pick(ai.model, env.AI_MODEL), codexModel: pick(ai.codexModel, env.CODEX_MODEL), budget: pick(ai.budget, env.LOTSE_AI_BUDGET_USD) },
    image: { openaiKey: pick(unseal(im.openaiKey), env.OPENAI_API_KEY), model: pick(im.model, env.IMAGE_MODEL) },
    scopes: { ...DEFAULT_SCOPES, ...(s.scopes ?? {}) },
  };
}

// Shopify/Magento/OpenMage: fields per description; fallback to the field's environment variable
function genericConfig(kind: GenericKind, sec: Section = {}): PlatformConfig {
  return Object.fromEntries(platformFields(kind).map(f => [f.key, f.secret ? pick(unseal(sec[f.key]), envSecret(kind, sec, f.env)) : pick(sec[f.key], f.env ? env[f.env] : undefined)]));
}

// Credentials belong to the address they are sent to (API base per platform). If its origin changes, mergeSettings discards the stored
// secrets (unless new ones come in the same patch); otherwise a compromised UI could send them to a foreign host via "Verbindung testen" (test connection).
const CONN_URL: Record<PlatformKind, string> = { shopware: 'url', shopify: 'storeDomain', magento: 'url', openmage: 'url' };
const connEnv = (kind: PlatformKind) => platformFields(kind).find(f => f.key === CONN_URL[kind])?.env;
/** Origin of a shop address (scheme, host, port; lower case). Domain without scheme (Shopify) = https. */
export function shopOrigin(v: string | undefined): string {
  const s = (v ?? '').trim(); if (!s) return '';
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).origin.toLowerCase(); } catch { return s.toLowerCase(); }
}
/** Parked credentials: { origin, <field>: sealed }; not in effect, they only come back when the address points exactly there again.
 *  So a briefly cleared or mistyped address field (auto-save) deletes nothing permanently, and they never go to a foreign address. */
const PARKED = '_parked';
function parkSecrets(sec: Section, secret: string[], before: string, after: string) {
  const held = secret.filter(k => sec[k]);
  if (before && held.length) { sec[PARKED] = JSON.stringify({ origin: before, ...Object.fromEntries(held.map(k => [k, sec[k]])) }); for (const k of held) delete sec[k]; return; }
  if (held.length || !sec[PARKED]) return;
  let parked: Record<string, string> = {}; try { parked = JSON.parse(sec[PARKED]); } catch {}
  if (after && parked.origin === after) { for (const k of secret) if (parked[k]) sec[k] = parked[k]; delete sec[PARKED]; }
}
/** Effective connection address of a platform (stored, else environment) */
const connOrigin = (kind: PlatformKind, sec: Section = {}) => { const e = connEnv(kind); return shopOrigin(pick(sec[CONN_URL[kind]], e ? env[e] : undefined)); };
/** Secret from the environment only for the address from the environment: if the stored URL points elsewhere, it is left out. */
function envSecret(kind: PlatformKind, sec: Section, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const e = connEnv(kind), envUrl = e ? env[e] : undefined;
  return !envUrl || connOrigin(kind, sec) === shopOrigin(envUrl) ? env[name] : undefined;
}
/** Access of a platform as key → value (Shopware: ShopwareConfig) */
export const platformConfig = (kind: PlatformKind, g = getSettings()): PlatformConfig => (kind === 'shopware' ? { ...g.shopware } : g[kind]);
const shopwareConfigured = (c: ShopwareConfig) => !!(c.url && ((c.user && c.password) || (c.clientId && c.clientSecret)));
/** Platform access complete (says nothing about whether the shop is reachable) */
export const shopConfigured = (kind: PlatformKind = getSettings().platform, g = getSettings()) => (kind === 'shopware' ? shopwareConfigured(g.shopware) : platformConfigured(kind, g[kind]));

function platformPublic(kind: PlatformKind, g: Settings): PlatformPublic {
  const c = platformConfig(kind, g);
  return {
    label: PLATFORM_SETTINGS[kind].label, available: PLATFORM_SETTINGS[kind].available, configured: shopConfigured(kind, g),
    values: Object.fromEntries(plainKeys(kind).map(k => [k, c[k] ?? ''])), has: Object.fromEntries(secretKeys(kind).map(k => [k, !!c[k]])),
  };
}

/** AI access available: Codex signed in or Anthropic API key (settings or environment). A Claude subscription is deliberately not supported
 *  (Anthropic doesn't allow third-party products built on the Agent SDK to use claude.ai login without approval). */
export const aiConfigured = (g = getSettings()) => (g.ai.provider === 'codex' ? codexLoggedIn() : !!(g.ai.apiKey || env.ANTHROPIC_API_KEY));

export function publicSettings(): PublicSettings { // masked, for the UI
  const g = getSettings();
  return {
    shopware: { url: g.shopware.url, publicUrl: g.shopware.publicUrl, user: g.shopware.user, clientId: g.shopware.clientId, hasPassword: !!g.shopware.password, hasClientSecret: !!g.shopware.clientSecret, configured: shopwareConfigured(g.shopware) },
    platform: g.platform,
    platforms: Object.fromEntries(PLATFORM_KINDS.map(k => [k, platformPublic(k, g)])),
    ai: { provider: g.ai.provider, hasApiKey: !!g.ai.apiKey, model: g.ai.model, viaEnv: !!env.ANTHROPIC_API_KEY, docker: inDocker(), codexModel: g.ai.codexModel, codexLoggedIn: codexLoggedIn(), budget: g.ai.budget, budgetViaEnv: !stored().ai?.budget && !!env.LOTSE_AI_BUDGET_USD },
    image: { hasKey: !!g.image.openaiKey, model: g.image.model },
    scopes: g.scopes,
    scopeInfo: Object.fromEntries(SCOPE_KEYS.map(k => [k, { label: SCOPES[k].label, hint: SCOPES[k].hint }])) as Record<ScopeKey, ScopeInfo>,
    openWithoutPassword: openWithoutPassword(env),
  };
}

export const updateSettings = (p: SettingsPatch = {}) => { kvSet('settings', mergeSettings(stored(), p)); };
/** Stored state + patch, without writing (api/settings uses this to check up front what changes in the shop connection) */
function mergeSettings(s: StoredSettings, p: SettingsPatch): StoredSettings {
  const out: StoredSettings = { ...s };
  const section = <K extends 'shopware' | 'shopify' | 'magento' | 'openmage' | 'ai' | 'image'>(name: K, plain: string[], secret: string[]) => {
    const patch = p[name] as Record<string, string | null | undefined> | undefined;
    if (!patch) return; const sec: Section = { ...(s[name] ?? {}) }; out[name] = sec;
    for (const k of plain) if (patch[k] !== undefined) sec[k] = String(patch[k]).trim();
    if (name !== 'ai' && name !== 'image') { // shop address with a different origin: discard stored secrets (new ones from the patch apply)
      const kind = name as PlatformKind, before = connOrigin(kind, s[kind]), after = connOrigin(kind, sec);
      if (before !== after) parkSecrets(sec, secret, before, after);
    }
    let fresh = false;
    for (const k of secret) { const v = patch[k]; if (v === null) delete sec[k]; else if (v !== undefined && v !== '') { const sealed = seal(String(v).trim()); if (sealed) { sec[k] = sealed; fresh = true; } } } // empty = unchanged, null = delete
    if (fresh) delete sec[PARKED]; // newly entered: parked old credentials are obsolete
  };
  if (p.platform !== undefined && isPlatformKind(p.platform)) out.platform = p.platform;
  section('shopware', ['url', 'publicUrl', 'user', 'clientId'], ['password', 'clientSecret']);
  for (const k of ['shopify', 'magento', 'openmage'] as const) section(k, plainKeys(k), secretKeys(k));
  section('ai', ['provider', 'model', 'codexModel', 'budget'], ['apiKey']);
  if (out.ai?.oauthToken) { out.ai = { ...out.ai }; delete out.ai.oauthToken; } // legacy data: Claude subscription token is no longer supported
  if (out.ai?.provider && out.ai.provider !== 'codex') out.ai.provider = 'claude';
  section('image', ['model'], ['openaiKey']);
  if (p.scopes) out.scopes = { ...DEFAULT_SCOPES, ...(s.scopes ?? {}), ...Object.fromEntries(Object.entries(p.scopes).filter(([k]) => k in DEFAULT_SCOPES).map(([k, v]) => [k, !!v])) };
  return out;
}

/** Shop connection fields (platform, URLs, credentials) the patch would change, e.g. ['platform', 'shopware.url']; names only, never values */
export function connectionChanges(p: SettingsPatch): string[] {
  const s = stored(), a = settingsOf(s), b = settingsOf(mergeSettings(s, p)), out: string[] = [];
  if (a.platform !== b.platform) out.push('platform');
  for (const k of PLATFORM_KINDS) { const ca = platformConfig(k, a), cb = platformConfig(k, b); for (const f of Object.keys({ ...ca, ...cb })) if ((ca[f] ?? '') !== (cb[f] ?? '')) out.push(`${k}.${f}`); }
  return out;
}

// Environment for the AI process (Claude): allowlist instead of denylist. Only what the agent process needs to run (paths, language, proxy, certificates,
// Anthropic/Claude variables); credentials of other services (SHOPWARE_*, OPENAI_*, AWS_*, GITHUB_TOKEN, DATABASE_URL, SMTP_* …) never reach it.
// API key only: no subscription token, no claude.ai login of the machine, own config directory in the data folder.
const AI_ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|COLORTERM|LANG|LANGUAGE|LC_\w+|TZ|TMPDIR|TMP|TEMP|PWD|HOSTNAME|NODE_\w+|HTTPS?_PROXY|NO_PROXY|SSL_CERT_(FILE|DIR)|ANTHROPIC_\w+|CLAUDE_\w+|DISABLE_\w+|MAX_THINKING_TOKENS|API_TIMEOUT_MS|MCP_\w+|SYSTEMROOT|SYSTEMDRIVE|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|PROGRAMFILES|PROGRAMDATA)$/i;
const AI_ENV_DENY = /^(ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR)$/i;
// Bedrock/Vertex behind the Agent SDK: their access only if explicitly enabled
const PROVIDER_ENV = /^(AWS_|GOOGLE_|GCLOUD_|CLOUD_ML_REGION$)/i;
export function aiEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  const provider = env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_VERTEX === '1';
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !AI_ENV_DENY.test(k) && (AI_ENV_ALLOW.test(k) || (provider && PROVIDER_ENV.test(k)))) e[k] = v;
  e.CLAUDE_CONFIG_DIR = path.join(dataDir(), 'claude');
  const g = getSettings();
  if (g.ai.apiKey) e.ANTHROPIC_API_KEY = g.ai.apiKey;
  return e;
}

// Remove secrets from error messages before anything goes to the AI
const encodings = (v: string | null | undefined): (string | null | undefined)[] => {
  if (!v || v.length <= 3) return [v];
  const b = Buffer.from(v), hex = b.toString('hex');
  return [v, b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), hex, hex.toUpperCase()];
};
export function redact(text: unknown): string {
  let t = String(text ?? ''); const g = getSettings();
  const shopSecrets = (['shopify', 'magento', 'openmage'] as const).flatMap(k => secretKeys(k).map(f => g[k][f]));
  const sistrixKey = unseal(kvGet<{ key?: string }>('sistrix')?.key);
  const githubToken = unseal(kvGet<{ token?: string }>('github')?.token); // also as the Basic credential git sends
  const githubBasic = githubToken ? Buffer.from(`x-access-token:${githubToken}`).toString('base64') : null;
  // sandbox env vars marked secret, also base64/hex encoded: code in the container can read them (defense in depth only, no guarantee)
  const sandboxSecrets = (kvGet<{ envVars?: { secret?: boolean; value?: string }[] }>('sandbox')?.envVars ?? []).filter(v => v.secret).map(v => unseal(v.value)).flatMap(encodings);
  for (const v of [g.shopware.password, g.shopware.clientSecret, ...shopSecrets, g.ai.apiKey, g.image.openaiKey, sistrixKey, githubToken, githubBasic, ...sandboxSecrets]) if (v && v.length > 3) t = t.split(v).join('•••');
  return t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer •••').replace(/(Authorization:\s*Basic\s+)[A-Za-z0-9+/=]{8,}/gi, '$1•••').replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-•••')
    .replace(/\b(github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}/g, '$1•••').replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1•••@');
}
