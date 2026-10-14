import 'server-only';
// Einstellungen: Shop-Plattform + Zugang (Shopware, Shopify, Magento, OpenMage), KI-Zugang, Bild-KI, KI-Zugriffsbereiche. Geheimnisse liegen verschlüsselt in der DB (db.ts) – sie verlassen den Server nie in Richtung KI.
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
/** Zugang einer Plattform als Schlüssel → Wert (Felder laut lib/platforms.ts, Geheimnisse entschlüsselt) */
export type PlatformConfig = Record<string, string>;
type GenericKind = Exclude<PlatformKind, 'shopware'>;
const stored = () => kvGet<StoredSettings>('settings') ?? {};
const pick = (...v: (string | null | undefined)[]): string => v.find(x => x !== undefined && x !== null && x !== '') ?? '';

export interface Settings {
  /** aktive Plattform: genau ein Shop ist verbunden (gespeichert, sonst SHOP_PLATFORM, sonst shopware) */
  platform: PlatformKind;
  shopware: ShopwareConfig;
  shopify: PlatformConfig;
  magento: PlatformConfig;
  openmage: PlatformConfig;
  ai: { provider: AiProvider; apiKey: string; model: string; codexModel: string };
  image: { openaiKey: string; model: string };
  scopes: Scopes;
}

const kindOf = (s: StoredSettings): PlatformKind => (isPlatformKind(s.platform) ? s.platform : isPlatformKind(env.SHOP_PLATFORM) ? env.SHOP_PLATFORM : DEFAULT_PLATFORM);
/** Verbundene Plattform ohne Entschlüsseln der Zugangsdaten (läuft bei jedem Session-Zugriff) */
export const storedPlatform = (): PlatformKind => kindOf(stored());

export const getSettings = (): Settings => settingsOf(stored()); // entschlüsselt, nur serverintern verwenden
function settingsOf(s: StoredSettings): Settings {
  const sw = s.shopware ?? {}, ai = s.ai ?? {}, im = s.image ?? {};
  return {
    platform: kindOf(s),
    shopify: genericConfig('shopify', s.shopify), magento: genericConfig('magento', s.magento), openmage: genericConfig('openmage', s.openmage),
    shopware: { url: pick(sw.url, env.SHOPWARE_URL), publicUrl: pick(sw.publicUrl, env.SHOPWARE_PUBLIC_URL), user: pick(sw.user, env.SHOPWARE_USER), password: pick(unseal(sw.password), envSecret('shopware', sw, 'SHOPWARE_PASSWORD')), clientId: pick(sw.clientId, env.SHOPWARE_CLIENT_ID), clientSecret: pick(unseal(sw.clientSecret), envSecret('shopware', sw, 'SHOPWARE_CLIENT_SECRET')) },
    ai: { provider: pick(ai.provider, env.AI_PROVIDER) === 'codex' ? 'codex' : 'claude', apiKey: pick(unseal(ai.apiKey)), model: pick(ai.model, env.AI_MODEL), codexModel: pick(ai.codexModel, env.CODEX_MODEL) },
    image: { openaiKey: pick(unseal(im.openaiKey), env.OPENAI_API_KEY), model: pick(im.model, env.IMAGE_MODEL) },
    scopes: { ...DEFAULT_SCOPES, ...(s.scopes ?? {}) },
  };
}

// Shopify/Magento/OpenMage: Felder laut Beschreibung; Rückfall auf die Umgebungsvariable des Feldes
function genericConfig(kind: GenericKind, sec: Section = {}): PlatformConfig {
  return Object.fromEntries(platformFields(kind).map(f => [f.key, f.secret ? pick(unseal(sec[f.key]), envSecret(kind, sec, f.env)) : pick(sec[f.key], f.env ? env[f.env] : undefined)]));
}

// Zugangsdaten gehören zur Adresse, an die sie gehen (API-Basis je Plattform). Wechselt deren Herkunft, verwirft mergeSettings die gespeicherten
// Geheimnisse (außer sie kommen im selben Patch neu mit) – eine kompromittierte Oberfläche kann sie sonst per „Verbindung testen“ an einen fremden Host schicken.
const CONN_URL: Record<PlatformKind, string> = { shopware: 'url', shopify: 'storeDomain', magento: 'url', openmage: 'url' };
const connEnv = (kind: PlatformKind) => platformFields(kind).find(f => f.key === CONN_URL[kind])?.env;
/** Herkunft einer Shop-Adresse (Schema, Host, Port; klein). Domain ohne Schema (Shopify) = https. */
export function shopOrigin(v: string | undefined): string {
  const s = (v ?? '').trim(); if (!s) return '';
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).origin.toLowerCase(); } catch { return s.toLowerCase(); }
}
/** Geparkte Zugangsdaten: { origin, <feld>: versiegelt } – nicht wirksam, kommen nur zurück, wenn die Adresse wieder genau dorthin zeigt.
 *  So löscht ein kurz geleertes oder vertipptes Adressfeld (Auto-Speichern) nichts endgültig, und an eine fremde Adresse gehen sie nie. */
