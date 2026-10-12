/**
 * Minimal, dependency-free GraphQL engine for the Shopify fake.
 *
 * Covers what an Admin API client actually sends: queries/mutations with
 * variables, aliases, fragments, inline fragments, @include/@skip, interfaces
 * and unions. Validation and error messages follow graphql-ruby (which Shopify
 * runs), so clients see the same shapes they would see in production.
 *
 * Not covered: subscriptions, introspection (__schema/__type), custom
 * directives on executable documents, overlapping-field-merge validation.
 */

/* ------------------------------------------------------------------ errors */

export interface SourceLocation {
  line: number;
  column: number;
}

export class GraphQLError extends Error {
  locations?: SourceLocation[];
  path?: (string | number)[];
  extensions?: Record<string, unknown>;

  constructor(
    message: string,
    opts: { locations?: SourceLocation[]; path?: (string | number)[]; extensions?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.locations = opts.locations;
    this.path = opts.path;
    this.extensions = opts.extensions;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { message: this.message };
    if (this.locations?.length) out.locations = this.locations;
    if (this.path) out.path = this.path;
    if (this.extensions) out.extensions = this.extensions;
    return out;
  }
}

/* ------------------------------------------------------------------- lexer */

type TokKind = 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';

interface Token {
  kind: TokKind;
  value: string;
  line: number;
  column: number;
}

const PUNCT_NAMES: Record<string, string> = {
  '{': 'LCURLY',
  '}': 'RCURLY',
  '(': 'LPAREN',
  ')': 'RPAREN',
  '[': 'LBRACKET',
  ']': 'RBRACKET',
  ':': 'COLON',
  '=': 'EQUALS',
  '!': 'BANG',
  $: 'VAR_SIGN',
  '@': 'DIR_SIGN',
  '|': 'PIPE',
  '&': 'AMP',
  '...': 'ELLIPSIS',
};

function tokenLabel(t: Token): string {
  if (t.kind === 'eof') return 'end of file';
  if (t.kind === 'punct') return `"${t.value}" (${PUNCT_NAMES[t.value] ?? 'PUNCT'})`;
  if (t.kind === 'name') return `"${t.value}" (IDENTIFIER)`;
  if (t.kind === 'string') return `${JSON.stringify(t.value)} (STRING)`;
  return `"${t.value}" (${t.kind.toUpperCase()})`;
}

function parseError(message: string, line: number, column: number): GraphQLError {
  return new GraphQLError(message, { locations: [{ line, column }] });
}

function dedentBlockString(raw: string): string {
  const lines = raw.split(/\r\n|[\n\r]/g);
  let common: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    if (indent < line.length && (common === null || indent < common)) common = indent;
  }
  if (common) for (let i = 1; i < lines.length; i++) lines[i] = lines[i].slice(common);
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const len = source.length;
  const col = () => i - lineStart + 1;

  while (i < len) {
    const ch = source[i];
    if (ch === '﻿' || ch === ' ' || ch === '\t' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (ch === '#') {
      while (i < len && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    const startCol = col();
    if (ch === '.') {
      if (source.startsWith('...', i)) {
        tokens.push({ kind: 'punct', value: '...', line, column: startCol });
        i += 3;
        continue;
      }
      throw parseError(`Parse error on "." at [${line}, ${startCol}]`, line, startCol);
    }
    if ('{}()[]:=!$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch, line, column: startCol });
      i++;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[_0-9A-Za-z]/.test(source[j])) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j), line, column: startCol });
      i = j;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (!m) throw parseError(`Parse error on "${ch}" at [${line}, ${startCol}]`, line, startCol);
      const isFloat = Boolean(m[2] || m[3]);
      tokens.push({ kind: isFloat ? 'float' : 'int', value: m[0], line, column: startCol });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        let j = i + 3;
        let raw = '';
        while (j < len && !source.startsWith('"""', j)) {
          if (source.startsWith('\\"""', j)) {
            raw += '"""';
            j += 4;
            continue;
          }
          if (source[j] === '\n') {
            line++;
            lineStart = j + 1;
          }
          raw += source[j];
          j++;
        }
        if (j >= len) throw parseError(`Unterminated string at [${line}, ${startCol}]`, line, startCol);
        tokens.push({ kind: 'string', value: dedentBlockString(raw), line, column: startCol });
        i = j + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < len && source[j] !== '"') {
        const c = source[j];
        if (c === '\n' || c === '\r') throw parseError(`Unterminated string at [${line}, ${startCol}]`, line, startCol);
        if (c === '\\') {
          const e = source[j + 1];
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (e === 'u') {
            const hex = source.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw parseError(`Bad unicode escape at [${line}, ${startCol}]`, line, startCol);
            value += String.fromCharCode(parseInt(hex, 16));
            j += 6;
            continue;
          }
          if (!(e in map)) throw parseError(`Bad escape at [${line}, ${startCol}]`, line, startCol);
          value += map[e];
          j += 2;
          continue;
        }
        value += c;
        j++;
      }
      if (j >= len) throw parseError(`Unterminated string at [${line}, ${startCol}]`, line, startCol);
      tokens.push({ kind: 'string', value, line, column: startCol });
      i = j + 1;
      continue;
    }
    throw parseError(`Parse error on "${ch}" at [${line}, ${startCol}]`, line, startCol);
  }
  tokens.push({ kind: 'eof', value: '', line, column: col() });
  return tokens;
}

/* --------------------------------------------------------------------- AST */

export type TypeNode =
  | { kind: 'Named'; name: string }
  | { kind: 'List'; ofType: TypeNode }
  | { kind: 'NonNull'; ofType: TypeNode };

export type ValueNode =
  | { kind: 'Variable'; name: string; loc: SourceLocation }
  | { kind: 'Int'; value: string; loc: SourceLocation }
  | { kind: 'Float'; value: string; loc: SourceLocation }
  | { kind: 'String'; value: string; loc: SourceLocation }
  | { kind: 'Boolean'; value: boolean; loc: SourceLocation }
  | { kind: 'Null'; loc: SourceLocation }
  | { kind: 'Enum'; value: string; loc: SourceLocation }
  | { kind: 'List'; values: ValueNode[]; loc: SourceLocation }
  | { kind: 'Object'; fields: { name: string; value: ValueNode }[]; loc: SourceLocation };

export interface ArgumentNode {
  name: string;
  value: ValueNode;
  loc: SourceLocation;
}

export interface DirectiveNode {
  name: string;
  arguments: ArgumentNode[];
  loc: SourceLocation;
}

export interface FieldNode {
  kind: 'Field';
  alias?: string;
  name: string;
  arguments: ArgumentNode[];
  directives: DirectiveNode[];
  selectionSet?: SelectionSetNode;
  loc: SourceLocation;
}

export interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
  directives: DirectiveNode[];
  loc: SourceLocation;
}

export interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition?: string;
  directives: DirectiveNode[];
  selectionSet: SelectionSetNode;
  loc: SourceLocation;
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface SelectionSetNode {
  selections: SelectionNode[];
  loc: SourceLocation;
}

export interface VariableDefinitionNode {
  name: string;
  type: TypeNode;
  defaultValue?: ValueNode;
  loc: SourceLocation;
}

export interface OperationDefinitionNode {
  kind: 'Operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: VariableDefinitionNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionSetNode;
  loc: SourceLocation;
}

