# Plattform-Schicht: Shopware, Shopify, Magento, OpenMage

Lotse verbindet genau **einen** Shop. Welche Plattform das ist, steht in den Einstellungen (`platform`, Standard `shopware`, Umgebung `SHOP_PLATFORM`). Der Kern (Chat, Freigabe-Workflow, Seitenentwurf mit Vorschau, Styleguide, Wissensbasis, Datei-Anhänge, Search Console, Shop-Check) kennt keinen Shop. Er spricht ausschließlich über einen **Adapter** (`PlatformAdapter`) mit der Plattform.

Stand: **alle vier Plattformen sind angebunden** (`available: true`). Shopware 6 ist der erste Adapter und hüllt den gewachsenen Code ein. Shopify (Admin GraphQL, `src/server/platform/shopify/`, Abschnitt 6a), Magento 2 (REST + GraphQL für Links, `src/server/platform/magento/`, Abschnitt 12) und OpenMage/Magento 1 (eigenes Modul `Lotse_Connector` mit JSON-API, `src/server/platform/openmage/`, Abschnitt 12a) lesen, schlagen Änderungssets mit exaktem Rückgängig vor, veröffentlichen Landingpages, Kategorie-/Kollektionsinhalte und Produktinhalte, haben einen Shop-Check und einen Lieferanten-Import. Was genau welche Plattform kann, zeigt die Fähigkeitsmatrix in Abschnitt 0. Der Plattformwechsel erfolgt in den Einstellungen (Abschnitt „Shop verbinden“); ruhende Chats werden mit der neuen Plattform neu aufgebaut, Rückgängig-Schritte eines anderen Shops werden nicht ausgeführt. Dieses Dokument ist zugleich die Vorlage für weitere Adapter.

Unverhandelbar auf jeder Plattform:

1. **Die KI liest nur** über einen geschützten Lese-Client mit expliziter Freigabeliste. Kunden, Bestellungen, Warenkörbe, Benutzer/Mitarbeiter, Zahlungsdaten und Zugangsdaten sind nie lesbar, egal was im Prompt steht.
2. **Die KI schreibt nie.** Sie baut ein Änderungsset; der Mensch gibt frei; erst dann schreibt der Server mit dem privilegierten Client. Jede Schreibaktion liefert **exakte** Rückgängig-Schritte, die tatsächlich funktionieren (getestet).
3. **Keine erfundenen Fakten.** Werkzeuge liefern echte Shop-Daten, Preise rechnet der Server, fehlende Angaben werden erfragt.

---

## 0. Fähigkeitsmatrix (Stand nach Shopify, Magento 2 und OpenMage)

Seiten (`PlatformCapabilities`):

| | Shopware 6 | Shopify | Magento 2 | OpenMage (Magento 1) |
|---|---|---|---|---|
| `pageFormat` | `cms` (Einkaufswelt) | `html` (Theme-Vorlage + Lotse-Abschnitt) | `html` (Page-Builder-Inhalt) | `html` (statisches HTML mit begrenztem CSS) |
| Blöcke | alle (`'all'`) inkl. `product-listing`, `sidebar-filter`, `pdp-*`, `reuse` | generische + `theme-main` | nur generische | nur generische; Produkt-Slider werden zu statischen Produktboxen |
| `landingpage` | Einkaufswelt + Landingpage | Shopify-Seite `/pages/<handle>` mit Vorlage `page.lotse-<handle>` | neue CMS-Seite (Store-View oder alle) | neue CMS-Seite (Store-View der Einstellungen oder alle) |
| `product_list` → Ziel `category` | Kategorie-Layout (genau ein `product-listing`) | Kollektionsvorlage: Inhalt vor/nach `theme-main` (Pflicht, genau einmal); alternativ `mode: description` | CMS-Block über der Produktliste (`display_mode` PRODUCTS_AND_PAGE/PAGE), kein `theme-main` | CMS-Block + `landing_page` der Kategorie (`display_mode` PRODUCTS_AND_PAGE/PAGE) |
| `product_detail` → Ziel `product` | Produktseiten-Layout (`pdp-*`-Blöcke) | Produktvorlage für 1 bis 50 Produkte: Inhalt vor/nach `theme-main` (Pflicht) | Produktbeschreibung (ein Produkt) bzw. CMS-Block-Widget unter der Beschreibung (mehrere), nur generische Blöcke | Produktbeschreibung ersetzen (`replace`) oder Inhalt darunter anhängen (`append`, Standard bei mehreren); kein CMS-Block, Magento 1 rendert `{{block}}` in Produkttexten nicht |
| Wiederverwendung (`reuse`) | ja | nein | nein | nein |
| H1 im Inhalt | genau eine | Theme setzt die H1 (Kollektion/Produkt), Landingpage genau eine | Kategorie/Produkt: keine eigene H1 (wird H2), Landingpage genau eine (Theme-Titel ausgeblendet) | wie Magento 2 (`content_heading` leer, wenn der Inhalt eine H1 hat) |
| Bilder beim Veröffentlichen | Medienverwaltung | `stagedUploadsCreate` + `fileCreate`, fremde URLs per `fileCreate` | Produktbilder, URLs, SVG eingebettet; andere Uploads abgelehnt (keine REST-API für CMS-Medien) | Produktbilder, URLs, SVG eingebettet; andere Uploads abgelehnt |
| Live-Prüfung nach dem Schreiben | ja | ja (Vorlage, Zuordnung, Seite) | ja (Executor atomar) | ja (Executor atomar, Rückabwicklung bei Fehler) |

Werkzeuge und Fachbereiche (gleiche Namen, wo die Bedeutung passt; ✓ = vorhanden, – = nicht vorhanden):

| Bereich | Shopware 6 | Shopify | Magento 2 | OpenMage |
|---|---|---|---|---|
| Produkte lesen/ändern (`search_products`, `get_product`, `list_products`, `propose_product_changes`, `propose_new_products`) | ✓ | ✓ | ✓ (Preise nur mit gesetzter Preisbasis brutto/netto) | ✓ (Preisbasis aus `/v1/info`, keine Einstellung nötig) |
| Kategorien/Kollektionen (`propose_category_changes`) | ✓ | ✓ + Kollektionen anlegen/Regeln (`propose_collection`, `preview_collection_rules`, `propose_collection_products`) | ✓ + Zuordnung (`propose_category_products`) | ✓ + Zuordnung (`propose_category_products`) |
| Produktstreams | ✓ | – (automatische Kollektionen statt Streams) | – | – |
| Bilder, Alt-Texte (`propose_product_images`, `propose_alt_texts`, `find_image_gaps`) | ✓ | ✓ | ✓ (Entfernen = ausblenden) | ✓ (Entfernen = ausblenden, Alt-Text je Store-View) |
| SEO-URLs, SEO-Audit (`get_seo_urls`, `propose_seo_urls`, `seo_audit`) | ✓ (+ `suggest_internal_links`) | ✓ | ✓ | ✓ (301 über `save_rewrites_history`, Rückgängig löscht die Weiterleitung) |
| Übersetzungen (`get_translations`, `propose_translations`) | ✓ (Sprachen, + Seitentexte) | ✓ (`list_languages`) | ✓ (Store-Views, `list_store_views`) | ✓ (Store-Views, `list_store_views`; Rückgängig = „Standardwert verwenden“) |
| Varianten (`get_variants`, `propose_variants`) | ✓ | ✓ | ✓ (nur vorhandene Ausprägungen, kein Löschen) | ✓ (vorhandene Kinder: Preis, Bestand, Status) |
| Stapeländerungen (`preview_bulk_filter`, `propose_bulk_product_change`) | ✓ | ✓ | ✓ | ✓ |
| Promotionen (`list_promotions`, `propose_promotion`, `propose_promotion_status`) | ✓ | ✓ (Discounts) | ✓ (Warenkorb-Preisregeln) | ✓ (Warenkorb-Preisregeln, Code fest oder ohne) |
| Stammdaten (Hersteller, Eigenschaften, Steuern …) | ✓ (`propose_product_data` u. a.) | – | Attribute lesen (`list_product_attributes`) | Attribute lesen (`list_product_attributes`) |
| CMS-Seiten lesen/ändern (`list_cms_pages`, `get_cms_page`, `read_page`) | ✓ (lesen) | – | ✓ (+ `propose_cms_page_changes`) | ✓ (+ `propose_cms_page_changes`, Blöcke lesen) |
| Recht, GPSR, Grundpreise, Barrierefreiheit | ✓ | – | – | – |
| `get_brand_signals` (Onboarding aus dem Theme) | ✓ | – | – | – |
| Lieferanten-Import (`read_supplier_file`, `save_import_mapping`, `preview_import`, `propose_import`) | ✓ | ✓ (eigenes Feature `shopify-import`; vorhandene Varianten per SKU/Barcode, neue Varianten bestehender Produkte nur über `propose_variants`) | ✓ (Abgleich per SKU, keine Varianten/Attribute/Kategorien anlegen) | ✓ (`import-openmage`, wie Magento 2) |
| Shop-Check (`run_shop_check`) | ✓ | ✓ (`shopify/checks.ts`) | ✓ (`magento/checks.ts`) | ✓ (`openmage/checks.ts`) |
| Eigene Prüfungen per Chat, Prüfungen an/aus (`create_check`, `set_check_enabled`) | ✓ (`shopware/scan.ts`) | ✓ (`neutralScan` in `checks.ts`) | ✓ (`neutralScan`) | ✓ (`neutralScan`) |
| Kern: Seiten, Styleguide, Bilder-KI, Wissensbasis, Search Console | ✓ | ✓ | ✓ | ✓ |

Die Werkzeugnamen je Plattform sind eindeutig und haben alle einen Anzeigenamen (`TOOL_LABELS`); beides prüft `tests/server/platform/platform.test.ts`.

---

## 1. Dateien

