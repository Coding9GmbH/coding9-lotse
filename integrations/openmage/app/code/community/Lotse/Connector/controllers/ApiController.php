<?php
/**
 * Einziger Einstiegspunkt der Lotse-API (/lotse-api/...). Zustandslos: keine Session, keine Cookies,
 * kein Form-Key. Auth: Authorization: Bearer <token>, optional IP-Freigabeliste.
 * Routing über Lotse_Connector_Model_Route, Fachlogik in Lotse_Connector_Model_Api_*.
 */
class Lotse_Connector_ApiController extends Mage_Core_Controller_Front_Action
{
    public function preDispatch()
    {
        $this->setFlag('', self::FLAG_NO_START_SESSION, true);
        $this->setFlag('', self::FLAG_NO_PRE_DISPATCH, true);
        $this->setFlag('', self::FLAG_NO_POST_DISPATCH, true);
        $this->setFlag('', self::FLAG_NO_COOKIES_REDIRECT, false);
        $this->getLayout()->setArea($this->_currentArea);
        Mage::app()->loadArea($this->_currentArea);
        // Wie die Core-API: Admin-Store als aktueller Store, sonst verwirft Mage_Catalog_Model_Product
        // die Originaldaten (setOrigData) und ein Produkt-Save scheitert unter PHP 8.
        Mage::app()->setCurrentStore(Mage_Core_Model_App::ADMIN_STORE_ID);
        return $this;
    }

    public function indexAction()
    {
        $request = $this->getRequest();
        $response = $this->getResponse();
        $started = microtime(true);
        try {
            /** @var Lotse_Connector_Helper_Data $helper */
            $helper = Mage::helper('lotse_connector');
            if (!$helper->isEnabled()) {
                throw new Lotse_Connector_Model_Exception(404, 'disabled', 'Die Lotse-Schnittstelle ist nicht aktiviert.');
            }
            $this->authenticate($helper);

            $method = Lotse_Connector_Model_Util::httpMethod($request->getMethod(), $request->getHeader('X-HTTP-Method-Override'));
            $route = Lotse_Connector_Model_Route::match($method, (string) $request->getParam('lotse_path', ''));
            if ($route === null) {
                throw Lotse_Connector_Model_Exception::notFound('Unbekannter Endpunkt.');
            }
            if (isset($route['method_not_allowed'])) {
                $response->setHeader('Allow', implode(', ', $route['method_not_allowed']));
                throw new Lotse_Connector_Model_Exception(405, 'method_not_allowed', 'Methode nicht erlaubt.');
            }

            $storeId = $this->resolveStoreId();
            $body = $this->readBody($method);
            $query = $request->getQuery();
            unset($query['store']);

            /** @var Lotse_Connector_Model_Api_Abstract $api */
            $api = Mage::getModel('lotse_connector/api_' . $route['model']);
            $api->setContext($storeId, $query, $body);
            $result = $this->runWithDeadlockRetry($api, $route, $method);
            if (!is_array($result) || !array_key_exists('data', $result)) {
                $result = ['data' => $result];
            }
            $result['meta'] = array_merge($result['meta'] ?? [], [
                'store' => $storeId === 0 ? 'admin' : Mage::app()->getStore($storeId)->getCode(),
                'store_id' => $storeId,
                'duration_ms' => (int) round((microtime(true) - $started) * 1000),
            ]);
            $this->sendJson($api->getStatus() ?: 200, $result);
        } catch (Lotse_Connector_Model_Exception $e) {
            $this->sendJson($e->getStatus(), ['error' => [
                'code' => $e->getErrorCode(),
                'message' => $e->getMessage(),
                'details' => $e->getDetails(),
            ]]);
        } catch (Mage_Core_Exception $e) {
            $this->sendJson(422, ['error' => ['code' => 'magento', 'message' => $e->getMessage()]]);
        } catch (Throwable $e) {
            // Details (Klasse, Meldung, Pfade) nur ins Log, nicht an den Client
            Mage::logException($e);
            $this->sendJson(500, ['error' => ['code' => 'internal', 'message' => 'Interner Fehler; Details stehen in var/log/exception.log.']]);
        }
    }

