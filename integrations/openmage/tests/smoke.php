<?php
/**
 * Smoke-Test des Lotse Connectors gegen eine laufende OpenMage-Instanz mit den „Haus Holm“-Demodaten.
 * Liest alle Endpunkte, schreibt und macht jede Änderung exakt rückgängig; prüft am Ende, dass der
 * Stand (Produkte in Store 0 und en, Kategorien, CMS, Preisregeln, URL-Rewrites) dem Anfangsstand entspricht.
 *
 *   LOTSE_OPENMAGE_URL=http://127.0.0.1:8891 LOTSE_OPENMAGE_TOKEN=<token> php integrations/openmage/tests/smoke.php
 *
 * Erwartet: SKU HH-VASE-KIESEL (id 1, Kategorie 3), Kategorie 4, Store-Views default + en,
 * Kinder HH-KISSEN-WELLE-SAND/-SALBEI (für den Configurable-Test), Attribut color.
 */
declare(strict_types=1);

$baseUrl = rtrim(getenv('LOTSE_OPENMAGE_URL') ?: 'http://127.0.0.1:8891', '/');
$token = getenv('LOTSE_OPENMAGE_TOKEN') ?: '';
if ($token === '') {
    fwrite(STDERR, "LOTSE_OPENMAGE_TOKEN fehlt.\n");
    exit(2);
}
$sku = getenv('LOTSE_SMOKE_SKU') ?: 'HH-VASE-KIESEL';
$storeView = getenv('LOTSE_SMOKE_STORE') ?: 'en';
$categoryA = (int) (getenv('LOTSE_SMOKE_CATEGORY') ?: 3);
$categoryB = (int) (getenv('LOTSE_SMOKE_CATEGORY2') ?: 4);

$failed = 0;
$passed = 0;
$log = [];
function ok(string $name, bool $cond, $detail = null): void
{
    global $failed, $passed, $log;
    if ($cond) {
        $passed++;
        $log[] = "ok   $name";
        return;
    }
    $failed++;
    $log[] = "FAIL $name" . ($detail !== null ? ' :: ' . (is_string($detail) ? $detail : json_encode($detail, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) : '');
    fwrite(STDERR, end($log) . "\n");
}

/** @return array{0:int,1:array|null,2:array} [Status, JSON, Header] */
function call(string $method, string $path, $body = null, array $headers = [], ?string $tokenOverride = null): array
{
    global $baseUrl, $token;
    $t = $tokenOverride === null ? $token : $tokenOverride;
    $h = ['Accept: application/json'];
    if ($t !== '') {
        $h[] = 'Authorization: Bearer ' . $t;
    }
    if ($body !== null) {
        $h[] = 'Content-Type: application/json';
    }
    foreach ($headers as $k => $v) {
        $h[] = $k . ': ' . $v;
    }
    $ctx = stream_context_create(['http' => [
        'method' => $method,
        'header' => implode("\r\n", $h),
        'content' => $body === null ? '' : json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        'ignore_errors' => true,
        'timeout' => 60,
    ]]);
    $raw = @file_get_contents($baseUrl . '/lotse-api/' . ltrim($path, '/'), false, $ctx);
    $status = 0;
    $respHeaders = [];
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) {
            $status = (int) $m[1];
        } elseif (strpos($line, ':') !== false) {
            [$k, $v] = explode(':', $line, 2);
            $respHeaders[strtolower(trim($k))] = trim($v);
        }
    }
    $json = $raw === false || $raw === '' ? null : json_decode($raw, true);
    return [$status, $json, $respHeaders, $raw];
}

function data(array $r)
{
    return $r[1]['data'] ?? null;
}

/** Produkt-Snapshot ohne flüchtige Felder. */
function productSnapshot(array $p): array
{
    unset($p['updated_at'], $p['attributes']['updated_at'], $p['_write']);
    return $p;
}

function categorySnapshot(array $c): array
{
    unset($c['updated_at'], $c['attributes']['updated_at'], $c['_write']);
    return $c;
}

echo "Smoke-Test gegen $baseUrl\n";

// ---------- Auth / Datenschutz ----------
[$s] = call('GET', 'v1/info', null, [], '');
ok('ohne Token → 401', $s === 401);
[$s, $j, $h] = call('GET', 'v1/info', null, [], 'falsch-' . $token);
ok('falscher Token → 401 + WWW-Authenticate', $s === 401 && isset($h['www-authenticate']) && ($j['error']['code'] ?? '') === 'unauthorized');
[$s, $j, $h] = call('GET', 'v1/info');
ok('info 200 JSON', $s === 200 && isset($j['data']['version']) && strpos($h['content-type'] ?? '', 'application/json') === 0);
ok('info: keine Cookies', !isset($h['set-cookie']), $h['set-cookie'] ?? null);
$info = data([$s, $j]);
ok('info: Store-Views mit Codes', count(array_filter($info['store_views'], fn($v) => $v['code'] === $storeView)) === 1);
foreach (['customers', 'customers/1', 'orders', 'orders/1', 'quotes', 'carts', 'invoices', 'shipments', 'creditmemos', 'users', 'admin/users', 'api/users', 'payments', 'newsletter/subscribers', 'wishlists', 'reviews', 'products/' . rawurlencode($sku) . '/orders'] as $p) {
    [$s, $j] = call('GET', 'v1/' . $p);
    ok("privat: /v1/$p → 404", $s === 404 && ($j['error']['code'] ?? '') === 'not_found', [$s, $j]);
}
[$s] = call('GET', 'v1/info', null, ['X-Lotse-Store' => 'gibt-es-nicht']);
ok('unbekannter Store → 400', $s === 400);
[$s] = call('POST', 'v1/info');
ok('POST info → 405', $s === 405);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku), null);
ok('PATCH ohne Body → 400', $s === 400);
[$s] = call('GET', 'v1/produkte');
ok('unbekannter Pfad → 404', $s === 404);