```
src/lib/platforms.ts                 PlatformKind, Einstellungsfelder je Plattform (PLATFORM_SETTINGS), available-Flag
src/server/platform/types.ts         Vertrag: PlatformAdapter, PlatformCapabilities, ShopLookup, PlatformPages …
src/server/platform/index.ts         Register (ADAPTERS), getPlatform(), activePlatform(), undoWithPlatform()
src/server/platform/appliers.ts      applierRegistry<Client>(kind): Executor je Änderungsart
src/server/platform/stub.ts          Vorschau-Adapter für künftige Plattformen (heute von keiner Plattform genutzt), HTML_CAPABILITIES
src/server/platform/shopware/        Shopware-Adapter: index.ts, tools.ts, pages.ts, lookup.ts
src/server/platform/shopify/        Shopify: client.ts, reader.ts, data.ts, lookup.ts, tools.ts, products.ts, catalog.ts, content.ts, ops.ts, upload.ts,
                                     pages.ts, preview.ts, publish.ts, theme.ts (Seiten/Vorlagen), checks.ts (Shop-Check), import.ts (Lieferanten-Import)
src/server/platform/magento/        Magento: client.ts, reader.ts, tools.ts, write.ts, pages.ts, pagebuilder.ts, cms.ts, links.ts, checks.ts, importer.ts … (Abschnitt 12)
src/server/platform/openmage/       OpenMage: client.ts, reader.ts, map.ts, write.ts, catalog.ts, images.ts, promo.ts, variants.ts, bulk.ts, cms.ts, links.ts, lookup.ts,
                                     audit.ts, checks.ts, pages.ts, tools.ts, importer.ts, fake.ts (Test-Fake der Modul-API) … (Abschnitt 12a)
integrations/openmage/               OpenMage-Modul Lotse_Connector (JSON-API /lotse-api/v1), openapi.yaml, README, tests/unit.php + tests/smoke.php
tests/support/openmage-live/          verify.ts: Live-Prüfung aller Änderungsarten mit Rückgängig gegen eine echte OpenMage-Instanz
src/server/page-html.ts              renderPageHtml(): Seitenentwurf → statisches HTML (für HTML-Plattformen); renderPageParts(): geteilt am theme-main-Block
src/server/tools.ts                  Kern-Werkzeuge + Zusammenbau je Session (buildTools, toolNamesFor)
src/server/features/*                Feature-Module; Feature.platforms = ['shopware'] | 'all'
prompts/common/*.md                  Regeln für alle Plattformen (Platzhalter {{shop}}, {{platform}})
prompts/<plattform>/*.md             plattformspezifische Regeln (Shopware: Einkaufswelten; Shopify: Theme-Vorlagen, Kollektionen; Magento: Page Builder, CMS; OpenMage: CMS-Seiten/-Blöcke, Store-Views)
```

Empfohlene Struktur für einen neuen Adapter (Beispiel Shopify):

```
src/server/platform/shopify/
  index.ts        export const shopify: PlatformAdapter = { … }   (ersetzt stubAdapter)
  client.ts       privilegierter Client (Token, Timeout, Retry bei 429), NIE an die KI
  reader.ts       geschützter Lese-Client (Freigabeliste, Bereinigung, Zugriffsprotokoll)
  tools.ts        KI-Werkzeuge (lesen + propose_*)
  changes.ts      Änderungssets bauen + Applier registrieren (applierRegistry)
  pages.ts        PlatformPages (Vorschau-Daten, Veröffentlichen)
  lookup.ts       ShopLookup
  checks.ts       Shop-Prüfungen (registerPlatformCheck)
  (Tests: tests/server/platform/shopify/*.test.ts, gegen einen Fake-HTTP-Server)
prompts/shopify/  Prompt-Dateien (siehe Abschnitt 9)
```

Code-Stil wie im Repo: strenges TypeScript, kompakt, deutsche Kommentare, `import 'server-only'` in Server-Modulen. Kein `npm install`: erlaubt ist nur, was in `package.json` steht (fetch, zod, exceljs, unpdf, mammoth …). Shopify GraphQL und Magento REST gehen mit `fetch`.

---

## 2. Der Vertrag (`src/server/platform/types.ts`)

| Mitglied | Pflicht | Bedeutung |
|---|---|---|
| `kind`, `label` | ja | `'shopify'`, `'Shopify'` |
| `settings` | ja | `PLATFORM_SETTINGS[kind]` aus `src/lib/platforms.ts` |
| `capabilities` | ja | was Seiten können (Abschnitt 6) |
| `promptVars` | ja | `{ shop, platform, htmlElement, shopcheckTools }`, z. B. `{ shop: 'Shopify-Shop', platform: 'Shopify', htmlElement: 'HTML-Abschnitt der Seite', shopcheckTools: '' }` |
| `configured()` | ja | Zugang vollständig: `shopConfigured(kind)` aus `settings.ts` |
| `reconfigure()` | ja | nach dem Speichern der Einstellungen: Client/Token/Caches verwerfen |
| `testConnection()` | ja | „Verbindung testen“: `{ ok, message }`, z. B. „Verbunden mit Shopify (Haus Holm, API 2025-07)“. Fehlertexte ohne Geheimnisse (`redact`) |
| `health()` | ja | Seitenleiste: `{ url, ok, error? }` (günstiger Aufruf, z. B. Shop-Name) |
| `urls()` | ja | `{ admin, storefront, paths }` für Links in der Oberfläche. `paths` sind Vorlagen mit `{id}` (siehe `PlatformPaths`) |
| `openSession(chat)` | ja | je Chat: `{ reader, lookup, storefrontFetch, themeCss }`. `reader` ist der **geschützte** Lese-Client, `chat` der Name im Zugriffsprotokoll |
| `lookup(reader)` | ja | `ShopLookup` über einen Lese-Client (Shop-Check nutzt das je Durchlauf) |
| `toolNames`, `tools(session)` | ja | Werkzeuge der Plattform (Abschnitt 4); `toolNames` muss exakt zu `tools()` passen |
| `features?` | nein | zusätzliche Feature-Module (wie `src/server/features`), z. B. Bilder, Promotionen |
| `loadChecks()` | ja | importiert die Module, die Shop-Prüfungen registrieren (darf leer sein) |
| `scanProducts(reader)` | ja | aktive Produkte als `NeutralProduct` (Name, Beschreibung, Metas, Preis, Streichpreis, Bestand, Bild) für eigene Prüfungen; liest über den geschützten Lese-Client des Durchlaufs, je Durchlauf einmal (Deckel wie die eingebauten Prüfungen). `null` = auf der Plattform nicht lesbar |
| `apply(cs, payload, selected, ctx)` | ja | freigegebenes Änderungsset schreiben (Abschnitt 5). `ctx.progress(done, total, partial)` nach jedem Element/Häppchen aufrufen, `partial = { results, undo }` mit dem bisherigen Stand: die Session sichert ihn gebündelt in `changeset_runs` (SQLite), damit ein Absturz mittendrin kein Rückgängig verliert. Helfer in `changes.ts`: `applyEach` (tickt selbst), `partialTicker(ctx, total, { results, undo })` für eigene Schleifen, `trackedUndo(ctx, total, results?)` für Executor mit mehreren Schreibschritten je Datensatz (Promotion, Veröffentlichung: jeder `push` meldet sofort). Beim nächsten Laden des Chats wird ein unterbrochener Lauf zum Ergebnis `partial`/`failed` mit den gesicherten Rückgängig-Schritten; ohne gesicherten Zwischenstand sagt das Ergebnis ehrlich „unbekannt, im Shop prüfen“ (nie „nichts geschrieben“). Offene Freigaben gelten dann als abgelehnt („Neustart, bitte erneut vorschlagen“) |
| `undo(ops)` | ja | Rückgängig-Schritte dieser Plattform in **umgekehrter** Reihenfolge ausführen, je Schritt `{ ok, error? }` (in Ausführungsreihenfolge, also rückwärts zu `ops`). Die Session merkt sich den Ausgang je Schritt (`undoResults`); ein weiterer Klick wiederholt nur die fehlgeschlagenen Schritte |
| `pages` | ja | Vorschau-Daten, Veröffentlichung (Abschnitt 6) |
| `context` | ja | Kontext-Auswahl der Oberfläche: `categories()`, `products({ term, categoryId })` |
| `storefront` | ja | `{ base(), fetch }` für den Vorschau-Proxy `/shop/…` (iframe der echten Seite) |

`ShopLookup` (plattform-neutrale Lesefunktionen für Kern-Features, immer über den geschützten Lese-Client):

| Methode | Wer nutzt es | Erwartung |
|---|---|---|
| `findProducts({ ids, numbers })` | Wissensbasis | Treffer der IDs, dann der Artikelnummern (SKU); `{ id, number, name }` |
| `findCategories(ids)` | Wissensbasis | `{ id, name }` |
| `getProduct(id)` | Wissensbasis | `{ id, number, name, ean, categoryIds }` (`categoryIds` inkl. Eltern, wenn bekannt) oder `null` |
| `mediaUrl(id)` | `view_image` | öffentliche URL eines Mediums der Plattform |
| `mapUrls(urls, { metas })` | Search Console | Seiten-URL → `PageRef { kind: 'product'\|'category'\|'landing'\|'home', id, name, number?, active, metaTitle?, metaDescription? }` oder `null` |
| `entityPaths(kind, id)` | Search Console | alle Pfade (ohne Domain, ohne führenden `/`) und absoluten URLs der Entität |
| `current(entity, id)` | Search Console | aktueller Datensatz (`entity`: `product`, `category`, `landing-page`), Felder direkt oder unter `translated` |

### Session

`getSession(chatId)` legt je Chat einmal an (`src/server/sessions.ts`):

