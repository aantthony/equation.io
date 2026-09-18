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
 * - scalar ⊕ list maps elementwise; list ⊕ list zips, and mismatched
 *   lengths are an error — never a silent truncation.
 * - `(A, B)` with list components zips into a list of points.
 * - ranges [1..20] / [0, 0.5..10] / [10..1] expand here, where constant
 *   values are known (bounds behave like Σ bounds: constants and sliders).
 * - indexing is 1-based: L[1] is the first element.
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
 */
import { add, div, mul } from './diff.ts';
import type { ResolveOpts } from './defs.ts';
import { EVAL_FNS, type Expr, evaluate, freeVars, ineqComparisons, realPow } from './expr.ts';

/**
 * A list of values, in whichever representation it has: one expression per
 * element, a typed array of numbers, or a column of text. They are
 * interchangeable as values — the difference is only what they cost.
 */
export type Seq = Expr & { kind: 'list' | 'data' | 'text' };

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
 *  not among them: it hands back a list of the same length. */
export const SCALAR_REDUCTIONS = new Set(['mean', 'total', 'count', 'stdev', 'median']);

/** Reductions that lower symbolically — their elements may depend on t. */
const SYMBOLIC_REDUCTIONS = new Set(['mean', 'total', 'count']);
/** Reductions that need numeric elements (ordering), so a constant list. */
const NUMERIC_REDUCTIONS = new Set(['stdev', 'median', 'sort']);

/** Whole-plot forms a list can never appear inside. Exported because the
 *  shape-only checks in defs.ts have to refuse the same ones without the
 *  bytes, or a filter is valid exactly on the devices that cannot test it. */
export const NO_LIST_INSIDE = new Set([
  'domain', 'conformal', 'iter', 'tube',
  '[polygon]', '[segment]', '[polyline]', '[vector]', '[square]',
]);

/** The name such a call wears in a message: `[polygon]` is written polygon. */
export const plainFnName = (name: string): string =>
  (name.startsWith('[') ? name.slice(1, -1) : name);

interface Ctx {
  getList: GetList;
  opts: ResolveOpts;
  /** List elements materialized so far (ranges, zips, maps all count). */
  items: number;
  /** Numbers held in typed arrays built so far. */
  data: number;
  /** hist(…) nodes built: they are whole rows, not values. */
  hists: number;
}

const num = (value: number): Expr => ({ kind: 'num', value });

const isList = (e: Expr): e is Expr & { kind: 'list' } => e.kind === 'list';
const isData = (e: Expr): e is Expr & { kind: 'data' } => e.kind === 'data';
const isText = (e: Expr): e is Expr & { kind: 'text' } => e.kind === 'text';
/** Any representation of a list of values: expressions, numbers, or text. */
export const isSeq = (e: Expr): e is Seq => isList(e) || isData(e) || isText(e);
/**
 * A scatter of whole columns — `(person.age, person.height)` — kept as one
 * `vec` of typed arrays rather than one point per row, which is how classify
 * draws it and the only reason a 200 000-row file plots at all. A list of
 * values it is not, so it is not a `Seq`; a value a row may NAME it is.
 */
export const isDataScatter = (e: Expr): boolean =>
  e.kind === 'vec' && e.items.some(isData) && e.items.every(it => isData(it) || it.kind === 'num');
export const seqLength = (e: Seq): number =>
  (e.kind === 'list' ? e.items.length : e.values.length);
const isRange = (e: Expr): e is Expr & { kind: 'call' } =>
  e.kind === 'call' && e.name === '[range]';

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
function expand(e: Expr, ctx: Ctx): Expr {
  if (!isData(e) && !isText(e)) return e;
  const n = seqLength(e);
  if (n > ITEMS_MAX) {
    throw new Error(`That is ${n} values; only ${ITEMS_MAX} can be combined with sliders, t, or comparisons.`);
  }
  // Bounded by the check above, and NOT charged against the row's budget:
  // whatever consumes this list charges for the list it builds, and counting
  // both halved the usable size of the one operation the docs quote
  // (`col * t` failed at 50 001 rows against a stated limit of 100 000).
  return {
    kind: 'list',
    items: isText(e)
      ? e.values.map((value): Expr => ({ kind: 'str', value }))
      : [...e.values].map(num),
  };
}

