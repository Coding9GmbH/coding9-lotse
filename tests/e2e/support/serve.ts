/**
 * Startet alles, was die E2E-Tests brauchen, in einem Prozess (Playwright-webServer):
 *  - Shopify-Fake (Seed „Haus Holm“) auf E2E_SHOP_PORT
 *  - Anthropic-Fake (Drehbuch-Modell) auf E2E_AI_PORT; der echte Claude-Code-Prozess spricht über ANTHROPIC_BASE_URL mit ihm
 *  - Lotse (`next start`, mit E2E_DEV=1 `next dev`) auf E2E_PORT mit frischem, leerem Datenordner (AICB_DATA)
 * Beendet sich mit Lotse; die Fakes laufen im selben Prozess und enden mit ihm.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeShopify } from '../../support/shopify-fake/server';
import { startFakeAnthropic } from '../../support/anthropic-fake/server';
import { E2E } from './env';

fs.rmSync(E2E.dataDir, { recursive: true, force: true });
fs.mkdirSync(E2E.dataDir, { recursive: true });

const shop = await startFakeShopify({ port: E2E.shopPort, log: false });
const ai = await startFakeAnthropic({ port: E2E.aiPort, quiet: process.env.E2E_VERBOSE !== '1' });
console.log(`[e2e] Shopify-Fake ${shop.url} · Anthropic-Fake ${ai.url} · Daten ${E2E.dataDir}`);

const next = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
// Keine Zugangsdaten oder Claude-/Anthropic-Einstellungen aus der Umgebung des Entwicklers übernehmen
// (sonst wären Shop/KI schon „eingerichtet“ oder der Claude-Code-Prozess liefe gegen die echte API)
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(SHOPWARE_|SHOPIFY_|MAGENTO_|OPENMAGE_|OPENAI_|ANTHROPIC_|CLAUDE_|CODEX_|AI_PROVIDER$|AI_MODEL$|LOTSE_PASSWORD$|AICB_)/.test(k)));
const env: Record<string, string | undefined> = {
  ...inherited,
  AICB_DATA: E2E.dataDir,
  PORT: String(E2E.port),
  ANTHROPIC_BASE_URL: ai.url,
  ANTHROPIC_API_KEY: 'sk-ant-e2e-fake-key',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  NEXT_TELEMETRY_DISABLED: '1',
};

const run = (args: string[]) => spawn(process.execPath, [next, ...args], { env: env as NodeJS.ProcessEnv, stdio: 'inherit' });
const dev = process.env.E2E_DEV === '1';

let child = dev ? run(['dev', '-H', '127.0.0.1', '-p', String(E2E.port)]) : null;
if (!child) {
  if (process.env.E2E_SKIP_BUILD !== '1') {
    const build = run(['build']);
    const code: number = await new Promise(ok => build.on('exit', c => ok(c ?? 1)));
    if (code !== 0) { await Promise.all([shop.close(), ai.close()]); process.exit(code); }
  }
  child = run(['start', '-H', '127.0.0.1', '-p', String(E2E.port)]);
}
const stop = () => { child?.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', async code => { await Promise.all([shop.close(), ai.close()]); process.exit(code ?? 0); });
