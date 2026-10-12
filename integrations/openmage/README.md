# Lotse Connector für OpenMage (Magento 1)

Kleines OpenMage-Modul `Lotse_Connector`, das Lotse eine **token-gesicherte JSON-API** unter `/lotse-api/v1/...` gibt. Die alten Magento-1-Schnittstellen (REST mit OAuth 1.0a, SOAP/XML-RPC) kennen keine CMS-Seiten und -Blöcke und sind für Lotse unhandlich; dieses Modul deckt genau das ab, was Lotse liest und (nach menschlicher Freigabe) schreibt.

- OpenMage LTS 19.x/20.x (Magento 1.9 kompatibel), PHP 7.4 bis 8.3; geprüft gegen OpenMage 20.18.0 / PHP 8.2.
- Zustandslos: keine Session, keine Cookies, kein Form-Key. Auth per `Authorization: Bearer <token>`.
- Keine Endpunkte für Kunden, Bestellungen, Warenkörbe, Rechnungen, Admin-/API-Benutzer, Zahlungsdaten oder Newsletter. Es gibt sie nicht, sie liefern 404.
- Jede Schreibaktion liefert den vollständigen neuen Stand, damit Lotse exaktes Rückgängig bauen kann.
- Schnittstellenbeschreibung: [`openapi.yaml`](openapi.yaml) (das ist, wogegen der Lotse-Adapter implementiert ist).

## Installation

Voraussetzung: OpenMage mit Zugriff auf den Code-Ordner. Es gibt keine Datenbank-Setup-Skripte; das Modul legt nur Konfigurationswerte in `core_config_data` an.

### Variante A: Dateien kopieren (oder Zip aus `package.sh`)

```sh
# aus diesem Ordner heraus, <magento> = Wurzel der OpenMage-Installation
cp -r app/code/community/Lotse  <magento>/app/code/community/
cp app/etc/modules/Lotse_Connector.xml <magento>/app/etc/modules/
cp shell/lotse.php <magento>/shell/            # optional, Shell-Werkzeug
rm -rf <magento>/var/cache/*                   # oder im Admin: Cache Management > Flush Magento Cache
```

`./package.sh` baut `dist/lotse-connector-<version>.zip` mit genau dieser Struktur; das Zip wird in `<magento>/` entpackt.

### Variante B: modman

```sh
cd <magento>
modman init
modman link /pfad/zu/lotse/integrations/openmage
```

(`modman`-Datei liegt bei; „Allow Symlinks“ muss in OpenMage für Templates nicht aktiv sein, das Modul hat keine Templates.)

### Variante C: Composer (Typ `magento-module`)

`composer.json` ist vom Typ `magento-module` und wird vom `magento-hackathon/magento-composer-installer` (bzw. dessen Fork `cotya/magento-composer-installer`) anhand der `modman`-Datei in die Installation gelegt:

```sh
# in der composer.json der OpenMage-Installation
# "repositories": [{"type": "path", "url": "../lotse/integrations/openmage"}],
# "extra": {"magento-root-dir": ".", "magento-deploystrategy": "copy"}
composer require lotse/openmage-connector:@dev
```

### Prüfen

```sh
php -r 'require "app/Mage.php"; Mage::app(); echo (string) Mage::getConfig()->getModuleConfig("Lotse_Connector")->active, PHP_EOL;'   # true
```

## Konfiguration

Admin: **System > Konfiguration > Lotse > API** (ACL-Ressource `system/config/lotse`).