// ---------- Lesen ----------
[$s, $j] = call('GET', 'v1/products?limit=2&page=1&sort=sku&dir=desc');
ok('products: Paginierung + Sortierung', $s === 200 && count($j['data']) === 2 && $j['meta']['total'] >= 9 && $j['meta']['limit'] === 2 && strcmp($j['data'][0]['sku'], $j['data'][1]['sku']) > 0, $j['meta'] ?? $j);
[$s, $j] = call('GET', 'v1/products?limit=500');
ok('products: limit wird auf 200 begrenzt', $j['meta']['limit'] === 200);
[$s, $j] = call('GET', 'v1/products?sku=' . rawurlencode('VASE'));
ok('products: Filter sku like', $s === 200 && $j['meta']['total'] === 1 && $j['data'][0]['sku'] === $sku, $j);
[$s, $j] = call('GET', 'v1/products?name=' . rawurlencode('Kissen'));
ok('products: Filter name like', $s === 200 && $j['meta']['total'] >= 4);
[$s, $j] = call('GET', 'v1/products?category_id=' . $categoryA);
ok('products: Filter category_id', $s === 200 && $j['meta']['total'] >= 1 && count(array_filter($j['data'], fn($p) => in_array($categoryA, $p['category_ids'], true))) === count($j['data']), $j);
[$s, $j] = call('GET', 'v1/products?type=configurable');
ok('products: Filter type', $s === 200 && $j['meta']['total'] === 1 && $j['data'][0]['type_id'] === 'configurable');
[$s, $j] = call('GET', 'v1/products?status=1&visibility=4&price_from=30&price_to=50');
ok('products: Preisbereich', $s === 200 && count(array_filter($j['data'], fn($p) => $p['price'] >= 30 && $p['price'] <= 50)) === count($j['data']) && $j['meta']['total'] >= 2);
[$s, $j] = call('GET', 'v1/products?updated_from=' . rawurlencode('2000-01-01 00:00:00'));
ok('products: updated_from', $s === 200 && $j['meta']['total'] >= 9);
[$s, $j] = call('GET', 'v1/products?skus=' . rawurlencode($sku) . '&fields=description,meta_title&with=images');
ok('products: fields + with=images', $s === 200 && count($j['data']) === 1 && array_key_exists('description', $j['data'][0]['attributes']) && array_key_exists('meta_title', $j['data'][0]['attributes']) && is_array($j['data'][0]['images']) && count($j['data'][0]['images']) >= 1 && isset($j['data'][0]['images'][0]['label']), $j['data'][0] ?? $j);
[$s, $j] = call('GET', 'v1/products?fields=media_gallery');
ok('products: fields media_gallery → 400', $s === 400);
[$s, $j] = call('GET', 'v1/products?sort=unbekannt');
ok('products: unbekanntes Sortierfeld → 400', $s === 400);
[$s, $j] = call('GET', 'v1/products/attributes');
$attrs = data([$s, $j]);
ok('products/attributes: Sets + Attribute + Optionen', $s === 200 && count($attrs['attribute_sets']) >= 1 && count(array_filter($attrs['attributes'], fn($a) => $a['code'] === 'color' && count($a['options']) >= 3)) === 1);
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku));
$p0 = data([$s, $j]);
ok('product detail (global)', $s === 200 && $p0['sku'] === $sku && isset($p0['attributes']['description']) && $p0['stock']['qty'] > 0 && count($p0['images']) >= 1 && $p0['url'] !== null, $j);
ok('product detail: keine Kunden-/Bestellfelder', !isset($p0['orders']) && !isset($p0['customers']) && !isset($p0['customer_id']));
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku) . '?store=' . $storeView);
$pEn = data([$s, $j]);
ok('product detail (store view)', $s === 200 && $pEn['store_id'] > 0 && $pEn['name'] !== $p0['name'] && in_array('name', $pEn['store_overrides'], true), $j);
[$s, $j] = call('GET', 'v1/products/id:' . $p0['id'], null, ['X-Lotse-Store' => $storeView]);
ok('product per id + Header-Store', $s === 200 && data([$s, $j])['sku'] === $sku && $j['meta']['store'] === $storeView);
[$s, $j] = call('GET', 'v1/products/HH-KISSEN-WELLE');
$conf = data([$s, $j]);
ok('configurable: Achsen + Kinder', $s === 200 && isset($conf['configurable']) && $conf['configurable']['attributes'][0]['code'] === 'color' && count($conf['configurable']['children']) === 3, $j);
[$s, $j] = call('GET', 'v1/products/GIBT-ES-NICHT');
ok('product 404', $s === 404);
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku) . '/stock');
ok('stock', $s === 200 && data([$s, $j])['qty'] === $p0['stock']['qty']);
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku) . '/images');
$images0 = data([$s, $j]);
ok('images', $s === 200 && count($images0) >= 1 && in_array('image', $images0[0]['types'], true), $j);
[$s, $j] = call('GET', 'v1/media/' . rawurlencode($sku));
ok('media alias', $s === 200 && data([$s, $j]) === $images0);
[$s, $j] = call('GET', 'v1/categories');
$tree = data([$s, $j]);
ok('categories tree', $s === 200 && count($tree) >= 1 && isset($tree[0]['children']) && $j['meta']['total'] >= 4, $j);
[$s, $j] = call('GET', 'v1/categories?store=' . $storeView . '&flat=1');
ok('categories flat (store)', $s === 200 && count(array_filter(data([$s, $j]), fn($c) => $c['id'] === $categoryA)) === 1);
[$s, $j] = call('GET', 'v1/categories/' . $categoryA);
$cat0 = data([$s, $j]);
ok('category detail', $s === 200 && $cat0['id'] === $categoryA && $cat0['product_count'] >= 1 && array_key_exists('landing_page_block', $cat0) && isset($cat0['attributes']['name']), $j);
[$s, $j] = call('GET', 'v1/categories/' . $categoryA . '?store=' . $storeView);
$catEn = data([$s, $j]);
ok('category detail (store)', $s === 200 && $catEn['name'] !== $cat0['name']);
[$s, $j] = call('GET', 'v1/cms/pages');
$pages0 = $j['data'] ?? [];
ok('cms pages', $s === 200 && count($pages0) >= 1 && !isset($pages0[0]['content']));
[$s, $j] = call('GET', 'v1/cms/pages?identifier=ueber');
ok('cms pages: Filter', $s === 200 && $j['meta']['total'] === 1);
[$s, $j] = call('GET', 'v1/cms/pages/' . $pages0[0]['id']);
ok('cms page detail', $s === 200 && array_key_exists('content', data([$s, $j])) && isset(data([$s, $j])['stores']));
[$s, $j] = call('GET', 'v1/cms/blocks');
$blocks0 = $j['data'] ?? [];
ok('cms blocks', $s === 200 && count($blocks0) >= 1);
[$s, $j] = call('GET', 'v1/cms/blocks/' . $blocks0[0]['id']);
ok('cms block detail', $s === 200 && array_key_exists('content', data([$s, $j])));
[$s, $j] = call('GET', 'v1/salesrules');
$rules0 = $j['data'] ?? [];
ok('salesrules', $s === 200 && count($rules0) >= 1 && isset($rules0[0]['times_used']) && !isset($rules0[0]['customers']));
[$s, $j] = call('GET', 'v1/salesrules/' . $rules0[0]['id']);
$rule0 = data([$s, $j]);
ok('salesrule detail', $s === 200 && isset($rule0['conditions']['type']) && isset($rule0['actions']['type']));
[$s, $j] = call('GET', 'v1/salesrules/' . $rules0[0]['id'] . '/coupons');
ok('coupons: nur Zähler', $s === 200 && (count($j['data']) === 0 || (isset($j['data'][0]['times_used']) && !isset($j['data'][0]['customer_id']))));
[$s, $j] = call('GET', 'v1/urlrewrites?sku=' . rawurlencode($sku));
$rewrites0 = $j['data'] ?? [];
ok('urlrewrites per sku', $s === 200 && count($rewrites0) >= 1 && $rewrites0[0]['product_id'] === $p0['id'], $j);
[$s, $j] = call('GET', 'v1/urlrewrites');
ok('urlrewrites ohne Filter → 400', $s === 400);

