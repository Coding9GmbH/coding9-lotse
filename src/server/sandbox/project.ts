import 'server-only';
// Full Shopware project repositories (A19), mode "Overlay": the image's Shopware stays as it is; Lotse syncs the project's plugins
// (custom/plugins, custom/static-plugins), apps (custom/apps), config/packages, config/services*.yaml and src/ over it and installs
// them. Never synced: composer.json/lock, config/bundles.php, .env*, vendor/, var/, public/ (the image's own install keeps working
// offline). Measured with dockware/shopware:6.7.15.1 and a project repository with 4 plugins, an app, a theme, src/ and production
// configs (Redis, OpenSearch, S3/CDN, AMQP, SMTP, gelf, Sentry): ready in about 45 s after the container answers.
// This module is pure (files of the worktree, parsed config in, decisions out); jobs.ts, sync.ts and the template run it.
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectInfo, ProjectPart, ProjectPlugin } from '@/lib/protocol';
import { PLUGIN_NAME } from '@/lib/sandbox-task';
import { isExcluded } from './sync';

const MAX_PLUGINS = 300, MAX_CONFIG = 500, JSON_MAX = 20 * 1024 * 1024;
/** composer's package name pattern (its JSON schema) */
export const COMPOSER_NAME = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/;
/** A folder below custom/plugins, custom/static-plugins or custom/apps */
const EXT_DIR = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
/** Requirements the image provides itself (Shopware, PHP, extensions, composer) */
const PLATFORM_REQ = /^(php|php-64bit|hhvm|ext-.+|lib-.+|composer(-plugin|-runtime)?-api|composer\/.+|shopware\/.+|symfony\/flex|symfony\/runtime)$/i;

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > JSON_MAX) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const isDir = (p: string) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };
const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

/** composer.json says "a Shopware project": requires shopware/core or shopware/platform and is no plugin; type "project" or the layout
 *  of shopware/production (bin/console, custom/, config/packages). */
export function isProjectComposer(c: Record<string, unknown> | null, worktree: string): boolean {
  if (!c || c.type === 'shopware-platform-plugin') return false;
  const sw = Object.keys(obj(c.require)).some(k => /^shopware\/(core|platform)$/i.test(k));
  if (!sw) return false;
  return c.type === 'project' || ['bin/console', 'custom', 'config/packages'].some(r => exists(path.join(worktree, r)));
}

/** Technical name of a plugin folder (composer.json extra.shopware-plugin-class), null = not a plugin */
function pluginOf(root: string, rel: string, isStatic: boolean): ProjectPlugin | null {
  const c = readJson(path.join(root, rel, 'composer.json'));
  if (!c || c.type !== 'shopware-platform-plugin') return null;
  const cls = obj(c.extra)['shopware-plugin-class'];
  const name = typeof cls === 'string' ? cls.trim().split('\\').pop() ?? '' : '';
  if (!PLUGIN_NAME.test(name)) return null;
  const label = obj(obj(c.extra).label), desc = typeof c.description === 'string' ? c.description : '';
  const lbl = [label['de-DE'], label['en-GB'], ...Object.values(label)].find(v => typeof v === 'string' && v.trim()) as string | undefined;
  const has = (r: string) => exists(path.join(root, rel, r));
  const parts: ProjectPart[] = [];
  if (has('src/Resources/views/storefront')) parts.push('storefront');
  if (has('src/Resources/app/storefront/src/scss')) parts.push('styles');
  if (has('src/Resources/app/storefront/src/main.js') || has('src/Resources/app/storefront/dist')) parts.push('js');
  if (has('src/Resources/app/administration')) parts.push('admin');
  if (['src/Subscriber', 'src/Command', 'src/Controller', 'src/Service', 'src/Core', 'src/Resources/config/services.xml', 'src/Resources/config/services.php'].some(has)) parts.push('php');
  if (has('src/Resources/config/config.xml')) parts.push('settings');
  if (has('src/Migration')) parts.push('migrations');
  if (has('src/Resources/snippet')) parts.push('snippets');
  return {
    name, dir: rel, ...(isStatic ? { static: true } : {}), ...(has('src/Resources/theme.json') ? { theme: true } : {}),
    ...(typeof c.name === 'string' && COMPOSER_NAME.test(c.name) ? { composerName: c.name } : {}),
    ...(lbl || desc ? { label: (lbl || desc).replace(/\s+/g, ' ').trim().slice(0, 120) } : {}), parts,
  };
}
const subdirs = (root: string, rel: string) => {
  try { return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).filter(d => d.isDirectory() && EXT_DIR.test(d.name)).map(d => d.name).sort(); } catch { return []; }
};

