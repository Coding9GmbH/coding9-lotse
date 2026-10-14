import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// Search Console calls retry 429/5xx a limited number of times (Retry-After), other 4xx never. Local fake with replayed responses.
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-gsc-retry-'));
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const EMAIL = 'retry@projekt.iam.gserviceaccount.com';
type Step = { status: number; headers?: Record<string, string>; body?: unknown };
let script: Step[] = [], apiCalls = 0, tokenCalls = 0, tokenScript: Step[] = [{ status: 200 }];
const server = http.createServer((req, res) => {
  const send = (s: Step, body: unknown) => { res.writeHead(s.status, { 'content-type': 'application/json', ...s.headers }); res.end(JSON.stringify(s.body ?? body)); };
  req.resume();
  req.on('end', () => {
    if (req.url === '/token') { const s = tokenScript[Math.min(tokenCalls++, tokenScript.length - 1)]; return send(s, { access_token: 'tok', expires_in: 3600 }); }
    const s = script[Math.min(apiCalls++, script.length - 1)];
    send(s, { siteEntry: [{ siteUrl: 'sc-domain:shop.de', permissionLevel: 'siteOwner' }] });
  });
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.LOTSE_GSC_API_BASE = base; process.env.LOTSE_GSC_TOKEN_URL = `${base}/token`;
after(() => server.close());

const G = await import('../../../src/server/features/gsc-google');
const key = G.parseServiceKey(JSON.stringify({ type: 'service_account', project_id: 'p', private_key_id: 'k', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: EMAIL }));
beforeEach(() => { apiCalls = 0; tokenCalls = 0; tokenScript = [{ status: 200 }]; });

test('GSC: 429 with Retry-After and 503 are retried, then the result arrives', async () => {
  script = [{ status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Quota' } } }, { status: 503, headers: { 'retry-after': '0' } }, { status: 200 }];
  assert.deepEqual((await G.listSites({ key })).map(s => s.siteUrl), ['sc-domain:shop.de']);
  assert.equal(apiCalls, 3);
});

test('GSC: stops after 3 attempts, Google\'s error message is preserved', async () => {
  script = [{ status: 500, headers: { 'retry-after': '0' }, body: { error: { message: 'Interner Fehler' } } }];
  await assert.rejects(G.listSites({ key }), /Search Console: Interner Fehler/);
  assert.equal(apiCalls, 3);
});

test('GSC: 400/404 are not retried, 403 still yields the permission message', async () => {
  for (const status of [400, 404]) {
    apiCalls = 0; script = [{ status, body: { error: { message: 'kaputt' } } }, { status: 200 }];
    await assert.rejects(G.listSites({ key }), /Search Console: kaputt/);
    assert.equal(apiCalls, 1, String(status));
  }
  apiCalls = 0; script = [{ status: 403, body: { error: { message: 'verboten' } } }, { status: 200 }];
  await assert.rejects(G.listSites({ key }), /Kein Zugriff auf die Search-Console-Property/);
  assert.equal(apiCalls, 1);
});

test('GSC: the token endpoint also retries on 5xx; 401 there is final', async () => {
  const k2 = { ...key, client_email: 'zwei@projekt.iam.gserviceaccount.com' };
  script = [{ status: 200 }]; tokenScript = [{ status: 503, headers: { 'retry-after': '0' } }, { status: 200 }];
  assert.equal((await G.listSites({ key: k2 })).length, 1);
  assert.equal(tokenCalls, 2);
  const k3 = { ...key, client_email: 'drei@projekt.iam.gserviceaccount.com' };
  tokenCalls = 0; tokenScript = [{ status: 401, body: { error: 'invalid_grant' } }, { status: 200 }];
  await assert.rejects(G.listSites({ key: k3 }), /Google-Anmeldung fehlgeschlagen: invalid_grant/);
  assert.equal(tokenCalls, 1);
});
