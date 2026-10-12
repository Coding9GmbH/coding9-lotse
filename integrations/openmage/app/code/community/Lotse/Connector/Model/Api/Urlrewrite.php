<?php
/**
 * URL-Rewrites (core_url_rewrite): Liste je Produkt/Kategorie/Store, Detail, eigene Rewrites anlegen und löschen.
 * System-Rewrites (is_system=1) erzeugt OpenMage selbst aus url_key; sie werden hier nur gelesen.
 */
class Lotse_Connector_Model_Api_Urlrewrite extends Lotse_Connector_Model_Api_Abstract
{
    public function listRewrites(array $params)
    {
        $pg = $this->pagination();
        $collection = Mage::getModel('core/url_rewrite')->getCollection();
        $hasFilter = false;
        if (($v = $this->q('product_id')) !== null && $v !== '') {
            $collection->addFieldToFilter('product_id', $this->intParam($v, 'product_id'));
            $hasFilter = true;
        }
        if (($v = $this->q('sku')) !== null && $v !== '') {
            $collection->addFieldToFilter('product_id', Mage::getModel('lotse_connector/api_product')->resolveProductId($v));
            $hasFilter = true;
        }
        if (($v = $this->q('category_id')) !== null && $v !== '') {
            $collection->addFieldToFilter('category_id', $this->intParam($v, 'category_id'));
            $hasFilter = true;
        }
        if (($v = $this->q('request_path')) !== null && $v !== '') {
            $collection->addFieldToFilter('request_path', $v);
            $hasFilter = true;
        }
        if (($v = $this->q('id_path')) !== null && $v !== '') {
            $collection->addFieldToFilter('id_path', $v);
            $hasFilter = true;
        }
        if ($this->storeId > 0) {
            $collection->addFieldToFilter('store_id', $this->storeId);
        }
        if (($v = $this->q('is_system')) !== null && $v !== '') {
            $collection->addFieldToFilter('is_system', (int) $v);
        }
        if (!$hasFilter && $this->q('all') !== '1') {
            throw Lotse_Connector_Model_Exception::validation('Filter erwartet: product_id, sku, category_id, request_path oder id_path (oder all=1).');
        }
        $collection->setOrder('url_rewrite_id', 'ASC')->setPageSize($pg['limit'])->setCurPage($pg['page']);
        $total = $collection->getSize();
        $items = [];
        foreach ($collection as $rewrite) {
            $items[] = $this->formatRewrite($rewrite);
        }
        return $this->listResponse($items, $pg['page'], $pg['limit'], $total);
    }

    public function formatRewrite(Mage_Core_Model_Url_Rewrite $rewrite)
    {
        return [
            'id' => (int) $rewrite->getId(),
            'store_id' => (int) $rewrite->getStoreId(),
            'id_path' => $rewrite->getIdPath(),
            'request_path' => $rewrite->getRequestPath(),
            'target_path' => $rewrite->getTargetPath(),
            'is_system' => (bool) $rewrite->getIsSystem(),
            'options' => $rewrite->getOptions() ?: null,
            'description' => $rewrite->getDescription(),
            'category_id' => $rewrite->getCategoryId() === null ? null : (int) $rewrite->getCategoryId(),
            'product_id' => $rewrite->getProductId() === null ? null : (int) $rewrite->getProductId(),
        ];
    }

    protected function loadRewrite($id)
    {
        $rewrite = Mage::getModel('core/url_rewrite')->load($this->intParam($id, 'id'));
        if (!$rewrite->getId()) {
            throw Lotse_Connector_Model_Exception::notFound('URL-Rewrite nicht gefunden: ' . $id);
        }
        return $rewrite;
    }

    public function getRewrite(array $params)
    {
        return ['data' => $this->formatRewrite($this->loadRewrite($params['id']))];
    }

    /**
     * Nur relative Katalogpfade und CMS-Seitenpfade, die das Modul als cms/page kennt.
     * Schemata (http:, https:) und protokoll-relative Ziele (//) sind keine Shop-Pfade.
     */
    public static function allowedTargetPath($path)
    {
        $path = trim((string) $path);
        if ($path === '' || strpos($path, '//') !== false || preg_match('#^[a-z][a-z0-9+.\-]*:#i', $path)) {
            return false;
        }
        $path = trim($path, '/');
        if ($path === '' || strpos($path, ':') !== false || strpos($path, '\\') !== false || strpos($path, '..') !== false) {
            return false;
        }
        foreach (array('catalog/product/view/', 'catalog/category/view/', 'cms/page/view/') as $prefix) {
            if (strpos($path, $prefix) === 0 && strlen($path) > strlen($prefix) && preg_match('#^[A-Za-z0-9_./\-]+$#', $path)) {
                return true;
            }
        }
        return false;
    }

