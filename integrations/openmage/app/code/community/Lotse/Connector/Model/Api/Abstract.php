<?php
/**
 * Base of the API domain models: context (store, query, body), pagination, validation,
 * EAV helpers for "Use Default Value" (delete store value) and indexer calls.
 */
abstract class Lotse_Connector_Model_Api_Abstract
{
    public const MAX_LIMIT = 200;

    /** @var int 0 = global scope */
    protected $storeId = 0;
    /** @var array */
    protected $query = [];
    /** @var array|null */
    protected $body;
    /** @var int|null HTTP status of the response (default 200) */
    protected $status;

    public function setContext($storeId, array $query, $body)
    {
        $this->storeId = (int) $storeId;
        $this->query = $query;
        $this->body = $body;
        return $this;
    }

    public function getStatus()
    {
        return $this->status;
    }

    /** Store object for URLs: requested store, or default store view for scope 0. */
    protected function getUrlStore()
    {
        if ($this->storeId > 0) {
            return Mage::app()->getStore($this->storeId);
        }
        return Mage::app()->getDefaultStoreView();
    }

    protected function q($key, $default = null)
    {
        if (!array_key_exists($key, $this->query)) {
            return $default;
        }
        $v = $this->query[$key];
        if (!is_scalar($v)) {
            throw Lotse_Connector_Model_Exception::validation('Query-Parameter muss ein einzelner Wert sein: ' . $key, ['field' => $key]);
        }
        return is_string($v) ? trim($v) : $v;
    }

    /** Escapes %, _ and \ for LIKE filters built from user input. */
    protected function escapeLike($value)
    {
        return Lotse_Connector_Model_Util::escapeLike($value);
    }

    /**
     * Validates layout XML like the admin does (adminhtml/layoutUpdate_validator): no template paths with "../",
     * no helper= attributes, no setTemplate actions, no blocked blocks. Empty = allowed.
     */
    protected function validateLayoutXml($xml, $field)
    {
        if (is_array($xml)) {
            throw Lotse_Connector_Model_Exception::validation('Skalarer Wert erwartet: ' . $field, ['field' => $field]);
        }
        $xml = trim((string) $xml);
        if ($xml === '') {
            return $xml;
        }
        $validator = Mage::getModel('adminhtml/layoutUpdate_validator');
        try {
            $valid = $validator->isValid($xml);
            $messages = array_values(array_map('strval', $validator->getMessages()));
        } catch (Throwable $e) {
            // OpenMage 20.x on PHP 8: the validator throws TypeError when it rejects before the value is set
            // (invalid XML, template path, blocked block). Treated as rejected, as in the admin.
            $valid = false;
            $messages = ['Ungültiges XML oder nicht erlaubte Template-/Block-Direktive.'];
        }
        if (!$valid) {
            throw Lotse_Connector_Model_Exception::validation(
                'Layout-XML nicht erlaubt (' . $field . '): ' . implode(' ', $messages),
                ['field' => $field, 'messages' => $messages]
            );
        }
        return $xml;
    }

    protected function body()
    {
        if (!is_array($this->body)) {
            throw Lotse_Connector_Model_Exception::validation('JSON-Body erwartet.');
        }
        return $this->body;
    }

    protected function requireField(array $data, $key)
    {
        if (!array_key_exists($key, $data) || $data[$key] === null || $data[$key] === '') {
            throw Lotse_Connector_Model_Exception::validation('Feld fehlt: ' . $key, ['field' => $key]);
        }
        return $data[$key];
    }

    protected function intParam($value, $name)
    {
        if (!is_numeric($value) || (int) $value != $value) {
            throw Lotse_Connector_Model_Exception::validation('Ganzzahl erwartet: ' . $name, ['field' => $name]);
        }
        return (int) $value;
    }

    /** @return array{page:int,limit:int} */
    protected function pagination()
    {
        return Lotse_Connector_Model_Util::pagination(['page' => $this->q('page', 1), 'limit' => $this->q('limit', 50)]);
    }

    /** Standard response for lists. */
    protected function listResponse(array $items, $page, $limit, $total)
    {
        return ['data' => array_values($items), 'meta' => [
            'page' => (int) $page,
            'limit' => (int) $limit,
            'total' => (int) $total,
            'pages' => $limit > 0 ? (int) ceil($total / $limit) : 0,
        ]];
    }

    /** Sorting from ?sort=<field>&dir=asc|desc, allowed fields only. */
    protected function sorting(array $allowed, $default)
    {
        $sort = (string) $this->q('sort', $default);
        if (!in_array($sort, $allowed, true)) {
            throw Lotse_Connector_Model_Exception::validation('Unbekanntes Sortierfeld: ' . $sort, ['allowed' => $allowed]);
        }
        $dir = strtolower((string) $this->q('dir', 'asc')) === 'desc' ? 'DESC' : 'ASC';
        return [$sort, $dir];
    }

    /** Store codes to IDs (with 0 = all). */
    protected function storeIdsToCodes(array $ids)
    {
        $out = [];
        foreach ($ids as $id) {
            $id = (int) $id;
            if ($id === 0) {
                $out[] = ['id' => 0, 'code' => 'admin', 'name' => 'Alle Store-Views'];
                continue;
            }
            try {
                $store = Mage::app()->getStore($id);
                $out[] = ['id' => $id, 'code' => $store->getCode(), 'name' => $store->getName()];
            } catch (Exception $e) {
                $out[] = ['id' => $id, 'code' => null, 'name' => null];
            }
        }
        return $out;
    }

