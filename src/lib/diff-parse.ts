// Unified diff (git diff against the base branch, redacted on the server) → files with hunks and line numbers for the
// "Änderungen" tab. Pure; git's meta lines (diff --git, index, ---/+++, mode lines) become file fields, never shown as text.

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'note';
export interface DiffLine { kind: DiffLineKind; text: string; old: number | null; new: number | null }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface DiffFile { path: string; oldPath: string | null; status: 'added' | 'deleted' | 'modified' | 'renamed'; added: number; removed: number; binary: boolean; hunks: DiffHunk[] }

const unquote = (p: string) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);
const strip = (p: string) => unquote(p.trim()).replace(/^[ab]\//, '');

export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null, h: DiffHunk | null = null, oldNo = 0, newNo = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git ("?a\/.+?"?) ("?b\/.+"?)$/.exec(line);
      f = { path: m ? strip(m[2]) : line.slice(11), oldPath: null, status: 'modified', added: 0, removed: 0, binary: false, hunks: [] };
      files.push(f); h = null;
      continue;
    }
    if (!f) continue;
    if (!h) {
      if (line.startsWith('new file mode')) f.status = 'added';
      else if (line.startsWith('deleted file mode')) f.status = 'deleted';
      else if (line.startsWith('rename from ')) { f.oldPath = line.slice(12); f.status = 'renamed'; }
      else if (line.startsWith('rename to ')) f.path = line.slice(10);
      else if (line.startsWith('Binary files ')) f.binary = true;
      else if (line.startsWith('+++ ') && line.slice(4) !== '/dev/null') f.path = strip(line.slice(4));
    }
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hm) { h = { header: line, lines: [] }; f.hunks.push(h); oldNo = Number(hm[1]); newNo = Number(hm[2]); continue; }
    if (!h) continue;
    if (line.startsWith('+')) { h.lines.push({ kind: 'add', text: line.slice(1), old: null, new: newNo++ }); f.added++; }
    else if (line.startsWith('-')) { h.lines.push({ kind: 'del', text: line.slice(1), old: oldNo++, new: null }); f.removed++; }
    else if (line.startsWith('\\')) h.lines.push({ kind: 'note', text: line.slice(1).trim(), old: null, new: null });
    else if (line.startsWith(' ')) h.lines.push({ kind: 'ctx', text: line.slice(1), old: oldNo++, new: newNo++ });
    // an empty line is the end of the patch (git prefixes every context line with a space)
  }
  return files;
}
