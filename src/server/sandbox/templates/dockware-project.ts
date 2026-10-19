// Template "Dockware (Shopware)", step "install-plugin" for a full Shopware project repository (A19, mode "Overlay"): the image's
// Shopware stays installed, the project's parts are synced over it and installed. Measured offline with dockware/shopware:6.7.15.1 and a
// project with 3 plugins, a static plugin, an app, a theme, src/ and production configs: about 45 s.
//  1. what the clean image knows: APP_ENV, extension aliases (bin/console debug:config), defined environment variables (names only)
//  2. sync (sync.ts): plugin/app folders, config/packages + config/services*.yaml (with the sandbox override, quarantine), src/
//  3. static plugins (custom/static-plugins) via an offline composer path install, like shopware/production does it; other psr-4
//     namespaces of src/ via composer dump-autoload (offline, composer.json's repositories restored afterwards)
//  4. boot check: bin/console about; a config error that names a file takes that file out (at most 5 rounds), else the step fails
//     with the error and the likely file
//  5. plugin:refresh + install/activate (without a dump all project plugins; with a dump its plugin table decides, only new ones are
//     installed, ones the repository has in a newer version are updated; installed completely also the plugins composer.json requires), apps (app:install --force: aborts without it), the project's theme (without a dump)
//  6. extension aliases again (plugins may bring their own): files quarantined only for that are loaded now
// Installed completely (installProjectFull, the default): the whole repository goes into /var/www/html and the project's own
// composer install replaces the image's vendor/ – after a human allowed internet for it (the setup waits, internet.ts), offline again
// right after. Then steps 1 and 4–6 as above, with the database migrated to the project's Shopware first.
// Every argv is constant or built from validated names (plugin names, composer package names, sales channel ids from MySQL).
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectInfo, TaskLayout } from '@/lib/protocol';
import { PLUGIN_NAME, composerAuthWanted } from '@/lib/sandbox-task';
import {
  COMPOSER_NAME, ENV_NAMES_ARGV, bootError, bootFinding, detectProject, missingPsr4, parseAppEnv, parseEnvNames, parseExtensions, pickTheme,
  overrideFile, readComposerJson, reasonText, requiredPackages, type ConfigPlan,
} from '../project';
import type { StepCtx } from './types';

const MIN = 60_000;
const bin = (...a: string[]) => ['bin/console', ...a];
const MYSQL = ['mysql', '-uroot', '-proot', '-h127.0.0.1', 'shopware', '-N', '-e'];
const ANY = { okCodes: Array.from({ length: 256 }, (_, i) => i) };
/** Boot rounds: each one takes a file out or defines an env default (the fixture needed one) */
export const BOOT_ROUNDS = 5;

/** composer.json of the image: only path repositories plus packagist off (offline, else composer fails on Shopware's conflicts
 *  repository), psr-4 additions of the project (argv[2], JSON); "restore" puts the original repositories back afterwards (the
 *  requirements and autoload stay). As www-data in /var/www/html. */
export const COMPOSER_EDIT_PHP = `$f = '/var/www/html/composer.json'; $keep = '/var/www/html/var/lotse-composer-repositories.json';
$j = json_decode((string) file_get_contents($f), true);
if (!is_array($j)) { fwrite(STDERR, "composer.json ist nicht lesbar\\n"); exit(2); }
if (($argv[1] ?? '') === 'prepare') {
  if (!file_exists($keep)) file_put_contents($keep, json_encode(['repositories' => $j['repositories'] ?? null]));
  $repos = array_values(array_filter($j['repositories'] ?? [], fn ($r) => is_array($r) && ($r['type'] ?? '') === 'path'));
  if (!array_filter($repos, fn ($r) => ($r['url'] ?? '') === 'custom/static-plugins/*')) $repos[] = ['type' => 'path', 'url' => 'custom/static-plugins/*', 'options' => ['symlink' => true]];
  $repos[] = ['packagist.org' => false];
  $j['repositories'] = $repos;
  foreach (json_decode($argv[2] ?? '{}', true) ?: [] as $ns => $dir) $j['autoload']['psr-4'][$ns] = $dir;
} else {
  if (!file_exists($keep)) exit(0);
  $o = json_decode((string) file_get_contents($keep), true);
  if (($o['repositories'] ?? null) === null) unset($j['repositories']); else $j['repositories'] = $o['repositories'];
  unlink($keep);
}
file_put_contents($f, json_encode($j, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\\n");`;
const OFFLINE = ['env', 'COMPOSER_DISABLE_NETWORK=1', 'COMPOSER_NO_INTERACTION=1'];
/** Clears Symfony's cache directory (the boot check builds the container again) */
const CLEAR_CACHE = ['bash', '-c', 'rm -rf var/cache/* 2>/dev/null; exit 0'];

