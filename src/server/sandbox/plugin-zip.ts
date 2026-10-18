import 'server-only';
// "Plugin als ZIP herunterladen" (A15): the task's working copy as a ZIP the Shopware admin accepts (Erweiterungen → Meine
// Erweiterungen → Erweiterung hochladen). Top folder = the plugin's technical name (Shopware reads <Name>/composer.json from the
// first entry's folder). Left out: .git, node_modules, tests, CI and IDE folders, .env*, keys and other secret files, symlinks;
// vendor/ only when composer.json requires packages besides Shopware/PHP and the working copy has it. Text files with keys, tokens,
// stored secrets or URLs with credentials block the ZIP (publishing's scan, without an override: the ZIP goes into a shop). Built
// from disk as it is now, including what the AI has not committed yet; a file that changes between the check and the download breaks
// the download instead of going out unchecked. A full Shopware project: one of its plugins (custom/plugins or custom/static-plugins),
// chosen by its folder; the ZIP holds that folder only.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PluginZipCheck, PluginZipProblem, PluginZipWarning } from '@/lib/protocol';
import { PLUGIN_NAME } from '@/lib/sandbox-task';
import { scanSecrets } from '../settings';
import { zipStream, type ZipEntry } from '../zip-write';
import { detectProject } from './project';
import { secretIn } from './publish';
import { taskPaths, type CodeTask } from './tasks';
import { isBinary, isDenied } from './workspace-fs';

export const PLUGIN_ZIP_LIMITS = { files: 5000, bytes: 100 * 1024 * 1024 } as const;

/** Folders that never go into the plugin ZIP (any depth). */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'tests', 'Tests', '.github', '.gitlab', '.idea', '.vscode', '.devcontainer', '.ddev']);
/** Development files that do not belong into a shop (any depth). */
const SKIP_FILES = /^(\.env.*|\.ds_store|thumbs\.db|\.gitignore|\.gitattributes|\.gitmodules|\.gitlab-ci\.ya?ml|\.editorconfig|phpunit\.xml(\.dist)?|\.phpunit\.result\.cache|phpstan.*\.neon(\.dist)?|psalm\.xml(\.dist)?|\.php[-_]cs(-fixer)?(\.dist)?(\.php)?|ecs\.php|rector\.php|.+\.zip)$/i;
/** Requirements that the shop itself provides: everything else needs vendor/ in the ZIP. */
const PLATFORM_REQ = /^(php|php-64bit|ext-.+|lib-.+|composer(-plugin|-runtime)?-api|composer\/.+|shopware\/.+)$/i;

export const zipExcluded = (rel: string, vendor: boolean) => {
  const segs = rel.split('/');
  if (segs.some(s => SKIP_DIRS.has(s)) || isDenied(rel) || SKIP_FILES.test(segs[segs.length - 1])) return true;
  return !vendor && segs[0] === 'vendor';
};

interface Composer { name?: unknown; type?: unknown; version?: unknown; description?: unknown; require?: unknown; autoload?: { 'psr-4'?: unknown; 'psr-0'?: unknown }; extra?: { 'shopware-plugin-class'?: unknown; label?: unknown } }
/** composer's own patterns (its JSON schema): Shopware runs composer's validator on every plugin and skips one that fails. */
const COMPOSER_NAME = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/;
const COMPOSER_VERSION = /^[vV]?\d+(?:[.-]\d+){0,3}[._-]?(?:(?:[sS][tT][aA][bB][lL][eE]|beta|b|RC|rc|alpha|a|patch|pl|p)(?:(?:[.-]?\d+)+)?)?(?:[.-]?[dD][eE][vV]|\.x-dev)?(?:\+.*)?$|^dev-.*$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
interface Plan { check: PluginZipCheck; files: { rel: string; abs: string; mtime: Date; hash: string }[]; dirs: string[] }
const digest = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** composer.json of the working copy against what Shopware needs to install an uploaded plugin. Checked against Shopware 6.7.15.1:
 *  without name, description, autoload, extra.label or with a name/version composer rejects, the upload succeeds but "plugin:refresh"
 *  silently skips the plugin; a label that is a string instead of an object even breaks the refresh of the whole plugin list. */
