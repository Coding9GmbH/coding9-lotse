import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PublicSettings } from '../../src/lib/protocol';
import { buildPatch, connectionTestBlock, formFromSettings, gscKeyComplete, isDirty, secretsDropped } from '../../src/lib/settings-form';

const saved: PublicSettings = {
  shopware: { url: 'https://shop.test', publicUrl: '', user: '', clientId: 'SWIA1', hasPassword: false, hasClientSecret: true, configured: true },
  ai: { provider: 'claude', hasApiKey: true, model: '', viaEnv: false, docker: false, codexModel: '', codexLoggedIn: false },
  image: { hasKey: false, model: '' },
  scopes: { products: true, manufacturers: true, categories: true, cms: true, media: true, marketing: true, shop: false, gsc: true, sistrix: true, sales: false, web: false },
  scopeInfo: {
    manufacturers: { label: 'Hersteller', hint: '' }, gsc: { label: 'Search Console', hint: '' }, sistrix: { label: 'Sistrix', hint: '' }, web: { label: 'Internetrecherche', hint: '' }, sales: { label: 'Abverkauf', hint: '' },
    marketing: { label: 'Marketing', hint: '' },
    products: { label: 'Produkte', hint: '' }, categories: { label: 'Kategorien', hint: '' }, cms: { label: 'Layouts', hint: '' },
    media: { label: 'Medien', hint: '' }, shop: { label: 'Shop', hint: '' },
  },
};

test('secrets: empty = unchanged, remove = null, input = value', () => {
  const f = formFromSettings(saved);
  assert.equal(f.shopware.auth, 'integration');
  let p = buildPatch(f);
  assert.equal(p.shopware?.clientSecret, undefined);
  assert.equal(p.ai?.apiKey, undefined);
  assert.equal(isDirty(f, saved), false);

  f.secrets.clientSecret = { value: '', remove: true };
  f.secrets.apiKey = { value: '  sk-ant-x  ', remove: false };
  p = buildPatch(f);
  assert.equal(p.shopware?.clientSecret, null);
  assert.equal(p.ai?.apiKey, 'sk-ant-x');
  assert.equal(isDirty(f, saved), true);
});

test('test connection: unsaved input blocks the test and is not written along', () => {
  assert.equal(connectionTestBlock(false), null);
  const hint = connectionTestBlock(true);
  assert.ok(hint);
  assert.match(hint, /speichern/i);
  assert.match(hint, /gespeichert/i);
});

test('scopes and plain-text fields', () => {
  const f = formFromSettings(saved);
  f.scopes.shop = true;
  f.shopware.url = ' https://neu.test ';
  const p = buildPatch(f);
  assert.equal(p.scopes?.shop, true);
  assert.equal(p.shopware?.url, 'https://neu.test');
});

test('Search Console key: only a complete service account JSON is auto-saved', () => {
  const key = JSON.stringify({ type: 'service_account', client_email: 'lotse@projekt.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });
  assert.equal(gscKeyComplete(key), true);
  assert.equal(gscKeyComplete(key.slice(0, -10)), false, 'half pasted');
  assert.equal(gscKeyComplete(''), false);
  assert.equal(gscKeyComplete('null'), false);
  assert.equal(gscKeyComplete('[]'), false);
  assert.equal(gscKeyComplete(JSON.stringify({ client_email: 'x@y' })), false, 'without private key');
  assert.equal(gscKeyComplete(JSON.stringify({ private_key: 'k', client_email: '' })), false, 'empty email');
  assert.equal(gscKeyComplete(JSON.stringify({ private_key: 1, client_email: 'x@y' })), false);
});

test('secretsDropped: notice only if the server discarded secrets that the form did not intend to remove', () => {
  const f = formFromSettings(saved);
  const after: PublicSettings = { ...saved, shopware: { ...saved.shopware, url: 'https://anderer.test', hasClientSecret: false, configured: false } };
  assert.equal(secretsDropped(saved, after, f, 'shopware'), true, 'address points to another server');
  assert.equal(secretsDropped(saved, saved, f, 'shopware'), false);
  const removed = { ...f, secrets: { ...f.secrets, clientSecret: { value: '', remove: true } } };
  assert.equal(secretsDropped(saved, after, removed, 'shopware'), false, 'removed by the user: no notice');
  assert.equal(secretsDropped(saved, after, f, 'magento'), false, 'other platform');
});
