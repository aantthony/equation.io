import { childrenOf, mapChildren, structuralDiagnostic } from './expr.ts';
/**
 * List lowering — lists as values, by symbolic expansion.
 *
 * Like Σ/Π/∫, d/dx, points, and matrices, lists vanish before anything
 * downstream looks: broadcasting rewrites operations over lists into a
 * top-level `{kind: 'list'}` literal (the shape classify already plots as
 * dots/bars or a scatter), reductions collapse to scalar expressions, and
 * indexing picks its element at lowering time. GLSL, evaluate, diff, and the
 * integrator never see a list.
 *
 * Semantics (see docs/lists-tables-plan.md):
 * - scalar ⊕ list maps elementwise; list ⊕ list zips when both run over
 *   the same instances and crosses when they are independent (see Axis).
 * - `(A, B)` with list components becomes a list of points the same way.
 * - ranges [1..20] / [0, 0.5..10] / [10..1] expand here, where constant
 *   values are known (bounds behave like Σ bounds: constants and sliders).
 * - a list [ … ] is a multiset, with no order; order lives in tuples
 *   (docs/multisets.md §3): `sort` makes one, and indexing (1-based, T[1]
 *   is the first element) takes one. A tuple is a list whose positions are
 *   an `ordered` axis (see unionAxes).
 * - mean/total/count and min/max over a list lower symbolically, so their
 *   elements may animate with t; stdev/median/sort need a constant list.
 *
 * Two representations, one meaning. A list of PLAIN NUMBERS — a CSV column,
 * or anything built from one by constant arithmetic — is a `data` node
 * wrapping a Float64Array, so a 100k-row scatter costs two objects and the
 * renderer reads coordinates straight out of the array. Anything else (an
 * element that moves with t, a slider that must stay a shader uniform, a
 * comparison) takes the symbolic path, where every element is its own
 * expression and ITEMS_MAX bounds the damage. `expand` converts the first
 * into the second whenever the fast path cannot carry an operation.
 *
 * Between the two sits `lazy`: an operation over packed numbers that the fast
 * path cannot fold, only because a slider or t is involved (`sin(a L)`),
 * keeps ONE template over the packed columns instead of a copy of it per
 * element. Operations that need elements as nodes — a filter, a reduction, a
 * comparison — `expand` it into the symbolic form; so does the end of
 * lowering, unless the caller can use the template as it is (a connected
 * figure through thousands of computed points).
 */
import { add, div } from './diff.ts';
import type { ResolveOpts } from './defs.ts';
import {
  EVAL_FNS,
  type Axis,
  type Column,
  exprReplacer,
  type Expr,
  compArity,
  compDims,
  evaluate,
  originOf,
  freeVars,
  ineqComparisons,
  plainFnName,
  realPow,
  substVars,
} from './expr.ts';

/**
 * A list of values, in whichever representation it has: one expression per
 * element, a typed array of numbers, or a column of text. They are
 * interchangeable as values — the difference is only what they cost.
 */
export type Seq = Expr & { kind: 'list' | 'data' | 'text' | 'lazy' };

/** A named list's elements: a `list` node (symbolic) or a `data` node. */
export type GetList = (name: string) => Expr | null;

/** Elements one [a..b] range may expand to. */
const RANGE_MAX = 10_000;
/** Total list elements one lowering may materialize AS EXPRESSIONS. Typed
 *  arrays do not count: they are the cheap path, bounded by DATA_MAX. */
const ITEMS_MAX = 100_000;
/** Numbers one row's typed arrays may hold, in total (8 bytes each). */
const DATA_MAX = 4_000_000;

/** Reductions that answer with ONE number however long the list is. `sort` is
 *  not among them: it hands back the same values, as a tuple. */
export const SCALAR_REDUCTIONS = new Set(['mean', 'total', 'count', 'stdev', 'median']);

/** Reductions that lower symbolically — their elements may depend on t. */
const SYMBOLIC_REDUCTIONS = new Set(['mean', 'total', 'count']);
/** Reductions that need numeric elements (ordering), so a constant list. */
const NUMERIC_REDUCTIONS = new Set(['stdev', 'median', 'sort']);

/** Whole-plot forms a list can never appear inside. Exported because the
 *  shape-only checks in defs.ts have to refuse the same ones without the
 *  bytes, or a filter is valid exactly on the devices that cannot test it. */
export const NO_LIST_INSIDE = new Set([
  'domain',
  'conformal',
  'iter',
  'rgb',
  'hsl',
  'oklch',
  'tube',
  '[polygon]',
  '[segment]',
  '[polyline]',
  '[vector]',
  '[square]',
  '[hull]',
  '[polygon3]',
  '[segment3]',
  '[polyline3]',
  '[vector3]',
  '[hull3]',
]);

export { plainFnName };

interface Ctx {
  getList: GetList;
  opts: ResolveOpts;
  /** List elements materialized so far (ranges, zips, maps all count). */
  items: number;
  /** Numbers held in typed arrays built so far. */
  data: number;
  /** hist(…) nodes built: they are whole rows, not values. */
  hists: number;
  /** Point lists `[comp]` nodes pick from, lowered once however many ask. */
  comps: WeakMap<Expr, Expr>;
  /** Columns templates have named so far: names count up per lowering, so
   *  the same row lowers to the same template every time. */
  columns: number;
}

const num = (value: number): Expr => ({ kind: 'num', value });

const isList = (e: Expr): e is Expr & { kind: 'list' } => e.kind === 'list';
const isData = (e: Expr): e is Expr & { kind: 'data' } => e.kind === 'data';
const isText = (e: Expr): e is Expr & { kind: 'text' } => e.kind === 'text';
export const isLazy = (e: Expr): e is Expr & { kind: 'lazy' } => e.kind === 'lazy';
/** Any representation of a list of values: expressions, numbers, text, or a
 *  template over numbers. */
export const isSeq = (e: Expr): e is Seq => isList(e) || isData(e) || isText(e) || isLazy(e);
/**
 * A scatter of whole columns — `(person.age, person.height)` — kept as one
 * `vec` of typed arrays rather than one point per row, which is how classify
 * draws it and the only reason a 200 000-row file plots at all. A list of
 * values it is not, so it is not a `Seq`; a value a row may NAME it is.
 */
export const isDataScatter = (e: Expr): boolean =>
  e.kind === 'vec' && e.items.some(isData) && e.items.every(it => isData(it) || it.kind === 'num');
export const seqLength = (e: Seq): number =>
  e.kind === 'list' ? e.items.length : e.kind === 'lazy' ? e.cols[0].values.length : e.values.length;
const isRange = (e: Expr): e is Expr & { kind: 'range' } => e.kind === 'range';

/**
 * Which instances a list runs over. A list is a variable ranging over its
 * values: every use of the SAME list (a name, anything derived from it, the
 * columns of one data file) moves together, so they zip — the row is evaluated
 * once per instance. Lists with different origins are independent, so they
 * cross: `([0,1],[0,1],[0,1])` is the 8 corners of a cube while `a = [0,1]`,
 * `(a,a,a)` is its diagonal. Each list literal is its own origin.
 *
 * A value over several axes is stored flat, row-major, first axis slowest.
 * Kept beside the nodes rather than on them: nothing downstream of lowering
 * ever sees an axis.
 */
export type { Axis } from './expr.ts';
let anonymous = 0;
export function axesOf(e: Seq): readonly Axis[] {
  const n = seqLength(e);
  let hit = e.axes;
  if (!hit || hit.reduce((size, a) => size * a.n, 1) !== n) {
    hit = [{ id: `#${++anonymous}`, n }];
    e.axes = hit;
  }
  return hit;
}
export function withAxes<T extends Expr>(e: T, axes: readonly Axis[] | null): T {
  if (axes) e.axes = axes;
  return e;
}
/** The axes of a list reached through `name`: an origin nobody has named yet
 *  (a literal, a range) takes the name, so every later use of it agrees. */
export const namedAxes = (name: string, e: Seq): readonly Axis[] =>
  axesOf(e).map((a, i) => (a.id.startsWith('#') ? { ...a, id: `${name}#${i}` } : a));

/** A tuple: a value with an order (docs/multisets.md §3). */
export const isTuple = (e: Expr): boolean =>
  (isSeq(e) ? axesOf(e) : isDataScatter(e) ? axesOf((e as Expr & { kind: 'vec' }).items.find(isData)!) : []).some(
    a => a.ordered,
  );

/** A fresh tuple axis of n positions. */
export const tupleAxis = (n: number): Axis => ({ id: `#t${++anonymous}`, n, ordered: true });

/**
 * The axes a combination of values runs over, and the one each operand's own
 * axis stands for there. Multisets with different origins cross; tuples
 * never do (docs/multisets.md §3): every tuple axis in a combination is the
 * one axis of positions, so `sort(A) + sort(B)` adds position by position,
 * like two vectors, and tuples of different lengths do not combine at all.
 */
