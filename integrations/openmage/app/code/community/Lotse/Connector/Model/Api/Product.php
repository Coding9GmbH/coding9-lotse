<?php
/**
 * Produkte: Liste, Detail, Attribute schreiben (Store-Scope, null = Standardwert verwenden),
 * anlegen (simple, configurable), löschen, Bestand, Kategoriezuordnungen.
 * Alle Schreibmethoden liefern den vollständigen neuen Stand, damit Lotse exaktes Rückgängig bauen kann.
 */
class Lotse_Connector_Model_Api_Product extends Lotse_Connector_Model_Api_Abstract
{
    /** Attribute, die über /products nicht direkt geschrieben werden (eigene Endpunkte oder Systemfelder). */
    public const READ_ONLY_ATTRIBUTES = [
        'entity_id', 'entity_type_id', 'attribute_set_id', 'type_id', 'created_at', 'updated_at',
        'media_gallery', 'gallery', 'tier_price', 'group_price', 'has_options', 'required_options',
        'category_ids', 'website_ids', 'sku',
    ];

    protected const LIST_ATTRIBUTES = [
        'name', 'sku', 'price', 'special_price', 'special_from_date', 'special_to_date', 'status', 'visibility',
        'url_key', 'url_path', 'image', 'small_image', 'thumbnail', 'tax_class_id', 'weight', 'updated_at', 'created_at',
    ];

    // ---------- Lesen ----------

    public function listProducts(array $params)
    {
        $pg = $this->pagination();
        list($sort, $dir) = $this->sorting(['entity_id', 'sku', 'name', 'price', 'updated_at', 'created_at', 'status'], 'entity_id');

        $extra = $this->extraListAttributes();
        $with = array_filter(array_map('trim', explode(',', (string) $this->q('with', ''))));
        $withImages = in_array('images', $with, true);

        /** @var Mage_Catalog_Model_Resource_Product_Collection $collection */
        $collection = Mage::getModel('catalog/product')->getCollection()
            ->setStoreId($this->storeId)
            ->addAttributeToSelect(array_merge(self::LIST_ATTRIBUTES, array_keys($extra)));
        if ($this->storeId > 0) {
            $collection->addStoreFilter($this->storeId);
        }
        $this->applyFilters($collection);
        $collection->joinField('qty', 'cataloginventory/stock_item', 'qty', 'product_id=entity_id', '{{table}}.stock_id=1', 'left');
        $collection->joinField('is_in_stock', 'cataloginventory/stock_item', 'is_in_stock', 'product_id=entity_id', '{{table}}.stock_id=1', 'left');
        if ($sort === 'entity_id') {
            $collection->getSelect()->order('e.entity_id ' . $dir);
        } else {
            $collection->addAttributeToSort($sort, $dir);
        }
        $collection->setPageSize($pg['limit'])->setCurPage($pg['page']);
        $total = $collection->getSize();
        $collection->addCategoryIds()->addWebsiteNamesToResult();

        $media = $withImages ? Mage::getModel('lotse_connector/api_media')->setContext($this->storeId, [], null) : null;
        $items = [];
        foreach ($collection as $product) {
            $item = $this->formatListItem($product);
            if ($extra) {
                $item['attributes'] = [];
                foreach ($extra as $code => $attribute) {
                    $item['attributes'][$code] = $this->castValue($attribute, $product->getData($code));
                }
            }
            if ($media) {
                $this->loadGallery($product);
                $item['images'] = $media->formatImages($product);
            }
            $items[] = $item;
        }
        return $this->listResponse($items, $pg['page'], $pg['limit'], $total);
    }

    /**
     * ?fields=code,code: weitere Attribute je Listeneintrag (unter "attributes"), z. B. description, meta_title.
     * Nur vorhandene Produktattribute; Galerie- und Staffelpreis-Attribute sind ausgeschlossen (Detail-Endpunkt).
     * @return array code => Mage_Eav_Model_Entity_Attribute
     */
    protected function extraListAttributes()
    {
        $out = [];
        $raw = (string) $this->q('fields', '');
        if ($raw === '') {
            return $out;
        }
        $config = Mage::getSingleton('eav/config');
        foreach (array_unique(array_filter(array_map('trim', explode(',', $raw)))) as $code) {
            if (!preg_match('/^[a-z][a-z0-9_]{0,59}$/', $code) || in_array($code, ['media_gallery', 'gallery', 'tier_price', 'group_price'], true)) {
                throw Lotse_Connector_Model_Exception::validation('fields: Attribut nicht erlaubt: ' . $code, ['field' => 'fields']);
            }
            $attribute = $config->getAttribute(Mage_Catalog_Model_Product::ENTITY, $code);
            if (!$attribute || !$attribute->getId()) {
                throw Lotse_Connector_Model_Exception::validation('fields: Attribut unbekannt: ' . $code, ['field' => 'fields']);
            }
            $out[$code] = $attribute;
        }
        return $out;
    }

