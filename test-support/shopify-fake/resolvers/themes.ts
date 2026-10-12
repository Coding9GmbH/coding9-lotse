/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import { type ConnArgs, type Ctx, idOf, paginate, safeIdOf, ue, type UE } from '../context';
import { gid, isoNow, type ThemeFileRec, type ThemeRec } from '../state';
import { newJob } from './products';

const VALID_DIRS = ['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates'];
const PROTECTED_FILES = new Set(['layout/theme.liquid', 'config/settings_schema.json', 'config/settings_data.json']);
const MAX_FILES_PER_REQUEST = 50;

function contentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'liquid':
      return 'application/x-liquid';
    case 'json':
      return 'application/json';
    case 'css':
      return 'text/css';
    case 'js':
      return 'application/javascript';
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'woff2':
      return 'font/woff2';
    default:
      return 'text/plain';
  }
}

function fileBytes(f: ThemeFileRec): Buffer {
  return f.text !== null ? Buffer.from(f.text, 'utf8') : Buffer.from(f.base64 ?? '', 'base64');
}

function fileView(f: ThemeFileRec) {
  const bytes = fileBytes(f);
  return {
    filename: f.filename,
    body: f.text !== null ? { __typename: 'OnlineStoreThemeFileBodyText', content: f.text } : { __typename: 'OnlineStoreThemeFileBodyBase64', contentBase64: f.base64 },
    checksumMd5: createHash('md5').update(bytes).digest('hex'),
    contentType: contentType(f.filename),
    size: String(bytes.length),
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

function globToRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^]*').replace(/\?/g, '.')}$`);
}

/** Strips the optional leading block comment Shopify allows in JSON templates. */
export function stripJsonComment(text: string): string {
  return text.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
}

