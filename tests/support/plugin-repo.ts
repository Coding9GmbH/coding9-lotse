// For tests and local checks only: a bare git repository with a tiny Shopware plugin (optionally a theme), served as file:// remote.
// Contains files that must never reach the container (.env, a key, a symlink to the outside) next to normal plugin files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A storefront header template of a theme (fixture for edits): extends Shopware's header and shows `text` above it. */
export const HEADER_TEMPLATE = 'src/Resources/views/storefront/layout/header/header.html.twig';
export const headerTemplate = (text: string) => `{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n\n{% block layout_header %}\n    <div class="lotse-e2e-note">${text}</div>\n    {{ parent() }}\n{% endblock %}\n`;

export interface PluginRepo { remoteBase: string; bare: string; repo: string; name: string }

const git = (args: string[], cwd: string) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'init.defaultBranch=main', ...args],
  { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

/** Creates <root>/remote/<owner>/<name>.git with branch main. Use `file://<remoteBase>` as LOTSE_GITHUB_CLONE_BASE. */
/** `empty`: only what GitHub creates for a new repository (README.md, LICENSE, .gitignore) – the start of a new plugin. */
export function makePluginRepo(root: string, o: { repo?: string; name?: string; theme?: boolean; composer?: unknown; files?: Record<string, string>; empty?: boolean } = {}): PluginRepo {
  const repo = o.repo ?? 'acme/shop-theme', name = o.name ?? 'AcmeTheme';
  const remoteBase = path.join(root, 'remote'), bare = path.join(remoteBase, `${repo}.git`), seed = path.join(root, `seed-${repo.replace('/', '-')}`);
  fs.mkdirSync(bare, { recursive: true });
  git(['init', '--bare', '-q', bare], root);
  git(['init', '-q', seed], root);
  const ns = `Acme\\${name}`;
  const files: Record<string, string> = o.empty ? { 'README.md': `# ${repo}\n`, LICENSE: 'MIT License\n', '.gitignore': 'vendor/\nnode_modules/\n' } : {
    'composer.json': JSON.stringify(o.composer ?? { name: `acme/${name.toLowerCase()}`, type: 'shopware-platform-plugin', description: `${name} (Lotse-Test)`, version: '1.0.0', license: 'MIT',
      autoload: { 'psr-4': { [`${ns}\\`]: 'src/' } }, extra: { 'shopware-plugin-class': `${ns}\\${name}`, label: { 'de-DE': name, 'en-GB': name } }, require: { 'shopware/core': '~6.7.0' } }, null, 2),
    [`src/${name}.php`]: `<?php declare(strict_types=1);\n\nnamespace ${ns};\n\nuse Shopware\\Core\\Framework\\Plugin;\n${o.theme ? 'use Shopware\\Storefront\\Framework\\ThemeInterface;\n\nclass ' + name + ' extends Plugin implements ThemeInterface\n{\n}\n' : `\nclass ${name} extends Plugin\n{\n}\n`}`,
    ...(o.theme ? {
      'src/Resources/theme.json': JSON.stringify({ name, author: 'Lotse Test', views: ['@Storefront', '@Plugins', `@${name}`], style: ['app/storefront/src/scss/overrides.scss', '@Storefront', 'app/storefront/src/scss/base.scss'], script: ['@Storefront'], asset: ['@Storefront', 'app/storefront/src/assets'] }, null, 2),
      'src/Resources/app/storefront/src/scss/overrides.scss': '// overrides\n',
      'src/Resources/app/storefront/src/scss/base.scss': '.lotse-test-marker { color: #0a7; }\n',
      'src/Resources/app/storefront/src/assets/.gitkeep': '',
    } : {}),
    '.env': 'APP_SECRET=never-in-the-container\n',
    'keys/deploy.pem': '-----BEGIN PRIVATE KEY-----\nnot-real\n-----END PRIVATE KEY-----\n',
    'README.md': `# ${name}\n`,
    ...o.files,
  };
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(seed, f)), { recursive: true }); fs.writeFileSync(path.join(seed, f), c); }
  if (!o.empty) {
    fs.symlinkSync('/etc/passwd', path.join(seed, 'outside-link'));
    fs.symlinkSync('README.md', path.join(seed, 'inside-link'));
  }
  git(['add', '-A'], seed); git(['commit', '-q', '-m', 'init'], seed); git(['push', '-q', bare, 'HEAD:refs/heads/main'], seed);
  return { remoteBase, bare, repo, name };
}

