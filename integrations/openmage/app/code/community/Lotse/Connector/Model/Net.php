<?php
/**
 * Reine Netz-Logik ohne Magento-Abhängigkeit: IP-Freigabeliste (IPv4/IPv6, einzelne Adressen und CIDR), Client-IP hinter Proxys.
 * Wird vom Helper genutzt und von tests/unit.php direkt eingebunden.
 */
class Lotse_Connector_Model_Net
{
    /**
     * Client-IP für die Freigabeliste. Ohne vertrauenswürdigen Proxy zählt REMOTE_ADDR. Mit Proxy zählt aus X-Forwarded-For
     * der Eintrag, den der Proxy selbst ANGEHÄNGT hat (bei einem Proxy der letzte, bei $hops Proxys hintereinander der
     * $hops-letzte); die vorderen Einträge kommen vom Client und sind fälschbar. Fehlt der Eintrag, zählt REMOTE_ADDR.
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
     * Zerlegt die Freigabeliste (Zeilen, Kommas, Semikolons, Leerzeichen) in Einträge.
     * @return string[]
     */
    public static function parseAllowlist($raw)
    {
        $raw = preg_replace('/#[^\n]*/', '', (string) $raw); // Kommentare bis Zeilenende
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
     * Prüft, ob $ip in der Freigabeliste steht. Leere Liste = alles erlaubt.
     * Ungültige Einträge werden ignoriert (sie geben nie frei).
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

    /** Nicht öffentlich routbare Bereiche (Loopback, privat, Link-Local, Multicast, Dokumentation, CGNAT). */
    public const NON_PUBLIC = [
        '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
        '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
        '::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8', '2001:db8::/32',
    ];

    /**
     * Darf der Server diese Adresse von sich aus ansprechen (Schutz vor SSRF auf interne Dienste)?
     * IPv4-gemappte (::ffff:a.b.c.d) und NAT64-Adressen (64:ff9b::/96) werden als IPv4 geprüft.
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

    /** @param string $packed inet_pton-Form der Client-IP */
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
