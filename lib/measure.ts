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
 * - **Symbolic.** A product of ranges (`total(u^2)`, `{0 < x < 1: x^2}`), or
 *   a curve written as a graph over a bounded range (`{y = x^2, 0 < x < 1}`,
 *   arc length ∫ √(1 + g'²)). These become ordinary integrals through the
 *   resolver's ∫ machinery, so sliders stay symbolic and the row stays live.
 * - **Numeric.** Any other filter in one or two coordinates: a quadtree with
 *   interval enclosures (lib/certify.ts) that proves cells in or out and
 *   measures only the boundary finely — marching squares for a curve's
 *   length — and root finding for points. The set is first proved bounded
 *   (or proved to hold an infinite strip); the grid comes from the set, never
 *   the view. Its constants are read at resolve time, as Σ bounds are, so a
 *   slider change recomputes it.
 */
import { certifySystem, intervalValue, type Interval } from './certify.ts';
import { NonSmoothError, add, diff, mul, pow } from './diff.ts';
import { type Expr, childrenOf, evaluate, exprKey, freeVars, substVars } from './expr.ts';
import { quadrature } from './integrate.ts';
import { intervalsIn, replaceIntervals } from './interval.ts';
import { polynomialRoots } from './poly.ts';
import { findRoots } from './roots.ts';
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
  /** ∫ body dv from lo to hi, closed form when there is one; ±∞ bounds are
   *  `inf` / `-inf`. */
  integrate(body: Expr, v: string, lo: Expr, hi: Expr): Expr;
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
    if (points) {
      rest.push(c);
      continue;
    }
    const side = c.op !== '=' && c.l.kind === 'var' && names.includes(c.l.name) && !mentions(c.r) ? 'l' : null;
    const other = c.op !== '=' && c.r.kind === 'var' && names.includes(c.r.name) && !mentions(c.l) ? 'r' : null;
    if (side) ranges.get((c.l as Expr & { kind: 'var' }).name)![c.op === '<' ? 'hi' : 'lo'].push(c.r);
    else if (other) ranges.get((c.r as Expr & { kind: 'var' }).name)![c.op === '<' ? 'lo' : 'hi'].push(c.l);
    else rest.push(c);
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
  const integrate = (body: Expr, what: string, measure: boolean): Expr => {
    if (infinite.length > 1) {
      if (measure) return num(Infinity);
      throw new Error(`${what} over an unbounded plane is not supported: restrict it, like total({x^2 + y^2 < 1: …}).`);
    }
    let out = weight ? mul(body, weight) : body;
    for (const c of order) {
      if (infinite.includes(c) && !absolutelyIntegrable(out, c, host, what)) {
        if (measure) return num(Infinity);
        throw new Error(`${what} diverges: the integral over all of ${c.name} does not converge.`);
      }
      out = host.integrate(out, c.name, c.lo, c.hi);
    }
    return out;
  };
  const measure = (): Expr => {
    if (!weight) {
      if (infinite.length) return num(Infinity);
      return coords.map(lengthOf).reduce((m, l) => fold(m, l, '*'), num(1));
    }
    return integrate(num(1), 'count', true);
  };
  const componentwise = (f: (e: Expr) => Expr): Expr =>
    value.kind === 'vec' ? { kind: 'vec', items: value.items.map(f) } : f(value);
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

const lengthOf = (c: Coord): Expr => fold(c.hi, c.lo, '-');

function fold(a: Expr, b: Expr, op: '*' | '-'): Expr {
  if (a.kind === 'num' && b.kind === 'num') return num(op === '*' ? a.value * b.value : a.value - b.value);
  if (op === '*' && a.kind === 'num' && a.value === 1) return b;
  if (op === '*' && b.kind === 'num' && b.value === 1) return a;
  return { kind: 'bin', op, a, b };
}

/**
 * Whether ∫|f| over the infinite range converges, at the constants' current
 * values: the Lebesgue integral needs it, and an improper sum over a
 * divergent range (∫ x dx over ℝ reads 0 by symmetry) would otherwise report
 * a confident wrong number.
 */
function absolutelyIntegrable(f: Expr, c: Coord, host: MeasureHost, what: string): boolean {
  const env = constantsFor([f, c.lo, c.hi], [c.name], host, what);
  const bound = (e: Expr) => (isInf(e, 1) ? Infinity : isInf(e, -1) ? -Infinity : evaluate(e, env));
  const at = pointFn(f, [c.name], env);
  const got = quadrature(x => Math.abs(at([x])), bound(c.lo), bound(c.hi));
  return Number.isFinite(got);
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
    const [lo, hi] = intervalValue(c.d, names, box, env);
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
  /** ∫ f over the set, per component of the value. */
  totals: number[];
  /** The values at the points (a 0-dimensional set only), for min and max. */
  values?: number[][];
}

/** A slider drag re-resolves every row: keep recent measurements. */
const memo = new Map<string, Measured>();

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
  let got = memo.get(key);
  if (!got) {
    // count needs only the measure; the others need the values too.
    got = measureSet(conds, name === 'count' ? [] : values, names, lo, hi, env);
    if (memo.size > 200) memo.clear();
    memo.set(key, got);
  }
  const vec = (xs: number[]): Expr => (value.kind === 'vec' ? { kind: 'vec', items: xs.map(num) } : num(xs[0]));
  if (name === 'count') return num(got.measure);
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
  if (name === 'total') return vec(got.totals);
  if (got.measure === 0) throw new Error('mean over an empty set has no value.');
  return vec(got.totals.map(t => t / got!.measure));
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
  if (lo.some((l, k) => !(hi[k] > l))) return { measure: 0, totals: values.map(() => 0), values: [] };
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
  const box = boundSet(conds, names, lo, hi, env);
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
    const a = gridMeasure(conds, [], names, far(1024), env, 7).measure;
    const b = gridMeasure(conds, [], names, far(2048), env, 7).measure;
    if (b > 1.5 * a && b > 0) return { measure: Infinity, totals: [] };
    throw new Error('That set is unbounded, and its measure could not be found. Restrict it to a bounded range.');
  }
  // Only the sides the bound search chose may move off the grid; a range the
  // author gave (0 < x < 1) is an edge of the set itself.
  const soft = box.map((_, k): [boolean, boolean] => [!Number.isFinite(lo[k]), !Number.isFinite(hi[k])]);
  // A long boundary can exhaust the cell budget: step down to coarser cells
  // (less precise, still from the set alone) before giving up.
  for (let depth = names.length === 1 ? 20 : DEPTH_2D; ; depth -= 2) {
    try {
      return gridMeasure(conds, values, names, box, env, depth, soft);
    } catch (e) {
      if (!(e instanceof OverBudget) || depth <= 8) throw e;
    }
  }
}

