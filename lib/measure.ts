/**
 * Reductions over continuous multisets (docs/multisets.md §5, "Multiplicity
 * becomes measure").
 *
 * `x`, `y`, `z` (all reals), `u`, `v` ([0, 1]) and each `interval(a, b)` are
 * infinite multisets whose multiplicity is length. A reduction over them is
 * an integral against that measure: `count` is the measure, `total` the
 * integral, `mean` their ratio. A filter keeps a subset and measures it with
 * the geometric measure of its dimension — area for a region, arc length for
 * a curve, counting for points — so the answer depends only on the set:
 * `y = x^2` and `2y = 2x^2` agree.
 *
 * Two routes, chosen by the shape of the set:
 *
 * - **Integrals.** A product of ranges (`total(u^2)`, `{0 < x < 1: x^2}`), or
 *   a curve written as a graph over a bounded range (`{y = x^2, 0 < x < 1}`,
 *   arc length ∫ √(1 + g'²)). An everywhere-continuous integrand keeps its
 *   closed form, so sliders stay symbolic; any other is integrated
 *   adaptively at the sliders' values, finding its own singularities, so a
 *   divergent integral is ∞ or an error rather than a finite number.
 * - **Numeric.** Any other filter in one or two coordinates: a quadtree with
 *   interval enclosures (lib/certify.ts) that proves cells in or out and
 *   bounds the undecided ones, so a region's measure is certified or refused
 *   — marching squares for a curve's length — and certified root counting
 *   for points. The set is first proved bounded (or proved to hold an
 *   infinite strip); the grid comes from the set, never the view. Every
 *   measurement runs to a work budget. Its constants are read at resolve
 *   time, as Σ bounds are, so a slider change recomputes it.
 */
import { certifySystem, intervalFn, intervalKnows, type Interval } from './certify.ts';
import { countNodes } from './size.ts';
import { NonSmoothError, add, diff, mul, pow } from './diff.ts';
import { type Expr, childrenOf, evaluate, exprKey, freeVars, substVars } from './expr.ts';
import { intervalsIn, replaceIntervals } from './interval.ts';
import { polynomialRoots } from './poly.ts';
import { solveSystem } from './solve.ts';
import { compileProg, run } from './vm.ts';

/** Reductions that read a whole multiset (docs/multisets.md §3). */
const REDUCTIONS = new Set(['count', 'total', 'mean', 'min', 'max', 'stdev', 'median', 'hist']);

export const isReductionCall = (e: Expr): e is Expr & { kind: 'call' } =>
  e.kind === 'call' && REDUCTIONS.has(e.name) && e.args.length === 1;

/** The continuous multisets a row can name (§5). */
const CONTINUOUS = ['x', 'y', 'z', 'u', 'v'];
const GEOMETRIC = new Set(['x', 'y', 'z']);

const num = (value: number): Expr => ({ kind: 'num', value });
const vr = (name: string): Expr => ({ kind: 'var', name });
const INF: Expr = vr('inf');
const NEG_INF: Expr = { kind: 'neg', a: INF };

/** What a reduction over a continuous set needs from the resolver. */
export interface MeasureHost {
  /** Resolve a parsed expression (functions inlined, Σ/∫ expanded). */
  resolve(e: Expr): Expr;
  /** ∫ body dv from lo to hi as a verified closed form, or null when there
   *  is none; ±∞ bounds are `inf` / `-inf`. */
  integrate(body: Expr, v: string, lo: Expr, hi: Expr): Expr | null;
  /** Slider and constant values, read when a numeric measure needs them. */
  consts?: Record<string, number>;
  isList?(name: string): boolean;
  /** Names bound here (a function's parameters), so not the multisets x, u, … */
  bound(name: string): boolean;
}

/** A coordinate of the space a reduction runs over, with its natural range. */
interface Coord {
  name: string;
  lo: Expr;
  hi: Expr;
  geometric: boolean;
}

/** One comparison of a filter: it holds where `d < 0` (`d ≤ 0` when not
 *  strict), or `d = 0` for an equation. Strictness matters only to points. */
export interface Cond {
  d: Expr;
  eq: boolean;
  strict: boolean;
}

const isInf = (e: Expr, sign: 1 | -1): boolean =>
  sign === 1
    ? (e.kind === 'var' && e.name === 'inf') || (e.kind === 'num' && e.value === Infinity)
    : (e.kind === 'neg' && isInf(e.a, 1)) || (e.kind === 'num' && e.value === -Infinity);

const hasList = (e: Expr, host: MeasureHost): boolean =>
  e.kind === 'list' ||
  e.kind === 'data' ||
  e.kind === 'lazy' ||
  e.kind === 'text' ||
  (e.kind === 'var' && !!host.isList?.(e.name)) ||
  childrenOf(e).some(c => hasList(c, host));

/**
 * `count`, `total`, `mean`, … of `raw` (the parsed argument) when it ranges
 * over a continuous set: `{ expr }` is the reduced value. Otherwise
 * `{ arg }`, the resolved argument, for the list reduction to take — a
 * finite multiset in the argument keeps the list meaning (`total(L x)` is a
 * function of x, as it always was).
 */
export function reduceOverSet(name: string, raw: Expr, host: MeasureHost): { expr: Expr } | { arg: Expr } {
  // `{c1, c2: f}` in a reduction is f restricted to where c1 and c2 hold.
  let condsRaw: Expr[] = [];
  let valueRaw = raw;
  if (raw.kind === 'piecewise' && !raw.otherwise && raw.cases.slice(0, -1).every(c => c.bare)) {
    condsRaw = raw.cases.map(c => c.cond);
    const lastCase = raw.cases[raw.cases.length - 1];
    valueRaw = lastCase.bare ? num(1) : lastCase.value;
  }
  let conds = condsRaw.map(c => host.resolve(c));
  let value = host.resolve(valueRaw);
  if (!condsRaw.length && (value.kind === 'eq' || value.kind === 'ineq')) {
    conds = [value];
    value = num(1);
  }
  if (condsRaw.length && (value.kind === 'eq' || value.kind === 'ineq')) {
    throw new Error('In {condition: value}, the value is a number to reduce; put every comparison before the colon.');
  }
  const whole = [...conds, value];
  const names = new Set<string>();
  for (const e of whole) for (const n of freeVars(e)) if (CONTINUOUS.includes(n) && !host.bound(n)) names.add(n);
  const hidden = whole.flatMap(e => intervalsIn(e)).filter((h, k, all) => all.findIndex(o => o.key === h.key) === k);
  if ((!names.size && !hidden.length) || whole.some(e => hasList(e, host))) {
    return { arg: condsRaw.length ? host.resolve(raw) : conds.length ? conds[0] : value };
  }
  if (name === 'stdev' || name === 'median' || name === 'hist') {
    throw new Error(
      `${name} over a continuous set is not supported yet; count, total, mean, min and max are (docs/multisets.md §5).`,
    );
  }
  const coords: Coord[] = [];
  for (const n of CONTINUOUS) {
    if (!names.has(n)) continue;
    const geometric = GEOMETRIC.has(n);
    coords.push({ name: n, lo: geometric ? NEG_INF : num(0), hi: geometric ? INF : num(1), geometric });
  }
  hidden.forEach((h, k) => coords.push({ name: `@iv${k}`, lo: h.lo, hi: h.hi, geometric: false }));
  if (hidden.length) {
    const byKey = new Map(hidden.map((h, k) => [h.key, vr(`@iv${k}`)]));
    const plain = (e: Expr) => replaceIntervals(e, h => byKey.get(h.key)!);
    conds = conds.map(plain);
    value = plain(value);
  }
  const cs = conds.flatMap(c => comparisons(c));
  return { expr: reduceMeasure(name, cs, value, coords, host) };
}

interface Comparison {
  l: Expr;
  op: '<' | '>' | '=';
  r: Expr;
  strict: boolean;
}

/** A filter's comparisons; a chain is several. */
function comparisons(c: Expr): Comparison[] {
  if (c.kind === 'eq') {
    if (c.l.kind === 'vec' || c.r.kind === 'vec')
      throw new Error('A filter in a reduction compares numbers, not points.');
    return [{ l: c.l, op: '=', r: c.r, strict: false }];
  }
  if (c.kind !== 'ineq')
    throw new Error('Each condition of {…} in a reduction is a comparison, like x < 1 or y = x^2.');
  const op = c.op === '<' || c.op === '<=' ? '<' : '>';
  const strict = c.op === '<' || c.op === '>';
  if (c.l.kind === 'ineq') return [...comparisons(c.l), { l: c.l.r, op, r: c.r, strict }];
  return [{ l: c.l, op, r: c.r, strict }];
}

const residualOf = (c: Comparison): Cond => ({
  d: c.op === '>' ? { kind: 'bin', op: '-', a: c.r, b: c.l } : { kind: 'bin', op: '-', a: c.l, b: c.r },
  eq: c.op === '=',
  strict: c.strict,
});

function reduceMeasure(name: string, cs: Comparison[], value: Expr, coords: Coord[], host: MeasureHost): Expr {
  const names = coords.map(c => c.name);
  const mentions = (e: Expr) => [...freeVars(e)].some(n => names.includes(n));
  // Comparisons of one coordinate against a constant narrow its range; they
  // are not part of the set's shape.
  const ranges = new Map(coords.map(c => [c.name, { lo: [c.lo], hi: [c.hi] }]));
  const rest: Comparison[] = [];
  // Points sit on a range's ends, where `<` and `≤` differ: keep those whole.
  const points = cs.filter(c => c.op === '=').length >= coords.length;
  for (const c of cs) {
    const side = c.op !== '=' && c.l.kind === 'var' && names.includes(c.l.name) && !mentions(c.r) ? 'l' : null;
    const other = c.op !== '=' && c.r.kind === 'var' && names.includes(c.r.name) && !mentions(c.l) ? 'r' : null;
    if (side) ranges.get((c.l as Expr & { kind: 'var' }).name)![c.op === '<' ? 'hi' : 'lo'].push(c.r);
    else if (other) ranges.get((c.r as Expr & { kind: 'var' }).name)![c.op === '<' ? 'lo' : 'hi'].push(c.l);
    // Points keep their range as a condition too: its end decides one.
    if (points || (!side && !other)) rest.push(c);
  }
  const bounded: Coord[] = coords.map(c => {
    const r = ranges.get(c.name)!;
    return { ...c, lo: tightest(r.lo, 'max'), hi: tightest(r.hi, 'min') };
  });
  const eqs = rest.filter(c => c.op === '=');
  if (!rest.length) return productReduction(name, value, bounded, host, null);
  if (eqs.length === 1 && rest.length === 1) {
    const graph = graphForm(eqs[0], bounded);
    if (graph) return productReduction(name, value, graph.others, host, graph);
  }
  return numericReduction(name, rest.map(residualOf), value, bounded, host);
}

/** The tightest of several bounds: folded when they are numbers, else
 *  min/max calls (a slider bound stays symbolic). */