| Feld | Bedeutung |
|---|---|
| Aktiv | Schnittstelle ein/aus. Aus = alle Anfragen 404 (`disabled`). Standard: aus. |
| API-Token | Button „Token erzeugen“. Der Token wird mit der Core-Verschlüsselung (`Mage::helper('core')->encrypt`, Schlüssel aus `app/etc/local.xml`) in `core_config_data` unter `lotse/api/token` gespeichert und **nur einmal** angezeigt. Ein neuer Token ersetzt den alten sofort. |
| IP-Freigabeliste | Optional. Eine IP oder ein CIDR-Netz je Zeile (IPv4/IPv6), Kommentare mit `#`. Leer = alle Adressen. Andere Adressen erhalten 403 `ip_not_allowed`. |
| Client-IP aus X-Forwarded-For lesen | Nur aktivieren, wenn ein vertrauenswürdiger Reverse-Proxy davor steht. Gezählt wird der **letzte** Eintrag des Headers, also die Adresse, die der Proxy selbst anhängt (nginx `proxy_add_x_forwarded_for`, Apache `mod_proxy`, HAProxy `option forwardfor`); die vorderen Einträge kann der Client beliebig setzen. Bei mehreren Proxys hintereinander muss der vorderste den Header setzen und die hinteren ihn unverändert durchreichen. Sonst zählt `REMOTE_ADDR`. |

Alternativ per Shell (für Deployments und Tests):

```sh
php shell/lotse.php --generate-token      # neuen Token erzeugen und einmal ausgeben
php shell/lotse.php --set-token <token>   # vorgegebenen Token speichern (mind. 24 Zeichen)
php shell/lotse.php --enable              # bzw. --disable
php shell/lotse.php --status
```

In Lotse: Plattform „OpenMage“, Basis-URL des Shops, Token.

## Sicherheit

- **Token-Vergleich in konstanter Zeit** (`hash_equals` über SHA-256-Hashes, damit auch die Länge nichts verrät). Falscher oder fehlender Token: 401 mit `WWW-Authenticate: Bearer`.
- **Keine Session, keine Cookies**: der Controller setzt `FLAG_NO_START_SESSION`, es gibt keinen CSRF-Vektor. Der Token muss aus einem Header kommen, nie aus der URL.
- **Admin-Store-Kontext** wie die Core-API (`Mage::app()->setCurrentStore('admin')`); der Daten-Scope kommt ausschließlich aus `?store=` bzw. `X-Lotse-Store`.
- **Privatsphäre durch Nichtexistenz**: Die Routentabelle (`Model/Route.php`) enthält keine Kunden-, Bestell-, Warenkorb-, Rechnungs-, Benutzer-, Zahlungs- oder Newsletter-Routen; `tests/unit.php` prüft das. Produkt-, Kategorie- und CMS-Antworten enthalten keine solchen Relationen. Preisregeln liefern Nutzung nur als Zähler (`times_used`), Gutscheine ohne Kundenbezug.
- **Transport**: Nur über HTTPS betreiben. Zusätzlich IP-Freigabeliste setzen, wenn Lotse eine feste Adresse hat.
- **Layout-XML wie im Admin**: `layout_update_xml`/`custom_layout_update_xml` (CMS-Seiten) und `custom_layout_update` (Produkte, Kategorien) laufen durch `adminhtml/layoutUpdate_validator`, den auch der Admin anwendet: keine Template-Pfade mit `../`, keine `helper=`-Attribute, kein `setTemplate`, keine gesperrten Blöcke (`validators/custom_layout/disallowed_block`). Abgelehnt = 400 `validation` mit `details.messages`, nichts wird gespeichert. Die API erlaubt damit keine Direktiven, die Magento dem Admin verweigert.
- **Bild-URLs nur von öffentlichen Adressen**: `POST …/images` mit `url` lädt serverseitig; Ziele in Loopback-, privaten (10/8, 172.16/12, 192.168/16), Link-Local- (169.254/16, fe80::/10), Multicast- und Dokumentationsbereichen sowie fc00::/7 werden abgelehnt, auch als Weiterleitungsziel (jeder Hop wird aufgelöst und geprüft, maximal 3 Weiterleitungen). Kein blinder SSRF auf interne Dienste.
- **Fehlerausgaben**: Interne Fehler (500) sind generisch („Interner Fehler“); Klasse, Meldung und Pfade stehen nur in `var/log/exception.log`. Query-Parameter müssen einzelne Werte sein (`?skus[]=…` → 400 statt 500). Magento-Validierungsfehler kommen als 422 `magento`.
- Die Admin-Aktion „Token erzeugen“ ist eine normale Admin-Aktion (Secret-Key in der URL, Form-Key, ACL).
- `X-HTTP-Method-Override` wird für POST akzeptiert (für Proxys, die PATCH/DELETE blocken).

