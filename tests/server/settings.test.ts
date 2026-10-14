import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-test-'));
for (const k of ['SHOPWARE_PASSWORD', 'SHOPWARE_CLIENT_SECRET', 'OPENAI_API_KEY']) delete process.env[k];

const { redact, updateSettings, getSettings, publicSettings, aiEnv } = await import('../../src/server/settings');
const { kvGet } = await import('../../src/server/db');

test('redact: entfernt gespeicherte Geheimnisse, Bearer-Tokens und sk-Keys', () => {
  updateSettings({ shopware: { url: 'http://shop', user: 'admin', password: 'geheimes-passwort' }, image: { openaiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz' } });
  const msg = 'Login fehlgeschlagen für geheimes-passwort; Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdef; key sk-ABCDEFGHIJKLMNOPQRST';
  const out = redact(msg);
  assert.ok(!out.includes('geheimes-passwort'));
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.ok(!out.includes('ABCDEFGHIJKLMNOPQRST'));
  assert.match(out, /Bearer •••/);
  assert.equal(redact(null), '');
});

test('Geheimnisse liegen verschlüsselt in der DB, maskiert in der Oberfläche', () => {
  const raw = kvGet<{ shopware: { password: string } }>('settings');
  assert.match(raw!.shopware.password, /^enc:v1:/);
  assert.equal(getSettings().shopware.password, 'geheimes-passwort');
  const pub = publicSettings();
  assert.equal(pub.shopware.hasPassword, true);
  assert.ok(!JSON.stringify(pub).includes('geheimes-passwort'));
  assert.equal(pub.scopeInfo.products.label, 'Produkte');
  updateSettings({ shopware: { password: null } });
  assert.equal(getSettings().shopware.password, '');
});

test('aiEnv: Freigabeliste statt Sperrliste: fremde Geheimnisse der Umgebung erreichen den KI-Prozess nicht', () => {
  const set = { SHOPWARE_PASSWORD: 'x', OPENAI_API_KEY: 'y', AICB_DATA_X: 'z', AWS_SECRET_ACCESS_KEY: 'aws', GITHUB_TOKEN: 'gh', DATABASE_URL: 'postgres://u:p@db/x', SMTP_PASSWORD: 'smtp', NPM_TOKEN: 'npm', HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost', SSL_CERT_FILE: '/ca.crt', NODE_EXTRA_CA_CERTS: '/ca.crt', ANTHROPIC_BASE_URL: 'https://api.example', LANG: 'de_DE.UTF-8', TZ: 'Europe/Berlin', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000', DISABLE_TELEMETRY: '1' };
  const prev = Object.fromEntries(Object.keys(set).map(k => [k, process.env[k]]));
  Object.assign(process.env, set);
  try {
    const e = aiEnv();
    for (const k of ['SHOPWARE_PASSWORD', 'OPENAI_API_KEY', 'AICB_DATA_X', 'AICB_DATA', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'DATABASE_URL', 'SMTP_PASSWORD', 'NPM_TOKEN']) assert.equal(e[k], undefined, k);
    for (const k of ['PATH', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'ANTHROPIC_BASE_URL', 'LANG', 'TZ', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'DISABLE_TELEMETRY']) assert.equal(e[k], process.env[k], k);
    // Bedrock/Vertex: Cloud-Zugang nur, wenn ausdrücklich eingeschaltet
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    assert.equal(aiEnv().AWS_SECRET_ACCESS_KEY, 'aws');
  } finally {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('aiEnv: nur API-Schlüssel – kein Claude-Abo-Token, keine Anmeldung des Rechners', () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-x'; process.env.ANTHROPIC_AUTH_TOKEN = 't'; process.env.CLAUDE_CONFIG_DIR = '/home/x/.claude';
  updateSettings({ ai: { apiKey: 'sk-ant-api-test' } });
  const e = aiEnv();
  assert.equal(e.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(e.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(e.ANTHROPIC_API_KEY, 'sk-ant-api-test');
  assert.ok(e.CLAUDE_CONFIG_DIR.startsWith(process.env.AICB_DATA!), 'eigenes Konfigurationsverzeichnis im Datenordner');
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.ANTHROPIC_AUTH_TOKEN; delete process.env.CLAUDE_CONFIG_DIR;
  updateSettings({ ai: { apiKey: null } });
});

test('Shop-Adresse auf andere Herkunft: gespeicherte Geheimnisse werden verworfen, außer sie kommen im selben Patch neu mit', () => {
  updateSettings({ shopware: { url: 'https://shop.de', user: 'admin', password: 'pw-alt', clientId: 'SWIA', clientSecret: 'cs-alt' } });
  updateSettings({ shopware: { url: 'https://shop.de/', publicUrl: 'https://www.shop.de' } }); // gleiche Herkunft, andere Schreibweise
  assert.equal(getSettings().shopware.password, 'pw-alt');
  updateSettings({ shopware: { url: 'HTTPS://Shop.de:443/admin' } });
  assert.equal(getSettings().shopware.clientSecret, 'cs-alt', 'Pfad/Großschreibung/Standardport ändern die Herkunft nicht');
  updateSettings({ shopware: { url: 'https://boese.example' } });
  assert.equal(getSettings().shopware.password, '');
  assert.equal(getSettings().shopware.clientSecret, '');
  assert.equal(getSettings().shopware.user, 'admin', 'Klartextfelder bleiben');
  const pub = publicSettings();
  assert.equal(pub.shopware.hasPassword, false); assert.equal(pub.shopware.hasClientSecret, false);
  assert.equal(pub.shopware.configured, false, 'Oberfläche verlangt die Zugangsdaten neu');
  updateSettings({ shopware: { url: 'https://neu.shop', password: 'pw-neu' } });
  assert.equal(getSettings().shopware.password, 'pw-neu', 'neues Geheimnis im selben Patch gilt');
  updateSettings({ shopware: { url: 'http://neu.shop' } });
  assert.equal(getSettings().shopware.password, '', 'Schema-Wechsel ist eine andere Herkunft');
  updateSettings({ shopware: { url: '' } }); updateSettings({ shopware: { password: 'erst-passwort' } }); updateSettings({ shopware: { url: 'https://erst.shop' } });
  assert.equal(getSettings().shopware.password, 'erst-passwort', 'Ersteinrichtung (vorher keine Adresse) behält das Geheimnis');
});

test('Herkunftswechsel gilt für alle Plattformen (Shopify-Domain, Magento, OpenMage)', () => {
  updateSettings({ shopify: { storeDomain: 'laden.myshopify.com', accessToken: 'shpat_alt', clientId: 'cid', clientSecret: 'sec' }, magento: { url: 'https://m.shop', accessToken: 'mtok', user: 'u', password: 'mpw' }, openmage: { url: 'https://om.shop', token: 'lotse_tok' } });
  updateSettings({ shopify: { storeDomain: 'https://laden.myshopify.com/' } });
  assert.equal(getSettings().shopify.accessToken, 'shpat_alt', 'mit Schema = gleiche Herkunft');
  updateSettings({ shopify: { storeDomain: 'fremd.myshopify.com' }, magento: { url: 'https://evil.example' }, openmage: { url: 'https://om.shop/neu', token: '' } });
  assert.equal(getSettings().shopify.accessToken, ''); assert.equal(getSettings().shopify.clientSecret, '');
  assert.equal(getSettings().shopify.clientId, 'cid');
  assert.equal(getSettings().magento.accessToken, ''); assert.equal(getSettings().magento.password, '');
  assert.equal(getSettings().openmage.token, 'lotse_tok', 'gleiche Herkunft, leeres Feld = unverändert');
  assert.deepEqual(publicSettings().platforms?.magento?.has, { accessToken: false, password: false });
});

test('Geheimnisse aus der Umgebung gehen nur an die Adresse aus der Umgebung', () => {
  process.env.SHOPWARE_URL = 'https://env.shop'; process.env.SHOPWARE_PASSWORD = 'env-pw';
  try {
    updateSettings({ shopware: { url: '', password: null } });
    assert.equal(getSettings().shopware.password, 'env-pw');
    updateSettings({ shopware: { url: 'https://env.shop/' } });
    assert.equal(getSettings().shopware.password, 'env-pw', 'gleiche Herkunft');
    updateSettings({ shopware: { url: 'https://boese.example' } });
    assert.equal(getSettings().shopware.password, '', 'gespeicherte Adresse zeigt woandershin');
    updateSettings({ shopware: { url: '' } });
    assert.equal(getSettings().shopware.password, 'env-pw');
  } finally { delete process.env.SHOPWARE_URL; delete process.env.SHOPWARE_PASSWORD; }
});
