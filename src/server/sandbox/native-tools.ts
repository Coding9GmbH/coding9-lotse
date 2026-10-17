import 'server-only';
// Claude Code's own file tools (Read, Edit, Write, Glob, Grep, TodoWrite) in a chat with an attached sandbox, confined to the task's
// worktree. Every call passes guardNative first (PreToolUse hook and canUseTool): each path argument must resolve (realpath)
// inside the worktree and must not be .git or a secret file; writes not into vendor/ or node_modules/; no `~` paths (Claude Code
// expands them to the home directory). Grep never searches secret files. After an Edit/Write the file is mirrored into the container and shown as a file card (afterNativeWrite).
// Bash, Task/agents, NotebookEdit and (without web research) WebFetch/WebSearch are not offered at all.
import fs from 'node:fs';
import path from 'node:path';
import type { FileChangeKind } from '@/lib/protocol';
import { isDenied, lineDelta, resolveInWorkspace } from './workspace-fs';

/** Built-in tools of a sandbox chat (Claude). */
export const NATIVE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite'] as const;
const WRITES = new Set(['Edit', 'Write', 'MultiEdit']);

/** The secret names of sync.ts (SECRET_NAMES) as one case-insensitive negated ripgrep glob. Claude Code splits Grep's `glob` at
 *  whitespace (and outside braces at commas) into several `--glob` arguments, and with ripgrep the last matching glob wins: appended
 *  last, this exclusion beats any glob of the AI. Static (no walk of the worktree), so it also covers huge repositories; .env.example
 *  and friends are excluded from Grep as well (Read still works). */
const SECRET_GLOBS = ['.env', '.env.*', 'auth.json', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.htpasswd',
  ...['rsa', 'dsa', 'ecdsa', 'ed25519'].flatMap(k => [`id_${k}`, `id_${k}.pub`]), ...['pem', 'key', 'p12', 'pfx', 'jks', 'keystore'].map(x => `*.${x}`)];
export const SECRET_EXCLUDE = `!{${SECRET_GLOBS.map(g => g.replace(/[a-z]/gi, c => `[${c.toLowerCase()}${c.toUpperCase()}]`)).join(',')}}`;

export type NativeVerdict = { ok: true; input: Record<string, unknown> } | { ok: false; message: string };

/** Absolute (inside the worktree) or relative path → path relative to the worktree; anything else throws. */
export function relOf(root: string, p: unknown): string {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) throw new Error('Pfad fehlt.');
  const v = p.trim();
  if (v.startsWith('~')) throw new Error('Pfade mit „~“ sind nicht erlaubt: Pfade relativ zum Repository oder absolut darin angeben.');
  if (!path.isAbsolute(v)) return v;
  for (const base of new Set([path.resolve(root), fs.realpathSync(root)])) {
    const n = path.resolve(v);
    if (n === base) return '';
    if (n.startsWith(base + path.sep)) return n.slice(base.length + 1).split(path.sep).join('/');
  }
  throw new Error(`Pfad außerhalb des Repositorys: nur ${root} ist erlaubt.`);
}

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
        if (!pattern || pattern.startsWith('~') || pattern.split(/[\\/]/).includes('..')) throw new Error('Ungültiges Muster (ohne „..“ und „~“).');
        if (path.isAbsolute(pattern)) relOf(root, pattern.replace(/[*?[{].*$/, '') || '/');
        return { ok: true, input };
      }
      case 'Grep': {
        const dir = input.path === undefined ? '' : resolveInWorkspace(root, relOf(root, input.path)).rel;
        const glob = input.glob === undefined ? '' : String(input.glob).trim();
        if (glob.split(/[\s,{}]+/).some(g => g.replace(/^!/, '').split('/').includes('..') || path.isAbsolute(g.replace(/^!/, '')))) throw new Error('Ungültiges glob (relativ, ohne „..“).');
        if (!fs.statSync(path.join(fs.realpathSync(root), dir)).isDirectory()) return { ok: true, input }; // a single allowed file
        return { ok: true, input: { ...input, glob: glob ? `${glob} ${SECRET_EXCLUDE}` : SECRET_EXCLUDE } };
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