## Konventionen

- **Basis**: `https://shop.example/lotse-api/v1/…`, JSON (UTF-8) rein und raus. Erfolgsantwort `{"data": …, "meta": {…}}`, Fehler `{"error": {"code", "message", "details"}}`. `meta` enthält immer `store`, `store_id`, `duration_ms`; Listen zusätzlich `page`, `limit`, `total`, `pages`.
- **Store-Scope**: `?store=<code>` oder Header `X-Lotse-Store: <code>`. Fehlt er oder ist `admin`/`0`, gilt der globale Scope (Store 0 = Standardwerte). Mit Store-View-Code liefern Produkt- und Kategorie-Antworten die Werte dieser View und `store_overrides` (Attributcodes mit eigenem Wert in dieser View).
- **„Standardwert verwenden“**: Beim Schreiben im Store-View-Scope setzt `null` ein Attribut auf „Standardwert verwenden“ (der Store-Wert wird gelöscht). Im globalen Scope ist `null` nicht erlaubt; zum Leeren `""` senden.
- **Paginierung**: `page` (ab 1), `limit` (Standard 50, maximal 200). **Sortierung**: `sort=<feld>&dir=asc|desc`.
- **Produkte** werden per SKU adressiert (`/v1/products/HH-VASE-KIESEL`), alternativ per ID mit `id:` (`/v1/products/id:1`). SKUs mit `/` sind nicht adressierbar (Apache verwirft kodierte Schrägstriche).
- **HTTP-Codes**: 200, 201 (angelegt), 400 `validation`, 401 `unauthorized`, 403 `ip_not_allowed`, 404 `not_found`/`disabled`, 405 `method_not_allowed` (mit `Allow`), 409 `conflict`, 422 `magento`, 500 `internal`.

## Endpunkte

Lesen:

| Methode | Pfad | Inhalt |
|---|---|---|
| GET | `/v1/info` | OpenMage-/Magento-Version, Modulversion, Shopname, Websites, Store-Gruppen, Store-Views (Code, Locale, Währung, Basis-/Link-/Media-URL, Root-Kategorie, Titel-Präfix/-Suffix des Themes ab 1.1.2), Preisbasis (`price_includes_tax`), `catalog_price_scope`, `save_rewrites_history`, URL-Suffixe, Indexer-Status |
| GET | `/v1/products` | Liste. Filter: `sku` (like), `skus` (exakt, kommagetrennt), `ids`, `name` (like), `term` (like in Name ODER SKU, ab 1.2.0), `category_id` (direkte Zuordnung, ohne Unterkategorien), `status`, `visibility` (kommagetrennt), `type`, `attribute_set_id`, `price_from`, `price_to`, `updated_from`, `website_id`. Sortierung: `entity_id`, `sku`, `name`, `price`, `updated_at`, `created_at`, `status`. Je Produkt: Stammdaten, Preise, `qty`/`is_in_stock`, `category_ids`, `website_ids`. `fields=description,meta_title` liefert weitere Attribute unter `attributes`, `with=images` die Galerie je Eintrag (für Prüfungen großer Kataloge ohne Einzelabrufe) |
| GET | `/v1/products/{sku}` | Detail: alle Attribute des Attributsets (`attributes`), Labels von Auswahlattributen (`attribute_labels`), `store_overrides`, `stock`, `categories` (mit Position), `images`, `tier_prices`, `url`, bei Configurables `configurable.attributes` (mit Optionen) und `configurable.children`, bei Einzelprodukten `parent_ids` |
| GET | `/v1/products/attributes` | Attributsets und alle Produktattribute (Scope, Typ, Optionen mit Store-Labels, `writable`). `?options=0` ohne Optionen |
| GET | `/v1/products/{sku}/stock` | Bestand (`qty`, `is_in_stock`, `manage_stock`, …) |
| GET | `/v1/products/{sku}/categories` | Zuordnungen mit Position |
| GET | `/v1/products/{sku}/images`, `/v1/media/{sku}` | Galerie: `id`, `file`, `url`, `label`, `position`, `disabled`, `types` (`image`/`small_image`/`thumbnail`), `label_use_default`, `position_use_default`, `has_store_values` |
| GET | `/v1/categories` | Baum (im Store-Scope ab Root-Kategorie des Stores). `root=<id>`, `depth=<n>`, `flat=1`. Je Knoten `product_count` (direkte Zuordnungen) |
| GET | `/v1/categories/{id}` | Detail: Name, Beschreibung, Metas, `url_key`, `is_active`, `display_mode`, `landing_page` (+ `landing_page_block`), `attributes`, `store_overrides`, `url`, `child_ids` |
| GET | `/v1/cms/pages`, `/v1/cms/pages/{id}` | Seiten (Filter `identifier`, `title`, `term` = Titel ODER identifier ab 1.2.0, `is_active`; Store-Filter über Scope). Detail mit `content`, `root_template`, `stores`, `is_active`, Metas, Layout-XML |
| GET | `/v1/cms/blocks`, `/v1/cms/blocks/{id}` | Blöcke, Detail mit `content` |
| GET | `/v1/salesrules`, `/v1/salesrules/{id}`, `/v1/salesrules/{id}/coupons` | Warenkorb-Preisregeln mit Bedingungsbäumen, `times_used`, Gutscheine (Code, Limits, Zähler) |
| GET | `/v1/urlrewrites` | Filter nötig: `sku`, `product_id`, `category_id`, `request_path`, `id_path` (oder `all=1`); `is_system`; Store über Scope |
| GET | `/v1/urlrewrites/{id}` | Ein Rewrite |

