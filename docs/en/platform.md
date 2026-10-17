[Deutsch](../platform.md) · **English**

# Platform layer: Shopware, Shopify, Magento, OpenMage

Lotse connects exactly **one** shop. Which platform that is is set in the settings (`platform`, default `shopware`, environment `SHOP_PLATFORM`). The core (chat, approval workflow, page drafts with preview, style guide, knowledge base, file attachments, Search Console, shop check) knows nothing about any shop. It talks to the platform exclusively through an **adapter** (`PlatformAdapter`).

Status: **all four platforms are connected** (`available: true`). Shopware 6 is the first adapter and wraps the code that grew over time. Shopify (Admin GraphQL, `src/server/platform/shopify/`, section 6a), Magento 2 (REST + GraphQL for links, `src/server/platform/magento/`, section 12) and OpenMage/Magento 1 (own module `Lotse_Connector` with a JSON API, `src/server/platform/openmage/`, section 12a) read data, propose change sets with exact undo, publish landing pages, category/collection content and product content, and have a shop check and a supplier import. Exactly what each platform can do is shown in the capability matrix in section 0. The platform is switched in the settings (section “Connect shop”); idle chats are rebuilt with the new platform, undo steps belonging to a different shop are not executed. This document also serves as the template for further adapters.

Non-negotiable on every platform:

1. **The AI only reads** via a guarded read client with an explicit allowlist. Customers, orders, carts, users/staff, payment data and credentials are never readable, no matter what the prompt says. The only exception, with its own switch (off by default): `sales(range)` returns totals per product from a fixed adapter query, never single orders.
2. **The AI never writes.** It builds a change set; the human approves; only then does the server write with the privileged client. Every write action yields **exact** undo steps that actually work (tested).
3. **No invented facts.** Tools return real shop data, prices are calculated by the server, missing information is asked for.

---

## 0. Capability matrix (status after Shopify, Magento 2 and OpenMage)

Pages (`PlatformCapabilities`):

| | Shopware 6 | Shopify | Magento 2 | OpenMage (Magento 1) |
|---|---|---|---|---|
| `pageFormat` | `cms` (Shopping Experience) | `html` (theme template + Lotse section) | `html` (Page Builder content) | `html` (static HTML with limited CSS) |
| Blocks | all (`'all'`) incl. `product-listing`, `sidebar-filter`, `pdp-*`, `reuse` | generic + `theme-main` | generic only | generic only; product sliders become static product boxes |
| `landingpage` | Shopping Experience + landing page | Shopify page `/pages/<handle>` with template `page.lotse-<handle>` | new CMS page (store view or all) | new CMS page (store view from settings or all) |
| `product_list` → target `category` | Category layout (exactly one `product-listing`) | Collection template: content before/after `theme-main` (required, exactly once); alternatively `mode: description` | CMS block above the product list (`display_mode` PRODUCTS_AND_PAGE/PAGE), no `theme-main` | CMS block + the category's `landing_page` (`display_mode` PRODUCTS_AND_PAGE/PAGE) |
| `product_detail` → target `product` | Product page layout (`pdp-*` blocks) | Product template for 1 to 50 products: content before/after `theme-main` (required) | Product description (one product) or CMS block widget below the description (several), generic blocks only | Replace the product description (`replace`) or append content below it (`append`, default for several); no CMS block, Magento 1 does not render `{{block}}` in product texts |
| Reuse (`reuse`) | yes | no | no | no |
| H1 in content | exactly one | Theme sets the H1 (collection/product), landing page exactly one | Category/product: no own H1 (becomes H2), landing page exactly one (theme title hidden) | as Magento 2 (`content_heading` empty if the content has an H1) |
| Images when publishing | Media management | `stagedUploadsCreate` + `fileCreate`, foreign URLs via `fileCreate` | Product images, URLs, SVG embedded; other uploads rejected (no REST API for CMS media) | Product images, URLs, SVG embedded; other uploads rejected |
| Live verification after writing | yes | yes (template, assignment, page) | yes (executor atomic) | yes (executor atomic, rollback on error) |

Tools and domains (same names where the meaning matches; ✓ = available, – = not available):

| Area | Shopware 6 | Shopify | Magento 2 | OpenMage |
|---|---|---|---|---|
| Read/change products (`search_products`, `get_product`, `list_products`, `propose_product_changes`, `propose_new_products`) | ✓ | ✓ | ✓ (prices only with a configured price basis gross/net) | ✓ (price basis from `/v1/info`, no setting needed) |
| Categories/collections (`propose_category_changes`) | ✓ | ✓ + create collections/rules (`propose_collection`, `preview_collection_rules`, `propose_collection_products`) | ✓ + assignment (`propose_category_products`) | ✓ + assignment (`propose_category_products`) |
| Product streams | ✓ | – (automated collections instead of streams) | – | – |
| Images, alt texts (`propose_product_images`, `propose_alt_texts`, `find_image_gaps`) | ✓ | ✓ | ✓ (remove = hide) | ✓ (remove = hide, alt text per store view) |
| SEO URLs, SEO audit (`get_seo_urls`, `propose_seo_urls`, `seo_audit`) | ✓ (+ `suggest_internal_links`) | ✓ | ✓ | ✓ (301 via `save_rewrites_history`, undo deletes the redirect) |
| Translations (`get_translations`, `propose_translations`) | ✓ (languages, + page texts) | ✓ (`list_languages`) | ✓ (store views, `list_store_views`) | ✓ (store views, `list_store_views`; undo = “Use default value”) |
| Variants (`get_variants`, `propose_variants`) | ✓ | ✓ | ✓ (existing options only, no deletion) | ✓ (existing children: price, stock, status) |
| Bulk changes (`preview_bulk_filter`, `propose_bulk_product_change`) | ✓ | ✓ | ✓ | ✓ |
| Promotions (`list_promotions`, `propose_promotion`, `propose_promotion_status`) | ✓ | ✓ (discounts) | ✓ (cart price rules) | ✓ (cart price rules, fixed code or none) |
| Master data (manufacturers, properties, taxes …) | ✓ (`propose_product_data` etc.) | – | Read attributes (`list_product_attributes`) | Read attributes (`list_product_attributes`) |
| Read/change CMS pages (`list_cms_pages`, `get_cms_page`, `read_page`) | ✓ (read) | – | ✓ (+ `propose_cms_page_changes`) | ✓ (+ `propose_cms_page_changes`, read blocks) |
| Legal, GPSR, unit prices, accessibility | ✓ | – | – | – |
| `get_brand_signals` (onboarding from the theme) | ✓ | – | – | – |
| Supplier import (`read_supplier_file`, `save_import_mapping`, `preview_import`, `propose_import`) | ✓ | ✓ (own feature `shopify-import`; existing variants by SKU/barcode, new variants of existing products only via `propose_variants`) | ✓ (matching by SKU, no creation of variants/attributes/categories) | ✓ (`import-openmage`, as Magento 2) |
| Shop check (`run_shop_check`) | ✓ | ✓ (`shopify/checks.ts`) | ✓ (`magento/checks.ts`) | ✓ (`openmage/checks.ts`) |
| Sales (`sales_report`, switch “Sales”) | ✓ (order line items, variants → parent) | ✓ (`read_orders`, 60 days without `read_all_orders`) | ✓ (`/V1/orders` with `fields`, ACL Sales → Orders) | ✓ (module endpoint `/v1/sales`) |
| Custom checks via chat, checks on/off (`create_check`, `set_check_enabled`) | ✓ (`shopware/scan.ts`) | ✓ (`neutralScan` in `checks.ts`) | ✓ (`neutralScan`) | ✓ (`neutralScan`) |
| Core: pages, style guide, image AI, knowledge base, Search Console | ✓ | ✓ | ✓ | ✓ |