    /** Galerie eines Collection-Produkts nachladen (wie beim Laden eines Einzelprodukts). */
    protected function loadGallery(Mage_Catalog_Model_Product $product)
    {
        $attribute = Mage::getSingleton('eav/config')->getAttribute(Mage_Catalog_Model_Product::ENTITY, 'media_gallery');
        $backend = $attribute->getBackend();
        $backend->setAttribute($attribute);
        $backend->afterLoad($product);
    }

    protected function applyFilters(Mage_Catalog_Model_Resource_Product_Collection $collection)
    {
        if (($v = $this->q('sku')) !== null && $v !== '') {
            $collection->addAttributeToFilter('sku', ['like' => '%' . $this->escapeLike($v) . '%']);
        }
        if (($v = $this->q('skus')) !== null && $v !== '') {
            $collection->addAttributeToFilter('sku', ['in' => array_map('trim', explode(',', $v))]);
        }
        if (($v = $this->q('ids')) !== null && $v !== '') {
            $collection->addIdFilter(array_map('intval', explode(',', $v)));
        }
        if (($v = $this->q('name')) !== null && $v !== '') {
            $collection->addAttributeToFilter('name', ['like' => '%' . $this->escapeLike($v) . '%']);
        }
        if (($v = $this->q('term')) !== null && $v !== '') {
            // Suchbegriff in Name ODER SKU (eine Abfrage, damit Paginierung und total stimmen)
            $like = '%' . $this->escapeLike($v) . '%';
            $collection->addAttributeToFilter([['attribute' => 'name', 'like' => $like], ['attribute' => 'sku', 'like' => $like]]);
        }
        if (($v = $this->q('category_id')) !== null && $v !== '') {
            $collection->joinField('category_position', 'catalog/category_product', 'position', 'product_id=entity_id', 'category_id=' . $this->intParam($v, 'category_id'), 'inner');
        }
        if (($v = $this->q('status')) !== null && $v !== '') {
            $collection->addAttributeToFilter('status', (int) $v);
        }
        if (($v = $this->q('visibility')) !== null && $v !== '') {
            $collection->addAttributeToFilter('visibility', ['in' => array_map('intval', explode(',', $v))]);
        }
        if (($v = $this->q('type')) !== null && $v !== '') {
            $collection->addAttributeToFilter('type_id', ['in' => array_map('trim', explode(',', $v))]);
        }
        if (($v = $this->q('attribute_set_id')) !== null && $v !== '') {
            $collection->addAttributeToFilter('attribute_set_id', (int) $v);
        }
        if (($v = $this->q('price_from')) !== null && $v !== '') {
            $collection->addAttributeToFilter('price', ['gteq' => (float) $v]);
        }
        if (($v = $this->q('price_to')) !== null && $v !== '') {
            $collection->addAttributeToFilter('price', ['lteq' => (float) $v]);
        }
        if (($v = $this->q('updated_from')) !== null && $v !== '') {
            $collection->addAttributeToFilter('updated_at', ['gteq' => $v]);
        }
        if (($v = $this->q('website_id')) !== null && $v !== '') {
            $collection->addWebsiteFilter([(int) $v]);
        }
    }

    protected function formatListItem(Mage_Catalog_Model_Product $product)
    {
        $websites = [];
        foreach ((array) $product->getWebsiteIds() as $wid) {
            $websites[] = (int) $wid;
        }
        return [
            'id' => (int) $product->getId(),
            'sku' => $product->getSku(),
            'type_id' => $product->getTypeId(),
            'attribute_set_id' => (int) $product->getAttributeSetId(),
            'name' => $product->getName(),
            'status' => (int) $product->getStatus(),
            'visibility' => (int) $product->getVisibility(),
            'price' => $this->formatDecimal($product->getPrice()),
            'special_price' => $this->formatDecimal($product->getSpecialPrice()),
            'special_from_date' => $this->formatDate($product->getSpecialFromDate()),
            'special_to_date' => $this->formatDate($product->getSpecialToDate()),
            'tax_class_id' => $product->getTaxClassId() === null ? null : (int) $product->getTaxClassId(),
            'weight' => $this->formatDecimal($product->getWeight()),
            'url_key' => $product->getUrlKey(),
            'image' => $product->getImage(),
            'qty' => $product->getData('qty') === null ? null : (float) $product->getData('qty'),
            'is_in_stock' => $product->getData('is_in_stock') === null ? null : (bool) $product->getData('is_in_stock'),
            'category_ids' => array_map('intval', (array) $product->getCategoryIds()),
            'website_ids' => $websites,
            'created_at' => $this->formatDate($product->getCreatedAt()),
            'updated_at' => $this->formatDate($product->getUpdatedAt()),
        ];
    }

