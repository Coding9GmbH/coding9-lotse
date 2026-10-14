import { DEFAULT_LOCALE, messages, type Locale } from './i18n';
import { activeAuthMode, PLATFORM_KINDS, PLATFORM_SETTINGS, plainKeys, secretKeys, type PlatformKind } from './platforms';
import type { AiProvider, PlatformPatch, PublicSettings, ScopeKey, SettingsPatch } from './protocol';

// Form state of the settings. Secrets are never prefilled:
// empty field = unchanged, "Entfernen" (remove) = null (delete), input = new value.

export interface SecretInput { value: string; remove: boolean }
export type SecretKey = 'clientSecret' | 'password' | 'apiKey' | 'openaiKey';
export type ShopwareAuth = 'integration' | 'user';
/** Platforms with a generic form (fields from lib/platforms.ts); Shopware has its own fixed fields */
export type GenericPlatform = Exclude<PlatformKind, 'shopware'>;
export const GENERIC_PLATFORMS = PLATFORM_KINDS.filter((k): k is GenericPlatform => k !== 'shopware');

export interface SettingsForm {
  /** selected shop platform (exactly one shop is connected) */
  platform: PlatformKind;
  shopware: { url: string; publicUrl: string; clientId: string; user: string; auth: ShopwareAuth };
  /** plain-text fields + selected access type per platform */
  platforms: Record<GenericPlatform, { values: Record<string, string>; auth: string }>;
  /** platform secrets, key "platform.field" */
  platformSecrets: Record<string, SecretInput>;
  ai: { provider: AiProvider; model: string; codexModel: string };
  image: { model: string };
  scopes: Record<ScopeKey, boolean>;
  secrets: Record<SecretKey, SecretInput>;
}

const emptySecret = (): SecretInput => ({ value: '', remove: false });

export function formFromSettings(s: PublicSettings): SettingsForm {
  const sw = s.shopware;
  const platforms = Object.fromEntries(GENERIC_PLATFORMS.map(k => {
    const pub = s.platforms?.[k], values = Object.fromEntries(plainKeys(k).map(f => [f, pub?.values[f] ?? '']));
    return [k, { values, auth: activeAuthMode(k, { ...values, ...(pub?.has ?? {}) }) }];
  })) as SettingsForm['platforms'];
  return {
    platform: s.platform ?? 'shopware',
    platforms,
    platformSecrets: Object.fromEntries(GENERIC_PLATFORMS.flatMap(k => secretKeys(k).map(f => [`${k}.${f}`, emptySecret()]))),
    shopware: { url: sw.url, publicUrl: sw.publicUrl, clientId: sw.clientId, user: sw.user, auth: sw.clientId || !sw.user ? 'integration' : 'user' },
    ai: { provider: s.ai.provider, model: s.ai.model, codexModel: s.ai.codexModel },
    image: { model: s.image.model },
    scopes: { ...s.scopes },
    secrets: { clientSecret: emptySecret(), password: emptySecret(), apiKey: emptySecret(), openaiKey: emptySecret() },
  };
}

const secret = (x: SecretInput): string | null | undefined => (x.remove ? null : x.value.trim() || undefined);

export function buildPatch(f: SettingsForm): SettingsPatch {
  const s = f.secrets;
  const generic = (k: GenericPlatform): PlatformPatch => ({
    ...Object.fromEntries(plainKeys(k).map(n => [n, (f.platforms[k].values[n] ?? '').trim()])),
    ...Object.fromEntries(secretKeys(k).map(n => [n, secret(f.platformSecrets[`${k}.${n}`] ?? emptySecret())])),
  });
  return {
    platform: f.platform,
    shopify: generic('shopify'),
    magento: generic('magento'),
    openmage: generic('openmage'),
    shopware: { url: f.shopware.url.trim(), publicUrl: f.shopware.publicUrl.trim(), clientId: f.shopware.clientId.trim(), user: f.shopware.user.trim(), clientSecret: secret(s.clientSecret), password: secret(s.password) },
    ai: { provider: f.ai.provider, model: f.ai.model, codexModel: f.ai.codexModel.trim(), apiKey: secret(s.apiKey) },
    image: { model: f.image.model.trim(), openaiKey: secret(s.openaiKey) },
    scopes: { ...f.scopes },
  };
}

/** Does the form have changes compared to the saved state? */
export const isDirty = (f: SettingsForm, saved: PublicSettings): boolean =>
  JSON.stringify(buildPatch(f)) !== JSON.stringify(buildPatch(formFromSettings(saved)));

// ---- Autosave ----
// A platform switch only takes effect once the selected platform is set up (credentials saved);
// otherwise the shop would be disconnected just by switching the tab. Until then Lotse only saves its fields.

/** Selected platform is still waiting for its credentials; the saved one stays connected. */
export const platformPending = (f: SettingsForm, saved: PublicSettings): boolean =>
  f.platform !== (saved.platform ?? 'shopware') && !savedConfigured(saved, f.platform);

/** Selected AI provider is not signed in yet or has no key: the previous AI stays active. */
export const aiPending = (f: SettingsForm, saved: PublicSettings): boolean =>
  f.ai.provider !== saved.ai.provider
  && !(f.ai.provider === 'codex' ? saved.ai.codexLoggedIn : saved.ai.hasApiKey || saved.ai.viaEnv || !!f.secrets.apiKey.value.trim());

