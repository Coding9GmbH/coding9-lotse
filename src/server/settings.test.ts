import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-test-'));
for (const k of ['SHOPWARE_PASSWORD', 'SHOPWARE_CLIENT_SECRET', 'OPENAI_API_KEY']) delete process.env[k];

const { redact, updateSettings, getSettings, publicSettings, aiEnv } = await import('./settings');
const { kvGet } = await import('./db');

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
