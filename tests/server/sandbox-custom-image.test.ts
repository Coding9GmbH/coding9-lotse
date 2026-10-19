import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../isolate-data';

// The environment's own Dockerfile (instructions after FROM) and the token for packages.shopware.com entered while a setup waits.
const { checkDockerfile, customImage, CUSTOM_IMAGE } = await import('../../src/server/sandbox/custom-image');
const { ensureSandboxImage } = await import('../../src/server/sandbox/image-build');
const { mergeComposerAuth, saveShopwareToken } = await import('../../src/server/sandbox/composer-auth');
const { saveSandbox, getSandboxConfig, sandboxPublic, environmentImage } = await import('../../src/server/sandbox/env');
const { FakeRunner } = await import('../../src/server/sandbox/fake-runner');
const { composerAuthWanted } = await import('../../src/lib/sandbox-task');
const { composerHint } = await import('../../src/server/sandbox/templates/dockware-project');

const BASE = 'dockware/shopware:6.7.14.0';

test('checkDockerfile: continuation lines and comments are fine; FROM, COPY/ADD, mounts and heredocs are refused', () => {
  const ok = '# PHP\nRUN apt-get update \\\n  # why\n  && apt-get install -y libvips-dev\nENV FOO=1\n';
  assert.equal(checkDockerfile(ok), ok.trim());
  assert.equal(checkDockerfile('  \n'), '');
  assert.throws(() => checkDockerfile('FROM php:8.3'), /FROM setzt Lotse selbst/);
  assert.throws(() => checkDockerfile('RUN true\nCOPY . /app'), /nicht erlaubt/);
  assert.throws(() => checkDockerfile('ADD http://x/y /y'), /nicht erlaubt/);
  assert.throws(() => checkDockerfile('RUN --mount=type=secret,id=x cat /run/secrets/x'), /--mount/);
  assert.throws(() => checkDockerfile('RUN cat <<EOF\nx\nEOF'), /Heredocs/);
  assert.throws(() => checkDockerfile('RUN true\n'.repeat(1000)), /höchstens/);
});

test('customImage: none without a Dockerfile; else a name the guards allow, with the base tag and a hash of base + Dockerfile', () => {
  assert.equal(customImage(BASE, ''), null);
  const a = customImage(BASE, 'RUN true')!, b = customImage(BASE, 'RUN false')!, c = customImage('dockware/shopware:6.6.1.0', 'RUN true')!;
  assert.match(a.name, CUSTOM_IMAGE);
  assert.match(a.name, /:6\.7\.14\.0$/);
  assert.equal(a.dockerfile, `FROM ${BASE}\nRUN true\n`);
  assert.equal(customImage(BASE, 'RUN true')!.name, a.name);
  assert.equal(new Set([a.name, b.name, c.name]).size, 3);
});

test('ensureSandboxImage: pulls the base and builds once; an unchanged Dockerfile is reused; no Dockerfile = plain pull', async () => {
  const r = new FakeRunner();
  const plain = await ensureSandboxImage(r, BASE, undefined, () => {});
  assert.deepEqual(plain, { image: BASE, pulled: true, built: false });
  const first = await ensureSandboxImage(r, 'dockware/shopware:6.7.13.0', 'RUN docker-php-ext-install bcmath', () => {});
  assert.equal(first.built, true);
  assert.match(first.image, CUSTOM_IMAGE);
  const builds = () => r.calls.filter(c => c.op === 'buildImage');
  assert.equal(builds().length, 1);
  assert.match(JSON.stringify(builds()[0].detail), /FROM dockware\/shopware:6\.7\.13\.0\\nRUN docker-php-ext-install bcmath/);
  assert.deepEqual(await ensureSandboxImage(r, 'dockware/shopware:6.7.13.0', 'RUN docker-php-ext-install bcmath', () => {}), { image: first.image, pulled: false, built: false });
  assert.equal(builds().length, 1, 'built once');
  assert.notEqual((await ensureSandboxImage(r, 'dockware/shopware:6.7.13.0', 'RUN true', () => {})).image, first.image, 'another Dockerfile = another image');
});

test('the environment saves the Dockerfile and the sandboxes run the built image', () => {
  assert.deepEqual(saveSandbox({ dockerfile: 'RUN docker-php-ext-install bcmath' }).changed, ['dockerfile']);
  assert.deepEqual(saveSandbox({ dockerfile: 'RUN docker-php-ext-install bcmath' }).changed, []);
  assert.equal(sandboxPublic().dockerfile, 'RUN docker-php-ext-install bcmath');
  assert.equal(environmentImage(), customImage(getSandboxConfig().image, 'RUN docker-php-ext-install bcmath')!.name);
  assert.throws(() => saveSandbox({ dockerfile: 'FROM scratch' }), /FROM/);
  saveSandbox({ dockerfile: '' });
  assert.equal(environmentImage(), getSandboxConfig().image);
});

test('mergeComposerAuth keeps other credentials; saveShopwareToken stores a secret COMPOSER_AUTH and refuses odd tokens', () => {
  const merged = JSON.parse(mergeComposerAuth('{"github-oauth":{"github.com":"x"},"bearer":{"example.com":"b"}}', 'packages.shopware.com', 'tok'));
  assert.deepEqual(merged, { 'github-oauth': { 'github.com': 'x' }, bearer: { 'example.com': 'b', 'packages.shopware.com': 'tok' } });
  assert.deepEqual(JSON.parse(mergeComposerAuth('not json', 'packages.shopware.com', 't')), { bearer: { 'packages.shopware.com': 't' } });
  assert.throws(() => saveShopwareToken('  '), /Token/);
  assert.throws(() => saveShopwareToken('a"b'), /ungültige Zeichen/);
  saveShopwareToken('abc123');
  assert.ok(getSandboxConfig().env.includes('COMPOSER_AUTH={"bearer":{"packages.shopware.com":"abc123"}}'));
  const v = sandboxPublic().envVars.find(x => x.key === 'COMPOSER_AUTH')!;
  assert.deepEqual({ secret: v.secret, value: v.value, hasValue: v.hasValue }, { secret: true, value: '', hasValue: true }, 'never returned');
  saveShopwareToken('def456'); // a second token replaces the first
  assert.equal(getSandboxConfig().env.filter(e => e.startsWith('COMPOSER_AUTH=')).length, 1);
});

test('composerAuthWanted / composerHint: the packages.shopware.com refusal asks for the token; plain "shopware/platform" is not a PHP problem', () => {
  const refused = '  - Downloading shopware/platform (v6.7.1)\nThe "https://packages.shopware.com/download?downloadUrl=%2Fpackages%2Fplugins%2FDooFinder%2Fbinaries%2F2.7.7" file could not be downloaded (HTTP/2 400 ):';
  assert.ok(composerAuthWanted(refused));
  assert.match(composerHint(refused), /Token/);
  assert.equal(composerAuthWanted('  - Downloading bacon/bacon-qr-code (v3.1.1)'), false);
  assert.equal(composerHint('  - Downloading shopware/platform (v6.7.1)\n  - Downloading bacon/bacon-qr-code (v3.1.1)'), '');
  assert.match(composerHint('Fatal error: Allowed memory size of 1610612736 bytes exhausted'), /Arbeitsspeicher/);
  assert.match(composerHint('Your requirements could not be resolved: ext-gd * is missing from your system'), /Dockerfile/);
});