function tightest(bounds: Expr[], pick: 'min' | 'max'): Expr {
  const infinite = (e: Expr) => isInf(e, 1) || isInf(e, -1);
  const finite = bounds.filter(b => !infinite(b));
  if (!finite.length) return bounds[0];
  const nums = finite.filter(b => b.kind === 'num').map(b => (b as Expr & { kind: 'num' }).value);
  const rest = finite.filter(b => b.kind !== 'num');
  const folded = nums.length ? [num(pick === 'min' ? Math.min(...nums) : Math.max(...nums))] : [];
  const all = [...folded, ...rest];
  return all.length === 1 ? all[0] : { kind: 'call', name: pick, args: all };
}

// --- symbolic: products of ranges, and graphs over a bounded range ---

interface Graph {
  /** The coordinate the equation solves for, and its value. */
  solved: string;
  g: Expr;
  /** The coordinates left, over which the curve is integrated. */
  others: Coord[];
  /** Arc-length density √(1 + |∇g|²) over the other geometric coordinate. */
  weight: Expr;
}

/** `y = g(x)` (or `x = g(y)`) over a bounded range of the other coordinate:
 *  its arc length is ∫ √(1 + g'²). Null for any other equation. */
function graphForm(c: Comparison, coords: Coord[]): Graph | null {
  const geo = coords.filter(k => k.geometric);
  if (geo.length !== 2 || geo.some(k => k.name === 'z')) return null;
  for (const [lhs, rhs] of [
    [c.l, c.r],
    [c.r, c.l],
  ]) {
    if (lhs.kind !== 'var') continue;
    const solved = geo.find(k => k.name === lhs.name);
    if (!solved || freeVars(rhs).has(solved.name)) continue;
    // The solved coordinate is the curve's own: a range on it is not a graph.
    if (!isInf(solved.lo, -1) || !isInf(solved.hi, 1)) return null;
    const along = geo.find(k => k !== solved)!;
    // Over all of ℝ the graph may leave its domain; the quadtree handles that.
    if (isInf(along.lo, -1) || isInf(along.hi, 1)) return null;
    let slope: Expr;
    try {
      slope = diff(rhs, along.name);
    } catch (e) {
      if (e instanceof NonSmoothError) return null;
      throw e;
    }
    const weight: Expr = { kind: 'call', name: 'sqrt', args: [add(num(1), pow(slope, num(2)))] };
    return { solved: solved.name, g: rhs, others: coords.filter(k => k !== solved), weight };
  }
  return null;
}

/** Numbers every free name of `es` needs beyond `coords`: sliders and
 *  constants, read now, so the value follows them by re-resolving. */
function constantsFor(es: readonly Expr[], coords: readonly string[], host: MeasureHost, what: string) {
  const env: Record<string, number> = {};
  for (const e of es) {
    for (const n of freeVars(e)) {
      if (coords.includes(n) || n === 'inf' || Object.hasOwn(env, n)) continue;
      const v = host.consts?.[n];
      if (v === undefined || !Number.isFinite(v)) {
        throw new Error(
          n === 't'
            ? `${what} cannot follow t: it is measured once, not every frame.`
            : `${what} needs ${n} to be a number defined above this row.`,
        );
      }
      env[n] = v;
    }
  }
  return env;
}

/**
 * count/total/mean/min/max over a product of ranges — with, for a graph,
 * the solved coordinate substituted and arc length as the density.
 */
function productReduction(name: string, value: Expr, coords: Coord[], host: MeasureHost, graph: Graph | null): Expr {
  const infinite = coords.filter(c => isInf(c.lo, -1) || isInf(c.hi, 1));
  const at = (e: Expr) => (graph ? substVars(e, { [graph.solved]: graph.g }) : e);
  if (name === 'min' || name === 'max') return extremum(name, at(value), coords, host);
  const weight = graph?.weight ?? null;
  // Finite ranges first; at most one infinite range, integrated last.
  const order = [...coords.filter(c => !infinite.includes(c)), ...infinite];
  /** ∫ body over the set; `positive` bodies (a measure) diverge to ∞. */
  const integrate = (body: Expr, what: string, positive: boolean): Expr => {
    if (infinite.length > 1) {
      if (positive) return num(Infinity);
      throw new Error(`${what} over an unbounded plane is not supported: restrict it, like total({x^2 + y^2 < 1: …}).`);
    }
    const f = weight ? mul(body, weight) : body;
    // An integrand bounded on every bounded range, over bounded ranges: its
    // closed form holds for every slider value, so the row stays symbolic
    // (an empty range clamps to 0 rather than reversing the sign).
    if (!infinite.length && entire(f) && (!graph || entire(graph.g))) {
      let out: Expr | null = f;
      for (const c of order) {
        const hi = clampedHi(c);
        if (!hi) return num(0);
        out = host.integrate(out, c.name, c.lo, hi);
        if (!out) break;
      }
      if (out) return out;
    }
    return numericIntegral(f, order, graph, host, what, positive);
  };
  const componentwise = (f: (e: Expr) => Expr): Expr =>
    value.kind === 'vec' ? { kind: 'vec', items: value.items.map(f) } : f(value);
  const measure = (): Expr => (weight ? integrate(num(1), 'count', true) : lengthProduct(coords));
  if (name === 'count') return measure();
  if (name === 'total') return componentwise(e => integrate(at(e), 'total', false));
  // mean
  const m = measure();
  if (m.kind === 'num' && m.value === Infinity) {
    throw new Error('mean over a set of infinite measure has no value: restrict it, like mean({0 < x < 1: …}).');
  }
  if (m.kind === 'num' && m.value === 0) throw new Error('mean over an empty set has no value.');
  return componentwise(e => ({ kind: 'bin', op: '/', a: integrate(at(e), 'mean', false), b: m }));
}

/** A range's upper end, clamped so an empty range integrates to 0: null when
 *  it is empty now, `max(lo, hi)` when a slider decides. */
function clampedHi(c: Coord): Expr | null {
  if (c.lo.kind === 'num' && c.hi.kind === 'num') return c.hi.value > c.lo.value ? c.hi : null;
  return { kind: 'call', name: 'max', args: [c.lo, c.hi] };
}

/** The product of the ranges' lengths, each max(0, hi − lo): an empty range
 *  (2 < x < 1, or two ranges that miss) has measure 0, never negative. */
function lengthProduct(coords: readonly Coord[]): Expr {
  let infinite = false;
  const lengths: Expr[] = [];
  for (const c of coords) {
    if (c.lo.kind === 'num' && c.hi.kind === 'num') {
      if (!(c.hi.value > c.lo.value)) return num(0);
      lengths.push(num(c.hi.value - c.lo.value));
    } else if (isInf(c.lo, -1) || isInf(c.hi, 1)) {
      infinite = true;
    } else {
      const d: Expr = { kind: 'bin', op: '-', a: c.hi, b: c.lo };
      lengths.push({ kind: 'call', name: 'max', args: [num(0), d] });
    }
  }
  // A slider range may be empty (0), and 0 · ∞ is 0: read it before saying ∞.
  if (infinite) return lengths.length ? { kind: 'bin', op: '*', a: product(lengths), b: INF } : num(Infinity);
  return product(lengths);
}

function product(es: readonly Expr[]): Expr {
  const nums = es.filter(e => e.kind === 'num').reduce((m, e) => m * (e as Expr & { kind: 'num' }).value, 1);
  const rest = es.filter(e => e.kind !== 'num');
  return rest.reduce<Expr>(
    (m, e) => (m.kind === 'num' && m.value === 1 ? e : { kind: 'bin', op: '*', a: m, b: e }),
    num(nums),
  );
}

/** Functions finite and continuous on all of ℝ: bounded on a bounded range. */
const ENTIRE_CALLS = new Set(['sin', 'cos', 'exp', 'atan', 'tanh', 'sinh', 'cosh', 'abs']);

/**
 * Whether `e` is finite and continuous everywhere, whatever its constants'
 * values: sums, products and whole powers of those functions. Such an
 * integrand has no singularity to diverge at and no domain to leave, so its
 * integral over a bounded range can stay symbolic.
 */
function entire(e: Expr): boolean {
  switch (e.kind) {
    case 'num':
      return Number.isFinite(e.value);
    case 'var':
      return e.name !== 'inf';
    case 'neg':
      return entire(e.a);
    case 'bin':
      if (e.op === '^') return e.b.kind === 'num' && Number.isInteger(e.b.value) && e.b.value >= 0 && entire(e.a);
      if (e.op === '/') return e.b.kind === 'num' && e.b.value !== 0 && entire(e.a);
      return entire(e.a) && entire(e.b);
    case 'call':
      // √(1 + g'²), the arc-length density, is ≥ 1 wherever g' is finite.
      if (e.name === 'sqrt' && e.args.length === 1) {
        const a = e.args[0];
        return (
          a.kind === 'bin' &&
          a.op === '+' &&
          a.a.kind === 'num' &&
          a.a.value > 0 &&
          a.b.kind === 'bin' &&
          a.b.op === '^' &&
          a.b.b.kind === 'num' &&
          a.b.b.value === 2 &&
          entire(a.b.a)
        );
      }
      return ENTIRE_CALLS.has(e.name) && e.args.every(entire);
    default:
      return false;
  }
}

/**
 * ∫ f over a product of ranges at the constants' current values, by adaptive
 * quadrature that finds its own singularities: a divergent integral (∫₀¹ dx/x,
 * or an arc of infinite length) is ∞ for a measure and an error for a total,
 * never the finite number a fixed rule would print. A closed form that agrees
 * is kept, so exact values still read exactly. On a graph, where g is
 * undefined the curve is not there.
 */
function numericIntegral(
  f: Expr,
  order: readonly Coord[],
  graph: Graph | null,
  host: MeasureHost,
  what: string,
  positive: boolean,
): Expr {
  const names = order.map(c => c.name);
  const bounds = order.flatMap(c => [c.lo, c.hi]);
  const env = constantsFor([f, ...(graph ? [graph.g] : []), ...bounds], names, host, what);
  const range = (e: Expr): number => (isInf(e, 1) ? Infinity : isInf(e, -1) ? -Infinity : evaluate(e, env));
  const ranges = order.map((c): Interval => [range(c.lo), range(c.hi)]);
  if (ranges.some(([a, b]) => !(b > a))) return num(0);
  const fn = pointFn(f, names, env);
  const domain = graph && !entire(graph.g) ? pointFn(graph.g, names, env) : null;
  const integrand = domain ? (p: readonly number[]) => (Number.isFinite(domain(p)) ? fn(p) : 0) : fn;
  let value: number;
  try {
    value = nestedIntegral(integrand, ranges, { evals: 0 });
  } catch (e) {
    if (e instanceof Diverges) {
      if (positive) return num(Infinity);
      throw new Error(`${what} diverges: the integral of |f| over that set is infinite.`);
    }
    if (e instanceof Unreliable) throw new Error(`${what} could not be computed reliably: ${e.message}`);
    throw e;
  }
  if (!Number.isFinite(value)) throw new Error(`${what} has no value: the expression is undefined over the set.`);
  // A closed form reads exactly; keep it when it agrees.
  let exact: Expr | null = f;
  for (const c of order) {
    exact = exact && host.integrate(exact, c.name, c.lo, c.hi);
  }
  if (exact) {
    try {
      const got = evaluate(exact, env);
      if (Math.abs(got - value) <= 1e-8 * (1 + Math.abs(value))) return exact;
    } catch {
      // Not evaluable here: the number stands.
    }
  }
  return num(value);
}

