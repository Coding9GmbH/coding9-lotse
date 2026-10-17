// Template "Dockware (Shopware)": a complete Shopware 6 (dockware/shopware, formerly dockware/play) per task, the repo is a plugin
// or theme below custom/plugins/<Name>. Steps are declared here; the setup job (jobs.ts) executes them with a restricted context.
// Measured with dockware/shopware:6.7.15.1: first boot until HTTP 200 about 75 s, restart after a stop about 43 s, theme:compile about 7 s
// (dockware/play:6.7.2.2: about 20 s). Same layout as play: /var/www/html, www-data (uid 33) with sudo, mysql root/root.
// Dockware keeps APP_URL and the storefront domain at http://localhost; Lotse sends Host: localhost instead of changing them.
import fs from 'node:fs';
import path from 'node:path';
import type { ContainerSpec } from '../runner';
import type { TaskLayout } from '@/lib/protocol';
import { MANAGED, SANDBOX_NET, TASK_LABEL, sandboxAlias } from '../labels';
import type { CommandArg, CommandSpec, SandboxTemplate, SpecInput, StepCtx, TemplateStep } from './types';

const MIN = 60_000;
export const DOCKWARE_DEFAULT_IMAGE = 'dockware/shopware:6.7.15.1';
/** Only dockware/shopware (optionally the -amd64/-arm64 variant) or the discontinued dockware/play from Docker Hub with a fixed version:
 *  no latest/6.7-latest, no other repository, no registry host. */
export const DOCKWARE_IMAGE_PATTERN = /^(dockware\/shopware:\d+(\.\d+){2,3}(-(amd64|arm64))?|dockware\/play:\d+(\.\d+){1,3})$/;

/** Path relative to the plugin directory: no absolute path, no "..", no leading "-", no shell characters. */
const RELATIVE_PATH = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
const pathArg = (pattern = RELATIVE_PATH): CommandArg => ({ name: 'path', pattern });

const bin = (...a: string[]) => ['bin/console', ...a];
const MYSQL = ['mysql', '-uroot', '-proot', '-h127.0.0.1', 'shopware'];
/** Waits `ms` unless the signal aborts; the abort listener is removed again, so a long poll does not pile them up. */
export const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((ok, fail) => {
  if (signal.aborted) { fail(new Error('Abgebrochen.')); return; }
  const onAbort = () => { clearTimeout(t); fail(new Error('Abgebrochen.')); };
  const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); ok(); }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});
const pluginName = (ctx: StepCtx) => {
  const l = ctx.layout();
  if (!l || !PLUGIN_NAME.test(l.name)) throw new Error('Plugin noch nicht erkannt (Schritt „Plugin erkennen“ fehlt).');
  return l;
};

/** MySQL first, then the storefront with HTTP 200; backoff up to 3 s, ends with the step's time limit or an abort. */
export async function waitReady(ctx: Pick<StepCtx, 'run' | 'httpStatus' | 'log' | 'signal'>) {
  let wait = 500, last = '';
  const note = (s: string) => { if (s !== last) ctx.log(s); last = s; };
  for (;;) {
    const db = await ctx.run(['mysqladmin', 'ping', '-h127.0.0.1', '-uroot', '-proot', '--silent'], { okCodes: [0, 1], timeoutMs: 15_000, quiet: true }).catch(() => ({ exitCode: 1 }));
    if (db.exitCode === 0) {
      const status = await ctx.httpStatus('/').catch(() => 0);
      if (status === 200) { ctx.log('Shopware antwortet (HTTP 200).'); return; }
      note(`Datenbank bereit, Shop antwortet noch nicht${status ? ` (HTTP ${status})` : ''} …`);
    } else note('Warte auf die Datenbank …');
    await sleep(wait, ctx.signal);
    wait = Math.min(3000, wait * 1.5);
  }
}

/** Domain stays http://localhost (see top); after a dump import the storefront domain is pointed back to it. Fixed SQL, no input. */
const SET_DOMAIN_SQL = "UPDATE sales_channel_domain SET url = 'http://localhost' WHERE url NOT LIKE 'default.%' AND url <> 'http://localhost' AND NOT EXISTS (SELECT 1 FROM (SELECT id FROM sales_channel_domain WHERE url = 'http://localhost') AS d) ORDER BY created_at LIMIT 1";

/** Where the dump lands in the container for the import; removed by the import command itself and again afterwards. */
export const IMPORT_DIR = '/tmp/lotse-import';
/** Constant argv, no interpolation: decompress if needed, import as root into the shop database, always delete the file. */
export const IMPORT_ARGV = ['bash', '-c', `set -o pipefail; gunzip -cf ${IMPORT_DIR}/dump | mysql -uroot -proot -h127.0.0.1 shopware; rc=$?; rm -rf ${IMPORT_DIR}; exit $rc`];
const minor = (v: string) => v.split('.').slice(0, 2).join('.');