/** The project's plugins (custom/plugins + custom/static-plugins, by their composer.json), apps (custom/apps/<dir>/manifest.xml with
 *  its technical name), config files and src/, and the Shopware version of composer.lock. Read from the worktree only. */
export function detectProject(worktree: string): ProjectInfo {
  const plugins: ProjectPlugin[] = [];
  for (const [base, isStatic] of [['custom/plugins', false], ['custom/static-plugins', true]] as const)
    for (const d of subdirs(worktree, base)) { const p = pluginOf(worktree, `${base}/${d}`, isStatic); if (p && plugins.length < MAX_PLUGINS && !plugins.some(x => x.name === p.name)) plugins.push(p); }
  const apps: ProjectInfo['apps'] = [];
  for (const d of subdirs(worktree, 'custom/apps')) {
    let xml = '';
    try { const f = path.join(worktree, 'custom/apps', d, 'manifest.xml'); if (fs.lstatSync(f).isFile() && fs.statSync(f).size < 1024 * 1024) xml = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const name = /<meta>[\s\S]*?<name>\s*([A-Za-z][A-Za-z0-9_]{0,99})\s*<\/name>/.exec(xml)?.[1];
    if (name && apps.length < MAX_PLUGINS) apps.push({ name, dir: `custom/apps/${d}` });
  }
  const c = readJson(path.join(worktree, 'composer.json'));
  const psr4: Record<string, string> = {};
  for (const [ns, dir] of Object.entries(obj(obj(c?.autoload)['psr-4']))) if (typeof dir === 'string') psr4[ns] = dir;
  return { plugins, apps, configFiles: configFiles(worktree), src: isDir(path.join(worktree, 'src')), psr4, shopwareVersion: lockVersion(worktree) };
}

/** shopware/core (or shopware/platform) in composer.lock, "v6.7.15.1" → "6.7.15.1"; null without a lock or a usable version */
export function lockVersion(worktree: string): string | null {
  const lock = readJson(path.join(worktree, 'composer.lock'));
  const pkgs = Array.isArray(lock?.packages) ? lock.packages as unknown[] : [];
  for (const want of ['shopware/core', 'shopware/platform']) {
    const v = obj(pkgs.find(p => obj(p).name === want)).version;
    const m = typeof v === 'string' ? /^v?(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(v.trim()) : null;
    if (m) return m[1];
  }
  return null;
}
/** Shopware version of an image tag (dockware/shopware:6.7.15.1-amd64 → 6.7.15.1), null if the tag has none */
export const imageVersion = (image: string): string | null => /:(\d+(?:\.\d+){1,3})(?:-[a-z0-9]+)?$/.exec(image)?.[1] ?? null;
const minor = (v: string) => v.split('.').slice(0, 2).join('.');
/** The project's Shopware vs. the image: a different major.minor is a mismatch (plugins and configs of another minor version often do
 *  not load); `suggest` = the dockware/shopware image of exactly the project's version. null = same minor or unknown. */
export function versionMismatch(project: string | null, image: string): ProjectInfo['versionMismatch'] | null {
  const img = imageVersion(image);
  if (!project || !img || minor(project) === minor(img)) return null;
  return { project, image: img, suggest: `dockware/shopware:${project}` };
}

// ---- What is synced into the container (paths relative to the repository = relative to /var/www/html) ----
/** Never synced, even inside the synced folders: the sandbox override Lotse writes itself */
export const overrideFile = (appEnv: string) => `config/packages/${appEnv}/zz_lotse_sandbox.yaml`;
/** Where the setup keeps the list of what it synced (to remove what disappeared from the repository at the next full sync) */
export const SYNC_MANIFEST = 'var/lotse-project-sync.txt';
/**
 * Whether a repository path is synced into the container, and as what: 'unit' = inside a plugin or app folder (the folder is mirrored
 * as a whole, `unit` names it), 'file' = a single file of config/packages, config/services*.yaml or src/ (written over the image's).
 * null = not synced: composer.json/lock, bundles.php, routes, .env*, vendor/, var/, public/, everything else.
 */
export function projectSyncPath(rel: string): { kind: 'unit'; unit: string } | { kind: 'file' } | null {
  if (!rel || isExcluded(rel) || rel.split('/').some(s => s === '..' || s === '')) return null;
  const s = rel.split('/');
  if (s[0] === 'custom' && ['plugins', 'static-plugins', 'apps'].includes(s[1]) && s.length >= 3 && EXT_DIR.test(s[2])) return { kind: 'unit', unit: s.slice(0, 3).join('/') };
  if (s[0] === 'config' && s[1] === 'packages' && s.length >= 3) return /\.(ya?ml|php|xml)$/i.test(rel) && !/\/zz_lotse_sandbox\.yaml$/.test(rel) ? { kind: 'file' } : null;
  if (s[0] === 'config' && s.length === 2 && /^services(_[a-z0-9]+)?\.ya?ml$/i.test(s[1])) return { kind: 'file' };
  if (s[0] === 'src' && s.length >= 2) return { kind: 'file' };
  return null;
}
/** A config file Lotse checks before loading it (YAML below config/packages or config/services*.yaml) */
export const isProjectConfig = (rel: string) => projectSyncPath(rel)?.kind === 'file' && rel.startsWith('config/') && /\.ya?ml$/i.test(rel);

/** config/packages/** and config/services*.yaml of the worktree (YAML, PHP, XML), sorted */
export function configFiles(worktree: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(path.join(worktree, rel), { withFileTypes: true }); } catch { return; }
    for (const d of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = `${rel}/${d.name}`;
      if (d.isDirectory() && depth < 3) walk(r, depth + 1);
      else if (d.isFile() && projectSyncPath(r) && out.length < MAX_CONFIG) out.push(r);
    }
  };
  walk('config/packages', 0);
  try { for (const n of fs.readdirSync(path.join(worktree, 'config')).sort()) if (projectSyncPath(`config/${n}`) && fs.lstatSync(path.join(worktree, 'config', n)).isFile()) out.push(`config/${n}`); } catch { /* no config/ */ }
  return out;
}