Schreiben (nur für den privilegierten Lotse-Client nach Freigabe):

| Methode | Pfad | Body | Hinweise |
|---|---|---|---|
| PATCH/PUT | `/v1/products/{sku}` | `{"attributes": {code: wert\|null}}` | Store-Scope. Schreibt über `catalog/product_action::updateAttributes` (Flat-/Preis-Indexer laufen mit); `null` löscht den Store-Wert (bei Website-Attributen wie `price` im Preis-Scope „Website“ in allen Store-Views der Website). `custom_layout_update` wird wie im Admin validiert (400). `url_key` wird formatiert, `catalog_url` wird für das Produkt aufgefrischt, `_write.rewrites_added` nennt neue 301-Rewrites („Save Rewrites History“), die Lotse beim Rückgängig löscht. Auswahlattribute akzeptieren Options-ID oder Label. Nicht schreibbar: `sku`, `type_id`, `attribute_set_id`, `media_gallery`, `tier_price`, `category_ids`, `website_ids` |
| POST | `/v1/products` | `{"sku", "type_id"?: simple\|virtual\|configurable, "attribute_set_id"?, "website_ids"?, "attributes": {...}, "stock"?: {qty, is_in_stock, manage_stock?}, "categories"?: [{id, position}], "configurable"?: {"attribute_codes": [...], "children": [sku\|id]}}` | 201, immer global (Store 0, `url_key` mit der Locale der Default-Store-View). Pflicht: `sku`, `attributes.name`, `attributes.price` (außer configurable); `null`-Werte sind beim Anlegen nicht erlaubt (400). Standard: `status` 1, `visibility` 4, Website der Default-Store-View |
| DELETE | `/v1/products/{sku}` | | Löscht das Produkt (für Rückgängig von Anlagen); Antwort enthält `before` |
| PUT | `/v1/products/{sku}/stock` | `{"qty"?, "is_in_stock"?, "manage_stock"?: bool\|null}` | `null` = Konfiguration verwenden |
| PUT | `/v1/products/{sku}/categories` | `{"add": [{id, position?}], "remove": [id], "set_position": [{id, position}]}` | Über das Kategoriemodell (Indexer wie im Admin). Beim Entfernen werden die Produkt-Rewrites der verlassenen Kategorie gelöscht (wie ein voller `catalog_url`-Reindex) |
| POST | `/v1/products/{sku}/images` | `{"base64"\|"url", "filename"?, "label"?, "position"?, "types"?: [...], "disabled"?}` | 201, immer global. JPEG/PNG/GIF/WebP, max. 20 MB. `url` nur öffentliche Adressen (siehe Sicherheit). Antwort `image` + `images` |
| PATCH | `/v1/products/{sku}/images/{id}` | `{"label"?, "position"?, "disabled"?, "types"?}` | Store-Scope für `label`/`position`/`disabled` (`null` = Standardwert bei `label`/`position`). Schreibt genau eine Galerie-Zeile (value_id, store_id) direkt, kein Produkt-Save; eine Store-Zeile ohne eigenen Wert wird entfernt. `types` = exakte Rollen dieses Bildes (nicht genannte Rollen, die auf dieses Bild zeigen, werden auf `no_selection` gesetzt), geschrieben über `updateAttributes` im Scope, nur geänderte Rollen |
| DELETE | `/v1/products/{sku}/images/{id}?mode=disable\|delete` | | Standard `disable` (exakt rückgängig machbar). `delete` entfernt den Galerieeintrag (alle Stores) und die Datei, wenn kein anderes Produkt sie nutzt |
| PATCH | `/v1/categories/{id}` | `{"attributes": {code: wert\|null}}` | Store-Scope über das Kategoriemodell. Im Store-Scope werden nur die angefragten Attribute Store-Werte: alle anderen geerbten Attribute werden wie im Admin auf „Standardwert verwenden“ gesetzt (`store_overrides` wächst genau um die angefragten Codes). `landing_page` muss eine existierende Block-ID sein, `display_mode` PRODUCTS/PAGE/PRODUCTS_AND_PAGE |
| POST/PATCH/PUT/DELETE | `/v1/cms/pages[/{id}]` | `title`, `identifier`, `content`, `content_heading`, `root_template`, `meta_keywords`, `meta_description`, `is_active`, `sort_order`, `layout_update_xml`, `custom_*`, `stores` (Codes/IDs, `"admin"` = alle) | Identifier je Store eindeutig (sonst 422). PATCH ohne `stores` behält die Zuordnung. Layout-XML wird wie im Admin validiert (400). `GET /v1/cms/pages` und `/blocks` ohne `?store` listen alle Einträge (auch nur einer Store-View zugeordnete, siehe `stores`), mit `?store` nur die dort sichtbaren |
| POST/PATCH/PUT/DELETE | `/v1/cms/blocks[/{id}]` | `title`, `identifier`, `content`, `is_active`, `stores` | |
| POST/PATCH/PUT/DELETE | `/v1/salesrules[/{id}]` | `name`, `description`, `is_active`, `from_date`, `to_date` (YYYY-MM-DD, `null` löscht), `coupon_code` (setzt `coupon_type` 2), `coupon_type`, `uses_per_coupon`, `uses_per_customer`, `simple_action` (by_percent, by_fixed, cart_fixed, buy_x_get_y), `discount_amount`, `discount_qty`, `discount_step`, `apply_to_shipping`, `stop_rules_processing`, `sort_order`, `website_ids` (Standard alle), `customer_group_ids` (Standard alle), `conditions`/`actions` (Baum) oder `product_filter: {category_ids, skus}` + `apply_to_matching` | Bedingungsbäume im Format von `Mage_Rule_Model_Condition_Combine::asArray` (Kinder immer unter `conditions`), nur `salesrule/rule_condition_*`-Typen |
| POST | `/v1/urlrewrites` | `{"request_path", "store"\|"store_id", "sku"\|"product_id"\|"category_id"\|"target_path", "options"?: R\|RP\|null, "id_path"?, "description"?}` | 201, Store-View nötig, 409 bei belegtem Pfad |
| DELETE | `/v1/urlrewrites/{id}` | | Nur eigene Rewrites; System-Rewrites nur mit `?force=1` |

