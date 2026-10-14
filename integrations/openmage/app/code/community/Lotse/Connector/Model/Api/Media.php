<?php
/**
 * Product images (media gallery): list, add (Base64 or URL), label/position/roles/disable,
 * remove. Label and position can be overridden per store view (null = use default value).
 * New images are always created in the global scope.
 */
class Lotse_Connector_Model_Api_Media extends Lotse_Connector_Model_Api_Abstract
{
    public const MAX_BYTES = 20 * 1024 * 1024;
    public const ROLES = ['image', 'small_image', 'thumbnail'];

    public function listImages(array $params)
    {
        $product = $this->productApi()->loadProduct($params['sku']);
        return ['data' => $this->formatImages($product)];
    }

    /** @return Lotse_Connector_Model_Api_Product */
    protected function productApi()
    {
        return Mage::getModel('lotse_connector/api_product')->setContext($this->storeId, $this->query, $this->body);
    }

    public function formatImages(Mage_Catalog_Model_Product $product)
    {
        $gallery = $product->getMediaGallery('images');
        if (!is_array($gallery)) {
            return [];
        }
        $config = Mage::getSingleton('catalog/product_media_config');
        $roles = [];
        foreach ($product->getMediaAttributes() as $code => $attribute) {
            $roles[$code] = $product->getData($code);
        }
        $storeRows = $this->storeValueRows(array_column($gallery, 'value_id'));
        $mediaBase = $this->getUrlStore()->getBaseUrl(Mage_Core_Model_Store::URL_TYPE_MEDIA);
        $out = [];
        foreach ($gallery as $image) {
            $types = [];
            foreach ($roles as $code => $file) {
                if ($file === $image['file']) {
                    $types[] = $code;
                }
            }
            $out[] = [
                'id' => (int) $image['value_id'],
                'file' => $image['file'],
                'url' => $mediaBase . $config->getBaseMediaUrlAddition() . $image['file'],
                'label' => $image['label'] === null ? '' : (string) $image['label'],
                'position' => (int) $image['position'],
                'disabled' => (bool) $image['disabled'],
                'types' => $types,
                'label_use_default' => (bool) ($image['label_use_default'] ?? false),
                'position_use_default' => (bool) ($image['position_use_default'] ?? false),
                'has_store_values' => $this->storeId > 0 && isset($storeRows[(int) $image['value_id']]),
            ];
        }
        usort($out, function ($a, $b) {
            return [$a['position'], $a['id']] <=> [$b['position'], $b['id']];
        });
        return $out;
    }

    /** value_ids with their own row in the requested store (store > 0 only). */
    protected function storeValueRows(array $valueIds)
    {
        if ($this->storeId === 0 || $valueIds === []) {
            return [];
        }
        $resource = Mage::getSingleton('core/resource');
        $read = $resource->getConnection('core_read');
        $ids = $read->fetchCol($read->select()
            ->from($resource->getTableName('catalog/product_attribute_media_gallery_value'), 'value_id')
            ->where('value_id IN (?)', array_map('intval', $valueIds))
            ->where('store_id = ?', $this->storeId));
        return array_fill_keys(array_map('intval', $ids), true);
    }

    /** @return Mage_Catalog_Model_Product_Attribute_Backend_Media */
    protected function backend(Mage_Catalog_Model_Product $product)
    {
        $attribute = Mage::getSingleton('eav/config')->getAttribute(Mage_Catalog_Model_Product::ENTITY, 'media_gallery');
        /** @var Mage_Catalog_Model_Product_Attribute_Backend_Media $backend */
        $backend = $attribute->getBackend();
        $backend->setAttribute($attribute);
        return $backend;
    }

    protected function findImage(Mage_Catalog_Model_Product $product, $id)
    {
        foreach ((array) $product->getMediaGallery('images') as $image) {
            if ((int) $image['value_id'] === (int) $id) {
                return $image;
            }
        }
        throw Lotse_Connector_Model_Exception::notFound('Bild nicht gefunden: ' . $id);
    }