const project = (ctx: StepCtx): { l: TaskLayout; p: ProjectInfo } => {
  const l = ctx.layout();
  if (!l?.project || l.kind !== 'project') throw new Error('Projekt noch nicht erkannt (Schritt „Plugin erkennen“ fehlt).');
  return { l, p: l.project };
};
const save = (ctx: StepCtx, l: TaskLayout, p: ProjectInfo) => ctx.setLayout({ ...l, project: p });
const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean);

/** Config files in the container that configure the extension a failed boot names as missing, but are not in the project's repository
 *  (so they come from the image): removed; the paths removed. */
export async function removeImageLeftovers(ctx: StepCtx, output: string): Promise<string[]> {
  const ext = /Container extension "([a-z0-9_]+)" is not registered|no extension able to load the configuration for "([a-z0-9_]+)"/.exec(output);
  const name = ext?.[1] ?? ext?.[2];
  if (!name) return [];
  const found = await ctx.run(['grep', '-rlE', `^[[:space:]]*${name}:`, '--', 'config/packages'], { ...ANY, quiet: true });
  const root = ctx.projectRoot();
  const files = lines(found.output).filter(f => /^config\/packages\/[\w./-]+$/.test(f) && !f.split('/').includes('..') && !fs.existsSync(path.join(root, f)));
  for (const f of files) await ctx.run(['rm', '-f', '--', f], { quiet: true });
  return files;
}

/** Step 1: the clean image's APP_ENV, extension aliases and environment names; on a retry (config already synced, the console may not
 *  boot) what an earlier run read is kept. */
async function readRuntime(ctx: StepCtx, p: ProjectInfo): Promise<ProjectInfo> {
  const about = await ctx.run(bin('about'), { ...ANY, quiet: true });
  let dbg = await ctx.run(['bash', '-c', 'bin/console debug:config 2>&1'], { ...ANY, quiet: true });
  // An installed project replaces the image's vendor/ and bundles.php, but the image's own config files stay: one that configures a
  // bundle the project does not have ("Container extension "web_profiler" is not registered") is a leftover of the image – removed.
  for (let round = 0; round < BOOT_ROUNDS && dbg.exitCode !== 0; round++) {
    const gone = await removeImageLeftovers(ctx, dbg.output);
    if (!gone.length) break;
    ctx.log(`Konfiguration des Images, die eine Erweiterung des Projekts nicht kennt, entfernt: ${gone.join(', ')}`);
    await ctx.run(CLEAR_CACHE, { quiet: true });
    dbg = await ctx.run(['bash', '-c', 'bin/console debug:config 2>&1'], { ...ANY, quiet: true });
  }
  const extensions = dbg.exitCode === 0 ? parseExtensions(dbg.output) : p.extensions;
  if (!extensions?.length) throw new Error(`Shopware im Container antwortet nicht auf bin/console: ${bootError(dbg.output) || `Exit-Code ${dbg.exitCode}`}`);
  const envNames = parseEnvNames((await ctx.run(ENV_NAMES_ARGV, { quiet: true })).output);
  const appEnv = about.exitCode === 0 ? parseAppEnv(about.output) : p.appEnv ?? 'dev';
  ctx.log(`Shopware ${p.install === 'full' ? 'des Projekts' : 'im Image'}: Umgebung ${appEnv}, ${extensions.length} Konfigurations-Erweiterungen (${extensions.join(', ')}).`);
  return { ...p, appEnv, extensions, envNames };
}

/** What the sync's config plan did, for the setup log: written once the boot check settled (an override taken from a file the boot
 *  check took out afterwards would otherwise be listed although it never applied) */