### Indexer

Schreibzugriffe laufen über die Magento-Modelle, darum greifen die Indexer wie im Admin (Modus „Update on Save“): Produktattribute → `catalog_product_attribute`, `catalog_product_price`, `catalog_product_flat`; Bestand → `cataloginventory_stock`; Kategoriezuordnung → `catalog_category_product`, `catalog_url`; `url_key` → `catalog_url` für das Produkt (direkt über `catalog/url::refreshProductRewrite`). Stehen Indexer auf „Manual Update“, übernimmt der Cron bzw. `php shell/indexer.php reindexall`. `/v1/info` zeigt Modus und Status jedes Indexers.

## Beispiele (curl)

```sh
TOKEN=lotse_…
BASE=https://shop.example/lotse-api/v1

# Shopinfo
curl -s $BASE/info -H "Authorization: Bearer $TOKEN"

# Produkte: Seite 1, 50 Stück, nach Name, nur Kategorie 3
curl -s "$BASE/products?category_id=3&sort=name&dir=asc&limit=50" -H "Authorization: Bearer $TOKEN"

# Produkt in der Store-View "en"
curl -s "$BASE/products/HH-VASE-KIESEL?store=en" -H "Authorization: Bearer $TOKEN"

# Namen global ändern (Store 0)
curl -s -X PATCH $BASE/products/HH-VASE-KIESEL -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"attributes":{"name":"Vase „Kiesel“ groß","meta_title":"Vase Kiesel kaufen"}}'

# Englischen Namen setzen, Meta-Description in "en" wieder auf Standardwert
curl -s -X PATCH "$BASE/products/HH-VASE-KIESEL?store=en" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"attributes":{"name":"Pebble vase","meta_description":null}}'

# Bestand
curl -s -X PUT $BASE/products/HH-VASE-KIESEL/stock -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"qty":120,"is_in_stock":true}'

# Kategoriezuordnung: zu Kategorie 4 an Position 7, aus 5 entfernen
curl -s -X PUT $BASE/products/HH-VASE-KIESEL/categories -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"add":[{"id":4,"position":7}],"remove":[5]}'

# Bild hochladen (Base64), als Titelbild, Alt-Text setzen
curl -s -X POST $BASE/products/HH-VASE-KIESEL/images -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"filename\":\"vase.jpg\",\"base64\":\"$(base64 -w0 vase.jpg)\",\"label\":\"Vase Kiesel von vorn\",\"types\":[\"image\",\"small_image\",\"thumbnail\"]}"

# Alt-Text eines Bildes nur in "en"
curl -s -X PATCH "$BASE/products/HH-VASE-KIESEL/images/1?store=en" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"label":"Pebble vase, front"}'

# Bild ausblenden (rückgängig: {"disabled": false})
curl -s -X DELETE $BASE/products/HH-VASE-KIESEL/images/1 -H "Authorization: Bearer $TOKEN"

# Kategorie: Beschreibung in "en"
curl -s -X PATCH "$BASE/categories/3?store=en" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"attributes":{"description":"<p>Home accessories by Haus Holm.</p>"}}'

# CMS-Seite anlegen (nur Store-View "en"), später löschen
curl -s -X POST $BASE/cms/pages -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Gift ideas","identifier":"gift-ideas","content":"<h1>Gift ideas</h1>","root_template":"one_column","stores":["en"],"meta_description":"Gifts by Haus Holm"}'
curl -s -X DELETE $BASE/cms/pages/8 -H "Authorization: Bearer $TOKEN"

# CMS-Block
curl -s -X POST $BASE/cms/blocks -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"USP-Leiste","identifier":"usp-leiste","content":"<ul><li>Handgemacht</li></ul>","stores":["admin"]}'

# Preisregel: 15 % mit Gutschein auf Kategorie 3, nur auf passende Artikel
curl -s -X POST $BASE/salesrules -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Herbst 15","coupon_code":"HERBST15","simple_action":"by_percent","discount_amount":15,"from_date":"2026-10-01","to_date":"2026-10-31","uses_per_coupon":500,"uses_per_customer":1,"product_filter":{"category_ids":[3]},"apply_to_matching":true}'

# Eigener Rewrite (301) in Store "default"
curl -s -X POST $BASE/urlrewrites -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"request_path":"vase.html","sku":"HH-VASE-KIESEL","store":"default","options":"RP"}'

# Privatsphäre: existiert nicht
curl -s -o /dev/null -w '%{http_code}\n' $BASE/customers -H "Authorization: Bearer $TOKEN"   # 404
```

