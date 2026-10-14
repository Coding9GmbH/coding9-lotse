<p align="center"><img src="docs/lotse-logo.svg" alt="Lotse" width="260"></p>

<p align="center"><a href="README.md">Deutsch</a> · <b>English</b></p>

<p align="center"><b>The AI pilot for your online shop – Shopware 6, Shopify, Magento 2 and OpenMage.</b> You set the course – Lotse steers your shop safely there.<br>
Pages & shopping experiences, prices, copy & SEO via chat. The AI only reads; nothing is written until you approve it.</p>

<p align="center"><img src="docs/screenshots/app.png" alt="Lotse interface" width="820"></p>

## Demo

<p align="center"><a href="docs/media/lotse-demo.mp4"><img src="docs/media/lotse-demo-poster.jpg" alt="Lotse in 46 seconds: change prices via chat, review the change set, landing page as a draft" width="820"></a><br><sub>46 seconds: prices via chat, review the comparison, page as a draft – click to open the video</sub></p>

## Screenshots

| Workspace with shop check | Choose context | AI access per area |
|---|---|---|
| <img src="docs/screenshots/app.png" alt="Workspace" width="300"> | <img src="docs/screenshots/app-context.png" alt="Context selection" width="300"> | <img src="docs/screenshots/ki-zugriff.png" alt="AI access: enable shop areas individually" width="300"> |

<sub>Screenshots from the demo shop (Dockware), German UI. The video shows a sample draft with a fictional brand and custom illustrations.</sub>

## Quick start (Docker)

```bash
docker run -d --name lotse --restart unless-stopped \
  -p 127.0.0.1:3333:3333 -v lotse-data:/data \
  --read-only --tmpfs /tmp:size=256m,mode=1777 --tmpfs /app/.next/cache:size=64m,uid=1000,gid=1000 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 512 --memory 2g --cpus 2 \
  ghcr.io/coding9gmbh/lotse:latest
```

> `latest` only exists once the pipeline's release run has been started manually from a tag (see [Releases & image](#releases--image)). If the image doesn't exist yet, build it from source with `make up`.

