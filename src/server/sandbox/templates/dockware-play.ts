// Template "Dockware Play": a complete Shopware 6 (dockware/play) per task, the repo is a plugin or theme
// below custom/plugins/<Name>. Steps are declared here as data; the setup job executes them.
import type { CommandArg, CommandSpec, SandboxTemplate, TemplateStep } from './types';

const MIN = 60_000;
export const DOCKWARE_DEFAULT_IMAGE = 'dockware/play:6.7.2.2';
/** Only dockware/play from Docker Hub with a fixed version: no :latest, no other repository, no registry host. */
export const DOCKWARE_IMAGE_PATTERN = /^dockware\/play:\d+(\.\d+){1,3}$/;

/** Path relative to the plugin directory: no absolute path, no "..", no leading "-", no shell characters. */
const RELATIVE_PATH = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
const pathArg = (pattern = RELATIVE_PATH): CommandArg => ({ name: 'path', pattern });

const step = (id: TemplateStep['id'], timeoutMs: number, extra: Partial<TemplateStep> = {}): TemplateStep => ({ id, labelKey: id, timeoutMs, ...extra });
const STEPS: TemplateStep[] = [
  step('check-image', 30 * MIN),
  step('clone', 5 * MIN),
  step('detect-layout', 30_000),
  step('start-container', 2 * MIN),
  step('wait-ready', 5 * MIN),
  step('install-plugin', 5 * MIN),
  step('import-db', 30 * MIN, { optional: true }),
  step('set-domain', MIN),
  step('custom-after-db', 0, { custom: 'after-db' }),
  step('theme-compile', 10 * MIN),
  step('custom-final', 0, { custom: 'final' }),
  step('ready', 30_000),
];

const bin = (...a: string[]) => ['bin/console', ...a];
const cmd = (id: CommandSpec['id'], argv: CommandSpec['argv'], args: CommandArg[] = [], timeoutMs = 5 * MIN): CommandSpec =>
  ({ id, labelKey: id, args, argv, user: 'www-data', workdir: '/var/www/html', timeoutMs, maxOutput: 64 * 1024 });
const COMMANDS: CommandSpec[] = [
  cmd('theme-compile', () => bin('theme:compile'), [], 10 * MIN),
  cmd('cache-clear', () => bin('cache:clear')),
  cmd('plugin-refresh', () => bin('plugin:refresh')),
  cmd('theme-refresh', () => bin('theme:refresh')),
  cmd('lint-twig', (a, c) => bin('lint:twig', `${c.pluginDir}/${a.path}`), [pathArg()]),
  cmd('php-lint', (a, c) => ['php', '-l', `${c.pluginDir}/${a.path}`], [pathArg(/^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9._/-]{0,195}\.php$/)], MIN),
];

export const dockwarePlay: SandboxTemplate = {
  id: 'dockware-play',
  labelKey: 'dockware-play',
  platform: 'shopware',
  imagePattern: DOCKWARE_IMAGE_PATTERN,
  defaultImage: DOCKWARE_DEFAULT_IMAGE,
  steps: STEPS,
  commands: COMMANDS,
};