/** Dump vs. image: a different major.minor blocks until the user chooses "Trotzdem fortfahren". */
async function versionCheck(ctx: StepCtx): Promise<void | 'skipped'> {
  const d = ctx.dump();
  if (!d) { ctx.log('Kein Datenbank-Dump – nichts zu prüfen.'); return 'skipped'; }
  const dumpV = await ctx.dumpVersion();
  const image = /(\d+\.\d+\.\d+(?:\.\d+)?)/.exec((await ctx.run(bin('--version'))).output)?.[1] ?? null;
  if (!dumpV || !image) { ctx.log(`Shopware-Version ${dumpV ? 'des Images' : 'des Dumps'} nicht erkennbar – keine Prüfung.`); ctx.setVersionMismatch(null); return; }
  ctx.log(`Dump: Shopware ${dumpV} · Image: Shopware ${image}`);
  if (minor(dumpV) === minor(image)) { ctx.setVersionMismatch(null); return; }
  ctx.setVersionMismatch({ dump: dumpV, image });
  if (d.ignoreVersion) { ctx.log('Abweichende Version – „Trotzdem fortfahren“ gewählt.'); return; }
  throw new Error(`Dump stammt von ${dumpV}, Image enthält ${image} – passendes Dockware-Image (dockware/shopware:${dumpV}.x) in der Umgebung wählen oder „Trotzdem fortfahren“.`);
}

/** Import, then the dump is deleted on the host and in the container – also when the import fails. */
async function importDb(ctx: StepCtx): Promise<void | 'skipped'> {
  const d = ctx.dump();
  if (!d) { ctx.log('Kein Datenbank-Dump – es bleiben die Demodaten von Dockware.'); return 'skipped'; }
  let ok = false;
  try {
    ctx.log(`Dump ${d.name} (${(d.size / 1048576).toFixed(1)} MB) in den Container übertragen …`);
    await ctx.copyDump(IMPORT_DIR);
    await ctx.run(IMPORT_ARGV);
    ok = true;
  } finally { await ctx.discardDump(ok, IMPORT_DIR); }
  ctx.log('Datenbank importiert. Dump gelöscht ✓');
}

const RUNS: Partial<Record<TemplateStep['id'], TemplateStep['run']>> = {
  'check-image': ctx => ctx.ensureImage(),
  clone: async ctx => { const { head } = await ctx.clone(); ctx.log(`Commit ${head.slice(0, 12)}`); },
  'detect-layout': async ctx => { const l = detectLayout(ctx.worktree); ctx.setLayout(l); ctx.log(`${l.kind === 'theme' ? 'Theme' : 'Plugin'} ${l.name} → ${l.pluginDir}`); },
  'start-container': ctx => ctx.createContainer(),
  'wait-ready': ctx => waitReady(ctx),
  'install-plugin': async ctx => {
    const l = pluginName(ctx);
    await ctx.syncAll();
    // plugin:refresh and plugin:install exit with 0 even when the plugin was not found (e.g. composer.json invalid): check the database
    const refresh = await ctx.run(bin('plugin:refresh'));
    await ctx.run(bin('plugin:install', '--activate', '--', l.name));
    const state = (await ctx.run([...MYSQL, '-N', '-e', `SELECT CONCAT(installed_at IS NOT NULL, active) FROM plugin WHERE name = '${l.name}'`], { quiet: true })).output;
    if (!state.split('\n').some(x => x.trim() === '11')) { // stderr (password warning) is part of the output
      const why = refresh.output.split('\n').filter(x => /\[ERROR]|Errors?:|^\s{5,}\S/.test(x)).map(x => x.trim()).join(' ').slice(0, 600);
      throw new Error(`Plugin ${l.name} wurde nicht installiert und aktiviert.${why ? ` Shopware meldet: ${why}` : ''}`);
    }
    if (l.kind === 'theme') await ctx.run(bin('theme:change', '--all', '--no-compile', '--', l.name));
  },
  'version-check': versionCheck,
  'import-db': importDb,
  'set-domain': async ctx => { await ctx.run([...MYSQL, '-e', SET_DOMAIN_SQL]); ctx.log('Storefront-Domain: http://localhost'); },
  'theme-compile': async ctx => { await ctx.run(bin('theme:compile')); await ctx.run(bin('cache:clear')); },
  ready: async ctx => { const s = await ctx.httpStatus('/'); if (s !== 200) throw new Error(`Die Storefront antwortet mit HTTP ${s}.`); },
};
const step = (id: TemplateStep['id'], timeoutMs: number, extra: Partial<TemplateStep> = {}): TemplateStep => ({ id, labelKey: id, timeoutMs, run: RUNS[id], ...extra });
const STEPS: TemplateStep[] = [
  step('check-image', 30 * MIN),
  step('clone', 5 * MIN),
  step('detect-layout', 30_000),
  step('start-container', 2 * MIN),
  step('wait-ready', 5 * MIN),
  // the dump replaces the whole database (plugin table, domains), so it comes first; the plugin is installed into it afterwards
  step('version-check', 10 * MIN, { optional: true }),
  step('import-db', 60 * MIN, { optional: true }),
  step('set-domain', MIN),
  step('install-plugin', 5 * MIN),
  step('custom-after-db', 0, { custom: 'after-db' }),
  step('theme-compile', 10 * MIN),
  step('custom-final', 0, { custom: 'final' }),
  step('ready', 30_000),
];

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

