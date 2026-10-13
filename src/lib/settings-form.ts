import { DEFAULT_LOCALE, messages, type Locale } from './i18n';
import { activeAuthMode, PLATFORM_KINDS, PLATFORM_SETTINGS, plainKeys, secretKeys, type PlatformKind } from './platforms';
import type { AiProvider, PlatformPatch, PublicSettings, ScopeKey, SettingsPatch } from './protocol';

// Formularzustand der Einstellungen. Geheimnisse werden nie vorbefüllt:
// leeres Feld = unverändert, „Entfernen“ = null (löschen), Eingabe = neuer Wert.

export interface SecretInput { value: string; remove: boolean }
export type SecretKey = 'clientSecret' | 'password' | 'apiKey' | 'openaiKey';
export type ShopwareAuth = 'integration' | 'user';
/** Plattformen mit generischem Formular (Felder aus lib/platforms.ts); Shopware hat seine festen Felder */
export type GenericPlatform = Exclude<PlatformKind, 'shopware'>;
export const GENERIC_PLATFORMS = PLATFORM_KINDS.filter((k): k is GenericPlatform => k !== 'shopware');

export interface SettingsForm {
  /** gewählte Shop-Plattform (genau ein Shop ist verbunden) */
  platform: PlatformKind;
  shopware: { url: string; publicUrl: string; clientId: string; user: string; auth: ShopwareAuth };
  /** Klartextfelder + gewählte Zugangsart je Plattform */
  platforms: Record<GenericPlatform, { values: Record<string, string>; auth: string }>;
  /** Geheimnisse der Plattformen, Schlüssel „plattform.feld“ */
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

/** Hat das Formular Änderungen gegenüber dem gespeicherten Stand? */
export const isDirty = (f: SettingsForm, saved: PublicSettings): boolean =>
  JSON.stringify(buildPatch(f)) !== JSON.stringify(buildPatch(formFromSettings(saved)));

// ---- Automatisch speichern ----
// Ein Plattformwechsel wird erst wirksam, wenn die gewählte Plattform eingerichtet ist (Zugangsdaten gespeichert) –
// sonst wäre der Shop schon beim bloßen Umschalten des Reiters getrennt. Bis dahin speichert Lotse nur deren Felder.

/** Gewählte Plattform wartet noch auf ihre Zugangsdaten, verbunden bleibt die gespeicherte. */
export const platformPending = (f: SettingsForm, saved: PublicSettings): boolean =>
  f.platform !== (saved.platform ?? 'shopware') && !savedConfigured(saved, f.platform);

/** Gewählter KI-Anbieter ist noch nicht angemeldet bzw. hat keinen Schlüssel: die bisherige KI bleibt aktiv. */
export const aiPending = (f: SettingsForm, saved: PublicSettings): boolean =>
  f.ai.provider !== saved.ai.provider
  && !(f.ai.provider === 'codex' ? saved.ai.codexLoggedIn : saved.ai.hasApiKey || saved.ai.viaEnv || !!f.secrets.apiKey.value.trim());

/** Was automatisch gespeichert wird: wie buildPatch, nur ohne einen noch nicht einsatzbereiten Plattform- oder KI-Wechsel. */
export function autosavePatch(f: SettingsForm, saved: PublicSettings): SettingsPatch {
  const p = buildPatch(f);
  return {
    ...p,
    ...(platformPending(f, saved) ? { platform: saved.platform ?? 'shopware' } : {}),
    ...(aiPending(f, saved) && p.ai ? { ai: { ...p.ai, provider: saved.ai.provider } } : {}),
  };
}

/** Gibt es etwas automatisch zu speichern? */
export const autosaveDirty = (f: SettingsForm, saved: PublicSettings): boolean =>
  JSON.stringify(autosavePatch(f, saved)) !== JSON.stringify(buildPatch(formFromSettings(saved)));

/** null = Test erlaubt. Sonst der Hinweis: ungespeicherte Eingaben, auch ein Plattformwechsel, werden nicht mitgeschrieben. */
export const connectionTestBlock = (dirty: boolean, locale: Locale = DEFAULT_LOCALE): string | null =>
  (dirty ? messages(locale).lib.settings.testBlocked : null);

/** Claude-Modelle zur Auswahl, Beschriftung in der gewünschten Sprache */
export const aiModels = (locale: Locale = DEFAULT_LOCALE): { value: string; label: string }[] => {
  const m = messages(locale).lib.settings.aiModels;
  return [{ value: '', label: m.default }, { value: 'sonnet', label: m.sonnet }, { value: 'opus', label: m.opus }];
};
export const AI_MODELS: { value: string; label: string }[] = aiModels();


// ---- Generisches Plattform-Formular: Werte lesen/setzen, egal ob Shopware (feste Felder) oder Shopify/Magento/OpenMage ----
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
/** Geheimnis gespeichert? (Shopware: hasPassword/hasClientSecret) */
export function hasSecret(saved: PublicSettings, kind: PlatformKind, key: string): boolean {
  if (kind === 'shopware') return key === 'password' ? saved.shopware.hasPassword : key === 'clientSecret' ? saved.shopware.hasClientSecret : false;
  return !!saved.platforms?.[kind]?.has[key];
}
/** Gespeicherter Stand: Plattform eingerichtet? */
export const savedConfigured = (saved: PublicSettings, kind: PlatformKind): boolean => (kind === 'shopware' ? saved.shopware.configured : !!saved.platforms?.[kind]?.configured);
/** Anbindung fertig (sonst Vorschau) */
export const platformAvailable = (saved: PublicSettings, kind: PlatformKind): boolean => saved.platforms?.[kind]?.available ?? PLATFORM_SETTINGS[kind].available;

/** Search-Console-Schlüssel vollständig (Service-Konto-JSON mit E-Mail und privatem Schlüssel)? Erst dann automatisch speichern –
 *  sonst landet ein halb eingefügtes JSON im Speicher. */
export function gscKeyComplete(key: string): boolean {
  try {
    const k = JSON.parse(key) as { private_key?: unknown; client_email?: unknown } | null;
    return !!k && typeof k === 'object' && typeof k.private_key === 'string' && !!k.private_key && typeof k.client_email === 'string' && !!k.client_email;
  } catch { return false; }
}