/** ∫ f diverges (∫|f| is infinite near `at`). */
class Diverges extends Error {
  constructor(readonly at: number) {
    super('diverges');
  }
}
/** The integral did not settle, and no divergence was found to blame. */
class Unreliable extends Error {}

/** Function evaluations one integral may spend (a readout must stay fast). */
const EVAL_BUDGET = 1_500_000;

/** ∫ over a box, innermost coordinate first. */
function nestedIntegral(
  f: (p: readonly number[]) => number,
  ranges: readonly Interval[],
  work: { evals: number },
): number {
  const p = new Array<number>(ranges.length).fill(0);
  const level = (k: number): number =>
    integrate1D(
      x => {
        p[k] = x;
        return k === 0 ? f(p) : level(k - 1);
      },
      ranges[k][0],
      ranges[k][1],
      work,
    );
  return level(ranges.length - 1);
}

/** Gauss–Kronrod 7–15 nodes and weights on [-1, 1] (non-negative half). */
const K15_X = [
  0, 0.2077849550078985, 0.4058451513773972, 0.5860872354676911, 0.7415311855993945, 0.8648644233597691,
  0.9491079123427585, 0.9914553711208126,
];
const K15_W = [
  0.2094821410847278, 0.2044329400752989, 0.1903505780647854, 0.1690047266392679, 0.1406532597155259,
  0.1047900103222502, 0.0630920926299786, 0.0229353220105292,
];
const G7_W = [0.4179591836734694, 0.3818300505051189, 0.2797053914892767, 0.1294849661688697];

/** K15 on [x0, x1] of f and of |f|, with the G7 difference as error. */
function panel(f: (x: number) => number, x0: number, x1: number) {
  const c = (x0 + x1) / 2;
  const h = (x1 - x0) / 2;
  let k15 = 0;
  let g7 = 0;
  let a15 = 0;
  let ag7 = 0;
  for (let i = 0; i < 8; i++) {
    const fp = f(c + h * K15_X[i]);
    const fm = i === 0 ? 0 : f(c - h * K15_X[i]);
    const s = fp + fm;
    const t = Math.abs(fp) + Math.abs(fm);
    k15 += K15_W[i] * s;
    a15 += K15_W[i] * t;
    if (i % 2 === 0) {
      g7 += G7_W[i / 2] * s;
      ag7 += G7_W[i / 2] * t;
    }
  }
  // |f| has kinks where f changes sign, so its rule converges slowly; it is
  // only needed roughly (is ∫|f| finite?), so its error counts at 1e-4.
  return { k: k15 * h, abs: a15 * h, err: Math.max(Math.abs((k15 - g7) * h), 1e-4 * Math.abs((a15 - ag7) * h)) };
}

const MAX_DEPTH = 200;

/**
 * Adaptive ∫ f over [a, b] (±∞ by the rational change of variables). Where
 * the panels will not settle, the shells around that point decide: ∫|f| over
 * [s + δ/2^(k+1), s + δ/2^k] not shrinking is a divergence (Diverges);
 * anything else unsettled is Unreliable.
 */
function integrate1D(f: (x: number) => number, a: number, b: number, work: { evals: number }): number {
  if (a === b) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    if (a === -Infinity && b === Infinity) {
      return integrate1D(
        u => {
          const d = 1 - u * u;
          return (f(u / d) * (1 + u * u)) / (d * d);
        },
        -1,
        1,
        work,
      );
    }
    const end = Number.isFinite(a) ? a : b;
    const dir = Number.isFinite(a) ? 1 : -1;
    return integrate1D(
      u => {
        const d = 1 - u;
        return f(end + (dir * u) / d) / (d * d);
      },
      0,
      1,
      work,
    );
  }
  const g = (x: number) => {
    if (++work.evals > EVAL_BUDGET) throw new Unreliable('it takes too many evaluations.');
    return f(x);
  };
  const start = work.evals;
  const whole = panel(g, a, b);
  let scale = Number.isFinite(whole.abs) ? whole.abs : 0;
  let total = 0;
  let totalAbs = 0;
  const stuck: Interval[] = [];
  const weights = new Map<Interval, number>();
  const weight = (w: Interval) => weights.get(w) ?? 0;
  // The narrowest panel so far: where the work piles up, if it does.
  let deepest: Interval = [a, b];
  let deepestLevel = 0;
  const stack: Array<[number, number, number]> = [[a, b, 0]];
  while (stack.length) {
    const [x0, x1, depth] = stack.pop()!;
    if (work.evals - start > LOCAL_EVALS) {
      if (shellsAt(g, deepest, a, b).diverges) throw new Diverges((deepest[0] + deepest[1]) / 2);
      throw new Unreliable('it does not settle (the integrand oscillates too fast, or is singular).');
    }
    const p = x0 === a && x1 === b ? whole : panel(g, x0, x1);
    const settled = Number.isFinite(p.k) && Number.isFinite(p.abs);
    // Never ask a panel for more than rounding allows (near a singularity
    // x − s cancels, so the values themselves are noisy).
    // A panel that dominates the running total cannot set its own
    // tolerance by it (a pole would pass on its own size).
    const size = Math.max(scale, totalAbs);
    const tol =
      p.abs <= 0.5 * size ? Math.max(1e-9 * size * ((x1 - x0) / (b - a)), 1e-11 * size, 1e-9 * p.abs) : 1e-9 * p.abs;
    const m = (x0 + x1) / 2;
    // A panel ~1000 ulps wide samples nearly the same floats at every node, so its
    // error estimate says nothing: only a singularity drives one this far.
    const floorWide = x1 - x0 <= 1e-13 * Math.abs(m);
    if (settled && p.err <= tol && !floorWide) {
      total += p.k;
      totalAbs += p.abs;
      continue;
    }
    if (depth >= MAX_DEPTH || floorWide || m <= x0 || m >= x1) {
      // A panel this narrow that has not settled sits on a singularity; the
      // shells around it decide (below). Its own share counts when finite
      // (a divergence inflates the running total, so no size test here).
      if (settled) {
        total += p.k;
        totalAbs += p.abs;
      }
      stuck.push([x0, x1]);
      weights.set(stuck[stuck.length - 1], settled ? p.abs : Infinity);
      continue;
    }
    if (settled && scale === 0) scale = p.abs;
    if (depth + 1 > deepestLevel) {
      deepestLevel = depth + 1;
      deepest = [x0, x1];
    }
    stack.push([x0, m, depth + 1], [m, x1, depth + 1]);
  }
  // A singular panel at the limit of resolution: what it holds is bounded by
  // the shells around it when they shrink geometrically, and is negligible.
  // (Many stuck panels are oscillation or noise: judge the 8 heaviest,
  // where a pole would be.)
  const heaviest = [...stuck].sort((p, q) => weight(q) - weight(p)).slice(0, 8);
  const judged = heaviest.map(w => ({ w, ...shellsAt(g, w, a, b) }));
  if (stuck.length > 8 && !judged.some(j => j.diverges)) {
    throw new Unreliable('it does not settle (the integrand oscillates too fast, or is singular).');
  }
  const pole = judged.find(j => j.diverges);
  if (pole) throw new Diverges((pole.w[0] + pole.w[1]) / 2);
  if (judged.some(j => j.tail === null || j.tail > 1e-6 * Math.max(scale, totalAbs))) {
    throw new Unreliable('the integrand is singular near a point where the integral may diverge.');
  }
  // What cancels to rounding noise (an odd integrand) is 0.
  return Math.abs(total) < 1e-12 * totalAbs ? 0 : total;
}

/** Evaluations one 1D integral may spend before its trouble spot is examined. */
const LOCAL_EVALS = 400_000;

/**
 * ∫|f| near the narrow panel `w`, read from the dyadic shells around it down
 * to its width: `diverges` when they stop shrinking (a fixed size is a log
 * divergence, growth a pole); else `tail`, a bound on what the panel itself
 * holds when they shrink geometrically, or null when they do neither.
 */
function shellsAt(
  f: (x: number) => number,
  w: Interval,
  a: number,
  b: number,
): { diverges: boolean; tail: number | null } {
  const s = (w[0] + w[1]) / 2;
  const floor = Math.max(w[1] - w[0], Math.abs(s) * 1e-14, 1e-300);
  let tail = 0;
  for (const side of [1, -1]) {
    const room = side > 0 ? b - s : s - a;
    if (!(room > 64 * floor)) continue;
    let delta = Math.min(room, (b - a) / 16);
    const shells: number[] = [];
    while (delta / 2 > 16 * floor && shells.length < 200) {
      const lo = s + (side * delta) / 2;
      const hi = s + side * delta;
      const p = panel(f, Math.min(lo, hi), Math.max(lo, hi));
      if (!Number.isFinite(p.abs)) return { diverges: true, tail: null };
      shells.push(p.abs);
      delta /= 2;
    }
    const last = shells.slice(-10);
    const ratios = last.slice(1).map((j, k) => (last[k] > 0 ? j / last[k] : 0));
    if (last.length >= 10 && last[0] > 0 && ratios.every(r => r >= 0.97)) return { diverges: true, tail: null };
    if (last.length < 7) {
      tail = NaN;
      continue;
    }
    const r = Math.max(...ratios.slice(-6));
    tail += r <= 0.9 ? (last[last.length - 1] * r) / (1 - r) : NaN;
  }
  return { diverges: false, tail: Number.isNaN(tail) ? null : tail };
}

/** min or max over a bounded product of ranges: a dense grid, then a local
 *  refinement around the best point. */
function extremum(name: 'min' | 'max', value: Expr, coords: Coord[], host: MeasureHost): Expr {
  const what = `${name} over a continuous set`;
  if (value.kind === 'vec') throw new Error(`${name} compares numbers; that set holds points.`);
  if (coords.length > 2) throw new Error(`${what} takes at most two continuous variables.`);
  if (coords.some(c => isInf(c.lo, -1) || isInf(c.hi, 1))) {
    throw new Error(`${what} needs a bounded set: restrict it, like ${name}({0 < x < 1: …}).`);
  }
  const names = coords.map(c => c.name);
  const env = constantsFor([value, ...coords.flatMap(c => [c.lo, c.hi])], names, host, what);
  const lo = coords.map(c => evaluate(c.lo, env));
  const hi = coords.map(c => evaluate(c.hi, env));
  if (lo.some((l, k) => !(hi[k] >= l))) throw new Error(`${name} over an empty set has no value.`);
  const f = pointFn(value, names, env);
  const sign = name === 'min' ? 1 : -1;
  const n = coords.length === 1 ? 4096 : 256;
  let best = Infinity;
  let at: number[] = [];
  const visit = (p: number[]) => {
    const y = sign * f(p);
    if (y < best) {
      best = y;
      at = p;
    }
  };
  if (coords.length === 1) for (let i = 0; i <= n; i++) visit([lo[0] + ((hi[0] - lo[0]) * i) / n]);
  else
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++) visit([lo[0] + ((hi[0] - lo[0]) * i) / n, lo[1] + ((hi[1] - lo[1]) * j) / n]);
  if (!Number.isFinite(best)) throw new Error(`${name} has no value: the expression is undefined over the set.`);
  // Pattern search: shrink a step around the best grid point.
  let step = coords.map((_, k) => (hi[k] - lo[k]) / n);
  for (let it = 0; it < 200 && step.some(s => s > 1e-13); it++) {
    let moved = false;
    for (let k = 0; k < coords.length; k++) {
      for (const dir of [-1, 1]) {
        const p = [...at];
        p[k] = Math.min(hi[k], Math.max(lo[k], p[k] + dir * step[k]));
        const before = best;
        visit(p);
        if (best < before) moved = true;
      }
    }
    if (!moved) step = step.map(s => s / 2);
  }
  return num(sign * best);
}