export function unionAxes(all: readonly (readonly Axis[])[]): { union: Axis[]; canon: (a: Axis) => string } {
  const union: Axis[] = [];
  const renamed = new Map<string, string>();
  for (const axes of all)
    for (const a of axes) {
      let seen = union.find(u => u.id === a.id);
      if (!seen && a.ordered) {
        seen = union.find(u => u.ordered);
        if (seen) {
          if (seen.n !== a.n) throw new Error(`Tuples of different lengths do not combine (${seen.n} vs ${a.n}).`);
          renamed.set(a.id, seen.id);
          continue;
        }
      }
      if (!seen) union.push(a);
      else if (seen.n !== a.n) throw new Error(`Lists have different lengths (${seen.n} vs ${a.n}).`);
    }
  // The positions innermost: a multiset of tuples is stored tuple by tuple.
  const positions = union.findIndex(a => a.ordered);
  if (positions >= 0) union.push(...union.splice(positions, 1));
  return { union, canon: a => renamed.get(a.id) ?? a.id };
}

/**
 * Bring operands onto one shared set of axes, so that combining them
 * elementwise is a plain zip again: a list already over every axis is left
 * alone, and one that is missing some repeats along them.
 */
function align(parts: Expr[]): { parts: Expr[]; axes: readonly Axis[] | null } {
  const { union, canon } = unionAxes(parts.filter(isSeq).map(axesOf));
  if (!union.length) return { parts, axes: null };
  const total = union.reduce((size, a) => size * a.n, 1);
  const out = parts.map(p => {
    if (!isSeq(p)) return p;
    const own = axesOf(p);
    if (own.length === union.length && own.every((a, i) => canon(a) === union[i].id)) {
      // (A tuple met under another tuple's name is the same positions.)
      return own.every((a, i) => a.id === union[i].id) ? p : withAxes({ ...p } as Expr, union);
    }
    if (total > (isData(p) ? DATA_MAX : ITEMS_MAX)) {
      throw new Error(
        `Independent lists combine every value with every other — that is ${total} combinations (limit ${isData(p) ? DATA_MAX : ITEMS_MAX}). Name one list and reuse it to pair values up instead.`,
      );
    }
    // Where each shared axis steps inside this operand (0: it does not vary).
    const strides = union.map(u => {
      const at = own.findIndex(a => canon(a) === u.id);
      return at < 0 ? 0 : own.slice(at + 1).reduce((size, a) => size * a.n, 1);
    });
    const index = new Int32Array(total);
    const counter = union.map(() => 0);
    for (let k = 0, from = 0; k < total; k++) {
      index[k] = from;
      for (let d = union.length - 1; d >= 0; d--) {
        from += strides[d];
        if (++counter[d] < union[d].n) break;
        from -= strides[d] * counter[d];
        counter[d] = 0;
      }
    }
    const spread: Expr = isData(p)
      ? { kind: 'data', values: Float64Array.from(index, i => p.values[i]) }
      : isText(p)
        ? { kind: 'text', values: Array.from(index, i => p.values[i]) }
        : isLazy(p)
          ? {
              kind: 'lazy',
              body: p.body,
              cols: p.cols.map(c => ({ name: c.name, values: Float64Array.from(index, i => c.values[i]) })),
            }
          : { kind: 'list', items: Array.from(index, i => p.items[i]) };
    return withAxes(spread, union);
  });
  return { parts: out, axes: union };
}

function listOf(items: Expr[], ctx: Ctx): Expr {
  ctx.items += items.length;
  if (ctx.items > ITEMS_MAX) {
    throw new Error(`This expression expands to too many list elements (limit ${ITEMS_MAX}).`);
  }
  return { kind: 'list', items };
}

function dataOf(values: Float64Array, ctx: Ctx): Expr {
  ctx.data += values.length;
  if (ctx.data > DATA_MAX) {
    throw new Error(`This expression works over too much data (limit ${DATA_MAX} values).`);
  }
  return { kind: 'data', values };
}

/**
 * Turn a typed array back into one expression per element, for operations the
 * fast path cannot carry — anything involving t, a slider that must stay a
 * uniform, or a comparison. This is where a big column meets ITEMS_MAX.
 */
function expand(e: Expr, _ctx: Ctx): Expr {
  if (!isData(e) && !isText(e) && !isLazy(e)) return e;
  const n = seqLength(e);
  if (n > ITEMS_MAX) {
    throw new Error(`That is ${n} values; only ${ITEMS_MAX} can be combined with sliders, t, or comparisons.`);
  }
  if (isLazy(e)) return withAxes({ kind: 'list', items: instances(e) }, axesOf(e));
  // Bounded by the check above, and NOT charged against the row's budget:
  // whatever consumes this list charges for the list it builds, and counting
  // both halved the usable size of the one operation the docs quote
  // (`col * t` failed at 50 001 rows against a stated limit of 100 000).
  return withAxes(
    {
      kind: 'list',
      items: isText(e) ? e.values.map((value): Expr => ({ kind: 'str', value })) : [...e.values].map(num),
    },
    axesOf(e),
  );
}

/** A lazy list's elements, one tree each: the template per instance. */
function instances(e: Expr & { kind: 'lazy' }): Expr[] {
  const n = seqLength(e);
  const items: Expr[] = new Array(n);
  for (let k = 0; k < n; k++) {
    const env: Record<string, Expr> = {};
    for (const c of e.cols) env[c.name] = num(c.values[k]);
    items[k] = substVars(e.body, env);
  }
  return items;
}

/** A list's values as numbers, when that is all it holds. */
const numbersOf = (p: Seq): Float64Array | null =>
  isData(p)
    ? p.values
    : isList(p) && p.items.every(it => it.kind === 'num')
      ? Float64Array.from(p.items, it => (it as Expr & { kind: 'num' }).value)
      : null;

/**
 * Combine operands elementwise as ONE template over their packed columns, when
 * every list among them is numbers or already a template — the symbolic path
 * with its per-element copies left out. Null when a list holds anything else
 * (text, points, per-element expressions): zipN's checks and representation
 * apply there as they always have.
 */
function lazyMap(raw: Expr[], build: (comps: Expr[]) => Expr, ctx: Ctx): Expr | null {
  const packed: Expr[] = [];
  let listy = false;
  for (const p of raw) {
    // Text only ever compares: zipN refuses it in arithmetic, in its words.
    if (p.kind === 'str') return null;
    if (!isSeq(p)) {
      packed.push(p);
      continue;
    }
    listy = true;
    if (isLazy(p)) {
      // Arithmetic over a list of points is zipN's to refuse, in its words.
      if (p.body.kind === 'vec') return null;
      packed.push(p);
      continue;
    }
    const values = numbersOf(p);
    if (!values) return null;
    packed.push(isData(p) ? p : withAxes({ kind: 'data', values }, axesOf(p)));
  }
  if (!listy) return null;
  // A template still becomes one expression per element wherever it is
  // settled, so it may only span what the symbolic path could: past that,
  // zipN's own limit says so.
  const { union } = unionAxes(packed.filter(isSeq).map(axesOf));
  if (union.reduce((size, a) => size * a.n, 1) > ITEMS_MAX) return null;
  const { parts, axes } = align(packed);
  const cols: Column[] = [];
  const comps = parts.map(p => {
    if (isLazy(p)) {
      for (const c of p.cols) if (!cols.some(have => have.name === c.name)) cols.push(c);
      return p.body;
    }
    if (!isData(p)) return p;
    const name = `@col${++ctx.columns}`;
    cols.push({ name, values: p.values });
    return { kind: 'var', name } as Expr;
  });
  return withAxes({ kind: 'lazy', cols, body: build(comps) }, axes);
}

/** A lazy list as per-element trees, for operations that need elements as
 *  nodes; everything else passes through. Charged like any list the symbolic
 *  path builds — once, however many operations the template folded in. */
function settle(e: Expr, ctx: Ctx): Exclude<Expr, { kind: 'lazy' }> {
  if (!isLazy(e)) return e as Exclude<Expr, { kind: 'lazy' }>;
  const n = seqLength(e);
  if (n > ITEMS_MAX) {
    throw new Error(`That is ${n} values; only ${ITEMS_MAX} can be combined with sliders, t, or comparisons.`);
  }
  return withAxes(listOf(instances(e), ctx), axesOf(e)) as Exclude<Expr, { kind: 'lazy' }>;
}

/**
 * Combine operands elementwise as numbers, when they all are numbers: typed
 * arrays and literals only. A slider or an unresolved variable returns null,
 * so those keep the symbolic path and shaders keep their uniforms.
 */
function fastMap(raw: Expr[], f: (xs: number[]) => number, ctx: Ctx): Expr | null {
  for (const p of raw) if (!isData(p) && p.kind !== 'num') return null;
  let n: number | null = null;
  const { parts, axes } = align(raw);
  for (const p of parts) {
    if (isData(p)) {
      if (n !== null && p.values.length !== n) {
        throw new Error(`Lists have different lengths (${n} vs ${p.values.length}).`);
      }
      n = p.values.length;
    } else if (p.kind !== 'num') {
      return null;
    }
  }
  if (n === null) return null;
  const out = new Float64Array(n);
  const xs = parts.map(p => (isData(p) ? 0 : (p as Expr & { kind: 'num' }).value));
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (isData(p)) xs[i] = p.values[k];
    }
    out[k] = f(xs);
  }
  return withAxes(dataOf(out, ctx), axes);
}

const BIN_OPS: Record<string, (a: number, b: number) => number> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '^': realPow,
};

/** Evaluate a subexpression that must be a known number (range bounds,
 *  indices) from constants and sliders, like Σ/Π bounds. */
