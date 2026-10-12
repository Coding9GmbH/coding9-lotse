<?php
/**
 * Konfiguration, Token und Zugriffsprüfung der Lotse-API.
 * Der Token liegt verschlüsselt (Mage core encrypt) in core_config_data unter lotse/api/token.
 */
class Lotse_Connector_Helper_Data extends Mage_Core_Helper_Abstract
{
    public const XML_PATH_ENABLED      = 'lotse/api/enabled';
    public const XML_PATH_TOKEN        = 'lotse/api/token';
    public const XML_PATH_IP_ALLOWLIST = 'lotse/api/ip_allowlist';
    public const XML_PATH_TRUST_PROXY  = 'lotse/api/trust_proxy';

    public function isEnabled()
    {
        return (bool) Mage::getStoreConfigFlag(self::XML_PATH_ENABLED, 0);
    }

    /** Entschlüsselter Token oder '' (Standard-Scope; die API hat keinen Store-Scope). */
    public function getToken()
    {
        $raw = (string) Mage::getStoreConfig(self::XML_PATH_TOKEN, 0);
        if ($raw === '') {
            return '';
        }
        return (string) Mage::helper('core')->decrypt($raw);
    }

    /** Neuer Token: 48 Hex-Zeichen (192 Bit) aus random_bytes. */
    public function generateToken()
    {
        return 'lotse_' . bin2hex(random_bytes(24));
    }

    /** Speichert den Token verschlüsselt und leert den Config-Cache. */
    public function saveToken($token)
    {
        $encrypted = Mage::helper('core')->encrypt($token);
        Mage::getConfig()->saveConfig(self::XML_PATH_TOKEN, $encrypted, 'default', 0);
        Mage::getConfig()->reinit();
        Mage::app()->getCacheInstance()->cleanType('config');
        return $this;
    }

    /** Konstantzeit-Vergleich über gleich lange Hashes, damit die Länge nichts verrät. */
    public function tokenMatches($given)
    {
        $expected = $this->getToken();
        if ($expected === '' || !is_string($given) || $given === '') {
            return false;
        }
        return hash_equals(hash('sha256', $expected), hash('sha256', $given));
    }

    /** @return string[] */
    public function getIpAllowlist()
    {
        return Lotse_Connector_Model_Net::parseAllowlist(Mage::getStoreConfig(self::XML_PATH_IP_ALLOWLIST, 0));
    }

    public function isIpAllowed($ip)
    {
        return Lotse_Connector_Model_Net::isAllowed($ip, $this->getIpAllowlist());
    }

    /**
     * Client-IP: REMOTE_ADDR; bei trust_proxy der vom Proxy angehängte (letzte) Eintrag aus X-Forwarded-For.
     * Der erste Eintrag wäre vom Client fälschbar (Logik und Tests: Lotse_Connector_Model_Net::clientIp).
     */
    public function getClientIp(Mage_Core_Controller_Request_Http $request)
    {
        return Lotse_Connector_Model_Net::clientIp(
            (string) $request->getServer('REMOTE_ADDR', ''),
            (string) $request->getServer('HTTP_X_FORWARDED_FOR', ''),
            Mage::getStoreConfigFlag(self::XML_PATH_TRUST_PROXY, 0)
        );
    }
}
