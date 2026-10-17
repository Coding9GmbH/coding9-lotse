[Deutsch](../architektur.md) · **English**

# Architecture

How Lotse works internally: flow of a chat turn, protection layers, data storage, preview, layout publishing, shop check, prompts, internationalization and tests. Usage is described in the [user guide](user-guide.md), the platform interface in [platform.md](platform.md).

## 1. Overview

```
Browser ──► proxy.ts ──► Next.js (App Router)
              │            ├─ app/api/**        REST + chat stream (NDJSON)
              │            ├─ app/shop/**       storefront proxy for the preview
              │            └─ interface         React 19, one reducer (lib/chat-state.ts)
              │
              └─ host/origin check, login, storefront paths → /shop

Chat turn:   Agent (Claude SDK | Codex) ──► tools (tools.ts) ──► guarded read client ──► Shop
                                   │
                                   └─► propose_* / publish_page ──► change set ──► approval (human)
                                                                                      │
                                              Executor (changes.ts, sole writer)  ◄───┘
                                              ├─ audit log + undo steps (SQLite)
                                              └─ Shop (privileged client)
```

Stack: Next.js 16 · React 19 · TypeScript (strict) · SQLite (`node:sqlite`) · Claude Agent SDK or OpenAI Codex SDK. Runs as a Docker image (`output: 'standalone'`) or via `npm run dev`.

## 2. Flow of a chat turn

1. **Start.** `POST /api/chat` starts a turn and responds as an NDJSON stream, one JSON line per event (`ChatEvent`, types in `lib/protocol.ts`). The turn **keeps running on the server**, even if the connection drops or the user switches chats. `GET /api/chat` reconnects: first a `snapshot` of the history so far, then the live events.
2. **Prompt.** `prompt.ts` assembles the system prompt from `prompts/common/*.md` and `prompts/<platform>/*.md` (placeholders like `{{shop}}`), plus the style guide block, the rules (`rulesPromptBlock`), the reply language (`REPLY_LANGUAGE`, section 12) and, with context, a target hint (`target-hint.ts`).
3. **Tools.** The agent gets the tools of the platform and of the feature modules (`tools.ts`, `features/`). Reading goes through the guarded read client; **there is no writing**, only proposals (`propose_*`, `publish_page`).
4. **Follow-up questions.** `ask_user` creates a `question` event; the turn waits, `POST /api/answer` resumes it.
5. **Proposal → approval.** A proposal becomes a `ChangeSet` (rows with before/after, warnings, selection). The tool waits for the decision; `POST /api/approve` passes the approval and the selected rows.
6. **Writing.** The executor writes the selected rows at a throttled rate, records an undo step per row and logs the result in the audit log. `POST /api/changesets/undo` reverts an application.
7. **End.** `done` closes the turn; open steps are closed in the interface.

### Providers
- **Claude** (Agent SDK, in-process MCP server `shop`): tools in the same process.
- **Codex** (ChatGPT subscription): Codex's own tools (shell, files, web) disabled, file access blocked via profile; shop tools only via `/api/mcp/<chat>` with a random token per chat.

