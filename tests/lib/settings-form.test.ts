import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PublicSettings } from '../../src/lib/protocol';
import { buildPatch, connectionTestBlock, formFromSettings, gscKeyComplete, isDirty, secretsDropped } from '../../src/lib/settings-form';

const saved: PublicSettings = {
  shopware: { url: 'https://shop.test', publicUrl: '', user: '', clientId: 'SWIA1', hasPassword: false, hasClientSecret: true, configured: true },
  ai: { provider: 'claude', hasApiKey: true, model: '', viaEnv: false, docker: false, codexModel: '', codexLoggedIn: false },
  image: { hasKey: false, model: '' },
  scopes: { products: true, categories: true, cms: true, media: true, marketing: true, shop: false },
  scopeInfo: {
    marketing: { label: 'Marketing', hint: '' },
    products: { label: 'Produkte', hint: '' }, categories: { label: 'Kategorien', hint: '' }, cms: { label: 'Layouts', hint: '' },
    media: { label: 'Medien', hint: '' }, shop: { label: 'Shop', hint: '' },
  },
};

test('Geheimnisse: leer = unverändert, Entfernen = null, Eingabe = Wert', () => {
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

test('Verbindung testen: ungespeicherte Eingaben blockieren den Test und werden nicht mitgeschrieben', () => {
  assert.equal(connectionTestBlock(false), null);
  const hint = connectionTestBlock(true);
  assert.ok(hint);
  assert.match(hint, /speichern/i);
  assert.match(hint, /gespeichert/i);
});

test('Bereiche und Klartextfelder', () => {
  const f = formFromSettings(saved);
  f.scopes.shop = true;
  f.shopware.url = ' https://neu.test ';
  const p = buildPatch(f);
  assert.equal(p.scopes?.shop, true);
  assert.equal(p.shopware?.url, 'https://neu.test');
});

test('Search-Console-Schlüssel: automatisch gespeichert wird erst ein vollständiges Service-Konto-JSON', () => {
  const key = JSON.stringify({ type: 'service_account', client_email: 'lotse@projekt.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });
  assert.equal(gscKeyComplete(key), true);
  assert.equal(gscKeyComplete(key.slice(0, -10)), false, 'halb eingefügt');
  assert.equal(gscKeyComplete(''), false);
  assert.equal(gscKeyComplete('null'), false);
  assert.equal(gscKeyComplete('[]'), false);
  assert.equal(gscKeyComplete(JSON.stringify({ client_email: 'x@y' })), false, 'ohne privaten Schlüssel');
  assert.equal(gscKeyComplete(JSON.stringify({ private_key: 'k', client_email: '' })), false, 'leere E-Mail');
  assert.equal(gscKeyComplete(JSON.stringify({ private_key: 1, client_email: 'x@y' })), false);
});

test('secretsDropped: Hinweis nur, wenn der Server Geheimnisse verworfen hat, die das Formular nicht entfernen wollte', () => {
  const f = formFromSettings(saved);
  const after: PublicSettings = { ...saved, shopware: { ...saved.shopware, url: 'https://anderer.test', hasClientSecret: false, configured: false } };
  assert.equal(secretsDropped(saved, after, f, 'shopware'), true, 'Adresse auf anderen Server');
  assert.equal(secretsDropped(saved, saved, f, 'shopware'), false);
  const removed = { ...f, secrets: { ...f.secrets, clientSecret: { value: '', remove: true } } };
  assert.equal(secretsDropped(saved, after, removed, 'shopware'), false, 'selbst entfernt: kein Hinweis');
  assert.equal(secretsDropped(saved, after, f, 'magento'), false, 'andere Plattform');
});