function logPlan(ctx: StepCtx, plan: ConfigPlan | null, appEnv: string) {
  if (!plan) return;
  for (const [f, q] of plan.quarantine) ctx.log(`Nicht geladen: ${f} – ${reasonText(q)}`);
  if (plan.notes.length) ctx.log(`Sandbox-Anpassungen (${overrideFile(appEnv)}): ${plan.notes.join('; ')}`);
  if (plan.envDefaults.length) ctx.log(`Umgebungsvariablen ohne Wert in der Sandbox: ${plan.envDefaults.join(', ')}`);
}

/** Packages the project or its plugins require that the image does not have (never installed offline: a warning) */
async function missingPackages(ctx: StepCtx, p: ProjectInfo): Promise<string[]> {
  const own = new Set(p.plugins.map(x => x.composerName).filter((x): x is string => !!x));
  const want = new Set(requiredPackages(readComposerJson(`${ctx.projectRoot()}/composer.json`), own));
  for (const x of p.plugins) for (const r of requiredPackages(readComposerJson(`${ctx.projectRoot()}/${x.dir}/composer.json`), own)) want.add(r);
  if (!want.size) return [];
  const r = await ctx.run(['bash', '-c', 'for p; do [ -d "vendor/$p" ] || echo "$p"; done; exit 0', '_', ...[...want].filter(n => COMPOSER_NAME.test(n))], { quiet: true });
  return lines(r.output).filter(n => want.has(n)).sort();
}

/** Step 3: static plugins (offline composer path install) and psr-4 namespaces of src/ the image lacks */
async function composerParts(ctx: StepCtx, p: ProjectInfo, skip: Set<string>) {
  const statics = p.plugins.filter(x => x.static && x.composerName && !skip.has(x.name));
  for (const x of p.plugins.filter(y => y.static && !y.composerName)) ctx.log(`Warnung: ${x.dir} hat keinen gültigen composer-Namen – wird nicht installiert.`);
  const image = await ctx.run(['cat', 'composer.json'], { quiet: true });
  let imageJson: Record<string, unknown> | null = null;
  try { imageJson = JSON.parse(image.output) as Record<string, unknown>; } catch { /* below */ }
  const { add, skipped } = missingPsr4(p.psr4, imageJson);
  if (skipped.length) ctx.log(`Hinweis: Autoload für ${skipped.join(', ')} zeigt nicht nach src/ – dieser Code wird in der Sandbox nicht geladen.`);
  if (!statics.length && !Object.keys(add).length) return;
  if (!imageJson) throw new Error('composer.json im Container ist nicht lesbar.');
  await ctx.run(['php', '-r', COMPOSER_EDIT_PHP, '--', 'prepare', JSON.stringify(add)], { quiet: true });
  try {
    if (statics.length) {
      ctx.log(`Statische Plugins über composer (offline, Pfad-Repository): ${statics.map(x => x.composerName).join(', ')}`);
      await ctx.run([...OFFLINE, 'composer', 'require', '--no-scripts', '--no-plugins', '--no-interaction', '--no-progress', '--', ...statics.map(x => `${x.composerName}:*@dev`)], { timeoutMs: 5 * MIN });
    } else {
      ctx.log(`Autoload für den Projekt-Code: ${Object.keys(add).join(', ')}`);
      await ctx.run([...OFFLINE, 'composer', 'dump-autoload', '--no-scripts', '--no-plugins', '--no-interaction'], { timeoutMs: 5 * MIN });
    }
  } finally { await ctx.run(['php', '-r', COMPOSER_EDIT_PHP, '--', 'restore'], { quiet: true }).catch(() => {}); }
}

/** Step 4: Shopware boots with the project's config (bin/console about); a file the error points at is taken out and synced again.
 *  Returns the project and the plan it booted with; a failure logs the plan of the last round before it throws. */
