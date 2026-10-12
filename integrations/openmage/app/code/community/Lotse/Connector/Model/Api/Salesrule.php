<?php
/**
 * Warenkorb-Preisregeln (salesrule): Liste, Detail, anlegen, ändern, löschen, Gutscheine (nur Zähler).
 * Bedingungen als Baum (Format von Mage_Rule_Model_Condition_Combine::asArray) oder vereinfacht über
 * "product_filter" {category_ids, skus} + "apply_to_matching". Keine Kundendaten: Nutzung nur als Zähler.
 */
class Lotse_Connector_Model_Api_Salesrule extends Lotse_Connector_Model_Api_Abstract
{
    protected const FIELDS = [
        'name', 'description', 'is_active', 'from_date', 'to_date', 'uses_per_customer', 'uses_per_coupon',
        'coupon_type', 'coupon_code', 'simple_action', 'discount_amount', 'discount_qty', 'discount_step',
        'apply_to_shipping', 'stop_rules_processing', 'sort_order', 'simple_free_shipping', 'is_rss',
    ];
    protected const ACTIONS = ['by_percent', 'by_fixed', 'cart_fixed', 'buy_x_get_y'];

    public function listRules(array $params)
    {
        $pg = $this->pagination();
        list($sort, $dir) = $this->sorting(['rule_id', 'name', 'sort_order', 'from_date', 'to_date', 'is_active'], 'rule_id');
        $collection = Mage::getModel('salesrule/rule')->getCollection();
        if (($v = $this->q('is_active')) !== null && $v !== '') {
            $collection->addFieldToFilter('is_active', (int) $v);
        }
        if (($v = $this->q('name')) !== null && $v !== '') {
            $collection->addFieldToFilter('name', ['like' => '%' . $this->escapeLike($v) . '%']);
        }
        if (($v = $this->q('coupon_code')) !== null && $v !== '') {
            // Der Code steht im Primär-Coupon (salesrule_coupon, von der Collection als rule_coupons gejoint), nicht in der Regel
            $collection->getSelect()->where('rule_coupons.code = ?', $v);
        }
        if (($v = $this->q('website_id')) !== null && $v !== '') {
            $collection->addWebsiteFilter((int) $v);
        }
        $collection->setOrder($sort, $dir)->setPageSize($pg['limit'])->setCurPage($pg['page']);
        $total = $collection->getSize();
        $items = [];
        foreach ($collection as $rule) {
            $items[] = $this->formatRule($this->loadRule($rule->getId()), false);
        }
        return $this->listResponse($items, $pg['page'], $pg['limit'], $total);
    }

    protected function loadRule($id)
    {
        $rule = Mage::getModel('salesrule/rule')->load($this->intParam($id, 'id'));
        if (!$rule->getId()) {
            throw Lotse_Connector_Model_Exception::notFound('Preisregel nicht gefunden: ' . $id);
        }
        return $rule;
    }

    public function formatRule(Mage_SalesRule_Model_Rule $rule, $withConditions = true)
    {
        $primary = $rule->getPrimaryCoupon();
        $data = [
            'id' => (int) $rule->getId(),
            'name' => $rule->getName(),
            'description' => $rule->getDescription(),
            'is_active' => (bool) $rule->getIsActive(),
            'from_date' => $this->formatDate($rule->getFromDate()),
            'to_date' => $this->formatDate($rule->getToDate()),
            'coupon_type' => (int) $rule->getCouponType(),
            'coupon_code' => $rule->getCouponType() == Mage_SalesRule_Model_Rule::COUPON_TYPE_SPECIFIC ? ($rule->getCouponCode() ?: ($primary->getId() ? $primary->getCode() : null)) : null,
            'uses_per_coupon' => $rule->getUsesPerCoupon() === null ? null : (int) $rule->getUsesPerCoupon(),
            'uses_per_customer' => (int) $rule->getUsesPerCustomer(),
            'times_used' => (int) $rule->getTimesUsed(),
            'simple_action' => $rule->getSimpleAction(),
            'discount_amount' => (float) $rule->getDiscountAmount(),
            'discount_qty' => $rule->getDiscountQty() === null ? null : (float) $rule->getDiscountQty(),
            'discount_step' => (int) $rule->getDiscountStep(),
            'apply_to_shipping' => (bool) $rule->getApplyToShipping(),
            'simple_free_shipping' => (int) $rule->getSimpleFreeShipping(),
            'stop_rules_processing' => (bool) $rule->getStopRulesProcessing(),
            'sort_order' => (int) $rule->getSortOrder(),
            'website_ids' => array_map('intval', (array) $rule->getWebsiteIds()),
            'customer_group_ids' => array_map('intval', (array) $rule->getCustomerGroupIds()),
            'primary_coupon' => $primary->getId() ? $this->formatCoupon($primary) : null,
            'coupon_count' => (int) Mage::getModel('salesrule/coupon')->getCollection()->addFieldToFilter('rule_id', (int) $rule->getId())->getSize(),
        ];
        if ($withConditions) {
            $data['conditions'] = $this->stripConditions($rule->getConditions()->asArray());
            $data['actions'] = $this->stripConditions($rule->getActions()->asArray());
        }
        return $data;
    }