Tool names are unique per platform and all have a display name (`TOOL_LABELS`); `tests/server/platform/platform.test.ts` checks both.

---

## 1. Files

```
src/lib/platforms.ts                 PlatformKind, settings fields per platform (PLATFORM_SETTINGS), available flag
src/server/platform/types.ts         Contract: PlatformAdapter, PlatformCapabilities, ShopLookup, PlatformPages …
src/server/platform/index.ts         Registry (ADAPTERS), getPlatform(), activePlatform(), undoWithPlatform()
src/server/platform/appliers.ts      applierRegistry<Client>(kind): executor per change kind
src/server/platform/stub.ts          Preview adapter for future platforms (currently used by no platform), HTML_CAPABILITIES
src/server/platform/shopware/        Shopware adapter: index.ts, tools.ts, pages.ts, lookup.ts
src/server/platform/shopify/        Shopify: client.ts, reader.ts, data.ts, lookup.ts, tools.ts, products.ts, catalog.ts, content.ts, ops.ts, upload.ts,
                                     pages.ts, preview.ts, publish.ts, theme.ts (pages/templates), checks.ts (shop check), import.ts (supplier import)
src/server/platform/magento/        Magento: client.ts, reader.ts, tools.ts, write.ts, pages.ts, pagebuilder.ts, cms.ts, links.ts, checks.ts, importer.ts … (section 12)
src/server/platform/openmage/       OpenMage: client.ts, reader.ts, map.ts, write.ts, catalog.ts, images.ts, promo.ts, variants.ts, bulk.ts, cms.ts, links.ts, lookup.ts,
                                     audit.ts, checks.ts, pages.ts, tools.ts, importer.ts … (section 12a)
integrations/openmage/               OpenMage module Lotse_Connector (JSON API /lotse-api/v1), openapi.yaml, README, tests/unit.php + tests/smoke.php
tests/support/openmage-live/          verify.ts: live verification of all change kinds with undo against a real OpenMage instance
src/server/page-html.ts              renderPageHtml(): page draft → static HTML (for HTML platforms); renderPageParts(): split at the theme-main block
src/server/tools.ts                  Core tools + assembly per session (buildTools, toolNamesFor)
src/server/features/*                Feature modules; Feature.platforms = ['shopware'] | 'all'
prompts/common/*.md                  Rules for all platforms (placeholders {{shop}}, {{platform}})
prompts/<platform>/*.md              Platform-specific rules (Shopware: Shopping Experiences; Shopify: theme templates, collections; Magento: Page Builder, CMS; OpenMage: CMS pages/blocks, store views)
```

Recommended structure for a new adapter (Shopify as an example):

```
src/server/platform/shopify/
  index.ts        export const shopify: PlatformAdapter = { … }   (replaces stubAdapter)
  client.ts       privileged client (token, timeout, retry on 429), NEVER exposed to the AI
  reader.ts       guarded read client (allowlist, scrubbing, access log)
  tools.ts        AI tools (read + propose_*)
  changes.ts      build change sets + register appliers (applierRegistry)
  pages.ts        PlatformPages (preview data, publishing)
  lookup.ts       ShopLookup
  checks.ts       shop checks (registerPlatformCheck)
  (tests: tests/server/platform/shopify/*.test.ts, against a fake HTTP server)
prompts/shopify/  prompt files (see section 9)
```

Code style as in the repo: strict TypeScript, compact, German comments, `import 'server-only'` in server modules. No `npm install`: only what is in `package.json` is allowed (fetch, zod, exceljs, unpdf, mammoth …). Shopify GraphQL and Magento REST work with `fetch`.

---

## 2. The contract (`src/server/platform/types.ts`)

| Member | Required | Meaning |
|---|---|---|
| `kind`, `label` | yes | `'shopify'`, `'Shopify'` |
| `settings` | yes | `PLATFORM_SETTINGS[kind]` from `src/lib/platforms.ts` |
| `capabilities` | yes | what pages can do (section 6) |
| `promptVars` | yes | `{ shop, platform, htmlElement, shopcheckTools }`, e.g. `{ shop: 'Shopify-Shop', platform: 'Shopify', htmlElement: 'HTML-Abschnitt der Seite', shopcheckTools: '' }` |
| `configured()` | yes | Credentials complete: `shopConfigured(kind)` from `settings.ts` |
| `reconfigure()` | yes | after settings are saved: discard client/token/caches |
| `testConnection()` | yes | “Test connection”: `{ ok, message }`, e.g. “Verbunden mit Shopify (Haus Holm, API 2025-07)”. Error texts without secrets (`redact`) |
| `health()` | yes | Sidebar: `{ url, ok, error? }` (cheap call, e.g. shop name) |
| `urls()` | yes | `{ admin, storefront, paths }` for links in the interface. `paths` are templates with `{id}` (see `PlatformPaths`) |
| `openSession(chat)` | yes | per chat: `{ reader, lookup, storefrontFetch, themeCss }`. `reader` is the **guarded** read client, `chat` the name in the access log |
| `lookup(reader)` | yes | `ShopLookup` over a read client (the shop check uses this per run) |
| `toolNames`, `tools(session)` | yes | The platform's tools (section 4); `toolNames` must match `tools()` exactly |
| `features?` | no | additional feature modules (like `src/server/features`), e.g. images, promotions |
| `loadChecks()` | yes | imports the modules that register shop checks (may be empty) |
| `sales(range)` | yes | Sales without personal data (`features/sales.ts`): totals per product (`productId` as in `scanProducts`, variants under their parent, `quantity`, `revenue`, `orders`) for `from`–`to` (UTC days), without cancelled orders. Fixed query via the privileged client, never criteria from the AI, never customer, address or order number fields; cap → `capped`. If the shop lacks the permission, an understandable error |
| `scanProducts(reader)` | yes | active products as `NeutralProduct` (name, description, metas, price, list price, stock, image) for custom checks; reads via the run's guarded read client, once per run (cap like the built-in checks). `null` = not readable on the platform |
| `apply(cs, payload, selected, ctx)` | yes | write an approved change set (section 5). Call `ctx.progress(done, total, partial)` after each item/chunk, `partial = { results, undo }` with the state so far: the session saves it in batches in `changeset_runs` (SQLite) so that a crash midway does not lose any undo. Helpers in `changes.ts`: `applyEach` (ticks by itself), `partialTicker(ctx, total, { results, undo })` for custom loops, `trackedUndo(ctx, total, results?)` for executors with several write steps per record (promotion, publishing: every `push` reports immediately). The next time the chat is loaded, an interrupted run becomes the result `partial`/`failed` with the saved undo steps; without a saved intermediate state the result honestly says “unknown, check in the shop” (never “nothing written”). Pending approvals are then treated as rejected (“restart, please propose again”) |
| `undo(ops)` | yes | execute this platform's undo steps in **reverse** order, `{ ok, error? }` per step (in execution order, i.e. backwards relative to `ops`). The session remembers the outcome per step (`undoResults`); another click only retries the failed steps |
| `pages` | yes | Preview data, publishing (section 6) |
| `context` | yes | Context selection in the interface: `categories()`, `products({ term, categoryId })` |
| `storefront` | yes | `{ base(), fetch }` for the preview proxy `/shop/…` (iframe of the real page) |

`ShopLookup` (platform-neutral read functions for core features, always via the guarded read client):

