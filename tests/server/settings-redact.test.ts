import '../isolate-data';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// redact(): GitHub tokens (stored and by pattern), Basic credentials and URL credentials are removed.
// The AI processes (Claude, Codex) never get a GitHub token or a git extraheader, even if the Lotse process has them.
const TOKEN = `github_pat_${'Q1w2E3r4T5'.repeat(8)}_zz`;
process.env.GITHUB_TOKEN = 'ghp_fromTheEnvironment0123456789abcdefXYZ';
process.env.GH_TOKEN = process.env.GITHUB_TOKEN;
process.env.GIT_CONFIG_COUNT = '1';
process.env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
process.env.GIT_CONFIG_VALUE_0 = 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0';

const { redact, aiEnv } = await import('../../src/server/settings');
const { codexEnv } = await import('../../src/server/codex');
const { saveGithub } = await import('../../src/server/github');

test('redact: GitHub token patterns and URL credentials', () => {
  const cases: [string, string][] = [
    [`token ${'ghp_'}abcdefghijklmnopqrstuvwxyz0123456789`, 'ghp_•••'],
    [`gho_abcdefghijklmnopqrstuv1234`, 'gho_•••'],
    [`ghs_abcdefghijklmnopqrstuv1234 und ghu_abcdefghijklmnopqrstuv1234`, 'ghs_•••'],
    [`github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789`, 'github_pat_•••'],
    ['fatal: unable to access https://x-access-token:s3cr3t-value@github.com/acme/x.git/', 'https://•••@github.com'],
    ['remote: https://alex:hunter22@git.example.com/repo', 'https://•••@git.example.com'],
    ['Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0', 'Authorization: Basic •••'],
  ];
  for (const [input, want] of cases) {
    const out = redact(input);
    assert.ok(out.includes(want), `${input} -> ${out}`);
    assert.ok(!/s3cr3t|hunter22|abcdefghijklmnopqrstuv|eC1hY2Nl/.test(out), out);
  }
  assert.equal(redact('https://github.com/acme/x.git ist erreichbar'), 'https://github.com/acme/x.git ist erreichbar', 'plain URLs stay');
});

test('redact: the stored token, raw and as Basic credential', () => {
  saveGithub({ token: TOKEN });
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  const out = redact(`a ${TOKEN} b ${basic} c`);
  assert.ok(!out.includes(TOKEN) && !out.includes(basic) && !out.includes(TOKEN.slice(11, 40)), out);
  saveGithub({ token: null });
});

test('aiEnv/codexEnv: no GitHub token and no git extraheader', () => {
  for (const env of [aiEnv(), codexEnv()]) {
    const all = JSON.stringify(env);
    assert.ok(!('GITHUB_TOKEN' in env) && !('GH_TOKEN' in env), 'no token variable');
    assert.ok(!Object.keys(env).some(k => k.startsWith('GIT_CONFIG')), 'no git config variables');
    assert.ok(!/extraheader|ghp_|github_pat_|Basic /i.test(all), 'no credential value');
  }
});
