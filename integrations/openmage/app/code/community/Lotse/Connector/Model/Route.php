<?php
/**
 * Pure routing logic without Magento dependency: route table of API v1 and path matching.
 * Path = part after "/lotse-api/", e.g. "v1/products/HH-VASE-KIESEL/images/12".
 * Placeholders {name} match exactly one path segment (URL-decoded).
 */
class Lotse_Connector_Model_Route
{
    /**
     * Route table: [method, pattern, model alias, model method]. Order matters
     * (fixed segments like "products/attributes" come before placeholders).
     * Deliberately NOT included: customers, orders, quotes, invoices, users, api users, payments, newsletter.
     * v1/sales only returns sums per product (no single orders, no customer data).
     */
    public static function table()
    {
        return [
            ['GET',    'v1/info',                              'info',       'info'],
            ['GET',    'v1/products/attributes',               'attribute',  'listProductAttributes'],
            ['GET',    'v1/products',                          'product',    'listProducts'],
            ['POST',   'v1/products',                          'product',    'createProduct'],
            ['GET',    'v1/products/{sku}',                    'product',    'getProduct'],
            ['PATCH',  'v1/products/{sku}',                    'product',    'updateProduct'],
            ['PUT',    'v1/products/{sku}',                    'product',    'updateProduct'],
            ['DELETE', 'v1/products/{sku}',                    'product',    'deleteProduct'],
            ['GET',    'v1/products/{sku}/stock',              'product',    'getStock'],
            ['PUT',    'v1/products/{sku}/stock',              'product',    'updateStock'],
            ['GET',    'v1/products/{sku}/categories',         'product',    'getCategoryAssignments'],
            ['PUT',    'v1/products/{sku}/categories',         'product',    'updateCategoryAssignments'],
            ['GET',    'v1/products/{sku}/images',             'media',      'listImages'],
            ['POST',   'v1/products/{sku}/images',             'media',      'addImage'],
            ['PATCH',  'v1/products/{sku}/images/{id}',        'media',      'updateImage'],
            ['DELETE', 'v1/products/{sku}/images/{id}',        'media',      'removeImage'],
            ['GET',    'v1/media/{sku}',                       'media',      'listImages'],
            ['GET',    'v1/categories',                        'category',   'listCategories'],
            ['GET',    'v1/categories/{id}',                   'category',   'getCategory'],
            ['PATCH',  'v1/categories/{id}',                   'category',   'updateCategory'],
            ['GET',    'v1/cms/pages',                         'cms',        'listPages'],
            ['POST',   'v1/cms/pages',                         'cms',        'createPage'],
            ['GET',    'v1/cms/pages/{id}',                    'cms',        'getPage'],
            ['PATCH',  'v1/cms/pages/{id}',                    'cms',        'updatePage'],
            ['PUT',    'v1/cms/pages/{id}',                    'cms',        'updatePage'],
            ['DELETE', 'v1/cms/pages/{id}',                    'cms',        'deletePage'],
            ['GET',    'v1/cms/blocks',                        'cms',        'listBlocks'],
            ['POST',   'v1/cms/blocks',                        'cms',        'createBlock'],
            ['GET',    'v1/cms/blocks/{id}',                   'cms',        'getBlock'],
            ['PATCH',  'v1/cms/blocks/{id}',                   'cms',        'updateBlock'],
            ['PUT',    'v1/cms/blocks/{id}',                   'cms',        'updateBlock'],
            ['DELETE', 'v1/cms/blocks/{id}',                   'cms',        'deleteBlock'],
            ['GET',    'v1/salesrules',                        'salesrule',  'listRules'],
            ['POST',   'v1/salesrules',                        'salesrule',  'createRule'],
            ['GET',    'v1/salesrules/{id}',                   'salesrule',  'getRule'],
            ['PATCH',  'v1/salesrules/{id}',                   'salesrule',  'updateRule'],
            ['PUT',    'v1/salesrules/{id}',                   'salesrule',  'updateRule'],
            ['DELETE', 'v1/salesrules/{id}',                   'salesrule',  'deleteRule'],
            ['GET',    'v1/salesrules/{id}/coupons',           'salesrule',  'listCoupons'],
            ['GET',    'v1/sales',                             'sales',      'productTotals'],
            ['GET',    'v1/urlrewrites',                       'urlrewrite', 'listRewrites'],
            ['POST',   'v1/urlrewrites',                       'urlrewrite', 'createRewrite'],
            ['GET',    'v1/urlrewrites/{id}',                  'urlrewrite', 'getRewrite'],
            ['DELETE', 'v1/urlrewrites/{id}',                  'urlrewrite', 'deleteRewrite'],
        ];
    }

    /**
     * Finds the route for method + path.
     * @return array|null ['model'=>..., 'method'=>..., 'params'=>[...]] or null; for a matching path
     *                    with the wrong method ['method_not_allowed'=>[allowed methods]]
     */
    public static function match($httpMethod, $path, array $table = null)
    {
        $table = $table === null ? self::table() : $table;
        $httpMethod = strtoupper((string) $httpMethod);
        $segments = self::segments($path);
        $allowed = [];
        foreach ($table as $route) {
            $params = self::matchPattern($route[1], $segments);
            if ($params === null) {
                continue;
            }
            if ($route[0] === $httpMethod) {
                return ['model' => $route[2], 'method' => $route[3], 'params' => $params];
            }
            $allowed[] = $route[0];
        }
        if ($allowed !== []) {
            return ['method_not_allowed' => array_values(array_unique($allowed))];
        }
        return null;
    }

    /** @return string[] URL-decoded segments without empty entries */
    public static function segments($path)
    {
        $path = trim((string) $path, '/');
        if ($path === '') {
            return [];
        }
        $out = [];
        foreach (explode('/', $path) as $seg) {
            if ($seg !== '') {
                $out[] = rawurldecode($seg);
            }
        }
        return $out;
    }

    /** @return array|null placeholder values or null if the pattern does not match */
    public static function matchPattern($pattern, array $segments)
    {
        $parts = explode('/', $pattern);
        if (count($parts) !== count($segments)) {
            return null;
        }
        $params = [];
        foreach ($parts as $i => $part) {
            if (strlen($part) > 2 && $part[0] === '{' && substr($part, -1) === '}') {
                $params[substr($part, 1, -1)] = $segments[$i];
            } elseif ($part !== $segments[$i]) {
                return null;
            }
        }
        return $params;
    }
}