// ---------- Schreiben + Rückgängig: Produktattribute global ----------
$origName = $p0['name'];
$origMetaTitle = $p0['attributes']['meta_title'];
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku), ['attributes' => ['name' => $origName . ' TEST', 'meta_title' => 'Smoke-Titel']]);
$w = data([$s, $j]);
ok('PATCH product (global)', $s === 200 && $w['name'] === $origName . ' TEST' && $w['attributes']['meta_title'] === 'Smoke-Titel' && $w['_write']['updated'] === ['name', 'meta_title'], $j);
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku));
ok('PATCH product (global) sichtbar', data([$s, $j])['name'] === $origName . ' TEST');
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku) . '?store=' . $storeView);
ok('Store-View behält eigenen Namen', data([$s, $j])['name'] === $pEn['name']);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku), ['attributes' => ['name' => $origName, 'meta_title' => $origMetaTitle === null ? '' : $origMetaTitle]]);
ok('Revert product (global)', $s === 200 && data([$s, $j])['name'] === $origName);
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku));
ok('product global = Ausgangszustand', productSnapshot(data([$s, $j])) === productSnapshot($p0), array_diff_assoc(array_map('json_encode', productSnapshot(data([$s, $j]))), array_map('json_encode', productSnapshot($p0))));
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku), ['attributes' => ['name' => null]]);
ok('null im globalen Scope → 400', $s === 400);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku), ['attributes' => ['sku' => 'X']]);
ok('sku nicht schreibbar → 400', $s === 400);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku), ['attributes' => ['gibt_es_nicht' => 'X']]);
ok('unbekanntes Attribut → 400', $s === 400);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku), ['attributes' => ['custom_layout_update' => '<reference name="content"><block type="core/template" name="smoke.bad" template="../../../../etc/passwd"/></reference>']]);
ok('product custom_layout_update mit ../ → 400', $s === 400 && ($j['error']['details']['field'] ?? '') === 'custom_layout_update', $j);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku), ['attributes' => ['custom_layout_update' => '<reference name="content"><action method="setText"><text helper="core/url/getUrl">x</text></action></reference>']]);
ok('product custom_layout_update mit helper= → 400', $s === 400, $j);
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku));
ok('product: ungültiges Layout-XML nicht gespeichert', (data([$s, $j])['attributes']['custom_layout_update'] ?? null) === ($p0['attributes']['custom_layout_update'] ?? null));
[$s, $j] = call('GET', 'v1/products?skus[]=a');
ok('Query-Array → 400 statt 500', $s === 400 && ($j['error']['code'] ?? '') === 'validation', $j);
[$s, $j] = call('GET', 'v1/products?sku=' . rawurlencode('%'));
ok('products: LIKE-Wildcard aus Eingabe wird escaped', $s === 200 && $j['meta']['total'] === 0, $j['meta'] ?? $j);

// ---------- Produktattribute Store-View: eigener Wert ändern + „Standardwert verwenden“ ----------
$enName = $pEn['name'];
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku) . '?store=' . $storeView, ['attributes' => ['name' => $enName . ' EN-TEST']]);
ok('PATCH product (store view)', $s === 200 && data([$s, $j])['name'] === $enName . ' EN-TEST' && data([$s, $j])['store_id'] === $pEn['store_id']);
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku));
ok('global unverändert', data([$s, $j])['name'] === $origName);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku) . '?store=' . $storeView, ['attributes' => ['name' => $enName]]);
ok('Revert product (store view)', $s === 200 && data([$s, $j])['name'] === $enName);
// Attribut ohne Store-Wert: setzen, dann null → Store-Wert weg
$noOverride = null;
foreach (['meta_keyword', 'meta_description', 'short_description'] as $cand) {
    if (!in_array($cand, $pEn['store_overrides'], true)) {
        $noOverride = $cand;
        break;
    }
}
ok('Kandidat ohne Store-Wert gefunden', $noOverride !== null, $pEn['store_overrides']);
if ($noOverride !== null) {
    [$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku) . '?store=' . $storeView, ['attributes' => [$noOverride => 'Store-Wert']]);
    ok("Store-Wert für $noOverride gesetzt", $s === 200 && in_array($noOverride, data([$s, $j])['store_overrides'], true) && data([$s, $j])['attributes'][$noOverride] === 'Store-Wert', $j);
    [$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku) . '?store=' . $storeView, ['attributes' => [$noOverride => null]]);
    ok("null entfernt Store-Wert für $noOverride", $s === 200 && !in_array($noOverride, data([$s, $j])['store_overrides'], true) && data([$s, $j])['_write']['reverted'] === [$noOverride] && data([$s, $j])['attributes'][$noOverride] === $pEn['attributes'][$noOverride], $j);
}
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku) . '?store=' . $storeView);
ok('product store view = Ausgangszustand', productSnapshot(data([$s, $j])) === productSnapshot($pEn), array_diff_assoc(array_map('json_encode', productSnapshot(data([$s, $j]))), array_map('json_encode', productSnapshot($pEn))));

