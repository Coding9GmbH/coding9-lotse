<?php
/**
 * Configuration, token and access check of the Lotse API.
 * The token is stored encrypted (Mage core encrypt) in core_config_data under lotse/api/token.
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

    /** Decrypted token or '' (default scope; the API has no store scope). */
    public function getToken()
    {
        $raw = (string) Mage::getStoreConfig(self::XML_PATH_TOKEN, 0);
        if ($raw === '') {
            return '';
        }
        return (string) Mage::helper('core')->decrypt($raw);
    }

    /** New token: 48 hex characters (192 bits) from random_bytes. */
    public function generateToken()
    {
        return 'lotse_' . bin2hex(random_bytes(24));
    }

    /** Stores the token encrypted and clears the config cache. */
    public function saveToken($token)
    {
        $encrypted = Mage::helper('core')->encrypt($token);
        Mage::getConfig()->saveConfig(self::XML_PATH_TOKEN, $encrypted, 'default', 0);
        Mage::getConfig()->reinit();
        Mage::app()->getCacheInstance()->cleanType('config');
        return $this;
    }

    /** Constant-time comparison over equal-length hashes so the length reveals nothing. */
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
     * Client IP: REMOTE_ADDR; with trust_proxy the (last) X-Forwarded-For entry appended by the proxy.
     * The first entry could be forged by the client (logic and tests: Lotse_Connector_Model_Net::clientIp).
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
