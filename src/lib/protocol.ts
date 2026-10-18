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
  /** Existing pages whose layout or page content this set replaces (publish_page): impact measurement remembers their search data before the change */
  measureTargets?: MeasureTarget[];
}
export interface MeasureTarget { entity: 'product' | 'category'; id: string; label: string }
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
  // ---- Chats with an attached sandbox (Sandbox Coding) ----
  /** A workspace file was created, changed or deleted by the AI (added/removed: changed lines, 0/0 = unknown) */
  | { t: 'file_change'; path: string; kind: FileChangeKind; added: number; removed: number }
  /** A shell command in the task container (sandbox_bash): first 'running', then the result (same id); tail = redacted end of the output */
  | { t: 'command'; id: string; command: string; args?: Record<string, string>; status: 'running' | 'ok' | 'failed'; exitCode?: number; tail?: string; ms?: number }
  /** The task's container before the turn: waking (paused or still being set up) → ready, or failed (message) */
  /** approval: the setup waits for the user's decision on the repository's .lotse/sandbox.json commands (not an error) */
  | { t: 'sandbox_status'; state: 'waking' | 'ready' | 'failed' | 'approval' | 'finished'; message?: string }
  /** The storefront changed (theme compiled, cache cleared): the preview reloads (live only) */
  | { t: 'preview_reload' }
  /** The AI proposes to publish its changes as a pull request (card only; publishing itself comes from the user) */
  | { t: 'publish_proposal'; title: string; body: string }
  /** The user published the sandbox's changes: pull request created or updated (state as of that moment) */
  | { t: 'pr'; taskId: string; number: number; url: string; title: string; action: 'created' | 'updated'; files: number }
  /** The AI proposes to attach a sandbox to this chat (start_sandbox): a card; only the user's click creates the task */
  | { t: 'sandbox_offer'; id: string; repo: string; baseBranch: string; reason: string; /** technical name if the AI proposes a new plugin (empty repository) */ pluginName?: string }
  /** The AI asks for internet in the task container (request_internet): a card; only the user's click allows it (decision: the answer).
   *  Sent again with the same approvalId, decision false and error when attaching failed after the click (the card shows it);
   *  restart: still open when Lotse restarted (closed as declined). */
  | { t: 'internet_request'; approvalId: string; reason: string; decision?: boolean; error?: string; restart?: boolean }
  /** Feedback on the task's pull request found by the watcher (pr-watch.ts): reviews, comments, failed checks (third-party text,
   *  redacted and capped), or the PR was merged/closed (state). handedOver: the user handed it to the AI ("An KI übergeben").
   *  The same id again updates the card (the watcher's event also reaches an open panel, see TaskEvent 'chat'). */
  | { t: 'pr_feedback'; id: string; taskId: string; number: number; url: string; items: PrFeedbackItem[]; more?: number; state?: 'merged' | 'closed'; handedOver?: boolean }
  /** A sandbox was attached to this chat (by the user) */
  | { t: 'sandbox_attached'; taskId: string; repo: string; baseBranch: string }
  /** First line when reconnecting to a chat: history so far + whether it's still running */
  | { t: 'snapshot'; chat: ChatDetail; running: boolean };

export type ChatEventType = ChatEvent['t'];
export type FileChangeKind = 'create' | 'edit' | 'delete';

// ---- REST ----
/** locale: language of the AI responses (set by the server from cookie/Accept-Language) */
export interface ChatRequest { chatId: string; message: string; target?: Target | null; onboarding?: boolean; locale?: Locale; /** "An KI übergeben": id of a pr_feedback event of this chat, wrapped as data into the prompt by the server */ prFeedback?: string }
/** status: currently running ("running") or waiting for the human's reply/approval ("waiting"); missing = idle */
export type ChatStatus = 'running' | 'waiting';
/** Page size of the chat list (/api/chats): a full page means "there may be more". */
export const CHAT_PAGE = 200;
export interface ChatSummary { id: string; title: string; target: Target | null; updatedAt: string; published: number; status?: ChatStatus; /** sandbox attached to the chat (its task) */ taskId?: string; /** a sandbox of this chat was finished (none attached any more) */ sandboxDone?: boolean }
export interface ChatDetail { id: string; title: string; target: Target | null; events: ChatEvent[]; /** turn is currently running (then connect live) */ running?: boolean; /** sandbox attached to the chat (its task) */ taskId?: string }