function constVal(e: Expr, ctx: Ctx, what: string, whole = false): number {
  const env: Record<string, number> = {};
  for (const fv of freeVars(e)) {
    const v = ctx.opts.consts?.[fv];
    if (v === undefined) {
      if (fv === 't') throw new Error(`${what} cannot depend on t.`);
      throw new Error(`${what} must be constant — add "${fv} = 5" in a row above.`);
    }
    // boundConsts snaps a slider to whole numbers, so only record the
    // variables of something that HAS to be an integer. A step or an element
    // is an ordinary number: `b = 0.5; [0, b..2]` must keep its half.
    if (whole) ctx.opts.boundConsts?.add(fv);
    env[fv] = v;
  }
  const v = evaluate(e, env);
  if (!isFinite(v)) throw new Error(`${what} is not finite.`);
  return v;
}

/** Expand the items of a list literal: ranges become runs of numbers, with
 *  the step set by the element just before the range ([0, 0.5..10]). */
function expandItems(raw: readonly Expr[], ctx: Ctx): Expr[] & { width?: number } {
  const out: Expr[] & { width?: number } = [];
  /** Tuples among the items, and other things, for the one message. */
  let tuples = 0;
  for (const item of raw) {
    if (!isRange(item)) {
      const low = lower(item, ctx);
      // A bracket is a multiset sum (docs/multisets.md §2): a multiset among
      // the items contributes every one of its elements, so [n, 3, 5] with
      // n = [1,2] is [1 2 3 5]. The result is a new multiset, not n. A tuple
      // is one element, not its positions: [(1, 2, 3, 4), (5, 6, 7, 8)] is a
      // multiset of two 4-tuples, stored as tuples are, positions innermost.
      // (A tuple of 2 or 3 numbers is a point, and joins as one.)
      if (isSeq(low)) {
        const axes = axesOf(low);
        const at = axes.findIndex(a => a.ordered);
        const values = (expand(settle(low, ctx), ctx) as Expr & { kind: 'list' }).items;
        if (at >= 0 && at === axes.length - 1) {
          const width = axes[at].n;
          if (width <= 3 && !values.some(v => v.kind === 'vec')) {
            for (let k = 0; k < values.length; k += width) out.push({ kind: 'vec', items: values.slice(k, k + width) });
            continue;
          }
          if (out.width !== undefined && out.width !== width) {
            throw new Error(`A multiset holds tuples of one length, not ${out.width} and ${width}.`);
          }
          out.width = width;
          tuples += values.length / width;
        }
        out.push(...values);
      } else out.push(low);
      if (out.width !== undefined && tuples !== out.length / out.width) {
        throw new Error(
          `A multiset of ${out.width}-tuples cannot also hold numbers or points: a tuple is one element, not its values.`,
        );
      }
      continue;
    }
    if (out.width !== undefined) {
      throw new Error(
        `A multiset of ${out.width}-tuples cannot also hold numbers or points: a tuple is one element, not its values.`,
      );
    }
    // NOT marked whole: a range bound is an ordinary number ([1..3.5] is
    // legal), and in `[0, b..2]` the bound IS the thing that sets the step.
    const lo = constVal(item.args[0], ctx, 'A ".." range bound');
    const hi = constVal(item.args[1], ctx, 'A ".." range bound');
    let step = hi >= lo ? 1 : -1;
    if (out.length) {
      // The element before the range sets the step, so it needs a value at
      // expansion time — the same standing as the bounds themselves, which
      // means a constant or a slider counts: `a = 0; b = 0.5; [a, b..2]`.
      const prev = constVal(out[out.length - 1], ctx, 'The element before a ".." range (it sets the step)');
      step = lo - prev;
      if (step === 0) throw new Error('The ".." range step is zero.');
      if ((hi - lo) / step < -1e-9) {
        throw new Error('The ".." range step points away from its end value.');
      }
    }
    const count = Math.floor((hi - lo) / step + 1e-9) + 1;
    if (count > RANGE_MAX) {
      throw new Error(`[${lo}..${hi}] expands to ${count} elements (limit ${RANGE_MAX}).`);
    }
    for (let k = 0; k < count; k++) out.push(num(lo + k * step));
  }
  return out;
}

/** Combine lowered operands elementwise: same-axis lists zip, independent
 *  lists cross, scalars broadcast. */
function zipN(raw: Expr[], build: (comps: Expr[]) => Expr, ctx: Ctx): Expr {
  // Nearly every node of nearly every row: no list in sight, nothing to align.
  let listy = false;
  for (const p of raw)
    if (isSeq(p)) {
      listy = true;
      break;
    }
  if (!listy) return build(raw);
  let n: number | null = null;
  const { parts, axes } = align(raw);
  for (const p of parts) {
    if (!isList(p)) continue;
    if (n !== null && p.items.length !== n) {
      throw new Error(`Lists have different lengths (${n} vs ${p.items.length}).`);
    }
    n = p.items.length;
  }
  if (n === null) return build(parts);
  // A mask only ever grows into a longer comparison chain (18 <= a < 65);
  // anything else built from one is arithmetic on a filter. Text is the same
  // shape of mistake: only a comparison may consume it. A list is homogeneous
  // so its first element settles it — but the text can equally be the scalar
  // being broadcast, and asking only the lists let `person.age + "NYC"` build
  // a whole list of number-plus-text elements. Nothing downstream can
  // evaluate one, so the row classified and then drew nothing at all, where
  // every other spelling of the same mistake says so.
  const masked = parts.some(isMask);
  const textual = parts.some(p => (isList(p) ? p.items[0]?.kind : p.kind) === 'str');
  const items: Expr[] = [];
  for (let k = 0; k < n; k++) {
    const comps = parts.map(p => (isList(p) ? p.items[k] : p));
    // An element that is itself a point cannot feed scalar operations or
    // nest inside another point — fail loud rather than mis-plot later.
    if (comps.some((c, i) => c.kind === 'vec' && isList(parts[i]))) {
      throw new Error('Arithmetic over a list of points is not supported yet — operate on coordinate lists instead.');
    }
    const built = build(comps);
    if (masked && built.kind !== 'ineq') {
      throw new Error('A comparison over a list is a filter, not a value — put it in brackets, like L[L > 2].');
    }
    if (textual && !isEquality(built)) {
      throw new Error('Text has no numeric value — it can only be compared, inside a filter.');
    }
    items.push(built);
  }
  return withAxes(listOf(items, ctx), axes);
}

/**
 * A comparison over a list is a mask — the thing a filter selects with
 * (`L[L > 2]`, `person[person.age >= 18]`). It is not a value: only
 * indexing consumes one, and any other use reports itself.
 */
const isEquality = (e: Expr): e is Expr & { kind: 'eqtest' } => e.kind === 'eqtest';

const isMask = (e: Expr): e is Expr & { kind: 'list' } =>
  isList(e) && e.items.length > 0 && e.items.every(it => it.kind === 'ineq' || isEquality(it));

/** Whether one comparison (or a chain like 18 <= a < 65) holds. */
function holds(cond: Expr, env: Record<string, number>): boolean {
  if (isEquality(cond)) {
    const [l, r] = cond.args;
    // Text compares as text and numbers as numbers; the two never match,
    // which is the honest answer for `person.city == 3`.
    if (l.kind === 'str' || r.kind === 'str') {
      // A blank cell is text's NaN (csv.ts stores it as ""), so it fails
      // every test including `!=` — the same rule the numeric side follows.
      if ((l.kind === 'str' && !l.value) || (r.kind === 'str' && !r.value)) return false;
      // …and a numeric gap on the other side is still a gap: comparing a
      // missing age against text kept the row precisely when the test was
      // `!=`, which is the test written to exclude something.
      for (const side of [l, r]) {
        if (side.kind !== 'str' && Number.isNaN(evaluate(side, env))) return false;
      }
      const same = l.kind === 'str' && r.kind === 'str' && l.value === r.value;
      return cond.op === '==' ? same : !same;
    }
    const a = evaluate(l, env);
    const b = evaluate(r, env);
    // A missing cell (NaN) fails every test, `!=` included: it is the absence
    // of a value, not a value that happens to differ. Otherwise the one
    // comparison that kept gaps would be the one written to exclude something.
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return cond.op === '==' ? a === b : a !== b;
  }
  return ineqComparisons(cond as Expr & { kind: 'ineq' }).every(({ op, l, r }) => {
    const a = evaluate(l, env);
    const b = evaluate(r, env);
    return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  });
}

/**
 * Decide a mask, element by element.
 *
 * A filter has to settle at lowering time: the result is a list literal, and
 * a list whose LENGTH moved with t could not be one. So conditions read
 * constants and sliders (which recompile when dragged) but not t — the same
 * line ranges and indices draw. Comparisons against a missing cell (NaN) are
 * false, so filtering a column also drops its gaps.
 */
function maskValues(mask: Expr, opts: ResolveOpts): boolean[] | null {
  if (!isMask(mask)) return null;
  return mask.items.map(cond => {
    const env: Record<string, number> = {};
    for (const fv of freeVars(cond)) {
      const v = opts.consts?.[fv];
      if (v === undefined) {
        throw new Error(
          fv === 't'
            ? 'A filter cannot depend on t — the list would change length every frame.'
            : `A filter must be constant — add "${fv} = 5" in a row above.`,
        );
      }
      env[fv] = v;
    }
    return holds(cond, env);
  });
}

/**
 * Whether an element carries a missing cell. A gap is stored as NaN, and NaN
 * poisons every operation it reaches, so an expression holding one IS the
 * gap however much arithmetic has been mapped over the column since — which
 * is what lets the symbolic path drop the same elements the typed-array path
 * never looked at. Nothing else puts a NaN literal in an expression: it
 * cannot be typed.
 */
