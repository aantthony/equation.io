/**
 * Editor syntax colouring and hover descriptions. Pure and tolerant: a row
 * half-typed, unbalanced or invalid still colours, because this is a scan of
 * the text, not a parse — the parser throws on what the typist has not
 * finished yet. Names are coloured by what the document's built definitions
 * make of them, so `mean` is a function until a row binds `mean = [1, 2]`.
 */
import { isViewportText } from './analysis.ts';
import { type Binding, type Env, lookupValue } from './env.ts';
import { CONSTANTS, GLYPH_CHARS, NAME_SRC, SUPERSCRIPT_CHARS, canonicalName, freeVars } from './expr.ts';
import { familyOf } from './dist-families.ts';
import { VALUE_END, noteStart } from './statements.ts';
import { builtinHelp } from './syntax-help.ts';

/** `name` is a name the document or the row binds; `unbound` one nothing
 *  does yet — mid-typing, a typo, or a row that failed to define it. */
export type SpanClass = 'num' | 'str' | 'fn' | 'const' | 'coord' | 'name' | 'unbound' | 'op';

export interface Span {
  start: number;
  end: number;
  cls: SpanClass;
  /** The canonical name a name span refers to (dotted for a column). */
  name?: string;
  /** The name is applied: `(` follows it. */
  called?: boolean;
}

/** The plot's own variables: meaningful in any row without a definition. */
const COORDS = new Set(['x', 'y', 'z', 't', 'u', 'v', 'w']);

const GLYPH_CLASS: Record<string, SpanClass> = { π: 'const', τ: 'const', '∞': 'const' };

/** A name, its primes, and any dotted members: `f''`, `person.age`, `A.x`. */
const NAME_RE = new RegExp(`${NAME_SRC}'*(?:\\.${NAME_SRC})*`, 'y');
/** Greedy like the tokenizer, but `1..N` leaves `1` and the range operator. */
const NUMBER_RE = /\d+(?:\.(?!\.)\d*)?|\.\d+/y;
/** A range's `..`, consumed whole so `0..1` never reads `.1`. */
const RANGE_RE = /\.\.+/y;
const SUPERSCRIPT_RE = new RegExp(`[${SUPERSCRIPT_CHARS}]+`, 'y');
/** A function row's parameters: `f(x, k) =`. */
const PARAMS_RE = new RegExp(`^\\s*${NAME_SRC}\\s*\\(([^)]*)\\)\\s*=(?!=)`);
/** An index a sum, product or list binds in place: `sum[n=1..N]`, `prod(k=1..N, k)`. */
const INDEX_RE = new RegExp(`[[(,]\\s*(${NAME_SRC})\\s*=(?!=)`, 'g');
/** Calculus notation: d/dx, the dx of an integral. */
const DIFFERENTIAL_RE = /^d[xyztuvw]?$/;

/** Names the row binds for itself, which no definition will ever claim. */
function rowLocals(text: string): Set<string> {
  const locals = new Set<string>();
  const params = PARAMS_RE.exec(text);
  for (const p of params?.[1].split(',') ?? []) if (p.trim()) locals.add(canonicalName(p.trim()));
  for (const m of text.matchAll(INDEX_RE)) locals.add(canonicalName(m[1]));
  return locals;
}

/** Relations and binders: where a row says what it is. Arithmetic stays plain. */
const RELATION_RE = /<=|>=|:=|[=<>≤≥≠~∈:]/y;

function nameClass(name: string, env: Env, called: boolean): SpanClass | undefined {
  const binding = lookupValue(env, name);
  if (binding) return binding.tag === 'fn' ? 'fn' : 'name';
  const dot = name.indexOf('.');
  if (dot > 0 && env.names.has(name.slice(0, dot))) return 'name';
  // A sequence's terms: a_n, a_ before {n+1}, a_0.
  const under = name.lastIndexOf('_');
  if (under > 0 && [...env.sequences.values()].some(s => s.name === name.slice(0, under))) return 'name';
  if (Object.hasOwn(CONSTANTS, name) || name === 'i' || name === 'inf') return 'const';
  if (/^e_(?:x|y|z|xy|yz|zx|xyz)$/.test(name)) return 'const';
  if (COORDS.has(name) || DIFFERENTIAL_RE.test(name)) return 'coord';
  return builtinHelp(name, called) ? 'fn' : undefined;
}