async function bootCheck(ctx: StepCtx, l: TaskLayout, p: ProjectInfo, plan: ConfigPlan | null): Promise<{ p: ProjectInfo; plan: ConfigPlan | null }> {
  for (let round = 1; ; round++) {
    await ctx.run(CLEAR_CACHE, { quiet: true });
    const r = await ctx.run(bin('about'), { ...ANY, quiet: true, timeoutMs: 3 * MIN });
    if (r.exitCode === 0) { ctx.log(round === 1 ? 'Shopware startet mit der Konfiguration des Projekts ✓' : `Shopware startet nach ${round - 1} Anpassung(en) ✓`); return { p, plan }; }
    const why = bootError(r.output), found = round <= BOOT_ROUNDS ? bootFinding(r.output, plan?.files ?? [], p.appEnv ?? 'dev') : null;
    if (found && 'env' in found && !(p.extraEnv ?? []).includes(found.env)) {
      ctx.log(`Umgebungsvariable ${found.env} fehlt – in der Sandbox leer gesetzt.`);
      p = { ...p, extraEnv: [...(p.extraEnv ?? []), found.env] };
    } else if (found && 'file' in found && !(p.held ?? []).some(h => h.file === found.file)) {
      ctx.log(`Shopware startet nicht (${why}) – ${found.file} wird in der Sandbox nicht geladen.`);
      p = { ...p, held: [...(p.held ?? []), found] };
    } else {
      const quoted = [...why.matchAll(/"([^"]{3,80})"/g)].map(m => m[1]);
      const likely = (plan?.files ?? []).find(f => quoted.some(q => f.raw.includes(q)))?.rel;
      logPlan(ctx, plan, p.appEnv ?? 'dev');
      throw new Error(`Shopware startet mit der Konfiguration des Projekts nicht: ${why || `Exit-Code ${r.exitCode}`}${likely ? `\nWahrscheinliche Ursache: ${likely}` : found && 'file' in found ? `\nWahrscheinliche Ursache: ${found.file}` : '\nDie Ursache ließ sich keiner Konfigurationsdatei zuordnen – Log (var/log) in der Konsole prüfen.'}`);
    }
    save(ctx, l, p);
    plan = await ctx.syncAll();
    p = project(ctx).p; // the sync keeps what it quarantined on the layout
  }
}

/** Installed plugins of the database whose code in the repository is newer (a branch ahead of the live shop): plugin:refresh only
 *  records the upgrade version, plugin:update runs the plugin's update() and its new migrations, as a deployment does. One that fails
 *  (Shopware then deactivates it) is a warning: the database stays the user's. */
export async function updatePlugins(ctx: StepCtx, names: string[]): Promise<void> {
  const safe = names.filter(n => PLUGIN_NAME.test(n));
  if (!safe.length) return;
  const r = await ctx.run([...MYSQL, `SELECT name, version, upgrade_version FROM plugin WHERE installed_at IS NOT NULL AND upgrade_version IS NOT NULL AND name IN (${safe.map(n => `'${n}'`).join(',')})`], { quiet: true });
  const due = lines(r.output).map(x => x.split(/\s+/)).filter(x => x.length === 3 && safe.includes(x[0]));
  if (!due.length) return;
  const all = await ctx.run(bin('plugin:update', '-n', '--', ...due.map(x => x[0])), { ...ANY, timeoutMs: 10 * MIN });
  const failed = new Map<string, string>();
  if (all.exitCode !== 0) {
    for (const [n] of due) {
      const one = await ctx.run(bin('plugin:update', '-n', '--', n), { ...ANY, timeoutMs: 5 * MIN });
      if (one.exitCode !== 0) failed.set(n, bootError(one.output) || `Exit-Code ${one.exitCode}`);
    }
  }
  const done = due.filter(x => !failed.has(x[0]));
  if (done.length) ctx.log(`Plugins auf die Version des Repositorys aktualisiert (plugin:update, mit Migrationen): ${done.map(([n, from, to]) => `${n} ${from} → ${to}`).join(', ')}`);
  for (const [n, why] of failed) ctx.log(`Warnung: Plugin ${n} ließ sich nicht auf die Version des Repositorys aktualisieren (Shopware deaktiviert es dann): ${why}`);
}