function holdsGap(e: Expr): boolean {
  switch (e.kind) {
    case 'num':
      return Number.isNaN(e.value);
    case 'data':
      return e.values.some(Number.isNaN);
    case 'neg':
      return holdsGap(e.a);
    case 'bin':
      return holdsGap(e.a) || holdsGap(e.b);
    case 'call':
      return e.args.some(holdsGap);
    case 'vec':
    case 'list':
      return e.items.some(holdsGap);
    case 'eq':
      return holdsGap(e.l) || holdsGap(e.r);
    case 'ineq':
      return holdsGap(e.l) || holdsGap(e.r);
    case 'piecewise':
      return e.cases.some(c => holdsGap(c.cond) || holdsGap(c.value)) || (e.otherwise ? holdsGap(e.otherwise) : false);
    default:
      return false;
  }
}

/** Numeric values of a constant list, for order-dependent reductions. */
function numericItems(items: readonly Expr[], ctx: Ctx, name: string): number[] {
  return items.map(it => constVal(it, ctx, `${name}(…) needs a constant list, so each element`));
}

/**
 * Reductions straight off a typed array: no expression tree at all, which
 * matters twice over — a 100k-element `total` used to build a 100k-deep sum
 * that `evaluate` then recursed through.
 */
function reduceData(name: string, all: Float64Array, ctx: Ctx): Expr {
  // `count` asks how many rows there are, gaps included — the same answer it
  // gives for a text column. Every other reduction answers about the values
  // that are there: a missing cell is NaN, and one of them would otherwise
  // poison a mean into NaN, or sort to the end of a median and shift it onto
  // the wrong element. hist() has always skipped them; so does the warning
  // the file's own preview shows ("2 missing values in age").
  if (name === 'count') return num(all.length);
  const xs = all.some(Number.isNaN) ? all.filter(v => !Number.isNaN(v)) : all;
  const n = xs.length;
  if (!n) {
    throw new Error(`${name}(…) has no values to work with — every cell there is missing.`);
  }
  switch (name) {
    case 'total':
    case 'mean': {
      let sum = 0;
      for (const x of xs) sum += x;
      return num(name === 'total' ? sum : sum / n);
    }
    case 'min':
      return num(xs.reduce((a, b) => Math.min(a, b)));
    case 'max':
      return num(xs.reduce((a, b) => Math.max(a, b)));
    case 'stdev': {
      if (n < 2) throw new Error('stdev needs at least 2 elements.');
      let sum = 0;
      for (const x of xs) sum += x;
      const mean = sum / n;
      let sq = 0;
      for (const x of xs) sq += (x - mean) ** 2;
      return num(Math.sqrt(sq / (n - 1)));
    }
    case 'median': {
      const s = Float64Array.from(xs).sort();
      return num(n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2);
    }
    case 'sort':
      return dataOf(Float64Array.from(xs).sort(), ctx);
  }
  throw new Error(`Unknown reduction: ${name}.`);
}

/**
 * Combine a list into one expression as a BALANCED tree, pairing neighbours
 * and halving until one is left.
 *
 * Folding left instead would nest as deep as the list is long, and the
 * consumers of an Expr — freeVars, evaluate, toGLSL, diff — all recurse: a
 * column of 30 000 elements crossed with `t` overflowed the stack while
 * still inside the advertised expansion limit. Balanced, the depth is log₂ n
 * (17 for 100 000), and the arithmetic is the same expression either way.
 */
function fold(items: readonly Expr[], join: (a: Expr, b: Expr) => Expr): Expr | null {
  if (!items.length) return null;
  let level = items as Expr[];
  while (level.length > 1) {
    const next: Expr[] = [];
    for (let k = 0; k < level.length; k += 2) {
      next.push(k + 1 < level.length ? join(level[k], level[k + 1]) : level[k]);
    }
    level = next;
  }
  return level[0];
}

function reduce(name: string, all: readonly Expr[], ctx: Ctx): Expr {
  // `count` asks how many, not what they are — it never looks inside an
  // element, so a list of points answers it as readily as a list of numbers.
  if (name === 'count') return num(all.length);
  if (all.some(it => it.kind === 'vec')) {
    if (name === 'sort') throw new Error(SORT_POINTS);
    // A total or mean of points is taken coordinate by coordinate.
    if ((name === 'total' || name === 'mean') && all.every(it => it.kind === 'vec')) {
      const dims = (all[0] as Expr & { kind: 'vec' }).items.length;
      if (all.some(it => (it as Expr & { kind: 'vec' }).items.length !== dims)) {
        throw new Error('All points in a list need the same number of coordinates.');
      }
      return {
        kind: 'vec',
        items: Array.from({ length: dims }, (_, k) =>
          reduce(
            name,
            all.map(it => (it as Expr & { kind: 'vec' }).items[k]),
            ctx,
          ),
        ),
      };
    }
    throw new Error(`${name}(…) over a list of points is not supported yet.`);
  }
  // Gaps leave the same way they leave a typed array (reduceData) — the rule
  // cannot depend on which representation the column happens to be in.
  // `mean(person.age)` skipped the missing cells; `mean(person.age t)`, one
  // slider away, folded them in and answered NaN.
  const items = all.filter(it => !holdsGap(it));
  const n = items.length;
  // The empty multiset `[]`: a sum over nothing is 0; anything that picks or
  // averages a value has none to pick.
  if (!all.length) {
    if (name === 'total') return num(0);
    if (name === 'sort') return listOf([], ctx);
    throw new Error(`${name}(…) of an empty list has no value.`);
  }
  if (!n) {
    throw new Error(`${name}(…) has no values to work with — every cell there is missing.`);
  }
  switch (name) {
    case 'total':
    case 'mean': {
      const acc = fold(items, add) ?? num(0);
      return name === 'total' ? acc : div(acc, num(n));
    }
    case 'min':
    case 'max':
      return fold(items, (a, b) => ({ kind: 'call', name, args: [a, b] }))!;
    case 'stdev': {
      if (n < 2) throw new Error('stdev needs at least 2 elements.');
      const xs = numericItems(items, ctx, name);
      const mean = xs.reduce((a, b) => a + b, 0) / n;
      return num(Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)));
    }
    case 'median': {
      const xs = numericItems(items, ctx, name).sort((a, b) => a - b);
      return num(n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2);
    }
    case 'sort':
      return listOf(
        numericItems(items, ctx, name)
          .sort((a, b) => a - b)
          .map(num),
        ctx,
      );
  }
  throw new Error(`Unknown reduction: ${name}.`);
}

const SORT_POINTS = 'Points have no order of their own — sort them by a key written in the list: sort(P, P.x).';

/**
 * `sort(P, key)`: the elements of P as a tuple, in ascending order of the key
 * (docs/multisets.md §3). The key is written in P — `sort(P, P.x)`,
 * `sort((s, sin(s)), s)`, `sort((person.x, person.y), person.row)` — so it
 * runs over the very same instances and each element carries its own key.
 *
 * Whatever representation P has, the sorted tuple keeps it: a column stays a
 * typed array, a template keeps its one body with its columns permuted, so
 * sorting 100 000 rows moves numbers, never builds 100 000 trees.
 */
function sortBy(p: Expr, key: Expr, ctx: Ctx): Expr {
  const usage = 'sort(P, key) orders P by a key written in P, like sort(P, P.x).';
  const scatter = isDataScatter(p) ? (p as Expr & { kind: 'vec' }) : null;
  const own = scatter ? axesOf(scatter.items.find(isData) as Seq) : isSeq(p) ? axesOf(p) : null;
  if (!own) throw new Error(usage);
  if (isText(p)) throw new Error('sort(…) orders numbers or points; that column holds text.');
  // Identical, not merely as long: a key from another list would pair up
  // elements that have nothing to do with each other. A key over some of
  // P's instances is fine — sort(L + M, L) — and every element of P takes
  // the key of the instance it came from (ties stay in order).
  const keyAxes = isSeq(key) ? axesOf(key) : [];
  if (!isSeq(key) || !keyAxes.length || keyAxes.some(a => !own.some(o => o.id === a.id))) {
    throw new Error(
      'The sort key has to be written in the list it sorts, so each element carries its own: sort(P, P.x).',
    );
  }
  const n = own.reduce((size, a) => size * a.n, 1);
  const same = keyAxes.length === own.length && keyAxes.every((a, i) => a.id === own[i].id);
  const spread = same
    ? key
    : (align([withAxes({ kind: 'data', values: new Float64Array(n) } as Expr, own), key]).parts[1] as Seq);
  const keys = sortKeys(spread, ctx);
  // Stable, and a missing key (a gap) leaves its element out, as sort(L) does.
  const order = Int32Array.from({ length: n }, (_, k) => k).filter(k => !Number.isNaN(keys[k]));
  order.sort((a, b) => keys[a] - keys[b] || a - b);
  const axes = [tupleAxis(order.length)];
  const pick = (values: Float64Array): Float64Array => Float64Array.from(order, k => values[k]);
  if (scatter) {
    return {
      kind: 'vec',
      items: scatter.items.map(it => (isData(it) ? withAxes(dataOf(pick(it.values), ctx), axes) : it)),
    };
  }
  const seq = p as Seq;
  if (isData(seq)) return withAxes(dataOf(pick(seq.values), ctx), axes);
  if (isLazy(seq)) {
    return withAxes(
      { kind: 'lazy', body: seq.body, cols: seq.cols.map(c => ({ name: c.name, values: pick(c.values) })) },
      axes,
    );
  }
  const items = (seq as Expr & { kind: 'list' }).items;
  return withAxes(
    listOf(
      Array.from(order, k => items[k]),
      ctx,
    ),
    axes,
  );
}