/** Coloured spans of a row, in order. A `#` comment row, a trailing note and
 *  a viewport row have none: the stylesheet sets them apart as a whole. */
export function highlightSpans(text: string, env: Env): Span[] {
  if (text.trimStart().startsWith('#') || isViewportText(text.trim())) return [];
  const note = noteStart(text);
  const end = note < 0 ? text.length : note;
  const spans: Span[] = [];
  const at = (re: RegExp, i: number): string | null => {
    re.lastIndex = i;
    return re.exec(text)?.[0] ?? null;
  };
  const locals = rowLocals(text.slice(0, end));
  // A sequence's index (n in a_{n+1}) and a lattice's cells are names in every row that uses them.
  for (const scan of env.sequences.values())
    for (const idx of [scan.index, scan.cell, scan.cell2]) if (idx) locals.add(idx);
  let i = 0;
  while (i < end) {
    const c = text[i];
    if (c === '"' || (c === "'" && !VALUE_END.test(text[i - 1] ?? ''))) {
      const close = text.indexOf(c, i + 1);
      const stop = close < 0 || close >= end ? end : close + 1;
      spans.push({ start: i, end: stop, cls: 'str' });
      i = stop;
      continue;
    }
    const word = at(NAME_RE, i);
    if (word) {
      const stop = Math.min(i + word.length, end);
      const bare = word.replace(/'+/g, '');
      const name = canonicalName(bare);
      const called = /^\s*\(/.test(text.slice(stop, end));
      const cls = nameClass(name, env, called) ?? (locals.has(name) ? 'name' : 'unbound');
      spans.push({ start: i, end: stop, cls, name, called });
      i = stop;
      continue;
    }
    const range = at(RANGE_RE, i);
    if (range) {
      i += range.length;
      continue;
    }
    const number = at(NUMBER_RE, i) ?? at(SUPERSCRIPT_RE, i);
    if (number) {
      spans.push({ start: i, end: i + number.length, cls: 'num' });
      i += number.length;
      continue;
    }
    if (GLYPH_CHARS.includes(c)) {
      spans.push({ start: i, end: i + 1, cls: GLYPH_CLASS[c] ?? 'fn', name: c });
      i++;
      continue;
    }
    const relation = at(RELATION_RE, i);
    if (relation) {
      spans.push({ start: i, end: i + relation.length, cls: 'op' });
      i += relation.length;
      continue;
    }
    i++;
  }
  return spans;
}

export interface NameInfo {
  /** What the name is written as in the card: `f(x, a)`, `A`, `person.age`. */
  signature: string;
  /** Its type, in the language's own words: number, point (2D), function… */
  type: string;
  description?: string;
  /** The name whose definition row this one is found on: `A` for `A_x`. */
  defined?: string;
}

const dims = (n: number[]): string => n.join('×');

function paramsOf(e: readonly unknown[]): Set<string> {
  const vars = new Set<string>();
  for (const x of e) for (const v of freeVars(x as Parameters<typeof freeVars>[0])) vars.add(v);
  return vars;
}

/** A field's variables, in plot order: `of x, y`. */
const overVars = (vars: Set<string>): string[] => ['x', 'y', 'z', 't', 'u', 'v', 'w'].filter(v => vars.has(v));

function bindingInfo(name: string, b: Binding): NameInfo {
  switch (b.tag) {
    case 'scalar': {
      if (b.role === 'state')
        return { signature: name, type: 'state', description: `Integrated forward in t from ${name}(0)` };
      if (b.role === 'const') return { signature: name, type: 'number' };
      const over = overVars(paramsOf([b.expr]));
      return { signature: name, type: 'field', description: over.length ? `Depends on ${over.join(', ')}` : undefined };
    }
    case 'vector': {
      const dim = b.role === 'state' ? b.deriv.length : b.components.length;
      if (b.role === 'state') return { signature: name, type: `vector state (${dim}D)` };
      const vars = paramsOf(b.components);
      const params = ['u', 'v'].filter(v => vars.has(v)).length;
      const kind =
        params === 2 ? 'surface' : params === 1 ? 'curve' : vars.has('x') || vars.has('y') ? 'vector field' : 'point';
      return { signature: name, type: `${kind} (${dim}D)` };
    }
    case 'fn':
      return { signature: `${name}(${b.fn.params.join(', ')})`, type: 'function' };
    case 'matrix':
      return { signature: name, type: `matrix (${dims([b.matrix.length, b.matrix[0]?.length ?? 0])})` };
    case 'tensor':
      return { signature: name, type: `tensor (${dims([...b.tensor.shape])})` };
    case 'seq': {
      if (b.value.representation === 'scatter') return { signature: name, type: 'list of points' };
      const s = b.value.sequence;
      const n = s.kind === 'list' ? s.items.length : s.kind === 'data' || s.kind === 'text' ? s.values.length : null;
      const of = s.kind === 'text' ? 'text' : 'numbers';
      return { signature: name, type: n === null ? 'list' : `list of ${n} ${of}` };
    }
    case 'table': {
      const data = b.table.data;
      return {
        signature: name,
        type: data ? `table (${data.rows} rows)` : 'table',
        description: data
          ? `${b.table.file}: ${data.columns.map(c => c.name).join(', ')}`
          : (b.unavailable?.message ?? b.table.file),
      };
    }
    case 'rv': {
      const d = b.declaration;
      return d.kind === 'base'
        ? { signature: name, type: 'random variable', description: `~ ${familyOf(d.dist.kind).name}` }
        : { signature: name, type: 'random variable', description: 'Derived from other random variables' };
    }
    case 'missing':
      return { signature: name, type: b.list ? 'list (unavailable)' : 'value (unavailable)', description: b.message };
    case 'interval':
      return { signature: name, type: 'interval' };
    case 'multivector':
      return { signature: name, type: 'multivector' };
  }
}

const BUILTIN_VALUES: Record<string, [string, string]> = {
  pi: ['constant', 'π ≈ 3.14159'],
  tau: ['constant', 'τ = 2π ≈ 6.28319'],
  e: ['constant', 'e ≈ 2.71828'],
  i: ['constant', 'The imaginary unit, i² = −1'],
  inf: ['constant', 'Infinity'],
  x: ['coordinate', 'Horizontal axis of the plane'],
  y: ['coordinate', 'Vertical axis of the plane'],
  z: ['coordinate', 'Height: a row in z draws in 3D'],
  t: ['time', 'Seconds since the graph started; a row in t animates'],
  u: ['parameter', 'Runs over (0, 1): a tuple in u traces a curve'],
  v: ['parameter', 'Runs over (0, 1): a tuple in u and v is a surface'],
  w: ['complex coordinate', 'The point x + iy of the complex plane'],
  e_x: ['constant vector', '(1, 0, 0)'],
  e_y: ['constant vector', '(0, 1, 0)'],
  e_z: ['constant vector', '(0, 0, 1)'],
};

/** What a name means where the document stands: its type, and for a
 *  document's own names, which definition to jump to. */
export function describeName(name: string, env: Env, called = false): NameInfo | null {
  const entry = env.names.get(name);
  if (entry?.kind === 'component') {
    const binding = lookupValue(env, name)!;
    const axis = entry.index + 1;
    const role = binding.tag === 'scalar' && binding.role === 'state' ? 'state' : 'number';
    return { signature: name, type: role, description: `Component ${axis} of ${entry.owner}`, defined: entry.owner };
  }
  if (entry?.kind === 'binding') return { ...bindingInfo(name, entry.binding), defined: name };
  const dot = name.indexOf('.');
  if (dot > 0) {
    const head = name.slice(0, dot);
    const member = name.slice(dot + 1);
    const table = env.tables.get(head);
    const col = table?.data?.columns.find(c => c.name === member);
    if (col)
      return {
        signature: name,
        type: col.type === 'num' ? 'numeric column' : 'text column',
        description: table!.file,
        defined: head,
      };
    if (env.points.has(head) && /^[xyz]$/.test(member))
      return { signature: name, type: 'number', description: `The ${member} of ${head}`, defined: head };
    if (env.names.has(head)) return { signature: name, type: 'member', defined: head };
  }
  const glyph = {
    π: 'pi',
    τ: 'tau',
    '∞': 'inf',
    Σ: 'sum',
    '∑': 'sum',
    Π: 'prod',
    '∏': 'prod',
    '∫': 'int',
    '∇': 'grad',
  }[name];
  const key = glyph ?? name;
  const value = BUILTIN_VALUES[key];
  if (value) return { signature: name, type: value[0], description: value[1] };
  const help = builtinHelp(key, called || !!glyph);
  if (help) return { signature: help.signature, type: 'built-in', description: help.description };
  return null;
}
