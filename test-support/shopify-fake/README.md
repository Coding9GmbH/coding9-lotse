# Shopify Admin GraphQL – lokaler Fake

Ein lokaler Ersatz für die **Shopify Admin GraphQL API (Version `2026-10`)**. Damit lässt sich eine
Shopify-Integration ohne echten Shop testen. Er hat keine Abhängigkeiten: Parser, Validierung und
Executor sind in `graphql.ts` selbst geschrieben, denn im Repo gibt es kein `graphql`-Paket.

> **Wichtig:** Der Fake ersetzt keinen Test gegen einen echten Shop oder Development-Store. Er bildet
> die Antwortformate und das typische Verhalten nach (Fehler, `userErrors`, Paginierung, Kosten).
> Die Geschäftslogik von Shopify bildet er nur in Teilen nach. Unter „Abweichungen“ steht, was fehlt.

## Start

```bash
# als Server (Standard-Port 3601)
npx tsx test-support/shopify-fake/server.ts --port 3601
npm run shopify-fake            # dasselbe

# Optionen
--host 127.0.0.1  --token shpat_…  --no-seed  --scopes read_products,write_products
--media-immediate  --auto-publish  --quiet
```

Endpoint: `POST http://127.0.0.1:3601/admin/api/2026-10/graphql.json`
Header: `X-Shopify-Access-Token: shpat_fake_haus_holm_00000000000000000000`

Einbindung in `node:test`:

```ts
import { startFakeShopify } from '../test-support/shopify-fake/server';

const fake = await startFakeShopify({ port: 0 });   // { url, graphqlUrl, token, state, close, … }
const res = await fake.graphql('{ shop { name } }'); // Hilfsfunktion; normaler fetch geht auch
fake.state.findProductByHandle('vase-kiesel');       // Zustand direkt prüfen
fake.failNext({ status: 429, retryAfter: 2 });       // nächste Anfrage scheitert
fake.throttle.currentlyAvailable = 0;                // nächste Anfrage → THROTTLED
fake.reset();                                         // Seed wiederherstellen
await fake.close();
```

`startFakeShopify(options)`:

| Option | Standard | Wirkung |
|---|---|---|
| `port` | `0` (freier Port) | |
| `token` | `shpat_fake_haus_holm_…` | erwarteter `X-Shopify-Access-Token` |
| `seed` | `true` | Demo-Daten „Haus Holm“ |
| `accessScopes` | alles außer Kunden/Bestellungen | fehlende Scopes ergeben `ACCESS_DENIED` |
| `mediaProcessing` | `'async'` | neue Medien sind in der erzeugenden Anfrage `UPLOADED` (`image: null`) und ab der nächsten Anfrage `READY` |
| `themeWriteAccess` | `'all'` | `'unpublished-only'` simuliert eine fehlende Theme-Exemption für das Live-Theme |
| `autoPublish` | `false` | per API angelegte Produkte und Kollektionen sind nicht im Online Store veröffentlicht |
| `throttle` | `{ maximumAvailable: 2000, restoreRate: 100 }` | Leaky Bucket |

Steuer-Endpunkte (ohne Auth, nur für lokale Tests): `GET /__fake/state`, `GET /__fake/requests`,
`POST /__fake/reset`, `POST /__fake/fail` (`{status, retryAfter, times, body}`),
`POST /__fake/throttle` (`{currentlyAvailable, maximumAvailable, restoreRate}`), `GET /__fake/health`.

## Seed „Haus Holm“

* Shop „Haus Holm“, EUR, `primaryDomain.url = https://haus-holm.myshopify.com`, Zeitzone Europe/Berlin
* Locales: `de` (primär), `en` (veröffentlicht); vorhandene en-Übersetzung des Titels von Becher „Morgen“
* Produkte:
  * Vase „Kiesel“ 49,00 €, Handle `vase-kiesel`, 1 Bild **ohne Alt-Text**, Metafeld `custom.material`
  * Becher „Morgen“ 18,00 €, Optionen Farbe × Größe mit 4 Varianten (eine mit Vergleichspreis 22,00 €), 2 Bilder, SEO gesetzt
  * Plaid „Düne“ 89,00 €, Handle `plaid-duene`, ohne Bild und ohne SEO
* Kollektionen: „Wohnaccessoires“ (manuell, alle 3 Produkte), „Keramik“ (Smart Collection, `TAG EQUALS Keramik`)
* Seite „Über uns“ (`ueber-uns`)
* Themes: „Dawn“ (`MAIN`) mit `layout/theme.liquid`, `templates/{index,product,collection,page}.json`, passenden
  `sections/*.liquid` (mit `{% schema %}`), `config/*`, `locales/*`; dazu eine Kopie „Dawn (Entwurf)“ (`UNPUBLISHED`)