Then open **http://localhost:3333** and go to *Settings*:
1. **Connect AI** – either
   - **Claude**: Anthropic API key (console.anthropic.com, pay-as-you-go), or
   - **ChatGPT subscription (Codex)**: "Sign in with ChatGPT" → open the link, enter the code shown. Also works inside the container, with no API costs (your subscription's limits apply).
2. **Connect shop** – in the Shopware Admin under *Settings → System → Integrations*, create an integration and enter the shop URL, access key ID and secret.
3. Start with the **style guide onboarding** so Lotse matches your shop's tone and colors.

Everything (app, AI runtime, SQLite database) is in the image; data, encrypted credentials and history live in the `lotse-data` volume and survive updates.

> Shop on the same machine? Inside the container, `localhost` is the container itself – use `http://host.docker.internal:<port>`.

## Running on a server

Lotse can also be self-hosted, e.g. for a team: set `LOTSE_PASSWORD` (login via environment variable) and `ALLOWED_HOSTS`, and put HTTPS in front with a reverse proxy (Caddy, nginx, Traefik). Configuration, proxy examples, backups and troubleshooting: **[docs/self-hosting.md](docs/self-hosting.md)** (German).

## From source / development

```bash
make env     # .env from .env.example (optional – everything can also be set in the UI)
make up      # build and start the image → http://localhost:3333
make demo    # additionally a demo shop (dockware) → http://localhost:8888
make logs    # logs   ·   make down  stop   ·   make backup  back up data
make help    # all commands
```

To add the demo shop in Lotse: shop URL `http://shopware`, public URL `http://localhost:8888`, user `admin` / `shopware`.
Without Docker: `npm install && npm run dev` (Node ≥ 22.13) → http://localhost:3333. Before every commit: `npm run check` (typecheck, ESLint, tests).

## Security – so no shop suddenly goes down

| Protection | How |
|---|---|
| AI without write access | The model only gets a guarded read client with an allowlist (Shopware `ReadOnlyShopware`, Shopify `ShopifyReader`, Magento `MagentoReader`, OpenMage `OmReader`); customer, order, payment and credential data are hard-blocked, and every read is logged. |
| Approval before every write | Changes appear as an old→new comparison; only "Apply" writes. Audit log + undo. |
| The shop is spared | Writes are throttled (`LOTSE_WRITE_CONCURRENCY`, default 2), max. 300 entries per change set, timeouts (`LOTSE_SHOP_TIMEOUT_MS`), backoff on 429/503. |
| Local & hardened | Port bound to `127.0.0.1` only, host/origin check, container runs as non-root, read-only, without capabilities, with resource limits. |
| Credentials | AES-256-GCM encrypted in the volume, never sent to the AI. |
| Codex (ChatGPT subscription) | Codex's own tools (shell, files, web, images, plugins …) disabled, file access fully blocked via permission profile, no prompts for more permissions; shop tools only via a local MCP endpoint with a random token per chat. If a blocked tool shows up anyway, Lotse aborts the turn. |
| Server operation | Set `LOTSE_PASSWORD` (login) + `ALLOWED_HOSTS`, HTTPS via reverse proxy. Guide: [`docs/self-hosting.md`](docs/self-hosting.md) (German). |

For live shops: use a dedicated integration with a restricted role instead of an admin login, and test new workflows on staging first. Details: [SECURITY.en.md](SECURITY.en.md).

> **Why no Claude subscription?** Anthropic does not allow third-party products built on the Claude Agent SDK to use claude.ai login or subscription quotas without prior approval ([Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview)). That's why Lotse only uses Claude with an API key – and deliberately ignores any existing Claude Code login on the machine.

## Configuration

All variables with explanations are in [`.env.example`](.env.example). Values set in the UI take precedence.
Language (German/English) is not a variable: it is chosen in Settings or the side navigation; the default is the browser language (cookie `lotse_lang`).

| Variable | Purpose |
|---|---|
| `AI_PROVIDER` | `claude` (default) or `codex` (ChatGPT subscription) |
| `ANTHROPIC_API_KEY` | Claude AI access (API key) |
| `CODEX_MODEL` | optional Codex model (empty = subscription default) |
| `SHOPWARE_URL`, `SHOPWARE_CLIENT_ID`, `SHOPWARE_CLIENT_SECRET` | Shop access (integration) |
| `SHOPWARE_PUBLIC_URL` | Shop address as seen from the browser, if different |
| `SHOP_PLATFORM` | connected platform: `shopware` (default), `shopify`, `magento` (Magento 2) or `openmage` (Magento 1 with the module from `integrations/openmage/`); for `SHOPIFY_*`, `MAGENTO_*`, `OPENMAGE_*` variables see `src/lib/platforms.ts` |
| `AI_MODEL` | e.g. `sonnet` or `opus` |
| `LOTSE_PASSWORD`, `ALLOWED_HOSTS` | Access protection for server operation ([self-hosting](docs/self-hosting.md)) |
| `LOTSE_BIND`, `LOTSE_PORT` | Published address and port of the container (default `127.0.0.1`, `3333`) |
| `LOTSE_WRITE_CONCURRENCY`, `LOTSE_SHOP_TIMEOUT_MS` | Sparing the shop |
| `OPENAI_API_KEY`, `IMAGE_MODEL` | optional image AI |

## Releases & image

A tag `vX.Y.Z` publishes the image automatically (`.github/workflows/docker.yml`); it can also be started by hand: GitHub → Actions → *Docker-Image* → *Run workflow*. Pushes to `main` and pull requests only run typecheck, lint, tests, build and smoke test, but do not publish an image.

- Tag `vX.Y.Z` (or a manual run from that tag): publishes `ghcr.io/coding9gmbh/lotse` as `X.Y.Z`, `X.Y` and `latest`.
- Manual run from `main`: publishes `edge` and a tag with the commit's short hash.

Built for amd64 and arm64, with SBOM and provenance. `latest` only exists after the first release tag; until then, building from source is the only option (see above). New GHCR packages start out private and must be set to *Public* once in the package settings.

## Documentation

The detailed documentation lives in [`docs/`](docs/README.md) (German): [user guide](docs/benutzerhandbuch.md) (how everything works), [self-hosting](docs/self-hosting.md), [architecture](docs/architektur.md) and [platform layer](docs/platform.md). What changed in each version is listed in the [CHANGELOG](CHANGELOG.md) (German).

## Concept: AI-first administration
Chat instead of forms. You write what should happen ("Change the layout of product XY", "Lower all prices by 20%", "FAQ on all products"). The agent **understands → asks targeted follow-up questions** (clickable answers) **→ researches (read-only) → shows a preview or old→new comparison → you approve → the server writes** (audit log, undo).

**Security model:** The AI has read access only (`ReadOnlyShopware`, no create/update/upload). Writing happens only in the executor (`src/server/changes.ts`) after clicking "Apply"; every application is recorded in the audit log (SQLite, `data/aicb.db`) and can be reversed with "Undo". Uploaded image attachments and AI-generated images stay local in `data/staging/` until approved and only reach the shop with an approved change set.

## Features
- **Chat start with examples**, follow-up questions with answer buttons, history. Optional context (choose category/product) with direct links to the Admin/Storefront.
- **Bulk changes** (prices, list prices, stock, active, copy, SEO) with server-side price rules, warnings (e.g. −99%), row selection, audit log and undo.
- **Per-product blocks** (FAQ): shared PDP layout with block `pdp-faq`, content per product in the JSON custom field `aicb_blocks` (with FAQPage schema).
- **Style guide onboarding**: the AI analyzes theme configuration, storefront CSS, logo and real copy → stored in the database. Applies to copy, colors, preview and the CSS variables (`--sg-*`) in custom HTML.
- **Layout with scope selection** (Shopware): one layout for a category, individual products, all products in a category or the whole shop. Lotse asks beforehand with real numbers, the approval shows how many pages will lose their own layout, and undo restores each page individually.
- **Draft on the real page** (Shopware): header, footer, theme, buy box and product listing of the target page stay; only the content is replaced by the draft. Without a named target, Lotse picks a real product or category.
- **Custom rules**: fixed requirements for copy ("SEO texts at least 2000 characters", "we use informal address"), per area (product copy, pages, SEO) and optionally only for one category. Maintained in the style guide or via chat, applied in every chat.
- **Custom shop checks** (all platforms): checks defined via chat over fixed fields (description length, meta, price, stock, image) appear as findings in the shop check; existing checks can be switched on and off.
- **Shopping experience know-how**: the agent knows sections/blocks/slots, reads existing layouts (`get_cms_page`) and takes existing content into account.
- **Custom HTML/CSS/JS** as an `html` element (block `custom-html`, CSS automatically scoped).
- **History**: all chats incl. drafts/approvals are stored in the database and can be reopened in the UI.
- **German and English**: the UI and AI replies are available in German and English. Switch in Settings or the side navigation; without a choice, the browser language applies (stored in the `lotse_lang` cookie).
- UI in the Coding9 corporate design (dark `#2E2E38`, green, coral, cream; Satoshi/Inter via Fontshare/Google Fonts).

## Supported platforms

The platform is chosen in Settings under "Connect shop" (or via `SHOP_PLATFORM`). Shopware 6 is the default and the most complete; exactly what each platform can do is shown in the [capability matrix](docs/en/platform.md#0-capability-matrix-status-after-shopify-magento-2-and-openmage) in [`docs/en/platform.md`](docs/en/platform.md).

| Platform | Setup (in brief) |
|---|---|
| **Shopware 6** (default) | In the admin under *Settings → System → Integrations*, create an integration and enter shop URL, access key ID and secret (alternatively an admin user; `SHOPWARE_*`). |
| **Shopify** | Install an app from the Shopify Dev Dashboard and enter its client ID/secret, or use the Admin API token of an existing custom app; plus the `*.myshopify.com` domain (`SHOPIFY_*`). |
| **Magento 2** (Adobe Commerce) | In the admin under *System → Extensions → Integrations*, create an integration with access to catalog, content and marketing and enter its access token (alternatively an admin user); optionally store view and price basis (`MAGENTO_*`). |
| **OpenMage** (Magento 1) | Install the `Lotse_Connector` module from [`integrations/openmage/`](integrations/openmage/README.en.md), generate an API token, enter shop URL and token (`OPENMAGE_*`, see below). |

**OpenMage** has no usable API for CMS pages/blocks, so the repository includes the module **`Lotse_Connector`** ([`integrations/openmage/`](integrations/openmage/README.en.md)) with a token-secured JSON API under `/lotse-api/v1`. Installation in brief (details, security and endpoints in [`integrations/openmage/README.en.md`](integrations/openmage/README.en.md)):

1. Add the module to the OpenMage installation: copy the files from `integrations/openmage/` or unpack the zip from `./package.sh`, via `modman link`, or via Composer (type `magento-module`).
2. Flush the cache, enable the API in the Admin under **System → Configuration → Lotse → API** and generate an API token (alternatively `php shell/lotse.php --generate-token`).
3. In Lotse under "Connect shop", choose **OpenMage** and enter the shop URL and token (or `OPENMAGE_URL`, `OPENMAGE_TOKEN`, optionally `OPENMAGE_STORE_CODE`).

The module has no routes for customers, orders, payments or users – this data never reaches Lotse.

## Product page

Lotse's product page is at [coding9.de/produkte/lotse](https://coding9.de/produkte/lotse) and is maintained with the CODING 9 website.

## Architecture

Next.js 16 (App Router) · React 19 · TypeScript (strict) · SQLite (`node:sqlite`) · Claude Agent SDK or OpenAI Codex SDK (ChatGPT subscription).

```
src/
├── proxy.ts              host/origin check, optional login, storefront paths → /shop
├── app/
│   ├── page.tsx          workspace (chat, context, preview)
│   ├── settings/         settings: shop, AI, image AI, AI access, logs
│   ├── api/**/route.ts   REST + chat stream (NDJSON)
│   ├── shop/             storefront proxy for the live preview
│   └── staged/           staged images (local only until approved)
├── components/           UI by area (shell = navigation, chat, context, preview, dialogs, settings, ui), CSS Modules
├── hooks/                useChatStream, useAttachments
├── lib/
│   ├── i18n/             languages (de, en), dictionaries per namespace under messages/
│   ├── protocol.ts       contract server ↔ UI (REST types, chat events)
│   └── chat-state.ts     one reducer for the live stream and restoring a chat
└── server/               server-only (`server-only`)
    ├── agent.ts          chat turn: Claude Agent SDK (in-process MCP), streaming of the draft
    ├── agent-codex.ts    chat turn with Codex (ChatGPT subscription); shop tools via /api/mcp/<chat> (token per chat)
    ├── codex.ts          Codex sign-in (device code), locked-down configuration without shell/files/web
    ├── platform/         platform layer: adapter contract + Shopware, Shopify, Magento 2, OpenMage, see docs/platform.md
    ├── tools.ts          core tools + assembly per platform (reading free, writing only via change sets)
    ├── policy.ts         protection layer: allowlist, blocked data, access log
    ├── changes.ts        executor: the only code that writes (throttled, audit, undo)
    ├── shopware.ts       Admin API client (timeouts, backoff) + ReadOnlyShopware for the AI
    ├── cms.ts / patterns.ts   block catalog, spec → `cms_page`, HTML preview
    └── db.ts / settings.ts    SQLite, encrypted credentials
prompts/                  system prompt as versioned Markdown: common/ (all platforms) + shopware/, shopify/, magento/, openmage/
integrations/openmage/    OpenMage module Lotse_Connector (JSON API, openapi.yaml, tests, package.sh)
tests/                    all tests (node:test), structure mirrors src/
└── support/              fake shops (Shopify, OpenMage) with tests and live check scripts
```

New block types: add them to `BLOCKS` (`src/server/cms.ts`) (+ preview renderer) – the agent gets the catalog automatically.
New shop platform: contract, conventions and checklist in [`docs/platform.md`](docs/platform.md) (German).
New UI language or translations: see [CONTRIBUTING.en.md](CONTRIBUTING.en.md#translations).

## Disclaimer

Lotse is provided without warranty; use is at your own risk. AI results can be wrong and must be reviewed before approval; test new workflows on a staging shop first and make a backup beforehand. As the operator, you are responsible for transferring shop content to the AI provider. All notes: [DISCLAIMER.en.md](DISCLAIMER.en.md).

## License

[MIT](LICENSE) © CODING 9 GmbH
