// Template "Dockware (Shopware)": a complete Shopware 6 (dockware/shopware, formerly dockware/play) per task, the repo is a plugin
// or theme below custom/plugins/<Name>. Steps are declared here; the setup job (jobs.ts) executes them with a restricted context.
// Measured with dockware/shopware:6.7.15.1: first boot until HTTP 200 about 75 s, restart after a stop about 43 s, theme:compile about 7 s
// (dockware/play:6.7.2.2: about 20 s). Same layout as play: /var/www/html, www-data (uid 33), mysql root/root. The entrypoint runs as the
// image user dockware (also uid 33, in the sudo group); an exec as www-data has no sudo.
// Dockware keeps APP_URL and the storefront domain at http://localhost; Lotse sends Host: localhost instead of changing them.
import fs from 'node:fs';
import path from 'node:path';
import type { ContainerSpec } from '../runner';
import type { TaskLayout } from '@/lib/protocol';
import { PLUGIN_NAME, isEmptyRepoListing, pluginNameFromRepo } from '@/lib/sandbox-task';
import { MANAGED, SANDBOX_NET, TASK_LABEL, sandboxAlias, taskDbVolume } from '../labels';
import { COMPOSER_NAME, PROJECT_DIR, detectProject, findProjectDirs, imageVersion, isProjectComposer, lockInfo, projectBase, projectSummary, versionMismatch } from '../project';
import { installProject, updatePlugins } from './dockware-project';
import type { CommandArg, CommandSpec, ConsoleSpec, SandboxTemplate, SpecInput, StepCtx, TemplateStep } from './types';

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

/** MySQL first, then the storefront with HTTP 200; backoff up to 3 s, ends with the step's time limit or an abort.
 *  A container that exits meanwhile (e.g. MySQL did not start, Dockware's entrypoint then ends) fails at once with its log.
 *  dbOnly: MySQL alone – right after a dump import the storefront may answer 500 until install-plugin and theme-compile ran. */
