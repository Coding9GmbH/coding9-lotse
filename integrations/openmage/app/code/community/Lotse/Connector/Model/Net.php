<?php
/**
 * Pure network logic without Magento dependency: IP allowlist (IPv4/IPv6, single addresses and CIDR), client IP behind proxies.
 * Used by the helper and included directly by tests/unit.php.
 */
class Lotse_Connector_Model_Net
{
    /**
     * Client IP for the allowlist. Without a trusted proxy, REMOTE_ADDR counts. With a proxy, the X-Forwarded-For entry
     * that the proxy itself APPENDED counts (with one proxy the last one, with $hops proxies in a row the
     * $hops-th from the end); the earlier entries come from the client and can be forged. If the entry is missing, REMOTE_ADDR counts.
     */
    public static function clientIp($remote, $forwardedFor, $trustProxy, $hops = 1)
    {
        $remote = trim((string) $remote);
        if (!$trustProxy) {
            return $remote;
        }
        $parts = [];
        foreach (explode(',', (string) $forwardedFor) as $p) {
            $p = trim($p);
            if ($p !== '') {
                $parts[] = $p;
            }
        }
        $hops = max(1, (int) $hops);
        if (count($parts) < $hops) {
            return $remote;
        }
        return $parts[count($parts) - $hops];
    }

    /**
     * Splits the allowlist (lines, commas, semicolons, spaces) into entries.
     * @return string[]
     */
    public static function parseAllowlist($raw)
    {
        $raw = preg_replace('/#[^\n]*/', '', (string) $raw); // comments up to end of line
        $out = [];
        foreach (preg_split('/[\s,;]+/', $raw) as $p) {
            $p = trim($p);
            if ($p !== '') {
                $out[] = $p;
            }
        }
        return $out;
    }

    /**
     * Checks whether $ip is on the allowlist. Empty list = everything allowed.
     * Invalid entries are ignored (they never grant access).
     */
    public static function isAllowed($ip, array $allowlist)
    {
        if ($allowlist === []) {
            return true;
        }
        $packed = @inet_pton((string) $ip);
        if ($packed === false) {
            return false;
        }
        foreach ($allowlist as $entry) {
            if (self::matches($packed, $entry)) {
                return true;
            }
        }
        return false;
    }

    /** Non-publicly-routable ranges (loopback, private, link-local, multicast, documentation, CGNAT). */
    public const NON_PUBLIC = [
        '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
        '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
        '::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8', '2001:db8::/32',
    ];

    /**
     * May the server contact this address on its own (protection against SSRF on internal services)?
     * IPv4-mapped (::ffff:a.b.c.d) and NAT64 addresses (64:ff9b::/96) are checked as IPv4.
     */
    public static function isPublicIp($ip)
    {
        $packed = @inet_pton((string) $ip);
        if ($packed === false) {
            return false;
        }
        if (strlen($packed) === 16) {
            if (substr($packed, 0, 12) === "\0\0\0\0\0\0\0\0\0\0\xff\xff" || substr($packed, 0, 12) === "\0\x64\xff\x9b\0\0\0\0\0\0\0\0") {
                $packed = substr($packed, 12);
            }
        }
        foreach (self::NON_PUBLIC as $entry) {
            if (self::matches($packed, $entry)) {
                return false;
            }
        }
        return true;
    }

    /** @param string $packed inet_pton form of the client IP */
    public static function matches($packed, $entry)
    {
        $bits = null;
        if (strpos($entry, '/') !== false) {
            list($entry, $bits) = explode('/', $entry, 2);
            if ($bits === '' || !ctype_digit($bits)) {
                return false;
            }
            $bits = (int) $bits;
        }
        $net = @inet_pton($entry);
        if ($net === false || strlen($net) !== strlen($packed)) {
            return false;
        }
        $max = strlen($net) * 8;
        if ($bits === null) {
            $bits = $max;
        }
        if ($bits < 0 || $bits > $max) {
            return false;
        }
        $full = intdiv($bits, 8);
        if ($full > 0 && substr($net, 0, $full) !== substr($packed, 0, $full)) {
            return false;
        }
        $rest = $bits % 8;
        if ($rest === 0) {
            return true;
        }
        $mask = (0xFF << (8 - $rest)) & 0xFF;
        return (ord($net[$full]) & $mask) === (ord($packed[$full]) & $mask);
    }
}