- `session.platform`: Plattform beim Anlegen. Wird die Plattform in den Einstellungen gewechselt, wird eine **ruhende** Session neu aufgebaut (Verlauf kommt aus der DB); eine laufende Runde behält ihre Plattform bis zum Ende.
- `session.reader`: geschützter Lese-Client der Plattform (`unknown`). Eigene Werkzeuge casten auf ihren Typ, am besten mit Prüfung, z. B. `const r = session.reader as ShopifyReader`.
- `session.lookup`: `ShopLookup`.
- `session.sw`: nur Shopware. Auf anderen Plattformen wirft jeder Zugriff („Dieses Werkzeug gibt es nur für Shopware“).
- `session.requestChange(cs, payload)`: einziger Weg zum Schreiben (Abschnitt 5).
- `session.askUser(q)`: Rückfrage mit Optionen.

---

## 3. Einstellungen (`src/lib/platforms.ts`)

Jede Plattform beschreibt ihre Felder in `PLATFORM_SETTINGS[kind]`:

- `fields`: allgemeine Felder (URL, optionale öffentliche URL, Store-View …).
- `auth`: Zugangsarten; **eine vollständige** genügt (Magento: Integrations-Token **oder** Admin-Benutzer + Passwort). Die Oberfläche zeigt bei mehreren Arten einen Umschalter.
- Feld: `key`, `label`, `secret` (verschlüsselt gespeichert, nie angezeigt, nie an die KI, wird in Fehlermeldungen geschwärzt), `type: 'url'`, `placeholder`, `hint` (`**fett**` erlaubt), `env` (Rückfall-Umgebungsvariable, Präfix `SHOPIFY_`, `MAGENTO_` bzw. `OPENMAGE_`), `optional`.
- `storefrontPaths`: Pfad-Präfixe, die die Storefront ohne `/shop` aufruft (Assets, Widgets, Links), z. B. Shopify `['cdn', 'products', 'collections', 'pages', 'cart', 'search']`, Magento `['static', 'media', 'pub', 'catalog', 'checkout', 'customer/section']`. Erstes Segment oder feste Segmentfolge, ohne Schrägstriche außen. Siehe Abschnitt 8 (Vorschau-Proxy).
- `available`: **auf `true` setzen, wenn der Adapter fertig ist.** Solange `false`: Zugang speicherbar, Shop-Check aus, Verbindungstest gesperrt, Hinweis in der Oberfläche.

Serverseitig: `getSettings().shopify` bzw. `.magento` (Schlüssel → Wert, Geheimnisse entschlüsselt), `platformConfig(kind)`, `shopConfigured(kind)`. Die Oberfläche (`SettingsView`, Abschnitt „Shop verbinden“) rendert die Felder automatisch; der API-Endpunkt nimmt nur Felder laut Beschreibung an. Neue Felder: nur in `platforms.ts` eintragen.

Umgebungsvariablen `SHOPWARE_*`, `SHOPIFY_*`, `MAGENTO_*`, `OPENMAGE_*`, `SHOP_PLATFORM` gelangen nie in den KI-Prozess (`aiEnv`).

---

## 4. Werkzeuge

### Kern (für alle Plattformen, `src/server/tools.ts`)

`ask_user`, `draft_page`, `publish_page`, `get_styleguide`, `save_styleguide`, `view_image`, `import_image`, `create_svg_image`, `generate_image`. Dazu die Kern-Features (`Feature.platforms = 'all'`): Wissensbasis (`add_knowledge`, `search_knowledge`, `get_product_knowledge`, `list_knowledge`, `add_rule`, `list_rules`, `remove_rule`), Search Console (`gsc_performance`, `gsc_opportunities`, `gsc_content_gaps`, `gsc_measure_effect`) und `run_shop_check`. Diese nutzen `session.lookup` und `adapter.pages`, nie die Plattform direkt.

**Bild-Anhänge (Uploads):** Bild-Anhänge aus dem Chat (`POST /api/upload`) werden auf **allen** Plattformen nur lokal vorgemerkt (`data/staging/`, `mediaId: 'staged:<id>'`, Vorschau `/staged/<datei>`); kein Adapter schreibt dabei in den Shop, einen `uploadImage`-Hook gibt es im Vertrag nicht mehr. In die Medienbibliothek kommt ein Bild erst, wenn ein freigegebenes Änderungsset es verwendet (`propose_new_products`, `propose_product_images`, `publish_page`): Shopware `uploadStaged` (einmal je Bild, Zuordnung in `staging_map`), Shopify `uploadStagedImage`, Magento/OpenMage ihre Upload-Wege. Rückgängig entfernt die Zuordnung zum Produkt bzw. die Seite; das hochgeladene Bild bleibt wie ein manuell hochgeladenes in der Medienbibliothek.

### Plattform (Adapter oder eigene Feature-Module)

**Gleiche Namen auf allen Plattformen, wo die Bedeutung passt.** Prompts, Shop-Check-Aufträge (`fixPrompt`) und das Onboarding verweisen auf diese Namen. Argumente möglichst wie bei Shopware (`src/server/platform/shopware/tools.ts`), damit die gemeinsamen Prompts stimmen.

| Name | Art | Mindestumfang |
|---|---|---|
| `search_products` | lesen | `{ term?, categoryId?, limit? }` → `{ total, products: [{ id, name, number, price (formatiert, z. B. „49,00 €“), image, manufacturer? }] }` |
| `get_product` | lesen | `{ id }` → Beschreibung (HTML), Metas, Bilder (URL; KI-Bilder mit `aiGenerated: true`), Kategorien, Eigenschaften/Optionen, Bestand |
| `list_products` | lesen | Massenlesen mit Filtern (`categoryId`, `term`, `minPrice`, `maxPrice`, `active`, `maxStock`, `details`, `limit`, `offset`), Preise brutto als Zahl |
| `search_categories` | lesen | `{ term?, limit? }` (Shopify: Kollektionen) |
| `get_category` | lesen | `{ id }` → Name, Beschreibung, Metas, Unterkategorien |
| `search_media` | lesen | `{ term?, limit? }` → `{ mediaId, url, alt }` |
| `read_page` | lesen | `{ url }` einer Seite des **eigenen** Shops (`assertShopUrl` aus `storefront.ts`), Text, Überschriften, Bilder, Links |
| `get_brand_signals` | lesen | Onboarding: Theme-Farben/Schriften, Logo, echte Texte (siehe `collectSignals` in `styleguide.ts` als Vorbild) |
| `propose_product_changes` | Vorschlag | `{ title, reason, changes: [{ id, fields }] }`, Felder mindestens `name, description, metaTitle, metaDescription, price, listPrice, stock, active`; Preisregeln über `resolvePrice` (`changes.ts`) |
| `propose_new_products` | Vorschlag | wie Shopware: Standard inaktiv, Bestand 0, Preis nie schätzen |
| `propose_category_changes` | Vorschlag | `name, description, metaTitle, metaDescription, active` |
| `propose_product_images` | Vorschlag | Bilder hinzufügen, entfernen, sortieren, Titelbild |
| `propose_alt_texts` | Vorschlag | Alt-Text je Medium (Bild vorher mit `view_image` ansehen) |
| `propose_translations` | Vorschlag | Texte je Sprache/Store-View/Markt |
| `propose_promotion` | Vorschlag | Rabatt/Rabattcode anlegen (Shopify: Discounts, Magento: Warenkorb-Preisregeln) |
| `seo_audit`, `find_image_gaps`, `get_product_details` | lesen | wenn vorhanden, gleiche Namen wie bei Shopware (der Shop-Check-Prompt nennt sie als Beispiele) |

Regeln:

- Name eindeutig je Plattform; Präfix `mcp__shop__` setzt der Kern. `toolNames` exakt wie `tools()` (Test `toolNamesFor`).
- Werkzeuge mit `tool()` aus `@anthropic-ai/claude-agent-sdk`, Handler in `guard()` (`tool-kit.ts`), Ergebnis mit `ok()`/`fail()`. Fehler gehen geschwärzt an die KI.
- Lesen **nur** über `session.reader`/`session.lookup`, nie über den privilegierten Client.
- Beschreibungen auf Deutsch, Ziel und Grenzen klar („Es wird NICHTS geschrieben …“). Keine langen Gedankenstriche in neuen Nutzertexten.
- Shopware-only-Features bleiben `platforms: ['shopware']`. Ein Feature für alle Plattformen (`'all'`) darf nur `session.lookup`, `session.askUser`, `session.requestChange` und Kern-Module nutzen.

---

## 5. Änderungssets und Rückgängig

Ablauf (identisch auf allen Plattformen):

```
Werkzeug propose_* → build…ChangeSet(reader, args)       liest aktuellen Stand über den geschützten Lese-Client
                   → session.requestChange(cs, payload)   Karte im Chat, Mensch wählt Zeilen + gibt frei
Server             → adapter.apply(cs, payload, selected) privilegierter Client, liest Vorher-Werte NEU, schreibt
                   → ApplyResult { results, undo }        je Zeile ok/Fehler + exakte UndoOps
Mensch „Rückgängig“→ undoWithPlatform(undo)               adapter.undo(ops) in umgekehrter Reihenfolge
```

`ChangeSet` (`src/lib/protocol.ts`): `id` (`newId()`), `kind` (Änderungsart, z. B. `products`, `categories`, `page`, `new-products`, `product-media`, `promotion`), `entity`, `title`, `reason`, `items` (je Zeile `entity`, `entityId`, `label`, `field`, `fieldLabel`, `before`, `after` als Anzeige, `afterRaw` als Wert für den Executor, optional `beforeRaw` als Rohwert beim Vorschlag, `html: { before, after }`, `warn[]`), `skipped`, `atomic`, optional `noun`, `applyLabel`, `assets`, `total`/`sample` für Stapel. `platform` setzt die Session automatisch.