## Tests

- `php tests/unit.php`: reine Logik ohne Magento (IP-Freigabeliste, Routentabelle, Datenschutz-Prüfung der Routen).
- `php tests/smoke.php`: voller Lese-, Schreib- und Rückgängig-Zyklus gegen eine laufende Instanz mit den „Haus Holm“-Demodaten (187 Prüfungen, davon Layout-XML-Ablehnung, SSRF-Sperre, Store-Sichtbarkeit der CMS-Listen, LIKE-Escaping). Prüft am Ende, dass Produkt (global und Store-View), Kategorien, CMS, Preisregeln und URL-Rewrites dem Ausgangszustand entsprechen.

```sh
LOTSE_OPENMAGE_URL=http://127.0.0.1:8891 LOTSE_OPENMAGE_TOKEN=<token> php tests/smoke.php
# Bild-Upload per URL braucht eine vom Shop-Server erreichbare öffentliche Adresse (private/localhost werden abgelehnt):
#   LOTSE_SMOKE_IMAGE_URL=http://<öffentlich>/bild.png            erfolgreicher Upload
#   LOTSE_SMOKE_REDIRECT_URL=http://<öffentlich>/weiter            302 auf ein öffentliches Bild (wird gefolgt)
#   LOTSE_SMOKE_PRIVATE_REDIRECT_URL=http://<öffentlich>/intern    302 auf 127.0.0.1 (muss 400 liefern)
# Ohne diese Variablen werden die Upload-Prüfungen übersprungen; die Ablehnung privater Adressen wird immer geprüft.
```

