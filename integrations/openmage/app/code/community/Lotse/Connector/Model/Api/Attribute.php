<?php
/**
 * GET /v1/products/attributes: Attributsets und Produktattribute mit Optionen (Labels im angefragten Store).
 */
class Lotse_Connector_Model_Api_Attribute extends Lotse_Connector_Model_Api_Abstract
{
    public function listProductAttributes(array $params)
    {
        $entityType = Mage::getSingleton('eav/config')->getEntityType(Mage_Catalog_Model_Product::ENTITY);
        $sets = [];
        $setCollection = Mage::getResourceModel('eav/entity_attribute_set_collection')
            ->setEntityTypeFilter($entityType->getId());
        foreach ($setCollection as $set) {
            $codes = [];
            $attrs = Mage::getResourceModel('catalog/product_attribute_collection')
                ->setAttributeSetFilter($set->getId())
                ->addSetInfo();
            foreach ($attrs as $a) {
                $codes[] = $a->getAttributeCode();
            }
            sort($codes);
            $sets[] = [
                'id' => (int) $set->getId(),
                'name' => $set->getAttributeSetName(),
                'is_default' => (int) $set->getId() === (int) $entityType->getDefaultAttributeSetId(),
                'attribute_codes' => $codes,
            ];
        }

        $attributes = [];
        $collection = Mage::getResourceModel('catalog/product_attribute_collection');
        $withOptions = $this->q('options', '1') !== '0';
        foreach ($collection as $attribute) {
            /** @var Mage_Catalog_Model_Resource_Eav_Attribute $attribute */
            $attributes[] = $this->formatAttribute($attribute, $withOptions);
        }
        return ['data' => ['attribute_sets' => $sets, 'attributes' => $attributes]];
    }

    public function formatAttribute(Mage_Catalog_Model_Resource_Eav_Attribute $attribute, $withOptions = true)
    {
        $attribute->setStoreId($this->storeId);
        $scope = 'global';
        if ($attribute->isScopeStore()) {
            $scope = 'store';
        } elseif ($attribute->isScopeWebsite()) {
            $scope = 'website';
        }
        $out = [
            'id' => (int) $attribute->getId(),
            'code' => $attribute->getAttributeCode(),
            'label' => $attribute->getFrontendLabel(),
            'store_label' => $this->storeId > 0 ? $attribute->getStoreLabel($this->storeId) : $attribute->getFrontendLabel(),
            'input' => $attribute->getFrontendInput(),
            'backend_type' => $attribute->getBackendType(),
            'scope' => $scope,
            'is_required' => (bool) $attribute->getIsRequired(),
            'is_user_defined' => (bool) $attribute->getIsUserDefined(),
            'is_unique' => (bool) $attribute->getIsUnique(),
            'is_configurable' => (bool) $attribute->getIsConfigurable(),
            'is_visible' => (bool) $attribute->getIsVisible(),
            'is_searchable' => (bool) $attribute->getIsSearchable(),
            'is_filterable' => (bool) $attribute->getIsFilterable(),
            'used_in_product_listing' => (bool) $attribute->getUsedInProductListing(),
            'apply_to' => $attribute->getApplyTo() ? array_values($attribute->getApplyTo()) : [],
            'default_value' => $attribute->getDefaultValue(),
            'writable' => !in_array($attribute->getAttributeCode(), Lotse_Connector_Model_Api_Product::READ_ONLY_ATTRIBUTES, true),
        ];
        if ($withOptions && in_array($attribute->getFrontendInput(), ['select', 'multiselect', 'boolean'], true)) {
            $out['options'] = $this->options($attribute);
        }
        return $out;
    }

    public function options(Mage_Catalog_Model_Resource_Eav_Attribute $attribute)
    {
        $options = [];
        try {
            $source = $attribute->getSource();
            if (!$source) {
                return [];
            }
            $all = $source->getAllOptions(false);
        } catch (Exception $e) {
            return [];
        }
        foreach ($all as $opt) {
            if (!is_array($opt) || !isset($opt['value']) || is_array($opt['value'])) {
                continue;
            }
            $options[] = ['value' => is_numeric($opt['value']) ? (int) $opt['value'] : $opt['value'], 'label' => (string) $opt['label']];
        }
        return $options;
    }
}
