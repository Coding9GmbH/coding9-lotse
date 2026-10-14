<?php
/**
 * Router for /lotse-api/...: intercepts the path before the standard router and dispatches
 * Lotse_Connector_ApiController::indexAction with the remaining path as parameter "lotse_path".
 */
class Lotse_Connector_Controller_Router extends Mage_Core_Controller_Varien_Router_Standard
{
    public const FRONT_NAME = 'lotse-api';

    public function initControllerRouters($observer)
    {
        /** @var Mage_Core_Controller_Varien_Front $front */
        $front = $observer->getEvent()->getFront();
        $front->addRouter('lotse_api', $this);
    }

    public function match(Zend_Controller_Request_Http $request)
    {
        if (!Mage::isInstalled()) {
            return false;
        }
        $path = trim($request->getPathInfo(), '/');
        $prefix = self::FRONT_NAME;
        if ($path !== $prefix && strpos($path, $prefix . '/') !== 0) {
            return false;
        }
        $rest = $path === $prefix ? '' : substr($path, strlen($prefix) + 1);

        $className = $this->_validateControllerClassName('Lotse_Connector', 'api');
        if (!$className) {
            return false;
        }
        $request->setModuleName('lotse_api')
            ->setRouteName('lotse_api')
            ->setControllerName('api')
            ->setActionName('index')
            ->setControllerModule('Lotse_Connector')
            ->setParam('lotse_path', $rest);
        $request->setDispatched(true);

        $controller = Mage::getControllerInstance($className, $request, $this->getFront()->getResponse());
        $controller->dispatch('index');
        return true;
    }
}