/**
 * Combine operands elementwise as numbers, when they all are numbers: typed
 * arrays and literals only. A slider or an unresolved variable returns null,
 * so those keep the symbolic path and shaders keep their uniforms.
 */
function fastMap(parts: Expr[], f: (xs: number[]) => number, ctx: Ctx): Expr | null {
  let n: number | null = null;
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
  return dataOf(out, ctx);
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
function expandItems(raw: readonly Expr[], ctx: Ctx): Expr[] {
  const out: Expr[] = [];
  for (const item of raw) {
    if (!isRange(item)) {
      const low = lower(item, ctx);
      if (isSeq(low)) throw new Error('Lists cannot be nested.');
      out.push(low);
      continue;
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

/** Combine lowered operands elementwise: lists zip (equal lengths only),
 *  scalars broadcast. */
function zipN(parts: Expr[], build: (comps: Expr[]) => Expr, ctx: Ctx): Expr {
  let n: number | null = null;
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
  return listOf(items, ctx);
}

/**
 * A comparison over a list is a mask — the thing a filter selects with
 * (`L[L > 2]`, `person[person.age >= 18]`). It is not a value: only
 * indexing consumes one, and any other use reports itself.
 */
const isEquality = (e: Expr): e is Expr & { kind: 'call' } =>
  e.kind === 'call' && (e.name === '[eq]' || e.name === '[ne]');

const isMask = (e: Expr): e is Expr & { kind: 'list' } =>
  isList(e) && e.items.length > 0
  && e.items.every(it => it.kind === 'ineq' || isEquality(it));

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
      return cond.name === '[eq]' ? same : !same;
    }
    const a = evaluate(l, env);
    const b = evaluate(r, env);
    // A missing cell (NaN) fails every test, `!=` included: it is the absence
    // of a value, not a value that happens to differ. Otherwise the one
    // comparison that kept gaps would be the one written to exclude something.
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return cond.name === '[eq]' ? a === b : a !== b;
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
        throw new Error(fv === 't'
          ? 'A filter cannot depend on t — the list would change length every frame.'
          : `A filter must be constant — add "${fv} = 5" in a row above.`);
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
    case 'num': return Number.isNaN(e.value);
    case 'data': return e.values.some(Number.isNaN);
    case 'neg': return holdsGap(e.a);
    case 'bin': return holdsGap(e.a) || holdsGap(e.b);
    case 'call': return e.args.some(holdsGap);
    case 'vec':
    case 'list': return e.items.some(holdsGap);
    case 'eq': return holdsGap(e.l) || holdsGap(e.r);
    case 'ineq': return holdsGap(e.l) || holdsGap(e.r);
    case 'piecewise':
      return e.cases.some(c => holdsGap(c.cond) || holdsGap(c.value))
        || (e.otherwise ? holdsGap(e.otherwise) : false);
    default: return false;
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
    case 'min': return num(xs.reduce((a, b) => Math.min(a, b)));
    case 'max': return num(xs.reduce((a, b) => Math.max(a, b)));
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
    case 'sort': return dataOf(Float64Array.from(xs).sort(), ctx);
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
    throw new Error(`${name}(…) over a list of points is not supported yet.`);
  }
  // Gaps leave the same way they leave a typed array (reduceData) — the rule
  // cannot depend on which representation the column happens to be in.
  // `mean(person.age)` skipped the missing cells; `mean(person.age t)`, one
  // slider away, folded them in and answered NaN.
  const items = all.filter(it => !holdsGap(it));
  const n = items.length;
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
      return listOf(numericItems(items, ctx, name).sort((a, b) => a - b).map(num), ctx);
  }
  throw new Error(`Unknown reduction: ${name}.`);
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
    kind: 'call',
    name: '[hist]',
    args: [dataOf(centers, ctx), dataOf(counts, ctx), num(width)],
  };
}

