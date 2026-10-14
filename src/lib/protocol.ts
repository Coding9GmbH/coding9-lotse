// Vertrag zwischen Server und Oberfläche: Datentypen der REST-Endpunkte und der Chat-Ereignisse (NDJSON-Stream).
// Wird von src/server (Erzeuger) und src/components (Verbraucher) gemeinsam genutzt – nur Typen, kein Laufzeitcode.
import type { PlatformKind } from './platforms';
import type { Locale } from './i18n/locales';
import type { ScriptRisk } from './script-scan';
export type { PlatformKind } from './platforms';

export type TargetKind = 'category' | 'product' | 'landing';
export interface Target { kind: TargetKind; id?: string; name?: string; path?: string | null; cmsPage?: string | null }

// ---- Änderungssets (Vorschlag der KI → Freigabe durch den Menschen) ----
export interface ChangeItem {
  id: string;
  /** 'info' = nur Hinweis (nicht auswählbar); sonst die betroffene Entität, z. B. product, category, promotion */
  entity: string;
  entityId?: string;
  label: string;
  field?: string;
  fieldLabel: string;
  before: string;
  after: string;
  afterRaw?: unknown;
  /** Rohwert des Feldes beim Vorschlag (Stale-Write-Guard: der Executor schreibt nicht, wenn der Shop inzwischen etwas anderes hat) */
  beforeRaw?: unknown;
  html?: { before: string; after: string };
  warn: string[];
}
export interface ChangeAsset { name?: string; url: string; alt?: string; note: string }
export interface ChangeSet {
  id: string;
  /** Kernarten + Feature-Arten (z. B. 'product-media', 'promotions'); Feature-Arten haben einen Applier in changes.ts */
  kind: 'products' | 'categories' | 'page' | 'new-products' | (string & {});
  entity?: string;
  /** Anzeige im Kopf der Karte, z. B. { one: 'Promotion', many: 'Promotionen' } und Text des Freigabe-Buttons */
  noun?: { one: string; many: string };
  applyLabel?: string;
  title: string;
  reason: string | null;
  items: ChangeItem[];
  assets?: ChangeAsset[];
  skipped: { id: string; reason: string }[];
  unchanged?: number;
  atomic: boolean;
  /** Stapelverarbeitung: Anzahl aller betroffenen Datensätze – items sind dann Gruppen, sample eine Stichprobe (Karte bleibt schnell) */
  total?: number;
  sample?: ChangeItem[];
  /** Shop-Plattform, für die das Set gebaut wurde (setzt die Session; fehlt bei Altbestand = shopware) */
  platform?: PlatformKind;
  /** Enthält JavaScript (Skript, Event-Handler, javascript:-URL, js-Feld): Karte zeigt eine deutliche Warnung mit den Ladeadressen */
  script?: ScriptRisk;
}
export type ChangeStatus = 'applied' | 'partial' | 'failed' | 'rejected';
/** Rückgängig-Schritt: patch/delete/create auf eine Entität oder ein roher Admin-API-Aufruf (req, z. B. Zuordnung löschen) */
export interface UndoOp {
  op: 'patch' | 'delete' | 'create' | 'req'; entity: string; id: string; data?: Record<string, unknown>; method?: string; path?: string; body?: unknown;
  /** Plattform, deren Adapter den Schritt ausführt (fehlt bei Altbestand = shopware) */
  platform?: PlatformKind;
  /** Werte, die Lotse geschrieben hat. Fehlt der Eintrag, stellt Rückgängig den Vorher-Wert ohne erneuten Vergleich her. */
  wrote?: Record<string, unknown>;
}
export interface UndoOutcome { ok: boolean; error?: string }
export interface PublishedInfo { url?: string; cmsPageId?: string; adminUrl?: string; [k: string]: unknown }

// ---- Qualitäts-Check eines Seitenentwurfs ----
export interface AuditCheck { id?: string; label: string; ok: boolean; weight?: number; level?: 'wichtig' | 'empfohlen' | string; hint?: string; area?: 'SEO' | 'CRO' | 'UX'; [k: string]: unknown }
export interface DraftAudit { score: number; checks: AuditCheck[]; warnings: string[]; stats: { words: number; h1: number; internalLinks: number } }

// ---- Styleguide ----
export interface Styleguide {
  brandName: string;
  summary: string;
  colors: { primary: string; primaryContrast: string; secondary?: string; accent?: string; text: string; muted?: string; background: string; surface?: string; border?: string };
  typography: { headingFont: string; bodyFont: string; baseSize?: string; headingWeight?: string; notes?: string };
  shape: { radius: string; buttons: string; shadow?: string };
  logoUrl?: string;
  imagery: string;
  tone: { formality: 'Du' | 'Sie'; voice: string; dos: string[]; donts: string[]; examples: string[] };
  layoutNotes?: string;
  /** Wie der Shop seine Seiten tatsächlich baut – damit neue Seiten wie bestehende wirken */
  components?: { buttons?: string; headings?: string; cards?: string; sections?: string; notes?: string };
  /** Im Shop übliche Blöcke/Elemente mit Verwendung, z.B. "acme-trust-bar: Vertrauensleiste unter dem Einstieg (Produkt- und Kategorieseiten)" */
  existingBlocks?: string[];
  updatedAt?: string;
}