const PLUGIN_NAME = /^[A-Z][A-Za-z0-9]{1,60}$/;
const FULL_PROJECT = 'Vollständige Shopware-Projekte werden von dieser Vorlage noch nicht unterstützt – nur Plugin- und Theme-Repositorys (custom/plugins/<Name>).';
const NO_PLUGIN = 'Kein Shopware-Plugin erkannt: composer.json mit type „shopware-platform-plugin“ und extra.shopware-plugin-class fehlt.';

/** composer.json type shopware-platform-plugin + extra.shopware-plugin-class → plugin name; src/Resources/theme.json → theme. */
export function detectLayout(worktree: string): TaskLayout {
  const file = path.join(worktree, 'composer.json');
  const has = (rel: string) => fs.existsSync(path.join(worktree, rel));
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(file); } catch { /* missing */ }
  if (!st) throw new Error(has('bin/console') || has('symfony.lock') ? FULL_PROJECT : NO_PLUGIN);
  if (!st.isFile() || st.size > 1024 * 1024) throw new Error('composer.json ist keine normale Datei oder zu groß.');
  let c: { type?: unknown; extra?: Record<string, unknown>; require?: Record<string, unknown> };
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('composer.json ist kein gültiges JSON.'); }
  if (c?.type !== 'shopware-platform-plugin') {
    const sw = c?.require && typeof c.require === 'object' && Object.keys(c.require).some(k => /^shopware\/(core|platform|storefront)$/.test(k));
    throw new Error(c?.type === 'project' || sw || has('bin/console') ? FULL_PROJECT : NO_PLUGIN);
  }
  const cls = c.extra?.['shopware-plugin-class'];
  if (typeof cls !== 'string' || !cls.trim()) throw new Error(NO_PLUGIN);
  const name = cls.trim().split('\\').pop() ?? '';
  if (!PLUGIN_NAME.test(name)) throw new Error(`Ungültiger Plugin-Name „${name.slice(0, 80)}“ (erwartet z. B. AcmeTheme: Buchstaben und Ziffern, beginnt mit Großbuchstaben).`);
  return { kind: has('src/Resources/theme.json') ? 'theme' : 'plugin', name, pluginDir: `custom/plugins/${name}` };
}

const DROP_CAPS = ['NET_RAW', 'MKNOD', 'AUDIT_WRITE', 'SYS_CHROOT', 'SETFCAP'];
/** Create body for one task container. Pure: only the validated task id, the configured image, limits and environment.
 *  Attached to the internal network lotse-sandbox only.
 *  No binds, no devices, not privileged. Dockware starts its services with sudo, so no-new-privileges is not possible;
 *  instead capabilities the services do not need are dropped on top of Docker's defaults. */
export function buildSpec(o: SpecInput): ContainerSpec {
  if (!/^t_[a-z0-9]{12}$/.test(o.taskId)) throw new Error('Ungültige Aufgaben-ID.');
  if (!DOCKWARE_IMAGE_PATTERN.test(o.image)) throw new Error('Image nicht erlaubt.');
  const alias = sandboxAlias(o.taskId);
  const host = {
    Memory: Math.round(o.memoryMb * 1024 * 1024), NanoCpus: Math.round(o.cpus * 1e9), PidsLimit: 2048, CapDrop: DROP_CAPS,
    RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '2' } },
  };
  const base = { name: alias, Image: o.image, Hostname: alias, Labels: { ...MANAGED, [TASK_LABEL]: o.taskId, 'lotse.template': 'dockware' }, Env: [...o.env] };
  // Always only the internal network (no route to the internet or the live shop), no published ports: Lotse reaches the storefront
  // there, by alias inside the compose setup or by the container's IP from the host.
  return { ...base, HostConfig: { ...host, NetworkMode: SANDBOX_NET }, NetworkingConfig: { EndpointsConfig: { [SANDBOX_NET]: { Aliases: [alias] } } } };
}

export const dockware: SandboxTemplate = {
  id: 'dockware',
  labelKey: 'dockware',
  platform: 'shopware',
  imagePattern: DOCKWARE_IMAGE_PATTERN,
  defaultImage: DOCKWARE_DEFAULT_IMAGE,
  steps: STEPS,
  commands: COMMANDS,
  buildSpec,
  detectLayout,
  syncTarget: l => `/var/www/html/${l.pluginDir}`,
  execUser: 'www-data',
  workdir: '/var/www/html',
};