/** A sort key's value per element, from constants and sliders like a filter's. */
function sortKeys(key: Seq, ctx: Ctx): Float64Array {
  if (isData(key)) return key.values;
  if (isText(key)) throw new Error('A sort key has to be a number; that column holds text.');
  const env: Record<string, number> = {};
  const bind = (e: Expr): void => {
    for (const fv of freeVars(e)) {
      if (fv in env || fv.startsWith('@')) continue;
      const v = ctx.opts.consts?.[fv];
      if (v === undefined) {
        throw new Error(
          fv === 't'
            ? 'A sort key cannot depend on t — the order would change every frame.'
            : `A sort key must be constant — add "${fv} = 5" in a row above.`,
        );
      }
      env[fv] = v;
    }
  };
  if (isLazy(key)) {
    bind(key.body);
    const out = new Float64Array(seqLength(key));
    for (let k = 0; k < out.length; k++) {
      for (const c of key.cols) env[c.name] = c.values[k];
      out[k] = evaluate(key.body, env);
    }
    return out;
  }
  return Float64Array.from(key.items, it => {
    if (it.kind === 'vec') throw new Error('A sort key has to be a number per element, like P.x.');
    bind(it);
    return evaluate(it, env);
  });
}

/** A point, or a multiset of them: an element of a tuple of points. */
const isPointValue = (e: Expr): boolean =>
  e.kind === 'vec' ||
  isDataScatter(e) ||
  (isList(e) && e.items[0]?.kind === 'vec') ||
  (isLazy(e) && e.body.kind === 'vec');

/**
 * A tuple literal that is not a point: `(1, 2, 3, 5, 8)`, or a tuple of points
 * `((0, 0), (1, 1), (2, 0))`, which is also a matrix — the consumer decides
 * (docs/multisets.md §3). Its positions are one tuple axis; a multiset among
 * its items makes a multiset of tuples, the tuple axis innermost.
 */
function tupleOf(items: Expr[], ctx: Ctx): Expr {
  const n = items.length;
  // (A tuple of tuples written out is a tensor, which geometry lowering
  // builds; one that reaches here is built over a multiset.)
  if (items.some(isTuple)) {
    throw new Error(
      'A tensor over a list — a tuple of tuples with a list inside — is not supported yet: take one element at a time, or write the tensor out on a row of its own.',
    );
  }
  const { parts, axes } = align(items.map(it => (isDataScatter(it) ? scatterPoints(it) : it)));
  if (!axes) return withAxes(listOf(parts, ctx), [tupleAxis(n)]);
  const total = axes.reduce((size, a) => size * a.n, 1);
  const columns = parts.map(p => (isSeq(p) ? (expand(settle(p, ctx), ctx) as Expr & { kind: 'list' }).items : null));
  const out: Expr[] = new Array(total * n);
  for (let c = 0; c < total; c++) for (let k = 0; k < n; k++) out[c * n + k] = columns[k]?.[c] ?? parts[k];
  return withAxes(listOf(out, ctx), [...axes, tupleAxis(n)]);
}

/** A scatter of columns as one point per row, over the columns' instances. */
function scatterPoints(e: Expr): Expr {
  const items = (e as Expr & { kind: 'vec' }).items;
  const first = items.find(isData)!;
  return withAxes(
    {
      kind: 'list',
      items: Array.from(first.values, (_, k): Expr => ({
        kind: 'vec',
        items: items.map(c => (isData(c) ? num(c.values[k]) : c)),
      })),
    },
    axesOf(first),
  );
}

/** Bins for n values, when the row did not say: about √n, kept readable. */
const binCount = (n: number): number => Math.min(60, Math.max(5, Math.round(Math.sqrt(n))));

/**
 * Bin values into a histogram. The result is a call node carrying three
 * typed arrays — centers, counts, and one bin width — which classify turns
 * into a bar row; it is not a value, so it may not feed anything else.
 * Missing values (NaN) are left out, exactly as filtering leaves them out.
 */
function histBars(centers: Float64Array, counts: Float64Array, width: number, ctx: Ctx): Expr {
  ctx.hists++;
  return {
    kind: 'hist',
    centers: (dataOf(centers, ctx) as Expr & { kind: 'data' }).values,
    counts: (dataOf(counts, ctx) as Expr & { kind: 'data' }).values,
    width,
  };
}

const oneBin = (at: number, count: number, ctx: Ctx): Expr =>
  histBars(Float64Array.of(at), Float64Array.of(count), 1, ctx);

const isHist = (e: Expr): e is Expr & { kind: 'hist' } => e.kind === 'hist';

/**
 * `hist(L) / 1000`, `0.001 hist(L)` — scale the bars.
 *
 * The plane has one scale for both axes (a circle has to look like a circle),
 * so counts in the thousands cannot share a view with values in the units.
 * Rather than pick a normalization and call it the truth, the row says what
 * it wants: the counts are still counts, divided by a number you can see.
 */
function scaleHist(op: string, a: Expr, b: Expr, ctx: Ctx): Expr | null {
  const hist = isHist(a) ? a : isHist(b) ? b : null;
  if (!hist) return null;
  const other = hist === a ? b : a;
  if (other.kind !== 'num' || !(op === '*' || (op === '/' && hist === a))) {
    throw new Error('hist(…) is a whole plot — it can only be scaled, as hist(L)/1000.');
  }
  const factor = op === '*' ? other.value : 1 / other.value;
  const counts = hist.counts;
  const scaled = new Float64Array(counts.length);
  for (let k = 0; k < counts.length; k++) scaled[k] = counts[k] * factor;
  // The original bars were counted once; only their heights change.
  ctx.hists--;
  return histBars(hist.centers, scaled, hist.width, ctx);
}

function histogram(xs: Float64Array, bins: number | null, ctx: Ctx): Expr {
  const finite = xs.filter(v => isFinite(v));
  if (!finite.length) throw new Error('hist(…) needs at least one value.');
  let lo = finite[0];
  let hi = finite[0];
  for (const v of finite) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // Every value identical: one bin, a unit wide, centred on the value —
  // splitting a single value across bins says nothing.
  if (hi === lo) return oneBin(lo, finite.length, ctx);
  const k = bins ?? binCount(finite.length);
  const width = (hi - lo) / k;
  const counts = new Float64Array(k);
  for (const v of finite) {
    // The top edge belongs to the last bin, not to a bin past the end.
    const at = Math.min(k - 1, Math.floor((v - lo) / width));
    counts[at]++;
  }
  const centers = new Float64Array(k);
  for (let i = 0; i < k; i++) centers[i] = lo + (i + 0.5) * width;
  return histBars(centers, counts, width, ctx);
}

/** Keep the elements of a list where a filter holds. */
function cutBy(low: Exclude<Seq, { kind: 'lazy' }>, keep: readonly boolean[], idx: Expr, ctx: Ctx): Expr {
  const n = keep.length;
  const kept = keep.reduce((c, k) => c + (k ? 1 : 0), 0);
  // The same cut of the same list is the same instances, however many
  // times it is written: (L[L > 2], L[L > 2]^2) still pairs up.
  const test = JSON.stringify(idx, (key, v) => (ArrayBuffer.isView(v) ? undefined : exprReplacer(key, v)));
  // (A filter keeps the order of what it filters: a cut of a tuple is one.)
  const own = axesOf(low);
  const cut: Axis[] | null =
    own.length === 1 && own[0].ordered
      ? [tupleAxis(kept)]
      : test.length > 4096
        ? null
        : [
            {
              id: `${own.map(a => a.id).join('×')}[${test}]`,
              n: kept,
            },
          ];
  if (isData(low)) {
    const out = new Float64Array(kept);
    let at = 0;
    for (let k = 0; k < n; k++) if (keep[k]) out[at++] = low.values[k];
    return withAxes(dataOf(out, ctx), cut);
  }
  if (isText(low)) return withAxes({ kind: 'text', values: low.values.filter((_, k) => keep[k]) }, cut);
  return withAxes(
    listOf(
      low.items.filter((_, k) => keep[k]),
      ctx,
    ),
    cut,
  );
}