/** Plugins below vendor/ (after plugin:refresh) that the project's composer.json requires directly: their names */
async function composerPlugins(ctx: StepCtx, p: ProjectInfo): Promise<string[]> {
  const own = new Set(p.plugins.map(x => x.composerName).filter((x): x is string => !!x));
  const want = new Set(requiredPackages(readComposerJson(`${ctx.projectRoot()}/composer.json`), own));
  if (!want.size) return [];
  const r = await ctx.run([...MYSQL, "SELECT name, composer_name FROM plugin WHERE path LIKE 'vendor/%' AND composer_name IS NOT NULL"], { quiet: true, okCodes: [0, 1] });
  return lines(r.output).map(x => x.split(/\s+/)).filter(x => x.length === 2 && PLUGIN_NAME.test(x[0]) && want.has(x[1])).map(x => x[0]).sort();
}

/** Plugin states in the database: name → "<installed><active>" (e.g. "11") */
async function pluginStates(ctx: StepCtx, names: string[]): Promise<Map<string, string>> {
  const safe = names.filter(n => PLUGIN_NAME.test(n));
  if (!safe.length) return new Map();
  const r = await ctx.run([...MYSQL, `SELECT name, CONCAT(installed_at IS NOT NULL, active) FROM plugin WHERE name IN (${safe.map(n => `'${n}'`).join(',')})`], { quiet: true });
  return new Map(lines(r.output).map(x => x.split(/\s+/)).filter(x => x.length === 2 && PLUGIN_NAME.test(x[0])).map(x => [x[0], x[1]]));
}

/** composer install of the project itself: from its composer.lock, without scripts (they would boot Shopware with the project's
 *  unchecked config); private packages authenticate with COMPOSER_AUTH from the sandbox environment. As www-data in /var/www/html. */
export const COMPOSER_INSTALL = ['env', 'COMPOSER_NO_INTERACTION=1', 'COMPOSER_MEMORY_LIMIT=-1', 'composer', 'install', '--no-interaction', '--no-progress', '--no-scripts', '--prefer-dist', '--optimize-autoloader'];
/** The project's migrations (its Shopware may be newer than the image's or the dump's): non-destructive ones only, as an update does */
const MIGRATE = bin('database:migrate', '--all', '-n');
/** Why composer failed, for the step's error: authentication, a missing lock, a platform requirement, otherwise its last lines */
export function composerHint(output: string): string {
  if (composerAuthWanted(output)) return /packages\.shopware\.com/.test(output) ? 'packages.shopware.com verweigert den Download – hier den Token deines Shopware-Kontos (Shops → Composer-Token) eingeben; er wird als geheime Variable COMPOSER_AUTH gespeichert und der Schritt läuft erneut.' : 'Für private Pakete (z. B. private Git-Repositorys) die Zugangsdaten als geheime Umgebungsvariable COMPOSER_AUTH (Inhalt einer auth.json) in der Sandbox-Umgebung hinterlegen und diesen Schritt erneut versuchen.';
  if (/could not resolve host|connection (timed out|refused)|network is unreachable|failed to download/i.test(output)) return 'composer hat das Internet nicht erreicht – Internet für die Sandbox erlauben und erneut versuchen.';
  if (/requires php\b|requires ext-|your php version|ext-[a-z0-9_]+\S* .*(missing|not present|is required)|platform requirements/i.test(output)) return 'Das Projekt verlangt eine andere PHP-Version oder -Erweiterung als das Image – ein passendes Dockware-Image wählen oder die Erweiterung im Dockerfile der Sandbox-Umgebung installieren.';
  if (/allowed memory size|out of memory|\bkilled\b/i.test(output)) return 'composer ist ohne Arbeitsspeicher geblieben – in der Sandbox-Umgebung mehr Arbeitsspeicher einstellen.';
  if (/no composer\.lock|lock file is not up to date/i.test(output)) return 'composer.lock fehlt oder passt nicht zu composer.json – im Repository aktualisieren.';
  return '';
}

/** "install-plugin" for a project: installed completely by default; overlay when chosen in .lotse/sandbox.json or when the environment
 *  forbids internet altogether (then the log says so) */
export async function installProject(ctx: StepCtx): Promise<void> {
  const { l } = project(ctx);
  if (l.project?.install !== 'full') return installOverlay(ctx);
  const blocked = ctx.internet.blocked();
  if (!blocked) return installProjectFull(ctx);
  ctx.log(`Projekt vollständig installieren braucht Internet für composer install, das ist hier nicht möglich: ${blocked} Stattdessen Modus „Overlay“ (das Shopware des Images bleibt).`);
  ctx.setLayout({ ...l, project: { ...l.project, install: 'overlay' } });
  return installOverlay(ctx);
}