    protected function roles($types)
    {
        if (!is_array($types)) {
            throw Lotse_Connector_Model_Exception::validation('types muss eine Liste sein (image, small_image, thumbnail).');
        }
        foreach ($types as $t) {
            if (!in_array($t, self::ROLES, true)) {
                throw Lotse_Connector_Model_Exception::validation('Unbekannte Bildrolle: ' . $t, ['allowed' => self::ROLES]);
            }
        }
        return array_values(array_unique($types));
    }

    /**
     * POST /v1/products/{sku}/images: {base64 | url, filename?, label?, position?, types?, disabled?}.
     * The file is moved to media/catalog/product/<a>/<b>/ (file name gets numbered on collision).
     */
    public function addImage(array $params)
    {
        $body = $this->body();
        $product = $this->productApi()->loadProduct($params['sku'], 0);
        $tmp = $this->fetchToTmp($body);
        try {
            $backend = $this->backend($product);
            $types = isset($body['types']) ? $this->roles($body['types']) : [];
            $file = $backend->addImage($product, $tmp, $types, true, !empty($body['disabled']));
            $data = [];
            if (isset($body['label'])) {
                $data['label'] = (string) $body['label'];
            }
            if (isset($body['position'])) {
                $data['position'] = (int) $body['position'];
            }
            if ($data !== []) {
                $backend->updateImage($product, $file, $data);
            }
            $product->save();
        } finally {
            if (is_file($tmp)) {
                @unlink($tmp);
            }
        }
        $fresh = $this->productApi()->loadProduct('id:' . $product->getId(), 0);
        $images = $this->formatImages($fresh);
        $created = null;
        foreach ($images as $img) {
            if ($img['file'] === $file) {
                $created = $img;
            }
        }
        $this->status = 201;
        return ['data' => ['image' => $created, 'images' => $images]];
    }