const oneBin = (at: number, count: number, ctx: Ctx): Expr =>
  histBars(Float64Array.of(at), Float64Array.of(count), 1, ctx);

const isHist = (e: Expr): e is Expr & { kind: 'call' } =>
  e.kind === 'call' && e.name === '[hist]';

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
  const counts = (hist.args[1] as Expr & { kind: 'data' }).values;
  const scaled = new Float64Array(counts.length);
  for (let k = 0; k < counts.length; k++) scaled[k] = counts[k] * factor;
  // The original bars were counted once; only their heights change.
  ctx.hists--;
  return histBars((hist.args[0] as Expr & { kind: 'data' }).values, scaled,
    (hist.args[2] as Expr & { kind: 'num' }).value, ctx);
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

/** Exported because defs.ts answers the same question without the bytes
 *  (indexIssue), and the two devices must say the same sentence. */
export const SLICE = 'Slicing L[a..b] is not supported yet — index one element, like L[1].';

function lowerIndex(e: Expr & { kind: 'call' }, ctx: Ctx): Expr {
  const [target, idx] = e.args;
  // Before anything is lowered, because lowering a column whose file is not
  // on this device throws first and would leave this row reported as merely
  // device-local — valid in a shared link, rejected for the author.
  const issue = ctx.opts.indexIssue?.(idx);
  if (issue) throw new Error(issue);
  const low = lower(target, ctx);
  if (!isSeq(low)) {
    const name = target.kind === 'var' ? target.name : 'this';
    throw new Error(`${name} is not a list here — define it above where it is used.`);
  }
  const n = seqLength(low);
  const idxLow = lower(idx, ctx);
  const keep = maskValues(idxLow, ctx.opts);
  if (keep) {
    if (keep.length !== n) {
      throw new Error(`The filter tests ${keep.length} values but the list has ${n}.`);
    }
    const kept = keep.reduce((c, k) => c + (k ? 1 : 0), 0);
    if (!kept) throw new Error(`That filter keeps nothing (0 of ${keep.length}).`);
    if (isData(low)) {
      const out = new Float64Array(kept);
      let at = 0;
      for (let k = 0; k < n; k++) if (keep[k]) out[at++] = low.values[k];
      return dataOf(out, ctx);
    }
    if (isText(low)) return { kind: 'text', values: low.values.filter((_, k) => keep[k]) };
    return listOf(low.items.filter((_, k) => keep[k]), ctx);
  }
  if (isSeq(idxLow)) throw new Error(SLICE);
  const v = constVal(idxLow, ctx, 'A list index', true);
  const k = Math.round(v);
  if (Math.abs(v - k) > 1e-9) throw new Error('List indices must be whole numbers.');
  if (k === 0) throw new Error('Lists are 1-based: the first element is L[1].');
  if (k < 1 || k > n) {
    throw new Error(`Index ${k} is out of range — the list has ${n} element${n === 1 ? '' : 's'}.`);
  }
  if (isData(low)) return num(low.values[k - 1]);
  if (isText(low)) return { kind: 'str', value: low.values[k - 1] };
  return low.items[k - 1];
}