    /** Entfernt interne Felder (is_value_processed) aus dem Bedingungsbaum. */
    protected function stripConditions(array $tree)
    {
        unset($tree['is_value_processed']);
        if (isset($tree['conditions']) && is_array($tree['conditions'])) {
            foreach ($tree['conditions'] as $i => $child) {
                $tree['conditions'][$i] = $this->stripConditions($child);
            }
        }
        return $tree;
    }

    protected function formatCoupon(Mage_SalesRule_Model_Coupon $coupon)
    {
        return [
            'id' => (int) $coupon->getId(),
            'code' => $coupon->getCode(),
            'usage_limit' => $coupon->getUsageLimit() === null ? null : (int) $coupon->getUsageLimit(),
            'usage_per_customer' => $coupon->getUsagePerCustomer() === null ? null : (int) $coupon->getUsagePerCustomer(),
            'times_used' => (int) $coupon->getTimesUsed(),
            'expiration_date' => $this->formatDate($coupon->getExpirationDate()),
            'is_primary' => (bool) $coupon->getIsPrimary(),
            'type' => $coupon->getType() === null ? null : (int) $coupon->getType(),
        ];
    }

    public function getRule(array $params)
    {
        return ['data' => $this->formatRule($this->loadRule($params['id']))];
    }

    public function listCoupons(array $params)
    {
        $rule = $this->loadRule($params['id']);
        $pg = $this->pagination();
        $collection = Mage::getModel('salesrule/coupon')->getCollection()
            ->addFieldToFilter('rule_id', (int) $rule->getId())
            ->setOrder('coupon_id', 'ASC')
            ->setPageSize($pg['limit'])->setCurPage($pg['page']);
        $total = $collection->getSize();
        $items = [];
        foreach ($collection as $coupon) {
            $items[] = $this->formatCoupon($coupon);
        }
        return $this->listResponse($items, $pg['page'], $pg['limit'], $total);
    }

    public function createRule(array $params)
    {
        $body = $this->body();
        $this->requireField($body, 'name');
        $rule = Mage::getModel('salesrule/rule');
        $rule->setData('is_active', 1)->setData('simple_action', 'by_percent')->setData('discount_amount', 0)
            ->setData('coupon_type', Mage_SalesRule_Model_Rule::COUPON_TYPE_NO_COUPON)->setData('uses_per_customer', 0)
            ->setData('stop_rules_processing', 0)->setData('sort_order', 0);
        if (!isset($body['simple_action'])) {
            $this->requireField($body, 'simple_action');
        }
        if (!isset($body['website_ids'])) {
            $body['website_ids'] = array_map('intval', array_keys(Mage::app()->getWebsites()));
        }
        if (!isset($body['customer_group_ids'])) {
            $body['customer_group_ids'] = array_map('intval', Mage::getModel('customer/group')->getCollection()->getAllIds());
        }
        $this->applyFields($rule, $body);
        $rule->save();
        $this->status = 201;
        return ['data' => $this->formatRule($this->loadRule($rule->getId()))];
    }

    public function updateRule(array $params)
    {
        $body = $this->body();
        $rule = $this->loadRule($params['id']);
        $this->applyFields($rule, $body);
        $rule->save();
        return ['data' => $this->formatRule($this->loadRule($rule->getId()))];
    }

    public function deleteRule(array $params)
    {
        $rule = $this->loadRule($params['id']);
        $before = $this->formatRule($rule);
        $rule->delete();
        return ['data' => ['deleted' => true, 'id' => $before['id'], 'before' => $before]];
    }