## Bekannte Grenzen

- `disabled` eines Bildes gibt es je Store nur als fester Wert (jede Galerie-Zeile einer Store-View trägt ihr eigenes `disabled`); „Standardwert verwenden“ gilt nur für `label` und `position`. Hat eine View eine eigene Zeile (etwa weil im Admin je View gespeichert wurde), verdeckt sie das globale `disabled`: Lotse schreibt dann zusätzlich in der View. Das Modul legt selbst keine Zeilen ohne eigenen Wert an und entfernt eine Store-Zeile, sobald Label und Position leer sind und `disabled` dem globalen Wert entspricht; `has_store_values` zeigt damit nur echte Store-Werte und taugt als Rückgängig-Signal.
- Die Layout-XML-Prüfung nutzt den OpenMage-Validator; unter PHP 8 wirft der bei manchen Ablehnungen (ungültiges XML, Template-Pfad, gesperrter Block) intern einen TypeError. Das Modul wertet das als Ablehnung (400 mit generischer Meldung statt der Validator-Texte).
- Neue Bilder werden immer im globalen Scope angelegt.
- Eine CMS-Seite, die in der Konfiguration (z. B. als Startseite) referenziert wird, lässt sich nicht deaktivieren; OpenMage setzt `is_active` dann zurück.
- SKUs mit `/` sind nicht adressierbar.
- Keine Rate-Limits (bewusst, Lotse ist der einzige Client); bei Bedarf im Webserver begrenzen.
- Parallele Produkt-Saves lösen in OpenMage Deadlocks im Indexer aus (`index_process`, MySQL 1213). Das Modul wiederholt PUT/PATCH/DELETE dann bis zu dreimal; Lotse sendet schreibende Aufrufe ohnehin nacheinander.
- Magento 1 kopiert bei einem Modell-Save im Store-Scope jedes geladene Attribut als Store-Wert (danach erbt die View nichts mehr). Das Modul speichert darum nie ein Produkt im Store-Scope (Attribute über `updateAttributes`, Galerie-Zeilen und Rollen direkt) und setzt beim Kategorie-Save alle nicht angefragten, geerbten Attribute auf „Standardwert verwenden“, wie der Admin es tut. `store_overrides` wächst so nur um die geschriebenen Codes; `tests/smoke.php` prüft das für Produktbilder und Kategorien in der Standard-Store-View.
- `{{block id="…"}}` in Produkt- oder Kategoriebeschreibungen rendert Magento 1 nicht (der Katalog-Filter kennt nur `skin`, `media`, `store`); Blöcke gehören in CMS-Seiten/-Blöcke oder in `landing_page` einer Kategorie.