| Method | Used by | Expectation |
|---|---|---|
| `findProducts({ ids, numbers })` | Knowledge base | Matches by ID, then by product number (SKU); `{ id, number, name }` |
| `findCategories(ids)` | Knowledge base | `{ id, name }` |
| `getProduct(id)` | Knowledge base | `{ id, number, name, ean, categoryIds }` (`categoryIds` incl. parents, if known) or `null` |
| `mediaUrl(id)` | `view_image` | public URL of a platform media item |
| `mapUrls(urls, { metas })` | Search Console | page URL → `PageRef { kind: 'product'\|'category'\|'landing'\|'home', id, name, number?, active, metaTitle?, metaDescription? }` or `null` |
| `entityPaths(kind, id)` | Search Console | all paths (without domain, without leading `/`) and absolute URLs of the entity |
| `current(entity, id)` | Search Console | current record (`entity`: `product`, `category`, `landing-page`), fields directly or under `translated` |

### Session

`getSession(chatId)` creates one session per chat (`src/server/sessions.ts`):

- `session.platform`: platform at creation time. If the platform is switched in the settings, an **idle** session is rebuilt (history comes from the DB); a running turn keeps its platform until it ends.
- `session.reader`: the platform's guarded read client (`unknown`). Custom tools cast to their type, ideally with a check, e.g. `const r = session.reader as ShopifyReader`.
- `session.lookup`: `ShopLookup`.
- `session.sw`: Shopware only. On other platforms every access throws (“Dieses Werkzeug gibt es nur für Shopware”, i.e. this tool only exists for Shopware).
- `session.locale`: language of the interface (`'de' | 'en'`), set by `POST /api/chat`; determines the reply language in the system prompt (see [architecture.md](architecture.md), section 12).
- `session.requestChange(cs, payload)`: the only way to write (section 5).
- `session.askUser(q)`: follow-up question with options.

---

## 3. Settings (`src/lib/platforms.ts`)

Each platform describes its fields in `PLATFORM_SETTINGS[kind]`:

- `fields`: general fields (URL, optional public URL, store view …).
- `auth`: authentication methods; **one complete** method is enough (Magento: integration token **or** admin user + password). With several methods, the interface shows a toggle.
- Field: `key`, `label`, `secret` (stored encrypted, never displayed, never sent to the AI, redacted in error messages), `type: 'url'`, `placeholder`, `hint` (`**bold**` allowed), `env` (fallback environment variable, prefix `SHOPIFY_`, `MAGENTO_` or `OPENMAGE_`), `optional`.
- `storefrontPaths`: path prefixes the storefront calls without `/shop` (assets, widgets, links), e.g. Shopify `['cdn', 'products', 'collections', 'pages', 'cart', 'search']`, Magento `['static', 'media', 'pub', 'catalog', 'checkout', 'customer/section']`. First segment or a fixed sequence of segments, without outer slashes. See section 8 (preview proxy).
- `available`: **set to `true` once the adapter is finished.** While `false`: credentials can be saved, shop check off, connection test disabled, notice in the interface.

Server side: `getSettings().shopify` or `.magento` (key → value, secrets decrypted), `platformConfig(kind)`, `shopConfigured(kind)`. The interface (`SettingsView`, section “Connect shop”) renders the fields automatically; the API endpoint only accepts fields according to the description. New fields: only add them in `platforms.ts`.

Environment variables `SHOPWARE_*`, `SHOPIFY_*`, `MAGENTO_*`, `OPENMAGE_*`, `SHOP_PLATFORM` never reach the AI process (`aiEnv`).

---

## 4. Tools

### Core (for all platforms, `src/server/tools.ts`)

`ask_user`, `draft_page`, `publish_page`, `get_styleguide`, `save_styleguide`, `view_image`, `import_image`, `create_svg_image`, `generate_image`. Plus the core features (`Feature.platforms = 'all'`): knowledge base (`add_knowledge`, `search_knowledge`, `get_product_knowledge`, `list_knowledge`, `add_rule`, `list_rules`, `remove_rule`), Search Console (`gsc_performance`, `gsc_opportunities`, `gsc_content_gaps`, `gsc_measure_effect`), Sistrix (`sistrix_visibility`, `sistrix_top_pages`, `sistrix_opportunities`, `sistrix_competitors`, `sistrix_keyword_metrics`, `sistrix_onpage`; API key + domain in the settings, credits capped per request) and `run_shop_check`. These use `session.lookup` and `adapter.pages`, never the platform directly.

**Image attachments (uploads):** image attachments from the chat (`POST /api/upload`) are only staged locally on **all** platforms (`data/staging/`, `mediaId: 'staged:<id>'`, preview `/staged/<file>`); no adapter writes to the shop at that point, and the contract no longer has an `uploadImage` hook. An image only reaches the media library when an approved change set uses it (`propose_new_products`, `propose_product_images`, `publish_page`): Shopware `uploadStaged` (once per image, mapping in `staging_map`), Shopify `uploadStagedImage`, Magento/OpenMage their own upload paths. Undo removes the assignment to the product or the page; the uploaded image stays in the media library like a manually uploaded one.

### Platform (adapter or own feature modules)

**Same names on all platforms where the meaning matches.** Prompts, shop check tasks (`fixPrompt`) and onboarding refer to these names. Arguments as close to Shopware as possible (`src/server/platform/shopware/tools.ts`) so the shared prompts stay correct.

| Name | Kind | Minimum scope |
|---|---|---|
| `search_products` | read | `{ term?, categoryId?, limit? }` → `{ total, products: [{ id, name, number, price (formatted, e.g. “49,00 €”), image, manufacturer? }] }` |
| `get_product` | read | `{ id }` → description (HTML), metas, images (URL; AI images with `aiGenerated: true`), categories, properties/options, stock |
| `list_products` | read | bulk read with filters (`categoryId`, `term`, `minPrice`, `maxPrice`, `active`, `maxStock`, `details`, `limit`, `offset`), gross prices as numbers |
| `search_categories` | read | `{ term?, limit? }` (Shopify: collections) |
| `get_category` | read | `{ id }` → name, description, metas, subcategories |
| `search_media` | read | `{ term?, limit? }` → `{ mediaId, url, alt }` |
| `read_page` | read | `{ url }` of a page of the **own** shop (`assertShopUrl` from `storefront.ts`), text, headings, images, links |
| `get_brand_signals` | read | Onboarding: theme colors/fonts, logo, real copy (see `collectSignals` in `styleguide.ts` as a model) |
| `propose_product_changes` | proposal | `{ title, reason, changes: [{ id, fields }] }`, fields at least `name, description, metaTitle, metaDescription, price, listPrice, stock, active`; price rules via `resolvePrice` (`changes.ts`) |
| `propose_new_products` | proposal | as in Shopware: inactive by default, stock 0, never estimate prices |
| `propose_category_changes` | proposal | `name, description, metaTitle, metaDescription, active` |
| `propose_product_images` | proposal | add, remove, sort images, cover image |
| `propose_alt_texts` | proposal | alt text per media item (look at the image with `view_image` first) |
| `propose_translations` | proposal | texts per language/store view/market |
| `propose_promotion` | proposal | create a discount/discount code (Shopify: discounts, Magento: cart price rules) |
| `seo_audit`, `find_image_gaps`, `get_product_details` | read | if available, same names as in Shopware (the shop check prompt names them as examples) |

Rules:

- Name unique per platform; the core adds the prefix `mcp__shop__`. `toolNames` exactly as `tools()` (test `toolNamesFor`).
- Tools with `tool()` from `@anthropic-ai/claude-agent-sdk`, handlers in `guard()` (`tool-kit.ts`), results with `ok()`/`fail()`. Errors reach the AI redacted.
- Read **only** via `session.reader`/`session.lookup`, never via the privileged client.
- Descriptions in German, goal and limits clear (“Es wird NICHTS geschrieben …”, i.e. nothing is written). No long dashes in new user-facing texts.
- Shopware-only features remain `platforms: ['shopware']`. A feature for all platforms (`'all'`) may only use `session.lookup`, `session.askUser`, `session.requestChange` and core modules.

