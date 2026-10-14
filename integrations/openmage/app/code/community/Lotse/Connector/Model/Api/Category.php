<?php
/**
 * Categories: tree (store scope), detail, write attributes (store scope, null = use default value).
 */
class Lotse_Connector_Model_Api_Category extends Lotse_Connector_Model_Api_Abstract
{
    public const READ_ONLY_ATTRIBUTES = [
        'entity_id', 'entity_type_id', 'attribute_set_id', 'parent_id', 'path', 'level', 'children_count',
        'created_at', 'updated_at', 'position', 'all_children', 'children', 'path_in_store', 'url_path',
    ];

    protected const TREE_ATTRIBUTES = ['name', 'is_active', 'include_in_menu', 'url_key', 'url_path', 'display_mode', 'is_anchor', 'landing_page', 'image', 'updated_at'];

    /**
     * GET /v1/categories?root=<id>&depth=<n>&flat=1: tree from root (default: the store's root category,
     * or all root categories in the global scope). flat=1 returns a list instead of the tree.
     */
    public function listCategories(array $params)
    {
        $rootId = $this->q('root');
        $depth = (int) $this->q('depth', 0);
        $collection = Mage::getModel('catalog/category')->getCollection()
            ->setStoreId($this->storeId)
            ->addAttributeToSelect(self::TREE_ATTRIBUTES)
            ->addFieldToFilter('level', ['gt' => 0])
            ->setOrder('level', 'ASC')
            ->setOrder('position', 'ASC');
        if ($rootId !== null && $rootId !== '') {
            $rootId = $this->intParam($rootId, 'root');
            $root = Mage::getModel('catalog/category')->load($rootId);
            if (!$root->getId()) {
                throw Lotse_Connector_Model_Exception::notFound('Kategorie nicht gefunden: ' . $rootId);
            }
            $collection->addFieldToFilter('path', ['like' => $root->getPath() . '/%']);
            if ($depth > 0) {
                $collection->addFieldToFilter('level', ['lteq' => (int) $root->getLevel() + $depth]);
            }
        } elseif ($this->storeId > 0) {
            $root = Mage::getModel('catalog/category')->load(Mage::app()->getStore($this->storeId)->getRootCategoryId());
            $collection->addFieldToFilter('path', ['like' => $root->getPath() . '/%']);
            if ($depth > 0) {
                $collection->addFieldToFilter('level', ['lteq' => (int) $root->getLevel() + $depth]);
            }
        } elseif ($depth > 0) {
            $collection->addFieldToFilter('level', ['lteq' => $depth]);
        }
        $counts = $this->productCounts();
        $nodes = [];
        foreach ($collection as $category) {
            $nodes[(int) $category->getId()] = $this->formatNode($category, $counts);
        }
        if ($this->q('flat') === '1') {
            return ['data' => array_values($nodes), 'meta' => ['total' => count($nodes)]];
        }
        $tree = [];
        foreach ($nodes as $id => &$node) {
            $parent = $node['parent_id'];
            if (isset($nodes[$parent])) {
                $nodes[$parent]['children'][] = &$node;
            } else {
                $tree[] = &$node;
            }
        }
        unset($node);
        return ['data' => $tree, 'meta' => ['total' => count($nodes)]];
    }

    /** Direct product assignments per category (without anchor inheritance). */
    protected function productCounts()
    {
        $resource = Mage::getSingleton('core/resource');
        $read = $resource->getConnection('core_read');
        return array_map('intval', $read->fetchPairs($read->select()
            ->from($resource->getTableName('catalog/category_product'), ['category_id', new Zend_Db_Expr('COUNT(*)')])
            ->group('category_id')));
    }

    protected function formatNode(Mage_Catalog_Model_Category $category, array $counts)
    {
        return [
            'id' => (int) $category->getId(),
            'parent_id' => (int) $category->getParentId(),
            'path' => $category->getPath(),
            'level' => (int) $category->getLevel(),
            'position' => (int) $category->getPosition(),
            'name' => $category->getName(),
            'is_active' => (bool) $category->getIsActive(),
            'include_in_menu' => (bool) $category->getIncludeInMenu(),
            'is_anchor' => (bool) $category->getIsAnchor(),
            'url_key' => $category->getUrlKey(),
            'url_path' => $category->getData('url_path'),
            'display_mode' => $category->getDisplayMode(),
            'landing_page' => $category->getLandingPage() === null ? null : (int) $category->getLandingPage(),
            'product_count' => $counts[(int) $category->getId()] ?? 0,
            'children_count' => (int) $category->getChildrenCount(),
            'updated_at' => $this->formatDate($category->getUpdatedAt()),
            'children' => [],
        ];
    }