/** What gets autosaved: like buildPatch, but without a platform or AI switch that is not ready yet. */
export function autosavePatch(f: SettingsForm, saved: PublicSettings): SettingsPatch {
  const p = buildPatch(f);
  return {
    ...p,
    ...(platformPending(f, saved) ? { platform: saved.platform ?? 'shopware' } : {}),
    ...(aiPending(f, saved) && p.ai ? { ai: { ...p.ai, provider: saved.ai.provider } } : {}),
  };
}

/** Is there anything to autosave? */
export const autosaveDirty = (f: SettingsForm, saved: PublicSettings): boolean =>
  JSON.stringify(autosavePatch(f, saved)) !== JSON.stringify(buildPatch(formFromSettings(saved)));

/** null = test allowed. Otherwise the hint: unsaved inputs, including a platform switch, are not included. */
export const connectionTestBlock = (dirty: boolean, locale: Locale = DEFAULT_LOCALE): string | null =>
  (dirty ? messages(locale).lib.settings.testBlocked : null);

/** Claude models to choose from, labels in the requested language */
export const aiModels = (locale: Locale = DEFAULT_LOCALE): { value: string; label: string }[] => {
  const m = messages(locale).lib.settings.aiModels;
  return [{ value: '', label: m.default }, { value: 'sonnet', label: m.sonnet }, { value: 'opus', label: m.opus }];
};


// ---- Generic platform form: read/set values, whether Shopware (fixed fields) or Shopify/Magento/OpenMage ----
const SW_SECRET: Record<string, SecretKey> = { clientSecret: 'clientSecret', password: 'password' };
type SwPlain = 'url' | 'publicUrl' | 'clientId' | 'user';

export function fieldValue(f: SettingsForm, kind: PlatformKind, key: string): string {
  return kind === 'shopware' ? String(f.shopware[key as SwPlain] ?? '') : f.platforms[kind].values[key] ?? '';
}
export function withFieldValue(f: SettingsForm, kind: PlatformKind, key: string, v: string): SettingsForm {
  if (kind === 'shopware') return { ...f, shopware: { ...f.shopware, [key]: v } };
  return { ...f, platforms: { ...f.platforms, [kind]: { ...f.platforms[kind], values: { ...f.platforms[kind].values, [key]: v } } } };
}
export function secretState(f: SettingsForm, kind: PlatformKind, key: string): SecretInput {
  return (kind === 'shopware' ? f.secrets[SW_SECRET[key]] : f.platformSecrets[`${kind}.${key}`]) ?? emptySecret();
}
export function withSecret(f: SettingsForm, kind: PlatformKind, key: string, v: SecretInput): SettingsForm {
  if (kind === 'shopware') return SW_SECRET[key] ? { ...f, secrets: { ...f.secrets, [SW_SECRET[key]]: v } } : f;
  return { ...f, platformSecrets: { ...f.platformSecrets, [`${kind}.${key}`]: v } };
}
export const authOf = (f: SettingsForm, kind: PlatformKind): string => (kind === 'shopware' ? f.shopware.auth : f.platforms[kind].auth);
export function withAuth(f: SettingsForm, kind: PlatformKind, auth: string): SettingsForm {
  if (kind === 'shopware') return { ...f, shopware: { ...f.shopware, auth: auth === 'user' ? 'user' : 'integration' } };
  return { ...f, platforms: { ...f.platforms, [kind]: { ...f.platforms[kind], auth } } };
}
/** Secret saved? (Shopware: hasPassword/hasClientSecret) */
export function hasSecret(saved: PublicSettings, kind: PlatformKind, key: string): boolean {
  if (kind === 'shopware') return key === 'password' ? saved.shopware.hasPassword : key === 'clientSecret' ? saved.shopware.hasClientSecret : false;
  return !!saved.platforms?.[kind]?.has[key];
}
/** Did the server discard platform secrets on save that the form did not intend to remove? (Shop address changed to another origin:
 *  saved credentials never go to a new host, they must be entered again) */
export const secretsDropped = (before: PublicSettings, after: PublicSettings, sent: SettingsForm, kind: PlatformKind): boolean =>
  secretKeys(kind).some(k => hasSecret(before, kind, k) && !hasSecret(after, kind, k) && !secretState(sent, kind, k).remove);
/** Saved state: platform set up? */
export const savedConfigured = (saved: PublicSettings, kind: PlatformKind): boolean => (kind === 'shopware' ? saved.shopware.configured : !!saved.platforms?.[kind]?.configured);
/** Connection ready (otherwise preview) */
export const platformAvailable = (saved: PublicSettings, kind: PlatformKind): boolean => saved.platforms?.[kind]?.available ?? PLATFORM_SETTINGS[kind].available;

/** Sistrix API key plausible (length/characters)? Only then autosave. */
export const sistrixKeyComplete = (key: string): boolean => /^[A-Za-z0-9_-]{16,128}$/.test(key.trim());

/** Search Console key complete (service account JSON with email and private key)? Only then autosave;
 *  otherwise a half-pasted JSON ends up in storage. */
export function gscKeyComplete(key: string): boolean {
  try {
    const k = JSON.parse(key) as { private_key?: unknown; client_email?: unknown } | null;
    return !!k && typeof k === 'object' && typeof k.private_key === 'string' && !!k.private_key && typeof k.client_email === 'string' && !!k.client_email;
  } catch { return false; }
}