export interface FragmentDefinitionNode {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selectionSet: SelectionSetNode;
  loc: SourceLocation;
}

export interface DocumentNode {
  operations: OperationDefinitionNode[];
  fragments: Map<string, FragmentDefinitionNode>;
}

/* ------------------------------------------------------------------ parser */

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  next(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  loc(t: Token = this.peek()): SourceLocation {
    return { line: t.line, column: t.column };
  }

  fail(t: Token = this.peek()): never {
    if (t.kind === 'eof') throw parseError('Unexpected end of document', t.line, t.column);
    throw parseError(`Parse error on ${tokenLabel(t)} at [${t.line}, ${t.column}]`, t.line, t.column);
  }

  isPunct(v: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === v;
  }

  isName(v?: string): boolean {
    const t = this.peek();
    return t.kind === 'name' && (v === undefined || t.value === v);
  }

  expectPunct(v: string): Token {
    if (!this.isPunct(v)) this.fail();
    return this.next();
  }

  expectName(v?: string): string {
    if (!this.isName(v)) this.fail();
    return this.next().value;
  }

  atEof(): boolean {
    return this.peek().kind === 'eof';
  }

  /* -------- executable documents */

  parseDocument(): DocumentNode {
    const operations: OperationDefinitionNode[] = [];
    const fragments = new Map<string, FragmentDefinitionNode>();
    if (this.atEof()) throw parseError('Unexpected end of document', 1, 1);
    while (!this.atEof()) {
      if (this.isPunct('{')) {
        const loc = this.loc();
        operations.push({ kind: 'Operation', operation: 'query', variableDefinitions: [], directives: [], selectionSet: this.parseSelectionSet(), loc });
        continue;
      }
      if (this.isName('query') || this.isName('mutation') || this.isName('subscription')) {
        operations.push(this.parseOperation());
        continue;
      }
      if (this.isName('fragment')) {
        const loc = this.loc();
        this.next();
        const name = this.expectName();
        if (name === 'on') this.fail();
        this.expectName('on');
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        fragments.set(name, { kind: 'Fragment', name, typeCondition, directives, selectionSet, loc });
        continue;
      }
      this.fail();
    }
    return { operations, fragments };
  }

  parseOperation(): OperationDefinitionNode {
    const loc = this.loc();
    const operation = this.next().value as OperationDefinitionNode['operation'];
    let name: string | undefined;
    if (this.isName()) name = this.next().value;
    const variableDefinitions: VariableDefinitionNode[] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const vloc = this.loc();
        this.expectPunct('$');
        const vname = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.isPunct('=')) {
          this.next();
          defaultValue = this.parseValue(true);
        }
        this.parseDirectives();
        variableDefinitions.push({ name: vname, type, defaultValue, loc: vloc });
      }
      this.next();
    }
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'Operation', operation, name, variableDefinitions, directives, selectionSet, loc };
  }

  parseSelectionSet(): SelectionSetNode {
    const loc = this.loc();
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.atEof()) this.fail();
      selections.push(this.parseSelection());
    }
    if (selections.length === 0) this.fail();
    this.next();
    return { selections, loc };
  }

  parseSelection(): SelectionNode {
    const loc = this.loc();
    if (this.isPunct('...')) {
      this.next();
      if (this.isName('on')) {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'InlineFragment', typeCondition, directives, selectionSet: this.parseSelectionSet(), loc };
      }
      if (this.isName()) {
        const name = this.next().value;
        return { kind: 'FragmentSpread', name, directives: this.parseDirectives(), loc };
      }
      const directives = this.parseDirectives();
      return { kind: 'InlineFragment', directives, selectionSet: this.parseSelectionSet(), loc };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments(false);
    const directives = this.parseDirectives();
    const selectionSet = this.isPunct('{') ? this.parseSelectionSet() : undefined;
    return { kind: 'Field', alias, name, arguments: args, directives, selectionSet, loc };
  }

  parseArguments(isConst: boolean): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (!this.isPunct('(')) return args;
    this.next();
    while (!this.isPunct(')')) {
      const loc = this.loc();
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(isConst), loc });
    }
    if (args.length === 0) this.fail();
    this.next();
    return args;
  }

  parseDirectives(): DirectiveNode[] {
    const dirs: DirectiveNode[] = [];
    while (this.isPunct('@')) {
      const loc = this.loc();
      this.next();
      const name = this.expectName();
      dirs.push({ name, arguments: this.parseArguments(false), loc });
    }
    return dirs;
  }

  parseType(): TypeNode {
    let type: TypeNode;
    if (this.isPunct('[')) {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'List', ofType: inner };
    } else {
      type = { kind: 'Named', name: this.expectName() };
    }
    if (this.isPunct('!')) {
      this.next();
      type = { kind: 'NonNull', ofType: type };
    }
    return type;
  }

  parseValue(isConst: boolean): ValueNode {
    const t = this.peek();
    const loc = this.loc(t);
    if (t.kind === 'punct') {
      if (t.value === '$' && !isConst) {
        this.next();
        return { kind: 'Variable', name: this.expectName(), loc };
      }
      if (t.value === '[') {
        this.next();
        const values: ValueNode[] = [];
        while (!this.isPunct(']')) {
          if (this.atEof()) this.fail();
          values.push(this.parseValue(isConst));
        }
        this.next();
        return { kind: 'List', values, loc };
      }
      if (t.value === '{') {
        this.next();
        const fields: { name: string; value: ValueNode }[] = [];
        while (!this.isPunct('}')) {
          const name = this.expectName();
          this.expectPunct(':');
          fields.push({ name, value: this.parseValue(isConst) });
        }
        this.next();
        return { kind: 'Object', fields, loc };
      }
      this.fail();
    }
    this.next();
    if (t.kind === 'int') return { kind: 'Int', value: t.value, loc };
    if (t.kind === 'float') return { kind: 'Float', value: t.value, loc };
    if (t.kind === 'string') return { kind: 'String', value: t.value, loc };
    if (t.kind === 'name') {
      if (t.value === 'true' || t.value === 'false') return { kind: 'Boolean', value: t.value === 'true', loc };
      if (t.value === 'null') return { kind: 'Null', loc };
      return { kind: 'Enum', value: t.value, loc };
    }
    return this.fail(t);
  }

  /* -------- SDL */

  skipDescription(): void {
    if (this.peek().kind === 'string') this.next();
  }

  parseSDL(): SchemaDefinitions {
    const defs: TypeDefinition[] = [];
    while (!this.atEof()) {
      this.skipDescription();
      const kw = this.expectName();
      const name = this.expectName();
      if (kw === 'scalar') {
        this.parseDirectives();
        defs.push({ kind: 'SCALAR', name });
      } else if (kw === 'type' || kw === 'interface') {
        const interfaces: string[] = [];
        if (this.isName('implements')) {
          this.next();
          if (this.isPunct('&')) this.next();
          interfaces.push(this.expectName());
          while (this.isPunct('&')) {
            this.next();
            interfaces.push(this.expectName());
          }
        }
        this.parseDirectives();
        const fields = new Map<string, FieldDefinition>();
        this.expectPunct('{');
        while (!this.isPunct('}')) {
          this.skipDescription();
          const fname = this.expectName();
          const args = new Map<string, InputValueDefinition>();
          if (this.isPunct('(')) {
            this.next();
            while (!this.isPunct(')')) {
              const iv = this.parseInputValueDef();
              args.set(iv.name, iv);
            }
            this.next();
          }
          this.expectPunct(':');
          const type = this.parseType();
          const directives = this.parseDirectives();
          fields.set(fname, { name: fname, type, args, directives });
        }
        this.next();
        defs.push(kw === 'type' ? { kind: 'OBJECT', name, fields, interfaces } : { kind: 'INTERFACE', name, fields, interfaces });
      } else if (kw === 'union') {
        this.parseDirectives();
        this.expectPunct('=');
        if (this.isPunct('|')) this.next();
        const types = [this.expectName()];
        while (this.isPunct('|')) {
          this.next();
          types.push(this.expectName());
        }
        defs.push({ kind: 'UNION', name, types });
      } else if (kw === 'enum') {
        this.parseDirectives();
        const values = new Set<string>();
        this.expectPunct('{');
        while (!this.isPunct('}')) {
          this.skipDescription();
          values.add(this.expectName());
          this.parseDirectives();
        }
        this.next();
        defs.push({ kind: 'ENUM', name, values });
      } else if (kw === 'input') {
        this.parseDirectives();
        const fields = new Map<string, InputValueDefinition>();
        this.expectPunct('{');
        while (!this.isPunct('}')) {
          const iv = this.parseInputValueDef();
          fields.set(iv.name, iv);
        }
        this.next();
        defs.push({ kind: 'INPUT_OBJECT', name, fields });
      } else {
        throw new Error(`SDL: unsupported definition keyword ${kw}`);
      }
    }
    return defs;
  }

  parseInputValueDef(): InputValueDefinition {
    this.skipDescription();
    const name = this.expectName();
    this.expectPunct(':');
    const type = this.parseType();
    let defaultValue: ValueNode | undefined;
    if (this.isPunct('=')) {
      this.next();
      defaultValue = this.parseValue(true);
    }
    this.parseDirectives();
    return { name, type, defaultValue };
  }
}