    public function loadCategory($id, $storeId = null)
    {
        $storeId = $storeId === null ? $this->storeId : (int) $storeId;
        $id = $this->intParam($id, 'id');
        $category = Mage::getModel('catalog/category')->setStoreId($storeId)->load($id);
        if (!$category->getId() || (int) $category->getLevel() === 0) {
            throw Lotse_Connector_Model_Exception::notFound('Kategorie nicht gefunden: ' . $id);
        }
        return $category;
    }

    public function getCategory(array $params)
    {
        return ['data' => $this->formatCategory($this->loadCategory($params['id']))];
    }

    public function formatCategory(Mage_Catalog_Model_Category $category)
    {
        $attributes = [];
        foreach ($this->attributesOfSet(Mage_Catalog_Model_Category::ENTITY, $category->getAttributeSetId()) as $code => $attribute) {
            if (in_array($code, ['all_children', 'children', 'path_in_store'], true)) {
                continue;
            }
            $value = $category->getData($code);
            if ($value !== null && in_array($attribute->getBackendType(), ['int'], true)) {
                $value = (int) $value;
            } elseif ($value !== null && $attribute->getBackendType() === 'decimal') {
                $value = (float) $value;
            }
            $attributes[$code] = $value;
        }
        ksort($attributes);
        $counts = $this->productCounts();
        $data = $this->formatNode($category, $counts);
        unset($data['children']);
        $landing = null;
        if ($category->getLandingPage()) {
            $block = Mage::getModel('cms/block')->load((int) $category->getLandingPage());
            if ($block->getId()) {
                $landing = ['id' => (int) $block->getId(), 'identifier' => $block->getIdentifier(), 'title' => $block->getTitle(), 'is_active' => (bool) $block->getIsActive()];
            }
        }
        $data += [
            'store_id' => $this->storeId,
            'description' => $category->getDescription(),
            'meta_title' => $category->getMetaTitle(),
            'meta_keywords' => $category->getMetaKeywords(),
            'meta_description' => $category->getMetaDescription(),
            'image_url' => $category->getImage() ? $this->getUrlStore()->getBaseUrl(Mage_Core_Model_Store::URL_TYPE_MEDIA) . 'catalog/category/' . $category->getImage() : null,
            'url' => $this->categoryUrl($category),
            'landing_page_block' => $landing,
            'custom_design' => $category->getCustomDesign(),
            'page_layout' => $category->getPageLayout(),
            'attributes' => $attributes,
            'store_overrides' => $this->storeOverrides(Mage_Catalog_Model_Category::ENTITY, $category->getId(), $this->storeId),
            'child_ids' => array_values(array_filter(array_map('intval', explode(',', (string) $category->getChildren())))),
        ];
        return $data;
    }

    protected function categoryUrl(Mage_Catalog_Model_Category $category)
    {
        $store = $this->getUrlStore();
        $resource = Mage::getSingleton('core/resource');
        $read = $resource->getConnection('core_read');
        $path = $read->fetchOne($read->select()
            ->from($resource->getTableName('core/url_rewrite'), 'request_path')
            ->where('category_id = ?', (int) $category->getId())
            ->where('product_id IS NULL')
            ->where('store_id = ?', (int) $store->getId())
            ->where('is_system = 1')
            ->limit(1));
        return $path ? $store->getBaseUrl(Mage_Core_Model_Store::URL_TYPE_LINK) . $path : null;
    }