export type AiProvider = 'claude' | 'codex';
/** shopware = connection to the active shop (legacy name, applies to every platform); platform = which platform is connected */
/** Optional integrations: only when connected does the UI show matching examples */
export interface Integrations { gsc: boolean; sistrix: boolean; github: boolean }
export interface Health { shopware: { url: string; ok: boolean; configured: boolean; error?: string }; ai: { configured: boolean; provider?: AiProvider; /** cost brake (Claude with a monthly budget only): spent/limit in USD this month */ budget?: { spent: number; limit: number; warn: boolean; blocked: boolean } }; platform?: { kind: PlatformKind; label: string; available: boolean }; integrations?: Integrations; /** Sandbox Coding: switched on, Docker reachable (null = not checked), GitHub connected, configured image */ sandbox?: { enabled: boolean; docker: boolean | null; github: boolean; image: string | null } }
/** The platform's path templates ({id} is replaced): admin links and storefront paths for category/product */
export interface PlatformPaths { adminCategory: string; adminProduct: string; adminCms: string; category: string; product: string }
export interface AppConfig { admin: string; storefront: string; imageGen: boolean; docker: boolean; version: string; platform?: PlatformKind; paths?: PlatformPaths }

export interface CategoryRow { id: string; name: string; parentId: string | null; active: boolean; type: string; cmsPage: string | null }
export interface ProductRow { id: string; name: string; number: string; img?: string; cmsPage: string | null }

/** The AI's access scopes: shop data (entities), integrations (gsc, sistrix: data only, no shop entities), sales sums (sales) and web research (web) */
export type ScopeKey = 'products' | 'manufacturers' | 'categories' | 'cms' | 'media' | 'shop' | 'marketing' | 'gsc' | 'sistrix' | 'sales' | 'web';
export interface ScopeInfo { label: string; hint: string }

