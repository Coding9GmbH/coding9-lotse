// End-to-end tests (Playwright): Lotse against a Shopify fake and an Anthropic fake, see tests/e2e/support/serve.ts.
// Start: npm run test:e2e (builds and starts Lotse). Faster during development: E2E_DEV=1 npm run test:e2e
import fs from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { E2E } from './tests/e2e/support/env';

// Preinstalled Chromium (e.g. /opt/pw-browsers/chromium in cloud environments) in case the matching revision is missing
const chromium = process.env.E2E_CHROMIUM ?? (fs.existsSync('/opt/pw-browsers/chromium') && !process.env.PLAYWRIGHT_BROWSERS_PATH ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  // One Lotse with one data folder: tests build on each other (settings → chat) and run sequentially
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: E2E.baseURL,
    locale: 'de-DE',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(chromium ? { launchOptions: { executablePath: chromium } } : {}) } }],
  webServer: {
    command: 'npx tsx tests/e2e/support/serve.ts',
    url: `${E2E.baseURL}/api/ping`,
    timeout: 300_000, // including next build
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
