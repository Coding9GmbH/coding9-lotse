// Contract between server and UI: data types of the REST endpoints and the chat events (NDJSON stream).
// Shared by src/server (producer) and src/components (consumer); types only, no runtime code.
import type { PlatformKind } from './platforms';
import type { Locale } from './i18n/locales';
import type { ScriptRisk } from './script-scan';
export type { PlatformKind } from './platforms';

export type TargetKind = 'category' | 'product' | 'landing';
export interface Target { kind: TargetKind; id?: string; name?: string; path?: string | null; cmsPage?: string | null }

// ---- Change sets (AI proposal → approval by the human) ----
export interface ChangeItem {
  id: string;
  /** 'info' = note only (not selectable); otherwise the affected entity, e.g. product, category, promotion */
  entity: string;
  entityId?: string;
  label: string;
  field?: string;
  fieldLabel: string;
  before: string;
  after: string;
  afterRaw?: unknown;
  /** Raw field value at proposal time (stale-write guard: the executor doesn't write if the shop has something else by now) */
  beforeRaw?: unknown;
  html?: { before: string; after: string };
  warn: string[];
}
export interface ChangeAsset { name?: string; url: string; alt?: string; note: string }
export interface ChangeSet {
  id: string;
  /** Core kinds + feature kinds (e.g. 'product-media', 'promotions'); feature kinds have an applier in changes.ts */
  kind: 'products' | 'categories' | 'page' | 'new-products' | (string & {});
  entity?: string;
  /** Display in the card header, e.g. { one: 'Promotion', many: 'Promotionen' }, and text of the approve button */
  noun?: { one: string; many: string };
  applyLabel?: string;
  title: string;
  reason: string | null;
  items: ChangeItem[];
  assets?: ChangeAsset[];
  skipped: { id: string; reason: string }[];
  unchanged?: number;
  atomic: boolean;
  /** Bulk edit: number of all affected records; items are then groups, sample a sample (card stays fast) */
  total?: number;
  sample?: ChangeItem[];
  /** Shop platform the set was built for (set by the session; missing in legacy data = shopware) */
  platform?: PlatformKind;
  /** Contains JavaScript (script, event handler, javascript: URL, js field): the card shows a clear warning with the load URLs */
  script?: ScriptRisk;
}
export type ChangeStatus = 'applied' | 'partial' | 'failed' | 'rejected';
/** Undo step: patch/delete/create on an entity or a raw Admin API call (req, e.g. delete an assignment) */
export interface UndoOp {
  op: 'patch' | 'delete' | 'create' | 'req'; entity: string; id: string; data?: Record<string, unknown>; method?: string; path?: string; body?: unknown;
  /** Platform whose adapter executes the step (missing in legacy data = shopware) */
  platform?: PlatformKind;
  /** Values Lotse wrote. If the entry is missing, undo restores the previous value without re-comparing. */
  wrote?: Record<string, unknown>;
}
export interface UndoOutcome { ok: boolean; error?: string }
export interface PublishedInfo { url?: string; cmsPageId?: string; adminUrl?: string; [k: string]: unknown }

// ---- Quality check of a page draft ----
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
  /** How the shop actually builds its pages, so new pages look like existing ones */
  components?: { buttons?: string; headings?: string; cards?: string; sections?: string; notes?: string };
  /** Blocks/elements common in the shop with their usage, e.g. "acme-trust-bar: Vertrauensleiste unter dem Einstieg (Produkt- und Kategorieseiten)" */
  existingBlocks?: string[];
  updatedAt?: string;
}

// ---- Staged images (kept locally only until approval) ----
export interface StagedImage { mediaId: string; url: string; name?: string; alt?: string; width?: number; height?: number; [k: string]: unknown }