    /**
     * PATCH /v1/categories/{id} with {"attributes": {code: value|null}} in store scope.
     * Writes via the category model (store scope), null deletes the store value.
     */
    public function updateCategory(array $params)
    {
        $body = $this->body();
        $input = $body['attributes'] ?? null;
        if (!is_array($input) || $input === []) {
            throw Lotse_Connector_Model_Exception::validation('attributes (Objekt code => wert) fehlt.');
        }
        $category = $this->loadCategory($params['id']);
        $eav = Mage::getSingleton('eav/config');
        $set = [];
        $revert = [];
        foreach ($input as $code => $value) {
            $code = (string) $code;
            if (in_array($code, self::READ_ONLY_ATTRIBUTES, true)) {
                throw Lotse_Connector_Model_Exception::validation('Attribut nicht schreibbar: ' . $code, ['field' => $code]);
            }
            $attribute = $eav->getAttribute(Mage_Catalog_Model_Category::ENTITY, $code);
            if (!$attribute || !$attribute->getId()) {
                throw Lotse_Connector_Model_Exception::validation('Unbekanntes Attribut: ' . $code, ['field' => $code]);
            }
            if ($value === null) {
                if ($this->storeId === 0) {
                    throw Lotse_Connector_Model_Exception::validation('null (Standardwert verwenden) nur im Store-View-Scope.', ['field' => $code]);
                }
                $revert[] = $code;
                continue;
            }
            if (is_bool($value)) {
                $value = $value ? 1 : 0;
            } elseif (is_array($value)) {
                throw Lotse_Connector_Model_Exception::validation('Skalarer Wert erwartet: ' . $code, ['field' => $code]);
            }
            if ($code === 'url_key' && (string) $value !== '') {
                $value = $this->formatUrlKey((string) $value);
            }
            if ($code === 'custom_layout_update') {
                $value = $this->validateLayoutXml($value, $code);
            }
            if ($code === 'landing_page' && (string) $value !== '') {
                $block = Mage::getModel('cms/block')->load((int) $value);
                if (!$block->getId()) {
                    throw Lotse_Connector_Model_Exception::validation('CMS-Block nicht gefunden: ' . $value, ['field' => $code]);
                }
                $value = (int) $value;
            }
            if ($code === 'display_mode' && !in_array($value, [Mage_Catalog_Model_Category::DM_PRODUCT, Mage_Catalog_Model_Category::DM_PAGE, Mage_Catalog_Model_Category::DM_MIXED], true)) {
                throw Lotse_Connector_Model_Exception::validation('display_mode muss PRODUCTS, PAGE oder PRODUCTS_AND_PAGE sein.', ['field' => $code]);
            }
            $set[$code] = $value;
        }
        $urlKeyChanged = array_key_exists('url_key', $set) || in_array('url_key', $revert, true);
        $rewritesBefore = $urlKeyChanged ? $this->rewriteIds($category) : [];
        if ($set !== []) {
            foreach ($set as $code => $value) {
                $category->setData($code, $value);
            }
            if ($this->storeId > 0) {
                $this->useDefaultExcept($category, array_keys($set));
            }
            $category->save();
        }
        foreach ($revert as $code) {
            $this->deleteStoreValue(Mage_Catalog_Model_Category::ENTITY, $category->getId(), $code, $this->storeId);
        }
        if ($revert !== [] && in_array('url_key', $revert, true)) {
            Mage::getSingleton('catalog/url')->refreshCategoryRewrite($category->getId(), $this->storeId);
        }
        if ($revert !== []) {
            Mage::app()->cleanCache([Mage_Catalog_Model_Category::CACHE_TAG . '_' . $category->getId()]);
        }
        $rewritesAdded = [];
        if ($urlKeyChanged) {
            // With "Save Rewrites History" OpenMage creates 301 redirects (category, subcategories, product URLs with
            // category path); Lotse deletes them on undo. System rewrites (recreated with a new ID) don't count.
            $rewritesAdded = array_values(array_diff($this->rewriteIds($category, true), $rewritesBefore));
        }
        $fresh = $this->loadCategory($category->getId());
        $data = $this->formatCategory($fresh);
        $data['_write'] = ['updated' => array_keys($set), 'reverted' => $revert, 'rewrites_added' => $rewritesAdded];
        return ['data' => $data];
    }

    /**
     * IDs of all URL rewrites of the category and its subcategories (including product rewrites with category path).
     * @return int[]
     */
    protected function rewriteIds(Mage_Catalog_Model_Category $category, $onlyHistory = false)
    {
        $resource = Mage::getSingleton('core/resource');
        $read = $resource->getConnection('core_read');
        $ids = $read->fetchCol($read->select()
            ->from($resource->getTableName('catalog/category'), 'entity_id')
            ->where('path LIKE ?', $category->getPath() . '/%'));
        $ids[] = (int) $category->getId();
        $select = $read->select()
            ->from($resource->getTableName('core/url_rewrite'), 'url_rewrite_id')
            ->where('category_id IN (?)', array_map('intval', $ids));
        if ($onlyHistory) {
            $select->where('is_system = 0');
        }
        return array_map('intval', $read->fetchCol($select));
    }

    /**
     * In Magento 1 a category save in store scope writes EVERY loaded attribute as a store value, inherited ones too.
     * Like the admin ("Use Default Value") we set all store attributes that are neither requested nor already have
     * their own value in this view to false: the resource save then skips them (no store value,
     * no backend hooks), inheritance stays intact and store_overrides only grows by the requested codes.
     */
    protected function useDefaultExcept(Mage_Catalog_Model_Category $category, array $keep)
    {
        $own = $this->storeOverrides(Mage_Catalog_Model_Category::ENTITY, $category->getId(), $this->storeId);
        $eav = Mage::getSingleton('eav/config');
        foreach (array_keys($this->attributesOfSet(Mage_Catalog_Model_Category::ENTITY, $category->getAttributeSetId())) as $code) {
            if (in_array($code, $keep, true) || in_array($code, $own, true)) {
                continue;
            }
            $attribute = $eav->getAttribute(Mage_Catalog_Model_Category::ENTITY, $code);
            if (!$attribute || !$attribute->getId() || $attribute->getBackendType() === 'static' || !$attribute->isScopeStore()) {
                continue;
            }
            $category->setData($code, false);
        }
    }
}