/** The whole repository in /var/www/html, the project's own composer install (internet only after a human allowed it), its config
 *  checked and booted, the database migrated, then plugins, apps and theme as in overlay mode. */
async function installProjectFull(ctx: StepCtx): Promise<void> {
  const { l } = project(ctx);
  // the runtime is read again from the installed project (a retry must not plan with the one before): until then config files the
  // plan checks are held back – the project's bundles bring their own extensions
  let p: ProjectInfo = { ...l.project!, ...detectProject(ctx.projectRoot()), install: 'full', held: [], extraEnv: [], missingPackages: [], appEnv: undefined, extensions: undefined, envNames: undefined };
  save(ctx, l, p);
  await ctx.syncAll();
  p = project(ctx).p;

  ctx.log('Warte auf Internet für composer install: oben in der Sandbox auf „Internet: aus“ klicken und erlauben. Danach ist der Container wieder offline.');
  await ctx.internet.await();
  try {
    ctx.log('Internet erlaubt – composer install (Pakete aus composer.lock, ohne Skripte) …');
    const r = await ctx.run(COMPOSER_INSTALL, { timeoutMs: 20 * MIN, okCodes: ANY.okCodes });
    if (r.exitCode !== 0) {
      const hint = composerHint(r.output), tail = r.output.trim().split('\n').slice(-12).join('\n');
      throw new Error(`composer install fehlgeschlagen (Exit-Code ${r.exitCode}).${hint ? ` ${hint}` : ''}${tail ? `\n${tail}` : ''}`);
    }
  } finally {
    await ctx.internet.end().then(() => ctx.log('Internet wieder gesperrt.'), e => ctx.log(`Warnung: Internet ließ sich nicht wieder sperren: ${e instanceof Error ? e.message : String(e)}`));
  }

  await ctx.run(CLEAR_CACHE, { quiet: true });
  p = await readRuntime(ctx, p);
  save(ctx, l, p);
  let plan = await ctx.syncAll();
  p = project(ctx).p;
  ({ p, plan } = await bootCheck(ctx, l, p, plan));
  logPlan(ctx, plan, p.appEnv ?? 'dev');
  save(ctx, l, p);
  await ctx.run(MIGRATE, { timeoutMs: 10 * MIN });
  ctx.log('Datenbank auf den Stand des Projekts migriert.');
  await installExtensions(ctx, l, p, new Set(), plan);
  await ctx.run(bin('assets:install', '-n'), { okCodes: ANY.okCodes, timeoutMs: 5 * MIN, quiet: true });
}

/** Overlay: the image's Shopware stays, the project's parts are laid over it (steps 1–6 at the top) */
async function installOverlay(ctx: StepCtx): Promise<void> {
  const { l } = project(ctx);
  // detected again: a retry after the AI changed the repository installs what is there now; a new run starts the boot check over
  let p: ProjectInfo = { ...l.project!, ...detectProject(ctx.projectRoot()), install: 'overlay', held: [], extraEnv: [] };
  p = await readRuntime(ctx, p);
  save(ctx, l, p);

  const missing = await missingPackages(ctx, p);
  p = { ...p, missingPackages: missing };
  if (missing.length) ctx.log(`Warnung: Diese Pakete verlangt das Projekt, sie fehlen aber im Image und werden offline nicht installiert: ${missing.join(', ')}. Was sie braucht, läuft in der Sandbox nicht (Modus „Overlay“ – vollständig installiert holt composer install sie).`);
  // a static plugin whose own requirements are missing cannot be installed by composer offline
  const skip = new Set<string>();
  for (const x of p.plugins.filter(y => y.static)) {
    const own = new Set(p.plugins.map(y => y.composerName).filter((y): y is string => !!y));
    const need = requiredPackages(readComposerJson(`${ctx.projectRoot()}/${x.dir}/composer.json`), own).filter(n => missing.includes(n));
    if (need.length) { skip.add(x.name); ctx.log(`Warnung: ${x.name} braucht ${need.join(', ')} – wird in der Sandbox nicht installiert.`); }
  }
  save(ctx, l, p);

  let plan = await ctx.syncAll();
  p = project(ctx).p;
  await composerParts(ctx, p, skip);
  ({ p, plan } = await bootCheck(ctx, l, p, plan));
  logPlan(ctx, plan, p.appEnv ?? 'dev');
  save(ctx, l, p);
  await installExtensions(ctx, l, p, skip, plan);
}