**Stale-Write-Guard:** Zwischen Vorschlag und Freigabe kann ein zweiter Chat oder ein Admin-Nutzer denselben Datensatz ändern; der Mensch hätte dann einen Diff freigegeben, der nicht mehr stimmt. Der Executor vergleicht darum den frischen Wert jedes geänderten Feldes mit dem gemerkten `beforeRaw` (`assertFresh`/`normValue` in `changes.ts`, tolerant gegenüber reinen Formatierungsunterschieden) und schreibt bei Abweichung dieses Element nicht („inzwischen geändert, bitte neu vorschlagen“); die übrigen Elemente laufen weiter. Shopware: Produkt-/Kategoriefelder, Stammdaten, Übersetzungen, Produktstreams/-zuordnungen, Stapel je Block (`BulkPlan.prev`; Varianten mit dem frisch geladenen Hauptprodukt, damit geerbte Werte wie beim Vorschlag zählen). Der absolute Bestand (Produktfeld `stock`, Stapel `stock {set}`) ist ebenfalls geschützt: ein Verkauf zwischen Vorschlag und Freigabe lässt dieses Element fehlschlagen; `stock {add}` rechnet relativ auf den dann aktuellen Bestand und bleibt ungeprüft. Shopify (`bulkStale`), Magento (`assertPriceUnchanged`, CMS-Seiten) und OpenMage prüfen gleichwertig. Ohne `beforeRaw` (Altbestand) keine Prüfung.

**Absturzsicherheit:** Vor dem ersten Schreibzugriff schreibt die Session eine Audit-Zeile mit `status: 'started'` und legt in `changeset_runs` (SQLite) einen Lauf an; den Zwischenstand aus `ctx.progress(done, total, { results, undo })` sichert `trackRun` (`sessions.ts`) gebündelt (höchstens alle 250 ms), nach dem gespeicherten Ergebnis wird der Lauf gelöscht. Stirbt der Server mittendrin (Absturz, Deploy), schließt `recoverChat` den Chat beim nächsten Laden ab: ein unterbrochener Lauf wird zum Ergebnis `partial`/`failed` mit den gesicherten Rückgängig-Schritten (Rückgängig funktioniert); ohne gesicherten Zwischenstand sagt die Karte ehrlich „unbekannt, bitte im Shop prüfen“ statt „nichts geschrieben“. Noch offene Freigaben gelten als abgelehnt („Neustart, bitte erneut vorschlagen“), offene Rückfragen der letzten Runde werden markiert, jeweils mit Audit-Zeile (`recoveredFrom` = Zeitpunkt des Vorfalls). Rückgängig merkt sich den Ausgang je Schritt (`undoResults`); ein weiterer Klick wiederholt nur die fehlgeschlagenen Schritte. Solange ein Anwenden oder Rückgängig läuft (`writesInProgress`), lehnt `PATCH /api/settings` einen Wechsel der Shop-Verbindung mit 409 ab; ein vollzogener Wechsel bekommt eine Audit-Zeile `decision: 'changed'` (nur Feldnamen, nie Werte).

- `items[].entity` für Metas **neutral**: `product`, `category`, `landing-page` (sonst misst die Search Console keine Ausgangswerte).
- Höchstens `MAX_ITEMS` (300) Zeilen je Set; Stapel über Gruppen + Stichprobe. Magento und OpenMage brechen bei 5.000 Produkten ab, Shopware und Shopify bei 10.000.
- Vorher-Werte für `before` beim Bauen lesen, Vorher-Werte für `undo` beim Anwenden **erneut** lesen (es kann sich etwas geändert haben).

Executor: `const reg = applierRegistry<ShopifyClient>('shopify'); reg.register('products', (client, cs, payload, selected, ctx) => …)`; `adapter.apply = (cs, p, sel, ctx) => reg.apply(client(), cs, p, sel, ctx)`. Hilfen aus `changes.ts`: `applyEach(cs, selected, fn, ctx)` (schonend parallel mit `WRITE_CONCURRENCY`), `pool`, `errMsg`, `resolvePrice`, `normFaq`, `partialTicker`, `trackedUndo`. Fortschritt und Zwischenstand: `ctx.progress(done, total, { results, undo })` nach jedem Datensatz, auch bei Fehlern.

`UndoOp` (`{ op, entity, id, data?, method?, path?, body?, platform? }`):

| op | Bedeutung | Pflicht |
|---|---|---|
| `patch` | `data` = **genau** die Vorher-Werte der geänderten Felder (auch `null`) | gleiche Felder, die geschrieben wurden |
| `delete` | angelegtes Objekt wieder löschen (`entity`, `id`) | „schon weg“ (404) gilt als Erfolg |
| `create` | gelöschtes Objekt mit `data` wieder anlegen | nur wenn das Löschen Teil der Änderung war |
| `req` | roher Aufruf (`method`, `path`, `body`), z. B. GraphQL-Mutation mit Variablen oder REST-Aufruf | JSON-serialisierbar, ohne Geheimnisse |

Die Bedeutung von `entity`/`path` legt der Adapter fest (Shopify z. B. `path: 'graphql'`, `body: { query, variables }`). UndoOps werden mit dem Chat gespeichert: nur Daten, keine Funktionen, keine Tokens. Ein Undo darf nie mehr verändern als die Änderung selbst. Gehört ein Undo zu einer anderen Plattform als der verbundenen, führt der Kern es nicht aus.

Unklarer Ausgang (Zeitlimit, Verbindungsabbruch, 5xx nach dem Senden): die Mutation kann gewirkt haben. Shopify baut deshalb die Vorher-Werte VOR der Mutation und vermerkt den Rückgängig-Schritt auch im Fehlerfall (`runRecording`); nur bei `userErrors` (nichts geändert) nicht. Beim Anlegen (ID erst in der Antwort) liest `runCreating` die Kandidaten per Titel/Handle vorher und nachher und merkt neue IDs zum Löschen vor. Die Zeile meldet trotzdem den Fehler, der Nutzer kann aber „Rückgängig“ nutzen. Die Allowlist der Rückgängig-Mutationen (`UNDO_QUERIES`) zählt genau die Mutationen auf, die Executoren vermerken; Anlege-Mutationen fehlen bewusst.

---

## 6. Seiten: Fähigkeiten, Vorschau, Veröffentlichen

`PlatformCapabilities`:

```ts
{ pageTypes: ['landingpage', 'product_list'],      // Seitentypen in draft_page
  publishTargets: ['landingpage', 'category'],     // Ziele in publish_page
  blocks: GENERIC_BLOCKS,                          // 'all' nur bei Shopware
  pageFormat: 'html',                              // 'cms' = Shopware-Einkaufswelt
  reuse: false }
```

Ziel ↔ Seitentyp (`PUBLISH_PAGE_TYPE`): `category` ↔ `product_list`, `product` ↔ `product_detail`, `landingpage` ↔ `landingpage`. `HTML_CAPABILITIES` (`stub.ts`) ist der empfohlene Start für neue HTML-Plattformen. Shopify nutzt `SHOPIFY_CAPABILITIES`: alle drei Seitentypen und Ziele, generische Blöcke plus `theme-main`. Magento nutzt `MAGENTO_CAPABILITIES`: alle drei Seitentypen und Ziele, nur generische Blöcke (kein `theme-main`, der Inhalt ist ein Abschnitt, den das Theme einbettet).

`draft_page` prüft den Seitentyp gegen `pageTypes`, jeden Block (nach Pattern-Auflösung) gegen `blocksFor(blocks)` und ruft `validateSpec(spec, { layoutRules: pageFormat === 'cms', themeMain })` auf (`themeMain` = die Plattform erlaubt `theme-main`). Bei `pageFormat: 'html'` entfallen die Einkaufswelt-Regeln „genau ein `product-listing`“ (product_list) bzw. „genau ein `pdp-gallery-buybox`“ (product_detail): eine Kategorie-/Kollektionsseite ist dort nur der **Inhalt** über der Produktliste, die das Theme liefert, und besteht aus generischen Blöcken.

Blöcke (`src/server/cms.ts`, `BLOCKS[k].generic`): generisch sind `text`, `text-hero`, `text-two-column`, `text-three-column`, `image-cover`, `image-text`, `text-image`, `image-two-column`, `custom-html`, `product-slider` und alle Patterns (`type: 'pattern'`, werden zu `custom-html`). Nur Shopware: `product-listing`, `sidebar-filter`, `pdp-*`, `reuse`. Nur HTML-Plattformen mit Theme-Vorlagen (`BLOCKS[k].htmlOnly`, nie bei `blocks: 'all'`): `theme-main` = Platzhalter für den Hauptinhalt des Themes (Produktliste bzw. Galerie/Kaufbox/Beschreibung); genau einmal bei `product_list`/`product_detail`, nie bei `landingpage`. Vorschau: echte Produkte der Kollektion bzw. das Vorschau-Produkt. Qualitäts-Check (`auditSpec(spec, links, { format })`): mit `theme-main` (Shopify) zählt der Block wie `product-listing` bzw. `pdp-gallery-buybox`/`pdp-description-reviews`, das Theme liefert die H1. Bei `format: 'html'` **ohne** `theme-main` (Magento) gelten eigene Regeln: Kategorie-/Produktinhalt ohne eigene H1, Inhalt über der Produktliste höchstens 300 Wörter, Produktbeschreibung mit FAQ, USPs und Einwandbehandlung. `draft_page` lehnt nicht erlaubte Blöcke ab; der Prompt zeigt nur den Katalog der Plattform.

`PlatformPages`:

- `previewData(session, spec)` → `PreviewCtx`: `products` nach ID (`{ name, price (formatiert), img, description?, url? }`) für alle `productIds` der Blöcke, bei `previewCategoryId` bis zu 8 aktive Produkte der Kategorie, `product` für `previewProductId`, `imageUrl(ref)` löst `{ mediaId }` auf (vorgemerkte Bilder `staged:…` → `/staged/<datei>` über `stagedMeta`).
- `prepareDraft?(session, spec)` → `{ spec, links?, errors? }` (Shopware: reuse-Blöcke, technische Links → SEO-URLs). Optional.
- `focus?(session, spec)` → Fokus-Ereignis (Produkt/Kategorie) für die Oberfläche. Optional.
- `publishTool` → `{ description, shape }` (zod-Shape). `target` **muss** `z.enum(capabilities.publishTargets)` sein. Übliche Felder: `categoryId`, `productIds`, `url` (Pfad/Handle der Landingpage), `metaTitle`, `metaDescription`, plattformspezifisch z. B. `storeId`.
- `buildPublish(session, spec, args)` → `{ cs, payload }`. Prüft Pflichtangaben (wirft `Error` mit Klartext für die KI), baut ein Änderungsset `kind: 'page'`, `atomic: true`, Info-Zeilen (`entity: 'info'`: „Neue Seite“, „URL“, „Meta-Title“ Vorher → Nachher) und `assets` (Bilder, die hochgeladen werden).

Veröffentlichen als HTML (Shopify, Magento): im Applier `renderPageHtml(spec, { imageUrl, products, scope })` aus `src/server/page-html.ts`. Vorher alle Bilder auflösen: `staged:` hochladen (Shopify: `stagedUploadsCreate` + `fileCreate`; Magento: nur wenn ein Upload-Weg existiert, sonst in `buildPublish` mit klarer Meldung ablehnen), `{ url }` übernehmen oder importieren. Danach:

- `landingpage`: neue Seite anlegen (Shopify `pageCreate` mit Handle = `url`, Magento `POST /V1/cmsPage` mit `identifier` = `url`, Metas). Undo: `delete` der Seite.
- `category`: Inhalt der Kategorie/Kollektion setzen (Shopify `collectionUpdate.descriptionHtml`, Magento `PUT /V1/categories/{id}` `description` bzw. CMS-Block). Undo: `patch` mit dem vollständigen Vorher-Inhalt.
- Ergebnis `published: { name, storefront: '<öffentliche URL>' | string[], adminUrl?, url? }`; die Oberfläche zeigt daraus Links.

### 6a. Shopify: Seiten und Theme-Vorlagen (umgesetzt)

| Ziel | Was Lotse schreibt | Rückgängig |
|---|---|---|
| `landingpage` | `pageCreate` (Handle = `url`, Inhalt = `renderPageHtml`, Metas als `global.title_tag`/`description_tag`, `templateSuffix lotse-<handle>`), `templates/page.lotse-<handle>.json` (nur Abschnitt „Lotse-Inhalt“, `key: page` = Seiteninhalt) | Seite löschen, Vorlage löschen |
| `category` | Kopie der Kollektionsvorlage des Themes als `templates/collection.lotse-<handle>.json` mit Abschnitten `lotse_before`/`lotse_after` vor/nach dem Hauptabschnitt (`mainSectionKey`), Inhalte in Shop-Metafeldern `lotse.collection-<slug>-before/-after` (multi_line_text_field, ≤ 65.000 Zeichen), `collectionUpdate.templateSuffix` (+ SEO) | Vorlage löschen bzw. alten Inhalt zurück, Metafelder zurück/löschen, alter `templateSuffix` (auch `null`) |
| `category`, `mode: description` | `collectionUpdate.descriptionHtml` (ohne Theme-Schreibrecht) | alte Beschreibung |
| `product` | wie `category` mit `templates/product.lotse-<layout>.json` für 1 bis 50 Produkte (`productUpdate.templateSuffix`) | wie oben je Produkt |

Gemeinsam: `sections/lotse-content.liquid` (Einstellung `key`: `page` = `page.content`, sonst `shop.metafields.lotse[key].value`). Rückgängig löscht den Abschnitt nur, wenn keine Vorlage ihn mehr nutzt (`theme-section`-Schritt). Gespeicherte Rückgängig-Schritte dürfen nur Lotse-Dateien schreiben/löschen (`LOTSE_FILE`). Bilder: vorgemerkte per `stagedUploadsCreate` + `fileCreate`, fremde URLs per `fileCreate` (warten auf `READY`), angelegte Dateien werden beim Rückgängig gelöscht. Jede Veröffentlichung wird nach dem Schreiben geprüft (Vorlage gelesen, Zuordnung, Seite); scheitert ein Schritt, nimmt der Executor alle bisherigen sofort zurück (atomar). Ohne Theme-Schreibrecht (Shopify verlangt `write_themes` und eine Freigabe für `themeFilesUpsert`): Landingpage mit Standardvorlage, Kollektion scheitert mit Hinweis auf `mode: description`.

Storefront: Der lokale Fake rendert kein Liquid. Im echten Shop zeigt `/pages/<handle>` das HTML im Abschnitt „Lotse-Inhalt“ ohne den Seitentitel des Themes (volle Breite); `/collections/<handle>` zeigt Banner, Lotse-Inhalt, Produktraster mit Filtern, Lotse-Inhalt; `/products/<handle>` den Produktbereich des Themes mit Lotse-Inhalt davor/danach. Im Theme-Editor erscheinen die Abschnitte als „Lotse-Inhalt“.

---

## 7. Datenschutz: geschützter Lese-Client

Jede Plattform hat eine **explizite Freigabeliste** (nicht: Sperrliste). Vorbild: `src/server/policy.ts` (`createGuard`, `ReadOnlyShopware` in `shopware.ts`).

Pflicht:

- Lesbar nur Ressourcen der Bereiche `products`, `categories`, `cms`, `media`, `marketing`, `shop` (`ScopeKey`, schaltbar unter Einstellungen → KI-Zugriff; gesperrter Bereich → `DeniedError` mit „ZUGRIFF VERWEIGERT: …“). Die Zuordnung Ressource → Bereich steht im Reader der Plattform.
- **Nie lesbar:** Kunden, Kundensegmente, Bestellungen, Entwurfsbestellungen, Checkouts/Warenkörbe, Rücksendungen, Rechnungen, Gutschriften, Transaktionen, Zahlungen, Geschenkkarten-Codes, Mitarbeiter/Admin-Benutzer, Integrationen/Apps, Tokens, Einstellungen mit Zugangsdaten. Für Filter, Felder und Pfade `DENIED_TERMS` aus `policy.ts` verwenden.
- Antworten bereinigen: `scrubSensitive(data)` (E-Mail, Telefon, Adresse, Namen, Token …). Promotionen nur mit Zählwerten, nie mit Einlösern.
- Jeder Zugriff wird protokolliert: `accessAdd({ chat, op, entity, n, scrubbed, denied })` (`db.ts`), sichtbar unter Einstellungen → Protokolle.
- Die KI bestimmt keine freien Abfragen: Werkzeuge rufen **feste** Lese-Methoden des Readers auf (Shopify: feste GraphQL-Queries im Code, keine Query-Strings von der KI; Magento: feste REST-Pfade, `searchCriteria` nur mit freigegebenen Feldern).
- Der privilegierte Client (Token) bleibt im Adapter: nie in `session`, nie in Werkzeug-Ergebnissen, nie in Fehlermeldungen (`redact`).

Shopify (Admin GraphQL): Root-Felder z. B. `products`, `product`, `productVariants`, `collections`, `collection`, `files`, `pages`, `blogs`/`articles`, `discountNodes` (ohne `customerSelection`-Details), `shop` (nur Name, Domains, Währung), `locations` (nur Namen), `markets`/`shopLocales`. Gesperrt u. a. `customers`, `orders`, `draftOrders`, `abandonedCheckouts`, `giftCards`, `staffMembers`, `apps`, `shop.email`.

Magento (REST, `/rest/<store>/V1/…`): z. B. `GET products`, `products/{sku}`, `products/attributes`, `categories`, `categories/list`, `cmsPage/search`, `cmsBlock/search`, `salesRules/search`, `coupons/search` (ohne Kundenbezug), `store/storeViews`, `store/storeConfigs`. Gesperrt u. a. `customers*`, `orders*`, `invoices*`, `creditmemo*`, `shipment*`, `transactions*`, `carts*`, `guest-carts*`, `integration*`, `admin*`, `tfa*`.

Tests müssen zeigen: Kunden/Bestellungen werden abgewiesen, sensible Felder entfernt, Zugriffe protokolliert.

---

## 8. Shop-Check, Kontext-Auswahl, Vorschau-Proxy