* Location „Lager Hamburg“, Publication „Online Store“

IDs sind stabil (z. B. `gid://shopify/Product/9100000000001`), solange nicht neu angelegt wird.

## Abdeckung

**Protokoll**
* `POST /admin/api/{version}/graphql.json` mit JSON- oder `application/graphql`-Body. Die Versionen 2025-10 bis
  2026-10 und `unstable` werden direkt bedient; ältere fallen auf die älteste unterstützte Version zurück
  (Header `X-Shopify-API-Version`).
* Auth über `X-Shopify-Access-Token`, sonst HTTP 401 mit Shopifys Fehlertext. Auf Anforderung (`failNext`)
  gibt es 401/402/403/404/423/429/5xx, bei 429 mit `Retry-After`.
* `extensions.cost` mit `requestedQueryCost`, `actualQueryCost` und `throttleStatus`. Außerdem `THROTTLED`
  und `MAX_COST_EXCEEDED` (Grenze 1000).
* `extensions.search`-Warnungen für unbekannte Suchfelder.
* Validierung wie bei graphql-ruby: unbekannte Felder und Argumente, fehlende Pflichtargumente, fehlende oder
  unzulässige Selektionen, nicht deklarierte oder ungenutzte Variablen, Typ- und Nullability-Konflikte.
  **Unbekannte Felder in Input-Variablen** führen wie bei Shopify zu einem *Top-Level-Fehler*
  (`Variable $x … was provided invalid value for foo (Field is not defined on …)` mit `extensions.problems`).
  Semantische Fehler wie ein leerer Titel oder ein belegter Handle stehen in den `userErrors` der Mutation.
* Ausführung: Aliase, Fragmente, Inline-Fragmente, `@include`/`@skip`, Interfaces und Unions, Null-Propagation,
  mehrere Operationen mit `operationName`, Mutationen strikt sequenziell.
* Connections mit `first`/`after`/`last`/`before`/`reverse`, `edges { cursor node }`, `nodes` und `pageInfo`.
  Fehlen `first` und `last`, kommt `you must provide one of first or last`.
* Suchsyntax: Freitext, `feld:wert`, `feld:"mit Leerzeichen"`, `präfix*`, `-negation`, `NOT`, `AND`/`OR`,
  Klammern, Vergleiche (`id:>…`, `updated_at:<2026-01-01`), Kommalisten (`status:active,draft`)
* Skalare: `Money` als `"49.00"`, `Decimal` als `"49.0"`, `DateTime` ohne Millisekunden, `UnsignedInt64` als String

**Ressourcen**

