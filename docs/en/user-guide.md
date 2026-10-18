[Deutsch](../benutzerhandbuch.md) · **English**

# User guide

Lotse is an AI assistant for your online shop (Shopware 6, Shopify, Magento 2, OpenMage). You write what should happen in the shop. Lotse asks follow-up questions, shows you a preview or a comparison first, and writes **only after your approval**.

> The AI has read-only access. Writing is done exclusively by the server, after you click “Apply”, and every change can be undone.

## 1. The interface

| Area | Purpose |
|---|---|
| **Workspace** | Chat, context and preview. Start page with shop check and examples |
| **Style guide** | Brand (colors, fonts, tone) and custom rules, in one dialog |
| **Knowledge** | Documents (data sheets, PDFs) as a source of facts |
| **History** | All chats; a dot shows whether a turn is running, waiting for you or finished |
| **Settings** | Connect shop, connect AI, image AI, AI access, logs, language |

New chat: **New chat** or **New chat with context** (choose the target right away). Chats stay in the history and can be reopened, including draft and approvals.

## 2. A chat in brief

1. **Write what should happen.** Examples: “Change the layout of the product page of product XY”, “Lower all prices in the Jackets category by 20%”, “Add an FAQ to all products”.
2. **Answer follow-up questions.** Lotse asks targeted questions (clickable answers) when something is unclear: scope, tone, order. It does not invent missing facts.
3. **Review the preview or comparison.** Pages appear on the right as a draft, data changes as an old→new list.
4. **Approve.** Only “Apply” writes to the shop.
5. **Undo if needed.** “Undo” restores the previous state.

You can attach files (images, CSV, Excel, PDF, Word, text; by clicking, pasting or dragging). Lotse uses them as a source, e.g. photos for new products or a supplier list for an import.

### Context
Use the target icon to choose a category, product or landing page. The chat then refers to it, and the real page appears on the right. Without a selection, Lotse works out the target from your message. Choosing a different context in a chat that already has a history automatically starts a new chat, so histories stay cleanly separated.

## 3. Preview

The preview on the right has two views:

- **Current**: the real page in the shop.
- **Draft**: Lotse's draft, in your shop's theme.

**Draft on the real page (Shopware).** Header, footer, menu, buy box, description/reviews, cross-selling, product listing and filters are the real parts of the target page. Only the content in between is replaced by your draft. If you don't name a product, Lotse picks a real active product with an image (for category layouts, its category). 

**Draft in the real theme (Shopify, Magento, OpenMage).** The preview shows the shop's real target page (product, category or collection; for landing pages the home page as the frame) with header, footer and theme CSS. Inside it is exactly the HTML that publishing writes: above and below the theme content (product list, product area, position of the `theme-main` block), for Magento and OpenMage products in the product description, for landing pages in place of the page content. If the page cannot be reached (e.g. a password-protected shop without a content area), Lotse shows the simple preview with the style guide colors.

**JavaScript in the preview.** The shop's menu, sliders and gallery work, but isolated: the preview has no access to Lotse, cookies or your session, and third-party scripts (tracking, consent services) are not executed. Features that need requests to the shop (e.g. the cart flyout) do not work in the preview.

**Annotate.** With **Annotate** you click elements in the preview and note what should be different. The notes (“requests”) are collected and sent together as one task with **Send … requests to Lotse**. This works in both “Current” and “Draft”.

**Mobile view.** The phone icon switches to a narrow layout.

**SEO/CRO review.** For the draft, Lotse shows a rating with concrete points (headings, links, images, structure). One click opens the list.

## 4. Approval and undo

Every change to the shop goes through a **change set**:

- For each row you see **before → after** with warnings (e.g. price −99%, price below purchase price).
- You can **deselect rows**; only what is selected is applied.
- “Apply” writes to the shop at a throttled rate (at most 300 entries per set; bulk rules beyond that, see below).
- Every application is recorded in the **Changes** log (Settings → Logs), with time, scope and result.
- **Undo** restores the old values. For layouts, each page is reset individually and the new layout is removed again.