function lowerIndex(e: Expr & { kind: 'index' }, ctx: Ctx): Expr {
  const [target, idx] = e.args;
  // Before anything is lowered, because lowering a column whose file is not
  // on this device throws first and would leave this row reported as merely
  // device-local — valid in a shared link, rejected for the author.
  const issue = ctx.opts.indexIssue?.(idx, target);
  if (issue) throw new Error(issue);
  const lowered = settle(lower(target, ctx), ctx);
  // A point is a tuple of its coordinates (docs/multisets.md §3): a named
  // one, T = (3, 1, 2), reaches here as (T_x, T_y, T_z) and T[2] is T_y.
  const point =
    lowered.kind === 'vec' && !isSeq(lowered) && lowered.items.every(it => it.kind !== 'vec' && !isSeq(it))
      ? withAxes<Expr>({ kind: 'list', items: lowered.items }, [tupleAxis(lowered.items.length)])
      : null;
  const low = (point ?? (isDataScatter(lowered) ? scatterPoints(lowered) : lowered)) as Exclude<Expr, { kind: 'lazy' }>;
  if (!isSeq(low)) {
    const name = target.kind === 'var' ? target.name : 'this';
    throw new Error(`${name} is not a list here — define it above where it is used.`);
  }
  const n = seqLength(low);
  const idxLow = lowerCond(idx, ctx);
  const keep = maskValues(idxLow, ctx.opts);
  if (keep) {
    if (keep.length !== n) {
      throw new Error(`The filter tests ${keep.length} values but the list has ${n}.`);
    }
    return cutBy(low, keep, idx, ctx);
  }
  // Anything but a filter picks by position, and only a tuple has positions.
  const axes = axesOf(low);
  const ordered = axes.findIndex(a => a.ordered);
  if (ordered < 0) throw new Error(needsOrder(target, idx, low));
  if (axes.length > 1) {
    // A multiset of tuples: position k of each, over the multiset.
    if (isSeq(idxLow)) throw new Error('A multiset of tuples takes one index at a time: T[2].');
    const n = axes[ordered].n;
    const k = Math.round(constVal(idxLow, ctx, 'A list index', true));
    if (k < 1 || k > n) throw new Error(`Index ${k} is out of range — each tuple has ${n} elements.`);
    const inner = axes.slice(ordered + 1).reduce((size, a) => size * a.n, 1);
    const outer = axes.slice(0, ordered).reduce((size, a) => size * a.n, 1);
    const at = Array.from(
      { length: outer * inner },
      (_, j) => Math.floor(j / inner) * n * inner + (k - 1) * inner + (j % inner),
    );
    const rest = axes.filter((_, i) => i !== ordered);
    if (isData(low))
      return withAxes(
        dataOf(
          Float64Array.from(at, j => low.values[j]),
          ctx,
        ),
        rest,
      );
    if (isText(low)) return withAxes({ kind: 'text', values: at.map(j => low.values[j]) }, rest);
    return withAxes(
      listOf(
        at.map(j => (low as Expr & { kind: 'list' }).items[j]),
        ctx,
      ),
      rest,
    );
  }
  const position = (v: number): number => {
    const k = Math.round(v);
    if (Math.abs(v - k) > 1e-9) throw new Error('List indices must be whole numbers.');
    if (k === 0) throw new Error('Lists are 1-based: the first element is L[1].');
    if (k < 1 || k > n) {
      throw new Error(`Index ${k} is out of range — the list has ${n} element${n === 1 ? '' : 's'}.`);
    }
    return k - 1;
  };
  // A list of indices picks one element each, over the index list's own
  // instances: `L[N]` zips with every other use of N.
  if (isSeq(idxLow)) {
    const at = Array.from(
      numbersOf(isLazy(idxLow) ? (settle(idxLow, ctx) as Seq) : idxLow) ??
        (expand(idxLow, ctx) as Expr & { kind: 'list' }).items.map(it => constVal(it, ctx, 'A list index', true)),
      position,
    );
    // A slice T[2..4] keeps the tuple's order; any other list of indices
    // picks over its own instances.
    const slice = idx.kind === 'list' && idx.items.length === 1 && idx.items[0].kind === 'range';
    const axes = slice ? [tupleAxis(at.length)] : axesOf(idxLow);
    if (isData(low))
      return withAxes(
        dataOf(
          Float64Array.from(at, k => low.values[k]),
          ctx,
        ),
        axes,
      );
    if (isText(low)) return withAxes({ kind: 'text', values: at.map(k => low.values[k]) }, axes);
    return withAxes(
      listOf(
        at.map(k => low.items[k]),
        ctx,
      ),
      axes,
    );
  }
  const k = position(constVal(idxLow, ctx, 'A list index', true));
  if (isData(low)) return num(low.values[k]);
  if (isText(low)) return { kind: 'str', value: low.values[k] };
  return low.items[k];
}

/** What `L[k]` says when L is a multiset: it has no positions, and sort is
 *  the way to give it some (docs/multisets.md §3). */
function needsOrder(target: Expr, idx: Expr, low: Seq): string {
  // A state family's runs are in order only when their starts are (defs.ts).
  if (axesOf(low)[0].id.endsWith('#runs')) {
    const name = target.kind === 'var' ? target.name : 'p';
    const k = idx.kind === 'num' ? String(idx.value) : 'k';
    return `${name}[${k}] needs an order — its runs start from a list [ … ], which has none. Start them from a tuple to number them: ${name}(0) = (sort([1..4]), 0).`;
  }
  const points = isList(low) && low.items[0]?.kind === 'vec';
  if (target.kind === 'list') {
    const k = idx.kind === 'num' ? String(idx.value) : 'k';
    return `[ … ][${k}] needs an order — a list [ … ] has none. Sort it: ${points ? 'sort(P, P.x)' : 'sort([ … ])'}[${k}].`;
  }
  return orderMessage(target.kind === 'var' ? target.name : 'L', idx, points);
}

/** The words of needsOrder, for a caller that knows the shape without the
 *  bytes (a data column is always a multiset: defs.ts indexIssue). */
export function orderMessage(name: string, idx: Expr, points: boolean): string {
  const k = idx.kind === 'num' ? String(idx.value) : idx.kind === 'var' ? idx.name : 'k';
  const dot = name.indexOf('.');
  const sorted = points
    ? `sort(${name}, ${name}.x)`
    : dot > 0
      ? `sort(${name}, ${name.slice(0, dot)}.row)`
      : `sort(${name})`;
  return `${name}[${k}] needs an order — a list [ … ] has none. Sort it: ${sorted}[${k}].`;
}

/**
 * f(P) for a list of points: the list of their k-th coordinates, over the
 * instances P itself runs over. All n components come from the one value, so
 * they zip back together — f(P) on a 21×21 lattice is 441 points, not 441².
 */
function lowerComp(e: Expr & { kind: 'comp' }, ctx: Ctx): Expr {
  const { value, index: k, arity: n, functionName: fn } = e;
  let low = ctx.comps.get(value);
  if (!low) ctx.comps.set(value, (low = lower(value, ctx)));
  const dims = (got: number): void => {
    if (got !== n) throw new Error(compDims(fn, n, value, got));
  };
  // A template of points: its k-th coordinate is the template's.
  if (isLazy(low) && low.body.kind === 'vec') {
    dims(low.body.items.length);
    return withAxes({ kind: 'lazy', cols: low.cols, body: low.body.items[k] }, axesOf(low));
  }
  low = settle(low, ctx);
  // A scatter of columns: its k-th component is just its k-th column.
  if (low.kind === 'vec' && isDataScatter(low)) {
    dims(low.items.length);
    return low.items[k];
  }
  if (!isList(low) || !low.items.length || !low.items.every(it => it.kind === 'vec')) throw new Error(compArity(fn, n));
  for (const it of low.items) dims((it as Expr & { kind: 'vec' }).items.length);
  return withAxes(
    listOf(
      low.items.map(it => (it as Expr & { kind: 'vec' }).items[k]),
      ctx,
    ),
    axesOf(low),
  );
}

/**
 * A comparison where a condition is expected — inside `L[…]` or a `{…}`
 * piecewise — is decided element by element: over a list it lowers to a
 * mask, one comparison per element, which the caller keeps or drops by.
 */
function lowerCond(e: Expr, ctx: Ctx): Expr {
  if (e.kind === 'eqtest') {
    const parts = e.args.map(a => expand(lower(a, ctx), ctx));
    if (!parts.some(isList)) {
      throw new Error(
        `'${e.op}' tests the members of a list, like people.city == "NYC".` +
          (e.op === '!='
            ? " For a factorial equation, put a space before '=': x! = 2."
            : " An equation takes a single '=': x^2 = y."),
      );
    }
    return zipN(parts, comps => ({ ...e, args: [comps[0], comps[1]] }), ctx);
  }
  if (e.kind !== 'eq' && e.kind !== 'ineq') return lower(e, ctx);
  // Comparisons are the symbolic path: a mask is per-element structure (and
  // chains nest, so a chain's inner comparison is a condition too), so a
  // typed array expands here.
  const l = expand(e.l.kind === 'ineq' && e.l.grouped ? lower(e.l, ctx) : lowerCond(e.l, ctx), ctx);
  const r = expand(lower(e.r, ctx), ctx);
  if (e.kind === 'ineq' && (isList(l) || isList(r))) {
    return zipN([l, r], ([a, b]) => ({ kind: 'ineq', op: e.op, l: a, r: b }), ctx);
  }
  if (isList(l) || isList(r)) {
    throw new Error('Cannot put a list in an equation — to keep the members equal to a value, write L == 2.');
  }
  return e.kind === 'eq' ? { kind: 'eq', l, r } : { ...e, l, r };
}

/**
 * A comparison as a value keeps the members of the multiset it runs over
 * (docs/multisets.md §4): `[1,2,3] < 3` is [1, 2], just as `x < 3` is the
 * reals below 3. The members are those of the multiset, not the values
 * compared: `L^2 < 4` keeps members of L and `P.x < 0` keeps points of P,
 * as `x^2 < 4` shades x in (−2, 2). That multiset is the innermost part of
 * the comparison running over exactly the mask's instances; over two
 * separate multisets (`L < M`) the members are the pairs.
 */