// --- numeric: regions, curves and points ---

/** A fast evaluator of `e` at points of `names`, the constants bound. */
function pointFn(e: Expr, names: readonly string[], env: Record<string, number>): (p: readonly number[]) => number {
  const bound = bindConstants(e, env);
  const slots = new Map(names.map((n, k): [string, number] => [n, k]));
  try {
    const prog = compileProg(bound, slots);
    const vars = new Float64Array(names.length);
    const stack = new Float64Array(Math.max(1, prog.depth));
    return p => {
      for (let k = 0; k < p.length; k++) vars[k] = p[k];
      return run(prog, vars, stack);
    };
  } catch {
    return p => {
      try {
        return evaluate(bound, Object.fromEntries(names.map((n, k) => [n, p[k]])));
      } catch {
        return NaN;
      }
    };
  }
}

const FALSE = 0;
const TRUE = 1;
const UNKNOWN = 2;
type Truth = typeof FALSE | typeof TRUE | typeof UNKNOWN;

/** Compiled enclosures, per expression, for the names and constants of the
 *  measurement in progress (the same arrays throughout one). */
const compiled = new WeakMap<Expr, { names: readonly string[]; env: object; fn: ReturnType<typeof intervalFn> }>();
function ivOf(e: Expr, names: readonly string[], env: Record<string, number>) {
  const hit = compiled.get(e);
  if (hit && hit.names === names && hit.env === env) return hit.fn;
  const fn = intervalFn(e, names, env);
  compiled.set(e, { names, env, fn });
  return fn;
}

/** Whether every condition holds on the whole box, on none of it, or neither
 *  is proven. An equation never holds on a whole box. */
function truthOn(
  conds: readonly Cond[],
  names: readonly string[],
  box: readonly Interval[],
  env: Record<string, number>,
): Truth {
  let all = true;
  for (const c of conds) {
    const [lo, hi] = ivOf(c.d, names, env)(box);
    if (c.eq) {
      if (lo > 0 || hi < 0) return FALSE;
      all = false;
    } else {
      if (lo > 0 || (c.strict && lo >= 0)) return FALSE;
      if (!(hi < 0 || (!c.strict && hi <= 0))) all = false;
    }
  }
  return all ? TRUE : UNKNOWN;
}

export interface Measured {
  /** Area, length or number of points; Infinity for an unbounded set. */
  measure: number;
  /** How far `measure` may be off (0 when exact). */
  gap?: number;
  /** ∫ f over the set, per component of the value. */
  totals: number[];
  /** How far each total may be off. */
  totalGaps?: number[];
  /** ∫ |f| over the set, per component (the scale totalGaps compare to). */
  sizes?: number[];
  /** The values at the points (a 0-dimensional set only), for min and max. */
  values?: number[][];
}

/** A slider drag re-resolves every row: keep recent measurements. */
const memo = new Map<string, Measured | Error>();

function numericReduction(name: string, conds: Cond[], value: Expr, coords: Coord[], host: MeasureHost): Expr {
  const what = `${name} over that set`;
  const names = coords.map(c => c.name);
  if (coords.some(c => c.name === 'z')) {
    throw new Error(`${name} over a set in space (volume, surface area) is not supported yet.`);
  }
  if (coords.length > 2) throw new Error(`${what} takes at most two continuous variables.`);
  const values = value.kind === 'vec' ? value.items : [value];
  const bounds = coords.flatMap(c => [c.lo, c.hi]);
  const env = constantsFor([...conds.map(c => c.d), ...values, ...bounds], names, host, `${name} of a filter`);
  const range = (e: Expr): number => (isInf(e, 1) ? Infinity : isInf(e, -1) ? -Infinity : evaluate(e, env));
  const lo = coords.map(c => range(c.lo));
  const hi = coords.map(c => range(c.hi));
  const key =
    exprKey([name, conds.map(c => [c.d, c.eq ? 1 : c.strict ? 2 : 0]), values, names]) + JSON.stringify([lo, hi, env]);
  // Failures are kept too: a slider drag must not redo a refused measurement.
  let hit = memo.get(key);
  if (!hit) {
    try {
      // count needs only the measure; the others need the values too.
      hit = measureSet(conds, name === 'count' ? [] : values, names, lo, hi, env);
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      hit =
        e instanceof Diverges
          ? new Error(
              `${name} over that set diverges: the value is unbounded near a point, and its integral is infinite.`,
            )
          : e;
    }
    if (memo.size > 200) memo.clear();
    memo.set(key, hit);
  }
  if (hit instanceof Error) throw hit;
  const got = hit;
  const vec = (xs: number[]): Expr => (value.kind === 'vec' ? { kind: 'vec', items: xs.map(num) } : num(xs[0]));
  if (name === 'count') return num(certified(got.measure, got.gap ?? 0));
  if (name === 'min' || name === 'max') {
    if (!got.values) {
      throw new Error(`${name} over a region or curve is not supported yet; over points (a solved filter) it is.`);
    }
    if (value.kind === 'vec') throw new Error(`${name} compares numbers; that set holds points.`);
    if (!got.values.length) throw new Error(`${name} over an empty set has no value.`);
    const xs = got.values.map(v => v[0]);
    return num(name === 'min' ? Math.min(...xs) : Math.max(...xs));
  }
  if (got.measure === Infinity) {
    throw new Error(
      `${name} over a set of infinite measure is not supported: restrict it, like ${name}({x^2 + y^2 < 1: …}).`,
    );
  }
  const gaps = got.totalGaps ?? [];
  if (name === 'total') return vec(got.totals.map((t, i) => certified(t, gaps[i] ?? 0)));
  if (got.measure === 0) throw new Error('mean over an empty set has no value.');
  // Each ratio's error, from the errors of its two parts.
  const m = got.measure;
  const dm = got.gap ?? 0;
  return vec(got.totals.map((t, i) => certified(t / m, ((gaps[i] ?? 0) + (Math.abs(t) * dm) / m) / m)));
}

/**
 * `v` to the digits its error bound `gap` vouches for, so a readout never
 * shows digits the measurement cannot back (the last one shown is the
 * first it leaves uncertain). The rounded number is nudged by
 * 1e-13 so it still reads `≈`, not `=`.
 */
export function certified(v: number, gap: number): number {
  if (!(gap > 0) || !Number.isFinite(v) || v === 0) return v;
  // The last digit shown is the first the bound leaves uncertain.
  const unit = 10 ** Math.floor(Math.log10(gap));
  if (unit <= Math.abs(v) * 1e-6) return v;
  const r = Number((Math.round(v / unit) * unit).toPrecision(15));
  return r === 0 ? 0 : r * (1 + 1e-13);
}

/**
 * Measure the set where `conds` hold, over coordinates `names` with ranges
 * [lo, hi] (±Infinity allowed), and integrate each of `values` over it.
 * Its dimension is the number of coordinates less the number of equations.
 */
export function measureSet(
  conds: readonly Cond[],
  values: readonly Expr[],
  names: readonly string[],
  lo: readonly number[],
  hi: readonly number[],
  env: Record<string, number>,
): Measured {
  const eqs = conds.filter(c => c.eq).length;
  const dim = names.length - eqs;
  if (dim < 0) throw new Error('That filter has more equations than variables; count its points with fewer equations.');
  if (lo.some((l, k) => !(hi[k] > l))) {
    // A range of one value (0 ≤ x ≤ 0) still holds a root there.
    if (dim === 0 && names.length === 1 && hi[0] === lo[0] && pointFn(conds.find(c => c.eq)!.d, names, env)(lo) === 0) {
      return pointsMeasure(
        [[lo[0]]],
        conds.filter(c => !c.eq),
        values,
        names,
        env,
      );
    }
    return { measure: 0, totals: values.map(() => 0), values: [] };
  }
  // A polynomial's real roots are all known exactly, with no box.
  if (dim === 0 && names.length === 1) {
    const exact = polynomialRoots(bindConstants(conds.find(c => c.eq)!.d, env), names[0]);
    if (exact && exact !== 'zero') {
      const xs = exact.map(r => r.x).filter(x => x >= lo[0] && x <= hi[0]);
      return pointsMeasure(
        distinct(xs.map(x => [x])),
        conds.filter(c => !c.eq),
        values,
        names,
        env,
      );
    }
  }
  // Nothing anywhere (x^2 < 0): empty, before any box is sought.
  if (
    dim > 0 &&
    truthOn(
      conds,
      names,
      names.map((_, k): Interval => [lo[k], hi[k]]),
      env,
    ) === FALSE
  ) {
    return { measure: 0, totals: values.map(() => 0), values: [] };
  }
  let box = boundSet(conds, names, lo, hi, env);
  // Strips out to ∞ defeat interval arithmetic when terms cancel there
  // (x² − y² of the lemniscate): a polynomial's leading form can still
  // prove the set bounded, and the strips then tighten that box.
  if (box === null && names.length === 2) {
    const R = polynomialRadius(conds, names, env);
    if (R !== null) {
      const clipped = lo.map(l => Math.max(l, -R));
      const upper = hi.map(h => Math.min(h, R));
      box = clipped.some((l, k) => !(upper[k] > l)) ? null : boundSet(conds, names, clipped, upper, env);
      if (box === null) box = clipped.map((l, k): Interval => [l, upper[k]]);
    }
  }
  if (box === 'infinite') return { measure: Infinity, totals: [] };
  if (dim === 0) {
    if (!box) {
      throw new Error(
        `The solutions could not all be found: they may be infinitely many. Restrict the range, like count({-10 < ${names[0]} < 10, …}).`,
      );
    }
    return names.length === 1
      ? rootsOnLine(conds, values, names[0], box[0], env)
      : rootsInPlane(conds, values, names, box, env);
  }
  if (!box) {
    // Neither proved bounded nor holding a whole strip: measure it in two
    // squares, one twice the other's size. Growth means it runs off to
    // infinity; no growth, and it is unbounded but thin, which a grid over
    // a finite box cannot measure honestly.
    const far = (R: number) => lo.map((l, k) => [Math.max(l, -R), Math.min(hi[k], R)] as Interval);
    const a = gridMeasure(conds, [], names, far(1024), env, { maxDepth: 7 }).measure;
    const b = gridMeasure(conds, [], names, far(2048), env, { maxDepth: 7 }).measure;
    if (b > 1.5 * a && b > 0) return { measure: Infinity, totals: [] };
    throw new Error('That set is unbounded, and its measure could not be found. Restrict it to a bounded range.');
  }
  // Only the sides the bound search moved may move off the grid; a range the
  // author gave (0 < x < 1) is an edge of the set itself.
  const soft = box.map((b, k): [boolean, boolean] => [b[0] !== lo[k], b[1] !== hi[k]]);
  const got = gridMeasure(conds, values, names, box, env, { soft });
  // Report only what the bounds vouch for: an imprecise number is an error.
  const { measure, gap = 0 } = got;
  // (A gap below 1e-24 is a point's worth: x^2 + y^2 ≤ 0 has area 0.)
  if (!(gap <= REPORT_REL * measure) && gap > 1e-24) {
    throw new Error(
      'That set could not be measured precisely enough within the time a readout may take. Restrict it to a smaller range.',
    );
  }
  got.totalGaps?.forEach((g, i) => {
    const size = got.sizes?.[i] ?? Math.abs(got.totals[i]);
    if (g > REPORT_REL_TOTAL * size && g > 0) {
      throw new Error(
        g === Infinity
          ? 'The value could not be bounded on that set (it is unbounded near its edge, or at a point): its integral may diverge.'
          : 'The integral over that set could not be computed precisely enough within the time a readout may take.',
      );
    }
  });
  return got;
}