// ---------- url_key + Rewrites ----------
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku), ['attributes' => ['url_key' => 'vase-kiesel-smoke']]);
ok('url_key geändert + catalog_url', $s === 200 && data([$s, $j])['url_key'] === 'vase-kiesel-smoke' && in_array('catalog_url', data([$s, $j])['_write']['reindexed'], true) && strpos((string) data([$s, $j])['url'], 'vase-kiesel-smoke') !== false, $j);
$rewritesAdded = data([$s, $j])['_write']['rewrites_added'] ?? null;
ok('url_key: neue 301-Rewrites gemeldet (Save Rewrites History)', is_array($rewritesAdded) && (count($rewritesAdded) > 0) === $info['save_rewrites_history'], $rewritesAdded);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku), ['attributes' => ['url_key' => $p0['url_key']]]);
ok('url_key zurück', $s === 200 && data([$s, $j])['url'] === $p0['url'], $j);
ok('url_key zurück: _write.rewrites_added gemeldet', is_array(data([$s, $j])['_write']['rewrites_added'] ?? null));
[$s, $j] = call('GET', 'v1/urlrewrites?sku=' . rawurlencode($sku));
$initialIds = array_column($rewrites0, 'id');
foreach ($j['data'] ?? [] as $r) {
    if (!in_array($r['id'], $initialIds, true)) {
        call('DELETE', 'v1/urlrewrites/' . $r['id'] . '?force=1'); // 301-Historie des Testlaufs entfernen (wie Lotse beim Rückgängig)
    }
}
[$s, $j] = call('POST', 'v1/urlrewrites', ['request_path' => 'smoke-test-vase.html', 'sku' => $sku, 'store' => $storeView, 'options' => 'RP']);
$rw = data([$s, $j]);
ok('urlrewrite anlegen', $s === 201 && $rw['request_path'] === 'smoke-test-vase.html' && $rw['product_id'] === $p0['id'] && $rw['options'] === 'RP' && !$rw['is_system'], $j);
[$s, $j] = call('POST', 'v1/urlrewrites', ['request_path' => 'smoke-test-vase.html', 'sku' => $sku, 'store' => $storeView]);
ok('urlrewrite doppelt → 409', $s === 409);
[$s, $j] = call('DELETE', 'v1/urlrewrites/' . $rw['id']);
ok('urlrewrite löschen', $s === 200 && data([$s, $j])['deleted'] === true);
[$s] = call('GET', 'v1/urlrewrites/' . $rw['id']);
ok('urlrewrite weg', $s === 404);
[$s, $j] = call('GET', 'v1/urlrewrites?sku=' . rawurlencode($sku));
ok('urlrewrites = Ausgangszustand', ($j['data'] ?? null) === $rewrites0, ['now' => $j['data'] ?? null, 'before' => $rewrites0]);

// ---------- Bestand ----------
$origQty = $p0['stock']['qty'];
[$s, $j] = call('PUT', 'v1/products/' . rawurlencode($sku) . '/stock', ['qty' => $origQty - 1, 'is_in_stock' => true]);
ok('stock setzen', $s === 200 && data([$s, $j])['qty'] === $origQty - 1, $j);
[$s, $j] = call('PUT', 'v1/products/' . rawurlencode($sku) . '/stock', ['qty' => $origQty, 'is_in_stock' => $p0['stock']['is_in_stock']]);
ok('stock zurück', $s === 200 && data([$s, $j]) === $p0['stock'], $j);