function keptMembers(e: Expr, mask: Expr & { kind: 'list' }, ctx: Ctx): Expr {
  const want = axesOf(mask);
  const same = (a: readonly Axis[], b: readonly Axis[]) => a.length === b.length && a.every((x, k) => x.id === b[k].id);
  const lowered = (n: Expr): Expr | null => {
    try {
      return lower(n, ctx);
    } catch {
      return null;
    }
  };
  // Children first, so the innermost part wins: P over P.x.
  const find = (n: Expr, axes: readonly Axis[]): Expr | null => {
    for (const c of childrenOf(n)) {
      const hit = find(c, axes);
      if (hit) return hit;
    }
    // A comparison is no multiset of its own, unless written in parentheses
    // as an operand: its kept members are, ([1,2,3] > 1) > 1.
    if ((n.kind === 'ineq' && !n.grouped) || n.kind === 'eq' || n.kind === 'eqtest') return null;
    // A member column (P.x) belongs to the list it is read from.
    const dot = n.kind === 'var' ? n.name.lastIndexOf('.') : -1;
    if (n.kind === 'var' && dot > 0) {
      const base = find({ kind: 'var', name: n.name.slice(0, dot) }, axes);
      if (base) return base;
    }
    const low = lowered(n);
    return low && isSeq(low) && same(axesOf(low), axes) ? n : null;
  };
  let subject = find(e, want);
  if (!subject && want.length > 1) {
    const parts = want.map(a => find(e, [a]));
    if (parts.every(p => p !== null)) subject = { kind: 'vec', items: parts as Expr[] };
  }
  const low = subject && lowered(subject);
  const got = low && settle(low, ctx);
  if (!got || !isSeq(got) || isLazy(got) || !same(axesOf(got), want)) {
    throw new Error(
      'This comparison runs over more than one list in a way that has no members to keep — filter with L[…].',
    );
  }
  return cutBy(got, maskValues(mask, ctx.opts)!, e, ctx);
}

function lower(e: Expr, ctx: Ctx): Expr {
  switch (e.kind) {
    case 'range':
      throw new Error(structuralDiagnostic(e));
    case 'hist':
      return e;
    case 'figure':
    case 'trail':
    case 'label':
    case 'family':
      return mapChildren(e, n => {
        const child = lower(n, ctx);
        if (isSeq(child)) throw new Error(`Lists cannot appear inside ${e.kind === 'figure' ? e.form : e.kind}(…).`);
        return child;
      });
    case 'num':
    case 'data':
    case 'str':
    case 'text':
    case 'lazy':
      return e;
    case 'var': {
      const hit = ctx.getList(e.name);
      if (!hit) return e;
      // A `list` node's items belong to the definition: copy before anything
      // downstream can hold on to the array.
      // (A scatter of columns is a `vec`: a value to name, not a list.)
      if (!isSeq(hit)) return hit;
      return withAxes(isList(hit) ? listOf([...hit.items], ctx) : { ...hit }, namedAxes(e.name, hit));
    }
    case 'neg': {
      const a = lower(e.a, ctx);
      return (
        fastMap([a], xs => -xs[0], ctx) ??
        lazyMap([a], ([x]) => ({ kind: 'neg', a: x }), ctx) ??
        zipN([expand(a, ctx)], ([x]) => ({ kind: 'neg', a: x }), ctx)
      );
    }
    case 'bin': {
      const a = lower(e.a, ctx);
      const b = lower(e.b, ctx);
      const scaled = scaleHist(e.op, a, b, ctx);
      if (scaled) return scaled;
      const op = BIN_OPS[e.op];
      return (
        fastMap([a, b], xs => op(xs[0], xs[1]), ctx) ??
        lazyMap([a, b], ([x, y]) => ({ kind: 'bin', op: e.op, a: x, b: y }), ctx) ??
        zipN([expand(a, ctx), expand(b, ctx)], ([x, y]) => ({ kind: 'bin', op: e.op, a: x, b: y }), ctx)
      );
    }
    case 'eqtest': {
      const mask = lowerCond(e, ctx);
      return isMask(mask) ? keptMembers(e, mask, ctx) : mask;
    }
    case 'index':
      return lowerIndex(e, ctx);
    case 'comp':
      return lowerComp(e, ctx);
    case 'call': {
      if (e.name === 'hist') {
        // How many arguments there are, and what the bin count is, are
        // questions about the row — not about the file. Asked after the list
        // is lowered they are never reached on a device without the bytes,
        // and `hist(person.age, 1)` reads as a valid row there while the
        // author who has the file is told the bin count is out of range. The
        // same reasoning as lowerIndex: settle everything the shape decides
        // BEFORE resolving an operand that can be absent.
        if (e.args.length > 2) throw new Error('hist(…) takes a list and, optionally, a number of bins.');
        const binsArg = e.args[1] === undefined ? undefined : lower(e.args[1], ctx);
        const bins = binsArg === undefined ? null : constVal(binsArg, ctx, 'The number of bins', true);
        if (bins !== null && !Number.isInteger(bins)) {
          // Rounding would change what the row means without saying so, and
          // an index in the same position refuses a fraction outright.
          throw new Error(`hist(…) takes a whole number of bins; that is ${bins}.`);
        }
        if (bins !== null && (bins < 2 || bins > 500)) {
          throw new Error('hist(…) takes 2 to 500 bins.');
        }
        const arg = e.args[0] === undefined ? undefined : settle(lower(e.args[0], ctx), ctx);
        if (!arg || !isSeq(arg)) throw new Error('hist(…) needs a list, like hist(person.age).');
        if (isText(arg)) throw new Error('hist(…) counts numbers; that column holds text.');
        // Gaps go before the values are read, not after: `hist(person.age)`
        // skips them (histogram drops non-finite values), and one slider
        // later `hist(person.age k)` refused the whole row as "not finite".
        const xs = isData(arg)
          ? arg.values
          : Float64Array.from(
              numericItems(
                arg.items.filter(it => !holdsGap(it)),
                ctx,
                'hist',
              ),
            );
        return histogram(xs, bins, ctx);
      }
      const args = e.args.map(a => lower(a, ctx));
      if (e.name === 'sort' && args.length === 2) return sortBy(args[0], args[1], ctx);
      const isMinMax = e.name === 'min' || e.name === 'max';
      if (
        SYMBOLIC_REDUCTIONS.has(e.name) ||
        NUMERIC_REDUCTIONS.has(e.name) ||
        (isMinMax && args.length === 1 && isSeq(args[0]))
      ) {
        if (args.length !== 1 || !isSeq(args[0])) {
          if (args.length === 1 && args[0].kind === 'var') {
            throw new Error(`${e.name}(${args[0].name}) needs ${args[0].name} to be a list defined above this row.`);
          }
          throw new Error(`${e.name}(…) needs a list, like ${e.name}([1, 4, 2]).`);
        }
        const arg = settle(args[0], ctx) as Seq;
        if (isText(arg)) {
          // count is the only reduction text has an answer for.
          if (e.name === 'count') return num(arg.values.length);
          throw new Error(`${e.name}(…) needs numbers; that column holds text.`);
        }
        // A multiset of tuples (the positions stored innermost) is reduced
        // tuple by tuple: count counts the tuples, and total and mean are
        // taken position by position, as they are for points.
        const own = axesOf(arg);
        const tupleAt = own.findIndex(a => a.ordered);
        if (e.name !== 'sort' && own.length > 1 && tupleAt === own.length - 1) {
          const width = own[tupleAt].n;
          const all = isData(arg) ? Array.from(arg.values, num) : (arg as Expr & { kind: 'list' }).items;
          if (e.name === 'count') return num(all.length / width);
          if (e.name !== 'total' && e.name !== 'mean') {
            throw new Error(
              `${e.name}(…) of a multiset of ${width}-tuples is not defined — only count, total and mean are.`,
            );
          }
          const at = (k: number) => all.filter((_, i) => i % width === k);
          return withAxes(
            listOf(
              Array.from({ length: width }, (_, k) => reduce(e.name, at(k), ctx)),
              ctx,
            ),
            [tupleAxis(width)],
          );
        }
        const reduced = isData(arg)
          ? reduceData(e.name, arg.values, ctx)
          : reduce(e.name, (arg as Expr & { kind: 'list' }).items, ctx);
        // sort is the bridge from a multiset to a tuple (docs/multisets.md §3):
        // the same values, now at positions.
        return isSeq(reduced) ? withAxes(reduced, [tupleAxis(seqLength(reduced))]) : reduced;
      }
      if (!args.some(isSeq)) return { kind: 'call', name: e.name, args };
      if (e.name === 'revolve') {
        // Only a list PROFILE is a family waiting for its plan; a list in the
        // axis position is just not an axis.
        if (!isSeq(args[0])) return { kind: 'call', name: e.name, args }; // classify refuses the axis
        throw new Error('revolve of a list is not supported yet — write one revolve(…) row per profile.');
      }
      if (NO_LIST_INSIDE.has(e.name)) {
        throw new Error(`Lists cannot appear inside ${plainFnName(e.name)}(…).`);
      }
      // Scalar builtins map elementwise: sin(L), atan2(L, M), min(L, 5).
      const fn = EVAL_FNS[e.name];
      const fast = fn && fastMap(args, xs => fn(...xs), ctx);
      return (
        fast ??
        lazyMap(args, comps => ({ kind: 'call', name: e.name, args: comps }), ctx) ??
        zipN(
          args.map(a => expand(a, ctx)),
          comps => ({ kind: 'call', name: e.name, args: comps }),
          ctx,
        )
      );
    }
    case 'vec': {
      const items = e.items.map(it => lower(it, ctx));
      // Longer than a point, or a tuple of points: values at positions.
      if (items.length > 3 || items.some(isPointValue)) return tupleOf(items, ctx);
      // A scatter of columns stays two typed arrays rather than N points:
      // classify reads the coordinates straight out of them.
      if (items.some(isData) && items.every(it => isData(it) || it.kind === 'num')) {
        return { kind: 'vec', items: align(items).parts };
      }
      return (
        lazyMap(items, comps => ({ kind: 'vec', items: comps }), ctx) ??
        zipN(
          items.map(it => expand(it, ctx)),
          comps => ({ kind: 'vec', items: comps }),
          ctx,
        )
      );
    }
    case 'list': {
      // A literal is a new origin; a list lowered earlier (an index the
      // object pass settled first) keeps the instances it already had.
      // The origin is the literal itself, not this visit to it: expanding
      // M (0, [-1,1]) writes the same literal into every output component,
      // and those are one list, not several.
      const items = expandItems(e.items, ctx);
      const out = listOf(items, ctx) as Seq;
      // (…nor this COPY of it: a literal marked with its origin is one list
      // in every clone Σ expansion or a finite difference made of it.)
      const known = e.axes;
      const origin = originOf(e);
      const width = items.width ?? 1;
      const elements = seqLength(out) / width;
      const own: Axis[] =
        origin !== undefined ? [{ id: `#o${origin}`, n: elements }] : [{ id: `#${++anonymous}`, n: elements }];
      const axes =
        known && known.reduce((size, a) => size * a.n, 1) === seqLength(out)
          ? known
          : items.width !== undefined
            ? [...own, tupleAxis(width)]
            : origin !== undefined
              ? own
              : axesOf(out);
      e.axes = axes;
      return withAxes(out, axes);
    }
    case 'eq':
    case 'ineq': {
      const mask = lowerCond(e, ctx);
      return isMask(mask) ? keptMembers(e, mask, ctx) : mask;
    }
    case 'piecewise': {
      const cases = e.cases.map(c => ({ cond: lowerCond(c.cond, ctx), value: lower(c.value, ctx) }));
      const otherwise = e.otherwise && lower(e.otherwise, ctx);
      if (cases.some(c => isSeq(c.value)) || (otherwise && isSeq(otherwise))) {
        throw new Error('Lists are not supported inside {…} piecewise yet.');
      }
      return { kind: 'piecewise', cases, otherwise };
    }
    case 'loop': {
      const lowered = mapChildren(e, n => lower(n, ctx));
      if (childrenOf(lowered).some(isSeq)) throw new Error('Lists are not supported in a recursive function yet.');
      return lowered;
    }
  }
}