class OverBudget extends Error {
  constructor() {
    super('That set is too intricate to measure within the cell budget.');
  }
}

/** Quadtree depth in the plane: cells 1/4096 of the box across. */
const DEPTH_2D = 12;

/**
 * A box outside which no condition can hold, found by proving each far strip
 * empty with interval arithmetic: 'infinite' when a far strip is proved
 * inside the set (a region, so of infinite measure), null when neither is
 * proved. Ranges already finite are kept.
 */
function boundSet(
  conds: readonly Cond[],
  names: readonly string[],
  lo: readonly number[],
  hi: readonly number[],
  env: Record<string, number>,
): Interval[] | 'infinite' | null {
  const box: Interval[] = names.map((_, k) => [lo[k], hi[k]]);
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let k = 0; k < names.length; k++) {
      if (Number.isFinite(box[k][0]) && Number.isFinite(box[k][1])) continue;
      for (let e = -8; e <= 20; e++) {
        const R = 2 ** e;
        const strip = (side: Interval): Truth => {
          const b = box.map(v => [...v] as Interval);
          b[k] = side;
          return truthOn(conds, names, b, env);
        };
        const up = box[k][1] === Infinity ? strip([Math.max(R, box[k][0]), Infinity]) : FALSE;
        const down = box[k][0] === -Infinity ? strip([-Infinity, Math.min(-R, box[k][1])]) : FALSE;
        if (up === TRUE || down === TRUE) return 'infinite';
        if (up === FALSE && down === FALSE) {
          box[k] = [Math.max(box[k][0], -R), Math.min(box[k][1], R)];
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  return box.every(([a, b]) => Number.isFinite(a) && Number.isFinite(b)) ? box : null;
}

/** Gauss–Legendre, 3 points on [-1, 1]. */
const GL3_X = [-Math.sqrt(0.6), 0, Math.sqrt(0.6)];
const GL3_W = [5 / 9, 8 / 9, 5 / 9];

/** Cells one measurement may visit: a readout must not stall the page. */
const CELL_BUDGET = 100_000;

/**
 * Area (2D) or length (1D) of a region, or the length of a curve (2D with one
 * equation), over `box`, by a quadtree: cells the interval enclosures prove
 * inside count whole, cells proved outside drop, and cells still undecided
 * at `depth` are measured from their corner values.
 */
function gridMeasure(
  conds: readonly Cond[],
  values: readonly Expr[],
  names: readonly string[],
  box: readonly Interval[],
  env: Record<string, number>,
  depth: number,
  soft: ReadonlyArray<readonly [boolean, boolean]> = box.map(() => [true, true]),
): Measured {
  // Widen the box a little off any round grid, so a boundary never lies
  // along a cell edge (x = 1 of the unit circle, on a grid over [-2, 2]).
  const pad = box.map(([a, b]) => (b - a) * 0.0137);
  const root: Interval[] = box.map(([a, b], k) => [soft[k][0] ? a - pad[k] * 0.61 : a, soft[k][1] ? b + pad[k] : b]);
  const dim = names.length;
  const fs = values.map(v => pointFn(v, names, env));
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
  const totals = values.map(() => 0);
  // ∫|f| alongside, so a total that cancels to rounding noise reads 0.
  const sizes = values.map(() => 0);
  let measure = 0;
  const holds = (p: readonly number[]) => ds.every(c => (c.eq ? true : c.at(p) < 0));
  const addValues = (p: readonly number[], w: number) => {
    for (let i = 0; i < fs.length; i++) {
      const f = w * fs[i](p);
      totals[i] += f;
      sizes[i] += Math.abs(f);
    }
  };
  const stack: Array<{ box: Interval[]; level: number }> = [{ box: root, level: 0 }];
  let cells = 0;
  while (stack.length) {
    const { box: cell, level } = stack.pop()!;
    if (++cells > CELL_BUDGET) throw new OverBudget();
    const truth = truthOn(conds, names, cell, env);
    if (truth === FALSE) continue;
    if (truth === TRUE) {
      const vol = cell.reduce((m, [a, b]) => m * (b - a), 1);
      measure += vol;
      if (fs.length) gaussCell(cell, (p, w) => addValues(p, w * vol));
      continue;
    }
    if (level < depth) {
      for (const child of split(cell)) stack.push({ box: child, level: level + 1 });
      continue;
    }
    if (curve) {
      const eq = ds.find(c => c.eq)!;
      const others = ds.filter(c => c !== eq);
      for (const [p, q] of marchingSegments(cell, eq.at)) {
        const [a, b] = clipSegment(p, q, pt => others.every(c => c.at(pt) < 0));
        if (!a) continue;
        const len = Math.hypot(b![0] - a[0], b![1] - a[1]);
        measure += len;
        addValues([(a[0] + b![0]) / 2, (a[1] + b![1]) / 2], len);
      }
      continue;
    }
    // A boundary cell. One undecided comparison: its corner values place the
    // boundary (second order); several: sample the cell.
    const open = ds.filter(c => truthOn([c], names, cell, env) !== TRUE);
    if (open.length === 1 && dim === 2) {
      const poly = clipCell(cell, open[0].at);
      const area = polygonArea(poly);
      if (area > 0) {
        measure += area;
        addValues(centroid(poly), area);
      }
    } else if (open.length === 1 && dim === 1) {
      const [a, b] = cell[0];
      const fa = open[0].at([a]);
      const fb = open[0].at([b]);
      if (fa < 0 && fb < 0) {
        measure += b - a;
        addValues([(a + b) / 2], b - a);
      } else if (fa < 0 !== fb < 0 && Number.isFinite(fa) && Number.isFinite(fb)) {
        const s = a + ((b - a) * fa) / (fa - fb);
        const [l, r] = fa < 0 ? [a, s] : [s, b];
        measure += r - l;
        addValues([(l + r) / 2], r - l);
      }
    } else {
      const n = 8;
      const vol = cell.reduce((m, [a, b]) => m * (b - a), 1) / n ** dim;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < (dim === 2 ? n : 1); j++) {
          const p = cell.map(([a, b], k) => a + ((b - a) * ((k === 0 ? i : j) + 0.5)) / n);
          if (!holds(p)) continue;
          measure += vol;
          addValues(p, vol);
        }
      }
    }
  }
  return { measure, totals: totals.map((t, i) => (Math.abs(t) < 1e-10 * sizes[i] ? 0 : t)) };
}

function split(cell: readonly Interval[]): Interval[][] {
  let out: Interval[][] = [[]];
  for (const [a, b] of cell) {
    const m = (a + b) / 2;
    out = out.flatMap(c => [
      [...c, [a, m] as Interval],
      [...c, [m, b] as Interval],
    ]);
  }
  return out;
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
function marchingSegments(cell: readonly Interval[], g: (p: readonly number[]) => number): number[][][] {
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

/** Distinct roots of a 1D equation in [lo, hi] that satisfy the other conditions. */
function rootsOnLine(
  conds: readonly Cond[],
  values: readonly Expr[],
  v: string,
  [lo, hi]: Interval,
  env: Record<string, number>,
): Measured {
  const eq = conds.find(c => c.eq)!;
  const others = conds.filter(c => c !== eq);
  const roots = findRoots(bindConstants(eq.d, env), v, lo, hi);
  if (roots === 'zero') throw new Error('That equation holds for every value: it is not a set of points.');
  return pointsMeasure(distinct(roots.map(r => [r.x])), others, values, [v], env);
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