### Chats with a sandbox (Sandbox Coding)
A sandbox is attached to an ordinary chat of the workspace (`code_tasks.chat_id`; at most one unfinished per chat, `attachedTask`). Only the user attaches it (`POST /api/sandbox/tasks` with `chatId`, from the “Start sandbox” dialog or the card of the `start_sandbox` tool, which the AI has in normal chats while Sandbox Coding is on and which only shows a `sandbox_offer`). `Session.taskId` is determined again at the start of every turn: with a sandbox the turn gets **only** the sandbox tools – no shop tools, no live shop – and the prompt from `prompts/code/01-common.md` + `prompts/code/<template>.md` (with the worktree, title/goal quoted as data). The AI session belongs to working directory and tool set: when the sandbox changes (attached, finished) `agent.ts` starts a new session with a short recap of the history so far (`agentScope`, `recapOf`). Before every turn `prepareCodeTurn` checks that Sandbox Coding is on, waits for a running setup and wakes a paused container (`sandbox_status`); the idle sweeper does not pause it during the turn. **Claude** works with Claude Code’s own tools `Read`, `Edit`, `Write`, `Glob`, `Grep`, `TodoWrite` with `cwd` = the worktree (never Bash, Task, NotebookEdit; web only with web research); every call goes through a `PreToolUse` hook and `canUseTool` (`sandbox/native-tools.ts`: every path realpath-checked inside the worktree, `.git`/secrets/`config/jwt` denied, no writes into `vendor/`/`node_modules/`, paths with `~` refused, `Grep` gets the exclusion of secret files appended as the last glob); after `Edit`/`Write` a `PostToolUse` hook mirrors the file into the container and shows it as `file_change`. **Codex** runs with `workingDirectory` = the worktree, `workspace-write` (profile: only the worktree writable, `.git` denied), without network and without its own shell; its patches (`file_change`) only count if all paths are inside the worktree and allowed; refused paths are reverted by `revertPaths` (from `HEAD`, or deleted) and the turn is aborted; the others are mirrored. MCP tools (`sandbox/workspace-tools.ts`): `sandbox_bash` (any command line via `bash -lc` as `www-data` in `/var/www/html` **inside the container**, full sync first, under the task lock, timeout 120 s/max 600 s, output redacted and capped at 12 KB; after `theme:compile`/`cache:clear` etc. `preview_reload`), `delete_file`, `git_diff`, `read_sandbox_page`, `get_environment` (variables by name only), `ask_user`, `request_internet` (card `internet_request`, waits like a change set for the decision via `/api/approve`; only the approval attaches the container to the network `lotse-sandbox-egress` via `sandbox/internet.ts`), `propose_publish`; Codex additionally `list_files`, `read_file`, `search_files`. Claude runs without `settingSources`, with at most 120 steps, under the cost brake. On the right `Workspace.tsx` shows `SandboxPanel` (status line, tabs Preview/Setup/Changes/Pull request) instead of the draft preview. Former separate code chats (`mode: 'code'`) thereby are chats with an attached sandbox; their old AI session is not resumed.

**Publishing** (`server/sandbox/publish.ts`, `POST /api/sandbox/tasks/[id]/publish`): only by a click in the “Pull request” tab; the body has only a title (≤ 200) and a description (≤ 20,000), branch (`lotse/<slug>-<id>`, fixed at creation) and base come from the task. The AI can only show a card (`publish_proposal`) with `propose_publish`. Flow: one lock per task (`markPublishing`; a second click, a running AI turn or “Finish task” → 409, a new AI turn waits), preflight (changes exist, at most 300 files/5 MB per file/25 MB, no paths outside, no `.github/workflows`/`.github/actions` and no `action.yml` (local actions run with the repository secrets), no protected files, no symlinks out of the repository, a secret scan of every line that is new against the base branch in the files on disk – tokens, private keys, URLs with credentials, every secret stored in Lotse; title and description too), audit `kind: 'code-pr', status: 'started'`, `commitAll` (author `Lotse <lotse@users.noreply.github.com>`, the logged-in user as `Co-Authored-By` with an address under `.invalid`), `pushBranch` (only `refs/heads/lotse/*`, a re-push with `--force-with-lease` on the stored `pushed_sha` – if the branch was deleted on GitHub (e.g. after a merge) it is created anew, without lease and without force –, saved right after the push), then an open pull request with `head=<owner>:<branch>` is reused (PATCH of title and description), otherwise `POST /pulls` (not as a draft). `pr_number`, `pr_url` and `pushed_sha` are columns of `code_tasks`, the progress is `task.publish` (`check` → `commit` → `push` → `pr`, with a German cause on failure); a restart turns `running` into `interrupted` (`interruptStale`). A retry is idempotent (nothing new to commit, no push, the open pull request is found – also after a lost response to the create). Afterwards the audit result (`status: 'applied'`, repository, branch, link, files; errors `failed`, a preflight block `decision: 'rejected'`), the chat event `pr` (saved at once) and `GET …/pr` for state, draft and the checks of the head commit (cached in memory for 45 s). Because git’s output is redacted, the secret scan reads the files themselves, not the patch, and compares them byte by byte with the unredacted base version (`readBaseBlob`).

## 3. Protection layers

