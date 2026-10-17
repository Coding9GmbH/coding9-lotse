import 'server-only';
// Claude Code's own file tools (Read, Edit, Write, Glob, Grep, TodoWrite) in a chat with an attached sandbox, confined to the task's
// worktree. Every call passes guardNative first (PreToolUse hook and canUseTool): each path argument must resolve (realpath)
// inside the worktree and must not be .git or a secret file; writes not into vendor/ or node_modules/. Grep never searches
// secret files. After an Edit/Write the file is mirrored into the container and shown as a file card (afterNativeWrite).
// Bash, Task/agents, NotebookEdit and (without web research) WebFetch/WebSearch are not offered at all.
import fs from 'node:fs';
import path from 'node:path';
import type { FileChangeKind } from '@/lib/protocol';
import { isSecretPath } from './sync';
import { globRe, isDenied, lineDelta, resolveInWorkspace } from './workspace-fs';

/** Built-in tools of a sandbox chat (Claude). */
export const NATIVE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite'] as const;
const WRITES = new Set(['Edit', 'Write', 'MultiEdit']);
const SECRET_SCAN_MAX = 20_000;

export type NativeVerdict = { ok: true; input: Record<string, unknown> } | { ok: false; message: string };

/** Absolute (inside the worktree) or relative path → path relative to the worktree; anything else throws. */
export function relOf(root: string, p: unknown): string {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) throw new Error('Pfad fehlt.');
  const v = p.trim();
  if (!path.isAbsolute(v)) return v;
  for (const base of new Set([path.resolve(root), fs.realpathSync(root)])) {
    const n = path.resolve(v);
    if (n === base) return '';
    if (n.startsWith(base + path.sep)) return n.slice(base.length + 1).split(path.sep).join('/');
  }
  throw new Error(`Pfad außerhalb des Repositorys: nur ${root} ist erlaubt.`);
}

/** Secret files (relative paths) below `dir`: bounded walk without .git, node_modules and symlinks. */
export function secretFiles(root: string, dir = ''): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (abs: string, rel: string) => {
    let list: fs.Dirent[];
    try { list = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      if (++seen > SECRET_SCAN_MAX) return;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.name === '.git' || d.name === 'node_modules' || d.isSymbolicLink()) continue;
      if (d.isDirectory()) walk(path.join(abs, d.name), r);
      else if (isSecretPath(r)) out.push(r);
    }
  };
  walk(path.join(fs.realpathSync(root), dir), dir);
  return out;
}

const GLOB_META = /[{}[\]*?!,\\]/;

/** Decides one native tool call. `input` may come back changed (Grep: secret files excluded). */
export function guardNative(root: string, tool: string, input: Record<string, unknown>): NativeVerdict {
  try {
    switch (tool) {
      case 'TodoWrite': return { ok: true, input };
      case 'Read': case 'Edit': case 'Write': case 'MultiEdit': {
        resolveInWorkspace(root, relOf(root, input.file_path), { forWrite: WRITES.has(tool) });
        return { ok: true, input };
      }
      case 'Glob': {
        if (input.path !== undefined) resolveInWorkspace(root, relOf(root, input.path));
        const pattern = String(input.pattern ?? '');
        if (!pattern || pattern.split(/[\\/]/).includes('..')) throw new Error('Ungültiges Muster (ohne „..“).');
        if (path.isAbsolute(pattern)) relOf(root, pattern.replace(/[*?[{].*$/, '') || '/');
        return { ok: true, input };
      }
      case 'Grep': {
        const dir = input.path === undefined ? '' : resolveInWorkspace(root, relOf(root, input.path)).rel;
        const glob = input.glob === undefined ? '' : String(input.glob);
        if (glob && (glob.split('/').includes('..') || path.isAbsolute(glob))) throw new Error('Ungültiges glob (relativ, ohne „..“).');
        const st = fs.statSync(path.join(fs.realpathSync(root), dir));
        if (!st.isDirectory()) return { ok: true, input }; // a single allowed file
        const secrets = secretFiles(root, dir);
        if (!secrets.length) return { ok: true, input };
        if (glob) {
          const re = globRe(glob.replace(/^!/, ''));
          if (!glob.startsWith('!') && secrets.some(s => re.test(s))) throw new Error('Die Suche würde geheime Dateien einschließen – glob enger fassen.');
          if (glob.startsWith('!')) throw new Error('Ausschließende globs sind hier nicht erlaubt.');
          return { ok: true, input };
        }
        const names = [...new Set(secrets.map(s => path.posix.basename(s)))];
        if (names.some(n => GLOB_META.test(n))) throw new Error('Im Repository liegen geheime Dateien mit Sonderzeichen im Namen – Suche mit glob eingrenzen.');
        return { ok: true, input: { ...input, glob: `!{${names.join(',')}}` } };
      }
      default: return { ok: false, message: `Werkzeug ${tool} ist hier nicht erlaubt.` };
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Nicht erlaubt.' };
  }
}

/** Before a native write: the current text (for the card's +/− counts), null if new or unreadable. */
export function textBefore(root: string, filePath: unknown): string | null {
  try {
    const r = resolveInWorkspace(root, relOf(root, filePath), { forWrite: true });
    return r.exists ? fs.readFileSync(r.real, 'utf8') : null;
  } catch { return null; }
}

/** After a native write: relative path, kind and changed lines (the caller syncs and shows the card). */
export function nativeChange(root: string, filePath: unknown, before: string | null): { path: string; kind: FileChangeKind; added: number; removed: number } | null {
  try {
    const rel = relOf(root, filePath);
    if (!rel || isDenied(rel)) return null;
    const r = resolveInWorkspace(root, rel);
    const after = r.exists ? fs.readFileSync(r.real, 'utf8') : null;
    if (before === null && after === null) return null;
    return { path: r.rel, kind: before === null ? 'create' : after === null ? 'delete' : 'edit', ...lineDelta(before, after) };
  } catch { return null; }
}
