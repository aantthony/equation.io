/**
 * User definitions and derivative syntax.
 *
 * - `a = 2` defines a constant (the UI shows it as a slider); `b = a^2 + t`
 *   defines a computed constant. Constants stay symbolic through GLSL
 *   compilation (they become uniforms) so dragging a slider never recompiles
 *   a shader.
 * - `a' = …` defines a state: da/dt, integrated forward as the graph animates
 *   (see state.ts), starting from `a(0) = …`. A state is a constant whose
 *   value carries between frames instead of being a formula in t, so systems
 *   with no closed form — a driven oscillator, a double pendulum — animate.
 * - `f(x) = x^3 - a x` defines a function; calls are inlined symbolically.
 * - `d/dx (…)` (also `d^2/dx^2`, any single-letter variable) differentiates
 *   symbolically at resolve time via diff().
 * - `sum(n=1..N, …)` / `prod(…)` (also Σ/Π, and `sum[n=1..N] …` binding the
 *   trailing product like d/dx) expand symbolically at resolve time, so the
 *   bounds must be numbers or already-known constants.
 * - `int(f dx)` / `int[a..b] f dx` (also ∫) integrate at resolve time:
 *   symbolically when integrate.ts finds a verified antiderivative, and
 *   otherwise by expanding a fixed Gauss–Legendre sum the same way Σ
 *   expands — so every downstream consumer still sees ordinary expressions.
 */
import { type Column, type Table, filterTable } from './csv.ts';
import { NonSmoothError, add, diff, div, mul, neg, pow, sub } from './diff.ts';
import { FUNCTIONS, SHADOWABLE_FNS, type Expr, evaluate, freeVars, ineqComparisons, parseExpr, substVars } from './expr.ts';
import { HASH_TOKEN_LEN, shortHash } from './hash.ts';
import { QUAD_TERMS, antiderivative, improperSum, quadratureSum, verifyDefinite } from './integrate.ts';
import { lowerGeom, pointComps, vecStateComps } from './geom.ts';
import { type GetList, type Seq, SCALAR_REDUCTIONS, isSeq, lowerLists, lowerMask } from './list.ts';
import { type Mat, matrixFromList } from './mat.ts';

export type Definition =
  | { kind: 'const'; name: string; rhs: string }
  | { kind: 'fn'; name: string; params: string[]; rhs: string }
  /** `a' = …` — da/dt, integrated forward in time. */
  | { kind: 'state'; name: string; rhs: string }
  /** `a(0) = …` — where the state a starts. */
  | { kind: 'init'; name: string; rhs: string }
  /** `person = open("people.csv", 3a7f…)` — a local data file, pinned by
   *  content hash. The bytes live on the device, not in the link. */
  | { kind: 'table'; name: string; file: string; hash: string };

/**
 * Row identity for duplicate detection. `a = 1` and `a' = 2` share a key —
 * a cannot be both a constant and a state — but `a(0)` is its own row.
 */
export const defKey = (d: Definition): string => (d.kind === 'init' ? `${d.name}(0)` : d.name);

export interface FnDef {
  params: string[];
  /** Fully resolved: no user-function calls or derivative nodes remain. */
  body: Expr;
}

export interface StateDef {
  /** da/dt, resolved. Free vars in {t, constants, states}. */
  deriv: Expr;
  /** a at reset, resolved. Free vars in {constants}. */
  init: Expr;
}

export interface Defs {
  consts: Map<string, Expr>;
  fns: Map<string, FnDef>;
  /**
   * Coordinate fields: definitions like `r = sqrt(x^2+y^2)` whose value
   * depends on the plane. Fully resolved to free vars in {x, y, t, consts}.
   * Each field is a grid family (its level sets) and substitutes into plots,
   * so `theta = atan2(y,x); r = 1 + cos(theta)` draws a polar grid and a
   * cardioid.
   */
  fields: Map<string, Expr>;
  /**
   * Named points: constants whose right-hand side is a pair, like
   * `A = (0, 0)` or `C = B + D`. A point named A lives in `consts` as the
   * derived scalar components A_x, A_y (see pointComps); the name itself
   * never appears in resolved expressions.
   */
  points: Set<string>;
  /**
   * Time-integrated states: `a' = …` with `a(0) = …`. Downstream they behave
   * exactly like constants (uniforms in GLSL, entries in the constant
   * environment on the CPU); only their value comes from the integrator in
   * state.ts rather than from a formula.
   */
  states: Map<string, StateDef>;
  /**
   * Vector states by component count: `om' = …` whose derivative (or `om(0)`)
   * is a 2- or 3-vector. The scalar states om_1, om_2(, om_3) do the
   * integrating; the base name expands to them wherever expressions lower,
   * exactly as a point name expands to A_x, A_y.
   */
  vecStates: Map<string, number>;
  /**
   * Named matrices: `M = [(a, b), (c, d)]`. Symbolic row-major entries;
   * det/trace/matvec/solve expand against them during lowering, so no
   * matrix survives into anything downstream (see mat.ts).
   */
  mats: Map<string, Mat>;
  /**
   * Named data lists: `L = [1, 4, 2]` or `[1..20]` — scalar elements or
   * points, in constants/states/t. List lowering (list.ts) substitutes and
   * broadcasts them wherever rows use the name, so, like matrices, no list
   * name survives into anything downstream.
   *
   * The value keeps whichever representation the definition produced: a
   * `list` of expressions, or the compact `data`/`text` of a column and
   * constant arithmetic over one (`ages = person.age / 2`), which must not
   * be expanded here or naming a column would cost what reading it saved.
   */
  lists: Map<string, Seq>;
  /**
   * Definitions that needed a data file this device does not have
   * (`ages = person.age / 2`, `avg = mean(person.age)`): the reason, and
   * whether the value would have been a list. Registered instead of the
   * definition, so a row below reports the file rather than degrading into
   * "ages is not defined" — the same courtesy `tables` does for a column.
   *
   * The `list` flag has to be right: it decides whether the name indexes and
   * whether a filter over it is well formed, and getting it wrong makes a
   * shared link valid on one device and not the other.
   */
  missingData: Map<string, { message: string; list: boolean }>;
  /**
   * Data files opened by name: `person = open("people.csv", 3a7f…)`. Each
   * numeric column reads as a list under its dotted name (`person.age`), so
   * everything lists can do — broadcasting, reductions, scatters — applies to
   * columns unchanged. `data` is null when the bytes are not on this device
   * (a shared link elsewhere, or a server-side preview).
   */
  tables: Map<string, TableDef>;
}

export interface TableDef {
  file: string;
  hash: string;
  data: Table | null;
  /** Why `data` is null, phrased for wherever this ran. */
  missing?: string;
}

export const emptyDefs = (): Defs => ({
  consts: new Map(),
  fns: new Map(),
  fields: new Map(),
  points: new Set(),
  states: new Map(),
  vecStates: new Map(),
  mats: new Map(),
  lists: new Map(),
  missingData: new Map(),
  tables: new Map(),
});

/**
 * Rows one data file may plot. A column reaches the renderer as its own
 * Float64Array with nothing to evaluate per point, so this is now a drawing
 * limit rather than an expression one — a much higher ceiling. Combining a
 * column with t, a slider, or a comparison still expands it to one
 * expression per row, and list.ts caps that separately (ITEMS_MAX).
 */
export const TABLE_MAX_ROWS = 200_000;

/**
 * Thrown when a row needs data this device does not have. The web app turns
 * it into "drop the file here"; the server-side preview reports the row as
 * device-local rather than broken, because it is not the graph that is wrong.
 */
export class MissingDataError extends Error {}

/** Expression elements of a numeric column, built once per parsed column. */
const colExprs = new WeakMap<Column, Expr[]>();

export function columnExprs(col: Column): Expr[] {
  let hit = colExprs.get(col);
  if (!hit) {
    hit = [...col.nums!].map((value): Expr => ({ kind: 'num', value }));
    colExprs.set(col, hit);
  }
  return hit;
}

/**
 * Resolve a name to list elements: a named list, or a data column written
 * `table.column`. Throws (rather than returning null) when the name clearly
 * means a column but cannot produce one, so the row explains itself.
 */