export function parse(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

/* ------------------------------------------------------------------ schema */

export interface InputValueDefinition {
  name: string;
  type: TypeNode;
  defaultValue?: ValueNode;
}

export interface FieldDefinition {
  name: string;
  type: TypeNode;
  args: Map<string, InputValueDefinition>;
  directives: DirectiveNode[];
}

export type TypeDefinition =
  | { kind: 'SCALAR'; name: string }
  | { kind: 'OBJECT'; name: string; fields: Map<string, FieldDefinition>; interfaces: string[] }
  | { kind: 'INTERFACE'; name: string; fields: Map<string, FieldDefinition>; interfaces: string[] }
  | { kind: 'UNION'; name: string; types: string[] }
  | { kind: 'ENUM'; name: string; values: Set<string> }
  | { kind: 'INPUT_OBJECT'; name: string; fields: Map<string, InputValueDefinition> };

type SchemaDefinitions = TypeDefinition[];

export interface Schema {
  types: Map<string, TypeDefinition>;
  /** abstract type name -> concrete object type names */
  possibleTypes: Map<string, Set<string>>;
}

const BUILTIN_SCALARS = ['ID', 'String', 'Int', 'Float', 'Boolean'];

export function buildSchema(sdl: string): Schema {
  const defs = new Parser(lex(sdl)).parseSDL();
  const types = new Map<string, TypeDefinition>();
  for (const s of BUILTIN_SCALARS) types.set(s, { kind: 'SCALAR', name: s });
  for (const d of defs) {
    if (types.has(d.name) && !BUILTIN_SCALARS.includes(d.name)) throw new Error(`SDL: duplicate type ${d.name}`);
    types.set(d.name, d);
  }
  const possibleTypes = new Map<string, Set<string>>();
  const check = (t: TypeNode, where: string) => {
    const n = namedType(t);
    if (!types.has(n)) throw new Error(`SDL: unknown type ${n} referenced at ${where}`);
  };
  for (const d of types.values()) {
    if (d.kind === 'OBJECT' || d.kind === 'INTERFACE') {
      for (const f of d.fields.values()) {
        check(f.type, `${d.name}.${f.name}`);
        for (const a of f.args.values()) check(a.type, `${d.name}.${f.name}(${a.name})`);
      }
      for (const i of d.interfaces) {
        const iface = types.get(i);
        if (!iface || iface.kind !== 'INTERFACE') throw new Error(`SDL: ${d.name} implements unknown interface ${i}`);
        for (const f of iface.fields.keys()) {
          if (!d.fields.has(f)) throw new Error(`SDL: ${d.name} misses interface field ${i}.${f}`);
        }
        if (d.kind === 'OBJECT') {
          if (!possibleTypes.has(i)) possibleTypes.set(i, new Set());
          possibleTypes.get(i)!.add(d.name);
        }
      }
    } else if (d.kind === 'UNION') {
      for (const t of d.types) {
        const td = types.get(t);
        if (!td || td.kind !== 'OBJECT') throw new Error(`SDL: union ${d.name} member ${t} is not an object type`);
      }
      possibleTypes.set(d.name, new Set(d.types));
    } else if (d.kind === 'INPUT_OBJECT') {
      for (const f of d.fields.values()) check(f.type, `${d.name}.${f.name}`);
    }
  }
  if (!types.has('Query')) throw new Error('SDL: missing Query type');
  return { types, possibleTypes };
}

export function namedType(t: TypeNode): string {
  return t.kind === 'Named' ? t.name : namedType(t.ofType);
}

export function typeToString(t: TypeNode): string {
  if (t.kind === 'Named') return t.name;
  if (t.kind === 'List') return `[${typeToString(t.ofType)}]`;
  return `${typeToString(t.ofType)}!`;
}

function isLeafKind(def: TypeDefinition | undefined): boolean {
  return def?.kind === 'SCALAR' || def?.kind === 'ENUM';
}

function isInputKind(def: TypeDefinition | undefined): boolean {
  return def?.kind === 'SCALAR' || def?.kind === 'ENUM' || def?.kind === 'INPUT_OBJECT';
}

function isAbstract(def: TypeDefinition | undefined): boolean {
  return def?.kind === 'INTERFACE' || def?.kind === 'UNION';
}

function typesOverlap(schema: Schema, a: string, b: string): boolean {
  if (a === b) return true;
  const set = (n: string): Set<string> => {
    const d = schema.types.get(n);
    if (isAbstract(d)) return schema.possibleTypes.get(n) ?? new Set();
    return new Set([n]);
  };
  const sa = set(a);
  for (const x of set(b)) if (sa.has(x)) return true;
  return false;
}

export function doesTypeApply(schema: Schema, objectType: string, condition: string): boolean {
  if (objectType === condition) return true;
  return schema.possibleTypes.get(condition)?.has(objectType) ?? false;
}

/* ----------------------------------------------------------- scalar coerce */

export type ScalarCoercer = {
  /** returns coerced value or throws Error(explanation) */
  input: (v: unknown) => unknown;
  output: (v: unknown) => unknown;
};

const DEFAULT_SCALARS: Record<string, ScalarCoercer> = {
  String: {
    input: (v) => {
      if (typeof v !== 'string') throw new Error(`Could not coerce value ${JSON.stringify(v)} to String`);
      return v;
    },
    output: (v) => String(v),
  },
  ID: {
    input: (v) => {
      if (typeof v === 'string') return v;
      if (typeof v === 'number' && Number.isInteger(v)) return String(v);
      throw new Error(`Could not coerce value ${JSON.stringify(v)} to ID`);
    },
    output: (v) => String(v),
  },
  Int: {
    input: (v) => {
      if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > 2147483647) {
        throw new Error(`Could not coerce value ${JSON.stringify(v)} to Int`);
      }
      return v;
    },
    output: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new Error(`Int cannot represent non-integer value: ${String(v)}`);
      return n;
    },
  },
  Float: {
    input: (v) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Could not coerce value ${JSON.stringify(v)} to Float`);
      return v;
    },
    output: (v) => Number(v),
  },
  Boolean: {
    input: (v) => {
      if (typeof v !== 'boolean') throw new Error(`Could not coerce value ${JSON.stringify(v)} to Boolean`);
      return v;
    },
    output: (v) => Boolean(v),
  },
};

/* -------------------------------------------------------------- validation */

export interface ValidationContext {
  schema: Schema;
  document: DocumentNode;
  operation: OperationDefinitionNode;
  errors: GraphQLError[];
  /** fields carrying this directive skip validation of their sub-selection */
  opaqueDirective?: string;
}

interface VarUsage {
  name: string;
  type: TypeNode;
  hasLocationDefault: boolean;
  loc: SourceLocation;
  argName: string;
}

function opLabel(op: OperationDefinitionNode): string {
  return op.name ? `${op.operation} ${op.name}` : op.operation;
}

export function validateOperation(ctx: ValidationContext): void {
  const { schema, operation: op, document: doc } = ctx;
  const usages: VarUsage[] = [];
  const visitedFragments = new Set<string>();
  const rootName = op.operation === 'mutation' ? 'Mutation' : op.operation === 'subscription' ? 'Subscription' : 'Query';
  if (!schema.types.has(rootName)) {
    ctx.errors.push(new GraphQLError(`Schema is not configured for ${op.operation}s`, { locations: [op.loc], extensions: { code: 'missingQueryConfiguration' } }));
    return;
  }

  // variable definitions
  const declared = new Map<string, VariableDefinitionNode>();
  for (const v of op.variableDefinitions) {
    const tn = namedType(v.type);
    if (!isInputKind(schema.types.get(tn))) {
      ctx.errors.push(new GraphQLError(`${tn} isn't a defined input type (on $${v.name})`, {
        locations: [v.loc],
        path: [opLabel(op)],
        extensions: { code: 'variableRequiresValidType', typeName: tn, variableName: v.name },
      }));
    }
    declared.set(v.name, v);
  }

  const checkDirectives = (dirs: DirectiveNode[], path: string[]) => {
    for (const d of dirs) {
      if (d.name !== 'include' && d.name !== 'skip') {
        ctx.errors.push(new GraphQLError(`Directive @${d.name} is not defined`, { locations: [d.loc], path, extensions: { code: 'undefinedDirective', directiveName: d.name } }));
        continue;
      }
      const ifArg = d.arguments.find((a) => a.name === 'if');
      if (!ifArg) {
        ctx.errors.push(new GraphQLError(`Directive '${d.name}' is missing required arguments: if`, { locations: [d.loc], path, extensions: { code: 'missingRequiredArguments', className: 'Directive', name: d.name, arguments: 'if' } }));
        continue;
      }
      validateValue(ifArg.value, { kind: 'NonNull', ofType: { kind: 'Named', name: 'Boolean' } }, `Argument 'if' on Directive '${d.name}'`, path, false, 'if');
    }
  };

  const validateValue = (value: ValueNode, type: TypeNode, label: string, path: string[], hasDefault: boolean, argName: string): void => {
    if (value.kind === 'Variable') {
      usages.push({ name: value.name, type, hasLocationDefault: hasDefault, loc: value.loc, argName });
      return;
    }
    const incompatible = () =>
      ctx.errors.push(new GraphQLError(`${label} has an invalid value (${printValue(value)}). Expected type '${typeToString(type)}'.`, {
        locations: [value.loc],
        path,
        extensions: { code: 'argumentLiteralsIncompatible', typeName: label.includes(' on InputObject ') ? 'InputObject' : label.includes(' on Directive ') ? 'Directive' : 'Field', argumentName: argName },
      }));
    if (type.kind === 'NonNull') {
      if (value.kind === 'Null') return void incompatible();
      return validateValue(value, type.ofType, label, path, hasDefault, argName);
    }
    if (value.kind === 'Null') return;
    if (type.kind === 'List') {
      if (value.kind === 'List') {
        for (const v of value.values) validateValue(v, type.ofType, label, path, false, argName);
        return;
      }
      return validateValue(value, type.ofType, label, path, false, argName);
    }
    const def = schema.types.get(type.name);
    if (!def) return;
    if (def.kind === 'INPUT_OBJECT') {
      if (value.kind !== 'Object') return void incompatible();
      const seen = new Set<string>();
      for (const f of value.fields) {
        seen.add(f.name);
        const fd = def.fields.get(f.name);
        if (!fd) {
          ctx.errors.push(new GraphQLError(`InputObject '${def.name}' doesn't accept argument '${f.name}'`, {
            locations: [value.loc],
            path: [...path, f.name],
            extensions: { code: 'argumentNotAccepted', name: def.name, typeName: 'InputObject', argumentName: f.name },
          }));
          continue;
        }
        validateValue(f.value, fd.type, `Argument '${f.name}' on InputObject '${def.name}'`, [...path, f.name], fd.defaultValue !== undefined, f.name);
      }
      for (const fd of def.fields.values()) {
        if (fd.type.kind === 'NonNull' && fd.defaultValue === undefined && !seen.has(fd.name)) {
          ctx.errors.push(new GraphQLError(`Argument '${fd.name}' on InputObject '${def.name}' is required. Expected type ${typeToString(fd.type)}`, {
            locations: [value.loc],
            path: [...path, fd.name],
            extensions: { code: 'missingRequiredInputObjectAttribute', argumentName: fd.name, argumentType: typeToString(fd.type), inputObjectType: def.name },
          }));
        }
      }
      return;
    }
    if (def.kind === 'ENUM') {
      if (value.kind !== 'Enum' || !def.values.has(value.value)) incompatible();
      return;
    }
    if (def.kind === 'SCALAR') {
      if (value.kind === 'List' || value.kind === 'Object' || value.kind === 'Enum') {
        if (def.name === 'JSON') return;
        return void incompatible();
      }
      if (def.name === 'Int' && value.kind !== 'Int') return void incompatible();
      if (def.name === 'Float' && value.kind !== 'Int' && value.kind !== 'Float') return void incompatible();
      if (def.name === 'Boolean' && value.kind !== 'Boolean') return void incompatible();
      if ((def.name === 'String' || def.name === 'HTML' || def.name === 'URL' || def.name === 'DateTime') && value.kind !== 'String') return void incompatible();
      if (def.name === 'ID' && value.kind !== 'String' && value.kind !== 'Int') return void incompatible();
    }
  };

  const validateSelectionSet = (set: SelectionSetNode, parentType: string, path: string[]): void => {
    const parentDef = schema.types.get(parentType);
    for (const sel of set.selections) {
      checkDirectives(sel.directives, path);
      if (sel.kind === 'Field') {
        const fieldPath = [...path, sel.alias ?? sel.name];
        if (sel.name === '__typename') {
          if (sel.selectionSet) {
            ctx.errors.push(new GraphQLError(`Selections can't be made on scalars (field '__typename' returns String but has selections [${sel.selectionSet.selections.map(selName).join(', ')}])`, {
              locations: [sel.loc], path: fieldPath, extensions: { code: 'selectionMismatch', nodeName: "field '__typename'", typeName: 'String' },
            }));
          }
          continue;
        }
        if (sel.name === '__schema' || sel.name === '__type') {
          ctx.errors.push(new GraphQLError(`Introspection is not supported by the Shopify fake (field '${sel.name}')`, {
            locations: [sel.loc], path: fieldPath, extensions: { code: 'undefinedField', typeName: parentType, fieldName: sel.name },
          }));
          continue;
        }
        if (parentDef?.kind === 'UNION') {
          ctx.errors.push(new GraphQLError(`Selections can't be made directly on unions (see selections on ${parentType})`, {
            locations: [sel.loc], path: fieldPath, extensions: { code: 'selectionMismatch', nodeName: parentType },
          }));
          continue;
        }
        const fieldDef = parentDef && (parentDef.kind === 'OBJECT' || parentDef.kind === 'INTERFACE') ? parentDef.fields.get(sel.name) : undefined;
        if (!fieldDef) {
          ctx.errors.push(new GraphQLError(`Field '${sel.name}' doesn't exist on type '${parentType}'`, {
            locations: [sel.loc], path: fieldPath, extensions: { code: 'undefinedField', typeName: parentType, fieldName: sel.name },
          }));
          continue;
        }
        // arguments
        const provided = new Set<string>();
        for (const arg of sel.arguments) {
          provided.add(arg.name);
          const argDef = fieldDef.args.get(arg.name);
          if (!argDef) {
            ctx.errors.push(new GraphQLError(`Field '${sel.name}' doesn't accept argument '${arg.name}'`, {
              locations: [arg.loc], path: [...fieldPath, arg.name], extensions: { code: 'argumentNotAccepted', name: sel.name, typeName: 'Field', argumentName: arg.name },
            }));
            continue;
          }
          validateValue(arg.value, argDef.type, `Argument '${arg.name}' on Field '${sel.name}'`, [...fieldPath, arg.name], argDef.defaultValue !== undefined, arg.name);
        }
        const missing = [...fieldDef.args.values()].filter((a) => a.type.kind === 'NonNull' && a.defaultValue === undefined && !provided.has(a.name)).map((a) => a.name);
        if (missing.length) {
          ctx.errors.push(new GraphQLError(`Field '${sel.name}' is missing required arguments: ${missing.join(', ')}`, {
            locations: [sel.loc], path: fieldPath, extensions: { code: 'missingRequiredArguments', className: 'Field', name: sel.name, arguments: missing.join(', ') },
          }));
        }
        const retName = namedType(fieldDef.type);
        const retDef = schema.types.get(retName);
        if (isLeafKind(retDef)) {
          if (sel.selectionSet) {
            ctx.errors.push(new GraphQLError(`Selections can't be made on ${retDef?.kind === 'ENUM' ? 'enums' : 'scalars'} (field '${sel.name}' returns ${retName} but has selections [${sel.selectionSet.selections.map(selName).join(', ')}])`, {
              locations: [sel.loc], path: fieldPath, extensions: { code: 'selectionMismatch', nodeName: `field '${sel.name}'`, typeName: retName },
            }));
          }
        } else if (!sel.selectionSet) {
          ctx.errors.push(new GraphQLError(`Field must have selections (field '${sel.name}' returns ${retName} but has no selections. Did you mean '${sel.name} { ... }'?)`, {
            locations: [sel.loc], path: fieldPath, extensions: { code: 'selectionMismatch', nodeName: `field '${sel.name}'`, typeName: retName },
          }));
        } else if (!(ctx.opaqueDirective && fieldDef.directives.some((d) => d.name === ctx.opaqueDirective))) {
          validateSelectionSet(sel.selectionSet, retName, fieldPath);
        }
      } else if (sel.kind === 'InlineFragment') {
        const cond = sel.typeCondition ?? parentType;
        const fragPath = [...path, `... on ${cond}`];
        const condDef = schema.types.get(cond);
        if (!condDef) {
          ctx.errors.push(new GraphQLError(`No such type ${cond}, so it can't be a fragment condition`, {
            locations: [sel.loc], path: fragPath, extensions: { code: 'undefinedType', typeName: cond },
          }));
          continue;
        }
        if (isLeafKind(condDef) || condDef.kind === 'INPUT_OBJECT') {
          ctx.errors.push(new GraphQLError(`Invalid fragment on type ${cond} (must be Union, Interface or Object)`, {
            locations: [sel.loc], path: fragPath, extensions: { code: 'fragmentOnNonCompositeType', typeName: cond },
          }));
          continue;
        }
        if (!typesOverlap(schema, parentType, cond)) {
          ctx.errors.push(new GraphQLError(`Fragment on ${cond} can't be spread inside ${parentType}`, {
            locations: [sel.loc], path: fragPath, extensions: { code: 'cannotSpreadFragment', typeName: cond, fragmentName: 'unknown', parentName: parentType },
          }));
          continue;
        }
        validateSelectionSet(sel.selectionSet, cond, fragPath);
      } else {
        const frag = doc.fragments.get(sel.name);
        const fragPath = [...path, `... ${sel.name}`];
        if (!frag) {
          ctx.errors.push(new GraphQLError(`Fragment ${sel.name} was used, but not defined`, {
            locations: [sel.loc], path: fragPath, extensions: { code: 'useAndDefineFragment', fragmentName: sel.name },
          }));
          continue;
        }
        const condDef = schema.types.get(frag.typeCondition);
        if (!condDef) {
          ctx.errors.push(new GraphQLError(`No such type ${frag.typeCondition}, so it can't be a fragment condition`, {
            locations: [frag.loc], path: [`fragment ${frag.name}`], extensions: { code: 'undefinedType', typeName: frag.typeCondition },
          }));
          continue;
        }
        if (!typesOverlap(schema, parentType, frag.typeCondition)) {
          ctx.errors.push(new GraphQLError(`Fragment ${sel.name} on ${frag.typeCondition} can't be spread inside ${parentType}`, {
            locations: [sel.loc], path: fragPath, extensions: { code: 'cannotSpreadFragment', typeName: frag.typeCondition, fragmentName: sel.name, parentName: parentType },
          }));
          continue;
        }
        if (visitedFragments.has(sel.name)) continue;
        visitedFragments.add(sel.name);
        validateSelectionSet(frag.selectionSet, frag.typeCondition, [`fragment ${frag.name}`]);
      }
    }
  };

  checkDirectives(op.directives, [opLabel(op)]);
  validateSelectionSet(op.selectionSet, rootName, [opLabel(op)]);

  for (const [name, frag] of doc.fragments) {
    if (!visitedFragments.has(name) && doc.operations.length === 1) {
      ctx.errors.push(new GraphQLError(`Fragment ${name} was defined, but not used`, {
        locations: [frag.loc], path: [`fragment ${name}`], extensions: { code: 'useAndDefineFragment', fragmentName: name },
      }));
    }
  }

  const used = new Set<string>();
  for (const u of usages) {
    used.add(u.name);
    const decl = declared.get(u.name);
    if (!decl) {
      ctx.errors.push(new GraphQLError(`Variable $${u.name} is used by ${op.name ?? 'anonymous ' + op.operation} but not declared`, {
        locations: [u.loc], path: [opLabel(op)], extensions: { code: 'variableNotDefined', variableName: u.name },
      }));
      continue;
    }
    const varType: TypeNode = decl.defaultValue && decl.defaultValue.kind !== 'Null' && decl.type.kind !== 'NonNull' ? { kind: 'NonNull', ofType: decl.type } : decl.type;
    const locType: TypeNode = u.hasLocationDefault && u.type.kind === 'NonNull' ? u.type.ofType : u.type;
    if (!isTypeSubTypeOf(varType, locType)) {
      const strip = (t: TypeNode): string => typeToString(t).replace(/!/g, '');
      const kind = strip(varType) === strip(locType) ? 'Nullability mismatch' : strip(varType).replace(/[[\]]/g, '') === strip(locType).replace(/[[\]]/g, '') ? 'List dimension mismatch' : 'Type mismatch';
      ctx.errors.push(new GraphQLError(`${kind} on variable $${u.name} and argument ${u.argName} (${typeToString(decl.type)} / ${typeToString(u.type)})`, {
        locations: [u.loc], path: [opLabel(op)], extensions: { code: 'variableMismatch', variableName: u.name, typeName: typeToString(decl.type), argumentName: u.argName, errorMessage: kind },
      }));
    }
  }
  for (const v of op.variableDefinitions) {
    if (!used.has(v.name)) {
      ctx.errors.push(new GraphQLError(`Variable $${v.name} is declared by ${op.name ?? 'anonymous ' + op.operation} but not used`, {
        locations: [v.loc], path: [opLabel(op)], extensions: { code: 'variableNotUsed', variableName: v.name },
      }));
    }
  }
}