// ---------- Bild-Label / Position / Rollen ----------
$img = $images0[0];
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku) . '/images/' . $img['id'], ['label' => 'Smoke-Alt-Text', 'position' => 5]);
$u = data([$s, $j])['image'] ?? null;
ok('image label/position (global)', $s === 200 && $u['label'] === 'Smoke-Alt-Text' && $u['position'] === 5, $j);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku) . '/images/' . $img['id'], ['label' => $img['label'], 'position' => $img['position']]);
ok('image label/position zurück', $s === 200 && data([$s, $j])['image']['label'] === $img['label'] && data([$s, $j])['image']['position'] === $img['position']);
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku) . '/images?store=' . $storeView);
$imagesEn0 = data([$s, $j]);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku) . '/images/' . $img['id'] . '?store=' . $storeView, ['label' => 'EN alt text']);
$u = data([$s, $j])['image'] ?? null;
ok('image label (store view)', $s === 200 && $u['label'] === 'EN alt text' && $u['has_store_values'] === true && $u['label_use_default'] === false, $j);
// ein Store-Save würde in Magento 1 alle Produktattribute und alle Bilder als Store-Werte kopieren: genau eine Galerie-Zeile, keine neuen Attribut-Werte
ok('image label (store view): nur dieses Bild hat eine Store-Zeile', count(array_filter(data([$s, $j])['images'], fn($i) => $i['has_store_values'])) === 1, data([$s, $j])['images']);
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku) . '?store=' . $storeView);
ok('image label (store view): store_overrides des Produkts unverändert', data([$s, $j])['store_overrides'] === $pEn['store_overrides'], [data([$s, $j])['store_overrides'], $pEn['store_overrides']]);
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku) . '/images');
ok('image label global unverändert', data([$s, $j])[0]['label'] === $img['label']);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku) . '/images/' . $img['id'] . '?store=' . $storeView, ['label' => null]);
$u = data([$s, $j])['image'] ?? null;
ok('image label (store view) → Standard', $s === 200 && $u['label'] === $imagesEn0[0]['label'] && $u['label_use_default'] === $imagesEn0[0]['label_use_default'], $j);
ok('image label (store view) → Standard: keine Store-Zeile mehr (has_store_values)', $u['has_store_values'] === false && count(array_filter(data([$s, $j])['images'], fn($i) => $i['has_store_values'])) === 0, data([$s, $j])['images']);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku) . '/images/' . $img['id'], ['types' => ['image']]);
ok('image types nur image', $s === 200 && data([$s, $j])['image']['types'] === ['image'], $j);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku) . '/images/' . $img['id'], ['types' => $img['types']]);
ok('image types zurück', $s === 200 && data([$s, $j])['image']['types'] === $img['types'], $j);
[$s, $j] = call('DELETE', 'v1/products/' . rawurlencode($sku) . '/images/' . $img['id']);
ok('image deaktivieren', $s === 200 && data([$s, $j])['mode'] === 'disable' && data([$s, $j])['images'][0]['disabled'] === true, $j);
[$s, $j] = call('PATCH', 'v1/products/' . rawurlencode($sku) . '/images/' . $img['id'], ['disabled' => false]);
ok('image wieder aktiv', $s === 200 && data([$s, $j])['image']['disabled'] === false);
// Bild hinzufügen (1x1 PNG) und wieder löschen
$png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
[$s, $j] = call('POST', 'v1/products/' . rawurlencode($sku) . '/images', ['base64' => base64_encode($png), 'filename' => 'smoke-pixel.png', 'label' => 'Smoke Pixel', 'position' => 9, 'disabled' => true]);
$added = data([$s, $j])['image'] ?? null;
ok('image hinzufügen (base64)', $s === 201 && $added !== null && $added['label'] === 'Smoke Pixel' && $added['position'] === 9 && $added['disabled'] === true && $added['types'] === [] && strpos($added['url'], '/media/catalog/product/') !== false, $j);
if ($added) {
    // URL-Upload nur von öffentlichen Adressen (SSRF-Schutz): private, Loopback- und Link-Local-Ziele → 400
    foreach (['http://127.0.0.1/pixel.png', 'http://localhost/media/x.png', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1/a.png', 'http://[::1]/a.png', 'http://[::ffff:127.0.0.1]/a.png', 'ftp://example.com/a.png'] as $bad) {
        [$s, $j] = call('POST', 'v1/products/' . rawurlencode($sku) . '/images', ['url' => $bad]);
        ok("image url privat/ungültig → 400: $bad", $s === 400 && ($j['error']['code'] ?? '') === 'validation', $j);
    }
    // Erfolgreicher URL-Upload braucht eine aus Sicht des Shop-Servers erreichbare öffentliche Bild-URL (LOTSE_SMOKE_IMAGE_URL)
    if (getenv('LOTSE_SMOKE_IMAGE_URL')) {
        [$s, $j] = call('POST', 'v1/products/' . rawurlencode($sku) . '/images', ['url' => getenv('LOTSE_SMOKE_IMAGE_URL'), 'label' => 'Smoke URL']);
        $added2 = data([$s, $j])['image'] ?? null;
        ok('image hinzufügen (url)', $s === 201 && $added2 !== null && $added2['label'] === 'Smoke URL', $j);
        if ($added2) {
            call('DELETE', 'v1/products/' . rawurlencode($sku) . '/images/' . $added2['id'] . '?mode=delete');
        }
    } else {
        $log[] = 'skip image hinzufügen (url): LOTSE_SMOKE_IMAGE_URL nicht gesetzt';
    }
    // Weiterleitungen: auf ein öffentliches Bild folgen (LOTSE_SMOKE_REDIRECT_URL), auf private Adressen blocken (LOTSE_SMOKE_PRIVATE_REDIRECT_URL)
    if (getenv('LOTSE_SMOKE_REDIRECT_URL')) {
        [$s, $j] = call('POST', 'v1/products/' . rawurlencode($sku) . '/images', ['url' => getenv('LOTSE_SMOKE_REDIRECT_URL'), 'label' => 'Smoke Redirect']);
        $added3 = data([$s, $j])['image'] ?? null;
        ok('image hinzufügen (url mit Weiterleitung)', $s === 201 && $added3 !== null && $added3['label'] === 'Smoke Redirect', $j);
        if ($added3) {
            call('DELETE', 'v1/products/' . rawurlencode($sku) . '/images/' . $added3['id'] . '?mode=delete');
        }
    }
    if (getenv('LOTSE_SMOKE_PRIVATE_REDIRECT_URL')) {
        [$s, $j] = call('POST', 'v1/products/' . rawurlencode($sku) . '/images', ['url' => getenv('LOTSE_SMOKE_PRIVATE_REDIRECT_URL')]);
        ok('image url: Weiterleitung auf private Adresse → 400', $s === 400 && ($j['error']['details']['field'] ?? '') === 'url', $j);
    }
    [$s, $j] = call('DELETE', 'v1/products/' . rawurlencode($sku) . '/images/' . $added['id'] . '?mode=delete');
    ok('image löschen', $s === 200 && count(array_filter(data([$s, $j])['images'], fn($i) => $i['id'] === $added['id'])) === 0, $j);
}
[$s, $j] = call('POST', 'v1/products/' . rawurlencode($sku) . '/images', ['base64' => base64_encode('kein bild')]);
ok('ungültiges Bild → 400', $s === 400);
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku) . '/images');
ok('images = Ausgangszustand', data([$s, $j]) === $images0, [data([$s, $j]), $images0]);

// ---------- Kategoriezuordnung ----------
$cats0 = $p0['categories'];
[$s, $j] = call('PUT', 'v1/products/' . rawurlencode($sku) . '/categories', ['add' => [['id' => $categoryB, 'position' => 7]]]);
$cats = data([$s, $j]);
ok('category add', $s === 200 && count(array_filter($cats, fn($c) => $c['id'] === $categoryB && $c['position'] === 7)) === 1, $j);
[$s, $j] = call('GET', 'v1/products?category_id=' . $categoryB . '&sku=' . rawurlencode($sku));
ok('category add sichtbar im Filter', $j['meta']['total'] === 1);
[$s, $j] = call('PUT', 'v1/products/' . rawurlencode($sku) . '/categories', ['set_position' => [['id' => $categoryB, 'position' => 3]]]);
ok('category position', $s === 200 && count(array_filter(data([$s, $j]), fn($c) => $c['id'] === $categoryB && $c['position'] === 3)) === 1);
[$s, $j] = call('PUT', 'v1/products/' . rawurlencode($sku) . '/categories', ['remove' => [$categoryB]]);
ok('category remove = Ausgangszustand', $s === 200 && data([$s, $j]) === $cats0, [data([$s, $j]), $cats0]);
[$s, $j] = call('PUT', 'v1/products/' . rawurlencode($sku) . '/categories', ['add' => [999999]]);
ok('category unbekannt → 404', $s === 404);