function readComposer(root: string, problems: PluginZipProblem[], warnings: PluginZipWarning[]): { name: string | null; version: string | null; needsVendor: boolean } {
  const out = { name: null as string | null, version: null as string | null, needsVendor: false };
  const file = path.join(root, 'composer.json');
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(file); } catch { /* missing */ }
  if (!st?.isFile()) { problems.push('noComposer'); return out; }
  let c: Composer;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')) as Composer; if (!c || typeof c !== 'object') throw new Error('no object'); } catch { problems.push('badJson'); return out; }
  if (c.type !== 'shopware-platform-plugin') problems.push('type');
  if (typeof c.name !== 'string' || !COMPOSER_NAME.test(c.name)) problems.push('name');
  if (typeof c.description !== 'string' || !c.description.trim()) problems.push('description');
  if (typeof c.version === 'string' && COMPOSER_VERSION.test(c.version.trim())) out.version = c.version.trim().slice(0, 40); else problems.push('version');
  if (!isObject(c.autoload) || !(['psr-4', 'psr-0'] as const).some(k => isObject(c.autoload?.[k]) && Object.keys(c.autoload[k] as object).length)) problems.push('autoload');
  const cls = typeof c.extra?.['shopware-plugin-class'] === 'string' ? c.extra['shopware-plugin-class'].trim() : '';
  if (!cls) problems.push('pluginClass');
  else {
    const name = cls.split('\\').pop() ?? '';
    if (PLUGIN_NAME.test(name)) out.name = name; else problems.push('pluginName');
    // the class file where psr-4 autoloading points (Namespace\ → src/): Shopware cannot load the plugin without it
    const psr = c.autoload?.['psr-4'] && typeof c.autoload['psr-4'] === 'object' ? Object.entries(c.autoload['psr-4'] as Record<string, unknown>) : [];
    const hit = psr.find(([ns]) => ns && cls.startsWith(ns));
    const dir = hit && typeof hit[1] === 'string' ? hit[1] : null;
    const rel = dir !== null ? path.posix.join(dir, `${cls.slice(hit![0].length).split('\\').join('/')}.php`) : null;
    if (psr.length && (!rel || rel.startsWith('..') || !fs.existsSync(path.join(root, rel)))) warnings.push('classFile');
  }
  const label = c.extra?.label;
  if (!isObject(label) || !Object.values(label).some(v => typeof v === 'string' && v.trim()) || Object.values(label).some(v => typeof v !== 'string')) problems.push('label');
  const req = c.require && typeof c.require === 'object' ? Object.keys(c.require as Record<string, unknown>) : [];
  if (!req.some(k => /^shopware\/(core|platform)$/i.test(k))) warnings.push('requireCore');
  out.needsVendor = req.some(k => !PLATFORM_REQ.test(k));
  return out;
}

/** A project's plugins to choose from (folder relative to the repository, technical name); null for a plugin repository */
export function zipChoices(t: CodeTask): { dir: string; name: string }[] | null {
  if (t.layout?.kind !== 'project') return null;
  return detectProject(taskPaths(t.id).worktree).plugins.map(p => ({ dir: p.dir, name: p.name }));
}
/** The folder the ZIP is built from: the repository, or (a project) the chosen plugin's folder – the first one when none is chosen.
 *  Throws for a folder that is not one of the project's plugins. */
function zipRoot(t: CodeTask, plugin?: string | null): { root: string; choices: { dir: string; name: string }[] | null; plugin?: string } {
  const wt = taskPaths(t.id).worktree, choices = zipChoices(t);
  if (!choices) return { root: wt, choices: null };
  const pick = plugin ? choices.find(c => c.dir === plugin) : choices[0];
  if (plugin && !pick) throw Object.assign(new Error('Dieses Plugin gibt es im Projekt nicht.'), { status: 400 });
  return { root: pick ? path.join(wt, pick.dir) : path.join(wt, 'custom', 'plugins', '.none'), choices, ...(pick ? { plugin: pick.dir } : {}) };
}