    /** Accepts store IDs or codes (0/"admin" = all) and returns IDs. */
    protected function storeIdsFromInput($stores)
    {
        if (!is_array($stores)) {
            throw Lotse_Connector_Model_Exception::validation('stores muss eine Liste von Store-Codes oder -IDs sein.');
        }
        $ids = [];
        foreach ($stores as $s) {
            if ($s === 0 || $s === '0' || $s === 'admin' || $s === 'all') {
                $ids[] = 0;
                continue;
            }
            try {
                $ids[] = (int) Mage::app()->getStore($s)->getId();
            } catch (Exception $e) {
                throw Lotse_Connector_Model_Exception::validation('Unbekannter Store: ' . $s);
            }
        }
        return array_values(array_unique($ids));
    }

    /** URL key like OpenMage (slugger with the store's locale; store 0 = default store view). */
    protected function formatUrlKey($value, $storeId = null)
    {
        $storeId = $storeId === null ? $this->storeId : (int) $storeId;
        $locale = (string) Mage::getStoreConfig('general/locale/code', $storeId > 0 ? $storeId : Mage::app()->getDefaultStoreView()->getId());
        return Mage::getSingleton('catalog/url')->setLocale($locale ?: 'en_US')->formatUrlKey($value);
    }

    protected function formatDate($value)
    {
        return Lotse_Connector_Model_Util::formatDate($value);
    }

    protected function formatDecimal($value)
    {
        if ($value === null || $value === '') {
            return null;
        }
        return (float) $value;
    }

    /**
     * Attribute codes that have their own value for the entity in the given store (!= 0).
     * Basis for exact undo ("Use Default Value").
     * @return string[]
     */
    protected function storeOverrides($entityTypeCode, $entityId, $storeId)
    {
        if ((int) $storeId === 0) {
            return [];
        }
        $resource = Mage::getSingleton('core/resource');
        $read = $resource->getConnection('core_read');
        $entityType = Mage::getSingleton('eav/config')->getEntityType($entityTypeCode);
        $base = $resource->getTableName($entityType->getEntityTable());
        $codes = [];
        foreach (['varchar', 'int', 'decimal', 'text', 'datetime'] as $type) {
            $select = $read->select()
                ->from(['v' => $base . '_' . $type], [])
                ->join(['a' => $resource->getTableName('eav/attribute')], 'a.attribute_id = v.attribute_id', ['attribute_code'])
                ->where('v.entity_id = ?', (int) $entityId)
                ->where('v.store_id = ?', (int) $storeId)
                ->where('a.entity_type_id = ?', (int) $entityType->getId());
            foreach ($read->fetchCol($select) as $code) {
                $codes[] = $code;
            }
        }
        sort($codes);
        return $codes;
    }

    /**
     * Deletes the store-specific value of an attribute (= "Use Default Value").
     * Only for store != 0; in the global scope there is no default value to fall back to.
     * Website attributes (e.g. price with price scope Website) are deleted in all store views of the website,
     * because updateAttributes writes them in all of those too.
     */
    protected function deleteStoreValue($entityTypeCode, $entityId, $attributeCode, $storeId)
    {
        if ((int) $storeId === 0) {
            throw Lotse_Connector_Model_Exception::validation(
                'null („Standardwert verwenden“) gibt es nur im Store-View-Scope; zum Leeren im globalen Scope "" senden.',
                ['field' => $attributeCode]
            );
        }
        $attribute = Mage::getSingleton('eav/config')->getAttribute($entityTypeCode, $attributeCode);
        if (!$attribute || !$attribute->getId()) {
            throw Lotse_Connector_Model_Exception::validation('Unbekanntes Attribut: ' . $attributeCode);
        }
        if ($attribute->getBackendType() === 'static') {
            throw Lotse_Connector_Model_Exception::validation('Attribut hat keinen Store-Wert: ' . $attributeCode);
        }
        $storeIds = [(int) $storeId];
        if ($attribute->isScopeWebsite()) {
            $storeIds = array_map('intval', Mage::app()->getStore($storeId)->getWebsite()->getStoreIds());
        }
        $write = Mage::getSingleton('core/resource')->getConnection('core_write');
        $table = $attribute->getBackend()->getTable();
        return $write->delete($table, [
            'entity_id = ?' => (int) $entityId,
            'attribute_id = ?' => (int) $attribute->getId(),
            'store_id IN (?)' => $storeIds,
        ]);
    }

    /** All attributes (code => attribute) of an attribute set of an entity. */
    protected function attributesOfSet($entityTypeCode, $attributeSetId)
    {
        $out = [];
        $collection = Mage::getResourceModel('eav/entity_attribute_collection')
            ->setEntityTypeFilter(Mage::getSingleton('eav/config')->getEntityType($entityTypeCode)->getId())
            ->setAttributeSetFilter((int) $attributeSetId)
            ->addSetInfo();
        foreach ($collection as $attribute) {
            $out[$attribute->getAttributeCode()] = $attribute;
        }
        return $out;
    }
}