// ---- Chat events (one JSON line per event) ----
export type ChatEvent =
  | { t: 'start' }
  | { t: 'user'; text: string }
  | { t: 'text_start' }
  | { t: 'text'; text: string }
  | { t: 'tool'; id: string; name: string; input: unknown }
  | { t: 'tool_result'; id: string; error: boolean; preview: string }
  | { t: 'question'; approvalId: string; question: string; options: string[]; optionHints?: string[]; answer?: string }
  | { t: 'changeset'; approvalId: string; cs: ChangeSet; decision?: boolean }
  /** Progress while applying large change sets (live only, not saved) */
  | { t: 'changeset_progress'; csId: string; done: number; total: number }
  /** counts: totals for truncated results (bulk edit); undoResults: outcome per undo step (same order as undo), undone = all ok */
  | { t: 'changeset_result'; csId: string; status: ChangeStatus; results?: { itemId: string; ok: boolean; error?: string }[]; counts?: { applied: number; failed: number }; undo?: UndoOp[]; error?: string; published?: PublishedInfo; undone?: boolean; undoResults?: UndoOutcome[] }
  | { t: 'draft_partial'; html: string; name?: string; pageType?: string }
  /** rv: version of the preview renderer; older drafts are re-rendered when opened */
  | { t: 'draft'; html?: string; spec: unknown; name: string; pageType: string; audit: DraftAudit; rv?: number }
  | { t: 'focus'; kind: 'product' | 'category'; id: string; name?: string; path?: string | null; cmsPage: string | null }
  | ({ t: 'image' } & StagedImage)
  | { t: 'styleguide'; sg: Styleguide }
  | { t: 'done'; error: string | null; cost?: number }
  /** First line when reconnecting to a chat: history so far + whether it's still running */
  | { t: 'snapshot'; chat: ChatDetail; running: boolean };

export type ChatEventType = ChatEvent['t'];

// ---- REST ----
/** locale: language of the AI responses (set by the server from cookie/Accept-Language) */
export interface ChatRequest { chatId: string; message: string; target?: Target | null; onboarding?: boolean; locale?: Locale }
/** status: currently running ("running") or waiting for the human's reply/approval ("waiting"); missing = idle */
export type ChatStatus = 'running' | 'waiting';
/** Page size of the chat list (/api/chats): a full page means "there may be more". */
export const CHAT_PAGE = 200;
export interface ChatSummary { id: string; title: string; target: Target | null; updatedAt: string; published: number; status?: ChatStatus }
export interface ChatDetail { id: string; title: string; target: Target | null; events: ChatEvent[]; /** turn is currently running (then connect live) */ running?: boolean }

export type AiProvider = 'claude' | 'codex';
/** shopware = connection to the active shop (legacy name, applies to every platform); platform = which platform is connected */
/** Optional integrations: only when connected does the UI show matching examples */
export interface Integrations { gsc: boolean; sistrix: boolean }
export interface Health { shopware: { url: string; ok: boolean; configured: boolean; error?: string }; ai: { configured: boolean; provider?: AiProvider }; platform?: { kind: PlatformKind; label: string; available: boolean }; integrations?: Integrations }
/** The platform's path templates ({id} is replaced): admin links and storefront paths for category/product */
export interface PlatformPaths { adminCategory: string; adminProduct: string; adminCms: string; category: string; product: string }
export interface AppConfig { admin: string; storefront: string; imageGen: boolean; docker: boolean; version: string; platform?: PlatformKind; paths?: PlatformPaths }

export interface CategoryRow { id: string; name: string; parentId: string | null; active: boolean; type: string; cmsPage: string | null }
export interface ProductRow { id: string; name: string; number: string; img?: string; cmsPage: string | null }

/** The AI's access scopes: shop data (entities), integrations (gsc, sistrix: data only, no shop entities) and web research (web) */
export type ScopeKey = 'products' | 'manufacturers' | 'categories' | 'cms' | 'media' | 'shop' | 'marketing' | 'gsc' | 'sistrix' | 'web';
export interface ScopeInfo { label: string; hint: string }

/** Settings as the UI sees them: secrets only as "present yes/no". */
/** A platform's credentials for the UI: plain-text fields as values, secrets only as "present". */
export interface PlatformPublic { label: string; values: Record<string, string>; has: Record<string, boolean>; configured: boolean; /** adapter ready (otherwise preview: can be saved, but no tools yet) */ available: boolean }
export interface PublicSettings {
  shopware: { url: string; publicUrl: string; user: string; clientId: string; hasPassword: boolean; hasClientSecret: boolean; configured: boolean };
  /** active shop platform (exactly one shop is connected) */
  platform?: PlatformKind;
  platforms?: Partial<Record<PlatformKind, PlatformPublic>>;
  ai: { provider: AiProvider; hasApiKey: boolean; model: string; viaEnv: boolean; docker: boolean; codexModel: string; codexLoggedIn: boolean };
  image: { hasKey: boolean; model: string };
  scopes: Record<ScopeKey, boolean>;
  scopeInfo: Record<ScopeKey, ScopeInfo>;
  /** ALLOWED_HOSTS set, LOTSE_PASSWORD not: reachable from outside without login */
  openWithoutPassword?: boolean;
}
/** Changes to the settings. Secret: undefined/'' = unchanged, null = delete. */
/** A platform's fields per its description (lib/platforms.ts); secret: undefined/'' = unchanged, null = delete */
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
/** status 'started': line before the first write (crash safety); the result follows as its own line. decision 'changed': shop connection switched (settings) */
export interface AuditRow { ts: string; chatId?: string; changeSet?: string; kind?: string; title?: string; decision: 'approved' | 'rejected' | 'undo' | 'changed'; status?: ChangeStatus | 'started'; applied?: number; failed?: number; /** login username (LOTSE_PASSWORD), if present */ actor?: string; [k: string]: unknown }