| Layer | Where | Effect |
|---|---|---|
| Host/origin/marker check | `proxy.ts` | Only allowed host names; loopback names only from loopback (in the container also private gateway addresses with loopback publish); `Origin` must match `Host`; write calls require `x-lotse: 1` |
| Login | `proxy.ts` | `LOTSE_PASSWORD` → Basic Auth (constant-time comparison), `/api/mcp/*` has its own token, `/api/ping` open |
| Read client with allowlist | `policy.ts` + reader per platform | Only allowed entities/associations/fields; customer, order, payment and credential data blocked; areas from the settings; every access in the access log |
| Proposals only | `tools.ts`, `changes.ts` | The AI's tools contain no writing; the executor is the only place that writes |
| Approval + audit + undo | `changes.ts`, `audit.ts` | Old→new, row selection, log, undo per row |
| Shop protection | `changes.ts`, clients | Throttling (`LOTSE_WRITE_CONCURRENCY`), max. 300 entries per set (`MAX_ITEMS`), timeouts, backoff on 429/503 |
| Credentials | `db.ts` | AES-256-GCM, key `secret.key` in the data volume, never sent to the AI, removed from error texts |
| Git and GitHub | `git.ts`, `github.ts` | `git.ts` is the only place that starts git: no shell, minimal environment, no system/global config, hooks, fsmonitor or credential helper, https only. The GitHub token only goes into the environment of a single git process as `http.<host>/.extraheader` via `GIT_CONFIG_*`, never into argv, URLs, `.git/config` or output (everything passes through `redact()`). The git directory lives outside the worktree; repository and branch names are validated, pushes only go to `refs/heads/lotse/*`, no force push (only `--force-with-lease` on the state Lotse pushed last) |
| Sandbox Coding | `sandbox/env.ts`, `sandbox/runner.ts`, `sandbox/docker-engine.ts`, `sandbox/templates/`, `sandbox/tasks.ts`, `sandbox/jobs.ts`, `sandbox/sync.ts`, `sandbox/native-tools.ts`, `sandbox/offer-tool.ts`, `sandbox/dumps.ts`, `sandbox/reconcile.ts` | Off by default (switch in the settings, `LOTSE_SANDBOX=0` hard off, blocked without `LOTSE_PASSWORD` on an open address). `runner.ts` is the only Docker interface (Engine API over `node:http`, unix socket or `tcp://` to the socket proxy; a fake for tests with `LOTSE_SANDBOX_RUNNER=fake`): fixed operations, only containers labelled `lotse.managed=1`, specs without host paths/privileges. Templates are code (only `dockware`: image pattern, steps, command allow-list with validated arguments). Environment in kv `sandbox`: image, limits, variables (secret ones sealed, in `redact()` including base64/hex; code in the container can read them, so they count as visible to the AI), own setup commands. Tasks in the table `code_tasks` (JSON row): `jobs.ts` runs the steps detached from the request (AbortController and lock per task, every transition persisted at once, logs redacted and cut to 200 lines), pauses/wakes containers and keeps `LOTSE_SANDBOX_MAX`; `sync.ts` transfers the working folder as a tar archive (without `.git`/secrets); `dumps.ts` receives database dumps in chunks (table `code_dumps` with metadata only, the file in `<data>/dumps/<id>/data` with mode 0600, not in backups), the “Import database” step streams it into the container as tar and deletes it on both sides afterwards; `reconcile.ts` cleans up after a restart, pauses idle containers and deletes expired or orphaned dumps |
| Preview isolation | `app/shop/**`, `DraftFrame.tsx` | Shop HTML runs in an opaque origin, see below |

Details and how to report issues: [SECURITY.en.md](../../SECURITY.en.md).

## 4. Data storage

Everything lives in the data folder (`AICB_DATA`, in the container `/data` as volume `lotse-data`).

| File | Contents |
|---|---|
| `aicb.db` | Chats with event history (only the latest draft keeps its HTML), audit log, access log, settings and key-value data: `styleguide`, `shopcheck_run`, `custom_checks`, `checks_disabled` |
| `knowledge.db` | Knowledge base: documents, text chunks (BM25 search), custom rules (`rules`, with scope and optional category) |
| `secret.key` | Key for the encrypted credentials |
| `staging/`, files | Staged images and attachments, kept locally only until approval |
| `claude/`, `home/` | Claude Agent SDK sessions |

Backup: `make backup`, restore: `make restore FILE=…`. Always the whole volume, otherwise stored credentials are useless.

## 5. Preview

Three views, none with access to Lotse:

| View | Source | Isolation |
|---|---|---|
| **Current** | Shop page via the proxy `/shop/…` in an iframe | `sandbox="allow-scripts allow-forms"` (no `allow-same-origin`) and CSP `sandbox allow-scripts allow-forms; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'` via response header: opaque origin even on direct navigation, no third-party scripts |
| **Sandbox** (Sandbox Coding) | Storefront of the task container via `/sbx/<id>.<key>/…` | like **Current**, plus `connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'self'` |
| **Draft** (simple) | `renderPreview` in `cms.ts` renders the spec in the shop's theme CSS | `srcdoc`, `sandbox="allow-scripts"` |
| **Draft on the real page** (Shopware) | Real target page, only `.cms-sections` replaced | as draft |
| **Draft in the real theme** (Shopify, Magento, OpenMage) | Real target page, published HTML in the content area (`theme-preview.ts`) | as draft |

**Proxy `/shop`** (`app/shop/[[...path]]/route.ts`): fetches the storefront via the internal address, rewrites shop URLs to `/shop`, removes cookies and frame restrictions, sets the CSP, injects the frame script (`lib/preview-frame.ts`: highlighting, scroll, via `postMessage`) and serves images/fonts with CORS. Redirects: same origin as a `/shop` path; same site (parent domain, e.g. `stage.` → `www.`) followed server-side (at most 3 hops); foreign domains never. Root-relative paths of the shop (`/theme`, `/media`, `/thumbnail` …) are redirected to `/shop` by `proxy.ts`. Shared parts (headers, CSP, rewriting, frame script) live in `server/storefront-proxy.ts`.

**Proxy `/sbx`** (`app/sbx/[task]/[[...path]]/route.ts`, `server/sandbox/preview.ts`): preview of a code task's storefront, usable for testing (GET/HEAD/POST/PUT/PATCH/DELETE, body at most 2 MB). The upstream comes only from Lotse's own record of a container it started (alias on the `lotse-sandbox` network or the port on `127.0.0.1` Docker reports), never from the request; requests go out with `Host: localhost`, redirects are returned only within the sandbox as `/sbx` paths and never followed by Lotse itself. The page runs in an opaque origin: the browser sends neither cookies nor a Referer. So the path carries a key (HMAC of the task id with the key in the data folder) that ties form and ajax requests to the task (wrong key = 404), Lotse keeps the sandbox's cookies in a jar per task in memory (never sent to the browser), and a small script at the start of `<head>` replaces `document.cookie` (readable cookies from the jar, writes via `sendBeacon` to `…/__lotse/cookie`) and Web Storage (in memory) and keeps `fetch`/XHR paths below the prefix. Absolute `http://localhost` URLs and root-relative paths in HTML/CSS are rewritten to the prefix; requests without the prefix from a preview stylesheet are sent to the same sandbox by `proxy.ts` based on the Referer. Opening the preview of a paused task wakes it (“Environment starting …” with automatic reload); every request counts as activity.

**Draft on the real page** (`real-page.ts`, `platform/shopware/pages.ts`):
1. `previewData` loads the target page (`/detail/{id}`, `/navigation/{id}`, at most 2 redirects, only within the shop, 12 s, 1.5 MB, 60 s cache).
2. `stripScripts` removes comments as well as scripts and preload hints from foreign domains; shop scripts remain.
3. `extractBlocks` extracts the real dynamic blocks (buy box, heading, description/reviews, cross-selling, product listing, filters), also for themes with custom block types (markup detection).
4. `renderPreview` inserts the draft and the real blocks into `.cms-sections` (`spliceSections`). If it cannot find the CMS area, it falls back to the simple view.
5. Without a named target, `withPreviewDefaults` picks an active product with a cover image.

**Draft in the real theme** (`theme-preview.ts`, HTML platforms): target page via `lookup.entityPaths` (product, category/collection) or the home page for landing pages, fetched as above (redirects only within the shop, 12 s, 1.5 MB, 60 s cache, `stripScripts`, shop URLs to `/shop`). The content area is `<main>` (Shopify, Magento 2) or `.col-main` (OpenMage); `spliceMain` puts `renderPageParts` before and after the theme content there, landing pages replace it (`renderPageHtml`). Product content without `theme-main` (Magento, OpenMage) goes into the product description as when publishing (`.product.attribute.description .value` or `.box-description .std`). Protocol-relative shop addresses (`//host/…`, Shopify) also go through `/shop`, so the theme scripts stay. While streaming only from the cache; without a content area the simple rendering.