---

## 5. Change sets and undo

Flow (identical on all platforms):

```
Tool propose_*     → build…ChangeSet(reader, args)       reads the current state via the guarded read client
                   → session.requestChange(cs, payload)   card in the chat, human selects rows + approves
Server             → adapter.apply(cs, payload, selected) privileged client, re-reads before values, writes
                   → ApplyResult { results, undo }        ok/error per row + exact UndoOps
Human “Undo”       → undoWithPlatform(undo)               adapter.undo(ops) in reverse order
```

`ChangeSet` (`src/lib/protocol.ts`): `id` (`newId()`), `kind` (change kind, e.g. `products`, `categories`, `page`, `new-products`, `product-media`, `promotion`), `entity`, `title`, `reason`, `items` (per row `entity`, `entityId`, `label`, `field`, `fieldLabel`, `before`, `after` for display, `afterRaw` as the value for the executor, optionally `beforeRaw` as the raw value at proposal time, `html: { before, after }`, `warn[]`), `skipped`, `atomic`, optionally `noun`, `applyLabel`, `assets`, `total`/`sample` for bulk changes. The session sets `platform` automatically.

**Stale-write guard:** between proposal and approval, a second chat or an admin user can change the same record; the human would then have approved a diff that is no longer accurate. The executor therefore compares the fresh value of each changed field with the remembered `beforeRaw` (`assertFresh`/`normValue` in `changes.ts`, tolerant of pure formatting differences) and does not write that item if it differs (“changed in the meantime, please propose again”); the other items continue. Shopware: product/category fields, master data, translations, product streams/assignments, bulk per block (`BulkPlan.prev`; variants with the freshly loaded main product so that inherited values count as they did in the proposal). Absolute stock (product field `stock`, bulk `stock {set}`) is also protected: a sale between proposal and approval makes this item fail; `stock {add}` calculates relative to the then-current stock and stays unchecked. Shopify (`bulkStale`), Magento (`assertPriceUnchanged`, CMS pages) and OpenMage check equivalently. Without `beforeRaw` (legacy data) there is no check.

**Crash safety:** before the first write access, the session writes an audit row with `status: 'started'` and creates a run in `changeset_runs` (SQLite); `trackRun` (`sessions.ts`) saves the intermediate state from `ctx.progress(done, total, { results, undo })` in batches (at most every 250 ms), and the run is deleted once the result is stored. If the server dies midway (crash, deploy), `recoverChat` closes the chat the next time it is loaded: an interrupted run becomes the result `partial`/`failed` with the saved undo steps (undo works); without a saved intermediate state the card honestly says “unknown, please check in the shop” instead of “nothing written”. Pending approvals are treated as rejected (“restart, please propose again”), open follow-up questions of the last turn are marked, each with an audit row (`recoveredFrom` = time of the incident). Undo remembers the outcome per step (`undoResults`); another click only retries the failed steps. While an apply or undo is running (`writesInProgress`), `PATCH /api/settings` rejects a change of the shop connection with 409; a completed change gets an audit row `decision: 'changed'` (field names only, never values).

- `items[].entity` for metas and texts **neutral**: `product`, `category`, `landing-page`, field names as in the core (`metaTitle`, `metaDescription`, `keywords`, `name`, `description`, `shortDescription`, `faq`), otherwise Search Console cannot measure baseline values. For existing categories/products whose layout or page content is replaced, `buildPublish` sets `cs.measureTargets` via `measureTargets()` from `changes.ts` (at most 50 targets).
- At most `MAX_ITEMS` (300) rows per set; bulk via groups + sample. Magento and OpenMage abort at 5,000 products, Shopware and Shopify at 10,000.
- Read before values for `before` when building, read before values for `undo` **again** when applying (something may have changed).

Executor: `const reg = applierRegistry<ShopifyClient>('shopify'); reg.register('products', (client, cs, payload, selected, ctx) => …)`; `adapter.apply = (cs, p, sel, ctx) => reg.apply(client(), cs, p, sel, ctx)`. Helpers from `changes.ts`: `applyEach(cs, selected, fn, ctx)` (gently parallel with `WRITE_CONCURRENCY`), `pool`, `errMsg`, `resolvePrice`, `normFaq`, `partialTicker`, `trackedUndo`. Progress and intermediate state: `ctx.progress(done, total, { results, undo })` after each record, also on errors.

`UndoOp` (`{ op, entity, id, data?, method?, path?, body?, platform? }`):

| op | Meaning | Requirement |
|---|---|---|
| `patch` | `data` = **exactly** the before values of the changed fields (including `null`) | same fields that were written |
| `delete` | delete a created object again (`entity`, `id`) | “already gone” (404) counts as success |
| `create` | re-create a deleted object with `data` | only if the deletion was part of the change |
| `req` | raw call (`method`, `path`, `body`), e.g. a GraphQL mutation with variables or a REST call | JSON-serializable, without secrets |

The adapter defines the meaning of `entity`/`path` (Shopify e.g. `path: 'graphql'`, `body: { query, variables }`). UndoOps are stored with the chat: data only, no functions, no tokens. An undo must never change more than the change itself. If an undo belongs to a platform other than the connected one, the core does not execute it.

Unclear outcome (timeout, connection drop, 5xx after sending): the mutation may have taken effect. Shopify therefore builds the before values BEFORE the mutation and records the undo step even in the error case (`runRecording`); only not on `userErrors` (nothing changed). When creating (ID only in the response), `runCreating` reads the candidates by title/handle before and after and marks new IDs for deletion. The row still reports the error, but the user can use “Undo”. The allowlist of undo mutations (`UNDO_QUERIES`) lists exactly the mutations that executors record; create mutations are intentionally missing.

---

## 6. Pages: capabilities, preview, publishing

`PlatformCapabilities`:

```ts
{ pageTypes: ['landingpage', 'product_list'],      // page types in draft_page
  publishTargets: ['landingpage', 'category'],     // targets in publish_page
  blocks: GENERIC_BLOCKS,                          // 'all' only for Shopware
  pageFormat: 'html',                              // 'cms' = Shopware Shopping Experience
  reuse: false }
```

Target ↔ page type (`PUBLISH_PAGE_TYPE`): `category` ↔ `product_list`, `product` ↔ `product_detail`, `landingpage` ↔ `landingpage`. `HTML_CAPABILITIES` (`stub.ts`) is the recommended starting point for new HTML platforms. Shopify uses `SHOPIFY_CAPABILITIES`: all three page types and targets, generic blocks plus `theme-main`. Magento uses `MAGENTO_CAPABILITIES`: all three page types and targets, generic blocks only (no `theme-main`; the content is a section that the theme embeds).

`draft_page` checks the page type against `pageTypes`, each block (after pattern resolution) against `blocksFor(blocks)`, and calls `validateSpec(spec, { layoutRules: pageFormat === 'cms', themeMain })` (`themeMain` = the platform allows `theme-main`). With `pageFormat: 'html'`, the Shopping Experience rules “exactly one `product-listing`” (product_list) and “exactly one `pdp-gallery-buybox`” (product_detail) do not apply: a category/collection page there is only the **content** above the product list provided by the theme, and consists of generic blocks.