/** Validates a theme file the way Shopify's theme pipeline does (subset). Returns an error message or null. */
export function validateThemeFile(filename: string, text: string | null, files: Map<string, ThemeFileRec>, batch: Map<string, string | null>): string | null {
  if (text === null) return null;
  const exists = (name: string) => batch.has(name) || files.has(name);
  if (filename.endsWith('.json')) {
    let json: any;
    try {
      json = JSON.parse(stripJsonComment(text));
    } catch (e) {
      return `Invalid JSON in ${filename}: ${(e as Error).message}`;
    }
    const isTemplate = filename.startsWith('templates/');
    const isGroup = filename.startsWith('sections/');
    if (isTemplate || isGroup) {
      if (!json || typeof json !== 'object' || Array.isArray(json)) return `${filename} must contain a JSON object`;
      if (!json.sections || typeof json.sections !== 'object') return `${filename}: Template must contain a 'sections' object`;
      if (!Array.isArray(json.order)) return `${filename}: Template must contain an 'order' array`;
      const keys = Object.keys(json.sections);
      if (keys.length > 25) return `${filename}: Templates can have a maximum of 25 sections`;
      for (const key of keys) {
        const sec = json.sections[key];
        if (!sec || typeof sec.type !== 'string') return `${filename}: Section '${key}' is missing a type`;
        if (sec.type.startsWith('_') || sec.type.startsWith('@app')) continue;
        if (!exists(`sections/${sec.type}.liquid`)) return `${filename}: Section type '${sec.type}' does not refer to an existing section file`;
        if (sec.block_order && !Array.isArray(sec.block_order)) return `${filename}: block_order of section '${key}' must be an array`;
        if (Array.isArray(sec.block_order)) {
          for (const b of sec.block_order) if (!sec.blocks || !sec.blocks[b]) return `${filename}: Section '${key}' block_order references unknown block '${b}'`;
        }
      }
      for (const key of json.order) {
        if (!keys.includes(key)) return `${filename}: Section id '${key}' in order does not exist in sections`;
      }
      if (new Set(json.order).size !== json.order.length) return `${filename}: Section ids in order must be unique`;
    }
    return null;
  }
  if (filename.endsWith('.liquid')) {
    const m = /{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/.exec(text);
    if (m) {
      try {
        const schema = JSON.parse(m[1]);
        if (filename.startsWith('sections/') && (typeof schema !== 'object' || Array.isArray(schema))) return `${filename}: Invalid schema: must be a JSON object`;
      } catch (e) {
        return `${filename}: Invalid JSON in tag 'schema' (${(e as Error).message})`;
      }
    }
    const opens = (text.match(/{%-?\s*(if|unless|for|case|capture|form|paginate|comment|raw|schema|style|javascript|stylesheet)\b/g) ?? []).length;
    const closes = (text.match(/{%-?\s*end(if|unless|for|case|capture|form|paginate|comment|raw|schema|style|javascript|stylesheet)\b/g) ?? []).length;
    if (opens !== closes) return `${filename}: Liquid syntax error: unbalanced block tags (${opens} opened, ${closes} closed)`;
    return null;
  }
  return null;
}

export const themeTypes = {
  OnlineStoreTheme: {
    id: (t: ThemeRec) => gid('OnlineStoreTheme', t.id),
    prefix: (t: ThemeRec) => `/t/${t.id % 1000}`,
    processing: () => false,
    processingFailed: () => false,
    files: (t: ThemeRec, a: { filenames?: string[] | null; first?: number; after?: string | null }, ctx: Ctx) => {
      const names = [...t.files.keys()].sort();
      let selected = names;
      const userErrors: { filename: string; code: string }[] = [];
      if (a.filenames?.length) {
        const set = new Set<string>();
        for (const pattern of a.filenames) {
          if (pattern.includes('*') || pattern.includes('?')) {
            const re = globToRegex(pattern);
            names.filter((n) => re.test(n)).forEach((n) => set.add(n));
          } else if (t.files.has(pattern)) set.add(pattern);
          else userErrors.push({ filename: pattern, code: 'NOT_FOUND' });
        }
        selected = names.filter((n) => set.has(n));
      }
      const conn = paginate(selected.map((n) => t.files.get(n)!), { first: a.first ?? 50, after: a.after } as ConnArgs, ctx, (f) => f.filename);
      return { pageInfo: conn.pageInfo, nodes: conn.nodes.map(fileView), edges: conn.edges.map((e) => ({ cursor: e.cursor, node: fileView(e.node) })), userErrors };
    },
  },
};

export const themeQueries = {
  themes: (_: unknown, a: ConnArgs & { roles?: string[] | null; names?: string[] | null }, ctx: Ctx) => {
    let list = [...ctx.state.themes.values()].sort((x, y) => x.id - y.id);
    if (a.roles?.length) list = list.filter((t) => a.roles!.includes(t.role));
    if (a.names?.length) list = list.filter((t) => a.names!.some((n) => globToRegex(n).test(t.name)));
    return paginate(list, a, ctx, (t) => t.id);
  },
  theme: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = idOf(a.id, 'OnlineStoreTheme');
    return id !== null ? (ctx.state.themes.get(id) ?? null) : null;
  },
};

function themeFor(themeId: string, ctx: Ctx): { theme: ThemeRec | null; error: UE | null } {
  const id = safeIdOf(themeId, 'OnlineStoreTheme');
  const theme = id !== null ? ctx.state.themes.get(id) : undefined;
  if (!theme) return { theme: null, error: ue(['themeId'], 'Theme does not exist', 'NOT_FOUND') };
  if (theme.role === 'LOCKED') return { theme: null, error: ue(['themeId'], 'Theme is locked', 'ACCESS_DENIED') };
  if (theme.role === 'MAIN' && ctx.options.themeWriteAccess === 'unpublished-only') {
    return { theme: null, error: ue(['themeId'], 'This app does not have the theme write exemption required to modify the live theme', 'ACCESS_DENIED') };
  }
  return { theme, error: null };
}

function validFilename(filename: string): boolean {
  if (filename.includes('..') || filename.startsWith('/')) return false;
  const [dir, ...rest] = filename.split('/');
  if (!VALID_DIRS.includes(dir) || rest.length === 0) return false;
  if (rest.length > 1 && !(dir === 'templates' && rest[0] === 'customers' && rest.length === 2)) return false;
  return /^[A-Za-z0-9._-]+$/.test(rest[rest.length - 1]) && /\.[A-Za-z0-9]+$/.test(filename);
}

export const themeMutations = {
  themeFilesUpsert: (_: unknown, a: { themeId: string; files: { filename: string; body: { type: string; value: string } }[] }, ctx: Ctx) => {
    const { theme, error } = themeFor(a.themeId, ctx);
    if (!theme) return { job: null, upsertedThemeFiles: null, userErrors: [{ ...error!, filename: null }] };
    if (a.files.length > MAX_FILES_PER_REQUEST) {
      return { job: null, upsertedThemeFiles: null, userErrors: [{ ...ue(['files'], `Cannot upsert more than ${MAX_FILES_PER_REQUEST} files at once`, 'LESS_THAN_OR_EQUAL_TO'), filename: null }] };
    }
    const errors: (UE & { filename: string | null })[] = [];
    const decoded = new Map<string, { text: string | null; base64: string | null }>();
    a.files.forEach((f, i) => {
      if (!validFilename(f.filename)) {
        errors.push({ ...ue(['files', i, 'filename'], `Invalid filename ${f.filename}`, 'INVALID'), filename: f.filename });
        return;
      }
      if (f.body.type === 'TEXT') decoded.set(f.filename, { text: f.body.value, base64: null });
      else if (f.body.type === 'BASE64') {
        if (!/^[A-Za-z0-9+/=\s]*$/.test(f.body.value)) {
          errors.push({ ...ue(['files', i, 'body', 'value'], 'Invalid base64 content', 'INVALID'), filename: f.filename });
          return;
        }
        const buf = Buffer.from(f.body.value, 'base64');
        const asText = buf.toString('utf8');
        const isText = /\.(liquid|json|css|js|svg|txt)$/i.test(f.filename) && !asText.includes('�');
        decoded.set(f.filename, isText ? { text: asText, base64: null } : { text: null, base64: buf.toString('base64') });
      } else {
        const stagedPrefix = `${ctx.state.baseUrl}/__fake/staged-uploads/`;
        const staged = f.body.value.startsWith(stagedPrefix) ? ctx.state.stagedUploads.get(f.body.value.slice(stagedPrefix.length).split(/[/?]/)[0]) : undefined;
        if (!staged?.body) {
          errors.push({ ...ue(['files', i, 'body', 'value'], 'The Shopify fake can only load URL bodies from its own staged uploads', 'ERROR'), filename: f.filename });
          return;
        }
        decoded.set(f.filename, /\.(liquid|json|css|js|svg)$/i.test(f.filename) ? { text: staged.body.toString('utf8'), base64: null } : { text: null, base64: staged.body.toString('base64') });
      }
    });
    const batchText = new Map([...decoded].map(([k, v]) => [k, v.text]));
    const upserted: { filename: string }[] = [];
    const now = isoNow();
    for (const [filename, body] of decoded) {
      const msg = validateThemeFile(filename, body.text, theme.files, batchText);
      if (msg) {
        const i = a.files.findIndex((f) => f.filename === filename);
        errors.push({ ...ue(['files', i, 'body'], msg, 'FILE_VALIDATION_ERROR'), filename });
        continue;
      }
      const existing = theme.files.get(filename);
      theme.files.set(filename, { filename, text: body.text, base64: body.base64, createdAt: existing?.createdAt ?? now, updatedAt: now });
      upserted.push({ filename });
    }
    if (upserted.length) theme.updatedAt = now;
    return { job: upserted.length ? newJob(ctx) : null, upsertedThemeFiles: upserted, userErrors: errors };
  },

  themeFilesDelete: (_: unknown, a: { themeId: string; files: string[] }, ctx: Ctx) => {
    const { theme, error } = themeFor(a.themeId, ctx);
    if (!theme) return { deletedThemeFiles: null, userErrors: [{ ...error!, filename: null }] };
    const errors: (UE & { filename: string | null })[] = [];
    const deleted: { filename: string }[] = [];
    a.files.forEach((filename, i) => {
      if (PROTECTED_FILES.has(filename)) {
        errors.push({ ...ue(['files', i], `${filename} is required and cannot be deleted`, 'INVALID'), filename });
        return;
      }
      if (!theme.files.has(filename)) {
        errors.push({ ...ue(['files', i], `File ${filename} does not exist`, 'NOT_FOUND'), filename });
        return;
      }
      theme.files.delete(filename);
      deleted.push({ filename });
    });
    if (deleted.length) theme.updatedAt = isoNow();
    return { deletedThemeFiles: deleted, userErrors: errors };
  },
};