function selName(s: SelectionNode): string {
  if (s.kind === 'Field') return s.name;
  if (s.kind === 'FragmentSpread') return `...${s.name}`;
  return `... on ${s.typeCondition ?? ''}`;
}

function isTypeSubTypeOf(maybeSub: TypeNode, superType: TypeNode): boolean {
  if (superType.kind === 'NonNull') {
    return maybeSub.kind === 'NonNull' && isTypeSubTypeOf(maybeSub.ofType, superType.ofType);
  }
  if (maybeSub.kind === 'NonNull') return isTypeSubTypeOf(maybeSub.ofType, superType);
  if (superType.kind === 'List') return maybeSub.kind === 'List' && isTypeSubTypeOf(maybeSub.ofType, superType.ofType);
  if (maybeSub.kind === 'List') return false;
  return maybeSub.name === superType.name;
}

export function printValue(v: ValueNode): string {
  switch (v.kind) {
    case 'Variable':
      return `$${v.name}`;
    case 'Int':
    case 'Float':
      return v.value;
    case 'String':
      return JSON.stringify(v.value);
    case 'Boolean':
      return String(v.value);
    case 'Null':
      return 'null';
    case 'Enum':
      return v.value;
    case 'List':
      return `[${v.values.map(printValue).join(', ')}]`;
    case 'Object':
      return `{${v.fields.map((f) => `${f.name}: ${printValue(f.value)}`).join(', ')}}`;
  }
}