// ---- Vorgemerkte Bilder (liegen bis zur Freigabe nur lokal) ----
export interface StagedImage { mediaId: string; url: string; name?: string; alt?: string; width?: number; height?: number; [k: string]: unknown }

// ---- Chat-Ereignisse (eine JSON-Zeile je Ereignis) ----
export type ChatEvent =
  | { t: 'start' }
  | { t: 'user'; text: string }
  | { t: 'text_start' }
  | { t: 'text'; text: string }
  | { t: 'tool'; id: string; name: string; input: unknown }
  | { t: 'tool_result'; id: string; error: boolean; preview: string }
  | { t: 'question'; approvalId: string; question: string; options: string[]; optionHints?: string[]; answer?: string }
  | { t: 'changeset'; approvalId: string; cs: ChangeSet; decision?: boolean }
  /** Fortschritt beim Anwenden großer Änderungssets (nur live, wird nicht gespeichert) */
  | { t: 'changeset_progress'; csId: string; done: number; total: number }
  /** counts: Gesamtzahlen bei gekürzten results (Stapelverarbeitung); undoResults: Ausgang je Rückgängig-Schritt (gleiche Reihenfolge wie undo), undone = alle ok */
  | { t: 'changeset_result'; csId: string; status: ChangeStatus; results?: { itemId: string; ok: boolean; error?: string }[]; counts?: { applied: number; failed: number }; undo?: UndoOp[]; error?: string; published?: PublishedInfo; undone?: boolean; undoResults?: UndoOutcome[] }
  | { t: 'draft_partial'; html: string; name?: string; pageType?: string }
  /** rv: Version des Vorschau-Renderers – ältere Entwürfe werden beim Öffnen neu gezeichnet */
  | { t: 'draft'; html?: string; spec: unknown; name: string; pageType: string; audit: DraftAudit; rv?: number }
  | { t: 'focus'; kind: 'product' | 'category'; id: string; name?: string; path?: string | null; cmsPage: string | null }
  | ({ t: 'image' } & StagedImage)
  | { t: 'styleguide'; sg: Styleguide }
  | { t: 'done'; error: string | null; cost?: number }
  /** Erste Zeile beim Wieder-Verbinden mit einem Chat: bisheriger Verlauf + ob er noch läuft */
  | { t: 'snapshot'; chat: ChatDetail; running: boolean };

export type ChatEventType = ChatEvent['t'];

// ---- REST ----
/** locale: Sprache der KI-Antworten (vom Server aus Cookie/Accept-Language gesetzt) */
export interface ChatRequest { chatId: string; message: string; target?: Target | null; onboarding?: boolean; locale?: Locale }
/** status: läuft gerade („running“) oder wartet auf Antwort/Freigabe des Menschen („waiting“); fehlt = ruht */
export type ChatStatus = 'running' | 'waiting';
/** Seitengröße der Chatliste (/api/chats): eine volle Seite heißt „vielleicht gibt es mehr“. */
export const CHAT_PAGE = 200;
export interface ChatSummary { id: string; title: string; target: Target | null; updatedAt: string; published: number; status?: ChatStatus }
export interface ChatDetail { id: string; title: string; target: Target | null; events: ChatEvent[]; /** Runde läuft gerade (dann live verbinden) */ running?: boolean }

export type AiProvider = 'claude' | 'codex';
/** shopware = Verbindung zum aktiven Shop (Name aus Altbestand, gilt für jede Plattform); platform = welche Plattform verbunden ist */
export interface Health { shopware: { url: string; ok: boolean; configured: boolean; error?: string }; ai: { configured: boolean; provider?: AiProvider }; platform?: { kind: PlatformKind; label: string; available: boolean } }
/** Pfad-Vorlagen der Plattform ({id} wird ersetzt): Admin-Links und Storefront-Pfade für Kategorie/Produkt */
export interface PlatformPaths { adminCategory: string; adminProduct: string; adminCms: string; category: string; product: string }
export interface AppConfig { admin: string; storefront: string; imageGen: boolean; docker: boolean; version: string; platform?: PlatformKind; paths?: PlatformPaths }

export interface CategoryRow { id: string; name: string; parentId: string | null; active: boolean; type: string; cmsPage: string | null }
export interface ProductRow { id: string; name: string; number: string; img?: string; cmsPage: string | null }

export type ScopeKey = 'products' | 'categories' | 'cms' | 'media' | 'shop' | 'marketing';
export interface ScopeInfo { label: string; hint: string }

