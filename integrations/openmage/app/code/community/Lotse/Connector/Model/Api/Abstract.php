<?php
/**
 * Basis der API-Fachmodelle: Kontext (Store, Query, Body), Paginierung, Validierung,
 * EAV-Helfer für „Standardwert verwenden“ (Store-Wert löschen) und Indexer-Aufrufe.
 */
abstract class Lotse_Connector_Model_Api_Abstract
{
    public const MAX_LIMIT = 200;

    /** @var int 0 = globaler Scope */
    protected $storeId = 0;
    /** @var array */
    protected $query = [];
    /** @var array|null */
    protected $body;
    /** @var int|null HTTP-Status der Antwort (Standard 200) */
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

    /** Store-Objekt für URLs: angefragter Store oder Default-Store-View bei Scope 0. */
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

    /** Escaped %, _ und \ für LIKE-Filter aus Nutzereingaben. */
    protected function escapeLike($value)
    {
        return Lotse_Connector_Model_Util::escapeLike($value);
    }

    /**
     * Prüft Layout-XML wie der Admin (adminhtml/layoutUpdate_validator): keine Template-Pfade mit "../",
     * keine helper=-Attribute, keine setTemplate-Aktionen, keine gesperrten Blöcke. Leer = erlaubt.
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
            // OpenMage 20.x unter PHP 8: Validator wirft TypeError, wenn er vor dem Setzen des Werts ablehnt
            // (ungültiges XML, Template-Pfad, gesperrter Block). Gilt als abgelehnt, wie im Admin.
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

    /** Standard-Antwort für Listen. */
    protected function listResponse(array $items, $page, $limit, $total)
    {
        return ['data' => array_values($items), 'meta' => [
            'page' => (int) $page,
            'limit' => (int) $limit,
            'total' => (int) $total,
            'pages' => $limit > 0 ? (int) ceil($total / $limit) : 0,
        ]];
    }

    /** Sortierung aus ?sort=<feld>&dir=asc|desc, nur erlaubte Felder. */
    protected function sorting(array $allowed, $default)
    {
        $sort = (string) $this->q('sort', $default);
        if (!in_array($sort, $allowed, true)) {
            throw Lotse_Connector_Model_Exception::validation('Unbekanntes Sortierfeld: ' . $sort, ['allowed' => $allowed]);
        }
        $dir = strtolower((string) $this->q('dir', 'asc')) === 'desc' ? 'DESC' : 'ASC';
        return [$sort, $dir];
    }

    /** Store-Codes zu IDs (mit 0 = alle). */
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

    /** Akzeptiert Store-IDs oder -Codes (0/"admin" = alle) und liefert IDs. */
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

    /** URL-Schlüssel wie OpenMage (Slugger mit Locale des Stores; Store 0 = Default-Store-View). */
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
     * Attribut-Codes, die für die Entität im gegebenen Store (≠ 0) einen eigenen Wert haben.
     * Grundlage für exaktes Rückgängig („Standardwert verwenden“).
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
     * Löscht den Store-spezifischen Wert eines Attributs (= „Standardwert verwenden“).
     * Nur für Store ≠ 0; im globalen Scope gibt es keinen Standardwert, auf den man zurückfällt.
     * Website-Attribute (z. B. price bei Preis-Scope Website) werden in allen Store-Views der Website gelöscht,
     * weil updateAttributes sie dort auch alle schreibt.
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

    /** Alle Attribute (Code => Attribut) eines Attributsets einer Entität. */
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