    /** Loads Base64 data or an http(s) URL into a temporary file under var/tmp/lotse. */
    protected function fetchToTmp(array $body)
    {
        $filename = isset($body['filename']) ? basename((string) $body['filename']) : '';
        if (!empty($body['base64'])) {
            $raw = $body['base64'];
            if (preg_match('#^data:([^;]+);base64,#', $raw, $m)) {
                $raw = substr($raw, strlen($m[0]));
            }
            $bytes = base64_decode($raw, true);
            if ($bytes === false) {
                throw Lotse_Connector_Model_Exception::validation('base64 ist ungültig.');
            }
        } elseif (!empty($body['url'])) {
            $url = (string) $body['url'];
            $bytes = $this->download($url);
            if ($filename === '') {
                $filename = basename((string) parse_url($url, PHP_URL_PATH));
            }
        } else {
            throw Lotse_Connector_Model_Exception::validation('base64 oder url erwartet.');
        }
        if (strlen($bytes) > self::MAX_BYTES) {
            throw Lotse_Connector_Model_Exception::validation('Bild zu groß (max. 20 MB).');
        }
        $info = @getimagesizefromstring($bytes);
        if ($info === false) {
            throw Lotse_Connector_Model_Exception::validation('Daten sind kein gültiges Bild.');
        }
        $extByMime = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp'];
        $mime = $info['mime'] ?? '';
        if (!isset($extByMime[$mime])) {
            throw Lotse_Connector_Model_Exception::validation('Nicht unterstützter Bildtyp: ' . $mime);
        }
        $ext = $extByMime[$mime];
        $base = $filename !== '' ? pathinfo($filename, PATHINFO_FILENAME) : 'bild';
        $base = preg_replace('/[^a-zA-Z0-9_-]+/', '-', $base);
        $base = trim($base, '-') ?: 'bild';

        $dir = Mage::getBaseDir('var') . DS . 'tmp' . DS . 'lotse';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            Mage::log('Lotse: Temp-Verzeichnis nicht anlegbar: ' . $dir, Zend_Log::ERR);
            throw new Lotse_Connector_Model_Exception(500, 'io', 'Temp-Verzeichnis unter var/tmp nicht anlegbar (Rechte prüfen).');
        }
        $tmp = $dir . DS . $base . '.' . $ext;
        if (file_exists($tmp)) {
            $tmp = $dir . DS . $base . '-' . bin2hex(random_bytes(3)) . '.' . $ext;
        }
        if (file_put_contents($tmp, $bytes) === false) {
            throw new Lotse_Connector_Model_Exception(500, 'io', 'Temp-Datei nicht schreibbar.');
        }
        return $tmp;
    }

    /**
     * Fetches an http(s) URL server-side. SSRF protection: every hop (including redirects) must point to a
     * public address (no loopback, private, link-local or multicast addresses).
     */
    protected function download($url)
    {
        for ($hop = 0; $hop <= 3; $hop++) {
            if (!preg_match('#^https?://#i', $url)) {
                throw Lotse_Connector_Model_Exception::validation('url muss mit http:// oder https:// beginnen.');
            }
            $host = (string) parse_url($url, PHP_URL_HOST);
            $this->assertPublicHost($host);
            $client = new Varien_Http_Client($url, ['timeout' => 30, 'maxredirects' => 0]);
            try {
                $response = $client->request('GET');
            } catch (Exception $e) {
                Mage::log('Lotse: Bild-Download fehlgeschlagen (' . $url . '): ' . $e->getMessage(), Zend_Log::WARN);
                throw Lotse_Connector_Model_Exception::validation('Bild konnte nicht geladen werden.');
            }
            $status = $response->getStatus();
            if ($status === 200) {
                return $response->getBody();
            }
            if (!in_array($status, [301, 302, 303, 307, 308], true)) {
                throw Lotse_Connector_Model_Exception::validation('Bild konnte nicht geladen werden: HTTP ' . $status);
            }
            $location = (string) $response->getHeader('Location');
            if ($location === '') {
                throw Lotse_Connector_Model_Exception::validation('Bild konnte nicht geladen werden: Weiterleitung ohne Ziel.');
            }
            $url = $this->resolveLocation($url, $location);
        }
        throw Lotse_Connector_Model_Exception::validation('Bild konnte nicht geladen werden: zu viele Weiterleitungen.');
    }

    /** Resolve an absolute or relative Location against the previous URL. */
    protected function resolveLocation($base, $location)
    {
        return Lotse_Connector_Model_Util::resolveLocation($base, $location);
    }

    /** All addresses of the host (IP literal or DNS A/AAAA) must be public. */
    protected function assertPublicHost($host)
    {
        $host = trim($host, '[]');
        if ($host === '') {
            throw Lotse_Connector_Model_Exception::validation('url ohne Host.');
        }
        if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
            $ips = [$host];
        } else {
            $ips = @gethostbynamel($host) ?: [];
            foreach ((array) @dns_get_record($host, DNS_AAAA) as $rec) {
                if (!empty($rec['ipv6'])) {
                    $ips[] = $rec['ipv6'];
                }
            }
            if ($ips === []) {
                throw Lotse_Connector_Model_Exception::validation('url: Host nicht auflösbar: ' . $host);
            }
        }
        foreach ($ips as $ip) {
            if (!Lotse_Connector_Model_Net::isPublicIp($ip)) {
                throw Lotse_Connector_Model_Exception::validation('url zeigt auf eine private, lokale oder reservierte Adresse: ' . $host, ['field' => 'url']);
            }
        }
    }

    /**
     * Write an image's gallery values (label, position, disabled) directly in the store scope.
     * A product save in store scope would copy every attribute and every image as a store value in Magento 1;
     * here exactly one row (value_id, store_id) is created. null for label/position = use default value.
     * A store row without its own value (label and position NULL, disabled as global) is removed.
     */
    protected function writeGalleryValue($valueId, array $data)
    {
        $resource = Mage::getSingleton('core/resource');
        $write = $resource->getConnection('core_write');
        $table = $resource->getTableName('catalog/product_attribute_media_gallery_value');
        $rows = [];
        foreach ($write->fetchAll($write->select()->from($table)->where('value_id = ?', (int) $valueId)->where('store_id IN (?)', [0, $this->storeId])) as $row) {
            $rows[(int) $row['store_id']] = $row;
        }
        $default = $rows[0] ?? ['label' => null, 'position' => null, 'disabled' => 0];
        $row = $rows[$this->storeId] ?? ['label' => null, 'position' => null, 'disabled' => (int) $default['disabled']];
        foreach (['label', 'position'] as $field) {
            if (!array_key_exists($field, $data)) {
                continue;
            }
            if ($data[$field] === null || ($field === 'label' && $this->storeId === 0 && (string) $data[$field] === '')) {
                // globally, "no label" is NULL (as after upload); in store scope "" is a separate empty value
                $row[$field] = null;
            } else {
                $row[$field] = $field === 'position' ? (int) $data[$field] : (string) $data[$field];
            }
        }
        if (array_key_exists('disabled', $data)) {
            $row['disabled'] = (int) (bool) $data['disabled'];
        }
        $ownValue = $row['label'] !== null || $row['position'] !== null || (int) $row['disabled'] !== (int) $default['disabled'];
        if ($this->storeId > 0 && !$ownValue) {
            $write->delete($table, ['value_id = ?' => (int) $valueId, 'store_id = ?' => $this->storeId]);
            return;
        }
        $write->insertOnDuplicate($table, [
            'value_id' => (int) $valueId,
            'store_id' => $this->storeId,
            'label' => $row['label'],
            'position' => $row['position'],
            'disabled' => (int) $row['disabled'],
        ], ['label', 'position', 'disabled']);
    }

    /**
     * Image roles in store scope via catalog/product_action::updateAttributes (like PATCH /v1/products):
     * only roles that change are written, inherited unchanged roles stay inherited.
     */
    protected function writeRoles(Mage_Catalog_Model_Product $product, array $image, array $types)
    {
        $set = [];
        foreach (self::ROLES as $role) {
            $current = $product->getData($role);
            $want = in_array($role, $types, true) ? $image['file'] : ($current === $image['file'] ? 'no_selection' : null);
            if ($want !== null && $want !== $current) {
                $set[$role] = $want;
            }
        }
        if ($set !== []) {
            Mage::getSingleton('catalog/product_action')->updateAttributes([$product->getId()], $set, $this->storeId);
        }
    }

    /** After direct gallery writes: updated_at and product cache as after a save. */
    protected function afterGalleryWrite(Mage_Catalog_Model_Product $product)
    {
        $resource = Mage::getSingleton('core/resource');
        $resource->getConnection('core_write')->update(
            $resource->getTableName('catalog/product'),
            ['updated_at' => Varien_Date::now()],
            ['entity_id = ?' => (int) $product->getId()]
        );
        $product->cleanModelCache();
    }

    /**
     * PATCH /v1/products/{sku}/images/{id}: {label?, position?, disabled?, types?}.
     * label/position null = use default value (store > 0 only). types = exact roles of this image.
     */
    public function updateImage(array $params)
    {
        $body = $this->body();
        $product = $this->productApi()->loadProduct($params['sku']);
        $image = $this->findImage($product, $params['id']);
        $values = [];
        $changed = [];
        foreach (['label', 'position'] as $field) {
            if (!array_key_exists($field, $body)) {
                continue;
            }
            if ($body[$field] === null && $this->storeId === 0) {
                throw Lotse_Connector_Model_Exception::validation($field . ': null (Standardwert) nur im Store-View-Scope.', ['field' => $field]);
            }
            $values[$field] = $body[$field];
            $changed[] = $field;
        }
        if (array_key_exists('disabled', $body)) {
            $values['disabled'] = (bool) $body['disabled'];
            $changed[] = 'disabled';
        }
        $types = array_key_exists('types', $body) ? $this->roles($body['types']) : null;
        if ($types !== null) {
            $changed[] = 'types';
        }
        if ($changed === []) {
            throw Lotse_Connector_Model_Exception::validation('label, position, disabled oder types erwartet.');
        }
        if ($values !== []) {
            $this->writeGalleryValue($image['value_id'], $values);
        }
        if ($types !== null) {
            $this->writeRoles($product, $image, $types);
        }
        $this->afterGalleryWrite($product);
        $fresh = $this->productApi()->loadProduct('id:' . $product->getId());
        $images = $this->formatImages($fresh);
        $updated = null;
        foreach ($images as $img) {
            if ($img['id'] === (int) $image['value_id']) {
                $updated = $img;
            }
        }
        return ['data' => ['image' => $updated, 'images' => $images, '_write' => ['changed' => array_values(array_unique($changed))]]];
    }

    /**
     * DELETE /v1/products/{sku}/images/{id}?mode=disable|delete. Default: disable (exactly undoable).
     * delete removes the gallery entry in all stores; the file stays if other products use it.
     */
    public function removeImage(array $params)
    {
        $mode = (string) $this->q('mode', 'disable');
        $product = $this->productApi()->loadProduct($params['sku'], $mode === 'delete' ? 0 : $this->storeId);
        $image = $this->findImage($product, $params['id']);
        $before = null;
        foreach ($this->formatImages($product) as $img) {
            if ($img['id'] === (int) $image['value_id']) {
                $before = $img;
            }
        }
        if ($mode === 'delete') {
            // loaded globally (store 0): the product save removes the gallery entry in all stores without creating store copies
            $this->backend($product)->removeImage($product, $image['file']);
            foreach (self::ROLES as $role) {
                if ($product->getData($role) === $image['file']) {
                    $product->setData($role, 'no_selection');
                }
            }
            $product->save();
        } elseif ($mode === 'disable') {
            $this->writeGalleryValue($image['value_id'], ['disabled' => true]);
            $this->afterGalleryWrite($product);
        } else {
            throw Lotse_Connector_Model_Exception::validation('mode muss disable oder delete sein.');
        }
        $fileDeleted = false;
        if ($mode === 'delete' && !$this->fileInUse($image['file'])) {
            // OpenMage only deletes the database row when removing from the gallery; we clean up the file
            $path = Mage::getSingleton('catalog/product_media_config')->getMediaPath($image['file']);
            $fileDeleted = is_file($path) && @unlink($path);
        }
        $fresh = $this->productApi()->loadProduct('id:' . $product->getId());
        return ['data' => ['mode' => $mode, 'before' => $before, 'file_deleted' => $fileDeleted, 'images' => $this->formatImages($fresh)]];
    }

    /** Does any gallery (any product) or image role still reference the file? */
    protected function fileInUse($file)
    {
        $resource = Mage::getSingleton('core/resource');
        $read = $resource->getConnection('core_read');
        $gallery = $read->fetchOne($read->select()
            ->from($resource->getTableName('catalog/product_attribute_media_gallery'), 'value_id')
            ->where('value = ?', $file)->limit(1));
        if ($gallery) {
            return true;
        }
        $entityType = Mage::getSingleton('eav/config')->getEntityType(Mage_Catalog_Model_Product::ENTITY);
        $role = $read->fetchOne($read->select()
            ->from(['v' => $resource->getTableName('catalog/product') . '_varchar'], 'value_id')
            ->join(['a' => $resource->getTableName('eav/attribute')], 'a.attribute_id = v.attribute_id', [])
            ->where('a.entity_type_id = ?', (int) $entityType->getId())
            ->where('a.frontend_input = ?', 'media_image')
            ->where('v.value = ?', $file)->limit(1));
        return (bool) $role;
    }
}