    public function getProduct(array $params)
    {
        $product = $this->loadProduct($params['sku']);
        return ['data' => $this->formatProduct($product)];
    }

    /** Produkt per SKU (oder "id:<n>") im aktuellen Store-Scope laden. */
    public function loadProduct($skuOrId, $storeId = null)
    {
        $storeId = $storeId === null ? $this->storeId : (int) $storeId;
        $id = $this->resolveProductId($skuOrId);
        $product = Mage::getModel('catalog/product')->setStoreId($storeId)->load($id);
        if (!$product->getId()) {
            throw Lotse_Connector_Model_Exception::notFound('Produkt nicht gefunden: ' . $skuOrId);
        }
        return $product;
    }

    public function resolveProductId($skuOrId)
    {
        $skuOrId = (string) $skuOrId;
        if (strpos($skuOrId, 'id:') === 0) {
            $id = (int) substr($skuOrId, 3);
        } else {
            $id = (int) Mage::getModel('catalog/product')->getIdBySku($skuOrId);
        }
        if ($id <= 0) {
            throw Lotse_Connector_Model_Exception::notFound('Produkt nicht gefunden: ' . $skuOrId);
        }
        return $id;
    }

    public function formatProduct(Mage_Catalog_Model_Product $product)
    {
        $attributes = [];
        $labels = [];
        foreach ($this->attributesOfSet(Mage_Catalog_Model_Product::ENTITY, $product->getAttributeSetId()) as $code => $attribute) {
            if (in_array($code, ['media_gallery', 'gallery', 'tier_price', 'group_price'], true)) {
                continue;
            }
            $value = $product->getData($code);
            $attributes[$code] = $this->castValue($attribute, $value);
            if ($value !== null && $value !== '' && in_array($attribute->getFrontendInput(), ['select', 'multiselect', 'boolean'], true)) {
                try {
                    $text = $product->getAttributeText($code);
                    if ($text !== false && $text !== null) {
                        $labels[$code] = is_array($text) ? array_values($text) : (string) $text;
                    }
                } catch (Exception $e) {
                    // Attribute ohne Quelle: kein Label
                }
            }
        }
        ksort($attributes);

        $stock = $this->formatStock($this->stockItem($product->getId()));
        $data = [
            'id' => (int) $product->getId(),
            'sku' => $product->getSku(),
            'type_id' => $product->getTypeId(),
            'attribute_set_id' => (int) $product->getAttributeSetId(),
            'store_id' => $this->storeId,
            'name' => $product->getName(),
            'status' => (int) $product->getStatus(),
            'visibility' => (int) $product->getVisibility(),
            'price' => $this->formatDecimal($product->getPrice()),
            'special_price' => $this->formatDecimal($product->getSpecialPrice()),
            'special_from_date' => $this->formatDate($product->getSpecialFromDate()),
            'special_to_date' => $this->formatDate($product->getSpecialToDate()),
            'cost' => $this->formatDecimal($product->getData('cost')),
            'tax_class_id' => $product->getTaxClassId() === null ? null : (int) $product->getTaxClassId(),
            'weight' => $this->formatDecimal($product->getWeight()),
            'url_key' => $product->getUrlKey(),
            'url_path' => $product->getData('url_path'),
            'url' => $this->productUrl($product),
            'created_at' => $this->formatDate($product->getCreatedAt()),
            'updated_at' => $this->formatDate($product->getUpdatedAt()),
            'attributes' => $attributes,
            'attribute_labels' => $labels,
            'store_overrides' => $this->storeOverrides(Mage_Catalog_Model_Product::ENTITY, $product->getId(), $this->storeId),
            'stock' => $stock,
            'website_ids' => array_map('intval', (array) $product->getWebsiteIds()),
            'categories' => $this->categoryAssignments($product->getId()),
            'images' => Mage::getModel('lotse_connector/api_media')->setContext($this->storeId, [], null)->formatImages($product),
            'tier_prices' => $this->tierPrices($product),
        ];
        if ($product->getTypeId() === Mage_Catalog_Model_Product_Type::TYPE_CONFIGURABLE) {
            $data['configurable'] = $this->configurableInfo($product);
        }
        if ($product->getTypeId() === Mage_Catalog_Model_Product_Type::TYPE_SIMPLE) {
            $data['parent_ids'] = array_map('intval', Mage::getResourceSingleton('catalog/product_type_configurable')->getParentIdsByChild($product->getId()));
        }
        return $data;
    }

