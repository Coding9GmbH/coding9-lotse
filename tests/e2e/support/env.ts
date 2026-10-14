// Shared addresses of the E2E environment (Playwright config, serve.ts, tests). Ports can be changed via environment variables.
import os from 'node:os';
import path from 'node:path';

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
const port = num(process.env.E2E_PORT, 3480);

export const E2E = {
  port,
  shopPort: num(process.env.E2E_SHOP_PORT, port + 1),
  aiPort: num(process.env.E2E_AI_PORT, port + 2),
  baseURL: `http://127.0.0.1:${port}`,
  dataDir: process.env.E2E_DATA ?? path.join(os.tmpdir(), `lotse-e2e-${port}`),
};
export const shopUrl = `http://127.0.0.1:${E2E.shopPort}`;