**Writing is atomic where it makes sense:** if a step of a layout publication fails, everything is rolled back and nothing half-done remains in the shop.

**Bulk.** Rules for many products (“lower all prices by 20% and round to .99”) are calculated by the server, not the AI. You see groups, a sample and errors instead of thousands of rows.

## 5. Layouts and pages

Lotse builds Shopping Experience layouts (Shopware) or page content from blocks: text, image-text, sliders, FAQ, custom HTML sections and more. The draft matches your **style guide** and reuses existing building blocks of your shop.

### Where should a layout apply? (Shopware)
Before a layout for categories or products is published, Lotse asks, with real numbers, **where** it should apply:

| Target | Selection |
|---|---|
| Category | one category · several selected · all categories |
| Product | one product · several selected · all products of a category (incl. subcategories) · all products in the shop |
| Landing page | own page with URL and sales channel |

The overview shows how many pages **lose their own layout** as a result (“30 products, 4 of them with their own layout, will be replaced”). At most 1000 pages per publication; narrow the selection first for more. Meta title and description only apply to a single category; for several, add them afterwards via chat per category.

## 6. Style guide and custom rules

The **style guide** describes how your brand looks and sounds: colors, fonts, radius, tone (informal/formal address, dos and don'ts), typical building blocks. Lotse derives it from theme, CSS, logo and real copy (“Analyze style guide”) and applies it to everything.

- **Colors** can be adjusted and saved directly in the dialog.
- **Everything else** you change in the chat (“Switch to informal address”).
- **Detected building blocks** are collapsed; they are material for the AI.

### Custom rules
Fixed requirements for all copy, for example:

- “SEO texts on product pages have at least 2000 characters.”
- “We never say ‘cheap’, we say ‘fairly priced’.”
- “Dimensions always in cm.”

Each rule has a **scope** (everywhere, product copy, pages, SEO) and optionally a **category** to which it applies exclusively (then also to its subcategories and products). You create rules in the style guide dialog or in the chat (“Remember: we address our customers informally”); Lotse asks before saving. They apply in every chat in addition to the style guide and take precedence in case of conflict. At most 100 rules of 300 characters each.

## 7. Knowledge

On the **Knowledge** page you store documents: data sheets, PDFs, Word, Excel, CSV, text (up to 25 MB, no customer or order data). Lotse stores them locally and uses them as a **source of facts** for product copy, FAQs and safety information (e.g. GPSR).

- Documents can be linked to products and categories.
- Every statement taken from the knowledge base names its **source** (document and page).
- If a fact is missing, it is left out or asked for, never invented.
- Excerpts are sent to the AI provider (Anthropic or OpenAI) as part of the prompt.

## 8. Shop check and custom checks

On the start page, the **shop check** shows what is currently wrong in the shop: SEO, images, data, prices, links, languages, legal and accessibility (technical check, not legal advice) and Search Console. Each item has a severity (Important, Medium, Note), a count, examples and **Add as task**: this puts a ready-made task into the input field; it is only sent when you click.

The check runs in the background (stale after 6 hours) or via **Check again**, and automatically after changes have been applied.

### Managing checks
**Checks** opens the list of all checks:

- **On/off** per check. A disabled check does not run and does not appear.
- **Custom checks** (marked “custom”) can be deleted.
- **Create new check in chat**.

### Custom check via chat
Examples:

- “Warn me when product descriptions are shorter than 2000 characters.”
- “Report products with fewer than 5 items in stock.”
- “Check whether the meta description is missing and there is no image.”

Lotse turns this into conditions on fixed fields and shows you **the rule in words and the number of matches in your shop before saving**. Only after “Yes” is it created, and it then appears as a regular finding.

| Field | Meaning |
|---|---|
| Words / characters of the description | Length without HTML |
| Characters of the meta title / meta description | 0 = missing |
| Characters of the product name | |
| Price, list price | gross |
| Stock | where the platform provides it |
| Has an image | yes / no |

Conditions can be combined with **and** (all) or **or** (at least one); comparisons: <, ≤, >, ≥, =, ≠. Unknown values never match; nothing is guessed. Custom checks see active products, not categories, pages or links. At most 20 custom checks with 5 conditions each.

### Impact of changes (Search Console)
If Search Console is connected, Lotse remembers the search data of the previous 28 days when you apply a change: for meta title and description, name, description, short description, FAQ, title and content of CMS pages, and for new layouts or page content of existing categories and products (at most 50 pages per change set, only pages Google already knows). Under **SEO → Impact of your changes** you see the state of each change: *Waiting for data* (with the date from which it can be measured), *Preliminary* (from 14 days) or *Measured* (after 28 days), with clicks per day, click-through rate and position compared, and a verdict (*Improved*, *Got worse*, *No clear effect*, *Too little data*). **Measure now** asks Search Console about all open changes without writing anything. If a change did harm, **Open chat** takes you to the change set, where you can undo it; the shop check reports such changes too. Measurements can be hidden.

### Sales: top sellers and slow movers
If the **Sales** switch under Settings → AI access is on, Lotse reads only **totals per product** from the orders of a period: quantity, revenue (line totals) and number of orders, without cancelled orders. Neither Lotse nor the AI sees customers, addresses or single orders. You can then ask: “What are my top sellers of the last 30 days?”, “Which products don't sell?” or “Which top sellers have weak content?”. In the **Abverkauf** (sales) area the shop check reports top sellers with a thin description, missing metas or no image, and slow movers (stock but no sale in 90 days). Shop requirements: Shopware integration with read access to orders; Shopify app with `read_orders` (without `read_all_orders` only 60 days); Magento integration with access to Sales → Orders; OpenMage with the `Lotse_Connector` module 1.3.0 or later.

## 9. Settings

| Section | Contents |
|---|---|
| **Connect shop** | Choose platform, enter credentials, test connection. Recommended: a dedicated integration with a restricted role instead of an admin login |
| **Connect AI** | Provider (Claude via API key or Codex via ChatGPT subscription), model, **monthly budget** (cost brake for Claude: once reached, no new run starts; each run uses at most half of the free budget, also with parallel chats; from 80 % a notice in the chat; below it the costs of this month and today) |
| **Image AI** (optional) | OpenAI key and model for generated images; AI images are visibly labeled |
| **AI access** | Which areas Lotse may read (products, categories, layouts, media, marketing, shop basics). Blocked areas are not read, not even by the shop check. Separate switches (off by default): **Sales** (only totals per product from orders, see below) and **Internet** (web search) |
| **Logs** | **Access** (every read access by the AI, rejected ones marked) and **Changes** (approved, rejected, undone, changed) |
| **Search Console** (optional) | Access for opportunities, content gaps and impact measurement |
| **GitHub** (optional, under Integrations) | Fine-grained token for code changes to plugins and themes. On GitHub under *Settings → Developer settings → Fine-grained tokens*, select only the repositories you need and set **Contents** and **Pull requests** to *Read and write*. The token is stored encrypted, tested automatically (shows the GitHub login and repositories without write access) and never shown again, not even to the AI. Lotse only writes to its own `lotse/…` branches, never to `main` |
| **Sandbox** (optional) | Switches on **Sandbox Coding** (off by default): code tasks in their own Shopware containers (Dockware) on this machine, plus memory, CPUs and the idle pause (stopped, not deleted). Needs Docker access, see [Self-hosting](self-hosting.md#enable-sandbox-coding). Set the image, environment variables and own setup commands in the **Sandbox Coding** tab; secret values are encrypted and never shown |
| **Language** | German or English for the interface and AI replies (see below) |

Customer, order, payment and credential data are permanently blocked and cannot be unlocked.

### Sandbox Coding: a sandbox in the chat

A sandbox is a **development environment connected to Git, in which Claude Code or Codex work**: a working copy of your repository and a test shop of its own (Shopware in Docker), where the AI makes changes, checks them and saves its steps as commits – nothing is published until you click to open a pull request. You attach a sandbox to an ordinary chat of the workspace: **Start sandbox** (with a `</>` icon next to the context below the input) opens the “Start sandbox” dialog with repository (from GitHub), base branch (preselected from the environment’s presets in the **Sandbox Coding** tab), an optional title and – behind “Add a database dump” – an optional database dump. If Docker is not reachable, the button is locked and the dialog says so with a link to the guide. The AI can also propose a sandbox itself (“Proposal: start a sandbox” with repository, branch and its reason) – it is only created when you click **Start sandbox**; the reason becomes the sandbox’s title (**Adjust …** opens the same dialog). Afterwards the card shrinks to one line. There is at most one sandbox per chat. Lotse sets up a Shopware container of its own in the background; next to the chat, instead of the draft preview, the sandbox appears. Its header has two lines: title and status, below them repository and working branch (with a copy button; the full name is in the tooltip). On the right are the internet state, the one fitting action (**Stop**, **Pause** or **Resume**) and the **⋯** menu with **Replace database**, **All sandboxes** and **Finish sandbox**; while an action runs, the status reads “Pausing …” or “Starting …” (and no button contradicts it; “Resume” only appears once the container has really stopped). Below are the tabs **Preview**, **Setup**, **Changes** and **Pull request** (numbers are neutral; a coral dot means something needs you, e.g. a failed step or new feedback). During the setup **Setup** is open: at the top “Step 5 of 12 · about 2 min” with a progress bar, below it every step with status and duration; the log opens by itself for the running and the failed step, for the others on click. If a step fails, one line below it states the cause (the full output is in the log), **Retry from here** continues there, for your own commands **Edit the command in the environment →** leads straight to the environment, and the chat reports the failure too. Once the sandbox is ready the view switches to **Preview** and the setup folds into “Set up in 2:45 min ✓” (**Show details** opens it again). You can already write during the setup: the AI starts once the sandbox is ready. **Pause**/**Resume** stops and starts the container (code, database and changes stay; after longer inactivity Lotse pauses it by itself). **Finish sandbox** (in the **⋯** menu) deletes container and files – if feedback on the pull request is still open, the confirmation warns about it; the sandbox is detached, the chat stays and is a normal chat again (marked “Sandbox (finished)” in the history), the sandbox stays as an entry in the **Sandbox Coding** tab. That tab is an overview: readiness at the top (one line when everything is set up, otherwise a note on what is missing), then all sandboxes with status, repository and PR link with its state (“PR #1 · open”, “merged”, “closed”; a click opens its chat, **Sandbox in a new chat** starts a new one), and the collapsible **Environment** below. Memory, CPUs and the idle pause are under Settings → Sandbox; both pages link to each other.

**With your own database:** in the dialog you can optionally upload a **database dump** (`.sql` or `.sql.gz` from `mysqldump`/`mariadb-dump`, without `--databases`/`--all-databases`) by drag & drop or file picker – only sanitized dumps without customer data. The upload runs in chunks with progress; **Cancel** pauses it, **Resume** continues where it stopped. The setup first checks whether the dump matches the image’s Shopware version: if the major version differs (e.g. dump from 6.6, image 6.7) it stops with a hint – better choose a matching image in the environment, or import anyway with **Continue anyway**. Then Lotse imports the dump, points the domain to the sandbox, installs your plugin, runs the own commands “after the database” and compiles the theme. The dump is **deleted right after the import** (also if it fails); the timeline shows “Dump deleted ✓”. **Replace database** in the **⋯** menu imports a new dump later; your code stays unchanged.

The **Preview** shows the sandbox storefront – for trying it out like a real shop: navigation, search, cart, checkout and customer account work (Lotse keeps the session per sandbox on the server). It fills the tab edge to edge. At the top you enter a path (e.g. `/checkout/cart`), reload, switch between desktop and mobile or open the preview **in a new tab**. If the space is narrower than Shopware’s desktop width (992 px), “Desktop” shows a scaled-down 1280 px view, so the storefront really shows its desktop layout; below about 700 px the preview starts in mobile width (the desktop view would hardly be readable there) – “Desktop” still switches. More room: drag the border between chat and preview (or use the arrow keys) – Lotse remembers the width in this browser –, **Collapse chat** or **Full screen** (Esc ends it). **Admin** opens the sandbox’s Shopware administration (best effort). Symfony’s debug toolbar and Shopware’s cookie notice are switched off in the sandbox (step **Tidy the preview**), so they cover neither the preview nor screenshots. After the theme is compiled the preview reloads by itself. If the sandbox is paused, **Resume** (or **Load preview**) starts it again; until the storefront delivers its first page (Shopware recompiles its templates after the start, which Lotse does before “Ready”) it shows “Environment starting …” – at normal size, not scaled down. The preview counts as activity.

**Working on the code with the AI:** in a chat with a sandbox the AI works like a developer – and **only** in the sandbox: the live shop is not reachable from there (no shop tools, no change sets). It reads and edits the repository’s files with its own file tools, runs commands inside the container (e.g. `bin/console theme:compile`, logs, the sandbox database) and checks the page itself. Every changed file appears as a card with “+/−” lines, every command with its result (e.g. “Compile theme ✓ 7 s” or the error); after compiling, the preview reloads. Like Claude Code, the AI saves every finished, checked step as a **commit** with its own message (tool “Save change”) – locally in the sandbox only: no push, no branch switch, no rewriting of earlier commits; the author is “Lotse”, with you as co-author. It does not commit protected files, GitHub workflows or anything that looks like a secret (the same check as publishing, without “anyway”). The **Changes** tab shows the **saved steps** at the top (commits, newest first, each “local” or “published”) and – if any – what is **not saved yet**, below that all changes against the base branch: a collapsible section per file with “new”/“deleted”, +/− counts and line numbers; a click on a file in the list jumps there, and it refreshes by itself after every file change. If the sandbox is paused, your message starts it again (“Environment starting …”) – the chat waits until Shopware answers. Requests marked with **Mark** in the preview go straight to the AI. The AI can change files only in the sandbox’s repository; `.git`, `.env` and keys are blocked for it, commands run only inside the container (no internet, never on the Lotse machine), Lotse tells it environment variables by name only (commands in the container can read them, though; output is redacted – only enter credentials there that are meant for the sandbox alone), and it publishes nothing itself: at the end it proposes title and description for the pull request. Claude turns count towards the cost brake; with Codex the chat runs on the ChatGPT subscription.

**Building plugins:** the sandbox is not only for themes. In a plugin repository the AI also changes PHP classes, `services.xml`, settings (`config.xml`), migrations, storefront templates and administration extensions; it knows the structure of a Shopware plugin, makes changes effective in the container itself (`bin/console plugin:refresh`, `plugin:install --activate <Name>`, `plugin:update`, `database:migrate`, `theme:compile` and `cache:clear` last – in the reverse order a newly added template of a freshly installed plugin stayed invisible in our test) and checks them (preview, `plugin:list`, logs, its own console commands or calls to the test shop’s Store API). **A new plugin from scratch:** choose an empty repository in the dialog – at most `README`, `LICENSE` and `.gitignore`, as GitHub creates it (at least one commit, otherwise there is no base branch). The dialog notices (“The repository is still empty …”) and asks for the **technical name of the plugin** – its class and folder name in Shopware, e.g. `CoNineHeaderBanner` (letters and digits, starts with an upper-case letter; a name derived from the repository name is suggested). When the AI proposes the sandbox it can pass the name along (shown on the card); without one for an empty repository, **Start sandbox** opens the dialog. The setup reports “The repository is empty – new plugin …” at **Detect plugin**, skips **Install and activate plugin** and – without a database dump – also **Compile theme** (“will be skipped (new plugin)” in the timeline) and is ready afterwards; with a dump, the imported shop’s themes are compiled and the cache cleared as usual. The AI then creates `composer.json` (type `shopware-platform-plugin`, `extra.shopware-plugin-class`, `autoload`) and the plugin class, installs and activates the plugin in the container and then builds the actual feature; the files end up in the sandbox under `custom/plugins/<Name>`. As soon as `composer.json` and the class exist, Lotse treats the repository like any other plugin – a new setup (e.g. **Retry from here** at **Detect plugin**) then installs it normally. The pull request contains all new files. **JavaScript and administration:** storefront JavaScript and administration extensions have to be built (`bin/build-storefront.sh` or `bin/build-administration.sh` in the container). Both scripts ship with the Dockware image but download npm packages on their first run: offline the storefront build stops at once (`EAI_AGAIN`), the administration build hangs. So the AI asks for internet for it (see below); with internet the first build takes several minutes (not verified in Lotse’s test environment, whose containers have no internet). Twig, SCSS (via `theme:compile`), PHP and configuration need no build.

**Internet for the sandbox (only after approval):** the sandbox container is offline. If the AI needs internet (e.g. for `composer require` or `npm install`), it asks: the chat shows “Allow internet access for the sandbox?” with its reason; only your click on **Allow for this sandbox** connects the container to the internet (**Decline**: it continues without). Such requests have a coral border because they are a risk decision; if you block internet again later, the card says “Allowed – blocked again since”. You can also switch it yourself in the sandbox header: **Internet: off** allows it, with **Internet: on** (yellow badge) **Block** blocks it again. Access applies to this sandbox only and ends when you block it, pause (also automatically after inactivity) or finish; after “Resume” the container is offline again. **With internet the container reaches any public address – including your live shop’s website** like any other site. So only allow it when needed. Lotse itself stays unreachable from the container. In the environment (**Sandbox Coding** tab), **Internet in the container** is “only after approval” (default) or “never”. Approvals and revocations are in the audit log with the user.

**Publishing (pull request):** once the change is checked in the preview, the AI proposes title and description (“Proposal for the pull request”); the description is shown formatted (lists, bold, code). **Review and publish** opens the **Pull request** tab with that proposal; once the pull request exists, the card says “Published as #42” with a link. The tab shows the pull request at the top (once there is one), then the form with the changed files and the route `lotse/<title>-<id> → <base branch>`, adjust title and description and click **Create pull request** (the button stays visible at the bottom) – only this click publishes. Progress runs as the steps Commit → Push → Pull request; afterwards the tab scrolls to the top and reports “Pull request #42 created.” Lotse pushes the AI’s commits as they are and only turns what is not saved yet into one last commit (title and description as the message; author “Lotse”, you as co-author when you are logged in with `LOTSE_PASSWORD`) – all to the task’s own working branch and opens the pull request against the base branch (not a draft). Lotse sets branch and target, not the AI. Changes to `.github/workflows` and `.github/actions` (and `action.yml` anywhere), protected files (`.env*`, keys, `auth.json`) and anything that looks like a secret (tokens, private keys, URLs with a password, credentials stored in Lotse) are not published: Lotse stops before the push and names file and line. Stored credentials only count when they are fit to be a secret – a plain shop password like “shopware” does not block every `composer.json` with `shopware/core`. For a remaining false alarm (a stored value or an example URL with a password) you publish after checking with **Publish anyway**; the approval is logged with file, line and your name, never with the value. Keys and tokens cannot be approved. Afterwards chat and tab show the card “#42 … – open” with its state (open, merged, closed), the checks on GitHub and **Open on GitHub**; the task list shows the number. Further changes go into the same pull request with **Update pull request**; the button only appears when something changed since the last push (or you edit title or description), otherwise it says “Everything is published”. If something stops it, the reason is shown in one line in the tab, with the full report from git or GitHub collapsible below: missing write access of the token (only on a real 403 from GitHub), branch protection for `lotse/*`, a branch changed on GitHub, another refusal by the server (“Push rejected: …”, e.g. a pre-receive hook or a file that is too large), the GitHub rate limit or a Lotse restart; clicking again continues there without creating anything twice. Nothing is published while the AI is working (and vice versa).

**Feedback on the pull request:** while the pull request is open, Lotse asks GitHub for news about every two minutes (only with Sandbox Coding on and GitHub connected). Reviews, comments, line comments and failed checks appear as a card **Feedback on pull request #42** in the sandbox’s chat – each piece of feedback only once. The texts come from third parties; the AI only sees them when you click **Hand over to AI**. That starts a new turn: the AI gets the feedback as marked data (redacted and capped), works through it in the sandbox – a paused container is woken first – and then proposes a new description; publishing again takes your click on **Update pull request**, into the same pull request. When the pull request is merged or closed, a card says so with **Finish sandbox**, and Lotse stops asking. Once the sandbox is finished, feedback can no longer be handed over: for further changes start a new sandbox (and upload the database dump again).

**Screenshots (optional, by hand only):** neither the setup nor publishing captures anything by itself. If you want images for the pull request, switch on the **Screenshot button in the preview** in the environment (**Sandbox Coding** tab; default: off) and set the **Pages for screenshots** (one path per line, at most 5, default `/`). Then **Screenshot** (camera icon in the preview bar, in the menu when the panel is narrow) captures these pages on desktop and mobile – for example once before and once after the change. The **Pull request** tab shows the captures only when there are some (newest first, at most the last six; a click opens an image in full size). The images stay in Lotse (they are deleted with **Finish sandbox** and on a new clone); the pull request only mentions them in one sentence, without a link and without an upload to GitHub. The capture runs in a short-lived container with a fixed browser image (`mcr.microsoft.com/playwright`, about 2 GB once; “Check environment” pulls it while the button is switched on, otherwise the first click does); it is attached only to the internal network and reaches only its sandbox’s storefront. If a capture fails (page not answering, sandbox paused), the preview says why.

### Language
The interface and AI replies are available in **German** and **English**. You can switch in **Settings** and at the bottom of the side navigation (DE/EN). Without an explicit choice, Lotse follows your browser language (otherwise German); your choice is stored in the `lotse_lang` cookie and takes effect immediately.

- The AI's **chat replies** (answers, follow-up questions, summaries, reasons in proposals) follow the interface language.
- **Shop content** (product copy, pages, SEO, translations) is written by Lotse in the language the shop or sales channel requires, not automatically in the interface language.
- Text that comes directly from the shop or the server (shop data, some error messages) stays in its original language.

## 10. What Lotse does not do

- It never writes without approval and does not read customer, order or payment data.
- It does not estimate prices, stock levels or purchase prices. You decide these values.
- It does not give legal advice; legal and accessibility checks are technical hints.
- It does not replace staging: try new workflows in a test shop first.

## 11. Troubleshooting

| Symptom | What to do |
|---|---|
| “Host nicht erlaubt” (host not allowed) | You are accessing Lotse under a name that is not allowed. When running on a server, add the name to `ALLOWED_HOSTS` ([Self-hosting](self-hosting.md)) |
| Chat keeps showing “running” | Reload the page; Lotse reconnects. A dot in the history shows the real state |
| Preview shows “Redirect outside the shop” | The shop redirects to a foreign domain. The same site (e.g. `stage.` → `www.`) is followed, foreign domains are not |
| Shop check “incomplete” | At least half of the checks failed (shop unreachable, access blocked). Test the connection, then “Check again” |
| New check reports nothing | The rule currently matches no active product; the match count before saving shows this |
