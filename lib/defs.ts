import { Env, type Components, type ValueDefinitions, lowerValueRef } from './env.ts';
import { childrenOf, LOOP_LIMIT, RECUR, isRecur } from './expr.ts';
import { mapChildren, structuralDiagnostic, legacyCallArgs } from './expr.ts';
import { exprKey } from './expr.ts';
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
 * - `grad(f)` (also ∇) expands to the tuple (∂f/∂x, ∂f/∂y) the same way, so
 *   it plots as a vector field.
 * - `sum(n=1..N, …)` / `prod(…)` (also Σ/Π, and `sum[n=1..N] …` binding the
 *   trailing product like d/dx) expand symbolically at resolve time, so the
 *   bounds must be numbers or already-known constants. A bound that uses a
 *   sequence index (`a_n = Σ(s=1..n, s)`) is left as a sum and evaluated
 *   per term instead.
 * - `int(f dx)` / `int[a..b] f dx` (also ∫) integrate at resolve time:
 *   symbolically when integrate.ts finds a verified antiderivative, and
 *   otherwise by expanding a fixed Gauss–Legendre sum the same way Σ
 *   expands — so every downstream consumer still sees ordinary expressions.
 */
import { type SeqScan, sequenceResolver } from './seq.ts';
import { lowerObjects } from './object-lists.ts';
import { type Column, type Table, filterTable } from './csv.ts';
import { NonSmoothError, add, diff, div, mul, neg, pow, sub } from './diff.ts';
import { FUNCTIONS, NAME_SRC, SHADOWABLE_FNS, SUM_MAX_TERMS, type Expr, builtinFn, canonicalName, compDims, evaluate, markOrigins, freeVars, ineqComparisons, parseExpr, revolveAxis, sameList, substVars } from './expr.ts';
import { HASH_TOKEN_LEN, shortHash } from './hash.ts';
import { QUAD_TERMS, antiderivative, improperSum, quadratureSum, verifyDefinite } from './integrate.ts';
import type { IntShade, ResolvedRow } from './intshade.ts';
import { lowerGeom, lowerMatrix, pointComps, rowsAsPoints, vecStateComps } from './geom.ts';
import { type GetList, type Seq, NO_LIST_INSIDE, SCALAR_REDUCTIONS, SLICE, axesOf, isDataScatter, isSeq, lowerLists, lowerMask, namedAxes, plainFnName, withAxes } from './list.ts';
import { type Mat, matrixFromList } from './mat.ts';
import { type RegressionRow, type FitResult, fitRegression } from './regression.ts';

/** The axis variables: a definition reaching one is a coordinate field. */
const SPACE: ReadonlySet<string> = new Set(['x', 'y', 'z']);

export type Definition =
  | RegressionRow
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
  /** The function now being resolved, seen from inside its own body: a call
   *  becomes a RECUR marker, and the finished body wraps into a loop. */
  recursive?: boolean;
}

/**
 * A body that calls its own function runs as a bounded loop, provided every
 * self-call is a whole case of the body's {…} (tail position): the call's
 * arguments are then simply the next pass's parameters. Anything else —
 * `n f(n - 1)`, a call inside a condition — would need a stack per pixel.
 */
function wrapRecursion(name: string, params: string[], body: Expr): Expr {
  const p = params[0] ?? 'n';
  const check = (e: Expr, tail: boolean): void => {
    if (isRecur(e)) {
      if (!tail) throw new Error(`${name} can only call itself as a whole case of {…}, like ${name}(${p}) = {${p} <= 1: 1, ${name}(${p} - 1)}.`);
      return;
    }
    if (e.kind === 'piecewise' && tail) {
      for (const c of e.cases) { check(c.cond, false); check(c.value, true); }
      if (e.otherwise) check(e.otherwise, true);
      return;
    }
    // A loop already inlined here (a call to another recursive function)
    // owns the markers in its body; only its seeds are this function's.
    if (e.kind === 'loop') { for (const seed of e.seeds) check(seed, false); return; }
    for (const child of childrenOf(e)) check(child, false);
  };
  check(body, true);
  return { kind: 'loop', params, seeds: params.map(name => ({ kind: 'var', name })), body, limit: LOOP_LIMIT };
}

/** Whether `e` calls the function being defined. Markers inside an inlined
 * loop's body belong to that loop, so only its seeds count. */
const containsRecur = (e: Expr): boolean => isRecur(e)
  || (e.kind === 'loop' ? e.seeds.some(containsRecur) : childrenOf(e).some(containsRecur));

export interface StateDef {
  /** da/dt, resolved. Free vars in {t, constants, states}. */
  deriv: Expr;
  /** a at reset, resolved. Free vars in {constants}. */
  init: Expr;
}

/** Temporary construction scratch: never returned, retained, or used at runtime.
 * Only complete validated owners are committed to Env below. */
interface BindingDraft {
  sequences: Map<string, SeqScan>;
  sequencePrefix: string;
  consts: Map<string, Expr>;
  fields: Map<string, Expr>;
  fns: Map<string, FnDef>;
  points: Set<string>;
  pointDims: Map<string, number>;
  states: Map<string, StateDef>;
  vecStates: Map<string, number>;
  mats: Map<string, Mat>;
  lists: Map<string, Seq | (Expr & { kind: 'vec' })>;
  missingData: Map<string, { message: string; list: boolean }>;
  tables: Map<string, TableDef>;
}

export interface TableDef {
  file: string;
  hash: string;
  data: Table | null;
  /** Why `data` is null, phrased for wherever this ran. */
  missing?: string;
}

