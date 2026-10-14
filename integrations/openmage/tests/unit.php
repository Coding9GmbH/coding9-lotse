<?php
/**
 * Unit tests of the pure logic (without Magento): IP allowlist, client IP behind proxies, route table, helpers (Util).
 *   php integrations/openmage/tests/unit.php
 */
declare(strict_types=1);

$base = dirname(__DIR__) . '/app/code/community/Lotse/Connector/Model/';
require $base . 'Net.php';
require $base . 'Route.php';
require $base . 'Util.php';

$failed = 0;
$passed = 0;
function check(string $name, bool $ok, string $detail = ''): void
{
    global $failed, $passed;
    if ($ok) {
        $passed++;
        return;
    }
    $failed++;
    fwrite(STDERR, "FEHLER: $name" . ($detail !== '' ? " ($detail)" : '') . "\n");
}

// --- Net ---
check('leere Liste erlaubt alles', Lotse_Connector_Model_Net::isAllowed('203.0.113.5', []));
check('Parser: Zeilen, Kommas, Kommentare', Lotse_Connector_Model_Net::parseAllowlist("10.0.0.0/8\n# Kommentar\n203.0.113.5, ::1;fe80::/10") === ['10.0.0.0/8', '203.0.113.5', '::1', 'fe80::/10']);
check('IPv4 exakt', Lotse_Connector_Model_Net::isAllowed('203.0.113.5', ['203.0.113.5']));
check('IPv4 exakt fremd', !Lotse_Connector_Model_Net::isAllowed('203.0.113.6', ['203.0.113.5']));
check('IPv4 CIDR /8', Lotse_Connector_Model_Net::isAllowed('10.200.1.1', ['10.0.0.0/8']));
check('IPv4 CIDR /8 fremd', !Lotse_Connector_Model_Net::isAllowed('11.0.0.1', ['10.0.0.0/8']));
check('IPv4 CIDR /25 innerhalb', Lotse_Connector_Model_Net::isAllowed('192.168.1.127', ['192.168.1.0/25']));
check('IPv4 CIDR /25 außerhalb', !Lotse_Connector_Model_Net::isAllowed('192.168.1.128', ['192.168.1.0/25']));
check('IPv4 /0 alles', Lotse_Connector_Model_Net::isAllowed('8.8.8.8', ['0.0.0.0/0']));
check('IPv4 /32', Lotse_Connector_Model_Net::isAllowed('8.8.8.8', ['8.8.8.8/32']) && !Lotse_Connector_Model_Net::isAllowed('8.8.8.9', ['8.8.8.8/32']));
check('IPv6 exakt', Lotse_Connector_Model_Net::isAllowed('::1', ['::1']));
check('IPv6 CIDR', Lotse_Connector_Model_Net::isAllowed('fe80::1234', ['fe80::/10']) && !Lotse_Connector_Model_Net::isAllowed('2001:db8::1', ['fe80::/10']));
check('IPv6 vs IPv4 Eintrag passt nicht', !Lotse_Connector_Model_Net::isAllowed('::1', ['127.0.0.1']));
check('ungültige IP', !Lotse_Connector_Model_Net::isAllowed('nicht-ip', ['0.0.0.0/0']));
check('ungültiger Eintrag ignoriert', !Lotse_Connector_Model_Net::isAllowed('1.2.3.4', ['foo', '1.2.3.0/abc', '1.2.3.4/40']));
check('Mehrere Einträge', Lotse_Connector_Model_Net::isAllowed('1.2.3.4', ['9.9.9.9', '1.2.3.0/24']));