export function listGetter(defs: Defs): GetList {
  return name => {
    const hit = defs.lists.get(name);
    if (hit) return hit;
    // Any name whose definition wanted an absent file reports the file —
    // being a list or not decides how the name PARSES (indexing, filters),
    // not whether a row using it gets a straight answer. Without this
    // `avg = mean(person.age)` then `avg + 1` says "unknown variable".
    const absent = defs.missingData.get(name);
    if (absent) throw new MissingDataError(absent.message);
    const dot = name.indexOf('.');
    if (dot <= 0) {
      // A data file is not a value on its own: it is where columns live.
      const bare = defs.tables.get(name);
      if (!bare) return null;
      const col = bare.data?.columns.find(c => c.type === 'num')?.name;
      throw new Error(`${name} is a data file — plot one of its columns${col ? `, like ${name}.${col}` : ''},`
        + ` or name a filtered copy: adults = ${name}[…].`);
    }
    const table = defs.tables.get(name.slice(0, dot));
    if (!table) return null;
    const col = name.slice(dot + 1);
    if (!table.data) throw new MissingDataError(table.missing ?? `${table.file} is not loaded.`);
    const found = table.data.columns.find(c => c.name === col);
    if (!found) {
      throw new Error(`${table.file} has no column "${col}" (columns: ${table.data.columns.map(c => c.name).join(', ')}).`);
    }
    // A text column is a list too — of text. Only comparisons accept one
    // (list.ts); everything numeric says so where it is used.
    if (found.type !== 'num') return { kind: 'text', values: found.strs! };
    if (table.data.rows > TABLE_MAX_ROWS) {
      throw new Error(`${table.file} has ${table.data.rows} rows; plotting is limited to ${TABLE_MAX_ROWS}.`);
    }
    // The column's own array, never mutated downstream: every operation in
    // list.ts allocates its result.
    return { kind: 'data', values: found.nums! };
  };
}

/** Every name that reads as a list, so `L[2]`, `person.age[2]` and
 *  `person[…]` index instead of multiplying (parseExpr needs this before it
 *  parses). Table names count: a data file is indexed by a filter. */
export function listNamesOf(defs: Defs): Set<string> {
  const out = new Set([...defs.lists.keys()]);
  // A list whose file is elsewhere still indexes: the row must parse the same
  // way on every device (see `indexes` in expr.ts).
  for (const [name, m] of defs.missingData) if (m.list) out.add(name);
  for (const [name, t] of defs.tables) {
    out.add(name);
    for (const c of t.data?.columns ?? []) out.add(`${name}.${c.name}`);
  }
  return out;
}

/**
 * Whether this side of a comparison is still a list by the time the
 * comparison sees it — the question list.ts answers by lowering, asked here
 * of the shape alone, because on a device without the bytes there is nothing
 * to lower. Arithmetic and scalar functions map over a list; a reduction or
 * an index collapses one, and `[ ]` is itself a filter.
 */
function staysList(e: Expr, defs: Defs): boolean {
  switch (e.kind) {
    case 'var':
      return defs.lists.has(e.name) || defs.missingData.get(e.name)?.list === true
        || (e.name.includes('.') && defs.tables.has(e.name.slice(0, e.name.indexOf('.'))));
    case 'list':
    case 'data':
    case 'text': return true;
    case 'neg': return staysList(e.a, defs);
    case 'bin': return staysList(e.a, defs) || staysList(e.b, defs);
    case 'call':
      // A reduction answers with one number however long its argument is,
      // and `[at]`/`[index]` pick one element out.
      if (SCALAR_REDUCTIONS.has(e.name) || e.name === '[at]' || e.name === '[index]') return false;
      if ((e.name === 'min' || e.name === 'max') && e.args.length === 1) return false;
      // hist is a whole plot, not a value — list.ts refuses it in a filter
      // once the bytes are here, so it must not look list-shaped before then.
      if (e.name === 'hist' || e.name === '[hist]') return false;
      return e.args.some(a => staysList(a, defs));
    case 'vec': return e.items.some(a => staysList(a, defs));
    default: return false;
  }
}

/**
 * What a filter can be judged without reading a single row: that it is a
 * comparison over a list, and that it could ever settle. Everything else —
 * which rows it keeps, how many there are — needs the file (list.ts decides
 * those). The two answers must agree, or a shared link is valid only on the
 * device that has the bytes.
 */
/** A mask is a list of comparisons, so a filter condition has to BE one:
 *  `person[5]`, `person[person.age]`, `person[sin(person.age)]` are values. */
const isComparison = (e: Expr): e is Expr & { kind: 'ineq' | 'call' } =>
  e.kind === 'ineq' || (e.kind === 'call' && (e.name === '[eq]' || e.name === '[ne]'));

/**
 * Whether `L[idx]` is a slice rather than an element or a filter — the other
 * half of the `[…]` syntax, and the same reasoning as checkFilterShape below.
 * list.ts settles it by lowering, which needs the bytes; asked of the shape
 * alone it is settled identically on a device that has not got the file, so
 * `person.age[person.age]` is refused everywhere instead of passing as
 * "device-local" in a shared link and failing for the author.
 */
export const isSliceIndex = (idx: Expr, defs: Defs): boolean =>
  staysList(idx, defs) && !isComparison(idx);

function checkFilterShape(cond: Expr, defs: Defs, shape: string): void {
  if (!isComparison(cond)) throw new Error(shape);
  // …and a list has to REACH it. Merely mentioning one is not enough:
  // `person[mean(person.age) > 0]` and `person[person.age[1] > 0]` reduce to a
  // single scalar, so they decide one answer for every row — `person[1 < 2]`
  // wearing a column's name. Only operations that map over a list keep it one.
  const operands = cond.kind === 'ineq'
    ? ineqComparisons(cond).flatMap(c => [c.l, c.r])
    : cond.args;
  if (!operands.some(a => staysList(a, defs))) throw new Error(shape);
  if (freeVars(cond).has('t')) {
    throw new Error('A filter cannot depend on t — the list would change length every frame.');
  }
}

/**
 * A definition that filters a whole data file: `adults = person[cond]`.
 * Recognized before list lowering, which knows only about values — the
 * result is a new table, with every column cut to the rows the mask keeps.
 * Returns null when the row is not that shape.
 */
function filteredTable(e: Expr, defs: Defs, opts: ResolveOpts): TableDef | null {
  if (e.kind !== 'call' || e.name !== '[index]' || e.args[0]?.kind !== 'var') return null;
  const src = defs.tables.get(e.args[0].name);
  if (!src) return null;
  const name = e.args[0].name;
  const shape = `${name}[…] needs a comparison, like ${name}[${name}.x > 0].`;
  // No bytes to cut (a shared link elsewhere, or a server-side preview): the
  // cut is a table too, and reports the same reason its source does. Only the
  // per-row answer waits for the data — whether the row is a filter at all,
  // and whether it could ever settle, are answered here either way, or a
  // shared link would call `person[5]` valid and the author's device would not.
  if (!src.data) {
    checkFilterShape(e.args[1], defs, shape);
    return { file: src.file, hash: src.hash, data: null, missing: src.missing };
  }
  const keep = lowerMask(e.args[1], listGetter(defs), opts);
  if (!keep) throw new Error(shape);
  if (keep.length !== src.data.rows) {
    throw new Error(`The filter tests ${keep.length} values but ${src.file} has ${src.data.rows} rows.`);
  }
  return { file: src.file, hash: src.hash, data: filterTable(src.data, keep) };
}

/** Component names `name` expands to under geometry lowering, or null. */
export const compsOf = (defs: Defs, name: string): readonly string[] | null =>
  defs.points.has(name) ? pointComps(name)
    : defs.vecStates.has(name) ? vecStateComps(name, defs.vecStates.get(name)!)
      : null;

/** Names with built-in meaning that definitions may not shadow. */
export const RESERVED = new Set(['x', 'y', 'z', 'u', 'v', 't', 'w', 'i', 'd', 'e', 'pi', 'tau', 'open']);