/** A polynomial in two variables: coefficients by exponents "i,j". */
type Poly2 = Map<string, number>;

/** `e` as a polynomial in the two coordinates (constants read from env),
 *  or null when it is not one (or is too large to expand). */
function poly2(e: Expr, names: readonly string[], env: Record<string, number>): Poly2 | null {
  const constant = (c: number): Poly2 => new Map([['0,0', c]]);
  const add = (a: Poly2, b: Poly2, sign: number): Poly2 => {
    const out = new Map(a);
    for (const [k, v] of b) out.set(k, (out.get(k) ?? 0) + sign * v);
    return out;
  };
  const mul = (a: Poly2, b: Poly2): Poly2 | null => {
    if (a.size * b.size > 4096) return null;
    const out: Poly2 = new Map();
    for (const [ka, va] of a) {
      const [i, j] = ka.split(',').map(Number);
      for (const [kb, vb] of b) {
        const [p, q] = kb.split(',').map(Number);
        const k = `${i + p},${j + q}`;
        out.set(k, (out.get(k) ?? 0) + va * vb);
      }
    }
    return out;
  };
  const rec = (x: Expr): Poly2 | null => {
    switch (x.kind) {
      case 'num':
        return Number.isFinite(x.value) ? constant(x.value) : null;
      case 'var': {
        const k = names.indexOf(x.name);
        if (k === 0) return new Map([['1,0', 1]]);
        if (k === 1) return new Map([['0,1', 1]]);
        return Number.isFinite(env[x.name]) ? constant(env[x.name]) : null;
      }
      case 'neg': {
        const a = rec(x.a);
        return a && add(new Map(), a, -1);
      }
      case 'bin': {
        const a = rec(x.a);
        if (!a) return null;
        if (x.op === '^') {
          if (x.b.kind !== 'num' || !Number.isInteger(x.b.value) || x.b.value < 0 || x.b.value > 24) return null;
          let p: Poly2 | null = constant(1);
          for (let i = 0; i < x.b.value && p; i++) p = mul(p, a);
          return p;
        }
        const b = rec(x.b);
        if (!b) return null;
        if (x.op === '+' || x.op === '-') return add(a, b, x.op === '+' ? 1 : -1);
        if (x.op === '*') return mul(a, b);
        const c = b.size === 1 ? b.get('0,0') : undefined;
        return c ? add(new Map(), a, 1 / c) : null;
      }
      default:
        return null;
    }
  };
  return rec(e);
}

/**
 * A radius outside which the set is empty, from polynomial leading forms:
 * for P of degree n whose top form H is definite (|H| ≥ m rⁿ in every
 * direction, checked by interval arithmetic on the circle), P keeps H's sign
 * once m rⁿ exceeds the lower terms' bound Σ C_k r^k. A region `P < 0` with
 * H > 0 is bounded so; a curve `P = 0` with H of either sign; several
 * equations through the sum of their squares. Null when none applies.
 */
function polynomialRadius(
  conds: readonly Cond[],
  names: readonly string[],
  env: Record<string, number>,
): number | null {
  const polys = conds.map(c => ({ c, p: poly2(c.d, names, env) }));
  const candidates: Array<{ p: Poly2; sign: 1 | -1 | 0 }> = [];
  for (const { c, p } of polys) if (p) candidates.push({ p, sign: c.eq ? 0 : 1 });
  const eqs = polys.filter(x => x.c.eq && x.p);
  if (eqs.length >= 2) {
    let sum: Poly2 = new Map();
    for (const { p } of eqs) {
      const sq = new Map<string, number>();
      for (const [ka, va] of p!) {
        const [i, j] = ka.split(',').map(Number);
        for (const [kb, vb] of p!) {
          const [u, w] = kb.split(',').map(Number);
          const k = `${i + u},${j + w}`;
          sq.set(k, (sq.get(k) ?? 0) + va * vb);
        }
      }
      for (const [k, v] of sq) sum.set(k, (sum.get(k) ?? 0) + v);
    }
    candidates.push({ p: sum, sign: 1 });
  }
  let best: number | null = null;
  for (const { p, sign } of candidates) {
    const R = leadingRadius(p, sign);
    if (R !== null && (best === null || R < best)) best = R;
  }
  return best;
}

function leadingRadius(p: Poly2, sign: 1 | -1 | 0): number | null {
  const terms = [...p].map(([k, v]) => ({ ij: k.split(',').map(Number), v })).filter(t => t.v !== 0);
  if (!terms.length) return null;
  const degree = (t: { ij: number[] }) => t.ij[0] + t.ij[1];
  const n = Math.max(...terms.map(degree));
  if (n === 0) return null;
  const top = terms.filter(t => degree(t) === n);
  // H(cos t, sin t) over the circle, by interval arithmetic on 1024 arcs.
  const th = 't';
  const H: Expr = top.reduce<Expr>(
    (acc, t) => ({
      kind: 'bin',
      op: '+',
      a: acc,
      b: {
        kind: 'bin',
        op: '*',
        a: num(t.v),
        b: {
          kind: 'bin',
          op: '*',
          a: { kind: 'bin', op: '^', a: { kind: 'call', name: 'cos', args: [vr(th)] }, b: num(t.ij[0]) },
          b: { kind: 'bin', op: '^', a: { kind: 'call', name: 'sin', args: [vr(th)] }, b: num(t.ij[1]) },
        },
      },
    }),
    num(0),
  );
  const f = intervalFn(H, [th], {});
  let lo = Infinity;
  let hi = -Infinity;
  const N = 1024;
  for (let k = 0; k < N; k++) {
    const [a, b] = f([[(2 * Math.PI * k) / N, (2 * Math.PI * (k + 1)) / N]]);
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
  }
  // m: the least |H| on the circle, with the sign the condition needs.
  const m = lo > 0 && sign >= 0 ? lo : hi < 0 && sign === 0 ? -hi : 0;
  if (!(m > 0)) return null;
  const C = Array.from({ length: n }, (_, k) =>
    terms.filter(t => degree(t) === k).reduce((acc, t) => acc + Math.abs(t.v), 0),
  );
  const wins = (r: number) => m * r ** n > C.reduce((acc, c, k) => acc + c * r ** k, 0) * (1 + 1e-9);
  let R = 1;
  while (!wins(R)) {
    R *= 2;
    if (R > 2 ** 40) return null;
  }
  return R;
}

/** Candidate cut positions for a bounding box, ascending: ±2^e and 0. */
const CUTS = [
  ...Array.from({ length: 29 }, (_, i) => -(2 ** (20 - i))),
  0,
  ...Array.from({ length: 29 }, (_, i) => 2 ** (i - 8)),
];

/**
 * A box outside which no condition can hold, found by proving strips of each
 * coordinate empty with interval arithmetic — each side of each coordinate on
 * its own, so a finite side never stops the other's search: 'infinite' when a
 * strip out to ∞ is proved inside the set (a region, so of infinite measure),
 * null when a side is not proved bounded. Finite sides are tightened too.
 */
function boundSet(
  conds: readonly Cond[],
  names: readonly string[],
  lo: readonly number[],
  hi: readonly number[],
  env: Record<string, number>,
): Interval[] | 'infinite' | null {
  const box: Interval[] = names.map((_, k) => [lo[k], hi[k]]);
  const strip = (k: number, side: Interval): Truth => {
    const b = box.map(v => [...v] as Interval);
    b[k] = side;
    return truthOn(conds, names, b, env);
  };
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let k = 0; k < names.length; k++) {
      for (const up of [true, false]) {
        const [a, b] = box[k];
        // The strip beyond cut c: [c, b] above, [a, c] below.
        const beyond = (c: number): Interval => (up ? [c, b] : [a, c]);
        const cuts = (up ? CUTS : [...CUTS].reverse()).filter(c => c > a && c < b);
        let prev = up ? a : b;
        let found: number | null = null;
        for (const c of cuts) {
          const t = strip(k, beyond(c));
          if (t === TRUE && !Number.isFinite(up ? b : a)) return 'infinite';
          if (t === FALSE) {
            found = c;
            break;
          }
          prev = c;
        }
        if (found === null) continue;
        // Close in on the set between the last cut that failed and this one.
        let cut: number = found;
        if (Number.isFinite(prev)) {
          for (let i = 0; i < 16; i++) {
            const m = (prev + cut) / 2;
            if (strip(k, beyond(m)) === FALSE) cut = m;
            else prev = m;
          }
        }
        box[k] = up ? [a, cut] : [cut, b];
        changed = true;
      }
    }
    if (!changed) break;
  }
  return box.every(([a, b]) => Number.isFinite(a) && Number.isFinite(b)) ? box : null;
}

/** Gauss–Legendre, 3 points on [-1, 1]. */
const GL3_X = [-Math.sqrt(0.6), 0, Math.sqrt(0.6)];
const GL3_W = [5 / 9, 8 / 9, 5 / 9];

/** Interval-evaluated expression nodes one measurement may spend: about
 *  50 ms, so a readout never stalls the page (analysis runs on the main
 *  thread). */
const WORK_BUDGET = 2_200_000;
/** A hard stop, whatever the work estimate says (a safety net: the work
 *  budget, which is deterministic, is what normally ends a measurement). */
const HARD_MS = 300;

/** A measurement that ran out of budget before it was precise enough. */
class TooCostly extends Error {
  constructor() {
    super(
      'That set could not be measured precisely enough within the time a readout may take. Restrict it to a smaller range.',
    );
  }
}

/** Relative precision a measure's bounds must reach to be reported (the
 *  readout then shows only the digits they vouch for). */
const REPORT_REL = 2e-3;
/** The same for a total, whose edge cells are bounded by |f| at its worst. */
const REPORT_REL_TOTAL = 5e-3;
/** Relative precision at which refinement stops early (on a line an edge
 *  is a few points, so it can be refined much further). */