| Bereich | Queries | Mutations |
|---|---|---|
| Shop | `shop` (inkl. `primaryDomain`, `currencyCode`, Metafelder), `shopLocales`, `currentAppInstallation.accessScopes`, `locations`, `publications`, `node`/`nodes`, `job` | – |
| Produkte | `products(query, sortKey, reverse)`, `product`, `productByIdentifier`, `productsCount`, `productVariants`, `productVariant` mit Titel, Handle, `descriptionHtml`, Status, Vendor, Typ, Tags, `seo`, `options`/`optionValues`, `variants` (Preis, Vergleichspreis, SKU, Barcode, Bestand, `selectedOptions`, `inventoryItem`), `media`/`featuredMedia`/`images`, `collections`, `priceRangeV2`, Metafelder, `translations` | `productCreate` (`product:` und das veraltete `input:`), `productUpdate` (inkl. `seo`, `descriptionHtml`, `collectionsToJoin/Leave`, `metafields`, `redirectNewHandle`, `media`), `productDelete`, `productVariantsBulkUpdate` (Preis, Vergleichspreis, Barcode, `inventoryItem.sku`, `optionValues`, atomar oder `allowPartialUpdates`), `productVariantsBulkCreate`, `productVariantsBulkDelete`, `publishablePublish`/`Unpublish` |
| Medien und Dateien | `files(query)`, `MediaImage { image { url altText width height } status preview mediaErrors }` | `stagedUploadsCreate` (PUT und POST/multipart an den Fake), `productCreateMedia`, `productDeleteMedia`, `productReorderMedia`, `fileCreate`, `fileUpdate` (Alt-Text, Dateiname, `originalSource`, Referenzen), `fileDelete` |
| Kollektionen | `collections(query)`, `collection`, `collectionByHandle`, `collectionsCount`, `ruleSet`, `products` (Sortierung nach `sortOrder`), `hasProduct` | `collectionCreate` (manuell oder smart), `collectionUpdate`, `collectionDelete`, `collectionAddProducts`, `collectionRemoveProducts`, `collectionReorderProducts` (nur bei `sortOrder: MANUAL`). Smart-Regeln für TITLE, TYPE, VENDOR, TAG, VARIANT_TITLE, VARIANT_PRICE, VARIANT_COMPARE_AT_PRICE, VARIANT_INVENTORY und IS_PRICE_REDUCED werden ausgewertet. |
| Seiten | `pages(query)`, `page`, `pagesCount` (Titel, Handle, Body, `bodySummary`, `isPublished`, `publishedAt`, `templateSuffix`) | `pageCreate`, `pageUpdate` (inkl. `redirectNewHandle`), `pageDelete` |
| Metafelder | `metafield(namespace,key)` / `metafield(key:"ns.key")` / `metafields(namespace, keys)` auf Shop, Produkt, Variante, Kollektion, Seite und Rabatt; `jsonValue`, `compareDigest` | `metafieldsSet` (atomar, max. 25, Typ- und Wertprüfung für gängige Typen inkl. `list.*` und Referenzen, `compareDigest`), `metafieldsDelete` |
| Übersetzungen | `translatableResources(resourceType)` für PRODUCT, COLLECTION, ONLINE_STORE_PAGE, METAFIELD, PRODUCT_OPTION und PRODUCT_OPTION_VALUE; `translatableResource`, `translatableResourcesByIds`, `translatableContent` mit `digest` (SHA-256), `translations(locale, outdated)` mit `outdated`-Erkennung | `translationsRegister` (prüft Digest, Locale und Key), `translationsRemove` |
| Rabatte | `codeDiscountNodes(query)`, `codeDiscountNode`, `codeDiscountNodeByCode`: `DiscountCodeBasic` mit `customerGets` (Prozent oder Betrag; alle Artikel, Produkte, Varianten oder Kollektionen), `minimumRequirement`, `context`/`customerSelection`, `startsAt`/`endsAt`, `status`, `usageLimit`, `appliesOncePerCustomer`, `combinesWith`, `codes`, `summary` | `discountCodeBasicCreate`, `discountCodeBasicUpdate`, `discountCodeDelete`, `discountCodeActivate`, `discountCodeDeactivate`. Prozentwerte müssen zwischen 0 und 1 liegen (`VALUE_OUTSIDE_RANGE`, wie bei Shopify). |
| Themes | `themes(roles, names)`, `theme`, `files(filenames)` mit Wildcards wie `templates/*.json`, Body als TEXT oder BASE64, `checksumMd5`, `size`, `userErrors` mit NOT_FOUND | `themeFilesUpsert` (TEXT, BASE64, URL nur aus eigenen Staged Uploads; max. 50 Dateien) prüft JSON-Templates (`sections`/`order`; jede Section muss als `sections/<type>.liquid` existieren, auch im selben Batch) und das `{% schema %}`-JSON; `themeFilesDelete` schützt Pflichtdateien |
| Redirects | `urlRedirects(query)`, `urlRedirect` | `urlRedirectCreate`, `urlRedirectUpdate`, `urlRedirectDelete` |
| Bulk | `currentBulkOperation`, `bulkOperation`, `node` | `bulkOperationRunQuery` (führt die Query aus und liefert JSONL mit `__parentId` unter `/__fake/bulk/<id>.jsonl`), `bulkOperationCancel` |
| Datenschutz | `customers`, `customer`, `orders`, `order`, `draftOrders`, `abandonedCheckouts`, `customerSegmentMembers`, `*Count` → **`ACCESS_DENIED`** (`Access denied for customers field. Required access: \`read_customers\` access scope.`) | `customerCreate`/`customerUpdate` → `ACCESS_DENIED` |

## Abweichungen von echtem Shopify

Diese Unterschiede sind bekannt, und es gibt sicher weitere:

* **Teilschema:** Es gibt nur die oben genannten Typen und Felder. Ein Feld, das bei Shopify existiert, hier
  aber fehlt, liefert `undefinedField`. Liegt so ein Fehler am Fake, muss der Fake erweitert werden; die
  Integration ist dann nicht schuld. **Introspection** (`__schema`, `__type`) wird nicht unterstützt.
* **Validierung ist eine Teilmenge** von graphql-ruby: Feld-Merging-Konflikte (`fieldConflict`), Tiefen- und
  Komplexitätslimits außer den Kosten, Fragment-Zyklen und Direktiv-Positionen werden nicht geprüft.
  Fehlermeldungen orientieren sich an graphql-ruby, sind aber nicht durchgehend wortgleich.