    protected function castValue($attribute, $value)
    {
        if ($value === null) {
            return null;
        }
        if (is_array($value)) {
            return $value;
        }
        switch ($attribute->getBackendType()) {
            case 'decimal':
                return $value === '' ? null : (float) $value;
            case 'int':
                return $value === '' ? null : (int) $value;
            case 'datetime':
                return $this->formatDate($value);
        }
        if ($attribute->getFrontendInput() === 'multiselect' && is_string($value)) {
            return $value === '' ? [] : array_map('intval', explode(',', $value));
        }
        return (string) $value;
    }

    protected function tierPrices(Mage_Catalog_Model_Product $product)
    {
        $out = [];
        foreach ((array) $product->getData('tier_price') as $tp) {
            $out[] = [
                'website_id' => (int) ($tp['website_id'] ?? 0),
                'all_groups' => (bool) ($tp['all_groups'] ?? ($tp['cust_group'] == Mage_Customer_Model_Group::CUST_GROUP_ALL)),
                'customer_group_id' => (int) ($tp['cust_group'] ?? 0),
                'qty' => (float) ($tp['price_qty'] ?? 0),
                'price' => (float) ($tp['price'] ?? 0),
            ];
        }
        return $out;
    }

    protected function productUrl(Mage_Catalog_Model_Product $product)
    {
        $store = $this->getUrlStore();
        if (!$store) {
            return null;
        }
        $read = Mage::getSingleton('core/resource')->getConnection('core_read');
        $select = $read->select()
            ->from(Mage::getSingleton('core/resource')->getTableName('core/url_rewrite'), 'request_path')
            ->where('product_id = ?', (int) $product->getId())
            ->where('store_id = ?', (int) $store->getId())
            ->where('category_id IS NULL')
            ->where('is_system = 1')
            ->limit(1);
        $path = $read->fetchOne($select);
        if (!$path) {
            return null;
        }
        return $store->getBaseUrl(Mage_Core_Model_Store::URL_TYPE_LINK) . $path;
    }

    protected function categoryAssignments($productId)
    {
        $resource = Mage::getSingleton('core/resource');
        $read = $resource->getConnection('core_read');
        $rows = $read->fetchPairs($read->select()
            ->from($resource->getTableName('catalog/category_product'), ['category_id', 'position'])
            ->where('product_id = ?', (int) $productId));
        if ($rows === []) {
            return [];
        }
        $names = [];
        $collection = Mage::getModel('catalog/category')->getCollection()
            ->setStoreId($this->storeId)
            ->addAttributeToSelect(['name', 'url_key'])
            ->addIdFilter(array_keys($rows));
        foreach ($collection as $category) {
            $names[(int) $category->getId()] = ['name' => $category->getName(), 'path' => $category->getPath()];
        }
        $out = [];
        foreach ($rows as $cid => $position) {
            $out[] = [
                'id' => (int) $cid,
                'position' => (int) $position,
                'name' => $names[(int) $cid]['name'] ?? null,
                'path' => $names[(int) $cid]['path'] ?? null,
            ];
        }
        usort($out, function ($a, $b) {
            return $a['id'] <=> $b['id'];
        });
        return $out;
    }

    protected function configurableInfo(Mage_Catalog_Model_Product $product)
    {
        /** @var Mage_Catalog_Model_Product_Type_Configurable $type */
        $type = $product->getTypeInstance(true);
        $attributes = [];
        $codes = [];
        foreach ($type->getConfigurableAttributes($product) as $attribute) {
            $pa = $attribute->getProductAttribute();
            $pa->setStoreId($this->storeId);
            $codes[] = $pa->getAttributeCode();
            $attributes[] = [
                'id' => (int) $attribute->getId(),
                'attribute_id' => (int) $pa->getId(),
                'code' => $pa->getAttributeCode(),
                'label' => $attribute->getLabel(),
                'position' => (int) $attribute->getPosition(),
                'options' => Mage::getModel('lotse_connector/api_attribute')->options($pa),
            ];
        }
        $children = [];
        foreach ($type->getUsedProducts(null, $product) as $child) {
            $values = [];
            foreach ($codes as $code) {
                $values[$code] = $child->getData($code) === null ? null : (int) $child->getData($code);
            }
            $stock = $this->stockItem($child->getId());
            $children[] = [
                'id' => (int) $child->getId(),
                'sku' => $child->getSku(),
                'name' => $child->getName(),
                'status' => (int) $child->getStatus(),
                'price' => $this->formatDecimal($child->getPrice()),
                'attributes' => $values,
                'qty' => (float) $stock->getQty(),
                'is_in_stock' => (bool) $stock->getIsInStock(),
            ];
        }
        return ['attributes' => $attributes, 'children' => $children];
    }

    // ---------- Attribute schreiben ----------