const STOP_REL = 1e-6;
const STOP_REL_1D = 1e-12;

interface GridOptions {
  /** Author-given sides stay put; the others are padded off the grid. */
  soft?: ReadonlyArray<readonly [boolean, boolean]>;
  /** Only a rough size (the unboundedness test): no precision demanded. */
  maxDepth?: number;
}

/**
 * Area (2D) or length (1D) of a region, or the length of a curve (2D with one
 * equation), over `box`, by a quadtree refined only where the set's edge is:
 * cells the interval enclosures prove inside count whole, cells proved
 * outside drop, and the undecided cells are refined level by level while the
 * work budget lasts, then measured from their corner values. For a region
 * the undecided cells' total size bounds the error (`gap`, certified); for a
 * curve the change from the previous level estimates it.
 */
function gridMeasure(
  conds: readonly Cond[],
  values: readonly Expr[],
  names: readonly string[],
  box: readonly Interval[],
  env: Record<string, number>,
  opts: GridOptions = {},
): Measured {
  const soft = opts.soft ?? box.map(() => [true, true] as const);
  // Widen the box a little off any round grid, so a boundary never lies
  // along a cell edge (x = 1 of the unit circle, on a grid over [-2, 2]).
  const pad = box.map(([a, b]) => (b - a) * 0.0137);
  const root: Interval[] = box.map(([a, b], k) => [soft[k][0] ? a - pad[k] * 0.61 : a, soft[k][1] ? b + pad[k] : b]);
  const rootVol = root.reduce((m, [a, b]) => m * (b - a), 1);
  const dim = names.length;
  const fs = values.map(v => pointFn(v, names, env));
  const valuesKnown = values.every(intervalKnows);
  // Every test below is `at(p) < 0`: a comparison that allows equality
  // (≤) reads an exact 0 as just inside.
  const ds = conds.map(c => {
    const f = pointFn(c.d, names, env);
    const at =
      c.eq || c.strict
        ? f
        : (p: readonly number[]) => {
            const v = f(p);
            return v === 0 ? -Number.MIN_VALUE : v;
          };
    return { ...c, at };
  });
  const curve = conds.some(c => c.eq);
  // Work is counted in cells, each one enclosure of the conditions; a cell
  // proved inside also integrates the values (an enclosure and 9 points).
  const condNodes = Math.max(
    8,
    conds.reduce((n, c) => n + countNodes(c.d), 0),
  );
  const valueCost = Math.ceil((2 * values.reduce((n, e) => n + countNodes(e), 0)) / condNodes);
  const maxCells = Math.max(4096, Math.floor(WORK_BUDGET / condNodes));
  const maxDepth = opts.maxDepth ?? (dim === 1 ? 60 : 30);
  const continuous = conds.every(c => entire(c.d));
  // Measuring an undecided cell at the end, in cells' worth of work: corner
  // values, or a sample grid when several comparisons are open there.
  const estimateCost = (conds.length > 1 ? 3 : 1) * (curve && !continuous ? 12 : 1);
  const deadline = performance.now() + HARD_MS;
  let cells = 0;
  let ticks = 0;
  const tick = () => {
    cells++;
    if (++ticks % 512 === 0 && performance.now() > deadline) throw new TooCostly();
  };

  // Cells proved inside: their measure is exact; values integrate on them.
  let inner = 0;
  const totals = values.map(() => 0);
  const sizes = values.map(() => 0);
  const totalGaps = values.map(() => 0);
  const singular = new Singular(values.length);
  const addValues = (p: readonly number[], w: number) => {
    for (let i = 0; i < fs.length; i++) {
      const f = w * fs[i](p);
      totals[i] += f;
      sizes[i] += Math.abs(f);
    }
  };
  /** Per value, ∫ f and ∫ |f| over a cell by the tensor Gauss rule. */
  const gauss = (c: readonly Interval[]): { q: number[]; qa: number[] } => {
    const w = c.reduce((m, [a, b]) => m * (b - a), 1);
    const q = values.map(() => 0);
    const qa = values.map(() => 0);
    gaussCell(c, (p, g) => {
      for (let i = 0; i < fs.length; i++) {
        const f = g * w * fs[i](p);
        q[i] += f;
        qa[i] += Math.abs(f);
      }
    });
    return { q, qa };
  };
  const accept = (l: number, level: number, q: number[], qa: number[], err: number[]) => {
    for (let i = 0; i < fs.length; i++) {
      totals[i] += q[i];
      sizes[i] += qa[i];
      totalGaps[i] += err[i];
      if (l > level) singular.add(l, i, qa[i]);
    }
  };
  const insideCell = (cell: Interval[], level: number) => {
    const vol = cell.reduce((m, [a, b]) => m * (b - a), 1);
    inner += vol;
    if (!fs.length) return;
    // A value unbounded on the cell (1/r at the origin) is refined toward
    // its singularity, keeping the shells' sizes to judge convergence; one
    // that varies a lot across it is checked against its four children's
    // rule, and refined until they agree.
    const stack: Array<[Interval[], number]> = [[cell, level]];
    while (stack.length) {
      const [c, l] = stack.pop()!;
      cells += valueCost;
      tick();
      if (cells > 1.5 * maxCells) throw new TooCostly();
      let unbounded = false;
      let varies = !valuesKnown;
      if (valuesKnown) {
        for (const v of values) {
          const [lo, hi] = ivOf(v, names, env)(c);
          if (!(Number.isFinite(lo) && Number.isFinite(hi))) unbounded = true;
          else if (hi - lo > 0.25 * (Math.abs(lo) + Math.abs(hi))) varies = true;
        }
      }
      const deep = l >= level + 40;
      if (unbounded) {
        if (deep) singular.leftover++;
        else for (const child of split(c)) stack.push([child, l + 1]);
        continue;
      }
      const { q, qa } = gauss(c);
      if (!varies || deep) {
        accept(l, level, q, qa, deep && varies ? qa : q.map(() => 0));
        continue;
      }
      const kids = split(c).map(gauss);
      const qc = q.map((_, i) => kids.reduce((m, k) => m + k.q[i], 0));
      const qac = q.map((_, i) => kids.reduce((m, k) => m + k.qa[i], 0));
      const err = q.map((x, i) => Math.abs(x - qc[i]));
      if (err.every((e, i) => e <= 1e-6 * qac[i] || e === 0)) accept(l, level, qc, qac, err);
      else for (const child of split(c)) stack.push([child, l + 1]);
    }
  };

  // Second-order bounds on an undecided cell's share (below): the part of
  // it certainly inside and certainly outside, and so how much is unknown.
  const slopes = curve ? null : conds.map(c => gradientFns(c.d, names, env));
  const unknownIn = (cell: Interval[]): number => {
    const vol = cell.reduce((m, [a, b]) => m * (b - a), 1);
    if (!slopes) return vol;
    let only = -1;
    for (let k = 0; k < conds.length; k++) {
      if (truthOn([conds[k]], names, cell, env) === TRUE) continue;
      if (only >= 0) return vol;
      only = k;
    }
    const g = only >= 0 ? slopes[only] : null;
    if (!g) return vol;
    const { inside, outside } = certainParts(cell, ivOf(conds[only].d, names, env), g);
    return Math.max(0, vol - inside - outside);
  };
  let level: Interval[][] = [root];
  let open: Interval[][] = [];
  let previous: Interval[][] = [];
  let unknown: number[] = [];
  let unknownOf: Interval[][] = [];
  let predicted = Infinity;
  const stopRel = dim === 1 ? STOP_REL_1D : STOP_REL;
  for (let depth = 0; ; depth++) {
    previous = open;
    open = [];
    for (const cell of level) {
      tick();
      const truth = truthOn(conds, names, cell, env);
      if (truth === FALSE) continue;
      if (truth === TRUE) insideCell(cell, depth);
      else open.push(cell);
    }
    if (!open.length || depth >= maxDepth) break;
    // (An edge has one dimension less than the set, so the undecided cells
    // grow by 2^(dim − 1) a level; cells proved inside integrate the values.)
    const next = open.length * (2 ** dim + 2 ** (dim - 1) * (estimateCost + valueCost + 3));
    const last = cells + next > maxCells;
    // The bound is costly, so it is taken only when it may be met: it
    // shrinks about 4× a level.
    if (Number.isFinite(predicted)) predicted /= 4;
    if (!curve && ((depth >= 6 && (predicted === Infinity || predicted <= 2 * stopRel * inner)) || last)) {
      // Sample first: when even the bound over a sample, scaled up, is far
      // too wide to report, stop now rather than bound every cell.
      if (open.length > 2048) {
        const step = Math.floor(open.length / 256);
        let sample = 0;
        let vol = 0;
        for (let k = 0; k < open.length; k += step) {
          tick();
          sample += unknownIn(open[k]);
          vol += open[k].reduce((m, [a, b]) => m * (b - a), 1);
        }
        const total = open.reduce((m, c) => m + c.reduce((v, [a, b]) => v * (b - a), 1), 0);
        predicted = (sample / vol) * total;
        if (last && predicted > 4 * REPORT_REL * (inner + total)) throw new TooCostly();
        if (!last && predicted > 2 * stopRel * inner) {
          level = open.flatMap(split);
          continue;
        }
      }
      unknownOf = open;
      unknown = open.map(c => {
        tick();
        return unknownIn(c);
      });
      predicted = unknown.reduce((m, v) => m + v, 0);
      if (predicted <= stopRel * inner) break;
    }
    if (last) break;
    level = open.flatMap(split);
  }

  // The undecided cells: a region's edge from corner values, a curve's
  // segments by marching squares.
  const measureOpen = (cellsOpen: readonly Interval[][], add: (p: readonly number[], w: number) => void): number => {
    let m = 0;
    for (const cell of cellsOpen) {
      tick();
      m += estimateCell(cell, ds, dim, curve, continuous, names, env, add, fs.length > 0);
    }
    return m;
  };
  if (curve) {
    // Two levels, and how far apart they are: the length's error estimate.
    const here = measureOpen(open, addValues);
    const coarseTotals = values.map(() => 0);
    const coarse = measureOpen(previous, (p, w) => fs.forEach((f, i) => (coarseTotals[i] += w * f(p))));
    if (open.length && !previous.length) throw new TooCostly();
    // Where the curve meets its domain's edge (√(1 − x²) at x = ±1) the
    // corner values are undefined and marching squares cannot see it: each
    // such cell may hide up to its diagonal.
    const eq = ds.find(c => c.eq)!;
    let edge = 0;
    for (const cell of open) {
      const [[x0, x1], [y0, y1]] = cell;
      const corners = [eq.at([x0, y0]), eq.at([x1, y0]), eq.at([x1, y1]), eq.at([x0, y1])];
      if (corners.some(v => !Number.isFinite(v)) && corners.some(Number.isFinite)) edge += Math.hypot(x1 - x0, y1 - y0);
    }
    return {
      measure: here,
      // Four times the change: marching squares converges as h² on a
      // smooth curve, only as h through a crossing (the lemniscate's node)
      // or where the curve ends at its domain's edge.
      gap: open.length ? 4 * Math.abs(here - coarse) + edge : 0,
      totals: totals.map((t, i) => (Math.abs(t) < 1e-10 * sizes[i] ? 0 : t)),
      totalGaps: totals.map((t, i) => 4 * Math.abs(t - coarseTotals[i])),
      sizes,
    };
  }
  let gap = 0;
  const est = measureOpen(open, addValues);
  if (unknownOf !== open) unknown = open.map(unknownIn);
  open.forEach((cell, k) => {
    gap += unknown[k];
    values.forEach((v, i) => {
      const [lo, hi] = valuesKnown ? ivOf(v, names, env)(cell) : [-Infinity, Infinity];
      totalGaps[i] += unknown[k] * Math.max(Math.abs(lo), Math.abs(hi));
    });
  });
  const tails = singular.tails();
  const measure = inner + est;
  return {
    measure,
    gap: gap <= 1e-12 * rootVol ? 0 : gap,
    totals: totals.map((t, i) => (Math.abs(t) < 1e-10 * sizes[i] ? 0 : t)),
    totalGaps: totalGaps.map((g, i) => (open.length ? g : 0) + tails[i]),
    sizes,
  };
}