/* ------------------------------------------------------ variable coercion */

interface Problem {
  path: (string | number)[];
  explanation: string;
}

export class InputCoercer {
  constructor(
    private readonly schema: Schema,
    private readonly scalars: Record<string, ScalarCoercer>,
  ) {}

  coerce(value: unknown, type: TypeNode, path: (string | number)[], problems: Problem[]): unknown {
    if (type.kind === 'NonNull') {
      if (value === null || value === undefined) {
        problems.push({ path, explanation: 'Expected value to not be null' });
        return null;
      }
      return this.coerce(value, type.ofType, path, problems);
    }
    if (value === null || value === undefined) return null;
    if (type.kind === 'List') {
      if (Array.isArray(value)) return value.map((v, i) => this.coerce(v, type.ofType, [...path, i], problems));
      return [this.coerce(value, type.ofType, path, problems)];
    }
    const def = this.schema.types.get(type.name);
    if (!def) {
      problems.push({ path, explanation: `Unknown type ${type.name}` });
      return null;
    }
    if (def.kind === 'ENUM') {
      if (typeof value !== 'string' || !def.values.has(value)) {
        problems.push({ path, explanation: `Expected ${JSON.stringify(value)} to be one of: ${[...def.values].join(', ')}` });
        return null;
      }
      return value;
    }
    if (def.kind === 'SCALAR') {
      const c = this.scalars[def.name] ?? DEFAULT_SCALARS[def.name];
      if (!c) return value;
      try {
        return c.input(value);
      } catch (e) {
        problems.push({ path, explanation: (e as Error).message });
        return null;
      }
    }
    if (def.kind === 'INPUT_OBJECT') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        problems.push({ path, explanation: `Expected ${JSON.stringify(value)} to be a key-value object.` });
        return null;
      }
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) {
        if (!def.fields.has(key)) problems.push({ path: [...path, key], explanation: `Field is not defined on ${def.name}` });
      }
      for (const fd of def.fields.values()) {
        if (!(fd.name in obj) || obj[fd.name] === undefined) {
          if (fd.defaultValue !== undefined) out[fd.name] = this.fromAST(fd.defaultValue, fd.type, {});
          else if (fd.type.kind === 'NonNull') problems.push({ path: [...path, fd.name], explanation: 'Expected value to not be null' });
          continue;
        }
        out[fd.name] = this.coerce(obj[fd.name], fd.type, [...path, fd.name], problems);
      }
      return out;
    }
    problems.push({ path, explanation: `${def.name} is not an input type` });
    return null;
  }

  /** Converts a (validated) literal to a runtime value. Missing variables yield undefined. */
  fromAST(node: ValueNode, type: TypeNode, vars: Record<string, unknown>): unknown {
    if (node.kind === 'Variable') return vars[node.name];
    if (type.kind === 'NonNull') return this.fromAST(node, type.ofType, vars);
    if (node.kind === 'Null') return null;
    if (type.kind === 'List') {
      if (node.kind === 'List') return node.values.map((v) => this.fromAST(v, type.ofType, vars));
      return [this.fromAST(node, type.ofType, vars)];
    }
    const def = this.schema.types.get(type.name);
    if (def?.kind === 'INPUT_OBJECT' && node.kind === 'Object') {
      const out: Record<string, unknown> = {};
      for (const fd of def.fields.values()) {
        const f = node.fields.find((x) => x.name === fd.name);
        if (f) {
          const v = this.fromAST(f.value, fd.type, vars);
          if (v !== undefined) out[fd.name] = v;
          else if (fd.defaultValue) out[fd.name] = this.fromAST(fd.defaultValue, fd.type, vars);
        } else if (fd.defaultValue) {
          out[fd.name] = this.fromAST(fd.defaultValue, fd.type, vars);
        }
      }
      return out;
    }
    const raw = literalToJS(node, vars);
    if (def?.kind === 'SCALAR') {
      const c = this.scalars[def.name] ?? DEFAULT_SCALARS[def.name];
      if (c && raw !== null) {
        try {
          return c.input(def.name === 'Float' && typeof raw === 'number' ? raw : raw);
        } catch (e) {
          throw new GraphQLError(`Argument has an invalid value (${printValue(node)}). ${(e as Error).message}`, {
            locations: [node.loc], extensions: { code: 'argumentLiteralsIncompatible', typeName: 'CoercionError' },
          });
        }
      }
    }
    return raw;
  }
}

