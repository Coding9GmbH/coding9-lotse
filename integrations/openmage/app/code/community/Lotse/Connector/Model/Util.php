<?php
/**
 * Pure helpers without Magento dependency (pagination, LIKE escaping, date format, location resolution,
 * HTTP method with override). Used by Abstract/Media/ApiController and tested in tests/unit.php.
 */
class Lotse_Connector_Model_Util
{
    public const MAX_LIMIT = 200;

    /** @return array{page:int,limit:int} page >= 1, limit 1..MAX_LIMIT (default 50 if missing/invalid) */
    public static function pagination(array $query, $defaultLimit = 50)
    {
        $page = max(1, (int) ($query['page'] ?? 1));
        $limit = (int) ($query['limit'] ?? $defaultLimit);
        if ($limit < 1) {
            $limit = $defaultLimit;
        }
        return ['page' => $page, 'limit' => min(self::MAX_LIMIT, $limit)];
    }

    /** Escapes %, _ and \ for LIKE filters from user input. */
    public static function escapeLike($value)
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], (string) $value);
    }

    /** Date uniformly as UTC "Y-m-d H:i:s"; empty/zero date = null; ISO-8601 with time zone (store scope) is converted. */
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

    /**
     * Sales period from ?from=YYYY-MM-DD&to=YYYY-MM-DD (UTC days, inclusive, like created_at in sales_flat_order).
     * @return array{from:string,to:string}|string bounds as "Y-m-d H:i:s" or an error message
     */
    public static function salesRange($from, $to, $maxDays = 366)
    {
        foreach (['from' => $from, 'to' => $to] as $name => $day) {
            if (!is_string($day) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $day) || !checkdate((int) substr($day, 5, 2), (int) substr($day, 8, 2), (int) substr($day, 0, 4))) {
                return $name . ' fehlt oder ist kein Datum (JJJJ-MM-TT).';
            }
        }
        $days = (int) ((strtotime($to . ' 00:00:00 UTC') - strtotime($from . ' 00:00:00 UTC')) / 86400) + 1;
        if ($days < 1) {
            return 'from liegt nach to.';
        }
        if ($days > $maxDays) {
            return 'Zeitraum höchstens ' . $maxDays . ' Tage.';
        }
        return ['from' => $from . ' 00:00:00', 'to' => $to . ' 23:59:59'];
    }

    /** Resolve an absolute, protocol-relative, root-relative or relative location against the previous URL. */
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

    /** Effective HTTP method: HEAD counts as GET, POST with X-HTTP-Method-Override is reinterpreted. */
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
