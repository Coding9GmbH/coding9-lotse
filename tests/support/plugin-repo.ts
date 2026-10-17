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
export function makePluginRepo(root: string, o: { repo?: string; name?: string; theme?: boolean; composer?: unknown; files?: Record<string, string> } = {}): PluginRepo {
  const repo = o.repo ?? 'acme/shop-theme', name = o.name ?? 'AcmeTheme';
  const remoteBase = path.join(root, 'remote'), bare = path.join(remoteBase, `${repo}.git`), seed = path.join(root, `seed-${repo.replace('/', '-')}`);
  fs.mkdirSync(bare, { recursive: true });
  git(['init', '--bare', '-q', bare], root);
  git(['init', '-q', seed], root);
  const ns = `Acme\\${name}`;
  const files: Record<string, string> = {
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
  fs.symlinkSync('/etc/passwd', path.join(seed, 'outside-link'));
  fs.symlinkSync('README.md', path.join(seed, 'inside-link'));
  git(['add', '-A'], seed); git(['commit', '-q', '-m', 'init'], seed); git(['push', '-q', bare, 'HEAD:refs/heads/main'], seed);
  return { remoteBase, bare, repo, name };
}