function literalToJS(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return vars[node.name];
    case 'Int':
      return parseInt(node.value, 10);
    case 'Float':
      return parseFloat(node.value);
    case 'String':
    case 'Enum':
      return node.value;
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'List':
      return node.values.map((v) => literalToJS(v, vars));
    case 'Object':
      return Object.fromEntries(node.fields.map((f) => [f.name, literalToJS(f.value, vars)]));
  }
}

/* --------------------------------------------------------------- executor */

export interface ResolveInfo {
  fieldName: string;
  parentType: string;
  returnType: TypeNode;
  fieldDefinition: FieldDefinition;
  fieldNodes: FieldNode[];
  path: (string | number)[];
  schema: Schema;
  variables: Record<string, unknown>;
  operation: OperationDefinitionNode;
  document: DocumentNode;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ResolverFn = (parent: any, args: any, context: any, info: ResolveInfo) => unknown;
export type TypeResolvers = Record<string, ResolverFn> & { __resolveType?: (value: any) => string };
export type Resolvers = Record<string, TypeResolvers>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface PreparedRequest {
  document: DocumentNode;
  operation: OperationDefinitionNode;
  variables: Record<string, unknown>;
}

export interface EngineOptions {
  schema: Schema;
  resolvers: Resolvers;
  scalars?: Record<string, ScalarCoercer>;
  /** fields carrying this SDL directive skip validation of their sub-selection */
  opaqueDirective?: string;
  /** converts unexpected resolver exceptions to GraphQL errors */
  formatInternalError?: (err: unknown, path: (string | number)[]) => GraphQLError;
  /** called whenever an object value is completed (for cost accounting) */
  onObject?: (typeName: string, context: unknown) => void;
}

const BUBBLE = Symbol('null-bubble');

export class Engine {
  readonly schema: Schema;
  private readonly coercer: InputCoercer;
  private readonly scalars: Record<string, ScalarCoercer>;