/** Plugins (refresh, install/activate), apps, the theme, and config files held back only for extensions the plugins bring */
export async function installExtensions(ctx: StepCtx, l: TaskLayout, p: ProjectInfo, skip: Set<string>, plan: ConfigPlan | null): Promise<void> {
  // plugins: with a dump its plugin table decides (only plugins it does not know are installed); without one every project plugin
  const names = p.plugins.filter(x => !skip.has(x.name)).map(x => x.name);
  let dumped = ctx.hasDump() ? await dumpPlugins(ctx) : null;
  // A database that came another way (imported by hand, an earlier run) already has the project's plugins installed: its state counts
  // the same as a dump's – nothing is installed over it.
  if (!dumped) {
    const inDb = await dumpPlugins(ctx);
    if (names.some(n => inDb.has(n))) { dumped = inDb; ctx.log('Die Datenbank kennt die Projekt-Plugins schon (eingespielter Dump oder früherer Lauf) – wie bei einem Dump bleibt ihr Zustand.'); }
  }
  const refresh = await ctx.run(bin('plugin:refresh'));
  // installed completely, the plugins the project requires by composer (vendor/, e.g. frosh/tools) belong to it as well – like a
  // deployment installs them; one that cannot be installed is a warning, the project's own plugins decide whether the step fails
  const vendor = p.install === 'full' ? (await composerPlugins(ctx, p)).filter(n => !names.includes(n)) : [];
  const all = [...names, ...vendor];
  if (dumped) await updatePlugins(ctx, all.filter(n => dumped.has(n)));
  const install = dumped ? names.filter(n => !dumped.has(n)) : names, extra = dumped ? vendor.filter(n => !dumped.has(n)) : vendor;
  if (dumped) ctx.log(`Datenbank-Dump: ${all.length - install.length - extra.length} Projekt-Plugins sind darin bekannt und behalten ihren Zustand${install.length + extra.length ? `, neu installiert: ${[...install, ...extra].join(', ')}` : ''}.`);
  const refused = new Map<string, string>();
  for (const n of extra) {
    const one = await ctx.run(bin('plugin:install', '--activate', '-n', '--', n), { ...ANY, timeoutMs: 5 * MIN });
    if (one.exitCode !== 0) { refused.set(n, bootError(one.output) || `Exit-Code ${one.exitCode}`); ctx.log(`Warnung: Plugin ${n} (über composer eingebunden) ließ sich nicht installieren: ${refused.get(n)}`); }
  }
  if (install.length) {
    const all = await ctx.run(bin('plugin:install', '--activate', '-n', '--', ...install), { timeoutMs: 10 * MIN, ...(dumped ? ANY : {}) });
    // With a dump the database is the user's: a plugin it does not have installed that cannot be (a requirement, e.g. another plugin or a
    // version) stays as the dump has it – the others are installed one by one, and the setup goes on with a warning.
    if (dumped && all.exitCode !== 0) {
      for (const n of install) {
        const one = await ctx.run(bin('plugin:install', '--activate', '-n', '--', n), { ...ANY, timeoutMs: 5 * MIN });
        if (one.exitCode !== 0) refused.set(n, bootError(one.output) || `Exit-Code ${one.exitCode}`);
      }
      for (const [n, why] of refused) ctx.log(`Warnung: Plugin ${n} ließ sich nicht installieren und bleibt, wie es im Datenbank-Dump ist: ${why}`);
    }
  }
  const states = await pluginStates(ctx, [...install, ...extra]);
  for (const n of extra.filter(x => states.get(x) !== '11' && !refused.has(x))) { refused.set(n, 'nicht aktiv'); ctx.log(`Warnung: Plugin ${n} (über composer eingebunden) ist nach der Installation nicht aktiv.`); }
  const failed = install.filter(n => states.get(n) !== '11' && !refused.has(n));
  if (failed.length) {
    const why = refresh.output.split('\n').filter(x => /\[ERROR]|Errors?:|^\s{5,}\S/.test(x)).map(x => x.trim()).join(' ').slice(0, 600);
    throw new Error(`Nicht installiert und aktiviert: ${failed.join(', ')}.${why ? ` Shopware meldet: ${why}` : ''}`);
  }
  const installed = [...install, ...extra].filter(n => !refused.has(n));
  if (installed.length) ctx.log(`Plugins installiert und aktiv: ${installed.join(', ')}`);

  // apps: work offline as long as they have no backend of their own (registration)
  const known = dumped ? new Set(lines((await ctx.run([...MYSQL, 'SELECT name FROM app'], { quiet: true, okCodes: [0, 1] })).output)) : new Set<string>();
  for (const a of p.apps.filter(x => !known.has(x.name))) {
    const r = await ctx.run(bin('app:install', '--activate', '--force', '-n', '--', a.name), { okCodes: [0, 1], timeoutMs: 3 * MIN });
    ctx.log(r.exitCode === 0 ? `App ${a.name} installiert und aktiv.` : `Warnung: App ${a.name} ließ sich nicht installieren (Apps mit eigenem Server brauchen Internet).`);
  }

  // theme: without a dump the project's theme for every storefront; with one the dump's assignment stays (theme-compile compiles it)
  const theme = dumped ? null : pickTheme(ctx.projectRoot(), p.plugins.filter(x => names.includes(x.name)));
  if (theme) { await ctx.run(bin('theme:change', '--all', '--no-compile', '-n', '--', theme)); ctx.log(`Theme ${theme} der Storefront zugewiesen.`); }
  else if (dumped) ctx.log('Theme: bleibt, wie es im Datenbank-Dump zugewiesen ist.');
  p = { ...p, theme };
  save(ctx, l, p);

  // plugins may bring configuration extensions of their own: files held back only for an unknown extension are loaded now
  const dbg = await ctx.run(['bash', '-c', 'bin/console debug:config 2>&1'], { ...ANY, quiet: true });
  const ext = dbg.exitCode === 0 ? parseExtensions(dbg.output) : [];
  if (ext.some(e => !p.extensions?.includes(e)) && (p.quarantined ?? []).length) {
    p = { ...p, extensions: [...new Set([...(p.extensions ?? []), ...ext])].sort() };
    save(ctx, l, p);
    const before = new Set((p.quarantined ?? []).map(q => q.file));
    plan = await ctx.syncAll();
    p = project(ctx).p;
    const loaded = [...before].filter(f => !plan?.quarantine.has(f));
    if (loaded.length) {
      ctx.log(`Mit den Erweiterungen der Plugins jetzt geladen: ${loaded.join(', ')}`);
      ({ p, plan } = await bootCheck(ctx, l, p, plan));
      logPlan(ctx, plan, p.appEnv ?? 'dev');
      save(ctx, l, p);
    }
  }
}

/** The dump's plugin table before plugin:refresh: names known to it; warns about active plugins whose code is missing (a refresh
 *  deletes their rows) */
async function dumpPlugins(ctx: StepCtx): Promise<Set<string>> {
  const rows = lines((await ctx.run([...MYSQL, "SELECT name, active, path FROM plugin WHERE installed_at IS NOT NULL"], { quiet: true })).output).map(x => x.split('\t'));
  const paths = rows.filter(r => r[1] === '1' && /^[A-Za-z0-9_./-]{1,300}$/.test(r[2] ?? '') && !r[2].includes('..')).map(r => r[2]);
  if (paths.length) {
    const gone = lines((await ctx.run(['bash', '-c', 'for p; do [ -e "$p" ] || echo "$p"; done; exit 0', '_', ...paths], { quiet: true })).output);
    const names = rows.filter(r => gone.includes(r[2])).map(r => r[0]);
    if (names.length) ctx.log(`Warnung: Im Dump aktiv, aber ohne Code im Projekt oder Image: ${names.join(', ')} – plugin:refresh entfernt sie aus der Datenbank der Sandbox (Store- oder composer-Plugins).`);
  }
  return new Set(rows.map(r => r[0]).filter(n => PLUGIN_NAME.test(n)));
}