/** ChatGPT sign-in for Codex (device code): open the link, enter the code. */
export interface CodexLoginState { status: 'idle' | 'pending' | 'done' | 'error'; url?: string; code?: string; message?: string }

// ---- Shop check (home page): findings from registered checks ----
export type CheckSeverity = 'hoch' | 'mittel' | 'niedrig';
export interface CheckFinding {
  /** stable, e.g. 'seo.meta-description-missing' */
  id: string;
  /** Area for grouping/filtering, e.g. 'SEO', 'Recht', 'Bilder', 'Daten', 'Preise', 'Links', 'Search Console' */
  area: string;
  title: string;
  severity: CheckSeverity;
  /** affected entries (0 = all fine) */
  count: number;
  /** total checked entries, if known */
  total?: number;
  /** reference noun in German dative plural for "34 von 120 Produkten" */
  unit?: string;
  /** check was capped: count is a lower bound ("mindestens", at least) */
  atLeast?: boolean;
  /** examples (max. ~5) for display */
  sample?: { id: string; label: string }[];
  /** short explanation why this matters */
  hint?: string;
  /** task for Lotse that fixes the gap (starts a chat) */
  fixPrompt: string;
}
export interface CheckRun { checkedAt: string; findings: CheckFinding[]; errors: { check: string; error: string }[]; durationMs: number; /** checks run */ checks?: number; /** skipped (area locked) */ skipped?: string[] }
/** GET /api/shopcheck */
export interface ShopCheckState { enabled: boolean; running: boolean; stale: boolean; run: CheckRun | null; /** last run failed entirely */ error?: string }

// ---- Google Search Console (settings): key only as "present", never in the browser ----
export interface GscPublic { hasKey: boolean; clientEmail: string; projectId: string; property: string; connected: boolean; updatedAt: string | null }
export interface GscTestResult extends TestResult { sites: string[] }
// ---- Sistrix (settings): API key only as "present", never in the browser ----
export interface SistrixPublic { hasKey: boolean; domain: string; country: string; /** Optimizer project (hash), empty = automatic */ project: string; connected: boolean; updatedAt: string | null }
export interface SistrixTestResult extends TestResult { credits: number | null }
/** SEO overview: levers from Search Console and Sistrix as ready-made tasks (prompt) for a new chat */
export interface SeoItem { id: string; source: 'gsc' | 'sistrix' | 'site'; kind: 'meta' | 'gap' | 'striking' | 'cannibal' | 'decline' | 'keyword' | 'onpage' | 'site'; title: string; detail: string; metrics: { label: string; value: string }[]; /** sort value (estimated impact) */ impact: number; prompt: string; /** done/ignored by the user: hidden */ mark?: SeoMark }
/** Done = hidden until a fetch at least SEO_DONE_RECHECK_DAYS later still reports the lever; ignored = hidden permanently */
export interface SeoMark { state: 'done' | 'ignored'; at: string }
export const SEO_DONE_RECHECK_DAYS = 7;
/** OnPage crawl (Sistrix Optimizer): ok, no project, several projects without assignment (selection needed) or no crawl yet */
export interface SeoOnpage { status: 'ok' | 'none' | 'choose' | 'empty'; project?: { hash: string; name: string }; projects?: { hash: string; name: string }[]; lastCrawl?: { date: string; pages: number | null; errors: number | null; warnings: number | null; notices: number | null } | null }
export interface SeoOverview { gsc: boolean; sistrix: boolean; /** technical check of the live pages ran */ site?: boolean; items: SeoItem[]; errors: { source: 'gsc' | 'sistrix' | 'site'; error: string }[]; generatedAt: string; onpage?: SeoOnpage; /** live pages: checked pages and time */ siteChecked?: { base: string; pages: { kind: string; url: string }[] }; /** from the cache (costs no credits); "Aktualisieren" (refresh) refetches */ cached?: boolean }
/** Home page card: visibility history (oldest week first) */
export interface SistrixOverview { connected: boolean; domain?: string; country?: string; weeks?: number; series?: { date: string; value: number }[]; latest?: { date: string; value: number } | null; changePct?: number | null; creditsUsed?: number | null; error?: string }