  constructor(private readonly opts: EngineOptions) {
    this.schema = opts.schema;
    this.scalars = { ...DEFAULT_SCALARS, ...(opts.scalars ?? {}) };
    this.coercer = new InputCoercer(this.schema, this.scalars);
  }

  prepare(source: string, variables: unknown, operationName?: string | null): { ok: true; prepared: PreparedRequest } | { ok: false; errors: GraphQLError[] } {
    let document: DocumentNode;
    try {
      document = parse(source);
    } catch (e) {
      if (e instanceof GraphQLError) return { ok: false, errors: [e] };
      throw e;
    }
    let operation: OperationDefinitionNode | undefined;
    if (operationName) {
      operation = document.operations.find((o) => o.name === operationName);
      if (!operation) return { ok: false, errors: [new GraphQLError(`No operation named "${operationName}"`)] };
    } else if (document.operations.length === 1) {
      operation = document.operations[0];
    } else if (document.operations.length === 0) {
      return { ok: false, errors: [new GraphQLError('No operations in this document')] };
    } else {
      return { ok: false, errors: [new GraphQLError('An operation name is required')] };
    }
    const names = new Set<string>();
    for (const op of document.operations) {
      if (op.name && names.has(op.name)) {
        return { ok: false, errors: [new GraphQLError(`Operation name "${op.name}" must be unique`, { locations: [op.loc], extensions: { code: 'operationNotUnique', operationName: op.name } })] };
      }
      if (op.name) names.add(op.name);
    }
    if (operation.operation === 'subscription') {
      return { ok: false, errors: [new GraphQLError('Subscriptions are not supported', { locations: [operation.loc] })] };
    }
    const vctx: ValidationContext = { schema: this.schema, document, operation, errors: [], opaqueDirective: this.opts.opaqueDirective };
    validateOperation(vctx);
    if (vctx.errors.length) return { ok: false, errors: vctx.errors };

    const rawVars = variables && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
    const coerced: Record<string, unknown> = {};
    const errors: GraphQLError[] = [];
    for (const def of operation.variableDefinitions) {
      if (!(def.name in rawVars) || rawVars[def.name] === undefined) {
        if (def.defaultValue) {
          coerced[def.name] = this.coercer.fromAST(def.defaultValue, def.type, {});
        } else if (def.type.kind === 'NonNull') {
          errors.push(new GraphQLError(`Variable $${def.name} of type ${typeToString(def.type)} was provided invalid value`, {
            locations: [def.loc], extensions: { value: null, problems: [{ path: [], explanation: 'Expected value to not be null' }] },
          }));
        }
        continue;
      }
      const problems: Problem[] = [];
      const value = this.coercer.coerce(rawVars[def.name], def.type, [], problems);
      if (problems.length) {
        const withPath = problems.filter((p) => p.path.length > 0);
        const forPart = withPath.length ? ` for ${problems.map((p) => `${p.path.join('.') || '(root)'} (${p.explanation})`).join(', ')}` : '';
        errors.push(new GraphQLError(`Variable $${def.name} of type ${typeToString(def.type)} was provided invalid value${forPart}`, {
          locations: [def.loc], extensions: { value: rawVars[def.name], problems },
        }));
        continue;
      }
      coerced[def.name] = value;
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, prepared: { document, operation, variables: coerced } };
  }

  async execute(prepared: PreparedRequest, context: unknown, rootValue: unknown = {}): Promise<{ data: Record<string, unknown> | null; errors: GraphQLError[] }> {
    const errors: GraphQLError[] = [];
    const rootType = prepared.operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const exec = new Execution(this, prepared, context, errors, this.opts, this.scalars);
    let data: Record<string, unknown> | null;
    try {
      data = await exec.executeSelectionSet(rootType, rootValue, [prepared.operation.selectionSet], []);
    } catch (e) {
      if (e !== BUBBLE) throw e;
      data = null;
    }
    return { data, errors };
  }

  /** Collects fields for a selection set against a concrete object type (honours @skip/@include + fragments). */
  collectFields(typeName: string, sets: SelectionSetNode[], prepared: PreparedRequest): Map<string, FieldNode[]> {
    const out = new Map<string, FieldNode[]>();
    const visited = new Set<string>();
    const walk = (set: SelectionSetNode) => {
      for (const sel of set.selections) {
        if (!shouldInclude(sel.directives, prepared.variables)) continue;
        if (sel.kind === 'Field') {
          const key = sel.alias ?? sel.name;
          if (!out.has(key)) out.set(key, []);
          out.get(key)!.push(sel);
        } else if (sel.kind === 'InlineFragment') {
          if (sel.typeCondition && !doesTypeApply(this.schema, typeName, sel.typeCondition)) continue;
          walk(sel.selectionSet);
        } else {
          if (visited.has(sel.name)) continue;
          visited.add(sel.name);
          const frag = prepared.document.fragments.get(sel.name);
          if (!frag || !doesTypeApply(this.schema, typeName, frag.typeCondition)) continue;
          walk(frag.selectionSet);
        }
      }
    };
    for (const s of sets) walk(s);
    return out;
  }

