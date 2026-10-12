/**
 * Small implementation of Shopify's search syntax (the `query:` argument):
 *   free text, field:value, field:"quoted value", prefix*, -negation, NOT,
 *   AND / OR, parentheses, comparators (field:>10, field:<=2026-01-01),
 *   comma lists (status:active,draft).
 * Unknown fields are ignored and reported as warnings, like Shopify's
 * `extensions.search[].warnings`.
 */

export type FieldKind = 'keyword' | 'text' | 'number' | 'date' | 'boolean';

export interface SearchField<T> {
  kind: FieldKind;
  get: (rec: T) => string | number | boolean | null | undefined | (string | number)[];
}

export interface SearchSpec<T> {
  fields: Record<string, SearchField<T>>;
  freeText: (rec: T) => string[];
}

export interface SearchWarning {
  field: string;
  message: string;
}

type Node =
  | { type: 'and'; children: Node[] }
  | { type: 'or'; children: Node[] }
  | { type: 'not'; child: Node }
  | { type: 'term'; field: string | null; op: '=' | '>' | '>=' | '<' | '<='; values: string[]; raw: string };

function tokenize(q: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      tokens.push(c);
      i++;
      continue;
    }
    let tok = '';
    while (i < q.length && !/\s/.test(q[i]) && q[i] !== ')' && !(q[i] === '(' && tok === '')) {
      if (q[i] === '"' || q[i] === "'") {
        const quote = q[i];
        const end = q.indexOf(quote, i + 1);
        const stop = end === -1 ? q.length : end;
        tok += q.slice(i, stop + 1);
        i = stop + 1;
        continue;
      }
      if (q[i] === '(') break;
      tok += q[i];
      i++;
    }
    if (tok) tokens.push(tok);
  }
  return tokens;
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v.replace(/\\:/g, ':');
}

function parseTerm(raw: string): Node {
  const m = /^([a-zA-Z_][a-zA-Z0-9_.]*):(.*)$/.exec(raw);
  if (!m) return { type: 'term', field: null, op: '=', values: [unquote(raw)], raw };
  let rest = m[2];
  let op: '=' | '>' | '>=' | '<' | '<=' = '=';
  const cm = /^(>=|<=|>|<)(.*)$/.exec(rest);
  if (cm) {
    op = cm[1] as typeof op;
    rest = cm[2];
  }
  const values = rest.startsWith('"') || rest.startsWith("'") ? [unquote(rest)] : rest.split(',').map(unquote);
  return { type: 'term', field: m[1].toLowerCase(), op, values, raw };
}

function parseQuery(q: string): Node | null {
  const tokens = tokenize(q);
  let pos = 0;
  const parseOr = (): Node | null => {
    const children: Node[] = [];
    const first = parseAnd();
    if (first) children.push(first);
    while (tokens[pos] === 'OR') {
      pos++;
      const n = parseAnd();
      if (n) children.push(n);
    }
    if (children.length === 0) return null;
    return children.length === 1 ? children[0] : { type: 'or', children };
  };
  const parseAnd = (): Node | null => {
    const children: Node[] = [];
    while (pos < tokens.length && tokens[pos] !== ')' && tokens[pos] !== 'OR') {
      if (tokens[pos] === 'AND') {
        pos++;
        continue;
      }
      const n = parseUnary();
      if (n) children.push(n);
    }
    if (children.length === 0) return null;
    return children.length === 1 ? children[0] : { type: 'and', children };
  };
  const parseUnary = (): Node | null => {
    const t = tokens[pos];
    if (t === 'NOT') {
      pos++;
      const child = parseUnary();
      return child ? { type: 'not', child } : null;
    }
    if (t === '(') {
      pos++;
      const inner = parseOr();
      if (tokens[pos] === ')') pos++;
      return inner;
    }
    pos++;
    if (t.startsWith('-') && t.length > 1) return { type: 'not', child: parseTerm(t.slice(1)) };
    return parseTerm(t);
  };
  return parseOr();
}

function cmp(a: number, b: number, op: string): boolean {
  switch (op) {
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    default:
      return a === b;
  }
}

function matchString(hay: string, needle: string, kind: FieldKind): boolean {
  const h = hay.toLowerCase();
  let n = needle.toLowerCase();
  if (n === '*') return h.length > 0;
  const prefix = n.endsWith('*');
  if (prefix) n = n.slice(0, -1);
  if (kind === 'keyword') return prefix ? h.startsWith(n) : h === n;
  // text: match words / phrases at word boundaries, prefix on the last word when wildcarded
  if (prefix) return h.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(n)) || h.startsWith(n);
  const words = h.split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
  const nw = n.split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
  return ` ${words} `.includes(` ${nw} `) || h === n;
}

export function compileSearch<T>(query: string | null | undefined, spec: SearchSpec<T>): { match: (rec: T) => boolean; warnings: SearchWarning[] } {
  const warnings: SearchWarning[] = [];
  if (!query || !query.trim()) return { match: () => true, warnings };
  const ast = parseQuery(query);
  if (!ast) return { match: () => true, warnings };

  const checkFields = (n: Node) => {
    if (n.type === 'term') {
      if (n.field && !spec.fields[n.field]) warnings.push({ field: n.field, message: 'Invalid search field for this query.' });
    } else if (n.type === 'not') checkFields(n.child);
    else n.children.forEach(checkFields);
  };
  checkFields(ast);

  const evalNode = (n: Node, rec: T): boolean => {
    if (n.type === 'and') return n.children.every((c) => evalNode(c, rec));
    if (n.type === 'or') return n.children.some((c) => evalNode(c, rec));
    if (n.type === 'not') return !evalNode(n.child, rec);
    if (n.field === null) {
      const needle = n.values[0];
      const hay = spec.freeText(rec);
      const nl = needle.toLowerCase().replace(/\*$/, '');
      return hay.some((h) => h.toLowerCase().includes(nl));
    }
    const f = spec.fields[n.field];
    if (!f) return true; // ignored, reported as warning
    const raw = f.get(rec);
    const vals = Array.isArray(raw) ? raw : [raw];
    return n.values.some((needle) =>
      vals.some((v) => {
        if (v === null || v === undefined) return false;
        if (f.kind === 'number') {
          const num = Number(needle);
          return !Number.isNaN(num) && cmp(Number(v), num, n.op);
        }
        if (f.kind === 'date') {
          if (n.op === '=') return String(v).startsWith(needle);
          const t = Date.parse(needle);
          return !Number.isNaN(t) && cmp(Date.parse(String(v)), t, n.op);
        }
        if (f.kind === 'boolean') return String(v).toLowerCase() === needle.toLowerCase();
        return matchString(String(v), needle, f.kind);
      }),
    );
  };
  return { match: (rec) => evalNode(ast, rec), warnings };
}