    /**
     * PATCH /v1/products/{sku} mit {"attributes": {code: wert|null}}.
     * Wert: schreibt im Scope des Stores (0 = global). null: entfernt den Store-Wert (Standardwert verwenden).
     */
    public function updateProduct(array $params)
    {
        $body = $this->body();
        $input = $body['attributes'] ?? null;
        if (!is_array($input) || $input === []) {
            throw Lotse_Connector_Model_Exception::validation('attributes (Objekt code => wert) fehlt.');
        }
        $product = $this->loadProduct($params['sku']);
        list($set, $revert) = $this->prepareAttributeInput($input, $product);
        $urlKeyChanged = array_key_exists('url_key', $set) || in_array('url_key', $revert, true);
        $rewritesBefore = $urlKeyChanged ? $this->rewriteIds($product->getId()) : [];

        if ($set !== []) {
            Mage::getSingleton('catalog/product_action')->updateAttributes([$product->getId()], $set, $this->storeId);
        }
        foreach ($revert as $code) {
            $this->deleteStoreValue(Mage_Catalog_Model_Product::ENTITY, $product->getId(), $code, $this->storeId);
        }
        if ($revert !== []) {
            $this->touchUpdatedAt($product->getId());
            Mage::getSingleton('index/indexer')->processEntityAction(
                new Varien_Object(['product_ids' => [$product->getId()], 'attributes_data' => array_fill_keys($revert, null), 'store_id' => $this->storeId]),
                Mage_Catalog_Model_Product::ENTITY,
                Mage_Index_Model_Event::TYPE_MASS_ACTION
            );
        }
        $reindexed = [];
        $rewritesAdded = [];
        if ($urlKeyChanged) {
            Mage::getSingleton('catalog/url')->refreshProductRewrite($product->getId(), $this->storeId > 0 ? $this->storeId : null);
            $reindexed[] = 'catalog_url';
            // Mit „Save Rewrites History“ legt OpenMage 301-Weiterleitungen an; Lotse löscht sie beim Rückgängig.
            $rewritesAdded = array_values(array_diff($this->rewriteIds($product->getId()), $rewritesBefore));
        }
        $fresh = $this->loadProduct('id:' . $product->getId());
        $data = $this->formatProduct($fresh);
        $data['_write'] = ['updated' => array_keys($set), 'reverted' => $revert, 'reindexed' => $reindexed, 'rewrites_added' => $rewritesAdded];
        return ['data' => $data];
    }

    /**
     * Prüft Attributcodes und bereitet Werte auf.
     * @return array{0: array, 1: string[]} [zu setzende Werte, Codes für „Standardwert verwenden“]
     */
    protected function prepareAttributeInput(array $input, Mage_Catalog_Model_Product $product, $storeId = null)
    {
        $storeId = $storeId === null ? $this->storeId : (int) $storeId;
        $set = [];
        $revert = [];
        $eav = Mage::getSingleton('eav/config');
        foreach ($input as $code => $value) {
            $code = (string) $code;
            if (in_array($code, self::READ_ONLY_ATTRIBUTES, true)) {
                throw Lotse_Connector_Model_Exception::validation('Attribut nicht über diesen Endpunkt schreibbar: ' . $code, ['field' => $code]);
            }
            $attribute = $eav->getAttribute(Mage_Catalog_Model_Product::ENTITY, $code);
            if (!$attribute || !$attribute->getId()) {
                throw Lotse_Connector_Model_Exception::validation('Unbekanntes Attribut: ' . $code, ['field' => $code]);
            }
            if ($value === null) {
                if ($storeId === 0) {
                    throw Lotse_Connector_Model_Exception::validation(
                        'null gibt es nur im Store-View-Scope (Standardwert verwenden); zum Leeren im globalen Scope "" senden.',
                        ['field' => $code]
                    );
                }
                if (!$attribute->isScopeStore() && !$attribute->isScopeWebsite()) {
                    throw Lotse_Connector_Model_Exception::validation('Attribut ist global und hat keinen Store-Wert: ' . $code, ['field' => $code]);
                }
                $revert[] = $code;
                continue;
            }
            $set[$code] = $this->prepareValue($attribute, $value, $code, $storeId);
        }
        return [$set, $revert];
    }