    /**
     * POST /v1/urlrewrites: {request_path, target_path | product_id | category_id, store_id?|store?, options? (R|RP|null), description?}
     * target_path bei product_id/category_id: catalog/product/view/id/<id> bzw. catalog/category/view/id/<id>.
     * Freies target_path nur relativ: catalog/product/view/…, catalog/category/view/…, cms/page/view/….
     */
    public function createRewrite(array $params)
    {
        $body = $this->body();
        $requestPath = trim((string) $this->requireField($body, 'request_path'), '/');
        if ($requestPath === '' || preg_match('/\s/', $requestPath)) {
            throw Lotse_Connector_Model_Exception::validation('request_path ungültig.', ['field' => 'request_path']);
        }
        $storeId = isset($body['store_id']) ? (int) $body['store_id'] : (isset($body['store']) ? $this->storeIdsFromInput([$body['store']])[0] : $this->storeId);
        if ($storeId <= 0) {
            throw Lotse_Connector_Model_Exception::validation('store_id (Store-View) erforderlich; Rewrites sind immer Store-spezifisch.', ['field' => 'store_id']);
        }
        $productId = null;
        $categoryId = null;
        if (!empty($body['product_id']) || !empty($body['sku'])) {
            $productId = !empty($body['sku']) ? Mage::getModel('lotse_connector/api_product')->resolveProductId($body['sku']) : $this->intParam($body['product_id'], 'product_id');
            $targetPath = 'catalog/product/view/id/' . $productId;
            if (!empty($body['category_id'])) {
                $categoryId = $this->intParam($body['category_id'], 'category_id');
                $targetPath .= '/category/' . $categoryId;
            }
        } elseif (!empty($body['category_id'])) {
            $categoryId = $this->intParam($body['category_id'], 'category_id');
            $targetPath = 'catalog/category/view/id/' . $categoryId;
        } else {
            $targetPath = (string) $this->requireField($body, 'target_path');
        }
        if (!self::allowedTargetPath($targetPath)) {
            throw Lotse_Connector_Model_Exception::validation('target_path muss ein relativer Katalog- oder CMS-Pfad sein.', ['field' => 'target_path']);
        }
        $targetPath = trim($targetPath, '/');
        $options = $body['options'] ?? null;
        if ($options !== null && !in_array($options, ['R', 'RP'], true)) {
            throw Lotse_Connector_Model_Exception::validation('options muss R (302), RP (301) oder null sein.', ['field' => 'options']);
        }
        $existing = Mage::getModel('core/url_rewrite')->setStoreId($storeId)->loadByRequestPath($requestPath);
        if ($existing->getId()) {
            throw Lotse_Connector_Model_Exception::conflict('request_path ist im Store bereits belegt (Rewrite ' . $existing->getId() . ').');
        }
        $rewrite = Mage::getModel('core/url_rewrite')->setData([
            'store_id' => $storeId,
            'id_path' => isset($body['id_path']) ? (string) $body['id_path'] : 'lotse/' . bin2hex(random_bytes(6)),
            'request_path' => $requestPath,
            'target_path' => $targetPath,
            'is_system' => 0,
            'options' => $options,
            'description' => isset($body['description']) ? (string) $body['description'] : 'Lotse',
            'category_id' => $categoryId,
            'product_id' => $productId,
        ]);
        $rewrite->save();
        $this->status = 201;
        return ['data' => $this->formatRewrite($this->loadRewrite($rewrite->getId()))];
    }

    /** DELETE /v1/urlrewrites/{id}: nur eigene Rewrites (is_system=0), System-Rewrites verwaltet der Indexer. */
    public function deleteRewrite(array $params)
    {
        $rewrite = $this->loadRewrite($params['id']);
        if ($rewrite->getIsSystem() && $this->q('force') !== '1') {
            throw Lotse_Connector_Model_Exception::validation('System-Rewrite; nur mit ?force=1 löschbar (der Indexer legt ihn ggf. neu an).');
        }
        $before = $this->formatRewrite($rewrite);
        $rewrite->delete();
        return ['data' => ['deleted' => true, 'id' => $before['id'], 'before' => $before]];
    }
}