* **`userErrors`-Texte, `field`-Pfade und Codes** sind nach bestem Wissen gewählt, aber nicht mit echten
  Antworten abgeglichen. Tests sollten auf `field`/`code` prüfen und nicht auf exakte Meldungstexte.
  Beispiele: Produktfehler nutzen `["title"]` und `["handle"]`, Seitenfehler `["page","title"]`, Rabattfehler
  `["basicCodeDiscount", …]`.
* **Kostenberechnung** folgt der dokumentierten Formel (Objekt 1, Connection 2 + n × Knotenkosten,
  Mutation 10, Skalare 0). `actualQueryCost` ist eine Näherung (gezählte Objekte). Shopifys tatsächliche
  Werte weichen ab.
* **Asynchrone Vorgänge** sind vereinfacht. Medien wechseln eine Anfrage später von `UPLOADED` nach `READY` und
  überspringen `PROCESSING`. Jobs (`productReorderMedia`, `collectionRemoveProducts`, `themeFilesUpsert`) wirken
  sofort, melden aber `done: false`. Bulk-Operationen sind in der Antwort `CREATED` und ab der nächsten Anfrage
  `COMPLETED`.
* **Medien:** Unterstützt wird nur `IMAGE`. Video, externe Videos und 3D-Modelle liefern `INVALID_MEDIA_TYPE`.
  Externe `originalSource`-URLs werden nicht geladen; sie werden `READY` mit einer `cdn.shopify.com`-artigen URL,
  die sich nicht abrufen lässt. Staged Uploads liefert der Fake unter `/__fake/cdn/…` selbst aus. Breite und
  Höhe kommen aus PNG-, GIF- und JPEG-Headern, sonst sind sie 1024. Fehlt der Upload, endet das Medium in
  `FAILED`.
* **Theme-Validierung:** Geprüft werden JSON-Syntax, die Template-Struktur (`sections`/`order`/`block_order`),
  ob Section-Dateien existieren, das `{% schema %}`-JSON und eine grobe Balance der Block-Tags. Liquid wird
  **nicht** wirklich geparst und nicht gerendert, Block- und Setting-Typen werden nicht gegen das Schema geprüft.
  Ob ein Section-Typ im Template erlaubt ist (`enabled_on`/`disabled_on`), prüft der Fake nicht. Dass ein
  `templateSuffix` an Seite oder Produkt im Theme existiert, prüft der Fake nicht (Shopify vermutlich auch nicht).
* **Theme-Exemption:** Laut Shopify brauchen `themeFilesUpsert`/`Delete` eine Exemption. Der Fake erlaubt
  standardmäßig alles; `themeWriteAccess: 'unpublished-only'` simuliert die Sperre für das Live-Theme.
* **Veröffentlichung:** Per API angelegte Produkte und Kollektionen sind standardmäßig **nicht** im Online Store
  (`onlineStoreUrl: null`), bis `publishablePublish` aufgerufen wird. Es gibt nur die eine Publication
  „Online Store“. Das Standardverhalten ist eine Annahme; `autoPublish: true` schaltet es um.
* **Varianten:** Es gibt nur eine Location, und `inventoryQuantity` ist die Summe. Bestandsmutationen wie
  `inventorySetQuantities` fehlen. Die Logik der Strategien bei `productVariantsBulkCreate` ist vereinfacht:
  DEFAULT entfernt nur eine „Default Title“-Standalone-Variante. `productOptionsCreate`/`productOptionUpdate`
  fehlen; Optionen entstehen über `productCreate(productOptions)` und neue Werte über `optionValues`.
* **Smart Collections:** Metafeld-, Kategorie- und Gewichtsregeln werden nicht ausgewertet. `VARIANT_WEIGHT`
  trifft nie zu, Metafeld- und Kategorie-Spalten ergeben einen `userError`. `BEST_SELLING` sortiert nach ID.
* **Rabatte:** Nur `DiscountCodeBasic` ist vollständig modelliert. BXGY, Free Shipping und App-Rabatte gibt es
  nur als Typen für Fragmente, ebenso Automatic Discounts. `discountCodeBulk*`, `redeemCodes` und echte
  Nutzungszählung fehlen. Einen Mutationsnamen `discountDelete` gibt es bei Shopify nicht; richtig ist
  `discountCodeDelete`. `summary` ist eine englische Näherung an Shopifys Text.
