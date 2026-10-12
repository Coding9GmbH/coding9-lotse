<?php
/**
 * CMS-Seiten und -Blöcke: Liste, Detail, anlegen, ändern, löschen. Store-Zuordnung über "stores"
 * (Codes oder IDs, "admin"/0 = alle Store-Views). Jede Schreibaktion liefert den vollständigen Stand.
 */
class Lotse_Connector_Model_Api_Cms extends Lotse_Connector_Model_Api_Abstract
{
    protected const PAGE_FIELDS = [
        'title', 'identifier', 'content', 'content_heading', 'root_template', 'meta_keywords', 'meta_description',
        'is_active', 'sort_order', 'layout_update_xml', 'custom_theme', 'custom_root_template', 'custom_layout_update_xml',
        'custom_theme_from', 'custom_theme_to',
    ];
    protected const BLOCK_FIELDS = ['title', 'identifier', 'content', 'is_active'];

    // ---------- Seiten ----------

    public function listPages(array $params)
    {
        $pg = $this->pagination();
        list($sort, $dir) = $this->sorting(['page_id', 'identifier', 'title', 'update_time', 'creation_time', 'sort_order'], 'page_id');
        // Globaler Scope = alle Seiten (auch nur einem Store zugeordnete); Store-Filter nur bei ?store=
        $collection = Mage::getModel('cms/page')->getCollection();
        if ($this->storeId > 0) {
            $collection->addStoreFilter($this->storeId, true);
        }
        if (($v = $this->q('identifier')) !== null && $v !== '') {
            $collection->addFieldToFilter('identifier', ['like' => '%' . $this->escapeLike($v) . '%']);
        }
        if (($v = $this->q('title')) !== null && $v !== '') {
            $collection->addFieldToFilter('title', ['like' => '%' . $this->escapeLike($v) . '%']);
        }
        if (($v = $this->q('term')) !== null && $v !== '') {
            $like = '%' . $this->escapeLike($v) . '%';
            $collection->addFieldToFilter(['title', 'identifier'], [['like' => $like], ['like' => $like]]);
        }
        if (($v = $this->q('is_active')) !== null && $v !== '') {
            $collection->addFieldToFilter('is_active', (int) $v);
        }
        $collection->setOrder($sort, $dir)->setPageSize($pg['limit'])->setCurPage($pg['page']);
        $total = $collection->getSize();
        $items = [];
        foreach ($collection as $page) {
            $items[] = $this->formatPage($page, false);
        }
        return $this->listResponse($items, $pg['page'], $pg['limit'], $total);
    }

    protected function pageStores(Mage_Cms_Model_Page $page)
    {
        $ids = Mage::getResourceModel('cms/page')->lookupStoreIds($page->getId());
        return $this->storeIdsToCodes(array_map('intval', $ids));
    }

    public function formatPage(Mage_Cms_Model_Page $page, $withContent = true)
    {
        $stores = $this->pageStores($page);
        $data = [
            'id' => (int) $page->getId(),
            'identifier' => $page->getIdentifier(),
            'title' => $page->getTitle(),
            'content_heading' => $page->getContentHeading(),
            'root_template' => $page->getRootTemplate(),
            'meta_keywords' => $page->getMetaKeywords(),
            'meta_description' => $page->getMetaDescription(),
            'is_active' => (bool) $page->getIsActive(),
            'sort_order' => (int) $page->getSortOrder(),
            'stores' => $stores,
            'store_ids' => array_column($stores, 'id'),
            'creation_time' => $this->formatDate($page->getCreationTime()),
            'update_time' => $this->formatDate($page->getUpdateTime()),
            'url' => $this->getUrlStore()->getBaseUrl(Mage_Core_Model_Store::URL_TYPE_LINK) . $page->getIdentifier(),
        ];
        if ($withContent) {
            $data += [
                'content' => $page->getContent(),
                'layout_update_xml' => $page->getLayoutUpdateXml(),
                'custom_theme' => $page->getCustomTheme(),
                'custom_root_template' => $page->getCustomRootTemplate(),
                'custom_layout_update_xml' => $page->getCustomLayoutUpdateXml(),
                'custom_theme_from' => $this->formatDate($page->getCustomThemeFrom()),
                'custom_theme_to' => $this->formatDate($page->getCustomThemeTo()),
            ];
        }
        return $data;
    }

