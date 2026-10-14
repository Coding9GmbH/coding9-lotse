<?php
/**
 * Shell tool for the Lotse Connector (copy to <magento>/shell/lotse.php).
 *
 *   php shell/lotse.php --generate-token        generate a new token, store it encrypted, print it once
 *   php shell/lotse.php --set-token <token>     store a given token (e.g. for tests)
 *   php shell/lotse.php --enable | --disable    enable/disable the API
 *   php shell/lotse.php --status                show configuration (without token)
 */
require_once __DIR__ . '/abstract.php';

class Lotse_Connector_Shell extends Mage_Shell_Abstract
{
    public function run()
    {
        /** @var Lotse_Connector_Helper_Data $helper */
        $helper = Mage::helper('lotse_connector');
        if ($this->getArg('generate-token')) {
            $token = $helper->generateToken();
            $helper->saveToken($token);
            echo $token, PHP_EOL;
        } elseif ($this->getArg('set-token')) {
            $token = trim((string) $this->getArg('set-token'));
            if (strlen($token) < 24) {
                echo "Token muss mindestens 24 Zeichen haben.", PHP_EOL;
                exit(1);
            }
            $helper->saveToken($token);
            echo "Token gespeichert.", PHP_EOL;
        } elseif ($this->getArg('enable') || $this->getArg('disable')) {
            Mage::getConfig()->saveConfig(Lotse_Connector_Helper_Data::XML_PATH_ENABLED, $this->getArg('enable') ? 1 : 0, 'default', 0);
            Mage::getConfig()->reinit();
            Mage::app()->getCacheInstance()->cleanType('config');
            echo $this->getArg('enable') ? "Lotse-API aktiviert." : "Lotse-API deaktiviert.", PHP_EOL;
        } elseif ($this->getArg('status')) {
            echo 'enabled: ', $helper->isEnabled() ? 'ja' : 'nein', PHP_EOL;
            echo 'token: ', $helper->getToken() !== '' ? 'gesetzt' : 'fehlt', PHP_EOL;
            echo 'ip_allowlist: ', implode(', ', $helper->getIpAllowlist()) ?: '(leer = alle)', PHP_EOL;
        } else {
            echo $this->usageHelp();
        }
    }

    public function usageHelp()
    {
        return <<<USAGE
Verwendung: php shell/lotse.php [Option]
  --generate-token      neuen Token erzeugen und einmal ausgeben
  --set-token <token>   vorgegebenen Token speichern
  --enable | --disable  Schnittstelle ein-/ausschalten
  --status              Konfiguration anzeigen

USAGE;
    }
}

$shell = new Lotse_Connector_Shell();
$shell->run();