/**
 * Eliminate lists from a resolved, geometry-lowered expression. The result
 * is either an ordinary scalar expression or a top-level list literal of
 * scalars/points, ready for classify. `opts` supplies constant values for
 * range bounds and indices (and collects boundConsts so their sliders snap
 * to integers), exactly as Σ/Π expansion does.
 */
export function lowerLists(
  e: Expr,
  getList: GetList,
  opts: ResolveOpts = {},
  /** A definition (`who = person.name`) rather than a row to draw. Text is a
   *  value like any other to name; it is only drawing one that has no
   *  meaning, so that check belongs to plot rows alone. */
  named = false,
  /** Hand back a `lazy` template as it is, rather than one tree per element:
   *  for a caller that evaluates the template itself (a connected figure). */
  packed = false,
): Expr {
  const ctx: Ctx = { getList, opts, items: 0, data: 0, hists: 0, comps: new WeakMap(), columns: 0 };
  const lowered = lower(e, ctx);
  const out = packed ? lowered : settle(lowered, ctx);
  if (isMask(out)) {
    throw new Error('A comparison over a list is a filter, not a plot — put it in brackets, like L[L > 2].');
  }
  if (!named && (out.kind === 'text' || out.kind === 'str')) {
    throw new Error(
      'Text cannot be plotted — count it, or keep another column where it holds, like people.age[people.city == "NYC"].',
    );
  }
  // Bars are a whole row, never a value — including a named one. `h = hist(L)`
  // would otherwise store the internal `[hist]` node as a constant and every
  // row touching it would report "Unknown function: [hist]", a token no user
  // ever typed.
  if (ctx.hists && !(!named && isHist(out))) {
    throw new Error(
      named
        ? 'hist(…) is a whole plot, not a value — write it on a row of its own, with no name.'
        : 'hist(…) is a whole plot — give it its own row.',
    );
  }
  return out;
}

/**
 * What a row shows for a tuple of numbers (docs/multisets.md §3). A tuple of
 * 2 or 3 numbers IS a point — `sort([3, 1, 2])` is the point (1, 2, 3) — and
 * a multiset of them is a multiset of points. A longer tuple is a `vec` of
 * its values, which classify reads out rather than draws. Everything else,
 * a tuple of points included, is left as it is.
 */
export function tupleRow(e: Expr): Expr {
  if (!isList(e) && !isData(e)) return e;
  const axes = axesOf(e);
  const at = axes.findIndex(a => a.ordered);
  if (at < 0) return e;
  const items = isData(e) ? [...e.values].map(num) : e.items;
  if (items.some(it => it.kind === 'vec')) return e;
  const n = axes[at].n;
  if (n < 2) return e;
  if (axes.length === 1) return { kind: 'vec', items };
  // (Positions are stored innermost: see unionAxes.)
  if (at !== axes.length - 1 || n > 3) {
    throw new Error(`A multiset of ${n}-tuples has no picture — only tuples of 2 or 3 numbers are points.`);
  }
  const points: Expr[] = [];
  for (let k = 0; k < items.length; k += n) points.push({ kind: 'vec', items: items.slice(k, k + n) });
  return withAxes({ kind: 'list', items: points }, axes.slice(0, -1));
}

/** A multiset of tuples of more than 3 numbers — [(1, 2, 3, 4), (5, 6, 7, 8)]
 *  — as its values back to back, `count` tuples of `width`, so its row can
 *  read out as a multiset of matrices does; null for anything else. */
export function tupleMultiset(e: Expr): { values: readonly Expr[]; width: number; count: number } | null {
  if (!isList(e) && !isData(e)) return null;
  const axes = axesOf(e);
  const width = axes.at(-1)?.n ?? 0;
  if (axes.length < 2 || !axes.at(-1)!.ordered || axes.slice(0, -1).some(a => a.ordered) || width <= 3) return null;
  const values = isData(e) ? Array.from(e.values, num) : e.items;
  if (values.some(it => it.kind === 'vec')) return null;
  return { values, width, count: values.length / width };
}

/** A tuple of more than 3 packed numbers — a sorted column — as its numbers,
 *  so its row can read out without a node per value; null for anything else. */
export function packedTuple(e: Expr): Float64Array | null {
  if (!isData(e) || e.values.length <= 3) return null;
  const axes = axesOf(e);
  return axes.length === 1 && axes[0].ordered ? e.values : null;
}

/**
 * Lower a filter's condition and decide it, for callers that filter
 * something other than a list — `adults = person[person.age >= 18]` cuts a
 * whole data file (defs.ts). Null when the condition is not a comparison
 * over a list.
 */
export function lowerMask(cond: Expr, getList: GetList, opts: ResolveOpts = {}): boolean[] | null {
  return maskValues(
    lowerCond(cond, { getList, opts, items: 0, data: 0, hists: 0, comps: new WeakMap(), columns: 0 }),
    opts,
  );
}

/** Whether a parsed (unresolved) row calls a list reduction — such rows get
 *  a numeric readout when they resolve to a constant, like ∫ rows. */
export function usesListReduction(e: Expr): boolean {
  const REDUCTIONS = new Set([...SYMBOLIC_REDUCTIONS, ...NUMERIC_REDUCTIONS]);
  // One-argument min/max reduce a list too (`min(person.age)`). The row is
  // unresolved here, so whether the argument IS a list is not yet known —
  // but a readout only appears if the row resolves to a number anyway.
  const reduces = (name: string, args: readonly Expr[]): boolean =>
    REDUCTIONS.has(name) || ((name === 'min' || name === 'max') && args.length === 1);
  switch (e.kind) {
    case 'index':
    case 'range':
    case 'eqtest':
    case 'comp':
    case 'figure':
    case 'lazy':
    case 'trail':
    case 'label':
    case 'hist':
    case 'family':
      return childrenOf(e).some(usesListReduction);
    case 'num':
    case 'data':
    case 'str':
    case 'text':
    case 'var':
      return false;
    case 'neg':
      return usesListReduction(e.a);
    case 'bin':
      return usesListReduction(e.a) || usesListReduction(e.b);
    case 'call':
      return reduces(e.name, e.args) || e.args.some(usesListReduction);
    case 'eq':
      return usesListReduction(e.l) || usesListReduction(e.r);
    case 'ineq':
      return usesListReduction(e.l) || usesListReduction(e.r);
    case 'vec':
    case 'list':
      return e.items.some(usesListReduction);
    case 'piecewise':
      return (
        e.cases.some(c => usesListReduction(c.cond) || usesListReduction(c.value)) ||
        (e.otherwise ? usesListReduction(e.otherwise) : false)
      );
    case 'loop':
      return childrenOf(e).some(usesListReduction);
  }
}