function lower(e: Expr, ctx: Ctx): Expr {
  switch (e.kind) {
    case 'num':
    case 'data':
    case 'str':
    case 'text':
      return e;
    case 'var': {
      const hit = ctx.getList(e.name);
      if (!hit) return e;
      // A `list` node's items belong to the definition: copy before anything
      // downstream can hold on to the array.
      return isList(hit) ? listOf([...hit.items], ctx) : hit;
    }
    case 'neg': {
      const a = lower(e.a, ctx);
      return fastMap([a], xs => -xs[0], ctx)
        ?? zipN([expand(a, ctx)], ([x]) => ({ kind: 'neg', a: x }), ctx);
    }
    case 'bin': {
      const a = lower(e.a, ctx);
      const b = lower(e.b, ctx);
      const scaled = scaleHist(e.op, a, b, ctx);
      if (scaled) return scaled;
      const op = BIN_OPS[e.op];
      return fastMap([a, b], xs => op(xs[0], xs[1]), ctx)
        ?? zipN(
          [expand(a, ctx), expand(b, ctx)],
          ([x, y]) => ({ kind: 'bin', op: e.op, a: x, b: y }),
          ctx,
        );
    }
    case 'call': {
      if (e.name === '[index]') return lowerIndex(e, ctx);
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
        const bins = binsArg === undefined ? null
          : constVal(binsArg, ctx, 'The number of bins', true);
        if (bins !== null && !Number.isInteger(bins)) {
          // Rounding would change what the row means without saying so, and
          // an index in the same position refuses a fraction outright.
          throw new Error(`hist(…) takes a whole number of bins; that is ${bins}.`);
        }
        if (bins !== null && (bins < 2 || bins > 500)) {
          throw new Error('hist(…) takes 2 to 500 bins.');
        }
        const arg = e.args[0] === undefined ? undefined : lower(e.args[0], ctx);
        if (!arg || !isSeq(arg)) throw new Error('hist(…) needs a list, like hist(person.age).');
        if (isText(arg)) throw new Error('hist(…) counts numbers; that column holds text.');
        // Gaps go before the values are read, not after: `hist(person.age)`
        // skips them (histogram drops non-finite values), and one slider
        // later `hist(person.age k)` refused the whole row as "not finite".
        const xs = isData(arg)
          ? arg.values
          : Float64Array.from(numericItems(arg.items.filter(it => !holdsGap(it)), ctx, 'hist'));
        return histogram(xs, bins, ctx);
      }
      const args = e.args.map(a => lower(a, ctx));
      if (e.name === '[eq]' || e.name === '[ne]') {
        // Equality is a filter test, not a relation to draw: zip it into a
        // mask, which only `[ ]` will accept.
        const parts = args.map(a => expand(a, ctx));
        if (!parts.some(isList)) {
          const op = e.name === '[eq]' ? '==' : '!=';
          throw new Error(`'${op}' tests a list inside a filter, like people[people.city == "NYC"].`
            + (e.name === '[ne]'
              ? " For a factorial equation, put a space before '=': x! = 2."
              : " An equation takes a single '=': x^2 = y."));
        }
        return zipN(parts, comps => ({ kind: 'call', name: e.name, args: comps }), ctx);
      }
      const isMinMax = e.name === 'min' || e.name === 'max';
      if (SYMBOLIC_REDUCTIONS.has(e.name) || NUMERIC_REDUCTIONS.has(e.name)
        || (isMinMax && args.length === 1 && isSeq(args[0]))) {
        if (args.length !== 1 || !isSeq(args[0])) {
          if (args.length === 1 && args[0].kind === 'var') {
            throw new Error(`${e.name}(${args[0].name}) needs ${args[0].name} to be a list defined above this row.`);
          }
          throw new Error(`${e.name}(…) needs a list, like ${e.name}([1, 4, 2]).`);
        }
        const arg = args[0];
        if (isText(arg)) {
          // count is the only reduction text has an answer for.
          if (e.name === 'count') return num(arg.values.length);
          throw new Error(`${e.name}(…) needs numbers; that column holds text.`);
        }
        return isData(arg)
          ? reduceData(e.name, arg.values, ctx)
          : reduce(e.name, (arg as Expr & { kind: 'list' }).items, ctx);
      }
      if (!args.some(isSeq)) return { kind: 'call', name: e.name, args };
      if (NO_LIST_INSIDE.has(e.name)) {
        throw new Error(`Lists cannot appear inside ${plainFnName(e.name)}(…).`);
      }
      // Scalar builtins map elementwise: sin(L), atan2(L, M), min(L, 5).
      const fn = EVAL_FNS[e.name];
      const fast = fn && fastMap(args, xs => fn(...xs), ctx);
      return fast
        ?? zipN(args.map(a => expand(a, ctx)), comps => ({ kind: 'call', name: e.name, args: comps }), ctx);
    }
    case 'vec': {
      const items = e.items.map(it => lower(it, ctx));
      // A scatter of columns stays two typed arrays rather than N points:
      // classify reads the coordinates straight out of them.
      if (items.some(isData) && items.every(it => isData(it) || it.kind === 'num')) {
        const n = seqLength(items.find(isData)!);
        for (const it of items) {
          if (isData(it) && it.values.length !== n) {
            throw new Error(`Lists have different lengths (${n} vs ${it.values.length}).`);
          }
        }
        return { kind: 'vec', items };
      }
      return zipN(
        items.map(it => expand(it, ctx)),
        comps => ({ kind: 'vec', items: comps }),
        ctx,
      );
    }
    case 'list':
      return listOf(expandItems(e.items, ctx), ctx);
    case 'eq':
    case 'ineq': {
      // Comparisons are the symbolic path: a mask is per-element structure
      // (and chains nest), so a typed array expands here.
      const l = expand(lower(e.l, ctx), ctx);
      const r = expand(lower(e.r, ctx), ctx);
      if (e.kind === 'ineq' && (isList(l) || isList(r))) {
        // A mask, for a filter. It is only meaningful inside [ ]; anywhere
        // else it reaches classify as a list of comparisons and is refused.
        return zipN([l, r], ([a, b]) => ({ kind: 'ineq', op: e.op, l: a, r: b }), ctx);
      }
      if (isList(l) || isList(r)) {
        throw new Error('Cannot put a list in an equation — plot the list on its own row.');
      }
      return e.kind === 'eq'
        ? { kind: 'eq', l, r }
        : { kind: 'ineq', op: e.op, l, r };
    }
    case 'piecewise': {
      const cases = e.cases.map(c => ({ cond: lower(c.cond, ctx), value: lower(c.value, ctx) }));
      const otherwise = e.otherwise && lower(e.otherwise, ctx);
      if (cases.some(c => isSeq(c.value)) || (otherwise && isSeq(otherwise))) {
        throw new Error('Lists are not supported inside {…} piecewise yet.');
      }
      return { kind: 'piecewise', cases, otherwise };
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
): Expr {
  const ctx: Ctx = { getList, opts, items: 0, data: 0, hists: 0 };
  const out = lower(e, ctx);
  if (isMask(out)) {
    throw new Error('A comparison over a list is a filter, not a plot — put it in brackets, like L[L > 2].');
  }
  if (!named && (out.kind === 'text' || out.kind === 'str')) {
    throw new Error('Text cannot be plotted — compare it inside a filter, like people[people.city == "NYC"].');
  }
  // Bars are a whole row, never a value — including a named one. `h = hist(L)`
  // would otherwise store the internal `[hist]` node as a constant and every
  // row touching it would report "Unknown function: [hist]", a token no user
  // ever typed.
  if (ctx.hists && !(!named && isHist(out))) {
    throw new Error(named
      ? 'hist(…) is a whole plot, not a value — write it on a row of its own, with no name.'
      : 'hist(…) is a whole plot — give it its own row.');
  }
  return out;
}

/**
 * Lower a filter's condition and decide it, for callers that filter
 * something other than a list — `adults = person[person.age >= 18]` cuts a
 * whole data file (defs.ts). Null when the condition is not a comparison
 * over a list.
 */
export function lowerMask(cond: Expr, getList: GetList, opts: ResolveOpts = {}): boolean[] | null {
  return maskValues(lower(cond, { getList, opts, items: 0, data: 0, hists: 0 }), opts);
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
    case 'num':
    case 'data':
    case 'str':
    case 'text':
    case 'var': return false;
    case 'neg': return usesListReduction(e.a);
    case 'bin': return usesListReduction(e.a) || usesListReduction(e.b);
    case 'call': return reduces(e.name, e.args) || e.args.some(usesListReduction);
    case 'eq': return usesListReduction(e.l) || usesListReduction(e.r);
    case 'ineq': return usesListReduction(e.l) || usesListReduction(e.r);
    case 'vec':
    case 'list': return e.items.some(usesListReduction);
    case 'piecewise':
      return e.cases.some(c => usesListReduction(c.cond) || usesListReduction(c.value))
        || (e.otherwise ? usesListReduction(e.otherwise) : false);
  }
}