Blocks (`src/server/cms.ts`, `BLOCKS[k].generic`): generic are `text`, `text-hero`, `text-two-column`, `text-three-column`, `image-cover`, `image-text`, `text-image`, `image-two-column`, `custom-html`, `product-slider` and all patterns (`type: 'pattern'`, become `custom-html`). Shopware only: `product-listing`, `sidebar-filter`, `pdp-*`, `reuse`. Only HTML platforms with theme templates (`BLOCKS[k].htmlOnly`, never with `blocks: 'all'`): `theme-main` = placeholder for the theme's main content (product list or gallery/buy box/description); exactly once for `product_list`/`product_detail`, never for `landingpage`. Preview: real products of the collection or the preview product. Quality check (`auditSpec(spec, links, { format })`): with `theme-main` (Shopify) the block counts like `product-listing` or `pdp-gallery-buybox`/`pdp-description-reviews`, and the theme provides the H1. With `format: 'html'` **without** `theme-main` (Magento) separate rules apply: category/product content without its own H1, content above the product list at most 300 words, product description with FAQ, USPs and objection handling. `draft_page` rejects disallowed blocks; the prompt only shows the platform's catalog.

`PlatformPages`:

- `previewData(session, spec)` → `PreviewCtx`: `products` by ID (`{ name, price (formatted), img, description?, url? }`) for all `productIds` of the blocks, with `previewCategoryId` up to 8 active products of the category, `product` for `previewProductId`, `imageUrl(ref)` resolves `{ mediaId }` (staged images `staged:…` → `/staged/<file>` via `stagedMeta`).
- `prepareDraft?(session, spec)` → `{ spec, links?, errors? }` (Shopware: reuse blocks, technical links → SEO URLs). Optional.
- `focus?(session, spec)` → focus event (product/category) for the interface. Optional.
- `publishTool` → `{ description, shape }` (zod shape). `target` **must** be `z.enum(capabilities.publishTargets)`. Usual fields: `categoryId`, `productIds`, `url` (path/handle of the landing page), `metaTitle`, `metaDescription`, platform-specific e.g. `storeId`.
- `buildPublish(session, spec, args)` → `{ cs, payload }`. Checks required input (throws an `Error` with plain text for the AI), builds a change set `kind: 'page'`, `atomic: true`, info rows (`entity: 'info'`: “New page”, “URL”, “Meta title” before → after) and `assets` (images to be uploaded).

Publishing as HTML (Shopify, Magento): in the applier, `renderPageHtml(spec, { imageUrl, products, scope })` from `src/server/page-html.ts`. Resolve all images first: upload `staged:` (Shopify: `stagedUploadsCreate` + `fileCreate`; Magento: only if an upload path exists, otherwise reject in `buildPublish` with a clear message), take over or import `{ url }`. Then:

- `landingpage`: create a new page (Shopify `pageCreate` with handle = `url`, Magento `POST /V1/cmsPage` with `identifier` = `url`, metas). Undo: `delete` of the page.
- `category`: set the category/collection content (Shopify `collectionUpdate.descriptionHtml`, Magento `PUT /V1/categories/{id}` `description` or CMS block). Undo: `patch` with the complete before content.
- Result `published: { name, storefront: '<public URL>' | string[], adminUrl?, url? }`; the interface shows links from it.

### 6a. Shopify: pages and theme templates (implemented)

| Target | What Lotse writes | Undo |
|---|---|---|
| `landingpage` | `pageCreate` (handle = `url`, content = `renderPageHtml`, metas as `global.title_tag`/`description_tag`, `templateSuffix lotse-<handle>`), `templates/page.lotse-<handle>.json` (only the “Lotse-Inhalt” section, `key: page` = page content) | delete page, delete template |
| `category` | Copy of the theme's collection template as `templates/collection.lotse-<handle>.json` with sections `lotse_before`/`lotse_after` before/after the main section (`mainSectionKey`), content in shop metafields `lotse.collection-<slug>-before/-after` (multi_line_text_field, ≤ 65,000 characters), `collectionUpdate.templateSuffix` (+ SEO) | delete template or restore old content, restore/delete metafields, old `templateSuffix` (including `null`) |
| `category`, `mode: description` | `collectionUpdate.descriptionHtml` (without theme write access) | old description |
| `product` | as `category` with `templates/product.lotse-<layout>.json` for 1 to 50 products (`productUpdate.templateSuffix`) | as above per product |

Shared: `sections/lotse-content.liquid` (setting `key`: `page` = `page.content`, otherwise `shop.metafields.lotse[key].value`). Undo only deletes the section if no template uses it anymore (`theme-section` step). Stored undo steps may only write/delete Lotse files (`LOTSE_FILE`). Images: staged ones via `stagedUploadsCreate` + `fileCreate`, foreign URLs via `fileCreate` (waiting for `READY`); created files are deleted on undo. Every publication is verified after writing (template read back, assignment, page); if a step fails, the executor immediately reverts all previous ones (atomic). Without theme write access (Shopify requires `write_themes` and an exemption for `themeFilesUpsert`): landing page with the default template, collection fails with a hint to use `mode: description`.

Storefront: the local fake does not render Liquid. In the real shop, `/pages/<handle>` shows the HTML in the “Lotse-Inhalt” section without the theme's page title (full width); `/collections/<handle>` shows banner, Lotse content, product grid with filters, Lotse content; `/products/<handle>` shows the theme's product area with Lotse content before/after. In the theme editor the sections appear as “Lotse-Inhalt”.

---

## 7. Privacy: guarded read client

Each platform has an **explicit allowlist** (not a blocklist). Model: `src/server/policy.ts` (`createGuard`, `ReadOnlyShopware` in `shopware.ts`).

Required:

- Only resources of the areas `products`, `categories`, `cms`, `media`, `marketing`, `shop` are readable (`ScopeKey`, toggled under Settings → AI access; blocked area → `DeniedError` with “ZUGRIFF VERWEIGERT: …”, i.e. access denied). The mapping resource → area lives in the platform's reader.
- **Never readable:** customers, customer segments, orders, draft orders, checkouts/carts, returns, invoices, credit memos, transactions, payments, gift card codes, staff/admin users, integrations/apps, tokens, settings containing credentials. For filters, fields and paths use `DENIED_TERMS` from `policy.ts`.
- Scrub responses: `scrubSensitive(data)` (email, phone, address, names, token …). Promotions only with counts, never with redeemers.
- Every access is logged: `accessAdd({ chat, op, entity, n, scrubbed, denied })` (`db.ts`), visible under Settings → Logs.
- The AI does not define free-form queries: tools call **fixed** read methods of the reader (Shopify: fixed GraphQL queries in code, no query strings from the AI; Magento: fixed REST paths, `searchCriteria` only with allowed fields).
- The privileged client (token) stays inside the adapter: never in `session`, never in tool results, never in error messages (`redact`).

Shopify (Admin GraphQL): root fields e.g. `products`, `product`, `productVariants`, `collections`, `collection`, `files`, `pages`, `blogs`/`articles`, `discountNodes` (without `customerSelection` details), `shop` (only name, domains, currency), `locations` (names only), `markets`/`shopLocales`. Blocked include `customers`, `orders`, `draftOrders`, `abandonedCheckouts`, `giftCards`, `staffMembers`, `apps`, `shop.email`.

Magento (REST, `/rest/<store>/V1/…`): e.g. `GET products`, `products/{sku}`, `products/attributes`, `categories`, `categories/list`, `cmsPage/search`, `cmsBlock/search`, `salesRules/search`, `coupons/search` (without customer reference), `store/storeViews`, `store/storeConfigs`. Blocked include `customers*`, `orders*`, `invoices*`, `creditmemo*`, `shipment*`, `transactions*`, `carts*`, `guest-carts*`, `integration*`, `admin*`, `tfa*`.

