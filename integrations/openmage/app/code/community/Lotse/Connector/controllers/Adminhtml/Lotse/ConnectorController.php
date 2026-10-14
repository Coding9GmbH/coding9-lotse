<?php
/**
 * Admin action "Token erzeugen" (generate token) (POST, form key + secret key like every admin action).
 * Responds with JSON {token}; the token is transmitted exactly once.
 */
class Lotse_Connector_Adminhtml_Lotse_ConnectorController extends Mage_Adminhtml_Controller_Action
{
    protected function _isAllowed(): bool
    {
        return Mage::getSingleton('admin/session')->isAllowed('system/config/lotse');
    }

    public function generateAction()
    {
        $response = $this->getResponse()->setHeader('Content-Type', 'application/json; charset=utf-8', true);
        if (!$this->getRequest()->isPost() || !$this->_validateFormKey()) {
            $response->setHttpResponseCode(400)->setBody(json_encode(['error' => 'Ungültige Anfrage (Form-Key).']));
            return;
        }
        try {
            /** @var Lotse_Connector_Helper_Data $helper */
            $helper = Mage::helper('lotse_connector');
            $token = $helper->generateToken();
            $helper->saveToken($token);
            $response->setBody(json_encode(['token' => $token]));
        } catch (Exception $e) {
            Mage::logException($e);
            $response->setHttpResponseCode(500)->setBody(json_encode(['error' => $e->getMessage()]));
        }
    }
}
