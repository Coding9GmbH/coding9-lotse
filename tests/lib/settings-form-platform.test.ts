import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PublicSettings } from '../../src/lib/protocol';
import { authOf, buildPatch, fieldValue, formFromSettings, hasSecret, isDirty, platformAvailable, savedConfigured, secretState, withAuth, withFieldValue, withSecret } from '../../src/lib/settings-form';

const saved: PublicSettings = {
  shopware: { url: 'https://shop.test', publicUrl: '', user: 'admin', clientId: '', hasPassword: true, hasClientSecret: false, configured: true },
  platform: 'shopware',
  platforms: {
    shopify: { label: 'Shopify', values: { storeDomain: 'holm.myshopify.com', publicUrl: '', apiVersion: '' }, has: { accessToken: true }, configured: true, available: false },
    magento: { label: 'Magento', values: { url: '', publicUrl: '', storeCode: '', user: 'admin' }, has: { accessToken: false, password: false }, configured: false, available: false },
  },
  ai: { provider: 'claude', hasApiKey: true, model: '', viaEnv: false, docker: false, codexModel: '', codexLoggedIn: false },
  image: { hasKey: false, model: '' },
  scopes: { products: true, categories: true, cms: true, media: true, marketing: true, shop: true },
  scopeInfo: { products: { label: '', hint: '' }, categories: { label: '', hint: '' }, cms: { label: '', hint: '' }, media: { label: '', hint: '' }, marketing: { label: '', hint: '' }, shop: { label: '', hint: '' } },
};

test('Plattform-Formular: Shopware über feste Felder, Shopify/Magento generisch, Zugangsart aus gespeicherten Werten', () => {
  const f = formFromSettings(saved);
  assert.equal(f.platform, 'shopware');
  assert.equal(fieldValue(f, 'shopware', 'url'), 'https://shop.test');
  assert.equal(authOf(f, 'shopware'), 'user');
  assert.equal(fieldValue(f, 'shopify', 'storeDomain'), 'holm.myshopify.com');
  assert.equal(authOf(f, 'shopify'), 'token');
  assert.equal(authOf(f, 'magento'), 'user', 'Magento: Benutzer gesetzt → Admin-Benutzer');
  assert.equal(hasSecret(saved, 'shopware', 'password'), true);
  assert.equal(hasSecret(saved, 'shopify', 'accessToken'), true);
  assert.equal(savedConfigured(saved, 'shopify'), true);
  assert.equal(platformAvailable(saved, 'magento'), false);
  assert.equal(isDirty(f, saved), false);
});

test('Plattform wechseln und Felder setzen: Patch enthält Plattform, Klartext getrimmt, Geheimnis nur bei Eingabe', () => {
  let f = formFromSettings(saved);
  f = { ...f, platform: 'magento' };
  f = withFieldValue(f, 'magento', 'url', ' https://mage.test ');
  f = withAuth(f, 'magento', 'integration');
  f = withSecret(f, 'magento', 'accessToken', { value: ' tok ', remove: false });
  f = withSecret(f, 'shopify', 'accessToken', { value: '', remove: true });
  assert.equal(secretState(f, 'magento', 'accessToken').value, ' tok ');
  const p = buildPatch(f);
  assert.equal(p.platform, 'magento');
  assert.equal(p.magento?.url, 'https://mage.test');
  assert.equal(p.magento?.accessToken, 'tok');
  assert.equal(p.magento?.password, undefined, 'unverändert');
  assert.equal(p.shopify?.accessToken, null, 'Entfernen = null');
  assert.equal(isDirty(f, saved), true);
  // Shopware-Felder laufen weiter über die alten Schlüssel
  const g = withSecret(withFieldValue(formFromSettings(saved), 'shopware', 'clientId', 'SWIA2'), 'shopware', 'clientSecret', { value: 'geheim', remove: false });
  assert.equal(buildPatch(g).shopware?.clientId, 'SWIA2');
  assert.equal(buildPatch(g).shopware?.clientSecret, 'geheim');
});

test('Ältere Server ohne Plattform-Angaben: Shopware als Standard', () => {
  const old = { ...saved, platform: undefined, platforms: undefined };
  const f = formFromSettings(old);
  assert.equal(f.platform, 'shopware');
  assert.equal(fieldValue(f, 'shopify', 'storeDomain'), '');
  assert.equal(platformAvailable(old, 'shopware'), true);
});
