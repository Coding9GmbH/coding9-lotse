import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-settings-platform-'));
for (const k of Object.keys(process.env)) if (/^(SHOPWARE_|SHOPIFY_|MAGENTO_|OPENMAGE_|SHOP_PLATFORM$)/.test(k)) delete process.env[k];

const { getSettings, publicSettings, updateSettings, redact, aiEnv, shopConfigured, platformConfig } = await import('./settings');
const { kvGet } = await import('./db');

test('Plattform: Standard Shopware, Umgebung SHOP_PLATFORM, gespeicherte Wahl hat Vorrang, Unbekanntes wird ignoriert', () => {
  assert.equal(getSettings().platform, 'shopware');
  process.env.SHOP_PLATFORM = 'magento';
  assert.equal(getSettings().platform, 'magento');
  updateSettings({ platform: 'shopify' });
  assert.equal(getSettings().platform, 'shopify');
  updateSettings({ platform: 'woocommerce' as never });
  assert.equal(getSettings().platform, 'shopify', 'ungültige Plattform ändert nichts');
  process.env.SHOP_PLATFORM = 'quatsch';
  updateSettings({ platform: 'shopware' });
  assert.equal(getSettings().platform, 'shopware');
  delete process.env.SHOP_PLATFORM;
});

test('Shopify-Zugang: Geheimnis verschlüsselt, maskiert in der Oberfläche, eingerichtet erst mit Domain + Token', () => {
  updateSettings({ shopify: { storeDomain: ' haus-holm.myshopify.com ', accessToken: 'shpat_geheimes_token_123' } });
  const raw = kvGet<{ shopify: Record<string, string> }>('settings')!;
  assert.match(raw.shopify.accessToken, /^enc:v1:/);
  assert.equal(raw.shopify.storeDomain, 'haus-holm.myshopify.com');
  assert.equal(getSettings().shopify.accessToken, 'shpat_geheimes_token_123');
  const pub = publicSettings();
  assert.ok(!JSON.stringify(pub).includes('shpat_geheimes_token_123'));
  assert.deepEqual(pub.platforms?.shopify?.has, { clientSecret: false, accessToken: true });
  assert.equal(pub.platforms?.shopify?.values.storeDomain, 'haus-holm.myshopify.com');
  assert.equal(pub.platforms?.shopify?.configured, true);
  assert.equal(pub.platforms?.shopify?.available, true);
  assert.equal(pub.platforms?.magento?.available, true);
  assert.equal(shopConfigured('shopify'), true);
  updateSettings({ shopify: { accessToken: '' } });
  assert.equal(getSettings().shopify.accessToken, 'shpat_geheimes_token_123', 'leer = unverändert');
  updateSettings({ shopify: { accessToken: null } });
  assert.equal(shopConfigured('shopify'), false, 'null = gelöscht');
  // App aus dem Dev Dashboard: Client-ID + Client-Secret genügen ebenfalls; das Secret wird verschlüsselt und geschwärzt
  updateSettings({ shopify: { clientId: 'abc123clientid', clientSecret: 'geheimes_client_secret_789' } });
  assert.equal(shopConfigured('shopify'), true);
  assert.match(kvGet<{ shopify: Record<string, string> }>('settings')!.shopify.clientSecret, /^enc:v1:/);
  assert.ok(!JSON.stringify(publicSettings()).includes('geheimes_client_secret_789'));
  assert.equal(redact('Fehler mit geheimes_client_secret_789'), 'Fehler mit •••');
  updateSettings({ shopify: { clientId: null, clientSecret: null } });
  assert.equal(shopConfigured('shopify'), false);
});

test('Magento: eine vollständige Zugangsart genügt (Token ODER Benutzer + Passwort), Umgebung als Rückfall', () => {
  updateSettings({ magento: { url: 'https://magento.test' } });
  assert.equal(shopConfigured('magento'), false);
  updateSettings({ magento: { user: 'admin', password: 'mage-passwort' } });
  assert.equal(shopConfigured('magento'), true);
  updateSettings({ magento: { user: '', password: null } });
  process.env.MAGENTO_ACCESS_TOKEN = 'env-token-xyz';
  assert.equal(platformConfig('magento').accessToken, 'env-token-xyz');
  assert.equal(shopConfigured('magento'), true);
  delete process.env.MAGENTO_ACCESS_TOKEN;
});

test('OpenMage: Shop-URL + API-Token des Lotse-Moduls, Token verschlüsselt und geschwärzt, Umgebung als Rückfall', () => {
  updateSettings({ openmage: { url: 'https://om.test' } });
  assert.equal(shopConfigured('openmage'), false);
  updateSettings({ openmage: { token: 'lotse_geheimer_token_abc' } });
  assert.equal(shopConfigured('openmage'), true);
  assert.match(kvGet<{ openmage: Record<string, string> }>('settings')!.openmage.token, /^enc:v1:/);
  assert.ok(!JSON.stringify(publicSettings()).includes('lotse_geheimer_token_abc'));
  assert.equal(publicSettings().platforms?.openmage?.available, true);
  assert.equal(redact('Bearer lotse_geheimer_token_abc'), 'Bearer •••');
  updateSettings({ openmage: { token: null } });
  process.env.OPENMAGE_TOKEN = 'env-om-token';
  assert.equal(platformConfig('openmage').token, 'env-om-token'); assert.equal(shopConfigured('openmage'), true);
  delete process.env.OPENMAGE_TOKEN;
  assert.equal(aiEnv().OPENMAGE_URL, undefined);
});

test('Geheimnisse aller Plattformen werden geschwärzt und gehen nie in den KI-Prozess', () => {
  updateSettings({ shopify: { accessToken: 'shpat_nochmal_geheim_456' }, magento: { password: 'mage-passwort-2' } });
  const out = redact('Fehler: shpat_nochmal_geheim_456 / mage-passwort-2');
  assert.ok(!out.includes('shpat_nochmal_geheim_456') && !out.includes('mage-passwort-2'));
  process.env.SHOPIFY_ACCESS_TOKEN = 'x'; process.env.MAGENTO_PASSWORD = 'y'; process.env.SHOP_PLATFORM = 'shopify';
  const e = aiEnv();
  assert.equal(e.SHOPIFY_ACCESS_TOKEN, undefined); assert.equal(e.MAGENTO_PASSWORD, undefined); assert.equal(e.SHOP_PLATFORM, undefined);
  delete process.env.SHOPIFY_ACCESS_TOKEN; delete process.env.MAGENTO_PASSWORD; delete process.env.SHOP_PLATFORM;
});

test('API: Plattform und Felder werden geprüft (unbekannte Plattform → 400, fremde Felder werden verworfen)', async () => {
  const { PUT } = await import('../app/api/settings/route');
  const put = (body: unknown) => PUT(new Request('http://x/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal((await put({ platform: 'woocommerce' })).status, 400);
  const r = await put({ platform: 'magento', magento: { url: 'https://m.test', accessToken: 'tok-abc-123', nichtErlaubt: 'x' } });
  assert.equal(r.status, 200);
  const pub = await r.json() as { platform: string; platforms: { magento: { values: Record<string, string>; has: Record<string, boolean> } } };
  assert.equal(pub.platform, 'magento');
  assert.equal(pub.platforms.magento.values.url, 'https://m.test');
  assert.equal(pub.platforms.magento.has.accessToken, true);
  assert.ok(!('nichtErlaubt' in pub.platforms.magento.values));
  assert.ok(!JSON.stringify(kvGet('settings')).includes('nichtErlaubt'));
  assert.equal(getSettings().platform, 'magento');
});
