[Deutsch](README.md) · **English**

# Lotse Connector for OpenMage (Magento 1)

Small OpenMage module `Lotse_Connector` that gives Lotse a **token-secured JSON API** under `/lotse-api/v1/...`. The old Magento 1 APIs (REST with OAuth 1.0a, SOAP/XML-RPC) know nothing about CMS pages and blocks and are unwieldy for Lotse; this module covers exactly what Lotse reads and (after human approval) writes.

- OpenMage LTS 19.x/20.x (Magento 1.9 compatible), PHP 7.4 to 8.3; tested against OpenMage 20.18.0 / PHP 8.2.
- Stateless: no session, no cookies, no form key. Auth via `Authorization: Bearer <token>`.
- No endpoints for customers, orders, carts, invoices, admin/API users, payment data or newsletters. They don't exist and return 404.
- Every write returns the complete new state so Lotse can build an exact undo.
- API description: [`openapi.yaml`](openapi.yaml) (this is what the Lotse adapter is implemented against).

## Installation

Requirement: OpenMage with access to the code folder. There are no database setup scripts; the module only creates configuration values in `core_config_data`.

### Option A: copy files (or zip from `package.sh`)

```sh
# from inside this folder, <magento> = root of the OpenMage installation
cp -r app/code/community/Lotse  <magento>/app/code/community/
cp app/etc/modules/Lotse_Connector.xml <magento>/app/etc/modules/
cp shell/lotse.php <magento>/shell/            # optional, shell tool
rm -rf <magento>/var/cache/*                   # or in the Admin: Cache Management > Flush Magento Cache
```

`./package.sh` builds `dist/lotse-connector-<version>.zip` with exactly this structure; the zip is unpacked into `<magento>/`.

### Option B: modman

```sh
cd <magento>
modman init
modman link /path/to/lotse/integrations/openmage
```

(The `modman` file is included; "Allow Symlinks" does not need to be enabled in OpenMage for templates, as the module has no templates.)

### Option C: Composer (type `magento-module`)

`composer.json` is of type `magento-module` and is placed into the installation by `magento-hackathon/magento-composer-installer` (or its fork `cotya/magento-composer-installer`) based on the `modman` file:

```sh
# in the composer.json of the OpenMage installation
# "repositories": [{"type": "path", "url": "../lotse/integrations/openmage"}],
# "extra": {"magento-root-dir": ".", "magento-deploystrategy": "copy"}
composer require lotse/openmage-connector:@dev
```

### Verify

```sh
php -r 'require "app/Mage.php"; Mage::app(); echo (string) Mage::getConfig()->getModuleConfig("Lotse_Connector")->active, PHP_EOL;'   # true
```

## Configuration

Admin: **System > Configuration > Lotse > API** (ACL resource `system/config/lotse`). The Admin labels are in German.

| Field | Meaning |
|---|---|
| Aktiv (Active) | API on/off. Off = all requests 404 (`disabled`). Default: off. |
| API-Token | Button "Token erzeugen" (generate token). The token is stored encrypted with the core encryption (`Mage::helper('core')->encrypt`, key from `app/etc/local.xml`) in `core_config_data` under `lotse/api/token` and shown **only once**. A new token replaces the old one immediately. |
| IP-Freigabeliste (IP allowlist) | Optional. One IP or CIDR network per line (IPv4/IPv6), comments with `#`. Empty = all addresses. Other addresses get 403 `ip_not_allowed`. |
| Client-IP aus X-Forwarded-For lesen (read client IP from X-Forwarded-For) | Only enable if a trusted reverse proxy sits in front. The **last** entry of the header counts, i.e. the address the proxy appends itself (nginx `proxy_add_x_forwarded_for`, Apache `mod_proxy`, HAProxy `option forwardfor`); the client can set the earlier entries freely. With several proxies in a row, the front-most must set the header and the ones behind it must pass it through unchanged. Otherwise `REMOTE_ADDR` counts. |

Alternatively via shell (for deployments and tests):