// ---------- Kategorie-Attribute ----------
[$s, $j] = call('PATCH', 'v1/categories/' . $categoryA, ['attributes' => ['meta_title' => 'Smoke Kategorie', 'description' => '<p>Smoke</p>']]);
ok('PATCH category (global)', $s === 200 && data([$s, $j])['meta_title'] === 'Smoke Kategorie' && data([$s, $j])['description'] === '<p>Smoke</p>', $j);
[$s, $j] = call('PATCH', 'v1/categories/' . $categoryA, ['attributes' => ['meta_title' => $cat0['meta_title'] ?? '', 'description' => $cat0['description'] ?? '']]);
ok('Revert category (global)', $s === 200);
[$s, $j] = call('GET', 'v1/categories/' . $categoryA);
ok('category global = Ausgangszustand', categorySnapshot(data([$s, $j])) === categorySnapshot($cat0), array_diff_assoc(array_map('json_encode', categorySnapshot(data([$s, $j]))), array_map('json_encode', categorySnapshot($cat0))));
$catCand = in_array('meta_title', $catEn['store_overrides'], true) ? 'meta_keywords' : 'meta_title';
[$s, $j] = call('PATCH', 'v1/categories/' . $categoryA . '?store=' . $storeView, ['attributes' => [$catCand => 'Smoke EN']]);
ok('PATCH category (store view)', $s === 200 && data([$s, $j])['attributes'][$catCand] === 'Smoke EN' && in_array($catCand, data([$s, $j])['store_overrides'], true), $j);
$expectOverrides = array_merge($catEn['store_overrides'], [$catCand]);
sort($expectOverrides);
ok('PATCH category (store view): store_overrides wächst nur um ' . $catCand, data([$s, $j])['store_overrides'] === $expectOverrides, [data([$s, $j])['store_overrides'], $expectOverrides]);
[$s, $j] = call('GET', 'v1/categories/' . $categoryA);
ok('category global unverändert', data([$s, $j])['attributes'][$catCand] === $cat0['attributes'][$catCand]);
[$s, $j] = call('PATCH', 'v1/categories/' . $categoryA . '?store=' . $storeView, ['attributes' => [$catCand => null]]);
ok('category Store-Wert entfernt', $s === 200 && !in_array($catCand, data([$s, $j])['store_overrides'], true), $j);
[$s, $j] = call('GET', 'v1/categories/' . $categoryA . '?store=' . $storeView);
ok('category store view = Ausgangszustand', categorySnapshot(data([$s, $j])) === categorySnapshot($catEn), array_diff_assoc(array_map('json_encode', categorySnapshot(data([$s, $j]))), array_map('json_encode', categorySnapshot($catEn))));
// Standard-Store-View (dort erben meist alle Attribute): der Save im Store-Scope darf keine Kopien anlegen
$defaultStore = getenv('LOTSE_SMOKE_DEFAULT_STORE') ?: 'default';
[$s, $j] = call('GET', 'v1/categories/' . $categoryB . '?store=' . $defaultStore);
$catDe = data([$s, $j]);
$deCand = in_array('meta_keywords', $catDe['store_overrides'], true) ? 'meta_title' : 'meta_keywords';
[$s, $j] = call('PATCH', 'v1/categories/' . $categoryB . '?store=' . $defaultStore, ['attributes' => [$deCand => 'Smoke DE']]);
$expectOverrides = array_merge($catDe['store_overrides'], [$deCand]);
sort($expectOverrides);
ok('PATCH category (Standard-View): nur ' . $deCand . ' wird Store-Wert', $s === 200 && data([$s, $j])['store_overrides'] === $expectOverrides, [data([$s, $j])['store_overrides'] ?? $j, $expectOverrides]);
[$s, $j] = call('PATCH', 'v1/categories/' . $categoryB . '?store=' . $defaultStore, ['attributes' => [$deCand => null]]);
ok('category (Standard-View) = Ausgangszustand', $s === 200 && categorySnapshot(data([$s, $j])) === categorySnapshot($catDe), array_diff_assoc(array_map('json_encode', categorySnapshot(data([$s, $j]))), array_map('json_encode', categorySnapshot($catDe))));
[$s, $j] = call('PATCH', 'v1/categories/' . $categoryA, ['attributes' => ['display_mode' => 'FALSCH']]);
ok('category display_mode ungültig → 400', $s === 400);
[$s, $j] = call('PATCH', 'v1/categories/' . $categoryA, ['attributes' => ['custom_layout_update' => '<reference name="content"><block type="core/template" name="smoke.bad" template="../../../../etc/passwd"/></reference>']]);
ok('category custom_layout_update mit ../ → 400', $s === 400 && ($j['error']['details']['field'] ?? '') === 'custom_layout_update', $j);
[$s, $j] = call('GET', 'v1/categories/' . $categoryA);
ok('category: ungültiges Layout-XML nicht gespeichert', ($j['data']['attributes']['custom_layout_update'] ?? null) === ($cat0['attributes']['custom_layout_update'] ?? null));

