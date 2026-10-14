<?php
/**
 * GET /v1/info: version, websites, stores, store views with codes, base URLs, currency, locale, price basis.
 */
class Lotse_Connector_Model_Api_Info extends Lotse_Connector_Model_Api_Abstract
{
    public function info(array $params)
    {
        $websites = [];
        foreach (Mage::app()->getWebsites() as $website) {
            $groups = [];
            foreach ($website->getGroups() as $group) {
                $views = [];
                foreach ($group->getStores() as $store) {
                    $views[] = $this->storeInfo($store, (int) $group->getDefaultStoreId());
                }
                $groups[] = [
                    'id' => (int) $group->getId(),
                    'name' => $group->getName(),
                    'root_category_id' => (int) $group->getRootCategoryId(),
                    'default_store_id' => (int) $group->getDefaultStoreId(),
                    'store_views' => $views,
                ];
            }
            $websites[] = [
                'id' => (int) $website->getId(),
                'code' => $website->getCode(),
                'name' => $website->getName(),
                'is_default' => (bool) $website->getIsDefault(),
                'default_group_id' => (int) $website->getDefaultGroupId(),
                'base_currency' => (string) $website->getBaseCurrencyCode(),
                'groups' => $groups,
            ];
        }
        $storeViews = [];
        foreach (Mage::app()->getStores() as $store) {
            $storeViews[] = $this->storeInfo($store, (int) $store->getGroup()->getDefaultStoreId());
        }
        $default = Mage::app()->getDefaultStoreView();
        return ['data' => [
            'platform' => 'openmage',
            'version' => Mage::getOpenMageVersion(),
            'magento_version' => Mage::getVersion(),
            'edition' => Mage::getEdition(),
            'php_version' => PHP_VERSION,
            'module_version' => (string) Mage::getConfig()->getModuleConfig('Lotse_Connector')->version,
            'shop_name' => (string) Mage::getStoreConfig('general/store_information/name', $default ? $default->getId() : 0),
            'default_store_view' => $default ? $default->getCode() : null,
            'price_includes_tax' => (bool) Mage::getStoreConfigFlag('tax/calculation/price_includes_tax', $default ? $default->getId() : 0),
            'catalog_price_scope' => (int) Mage::getStoreConfig('catalog/price/scope', 0) === 1 ? 'website' : 'global',
            'save_rewrites_history' => (bool) Mage::getStoreConfigFlag('catalog/seo/save_rewrites_history', 0),
            'product_url_suffix' => (string) Mage::getStoreConfig('catalog/seo/product_url_suffix', $default ? $default->getId() : 0),
            'category_url_suffix' => (string) Mage::getStoreConfig('catalog/seo/category_url_suffix', $default ? $default->getId() : 0),
            'indexers' => $this->indexers(),
            'websites' => $websites,
            'store_views' => $storeViews,
        ]];
    }

    protected function storeInfo(Mage_Core_Model_Store $store, $defaultStoreId)
    {
        $id = (int) $store->getId();
        return [
            'id' => $id,
            'code' => $store->getCode(),
            'name' => $store->getName(),
            'website_id' => (int) $store->getWebsiteId(),
            'group_id' => (int) $store->getGroupId(),
            'is_active' => (bool) $store->getIsActive(),
            'is_default' => $id === $defaultStoreId,
            'locale' => (string) Mage::getStoreConfig('general/locale/code', $id),
            'currency' => (string) $store->getDefaultCurrencyCode(),
            'base_currency' => (string) $store->getBaseCurrencyCode(),
            'base_url' => $store->getBaseUrl(Mage_Core_Model_Store::URL_TYPE_WEB),
            'link_url' => $store->getBaseUrl(Mage_Core_Model_Store::URL_TYPE_LINK),
            'media_url' => $store->getBaseUrl(Mage_Core_Model_Store::URL_TYPE_MEDIA),
            'root_category_id' => (int) $store->getRootCategoryId(),
            'store_in_url' => (bool) Mage::getStoreConfigFlag('web/url/use_store', $id),
            'title_prefix' => (string) Mage::getStoreConfig('design/head/title_prefix', $id),
            'title_suffix' => (string) Mage::getStoreConfig('design/head/title_suffix', $id),
        ];
    }

    protected function indexers()
    {
        $out = [];
        foreach (Mage::getSingleton('index/indexer')->getProcessesCollection() as $process) {
            $out[] = [
                'code' => $process->getIndexerCode(),
                'mode' => $process->getMode(),
                'status' => $process->getStatus(),
            ];
        }
        return $out;
    }
}