- Prüfungen: `registerPlatformCheck<ShopifyReader>('shopify', { id: 'shopify.meta-description', area: 'SEO', scopes: ['products'], run: async (reader, ctx) => … })` in einem Modul, das `loadChecks()` importiert (Shopify: `shopify/checks.ts`: Metas, dünne Texte, Bilder/Alt-Texte, Bestand mit Weiterverkauf, Preise 0/Vergleichspreis/Spanne, Kollektionen, kaputte interne Links in Beschreibungen, Seiten und Kollektionstexten, fehlende Übersetzungen je Sprache). Je Durchlauf ein frischer Lese-Client (Zwischenspeicher je Durchlauf). Befund: `CheckFinding` mit `fixPrompt`, der die gemeinsamen Werkzeugnamen nutzt. Prüfungen mit `platforms: 'all'` (Search Console) laufen überall.
- Kontext-Auswahl (`/api/categories`, `/api/products`): `CategoryRow { id, name, parentId, active, type, cmsPage }`, `ProductRow { id, name, number, img, cmsPage }`. Anzeige für den Menschen; Shopify: Kollektionen flach (`parentId: null`), Magento: Kategoriebaum.
- Ziel-Hinweis (`src/server/target-hint.ts`, im Kern): Startet ein Chat aus der Kontext-Auswahl, stellt `agent.ts` der Nachricht `targetHint(target, capabilities)` voran. Er richtet sich nur nach den Fähigkeiten: Kategorie → `product_list` mit `previewCategoryId`, wenn `pageTypes` `product_list` und `publishTargets` `category` enthalten (bei `html` mit dem Hinweis „kein product-listing-Block, Produktliste liefert das Theme“), sonst Texte/Daten/SEO oder eine freie Landingpage. Produkt → `product_detail` mit `previewProductId` nur, wenn `pageTypes` `product_detail` und `publishTargets` `product` enthalten; sonst Texte, Daten und SEO (`propose_product_changes`, falls vorhanden) oder eine Landingpage mit dem Produkt (`product-slider`, `productIds`). Der Adapter muss dafür nichts tun, nur `capabilities` korrekt setzen.
- Vorschau-Proxy `/shop/…`: `storefront.base()` (öffentliche Basis-URL) und `storefront.fetch(url, init)`. Pfad-Vorlagen in `urls().paths` (z. B. Shopify `category: '/collections/{id}'`; ist die ID kein Handle, eine passende Vorlage wählen oder in `context` den Handle als ID liefern). Absolute URLs des Shops schreibt `storefrontRewrite` auf `/shop` um; **wurzelrelative** Aufrufe der Seite (`/cdn/shop/…`, `/static/…`, `/collections/…`) leitet `src/proxy.ts` anhand von `PLATFORM_SETTINGS[kind].storefrontPaths` an `/shop` weiter (nur GET). `proxy.ts` kennt die verbundene Plattform nicht und nimmt die Vereinigung aller Listen (`storefrontPrefix`); die `/shop`-Route lässt nur Präfixe der aktiven Plattform durch (Kopfzeile `x-lotse-storefront-prefix`, `isStorefrontPathOf`), alle anderen ergeben 404. Präfixe dürfen keine Lotse-Routen überdecken (`api`, `settings`, `wissen`, `shop`, `staged`; Test in `src/lib/urls.test.ts`).

---

## 9. Prompts

`prompt.ts` liest `prompts/common/*.md` und `prompts/<plattform>/*.md`, sortiert **alle nach Dateinamen** (die Teile greifen ineinander) und füllt `{{shop}}`, `{{platform}}`, `{{htmlElement}}`, `{{shopcheckTools}}` aus `promptVars`. `shopcheckTools` ergänzt im Shop-Check-Abschnitt die Lese-Werkzeuge für das Beheben eines Befunds, mit führendem Leerzeichen und Klammern (Shopware: `' (seo_audit, find_image_gaps, get_product_details …)'`), leer, wenn die Plattform diese optionalen Werkzeuge nicht hat. Nur Werkzeuge nennen, die es wirklich gibt. Gleicher Dateiname im Plattform-Ordner ersetzt die gemeinsame Datei. Danach folgen Pattern-Katalog und der Blockkatalog der Plattform.

Plätze, die eine Plattform füllt (Shopware-Dateien als Vorlage):

| Datei | Inhalt |
|---|---|
| `01-2-seiten.md` | eine Zeile „- LAYOUT/SEITEN: …“ (welche Seiten die Plattform kann) |
| `01-4-shop-verwaltung.md` | eine Zeile „- SHOP-VERWALTUNG: …“ (Fachbereiche) |
| `02-2-freigegebene-daten.md` | eine Zeile „- Du siehst nur freigegebene Shop-Daten: …“ |
| `03-…md` | Fachwissen zum Seitensystem der Plattform (Shopify: Seiten, Kollektionen, Theme-Abschnitte; Magento: CMS-Seiten, CMS-Blöcke, Page Builder) |
| `04-2-bestehende-inhalte.md` | Abschnitt „Bestehende Inhalte einbeziehen (Pflicht)“ mit den Lese-Werkzeugen der Plattform |
| `05-2-recherche.md` | Schritt „2. RECHERCHE …“ |
| `05-4-schreibzugriff-und-seitenaufbau.md` | „Schreibzugriff“ (welche propose_*-Werkzeuge), „Massenänderungen“, „Seitenaufbau-Regeln“ passend zu den Fähigkeiten |
| `08-…` bis `17-…` | Abschnitte der Fachbereiche (Bilder, SEO, Übersetzungen, Promotionen …), nur was es wirklich gibt |

Die gemeinsamen Dateien bleiben plattform-neutral (Test `tests/server/prompt.test.ts` prüft: keine Shopware-Begriffe in `common`, keine offenen Platzhalter). Shopify ersetzt zusätzlich `01-3-faehigkeiten.md` und `07-produkte.md`. Der Ziel-Hinweis der Kontext-Auswahl (`target-hint.ts`) unterscheidet `cms`, `html` mit `theme-main` (Shopify) und `html` ohne (Magento).

---

## 10. Tests

`npm run check` (Typen + ESLint + Tests) muss grün sein. Tests mit `node:test`, ausgeführt mit `tsx --conditions=react-server`; Datenordner je Datei: `process.env.AICB_DATA = fs.mkdtempSync(…)` vor dem ersten dynamischen Import.

- **Fake-HTTP-Server** statt echter Shops: `http.createServer` auf Port 0, Daten als Objekte im Speicher, Anfragen mitschreiben. Vorbilder: `src/server/features/gsc-fake.ts`, `src/server/shopware.test.ts`. Der Fake prüft Token-Header und lehnt gesperrte Ressourcen ab, damit Tests den Guard zeigen.
- Pflichttests je Adapter:
  1. Reader: gesperrte Ressourcen (Kunden, Bestellungen …) → `DeniedError`, sensible Felder entfernt, Bereichs-Schalter wirken, Zugriffsprotokoll.
  2. Werkzeuge: Lese-Werkzeuge liefern das erwartete Format; `toolNames` = Namen von `tools()`.
  3. Änderungssets: bauen (Vorher/Nachher, Warnungen, übersprungene Zeilen), anwenden gegen den Fake, **Rückgängig stellt den Fake-Zustand exakt wieder her** (Deep-Equal vor/nach).
  4. Veröffentlichen: Seite/Kollektion/Kategorie, Bilder-Upload, Undo.
  5. Prompt: `buildBasePrompt('<kind>')` ohne offene Platzhalter, ohne fremde Plattformbegriffe.
  6. Einstellungen: Felder, `configured`, Geheimnisse verschlüsselt und maskiert.
- Bestehende Tests: `tests/server/platform/platform.test.ts` (Register, Fähigkeiten, Werkzeuge je Plattform ohne doppelte Namen und mit Anzeigenamen, Undo-Verteilung, Shop-Checks, `stubAdapter`) und `session.test.ts` (Sessions je Plattform, Seitentypen und Blöcke). Shopify: `shopify/shopify.test.ts` gegen den GraphQL-Fake `tests/support/shopify-fake/`; Magento: `magento/*.test.ts` gegen `magento/fake.ts`.
- Live gegen einen echten Testshop nur mit eigenen Testdaten; jede Änderung mit Rückgängig zurücknehmen und den Ausgangszustand prüfen.

---

## 11. Checkliste für einen neuen Adapter

- [ ] `PLATFORM_SETTINGS[kind]`: Felder vollständig, `storefrontPaths` gegen die echte Storefront geprüft (Live-Vorschau lädt CSS/JS/Bilder), `available: true`.
- [ ] Privilegierter Client: Auth, Timeout, Retry bei 429 (Retry-After), Fehler ohne Geheimnisse.
- [ ] Geschützter Reader mit Freigabeliste, Bereichen, `scrubSensitive`, `accessAdd`, `DeniedError`.
- [ ] `openSession`, `lookup` (alle `ShopLookup`-Methoden).
- [ ] Werkzeuge mit den gemeinsamen Namen (Abschnitt 4), `toolNames` passend.
- [ ] Änderungssets + Applier (`applierRegistry`) für jede `propose_*`-Art, exakte UndoOps, `undo()`.
- [ ] `capabilities` (bestimmen auch den Ziel-Hinweis der Kontext-Auswahl) + `pages` (Vorschau-Daten, `publishTool`, `buildPublish`, Applier `page` mit `renderPageHtml`).
- [ ] `context`, `storefront`, `urls()` mit `paths`, `health()`, `testConnection()`, `reconfigure()`.
- [ ] Shop-Prüfungen über `registerPlatformCheck` + `loadChecks()`.
- [ ] Prompts in `prompts/<kind>/` (Abschnitt 9), `promptVars.shopcheckTools` passend, Vorschau-Hinweis entfernt.
- [ ] Tests (Abschnitt 10), `npm run check` grün.
- [ ] `stubAdapter(...)` in `src/server/platform/<kind>/index.ts` durch den echten Adapter ersetzt (`promptVars` und `paths` übernehmen).

---

## 12. Magento 2 (umgesetzt)

Dateien unter `src/server/platform/magento/`: `client.ts` (privilegierter REST-Client: Integrations-Token oder Admin-Token mit Erneuerung bei 401, Timeout, höchstens 4 gleichzeitige Anfragen, Retry bei 429/503), `criteria.ts` (searchCriteria), `reader.ts` (geschützter Lese-Client: Freigabeliste der REST-Pfade je Bereich, erlaubte Filterfelder je Ressource, Bereinigung auch von `custom_attributes`, Zugriffsprotokoll; Kunden, Kundengruppen, Bestellungen, Rechnungen, Warenkörbe, Integrationen, Admin und Tokens gesperrt), `map.ts` (reine Abbildung), `write.ts` (Ebenen-genaues Schreiben + Undo), `catalog.ts`, `images.ts`, `promo.ts`, `variants.ts`, `bulk.ts`, `audit.ts`, `lookup.ts`, `pages.ts` (Vorschau-Daten), `tools.ts`, `fake.ts` + `magento.test.ts` (Fake der REST-API).

Wichtige Magento-Regeln, die der Adapter umsetzt:

- **Ebenen:** Texte liegen global (Store `all`) oder je Store-View. Haupt-Store-View = Standard-View der Website, zu der die Store-View aus den Einstellungen gehört (`mainStoreCode`: Website → Standard-Gruppe → Standard-View; eine „Standard-Website“ liefert die REST-API nicht). In der Haupt-Store-View schreibt Lotse dort, wo der Wert herkommt (eigener Wert der View → View, geerbt → global) und prüft danach, ob die View den neuen Wert zeigt. In anderen Store-Views (Einstellung `storeCode`, `propose_translations`) wird nur dort geschrieben, auch Alt-Texte (`media-alt`). Rückgängig schreibt die Vorher-Werte der jeweiligen Ebene; `null` entfernt einen Wert der Ebene („Standardwert verwenden“). Ausnahme Kategorien: `name`/`is_active` einer Store-View lassen sich per REST nicht auf „Standardwert verwenden“ zurückstellen (Magento verwirft `null`), Rückgängig setzt dort den globalen Wert. Ausnahme Galerie: label/position/disabled je Store-View kennen per REST kein „Standardwert verwenden“; hat die Arbeits-View eigene Galeriewerte (im Admin in der View gespeichert), zieht `images.ts` (`fixStoreView`) Position, Sichtbarkeit und Titelbild-Rollen dort nach, prüft das Ergebnis und meldet sonst einen Fehler statt Erfolg (Rückgängig: Vorher-Werte der View, Rollen `null` = wieder geerbt).
- **Preise:** Lotse `price` = Verkaufspreis, `listPrice` = Streichpreis. Magento zeigt `price` durchgestrichen, solange `special_price` (mit `special_from_date`/`special_to_date`) aktiv und niedriger ist; `planPrice()` rechnet das um und schreibt `special_from_date` immer mit (Magento setzt es sonst selbst auf heute). Der Executor prüft vor dem Schreiben im Scope des Vorschlags (Store-View der Einstellungen, `assertPriceUnchanged`), ob sich die Preisfelder seit dem Vorschlag geändert haben, schreibt die Preisfelder global und prüft danach, ob die Store-View den neuen Wert zeigt (`assertPriceInView`): bei Preis-Scope „Website“ verdeckt ein Website-Preis den globalen Wert, dann Fehler mit Rückgängig-Schritten statt Erfolg.
- **Brutto/netto:** Magento speichert Katalogpreise je nach `tax/calculation/price_includes_tax` brutto oder (Standard) netto; das ist über REST/GraphQL nicht abfragbar. Darum Einstellung „Preise im Magento-Admin“ (`priceBasis`: `gross`/`net`, Umgebung `MAGENTO_PRICE_BASIS`). Lese-Werkzeuge liefern die Preise unverändert mit `priceBasis` (brutto/netto/unbekannt), Änderungskarten nennen die Basis; ist sie unbekannt, lehnen alle Preis-Vorschläge (Produkt, Stapel, neue Produkte, Varianten) ab.
- **Bestand:** nur mit Magento Inventory und genau einer aktiven Quelle (`/V1/inventory/source-items`); Rückgängig löscht auch Lagerbestände angelegter Produkte (MSI räumt sie nicht selbst auf).
- **Bilder:** Medien-ID `mg-<produktId>-<eintragId>`. Entfernen = ausblenden (`disabled`), damit Rückgängig exakt ist; Titelbild = Rollen `image`/`small_image`/`thumbnail`, die Rollen werden beim Rückgängig als Produktattribute exakt zurückgesetzt. Alt-Text = Galerie-Label.
- **URL-Schlüssel:** `save_rewrites_history` legt eine 301-Weiterleitung an. Rückgängig stellt den alten Schlüssel wieder her; die zwischenzeitliche URL bleibt als 301 auf die alte bestehen (Magento hat keine REST-API für URL-Rewrites).
- **Promotionen:** Warenkorb-Preisregeln mit genau einem Rabatt; Kundengruppen (alle) setzt nur der Executor, die KI liest keine Kundengruppen. Leere Datumsfelder werden mit `""` gelöscht.
- **Varianten:** neue Einzelprodukte für vorhandene Ausprägungen anlegen und verknüpfen; Löschen von Varianten bietet Lotse nicht an.
- **Seiten** (`pages.ts`, `pagebuilder.ts`): Fähigkeiten `MAGENTO_CAPABILITIES` (landingpage, product_list, product_detail; generische Blöcke, `html`). Inhalte im Page-Builder-Format: eine Zeile mit html-Elementen (HTML-kodiert, `{{` entschärft, CSS je Seite begrenzt) und für `product-slider` dem Element „Produkte“ (Widget `ProductsList` mit SKU-Bedingung: Live-Preise, Bestand, Warenkorb). `landingpage` = neue CMS-Seite (`POST /<store>/V1/cmsPage`, Store-View der Einstellungen oder `allStoreViews`), hat der Inhalt eine H1, wird der Seitentitel des Themes per CSS (`.cms-<identifier> .page-title-wrapper`) ausgeblendet; `category` = neuer CMS-Block + `display_mode` (PRODUCTS_AND_PAGE/PAGE) + `landing_page` (+ Metas) über `writeScoped`; `product` = Beschreibung ersetzen (ein Produkt) oder CMS-Block als Widget unter die Beschreibung hängen (mehrere). H1 im Kategorie-/Produktinhalt wird H2. Bilder: Produktbilder (`mg-…`), URLs, vorgemerkte SVG eingebettet (data-URI); andere Uploads lehnt `buildPublish` ab (keine REST-API für CMS-Medien). Executor atomar: bei Fehler sofort zurücknehmen. Rückgängig löscht Seite/Block und stellt Kategorie/Beschreibungen exakt her. Live gegen Mage-OS 2.4.9 geprüft.
- **CMS** (`cms.ts`): `list_cms_pages`, `get_cms_page`, `read_page`, `propose_cms_page_changes`. Magento speichert eine Seite immer ganz und bildet einen fehlenden `identifier` aus dem Titel neu: PUT sendet darum stets den vollständigen Stand, Rückgängig ebenso. Blöcke nur lesen (Speichern per REST setzt die Store-Zuordnung neu).
- **Links** (`links.ts`): interne Links über GraphQL `route` prüfen (fehlt, Produkt deaktiviert/unsichtbar, Kategorie inaktiv, Weiterleitung → direkt verlinken); in `prepareDraft`, `buildPublish` und im Shop-Check.
- **Shop-Check** (`checks.ts`, `checks-rules.ts`): Metas, Titel-Länge/Dubletten, dünne Texte, Bilder/Alt-Texte, Bestand 0 bei „auf Lager“ (MSI), Preis 0, Sonderpreis nicht unter Preis, Links in Beschreibungen und CMS-Seiten (ein Link-Cache je Durchlauf: jeder Pfad wird über alle Produkte und Seiten nur einmal aufgelöst), Kategorie-Metas/-Texte, Übersetzungen je Store-View mit anderer Locale; `fixPrompt` nennt Magento-Werkzeuge. `find_image_gaps` blättert mit Seitengröße = `limit` und liefert alle Treffer der Seite; `list_products` filtert Preisspanne (serverseitig vorgefiltert) und `maxStock` je Seite und sagt das im Ergebnis (`note`).
- **Import** (`importer.ts`): Datei/Zuordnung wie `features/import.ts` (`supplierFileTools`), Abgleich per SKU, neue Produkte als Entwurf (`createProduct`), Updates nur geänderter Felder (`writeScoped`), Preise in der Preisbasis des Shops, Bestand/Kategorien/Bilder, Gruppen + Stichprobe, Schreiben in Blöcken mit Fortschritt, Rückgängig exakt. Keine Varianten, keine neuen Attribute/Auswahlwerte, keine Kategorien.
- **Noch offen:** `get_brand_signals` und Theme-CSS der Vorschau (Vorschau nutzt die Styleguide-Variablen), Übersetzen von CMS-Inhalten.

---

## 12a. OpenMage (Magento 1): Modul + Adapter

OpenMage (Magento 1 LTS) hat keine brauchbare Schnittstelle für CMS-Seiten/-Blöcke, und die alten APIs (REST mit OAuth 1.0a, SOAP/XML-RPC) sind umständlich. Darum liegt im Repository ein eigenes OpenMage-Modul **`Lotse_Connector`** unter `integrations/openmage/` (README mit Installation, Konfiguration, Sicherheit, Endpunkt-Referenz und curl-Beispielen; `openapi.yaml` als Vertrag; `package.sh` baut ein Zip; `tests/unit.php` für die reine Logik, `tests/smoke.php` für den vollen Lese-, Schreib- und Rückgängig-Zyklus gegen eine laufende Instanz). Der Adapter `src/server/platform/openmage/` spricht **ausschließlich** mit dieser API (Modul ab 1.1.0: `GET /v1/products?fields=…&with=images` liefert Listen mit Zusatzattributen und Bildern für Audit und Shop-Check; ab 1.2.0: `?term=` sucht in Name ODER SKU bzw. Titel ODER identifier in EINER Abfrage, damit `list_products`/`search_products`/`list_cms_pages` mit Suchbegriff exakt paginieren; bei älteren Modulen fällt der Adapter auf zwei zusammengeführte Abfragen zurück. `PATCH /v1/categories/{id}` meldet wie bei Produkten `_write.rewrites_added`, damit Rückgängig eines Kategorie-URL-Schlüssels die 301-Historie löscht. Produkt-Referenzen der Werkzeuge: `id:12`/`sku:4711` sind eindeutig, eine reine Zahl wird als ID UND SKU geprüft und bei zwei verschiedenen Treffern als „Mehrdeutig“ abgewiesen).

