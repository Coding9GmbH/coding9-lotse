<?php
/**
 * Reine Helfer ohne Magento-Abhängigkeit (Paginierung, LIKE-Escaping, Datumsformat, Location-Auflösung,
 * HTTP-Methode mit Override). Werden von Abstract/Media/ApiController genutzt und in tests/unit.php geprüft.
 */
class Lotse_Connector_Model_Util
{
    public const MAX_LIMIT = 200;

    /** @return array{page:int,limit:int} page >= 1, limit 1..MAX_LIMIT (Standard 50 bei fehlend/ungültig) */
    public static function pagination(array $query, $defaultLimit = 50)
    {
        $page = max(1, (int) ($query['page'] ?? 1));
        $limit = (int) ($query['limit'] ?? $defaultLimit);
        if ($limit < 1) {
            $limit = $defaultLimit;
        }
        return ['page' => $page, 'limit' => min(self::MAX_LIMIT, $limit)];
    }

    /** Escaped %, _ und \ für LIKE-Filter aus Nutzereingaben. */
    public static function escapeLike($value)
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], (string) $value);
    }

    /** Datum einheitlich als UTC "Y-m-d H:i:s"; leer/Nulldatum = null; ISO-8601 mit Zeitzone (Store-Scope) wird umgerechnet. */
    public static function formatDate($value)
    {
        if ($value === null || $value === '' || $value === '0000-00-00 00:00:00') {
            return null;
        }
        if (preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/', (string) $value)) {
            return gmdate('Y-m-d H:i:s', strtotime((string) $value));
        }
        return (string) $value;
    }

    /** Absolute, protokoll-relative, wurzel-relative oder relative Location gegen die vorherige URL auflösen. */
    public static function resolveLocation($base, $location)
    {
        if (preg_match('#^https?://#i', $location)) {
            return $location;
        }
        $parts = parse_url($base);
        $origin = $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
        if (strpos($location, '//') === 0) {
            return $parts['scheme'] . ':' . $location;
        }
        if (strpos($location, '/') === 0) {
            return $origin . $location;
        }
        $dir = isset($parts['path']) ? preg_replace('#[^/]*$#', '', $parts['path']) : '/';
        return $origin . ($dir === '' ? '/' : $dir) . $location;
    }

    /** Effektive HTTP-Methode: HEAD zählt als GET, POST mit X-HTTP-Method-Override wird umgedeutet. */
    public static function httpMethod($method, $override = null)
    {
        $method = strtoupper((string) $method);
        if ($method === 'HEAD') {
            return 'GET';
        }
        if ($method === 'POST' && is_string($override) && trim($override) !== '') {
            return strtoupper(trim($override));
        }
        return $method;
    }
}