const FN_RE = /^\s*([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*\)\s*=(?!=)([\s\S]+)$/;
const CONST_RE = /^\s*([A-Za-z_]\w*)\s*=(?!=)([\s\S]+)$/;
const STATE_RE = /^\s*([A-Za-z_]\w*)'\s*=(?!=)([\s\S]+)$/;
const INIT_RE = /^\s*([A-Za-z_]\w*)\s*\(\s*0\s*\)\s*=(?!=)([\s\S]+)$/;
/**
 * `person = open("people.csv", 3a7f9c…)` — the hash is optional as typed;
 * the app fills it in from the file it finds (like a slider's write-back).
 *
 * At least `HASH_TOKEN_LEN` hex digits, because a row is resolved by hash
 * *prefix*: a shorter token can match more than one stored file, and binding
 * a row to the wrong bytes is the exact failure the pin exists to prevent.
 */
const TABLE_RE = new RegExp(
  // `;` is excluded from the name deliberately: it separates rows in the URL,
  // so such a row cannot survive a reload. See rowSafeFileName.
  String.raw`^\s*([A-Za-z_]\w*)\s*=\s*open\s*\(\s*(?:"([^";]*)"|'([^';]*)')\s*(?:,\s*([0-9a-fA-F]{${HASH_TOKEN_LEN},64})\s*)?\)\s*$`,
);

/**
 * The name a file is stored and written under. A row quotes the file name
 * with no escape (`open("sales.csv")`), so a name holding a quote or a line
 * break could not be read back — and a row that cannot be read back is worse
 * than one whose title lost a character. `;` goes too: it separates rows in
 * the URL, so `sales;2026.csv` would come back as two broken rows. Applied at
 * ingest, so what is stored and what the row says are the same string, and
 * re-dropping the file matches.
 */
export const rowSafeFileName = (name: string): string =>
  name.replace(/[";\r\n\t]+/g, '_').trim() || 'data.csv';

/** A row that means to open a file, whether or not it succeeds at saying so. */
const OPEN_HEAD_RE = /^\s*([A-Za-z_]\w*)\s*=\s*open\s*\(\s*["']/;

/** How an `open(…)` row is written, for the app's write-back. */
export const formatTableRow = (name: string, file: string, hash: string): string =>
  `${name} = open("${rowSafeFileName(file)}"${hash ? `, ${shortHash(hash)}` : ''})`;

/**
 * A row that means to open a file but cannot: it claims a name it may not
 * have (`w`, `e`, `open` itself), or pins a hash too short to identify one
 * file. Without this it falls through to the expression parser, which only
 * knows that quotes are not arithmetic.
 */
export function badTableRow(text: string): string | null {
  const m = OPEN_HEAD_RE.exec(text);
  if (!m) return null;
  if (!nameable(m[1])) {
    return `${m[1]} is a built-in name, so it cannot name a data file — try ${m[1]}_data = open(…).`;
  }
  if (TABLE_RE.test(text)) return null;
  const quoted = /["']([^"']*)["']/.exec(text);
  if (quoted?.[1].includes(';')) {
    // The row works until it is reloaded: the payload joins rows with ';' and
    // encodes the quotes, so the name comes back as two broken rows. Say so
    // now, while the name is still on screen to be changed.
    return `A data file's name cannot contain ';' — that character separates rows,`
      + ' so the link would come back split. Rename the file and drop it again.';
  }
  const short = /,\s*([0-9a-fA-F]+)\s*\)\s*$/.exec(text);
  if (short && short[1].length < HASH_TOKEN_LEN) {
    return `A data file's hash is ${HASH_TOKEN_LEN} hex digits; that is ${short[1].length}.`
      + ' Delete it and the app will fill in the right one.';
  }
  // Something else malformed. scanDefinition hands every open-shaped row here
  // rather than reading it as a constant, so this is the only explanation the
  // row will get — the expression parser only knows quotes are not arithmetic.
  return `A data file row reads ${m[1]} = open("file.csv")`
    + `, with an optional ${HASH_TOKEN_LEN}-digit hash after the name.`;
}

/** A name a definition may claim: not a builtin (except the late-addition
 *  ones old graphs may define themselves), not reserved, not a uniform. */
export const nameable = (n: string): boolean =>
  (!FUNCTIONS.has(n) || SHADOWABLE_FNS.has(n)) && !RESERVED.has(n) && !n.startsWith('u_');

/** Detect a definition row before parsing (so calls to it parse everywhere). */
export function scanDefinition(text: string): Definition | null {
  // Primes first: `a' = …` is a state, but the reserved coordinate names keep
  // their ODE meaning, so `y' = x - y` stays a slope field (see plot.ts).
  let m = STATE_RE.exec(text);
  if (m && nameable(m[1])) return { kind: 'state', name: m[1], rhs: m[2] };
  m = INIT_RE.exec(text);
  if (m && nameable(m[1])) return { kind: 'init', name: m[1], rhs: m[2] };
  // Before the function form: `open(…)` takes a file name, not parameters.
  m = TABLE_RE.exec(text);
  if (m && nameable(m[1])) {
    return { kind: 'table', name: m[1], file: m[2] ?? m[3], hash: (m[4] ?? '').toLowerCase() };
  }
  // A row that plainly means to open a file but does not parse as one is NOT
  // a constant: `p = open("a.csv", abc123)` would otherwise be scanned as a
  // definition, and the row validator — the only thing that can explain the
  // short hash — never runs on definition rows. Leave it to badTableRow.
  if (OPEN_HEAD_RE.test(text)) return null;
  m = FN_RE.exec(text);
  if (m && nameable(m[1])) {
    return { kind: 'fn', name: m[1], params: m[2].split(/\s*,\s*/), rhs: m[3] };
  }
  m = CONST_RE.exec(text);
  if (m && nameable(m[1])) return { kind: 'const', name: m[1], rhs: m[2] };
  return null;
}

export type GetFn = (name: string) => FnDef | undefined;

const dVarName = (n: Expr): string | null =>
  n.kind === 'var' && /^d[A-Za-z]$/.test(n.name) ? n.name.slice(1) : null;

/** Match `d` or `d^k` (the numerator of a Leibniz derivative). */
function dOrder(n: Expr): number | null {
  if (n.kind === 'var' && n.name === 'd') return 1;
  if (n.kind === 'bin' && n.op === '^' && n.a.kind === 'var' && n.a.name === 'd'
    && n.b.kind === 'num' && Number.isInteger(n.b.value) && n.b.value >= 1 && n.b.value <= 6) {
    return n.b.value;
  }
  return null;
}

/** Match `dx` or `dx^k`, yielding the variable and order. */
function dxOrder(n: Expr): { v: string; order: number } | null {
  let v = dVarName(n);
  if (v) return { v, order: 1 };
  if (n.kind === 'bin' && n.op === '^' && (v = dVarName(n.a))
    && n.b.kind === 'num' && Number.isInteger(n.b.value) && n.b.value >= 1 && n.b.value <= 6) {
    return { v, order: n.b.value };
  }
  return null;
}

/** Numerator forms: d(^k), -d(^k), C·d(^k). */
function numeratorWrap(n: Expr): { order: number; wrap: (x: Expr) => Expr } | null {
  let order = dOrder(n);
  if (order !== null) return { order, wrap: x => x };
  if (n.kind === 'neg' && (order = dOrder(n.a)) !== null) return { order, wrap: neg };
  if (n.kind === 'bin' && n.op === '*' && (order = dOrder(n.b)) !== null) {
    const c = n.a;
    return { order, wrap: x => mul(c, x) };
  }
  return null;
}

/** Step for the central-difference fallback. Balances truncation against
 *  float32 roundoff — plots evaluate the expanded expression on the GPU. */
const FD_H = 1e-4;

function applyDiff(e: Expr, v: string, order: number, isList?: (n: string) => boolean): Expr {
  // A list is still just a name at this point, and diff() treats an unknown
  // name as a constant — so differentiating one would answer 0 for every
  // element. Say it cannot be done rather than answer wrongly.
  const list = isList && [...freeVars(e)].find(isList);
  if (list) {
    throw new Error(`${list} is a list, and d/d${v} cannot differentiate one`
      + ` — write the derivative of its elements, like [d/d${v} f(${v}), …].`);
  }
  for (let k = 0; k < order; k++) {
    try {
      e = diff(e, v);
    } catch (err) {
      if (!(err instanceof NonSmoothError)) throw err;
      // factorial, gamma, floor, …: expand a symbolic central difference,
      // the fallback roots.ts and the renderer's normals use when diff() throws.
      const vv: Expr = { kind: 'var', name: v };
      e = div(
        sub(substVars(e, { [v]: add(vv, num(FD_H)) }), substVars(e, { [v]: sub(vv, num(FD_H)) })),
        num(2 * FD_H),
      );
    }
  }
  return e;
}

/**
 * Rewrite a division that spells a Leibniz derivative. Implicit
 * multiplication binds tighter than '/', so `d/dx expr` parses as
 * d / (dx · expr): the operand is the tail of the denominator's product chain.
 */
function matchDeriv(numr: Expr, den: Expr, opts?: ResolveOpts): Expr | null {
  const head = numeratorWrap(numr);
  if (!head) return null;
  const factors: Expr[] = [];
  let leftmost = den;
  while (leftmost.kind === 'bin' && leftmost.op === '*') {
    factors.unshift(leftmost.b);
    leftmost = leftmost.a;
  }
  const dx = dxOrder(leftmost);
  if (!dx || dx.order !== head.order || factors.length === 0) return null;
  let operand = factors[0];
  for (let k = 1; k < factors.length; k++) operand = { kind: 'bin', op: '*', a: operand, b: factors[k] };
  return head.wrap(applyDiff(operand, dx.v, head.order, opts?.isList));
}

const num = (value: number): Expr => ({ kind: 'num', value });

export interface ResolveOpts {
  /** Numeric constant values, used to evaluate Σ/Π bounds at expansion time. */
  consts?: Record<string, number>;
  /** Out: constant names referenced by Σ/Π bounds (their sliders snap to integers). */
  boundConsts?: Set<string>;
  /**
   * Whether a name is a list. Derivatives expand HERE, before list.ts
   * substitutes, so without this `d/dt L` differentiates `L` as an opaque
   * variable and quietly becomes 0.
   */
  isList?: (name: string) => boolean;
  /**
   * Whether `L[idx]` is a slice: an index that is a list and not a mask.
   * A shape question, so list.ts asks it before it lowers anything — see
   * isSliceIndex.
   */
  isSlice?: (idx: Expr) => boolean;
}

interface Ctx {
  getFn: GetFn;
  opts: ResolveOpts;
  /** Terms expanded so far across every Σ/Π in this resolve (nesting multiplies). */
  terms: number;
}

/** A Σ/Π call: args [index, lo, hi] (header awaiting a body) or [index, lo, hi, body]. */
type SumCall = Expr & { kind: 'call'; name: 'sum' | 'prod' };

const isSumHeader = (e: Expr): e is SumCall =>
  e.kind === 'call' && (e.name === 'sum' || e.name === 'prod') && e.args.length === 3;

/** An ∫ header awaiting its body: `int[a..b]` (bounds) or a bare `int`/∫. */
const isIntHeader = (e: Expr): boolean =>
  (e.kind === 'call' && e.name === 'int' && e.args.length === 2)
  || (e.kind === 'var' && e.name === 'int');

/**
 * A header in a product chain binds its trailing factors: in
 * `2 sum[n=1..N] sin(n x)/n` the body is sin(n x)/n and the 2 stays outside
 * (like d/dx, which also binds the rest of its product chain). ∫ headers
 * (`int[a..b] f dx`, bare `∫ f dx`) bind the same way; the LEFTMOST header
 * wins, so `int[0..1] sum[n=1..2] x^n dx` nests the Σ inside the ∫'s body.
 */
function splitSumChain(e: Expr): { coeff: Expr | null; op: '*' | '/'; header: Expr; body: Expr } | null {
  const factors: Array<{ e: Expr; op: '*' | '/' }> = [];
  let node: Expr = e;
  while (node.kind === 'bin' && (node.op === '*' || node.op === '/')) {
    factors.unshift({ e: node.b, op: node.op });
    node = node.a;
  }
  factors.unshift({ e: node, op: '*' });
  const at = factors.findIndex(f => isSumHeader(f.e) || isIntHeader(f.e));
  if (at < 0) return null;
  const rest = factors.slice(at + 1);
  if (!rest.length) return null; // bodyless header: the call case reports it
  let body: Expr = rest[0].op === '*' ? rest[0].e : { kind: 'bin', op: '/', a: num(1), b: rest[0].e };
  for (let k = 1; k < rest.length; k++) body = { kind: 'bin', op: rest[k].op, a: body, b: rest[k].e };
  let coeff: Expr | null = null;
  for (let k = 0; k < at; k++) {
    coeff = coeff === null ? factors[k].e : { kind: 'bin', op: factors[k].op, a: coeff, b: factors[k].e };
  }
  return { coeff, op: factors[at].op, header: factors[at].e, body };
}

/** The bounds of an ∫ header, or null for the bare indefinite form. */
const intBounds = (header: Expr): [Expr, Expr] | null =>
  header.kind === 'call' && header.args.length === 2 ? [header.args[0], header.args[1]] : null;

/** Canonical call node for an ∫ header + its chain-bound body. */
const intCallOf = (header: Expr, body: Expr): Expr => {
  const b = intBounds(header);
  return { kind: 'call', name: 'int', args: b ? [b[0], b[1], body] : [body] };
};

interface StripDx {
  v: string;
  integrand: Expr;
  /** Factors after this integral's measure that carry ANOTHER d-var: they
   *  belong to an enclosing ∫ (`int[0..1] int[0..y] x dx dy` pairs inside
   *  out), so the expansion multiplies them back on for the outer level. */
  residual: Expr | null;
}

/**
 * Split the integration variable off a body: the first d<letter> factor in
 * its multiplicative structure (`x^2 dx` → v = x, integrand x^2). Implicit
 * multiplication binds tighter than '/', so in `sin(t)/t dt` the dt sits
 * inside the denominator product — the measure is recognized on either side
 * and the rest of that denominator stays a true denominator. A tail after
 * the measure folds into the integrand (`∫ dx/(1+x^2)`) unless it carries
 * its own d-var, in which case it is the enclosing integral's (residual).
 * Sums integrate termwise, so every term must end in the same dx.
 */
function stripDx(body: Expr): StripDx | null {
  if (body.kind === 'neg') {
    const m = stripDx(body.a);
    return m && { ...m, integrand: neg(m.integrand) };
  }
  if (body.kind === 'bin' && (body.op === '+' || body.op === '-')) {
    const a = stripDx(body.a);
    const b = stripDx(body.b);
    if (!a && !b) return null;
    if (!a || !b || a.v !== b.v || a.residual || b.residual) {
      throw new Error(`Every term under one ∫ must end in the same d${a?.v ?? b?.v ?? 'x'}.`);
    }
    return { v: a.v, integrand: { kind: 'bin', op: body.op, a: a.integrand, b: b.integrand }, residual: null };
  }
  const factors: Array<{ e: Expr; inv: boolean }> = [];
  const walk = (e: Expr, inv: boolean): void => {
    if (e.kind === 'bin' && (e.op === '*' || e.op === '/')) {
      walk(e.a, inv);
      walk(e.b, e.op === '/' ? !inv : inv);
      return;
    }
    factors.push({ e, inv });
  };
  walk(body, false);
  const at = factors.findIndex(f => dVarName(f.e) !== null);
  if (at < 0) return null;
  const v = dVarName(factors[at].e)!;
  const tail = factors.slice(at + 1);
  const tailHasDx = tail.some(f => dVarName(f.e) !== null);
  const inside = tailHasDx ? factors.slice(0, at) : factors.filter((_, i) => i !== at);
  const product = (fs: Array<{ e: Expr; inv: boolean }>): Expr => {
    let numr: Expr | null = null;
    let den: Expr | null = null;
    for (const f of fs) {
      if (f.inv) den = den === null ? f.e : { kind: 'bin', op: '*', a: den, b: f.e };
      else numr = numr === null ? f.e : { kind: 'bin', op: '*', a: numr, b: f.e };
    }
    let out: Expr = numr ?? num(1);
    if (den) out = { kind: 'bin', op: '/', a: out, b: den };
    return out;
  };
  return { v, integrand: product(inside), residual: tailHasDx ? product(tail) : null };
}

/** substVars for a Σ/Π index, stopping at nested Σ/Π that rebind the same name. */
function substIdx(e: Expr, idx: string, val: Expr): Expr {
  switch (e.kind) {
    case 'num': return e;
    case 'var': return e.name === idx ? val : e;
    case 'neg': return { kind: 'neg', a: substIdx(e.a, idx, val) };
    case 'bin': {
      if (e.op === '*' || e.op === '/') {
        const m = splitSumChain(e);
        if (m) {
          // A bodyless header binds the rest of its product chain as its body
          // (`sum[n=1..2] sum[n=1..3] n`). Canonicalize to the full call so
          // the rebinding guard below sees that body as the inner binder's
          // own, not as a sibling factor ours may substitute into.
          const canonical: Expr = isSumHeader(m.header)
            ? { kind: 'call', name: m.header.name, args: [...m.header.args, m.body] }
            : intCallOf(m.header, m.body);
          const call = substIdx(canonical, idx, val);
          return m.coeff ? { kind: 'bin', op: m.op, a: substIdx(m.coeff, idx, val), b: call } : call;
        }
      }
      return { kind: 'bin', op: e.op, a: substIdx(e.a, idx, val), b: substIdx(e.b, idx, val) };
    }
    case 'call': {
      if ((e.name === 'sum' || e.name === 'prod') && e.args[0]?.kind === 'var' && e.args[0].name === idx) {
        // The inner Σ rebinds idx: substitute in its bounds but not its body.
        const args = e.args.map((a, k) => (k === 0 || k === 3 ? a : substIdx(a, idx, val)));
        return { kind: 'call', name: e.name, args };
      }
      if (e.name === 'int' && (e.args.length === 1 || e.args.length === 3)) {
        // An ∫ whose dx names this index rebinds it: bounds only.
        const bodyAt = e.args.length - 1;
        let dx: { v: string } | null = null;
        try {
          dx = stripDx(e.args[bodyAt]);
        } catch { /* multiple dx factors: expansion will report it */ }
        if (dx && dx.v === idx) {
          const args = e.args.map((a, k) => (k === bodyAt ? a : substIdx(a, idx, val)));
          return { kind: 'call', name: 'int', args };
        }
      }
      return { kind: 'call', name: e.name, args: e.args.map(a => substIdx(a, idx, val)) };
    }
    case 'eq': return { kind: 'eq', l: substIdx(e.l, idx, val), r: substIdx(e.r, idx, val) };
    case 'ineq': return { kind: 'ineq', op: e.op, l: substIdx(e.l, idx, val), r: substIdx(e.r, idx, val) };
    case 'vec': return { kind: 'vec', items: e.items.map(a => substIdx(a, idx, val)) };
    case 'list': return { kind: 'list', items: e.items.map(a => substIdx(a, idx, val)) };
    case 'data':
    case 'str':
    case 'text': return e;
    case 'piecewise': return {
      kind: 'piecewise',
      cases: e.cases.map(c => ({ cond: substIdx(c.cond, idx, val), value: substIdx(c.value, idx, val) })),
      otherwise: e.otherwise && substIdx(e.otherwise, idx, val),
    };
  }
}

const FOLD_BUILD = { '+': add, '-': sub, '*': mul, '/': div, '^': pow } as const;

/** Fold numeric subtrees ((2·3-1) → 5) so expanded Σ terms compile to compact GLSL. */
function foldNums(e: Expr): Expr {
  switch (e.kind) {
    case 'num':
    case 'var':
      return e;
    case 'neg': return neg(foldNums(e.a));
    case 'bin': {
      const a = foldNums(e.a);
      const b = foldNums(e.b);
      if (a.kind === 'num' && b.kind === 'num') {
        const v = evaluate({ kind: 'bin', op: e.op, a, b }, {});
        if (isFinite(v)) return num(v);
      }
      return FOLD_BUILD[e.op](a, b);
    }
    case 'call': return { kind: 'call', name: e.name, args: e.args.map(foldNums) };
    case 'eq': return { kind: 'eq', l: foldNums(e.l), r: foldNums(e.r) };
    case 'ineq': return { kind: 'ineq', op: e.op, l: foldNums(e.l), r: foldNums(e.r) };
    case 'vec': return { kind: 'vec', items: e.items.map(foldNums) };
    case 'list': return { kind: 'list', items: e.items.map(foldNums) };
    case 'data':
    case 'str':
    case 'text': return e;
    case 'piecewise': return {
      kind: 'piecewise',
      cases: e.cases.map(c => ({ cond: foldNums(c.cond), value: foldNums(c.value) })),
      otherwise: e.otherwise && foldNums(e.otherwise),
    };
  }
}

const SUM_MAX_TERMS = 500;
const SUM_MAX_TOTAL = 2000;

/** Expand a Σ/Π into an explicit sum/product of per-index terms. */
function expandSum(header: SumCall, body: Expr, ctx: Ctx): Expr {
  const sym = header.name === 'sum' ? 'Σ' : 'Π';
  const [idxE, loE, hiE] = header.args;
  if (idxE.kind !== 'var') throw new Error(`Expected ${header.name}(n=1..N, …).`);
  const idx = idxE.name;
  if (RESERVED.has(idx)) throw new Error(`Cannot use "${idx}" as a ${sym} index (it is reserved).`);
  const bound = (b: Expr): number => {
    const r = rx(b, ctx);
    const env: Record<string, number> = {};
    for (const fv of freeVars(r)) {
      const v = ctx.opts.consts?.[fv];
      if (v === undefined) {
        if (fv === 't' || RESERVED.has(fv)) throw new Error(`${sym} bounds cannot depend on ${fv}.`);
        throw new Error(`${sym} bounds must be constant — add "${fv} = 5" in a row above.`);
      }
      ctx.opts.boundConsts?.add(fv);
      env[fv] = v;
    }
    const v = evaluate(r, env);
    if (!isFinite(v)) throw new Error(`${sym} bound is not finite.`);
    return v;
  };
  const start = Math.ceil(bound(loE) - 1e-9);
  const end = Math.floor(bound(hiE) + 1e-9);
  const count = end - start + 1;
  if (count > SUM_MAX_TERMS) throw new Error(`${sym} expands to ${count} terms (limit ${SUM_MAX_TERMS}).`);
  ctx.terms += Math.max(count, 0);
  if (ctx.terms > SUM_MAX_TOTAL) {
    throw new Error(`Nested ${sym} expand to too many terms (limit ${SUM_MAX_TOTAL} total).`);
  }
  const combine = header.name === 'sum' ? add : mul;
  let acc: Expr | null = null;
  for (let k = start; k <= end; k++) {
    const term = foldNums(rx(substIdx(body, idx, num(k)), ctx));
    acc = acc === null ? term : combine(acc, term);
  }
  return acc ?? num(header.name === 'sum' ? 0 : 1);
}

/**
 * Cache of expanded integrals. The expansion is a pure function of the
 * resolved integrand and bounds — slider VALUES stay symbolic inside it — so
 * a slider drag's per-keystroke recompiles hit this instead of re-running
 * the symbolic engine and its verification quadratures.
 */
const intMemo = new Map<string, Expr>();

/**
 * Expand an ∫: a verified antiderivative when integrate.ts finds one
 * (definite values additionally checked against adaptive quadrature — the
 * fundamental theorem lies across a non-integrable singularity), otherwise
 * a fixed Gauss–Legendre sum in ordinary Expr form.
 */
/** ±1 for a bound written as ±inf/±∞, 0 for a finite (or absent) bound. */
const infOf = (e: Expr | null): 1 | -1 | 0 => {
  if (!e) return 0;
  if (e.kind === 'var' && e.name === 'inf') return 1;
  if (e.kind === 'neg' && e.a.kind === 'var' && e.a.name === 'inf') return -1;
  return 0;
};

/**
 * Stand-in argument for an antiderivative's limit at ±∞. Far beyond any plot
 * range, so F(±BIG) matches the true limit wherever F converges by then —
 * and verifyDefinite runs the REAL improper quadrature, so a
 * not-yet-converged (or divergent) limit is rejected, never reported.
 */
const INT_BIG = 1e8;

function expandInt(bounds: [Expr, Expr] | null, rawBody: Expr, ctx: Ctx): Expr {
  // Resolve the body FIRST: a d/dt inside consumes its own dt, user
  // functions inline, and nested (parenthesized) integrals expand — only
  // then is the surviving d<letter> factor unambiguous.
  const m = stripDx(rx(rawBody, ctx));
  if (!m) throw new Error('∫ needs its variable as a dx factor: int(x^2 dx) or int[0..2] x^2 dx.');
  const v = m.v;
  const integrand = m.integrand;
  let lo = bounds && rx(bounds[0], ctx);
  let hi = bounds && rx(bounds[1], ctx);
  let loI = infOf(lo);
  let hiI = infOf(hi);
  // Normalize a downhill infinite range (int[inf..0]) to the negated uphill one.
  let flip = false;
  if (loI === 1 || hiI === -1) {
    [lo, hi] = [hi, lo];
    [loI, hiI] = [hiI, loI];
    flip = true;
    if (loI === 1 || hiI === -1) return num(0); // int[inf..inf]: equal bounds
  }
  const memoKey = JSON.stringify([v, integrand, lo, hi]);
  const done = (out: Expr): Expr => {
    const signed = flip ? neg(out) : out;
    // An enclosing integral's measure rides along: (∫ inner) · residual.
    return m.residual ? { kind: 'bin', op: '*', a: signed, b: m.residual } : signed;
  };
  const hit = intMemo.get(memoKey);
  if (hit) return done(hit);

  const F = antiderivative(integrand, v);
  let out: Expr | null = null;
  if (!bounds) {
    out = F;
  } else if (F) {
    const loSub = loI ? num(loI * INT_BIG) : lo!;
    const hiSub = hiI ? num(hiI * INT_BIG) : hi!;
    const val = foldNums(sub(substVars(F, { [v]: hiSub }), substVars(F, { [v]: loSub })));
    const loChk = loI ? num(loI * Infinity) : lo!;
    const hiChk = hiI ? num(hiI * Infinity) : hi!;
    if (verifyDefinite(val, integrand, v, loChk, hiChk)) out = val;
  }
  if (!out) {
    // Numeric fallback. An indefinite ∫ anchors at 0: F(x) = ∫₀ˣ; infinite
    // ranges transform onto a finite interval first (improperSum).
    ctx.terms += QUAD_TERMS;
    if (ctx.terms > SUM_MAX_TOTAL) {
      throw new Error(`Nested Σ/∫ expand to too many terms (limit ${SUM_MAX_TOTAL} total).`);
    }
    out = foldNums(loI || hiI
      ? improperSum(integrand, v, loI ? null : lo, hiI ? null : hi)
      : quadratureSum(integrand, v, lo ?? num(0), hi ?? { kind: 'var', name: v }));
    if (JSON.stringify(out).length > 400_000) {
      throw new Error('∫ has no closed form here and its numeric expansion is too large.');
    }
  }
  if (intMemo.size > 500) intMemo.clear();
  intMemo.set(memoKey, out);
  return done(out);
}

/** Whether a parsed (unresolved) expression uses ∫ anywhere — after
 *  resolution the integral is gone, so row readouts test the parse. */
export function usesIntegral(e: Expr): boolean {
  switch (e.kind) {
    case 'num': return false;
    case 'var': return e.name === 'int';
    case 'neg': return usesIntegral(e.a);
    case 'bin': return usesIntegral(e.a) || usesIntegral(e.b);
    case 'call': return e.name === 'int' || e.args.some(usesIntegral);
    case 'eq': return usesIntegral(e.l) || usesIntegral(e.r);
    case 'ineq': return usesIntegral(e.l) || usesIntegral(e.r);
    case 'vec': return e.items.some(usesIntegral);
    case 'list': return e.items.some(usesIntegral);
    case 'data':
    case 'str':
    case 'text': return false;
    case 'piecewise':
      return e.cases.some(c => usesIntegral(c.cond) || usesIntegral(c.value))
        || (e.otherwise ? usesIntegral(e.otherwise) : false);
  }
}

/**
 * Inline user-function calls, resolve d/dx derivative notation, and expand
 * Σ/Π sums and ∫ integrals (post-order).
 */
export function resolveExpr(e: Expr, getFn: GetFn, opts: ResolveOpts = {}): Expr {
  return rx(e, { getFn, opts, terms: 0 });
}

function rx(e: Expr, ctx: Ctx): Expr {
  const { getFn } = ctx;
  switch (e.kind) {
    case 'num':
    case 'var':
      return e;
    case 'neg': return { kind: 'neg', a: rx(e.a, ctx) };
    case 'bin': {
      if (e.op === '*' || e.op === '/') {
        // Σ/∫ headers capture their trailing product chain before it
        // resolves, so `sum[n=1..N] sin(n x)/n` divides each term, not the
        // whole sum, and `int[0..1] x^2 dx` binds through to its dx.
        const m = splitSumChain(e);
        if (m) {
          const body = isSumHeader(m.header)
            ? expandSum(m.header, m.body, ctx)
            : expandInt(intBounds(m.header), m.body, ctx);
          return m.coeff ? { kind: 'bin', op: m.op, a: rx(m.coeff, ctx), b: body } : body;
        }
      }
      const a = rx(e.a, ctx);
      const b = rx(e.b, ctx);
      if (e.op === '/') {
        const d = matchDeriv(a, b, ctx.opts);
        if (d) return d;
      }
      if (e.op === '*' && a.kind === 'bin' && a.op === '/') {
        // The parenthesized form (d/dx)(expr): the quotient is bare.
        const head = numeratorWrap(a.a);
        const dx = dxOrder(a.b);
        if (head && dx && head.order === dx.order) {
          return head.wrap(applyDiff(b, dx.v, head.order, ctx.opts.isList));
        }
      }
      return { kind: 'bin', op: e.op, a, b };
    }
    case 'call': {
      if (e.name === 'sum' || e.name === 'prod') {
        if (e.args.length !== 4) {
          throw new Error(`${e.name === 'sum' ? 'Σ' : 'Π'} needs a body: write ${e.name}(n=1..N, …) or ${e.name}[n=1..N] (…).`);
        }
        return expandSum(e as SumCall, e.args[3], ctx);
      }
      if (e.name === 'int') {
        if (e.args.length === 2) throw new Error('∫ needs a body: write int[a..b] f(x) dx.');
        const body = e.args[e.args.length - 1];
        return expandInt(e.args.length === 3 ? [e.args[0], e.args[1]] : null, body, ctx);
      }
      if (e.name === '[range]') throw new Error("'..' ranges only appear in sum(n=1..N, …), prod(…), int[a..b], or a list like [1..10].");
      const args = e.args.map(x => rx(x, ctx));
      const fn = getFn(e.name);
      if (fn) {
        if (args.length !== fn.params.length) {
          throw new Error(`${e.name} takes ${fn.params.length} argument${fn.params.length === 1 ? '' : 's'}.`);
        }
        return substVars(fn.body, Object.fromEntries(fn.params.map((p, k) => [p, args[k]])));
      }
      return { kind: 'call', name: e.name, args };
    }
    case 'eq': return { kind: 'eq', l: rx(e.l, ctx), r: rx(e.r, ctx) };
    case 'ineq': return { kind: 'ineq', op: e.op, l: rx(e.l, ctx), r: rx(e.r, ctx) };
    case 'vec': return { kind: 'vec', items: e.items.map(x => rx(x, ctx)) };
    case 'list': return {
      kind: 'list',
      // `[1..10]` ranges survive resolution intact (bounds resolve) and
      // expand later in list lowering, where constant values are known.
      items: e.items.map((x): Expr => (x.kind === 'call' && x.name === '[range]'
        ? { kind: 'call', name: '[range]', args: x.args.map(a => rx(a, ctx)) }
        : rx(x, ctx))),
    };
    case 'data':
    case 'str':
    case 'text': return e;
    case 'piecewise': return {
      kind: 'piecewise',
      cases: e.cases.map(c => ({ cond: rx(c.cond, ctx), value: rx(c.value, ctx) })),
      otherwise: e.otherwise && rx(e.otherwise, ctx),
    };
  }
}

export interface BuiltDefs {
  defs: Defs;
  /** Per-definition errors by defKey; failed definitions are excluded from defs. */
  errors: Map<string, string>;
  /** Of those, the ones that failed only because a data file is not on this
   *  device — the app turns their message into a file picker. */
  needsFile: Set<string>;
  /** Constants referenced by Σ/Π bounds (the UI snaps their sliders to integers). */
  sumBoundConsts: Set<string>;
}

/**
 * Look up the bytes behind an `open(…)` row. Omitted (the worker, tests)
 * means no device data at all: the row still defines a table, but one whose
 * columns report themselves as device-local rather than missing.
 */
export type TableSource = (d: { file: string; hash: string }) => Table | null;

/** Parse and resolve a set of uniquely named definitions. */
export function buildDefs(raw: Definition[], tables?: TableSource): BuiltDefs {
  const errors = new Map<string, string>();
  const needsFile = new Set<string>();
  const defs = emptyDefs();
  const byName = new Map(raw.map(d => [d.name, d]));
  const fnNames = new Set(raw.filter(d => d.kind === 'fn').map(d => d.name));
  const stateNames = new Set(raw.filter(d => d.kind === 'state').map(d => d.name));
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // Numeric values of constants resolved so far: Σ/Π bounds in later
  // definitions may use them (bounds need a value at expansion time).
  const numEnv: Record<string, number> = {};
  const ropts: ResolveOpts = {
    consts: numEnv,
    boundConsts: new Set(),
    // Live: list names accumulate as definitions are processed.
    isList: n => listNamesOf(defs).has(n),
    isSlice: idx => isSliceIndex(idx, defs),
  };

  const parsed = new Map<string, Expr>();
  // List names accumulate in definition order, so `L[2]` indexes only when
  // L's list definition sits above (below, it parses as multiplication and
  // is reported as a forward reference after the loop).
  const parse = (d: Definition & { rhs: string }): Expr => {
    const key = defKey(d);
    let p = parsed.get(key);
    if (!p) parsed.set(key, (p = parseExpr(d.rhs, fnNames, listNamesOf(defs))));
    return p;
  };

  /** Derived point component → the point row it belongs to (A_x → A). */
  const compOwner = new Map<string, string>();

  const resolving = new Set<string>();
  const getFn: GetFn = name => {
    const hit = defs.fns.get(name);
    if (hit) return hit;
    if (!fnNames.has(name)) return undefined;
    if (errors.has(name)) throw new Error(`${name} has an error in its definition.`);
    if (resolving.has(name)) throw new Error(`${name} is defined in terms of itself.`);
    const d = byName.get(name) as Definition & { kind: 'fn' };
    resolving.add(name);
    try {
      const fn: FnDef = { params: d.params, body: resolveExpr(parse(d), getFn, ropts) };
      defs.fns.set(name, fn);
      return fn;
    } finally {
      resolving.delete(name);
    }
  };

  // Resolved right-hand sides of `a' = …` and `a(0) = …`, validated below
  // once the constant/field split is known.
  const derivs = new Map<string, Expr>();
  const inits = new Map<string, Expr>();

  for (const d of raw) {
    try {
      if (d.kind === 'fn') {
        if (new Set(d.params).size !== d.params.length) throw new Error('Duplicate parameter names.');
        getFn(d.name);
      } else if (d.kind === 'table') {
        // The data itself never comes from the document, so there is nothing
        // to resolve: look the file up and register its columns as lists.
        const data = tables ? tables(d) : null;
        // Registered even when the bytes are missing, so the rows that read
        // its columns report the file rather than "unknown variable".
        const named = d.hash ? `${d.file} (${shortHash(d.hash)})` : d.file;
        const missing = data ? undefined : tables
          ? `${named} is not on this device — drop the file here to load it.`
          : `${named} is not on this device — its data does not travel in the link.`;
        defs.tables.set(d.name, { file: d.file, hash: d.hash, data, missing });
        if (missing && tables) throw new MissingDataError(missing);
      } else if (d.kind === 'state') {
        derivs.set(d.name, resolveExpr(parse(d), getFn, ropts));
      } else if (d.kind === 'init') {
        inits.set(d.name, resolveExpr(parse(d), getFn, ropts));
      } else {
        // Lowering expands point arithmetic; a pair result names a point.
        // Point-ness flows in definition order, so `C = B + D` needs B and D
        // defined above (a stray point name below is reported after the loop).
        let e = lowerGeom(
          resolveExpr(parse(d), getFn, ropts),
          n => (defs.points.has(n) ? pointComps(n) : null),
          n => defs.mats.get(n) ?? null,
        );
        // `adults = person[person.age >= 18]` names a cut of a data file.
        const cut = filteredTable(e, defs, ropts);
        if (cut) {
          defs.tables.set(d.name, cut);
          // Registered first, so rows below report the file rather than
          // "unknown variable" — then the row says what is missing, exactly
          // as the `open()` row it cuts does. Without this the derived table
          // was the one row in the chain that said nothing: its source asked
          // for the file and every use of it did too.
          if (cut.missing && tables) throw new MissingDataError(cut.missing);
          continue;
        }
        if (e.kind === 'list') {
          // A named list of 2–3 equal-length tuple/nested rows is a matrix
          // (that syntax predates data lists); every other shape falls
          // through to data-list handling below.
          let mat: Mat | null = null;
          try {
            mat = matrixFromList(e);
          } catch (err) {
            // Nested-list rows ([[1,2],[3,4],…]) always spell a matrix, so
            // a bad shape there keeps the matrix error.
            if (e.items.some(it => it.kind === 'list')) throw err;
          }
          if (mat) {
            defs.mats.set(d.name, mat);
            continue;
          }
        }
        e = lowerLists(e, listGetter(defs), ropts, true);
        if (isSeq(e)) {
          // A named data list: scalar elements, or points for a named scatter.
          // A `data`/`text` value is a list too — a column, or arithmetic over
          // one — and is stored as it stands rather than expanded.
          if (e.kind === 'list') {
            const vecs = e.items.filter((it): it is Expr & { kind: 'vec' } => it.kind === 'vec');
            if (vecs.length && vecs.length !== e.items.length) {
              throw new Error('Lists cannot mix numbers and points.');
            }
            if (new Set(vecs.map(it => it.items.length)).size > 1) {
              throw new Error('All points in a list need the same number of coordinates.');
            }
          }
          defs.lists.set(d.name, e);
          continue;
        }
        const store: Array<[string, Expr]> = [[d.name, e]];
        if (e.kind === 'vec') {
          if (e.items.length !== 2) throw new Error('A named point needs exactly 2 components.');
          const comps = pointComps(d.name);
          for (const c of comps) {
            if (byName.has(c)) {
              throw new Error(`Cannot name a point ${d.name}: ${c} is already defined.`);
            }
          }
          for (const item of e.items) {
            for (const fv of freeVars(item)) {
              if (fv === 'x' || fv === 'y') throw new Error('A point cannot depend on x or y.');
            }
          }
          defs.points.add(d.name);
          compOwner.set(comps[0], d.name);
          compOwner.set(comps[1], d.name);
          store.length = 0;
          store.push([comps[0], e.items[0]], [comps[1], e.items[1]]);
        }
        for (const [name, expr] of store) {
          defs.consts.set(name, expr);
          try {
            const env: Record<string, number> = {};
            for (const fv of freeVars(expr)) {
              if (!(fv in numEnv)) throw new Error('not static');
              env[fv] = numEnv[fv];
            }
            const v = evaluate(expr, env);
            if (isFinite(v)) numEnv[name] = v;
          } catch { /* time-dependent or forward-referencing: Σ bounds can't use it */ }
        }
      }
    } catch (e) {
      errors.set(defKey(d), msg(e));
      if (e instanceof MissingDataError) {
        needsFile.add(defKey(d));
        // The name still means something — a value whose file is elsewhere.
        // Registered so rows below report the file too, instead of "ages is
        // not defined", which sends the reader looking for a typo.
        //
        // Whether it is a LIST is read off the shape, the same way a filter's
        // is: `ages = person.age / 2` is one, `avg = mean(person.age)` is a
        // number. Calling a scalar a list would make it index here and
        // multiply on the device that has the bytes.
        if (d.kind === 'const') {
          const shape = parsed.get(defKey(d));
          defs.missingData.set(d.name, {
            message: e.message,
            list: shape ? staysList(shape, defs) : false,
          });
        }
      }
    }
  }

  // A bare point name surviving in a resolved expression means the point was
  // defined below its use, so lowering saw it as a scalar: report and drop.
  for (const [name, e] of [...defs.consts]) {
    for (const fv of freeVars(e)) {
      if (!defs.points.has(fv)) continue;
      const owner = compOwner.get(name) ?? name;
      errors.set(owner, `${fv} is a point — move its definition above ${owner}.`);
      if (defs.points.has(owner)) {
        defs.points.delete(owner);
        for (const c of pointComps(owner)) defs.consts.delete(c);
      } else {
        defs.consts.delete(owner);
      }
      break;
    }
  }

  // Vector states: a state whose derivative (or starting value) lowers to a
  // 2- or 3-vector integrates componentwise. The base name splits into the
  // scalar states om_1, om_2(, om_3) — the integrator and everything below
  // it see only those — and the name itself expands to its components
  // wherever expressions lower, exactly as a point name does, so `th' = om`
  // and `segment((0, 0), om)` both work.
  const vecOwnerKey = new Map<string, string>();
  {
    // Dims propagate (`th' = om` is scalar until om's own row makes om a
    // vector), so discovery iterates to a fixed point. Lowering failures
    // wait for the final pass below, where they are reported per row.
    for (let changed = true; changed;) {
      changed = false;
      for (const [name, e] of [...derivs, ...inits]) {
        if (defs.vecStates.has(name)) continue;
        try {
          const low = lowerGeom(e, n => compsOf(defs, n), n => defs.mats.get(n) ?? null);
          if (low.kind === 'vec') {
            defs.vecStates.set(name, low.items.length);
            changed = true;
          }
        } catch { /* reported below */ }
      }
    }

    // Final pass: lower every derivative and starting value against the full
    // component map, split vector ones, and swap the scalar results in.
    const flatDerivs = new Map<string, Expr>();
    const flatInits = new Map<string, Expr>();
    for (const [name, e] of derivs) {
      try {
        const low = lowerGeom(e, n => compsOf(defs, n), n => defs.mats.get(n) ?? null);
        const dim = defs.vecStates.get(name);
        if (dim === undefined) {
          flatDerivs.set(name, low);
          continue;
        }
        if (low.kind !== 'vec' || low.items.length !== dim) {
          const got = low.kind === 'vec' ? `${low.items.length} components` : 'a single number';
          throw new Error(`${name} is a ${dim}-component state, but ${name}' has ${got}.`);
        }
        const comps = vecStateComps(name, dim);
        for (const c of comps) {
          if (byName.has(c)) throw new Error(`Cannot make ${name} a vector state: ${c} is already defined.`);
        }
        comps.forEach((c, k) => {
          flatDerivs.set(c, (low as Expr & { kind: 'vec' }).items[k]);
          vecOwnerKey.set(c, name);
        });
      } catch (err) {
        defs.vecStates.delete(name);
        errors.set(name, msg(err));
      }
    }
    for (const [name, e] of inits) {
      const rowKey = `${name}(0)`;
      try {
        const low = lowerGeom(e, n => compsOf(defs, n), n => defs.mats.get(n) ?? null);
        const dim = defs.vecStates.get(name);
        if (dim === undefined) {
          if (low.kind === 'vec') throw new Error(`${name}(0) has ${low.items.length} components, but ${name} is a single number.`);
          flatInits.set(name, low);
          continue;
        }
        if (low.kind !== 'vec' || low.items.length !== dim) {
          const got = low.kind === 'vec' ? `has ${low.items.length} components` : 'is a single number';
          throw new Error(`${name} is a ${dim}-component state, but ${name}(0) ${got}.`);
        }
        vecStateComps(name, dim).forEach((c, k) => {
          flatInits.set(c, (low as Expr & { kind: 'vec' }).items[k]);
          vecOwnerKey.set(c, name);
        });
      } catch (err) {
        errors.set(rowKey, msg(err));
      }
    }
    derivs.clear();
    for (const [k, v] of flatDerivs) derivs.set(k, v);
    inits.clear();
    for (const [k, v] of flatInits) inits.set(k, v);
    // Downstream validation runs over the scalar components.
    stateNames.clear();
    for (const k of derivs.keys()) stateNames.add(k);
  }

  // A definition whose value depends on the plane — x or y, directly or via
  // another such definition — is a coordinate field, not a constant.
  const fieldNames = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, e] of defs.consts) {
      if (fieldNames.has(name)) continue;
      for (const fv of freeVars(e)) {
        if (fv === 'x' || fv === 'y' || fieldNames.has(fv)) {
          fieldNames.add(name);
          changed = true;
          break;
        }
      }
    }
  }
  // A point component that reaches x/y through another definition would
  // otherwise become a grid field; a point is a constant, so reject it.
  for (const name of [...fieldNames]) {
    const owner = compOwner.get(name);
    if (!owner || !defs.points.has(owner)) continue;
    errors.set(owner, 'A point cannot depend on x or y.');
    defs.points.delete(owner);
    for (const c of pointComps(owner)) {
      defs.consts.delete(c);
      fieldNames.delete(c);
    }
  }

  const constNames = new Set(raw.filter(d => d.kind === 'const' && !fieldNames.has(d.name)).map(d => d.name));
  // Point rows resolve to their component constants; dependencies see those.
  for (const p of defs.points) {
    constNames.delete(p);
    for (const c of pointComps(p)) constNames.add(c);
  }

  const pendingFields = new Map<string, Expr>();
  for (const [name, e] of defs.consts) {
    if (fieldNames.has(name)) pendingFields.set(name, e);
  }
  for (const name of pendingFields.keys()) defs.consts.delete(name);

  // Resolve field-to-field references so each field is a closed expression
  // in x, y, t, and constants.
  const fieldVisiting = new Set<string>();
  const resolveField = (name: string): Expr => {
    const hit = defs.fields.get(name);
    if (hit) return hit;
    if (fieldVisiting.has(name)) throw new Error(`${name} is defined in terms of itself.`);
    fieldVisiting.add(name);
    try {
      let e = pendingFields.get(name)!;
      const sub: Record<string, Expr> = {};
      for (const fv of freeVars(e)) {
        if (pendingFields.has(fv)) sub[fv] = resolveField(fv);
      }
      if (Object.keys(sub).length) e = substVars(e, sub);
      for (const fv of freeVars(e)) {
        if (fv !== 'x' && fv !== 'y' && fv !== 't' && !constNames.has(fv) && !stateNames.has(fv)) {
          throw new Error(`${name} defines a coordinate (it uses x/y), so it may only use x, y, t, and constants (found ${fv}).`);
        }
      }
      // Trial-evaluate to surface unsupported calls (re, im, …) now.
      const env: Record<string, number> = { x: 0.7, y: 0.4, t: 0 };
      for (const fv of freeVars(e)) env[fv] ??= 1;
      evaluate(e, env);
      defs.fields.set(name, e);
      return e;
    } finally {
      fieldVisiting.delete(name);
    }
  };
  for (const name of pendingFields.keys()) {
    try {
      resolveField(name);
    } catch (e) {
      errors.set(name, msg(e));
    }
  }
  // Grid families draw in definition order, not dependency-resolution order.
  const orderedFields = new Map<string, Expr>();
  for (const name of pendingFields.keys()) {
    const e = defs.fields.get(name);
    if (e) orderedFields.set(name, e);
  }
  defs.fields = orderedFields;

  // Constants may only depend on other constants, states, and time.
  for (const [name, e] of defs.consts) {
    for (const fv of freeVars(e)) {
      if (fv !== 't' && !constNames.has(fv) && !stateNames.has(fv)) {
        errors.set(name, fv === 'inf'
          ? `inf only works as an ∫ bound — write it inline: int[-inf..x] f(x) dx.`
          : `${name} can only depend on other constants and t (found ${fv}).`);
        defs.consts.delete(name);
        break;
      }
    }
  }

  // A list holds data: its elements may only use constants, states, and t.
  // (References to other lists never survive — lowering already inlined
  // any list defined above, and one defined below parses as a product and
  // lands in the constant check above.)
  // (A `data`/`text` list holds numbers and text, so it has no variables to
  // check — only the symbolic representation can name one.)
  outer: for (const [name, seq] of defs.lists) {
    if (seq.kind !== 'list') continue;
    for (const item of seq.items) {
      for (const fv of freeVars(item)) {
        if (fv !== 't' && !constNames.has(fv) && !stateNames.has(fv)) {
          errors.set(name, `${name} is a list, so its elements may only use constants and t (found ${fv}).`);
          defs.lists.delete(name);
          continue outer;
        }
      }
    }
  }

  // Trial-evaluate to surface cycles and unsupported calls at definition time.
  // States are leaves here: the integrator supplies their values, so they
  // stand in as 0 and never recurse.
  const check = (name: string, visiting: Set<string>): void => {
    const e = defs.consts.get(name);
    // A surviving list (or matrix) name means it was defined below its use,
    // so lowering saw it as a plain scalar.
    if (!e && (defs.lists.has(name) || defs.mats.has(name))) {
      throw new Error(`${name} is a ${defs.lists.has(name) ? 'list' : 'matrix'} — move its definition above where it is used.`);
    }
    if (!e) throw new Error(`${name} is not defined.`);
    if (visiting.has(name)) throw new Error(`${name} is defined in terms of itself.`);
    visiting.add(name);
    const env: Record<string, number> = { t: 0 };
    for (const fv of freeVars(e)) {
      if (fv !== 't') {
        if (!stateNames.has(fv)) check(fv, visiting);
        env[fv] = 0;
      }
    }
    visiting.delete(name);
    evaluate(e, env);
  };
  const bad = new Set<string>();
  for (const name of defs.consts.keys()) {
    try {
      check(name, new Set());
    } catch (e) {
      errors.set(name, msg(e));
      bad.add(name);
    }
  }
  for (const name of bad) defs.consts.delete(name);

  // States. A derivative sees time, constants, and the other states; an
  // initial value is read once at reset, so it must be constant. Vector
  // states validate per scalar component; their errors land on the base row.
  const stateRow = (n: string): string => vecOwnerKey.get(n) ?? n;
  for (const [name, deriv] of derivs) {
    try {
      if (defs.consts.has(name) || defs.fields.has(name)) {
        throw new Error(`${name} is already defined as a constant.`);
      }
      const env: Record<string, number> = { t: 0 };
      for (const fv of freeVars(deriv)) {
        if (fv !== 't' && !constNames.has(fv) && !stateNames.has(fv)) {
          throw new Error(`${stateRow(name)}' changes with time, so it may only use t, constants, and other states (found ${fv}).`);
        }
        env[fv] = 0;
      }
      evaluate(deriv, env); // surfaces unsupported calls (re, im, …) now
      let init = inits.get(name) ?? num(0);
      for (const fv of freeVars(init)) {
        if (!constNames.has(fv)) {
          errors.set(`${stateRow(name)}(0)`, `${stateRow(name)}(0) is a starting value, so it must be constant (found ${fv}).`);
          init = num(0);
          break;
        }
      }
      defs.states.set(name, { deriv, init });
    } catch (e) {
      errors.set(stateRow(name), msg(e));
    }
  }
  for (const name of inits.keys()) {
    if (!defs.states.has(name) && !errors.has(stateRow(name)) && !errors.has(`${stateRow(name)}(0)`)) {
      errors.set(`${stateRow(name)}(0)`, `${stateRow(name)}(0) is a starting value, but ${stateRow(name)}' is not defined.`);
    }
  }
  // A vector state that lost every component to errors is not a state at all.
  for (const [name, dim] of defs.vecStates) {
    if (!vecStateComps(name, dim).every(c => defs.states.has(c))) defs.vecStates.delete(name);
  }

  return { defs, errors, needsFile, sumBoundConsts: ropts.boundConsts! };
}

/**
 * Constants with no fixed value: those depending on t or on a state, directly
 * or through other constants. (Σ/Π bounds may not use them — expansion is
 * static.)
 */
export function animatedConstNames(defs: Defs): Set<string> {
  const out = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, e] of defs.consts) {
      if (out.has(name)) continue;
      for (const fv of freeVars(e)) {
        if (fv === 't' || out.has(fv) || defs.states.has(fv)) {
          out.add(name);
          changed = true;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Evaluate every constant at the given time (t may appear in definitions).
 * `seed` supplies values the definitions may read but not compute — the
 * integrator's current state — and is returned alongside them.
 */
export function evalConstEnv(defs: Defs, time: number, seed: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = { ...seed };
  const visiting = new Set<string>();
  const get = (name: string): number => {
    if (name in out) return out[name];
    const e = defs.consts.get(name);
    if (!e) throw new Error(`${name} is not defined.`);
    if (visiting.has(name)) throw new Error(`${name} is defined in terms of itself.`);
    visiting.add(name);
    try {
      const env: Record<string, number> = { t: time };
      for (const fv of freeVars(e)) if (fv !== 't') env[fv] = get(fv);
      return (out[name] = evaluate(e, env));
    } finally {
      visiting.delete(name);
    }
  };
  for (const name of defs.consts.keys()) get(name);
  return out;
}

/** True when any constant depends on time and so must be re-evaluated per frame. */
export function constsAnimated(defs: Defs): boolean {
  for (const e of defs.consts.values()) if (freeVars(e).has('t')) return true;
  return false;
}