Tests must show: customers/orders are rejected, sensitive fields removed, accesses logged.

---

## 8. Shop check, context selection, preview proxy

- Custom checks and on/off: every platform provides a neutral product view via `scanProducts(reader)` (`NeutralProduct`, `lib/custom-checks.ts`); the checks defined via chat run on it. New adapters must implement `scanProducts` (without data: empty rows). Structure and fields: [architecture.md](architecture.md), section 8.

- Checks: `registerPlatformCheck<ShopifyReader>('shopify', { id: 'shopify.meta-description', area: 'SEO', scopes: ['products'], run: async (reader, ctx) => … })` in a module imported by `loadChecks()` (Shopify: `shopify/checks.ts`: metas, thin copy, images/alt texts, stock with overselling, prices 0/compare-at price/margin, collections, broken internal links in descriptions, pages and collection texts, missing translations per language). A fresh read client per run (cache per run). Finding: `CheckFinding` with a `fixPrompt` that uses the shared tool names. Checks with `platforms: 'all'` (Search Console) run everywhere.
- Context selection (`/api/categories`, `/api/products`): `CategoryRow { id, name, parentId, active, type, cmsPage }`, `ProductRow { id, name, number, img, cmsPage }`. For display to the human; Shopify: collections flat (`parentId: null`), Magento: category tree.
- Target hint (`src/server/target-hint.ts`, in the core): when a chat starts from the context selection, `agent.ts` prepends `targetHint(target, capabilities)` to the message. It only depends on the capabilities: category → `product_list` with `previewCategoryId` if `pageTypes` contains `product_list` and `publishTargets` contains `category` (with `html`, with the hint “no product-listing block, the theme provides the product list”), otherwise copy/data/SEO or a free landing page. Product → `product_detail` with `previewProductId` only if `pageTypes` contains `product_detail` and `publishTargets` contains `product`; otherwise copy, data and SEO (`propose_product_changes`, if available) or a landing page with the product (`product-slider`, `productIds`). The adapter does not need to do anything for this, just set `capabilities` correctly.
- Preview proxy `/shop/…`: `storefront.base()` (public base URL) and `storefront.fetch(url, init)`. Path templates in `urls().paths` (e.g. Shopify `category: '/collections/{id}'`; if the ID is not a handle, choose a suitable template or return the handle as ID in `context`). `storefrontRewrite` rewrites absolute shop URLs to `/shop`; **root-relative** requests of the page (`/cdn/shop/…`, `/static/…`, `/collections/…`) are forwarded to `/shop` by `src/proxy.ts` based on `PLATFORM_SETTINGS[kind].storefrontPaths` (GET only). `proxy.ts` does not know the connected platform and takes the union of all lists (`storefrontPrefix`); the `/shop` route only lets through prefixes of the active platform (header `x-lotse-storefront-prefix`, `isStorefrontPathOf`), everything else results in 404. Prefixes must not shadow Lotse routes (`api`, `settings`, `wissen`, `shop`, `staged`; test in `src/lib/urls.test.ts`).

---

## 9. Prompts

`prompt.ts` reads `prompts/common/*.md` and `prompts/<platform>/*.md`, sorts **all of them by file name** (the parts interlock) and fills `{{shop}}`, `{{platform}}`, `{{htmlElement}}`, `{{shopcheckTools}}` from `promptVars`. `shopcheckTools` adds the read tools for fixing a finding in the shop check section, with a leading space and parentheses (Shopware: `' (seo_audit, find_image_gaps, get_product_details …)'`), empty if the platform does not have these optional tools. Only name tools that really exist. A file with the same name in the platform folder replaces the shared file. Then follow the pattern catalog and the platform's block catalog.

The prompts are intentionally written in German (internal instructions to the model). The reply language is appended per session as a separate block (`REPLY_LANGUAGE` in `prompt.ts`, see [architecture.md](architecture.md), section 12).

Slots a platform fills (Shopware files as a template):

| File | Contents |
|---|---|
| `01-2-seiten.md` | one line “- LAYOUT/SEITEN: …” (which pages the platform supports) |
| `01-4-shop-verwaltung.md` | one line “- SHOP-VERWALTUNG: …” (domains) |
| `02-2-freigegebene-daten.md` | one line “- Du siehst nur freigegebene Shop-Daten: …” |
| `03-…md` | Domain knowledge of the platform's page system (Shopify: pages, collections, theme sections; Magento: CMS pages, CMS blocks, Page Builder) |
| `04-2-bestehende-inhalte.md` | Section “Bestehende Inhalte einbeziehen (Pflicht)” (include existing content, required) with the platform's read tools |
| `05-2-recherche.md` | Step “2. RECHERCHE …” |
| `05-4-schreibzugriff-und-seitenaufbau.md` | “Schreibzugriff” (which propose_* tools), “Massenänderungen” (bulk changes), “Seitenaufbau-Regeln” (page structure rules) matching the capabilities |
| `08-…` to `17-…` | Sections for the domains (images, SEO, translations, promotions …), only what really exists |

The shared files stay platform-neutral (test `tests/server/prompt.test.ts` checks: no Shopware terms in `common`, no unresolved placeholders). Shopify additionally replaces `01-3-faehigkeiten.md` and `07-produkte.md`. The target hint of the context selection (`target-hint.ts`) distinguishes `cms`, `html` with `theme-main` (Shopify) and `html` without (Magento).

---

## 10. Tests

`npm run check` (types + ESLint + tests) must pass. Tests with `node:test`, run with `tsx --conditions=react-server`; data folder per file: `process.env.AICB_DATA = fs.mkdtempSync(…)` before the first dynamic import.

- **Fake HTTP servers** instead of real shops: `http.createServer` on port 0, data as in-memory objects, requests recorded. Models: `tests/support/gsc-fake.ts`, `tests/server/shopware.test.ts`. The fake checks token headers and rejects blocked resources so tests demonstrate the guard.
- Required tests per adapter:
  1. Reader: blocked resources (customers, orders …) → `DeniedError`, sensitive fields removed, area toggles take effect, access log.
  2. Tools: read tools return the expected format; `toolNames` = names of `tools()`.
  3. Change sets: build (before/after, warnings, skipped rows), apply against the fake, **undo restores the fake state exactly** (deep-equal before/after).
  4. Publishing: page/collection/category, image upload, undo.
  5. Prompt: `buildBasePrompt('<kind>')` without unresolved placeholders, without terms from other platforms.
  6. Settings: fields, `configured`, secrets encrypted and masked.
- Existing tests: `tests/server/platform/platform.test.ts` (registry, capabilities, tools per platform without duplicate names and with display names, undo routing, shop checks, `stubAdapter`) and `session.test.ts` (sessions per platform, page types and blocks). Shopify: `shopify/shopify.test.ts` against the GraphQL fake `tests/support/shopify-fake/`; Magento: `magento/*.test.ts` against `tests/support/magento-fake.ts`; OpenMage: `openmage/*.test.ts` against `tests/support/openmage-fake.ts`.
- Live against a real test shop only with your own test data; revert every change with undo and verify the initial state.

---

## 11. Checklist for a new adapter

