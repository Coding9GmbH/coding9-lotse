import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PublicSettings } from '../../src/lib/protocol';
import { buildPatch, formFromSettings, isDirty } from '../../src/lib/settings-form';

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

test('Bereiche und Klartextfelder', () => {
  const f = formFromSettings(saved);
  f.scopes.shop = true;
  f.shopware.url = ' https://neu.test ';
  const p = buildPatch(f);
  assert.equal(p.scopes?.shop, true);
  assert.equal(p.shopware?.url, 'https://neu.test');
});