    /**
     * Parallele Produkt-/Kategorie-Saves lösen in OpenMage Deadlocks im Indexer aus (index_process, MySQL 1213).
     * Idempotente Methoden (PUT, PATCH, DELETE) werden dann bis zu dreimal wiederholt; der Handler liest den Zustand jeweils neu.
     */
    protected function runWithDeadlockRetry(Lotse_Connector_Model_Api_Abstract $api, array $route, string $method)
    {
        $retryable = in_array($method, ['PUT', 'PATCH', 'DELETE'], true);
        for ($attempt = 1; ; $attempt++) {
            try {
                return $api->{$route['method']}($route['params']);
            } catch (Zend_Db_Statement_Exception $e) {
                $deadlock = str_contains($e->getMessage(), 'Deadlock found') || str_contains($e->getMessage(), '40001');
                if (!$deadlock || !$retryable || $attempt >= 3) {
                    throw $e;
                }
                usleep(200000 * $attempt);
            }
        }
    }

    protected function authenticate(Lotse_Connector_Helper_Data $helper)
    {
        $request = $this->getRequest();
        $ip = $helper->getClientIp($request);
        if (!$helper->isIpAllowed($ip)) {
            throw new Lotse_Connector_Model_Exception(403, 'ip_not_allowed', 'IP-Adresse nicht freigegeben.');
        }
        $auth = (string) $request->getHeader('Authorization');
        if ($auth === '' && isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
            $auth = (string) $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
        }
        $token = '';
        if (preg_match('/^\s*Bearer\s+(\S+)\s*$/i', $auth, $m)) {
            $token = $m[1];
        }
        if (!$helper->tokenMatches($token)) {
            $this->getResponse()->setHeader('WWW-Authenticate', 'Bearer realm="lotse-api"');
            throw new Lotse_Connector_Model_Exception(401, 'unauthorized', 'Ungültiger oder fehlender API-Token.');
        }
    }

    /** Store-Scope: ?store=<code> oder Header X-Lotse-Store; leer/"admin"/"0" = globaler Scope (Store 0). */
    protected function resolveStoreId()
    {
        $request = $this->getRequest();
        $code = $request->getParam('store');
        if ($code === null || $code === '') {
            $code = $request->getHeader('X-Lotse-Store');
        }
        $code = is_string($code) ? trim($code) : '';
        if ($code === '' || $code === 'admin' || $code === '0') {
            return 0;
        }
        try {
            $store = Mage::app()->getStore($code);
        } catch (Mage_Core_Model_Store_Exception $e) {
            throw Lotse_Connector_Model_Exception::validation('Unbekannter Store: ' . $code);
        }
        if (!$store || !$store->getId()) {
            throw Lotse_Connector_Model_Exception::validation('Unbekannter Store: ' . $code);
        }
        return (int) $store->getId();
    }

    /** @return array|null JSON-Body (Objekt) oder null bei GET/DELETE ohne Body */
    protected function readBody($method)
    {
        $raw = (string) $this->getRequest()->getRawBody();
        if (trim($raw) === '') {
            if (in_array($method, ['POST', 'PUT', 'PATCH'], true)) {
                throw Lotse_Connector_Model_Exception::validation('JSON-Body erwartet.');
            }
            return null;
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw Lotse_Connector_Model_Exception::validation('Ungültiges JSON: ' . json_last_error_msg());
        }
        return $data;
    }

    protected function sendJson($status, array $payload)
    {
        $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($json === false) {
            $status = 500;
            $json = json_encode(['error' => ['code' => 'encoding', 'message' => json_last_error_msg()]]);
        }
        $this->getResponse()
            ->setHttpResponseCode((int) $status)
            ->setHeader('Content-Type', 'application/json; charset=utf-8', true)
            ->setHeader('Cache-Control', 'no-store', true)
            ->setHeader('X-Content-Type-Options', 'nosniff', true)
            ->setBody($json);
    }
}