/** Enclosures of ∂d/∂(each coordinate), or null when d is not smooth or
 *  not enclosable. */
function gradientFns(d: Expr, names: readonly string[], env: Record<string, number>) {
  try {
    const gs = names.map(n => diff(bindConstants(d, env), n));
    if (!gs.every(intervalKnows)) return null;
    return gs.map(g => intervalFn(g, names, {}));
  } catch (e) {
    if (e instanceof NonSmoothError) return null;
    throw e;
  }
}

/**
 * The parts of a cell where `d < 0` certainly holds, and where it certainly
 * fails, by the mean value theorem: d(p) lies between d(c) + G·(p − c) at the
 * gradient enclosure G's extremes, which is linear on each quadrant around
 * the centre c. The band left between them narrows as h² (the first-order
 * cell count as h), so a smooth edge is bounded far more tightly.
 */
function certainParts(
  cell: readonly Interval[],
  F: (box: readonly Interval[]) => Interval,
  G: ReadonlyArray<(box: readonly Interval[]) => Interval>,
): { inside: number; outside: number } {
  const c = cell.map(([a, b]) => (a + b) / 2);
  const [flo, fhi] = F(c.map((v): Interval => [v, v]));
  const g = G.map(f => f(cell));
  if (![flo, fhi, ...g.flat()].every(Number.isFinite)) return { inside: 0, outside: 0 };
  // Rounding in the linear bounds, generously.
  const h = cell.map(([a, b]) => b - a);
  const eps =
    1e-12 * (Math.abs(flo) + Math.abs(fhi) + g.reduce((m, [a, b], k) => m + (Math.abs(a) + Math.abs(b)) * h[k], 0));
  let inside = 0;
  let outside = 0;
  if (cell.length === 1) {
    const [[a, b]] = cell;
    const [[ga, gb]] = g;
    // Right half: up = fhi + gb·(x − c); left half: up = fhi + ga·(x − c).
    inside += negativeLength(c[0], b, fhi + eps, fhi + eps + gb * (b - c[0]));
    inside += negativeLength(a, c[0], fhi + eps - ga * (c[0] - a), fhi + eps);
    outside += negativeLength(c[0], b, -(flo - eps), -(flo - eps + ga * (b - c[0])));
    outside += negativeLength(a, c[0], -(flo - eps - gb * (c[0] - a)), -(flo - eps));
    return { inside, outside };
  }
  const [[x0, x1], [y0, y1]] = cell;
  const [cx, cy] = c;
  const [[gxl, gxh], [gyl, gyh]] = g;
  for (const qx of [-1, 1]) {
    for (const qy of [-1, 1]) {
      const [ax, bx] = qx < 0 ? [x0, cx] : [cx, x1];
      const [ay, by] = qy < 0 ? [y0, cy] : [cy, y1];
      // Above: the largest slope on the side it multiplies positively.
      const ux = qx > 0 ? gxh : gxl;
      const uy = qy > 0 ? gyh : gyl;
      const lx = qx > 0 ? gxl : gxh;
      const ly = qy > 0 ? gyl : gyh;
      const U = (x: number, y: number) => fhi + eps + ux * (x - cx) + uy * (y - cy);
      const L = (x: number, y: number) => -(flo - eps + lx * (x - cx) + ly * (y - cy));
      inside += negativeArea(ax, bx, ay, by, U(ax, ay), U(bx, ay), U(bx, by), U(ax, by));
      outside += negativeArea(ax, bx, ay, by, L(ax, ay), L(bx, ay), L(bx, by), L(ax, by));
    }
  }
  return { inside, outside };
}

/** Length of the part of [a, b] where a linear function (fa at a, fb at b)
 *  is negative. */
function negativeLength(a: number, b: number, fa: number, fb: number): number {
  if (fa < 0 && fb < 0) return b - a;
  if (fa >= 0 && fb >= 0) return 0;
  const s = a + ((b - a) * fa) / (fa - fb);
  return fa < 0 ? s - a : b - s;
}

/** Area of the part of a rectangle where a linear function is negative,
 *  from its corner values (counter-clockwise from (x0, y0)). */
function negativeArea(x0: number, x1: number, y0: number, y1: number, ...v: number[]): number {
  if (v[0] < 0 && v[1] < 0 && v[2] < 0 && v[3] < 0) return (x1 - x0) * (y1 - y0);
  if (v[0] >= 0 && v[1] >= 0 && v[2] >= 0 && v[3] >= 0) return 0;
  const xs = [x0, x1, x1, x0];
  const ys = [y0, y0, y1, y1];
  let twice = 0;
  let px = NaN;
  let py = NaN;
  let fx = NaN;
  let fy = NaN;
  const add = (x: number, y: number) => {
    if (Number.isNaN(px)) [fx, fy] = [x, y];
    else twice += px * y - x * py;
    [px, py] = [x, y];
  };
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    if (v[i] < 0) add(xs[i], ys[i]);
    if (v[i] < 0 !== v[j] < 0) {
      const t = v[i] / (v[i] - v[j]);
      add(xs[i] + t * (xs[j] - xs[i]), ys[i] + t * (ys[j] - ys[i]));
    }
  }
  twice += px * fy - fx * py;
  return Math.abs(twice) / 2;
}

/**
 * The shells around a value's singularity inside a region: the |f| mass the
 * cells next to it carry, level by level. Shrinking geometrically, the part
 * left in the last cells is bounded by their sum; not shrinking, the
 * integral diverges.
 */
class Singular {
  leftover = 0;
  private shells: number[][];
  constructor(n: number) {
    this.shells = Array.from({ length: n }, () => []);
  }
  add(level: number, i: number, mass: number) {
    this.shells[i][level] = (this.shells[i][level] ?? 0) + mass;
  }
  /** Per value, a bound on what the unrefined singular cells hold. */
  tails(): number[] {
    return this.shells.map(sh => {
      if (!this.leftover) return 0;
      const last = sh.filter(v => v !== undefined).slice(-10);
      if (last.length < 10 || !(last[0] > 0)) return Infinity;
      // The shells' mean ratio over the last levels (the grid is not centred
      // on the singularity, so single ratios wobble).
      const r = (last[last.length - 1] / last[0]) ** (1 / (last.length - 1));
      if (r >= 0.97) throw new Diverges(0);
      return r <= 0.9 ? (Math.max(...last.slice(-3)) * r) / (1 - r) : Infinity;
    });
  }
}

/** One undecided cell's share of the set: a region's part from its corner
 *  values (second order at one open comparison), or a curve's length. */
function estimateCell(
  cell: readonly Interval[],
  ds: ReadonlyArray<Cond & { at: (p: readonly number[]) => number }>,
  dim: number,
  curve: boolean,
  continuous: boolean,
  names: readonly string[],
  env: Record<string, number>,
  addValues: (p: readonly number[], w: number) => void,
  wantValues: boolean,
): number {
  if (curve) {
    const eq = ds.find(c => c.eq)!;
    const others = ds.filter(c => c !== eq);
    let m = 0;
    for (const [p, q] of marchingSegments(cell, eq.at, continuous)) {
      const [a, b] = clipSegment(p, q, pt => others.every(c => c.at(pt) < 0));
      if (!a) continue;
      const len = Math.hypot(b![0] - a[0], b![1] - a[1]);
      m += len;
      addValues([(a[0] + b![0]) / 2, (a[1] + b![1]) / 2], len);
    }
    return m;
  }
  const open = ds.filter(c => truthOn([c], names, cell, env) !== TRUE);
  if (open.length === 1 && dim === 2) {
    const poly = clipCell(cell, open[0].at);
    const area = polygonArea(poly);
    if (area > 0 && wantValues) addValues(centroid(poly), area);
    return area > 0 ? area : 0;
  }
  if (open.length === 1 && dim === 1) {
    const [a, b] = cell[0];
    const fa = open[0].at([a]);
    const fb = open[0].at([b]);
    if (fa < 0 && fb < 0) {
      addValues([(a + b) / 2], b - a);
      return b - a;
    }
    if (fa < 0 !== fb < 0 && Number.isFinite(fa) && Number.isFinite(fb)) {
      const s = a + ((b - a) * fa) / (fa - fb);
      const [l, r] = fa < 0 ? [a, s] : [s, b];
      addValues([(l + r) / 2], r - l);
      return r - l;
    }
    return 0;
  }
  const n = 8;
  const vol = cell.reduce((m, [a, b]) => m * (b - a), 1) / n ** dim;
  let m = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < (dim === 2 ? n : 1); j++) {
      const p = cell.map(([a, b], k) => a + ((b - a) * ((k === 0 ? i : j) + 0.5)) / n);
      if (!ds.every(c => (c.eq ? true : c.at(p) < 0))) continue;
      m += vol;
      addValues(p, vol);
    }
  }
  return m;
}

function split(cell: readonly Interval[]): Interval[][] {
  if (cell.length === 1) {
    const [a, b] = cell[0];
    const m = (a + b) / 2;
    return [[[a, m]], [[m, b]]];
  }
  const [[a, b], [c, d]] = cell;
  const m = (a + b) / 2;
  const n = (c + d) / 2;
  const x0: Interval = [a, m];
  const x1: Interval = [m, b];
  const y0: Interval = [c, n];
  const y1: Interval = [n, d];
  return [
    [x0, y0],
    [x0, y1],
    [x1, y0],
    [x1, y1],
  ];
}

/** Tensor 3-point Gauss rule on a cell, with weights summing to 1. */
function gaussCell(cell: readonly Interval[], visit: (p: number[], w: number) => void): void {
  const at = (k: number, i: number) => {
    const [a, b] = cell[k];
    return (a + b) / 2 + ((b - a) / 2) * GL3_X[i];
  };
  if (cell.length === 1) {
    for (let i = 0; i < 3; i++) visit([at(0, i)], GL3_W[i] / 2);
    return;
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) visit([at(0, i), at(1, j)], (GL3_W[i] * GL3_W[j]) / 4);
}