// ---- Config analysis: quarantine and the sandbox override ----
/** What the container told the setup: APP_ENV, the extension aliases Symfony can load, the environment variables it defines (names only) */
export interface ProjectRuntime { appEnv: string; extensions: string[]; envNames: string[]; /** names the boot check found missing (e.g. used in a PHP config file) */ extraEnv?: string[] }
/** One parsed YAML file (by the container's own Symfony YAML parser, PROJECT_PARSE_PHP); error = not parseable */
export type ParsedConfig = Record<string, { data?: unknown; error?: string }>;

/** Root keys a config file needs extensions for, for the active environment: its own and those of its when@<env> block (other
 *  environments' blocks are never loaded). */
export function rootKeys(data: unknown, env: string): string[] {
  const keys = new Set<string>();
  for (const [k, v] of Object.entries(obj(data))) {
    if (k.startsWith('when@')) { if (k === `when@${env}`) for (const x of Object.keys(obj(v))) keys.add(x); continue; }
    keys.add(k);
  }
  return [...keys];
}
const ALWAYS = ['parameters', 'services', 'imports'];
/** Loaded in this environment: config/packages/*, config/packages/<env>/*, config/services.yaml and services_<env>.yaml */
export function loadedIn(rel: string, env: string): boolean {
  const s = rel.split('/');
  if (s[0] === 'config' && s[1] === 'packages') return s.length === 3 || (s.length === 4 && s[2] === env);
  if (s[0] === 'config' && s.length === 2) return /^services\.ya?ml$/i.test(s[1]) || new RegExp(`^services_${env}\\.ya?ml$`, 'i').test(s[1]);
  return false;
}

