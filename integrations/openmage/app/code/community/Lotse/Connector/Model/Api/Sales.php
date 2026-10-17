<?php
/**
 * GET /v1/sales?from=YYYY-MM-DD&to=YYYY-MM-DD: sales per product without personal data (since 1.3.0).
 * Only sums: quantity (ordered minus canceled), revenue (row total incl. tax in base currency) and number of orders
 * per product. Never customers, addresses, order numbers or single orders. Canceled orders don't count.
 * Child rows (configurable/bundle) count towards their parent product: quantity from the parent row, revenue from all rows.
 * Always the whole shop (all store views); the store scope is ignored. Days in UTC like created_at.
 */
class Lotse_Connector_Model_Api_Sales extends Lotse_Connector_Model_Api_Abstract
{
    public const MAX_ROWS = 20000;

    public function productTotals(array $params)
    {
        $range = Lotse_Connector_Model_Util::salesRange($this->q('from'), $this->q('to'));
        if (is_string($range)) {
            throw Lotse_Connector_Model_Exception::validation($range);
        }
        $resource = Mage::getSingleton('core/resource');
        $read = $resource->getConnection('core_read');
        $orders = $resource->getTableName('sales/order');
        $items = $resource->getTableName('sales/order_item');
        $product = new Zend_Db_Expr('COALESCE(p.product_id, i.product_id)');
        $select = $read->select()
            ->from(['i' => $items], [
                'product_id' => $product,
                'qty' => new Zend_Db_Expr('SUM(CASE WHEN i.parent_item_id IS NULL THEN i.qty_ordered - COALESCE(i.qty_canceled, 0) ELSE 0 END)'),
                'revenue' => new Zend_Db_Expr('SUM(COALESCE(i.base_row_total_incl_tax, i.base_row_total + COALESCE(i.base_tax_amount, 0), 0))'),
                'orders' => new Zend_Db_Expr('COUNT(DISTINCT i.order_id)'),
            ])
            ->join(['o' => $orders], 'o.entity_id = i.order_id', [])
            ->joinLeft(['p' => $items], 'p.item_id = i.parent_item_id', [])
            ->where('o.created_at >= ?', $range['from'])
            ->where('o.created_at <= ?', $range['to'])
            ->where('o.state <> ?', Mage_Sales_Model_Order::STATE_CANCELED)
            ->where('COALESCE(p.product_id, i.product_id) IS NOT NULL')
            ->group($product)
            ->order('revenue DESC')
            ->limit(self::MAX_ROWS + 1);
        $rows = [];
        foreach ($read->fetchAll($select) as $r) {
            $rows[] = [
                'product_id' => (int) $r['product_id'],
                'qty' => (float) $r['qty'],
                'revenue' => round((float) $r['revenue'], 2),
                'orders' => (int) $r['orders'],
            ];
        }
        $capped = count($rows) > self::MAX_ROWS;
        $count = $read->select()
            ->from(['o' => $orders], ['n' => new Zend_Db_Expr('COUNT(*)'), 'currencies' => new Zend_Db_Expr('COUNT(DISTINCT o.base_currency_code)'), 'currency' => new Zend_Db_Expr('MIN(o.base_currency_code)')])
            ->where('o.created_at >= ?', $range['from'])
            ->where('o.created_at <= ?', $range['to'])
            ->where('o.state <> ?', Mage_Sales_Model_Order::STATE_CANCELED);
        $totals = $read->fetchRow($count);
        $currency = (int) $totals['currencies'] > 1 ? null : ((string) $totals['currency'] ?: (string) Mage::app()->getBaseCurrencyCode());
        return ['data' => [
            'from' => substr($range['from'], 0, 10),
            'to' => substr($range['to'], 0, 10),
            'currency' => $currency,
            'orders' => (int) $totals['n'],
            'capped' => $capped,
            'rows' => array_slice($rows, 0, self::MAX_ROWS),
        ]];
    }
}