```sh
php shell/lotse.php --generate-token      # generate a new token and print it once
php shell/lotse.php --set-token <token>   # store a given token (min. 24 characters)
php shell/lotse.php --enable              # or --disable
php shell/lotse.php --status
```

In Lotse: platform "OpenMage", the shop's base URL, token.

## Security

- **Constant-time token comparison** (`hash_equals` over SHA-256 hashes, so even the length reveals nothing). Wrong or missing token: 401 with `WWW-Authenticate: Bearer`.
- **No session, no cookies**: the controller sets `FLAG_NO_START_SESSION`, there is no CSRF vector. The token must come from a header, never from the URL.
- **Admin store context** like the core API (`Mage::app()->setCurrentStore('admin')`); the data scope comes exclusively from `?store=` or `X-Lotse-Store`.
- **Privacy through non-existence**: The route table (`Model/Route.php`) contains no customer, order, cart, invoice, user, payment or newsletter routes; `tests/unit.php` checks this. Product, category and CMS responses contain no such relations. Price rules return usage only as a counter (`times_used`), coupons without customer reference. `GET /v1/sales` only returns sums per product (quantity, revenue, number of orders), never single orders, order numbers or customer data.
- **Transport**: Only run over HTTPS. Additionally set the IP allowlist if Lotse has a fixed address.
- **Layout XML as in the Admin**: `layout_update_xml`/`custom_layout_update_xml` (CMS pages) and `custom_layout_update` (products, categories) go through `adminhtml/layoutUpdate_validator`, which the Admin also uses: no template paths with `../`, no `helper=` attributes, no `setTemplate`, no blocked blocks (`validators/custom_layout/disallowed_block`). Rejected = 400 `validation` with `details.messages`, nothing is saved. The API therefore allows no directives that Magento denies the Admin.
- **Image URLs only from public addresses**: `POST …/images` with `url` downloads server-side; targets in loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), multicast and documentation ranges as well as fc00::/7 are rejected, also as redirect targets (every hop is resolved and checked, at most 3 redirects). No blind SSRF on internal services.
- **Error output**: Internal errors (500) are generic ("Interner Fehler"); class, message and paths are only in `var/log/exception.log`. Query parameters must be single values (`?skus[]=…` → 400 instead of 500). Magento validation errors come as 422 `magento`.
- The Admin action "Token erzeugen" is a normal Admin action (secret key in the URL, form key, ACL).
- `X-HTTP-Method-Override` is accepted for POST (for proxies that block PATCH/DELETE).

## Conventions

- **Base**: `https://shop.example/lotse-api/v1/…`, JSON (UTF-8) in and out. Success response `{"data": …, "meta": {…}}`, error `{"error": {"code", "message", "details"}}`. `meta` always contains `store`, `store_id`, `duration_ms`; lists additionally `page`, `limit`, `total`, `pages`.
- **Store scope**: `?store=<code>` or header `X-Lotse-Store: <code>`. If missing or `admin`/`0`, the global scope applies (store 0 = default values). With a store view code, product and category responses return the values of that view and `store_overrides` (attribute codes with their own value in that view).
- **"Use default value"**: When writing in store view scope, `null` sets an attribute to "use default value" (the store value is deleted). In the global scope `null` is not allowed; send `""` to clear.
- **Pagination**: `page` (from 1), `limit` (default 50, max 200). **Sorting**: `sort=<field>&dir=asc|desc`.
- **Products** are addressed by SKU (`/v1/products/HH-VASE-KIESEL`), alternatively by ID with `id:` (`/v1/products/id:1`). SKUs containing `/` are not addressable (Apache drops encoded slashes).
- **HTTP codes**: 200, 201 (created), 400 `validation`, 401 `unauthorized`, 403 `ip_not_allowed`, 404 `not_found`/`disabled`, 405 `method_not_allowed` (with `Allow`), 409 `conflict`, 422 `magento`, 500 `internal`.

## Endpoints

Read:

| Method | Path | Content |
|---|---|---|
| GET | `/v1/info` | OpenMage/Magento version, module version, shop name, websites, store groups, store views (code, locale, currency, base/link/media URL, root category, theme title prefix/suffix since 1.1.2), price basis (`price_includes_tax`), `catalog_price_scope`, `save_rewrites_history`, URL suffixes, indexer status |
| GET | `/v1/products` | List. Filters: `sku` (like), `skus` (exact, comma-separated), `ids`, `name` (like), `term` (like in name OR SKU, since 1.2.0), `category_id` (direct assignment, without subcategories), `status`, `visibility` (comma-separated), `type`, `attribute_set_id`, `price_from`, `price_to`, `updated_from`, `website_id`. Sorting: `entity_id`, `sku`, `name`, `price`, `updated_at`, `created_at`, `status`. Per product: master data, prices, `qty`/`is_in_stock`, `category_ids`, `website_ids`. `fields=description,meta_title` returns further attributes under `attributes`, `with=images` the gallery per entry (for checks on large catalogs without individual requests) |
| GET | `/v1/products/{sku}` | Detail: all attributes of the attribute set (`attributes`), labels of select attributes (`attribute_labels`), `store_overrides`, `stock`, `categories` (with position), `images`, `tier_prices`, `url`, for configurables `configurable.attributes` (with options) and `configurable.children`, for simple products `parent_ids` |
| GET | `/v1/products/attributes` | Attribute sets and all product attributes (scope, type, options with store labels, `writable`). `?options=0` without options |
| GET | `/v1/products/{sku}/stock` | Stock (`qty`, `is_in_stock`, `manage_stock`, …) |
| GET | `/v1/products/{sku}/categories` | Assignments with position |
| GET | `/v1/products/{sku}/images`, `/v1/media/{sku}` | Gallery: `id`, `file`, `url`, `label`, `position`, `disabled`, `types` (`image`/`small_image`/`thumbnail`), `label_use_default`, `position_use_default`, `has_store_values` |
| GET | `/v1/categories` | Tree (in store scope from the store's root category). `root=<id>`, `depth=<n>`, `flat=1`. Per node `product_count` (direct assignments) |
| GET | `/v1/categories/{id}` | Detail: name, description, metas, `url_key`, `is_active`, `display_mode`, `landing_page` (+ `landing_page_block`), `attributes`, `store_overrides`, `url`, `child_ids` |
| GET | `/v1/cms/pages`, `/v1/cms/pages/{id}` | Pages (filters `identifier`, `title`, `term` = title OR identifier since 1.2.0, `is_active`; store filter via scope). Detail with `content`, `root_template`, `stores`, `is_active`, metas, layout XML |
| GET | `/v1/cms/blocks`, `/v1/cms/blocks/{id}` | Blocks, detail with `content` |
| GET | `/v1/salesrules`, `/v1/salesrules/{id}`, `/v1/salesrules/{id}/coupons` | Shopping cart price rules with condition trees, `times_used`, coupons (code, limits, counters) |
| GET | `/v1/urlrewrites` | Filter required: `sku`, `product_id`, `category_id`, `request_path`, `id_path` (or `all=1`); `is_system`; store via scope |
| GET | `/v1/urlrewrites/{id}` | A single rewrite |
| GET | `/v1/sales?from=YYYY-MM-DD&to=YYYY-MM-DD` | Sales without personal data (since 1.3.0): per product `product_id`, `qty` (ordered minus canceled), `revenue` (row total incl. tax in base currency), `orders` (number of orders); plus total `orders`, `currency` (`null` with several base currencies) and `capped` (more than 20,000 products). Canceled orders don't count, child items (configurable/bundle) count towards the parent product. Days in UTC like `created_at`, at most 366 days, always the whole shop (the store scope is ignored) |

Write (only for the privileged Lotse client after approval):

| Method | Path | Body | Notes |
|---|---|---|---|
| PATCH/PUT | `/v1/products/{sku}` | `{"attributes": {code: value\|null}}` | Store scope. Writes via `catalog/product_action::updateAttributes` (flat/price indexers run along); `null` deletes the store value (for website attributes like `price` with price scope "Website", in all store views of the website). `custom_layout_update` is validated as in the Admin (400). `url_key` is formatted, `catalog_url` is refreshed for the product, `_write.rewrites_added` lists new 301 rewrites ("Save Rewrites History"), which Lotse deletes on undo. Select attributes accept option ID or label. Not writable: `sku`, `type_id`, `attribute_set_id`, `media_gallery`, `tier_price`, `category_ids`, `website_ids` |
| POST | `/v1/products` | `{"sku", "type_id"?: simple\|virtual\|configurable, "attribute_set_id"?, "website_ids"?, "attributes": {...}, "stock"?: {qty, is_in_stock, manage_stock?}, "categories"?: [{id, position}], "configurable"?: {"attribute_codes": [...], "children": [sku\|id]}}` | 201, always global (store 0, `url_key` with the locale of the default store view). Required: `sku`, `attributes.name`, `attributes.price` (except configurable); `null` values are not allowed on create (400). Defaults: `status` 1, `visibility` 4, website of the default store view |
| DELETE | `/v1/products/{sku}` | | Deletes the product (to undo creations); response contains `before` |
| PUT | `/v1/products/{sku}/stock` | `{"qty"?, "is_in_stock"?, "manage_stock"?: bool\|null}` | `null` = use configuration |
| PUT | `/v1/products/{sku}/categories` | `{"add": [{id, position?}], "remove": [id], "set_position": [{id, position}]}` | Via the category model (indexers as in the Admin). On removal, the product rewrites of the category left are deleted (like a full `catalog_url` reindex) |
| POST | `/v1/products/{sku}/images` | `{"base64"\|"url", "filename"?, "label"?, "position"?, "types"?: [...], "disabled"?}` | 201, always global. JPEG/PNG/GIF/WebP, max. 20 MB. `url` only public addresses (see Security). Response `image` + `images` |
| PATCH | `/v1/products/{sku}/images/{id}` | `{"label"?, "position"?, "disabled"?, "types"?}` | Store scope for `label`/`position`/`disabled` (`null` = default value for `label`/`position`). Writes exactly one gallery row (value_id, store_id) directly, no product save; a store row without its own value is removed. `types` = exact roles of this image (roles not mentioned that point to this image are set to `no_selection`), written via `updateAttributes` in scope, only changed roles |
| DELETE | `/v1/products/{sku}/images/{id}?mode=disable\|delete` | | Default `disable` (exactly reversible). `delete` removes the gallery entry (all stores) and the file if no other product uses it |
| PATCH | `/v1/categories/{id}` | `{"attributes": {code: value\|null}}` | Store scope via the category model. In store scope only the requested attributes become store values: all other inherited attributes are set to "use default value" as in the Admin (`store_overrides` grows by exactly the requested codes). `landing_page` must be an existing block ID, `display_mode` PRODUCTS/PAGE/PRODUCTS_AND_PAGE |
| POST/PATCH/PUT/DELETE | `/v1/cms/pages[/{id}]` | `title`, `identifier`, `content`, `content_heading`, `root_template`, `meta_keywords`, `meta_description`, `is_active`, `sort_order`, `layout_update_xml`, `custom_*`, `stores` (codes/IDs, `"admin"` = all) | Identifier unique per store (otherwise 422). PATCH without `stores` keeps the assignment. Layout XML is validated as in the Admin (400). `GET /v1/cms/pages` and `/blocks` without `?store` list all entries (including those assigned to only one store view, see `stores`), with `?store` only those visible there |
| POST/PATCH/PUT/DELETE | `/v1/cms/blocks[/{id}]` | `title`, `identifier`, `content`, `is_active`, `stores` | |
| POST/PATCH/PUT/DELETE | `/v1/salesrules[/{id}]` | `name`, `description`, `is_active`, `from_date`, `to_date` (YYYY-MM-DD, `null` clears), `coupon_code` (sets `coupon_type` 2), `coupon_type`, `uses_per_coupon`, `uses_per_customer`, `simple_action` (by_percent, by_fixed, cart_fixed, buy_x_get_y), `discount_amount`, `discount_qty`, `discount_step`, `apply_to_shipping`, `stop_rules_processing`, `sort_order`, `website_ids` (default all), `customer_group_ids` (default all), `conditions`/`actions` (tree) or `product_filter: {category_ids, skus}` + `apply_to_matching` | Condition trees in the format of `Mage_Rule_Model_Condition_Combine::asArray` (children always under `conditions`), only `salesrule/rule_condition_*` types |
| POST | `/v1/urlrewrites` | `{"request_path", "store"\|"store_id", "sku"\|"product_id"\|"category_id"\|"target_path", "options"?: R\|RP\|null, "id_path"?, "description"?}` | 201, store view required, 409 if the path is taken |
| DELETE | `/v1/urlrewrites/{id}` | | Only custom rewrites; system rewrites only with `?force=1` |

### Indexers

Writes go through the Magento models, so the indexers apply as in the Admin (mode "Update on Save"): product attributes → `catalog_product_attribute`, `catalog_product_price`, `catalog_product_flat`; stock → `cataloginventory_stock`; category assignment → `catalog_category_product`, `catalog_url`; `url_key` → `catalog_url` for the product (directly via `catalog/url::refreshProductRewrite`). If indexers are set to "Manual Update", cron or `php shell/indexer.php reindexall` takes over. `/v1/info` shows the mode and status of every indexer.

## Examples (curl)

```sh
TOKEN=lotse_…
BASE=https://shop.example/lotse-api/v1

# Shop info
curl -s $BASE/info -H "Authorization: Bearer $TOKEN"

# Products: page 1, 50 items, by name, only category 3
curl -s "$BASE/products?category_id=3&sort=name&dir=asc&limit=50" -H "Authorization: Bearer $TOKEN"

# Product in store view "en"
curl -s "$BASE/products/HH-VASE-KIESEL?store=en" -H "Authorization: Bearer $TOKEN"

# Change names globally (store 0)
curl -s -X PATCH $BASE/products/HH-VASE-KIESEL -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"attributes":{"name":"Vase „Kiesel“ groß","meta_title":"Vase Kiesel kaufen"}}'

# Set English name, reset meta description in "en" to the default value
curl -s -X PATCH "$BASE/products/HH-VASE-KIESEL?store=en" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"attributes":{"name":"Pebble vase","meta_description":null}}'

# Stock
curl -s -X PUT $BASE/products/HH-VASE-KIESEL/stock -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"qty":120,"is_in_stock":true}'

# Category assignment: add to category 4 at position 7, remove from 5
curl -s -X PUT $BASE/products/HH-VASE-KIESEL/categories -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"add":[{"id":4,"position":7}],"remove":[5]}'

# Upload image (base64) as main image, set alt text
curl -s -X POST $BASE/products/HH-VASE-KIESEL/images -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"filename\":\"vase.jpg\",\"base64\":\"$(base64 -w0 vase.jpg)\",\"label\":\"Vase Kiesel von vorn\",\"types\":[\"image\",\"small_image\",\"thumbnail\"]}"

# Alt text of an image only in "en"
curl -s -X PATCH "$BASE/products/HH-VASE-KIESEL/images/1?store=en" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"label":"Pebble vase, front"}'

# Hide image (undo: {"disabled": false})
curl -s -X DELETE $BASE/products/HH-VASE-KIESEL/images/1 -H "Authorization: Bearer $TOKEN"

# Category: description in "en"
curl -s -X PATCH "$BASE/categories/3?store=en" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"attributes":{"description":"<p>Home accessories by Haus Holm.</p>"}}'

# Create CMS page (store view "en" only), delete later
curl -s -X POST $BASE/cms/pages -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Gift ideas","identifier":"gift-ideas","content":"<h1>Gift ideas</h1>","root_template":"one_column","stores":["en"],"meta_description":"Gifts by Haus Holm"}'
curl -s -X DELETE $BASE/cms/pages/8 -H "Authorization: Bearer $TOKEN"

# CMS block
curl -s -X POST $BASE/cms/blocks -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"USP-Leiste","identifier":"usp-leiste","content":"<ul><li>Handgemacht</li></ul>","stores":["admin"]}'

# Price rule: 15% with coupon on category 3, only on matching items
curl -s -X POST $BASE/salesrules -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Herbst 15","coupon_code":"HERBST15","simple_action":"by_percent","discount_amount":15,"from_date":"2026-10-01","to_date":"2026-10-31","uses_per_coupon":500,"uses_per_customer":1,"product_filter":{"category_ids":[3]},"apply_to_matching":true}'

# Custom rewrite (301) in store "default"
curl -s -X POST $BASE/urlrewrites -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"request_path":"vase.html","sku":"HH-VASE-KIESEL","store":"default","options":"RP"}'

# Privacy: does not exist
curl -s -o /dev/null -w '%{http_code}\n' $BASE/customers -H "Authorization: Bearer $TOKEN"   # 404
```

## Tests

- `php tests/unit.php`: pure logic without Magento (IP allowlist, route table, privacy check of the routes).
- `php tests/smoke.php`: full read, write and undo cycle against a running instance with the "Haus Holm" demo data (187 checks, including layout XML rejection, SSRF block, store visibility of CMS lists, LIKE escaping). At the end it verifies that product (global and store view), categories, CMS, price rules and URL rewrites match the initial state.

```sh
LOTSE_OPENMAGE_URL=http://127.0.0.1:8891 LOTSE_OPENMAGE_TOKEN=<token> php tests/smoke.php
# Image upload via URL needs a public address reachable from the shop server (private/localhost are rejected):
#   LOTSE_SMOKE_IMAGE_URL=http://<public>/image.png             successful upload
#   LOTSE_SMOKE_REDIRECT_URL=http://<public>/next               302 to a public image (followed)
#   LOTSE_SMOKE_PRIVATE_REDIRECT_URL=http://<public>/internal   302 to 127.0.0.1 (must return 400)
# Without these variables the upload checks are skipped; rejection of private addresses is always checked.
```

## Known limitations

- An image's `disabled` exists per store only as a fixed value (each gallery row of a store view carries its own `disabled`); "use default value" applies only to `label` and `position`. If a view has its own row (e.g. because it was saved per view in the Admin), it hides the global `disabled`: Lotse then additionally writes in that view. The module itself never creates rows without their own value and removes a store row as soon as label and position are empty and `disabled` equals the global value; `has_store_values` therefore only shows real store values and works as an undo signal.
- The layout XML check uses the OpenMage validator; under PHP 8 it internally throws a TypeError for some rejections (invalid XML, template path, blocked block). The module treats this as a rejection (400 with a generic message instead of the validator texts).
- New images are always created in the global scope.
- A CMS page referenced in the configuration (e.g. as the home page) cannot be deactivated; OpenMage then resets `is_active`.
- SKUs containing `/` are not addressable.
- No rate limits (deliberately, Lotse is the only client); limit in the web server if needed.
- Parallel product saves trigger indexer deadlocks in OpenMage (`index_process`, MySQL 1213). The module then retries PUT/PATCH/DELETE up to three times; Lotse sends writing calls one after another anyway.
- On a model save in store scope, Magento 1 copies every loaded attribute as a store value (after that the view inherits nothing). The module therefore never saves a product in store scope (attributes via `updateAttributes`, gallery rows and roles directly) and, on a category save, sets all non-requested inherited attributes to "use default value", as the Admin does. `store_overrides` thus only grows by the written codes; `tests/smoke.php` checks this for product images and categories in the default store view.
- Magento 1 does not render `{{block id="…"}}` in product or category descriptions (the catalog filter only knows `skin`, `media`, `store`); blocks belong in CMS pages/blocks or in a category's `landing_page`.