/** Einstellungen, wie die Oberfläche sie sieht: Geheimnisse nur als „vorhanden ja/nein“. */
/** Zugangsdaten einer Plattform für die Oberfläche: Klartextfelder als Wert, Geheimnisse nur als „vorhanden“. */
export interface PlatformPublic { label: string; values: Record<string, string>; has: Record<string, boolean>; configured: boolean; /** Adapter fertig (sonst Vorschau: speicherbar, aber noch keine Werkzeuge) */ available: boolean }
export interface PublicSettings {
  shopware: { url: string; publicUrl: string; user: string; clientId: string; hasPassword: boolean; hasClientSecret: boolean; configured: boolean };
  /** aktive Shop-Plattform (genau ein Shop ist verbunden) */
  platform?: PlatformKind;
  platforms?: Partial<Record<PlatformKind, PlatformPublic>>;
  ai: { provider: AiProvider; hasApiKey: boolean; model: string; viaEnv: boolean; docker: boolean; codexModel: string; codexLoggedIn: boolean };
  image: { hasKey: boolean; model: string };
  scopes: Record<ScopeKey, boolean>;
  scopeInfo: Record<ScopeKey, ScopeInfo>;
}
/** Änderungen an den Einstellungen. Geheimnis: undefined/'' = unverändert, null = löschen. */
/** Felder einer Plattform laut Beschreibung (lib/platforms.ts); Geheimnis: undefined/'' = unverändert, null = löschen */
export type PlatformPatch = Record<string, string | null | undefined>;
export interface SettingsPatch {
  platform?: PlatformKind;
  shopware?: { url?: string; publicUrl?: string; user?: string; clientId?: string; password?: string | null; clientSecret?: string | null };
  shopify?: PlatformPatch;
  magento?: PlatformPatch;
  openmage?: PlatformPatch;
  ai?: { provider?: AiProvider; model?: string; codexModel?: string; apiKey?: string | null };
  image?: { model?: string; openaiKey?: string | null };
  scopes?: Partial<Record<ScopeKey, boolean>>;
}
export interface TestResult { ok: boolean; message: string }

export interface AccessLogRow { ts: string; chat: string | null; op: string; entity: string; n: number; scrubbed: number; denied: string | null }
/** status 'started': Zeile vor dem ersten Schreibzugriff (Absturzsicherheit); das Ergebnis folgt als eigene Zeile. decision 'changed': Wechsel der Shop-Verbindung (Einstellungen) */
export interface AuditRow { ts: string; chatId?: string; changeSet?: string; kind?: string; title?: string; decision: 'approved' | 'rejected' | 'undo' | 'changed'; status?: ChangeStatus | 'started'; applied?: number; failed?: number; /** Benutzername des Logins (LOTSE_PASSWORD), wenn vorhanden */ actor?: string; [k: string]: unknown }

/** ChatGPT-Anmeldung für Codex (Gerätecode): Link öffnen, Code eingeben. */
export interface CodexLoginState { status: 'idle' | 'pending' | 'done' | 'error'; url?: string; code?: string; message?: string }

// ---- Shop-Check (Startseite): Befunde aus registrierten Prüfungen ----
export type CheckSeverity = 'hoch' | 'mittel' | 'niedrig';
export interface CheckFinding {
  /** stabil, z. B. 'seo.meta-description-missing' */
  id: string;
  /** Bereich für Gruppierung/Filter, z. B. 'SEO', 'Recht', 'Bilder', 'Daten', 'Preise', 'Links', 'Search Console' */
  area: string;
  title: string;
  severity: CheckSeverity;
  /** betroffene Einträge (0 = alles in Ordnung) */
  count: number;
  /** geprüfte Einträge insgesamt, falls bekannt */
  total?: number;
  /** Bezugsgröße im Dativ Plural für „34 von 120 Produkten“ */
  unit?: string;
  /** Prüfung wurde gedeckelt: count ist eine Untergrenze („mindestens“) */
  atLeast?: boolean;
  /** Beispiele (max. ~5) zur Anzeige */
  sample?: { id: string; label: string }[];
  /** kurze Erklärung, warum das wichtig ist */
  hint?: string;
  /** Auftrag an Lotse, der die Lücke behebt (startet einen Chat) */
  fixPrompt: string;
}
export interface CheckRun { checkedAt: string; findings: CheckFinding[]; errors: { check: string; error: string }[]; durationMs: number; /** ausgeführte Prüfungen */ checks?: number; /** übersprungen (Bereich gesperrt) */ skipped?: string[] }
/** GET /api/shopcheck */
export interface ShopCheckState { enabled: boolean; running: boolean; stale: boolean; run: CheckRun | null; /** letzter Durchlauf ganz fehlgeschlagen */ error?: string }

// ---- Google Search Console (Einstellungen): Schlüssel nur als „vorhanden“, nie im Browser ----
export interface GscPublic { hasKey: boolean; clientEmail: string; projectId: string; property: string; connected: boolean; updatedAt: string | null }
export interface GscTestResult extends TestResult { sites: string[] }