- [ ] `PLATFORM_SETTINGS[kind]`: fields complete, `storefrontPaths` verified against the real storefront (live preview loads CSS/JS/images), `available: true`.
- [ ] Privileged client: auth, timeout, retry on 429 (Retry-After), errors without secrets.
- [ ] Guarded reader with allowlist, areas, `scrubSensitive`, `accessAdd`, `DeniedError`.
- [ ] `openSession`, `lookup` (all `ShopLookup` methods).
- [ ] Tools with the shared names (section 4), matching `toolNames`.
- [ ] Change sets + appliers (`applierRegistry`) for every `propose_*` kind, exact UndoOps, `undo()`.
- [ ] `capabilities` (also determine the target hint of the context selection) + `pages` (preview data, `publishTool`, `buildPublish`, applier `page` with `renderPageHtml`).
- [ ] `context`, `storefront`, `urls()` with `paths`, `health()`, `testConnection()`, `reconfigure()`.
- [ ] Shop checks via `registerPlatformCheck` + `loadChecks()`.
- [ ] Prompts in `prompts/<kind>/` (section 9), matching `promptVars.shopcheckTools`, preview notice removed.
- [ ] Tests (section 10), `npm run check` passes.
- [ ] `stubAdapter(...)` in `src/server/platform/<kind>/index.ts` replaced by the real adapter (keep `promptVars` and `paths`).

---

## 12. Magento 2 (implemented)

Files under `src/server/platform/magento/`: `client.ts` (privileged REST client: integration token or admin token with renewal on 401, timeout, at most 4 concurrent requests, retry on 429/503), `criteria.ts` (searchCriteria), `reader.ts` (guarded read client: allowlist of REST paths per area, allowed filter fields per resource, scrubbing including `custom_attributes`, access log; customers, customer groups, orders, invoices, carts, integrations, admin and tokens blocked), `map.ts` (pure mapping), `write.ts` (scope-exact writing + undo), `catalog.ts`, `images.ts`, `promo.ts`, `variants.ts`, `bulk.ts`, `audit.ts`, `lookup.ts`, `pages.ts` (preview data), `tools.ts`; test fake `tests/support/magento-fake.ts` + `magento.test.ts` (fake of the REST API).

Important Magento rules the adapter implements:

- **Scopes:** texts are stored globally (store `all`) or per store view. Main store view = default view of the website to which the store view from the settings belongs (`mainStoreCode`: website → default group → default view; the REST API does not provide a “default website”). In the main store view, Lotse writes where the value comes from (own value of the view → view, inherited → global) and then checks whether the view shows the new value. In other store views (setting `storeCode`, `propose_translations`) it only writes there, including alt texts (`media-alt`). Undo writes the before values of the respective scope; `null` removes a value of the scope (“Use default value”). Exception for categories: `name`/`is_active` of a store view cannot be reset to “Use default value” via REST (Magento discards `null`), so undo sets the global value there. Exception for the gallery: label/position/disabled per store view have no “Use default value” via REST; if the working view has its own gallery values (saved in the view in the admin), `images.ts` (`fixStoreView`) updates position, visibility and cover image roles there, checks the result and otherwise reports an error instead of success (undo: before values of the view, roles `null` = inherited again).
- **Prices:** Lotse `price` = selling price, `listPrice` = list (strike-through) price. Magento shows `price` struck through as long as `special_price` (with `special_from_date`/`special_to_date`) is active and lower; `planPrice()` converts this and always writes `special_from_date` too (otherwise Magento sets it to today itself). Before writing, the executor checks in the proposal's scope (store view from settings, `assertPriceUnchanged`) whether the price fields have changed since the proposal, writes the price fields globally and then checks whether the store view shows the new value (`assertPriceInView`): with price scope “Website”, a website price hides the global value, resulting in an error with undo steps instead of success.
- **Gross/net:** depending on `tax/calculation/price_includes_tax`, Magento stores catalog prices gross or (by default) net; this cannot be queried via REST/GraphQL. Hence the setting “Prices in the Magento admin” (`priceBasis`: `gross`/`net`, environment `MAGENTO_PRICE_BASIS`). Read tools return prices unchanged with `priceBasis` (gross/net/unknown), change cards name the basis; if it is unknown, all price proposals (product, bulk, new products, variants) are rejected.
- **Stock:** only with Magento Inventory and exactly one active source (`/V1/inventory/source-items`); undo also deletes source items of created products (MSI does not clean them up itself).
- **Images:** media ID `mg-<productId>-<entryId>`. Remove = hide (`disabled`) so that undo is exact; cover image = roles `image`/`small_image`/`thumbnail`, the roles are reset exactly as product attributes on undo. Alt text = gallery label.
- **URL keys:** `save_rewrites_history` creates a 301 redirect. Undo restores the old key; the intermediate URL remains as a 301 to the old one (Magento has no REST API for URL rewrites).
- **Promotions:** cart price rules with exactly one discount; customer groups (all) are only set by the executor, the AI does not read customer groups. Empty date fields are cleared with `""`.
- **Variants:** create and link new simple products for existing options; Lotse does not offer deleting variants.
- **Pages** (`pages.ts`, `pagebuilder.ts`): capabilities `MAGENTO_CAPABILITIES` (landingpage, product_list, product_detail; generic blocks, `html`). Content in Page Builder format: one row with html elements (HTML-encoded, `{{` defused, CSS per page limited) and, for `product-slider`, the “Products” element (widget `ProductsList` with SKU condition: live prices, stock, cart). `landingpage` = new CMS page (`POST /<store>/V1/cmsPage`, store view from settings or `allStoreViews`); if the content has an H1, the theme's page title is hidden via CSS (`.cms-<identifier> .page-title-wrapper`); `category` = new CMS block + `display_mode` (PRODUCTS_AND_PAGE/PAGE) + `landing_page` (+ metas) via `writeScoped`; `product` = replace the description (one product) or attach a CMS block as a widget below the description (several). An H1 in category/product content becomes H2. Images: product images (`mg-…`), URLs, staged SVG embedded (data URI); other uploads are rejected by `buildPublish` (no REST API for CMS media). Executor atomic: revert immediately on error. Undo deletes page/block and restores category/descriptions exactly. Verified live against Mage-OS 2.4.9.
- **CMS** (`cms.ts`): `list_cms_pages`, `get_cms_page`, `read_page`, `propose_cms_page_changes`. Magento always saves a page as a whole and regenerates a missing `identifier` from the title: PUT therefore always sends the complete state, and so does undo. Blocks are read-only (saving via REST resets the store assignment).
- **Links** (`links.ts`): check internal links via GraphQL `route` (missing, product disabled/invisible, category inactive, redirect → link directly); in `prepareDraft`, `buildPublish` and in the shop check.
- **Shop check** (`checks.ts`, `checks-rules.ts`): metas, title length/duplicates, thin copy, images/alt texts, stock 0 with “in stock” (MSI), price 0, special price not below price, links in descriptions and CMS pages (one link cache per run: each path is resolved only once across all products and pages), category metas/texts, translations per store view with a different locale; `fixPrompt` names Magento tools. `find_image_gaps` pages with page size = `limit` and returns all matches of the page; `list_products` filters the price range (pre-filtered server-side) and `maxStock` per page and says so in the result (`note`).
- **Import** (`importer.ts`): file/mapping as in `features/import.ts` (`supplierFileTools`), matching by SKU, new products as drafts (`createProduct`), updates only for changed fields (`writeScoped`), prices in the shop's price basis, stock/categories/images, groups + sample, writing in chunks with progress, exact undo. No variants, no new attributes/option values, no categories.
- **Still open:** `get_brand_signals` and theme CSS for the preview (the preview uses the style guide variables), translating CMS content.

---

## 12a. OpenMage (Magento 1): module + adapter