/** The part of a square cell where `d < 0`, with the boundary linear between
 *  corner values (marching squares, as a polygon). */
function clipCell(cell: readonly Interval[], d: (p: readonly number[]) => number): number[][] {
  const [[x0, x1], [y0, y1]] = cell;
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const vals = corners.map(c => d(c));
  if (vals.some(v => !Number.isFinite(v))) return [];
  const poly: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    if (vals[i] < 0) poly.push(corners[i]);
    if (vals[i] < 0 !== vals[j] < 0) {
      const s = vals[i] / (vals[i] - vals[j]);
      poly.push([
        corners[i][0] + s * (corners[j][0] - corners[i][0]),
        corners[i][1] + s * (corners[j][1] - corners[i][1]),
      ]);
    }
  }
  return poly;
}

function polygonArea(poly: readonly number[][]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

function centroid(poly: readonly number[][]): number[] {
  let twice = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    const c = x0 * y1 - x1 * y0;
    twice += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
  }
  return twice === 0 ? poly[0] : [cx / (3 * twice), cy / (3 * twice)];
}

/** The pieces of the curve `g = 0` in a cell, from the signs at its corners;
 *  an ambiguous saddle is resolved by the value at the centre. */
function marchingSegments(
  cell: readonly Interval[],
  g: (p: readonly number[]) => number,
  continuous = true,
): number[][][] {
  const [[x0, x1], [y0, y1]] = cell;
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const vals = corners.map(c => g(c));
  if (vals.some(v => !Number.isFinite(v))) return [];
  const cross: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    if (vals[i] < 0 !== vals[j] < 0) {
      const s = vals[i] / (vals[i] - vals[j]);
      cross.push([
        corners[i][0] + s * (corners[j][0] - corners[i][0]),
        corners[i][1] + s * (corners[j][1] - corners[i][1]),
      ]);
    }
  }
  // A sign change across a jump (y = sign(x) at x = 0) is not a zero: where
  // g may be discontinuous, bisect along the edge and keep only crossings
  // where g really approaches 0.
  if (!continuous) {
    let k = 0;
    for (let i = 0; i < 4 && k < cross.length; i++) {
      const j = (i + 1) % 4;
      if (vals[i] < 0 === vals[j] < 0) continue;
      let [a, fa, b] = [corners[i], vals[i], corners[j]];
      let mid = a;
      let fm = fa;
      for (let it = 0; it < 24; it++) {
        mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        fm = g(mid);
        if (fm < 0 === fa < 0) [a, fa] = [mid, fm];
        else b = mid;
      }
      if (!(Math.abs(fm) <= 1e-5 * (Math.abs(vals[i]) + Math.abs(vals[j])))) return [];
      k++;
    }
  }
  if (cross.length === 2) return [[cross[0], cross[1]]];
  if (cross.length !== 4) return [];
  // Edges 0..3 each crossed; pair them so the centre's side stays connected.
  const centre = g([(x0 + x1) / 2, (y0 + y1) / 2]);
  return centre < 0 === vals[0] < 0
    ? [
        [cross[0], cross[1]],
        [cross[2], cross[3]],
      ]
    : [
        [cross[3], cross[0]],
        [cross[1], cross[2]],
      ];
}

/** The part of segment pq where `inside` holds, assuming it changes at most
 *  once along it; [null, null] when none does. */
function clipSegment(
  p: number[],
  q: number[],
  inside: (pt: readonly number[]) => boolean,
): [number[], number[]] | [null, null] {
  const ip = inside(p);
  const iq = inside(q);
  if (ip && iq) return [p, q];
  if (!ip && !iq) return [null, null];
  let a = 0;
  let b = 1;
  const at = (s: number) => [p[0] + s * (q[0] - p[0]), p[1] + s * (q[1] - p[1])];
  for (let i = 0; i < 40; i++) {
    const m = (a + b) / 2;
    if (inside(at(m)) === ip) a = m;
    else b = m;
  }
  const s = (a + b) / 2;
  return ip ? [p, at(s)] : [at(s), q];
}

/** Intervals one root count may examine: past this it is an error, never
 *  a short count. */
const ROOT_BUDGET = 40_000;

/**
 * Distinct roots of a 1D equation in [lo, hi] that satisfy the other
 * conditions, each certified: interval arithmetic drops the pieces where
 * the function cannot vanish, and on a piece where its derivative keeps one
 * sign (so at most one root) a certain sign change proves exactly one. A
 * piece that never settles (a double root, or roots piling up as sin(1/x)'s
 * do at 0), or a count past the budget, is an error rather than a count
 * that may be short.
 */
function rootsOnLine(
  conds: readonly Cond[],
  values: readonly Expr[],
  v: string,
  [lo, hi]: Interval,
  env: Record<string, number>,
): Measured {
  const eq = conds.find(c => c.eq)!;
  const others = conds.filter(c => c !== eq);
  const d = bindConstants(eq.d, env);
  const f = pointFn(d, [v], {});
  // An identity (sin(x)^2 + cos(x)^2 = 1) is a range, not points.
  const probe = Array.from({ length: 33 }, (_, k) => lo + ((hi - lo) * (k + 0.37)) / 33);
  if (probe.every(x => Math.abs(f([x])) <= 1e-12)) {
    throw new Error('That equation holds for every value: it is not a set of points.');
  }
  let dd: Expr | null = null;
  try {
    dd = diff(d, v);
  } catch (e) {
    if (!(e instanceof NonSmoothError)) throw e;
  }
  if (!dd || !intervalKnows(d) || !intervalKnows(dd)) {
    throw new Error(
      'The roots of that equation cannot all be proved (it uses a function without an interval enclosure), so they are not counted.',
    );
  }
  const F = intervalFn(d, [v], {});
  const D = intervalFn(dd, [v], {});
  const sign = (x: number) => {
    const [a, b] = F([[x, x]]);
    return a > 0 ? 1 : b < 0 ? -1 : 0;
  };
  const deadline = performance.now() + HARD_MS;
  const roots: number[] = [];
  const stack: Interval[] = [[lo, hi]];
  let visited = 0;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (++visited > ROOT_BUDGET || (visited % 256 === 0 && performance.now() > deadline)) {
      throw new Error(
        `That equation has too many roots in the range to count (or infinitely many). Restrict the range, like count({0 < ${v} < 10, …}).`,
      );
    }
    const [flo, fhi] = F([[a, b]]);
    if (flo > 0 || fhi < 0) continue;
    const [dlo, dhi] = D([[a, b]]);
    if (dlo > 0 || dhi < 0) {
      // Monotone here: at most one root, found by the signs at the ends.
      const sa = sign(a);
      const sb = sign(b);
      if (sa && sb) {
        if (sa !== sb) roots.push(bisectRoot(f, a, b, sa));
      } else {
        // An end within rounding of the root: it is there (a neighbour that
        // finds it too is merged by distinct).
        roots.push(sa ? b : a);
      }
      continue;
    }
    const w = b - a;
    const m = a + 0.493 * w;
    if (!(w > 1e-12 * Math.max(1, Math.abs(a), Math.abs(b))) || m <= a || m >= b) {
      // A root exactly at an end of the range (sin(x^2) at 0) never
      // separates; prove the rest of the piece empty, shell by shell toward
      // that end, and let the range's own condition decide the end itself.
      const end = [lo, hi].find(e => e === a || e === b);
      if (end !== undefined && emptyToward(F, a, b, end)) {
        if (sign(end) === 0) roots.push(end);
        continue;
      }
      throw new Error(
        `The roots near ${v} = ${Number(a.toPrecision(6))} could not be told apart (a repeated root, or roots closer together than the arithmetic can separate), so they are not counted.`,
      );
    }
    stack.push([m, b], [a, m]);
  }
  return pointsMeasure(distinct(roots.map(x => [x])), others, values, [v], env);
}

/** Whether F excludes 0 on all of [a, b] but the point `end` (one of its
 *  ends): dyadic shells toward it, down to 1e-30 of the scale (below that,
 *  powers underflow and nothing can be proved; a root that close to the end
 *  is taken to be the end). */
function emptyToward(F: (box: readonly Interval[]) => Interval, a: number, b: number, end: number): boolean {
  const far = end === a ? b : a;
  const floor = 1e-30 * Math.max(1, Math.abs(end));
  for (let k = 0; k < 1100; k++) {
    const near = end + (far - end) / 2 ** (k + 1);
    const outer = end + (far - end) / 2 ** k;
    if (Math.abs(near - end) < floor) return true;
    const [flo, fhi] = F([[Math.min(near, outer), Math.max(near, outer)]]);
    if (!(flo > 0 || fhi < 0)) return false;
  }
  return false;
}

/** The root of f in [a, b], where f(a) has sign `sa` and f(b) the other. */
function bisectRoot(f: (p: readonly number[]) => number, a: number, b: number, sa: number): number {
  for (let i = 0; i < 80; i++) {
    const m = (a + b) / 2;
    if (m <= a || m >= b) break;
    const fm = f([m]);
    if (fm === 0) return m;
    if (Math.sign(fm) === sa) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

const bindConstants = (e: Expr, env: Record<string, number>): Expr =>
  substVars(e, Object.fromEntries(Object.entries(env).map(([k, x]) => [k, num(x)])));

/** Roots of a 2D system in a box, each proved unique by the Krawczyk test;
 *  an incomplete search is an error rather than a count that may be short. */
function rootsInPlane(
  conds: readonly Cond[],
  values: readonly Expr[],
  names: readonly string[],
  box: readonly Interval[],
  env: Record<string, number>,
): Measured {
  const eqs = conds.filter(c => c.eq);
  const others = conds.filter(c => !c.eq);
  const residuals = eqs.map(c => c.d);
  const lo = box.map(b => b[0]);
  const hi = box.map(b => b[1]);
  const seeds = solveSystem(residuals, [...names], lo, hi, { env });
  const cert = certifySystem(residuals, [...names], lo, hi, env, 8192, seeds);
  if (!cert.complete) {
    throw new Error(
      'The solutions of that system could not all be proved: count needs every one. Try a system of polynomials, or a smaller range.',
    );
  }
  return pointsMeasure(distinct(cert.roots), others, values, names, env);
}

function distinct(points: number[][]): number[][] {
  const out: number[][] = [];
  for (const p of points) {
    if (!out.some(q => q.every((x, k) => Math.abs(x - p[k]) <= 1e-9 * (1 + Math.abs(x))))) out.push(p);
  }
  return out;
}

function pointsMeasure(
  points: number[][],
  others: readonly Cond[],
  values: readonly Expr[],
  names: readonly string[],
  env: Record<string, number>,
): Measured {
  const tests = others.map(c => ({ at: pointFn(c.d, names, env), strict: c.strict }));
  const kept = points.filter(p => tests.every(t => (t.strict ? t.at(p) < 0 : t.at(p) <= 0)));
  const fs = values.map(v => pointFn(v, names, env));
  const at = kept.map(p => fs.map(f => f(p)));
  return { measure: kept.length, totals: fs.map((_, i) => at.reduce((s, row) => s + row[i], 0)), values: at };
}