// --- SSRF protection: public vs. private addresses ---
foreach (['127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.51.100.7', '203.0.113.9', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1'] as $ip) {
    check('nicht öffentlich: ' . $ip, !Lotse_Connector_Model_Net::isPublicIp($ip));
}
foreach (['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255', '11.22.33.10', '2606:4700::1111', '2a00:1450:4001::1', '::ffff:8.8.8.8', '64:ff9b::808:808'] as $ip) {
    check('öffentlich: ' . $ip, Lotse_Connector_Model_Net::isPublicIp($ip));
}
check('keine IP ist nicht öffentlich', !Lotse_Connector_Model_Net::isPublicIp('localhost') && !Lotse_Connector_Model_Net::isPublicIp(''));

// --- Client IP behind proxies: the proxy APPENDS the real address, the first entry can be forged by the client ---
$ip = fn($remote, $xff, $trust, $hops = 1) => Lotse_Connector_Model_Net::clientIp($remote, $xff, $trust, $hops);
check('ohne trust_proxy zählt REMOTE_ADDR', $ip('198.51.100.7', '203.0.113.10', false) === '198.51.100.7');
check('trust_proxy: letzter Eintrag (vom Proxy angehängt)', $ip('10.0.0.2', '203.0.113.10, 198.51.100.7', true) === '198.51.100.7');
check('trust_proxy: gefälschter erster Eintrag zählt nicht', $ip('10.0.0.2', '203.0.113.10,198.51.100.7', true) !== '203.0.113.10');
check('trust_proxy: ein Eintrag', $ip('10.0.0.2', ' 198.51.100.7 ', true) === '198.51.100.7');
check('trust_proxy: leerer Header → REMOTE_ADDR', $ip('10.0.0.2', '', true) === '10.0.0.2');
check('trust_proxy: nur Kommas → REMOTE_ADDR', $ip('10.0.0.2', ' , ,', true) === '10.0.0.2');
check('zwei Proxys: vorletzter Eintrag', $ip('10.0.0.2', '203.0.113.10, 198.51.100.7, 10.0.0.3', true, 2) === '198.51.100.7');
check('zwei Proxys, zu wenige Einträge → REMOTE_ADDR', $ip('10.0.0.2', '198.51.100.7', true, 2) === '10.0.0.2');
check('IPv6 im Header', $ip('10.0.0.2', '2001:db8::1, 2606:4700::1111', true) === '2606:4700::1111');
check('ungültiger letzter Eintrag gibt nicht frei', !Lotse_Connector_Model_Net::isAllowed($ip('10.0.0.2', '203.0.113.10, unknown', true), ['203.0.113.10', '0.0.0.0/0']));

// --- Util ---
check('pagination Standard', Lotse_Connector_Model_Util::pagination([]) === ['page' => 1, 'limit' => 50]);
check('pagination limit 0 → 50', Lotse_Connector_Model_Util::pagination(['limit' => '0']) === ['page' => 1, 'limit' => 50]);
check('pagination limit negativ → 50, page < 1 → 1', Lotse_Connector_Model_Util::pagination(['limit' => '-5', 'page' => '0']) === ['page' => 1, 'limit' => 50]);
check('pagination Clamp 200', Lotse_Connector_Model_Util::pagination(['limit' => '999', 'page' => '3']) === ['page' => 3, 'limit' => 200]);
check('pagination Text → Standard', Lotse_Connector_Model_Util::pagination(['limit' => 'abc', 'page' => 'x']) === ['page' => 1, 'limit' => 50]);
check('escapeLike', Lotse_Connector_Model_Util::escapeLike('100%_a\\b') === '100\\%\\_a\\\\b');
check('formatDate ISO mit Zeitzone → UTC', Lotse_Connector_Model_Util::formatDate('2026-10-10T12:00:00+02:00') === '2026-10-10 10:00:00');
check('formatDate ISO negativ', Lotse_Connector_Model_Util::formatDate('2026-10-10T23:30:00-01:00') === '2026-10-11 00:30:00');
check('formatDate Nulldatum', Lotse_Connector_Model_Util::formatDate('0000-00-00 00:00:00') === null && Lotse_Connector_Model_Util::formatDate('') === null && Lotse_Connector_Model_Util::formatDate(null) === null);
check('formatDate MySQL unverändert', Lotse_Connector_Model_Util::formatDate('2026-10-10 12:00:00') === '2026-10-10 12:00:00');
check('resolveLocation absolut', Lotse_Connector_Model_Util::resolveLocation('https://a.test/x/y.jpg', 'https://b.test/z.png') === 'https://b.test/z.png');
check('resolveLocation protokoll-relativ', Lotse_Connector_Model_Util::resolveLocation('https://a.test/x/y.jpg', '//cdn.test/z.png') === 'https://cdn.test/z.png');
check('resolveLocation wurzel-relativ', Lotse_Connector_Model_Util::resolveLocation('https://a.test:8443/x/y.jpg', '/z.png') === 'https://a.test:8443/z.png');
check('resolveLocation relativ', Lotse_Connector_Model_Util::resolveLocation('https://a.test/x/y.jpg', 'z.png') === 'https://a.test/x/z.png');
check('resolveLocation relativ mit ../ (unaufgelöst, aber unter Origin)', Lotse_Connector_Model_Util::resolveLocation('https://a.test/x/y.jpg', '../z.png') === 'https://a.test/x/../z.png');
check('resolveLocation ohne Pfad', Lotse_Connector_Model_Util::resolveLocation('https://a.test', 'z.png') === 'https://a.test/z.png');
check('httpMethod HEAD → GET', Lotse_Connector_Model_Util::httpMethod('head') === 'GET');
check('httpMethod Override nur bei POST', Lotse_Connector_Model_Util::httpMethod('POST', 'patch') === 'PATCH' && Lotse_Connector_Model_Util::httpMethod('GET', 'DELETE') === 'GET');
check('httpMethod ohne Override', Lotse_Connector_Model_Util::httpMethod('POST', '') === 'POST' && Lotse_Connector_Model_Util::httpMethod('POST', null) === 'POST' && Lotse_Connector_Model_Util::httpMethod('put', false) === 'PUT');

// --- Route ---
$m = Lotse_Connector_Model_Route::match('GET', 'v1/info');
check('info', $m['model'] === 'info' && $m['method'] === 'info' && $m['params'] === []);
$m = Lotse_Connector_Model_Route::match('GET', '/v1/products/HH-VASE-KIESEL/');
check('product detail (Slashes toleriert)', $m['model'] === 'product' && $m['method'] === 'getProduct' && $m['params'] === ['sku' => 'HH-VASE-KIESEL']);
$m = Lotse_Connector_Model_Route::match('GET', 'v1/products/attributes');
check('feste Route vor Platzhalter', $m['method'] === 'listProductAttributes');
$m = Lotse_Connector_Model_Route::match('GET', 'v1/products/Becher%20%22Morgen%22');
check('URL-Dekodierung', $m['params']['sku'] === 'Becher "Morgen"');
$m = Lotse_Connector_Model_Route::match('PATCH', 'v1/products/X/images/12');
check('image update', $m['model'] === 'media' && $m['method'] === 'updateImage' && $m['params'] === ['sku' => 'X', 'id' => '12']);
$m = Lotse_Connector_Model_Route::match('DELETE', 'v1/products/X');
check('method not allowed-Liste', Lotse_Connector_Model_Route::match('POST', 'v1/info') === ['method_not_allowed' => ['GET']]);
check('unbekannt', Lotse_Connector_Model_Route::match('GET', 'v1/customers') === null);
check('unbekannt tief', Lotse_Connector_Model_Route::match('GET', 'v1/products/X/orders') === null);
check('kein v2', Lotse_Connector_Model_Route::match('GET', 'v2/products') === null);
check('leer', Lotse_Connector_Model_Route::match('GET', '') === null);
check('Methode case-insensitiv', Lotse_Connector_Model_Route::match('get', 'v1/info')['method'] === 'info');

// Privacy: no route may contain forbidden areas
$forbidden = ['customer', 'order', 'quote', 'invoice', 'shipment', 'creditmemo', 'user', 'api', 'payment', 'newsletter', 'admin', 'wishlist', 'review'];
foreach (Lotse_Connector_Model_Route::table() as $route) {
    foreach ($forbidden as $word) {
        check('Route ohne ' . $word . ': ' . $route[1], !preg_match('#(^|/)' . $word . 's?(/|$)#', $route[1]));
    }
}
check('jede Route hat 4 Felder', count(array_filter(Lotse_Connector_Model_Route::table(), fn($r) => count($r) !== 4)) === 0);

// --- URL rewrite target_path: only relative catalog and CMS paths, no schemes and no // ---
if (!class_exists('Lotse_Connector_Model_Api_Abstract', false)) {
    abstract class Lotse_Connector_Model_Api_Abstract {}
}
require $base . 'Api/Urlrewrite.php';
$targetOk = static fn(string $path): bool => Lotse_Connector_Model_Api_Urlrewrite::allowedTargetPath($path);
check('target https://evil', !$targetOk('https://evil'));
check('target http://evil', !$targetOk('http://evil.example/phish'));
check('target //evil', !$targetOk('//evil'));
check('target //evil mit Katalogpfad', !$targetOk('//evil.example/catalog/product/view/id/1'));
check('target catalog/product/view/id/1', $targetOk('catalog/product/view/id/1'));
check('target catalog/product mit Kategorie', $targetOk('catalog/product/view/id/1/category/2'));
check('target catalog/category/view/id/3', $targetOk('catalog/category/view/id/3'));
check('target cms/page/view', $targetOk('cms/page/view/page_id/4'));
check('target javascript-Schema', !$targetOk('javascript:alert(1)'));
check('target leerer Pfad', !$targetOk('') && !$targetOk('/'));

echo "unit: $passed ok, $failed Fehler\n";
exit($failed === 0 ? 0 : 1);