OpenMage (Magento 1 LTS) has no usable interface for CMS pages/blocks, and the old APIs (REST with OAuth 1.0a, SOAP/XML-RPC) are cumbersome. That's why the repository contains its own OpenMage module **`Lotse_Connector`** under `integrations/openmage/` (README with installation, configuration, security, endpoint reference and curl examples; `openapi.yaml` as the contract; `package.sh` builds a zip; `tests/unit.php` for the pure logic, `tests/smoke.php` for the full read, write and undo cycle against a running instance). The adapter `src/server/platform/openmage/` talks **exclusively** to this API (module 1.1.0 and later: `GET /v1/products?fields=…&with=images` returns lists with additional attributes and images for the audit and shop check; 1.2.0 and later: `?term=` searches name OR SKU or title OR identifier in ONE query, so that `list_products`/`search_products`/`list_cms_pages` paginate exactly with a search term; with older modules the adapter falls back to two merged queries. `PATCH /v1/categories/{id}` reports `_write.rewrites_added` like products do, so that undoing a category URL key deletes the 301 history. Product references in tools: `id:12`/`sku:4711` are unambiguous; a plain number is checked as ID AND SKU and rejected as “ambiguous” if there are two different matches).

The module gives Lotse a stateless, token-secured JSON API under `/lotse-api/v1/…` (bearer token, stored encrypted, constant-time comparison, optional IP allowlist; no session, no cookies). Store scope via `?store=<code>` or `X-Lotse-Store`; in store view scope, `null` sets an attribute to “Use default value”, and `store_overrides` names the attributes with their own value in the view (the basis for exact undo). Readable: info, products (list with filters/sorting/pagination, detail with all attributes, stock, categories, images, configurable axes and children), product attributes with options, categories (tree, detail), CMS pages/blocks, cart price rules (usage only as counters) and URL rewrites. Writable (only for the privileged client): product attributes per scope, create/delete product, stock, category assignment with position, images (upload, label, position, roles, hide/delete), category attributes, CMS pages/blocks, price rules including coupon and conditions, custom URL rewrites. Every write response contains the complete new state; indexers run as in the admin.

Privacy through non-existence: routes for customers, orders, carts, invoices, users, API users, payments and newsletters do not exist in the module (404); `tests/unit.php` checks the route table for this. In addition, the adapter follows the rules from section 12: `reader.ts` only allows the GET paths of the `ALLOW` list (plus query keys per path), refuses anything with `DENIED_TERMS` in the path, scrubs responses (`scrubSensitive`) and logs every access; `tests/support/openmage-fake.ts` replicates the module API in memory, and `openmage.test.ts`/`openmage-pages.test.ts` verify every change kind with undo against it via snapshot comparison.

Settings: base URL (`OPENMAGE_URL`), public URL, token (`OPENMAGE_TOKEN`, secret) and optionally a store code (`OPENMAGE_STORE_CODE`, default: the shop's default store view from `/v1/info`). The price basis (gross/net) comes from `/v1/info.price_includes_tax`; there is no separate setting. Files: `client.ts` (bearer, timeout, at most 4 parallel requests, retry on 429/503, **write calls one after another**: parallel product saves trigger indexer deadlocks in OpenMage), `map.ts` (`mrec()` reshapes OpenMage records so that the pure price/audit helpers from `magento/map.ts` can be reused: `priceState`, `planPrice`, `priceUndo`), `write.ts` (`writeScoped`: in the default store view, inherited values are written globally and own store values in the view; globally written values hidden by a store value are also set there; undo writes the before values or `null` = “Use default value” and deletes `_write.rewrites_added`), `catalog.ts`, `images.ts`, `promo.ts`, `variants.ts`, `bulk.ts`, `cms.ts`, `pages.ts`, `checks.ts`, `importer.ts`.

Pages: landing page = new CMS page (`POST /v1/cms/pages`, store view from settings or `admin` for all; `content_heading` empty if the content has an H1). Category = new CMS block + the category's `landing_page`/`display_mode` (PRODUCTS_AND_PAGE or PAGE), metas optional. Product = replace the description (`mode: replace`, default for one product) or append the content below the existing description (`append`, default for several); **no CMS block via `{{block}}`**, because Magento 1's catalog filter only knows `skin`/`media`/`store` in product texts (the directive would appear as text on the page, verified live). Directives in custom HTML are defused, product sliders become static product boxes with real data. The executor is atomic: if a step fails, it reverts the previous ones.

Findings from the live verification (`tests/support/openmage-live/verify.ts`, 174 checks against OpenMage 20.18 with module 1.2.0; the comparison state covers the global scope and every store view, including the default view that customers see): `status` often has its own value in the default store view, in which case Lotse writes there (so customer and admin see it); `""` clears a value globally (OpenMage then returns `null`); OpenMage recreates system rewrites for category assignments with a new ID; the module retries deadlocks (MySQL 1213) on PUT/PATCH/DELETE up to three times. The theme appends `design/head/title_suffix` (e.g. “ | Haus Holm”) or `title_prefix` to every page title; `/v1/info` returns both per store view (module 1.1.2 and later), and `stripTitleAffixes` (`map.ts`) removes a suffix the AI appended itself from meta titles, translations and CMS page titles, otherwise the brand would appear twice in the browser tab (“… | Haus Holm | Haus Holm”, observed in the E2E check).

Store-scope saves in Magento 1 copy every loaded attribute as a store value (the view then no longer inherits anything, undo would not be exact, and a value changed globally later would no longer come through). The module therefore never saves a product in store scope (attributes via `updateAttributes`, gallery rows and image roles directly, module 1.1.1 and later) and, when saving a category, sets all non-requested inherited attributes to “Use default value” like the admin does; `store_overrides` grows by exactly the written codes (`tests/smoke.php` and `verify.ts` check this). `disabled` of a gallery row is a fixed value per view: if the working view has its own rows or its own role attributes, `images.ts` (`fixStoreView`) updates position, visibility and cover image roles there (undo: before values of the row, roles via `writeStore` with `null` = default value) and reports an error instead of success if the view does not take over the state. The price check before writing (`assertPriceUnchanged`) compares in the proposal's scope (store view from settings), not in the global record, so that website prices do not trigger a false “changed in the meantime” message.

Capability note: `GET /v1/products` with `with=images` returns the gallery per entry; the reader allows this regardless of the media scope so that `list_products`/`seo_audit` can report image findings (missing image, missing alt text) even without media tools. This is intentional and matches the Magento 2 adapter; the AI only sees the image files themselves via `view_image`.

---

## 13. Open points

Shopify:

- All checks ran against the local fake (`tests/support/shopify-fake/`), not against a real shop. Not verified against Shopify: behavior of wildcards like `templates/product.*.json`, `templates/customers/*.json`, `templates/metaobject/*.json` in `OnlineStoreTheme.files(filenames:)` (the fake treats them as “no match”) and 250 as page size.
- Lotse templates published before the `base` setting existed in `sections/lotse-content.liquid` have no stored base template; it is only found via identical content with a theme template. If the theme template has changed since, the base is considered unknown and a mixed selection is rejected (deliberately cautious).
- Slugs over 40 characters get hashed metafield keys; old `lotse.<key>` metafields from earlier publications remain orphaned (harmless).
- Import: if the found variants of a family belong to several products, there is no parent row; product fields are then only taken over if all rows agree.

Magento:

- The check for taken `identifier`s is deliberately cautious and also blocks identifiers that only occur in other store views (`cmsPage/search` does not return a `store_id`).
- Preview: product sliders appear as Lotse product boxes in the Lotse preview and as a Magento widget in the shop; the change card and prompt point this out.
- On classic CMS pages (without Page Builder), new `{{…}}` directives from the AI are now also defused; existing ones are kept.
- `get_brand_signals`, theme CSS for the preview and translating CMS content are still missing (see section 12).

Both: `get_brand_signals` (onboarding from the theme) so far only exists for Shopware; on Shopify and Magento the preview uses the style guide variables instead of the theme CSS.