// ---------- CMS Seite ----------
[$s, $j] = call('POST', 'v1/cms/pages', ['title' => 'Smoke-Seite', 'identifier' => 'smoke-seite', 'content' => '<h1>Smoke</h1>', 'stores' => [$storeView], 'is_active' => true, 'meta_description' => 'Meta']);
$page = data([$s, $j]);
ok('cms page anlegen', $s === 201 && $page['identifier'] === 'smoke-seite' && $page['content'] === '<h1>Smoke</h1>' && $page['store_ids'] === [$pEn['store_id']] && $page['root_template'] === 'one_column' && $page['meta_description'] === 'Meta', $j);
[$s, $j] = call('POST', 'v1/cms/pages', ['title' => 'Smoke-Seite 2', 'identifier' => 'smoke-seite', 'stores' => [$storeView]]);
ok('cms page identifier doppelt → 422', $s === 422, $j);
[$s, $j] = call('PATCH', 'v1/cms/pages/' . $page['id'], ['title' => 'Smoke-Seite neu', 'stores' => ['admin'], 'root_template' => 'two_columns_left', 'is_active' => false]);
ok('cms page ändern', $s === 200 && data([$s, $j])['title'] === 'Smoke-Seite neu' && data([$s, $j])['store_ids'] === [0] && data([$s, $j])['root_template'] === 'two_columns_left' && data([$s, $j])['is_active'] === false, $j);
[$s, $j] = call('PATCH', 'v1/cms/pages/' . $page['id'], ['root_template' => 'gibt_es_nicht']);
ok('cms page root_template ungültig → 400', $s === 400);
// Layout-XML wie im Admin validiert: Template-Pfade mit "../", helper=-Attribute, setTemplate, gesperrte Blöcke → 400
$badLayouts = [
    'template ../' => '<reference name="content"><block type="core/template" name="smoke.bad" template="../../../../../../../etc/passwd"/></reference>',
    'setTemplate' => '<reference name="content"><block type="core/template" name="smoke.bad2"><action method="setTemplate"><t>../../../etc/passwd</t></action></block></reference>',
    'helper=' => '<reference name="content"><action method="setText"><text helper="core/url/getUrl">x</text></action></reference>',
    'gesperrter Block' => '<reference name="content"><block type="Mage_Core_Block_Template_Zend" name="smoke.zend" template="x.phtml"/></reference>',
    'kaputtes XML' => '<reference name="content"><block',
];
foreach ($badLayouts as $what => $xml) {
    foreach (['layout_update_xml', 'custom_layout_update_xml'] as $field) {
        [$s, $j] = call('PATCH', 'v1/cms/pages/' . $page['id'], [$field => $xml]);
        ok("cms page $field ($what) → 400", $s === 400 && ($j['error']['code'] ?? '') === 'validation' && ($j['error']['details']['field'] ?? '') === $field, $j);
    }
}
[$s, $j] = call('GET', 'v1/cms/pages/' . $page['id']);
ok('cms page: ungültiges Layout-XML nicht gespeichert', ($j['data']['layout_update_xml'] ?? null) === null && ($j['data']['custom_layout_update_xml'] ?? null) === null, $j['data'] ?? $j);
$goodLayout = '<reference name="content"><block type="core/text" name="smoke.text"><action method="setText"><text>Smoke</text></action></block></reference>';
[$s, $j] = call('PATCH', 'v1/cms/pages/' . $page['id'], ['layout_update_xml' => $goodLayout, 'custom_layout_update_xml' => '']);
ok('cms page erlaubtes Layout-XML → 200', $s === 200 && data([$s, $j])['layout_update_xml'] === $goodLayout, $j);
// Globale Liste zeigt auch nur einem Store zugeordnete Seiten; mit ?store nur die passenden
[$s, $j] = call('PATCH', 'v1/cms/pages/' . $page['id'], ['stores' => [$storeView]]);
ok('cms page nur Store-View zuordnen', $s === 200 && data([$s, $j])['store_ids'] === [$pEn['store_id']], $j);
[$s, $j] = call('GET', 'v1/cms/pages?identifier=smoke-seite');
ok('cms pages ohne ?store: Store-Seite in Gesamtliste', $s === 200 && $j['meta']['total'] === 1 && $j['data'][0]['id'] === $page['id'], $j);
[$s, $j] = call('GET', 'v1/cms/pages?identifier=smoke-seite&store=' . $storeView);
ok('cms pages ?store=' . $storeView . ': Store-Seite enthalten', $s === 200 && $j['meta']['total'] === 1, $j);
[$s, $j] = call('GET', 'v1/cms/pages?identifier=smoke-seite&store=default');
ok('cms pages ?store=default: Store-Seite nicht enthalten', $s === 200 && $j['meta']['total'] === 0, $j);
[$s, $j] = call('GET', 'v1/cms/pages?identifier=' . rawurlencode('%'));
ok('cms pages: LIKE-Wildcard aus Eingabe wird escaped', $s === 200 && $j['meta']['total'] === 0, $j['meta'] ?? $j);
[$s, $j] = call('GET', 'v1/cms/pages?identifier=' . rawurlencode('smoke_seite'));
ok('cms pages: _ ist kein Wildcard', $s === 200 && $j['meta']['total'] === 0, $j['meta'] ?? $j);
[$s, $j] = call('DELETE', 'v1/cms/pages/' . $page['id']);
ok('cms page löschen', $s === 200 && data([$s, $j])['before']['identifier'] === 'smoke-seite');
[$s] = call('GET', 'v1/cms/pages/' . $page['id']);
ok('cms page weg', $s === 404);

// ---------- CMS Block ----------
[$s, $j] = call('POST', 'v1/cms/blocks', ['title' => 'Smoke-Block', 'identifier' => 'smoke-block', 'content' => '<p>Block</p>']);
$block = data([$s, $j]);
ok('cms block anlegen', $s === 201 && $block['identifier'] === 'smoke-block' && $block['store_ids'] === [0] && $block['is_active'] === true, $j);
[$s, $j] = call('PUT', 'v1/cms/blocks/' . $block['id'], ['content' => '<p>Neu</p>', 'stores' => [$storeView, 'default']]);
ok('cms block ändern', $s === 200 && data([$s, $j])['content'] === '<p>Neu</p>' && count(data([$s, $j])['store_ids']) === 2, $j);
[$s, $j] = call('DELETE', 'v1/cms/blocks/' . $block['id']);
ok('cms block löschen', $s === 200 && data([$s, $j])['deleted'] === true);
[$s] = call('GET', 'v1/cms/blocks/' . $block['id']);
ok('cms block weg', $s === 404);

// ---------- Preisregel ----------
[$s, $j] = call('POST', 'v1/salesrules', [
    'name' => 'Smoke 15', 'description' => 'Test', 'is_active' => true, 'from_date' => '2026-01-01', 'to_date' => '2026-12-31',
    'coupon_code' => 'SMOKE15', 'uses_per_coupon' => 100, 'uses_per_customer' => 1,
    'simple_action' => 'by_percent', 'discount_amount' => 15, 'stop_rules_processing' => true,
    'product_filter' => ['category_ids' => [$categoryA], 'skus' => [$sku]], 'apply_to_matching' => true,
]);
$rule = data([$s, $j]);
ok('salesrule anlegen', $s === 201 && $rule['coupon_code'] === 'SMOKE15' && $rule['coupon_type'] === 2 && $rule['primary_coupon']['code'] === 'SMOKE15' && $rule['primary_coupon']['usage_limit'] === 100 && $rule['discount_amount'] === 15.0 && $rule['from_date'] === '2026-01-01' && $rule['to_date'] === '2026-12-31' && count($rule['website_ids']) >= 1 && $rule['times_used'] === 0, $j);
ok('salesrule Bedingungen aus product_filter', ($rule['conditions']['conditions'][0]['type'] ?? '') === 'salesrule/rule_condition_product_found' && ($rule['conditions']['conditions'][0]['conditions'][0]['attribute'] ?? '') === 'category_ids' && ($rule['actions']['conditions'][1]['attribute'] ?? '') === 'sku', $rule['conditions'] ?? null);
[$s, $j] = call('PATCH', 'v1/salesrules/' . $rule['id'], ['discount_amount' => 20, 'to_date' => null, 'coupon_code' => 'SMOKE20', 'conditions' => ['type' => 'salesrule/rule_condition_combine', 'aggregator' => 'all', 'value' => 1, 'conditions' => []]]);
$r2 = data([$s, $j]);
ok('salesrule ändern', $s === 200 && $r2['discount_amount'] === 20.0 && $r2['to_date'] === null && $r2['coupon_code'] === 'SMOKE20' && $r2['primary_coupon']['code'] === 'SMOKE20' && ($r2['conditions']['conditions'] ?? []) === [], $j);
[$s, $j] = call('GET', 'v1/salesrules?coupon_code=SMOKE20');
ok('salesrules Filter coupon_code (Primär-Coupon)', $s === 200 && count(data([$s, $j])) === 1 && data([$s, $j])[0]['id'] === $rule['id'], $j);
[$s, $j] = call('GET', 'v1/salesrules?coupon_code=SMOKE-GIBTS-NICHT');
ok('salesrules Filter coupon_code ohne Treffer', $s === 200 && data([$s, $j]) === [], $j);
[$s, $j] = call('PATCH', 'v1/salesrules/' . $rule['id'], ['conditions' => ['type' => 'catalog/product', 'value' => 1]]);
ok('salesrule fremder Bedingungstyp → 400', $s === 400);
[$s, $j] = call('DELETE', 'v1/salesrules/' . $rule['id']);
ok('salesrule löschen', $s === 200 && data([$s, $j])['before']['name'] === 'Smoke 15');
[$s] = call('GET', 'v1/salesrules/' . $rule['id']);
ok('salesrule weg', $s === 404);
[$s, $j] = call('GET', 'v1/salesrules');
ok('salesrules = Ausgangszustand', ($j['data'] ?? null) === $rules0);

