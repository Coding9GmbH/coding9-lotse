/**
 * Starts everything the E2E tests need in one process (Playwright webServer):
 *  - Shopify fake (seed "Haus Holm") on E2E_SHOP_PORT
 *  - Anthropic fake (scripted model) on E2E_AI_PORT; the real Claude Code process talks to it via ANTHROPIC_BASE_URL
 *  - GitHub fake (REST API) on a free port, via LOTSE_GITHUB_API_BASE, plus a bare git repository with a theme plugin
 *    (acme/shop-theme) as file:// clone source (LOTSE_TEST_FILE_REMOTES, only together with the fake Docker runner)
 *  - Lotse (`next start`, with E2E_DEV=1 `next dev`) on E2E_PORT with a fresh, empty data folder (AICB_DATA)
 * Exits together with Lotse; the fakes run in the same process and end with it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeShopify } from '../../support/shopify-fake/server';
import { startFakeAnthropic } from '../../support/anthropic-fake/server';
import { startFakeGithub } from '../../support/github-fake';
import { HEADER_TEMPLATE, headerTemplate, makePluginRepo } from '../../support/plugin-repo';
import { GITHUB_TOKEN as E2E_GITHUB_TOKEN } from './github';
import { E2E } from './env';

fs.rmSync(E2E.dataDir, { recursive: true, force: true });
fs.mkdirSync(E2E.dataDir, { recursive: true });
const remoteRoot = `${E2E.dataDir}-git`;
fs.rmSync(remoteRoot, { recursive: true, force: true });
fs.mkdirSync(remoteRoot, { recursive: true });
const themeRepo = makePluginRepo(remoteRoot, { repo: 'acme/shop-theme', name: 'AcmeShopTheme', theme: true, files: { [HEADER_TEMPLATE]: headerTemplate('Lotse Test-Header') } });

const shop = await startFakeShopify({ port: E2E.shopPort, log: false });
const ai = await startFakeAnthropic({ port: E2E.aiPort, quiet: process.env.E2E_VERBOSE !== '1' });
const gh = await startFakeGithub({ token: E2E_GITHUB_TOKEN, login: 'octo-lotse', repos: [{ fullName: 'acme/shop-theme' }, { fullName: 'acme/legacy-plugin', push: false }] });
console.log(`[e2e] Shopify-Fake ${shop.url} · Anthropic-Fake ${ai.url} · Daten ${E2E.dataDir}`);

const next = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
// Do not take over credentials or Claude/Anthropic settings from the developer's environment
// (otherwise shop/AI would already be "configured" or the Claude Code process would hit the real API)
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(SHOPWARE_|SHOPIFY_|MAGENTO_|OPENMAGE_|OPENAI_|ANTHROPIC_|CLAUDE_|CODEX_|AI_PROVIDER$|AI_MODEL$|LOTSE_PASSWORD$|AICB_|LOTSE_SANDBOX|DOCKER_HOST$)/.test(k)));
const env: Record<string, string | undefined> = {
  ...inherited,
  AICB_DATA: E2E.dataDir,
  PORT: String(E2E.port),
  ANTHROPIC_BASE_URL: ai.url,
  LOTSE_GITHUB_API_BASE: gh.base,
  LOTSE_SANDBOX_RUNNER: 'fake', // Sandbox Coding without Docker: in-memory runner
  LOTSE_GITHUB_CLONE_BASE: `file://${themeRepo.remoteBase}`,
  LOTSE_TEST_FILE_REMOTES: '1',
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
    if (code !== 0) { await Promise.all([shop.close(), ai.close(), gh.close()]); process.exit(code); }
  }
  child = run(['start', '-H', '127.0.0.1', '-p', String(E2E.port)]);
}
const stop = () => { child?.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', async code => { await Promise.all([shop.close(), ai.close(), gh.close()]); process.exit(code ?? 0); });