Das Modul gibt Lotse eine zustandslose, token-gesicherte JSON-API unter `/lotse-api/v1/…` (Bearer-Token, verschlüsselt gespeichert, Konstantzeit-Vergleich, optionale IP-Freigabeliste; keine Session, keine Cookies). Store-Scope über `?store=<code>` oder `X-Lotse-Store`; im Store-View-Scope setzt `null` ein Attribut auf „Standardwert verwenden“, `store_overrides` nennt die Attribute mit eigenem Wert in der View (Grundlage für exaktes Rückgängig). Lesbar: Info, Produkte (Liste mit Filtern/Sortierung/Paginierung, Detail mit allen Attributen, Bestand, Kategorien, Bildern, Configurable-Achsen und -Kindern), Produktattribute mit Optionen, Kategorien (Baum, Detail), CMS-Seiten/-Blöcke, Warenkorb-Preisregeln (Nutzung nur als Zähler) und URL-Rewrites. Schreibbar (nur für den privilegierten Client): Produktattribute je Scope, Produkt anlegen/löschen, Bestand, Kategoriezuordnung mit Position, Bilder (Upload, Label, Position, Rollen, ausblenden/löschen), Kategorie-Attribute, CMS-Seiten/-Blöcke, Preisregeln inkl. Gutschein und Bedingungen, eigene URL-Rewrites. Jede Schreibantwort enthält den vollständigen neuen Stand; Indexer laufen wie im Admin.

Privatsphäre durch Nichtexistenz: Routen für Kunden, Bestellungen, Warenkörbe, Rechnungen, Benutzer, API-Benutzer, Zahlungen und Newsletter gibt es im Modul nicht (404); `tests/unit.php` prüft die Routentabelle darauf. Zusätzlich hält der Adapter die Regeln aus Abschnitt 12: `reader.ts` erlaubt nur die GET-Pfade der `ALLOW`-Liste (plus Query-Schlüssel je Pfad), verweigert alles mit `DENIED_TERMS` im Pfad, scrubbt Antworten (`scrubSensitive`) und protokolliert jeden Zugriff; `fake.ts` bildet die Modul-API im Speicher nach, `openmage.test.ts`/`openmage-pages.test.ts` prüfen jede Änderungsart mit Rückgängig per Snapshot-Vergleich dagegen.

Einstellungen: Basis-URL (`OPENMAGE_URL`), öffentliche URL, Token (`OPENMAGE_TOKEN`, geheim) und optional ein Store-Code (`OPENMAGE_STORE_CODE`, Standard: Standard-Store-View des Shops aus `/v1/info`). Die Preisbasis (brutto/netto) kommt aus `/v1/info.price_includes_tax`, es gibt keine eigene Einstellung. Dateien: `client.ts` (Bearer, Timeout, höchstens 4 parallele Anfragen, Retry bei 429/503, **schreibende Aufrufe nacheinander**: parallele Produkt-Saves lösen in OpenMage Deadlocks im Indexer aus), `map.ts` (`mrec()` formt OpenMage-Datensätze so um, dass die reinen Preis-/Audit-Helfer aus `magento/map.ts` wiederverwendet werden: `priceState`, `planPrice`, `priceUndo`), `write.ts` (`writeScoped`: in der Standard-Store-View werden geerbte Werte global geschrieben, eigene Store-Werte in der View; global geschriebene Werte, die ein Store-Wert verdeckt, werden auch dort gesetzt; Rückgängig schreibt die Vorher-Werte bzw. `null` = „Standardwert verwenden“ und löscht `_write.rewrites_added`), `catalog.ts`, `images.ts`, `promo.ts`, `variants.ts`, `bulk.ts`, `cms.ts`, `pages.ts`, `checks.ts`, `importer.ts`.

Seiten: Landingpage = neue CMS-Seite (`POST /v1/cms/pages`, Store-View der Einstellungen oder `admin` für alle; `content_heading` leer, wenn der Inhalt eine H1 hat). Kategorie = neuer CMS-Block + `landing_page`/`display_mode` der Kategorie (PRODUCTS_AND_PAGE oder PAGE), Metas optional. Produkt = Beschreibung ersetzen (`mode: replace`, Standard bei einem Produkt) oder den Inhalt unter die bisherige Beschreibung hängen (`append`, Standard bei mehreren); **kein CMS-Block über `{{block}}`**, weil der Katalog-Filter von Magento 1 in Produkttexten nur `skin`/`media`/`store` kennt (die Direktive stünde als Text auf der Seite, live geprüft). Direktiven im eigenen HTML werden entschärft, Produkt-Slider zu statischen Produktboxen mit echten Daten. Der Executor ist atomar: schlägt ein Schritt fehl, nimmt er die bisherigen zurück.

Besonderheiten aus der Live-Prüfung (`tests/support/openmage-live/verify.ts`, 174 Prüfungen gegen OpenMage 20.18 mit Modul 1.2.0; der Vergleichszustand umfasst den globalen Scope und jede Store-View, auch die Standard-View, die Kunden sehen): `status` hat in der Standard-Store-View oft einen eigenen Wert, Lotse schreibt dann dort (so sehen es Kunde und Admin); `""` leert einen Wert global (OpenMage liefert danach `null`); System-Rewrites legt OpenMage bei Kategoriezuordnungen mit neuer ID neu an; Deadlocks (MySQL 1213) bei PUT/PATCH/DELETE wiederholt das Modul bis zu dreimal. Das Theme hängt an jeden Seitentitel `design/head/title_suffix` (z. B. „ | Haus Holm“) bzw. `title_prefix` an; `/v1/info` liefert beides je Store-View (Modul ab 1.1.2), `stripTitleAffixes` (`map.ts`) entfernt ein von der KI selbst angehängtes Suffix aus Meta-Titles, Übersetzungen und CMS-Seitentiteln, sonst stünde die Marke doppelt im Browser-Tab („… | Haus Holm | Haus Holm“, in der E2E-Prüfung beobachtet).

Store-Scope-Saves in Magento 1 kopieren jedes geladene Attribut als Store-Wert (die View erbt danach nichts mehr, Rückgängig wäre nicht exakt, und ein später global geänderter Wert käme nicht mehr an). Das Modul speichert darum nie ein Produkt im Store-Scope (Attribute über `updateAttributes`, Galerie-Zeilen und Bildrollen direkt, Modul ab 1.1.1) und setzt beim Kategorie-Save alle nicht angefragten, geerbten Attribute wie der Admin auf „Standardwert verwenden“; `store_overrides` wächst genau um die geschriebenen Codes (`tests/smoke.php` und `verify.ts` prüfen das). `disabled` einer Galerie-Zeile ist je View ein fester Wert: hat die Arbeits-View eigene Zeilen oder eigene Rollen-Attribute, zieht `images.ts` (`fixStoreView`) Position, Sichtbarkeit und Titelbild-Rollen dort nach (Rückgängig: Vorher-Werte der Zeile, Rollen über `writeStore` mit `null` = Standardwert) und meldet einen Fehler statt Erfolg, wenn die View den Stand nicht übernimmt. Die Preisprüfung vor dem Schreiben (`assertPriceUnchanged`) vergleicht im Scope des Vorschlags (Store-View der Einstellungen), nicht im globalen Datensatz, damit Website-Preise keine falsche Meldung „inzwischen geändert“ auslösen.

Capability-Hinweis: `GET /v1/products` liefert mit `with=images` die Galerie je Eintrag; der Reader erlaubt das unabhängig vom Medien-Scope, damit `list_products`/`seo_audit` Bildbefunde (fehlendes Bild, fehlender Alt-Text) auch ohne Medien-Werkzeuge melden können. Das ist bewusst so und entspricht dem Magento-2-Adapter; die Bilddateien selbst sieht die KI nur über `view_image`.

---

## 13. Offene Punkte

Shopify:

- Alle Prüfungen liefen gegen den lokalen Fake (`tests/support/shopify-fake/`), nicht gegen einen echten Shop. Nicht gegen Shopify geprüft: Verhalten von Wildcards wie `templates/product.*.json`, `templates/customers/*.json`, `templates/metaobject/*.json` in `OnlineStoreTheme.files(filenames:)` (der Fake wertet sie als „kein Treffer“) und 250 als Seitengröße.
- Lotse-Vorlagen, die vor der Einstellung `base` in `sections/lotse-content.liquid` veröffentlicht wurden, haben keine gespeicherte Basisvorlage; sie wird nur über gleichen Inhalt mit einer Theme-Vorlage gefunden. Hat sich die Theme-Vorlage seitdem geändert, gilt die Basis als unbekannt und eine gemischte Auswahl wird abgelehnt (bewusst vorsichtig).
- Slugs über 40 Zeichen bekommen gehashte Metafeld-Schlüssel; alte `lotse.<key>`-Metafelder früherer Veröffentlichungen bleiben verwaist (harmlos).
- Import: Gehören die gefundenen Varianten einer Familie zu mehreren Produkten, gibt es keine Elternzeile; Produktfelder werden dann nur übernommen, wenn alle Zeilen übereinstimmen.

Magento:

- Die Prüfung auf belegte `identifier` ist bewusst vorsichtig und blockiert auch Kennungen, die nur in anderen Store-Views vorkommen (`cmsPage/search` liefert keine `store_id`).
- Vorschau: Produkt-Slider erscheinen in der Lotse-Vorschau als Lotse-Produktboxen, im Shop als Magento-Widget; Änderungskarte und Prompt weisen darauf hin.
- Auf klassischen CMS-Seiten (ohne Page Builder) werden neue `{{…}}`-Direktiven der KI jetzt ebenfalls entschärft; vorhandene bleiben erhalten.
- `get_brand_signals`, Theme-CSS der Vorschau und das Übersetzen von CMS-Inhalten fehlen noch (siehe Abschnitt 12).

Beide: `get_brand_signals` (Onboarding aus dem Theme) gibt es bisher nur für Shopware; die Vorschau nutzt auf Shopify und Magento die Styleguide-Variablen statt des Theme-CSS.