    protected function applyFields(Mage_SalesRule_Model_Rule $rule, array $body)
    {
        foreach (self::FIELDS as $field) {
            if (!array_key_exists($field, $body)) {
                continue;
            }
            $value = $body[$field];
            switch ($field) {
                case 'is_active':
                case 'apply_to_shipping':
                case 'stop_rules_processing':
                case 'is_rss':
                    $value = (int) (bool) $value;
                    break;
                case 'from_date':
                case 'to_date':
                    if ($value !== null && $value !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}/', (string) $value)) {
                        throw Lotse_Connector_Model_Exception::validation($field . ' im Format YYYY-MM-DD erwartet.', ['field' => $field]);
                    }
                    $value = ($value === null || $value === '') ? null : substr((string) $value, 0, 10);
                    break;
                case 'simple_action':
                    if (!in_array($value, self::ACTIONS, true)) {
                        throw Lotse_Connector_Model_Exception::validation('simple_action ungültig.', ['allowed' => self::ACTIONS]);
                    }
                    break;
                case 'discount_amount':
                case 'discount_qty':
                    if ($value !== null && !is_numeric($value)) {
                        throw Lotse_Connector_Model_Exception::validation($field . ' muss eine Zahl sein.', ['field' => $field]);
                    }
                    $value = $value === null ? null : (float) $value;
                    break;
                case 'uses_per_coupon':
                    $value = ($value === null || $value === '') ? null : (int) $value;
                    break;
                case 'coupon_code':
                    $value = $value === null ? '' : trim((string) $value);
                    break;
                default:
                    if (is_array($value)) {
                        throw Lotse_Connector_Model_Exception::validation('Skalarer Wert erwartet: ' . $field, ['field' => $field]);
                    }
            }
            $rule->setData($field, $value);
        }
        // Gutscheintyp aus dem Code ableiten, wenn nicht explizit gesetzt
        if (array_key_exists('coupon_code', $body) && !array_key_exists('coupon_type', $body)) {
            $rule->setData('coupon_type', $rule->getData('coupon_code') !== '' ? Mage_SalesRule_Model_Rule::COUPON_TYPE_SPECIFIC : Mage_SalesRule_Model_Rule::COUPON_TYPE_NO_COUPON);
        }
        if ((int) $rule->getData('coupon_type') === Mage_SalesRule_Model_Rule::COUPON_TYPE_SPECIFIC && trim((string) $rule->getData('coupon_code')) === '') {
            throw Lotse_Connector_Model_Exception::validation('coupon_code fehlt für coupon_type 2.', ['field' => 'coupon_code']);
        }
        if (array_key_exists('website_ids', $body)) {
            $rule->setWebsiteIds(array_map('intval', (array) $body['website_ids']));
        }
        if (array_key_exists('customer_group_ids', $body)) {
            $rule->setCustomerGroupIds(array_map('intval', (array) $body['customer_group_ids']));
        }
        if (array_key_exists('store_labels', $body) && is_array($body['store_labels'])) {
            $rule->setStoreLabels($body['store_labels']);
        }

        $conditions = $body['conditions'] ?? null;
        $actions = $body['actions'] ?? null;
        if (isset($body['product_filter'])) {
            $built = $this->buildProductConditions($body['product_filter']);
            if ($built !== []) {
                $conditions = [
                    'type' => 'salesrule/rule_condition_combine', 'aggregator' => 'all', 'value' => 1,
                    'conditions' => [[
                        'type' => 'salesrule/rule_condition_product_found', 'aggregator' => 'any', 'value' => 1,
                        'conditions' => $built,
                    ]],
                ];
                if (!empty($body['apply_to_matching'])) {
                    $actions = ['type' => 'salesrule/rule_condition_product_combine', 'aggregator' => 'any', 'value' => 1, 'conditions' => $built];
                } elseif (array_key_exists('apply_to_matching', $body)) {
                    $actions = ['type' => 'salesrule/rule_condition_product_combine', 'aggregator' => 'all', 'value' => 1, 'conditions' => []];
                }
            }
        }
        if ($conditions !== null) {
            $rule->getConditions()->setConditions([])->loadArray($this->validateTree($conditions, 'conditions'));
        }
        if ($actions !== null) {
            // loadArray erwartet Kinder unter "actions"; die API nutzt ein- wie ausgehend "conditions"
            $rule->getActions()->setActions([])->loadArray($this->childrenKey($this->validateTree($actions, 'actions'), 'actions'), 'actions');
        }
    }

    protected function childrenKey(array $tree, $key)
    {
        if (isset($tree['conditions'])) {
            $tree[$key] = array_map(function ($c) use ($key) {
                return $this->childrenKey($c, $key);
            }, $tree['conditions']);
            unset($tree['conditions']);
        }
        return $tree;
    }

    /** Nur salesrule-Bedingungsklassen zulassen (keine beliebigen Modell-Aliase). */
    protected function validateTree($tree, $what)
    {
        if (!is_array($tree) || empty($tree['type'])) {
            throw Lotse_Connector_Model_Exception::validation($what . ': Baum mit "type" erwartet.');
        }
        if (strpos((string) $tree['type'], 'salesrule/rule_condition_') !== 0) {
            throw Lotse_Connector_Model_Exception::validation($what . ': unzulässiger Bedingungstyp ' . $tree['type']);
        }
        if (isset($tree['conditions'])) {
            if (!is_array($tree['conditions'])) {
                throw Lotse_Connector_Model_Exception::validation($what . ': conditions muss eine Liste sein.');
            }
            foreach ($tree['conditions'] as $i => $child) {
                $tree['conditions'][$i] = $this->validateTree($child, $what);
            }
        }
        return $tree;
    }

    protected function buildProductConditions($filter)
    {
        if (!is_array($filter)) {
            throw Lotse_Connector_Model_Exception::validation('product_filter muss ein Objekt sein ({category_ids, skus}).');
        }
        $out = [];
        if (!empty($filter['category_ids'])) {
            $out[] = ['type' => 'salesrule/rule_condition_product', 'attribute' => 'category_ids', 'operator' => '()', 'value' => implode(', ', array_map('intval', (array) $filter['category_ids']))];
        }
        if (!empty($filter['skus'])) {
            $out[] = ['type' => 'salesrule/rule_condition_product', 'attribute' => 'sku', 'operator' => '()', 'value' => implode(', ', array_map('strval', (array) $filter['skus']))];
        }
        return $out;
    }
}