/** What the ZIP would contain and why it cannot be built (if so). Never throws for the working copy's content. */
function plan(t: CodeTask, plugin?: string | null): Plan {
  const { root, choices, plugin: chosen } = zipRoot(t, plugin);
  const problems: PluginZipProblem[] = [], warnings: PluginZipWarning[] = [];
  const { name, version, needsVendor } = readComposer(root, problems, warnings);
  const vendor = needsVendor && fs.existsSync(path.join(root, 'vendor', 'autoload.php'));
  if (needsVendor && !vendor) warnings.push('vendorMissing');
  const files: Plan['files'] = [], dirs: string[] = [];
  let bytes = 0, tooLarge = false, secretFile: string | undefined;
  const known = scanSecrets();
  const walk = (dir: string) => {
    let names: string[];
    try { names = fs.readdirSync(path.join(root, dir)).sort(); } catch { return; }
    for (const n of names) {
      if (tooLarge) return;
      const rel = dir ? `${dir}/${n}` : n;
      if (zipExcluded(rel, vendor)) continue;
      const abs = path.join(root, rel);
      let st: fs.Stats;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue; // never followed (could point outside the working copy)
      if (st.isDirectory()) { dirs.push(rel); walk(rel); continue; }
      if (!st.isFile()) continue;
      bytes += st.size;
      if (files.length >= PLUGIN_ZIP_LIMITS.files || bytes > PLUGIN_ZIP_LIMITS.bytes) { tooLarge = true; return; }
      let buf: Buffer;
      try { buf = fs.readFileSync(abs); } catch { continue; } // vanished
      files.push({ rel, abs, mtime: st.mtime, hash: digest(buf) });
      // every hit counts, also stored secrets and URLs with credentials (no "publish anyway" here): the ZIP goes into a shop, often not by a developer
      if (!secretFile && !isBinary(buf) && secretIn(buf.toString('latin1'), known)) secretFile = rel;
    }
  };
  if (fs.existsSync(root)) walk('');
  if (tooLarge) problems.push('tooLarge');
  if (secretFile) problems.push('secret');
  if (!problems.length && !files.length) problems.push('empty');
  return {
    check: { ok: problems.length === 0, name, version, problems, warnings, files: files.length, bytes, vendor, ...(secretFile ? { secretFile: secretFile.slice(0, 300) } : {}),
      ...(choices ? { plugins: choices, ...(chosen ? { plugin: chosen } : {}) } : {}) },
    files, dirs: dirs.filter(d => files.some(f => f.rel.startsWith(`${d}/`))), // no folders left empty by the exclusions (keys/, config/ …)
  };
}

export const checkPluginZip = (t: CodeTask, plugin?: string | null): PluginZipCheck => plan(t, plugin).check;

/** The ZIP as a stream (top folder <Name>/ first, then folders and files in order), or the check that says why not. */
export function pluginZip(t: CodeTask, plugin?: string | null): { check: PluginZipCheck; stream: ReadableStream<Uint8Array> | null } {
  const p = plan(t, plugin);
  if (!p.check.ok || !p.check.name) return { check: p.check, stream: null };
  const top = p.check.name;
  // each file exactly as checked: changed since (the AI writes meanwhile) breaks the download instead of shipping unchecked content
  const entry = (f: Plan['files'][number]): ZipEntry => ({ name: `${top}/${f.rel}`, mtime: f.mtime, data: () => {
    const buf = fs.readFileSync(f.abs);
    if (digest(buf) !== f.hash) throw new Error(`${f.rel} wurde seit der Prüfung geändert – ZIP bitte neu herunterladen.`);
    return buf;
  } });
  const entries: ZipEntry[] = [{ name: `${top}/` }, ...p.dirs.map(d => ({ name: `${top}/${d}/` })), ...p.files.map(entry)];
  return { check: p.check, stream: zipStream(entries) };
}