* **Übersetzungen:** Markt-spezifische Übersetzungen (`marketId`) werden abgelehnt. Theme-, Menü- und
  Shop-Ressourcen liefern keine Inhalte. Produkt-SEO steht im Fake direkt am Produkt, nicht wie bei Shopify in
  den Metafeldern `global.title_tag` und `global.description_tag`. Bei Seiten kommt `meta_title`/
  `meta_description` dagegen aus diesen Metafeldern.
* **Metafelder:** Metafield-Definitionen, Metaobjects und App-reservierte Namespaces mit Rechteprüfung fehlen.
  Ohne `namespace` gilt `app--5550001`. `metafieldsSet` prüft keine Scopes pro Owner-Typ.
* **Suche:** Freitext ist eine einfache Teilstring-Suche ohne Relevanz-Ranking. Felder, die Shopify kennt, der
  Fake aber nicht, werden ignoriert und gemeldet; das kann mehr Treffer ergeben als bei Shopify.
* **Paginierung:** `first`/`last` über 250 werden still auf 250 gekürzt. Shopifys Verhalten dabei ist nicht
  verifiziert. Cursor sind Base64-JSON (`last_id`/`last_value`) und kompatibel mit dem Fake, nicht mit
  Shopify.
* **Datenschutz:** Werden Kunden- oder Bestell-Scopes per Option freigegeben, liefert der Fake leere Ergebnisse.
  Kunden- und Bestelldaten modelliert er nicht. Ob Shopify bei einem verweigerten Non-Null-Root-Feld
  `"data": null` liefert, folgt hier der GraphQL-Spezifikation (Null-Propagation).
* **Client-Credentials-Grant** (`POST /admin/oauth/access_token`, Apps aus dem Dev Dashboard): Form-urlencoded mit
  `grant_type=client_credentials`, `client_id`, `client_secret` → `{ access_token, scope, expires_in: 86399 }` wie in der
  Shopify-Doku. Ausgegebene Tokens gelten als `X-Shopify-Access-Token` bis zum Ablauf (`fake.expireAppTokens()` lässt sie
  sofort ablaufen). Die Fehlerantworten (`400` mit `invalid_client`, `unsupported_grant_type`, `shop_not_permitted`) sind
  Annahmen; nur der Code `shop_not_permitted` ist in der Shopify-Doku belegt. Zugang: `fake.clientId`/`fake.clientSecret`,
  Option `clientCredentials: { clientId, clientSecret, expiresIn, shopPermitted }`.
* **Nicht vorhanden:** REST-API (außer `/admin/oauth/access_scopes.json` und dem Client-Credentials-Grant), Webhooks,
  OAuth-Autorisierungscode- und Session-Token-Flows, Storefront API, Subscriptions, Märkte, Blogs und Artikel, Navigation/Menüs,
  Shop-Policies, Metaobjects, Selling Plans, `productSet`, `productDuplicate`.
* **Zeit:** Status wie `SCHEDULED`/`EXPIRED` und `isPublished` werden gegen die echte Systemzeit berechnet.

## Tests

```bash
npm run test:shopify-fake   # nur der Fake
npm test                    # src/** und test-support/**
```

Die Tests liegen in `test-support/shopify-fake/*.test.ts`: Protokoll, Validierung, Throttling und
Datenschutz in `protocol.test.ts`, Produkte, Medien, Kollektionen und Bulk in `products.test.ts`, Seiten,
Metafelder, Übersetzungen, Rabatte, Themes und Redirects in `content.test.ts`.

## Aufbau

| Datei | Inhalt |
|---|---|
| `server.ts` | HTTP-Server, `startFakeShopify`, CLI, Auth/Fehler/Throttle/Logs, Skalare |
| `graphql.ts` | Lexer, Parser (ausführbare Dokumente + SDL), Validierung, Variablen-Coercion, Executor |
| `schema.ts` | SDL-Teilmenge der Admin API 2026-10, Fake-Direktiven `@access(scope)` und `@opaque` |
| `state.ts` | In-Memory-Store, Seed, Handle-Generierung, Smart-Collection-Regeln |
| `search.ts` | Shopify-Suchsyntax |
| `cost.ts` | Kostenberechnung und Leaky Bucket |
| `context.ts` | Request-Kontext, Paginierung, gemeinsame Helfer |
| `resolvers/*` | Resolver je Bereich |

Neue Felder kommen zuerst ins SDL (`schema.ts`). Danach brauchen sie einen Resolver, sofern sie nicht direkt
auf ein gleichnamiges Feld im Datensatz abgebildet werden. Ein Root-Feld ohne Resolver lässt den Fake beim
Start abbrechen.