Streaming: while writing, the server sends `draft_partial` (only `<body>` via `postMessage`, theme CSS and scroll position stay), then `draft` (new document, scroll position restored). `PREVIEW_VERSION` (`tools.ts`) forces stored drafts to be regenerated on load.

## 6. Publishing layouts (Shopware)

`publish_page` → `buildPublish` (`platform/shopware/pages.ts`) → `buildPublishChangeSet` (`changes.ts`) → applier `applyPublish`.

1. **Resolve scope.** `resolvePublishScope` turns `allCategories`, `allProducts`, `productsInCategoryId` etc. into fixed ID lists (pages of 500, cap `SCOPE_MAX = 1000`). Ambiguous input is rejected. Products: active main products (variants inherit). Categories: type `page`, without root.
2. **Change set.** Up to 15 targets, one row per target; above that a summary (“N, of which M with their own layout, will be replaced”) plus scope and 8 samples. Metadata only for a single category.
3. **Apply.** Create the layout (`cms-page`), then the assignments with limited concurrency; on the first error no further target starts and everything is rolled back (atomic). One undo step per target with the previous `cmsPageId`.
4. **Intermediate state.** `trackedUndo` reports every step immediately; a crash does not lose any undo.

Other platforms publish via their own paths (Shopify: theme templates, Magento/OpenMage: CMS pages or Page Builder), see [platform.md](platform.md).

## 7. Style guide, rules, knowledge

- **Style guide** (`styleguide.ts`): derived from theme configuration, storefront CSS, logo and copy (`get_brand_signals` → `save_styleguide`) and passed into the prompt as a binding block. It also provides CSS variables (`--sg-*`) for the preview and custom HTML. Free text in it is treated as data, not as instructions.
- **Rules** (`knowledge.ts`, table `rules`): text, scope (`all|products|pages|seo`), optional `target` (category). The prompt block is capped (40 rules, 3000 characters), the rest is available via `list_rules`. Category rules appear in the block with name and ID; the AI checks membership via the product's categories.
- **Knowledge**: documents are split into chunks and searched locally with BM25 (`search_knowledge`, `get_product_knowledge`). Excerpts are data, not instructions, and appear with their source. Uploaded content is confirmed with the user before being added.

## 8. Shop check and custom checks

- **Registry** (`checks.ts`): `registerCheck`/`registerPlatformCheck` with `id`, `area`, `scopes`, `platforms`, `run`. `run` only reads via the guarded read client of the run and returns `CheckFinding`s with a `fixPrompt`.
- **Run** (`shopcheck.ts`, `shopcheck-run.ts`): at most one run at a time, concurrency 3, 90 s per check, errors isolated per check; result in the kv store, valid for the same shop and the same areas. Stale after 6 hours (incomplete runs after 5 minutes). Areas blocked in the settings are skipped.
- **On/off**: `checks_disabled` (list of IDs); the run filters them out.
- **Custom checks** (`lib/custom-checks.ts`, `server/custom-checks.ts`): declarative, conditions on fixed fields (`descriptionWords`, `descriptionChars`, `metaTitleChars`, `metaDescriptionChars`, `nameChars`, `price`, `listPrice`, `stock`, `hasImage`), comparisons `lt|lte|gt|gte|eq|neq`, combination `all|any`. No code, no free-form queries.
- **Neutral product view**: `PlatformAdapter.scanProducts(reader)` returns active products as `NeutralProduct` (cap 2500 products, 1000 on Shopify; `capped` → “at least”). Shopware: `platform/shopware/scan.ts`; Shopify, Magento, OpenMage: `neutralScan` in their `checks.ts`, from the same scan as the built-in checks (read once per run). Unknown values (`null`) never match.
- **Chat tools** (`features/shopcheck.ts`): `list_checks`, `create_check` (with a dry run: match count before saving), `update_check`, `set_check_enabled`, `delete_check`. Creating, changing, deleting and disabling ask the user.
- **API**: `GET /api/shopcheck`, `POST /api/shopcheck` (check again), `GET /api/shopcheck/checks`, `PUT|DELETE /api/shopcheck/checks/{id}`.