/** The analysis of the project's config for the sandbox */
export interface ConfigPlan {
  /** files not synced (not loaded) in the sandbox, with the reason in plain German */ quarantine: Map<string, string>;
  /** the override object (YAML is written by toYaml) */ override: Record<string, unknown>;
  /** what was switched, one line each (setup log, get_environment) */ notes: string[];
  /** %env(NAME)% the project uses and the container does not define: default '' */ envDefaults: string[];
  /** the YAML files that are loaded (parsed data and raw text), for the boot check */ files: { rel: string; data: unknown; raw: string }[];
}
const LOCAL_LOG = new Set(['stream', 'rotating_file', 'fingers_crossed', 'buffer', 'console', 'null', 'group', 'whatfailuregroup', 'fallbackgroup', 'filter', 'deduplication', 'service', 'error_log', 'syslog', 'test']);
const set = (o: Record<string, unknown>, keys: string[], v: unknown) => {
  let cur = o;
  for (const k of keys.slice(0, -1)) { if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k] as Record<string, unknown>; }
  cur[keys[keys.length - 1]] = v;
};
/** Symfony's array_replace_recursive: objects merged key by key, everything else replaced */
function merge(a: unknown, b: unknown): unknown {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Decides, from the parsed YAML files and the raw texts (both of the worktree), what the sandbox does with the project's config:
 * - quarantine: files that do not parse, need an extension the image lacks (sentry:, frosh_tools: – Symfony refuses to boot), plus
 *   `stuck` (files Shopware did not boot with, found by the setup's boot check)
 * - override: external services switched to local or off, only for what the project configures (measured: each of these breaks the
 *   storefront or the boot when left as it is: Redis cache/session/cart/number ranges, S3 filesystems, OpenSearch, gelf logging)
 * - env defaults: '' for each %env(NAME)% the container does not define (else the first bin/console fails)
 */
export function planConfig(parsed: ParsedConfig, raw: Record<string, string>, rt: ProjectRuntime, stuck: Record<string, string> = {}): ConfigPlan {
  const env = rt.appEnv, allowed = new Set([...rt.extensions, ...ALWAYS]);
  const quarantine = new Map<string, string>(), notes: string[] = [], o: Record<string, unknown> = {};
  const refs = new Set<string>(), files: ConfigPlan['files'] = [];
  let merged: Record<string, unknown> = {};
  // root files first, then the environment's folder (Symfony's order); config/services*.yaml define services, not extension config
  const order = Object.keys(parsed).filter(f => loadedIn(f, env)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const f of order) {
    if (stuck[f]) { quarantine.set(f, stuck[f]); continue; }
    const p = parsed[f];
    if (p.error !== undefined) { quarantine.set(f, `YAML-Fehler: ${p.error.slice(0, 200)}`); continue; }
    const unknown = rootKeys(p.data, env).filter(k => !allowed.has(k));
    if (unknown.length) { quarantine.set(f, `keine Erweiterung für „${unknown.slice(0, 3).join('“, „')}“ im Image`); continue; }
    files.push({ rel: f, data: p.data, raw: raw[f] ?? '' });
    for (const m of (raw[f] ?? '').matchAll(/%env\((?:[\w-]+:)*([A-Za-z_][A-Za-z0-9_]*)\)%/g)) refs.add(m[1]);
    if (!f.startsWith('config/packages/')) continue;
    for (const [k, v] of Object.entries(obj(p.data))) {
      if (k.startsWith('when@')) { if (k === `when@${env}`) for (const [k2, v2] of Object.entries(obj(v))) merged = merge(merged, { [k2]: v2 }) as Record<string, unknown>; continue; }
      merged = merge(merged, { [k]: v }) as Record<string, unknown>;
    }
  }
  const note = (s: string) => notes.push(s);

  // --- framework ---
  const fw = obj(merged.framework), cache = obj(fw.cache);
  if (typeof cache.app === 'string' && !['cache.adapter.filesystem', 'cache.adapter.array'].includes(cache.app)) { set(o, ['framework', 'cache', 'app'], 'cache.adapter.filesystem'); note(`framework.cache.app: ${cache.app} → cache.adapter.filesystem`); }
  for (const [pool, cfg] of Object.entries(obj(cache.pools))) {
    const c = obj(cfg), adapter = str(c.adapter) || str(Array.isArray(c.adapters) ? c.adapters[0] : '');
    if (/redis|memcache|pdo|doctrine|couchbase/i.test(adapter)) { set(o, ['framework', 'cache', 'pools', pool, 'adapter'], 'cache.app'); note(`framework.cache.pools.${pool}: ${adapter} → cache.app`); }
  }
  const session = obj(fw.session);
  if ('handler_id' in session && session.handler_id !== null) { set(o, ['framework', 'session', 'handler_id'], null); note('framework.session.handler_id → Dateien (PHP-Standard)'); }
  if (fw.lock !== undefined) { set(o, ['framework', 'lock'], 'flock'); note('framework.lock → flock'); }
  const mailer = obj(fw.mailer);
  if (mailer.dsn !== undefined || mailer.transports !== undefined) { set(o, ['framework', 'mailer', 'dsn'], 'smtp://127.0.0.1:1025'); note('framework.mailer → Mailcatcher der Sandbox (smtp://127.0.0.1:1025)'); }
  for (const [name, t] of Object.entries(obj(obj(fw.messenger).transports))) {
    const dsn = typeof t === 'string' ? t : str(obj(t).dsn);
    if (dsn.startsWith('shopware-webhook://') || dsn.startsWith('sync://')) continue;
    // Doctrine rejects options it does not know (the AMQP exchange/queues survive any later file), sync:// ignores them
    const target = name === 'failed' ? 'doctrine://default?queue_name=failed&auto_setup=false' : 'sync://';
    set(o, typeof t === 'string' ? ['framework', 'messenger', 'transports', name] : ['framework', 'messenger', 'transports', name, 'dsn'], target);
    note(`framework.messenger.transports.${name} → ${target}`);
  }

  // --- shopware ---
  const sw = obj(merged.shopware), dep = obj(sw.deployment);
  if (dep.cluster_setup === true) { set(o, ['shopware', 'deployment', 'cluster_setup'], false); note('shopware.deployment.cluster_setup → false'); }
  if (dep.runtime_extension_management === false) { set(o, ['shopware', 'deployment', 'runtime_extension_management'], true); note('shopware.deployment.runtime_extension_management → true'); }
  const delay = str(obj(obj(obj(sw.cache).invalidation).delay_options).storage);
  if (delay && delay !== 'mysql') { set(o, ['shopware', 'cache', 'invalidation', 'delay_options', 'storage'], 'mysql'); note(`shopware.cache.invalidation.delay_options.storage: ${delay} → mysql`); }
  const cart = str(obj(obj(sw.cart).storage).type);
  if (cart && cart !== 'mysql') { set(o, ['shopware', 'cart', 'storage', 'type'], 'mysql'); note(`shopware.cart.storage.type: ${cart} → mysql`); }
  const nr = str(obj(sw.number_range).increment_storage);
  if (nr && nr !== 'mysql') { set(o, ['shopware', 'number_range', 'increment_storage'], 'mysql'); note(`shopware.number_range.increment_storage: ${nr} → mysql`); }
  for (const [pool, cfg] of Object.entries(obj(sw.increment))) {
    const type = str(obj(cfg).type);
    if (type && type !== 'mysql' && type !== 'array') { set(o, ['shopware', 'increment', pool, 'type'], 'mysql'); note(`shopware.increment.${pool}.type: ${type} → mysql`); }
  }
  if (obj(obj(sw.http_cache).reverse_proxy).enabled === true) { set(o, ['shopware', 'http_cache', 'reverse_proxy', 'enabled'], false); note('shopware.http_cache.reverse_proxy.enabled → false'); }
  for (const [name, cfg] of Object.entries(obj(sw.filesystem))) {
    const type = str(obj(cfg).type);
    if (!type || type === 'local') continue;
    const root = name === 'private' ? '%kernel.project_dir%/files' : name === 'temp' ? '%kernel.project_dir%/var' : '%kernel.project_dir%/public';
    // a public filesystem needs a URL: '' breaks flysystem's URL generator, null breaks FallbackUrlPackage (6.7.15.1), APP_URL works
    set(o, ['shopware', 'filesystem', name], { type: 'local', ...(name === 'private' || name === 'temp' ? {} : { url: '%env(APP_URL)%' }), config: { root } });
    note(`shopware.filesystem.${name}: ${type} → local`);
  }
  if (str(obj(sw.cdn).url)) { set(o, ['shopware', 'cdn', 'url'], ''); note('shopware.cdn.url → leer'); }

  // --- search, theme config, logging ---
  // the image has no search server: whatever the project says about it, the sandbox searches with MySQL
  if (merged.elasticsearch !== undefined || refs.has('OPENSEARCH_URL') || refs.has('SHOPWARE_ES_HOSTS')) {
    o.elasticsearch = { enabled: false, indexing_enabled: false, throw_exception: false, administration: { enabled: false } };
    note('elasticsearch/OpenSearch → aus (MySQL-Suche)');
  }
  const theme = obj(obj(merged.storefront).theme);
  if (/StaticFile/.test(str(theme.config_loader_id)) || /StaticFile/.test(str(theme.available_theme_provider))) {
    set(o, ['storefront', 'theme', 'config_loader_id'], 'Shopware\\Storefront\\Theme\\ConfigLoader\\DatabaseConfigLoader');
    set(o, ['storefront', 'theme', 'available_theme_provider'], 'Shopware\\Storefront\\Theme\\ConfigLoader\\DatabaseAvailableThemeProvider');
    note('storefront.theme: Konfiguration aus Dateien → aus der Datenbank');
  }
  for (const [name, cfg] of Object.entries(obj(obj(merged.monolog).handlers))) {
    const type = str(obj(cfg).type);
    if (type && !LOCAL_LOG.has(type)) { set(o, ['monolog', 'handlers', name, 'type'], 'null'); note(`monolog.handlers.${name}: ${type} → aus`); }
  }

  // --- env defaults ---
  const known = new Set(rt.envNames);
  const envDefaults = [...new Set([...refs, ...(rt.extraEnv ?? [])])].filter(n => !known.has(n)).sort();
  for (const n of envDefaults) set(o, ['parameters', `env(${n})`], '');
  return { quarantine, override: o, notes, envDefaults, files };
}

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const yamlScalar = (v: unknown): string => {
  if (v === null || v === undefined) return '~';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};
/** Block YAML of nested objects with scalar leaves (every string single-quoted: 'null' stays a string, %…% is never an alias) */
export function toYaml(o: Record<string, unknown>, indent = 0): string {
  const pad = ' '.repeat(indent);
  return Object.entries(o).map(([k, v]) => {
    const key = PLAIN_KEY.test(k) ? k : yamlScalar(k);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = toYaml(v as Record<string, unknown>, indent + 4);
      return inner ? `${pad}${key}:\n${inner}` : `${pad}${key}: {}\n`;
    }
    if (Array.isArray(v)) return `${pad}${key}: [${v.map(yamlScalar).join(', ')}]\n`;
    return `${pad}${key}: ${yamlScalar(v)}\n`;
  }).join('');
}
/** The override file as written into the container */
export const overrideYaml = (plan: ConfigPlan, appEnv: string) => `# Written by Lotse for the sandbox only – never part of the repository. Loaded after config/packages/*.yaml and the other files
# in config/packages/${appEnv}/: external services (Redis, OpenSearch, message queues, S3/CDN, SMTP, remote logging) → local or off.
${Object.keys(plan.override).length ? toYaml(plan.override) : '{}\n'}`;

/** PHP run in the container (php -r, as www-data): parses the staged config files below /tmp/lotse-config with the image's own
 *  Symfony YAML parser (custom tags become strings, PHP constants are not resolved) and prints JSON { "<rel>": { data | error } }.
 *  Constant code; the file names come as arguments and are checked again. */
export const CONFIG_STAGE = '/tmp/lotse-config';
export const PROJECT_PARSE_PHP = `require '/var/www/html/vendor/autoload.php';
$out = [];
$plain = function ($v) use (&$plain) {
  if ($v instanceof Symfony\\Component\\Yaml\\Tag\\TaggedValue) return '!' . $v->getTag() . ' ' . (is_scalar($v->getValue()) ? (string) $v->getValue() : '');
  if (is_array($v)) { $r = []; foreach ($v as $k => $x) $r[$k] = $plain($x); return $r === [] ? new stdClass() : $r; }
  return is_object($v) ? null : $v;
};
foreach (array_slice($argv, 1) as $rel) {
  if (!preg_match('~^config/[A-Za-z0-9_./@-]+\\.ya?ml$~', $rel) || str_contains($rel, '..')) { $out[$rel] = ['error' => 'path']; continue; }
  try { $out[$rel] = ['data' => $plain(Symfony\\Component\\Yaml\\Yaml::parseFile('${CONFIG_STAGE}/' . $rel, Symfony\\Component\\Yaml\\Yaml::PARSE_CUSTOM_TAGS))]; }
  catch (Throwable $e) { $out[$rel] = ['error' => substr($e->getMessage(), 0, 300)]; }
}
echo json_encode($out === [] ? new stdClass() : $out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);`;

/** The JSON object in the output of PROJECT_PARSE_PHP (PHP warnings may precede it) */
export function parseConfigOutput(output: string): ParsedConfig {
  const i = output.indexOf('{');
  if (i < 0) throw new Error(`Die Konfiguration des Projekts ließ sich im Container nicht lesen: ${output.trim().slice(0, 300)}`);
  return obj(JSON.parse(output.slice(i))) as ParsedConfig;
}

// ---- Runtime facts of the container ----
/** Extension aliases from `bin/console debug:config` (its table goes to stderr: run with 2>&1): rows "Bundle  alias" */
export function parseExtensions(output: string): string[] {
  const out = new Set<string>();
  for (const line of output.split('\n')) {
    const m = /^\s+([A-Z][A-Za-z0-9_]*)\s{2,}([a-z][a-z0-9_]*)\s*$/.exec(line);
    if (m && m[2] !== 'alias') out.add(m[2]);
  }
  return [...out].sort();
}
/** "Environment  dev" of `bin/console about` */
export const parseAppEnv = (output: string) => /^\s*Environment\s+([a-z][a-z0-9_]*)\s*$/m.exec(output)?.[1] ?? 'dev';
/** Names of the variables the container defines (process environment and its .env files), never their values (ENV_NAMES_ARGV) */
export const parseEnvNames = (output: string) => [...new Set(output.split('\n').map(l => l.trim()).filter(l => /^[A-Za-z_][A-Za-z0-9_]*$/.test(l)))].sort();
/** Constant argv: the names of the container's environment and of the Symfony .env files Shopware loads – names only, values stay inside */
export const ENV_NAMES_ARGV = ['bash', '-c', 'env | cut -d= -f1; for f in .env .env.local .env.dev .env.dev.local; do [ -f "$f" ] && sed -n "s/^\\(export[[:space:]]\\+\\)\\?\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\2/p" "$f"; done; exit 0'];

// ---- Boot check: which config file kept Shopware from booting ----
/** What a failed `bin/console about` says, as a decision: quarantine a file (with the reason), define an env default, or nothing known */
export type BootFinding = { file: string; reason: string } | { env: string } | null;
const has = (o: unknown, keys: string[]): boolean => { let cur: unknown = o; for (const k of keys) { const c = obj(cur); if (!(k in c)) return false; cur = c[k]; } return true; };
/**
 * Finds the config file the boot error points at: "Unrecognized option X under Y" (the file whose Y has X, else the first with root Y),
 * "no extension able to load the configuration for X", a class that does not exist (the file that names it), or "Environment variable
 * not found: X" (an env default instead). Only files that are synced now count (`files`: parsed data and raw text).
 */
export function bootFinding(output: string, files: { rel: string; data: unknown; raw: string }[], env: string): BootFinding {
  const missingEnv = /Environment variable not found: "([A-Za-z_][A-Za-z0-9_]*)"/.exec(output);
  if (missingEnv) return { env: missingEnv[1] };
  const byPath = (keys: string[]) => files.find(f => has(f.data, keys) || has(obj(f.data)[`when@${env}`], keys));
  const unrec = /Unrecognized options? "([^"]+)" under "([^"]+)"/.exec(output);
  if (unrec) {
    const under = unrec[2].split('.').filter(Boolean), opt = unrec[1].split(',')[0].trim();
    const hit = byPath([...under, opt]) ?? byPath(under.slice(0, 1));
    if (hit) return { file: hit.rel, reason: `Shopware startet damit nicht: unbekannte Option „${opt}“ unter „${unrec[2]}“` };
  }
  const ext = /no extension able to load the configuration for "([^"]+)"/.exec(output);
  if (ext) { const hit = byPath([ext[1]]); if (hit) return { file: hit.rel, reason: `keine Erweiterung für „${ext[1]}“ im Image` }; }
  const cls = /(?:Attempted to load class "([^"]+)" from namespace "([^"]+)"|[Cc]lass "([^"]+)" (?:not found|does not exist)|Class ([A-Za-z_\\][A-Za-z0-9_\\]+) does not exist)/.exec(output);
  if (cls) {
    const fq = cls[1] ? `${cls[2]}\\${cls[1]}` : (cls[3] ?? cls[4]).replace(/^\\/, '');
    const short = fq.split('\\').pop() ?? fq;
    const hit = files.find(f => f.raw.includes(fq) || f.raw.includes(fq.replace(/\\/g, '\\\\'))) ?? files.find(f => new RegExp(`\\b${short}\\b`).test(f.raw));
    if (hit) return { file: hit.rel, reason: `Shopware startet damit nicht: Klasse ${fq.slice(0, 120)} fehlt im Image` };
  }
  return null;
}
/** The line of a failed boot that says why (for the step's error) */
export function bootError(output: string): string {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
  return (lines.find(l => /Unrecognized|no extension|Environment variable|Attempted to load|does not exist|not found|Exception|Error/i.test(l) && !/^(#\d|In \S+ line)/.test(l)) ?? lines[0] ?? '').slice(0, 400);
}

// ---- Packages the image lacks ----
/** Composer packages a project (or a plugin) requires that are neither the platform nor part of the project itself */
export function requiredPackages(c: Record<string, unknown> | null, own: Set<string>): string[] {
  return Object.keys(obj(c?.require)).filter(k => COMPOSER_NAME.test(k) && !PLATFORM_REQ.test(k) && !own.has(k)).sort();
}
export const readComposerJson = (file: string) => readJson(file);

/** psr-4 namespaces of the project that the image's composer.json lacks and that point into src/ (other folders are not synced) */
export function missingPsr4(project: Record<string, string>, image: Record<string, unknown> | null): { add: Record<string, string>; skipped: string[] } {
  const have = obj(obj(image?.autoload)['psr-4']), add: Record<string, string> = {}, skipped: string[] = [];
  for (const [ns, dir] of Object.entries(project)) {
    if (ns in have) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*(\\[A-Za-z_][A-Za-z0-9_]*)*\\$/.test(ns) && /^src(\/[A-Za-z0-9_.-]+)*\/?$/.test(dir) && !dir.includes('..')) add[ns] = dir;
    else skipped.push(ns);
  }
  return { add, skipped };
}

/** The project's theme to assign without a dump: a theme plugin that no other theme of the project builds upon (its theme.json
 *  "views" names the other one); several = the first by name. */
export function pickTheme(worktree: string, plugins: ProjectPlugin[]): string | null {
  const themes = plugins.filter(p => p.theme);
  if (themes.length <= 1) return themes[0]?.name ?? null;
  const parents = new Set<string>();
  for (const t of themes) {
    const views = readJson(path.join(worktree, t.dir, 'src/Resources/theme.json'))?.views;
    for (const v of Array.isArray(views) ? views : []) if (typeof v === 'string' && v.startsWith('@') && v.slice(1) !== t.name) parents.add(v.slice(1));
  }
  return themes.map(t => t.name).sort().find(n => !parents.has(n)) ?? themes[0].name;
}

/** Storefront sales channels (type id of Shopware's storefront), for theme:change */
export const STOREFRONT_TYPE = '8A243080F92E4C719546314B577CF82B';
/** The project in plain words for the setup log */
export function projectSummary(p: ProjectInfo): string {
  const pl = p.plugins.map(x => `${x.name}${x.theme ? ' (Theme)' : x.static ? ' (statisch)' : ''}`);
  return [`${p.plugins.length} Plugins${pl.length ? `: ${pl.join(', ')}` : ''}`, `${p.apps.length} Apps${p.apps.length ? `: ${p.apps.map(a => a.name).join(', ')}` : ''}`,
    `${p.configFiles.length} Konfigurationsdateien`, p.src ? 'Projekt-Code in src/' : 'kein src/', `Shopware ${p.shopwareVersion ?? 'unbekannt (kein composer.lock)'}`].join(' · ');
}

// ---- Publishing and committing in a project ----
/** Folders of a project Lotse publishes changes in (and the AI commits) */
const PROJECT_DIRS = new Set(['custom', 'config', 'src', 'tests', 'translations', 'templates', 'docs']);
/** Files in the project's root Lotse publishes */
const PROJECT_ROOT_FILES = /^(composer\.(json|lock)|symfony\.lock|package(-lock)?\.json|readme(\.[a-z]{1,8})?|changelog(\.[a-z]{1,8})?|\.gitignore|\.gitattributes|\.editorconfig|\.shopware-project\.ya?ml|phpstan[\w.-]*\.neon(\.dist)?|phpunit\.xml(\.dist)?|ecs\.php|rector\.php|\.php-cs-fixer(\.dist)?\.php)$/i;
/** Why a changed path of a project is not published, or null: dependencies and build output (vendor/, node_modules/, var/, public/)
 *  never, and only the parts of a project that belong to its code (custom/, config/, src/ …, composer files). Secrets, .env*, keys and
 *  workflows are refused by the general rules before. */
export function projectPathBlock(p: string): string | null {
  const segs = p.split('/');
  if (segs.some(s => s === 'vendor' || s === 'node_modules') || ['var', 'public'].includes(segs[0])) return `„${p.slice(0, 120)}“ ist eine Abhängigkeit oder Build-Ausgabe (vendor/, node_modules/, var/, public/) und wird nicht veröffentlicht.`;
  if (segs.length === 1 ? PROJECT_ROOT_FILES.test(segs[0]) : PROJECT_DIRS.has(segs[0])) return null;
  return `„${p.slice(0, 120)}“ liegt außerhalb der Bereiche, die Lotse in einem Shopware-Projekt veröffentlicht (custom/, config/, src/, tests/, composer.json/composer.lock …).`;
}