// ---------- Produkt anlegen / löschen ----------
[$s, $j] = call('POST', 'v1/products', [
    'sku' => 'SMOKE-SIMPLE', 'attributes' => ['name' => 'Smoke Simple', 'price' => 12.5, 'weight' => 0.5, 'description' => 'Test', 'tax_class_id' => 2, 'color' => 'Sand'],
    'stock' => ['qty' => 3, 'is_in_stock' => true], 'categories' => [['id' => $categoryB, 'position' => 2]],
]);
$np = data([$s, $j]);
ok('product anlegen (simple)', $s === 201 && $np['sku'] === 'SMOKE-SIMPLE' && $np['price'] === 12.5 && $np['stock']['qty'] === 3.0 && $np['stock']['is_in_stock'] === true && count($np['categories']) === 1 && $np['categories'][0]['position'] === 2 && $np['attribute_labels']['color'] === 'Sand' && $np['website_ids'] === [1], $j);
[$s, $j] = call('POST', 'v1/products', ['sku' => 'SMOKE-SIMPLE', 'attributes' => ['name' => 'x', 'price' => 1]]);
ok('product doppelte SKU → 409', $s === 409);
[$s, $j] = call('POST', 'v1/products', ['sku' => 'SMOKE-NOPRICE', 'attributes' => ['name' => 'x']]);
ok('product ohne Preis → 400', $s === 400);
[$s, $j] = call('POST', 'v1/products?store=' . $storeView, ['sku' => 'SMOKE-NULL', 'attributes' => ['name' => 'x', 'price' => 1, 'meta_title' => null]]);
ok('product anlegen mit null → 400 (nicht stillschweigend ignoriert)', $s === 400 && ($j['error']['details']['field'] ?? '') === 'meta_title', $j);
[$s, $j] = call('POST', 'v1/products', [
    'sku' => 'SMOKE-CONF', 'type_id' => 'configurable', 'attributes' => ['name' => 'Smoke Configurable', 'price' => 39],
    'configurable' => ['attribute_codes' => ['color'], 'children' => ['HH-KISSEN-WELLE-SAND', 'HH-KISSEN-WELLE-SALBEI']],
]);
$nc = data([$s, $j]);
ok('product anlegen (configurable)', $s === 201 && $nc['type_id'] === 'configurable' && ($nc['configurable']['attributes'][0]['code'] ?? '') === 'color' && count($nc['configurable']['children'] ?? []) === 2, $j);
[$s, $j] = call('DELETE', 'v1/products/SMOKE-CONF');
ok('product löschen (configurable)', $s === 200 && data([$s, $j])['deleted'] === true);
[$s, $j] = call('DELETE', 'v1/products/SMOKE-SIMPLE');
ok('product löschen (simple)', $s === 200 && data([$s, $j])['before']['sku'] === 'SMOKE-SIMPLE');
[$s] = call('GET', 'v1/products/SMOKE-SIMPLE');
ok('product weg', $s === 404);
[$s, $j] = call('GET', 'v1/products/HH-KISSEN-WELLE');
ok('bestehendes configurable unverändert', count(data([$s, $j])['configurable']['children']) === 3);
[$s, $j] = call('GET', 'v1/products/HH-KISSEN-WELLE-SAND');
ok('Kind hängt nur noch am Original', data([$s, $j])['parent_ids'] === [$conf['id']], data([$s, $j])['parent_ids']);

// ---------- Endzustand ----------
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku));
ok('Ende: product global = Anfang', productSnapshot(data([$s, $j])) === productSnapshot($p0), array_diff_assoc(array_map('json_encode', productSnapshot(data([$s, $j]))), array_map('json_encode', productSnapshot($p0))));
[$s, $j] = call('GET', 'v1/products/' . rawurlencode($sku) . '?store=' . $storeView);
ok('Ende: product store view = Anfang', productSnapshot(data([$s, $j])) === productSnapshot($pEn), array_diff_assoc(array_map('json_encode', productSnapshot(data([$s, $j]))), array_map('json_encode', productSnapshot($pEn))));
[$s, $j] = call('GET', 'v1/products?limit=200');
ok('Ende: Produktanzahl = Anfang', $j['meta']['total'] === 9, $j['meta']);
[$s, $j] = call('GET', 'v1/cms/pages');
ok('Ende: cms pages = Anfang', ($j['data'] ?? null) === $pages0);
[$s, $j] = call('GET', 'v1/cms/blocks');
ok('Ende: cms blocks = Anfang', ($j['data'] ?? null) === $blocks0);
[$s, $j] = call('GET', 'v1/categories/' . $categoryB);
ok('Ende: Kategorie B lesbar', $s === 200);
[$s, $j] = call('GET', 'v1/urlrewrites?sku=' . rawurlencode($sku));
ok('Ende: urlrewrites = Anfang', ($j['data'] ?? null) === $rewrites0, ['now' => $j['data'] ?? null, 'before' => $rewrites0]);

echo implode("\n", $log), "\n";
echo "smoke: $passed ok, $failed Fehler\n";
exit($failed === 0 ? 0 : 1);