    protected function prepareValue($attribute, $value, $code, $storeId = null)
    {
        if ($code === 'custom_layout_update') {
            // updateAttributes umgeht das Backend-Modell, darum hier prüfen wie der Admin
            return $this->validateLayoutXml($value, $code);
        }
        if (is_bool($value)) {
            return $value ? 1 : 0;
        }
        if (is_array($value)) {
            if ($attribute->getFrontendInput() !== 'multiselect') {
                throw Lotse_Connector_Model_Exception::validation('Liste nur für Multiselect-Attribute: ' . $code, ['field' => $code]);
            }
            return implode(',', array_map('strval', $value));
        }
        if (!is_scalar($value)) {
            throw Lotse_Connector_Model_Exception::validation('Skalarer Wert erwartet: ' . $code, ['field' => $code]);
        }
        if ($code === 'url_key' && (string) $value !== '') {
            return $this->formatUrlKey((string) $value, $storeId);
        }
        if ($attribute->getFrontendInput() === 'select' && is_string($value) && $value !== '' && !is_numeric($value)) {
            $optionId = $attribute->getSource()->getOptionId($value);
            if ($optionId === null || $optionId === false) {
                throw Lotse_Connector_Model_Exception::validation('Unbekannte Option „' . $value . '“ für ' . $code, ['field' => $code]);
            }
            return $optionId;
        }
        if (in_array($attribute->getBackendType(), ['decimal', 'int'], true) && $value !== '' && !is_numeric($value)) {
            throw Lotse_Connector_Model_Exception::validation('Zahl erwartet: ' . $code, ['field' => $code]);
        }
        return $value;
    }

    /** @return int[] IDs aller URL-Rewrites des Produkts */
    protected function rewriteIds($productId)
    {
        $resource = Mage::getSingleton('core/resource');
        $read = $resource->getConnection('core_read');
        return array_map('intval', $read->fetchCol($read->select()
            ->from($resource->getTableName('core/url_rewrite'), 'url_rewrite_id')
            ->where('product_id = ?', (int) $productId)));
    }

    protected function touchUpdatedAt($productId)
    {
        $resource = Mage::getSingleton('core/resource');
        $resource->getConnection('core_write')->update(
            $resource->getTableName('catalog/product'),
            ['updated_at' => Varien_Date::now()],
            ['entity_id = ?' => (int) $productId]
        );
    }

    // ---------- Anlegen / Löschen ----------

    /**
     * POST /v1/products: {sku, type_id, attribute_set_id?, website_ids?, attributes:{...}, stock?, categories?, configurable?}
     * Immer im globalen Scope (Store 0).
     */
    public function createProduct(array $params)
    {
        $body = $this->body();
        $sku = trim((string) $this->requireField($body, 'sku'));
        if (Mage::getModel('catalog/product')->getIdBySku($sku)) {
            throw Lotse_Connector_Model_Exception::conflict('SKU existiert bereits: ' . $sku);
        }
        $typeId = (string) ($body['type_id'] ?? Mage_Catalog_Model_Product_Type::TYPE_SIMPLE);
        if (!in_array($typeId, [Mage_Catalog_Model_Product_Type::TYPE_SIMPLE, Mage_Catalog_Model_Product_Type::TYPE_CONFIGURABLE, Mage_Catalog_Model_Product_Type::TYPE_VIRTUAL], true)) {
            throw Lotse_Connector_Model_Exception::validation('type_id muss simple, virtual oder configurable sein.');
        }
        $entityType = Mage::getSingleton('eav/config')->getEntityType(Mage_Catalog_Model_Product::ENTITY);
        $setId = isset($body['attribute_set_id']) ? $this->intParam($body['attribute_set_id'], 'attribute_set_id') : (int) $entityType->getDefaultAttributeSetId();

        $attributes = $body['attributes'] ?? [];
        if (!is_array($attributes)) {
            throw Lotse_Connector_Model_Exception::validation('attributes muss ein Objekt sein.');
        }
        if (!isset($attributes['name']) || trim((string) $attributes['name']) === '') {
            throw Lotse_Connector_Model_Exception::validation('attributes.name fehlt.', ['field' => 'name']);
        }
        $attributes += ['status' => 1, 'visibility' => 4, 'tax_class_id' => 0];
        if ($typeId !== Mage_Catalog_Model_Product_Type::TYPE_CONFIGURABLE && !isset($attributes['price'])) {
            throw Lotse_Connector_Model_Exception::validation('attributes.price fehlt.', ['field' => 'price']);
        }

        foreach ($attributes as $code => $value) {
            if ($value === null) {
                throw Lotse_Connector_Model_Exception::validation('null ist beim Anlegen nicht erlaubt (Attribut weglassen oder "" senden): ' . $code, ['field' => (string) $code]);
            }
        }
        $product = Mage::getModel('catalog/product')
            ->setStoreId(0)
            ->setTypeId($typeId)
            ->setAttributeSetId($setId)
            ->setSku($sku);
        // Anlage immer global (Store 0): url_key mit der Locale der Default-Store-View formatieren
        list($set) = $this->prepareAttributeInput($attributes, $product, 0);
        foreach ($set as $code => $value) {
            $product->setData($code, $value);
        }
        $websiteIds = isset($body['website_ids']) ? array_map('intval', (array) $body['website_ids']) : [(int) Mage::app()->getDefaultStoreView()->getWebsiteId()];
        $product->setWebsiteIds($websiteIds);
        if (isset($body['categories'])) {
            $product->setCategoryIds($this->categoryIdsFromInput($body['categories']));
        }
        $stock = is_array($body['stock'] ?? null) ? $body['stock'] : [];
        $stockData = ['use_config_manage_stock' => 1, 'is_in_stock' => (int) (bool) ($stock['is_in_stock'] ?? 0), 'qty' => (float) ($stock['qty'] ?? 0)];
        if (array_key_exists('manage_stock', $stock)) {
            $stockData['use_config_manage_stock'] = 0;
            $stockData['manage_stock'] = (int) (bool) $stock['manage_stock'];
        }
        $product->setStockData($stockData);

        if ($typeId === Mage_Catalog_Model_Product_Type::TYPE_CONFIGURABLE) {
            $this->applyConfigurable($product, is_array($body['configurable'] ?? null) ? $body['configurable'] : []);
        }

        $product->save();

        if (isset($body['categories']) && is_array($body['categories'])) {
            $this->applyCategoryPositions($product->getId(), $body['categories']);
        }

        $this->status = 201;
        return ['data' => $this->formatProduct($this->loadProduct('id:' . $product->getId()))];
    }

