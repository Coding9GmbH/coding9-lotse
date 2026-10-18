// Unified diff of two texts (Myers' O(ND) algorithm), in git's format so the "Änderungen" tab parses it like any other patch
// (src/lib/diff-parse.ts). Used for files that exist only as bytes (the task container's version against the worktree's): no git call.
// Bounded: more than MAX_LINES lines on a side or more than MAX_EDITS differing lines is reported as too large instead of computed.

export const LINE_DIFF_LIMITS = { lines: 20_000, edits: 2_000, context: 3 } as const;

type Op = { kind: ' ' | '-' | '+'; text: string };

/** The edit script old → new, or null when it would exceed the limits. */
function editScript(a: string[], b: string[]): Op[] | null {
  const n = a.length, m = b.length, max = Math.min(n + m, LINE_DIFF_LIMITS.edits);
  const off = max + 1, v = new Int32Array(2 * max + 3), trace: Int32Array[] = [];
  let found = -1;
  // per round only the diagonals -d-1 … d+1 are kept (memory grows with d², not with the file size)
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const t = trace[d], at = (k: number) => t[k + d + 1], k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(prevK), py = px - prevK;
    while (x > px && y > py) { ops.push({ kind: ' ', text: a[--x] }); y--; }
    if (x === px) ops.push({ kind: '+', text: b[--y] }); else ops.push({ kind: '-', text: a[--x] });
  }
  while (x > 0 && y > 0) { ops.push({ kind: ' ', text: a[--x] }); y--; }
  return ops.reverse();
}

const lines = (t: string | null) => (t === null || t === '' ? [] : t.replace(/\n$/, '').split('\n'));

/**
 * `diff --git a/<path> b/<path>` with hunks for old → new (null = the file does not exist on that side). Returns the patch and the
 * counts; `tooLarge` when the limits were hit (the patch then only has the header and a note line).
 */
export function unifiedDiff(file: string, before: string | null, after: string | null): { patch: string; added: number; removed: number; tooLarge?: boolean } {
  const a = lines(before), b = lines(after);
  const head = `diff --git a/${file} b/${file}\n${before === null ? 'new file mode 100644\n' : after === null ? 'deleted file mode 100644\n' : ''}--- ${before === null ? '/dev/null' : `a/${file}`}\n+++ ${after === null ? '/dev/null' : `b/${file}`}\n`;
  if (a.length > LINE_DIFF_LIMITS.lines || b.length > LINE_DIFF_LIMITS.lines) return { patch: head, added: 0, removed: 0, tooLarge: true };
  const ops = editScript(a, b);
  if (!ops) return { patch: head, added: 0, removed: 0, tooLarge: true };
  const added = ops.filter(o => o.kind === '+').length, removed = ops.filter(o => o.kind === '-').length;
  if (!added && !removed) return { patch: '', added, removed };
  const C = LINE_DIFF_LIMITS.context, out: string[] = [];
  // positions of changes; hunks = changes with C lines of context, merged when they touch
  let i = 0;
  const oldNo: number[] = [], newNo: number[] = [];
  let on = 1, nn = 1;
  for (const o of ops) { oldNo.push(on); newNo.push(nn); if (o.kind !== '+') on++; if (o.kind !== '-') nn++; }
  while (i < ops.length) {
    if (ops[i].kind === ' ') { i++; continue; }
    const start = Math.max(0, i - C);
    let end = i;
    for (let j = i; j < ops.length; j++) {
      if (ops[j].kind !== ' ') end = j;
      else if (j - end > 2 * C) break;
    }
    const stop = Math.min(ops.length, end + C + 1), hunk = ops.slice(start, stop);
    const oc = hunk.filter(o => o.kind !== '+').length, nc = hunk.filter(o => o.kind !== '-').length;
    const os = oc ? oldNo[start] : oldNo[start] - 1, ns = nc ? newNo[start] : newNo[start] - 1;
    out.push(`@@ -${os},${oc} +${ns},${nc} @@`, ...hunk.map(o => `${o.kind}${o.text}`));
    i = stop;
  }
  return { patch: `${head}${out.join('\n')}\n`, added, removed };
}