const PARKED = '_parked';
function parkSecrets(sec: Section, secret: string[], before: string, after: string) {
  const held = secret.filter(k => sec[k]);
  if (before && held.length) { sec[PARKED] = JSON.stringify({ origin: before, ...Object.fromEntries(held.map(k => [k, sec[k]])) }); for (const k of held) delete sec[k]; return; }
  if (held.length || !sec[PARKED]) return;
  let parked: Record<string, string> = {}; try { parked = JSON.parse(sec[PARKED]); } catch {}
  if (after && parked.origin === after) { for (const k of secret) if (parked[k]) sec[k] = parked[k]; delete sec[PARKED]; }
}
/** Wirksame Verbindungsadresse einer Plattform (gespeichert, sonst Umgebung) */
const connOrigin = (kind: PlatformKind, sec: Section = {}) => { const e = connEnv(kind); return shopOrigin(pick(sec[CONN_URL[kind]], e ? env[e] : undefined)); };
/** Geheimnis aus der Umgebung nur zur Adresse aus der Umgebung: zeigt die gespeicherte URL woandershin, bleibt es weg. */
function envSecret(kind: PlatformKind, sec: Section, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const e = connEnv(kind), envUrl = e ? env[e] : undefined;
  return !envUrl || connOrigin(kind, sec) === shopOrigin(envUrl) ? env[name] : undefined;
}
/** Zugang einer Plattform als Schlüssel → Wert (Shopware: ShopwareConfig) */
export const platformConfig = (kind: PlatformKind, g = getSettings()): PlatformConfig => (kind === 'shopware' ? { ...g.shopware } : g[kind]);
const shopwareConfigured = (c: ShopwareConfig) => !!(c.url && ((c.user && c.password) || (c.clientId && c.clientSecret)));
/** Zugang der Plattform vollständig (sagt nichts darüber, ob der Shop erreichbar ist) */
export const shopConfigured = (kind: PlatformKind = getSettings().platform, g = getSettings()) => (kind === 'shopware' ? shopwareConfigured(g.shopware) : platformConfigured(kind, g[kind]));

function platformPublic(kind: PlatformKind, g: Settings): PlatformPublic {
  const c = platformConfig(kind, g);
  return {
    label: PLATFORM_SETTINGS[kind].label, available: PLATFORM_SETTINGS[kind].available, configured: shopConfigured(kind, g),
    values: Object.fromEntries(plainKeys(kind).map(k => [k, c[k] ?? ''])), has: Object.fromEntries(secretKeys(kind).map(k => [k, !!c[k]])),
  };
}

/** KI-Zugang vorhanden: Codex angemeldet bzw. Anthropic-API-Schlüssel (Einstellungen oder Umgebung). Ein Claude-Abo wird bewusst nicht unterstützt
 *  (Anthropic erlaubt Drittprodukten auf Basis des Agent SDK keinen claude.ai-Login ohne Freigabe). */
export const aiConfigured = (g = getSettings()) => (g.ai.provider === 'codex' ? codexLoggedIn() : !!(g.ai.apiKey || env.ANTHROPIC_API_KEY));

export function publicSettings(): PublicSettings { // maskiert – für die Oberfläche
  const g = getSettings();
  return {
    shopware: { url: g.shopware.url, publicUrl: g.shopware.publicUrl, user: g.shopware.user, clientId: g.shopware.clientId, hasPassword: !!g.shopware.password, hasClientSecret: !!g.shopware.clientSecret, configured: shopwareConfigured(g.shopware) },
    platform: g.platform,
    platforms: Object.fromEntries(PLATFORM_KINDS.map(k => [k, platformPublic(k, g)])),
    ai: { provider: g.ai.provider, hasApiKey: !!g.ai.apiKey, model: g.ai.model, viaEnv: !!env.ANTHROPIC_API_KEY, docker: inDocker(), codexModel: g.ai.codexModel, codexLoggedIn: codexLoggedIn() },
    image: { hasKey: !!g.image.openaiKey, model: g.image.model },
    scopes: g.scopes,
    scopeInfo: Object.fromEntries(SCOPE_KEYS.map(k => [k, { label: SCOPES[k].label, hint: SCOPES[k].hint }])) as Record<ScopeKey, ScopeInfo>,
    openWithoutPassword: openWithoutPassword(env),
  };
}