    protected function categoryIdsFromInput($categories)
    {
        $ids = [];
        foreach ((array) $categories as $c) {
            $ids[] = is_array($c) ? $this->intParam($c['id'] ?? null, 'categories[].id') : $this->intParam($c, 'categories[]');
        }
        return array_values(array_unique($ids));
    }

    /** Positionen aus [{id, position}] nachtragen (setCategoryIds kennt keine Positionen). */
    protected function applyCategoryPositions($productId, array $categories)
    {
        $resource = Mage::getSingleton('core/resource');
        $write = $resource->getConnection('core_write');
        foreach ($categories as $c) {
            if (is_array($c) && isset($c['position'])) {
                $write->update($resource->getTableName('catalog/category_product'), ['position' => (int) $c['position']], [
                    'product_id = ?' => (int) $productId,
                    'category_id = ?' => (int) $c['id'],
                ]);
            }
        }
    }

    protected function applyConfigurable(Mage_Catalog_Model_Product $product, array $conf)
    {
        $codes = $conf['attribute_codes'] ?? [];
        if (!is_array($codes) || $codes === []) {
            throw Lotse_Connector_Model_Exception::validation('configurable.attribute_codes fehlt.');
        }
        $eav = Mage::getSingleton('eav/config');
        $attributesData = [];
        $position = 0;
        foreach ($codes as $code) {
            $attribute = $eav->getAttribute(Mage_Catalog_Model_Product::ENTITY, (string) $code);
            if (!$attribute || !$attribute->getId()) {
                throw Lotse_Connector_Model_Exception::validation('Unbekanntes Attribut: ' . $code);
            }
            if (!$attribute->getIsGlobal() || !$attribute->getIsConfigurable() || $attribute->getFrontendInput() !== 'select') {
                throw Lotse_Connector_Model_Exception::validation('Attribut ist nicht konfigurierbar (global, select, is_configurable): ' . $code);
            }
            $attributesData[] = [
                'id' => null,
                'attribute_id' => (int) $attribute->getId(),
                'attribute_code' => $attribute->getAttributeCode(),
                'label' => $attribute->getFrontendLabel(),
                'use_default' => 1,
                'position' => $position++,
                'values' => [],
            ];
        }
        $childIds = [];
        foreach ((array) ($conf['children'] ?? []) as $child) {
            $childIds[$this->resolveProductId($child)] = [];
        }
        $product->setCanSaveConfigurableAttributes(true);
        $product->setConfigurableAttributesData($attributesData);
        $product->setConfigurableProductsData($childIds);
    }

    public function deleteProduct(array $params)
    {
        $product = $this->loadProduct($params['sku'], 0);
        $snapshot = $this->formatProduct($product);
        Mage::register('isSecureArea', true, true);
        try {
            $product->delete();
        } finally {
            Mage::unregister('isSecureArea');
        }
        return ['data' => ['deleted' => true, 'id' => $snapshot['id'], 'sku' => $snapshot['sku'], 'before' => $snapshot]];
    }

    // ---------- Bestand ----------

    protected function stockItem($productId)
    {
        $item = Mage::getModel('cataloginventory/stock_item')->loadByProduct((int) $productId);
        if (!$item->getId()) {
            $item->setProductId((int) $productId)->setStockId(Mage_CatalogInventory_Model_Stock::DEFAULT_STOCK_ID);
        }
        return $item;
    }