    protected function loadPage($id)
    {
        $page = Mage::getModel('cms/page')->load($this->intParam($id, 'id'));
        if (!$page->getId()) {
            throw Lotse_Connector_Model_Exception::notFound('CMS-Seite nicht gefunden: ' . $id);
        }
        return $page;
    }

    public function getPage(array $params)
    {
        return ['data' => $this->formatPage($this->loadPage($params['id']))];
    }

    public function createPage(array $params)
    {
        $body = $this->body();
        $this->requireField($body, 'title');
        $this->requireField($body, 'identifier');
        $page = Mage::getModel('cms/page');
        $page->setData('is_active', 1)->setData('root_template', 'one_column')->setData('content', '');
        $this->applyPageFields($page, $body);
        $page->setStores(isset($body['stores']) ? $this->storeIdsFromInput($body['stores']) : [0]);
        $page->save();
        $this->status = 201;
        return ['data' => $this->formatPage($this->loadPage($page->getId()))];
    }

    public function updatePage(array $params)
    {
        $body = $this->body();
        $page = $this->loadPage($params['id']);
        $this->applyPageFields($page, $body);
        $page->setStores(isset($body['stores']) ? $this->storeIdsFromInput($body['stores']) : Mage::getResourceModel('cms/page')->lookupStoreIds($page->getId()));
        $page->save();
        return ['data' => $this->formatPage($this->loadPage($page->getId()))];
    }

    public function deletePage(array $params)
    {
        $page = $this->loadPage($params['id']);
        $before = $this->formatPage($page);
        $page->delete();
        return ['data' => ['deleted' => true, 'id' => $before['id'], 'before' => $before]];
    }

    protected function applyPageFields(Mage_Cms_Model_Page $page, array $body)
    {
        foreach (self::PAGE_FIELDS as $field) {
            if (!array_key_exists($field, $body)) {
                continue;
            }
            $value = $body[$field];
            if ($field === 'is_active') {
                $value = (int) (bool) $value;
            } elseif ($field === 'sort_order') {
                $value = (int) $value;
            } elseif ($field === 'identifier') {
                $value = trim((string) $value);
                if ($value === '' || !preg_match('#^[a-z0-9][a-z0-9/._-]*$#i', $value)) {
                    throw Lotse_Connector_Model_Exception::validation('identifier darf nur Buchstaben, Ziffern, "-", "_", "." und "/" enthalten.', ['field' => 'identifier']);
                }
            } elseif ($field === 'root_template') {
                $allowed = array_column(Mage::getSingleton('page/source_layout')->toOptionArray(), 'value');
                if (!in_array($value, $allowed, true)) {
                    throw Lotse_Connector_Model_Exception::validation('Unbekanntes root_template: ' . $value, ['allowed' => $allowed]);
                }
            } elseif ($field === 'layout_update_xml' || $field === 'custom_layout_update_xml') {
                $value = $this->validateLayoutXml($value, $field);
            } elseif (is_array($value)) {
                throw Lotse_Connector_Model_Exception::validation('Skalarer Wert erwartet: ' . $field, ['field' => $field]);
            }
            $page->setData($field, $value);
        }
    }

    // ---------- Blöcke ----------