/** Settings as the UI sees them: secrets only as "present yes/no". */
/** A platform's credentials for the UI: plain-text fields as values, secrets only as "present". */
export interface PlatformPublic { label: string; values: Record<string, string>; has: Record<string, boolean>; configured: boolean; /** adapter ready (otherwise preview: can be saved, but no tools yet) */ available: boolean }
export interface PublicSettings {
  shopware: { url: string; publicUrl: string; user: string; clientId: string; hasPassword: boolean; hasClientSecret: boolean; configured: boolean };
  /** active shop platform (exactly one shop is connected) */
  platform?: PlatformKind;
  platforms?: Partial<Record<PlatformKind, PlatformPublic>>;
  /** budget: monthly cost limit in USD for Claude ('' = none); budgetViaEnv: comes from LOTSE_AI_BUDGET_USD */
  ai: { provider: AiProvider; hasApiKey: boolean; model: string; viaEnv: boolean; docker: boolean; codexModel: string; codexLoggedIn: boolean; budget: string; budgetViaEnv: boolean };
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
  ai?: { provider?: AiProvider; model?: string; codexModel?: string; budget?: string; apiKey?: string | null };
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
// ---- GitHub (settings): token only as "present", never in the browser ----
export interface GithubPublic { hasToken: boolean; /** GitHub user of the token, known after the first successful test */ login: string | null; updatedAt: string | null }
export interface GithubTestResult extends TestResult { login: string | null; /** repositories the token can see */ repos: number | null; /** visible repositories without write access (max. 20) */ readOnly: string[] }
export interface GithubRepo { fullName: string; private: boolean; defaultBranch: string; /** may push (from GitHub's permissions) */ push: boolean; pushedAt: string | null }
export interface GithubBranch { name: string; protected: boolean }
// ---- Sandbox Coding: one container per task from a fixed template; secrets of the environment never reach the browser ----
export type SandboxStepKey = 'check-image' | 'clone' | 'detect-layout' | 'start-container' | 'wait-ready' | 'version-check' | 'import-db' | 'set-domain' | 'db-snapshot' | 'preview-tidy' | 'install-plugin' | 'custom-after-db' | 'theme-compile' | 'custom-final' | 'ready';
export type SandboxCommandKey = 'theme-compile' | 'cache-clear' | 'plugin-refresh' | 'theme-refresh' | 'lint-twig' | 'php-lint';
/** When an own setup command runs: after the database (before theme:compile) or at the very end of the setup */
export type CommandPhase = 'after-db' | 'final';
export interface TemplateDescriptor { id: string; platform: 'shopware'; defaultImage: string; imagePattern: string; steps: { id: SandboxStepKey; custom?: CommandPhase; optional?: boolean }[]; commands: { id: SandboxCommandKey; args: string[] }[] }
/** Environment variable for the task containers; a secret value is never sent back (value '' + hasValue) */
export interface SandboxEnvVar { key: string; secret: boolean; value: string; hasValue: boolean }
export interface SandboxCommand { id: string; label: string; command: string; phase: CommandPhase; timeoutSec: number }
/** off = switched off in the settings, env = LOTSE_SANDBOX=0, open-bind = reachable from the network (or from the task containers) without LOTSE_PASSWORD */
export type SandboxOffReason = 'off' | 'env' | 'open-bind';
export interface SandboxStatus { enabled: boolean; reason?: SandboxOffReason; message?: string }
export interface SandboxEnvPublic {
  /** the switch in the settings (status says whether it is effective) */ enabled: boolean; status: SandboxStatus;
  templateId: string; image: string; memoryMb: number; cpus: number; idleMinutes: number; /** LOTSE_SANDBOX_MAX: containers running at the same time */ maxRunning: number;
  envVars: SandboxEnvVar[]; commands: SandboxCommand[]; updatedAt: string | null;
  /** preselected in "Sandbox starten" (empty = none) */ defaultRepo: string; defaultBranch: string;
  /** "Internet im Container": only after a human allowed it per task (default) or never */ internet: InternetPolicy;
  /** "Screenshot" button in the preview (off by default): captures screenshotPaths on desktop and mobile, only on the user's click */ screenshots: boolean;
  /** storefront paths the "Screenshot" button captures */ screenshotPaths: string[];
  /** stored database preselected in "Sandbox starten" ('' = none, or the one stored was deleted) */ defaultDumpId: string;
  /** "Hinweise für die KI": the user's own notes for the agent of every sandbox (data in its prompt) */ aiNotes: string;
}
export type InternetPolicy = 'approval' | 'never';
/** Both modes: task containers only on the internal network lotse-sandbox. network = Lotse runs in Docker on that network; local = Lotse on the host reaches the container IPs */
export interface SandboxDocker { reachable: boolean; apiVersion: string | null; version: string | null; mode: 'network' | 'local'; error?: string }
/** GET /api/sandbox/env */
export interface SandboxEnvView { env: SandboxEnvPublic; docker: SandboxDocker | null; imagePresent: boolean | null; templates: TemplateDescriptor[] }
/** PUT /api/sandbox/env: secret value empty/undefined = unchanged; a command without id is new */
export interface SandboxEnvPatch {
  enabled?: boolean; image?: string; memoryMb?: number; cpus?: number; idleMinutes?: number; defaultRepo?: string; defaultBranch?: string; internet?: InternetPolicy; screenshots?: boolean; screenshotPaths?: string[];
  /** '' = no stored database preselected */ defaultDumpId?: string;
  aiNotes?: string;
  envVars?: { key: string; secret: boolean; value?: string }[];
  commands?: { id?: string; label: string; command: string; phase: CommandPhase; timeoutSec?: number }[];
}
/** NDJSON lines of POST /api/sandbox/env/check */
export type SandboxCheckEvent = { t: 'progress'; text: string; pct?: number } | { t: 'result'; ok: boolean; message: string; docker: SandboxDocker; imagePresent: boolean; pulled?: boolean };
/** GET /api/sandbox/repo-probe: an (almost) empty repository becomes a new plugin; null = unknown */
/** An account the GitHub token may create a repository under ("Neues Projekt") */
export interface RepoOwner { login: string; kind: 'user' | 'org' }
/** How a sandbox brings its code into the container (A20): auto = what .lotse/sandbox.json or the detection says; plugin and project
 *  as detected; custom = "Eigenes Setup" (a target path and the user's own commands, no Shopware steps) */
export type SandboxMode = 'auto' | 'plugin' | 'project' | 'custom';
/** What "Sandbox starten" found in repo@branch before the start: a plugin/theme, a whole project, an empty repository (new plugin), or
 *  nothing Lotse knows (unknown: then only an own setup works; reason = the detection's message) */
export interface RepoDetected { kind: 'plugin' | 'theme' | 'project' | 'new' | 'unknown'; name?: string; plugins?: number; reason?: string }
/** A command a repository's .lotse/sandbox.json asks to run during the setup (shown to the user; runs only after their approval) */
export interface RepoFileCommand { label: string; command: string; phase: CommandPhase; timeoutSec: number }
/** .lotse/sandbox.json as Lotse read it. hash = SHA-256 of the file: an approval of its commands holds for exactly this content. */
export interface RepoFileInfo {
  hash: string; mode?: Exclude<SandboxMode, 'auto'>; targetPath?: string; image?: string; previewPath?: string; notes?: string;
  commands: RepoFileCommand[];
  /** environment variable NAMES the project needs (values only from the Lotse environment) */ env: string[];
  /** keys of the file Lotse does not know: ignored */ ignored: string[];
}
/** GET /api/sandbox/repo-probe */
export interface RepoProbe {
  empty: boolean | null; suggestedName: string;
  /** null = GitHub or the clone could not tell (the setup decides) */ detected?: RepoDetected | null;
  /** the repository's .lotse/sandbox.json (null = none); error = it exists but is invalid (the setup would stop with that message) */
  repoFile?: (RepoFileInfo & { approved: boolean; missingEnv: string[] }) | { error: string } | null;
}
/** POST /api/sandbox/tasks: attach a sandbox to a chat. source 'none' = "Ohne Projekt starten" (repo/baseBranch ignored). commands/env:
 *  this sandbox's own (typed by the user in "Erweitert"); skipRepoHash: the repository file's commands declined in the dialog */
export interface NewSandboxRequest {
  chatId: string; title?: string; repo: string; baseBranch: string; dumpId?: string; pluginName?: string;
  source?: 'repo' | 'none'; mode?: SandboxMode; targetPath?: string; commands?: { label: string; command: string; phase: CommandPhase }[];
  env?: { key: string; value: string }[]; skipRepoHash?: string;
}
/** The user's choices in "Sandbox starten" for a task (stored on it) */
export interface TaskSetupPublic { source: 'repo' | 'none'; mode: SandboxMode; targetPath?: string; commands: number; env: string[] }
/** .lotse/sandbox.json of the task as the setup read it; state: commands approved, skipped by the user, waiting for a decision, or none */
export interface TaskRepoFile extends RepoFileInfo { state: 'approved' | 'skipped' | 'pending' | 'none' }
/** Code task lifecycle: setting_up → ready ⇄ paused (waking in between) → done; failed/interrupted stop the setup (retry possible) */
export type CodeTaskStatus = 'setting_up' | 'ready' | 'waking' | 'paused' | 'failed' | 'interrupted' | 'done';
export type TaskStepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'interrupted';
/** One setup step. key = template step; 'custom' = an own setup command of the environment (label = its name) */
export interface TaskStep { id: string; key: SandboxStepKey | 'custom'; label?: string; /** own commands: from the environment, this sandbox's start dialog or the repository's .lotse/sandbox.json */ source?: 'env' | 'task' | 'repo'; state: TaskStepState; startedAt?: string; endedAt?: string; /** last lines, redacted */ log: string[]; error?: string }
/** What the repository is: a plugin or a theme plugin below custom/plugins/<name>, or a whole Shopware project (project: its plugins,
 *  apps and configuration, synced into the shop's root; pluginDir ''). isNew: the repository was empty (README, LICENSE, .gitignore at
 *  most) and the plugin is built in the sandbox; nothing was installed during the setup. */
export interface TaskLayout { kind: 'plugin' | 'theme' | 'project' | 'custom'; name: string; pluginDir: string; isNew?: boolean; project?: ProjectInfo;
  /** custom ("Eigenes Setup"): absolute folder in the container the repository is synced to */ targetPath?: string }
/** What a project plugin brings (detected from its files): storefront templates, styles, JavaScript, administration, PHP code, settings,
 *  migrations, texts */
export type ProjectPart = 'storefront' | 'styles' | 'js' | 'admin' | 'php' | 'settings' | 'migrations' | 'snippets';
/** A plugin of a project: below custom/plugins/<dir> or (static) custom/static-plugins/<dir>, installed by its technical name */
export interface ProjectPlugin { name: string; dir: string; static?: boolean; theme?: boolean; composerName?: string; label?: string; parts: ProjectPart[] }
/** Why a config file of a project is not loaded in the sandbox: invalid YAML, an extension the image lacks, an option or class Shopware
 *  did not boot with, the mailer's dsn next to transports, PHP/XML config (not checked), the override's own file name */
export type QuarantineCode = 'yaml' | 'extension' | 'option' | 'class' | 'mailer' | 'unchecked' | 'reserved';
/** A config file not loaded in the sandbox; detail = Symfony's message, the extension(s), the option path, the class, APP_ENV */
export interface ConfigHold { file: string; code: QuarantineCode; detail?: string }
/** A full Shopware project repository (A19), "Overlay" mode: the image's Shopware stays, the project's plugins, apps, config/packages,
 *  config/services*.yaml and src/ are synced over it. The runtime part (appEnv, extensions, envNames) is read from the container during
 *  the setup; quarantined config files are not loaded in the sandbox (no extension for them, or Shopware did not boot with them). */
export interface ProjectInfo {
  plugins: ProjectPlugin[]; apps: { name: string; dir: string }[];
  /** config/packages/** and config/services*.yaml of the repository */ configFiles: string[];
  /** src/ with project code (psr-4 namespaces from composer.json autoload) */ src: boolean; psr4: Record<string, string>;
  /** shopware/core (or shopware/platform) in composer.lock, without "v" */ shopwareVersion: string | null;
  /** the lock's version differs from the image in major.minor: blocks until "Trotzdem fortfahren"; suggest = matching image */
  versionMismatch?: { project: string; image: string; suggest: string };
  /** theme plugin the setup assigned to the storefront (null: none or the dump's assignment) */ theme?: string | null;
  appEnv?: string; extensions?: string[]; envNames?: string[]; extraEnv?: string[];
  quarantined?: ConfigHold[];
  /** config files the boot check took out (Shopware did not start with them); kept until a new setup */ held?: ConfigHold[];
  /** what the sandbox override (config/services_<env>.yml, loaded last) switched to local, one line each ("framework.lock → flock") */ overrides?: string[];
  /** %env(NAME)% the project uses that the container does not define: empty in the sandbox */ envDefaults?: string[];
  /** composer packages the project requires that the image does not have */ missingPackages?: string[];
}
export interface CodeTaskPublic {
  id: string; title: string; goal: string; repo: string; baseBranch: string; branch: string; template: string;
  status: CodeTaskStatus; steps: TaskStep[]; layout: TaskLayout | null; error: string | null;
  /** a container exists and is running (null = none) */ container: { running: boolean } | null;
  /** its container is being stopped right now (paused, not stopped yet): "Pausiere …", no "Fortsetzen" until it is */ stopping?: boolean;
  /** path prefix of the storefront preview (/sbx/<id>.<key>) */ preview: string;
  /** uploaded database dump of the task (metadata only) */ dump: TaskDumpPublic | null;
  prUrl: string | null; createdAt: string; updatedAt: string; lastActiveAt: string; finishedAt: string | null;
  /** the chat the sandbox is attached to (one sandbox per chat) */ chatId: string | null;
  /** technical name chosen for a new plugin (empty repository); null = the repository brings its own plugin */ pluginName: string | null;
  /** the task's pull request (null = not published yet) */ pr: TaskPr | null;
  /** publishing right now, or the last attempt failed / was cut off by a restart (a retry continues idempotently) */ publish: TaskPublish | null;
  /** internet access a human allowed for this task (container attached to lotse-sandbox-egress); null = offline */ internet: { since: string } | null;
  /** screenshots of the sandbox storefront the user took by hand ("Screenshot" in the preview), oldest first; stored in Lotse only */ shots: TaskShotSet[];
  /** the template offers the user a console (tab "Konsole"); missing = none (containerless templates) */ console?: true;
  /** how it was started (A20); missing in rows from before */ setup?: TaskSetupPublic;
  /** the repository's .lotse/sandbox.json (null = none or not read yet) */ repoFile?: TaskRepoFile | null;
  /** the image of this task when the repository asked for another tag than the environment's */ image?: string | null;
  /** first page of the preview (.lotse/sandbox.json "previewPath"); missing = "/" */ startPath?: string;
}
export type ShotDevice = 'desktop' | 'mobile';
/** One stored screenshot; url = GET /api/sandbox/tasks/[id]/screenshots/[file] */
export interface TaskShot { path: string; device: ShotDevice; url: string }
export interface TaskShotSet { id: string; at: string; shots: TaskShot[]; /** why some of the shots are missing */ error?: string }
export interface TaskPr { number: number; url: string; title: string; /** seen by the PR watcher: merged or closed (missing = open or unknown) */ state?: 'merged' | 'closed' }
/** One piece of PR feedback: review (state APPROVED/CHANGES_REQUESTED/COMMENTED), comment on the PR, line comment (path/line), failed check (name) */
export interface PrFeedbackItem { kind: 'review' | 'comment' | 'line' | 'check'; id: string; author?: string; state?: string; name?: string; path?: string; line?: number; body: string; url?: string }
export type PublishStep = 'check' | 'commit' | 'push' | 'pr';
/** Something in a changed file that looks like a secret (file, line, kind – never the value). overridable: may be a false positive
 *  (a stored value, a URL with credentials) and can be published anyway by the user, by id (hash of file and line content). */
export interface SecretFinding { id: string; file: string; line: number; kind: string; overridable: boolean }
export interface TaskPublish { state: 'running' | 'failed' | 'interrupted'; step: PublishStep; error?: string; at: string; /** the secret scan blocked: what it found */ findings?: SecretFinding[] }
/** POST /api/sandbox/tasks/[id]/publish: title and description only (branch and base are fixed by the server); allowFindings = ids
 *  of secret findings the user publishes anyway ("Trotzdem veröffentlichen", audited) */
export interface PublishRequest { title: string; body: string; allowFindings?: string[] }
export interface PublishResult { task: CodeTaskPublic; pr: TaskPr; action: 'created' | 'updated'; /** changed files in the pull request */ files: number }
/** GET /api/sandbox/tasks/[id]/pr: live state from GitHub (cached briefly); checks null = not readable with the token */
export interface PrStatus { number: number; url: string; title: string; state: 'open' | 'closed' | 'merged'; draft: boolean; checks: { total: number; success: number; failure: number; pending: number } | null; fetchedAt: string }
/** GET /api/sandbox/tasks/[id]/diff: changes in the workspace against the base branch (redacted, capped) */
export interface TaskDiff {
  files: { path: string; added: number; removed: number; status: 'added' | 'modified' | 'deleted' | 'renamed' }[]; diff: string; truncated: boolean;
  /** pushed before: changes since that push exist (missing = never pushed) */ unpublished?: boolean;
  /** local commits on top of the base branch (the AI's git_commit, earlier publishes), newest first */ commits?: TaskCommit[];
  /** changed paths not committed yet (publishing adds them as one last commit) */ uncommitted?: string[];
}
/** What a plugin ZIP for the Shopware admin would contain (GET /api/sandbox/tasks/[id]/plugin-zip?check=1). problems block the download:
 *  what Shopware 6.7 needs to list an uploaded plugin at all (type, name, description, version, autoload, plugin class, label as an
 *  object – checked against a real shop) plus empty, too large, a key or token; warnings do not (no Shopware version required, class file
 *  not found, dependencies without vendor/). */
export type PluginZipProblem = 'noComposer' | 'badJson' | 'type' | 'name' | 'description' | 'version' | 'autoload' | 'pluginClass' | 'pluginName' | 'label' | 'empty' | 'tooLarge' | 'secret';
export type PluginZipWarning = 'requireCore' | 'classFile' | 'vendorMissing';
export interface PluginZipCheck {
  ok: boolean; /** technical name = top folder and file name */ name: string | null; version: string | null;
  problems: PluginZipProblem[]; warnings: PluginZipWarning[]; files: number; bytes: number; /** vendor/ included (dependencies besides Shopware) */ vendor: boolean;
  /** for 'secret': the file (no content) */ secretFile?: string;
  /** a project: its plugins to choose from (folder relative to the repository) and the one checked */ plugins?: { dir: string; name: string }[]; plugin?: string;
}
/** A local commit of the task's worktree; published = contained in the last push */
export interface TaskCommit { sha: string; at: string; subject: string; published: boolean }
/** Dump of a task: imported once and deleted right after the import (also on failure); a stored database (library) stays.
 *  restored = its data came from the snapshot of an earlier import (no import). versionMismatch blocks until "Trotzdem fortfahren". */
export interface TaskDumpPublic { name: string; size: number; sha256: string | null; imported: boolean; deleted: boolean; ignoreVersion: boolean; versionMismatch?: { dump: string; image: string }; library?: boolean; restored?: boolean }
/** An uploaded dump (GET/POST /api/sandbox/dumps/<id>…): metadata, never the content. expiresAt null = a complete stored database (kept until deleted) */
export interface DumpPublic { id: string; name: string; size: number; received: number; status: 'uploading' | 'ready' | 'deleted'; sha256: string | null; taskId: string | null; expiresAt: string | null; library: boolean }
/** "Gespeicherte Datenbanken" (GET /api/sandbox/dumps): complete stored databases. snapshot = a quick-start snapshot exists for the configured image */
export interface LibraryDumpPublic { id: string; name: string; size: number; shopwareVersion: string | null; createdAt: string; uploadedBy: string | null; lastUsedAt: string | null; snapshot: boolean }
/** NDJSON lines of GET /api/sandbox/tasks/[id]/events: full task on transitions, single log lines in between */
export type TaskEvent = { t: 'task'; task: CodeTaskPublic } | { t: 'log'; step: string; line: string } | { t: 'deleted' }
  /** an event the server added to the task's chat between turns (PR feedback): the open workspace shows it without reloading */
  | { t: 'chat'; event: ChatEvent };
/** Console of a sandbox (tab "Konsole"): an interactive shell in the task container, for the user only (never the AI). */
export type ConsoleCloseReason = 'user' | 'exit' | 'idle' | 'pause' | 'finish' | 'disabled' | 'restart' | 'stopped';
export interface ConsoleSessionPublic { id: string; openedAt: string; cols: number; rows: number }
/** GET /api/sandbox/tasks/<id>/console/<session>?from=<seq> (NDJSON): output chunks (base64 bytes, numbered; `from` replays the
 *  buffered ones, e.g. after a reload), then the end with its reason. */
export type ConsoleEvent = { t: 'out'; seq: number; data: string } | { t: 'end'; reason: ConsoleCloseReason };
/** Most consoles one task can have open at once */
export const CONSOLE_MAX = 3;
/** A console without input for this long is closed */
export const CONSOLE_IDLE_MINUTES = 30;
/** SEO overview: levers from Search Console and Sistrix as ready-made tasks (prompt) for a new chat */
export interface SeoItem { id: string; source: 'gsc' | 'sistrix' | 'site'; kind: 'meta' | 'gap' | 'striking' | 'cannibal' | 'decline' | 'keyword' | 'onpage' | 'site'; title: string; detail: string; metrics: { label: string; value: string }[]; /** sort value (estimated impact) */ impact: number; prompt: string; /** done/ignored by the user: hidden */ mark?: SeoMark }
/** Done = hidden until a fetch at least SEO_DONE_RECHECK_DAYS later still reports the lever; ignored = hidden permanently */
export interface SeoMark { state: 'done' | 'ignored'; at: string }
export const SEO_DONE_RECHECK_DAYS = 7;
/** OnPage crawl (Sistrix Optimizer): ok, no project, several projects without assignment (selection needed) or no crawl yet */
export interface SeoOnpage { status: 'ok' | 'none' | 'choose' | 'empty'; project?: { hash: string; name: string }; projects?: { hash: string; name: string }[]; lastCrawl?: { date: string; pages: number | null; errors: number | null; warnings: number | null; notices: number | null } | null }
export interface SeoOverview { gsc: boolean; sistrix: boolean; /** technical check of the live pages ran */ site?: boolean; items: SeoItem[]; errors: { source: 'gsc' | 'sistrix' | 'site'; error: string }[]; generatedAt: string; onpage?: SeoOnpage; /** live pages: checked pages and time */ siteChecked?: { base: string; pages: { kind: string; url: string }[] }; /** from the cache (costs no credits); "Aktualisieren" (refresh) refetches */ cached?: boolean }
/** Impact of an applied change in Search Console: 28 days before vs. the same period after (SEO section → Wirkung) */
export interface SeoImpact {
  id: string; entity: 'product' | 'category' | 'landing-page'; entityId: string; label: string;
  /** meta = meta title/description, content = name/description/FAQ, layout = new layout or page content */
  kind: 'meta' | 'content' | 'layout'; fields: string[]; changedAt: string; chatId?: string;
  /** too-early = not enough days after the change yet; superseded = changed again before it was measured */
  status: 'too-early' | 'preliminary' | 'complete' | 'superseded';
  measurableFrom: string; completeFrom: string;
  verdict?: 'better' | 'worse' | 'unclear' | 'little-data';
  before: { clicksPerDay: number; ctr: number; position: number };
  change?: { clicksPerDay: string; ctr: string; position: number };
  /** the field has a different value today (undone or changed again) */
  drift?: boolean;
  measuredAt?: string; dismissed?: boolean;
}
export interface SeoImpactList { connected: boolean; items: SeoImpact[] }
/** AI costs (cost brake): month = current calendar month (UTC); budget null = no limit; only Claude has USD costs (Codex: subscription) */
export interface UsageStatus {
  provider: AiProvider; budget: number | null;
  month: { from: string; cost: number; turns: number };
  today: { cost: number; turns: number };
  days: { day: string; cost: number; turns: number }[];
  /** share of the budget used (0..1+), null without budget */
  used: number | null;
  /** from WARN_SHARE of the budget: warning; blocked: no new Claude turns this month */
  warn: boolean; blocked: boolean;
}
export const WARN_SHARE = 0.8;
/** Home page card: visibility history (oldest week first) */
export interface SistrixOverview { connected: boolean; domain?: string; country?: string; weeks?: number; series?: { date: string; value: number }[]; latest?: { date: string; value: number } | null; changePct?: number | null; creditsUsed?: number | null; error?: string }