    protected function formatStock(Mage_CatalogInventory_Model_Stock_Item $item)
    {
        return [
            'item_id' => $item->getId() ? (int) $item->getId() : null,
            'qty' => (float) $item->getQty(),
            'is_in_stock' => (bool) $item->getIsInStock(),
            'manage_stock' => (bool) $item->getManageStock(),
            'use_config_manage_stock' => (bool) $item->getUseConfigManageStock(),
            'min_qty' => (float) $item->getMinQty(),
            'backorders' => (int) $item->getBackorders(),
            'min_sale_qty' => (float) $item->getMinSaleQty(),
            'max_sale_qty' => (float) $item->getMaxSaleQty(),
        ];
    }

    public function getStock(array $params)
    {
        $id = $this->resolveProductId($params['sku']);
        return ['data' => $this->formatStock($this->stockItem($id))];
    }

    /** PUT /v1/products/{sku}/stock mit {qty?, is_in_stock?, manage_stock?|null} (null = Konfiguration verwenden). */
    public function updateStock(array $params)
    {
        $body = $this->body();
        $id = $this->resolveProductId($params['sku']);
        $item = $this->stockItem($id);
        if (array_key_exists('qty', $body)) {
            if (!is_numeric($body['qty'])) {
                throw Lotse_Connector_Model_Exception::validation('qty muss eine Zahl sein.', ['field' => 'qty']);
            }
            $item->setQty((float) $body['qty']);
        }
        if (array_key_exists('is_in_stock', $body)) {
            $item->setIsInStock((int) (bool) $body['is_in_stock']);
        }
        if (array_key_exists('manage_stock', $body)) {
            if ($body['manage_stock'] === null) {
                $item->setUseConfigManageStock(1);
            } else {
                $item->setUseConfigManageStock(0)->setManageStock((int) (bool) $body['manage_stock']);
            }
        }
        $item->save();
        return ['data' => $this->formatStock($this->stockItem($id))];
    }

    // ---------- Kategoriezuordnungen ----------

    public function getCategoryAssignments(array $params)
    {
        $id = $this->resolveProductId($params['sku']);
        return ['data' => $this->categoryAssignments($id)];
    }

    /**
     * PUT /v1/products/{sku}/categories mit {add:[{id, position?}], remove:[id], set_position:[{id, position}]}.
     * Schreibt über das Kategoriemodell (setPostedProducts), damit Indexer und Events wie im Admin laufen.
     */
    public function updateCategoryAssignments(array $params)
    {
        $body = $this->body();
        $productId = $this->resolveProductId($params['sku']);
        $changes = [];
        foreach ((array) ($body['add'] ?? []) as $c) {
            $cid = is_array($c) ? $this->intParam($c['id'] ?? null, 'add[].id') : $this->intParam($c, 'add[]');
            $changes[$cid] = ['position' => is_array($c) && isset($c['position']) ? (int) $c['position'] : 0, 'remove' => false];
        }
        foreach ((array) ($body['set_position'] ?? []) as $c) {
            $cid = $this->intParam($c['id'] ?? null, 'set_position[].id');
            $changes[$cid] = ['position' => (int) ($c['position'] ?? 0), 'remove' => false];
        }
        foreach ((array) ($body['remove'] ?? []) as $c) {
            $cid = is_array($c) ? $this->intParam($c['id'] ?? null, 'remove[].id') : $this->intParam($c, 'remove[]');
            $changes[$cid] = ['remove' => true];
        }
        if ($changes === []) {
            throw Lotse_Connector_Model_Exception::validation('add, remove oder set_position erwartet.');
        }
        foreach ($changes as $cid => $change) {
            $category = Mage::getModel('catalog/category')->setStoreId(0)->load($cid);
            if (!$category->getId()) {
                throw Lotse_Connector_Model_Exception::notFound('Kategorie nicht gefunden: ' . $cid);
            }
            $positions = $category->getProductsPosition();
            if ($change['remove']) {
                if (!array_key_exists($productId, $positions)) {
                    continue;
                }
                unset($positions[$productId]);
            } else {
                if (array_key_exists($productId, $positions) && (int) $positions[$productId] === (int) $change['position']) {
                    continue;
                }
                $positions[$productId] = $change['position'];
            }
            $category->setPostedProducts($positions)->save();
            if ($change['remove']) {
                // Wie ein voller catalog_url-Reindex: Produkt-Rewrites der verlassenen Kategorie entfernen
                $resource = Mage::getSingleton('core/resource');
                $resource->getConnection('core_write')->delete($resource->getTableName('core/url_rewrite'), [
                    'product_id = ?' => (int) $productId,
                    'category_id = ?' => (int) $cid,
                ]);
            }
        }
        return ['data' => $this->categoryAssignments($productId)];
    }
}