const emptyDraft = (): BindingDraft => ({
  consts: new Map(),
  fns: new Map(),
  fields: new Map(),
  sequences: new Map(),
  sequencePrefix: 'eqioSeq',
  points: new Set(),
  pointDims: new Map(),
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
/** Character counts are stable for a parsed column, including filtered copies. */
const colLengths = new WeakMap<Column, Float64Array>();

function textLengths(col: Column): Float64Array {
  let values = colLengths.get(col);
  if (!values) {
    values = Float64Array.from(col.strs!, text => {
      // CSV blanks are missing values, not empty strings to count as zero.
      if (!text) return NaN;
      let length = 0;
      for (const _char of text) length++; // Unicode code points, not UTF-16 units
      return length;
    });
    colLengths.set(col, values);
  }
  return values;
}

export function columnExprs(col: Column): Expr[] {
  let hit = colExprs.get(col);
  if (!hit) {
    hit = [...col.nums!].map((value): Expr => ({ kind: 'num', value }));
    colExprs.set(col, hit);
  }
  return hit;
}

/**
 * `P.x`, `P.y`, `P.z` of a named point list: the list of that coordinate,
 * over P's own instances — so `(P.x, P.y - (m P.x + b))` and
 * `P.y ~ m P.x + b` pair up point by point, the way a data file's columns
 * do. (Two separately written lists `X`, `Y` are independent and cross.)
 */
function pointColumn(defs: ValueDefinitions, name: string, axis: string): Seq | null {
  // Two or three 2D points — three 3D ones — read as a matrix; its rows are
  // the same points.
  const mat = defs.mats.get(name);
  const points = mat ? rowsAsPoints(mat, name) : defs.lists.get(name);
  if (!points || points.kind !== 'list') return null;
  const k = ['x', 'y', 'z'].indexOf(axis);
  const dims = new Set(points.items.map(p => (p.kind === 'vec' ? p.items.length : 0)));
  if (!points.items.length || dims.has(0)) {
    throw new Error(`${name}.${axis} reads a coordinate of a list of points; ${name} is a list of numbers.`);
  }
  const dim = Math.min(...dims);
  if (k < 0 || k >= dim) {
    throw new Error(`${name} is a list of ${dim}D points: its coordinates are ${['x', 'y', 'z'].slice(0, dim).map(c => `${name}.${c}`).join(', ')}.`);
  }
  return withAxes({ kind: 'list', items: points.items.map(p => (p as Expr & { kind: 'vec' }).items[k]) }, namedAxes(name, points));
}

/**
 * Resolve a name to list elements: a named list, or a data column written
 * `table.column`. Throws (rather than returning null) when the name clearly
 * means a column but cannot produce one, so the row explains itself.
 */
export function listGetter(defs: ValueDefinitions): GetList {
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
    if (!table) return pointColumn(defs, name.slice(0, dot), name.slice(dot + 1));
    const path = name.slice(dot + 1);
    const length = path.endsWith('.length');
    const col = length ? path.slice(0, -'.length'.length) : path;
    if (!table.data) throw new MissingDataError(table.missing ?? `${table.file} is not loaded.`);
    const found = table.data.columns.find(c => c.name === col);
    if (!found) {
      throw new Error(`${table.file} has no column "${col}" (columns: ${table.data.columns.map(c => c.name).join(', ')}).`);
    }
    // Every column of one file runs over the same instances — its rows — so
    // (person.age, person.height) pairs up however the columns are combined.
    const rows = [{ id: `${name.slice(0, dot)}.`, n: table.data.rows }];
    if (length) {
      if (found.type !== 'str') {
        throw new Error(`${name} counts characters — ${name.slice(0, -'.length'.length)} is a numeric column.`);
      }
      if (table.data.rows > TABLE_MAX_ROWS) {
        throw new Error(`${table.file} has ${table.data.rows} rows; plotting is limited to ${TABLE_MAX_ROWS}.`);
      }
      return withAxes({ kind: 'data', values: textLengths(found) }, rows);
    }
    // A text column is a list too — of text. Only comparisons accept one
    // (list.ts); everything numeric says so where it is used.
    if (found.type !== 'num') return withAxes({ kind: 'text', values: found.strs! }, rows);
    if (table.data.rows > TABLE_MAX_ROWS) {
      throw new Error(`${table.file} has ${table.data.rows} rows; plotting is limited to ${TABLE_MAX_ROWS}.`);
    }
    // The column's own array, never mutated downstream: every operation in
    // list.ts allocates its result.
    return withAxes({ kind: 'data', values: found.nums! }, rows);
  };
}

/** Every name that reads as a list, so `L[2]`, `person.age[2]` and
 *  `person[…]` index instead of multiplying (parseExpr needs this before it
 *  parses). Table names count: a data file is indexed by a filter. */
export function listNamesOf(defs: ValueDefinitions): Set<string> {
  const out = new Set([...defs.mats.keys(), ...defs.lists.keys(), ...[...defs.sequences.keys()].map(n => n + '_')]);
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
 * Whether a name reads as a list — what `d/dx L` asks before it differentiates.
 *
 * A dotted path counts when its HEAD is known, not only the full path: without
 * the bytes there is no column list to enumerate, and answering "no" there
 * made `d/dx person.age` refuse on the author's device and quietly answer 0
 * in the same graph shared, previewed, or read through the MCP server. Same
 * rule, and the same reason, as `indexes` in expr.ts.
 */
export const isListName = (names: ReadonlySet<string>, n: string): boolean => {
  if (names.has(n)) return true;
  const dot = n.indexOf('.');
  return dot > 0 && names.has(n.slice(0, dot));
};

/**
 * Of the names a document binds as values, the ones a late-addition builtin
 * would otherwise claim — what parseExpr needs to keep `total = 3` followed by
 * `total(x + 1)` the product it was before `total` became a reduction.
 *
 * Folded through `builtinFn`, because that is how a call is read: `Total = 3`
 * is a legal definition and `Total(x + 1)` folds to the `total` builtin, so
 * only the folded name says which builtin this document has taken.
 */
export const shadowedFnNames = (names: Iterable<string>): Set<string> => {
  const out = new Set<string>();
  for (const n of names) {
    const b = builtinFn(n);
    if (b && SHADOWABLE_FNS.has(b)) out.add(b);
  }
  return out;
};

/**
 * Whether a name is already spoken for — what a `~` row asks before claiming
 * one. Shared by the app and the worker because it drifted while it was
 * written out twice, and because it must answer the same on both.
 *
 * `missingData` counts. A definition whose file is absent still claims its
 * name — that is why rows below it report the file rather than "not defined"
 * — so leaving it out would let `ages ~ Normal(0, 1)` stand next to
 * `ages = person.age / 2` in a shared link and be rejected as "already
 * defined" by the one person who has the CSV.
 */
const draftNameTaken = (defs: ValueDefinitions, n: string): boolean =>
  defs.consts.has(n) || defs.fns.has(n) || defs.fields.has(n) || defs.states.has(n)
  || defs.points.has(n) || defs.mats.has(n) || defs.lists.has(n) || defs.tables.has(n)
  || defs.missingData.has(n);

/**
 * Whether this side of a comparison is still a list by the time the
 * comparison sees it — the question list.ts answers by lowering, asked here
 * of the shape alone, because on a device without the bytes there is nothing
 * to lower. Arithmetic and scalar functions map over a list; a reduction or
 * an index collapses one, and `[ ]` is itself a filter.
 */
function staysList(e: Expr, defs: ValueDefinitions): boolean {
  switch (e.kind) {
    case 'var':
    {
      if (defs.lists.has(e.name) || defs.missingData.get(e.name)?.list === true) return true;
      const dot = e.name.indexOf('.');
      if (dot <= 0) return false;
      // `P.x` of a point list — including one short enough to read as a matrix.
      const head = e.name.slice(0, dot);
      return defs.tables.has(head) || defs.lists.has(head) || defs.mats.has(head);
    }
    case 'list':
    case 'data':
    case 'text': return true;
    case 'neg': return staysList(e.a, defs);
    case 'bin': return staysList(e.a, defs) || staysList(e.b, defs);
    case 'call':
      // A reduction answers with one number however long its argument is,
      // and `[at]`/`[index]` pick one element out.
      if (SCALAR_REDUCTIONS.has(e.name)) return false;
      if ((e.name === 'min' || e.name === 'max') && e.args.length === 1) return false;
      // hist is a whole plot, not a value — list.ts refuses it in a filter
      // once the bytes are here, so it must not look list-shaped before then.
      if (e.name === 'hist') return false;
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
const isComparison = (e: Expr): e is Expr & { kind: 'ineq' | 'eqtest' } =>
  e.kind === 'ineq' || (e.kind === 'eqtest');

/** A comparison that decides the same answer for every element is not a
 *  filter, whatever it mentions — `L[1 < 2]`, `L[mean(L) > 0]`, `L[L[1] > 0]`. */
const DEAD_FILTER = 'A filter has to test the list itself, like L[L > 2]'
  + ' — this one answers the same for every element.';

/**
 * What is wrong with the index in `L[idx]`, judged by shape alone — or null.
 * The other half of the `[…]` syntax from checkFilterShape below, and the same
 * reasoning: list.ts settles these by lowering, which needs the bytes, and a
 * question answered only where the file is makes a link valid on one device
 * and broken on the next. So `person.age[person.age]` is a slice everywhere,
 * and `person.age[1 < 2]` is a dead filter everywhere, rather than reported as
 * merely device-local in a shared link and refused for the author.
 */
export function indexIssue(idx: Expr, defs: ValueDefinitions): string | null {
  const inside = wholePlotOverList(idx, defs);
  if (inside) return `Lists cannot appear inside ${inside}(…).`;
  if (!isComparison(idx)) return staysList(idx, defs) ? SLICE : null;
  const operands = idx.kind === 'ineq'
    ? ineqComparisons(idx).flatMap(c => [c.l, c.r])
    : idx.args;
  return operands.some(a => staysList(a, defs)) ? null : DEAD_FILTER;
}

/**
 * A whole-plot form with a list inside it — `domain(person.age)`, and the
 * geometry statements — named as list.ts names it when the bytes are here.
 * Answered from the shape alone, so `person[domain(person.age) > 0]` is
 * refused on the device that cannot lower it as well as on the one that can.
 */
function wholePlotOverList(e: Expr, defs: ValueDefinitions): string | null {
  if (e.kind === 'call') {
    if (NO_LIST_INSIDE.has(e.name) && e.args.some(a => staysList(a, defs))) {
      return plainFnName(e.name);
    }
    for (const a of e.args) {
      const hit = wholePlotOverList(a, defs);
      if (hit) return hit;
    }
    return null;
  }
  const kids = childrenOf(e);
  for (const k of kids) {
    const hit = wholePlotOverList(k, defs);
    if (hit) return hit;
  }
  return null;
}

function checkFilterShape(cond: Expr, defs: ValueDefinitions, shape: string): void {
  if (!isComparison(cond)) throw new Error(shape);
  const inside = wholePlotOverList(cond, defs);
  if (inside) throw new Error(`Lists cannot appear inside ${inside}(…).`);
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
function filteredTable(e: Expr, defs: ValueDefinitions, opts: ResolveOpts): TableDef | null {
  if (e.kind !== 'index' || e.args[0]?.kind !== 'var') return null;
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
export const compsOf = (defs: ValueDefinitions, name: string): readonly string[] | null => {
  if (defs instanceof Env) {
    const value = lowerValueRef(defs, name);
    return value.kind === 'vec' ? value.items.map(e => (e as Expr & { kind: 'var' }).name) : null;
  }
  return defs.points.has(name) ? pointComps(name, defs.pointDims.get(name))
    : defs.vecStates.has(name) ? vecStateComps(name, defs.vecStates.get(name)!) : null;
};

/** Synthetic field names of named vectors (`s_x`, `s_y` for `s = (x, y)`).
 *  They substitute like coordinate fields but are not user-written grids. */
export const pointComponentNames = (defs: ValueDefinitions): Set<string> => {
  const out = new Set<string>();
  for (const p of defs.points) {
    for (const c of pointComps(p, defs.pointDims.get(p))) out.add(c);
  }
  return out;
};

/**
 * Names with built-in meaning that definitions may not shadow.
 *
 * `open` is deliberately NOT one of them, common as it is in data (a price
 * series names a column that). A row is a data file because of its SHAPE —
 * `name = open("file.csv")`, matched before the function and constant forms —
 * so a graph that says `open = 3` keeps the slider it was shared with, and a
 * graph that says `open(f) = f` keeps its function; only the quoted-file-name
 * shape belongs to the data syntax.
 */
export const RESERVED = new Set(['x', 'y', 'z', 'u', 'v', 't', 'w', 'i', 'd', 'e', 'pi', 'tau']);

const FN_RE = new RegExp(String.raw`^\s*(${NAME_SRC})\s*\(\s*(${NAME_SRC}(?:\s*,\s*${NAME_SRC})*)\s*\)\s*=(?!=)([\s\S]+)$`);
const CONST_RE = new RegExp(String.raw`^\s*(${NAME_SRC})\s*=(?!=)([\s\S]+)$`);
const STATE_RE = new RegExp(String.raw`^\s*(${NAME_SRC})'\s*=(?!=)([\s\S]+)$`);
const INIT_RE = new RegExp(String.raw`^\s*(${NAME_SRC})\s*\(\s*0\s*\)\s*=(?!=)([\s\S]+)$`);
/**
 * `person = open("people.csv", 3a7f9c…)` — the hash is optional as typed;
 * the app fills it in from the file it finds (like a slider's write-back).
 *
 * At least `HASH_TOKEN_LEN` hex digits, because a row is resolved by hash
 * *prefix*: a shorter token can match more than one stored file, and binding
 * a row to the wrong bytes is the exact failure the pin exists to prevent.
 */
const TABLE_RE = new RegExp(
  String.raw`^\s*(${NAME_SRC})\s*=\s*open\s*\(\s*(?:"([^"]*)"|'([^']*)')\s*(?:,\s*([0-9a-fA-F]{${HASH_TOKEN_LEN},64})\s*)?\)\s*$`,
);

/**
 * The name a file is stored and written under. A row quotes the file name
 * with no escape (`open("sales.csv")`), so a name holding a quote or a line
 * break could not be read back — and a row that cannot be read back is worse
 * than one whose title lost a character. Applied at ingest, so what is stored
 * and what the row says are the same string, and re-dropping the file matches.
 *
 * `;` used to go the same way, because the link codec could not tell a data
 * semicolon from the separator between rows; now it can (lib/link.ts), so
 * `sales;2026.csv` keeps its name.
 */
export const rowSafeFileName = (name: string): string =>
  name.replace(/["\r\n\t]+/g, '_').trim() || 'data.csv';

/** A row that means to open a file, whether or not it succeeds at saying so. */
const OPEN_HEAD_RE = new RegExp(String.raw`^\s*(${NAME_SRC})\s*=\s*open\s*\(\s*["']`);

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

/**
 * A definable name for a dropped file, starting from the one its file name
 * suggests: the stem itself where a definition may claim it, `data_…` where it
 * may not, then numbered until nothing else has taken it.
 *
 * Both halves matter, because numbering alone cannot rescue every stem: no
 * `u_2`, `u_3`, … is nameable either (they all read as uniforms), so `u.csv`
 * sent the search for a free name round forever and froze the tab — after the
 * bytes were already stored. `data_u` is nameable, and so is every number
 * after it.
 */
export function freeTableName(base: string, taken: ReadonlySet<string>): string {
  const stem = nameable(base) ? base : `data_${base}`;
  if (!taken.has(stem)) return stem;
  for (let k = 2; ; k++) {
    const name = `${stem}_${k}`;
    if (!taken.has(name)) return name;
  }
}

/** Detect a definition row before parsing (so calls to it parse everywhere). */
export function scanDefinition(text: string): Definition | null {
  // Captured names canonicalize (T₀ → T_0) so a definition binds the same
  // name the tokenizer reads in expressions.
  const name = (m: RegExpExecArray): string => canonicalName(m[1]);
  // Primes first: `a' = …` is a state, but the reserved coordinate names keep
  // their ODE meaning, so `y' = x - y` stays a slope field (see plot.ts).
  let m = STATE_RE.exec(text);
  if (m && nameable(name(m))) return { kind: 'state', name: name(m), rhs: m[2] };
  m = INIT_RE.exec(text);
  if (m && nameable(name(m))) return { kind: 'init', name: name(m), rhs: m[2] };
  // Before the function form: `open(…)` takes a file name, not parameters.
  m = TABLE_RE.exec(text);
  if (m && nameable(name(m))) {
    return { kind: 'table', name: name(m), file: m[2] ?? m[3], hash: (m[4] ?? '').toLowerCase() };
  }
  // A row that plainly means to open a file but does not parse as one is NOT
  // a constant: `p = open("a.csv", abc123)` would otherwise be scanned as a
  // definition, and the row validator — the only thing that can explain the
  // short hash — never runs on definition rows. Leave it to badTableRow.
  if (OPEN_HEAD_RE.test(text)) return null;
  m = FN_RE.exec(text);
  if (m && nameable(name(m))) {
    return { kind: 'fn', name: name(m), params: m[2].split(/\s*,\s*/).map(canonicalName), rhs: m[3] };
  }
  m = CONST_RE.exec(text);
  if (m && nameable(name(m))) return { kind: 'const', name: name(m), rhs: m[2] };
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
  sequenceTerm?: (name: string, index?: Expr) => Expr | null;
  /** Definition values cannot contain row-only motion trails. */
  inDefinition?: boolean;
  /** Numeric constant values, used to evaluate Σ/Π bounds at expansion time. */
  consts?: Record<string, number>;
  /** Out: constant names referenced by Σ/Π bounds (their sliders snap to integers). */
  boundConsts?: Set<string>;
  /**
   * Names a Σ/Π bound may use without a static value — the sequence index,
   * and the index of a sum that itself could not expand yet. The sum stays
   * a call and evaluate() runs it.
   */
  openVars?: ReadonlySet<string>;
  /**
   * Whether a name is a list. Derivatives expand HERE, before list.ts
   * substitutes, so without this `d/dt L` differentiates `L` as an opaque
   * variable and quietly becomes 0.
   */
  isList?: (name: string) => boolean;
  /**
   * What is wrong with `L[idx]` judged by SHAPE alone — a slice, a filter no
   * list reaches, a whole-plot call over one — or null if nothing is. Asked
   * before list.ts lowers anything, because lowering needs the bytes and the
   * answer must not: see indexIssue.
   */
  indexIssue?: (idx: Expr) => string | null;
}

interface Ctx {
  getFn: GetFn;
  opts: ResolveOpts;
  /** Terms expanded so far across every Σ/Π in this resolve (nesting multiplies). */
  terms: number;
  /** Out (resolveRow): every ∫ this resolve expanded — its resolved pieces
   *  when it is a plain definite integral, null otherwise (indefinite, or
   *  carrying an enclosing integral's measure). */
  ints?: Array<IntShade | null>;
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
export function substIdx(e: Expr, idx: string, val: Expr): Expr {
  switch (e.kind) {
    case 'index': case 'range': case 'eqtest': case 'comp': case 'figure': case 'trail': case 'hist': case 'family': return mapChildren(e, x => substIdx(x, idx, val));
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
    case 'list': return sameList(e, { kind: 'list', items: e.items.map(a => substIdx(a, idx, val)) });
    case 'data':
    case 'str':
    case 'text': return e;
    case 'piecewise': return {
      kind: 'piecewise',
      cases: e.cases.map(c => ({ cond: substIdx(c.cond, idx, val), value: substIdx(c.value, idx, val) })),
      otherwise: e.otherwise && substIdx(e.otherwise, idx, val),
    };
    // A loop's params rebind inside its body: substitute in the seeds only.
    case 'loop': return { ...e, seeds: e.seeds.map(a => substIdx(a, idx, val)), body: e.params.includes(idx) ? e.body : substIdx(e.body, idx, val) };
  }
}

const FOLD_BUILD = { '+': add, '-': sub, '*': mul, '/': div, '^': pow } as const;

/**
 * Fold numeric subtrees ((2·3-1) → 5) so expanded Σ terms compile to compact
 * GLSL. With `calls`, a call whose arguments all folded (cos(1/3)) folds too,
 * for consumers that evaluate the tree on the CPU rather than emit it.
 */
export function foldNums(e: Expr, calls = false): Expr {
  const fold = (x: Expr) => foldNums(x, calls);
  switch (e.kind) {
    case 'index': case 'range': case 'eqtest': case 'comp': case 'figure': case 'trail': case 'hist': case 'family': return mapChildren(e, fold);
    case 'num':
    case 'var':
      return e;
    case 'neg': return neg(fold(e.a));
    case 'bin': {
      const a = fold(e.a);
      const b = fold(e.b);
      if (a.kind === 'num' && b.kind === 'num') {
        const v = evaluate({ kind: 'bin', op: e.op, a, b }, {});
        if (isFinite(v)) return num(v);
      }
      return FOLD_BUILD[e.op](a, b);
    }
    case 'call': {
      const out: Expr = { kind: 'call', name: e.name, args: e.args.map(fold) };
      if (calls && out.args.length && out.args.every(a => a.kind === 'num')) {
        try {
          const v = evaluate(out, {});
          if (isFinite(v)) return num(v);
        } catch { /* not a scalar builtin: the interpreter keeps it */ }
      }
      return out;
    }
    case 'eq': return { kind: 'eq', l: fold(e.l), r: fold(e.r) };
    case 'ineq': return { kind: 'ineq', op: e.op, l: fold(e.l), r: fold(e.r) };
    case 'vec': return { kind: 'vec', items: e.items.map(fold) };
    case 'list': return sameList(e, { kind: 'list', items: e.items.map(fold) });
    case 'data':
    case 'str':
    case 'text': return e;
    case 'piecewise': return {
      kind: 'piecewise',
      cases: e.cases.map(c => ({ cond: fold(c.cond), value: fold(c.value) })),
      otherwise: e.otherwise && fold(e.otherwise),
    };
    case 'loop': return mapChildren(e, foldNums);
  }
}

/**
 * freeVars of an UNRESOLVED source. A Σ/Π index or an ∫'s measure variable
 * is the binder's own name, not a reference — including in the chain forms
 * (`sum[n=1..5] n`, `int[0..1] w^2 dw`), where the body is still a sibling
 * factor that plain freeVars would read as free.
 */
function sourceFreeVars(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.kind) {
    case 'var': out.add(e.name); return out;
    case 'bin': {
      if (e.op === '*' || e.op === '/') {
        const m = splitSumChain(e);
        if (m) {
          if (m.coeff) sourceFreeVars(m.coeff, out);
          const canonical: Expr = isSumHeader(m.header)
            ? { kind: 'call', name: m.header.name, args: [...m.header.args, m.body] }
            : intCallOf(m.header, m.body);
          return sourceFreeVars(canonical, out);
        }
      }
      sourceFreeVars(e.a, out);
      return sourceFreeVars(e.b, out);
    }
    case 'call': {
      if ((e.name === 'sum' || e.name === 'prod') && e.args.length === 4 && e.args[0].kind === 'var') {
        sourceFreeVars(e.args[1], out);
        sourceFreeVars(e.args[2], out);
        const inner = sourceFreeVars(e.args[3]);
        inner.delete(e.args[0].name);
        for (const v of inner) out.add(v);
        return out;
      }
      if (e.name === 'int' && (e.args.length === 1 || e.args.length === 3)) {
        const bodyAt = e.args.length - 1;
        for (let k = 0; k < bodyAt; k++) sourceFreeVars(e.args[k], out);
        let dx: StripDx | null = null;
        try { dx = stripDx(e.args[bodyAt]); } catch { /* expansion reports it */ }
        const inner = sourceFreeVars(e.args[bodyAt]);
        if (dx) { inner.delete(dx.v); inner.delete(`d${dx.v}`); }
        for (const v of inner) out.add(v);
        return out;
      }
      break;
    }
    default: break;
  }
  for (const child of childrenOf(e)) sourceFreeVars(child, out);
  return out;
}

const SUM_MAX_TOTAL = 2000;
/** Runs one state family may start: the point-figure family budget. */
const FAMILY_MAX = 1024;

/** Expand a Σ/Π into an explicit sum/product of per-index terms. */
function expandSum(header: SumCall, body: Expr, ctx: Ctx): Expr {
  const sym = header.name === 'sum' ? 'Σ' : 'Π';
  // A literal in the body is written once: every term's copy is that one
  // list, so the terms pair up element by element rather than crossing.
  markOrigins(body);
  const [idxE, loE, hiE] = header.args;
  if (idxE.kind !== 'var') throw new Error(`Expected ${header.name}(n=1..N, …).`);
  const idx = idxE.name;
  if (RESERVED.has(idx)) throw new Error(`Cannot use "${idx}" as a ${sym} index (it is reserved).`);
  // A bound that uses an open name (the sequence index) cannot be expanded
  // here: the sum stays a call and evaluate() runs it once that name is a number.
  const bound = (b: Expr): { expr: Expr; value?: number } => {
    const r = rx(b, ctx);
    const env: Record<string, number> = {};
    let open = false;
    for (const fv of freeVars(r)) {
      const v = ctx.opts.consts?.[fv];
      if (v !== undefined) {
        ctx.opts.boundConsts?.add(fv);
        env[fv] = v;
        continue;
      }
      if (ctx.opts.openVars?.has(fv)) { open = true; continue; }
      if (fv === 't' || RESERVED.has(fv)) throw new Error(`${sym} bounds cannot depend on ${fv}.`);
      throw new Error(`${sym} bounds must be constant — add "${fv} = 5" in a row above.`);
    }
    if (open) return { expr: r };
    const v = evaluate(r, env);
    if (!isFinite(v)) throw new Error(`${sym} bound is not finite.`);
    return { expr: r, value: v };
  };
  const lo = bound(loE);
  const hi = bound(hiE);
  if (lo.value === undefined || hi.value === undefined) {
    const saved = ctx.opts;
    const openVars = new Set(saved.openVars);
    openVars.add(idx);
    ctx.opts = { ...saved, openVars };
    try {
      return { kind: 'call', name: header.name, args: [{ kind: 'var', name: idx }, lo.expr, hi.expr, rx(body, ctx)] };
    } finally {
      ctx.opts = saved;
    }
  }
  const start = Math.ceil(lo.value - 1e-9);
  const end = Math.floor(hi.value + 1e-9);
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
  ctx.ints?.push(lo && hi && !m.residual ? { body: integrand, v, lo, hi } : null);
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
  const memoKey = exprKey([v, integrand, lo, hi]);
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
    if (exprKey(out).length > 400_000) {
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
    case 'index': case 'range': case 'eqtest': case 'comp': case 'figure': case 'trail': case 'hist': case 'family': return childrenOf(e).some(usesIntegral);
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
    case 'loop': return childrenOf(e).some(usesIntegral);
  }
}

/**
 * Resolve a whole row, also reporting the ∫ it consists of: `integral` is set
 * when the parsed row is exactly one definite integral — `int[a..b] f dx` or
 * `int(a..b, f dx)` standing alone — and that was the ONLY ∫ the resolution
 * expanded. A coefficient, a sum of integrals, an iterated or nested ∫ and an
 * indefinite ∫ all report null, because no single region IS their value. The
 * pieces are the ones expandInt itself resolved, not a second resolution.
 * classifyRow (lib/plot.ts) turns them into the area a value row shades.
 */
export function resolveRow(e: Expr, getFn: GetFn, opts: ResolveOpts = {}): ResolvedRow {
  const ctx: Ctx = { getFn, opts, terms: 0, ints: [] };
  const expr = rx(e, ctx);
  const m = splitSumChain(e);
  const call = !m ? e : !m.coeff && isIntHeader(m.header) ? intCallOf(m.header, m.body) : null;
  const sole = call?.kind === 'call' && call.name === 'int' && call.args.length === 3 && ctx.ints!.length === 1;
  return { expr, integral: sole ? ctx.ints![0] : null };
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
    case 'num': return e;
    case 'var': return ctx.opts.sequenceTerm?.(e.name) ?? e;
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
    case 'index': {
      if (e.args[0]?.kind === 'var') {
        const term = ctx.opts.sequenceTerm?.(e.args[0].name, e.args[1]);
        if (term) return term;
      }
      return mapChildren(e, x => rx(x, ctx));
    }
    case 'range': throw new Error(structuralDiagnostic(e));
    case 'comp': case 'eqtest': case 'figure': case 'trail': case 'hist': case 'family': return mapChildren(e, x => rx(x, ctx));
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
      const args = legacyCallArgs(e.name, e.args).map(x => rx(x, ctx));
      const fn = getFn(e.name);
      if (fn) {
        const n = fn.params.length;
        if (fn.recursive) {
          // f((a, b)) ≡ f(a, b), as for any other call with a tuple in hand.
          const splat = args.length === 1 && n >= 2 && args[0].kind === 'vec' ? args[0].items : args;
          if (args.length === 1 && n >= 2 && args[0].kind === 'vec' && splat.length !== n) throw new Error(compDims(e.name, n, args[0], splat.length));
          if (splat.length !== n) throw new Error(`${e.name} takes ${n} argument${n === 1 ? '' : 's'}.`);
          return { kind: 'call', name: RECUR, args: splat };
        }
        if (args.length === 1 && n >= 2 && args[0].kind !== 'num') {
          // f(P) ≡ f(P_1, …, P_n): one argument that is an n-component point
          // (or a list of them; a plain number is neither, and falls through to
          // the arity error). A tuple in hand gives up its items; anything
          // else is not known to be a point until it lowers, so each parameter
          // asks for its component of the SAME node — which is what keeps a
          // list argument's components moving together.
          const [arg] = args;
          markOrigins(arg);
          if (arg.kind === 'vec' && arg.items.length !== n) throw new Error(compDims(e.name, n, arg, arg.items.length));
          const comp = (k: number): Expr => (arg.kind === 'vec' ? arg.items[k]
            : { kind: 'comp', value: arg, index: k, arity: n, functionName: e.name });
          return substVars(fn.body, Object.fromEntries(fn.params.map((p, k) => [p, comp(k)])));
        }
        if (args.length !== n) {
          throw new Error(`${e.name} takes ${n} argument${n === 1 ? '' : 's'}.`);
        }
        return substVars(fn.body, Object.fromEntries(fn.params.map((p, k) => [p, args[k]])));
      }
      if (e.name === 'grad') {
        if (args.length !== 1) throw new Error('grad takes one expression: grad(x^2 + y^2).');
        const f = args[0];
        if (f.kind === 'vec' || f.kind === 'list' || f.kind === 'eq' || f.kind === 'ineq') {
          throw new Error('grad needs a scalar expression in x and y, like grad(x^2 + y^2).');
        }
        // ∇f as a tuple, so it plots as a vector field and feeds dot(…) like
        // any other; z joins only when f uses it.
        const vars = freeVars(f).has('z') ? ['x', 'y', 'z'] : ['x', 'y'];
        return { kind: 'vec', items: vars.map(v => applyDiff(f, v, 1, ctx.opts.isList)) };
      }
      if (ctx.opts.inDefinition && (e.name === 'trail' || e.name === 'revolve' || e.name === 'rgb' || e.name === 'hsl' || e.name === 'oklch')) {
        throw new Error(`${e.name}(…) must be a whole row, not part of a definition.`);
      }
      if (e.name === 'revolve' && args.length >= 1 && args.length <= 2) {
        // revolve(f) names the profile by its function: f stands for f(x), or
        // f(y) / f(z) about the axis asked for. classify (lib/plot.ts) checks
        // the rest — it sees only the ordinary expression.
        const [f, ax] = args;
        const profile = f.kind === 'var' ? getFn(f.name) : undefined;
        if (f.kind === 'var' && profile) {
          const axis = revolveAxis(ax);
          if (profile.params.length !== 1) {
            throw new Error(`revolve(${f.name}) needs a function of one variable; ${f.name} takes ${profile.params.length}.`);
          }
          const body = substVars(profile.body, { [profile.params[0]]: { kind: 'var', name: axis } });
          return { kind: 'call', name: e.name, args: [body, ...args.slice(1)] };
        }
        // Only the bare name stands for its function; inside a larger profile
        // (-f, 2f) it has to be called.
        for (const v of freeVars(f)) {
          if (getFn(v)) throw new Error(`${v} is a function — write it with parentheses, e.g. ${v}(x).`);
        }
      }
      return { kind: 'call', name: e.name, args };
    }
    case 'eq': return { kind: 'eq', l: rx(e.l, ctx), r: rx(e.r, ctx) };
    case 'ineq': return { kind: 'ineq', op: e.op, l: rx(e.l, ctx), r: rx(e.r, ctx) };
    case 'vec': return { kind: 'vec', items: e.items.map(x => rx(x, ctx)) };
    case 'list': return sameList(e, {
      kind: 'list',
      // `[1..10]` ranges survive resolution intact (bounds resolve) and
      // expand later in list lowering, where constant values are known.
      items: e.items.map((x): Expr => (x.kind === 'range'
        ? { kind: 'range', args: [rx(x.args[0], ctx), rx(x.args[1], ctx)] }
        : rx(x, ctx))),
    });
    case 'data':
    case 'str':
    case 'text': return e;
    case 'piecewise': return {
      kind: 'piecewise',
      cases: e.cases.map(c => ({ cond: rx(c.cond, ctx), value: rx(c.value, ctx) })),
      otherwise: e.otherwise && rx(e.otherwise, ctx),
    };
    case 'loop': return mapChildren(e, x => rx(x, ctx));
  }
}

export interface BuiltDefs {
  defs: Env;
  fits: Map<string, FitResult>;
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
export function buildDefs(raw: Definition[], tables?: TableSource, sequences: SeqScan[] = []): BuiltDefs {
  const fits = new Map<string, FitResult>();
  const fittedNames = new Set<string>();
  const fitOwner = new Map<string, string>();
  const errors = new Map<string, string>();
  const needsFile = new Set<string>();
  const defs = emptyDraft();
  for (const scan of sequences) defs.sequences.set(scan.name, scan);
  while (raw.some(d => d.name.startsWith(defs.sequencePrefix + '_'))) defs.sequencePrefix += 'X';
  const byName = new Map(raw.map(d => [d.name, d]));
  const fnNames = new Set(raw.filter(d => d.kind === 'fn').map(d => d.name));
  const stateNames = new Set(raw.filter(d => d.kind === 'state').map(d => d.name));
  // Names this document binds as values shadow a late-addition builtin of the
  // same name, so `total = 3` still reads `total(x + 1)` as a product.
  const valueNames = shadowedFnNames(raw.filter(d => d.kind !== 'fn').map(d => d.name));
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // Numeric values of constants resolved so far: Σ/Π bounds in later
  // definitions may use them (bounds need a value at expansion time).
  const numEnv: Record<string, number> = {};
  const ropts: ResolveOpts = {
    inDefinition: true,
    consts: numEnv,
    boundConsts: new Set(),
    // Live: list names accumulate as definitions are processed.
    isList: n => isListName(listNamesOf(defs), n),
    indexIssue: idx => indexIssue(idx, defs),
  };

  const parsed = new Map<string, Expr>();
  // List names accumulate in definition order, so `L[2]` indexes only when
  // L's list definition sits above (below, it parses as multiplication and
  // is reported as a forward reference after the loop).
  const parse = (d: Definition & { rhs: string }): Expr => {
    const key = defKey(d);
    let p = parsed.get(key);
    if (!p) parsed.set(key, (p = parseExpr(d.rhs, fnNames, listNamesOf(defs), valueNames)));
    return p;
  };

  /** Derived point component → the point row it belongs to (A_x → A). */
  const compOwner = new Map<string, string>();

  const resolving: string[] = [];
  const getFn: GetFn = name => {
    const hit = defs.fns.get(name);
    if (hit) return hit;
    if (!fnNames.has(name)) return undefined;
    if (errors.has(name)) throw new Error(`${name} has an error in its definition.`);
    const d = byName.get(name) as Definition & { kind: 'fn' };
    if (resolving.includes(name)) {
      if (resolving[resolving.length - 1] !== name) throw new Error(`${name} and ${resolving[resolving.length - 1]} are defined in terms of each other.`);
      return { params: d.params, body: { kind: 'call', name: RECUR, args: [] }, recursive: true };
    }
    resolving.push(name);
    try {
      let body = resolveExpr(parse(d), getFn, ropts);
      if (containsRecur(body)) body = wrapRecursion(name, d.params, body);
      const fn: FnDef = { params: d.params, body };
      defs.fns.set(name, fn);
      return fn;
    } finally {
      resolving.pop();
    }
  };
  ropts.sequenceTerm = sequenceResolver(defs, getFn, ropts, new Set(raw.map(d => d.name)), new Set(raw.map(d => d.name)), (name, expr) => defs.consts.set(name, expr));

  // Resolved right-hand sides of `a' = …` and `a(0) = …`, validated below
  // once the constant/field split is known.
  const derivs = new Map<string, Expr>();
  const inits = new Map<string, Expr>();

  for (const d of raw) {
    try {
      if (d.kind === 'regression') {
        const lhsSource = parseExpr(d.lhs, fnNames, listNamesOf(defs), valueNames);
        const rhsSource = parseExpr(d.rhs, fnNames, listNamesOf(defs), valueNames);
        parsed.set(defKey(d), { kind: 'eq', l: lhsSource, r: rhsSource });
        const lhs = resolveExpr(lhsSource, getFn, ropts), rhs = resolveExpr(rhsSource, getFn, ropts);
        const rhsVars = freeVars(rhs);
        // Points first, as in a plot row: `Y ~ g(A) X + b` reads g at the point A.
        const points = (e: Expr): Expr => lowerGeom(e, n => compsOf(defs, n), n => defs.mats.get(n) ?? null, n => getList(n) !== null);
        const parameters = [...rhsVars].filter(n => nameable(n) && !byName.has(n) && !draftNameTaken(defs, n) && !n.includes('.'));
        if (!parameters.length) throw new Error('Regression needs an unbound coefficient, like Y ~ m X + b. Defined constants stay fixed.');
        if (parameters.length > 8) throw new Error('Regression supports at most 8 fitted coefficients.');
        for (const n of rhsVars) {
          if (RESERVED.has(n) || stateNames.has(n)) throw new Error(`Regression models must be static; ${n} cannot vary during a fit.`);
        }
        const getList = listGetter(defs);
        const numericList = (e: Expr): number[] => {
          if (e.kind === 'data') return Array.from(e.values);
          if (e.kind !== 'list') throw new Error('Regression observations must be a numeric list, like Y ~ m X + b.');
          return e.items.map(it => {
            for (const n of freeVars(it)) {
              if (!(n in numEnv)) throw new Error(`Regression data must be static; define ${n} above the fit.`);
            }
            return evaluate(it, numEnv);
          });
        };
        try {
          const observed = numericList(lowerLists(points(lhs), getList, ropts));
          if (observed.length > 10_000) throw new Error('Regression supports at most 10000 observations; filter the data first.');
          // Keep model arithmetic symbolic even for typed CSV columns. The
          // usual fast path folds ln(-1) into NaN; a fit must distinguish an
          // invalid model from a missing input pair instead of dropping it.
          const model = lowerLists(points(rhs), n => {
            const value = getList(n);
            if (value?.kind !== 'data') return value;
            if (value.values.length > 10_000) throw new Error('Regression supports at most 10000 observations; filter the data first.');
            return withAxes({ kind: 'list', items: Array.from(value.values, v => ({ kind: 'num', value: v })) }, axesOf(value));
          }, ropts);
          const models = model.kind === 'list' ? model.items
            : model.kind === 'data' ? Array.from(model.values, (value): Expr => ({ kind: 'num', value }))
              : Array.from({ length: observed.length }, () => model);
          for (const f of models) for (const n of freeVars(f)) {
            if (parameters.includes(n)) continue;
            if (!(n in numEnv)) throw new Error(`Regression models must be static; define ${n} above the fit.`);
          }
          const fit = fitRegression(observed, models, parameters, numEnv);
          fits.set(d.name, fit);
          for (const [name, value] of Object.entries(fit.coefficients)) {
            defs.consts.set(name, { kind: 'num', value });
            numEnv[name] = value;
            fittedNames.add(name);
            fitOwner.set(name, d.name);
          }
        } catch (err) {
          if (err instanceof MissingDataError) {
            for (const name of parameters) defs.missingData.set(name, { message: err.message, list: false });
          }
          throw err;
        }
      } else if (d.kind === 'fn') {
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
        const resolved = resolveExpr(parse(d), getFn, ropts);
        // `R = e^(a J)`, `N = 2 M`: matrix algebra names a matrix.
        const computed = lowerMatrix(resolved, n => compsOf(defs, n), n => defs.mats.get(n) ?? null);
        if (computed) {
          defs.mats.set(d.name, computed);
          continue;
        }
        let e: Expr;
        try { e = lowerGeom(resolved, n => compsOf(defs, n), n => defs.mats.get(n) ?? null); }
        catch { e = lowerObjects(resolved, defs, ropts, true); }
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
          // `P = (person.age, person.height)` names a SCATTER, whose
          // components are whole columns — not a point, whose components are
          // two numbers. Read as a point it became two `data` components that
          // then failed to evaluate ("List in scalar context"), so the one
          // representation that makes a 200 000-row file plottable was also
          // the one that could not be given a name. The symbolic equivalent
          // `P = (L, M)` always could.
          if (isDataScatter(e)) {
            defs.lists.set(d.name, e);
            continue;
          }
          if (e.items.length !== 2 && e.items.length !== 3) throw new Error('A named point needs 2 or 3 components.');
          const comps = pointComps(d.name, e.items.length);
          for (const c of comps) {
            if (byName.has(c)) {
              throw new Error(`Cannot name a point ${d.name}: ${c} is already defined.`);
            }
          }
          defs.points.add(d.name);
          defs.pointDims.set(d.name, e.items.length);
          store.length = 0;
          comps.forEach((c, k) => { compOwner.set(c, d.name); store.push([c, e.items[k]]); });
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
        for (const c of pointComps(owner, defs.pointDims.get(owner))) defs.consts.delete(c);
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
  /** Starting values per run of a state family, by owner and component. */
  const familyInits = new Map<string, (readonly Expr[])[]>();
  /** A family run's hidden scalar state → the row that defines it. */
  const familyOwner = new Map<string, string>();
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
        // A list of starting values is a family: one run of the system each.
        const listed = lowerLists(low, listGetter(defs), ropts, true);
        if (isSeq(listed)) {
          if (listed.kind !== 'list') throw new Error(`${name}(0) must list numbers${dim ? ' or points' : ''}.`);
          const members = listed.items.map(it => {
            if (dim === undefined) {
              if (it.kind === 'vec') throw new Error(`${name}(0) lists points, but ${name} is a single number.`);
              return [it];
            }
            if (it.kind !== 'vec' || it.items.length !== dim) {
              throw new Error(`${name} is a ${dim}-component state, but ${name}(0) lists ${it.kind === 'vec' ? `${it.items.length}-component points` : 'single numbers'}.`);
            }
            return it.items;
          });
          if (!members.length) throw new Error(`${name}(0) is an empty list.`);
          if (members.length > FAMILY_MAX) throw new Error(`${name}(0) starts ${members.length} runs — the limit is ${FAMILY_MAX}.`);
          familyInits.set(name, members);
          const comps = dim === undefined ? [name] : vecStateComps(name, dim);
          comps.forEach((c, k) => {
            flatInits.set(c, members[0][k]);
            if (dim !== undefined) vecOwnerKey.set(c, name);
          });
          continue;
        }
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

  // State families: `p(0) = ([0..99]/10, 0, 0)` runs the system once per
  // starting value. Each run is its own set of hidden scalar states, so the
  // integrator is unchanged, and the state's names become lists over one
  // shared axis — `p` draws as a point per run, `p[1]` is the first run. A
  // state coupled to a family (`r' = vel` with a list of r(0)) runs per
  // member too, seeded from its own single starting value.
  if (familyInits.size) {
    const rowOf = (c: string) => vecOwnerKey.get(c) ?? c;
    const compsOfState = (owner: string) => {
      const dim = defs.vecStates.get(owner);
      return dim === undefined ? [owner] : vecStateComps(owner, dim);
    };
    // Constants that read a state are inlined into each run's derivative:
    // `f = (…th_1…)` means a different f per run.
    const stateDependent = new Map<string, Expr>();
    for (let changed = true; changed;) {
      changed = false;
      for (const [n, e] of defs.consts) {
        if (stateDependent.has(n)) continue;
        if ([...freeVars(e)].some(v => stateNames.has(v) || stateDependent.has(v))) {
          stateDependent.set(n, e);
          changed = true;
        }
      }
    }
    const inline = (e: Expr): Expr => {
      for (let depth = 0; depth <= stateDependent.size; depth++) {
        const hit = [...freeVars(e)].filter(v => stateDependent.has(v));
        if (!hit.length) return e;
        e = substVars(e, Object.fromEntries(hit.map(v => [v, stateDependent.get(v)!])));
      }
      return e; // a cycle: validation below reports it on the constant
    };
    // Coupled states run together, so they share one family.
    const parent = new Map<string, string>();
    const find = (a: string): string => {
      const p = parent.get(a) ?? a;
      if (p === a) return a;
      const root = find(p);
      parent.set(a, root);
      return root;
    };
    const inlined = new Map([...derivs].map(([c, d]) => [c, inline(d)]));
    for (const [c, d] of inlined) {
      for (const fv of freeVars(d)) if (stateNames.has(fv)) parent.set(find(rowOf(c)), find(rowOf(fv)));
    }
    const sizes = new Map<string, { n: number; from: string }>();
    for (const [owner, members] of familyInits) {
      const root = find(owner), seen = sizes.get(root);
      if (!seen) sizes.set(root, { n: members.length, from: owner });
      else if (seen.n !== members.length) {
        errors.set(`${owner}(0)`, `${owner}(0) starts ${members.length} runs, but ${seen.from}(0), which it moves with, starts ${seen.n}.`);
        familyInits.delete(owner);
      }
    }
    const owners = new Set([...derivs.keys()].map(rowOf));
    for (const [root, { n }] of sizes) {
      const group = [...owners].filter(o => find(o) === root);
      const comps = group.flatMap(compsOfState).filter(c => derivs.has(c));
      const hidden = (c: string, k: number) => `${defs.sequencePrefix}_run_${c}_${k}`;
      const axes = [{ id: `${root}#runs`, n }];
      const runs = Array.from({ length: n }, (_, k) =>
        Object.fromEntries(comps.map(c => [c, { kind: 'var', name: hidden(c, k) } as Expr])));
      for (const owner of group) {
        const own = compsOfState(owner);
        const members = familyInits.get(owner);
        own.forEach((c, i) => {
          const deriv = inlined.get(c);
          const init = inits.get(c) ?? num(0);
          for (let k = 0; k < n; k++) {
            const h = hidden(c, k);
            if (deriv) derivs.set(h, substVars(deriv, runs[k]));
            inits.set(h, members ? members[k][i] : init);
            stateNames.add(h);
            familyOwner.set(h, owner);
          }
          derivs.delete(c);
          inits.delete(c);
          stateNames.delete(c);
          vecOwnerKey.delete(c);
          const list: Expr = { kind: 'list', items: runs.map(r => r[c] ?? num(0)) };
          if (own.length > 1) defs.lists.set(c, withAxes(list, axes));
        });
        const list: Expr = own.length > 1
          ? { kind: 'list', items: runs.map(r => ({ kind: 'vec', items: own.map(c => r[c] ?? num(0)) })) }
          : { kind: 'list', items: runs.map(r => r[owner] ?? num(0)) };
        defs.lists.set(owner, withAxes(list, axes));
        defs.vecStates.delete(owner);
      }
    }
    // A constant reading a family is a list of values, one per run.
    const familyNames = () => new Set(defs.lists.keys());
    for (const [n, e] of [...defs.consts]) {
      const names = familyNames();
      if (![...freeVars(e)].some(v => names.has(v))) continue;
      try {
        const listed = lowerLists(e, listGetter(defs), ropts, true);
        if (!isSeq(listed)) continue;
        defs.consts.delete(n);
        defs.lists.set(n, listed);
      } catch (err) {
        errors.set(compOwner.get(n) ?? n, msg(err));
        defs.consts.delete(n);
      }
    }
    // A point with a component per run is a list of points.
    for (const owner of [...defs.points]) {
      const comps = pointComps(owner, defs.pointDims.get(owner));
      const lists = comps.map(c => defs.lists.get(c));
      if (!lists.some(Boolean)) continue;
      const len = lists.find(Boolean)!.kind === 'list' ? (lists.find(Boolean) as Expr & { kind: 'list' }).items.length : 0;
      const axes = axesOf(lists.find(Boolean) as Seq);
      const items = Array.from({ length: len }, (_, k): Expr => ({ kind: 'vec', items: comps.map((c, i) => {
        const l = lists[i];
        return l ? (l as Expr & { kind: 'list' }).items[k] : defs.consts.get(c) ?? num(0);
      }) }));
      for (const c of comps) { defs.consts.delete(c); compOwner.delete(c); }
      defs.points.delete(owner);
      defs.pointDims.delete(owner);
      defs.lists.set(owner, withAxes({ kind: 'list', items }, axes));
    }
  }

  // A definition whose value depends on position — x, y, or z, directly or
  // via another such definition — is a coordinate field, not a constant.
  const fieldNames = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, e] of defs.consts) {
      if (fieldNames.has(name)) continue;
      for (const fv of freeVars(e)) {
        if (SPACE.has(fv) || fieldNames.has(fv)) {
          fieldNames.add(name);
          changed = true;
          break;
        }
      }
    }
  }
  // A named vector that depends on position is a vector field: every
  // component becomes a coordinate field (`s = (x, y)` is the position
  // vector). Constant siblings (`A = (x, 0)`) join them so the name stays
  // one object; they are skipped when drawing grid families.
  for (const p of [...defs.points]) {
    const comps = pointComps(p, defs.pointDims.get(p));
    if (!comps.some(c => fieldNames.has(c))) continue;
    for (const c of comps) fieldNames.add(c);
  }

  const constNames = new Set(raw.filter(d => d.kind === 'const' && !fieldNames.has(d.name)).map(d => d.name));
  for (const name of fittedNames) constNames.add(name);
  for (const name of defs.consts.keys()) if (name.startsWith(defs.sequencePrefix + '_')) constNames.add(name);
  // Constant point rows resolve to their component constants; a vector
  // field's components are fields, not uniforms.
  for (const p of defs.points) {
    constNames.delete(p);
    for (const c of pointComps(p, defs.pointDims.get(p))) {
      if (!fieldNames.has(c)) constNames.add(c);
    }
  }

  const pendingFields = new Map<string, Expr>();
  for (const [name, e] of defs.consts) {
    if (fieldNames.has(name)) pendingFields.set(name, e);
  }
  for (const name of pendingFields.keys()) defs.consts.delete(name);

  // Resolve field-to-field references so each field is a closed expression
  // in x, y, z, t, and constants.
  const fieldVisiting = new Set<string>();
  const resolveField = (name: string): Expr => {
    const hit = defs.fields.get(name);
    if (hit) return hit;
    const shown = compOwner.get(name) ?? name;
    if (fieldVisiting.has(name)) throw new Error(`${shown} is defined in terms of itself.`);
    fieldVisiting.add(name);
    try {
      let e = pendingFields.get(name)!;
      const sub: Record<string, Expr> = {};
      for (const fv of freeVars(e)) {
        if (pendingFields.has(fv)) sub[fv] = resolveField(fv);
      }
      if (Object.keys(sub).length) e = substVars(e, sub);
      for (const fv of freeVars(e)) {
        if (!SPACE.has(fv) && fv !== 't' && !constNames.has(fv) && !stateNames.has(fv)) {
          throw new Error(`${shown} defines a coordinate (it uses x, y, or z), so it may only use x, y, z, t, and constants (found ${fv}).`);
        }
      }
      // Trial-evaluate to surface unsupported calls (re, im, …) now.
      const env: Record<string, number> = { x: 0.7, y: 0.4, z: 0.3, t: 0 };
      for (const fv of freeVars(e)) env[fv] ??= 1;
      evaluate(e, env);
      defs.fields.set(name, e);
      return e;
    } finally {
      fieldVisiting.delete(name);
    }
  };
  const droppedPoints = new Set<string>();
  for (const name of pendingFields.keys()) {
    const owner = compOwner.get(name);
    if (owner && droppedPoints.has(owner)) continue;
    try {
      resolveField(name);
    } catch (e) {
      const shown = owner ?? name;
      errors.set(shown, msg(e));
      if (owner && defs.points.has(owner)) {
        defs.points.delete(owner);
        droppedPoints.add(owner);
        for (const c of pointComps(owner, defs.pointDims.get(owner))) defs.fields.delete(c);
      }
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
  const stateRow = (n: string): string => vecOwnerKey.get(n) ?? familyOwner.get(n) ?? n;
  for (const [name, deriv] of derivs) {
    try {
      if (defs.fields.has(name)) throw new Error(`${name} is a coordinate field — use a tuple flow like (${name}', y') = (F, G).`);
      if (defs.consts.has(name)) {
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

  // Component validation is atomic at the owner boundary: a failed vector
  // cannot leave usable scalar aliases behind, or hide its error on an alias.
  for (const [component, owner] of compOwner) {
    const error = errors.get(component);
    if (error) { errors.set(owner, error); errors.delete(component); }
  }
  for (const [owner, dimension] of defs.pointDims) {
    const components = pointComps(owner, dimension);
    const store = components.some(c => defs.fields.has(c)) ? defs.fields : defs.consts;
    if (defs.points.has(owner) && components.every(c => store.has(c)) && !errors.has(owner)) continue;
    defs.points.delete(owner);
    for (const c of components) {
      defs.consts.delete(c);
      defs.fields.delete(c);
    }
  }
  for (const [component, owner] of vecOwnerKey) {
    if (!defs.vecStates.has(owner) || errors.has(owner)) defs.states.delete(component);
  }

  // A successful sibling may already have been inlined, folded into a
  // number, or used to build a table before another component failed. Retain
  // source dependencies until publication, so no binding can outlive a
  // failed owner merely because its lowered expression hid that reference.
  if (errors.size) {
    const ownerOf = (name: string) => compOwner.get(name) ?? vecOwnerKey.get(name) ?? familyOwner.get(name) ?? fitOwner.get(name) ?? name;
    const known = new Set([...byName.keys(), ...compOwner.keys(), ...vecOwnerKey.keys(), ...fittedNames, ...defs.consts.keys()]);
    const present = (name: string): boolean => defs.consts.has(name) || defs.fields.has(name)
      || defs.states.has(name) || defs.points.has(name) || defs.vecStates.has(name)
      || defs.fns.has(name) || defs.mats.has(name) || defs.lists.has(name)
      || defs.tables.has(name) || defs.missingData.has(name);
    const references = (expr: Expr): Set<string> => {
      const names = sourceFreeVars(expr);
      const calls = (node: Expr): void => {
        if (node.kind === 'call' && fnNames.has(node.name)) names.add(node.name);
        for (const child of childrenOf(node)) calls(child);
      };
      calls(expr);
      return names;
    };
    const sourceMemo = new Map<string, ReadonlySet<string>>();
    const sourceRefs = (name: string): ReadonlySet<string> => {
      const owner = ownerOf(name);
      let refs = sourceMemo.get(owner);
      if (!refs) {
        const source = parsed.get(owner);
        const names = source ? references(source) : new Set<string>();
        const row = byName.get(owner);
        if (row?.kind === 'fn') for (const param of row.params) names.delete(param);
        if (row?.kind === 'regression') for (const [parameter, fit] of fitOwner) if (fit === owner) names.delete(parameter);
        sourceMemo.set(owner, refs = names);
      }
      return refs;
    };
    const failedRef = (refs: Iterable<string>): string | undefined => {
      for (const name of refs) {
        const head = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
        if (known.has(head) && !present(head)) return ownerOf(head);
      }
    };
    const remove = (name: string): void => {
      const owner = ownerOf(name);
      if (compOwner.has(name)) {
        defs.points.delete(owner);
        for (const alias of pointComps(owner, defs.pointDims.get(owner))) {
          defs.consts.delete(alias); defs.fields.delete(alias);
        }
      } else if (vecOwnerKey.has(name)) {
        // The dimension map may have been removed by earlier validation.
        for (const [alias, state] of vecOwnerKey) if (state === owner) defs.states.delete(alias);
        defs.vecStates.delete(owner);
      } else if (fitOwner.has(name)) {
        for (const [parameter, fit] of fitOwner) if (fit === owner) defs.consts.delete(parameter);
        fits.delete(owner);
      } else {
        defs.consts.delete(name); defs.fields.delete(name); defs.states.delete(name);
        defs.fns.delete(name); defs.mats.delete(name); defs.lists.delete(name); defs.tables.delete(name);
        defs.missingData.delete(name);
      }
    };
    // Runtime formulas and original sources both matter: generated sequence
    // constants have no source row; inlined fields may have no free names.
    for (let changed = true; changed;) {
      changed = false;
      const candidates: Array<[string, readonly Expr[], readonly string[]]> = [
        ...[...defs.consts].map(([name, expr]): [string, Expr[], string[]] => [name, [expr], []]),
        ...[...defs.fields].map(([name, expr]): [string, Expr[], string[]] => [name, [expr], []]),
        ...[...defs.states].map(([name, state]): [string, Expr[], string[]] => [name, [state.deriv], []]),
        ...[...defs.fns].map(([name, fn]): [string, Expr[], string[]] => [name, [fn.body], fn.params]),
        ...[...defs.mats].map(([name, matrix]): [string, Expr[], string[]] => [name, matrix.flat(), []]),
        ...[...defs.lists].map(([name, value]): [string, Expr[], string[]] => [name, [value], []]),
        ...[...defs.tables.keys()].map((name): [string, Expr[], string[]] => [name, [], []]),
      ];
      for (const [name, expressions, parameters] of candidates) {
        if (!present(name)) continue;
        const refs = new Set(sourceRefs(name));
        for (const expr of expressions) for (const ref of references(expr)) refs.add(ref);
        for (const param of parameters) refs.delete(param);
        const failed = failedRef(refs);
        if (!failed) continue;
        const owner = ownerOf(name);
        if (!errors.has(owner)) errors.set(owner, `${failed} has an error in its definition.`);
        remove(name);
        changed = true;
      }
    }
    // Initial conditions retain their established recoverable behavior: an
    // invalid component gets the zero seed, while its state and valid sibling
    // seeds survive. Direct tuple sources preserve per-component provenance.
    for (const [name, state] of defs.states) {
      const owner = ownerOf(name);
      let source = parsed.get(`${owner}(0)`);
      if (source?.kind === 'vec' && vecOwnerKey.has(name)) {
        source = source.items[vecStateComps(owner, defs.vecStates.get(owner)!).indexOf(name)];
      }
      const refs = references(state.init);
      if (source) for (const ref of references(source)) refs.add(ref);
      const failed = failedRef(refs);
      if (!failed) continue;
      const row = `${owner}(0)`;
      if (!errors.has(row)) errors.set(row, `${failed} has an error in its definition.`);
      defs.states.set(name, { deriv: state.deriv, init: num(0) });
    }
  }

  const env = new Env(defs.sequences, defs.sequencePrefix);
  const components = (values: Expr[]): Components => {
    if (values.length !== 2 && values.length !== 3) throw new Error('A vector needs 2 or 3 components.');
    return values as unknown as Components;
  };
  for (const [role, store] of [['const', defs.consts], ['field', defs.fields]] as const) {
    for (const [name, expr] of store) {
      const owner = compOwner.get(name);
      if (!owner) env.bind(name, { tag: 'scalar', role, expr });
      else if (!env.names.has(owner)) {
        env.bind(owner, { tag: 'vector', role,
          components: components(pointComps(owner, defs.pointDims.get(owner)).map(c => store.get(c)!)) });
      }
    }
  }
  for (const [name, state] of defs.states) {
    const owner = vecOwnerKey.get(name);
    if (!owner) env.bind(name, { tag: 'scalar', role: 'state', ...state });
    else if (!env.names.has(owner)) {
      const values = vecStateComps(owner, defs.vecStates.get(owner)!).map(c => defs.states.get(c)!);
      env.bind(owner, { tag: 'vector', role: 'state',
        deriv: components(values.map(s => s.deriv)), init: components(values.map(s => s.init)) });
    }
  }
  for (const [name, fn] of defs.fns) env.bind(name, { tag: 'fn', fn });
  for (const [name, matrix] of defs.mats) env.bind(name, { tag: 'matrix', matrix });
  for (const [name, table] of defs.tables) env.bind(name, { tag: 'table', table, unavailable: defs.missingData.get(name) });
  for (const [name, value] of defs.lists) env.bind(name, { tag: 'seq', value: value.kind === 'vec'
    ? { representation: 'scatter', vector: value } : { representation: 'sequence', sequence: value } });
  for (const [name, missing] of defs.missingData) {
    if (!defs.tables.has(name)) env.bind(name, { tag: 'missing', ...missing });
  }
  return { defs: env, fits, errors, needsFile, sumBoundConsts: ropts.boundConsts! };
}

/**
 * Constants with no fixed value: those depending on t or on a state, directly
 * or through other constants. (Σ/Π bounds may not use them — expansion is
 * static.)
 */
export function animatedConstNames(defs: Env): Set<string> {
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

/** Names read by a value, including indirect constant and state dependencies. */
export function definitionDependencies(names: Iterable<string>, defs: Env): Set<string> {
  const out = new Set<string>();
  const visit = (name: string) => {
    if (out.has(name)) return;
    out.add(name);
    const constant = defs.consts.get(name);
    const state = defs.states.get(name);
    for (const e of constant ? [constant] : state ? [state.deriv, state.init] : []) {
      for (const fv of freeVars(e)) visit(fv);
    }
  };
  for (const name of names) visit(name);
  return out;
}

/** Total time derivative, keeping constants symbolic and using state rates. */
export function timeDifferentiator(defs: Env): (e: Expr) => Expr {
  const rates = new Map<string, Expr>();
  const zero: Expr = { kind: 'num', value: 0 };
  const rate = (name: string): Expr => {
    if (name === 't') return { kind: 'num', value: 1 };
    const state = defs.states.get(name);
    if (state) return state.deriv;
    const constant = defs.consts.get(name);
    if (!constant) return zero;
    let hit = rates.get(name);
    if (!hit) {
      hit = derivative(constant);
      rates.set(name, hit);
    }
    return hit;
  };
  const derivative = (e: Expr): Expr => {
    let out: Expr = zero;
    for (const name of freeVars(e)) {
      const dt = rate(name);
      // Fixed parameters need no differentiation, even if their definitions
      // use functions without symbolic derivatives, such as floor().
      if (dt.kind !== 'num' || dt.value !== 0) out = add(out, mul(diff(e, name), dt));
    }
    return out;
  };
  return derivative;
}

/** True when any constant depends on time and so must be re-evaluated per frame. */
export function constsAnimated(defs: Env): boolean {
  for (const e of defs.consts.values()) if (freeVars(e).has('t')) return true;
  return false;
}
