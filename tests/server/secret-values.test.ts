import '../isolate-data';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stored values that count as secrets for the publish scan and redact(): plausible ones everywhere, weak ones only as a credential.
const { plausibleSecret, findToken, redactWeak } = await import('../../src/server/secret-values');
const { redact, knownSecrets, weakSecrets, updateSettings } = await import('../../src/server/settings');
const { saveSandbox } = await import('../../src/server/sandbox/env');

test('plausibleSecret: long or mixed values; common words and package names (also with digits appended) are not', () => {
  for (const v of ['Kx7!pQ3z', 'mein-shop-passwort', 'Größe-Passwort1', 'a1b2c3d4e5f6', 'correcthorsebatterystaple', 'sk-ant-abcdefghijklmnopqrstuvwxyz']) assert.ok(plausibleSecret(v), v);
  for (const v of ['shopware', 'Shopware', 'shopware1', 'Shopware2024!', 'admin123', 'password', 'passwort!', 'geheim', 'abc', 'aaaaaaaaaaaaaaaaaaaa', 'kurzpw12', '', null, undefined]) assert.ok(!plausibleSecret(v), String(v));
});

test('findToken: only where the value stands as a token of its own', () => {
  assert.equal(findToken('"shopware/core"', 'shopware'), 1);
  assert.equal(findToken('myshopware', 'shopware'), -1);
  assert.equal(findToken('shopware_core', 'shopware'), -1);
  assert.equal(findToken('xx Kx7!pQ3z!', 'Kx7!pQ3z'), 3);
  assert.equal(findToken('aKx7!pQ3z', 'Kx7!pQ3z'), -1);
  assert.equal(findToken('pw=!abc12345', '!abc12345'), 3, 'a value starting with punctuation needs no boundary before it');
});

test('redactWeak: only as the value of a credential key', () => {
  assert.equal(redactWeak('Shopware 6.7 läuft (shopware/core)', 'shopware'), 'Shopware 6.7 läuft (shopware/core)');
  assert.equal(redactWeak('password: shopware', 'shopware'), 'password: •••');
  assert.equal(redactWeak('{"password":"shopware","user":"admin"}', 'shopware'), '{"password":"•••","user":"admin"}');
  assert.equal(redactWeak("SHOPWARE_PASSWORD='shopware'", 'shopware'), "SHOPWARE_PASSWORD='•••'");
  assert.equal(redactWeak('mysql --password shopware', 'shopware'), 'mysql --password •••');
  assert.equal(redactWeak('client_secret=shopware2', 'shopware'), 'client_secret=shopware2', 'another value');
});

test('redact: a weak shop password does not blank out normal words for the AI or logs; a strong one goes everywhere', () => {
  updateSettings({ shopware: { url: 'http://shop', user: 'admin', password: 'shopware' } });
  saveSandbox({ envVars: [{ key: 'API_SECRET', secret: true, value: 'Kx7!pQ3z-Lm9w' }, { key: 'DB_PASS', secret: true, value: 'admin123' }] });
  try {
    assert.ok(!knownSecrets().includes('shopware') && weakSecrets().includes('shopware'));
    assert.ok(knownSecrets().includes(Buffer.from('Kx7!pQ3z-Lm9w').toString('hex')), 'encodings of plausible sandbox secrets');
    assert.ok(!knownSecrets().includes(Buffer.from('admin123').toString('hex')), 'no encodings of weak ones');
    assert.equal(redact('platform=shopware shop=Shopware composer require shopware/core'), 'platform=shopware shop=Shopware composer require shopware/core');
    assert.equal(redact('login failed: password=shopware'), 'login failed: password=•••');
    assert.equal(redact('DB_PASS=admin123 und admin123'), 'DB_PASS=••• und admin123');
    assert.equal(redact('token Kx7!pQ3z-Lm9w in shopware'), 'token ••• in shopware');
  } finally {
    updateSettings({ shopware: { password: null } });
    saveSandbox({ envVars: [] });
  }
});