    public function listBlocks(array $params)
    {
        $pg = $this->pagination();
        list($sort, $dir) = $this->sorting(['block_id', 'identifier', 'title', 'update_time', 'creation_time'], 'block_id');
        $collection = Mage::getModel('cms/block')->getCollection();
        if ($this->storeId > 0) {
            $collection->addStoreFilter($this->storeId, true);
        }
        if (($v = $this->q('identifier')) !== null && $v !== '') {
            $collection->addFieldToFilter('identifier', ['like' => '%' . $this->escapeLike($v) . '%']);
        }
        if (($v = $this->q('title')) !== null && $v !== '') {
            $collection->addFieldToFilter('title', ['like' => '%' . $this->escapeLike($v) . '%']);
        }
        if (($v = $this->q('term')) !== null && $v !== '') {
            $like = '%' . $this->escapeLike($v) . '%';
            $collection->addFieldToFilter(['title', 'identifier'], [['like' => $like], ['like' => $like]]);
        }
        if (($v = $this->q('is_active')) !== null && $v !== '') {
            $collection->addFieldToFilter('is_active', (int) $v);
        }
        $collection->setOrder($sort, $dir)->setPageSize($pg['limit'])->setCurPage($pg['page']);
        $total = $collection->getSize();
        $items = [];
        foreach ($collection as $block) {
            $items[] = $this->formatBlock($block, false);
        }
        return $this->listResponse($items, $pg['page'], $pg['limit'], $total);
    }

    public function formatBlock(Mage_Cms_Model_Block $block, $withContent = true)
    {
        $stores = $this->storeIdsToCodes(array_map('intval', Mage::getResourceModel('cms/block')->lookupStoreIds($block->getId())));
        $data = [
            'id' => (int) $block->getId(),
            'identifier' => $block->getIdentifier(),
            'title' => $block->getTitle(),
            'is_active' => (bool) $block->getIsActive(),
            'stores' => $stores,
            'store_ids' => array_column($stores, 'id'),
            'creation_time' => $this->formatDate($block->getCreationTime()),
            'update_time' => $this->formatDate($block->getUpdateTime()),
        ];
        if ($withContent) {
            $data['content'] = $block->getContent();
        }
        return $data;
    }

    protected function loadBlock($id)
    {
        $block = Mage::getModel('cms/block')->load($this->intParam($id, 'id'));
        if (!$block->getId()) {
            throw Lotse_Connector_Model_Exception::notFound('CMS-Block nicht gefunden: ' . $id);
        }
        return $block;
    }

    public function getBlock(array $params)
    {
        return ['data' => $this->formatBlock($this->loadBlock($params['id']))];
    }

    public function createBlock(array $params)
    {
        $body = $this->body();
        $this->requireField($body, 'title');
        $this->requireField($body, 'identifier');
        $block = Mage::getModel('cms/block')->setData('is_active', 1)->setData('content', '');
        $this->applyBlockFields($block, $body);
        $block->setStores(isset($body['stores']) ? $this->storeIdsFromInput($body['stores']) : [0]);
        $block->save();
        $this->status = 201;
        return ['data' => $this->formatBlock($this->loadBlock($block->getId()))];
    }

    public function updateBlock(array $params)
    {
        $body = $this->body();
        $block = $this->loadBlock($params['id']);
        $this->applyBlockFields($block, $body);
        $block->setStores(isset($body['stores']) ? $this->storeIdsFromInput($body['stores']) : Mage::getResourceModel('cms/block')->lookupStoreIds($block->getId()));
        $block->save();
        return ['data' => $this->formatBlock($this->loadBlock($block->getId()))];
    }

    public function deleteBlock(array $params)
    {
        $block = $this->loadBlock($params['id']);
        $before = $this->formatBlock($block);
        $block->delete();
        return ['data' => ['deleted' => true, 'id' => $before['id'], 'before' => $before]];
    }

    protected function applyBlockFields(Mage_Cms_Model_Block $block, array $body)
    {
        foreach (self::BLOCK_FIELDS as $field) {
            if (!array_key_exists($field, $body)) {
                continue;
            }
            $value = $body[$field];
            if ($field === 'is_active') {
                $value = (int) (bool) $value;
            } elseif ($field === 'identifier') {
                $value = trim((string) $value);
                if ($value === '' || !preg_match('#^[a-z0-9][a-z0-9._-]*$#i', $value)) {
                    throw Lotse_Connector_Model_Exception::validation('identifier darf nur Buchstaben, Ziffern, "-", "_" und "." enthalten.', ['field' => 'identifier']);
                }
            } elseif (is_array($value)) {
                throw Lotse_Connector_Model_Exception::validation('Skalarer Wert erwartet: ' . $field, ['field' => $field]);
            }
            $block->setData($field, $value);
        }
    }
}
