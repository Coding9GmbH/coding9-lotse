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

### Sandbox Coding: tasks

In the **Sandbox Coding** tab, **New task** creates a code task: repository (from GitHub), base branch, title and “What should be changed?”. Lotse sets up a Shopware container of its own for it in the background; the task page shows every step with status, duration and log. If a step fails, the cause is shown below it and **Retry from here** continues there. **Stop** aborts a running setup, **Pause**/**Resume** stops and starts the container (code, database and changes stay; after a longer inactivity Lotse pauses it by itself). **Finish task** deletes the task's container and files; the entry stays in the list.

**With your own database:** when creating a task you can optionally upload a **database dump** (`.sql` or `.sql.gz` from `mysqldump`/`mariadb-dump`, without `--databases`/`--all-databases`) by drag & drop or file picker – only sanitized dumps without customer data. The upload runs in chunks with progress; **Cancel** pauses it, **Resume** continues where it stopped. The setup first checks whether the dump matches the image's Shopware version: if the minor version differs (e.g. dump from 6.6, image 6.7) it stops with a hint – better choose a matching image in the environment, or import with **Continue anyway**. Then Lotse imports the dump, points the domain to the sandbox, installs your plugin, runs the own commands “after the database” and compiles the theme. The dump is **deleted right after the import** (also when it fails); the timeline shows “Dump deleted ✓”. **Replace database** on the task page imports a new dump later; your code stays as it is.

Once the container is running, the **Preview** on the task page shows the sandbox storefront – for trying it out like a real shop: navigation, search, cart, checkout and customer account work (Lotse keeps the session per task on the server). At the top you enter a path (e.g. `/checkout/cart`), reload, switch between desktop and mobile width or open the preview **in a new tab**. **Admin** opens the sandbox's Shopware administration (best effort). After the theme was compiled the preview reloads by itself. If the task is paused, **Load preview** starts the environment again; until Shopware answers it shows “Environment starting …”, then the page appears by itself. The preview counts as activity.

**Working on the code with the AI:** next to the preview is the task's **chat** (one chat per task; it also shows up in the history on the left, marked “Code”). Describe what should change – or take the text from creating the task with **Use the task goal**. The AI works like a developer in the repository: it looks at the files, edits Twig templates and SCSS, compiles the theme in the container and checks the page itself. Every changed file appears as a card with “+/−” lines, every command with its result (e.g. “Compile theme ✓ 7 s” or the error message); after compiling, the preview reloads. The **Changes** tab shows all changes against the base branch. If the task is paused, your message starts the environment again (“Environment starting…”) – the chat waits until Shopware answers. Requests you mark with **Annotate** in the preview go straight to the AI. The AI can only work in the task's repository and only run allow-listed commands; `.git`, `.env` and keys are blocked for it, it sees environment variables by name only, and it publishes nothing by itself: at the end it proposes a title and description for the pull request. Claude runs count towards the cost brake; with Codex the chat runs on the ChatGPT subscription.

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