export const updateSettings = (p: SettingsPatch = {}) => { kvSet('settings', mergeSettings(stored(), p)); };
/** Gespeicherter Stand + Patch, ohne zu schreiben (api/settings prüft so vorab, was sich an der Shop-Verbindung ändert) */
function mergeSettings(s: StoredSettings, p: SettingsPatch): StoredSettings {
  const out: StoredSettings = { ...s };
  const section = <K extends 'shopware' | 'shopify' | 'magento' | 'openmage' | 'ai' | 'image'>(name: K, plain: string[], secret: string[]) => {
    const patch = p[name] as Record<string, string | null | undefined> | undefined;
    if (!patch) return; const sec: Section = { ...(s[name] ?? {}) }; out[name] = sec;
    for (const k of plain) if (patch[k] !== undefined) sec[k] = String(patch[k]).trim();
    if (name !== 'ai' && name !== 'image') { // Shop-Adresse auf andere Herkunft: gespeicherte Geheimnisse verwerfen (neue aus dem Patch gelten)
      const kind = name as PlatformKind, before = connOrigin(kind, s[kind]), after = connOrigin(kind, sec);
      if (before !== after) parkSecrets(sec, secret, before, after);
    }
    let fresh = false;
    for (const k of secret) { const v = patch[k]; if (v === null) delete sec[k]; else if (v !== undefined && v !== '') { const sealed = seal(String(v).trim()); if (sealed) { sec[k] = sealed; fresh = true; } } } // leer = unverändert, null = löschen
    if (fresh) delete sec[PARKED]; // neu eingegeben: geparkte alte Zugangsdaten sind überholt
  };
  if (p.platform !== undefined && isPlatformKind(p.platform)) out.platform = p.platform;
  section('shopware', ['url', 'publicUrl', 'user', 'clientId'], ['password', 'clientSecret']);
  for (const k of ['shopify', 'magento', 'openmage'] as const) section(k, plainKeys(k), secretKeys(k));
  section('ai', ['provider', 'model', 'codexModel'], ['apiKey']);
  if (out.ai?.oauthToken) { out.ai = { ...out.ai }; delete out.ai.oauthToken; } // Altbestand: Claude-Abo-Token wird nicht mehr unterstützt
  if (out.ai?.provider && out.ai.provider !== 'codex') out.ai.provider = 'claude';
  section('image', ['model'], ['openaiKey']);
  if (p.scopes) out.scopes = { ...DEFAULT_SCOPES, ...(s.scopes ?? {}), ...Object.fromEntries(Object.entries(p.scopes).filter(([k]) => k in DEFAULT_SCOPES).map(([k, v]) => [k, !!v])) };
  return out;
}

/** Felder der Shop-Verbindung (Plattform, URLs, Zugangsdaten), die der Patch ändern würde, z. B. ['platform', 'shopware.url']; nur Namen, nie Werte */
export function connectionChanges(p: SettingsPatch): string[] {
  const s = stored(), a = settingsOf(s), b = settingsOf(mergeSettings(s, p)), out: string[] = [];
  if (a.platform !== b.platform) out.push('platform');
  for (const k of PLATFORM_KINDS) { const ca = platformConfig(k, a), cb = platformConfig(k, b); for (const f of Object.keys({ ...ca, ...cb })) if ((ca[f] ?? '') !== (cb[f] ?? '')) out.push(`${k}.${f}`); }
  return out;
}

// Umgebung für den KI-Prozess (Claude): Freigabeliste statt Sperrliste. Nur was der Agent-Prozess zum Laufen braucht (Pfade, Sprache, Proxy, Zertifikate,
// Anthropic-/Claude-Variablen); Zugangsdaten anderer Dienste (SHOPWARE_*, OPENAI_*, AWS_*, GITHUB_TOKEN, DATABASE_URL, SMTP_* …) erreichen ihn nie.
// Nur API-Schlüssel: kein Abo-Token, keine claude.ai-Anmeldung des Rechners, eigenes Konfigurationsverzeichnis im Datenordner.
const AI_ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|COLORTERM|LANG|LANGUAGE|LC_\w+|TZ|TMPDIR|TMP|TEMP|PWD|HOSTNAME|NODE_\w+|HTTPS?_PROXY|NO_PROXY|SSL_CERT_(FILE|DIR)|ANTHROPIC_\w+|CLAUDE_\w+|DISABLE_\w+|MAX_THINKING_TOKENS|API_TIMEOUT_MS|MCP_\w+|SYSTEMROOT|SYSTEMDRIVE|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|PROGRAMFILES|PROGRAMDATA)$/i;
const AI_ENV_DENY = /^(ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR)$/i;
// Bedrock/Vertex hinter dem Agent SDK: deren Zugang nur, wenn ausdrücklich eingeschaltet
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

// Geheimnisse aus Fehlermeldungen entfernen, bevor etwas zur KI geht
export function redact(text: unknown): string {
  let t = String(text ?? ''); const g = getSettings();
  const shopSecrets = (['shopify', 'magento', 'openmage'] as const).flatMap(k => secretKeys(k).map(f => g[k][f]));
  for (const v of [g.shopware.password, g.shopware.clientSecret, ...shopSecrets, g.ai.apiKey, g.image.openaiKey]) if (v && v.length > 3) t = t.split(v).join('•••');
  return t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer •••').replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-•••');
}