export async function waitReady(ctx: Pick<StepCtx, 'run' | 'httpStatus' | 'log' | 'signal' | 'checkAlive'>, o: { dbOnly?: boolean } = {}) {
  let wait = 500, last = '';
  const note = (s: string) => { if (s !== last) ctx.log(s); last = s; };
  for (;;) {
    await ctx.checkAlive();
    const db = await ctx.run(['mysqladmin', 'ping', '-h127.0.0.1', '-uroot', '-proot', '--silent'], { okCodes: [0, 1], timeoutMs: 15_000, quiet: true }).catch(() => ({ exitCode: 1 }));
    if (db.exitCode === 0 && o.dbOnly) { ctx.log('Datenbank läuft wieder.'); return; }
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

/** Shopware's dev toolbar (Symfony profiler) and the cookie notice would cover the bottom of the preview and every screenshot:
 *  switched off in the sandbox only, by a config file for the dev environment and a system config value (the shop stays in dev mode,
 *  errors stay readable). Constant argv, no input; theme-compile clears the cache afterwards. */
export const TIDY_ARGV = ['bash', '-c', "set -e; mkdir -p config/packages/dev; printf 'web_profiler:\\n    toolbar: false\\n    intercept_redirects: false\\n' > config/packages/dev/zz-lotse-preview.yaml; bin/console system:config:set --json core.basicInformation.useDefaultCookieConsent false"];

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

/** Import, then the dump is deleted in the container and – unless it is a stored database – on the host, also when the import fails.
 *  A stored database whose snapshot was restored before the container started needs no import. */
async function importDb(ctx: StepCtx): Promise<void | 'skipped'> {
  const d = ctx.dump();
  if (!d) { ctx.log('Kein Datenbank-Dump – es bleiben die Demodaten von Dockware.'); return 'skipped'; }
  if (d.restored) { await ctx.discardDump(true, null); ctx.log(`Datenbank ${d.name} aus dem Snapshot übernommen – kein Import nötig.`); return; }
  let ok = false;
  try {
    ctx.log(`Dump ${d.name} (${(d.size / 1048576).toFixed(1)} MB) in den Container übertragen …`);
    await ctx.copyDump(IMPORT_DIR);
    await ctx.run(IMPORT_ARGV);
    ok = true;
  } finally { await ctx.discardDump(ok, IMPORT_DIR); }
  ctx.log(d.library ? 'Datenbank importiert. Die gespeicherte Datenbank bleibt für weitere Sandboxes erhalten.' : 'Datenbank importiert. Dump gelöscht ✓');
}

/** A full project: what it contains, and its Shopware version (composer.lock) against the image's tag – a different major.minor
 *  blocks until "Trotzdem fortfahren" (the layout is kept first, so the view can show both versions and the matching image). */
async function projectLayout(ctx: StepCtx, l: TaskLayout): Promise<void> {
  const install = ctx.projectInstall(), p = { ...l.project!, install }, mm = versionMismatch(p.shopwareVersion, ctx.image);
  ctx.setLayout({ ...l, project: { ...p, ...(mm ? { versionMismatch: mm } : {}) } });
  ctx.log(`Shopware-Projekt ${l.name}${l.root ? ` (Ordner ${l.root}/ im Repository)` : ''} → /var/www/html (${install === 'full'
    ? 'vollständig: das ganze Repository, composer install nach deiner Internet-Freigabe'
    : 'Overlay: Plugins, Apps, config/packages, config/services*.yaml, src/'}) · ${projectSummary(p)}`);
  const raw = p.shopwareVersion ? null : lockInfo(ctx.projectRoot()).raw;
  if (raw) ctx.log(`Hinweis: composer.lock nennt shopware/core als „${raw}“ (ein Branch, keine Versionsnummer) – die Shopware-Version des Projekts lässt sich nicht mit dem Image vergleichen.`);
  else if (!p.shopwareVersion) ctx.log('Hinweis: Kein composer.lock mit shopware/core – die Shopware-Version des Projekts lässt sich nicht prüfen.');
  else if (!mm) ctx.log(`Shopware ${p.shopwareVersion} des Projekts passt zum Image (${imageVersion(ctx.image) ?? ctx.image}).`);
  if (!mm) return;
  if (ctx.ignoreProjectVersion) { ctx.log(`Abweichende Version (Projekt ${mm.project}, Image ${mm.image}) – „Trotzdem fortfahren“ gewählt.`); return; }
  throw new Error(`Das Projekt nutzt Shopware ${mm.project}, das Image enthält ${mm.image} – passendes Image (${mm.suggest}) in der Umgebung wählen oder „Trotzdem fortfahren“.`);
}

const RUNS: Partial<Record<TemplateStep['id'], TemplateStep['run']>> = {
  'check-image': ctx => ctx.ensureImage(),
  clone: async ctx => { const { head } = await ctx.clone(); ctx.log(`Commit ${head.slice(0, 12)}`); },
  'detect-layout': async ctx => {
    const mode = ctx.mode();
    if (mode === 'custom') {
      const target = ctx.targetPath(), name = (ctx.repo.split('/').pop() || 'projekt').slice(0, 100);
      ctx.setLayout({ kind: 'custom', name, pluginDir: '', targetPath: target });
      ctx.log(`Eigenes Setup: Das Repository kommt nach ${target}. Lotse installiert und kompiliert nichts – die Einrichtung liegt in deiner Hand (eigene Befehle, Umgebungsvariablen).`);
      return;
    }
    const l = detectLayout(ctx.worktree, { newPluginName: ctx.newPluginName, repo: ctx.repo, projectDir: ctx.projectDir() });
    if (mode === 'project' && l.kind !== 'project') throw new Error(`Gewählt ist „Ganzes Shopware-Projekt“, erkannt wurde aber ${l.isNew ? 'ein leeres Repository' : `ein einzelnes ${l.kind === 'theme' ? 'Theme' : 'Plugin'} (${l.name})`}. Sandbox abschließen und mit „Automatisch“ oder „Eigenes Setup“ neu starten.`);
    if (mode === 'plugin' && l.kind === 'project') throw new Error('Gewählt ist „Plugin oder Theme“, erkannt wurde aber ein ganzes Shopware-Projekt. Sandbox abschließen und mit „Automatisch“ neu starten.');
    if (l.kind === 'project') return projectLayout(ctx, l);
    ctx.setLayout(l);
    ctx.log(l.isNew
      ? `Das Repository ist leer – neues Plugin ${l.name} → ${l.pluginDir}. Die KI legt es in der Sandbox an; Installieren und Theme-Kompilieren entfallen bei der Einrichtung.`
      : `${l.kind === 'theme' ? 'Theme' : 'Plugin'} ${l.name} → ${l.pluginDir}`);
  },
  'start-container': ctx => ctx.createContainer(),
  'wait-ready': ctx => waitReady(ctx),
  'install-plugin': async ctx => {
    if (ctx.layout()?.kind === 'project') return installProject(ctx);
    if (ctx.layout()?.kind === 'custom') {
      await ctx.syncAll();
      ctx.log('Eigenes Setup: Code übertragen. Installiert wird nur, was die eigenen Befehle tun (Umgebung, „Sandbox starten“ → Erweitert oder .lotse/sandbox.json).');
      return;
    }
    const l = pluginName(ctx);
    await ctx.syncAll();
    if (l.isNew) { ctx.log(`Neues Plugin: Es gibt noch nichts zu installieren. Sobald composer.json und die Plugin-Klasse angelegt sind, installiert die KI es mit bin/console plugin:install --activate ${l.name}.`); return 'skipped'; }
    // plugin:refresh and plugin:install exit with 0 even when the plugin was not found (e.g. composer.json invalid): check the database
    const refresh = await ctx.run(bin('plugin:refresh'));
    // a dump with an older version of the plugin installed: updated to the repository's version first (its migrations)
    await updatePlugins(ctx, [l.name]);
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
  // right after import + domain, before anything of the task: MySQL is stopped and started again around the copy. Only MySQL is
  // awaited: the imported shop often answers 500 until its plugins are installed and its theme compiled (later steps; ready checks it)
  'db-snapshot': async ctx => { if ((await ctx.saveDbSnapshot()) === 'skipped') return 'skipped'; await waitReady(ctx, { dbOnly: true }); },
  // cosmetic for the preview (and screenshots taken by hand): a failure only skips the step (the preview proxy hides both by CSS as well)
  'preview-tidy': async ctx => {
    if (ctx.layout()?.kind === 'custom') { ctx.log('Eigenes Setup: Lotse ändert am Shop nichts.'); return 'skipped'; }
    try { await ctx.run(TIDY_ARGV, { timeoutMs: 2 * MIN }); ctx.log('Debug-Leiste und Cookie-Hinweis in der Sandbox ausgeschaltet.'); }
    catch (e) { if (ctx.signal.aborted) throw e; ctx.log(`Übersprungen: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); return 'skipped'; }
  },
  'theme-compile': async ctx => {
    // a new plugin changes nothing yet; an imported dump still needs its themes compiled and the warm cache cleared
    if (ctx.layout()?.kind === 'custom') { ctx.log('Eigenes Setup: kein Theme-Kompilieren durch Lotse.'); return 'skipped'; }
    if (ctx.layout()?.isNew && !ctx.hasDump()) { ctx.log('Neues Plugin: Die Storefront bleibt vorerst unverändert; kompiliert wird, sobald das Plugin Styles oder Templates mitbringt.'); return 'skipped'; }
    await ctx.run(bin('theme:compile')); await ctx.run(bin('cache:clear'));
    // a project's changes (theme, apps, plugins at once): the HTTP cache kept serving the old start page after cache:clear alone
    if (ctx.layout()?.kind === 'project') await ctx.run(bin('cache:pool:clear', '--all'), { okCodes: [0, 1] });
  },
  ready: async ctx => {
    const custom = ctx.layout()?.kind === 'custom';
    const s = await ctx.httpStatus('/').catch((e: unknown) => { if (custom) return 0; throw e; });
    // an own setup decides itself what runs: the status is reported, not judged
    if (custom) { ctx.log(`Die Startseite des Containers antwortet mit HTTP ${s || '–'}.`); return; }
    if (s !== 200) throw new Error(`Die Storefront antwortet mit HTTP ${s}.`);
  },
};
const step = (id: TemplateStep['id'], timeoutMs: number, extra: Partial<TemplateStep> = {}): TemplateStep => ({ id, labelKey: id, timeoutMs, run: RUNS[id], ...extra });
const STEPS: TemplateStep[] = [
  step('check-image', 30 * MIN),
  step('clone', 5 * MIN),
  step('detect-layout', 30_000),
  // includes filling the task's database volume from a snapshot (stored databases)
  step('start-container', 10 * MIN),
  step('wait-ready', 5 * MIN),
  // the dump replaces the whole database (plugin table, domains), so it comes first; the plugin is installed into it afterwards
  step('version-check', 10 * MIN, { optional: true }),
  step('import-db', 60 * MIN, { optional: true }),
  step('set-domain', MIN),
  step('db-snapshot', 10 * MIN, { optional: true }),
  step('preview-tidy', 3 * MIN, { optional: true }),
  // a full project installs several plugins, apps, its theme and composer parts here (about 45 s measured): more time for that only;
  // installed completely it also waits for a human to allow internet and runs composer install (up to 20 min)
  step('install-plugin', 5 * MIN, { timeoutFor: l => (l?.kind !== 'project' ? 5 * MIN : l.project?.install === 'full' ? 90 * MIN : 15 * MIN) }),
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

const NO_COMPOSER_PROJECT = 'Das Repository sieht nach einem Shopware-Projekt aus, hat aber keine composer.json im Hauptordner (mit shopware/core in „require“) – so kann Lotse es nicht einrichten.';
const NOT_SHOPWARE_PROJECT = 'Kein Shopware-Projekt erkannt: composer.json verlangt weder shopware/core noch shopware/platform.';
const NO_PLUGIN = 'Kein Shopware-Plugin erkannt: composer.json mit type „shopware-platform-plugin“ und extra.shopware-plugin-class fehlt. Für ein neues Plugin ein leeres Repository wählen (höchstens README, LICENSE, .gitignore).';

const NO_NAME = 'Das Repository ist leer, aber es fehlt ein gültiger technischer Name für das neue Plugin (z. B. CoNineHeaderBanner: Buchstaben und Ziffern, beginnt mit einem Großbuchstaben). Sandbox abschließen und mit Plugin-Namen neu starten.';

/** Options for an empty repository: the name the user chose for the new plugin (else one derived from the repository name). */
export interface DetectOptions { newPluginName?: string | null; repo?: string;
  /** the repository's subfolder that holds the Shopware project (.lotse/sandbox.json "projectDir"); empty = search for it */ projectDir?: string }

const NOT_IN_DIR = (dir: string) => `In „${dir.slice(0, 80)}“ liegt kein Shopware-Projekt (composer.json mit shopware/core in „require“).`;
const projectName = (c: Record<string, unknown>, o: DetectOptions) => {
  const n = typeof c.name === 'string' && COMPOSER_NAME.test(c.name) ? c.name : (o.repo ?? '').split('/').pop() || 'projekt';
  return n.slice(0, 100);
};
/** The layout of a project whose folder is `root` ('' = the repository's root) */
function projectLayoutOf(worktree: string, root: string, c: Record<string, unknown>, o: DetectOptions): TaskLayout {
  return { kind: 'project', name: projectName(c, o), pluginDir: '', ...(root ? { root } : {}), project: detectProject(projectBase(worktree, root)) };
}
/** The Shopware project in a subfolder the repository file named (projectDir) */
function projectInDir(worktree: string, dir: string, o: DetectOptions): TaskLayout {
  if (!PROJECT_DIR.test(dir)) throw new Error(`projectDir „${dir.slice(0, 80)}“ ist kein gültiger Ordnername (höchstens drei Ebenen, ohne führenden Punkt).`);
  const base = projectBase(worktree, dir);
  let c: Record<string, unknown> | null = null;
  try { c = JSON.parse(fs.readFileSync(path.join(base, 'composer.json'), 'utf8')) as Record<string, unknown>; } catch { /* none */ }
  if (!isProjectComposer(c, base)) throw new Error(NOT_IN_DIR(dir));
  return projectLayoutOf(worktree, dir, c!, o);
}
/** The one Shopware project below the root; several: the repository file must say which (projectDir). null = none. */
function inSubfolder(worktree: string, o: DetectOptions): TaskLayout | null {
  const found = findProjectDirs(worktree);
  if (!found.length) return null;
  if (found.length > 1) throw new Error(`Im Repository liegen mehrere Shopware-Projekte (${found.slice(0, 5).join(', ')}). Welches gemeint ist, steht in .lotse/sandbox.json unter "projectDir" (z. B. "projectDir": "${found[0]}").`);
  return projectInDir(worktree, found[0], o);
}

/** composer.json type shopware-platform-plugin + extra.shopware-plugin-class → plugin name; src/Resources/theme.json → theme;
 *  type project requiring shopware/core (or platform) → a full Shopware project (project.ts).
 *  An (almost) empty repository (README, LICENSE, .gitignore at most) becomes a new plugin that the AI builds in the sandbox. */
export function detectLayout(worktree: string, o: DetectOptions = {}): TaskLayout {
  // the repository file names the project's folder: nothing else is looked at
  if (o.projectDir) return projectInDir(worktree, o.projectDir, o);
  const file = path.join(worktree, 'composer.json');
  const has = (rel: string) => fs.existsSync(path.join(worktree, rel));
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(file); } catch { /* missing */ }
  if (!st && isEmptyRepoListing(fs.readdirSync(worktree))) {
    const name = o.newPluginName?.trim() || pluginNameFromRepo(o.repo ?? '');
    if (!PLUGIN_NAME.test(name)) throw new Error(NO_NAME);
    return { kind: 'plugin', name, pluginDir: `custom/plugins/${name}`, isNew: true };
  }
  if (!st) {
    // no composer.json in the root: the Shopware project may be in a subfolder (the root holds other things)
    const sub = inSubfolder(worktree, o);
    if (sub) return sub;
    throw new Error(has('bin/console') || has('symfony.lock') ? NO_COMPOSER_PROJECT : NO_PLUGIN);
  }
  if (!st.isFile() || st.size > 1024 * 1024) throw new Error('composer.json ist keine normale Datei oder zu groß.');
  let c: { type?: unknown; extra?: Record<string, unknown>; require?: Record<string, unknown> };
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('composer.json ist kein gültiges JSON.'); }
  if (c?.type !== 'shopware-platform-plugin') {
    // a whole Shopware project (shopware/production layout): its plugins, apps and configuration are synced into the sandbox's shop
    if (isProjectComposer(c as Record<string, unknown>, worktree)) return projectLayoutOf(worktree, '', c as Record<string, unknown>, o);
    // another composer.json in the root (tooling next to the shop): the project may still be in a subfolder
    const sub = inSubfolder(worktree, o);
    if (sub) return sub;
    throw new Error(c?.type === 'project' || has('bin/console') ? NOT_SHOPWARE_PROJECT : NO_PLUGIN);
  }
  const cls = c.extra?.['shopware-plugin-class'];
  if (typeof cls !== 'string' || !cls.trim()) throw new Error(NO_PLUGIN);
  const name = cls.trim().split('\\').pop() ?? '';
  if (!PLUGIN_NAME.test(name)) throw new Error(`Ungültiger Plugin-Name „${name.slice(0, 80)}“ (erwartet z. B. AcmeTheme: Buchstaben und Ziffern, beginnt mit Großbuchstaben).`);
  return { kind: has('src/Resources/theme.json') ? 'theme' : 'plugin', name, pluginDir: `custom/plugins/${name}` };
}

/** Measured with dockware/shopware:6.7.15.1: the entrypoint runs as PID 1 under bash, which ignores SIGTERM, so `docker stop` always
 *  waits its full grace period and then kills MySQL with SIGKILL. Its socket lock file (/var/run/mysqld/mysqld.sock.lock, holding the
 *  old PID) stays behind; the entrypoint's own cleanup runs as www-data and cannot see into the 0700 directory. On the next start
 *  mysqld aborts whenever that PID belongs to another process again ("Another process with pid … is using unix socket file"),
 *  `service mysql start` fails after 30 s and the container exits – 2 of 4 quick restarts here. Two remedies:
 *  - the boot hook /var/www/boot_start.sh (run by the entrypoint before MySQL) removes stale lock files: 10 of 10 SIGKILL restarts
 *    came up, also those stopped 15 s into the boot; it also covers stops Lotse does not control (OOM, Docker restart);
 *  - pausing first shuts MySQL down cleanly (as root), then a short grace period: docker stop takes about 3 s instead of 10 s. */
export const BOOT_SCRIPT = '#!/bin/sh\n# Lotse: remove MySQL socket locks a killed container left behind (see dockware.ts)\nsudo rm -f /var/run/mysqld/mysqld.sock.lock /var/run/mysqld/mysqlx.sock.lock || true\nexit 0\n';
/** As root: Lotse's execs run as www-data, which shares uid 33 with the image user dockware but not its sudo group (sudo asks for a password). */
export const MYSQL_STOP_ARGV = ['service', 'mysql', 'stop'];
export const MYSQL_START_ARGV = ['service', 'mysql', 'start'];
/** Stored databases: MySQL's data directory lives in a volume of the task; snapshots are taken from a cleanly stopped MySQL (jobs.ts) */
export const DATABASE = { dataDir: '/var/lib/mysql', stop: { argv: MYSQL_STOP_ARGV, user: 'root' }, start: { argv: MYSQL_START_ARGV, user: 'root' } };

const DROP_CAPS = ['NET_RAW', 'MKNOD', 'AUDIT_WRITE', 'SYS_CHROOT', 'SETFCAP'];
/** Create body for one task container. Pure: only the validated task id, the configured image, limits and environment.
 *  Attached to the internal network lotse-sandbox only.
 *  No binds, no devices, not privileged; at most the task's own database volume (stored databases). Dockware starts its services with sudo, so no-new-privileges is not possible;
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
  // a stored database: MySQL's data directory is the task's own volume (restored from a snapshot or filled from the image on first use)
  if (o.dbVolume !== undefined && o.dbVolume !== taskDbVolume(o.taskId)) throw new Error('Ungültiges Datenbank-Volume.');
  const mounts = o.dbVolume ? { Mounts: [{ Type: 'volume', Source: o.dbVolume, Target: DATABASE.dataDir, ReadOnly: false }] } : {};
  // Always only the internal network (no route to the internet or the live shop), no published ports: Lotse reaches the storefront
  // there, by alias inside the compose setup or by the container's IP from the host.
  return { ...base, HostConfig: { ...host, ...mounts, NetworkMode: SANDBOX_NET }, NetworkingConfig: { EndpointsConfig: { [SANDBOX_NET]: { Aliases: [alias] } } } };
}

/** Console shells as the image's own user "dockware" (uid 33 like www-data, so files keep their owner; member of sudo, so sudo works as
 *  in a normal Dockware shell – www-data cannot sudo). The AI's execs share uid 33, so the shell must not read anything uid 33 can write
 *  on its own: the wrapper starts as root, writes the rc file and the pid file into a root-owned directory, then drops to dockware
 *  (setpriv, no fork: the pid stays the session leader of the TTY) and starts an interactive bash without profile, ~/.bashrc,
 *  ~/.inputrc, history file and BASH_ENV, with the system-wide files only; nvm (in /var/www) loads when it is typed.
 *  The pid file holds pid and start time: stop only ends that very console (CONSOLE_KILL). */
export const CONSOLE_DIR = '/run/lotse-console';
const CONSOLE_RC = [
  '# Lotse console: written by root on every start; the shell reads no file the sandbox user (uid 33) can change',
  '# /etc/bash.bashrc ran already (Debian bash reads it for every interactive shell); /etc/profile adds the image environment',
  'p1=$PS1; PS1=; [ -r /etc/profile ] && . /etc/profile; PS1=$p1; unset p1',
  '# the image points BASH_ENV at /var/www/.bashrc, which uid 33 can write: no script the user starts here sources it',
  'unset BASH_ENV HISTFILE',
  'nvm() { unset -f nvm; . /var/www/.nvm/nvm.sh && nvm "$@"; }',
  '# the user and directory as the console tab and the audit name them (uid 33 is "www-data" first in /etc/passwd, so not \\u; not \\w,',
  '# which shortens the shop directory to ~/html)',
  'PS1=\'\\[\\e[32m\\]dockware@\\h\\[\\e[0m\\]:\\[\\e[34m\\]$PWD\\[\\e[0m\\]\\$ \'',
].join('\n');
/** sudo in the console: the image's sudo logs every allowed command to syslog (not running) and the kernel audit, which fails
 *  without AUDIT_WRITE (dropped on purpose) and prints "unable to send audit message" after each sudo. Not logging allowed commands
 *  of the sudo group (only the console has it; www-data, the AI's user, has no sudo at all) loses no record that existed; denials are
 *  still logged, use_pty stays (CONSOLE_KILL relies on it only through the process tree), Lotse audits opening and closing. */
export const CONSOLE_SUDOERS = 'Defaults:%sudo !log_allowed';
const CONSOLE_START = [
  `set -eu; s=$1; d=${CONSOLE_DIR}`,
  '[ -d "$d" ] || mkdir -m 755 "$d"; [ "$(stat -c %u "$d")" = 0 ]; umask 022',
  'printf \'%s\\n\' "$2" > "$d/bashrc"',
  // checked by visudo before it is moved into place: a broken sudoers file would lock sudo; best effort, never stops the console
  `c=/etc/sudoers.d/lotse-console; if [ -d /etc/sudoers.d ] && [ "$(cat "$c" 2>/dev/null)" != '${CONSOLE_SUDOERS}' ]; then`,
  `  { printf '%s\\n' '${CONSOLE_SUDOERS}' > "$d/sudoers" && chmod 440 "$d/sudoers" && visudo -cqf "$d/sudoers" && mv -f "$d/sudoers" "$c"; } || rm -f "$d/sudoers"; fi`,
  'st=$(cat /proc/$$/stat); set -- ${st##*) }; echo "$$ ${20}" > "$d/$s.pid"',
  'u=$(id -u dockware); g=$(id -g dockware); gs=$(id -G dockware | tr " " ,)',
  'exec env -u BASH_ENV -u ENV HOME=/var/www USER=dockware LOGNAME=dockware SHELL=/bin/bash INPUTRC=/etc/inputrc setpriv --reuid="$u" --regid="$g" --groups="$gs" bash --noprofile --rcfile "$d/bashrc" -i',
].join('\n');
/** `leader <pid file>`: removes the file; true (and $p set) if the recorded process still runs with the recorded start time */
const LEADER = 'leader() { p=; t=; read -r p t < "$1" || :; rm -f "$1"; case "$p" in ""|*[!0-9]*|0|1) return 1;; esac; st=$(cat "/proc/$p/stat" 2>/dev/null) || return 1; set -- ${st##*) }; [ "${20}" = "$t" ]; }';
/** `procs <session> "<pid:start …>"`: the console's processes as "pid:start" (sorted), from /proc: everything in the session and
 *  everything still alive of the given ones (same start time, so never a reused pid), plus all their descendants. The tree, not
 *  only the session: sudo (use_pty) runs its command in a new session below it. A job that forks away to pid 1 (`setsid cmd &`, a
 *  daemon) is not the console's any more. The pid comes from the file name, never from the line: a process name may contain a
 *  newline, which only splits its own line (joined again here). */
export const CONSOLE_PROCS = `procs() { LC_ALL=C grep -aHs '' /proc/[0-9]*/stat | LC_ALL=C awk -v s="$1" -v seed="$2" '
{ i = index($0, ":"); p = substr($0, 7, i - 12); l[p] = (p in l) ? l[p] " " substr($0, i + 1) : substr($0, i + 1) }
END { for (p in l) { r = l[p]; sub(/^[^(]*\\(.*\\) /, "", r); split(r, f, " "); par[p] = f[2]; st[p] = f[20]; if (f[4] == s) k[p] = 1 }
  m = split(seed, a, " "); for (j = 1; j <= m; j++) { split(a[j], q, ":"); if ((q[1] in st) && st[q[1]] == q[2]) k[q[1]] = 1 }
  do { c = 0; for (i in par) if (!(i in k) && (par[i] in k)) { k[i] = 1; c = 1 } } while (c)
  for (i in k) if (i != 1) print i ":" st[i] }' | sort | tr '\\n' ' '; }`;
/** `freeze <session>`: SIGSTOP the console's processes ($a, extended) until no new one appears – stopped processes cannot fork, so
 *  nothing slips out between finding and killing; `sig <signal>` sends one to all of $a. */
const CONSOLE_FREEZE = 'freeze() { i=0; while [ $i -lt 50 ]; do b=$(procs "$1" "$a"); [ "$b" = "$a" ] && return; a=$b; sig STOP; i=$((i+1)); done; }; sig() { for x in $a; do kill -"$1" "${x%%:*}" 2>/dev/null || :; done; }';
/** Ends a console: its whole process tree, also what runs as root via sudo. HUP first (editors save, jobs clean up), then KILL for
 *  whatever is left a second later. Daemons that detach completely (double fork to pid 1, e.g. `sudo service mysql restart`) are
 *  left alone on purpose; pausing or finishing the sandbox stops the container and everything in it. */
const CONSOLE_KILL = `${CONSOLE_PROCS}; ${CONSOLE_FREEZE}`;
const CONSOLE_STOP = `${LEADER}; ${CONSOLE_KILL}; f=${CONSOLE_DIR}/$1.pid; [ -f "$f" ] && leader "$f" || exit 0; a=; freeze "$p"; sig HUP; sig CONT; sleep 1; freeze "$p"; sig KILL; exit 0`;
const CONSOLE_STOP_ALL = `${LEADER}; ${CONSOLE_KILL}; n=0; for f in ${CONSOLE_DIR}/*.pid; do [ -f "$f" ] && leader "$f" || continue; a=; freeze "$p"; sig KILL; n=$((n+1)); done; echo "$n"; exit 0`;
export const CONSOLE: ConsoleSpec = {
  user: 'dockware',
  workdir: '/var/www/html',
  env: ['TERM=xterm-256color', 'COLORTERM=truecolor', 'LANG=C.UTF-8'],
  start: sid => ({ argv: ['sh', '-c', CONSOLE_START, 'sh', sid, CONSOLE_RC], user: 'root' }),
  stop: sid => ({ argv: ['sh', '-c', CONSOLE_STOP, 'sh', sid], user: 'root' }),
  stopAll: { argv: ['sh', '-c', CONSOLE_STOP_ALL], user: 'root' },
};

export const dockware: SandboxTemplate = {
  id: 'dockware',
  labelKey: 'dockware',
  platform: 'shopware',
  runtime: 'container',
  enabled: true,
  previewProvider: { kind: 'sandbox' },
  imagePattern: DOCKWARE_IMAGE_PATTERN,
  defaultImage: DOCKWARE_DEFAULT_IMAGE,
  steps: STEPS,
  commands: COMMANDS,
  buildSpec,
  detectLayout,
  syncTarget: l => (l.kind === 'project' ? '/var/www/html' : l.kind === 'custom' ? l.targetPath ?? '' : `/var/www/html/${l.pluginDir}`),
  execUser: 'www-data',
  workdir: '/var/www/html',
  bootFile: { dir: '/var/www', name: 'boot_start.sh', content: BOOT_SCRIPT, mode: 0o755 },
  gracefulStop: { argv: MYSQL_STOP_ARGV, user: 'root', timeoutMs: 30_000, stopTimeoutSec: 3 },
  database: DATABASE,
  console: CONSOLE,
};