  /** Like collectFields but for an abstract/unknown type: includes all fragments (used by cost analysis). */
  collectFieldsLoose(typeName: string, sets: SelectionSetNode[], prepared: PreparedRequest): Map<string, { nodes: FieldNode[]; typeName: string }> {
    const out = new Map<string, { nodes: FieldNode[]; typeName: string }>();
    const visited = new Set<string>();
    const walk = (set: SelectionSetNode, t: string) => {
      for (const sel of set.selections) {
        if (!shouldInclude(sel.directives, prepared.variables)) continue;
        if (sel.kind === 'Field') {
          const key = `${t}:${sel.alias ?? sel.name}`;
          if (!out.has(key)) out.set(key, { nodes: [], typeName: t });
          out.get(key)!.nodes.push(sel);
        } else if (sel.kind === 'InlineFragment') {
          walk(sel.selectionSet, sel.typeCondition ?? t);
        } else {
          if (visited.has(sel.name)) continue;
          visited.add(sel.name);
          const frag = prepared.document.fragments.get(sel.name);
          if (frag) walk(frag.selectionSet, frag.typeCondition);
        }
      }
    };
    for (const s of sets) walk(s, typeName);
    return out;
  }

  argumentValues(fieldDef: FieldDefinition, node: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const argDef of fieldDef.args.values()) {
      const provided = node.arguments.find((a) => a.name === argDef.name);
      let value: unknown;
      if (provided) {
        value = this.coercer.fromAST(provided.value, argDef.type, variables);
        if (value === undefined && argDef.defaultValue) value = this.coercer.fromAST(argDef.defaultValue, argDef.type, {});
      } else if (argDef.defaultValue) {
        value = this.coercer.fromAST(argDef.defaultValue, argDef.type, {});
      }
      if (value !== undefined) args[argDef.name] = value;
      if ((value === undefined || value === null) && argDef.type.kind === 'NonNull') {
        throw new GraphQLError(`Argument '${argDef.name}' on Field '${node.name}' has an invalid value (null). Expected type '${typeToString(argDef.type)}'.`, {
          locations: [node.loc], extensions: { code: 'argumentLiteralsIncompatible', typeName: 'Field', argumentName: argDef.name },
        });
      }
    }
    return args;
  }
}

function shouldInclude(directives: DirectiveNode[], vars: Record<string, unknown>): boolean {
  for (const d of directives) {
    const arg = d.arguments.find((a) => a.name === 'if');
    if (!arg) continue;
    const v = arg.value.kind === 'Variable' ? vars[arg.value.name] : arg.value.kind === 'Boolean' ? arg.value.value : false;
    if (d.name === 'skip' && v === true) return false;
    if (d.name === 'include' && v !== true) return false;
  }
  return true;
}

class Execution {
  constructor(
    private readonly engine: Engine,
    private readonly prepared: PreparedRequest,
    private readonly context: unknown,
    private readonly errors: GraphQLError[],
    private readonly opts: EngineOptions,
    private readonly scalars: Record<string, ScalarCoercer>,
  ) {}

  async executeSelectionSet(typeName: string, parent: unknown, sets: SelectionSetNode[], path: (string | number)[]): Promise<Record<string, unknown>> {
    const fields = this.engine.collectFields(typeName, sets, this.prepared);
    const result: Record<string, unknown> = {};
    for (const [key, nodes] of fields) {
      // Sequential execution keeps mutation ordering and deterministic state.
      result[key] = await this.executeField(typeName, parent, nodes, [...path, key]);
    }
    return result;
  }

  async executeField(parentType: string, parent: unknown, nodes: FieldNode[], path: (string | number)[]): Promise<unknown> {
    const node = nodes[0];
    if (node.name === '__typename') return parentType;
    const typeDef = this.engine.schema.types.get(parentType);
    const fieldDef = typeDef && (typeDef.kind === 'OBJECT' || typeDef.kind === 'INTERFACE') ? typeDef.fields.get(node.name) : undefined;
    if (!fieldDef) return null;
    const returnType = fieldDef.type;
    try {
      const args = this.engine.argumentValues(fieldDef, node, this.prepared.variables);
      const resolver = this.opts.resolvers[parentType]?.[node.name];
      const info: ResolveInfo = {
        fieldName: node.name,
        parentType,
        returnType,
        fieldDefinition: fieldDef,
        fieldNodes: nodes,
        path,
        schema: this.engine.schema,
        variables: this.prepared.variables,
        operation: this.prepared.operation,
        document: this.prepared.document,
      };
      let raw: unknown;
      if (resolver) {
        raw = await resolver(parent, args, this.context, info);
      } else {
        const v = parent && typeof parent === 'object' ? (parent as Record<string, unknown>)[node.name] : undefined;
        raw = typeof v === 'function' ? await (v as (a: unknown, c: unknown, i: ResolveInfo) => unknown).call(parent, args, this.context, info) : v;
      }
      return await this.completeValue(returnType, nodes, raw, path, parentType);
    } catch (e) {
      if (e !== BUBBLE) this.recordError(e, nodes, path);
      if (returnType.kind === 'NonNull') throw BUBBLE;
      return null;
    }
  }

  recordError(e: unknown, nodes: FieldNode[], path: (string | number)[]): void {
    if (e instanceof GraphQLError) {
      if (!e.path) e.path = path;
      if (!e.locations) e.locations = [nodes[0].loc];
      this.errors.push(e);
      return;
    }
    const err = this.opts.formatInternalError
      ? this.opts.formatInternalError(e, path)
      : new GraphQLError(e instanceof Error ? e.message : String(e), { path });
    if (!err.locations) err.locations = [nodes[0].loc];
    if (!err.path) err.path = path;
    this.errors.push(err);
  }

  async completeValue(type: TypeNode, nodes: FieldNode[], value: unknown, path: (string | number)[], parentType: string): Promise<unknown> {
    if (type.kind === 'NonNull') {
      if (value === null || value === undefined) {
        this.errors.push(new GraphQLError(`Cannot return null for non-nullable field ${parentType}.${nodes[0].name}`, { locations: [nodes[0].loc], path }));
        throw BUBBLE;
      }
      return this.completeValue(type.ofType, nodes, value, path, parentType);
    }
    if (value === null || value === undefined) return null;
    if (type.kind === 'List') {
      if (!Array.isArray(value)) throw new Error(`Expected list for ${parentType}.${nodes[0].name}`);
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        try {
          out.push(await this.completeValue(type.ofType, nodes, value[i], [...path, i], parentType));
        } catch (e) {
          if (e !== BUBBLE) throw e;
          if (type.ofType.kind === 'NonNull') throw BUBBLE;
          out.push(null);
        }
      }
      return out;
    }
    const def = this.engine.schema.types.get(type.name);
    if (!def) return null;
    if (def.kind === 'SCALAR') {
      const c = this.scalars[def.name];
      return c ? c.output(value) : value;
    }
    if (def.kind === 'ENUM') {
      const s = String(value);
      if (!def.values.has(s)) throw new Error(`Enum ${def.name} cannot represent value ${s}`);
      return s;
    }
    let objectType = def.name;
    if (def.kind === 'INTERFACE' || def.kind === 'UNION') {
      const resolveType = this.opts.resolvers[def.name]?.__resolveType;
      const resolved = resolveType ? resolveType(value) : (value as { __typename?: string }).__typename;
      if (!resolved || !doesTypeApply(this.engine.schema, resolved, def.name)) {
        throw new Error(`Could not resolve concrete type for ${def.name} (got ${String(resolved)})`);
      }
      objectType = resolved;
    }
    this.opts.onObject?.(objectType, this.context);
    const sets = nodes.map((n) => n.selectionSet).filter((s): s is SelectionSetNode => Boolean(s));
    return this.executeSelectionSet(objectType, value, sets, path);
  }
}