## 9. API overview

| Path | Purpose |
|---|---|
| `POST/GET /api/chat` | Start a turn (NDJSON) / reconnect |
| `GET /api/chats`, `POST /api/reset` | History, clear chat |
| `POST /api/answer`, `POST /api/approve`, `POST /api/changesets/undo` | Answer follow-up question, approval, undo |
| `POST /api/files`, `POST /api/upload` | Attachments, images |
| `GET/PUT /api/settings`, `GET /api/config`, `GET /api/health`, `GET /api/ping` | Settings, path templates/version, status (incl. cost brake), health check |
| `GET /api/usage` | AI costs: month, today, last 30 days, monthly budget |
| `GET/PUT /api/styleguide` | Style guide |
| `/api/knowledge`, `PATCH|DELETE /api/knowledge/docs/{id}`, `POST /api/knowledge/rules`, `PUT|DELETE /api/knowledge/rules/{id}` | Knowledge base and rules |
| `/api/shopcheck`, `/api/shopcheck/checks[/{id}]` | Shop check, checks |
| `GET /api/categories`, `GET /api/products` | Context selection |
| `GET /api/audit`, `GET /api/access-log` | Logs |
| `/api/gsc`, `/api/sistrix`, `/api/codex/login` | Search Console, Sistrix, Codex sign-in |
| `GET/PUT/DELETE /api/github`, `POST /api/github/test`, `GET /api/github/repos`, `GET /api/github/branches?repo=` | GitHub token (only "present" + login), connection test, repositories, branches |
| `GET/PUT /api/sandbox/env`, `POST /api/sandbox/env/check` | Sandbox environment (switch, image, limits, variables masked only, own commands; Docker is only contacted while the sandbox is on), “check environment” as NDJSON with progress (403 while off) |
| `POST /api/sandbox/dumps`, `GET/PUT/DELETE /api/sandbox/dumps/{id}` (`PUT ?offset=`), `POST …/{id}/complete`, `POST /api/sandbox/tasks/{id}/dump` | Database dump: announce an upload (name, size ≤ `LOTSE_DUMP_MAX_MB`), raw chunks ≤ 16 MB at the current length (otherwise 409 with `received`, optional `x-chunk-sha256`), complete (size, SHA-256, gzip/SQL checked, otherwise 415/422 and deleted), discard; “Replace database” for a task. Responses carry metadata only, never the content |
| `GET/POST /api/sandbox/tasks`, `GET/DELETE /api/sandbox/tasks/{id}`, `POST …/{id}/start\|stop\|pause\|resume\|finish`, `GET …/{id}/events`, `GET …/{id}/diff` | Sandboxes: attach to a chat (`chatId`, one per chat, 409 otherwise; checks repository access first; line `sandbox_attached` in the chat), start/retry the setup from a step, stop, pause, resume, finish (detaches the sandbox from the chat), delete (only the record, the chat stays; every action in the audit); events as NDJSON (snapshot, then live); “Changes” against the base branch (redacted, without secrets, at most 400 KB). The chat runs like any other through `POST /api/chat`; `GET /api/chats/{id}` and the chat list name the attached sandbox (`taskId`), deleting a chat finishes it |
| `GET /api/seo`, `PUT /api/seo/marks`, `GET\|POST\|PUT /api/seo/impact` | SEO area: levers, done/ignored, impact of applied changes (stored / measure now / hide) |
| `/api/mcp/{chat}` | MCP endpoint for Codex (token per chat) |
| `GET /shop/**` | Storefront proxy (GET only) |

## 10. Tests and quality

- `npm run check`: type check (`next typegen && tsc`), ESLint, tests.
- Tests (`node:test`, structure mirrors `src/`): pure logic, executor against fake Shopware, platform adapters against fakes (`tests/support/`: Shopify, Magento, OpenMage), proxy and reducer tests.
- CI (`.github/workflows/docker.yml`): type check, lint, tests on pull requests and `main`; image build and smoke test on `main`; release on tag `vX.Y.Z`.

## 11. Extending