/** An empty bare repository (no commit, no branch) – what GitHub creates without auto_init; a local history is pushed into it. */
export function makeBareRepo(root: string, repo: string): PluginRepo {
  const remoteBase = path.join(root, 'remote'), bare = path.join(remoteBase, `${repo}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(['init', '--bare', '-q', bare], root);
  return { remoteBase, bare, repo, name: '' };
}

const pluginComposer = (vendor: string, name: string, o: { require?: Record<string, string>; version?: string } = {}) => JSON.stringify({
  name: `${vendor}/${name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`, type: 'shopware-platform-plugin', description: `${name} (Lotse-Test)`, version: o.version ?? '1.0.0', license: 'proprietary',
  autoload: { 'psr-4': { [`Acme\\${name}\\`]: 'src/' } }, extra: { 'shopware-plugin-class': `Acme\\${name}\\${name}`, label: { 'de-DE': name, 'en-GB': name } }, require: { 'shopware/core': '~6.7.0', ...o.require } }, null, 2);
const pluginClass = (name: string, theme = false) => `<?php declare(strict_types=1);\n\nnamespace Acme\\${name};\n\nuse Shopware\\Core\\Framework\\Plugin;\n${theme ? 'use Shopware\\Storefront\\Framework\\ThemeInterface;\n' : ''}\nclass ${name} extends Plugin${theme ? ' implements ThemeInterface' : ''}\n{\n}\n`;
/** Production-style config of a Shopware project: Redis, S3, OpenSearch, AMQP, SMTP, gelf, Sentry (as in the live fixture of A19) */
export const PROJECT_CONFIG: Record<string, string> = {
  'config/packages/shopware.yaml': `# production\nshopware:\n    deployment:\n        cluster_setup: true\n    cart:\n        storage:\n            type: 'redis'\n            config:\n                connection: 'persistent'\n    number_range:\n        increment_storage: 'redis'\n    filesystem:\n        public:\n            type: 'amazon-s3'\n            url: 'https://cdn.acme-shop.example'\n            config:\n                bucket: '%env(S3_PUBLIC_BUCKET)%'\n        private:\n            type: 'amazon-s3'\n            config:\n                bucket: '%env(S3_PRIVATE_BUCKET)%'\n    cdn:\n        url: 'https://cdn.acme-shop.example'\n`,
  'config/packages/framework.yaml': `framework:\n    cache:\n        app: cache.adapter.redis\n        default_redis_provider: '%env(REDIS_CACHE_URL)%'\n    session:\n        handler_id: '%env(REDIS_SESSION_URL)%'\n    messenger:\n        transports:\n            async:\n                dsn: '%env(MESSENGER_TRANSPORT_DSN)%'\n            failed: 'doctrine://default?queue_name=failed'\n`,
  'config/packages/elasticsearch.yaml': `elasticsearch:\n    enabled: true\n    hosts: '%env(OPENSEARCH_URL)%'\n`,
  'config/packages/mailer.yaml': `framework:\n    mailer:\n        dsn: 'smtp://%env(SMTP_USER)%:%env(SMTP_PASSWORD)%@smtp.acme-shop.example:587'\n`,
  'config/packages/monolog.yaml': `monolog:\n    handlers:\n        graylog:\n            type: gelf\n            level: warning\n        main:\n            type: stream\n            path: 'php://stderr'\n`,
  'config/packages/sentry.yaml': `sentry:\n    dsn: '%env(SENTRY_DSN)%'\n`,
  'config/packages/prod/monolog.yaml': `monolog:\n    handlers:\n        nested:\n            type: stream\n`,
  'config/services.yaml': `services:\n    _defaults:\n        autowire: true\n        autoconfigure: true\n    App\\:\n        resource: '../src/'\n`,
  'config/bundles.php': "<?php\n\nreturn [\n    Sentry\\SentryBundle\\SentryBundle::class => ['all' => true],\n];\n",
};
/** A whole Shopware project (shopware/production layout) as bare repository: a theme, a storefront plugin, a static plugin, an app,
 *  project code in src/, production config and files that never reach the container (.env, composer.*, bundles.php, public/, var/). */
export function makeProjectRepo(root: string, o: { repo?: string; version?: string; files?: Record<string, string | null>;
  /** the project lives in this subfolder of the repository; `rootFiles` are the other things in the repository's root (not prefixed) */ subdir?: string; rootFiles?: Record<string, string> } = {}): PluginRepo {
  const repo = o.repo ?? 'acme/shop', remoteBase = path.join(root, 'remote'), bare = path.join(remoteBase, `${repo}.git`), seed = path.join(root, `seed-${repo.replace('/', '-')}`);
  fs.mkdirSync(bare, { recursive: true });
  git(['init', '--bare', '-q', bare], root);
  git(['init', '-q', seed], root);
  const version = o.version ?? '6.7.15.1';
  const files: Record<string, string | null> = {
    'composer.json': JSON.stringify({ name: 'acme/shop', type: 'project', license: 'proprietary', require: { 'shopware/core': `v${version}`, 'shopware/storefront': '*', 'acme/erp-connector': '*', 'sentry/sentry-symfony': '^5.0', 'frosh/tools': '^3.0' },
      repositories: [{ type: 'path', url: 'custom/plugins/*', options: { symlink: true } }, { type: 'path', url: 'custom/static-plugins/*', options: { symlink: true } }], autoload: { 'psr-4': { 'App\\': 'src/' } } }, null, 2),
    'composer.lock': JSON.stringify({ 'content-hash': 'x', packages: [{ name: 'shopware/core', version: `v${version}` }, { name: 'symfony/yaml', version: 'v7.4.0' }] }, null, 2),
    'symfony.lock': '{}\n',
    'bin/console': '#!/usr/bin/env php\n<?php\n',
    'public/index.php': '<?php\n',
    'var/.htaccess': 'deny from all\n',
    '.env': 'APP_SECRET=never-in-the-container\nDATABASE_URL=mysql://prod:secret@db/shop\n',
    '.github/workflows/deploy.yml': 'on: push\n',
    'README.md': '# Acme Shop\n',
    'custom/plugins/AcmeTheme/composer.json': pluginComposer('acme', 'AcmeTheme'),
    'custom/plugins/AcmeTheme/src/AcmeTheme.php': pluginClass('AcmeTheme', true),
    'custom/plugins/AcmeTheme/src/Resources/theme.json': JSON.stringify({ name: 'AcmeTheme', views: ['@Storefront', '@Plugins', '@AcmeTheme'], style: ['app/storefront/src/scss/base.scss'] }, null, 2),
    'custom/plugins/AcmeTheme/src/Resources/app/storefront/src/scss/base.scss': '.acme-footer { color: #c40; }\n',
    'custom/plugins/AcmeTheme/src/Resources/views/storefront/layout/footer/footer.html.twig': "{% sw_extends '@Storefront/storefront/layout/footer/footer.html.twig' %}\n{% block layout_footer_copyright %}<p class=\"acme-footer\">Acme Footer</p>{% endblock %}\n",
    'custom/plugins/AcmeStorefrontTweaks/composer.json': pluginComposer('acme', 'AcmeStorefrontTweaks'),
    'custom/plugins/AcmeStorefrontTweaks/src/AcmeStorefrontTweaks.php': pluginClass('AcmeStorefrontTweaks'),
    'custom/plugins/AcmeStorefrontTweaks/src/Resources/views/storefront/layout/header/header.html.twig': headerTemplate('Acme Header'),
    'custom/plugins/AcmeStorefrontTweaks/src/Resources/snippet/storefront.de-DE.json': '{"acme": {"hello": "Hallo"}}\n',
    'custom/static-plugins/AcmeErpConnector/composer.json': pluginComposer('acme', 'AcmeErpConnector').replace('"acme/acme-erp-connector"', '"acme/erp-connector"'),
    'custom/static-plugins/AcmeErpConnector/src/AcmeErpConnector.php': pluginClass('AcmeErpConnector'),
    'custom/static-plugins/AcmeErpConnector/src/Resources/config/services.xml': '<?xml version="1.0" ?>\n<container/>\n',
    'custom/apps/AcmeHelloApp/manifest.xml': '<?xml version="1.0" encoding="UTF-8"?>\n<manifest>\n    <meta>\n        <name>AcmeHelloApp</name>\n        <label>Acme Hello</label>\n        <version>1.0.0</version>\n    </meta>\n</manifest>\n',
    'src/Subscriber/ProjectHeaderSubscriber.php': '<?php declare(strict_types=1);\n\nnamespace App\\Subscriber;\n\nfinal class ProjectHeaderSubscriber {}\n',
    ...PROJECT_CONFIG,
    ...o.files,
  };
  const all: Record<string, string | null> = o.subdir ? { ...Object.fromEntries(Object.entries(files).map(([f, c]) => [`${o.subdir}/${f}`, c])), ...o.rootFiles } : files;
  for (const [f, c] of Object.entries(all)) { if (c === null) continue; fs.mkdirSync(path.dirname(path.join(seed, f)), { recursive: true }); fs.writeFileSync(path.join(seed, f), c); }
  git(['add', '-A'], seed); git(['commit', '-q', '-m', 'init'], seed); git(['push', '-q', bare, 'HEAD:refs/heads/main'], seed);
  return { remoteBase, bare, repo, name: 'acme/shop' };
}