| Goal | Where |
|---|---|
| New block type | `BLOCKS` in `cms.ts` + preview renderer; the agent receives the catalog automatically |
| New check (built-in) | `registerCheck` in a feature module or `registerPlatformCheck` in the adapter; add the title in `lib/custom-checks.ts` (`builtinTitle`) |
| New field for custom checks | `CHECK_FIELDS` + `fieldValue` in `lib/custom-checks.ts`, value in `NeutralProduct` and in all four `scanProducts` |
| New feature module | Register `features/<name>.ts` (`Feature`) in `features/index.ts`; tool names in `lib/labels.ts` |
| New platform | [platform.md](platform.md), section 11 |
| New language | `LOCALES` and `LOCALE_NAMES` in `lib/i18n/locales.ts`, a dictionary per namespace in `lib/i18n/messages/`, `INTL_LOCALE`, `REPLY_LANGUAGE` in `server/prompt.ts` |

### Shared building blocks

Check here before writing a new helper; avoid copies of the same logic across modules.

| Purpose | Building block |
|---|---|
| HTML text: drop blocks, extract text, decode entities, read an attribute (linear, ReDoS-safe) | `lib/text.ts`: `stripBlocks`, `htmlToText`, `decodeEntities`, `attr`, `HEADINGS` |
| Escape HTML, strip HTML | `lib/format.ts`: `esc`, `stripHtml` |
| Take foreign HTML into shop content (allowlist) | `server/html-sanitize.ts`: `sanitizeHtml`, `safeUrl` |
| Shop HTTP with a concurrency limit and 429/503 retry | `server/shop-http.ts`: `createLimiter`, `shopFetch`; `sleep` from `server/retry.ts` |
| Fetch shop pages with every redirect checked (SSRF) | `server/storefront.ts`: `fetchShopPage`, `assertShopUrl` |
| Read responses/bodies with a size cap | `server/http.ts`: `readLimited`, `readBodyLimited`; `server/media.ts`: `readCapped`, `MAX_IMAGE_BYTES` |
| Parse files (PDF, DOCX, XLSX with zip-bomb guard) | `server/knowledge-text.ts`: `extractSegments` |
| Split lists, error text | `server/util.ts`: `chunks`, `errMsg` |
| Tools: result, error, limit | `server/tool-kit.ts`: `ok`, `guard`, `lim` |
| Magento/OpenMage: apply helpers, link check | `platform/magento/kit.ts`, `platform/magento/grouped.ts`, `checkLinksWith` in `platform/magento/links.ts` |

## 12. Internationalization

The interface and AI replies are available in German (default) and English. Everything lives in `src/lib/i18n/`:

| File | Purpose |
|---|---|
| `locales.ts` | `LOCALES` (`'de' \| 'en'`), `DEFAULT_LOCALE = 'de'`, `LOCALE_NAMES`, `INTL_LOCALE` (BCP 47 tag for `Intl`: dates, numbers), cookie `LOCALE_COOKIE = 'lotse_lang'`; `resolveLocale` (cookie before `Accept-Language` before default) and `requestLocale(req)` for route handlers |
| `messages/<ns>.ts` | Typed dictionaries per namespace (`common`, `chat`, `settings` …): `export const de = {…}` and `export const en: typeof de = {…}`. The type enforces identical keys; texts with placeholders or plurals are functions (`t.common.minutesAgo(5)`). `tests/lib/i18n.test.ts` checks that both languages have the same shape |
| `index.ts` | `messages(locale)` → `Messages`, `formatNumber(n, locale)` |
| `I18nProvider.tsx` | Client context: `useT()` (dictionary), `useLocale()`, `useI18n()` (with `setLocale`). Switching sets the cookie and `<html lang>` and reloads the server parts via `router.refresh()` |
| `server.ts` | `getLocale()`/`getMessages()` for server components and `generateMetadata` (cookie, otherwise `Accept-Language`) |

The switcher (`components/i18n/LanguageSwitch.tsx`) sits in the settings and in the side navigation. There are no language prefixes in URLs; server and client render with the same language from the cookie.

**AI replies.** `POST /api/chat` determines the language with `requestLocale(req)` and sets it as `Session.locale`. `buildSystem(kind, locale)` (`server/prompt.ts`) appends the matching `REPLY_LANGUAGE` block: chat replies, follow-up questions and reasons in the interface language; shop content in the language the user or the shop/sales channel requires. The prompts in `prompts/` intentionally stay German (internal instructions to the model, not user-facing text).

Not translated: text that comes from the server or the shop (API error texts, AI output, shop data).
