/**
 * Probability distribution rows.
 *
 * - `X ~ Normal(mean, sd)` (also Uniform, Exponential, Gamma, Beta,
 *   ChiSquared, StudentT, LogNormal, Cauchy, Weibull — lib/dist-families.ts)
 *   declares a random variable; the row plots its exact density. Parameters
 *   may reference constants (sliders) and t, so `X ~ Normal(0, a)` responds
 *   to the slider.
 * - `X ~ Binomial(n, p)` (also Poisson, Geometric, NegativeBinomial, Bernoulli,
 *   DiscreteUniform) declares a DISCRETE variable: the row plots its pmf as
 *   stems, `P(…)` with constant bounds is the exact mass of the whole numbers
 *   it selects (so `<` and `<=` differ, and `P(X = 3)` is a number), `E(X)`
 *   the closed-form mean. Nothing below applies to them yet — every tier
 *   there assumes a density — so a derived row over one is refused by name.
 * - `Y = g(X, …)` where the right side references random variables declares a
 *   *derived* random variable — arithmetic on distributions. `S = X1 + X2` is
 *   the convolution of independent summands, `X Y` the product distribution,
 *   and piecewise conditionals work too: `Y = {X > 0: X^2, 1}`. Derived rows
 *   (and bare expressions like `X + Y`) plot a density estimated from samples.
 * - `P(…)` takes any inequality over the declared variables: `P(X < b)`,
 *   `P(a < X < b)`, `P(Y > 0.5)`, even `P(Y > X)`. Single-variable bounds on a
 *   base distribution stay exact (closed-form CDF + shaded region); everything
 *   else is estimated from the same joint samples.
 * - `E(…)` takes any expression over the declared variables: `E(X)`,
 *   `E(X^2 + Y)`. The mean is exact when the law is (closed-form pdfs and
 *   uniform sums), the finite-sample mean otherwise, and the row draws a
 *   vertical marker at x = E under the expression's density.
 *
 * Sampling model: every base variable owns a deterministic stratified stream
 * of standard uniforms (equal-mass quantile midpoints, shuffled by a hash of
 * its name — a Latin-hypercube pairing across variables). Samples are the
 * quantile transform of that stream, so distinct names are independent while
 * a derived variable, evaluated per-sample over its dependencies, preserves
 * the joint distribution exactly: `X + X` is 2X, `P(Y > X)` sees the
 * dependence of Y on X. Streams are fixed, so results are reproducible and
 * respond continuously to slider drags (common random numbers).
 */
import {
  BETA_PDF_FN,
  BINOM_PMF_FN,
  DUNIFORM_PMF_FN,
  EVAL_FNS,
  type Expr,
  GAMMA_PDF_FN,
  NEGBINOM_PMF_FN,
  POISSON_PMF_FN,
  SHADOWABLE_FNS,
  T_PDF_FN,
  WEIBULL_PDF_FN,
  builtinFn,
  evaluate,
  freeVars,
  ineqComparisons,
  normalcdf,
  normalpdf,
  parseExpr,
  substVars,
} from './expr.ts';
import { usesComplex } from './complex.ts';
import { type GetFn, RESERVED, type ResolveOpts, nameable, resolveExpr } from './defs.ts';
import { type BaseKind, DIST_FAMILIES, type DistFamily, distFamily, distUsage, familyOf } from './dist-families.ts';
import { quadrature } from './integrate.ts';
import {
  BETA_GAMMA_SIDE, BETA_LIMIT_SUM, GAMMA_UNIFORM_SHAPE, betaPQ, betaPdf, binomPmf, discreteUniformPmf, gammaPQ, gammaPdf, lbeta, lgamma,
  negBinomPmf, normalPQ, poissonPmf, studentTPQ, studentTPdf, weibullPdf, wholeNumber,
} from './specfn.ts';

// --- base distributions ---

export type { BaseKind };

/**
 * Argument meaning by kind — the conventions are the textbook ones, stated
 * because two of them are genuinely contested:
 *
 * - normal: [mean, sd]; uniform: [lo, hi]; exponential: [rate];
 * - gamma: [shape α, RATE β] (mean α/β — not scale; Exponential(λ) is Gamma(1, λ));
 * - beta: [a, b] on [0, 1]; chisquared: [df]; studentt: [df];
 * - lognormal: [mu, sigma] of the underlying normal, ln X ~ Normal(mu, sigma);
 * - cauchy: [location, scale]; weibull: [shape k, scale λ].
 *
 * The discrete laws (scipy's conventions, the contested two in capitals):
 *
 * - binomial: [n, p], n a whole number ≥ 0, 0 ≤ p ≤ 1 (p = 0, p = 1 and n = 0
 *   are atoms, not errors); bernoulli: [p] is Binomial(1, p);
 * - poisson: [mean] > 0 (Poisson(0) is refused like Exponential(0): a slider
 *   reaching 0 says so on the row);
 * - geometric: [p], 0 < p ≤ 1, the TRIAL of the first success — support 1, 2, …;
 * - negbinomial: [r, p], the FAILURES before the r-th success — support
 *   0, 1, …; r > 0 need not be whole. So NegativeBinomial(1, p) is Geometric(p) − 1;
 * - discreteuniform: [a, b], whole numbers a ≤ b, both included.
 */
export interface BaseDist {
  kind: BaseKind;
  args: Expr[];
  /** A law on the integers: it has a pmf (pmfExpr, stems), a step cdf whose
   *  strict and non-strict bounds differ, and no density for a shader. */
  discrete?: boolean;
}

/** `${name} = ${value}` for a message, short enough to read. */
const showParam = (name: string, val: number): string => `${name} = ${Number(val.toPrecision(6))}`;

/**
 * Why these parameter values declare no distribution, or null when they do.
 * `a[k]` may be undefined/NaN for a parameter not known yet (a slider at
 * parse time): only what is known is judged.
 */
export function paramProblem(kind: BaseKind, a: ReadonlyArray<number | null | undefined>): string | null {
  const family = familyOf(kind);
  for (const [k, param] of family.params.entries()) {
    const val = a[k];
    if (typeof val !== 'number' || Number.isNaN(val)) continue;
    const usage = distUsage(family);
    if (param.positive && val <= 0) return `${usage} needs ${param.name} > 0.`;
    if (param.whole && (Number.isNaN(wholeNumber(val)) || (param.whole === 'count' && val < 0))) {
      return `${usage} needs a whole number ${param.name}${param.whole === 'count' ? ' ≥ 0' : ''} (${showParam(param.name, val)}).`;
    }
    if (param.unit && !(val <= 1 && (param.unit === '[0,1]' ? val >= 0 : val > 0))) {
      return `${usage} needs ${param.unit === '[0,1]' ? '0 ≤' : '0 <'} ${param.name} ≤ 1.`;
    }
  }
  const both = typeof a[0] === 'number' && typeof a[1] === 'number';
  if (kind === 'uniform' && both && a[1]! <= a[0]!) return 'Uniform(lo, hi) needs lo < hi.';
  if (kind === 'discreteuniform' && both && a[1]! < a[0]!) return 'DiscreteUniform(a, b) needs a ≤ b.';
  return null;
}

const TILDE_RE = /^\s*([A-Za-z_]\w*)\s*~\s*([\s\S]+)$/;
const DIST_RE = /^\s*([A-Za-z_]\w*)\s*(?:\(([\s\S]*)\))?\s*$/;
const PROB_RE = /^\s*P\s*\(([\s\S]+)\)\s*$/;
const EXPECT_RE = /^\s*E\s*\(([\s\S]+)\)\s*$/;
const CONST_ROW_RE = /^\s*([A-Za-z_]\w*)\s*=(?!=)([\s\S]+)$/;

/** Detect a `name ~ rhs` row before parsing ('~' is not an expression token). */
export function scanDistribution(text: string): { name: string; rhs: string } | null {
  const m = TILDE_RE.exec(text);
  return m ? { name: m[1], rhs: m[2] } : null;
}

/**
 * Names (lib/dist-families.ts) are matched case-insensitively and live in
 * their own namespace, the right side of `~`, so they collide with nothing a
 * document defines: a constant T or a function gamma(x) leaves `X ~ T(5)` and
 * `X ~ Gamma(2, 1)` alone.
 */
const DIST_HINT = `Try ${DIST_FAMILIES.map((f, k, all) => (k === all.length - 1 ? 'or ' : '') + distUsage(f)).join(', ')}.`;

/** Parse the right side of `name ~ …`. Throws with a row-friendly message. */
export function parseDistribution(rhs: string, fnNames: ReadonlySet<string>): BaseDist {
  const m = DIST_RE.exec(rhs);
  const spec = m && distFamily(m[1]);
  if (!m || !spec) {
    throw new Error(m && !distFamily(m[1])
      ? `Unknown distribution: ${m[1]}. ${DIST_HINT}`
      : 'Expected a distribution like Normal(0, 1).');
  }
  const arity = spec.params.length;
  const arityError = `${distUsage(spec)} takes ${arity} argument${arity > 1 ? 's' : ''}.`;
  // A bare name takes the standard parameters: `X ~ N` is Normal(0, 1).
  if (m[2] === undefined) {
    if (!spec.defaults) throw new Error(arityError);
    return baseDist(spec, spec.defaults.map(value => ({ kind: 'num', value })));
  }
  let args: Expr;
  try {
    args = parseExpr(`(${m[2]})`, fnNames);
  } catch (e) {
    if (e instanceof Error && /vector components/.test(e.message)) throw new Error(arityError);
    throw e;
  }
  const items = args.kind === 'vec' ? args.items : [args];
  if (items.length !== arity) throw new Error(arityError);
  // Written-out numbers are judged now; a slider's value is judged when it is
  // known (RVSystem.paramProblem), and flattens the density to 0 meanwhile.
  const problem = paramProblem(spec.kind, items.map(numOf));
  if (problem) throw new Error(problem);
  return baseDist(spec, items);
}

const baseDist = (family: DistFamily, args: Expr[]): BaseDist =>
  (family.discrete ? { kind: family.kind, args, discrete: true } : { kind: family.kind, args });

const v = (name: string): Expr => ({ kind: 'var', name });
const num = (value: number): Expr => ({ kind: 'num', value });
const bin = (op: '+' | '-' | '*' | '/' | '^', a: Expr, b: Expr): Expr => ({ kind: 'bin', op, a, b });
const chain = (lo: Expr, mid: Expr, hi: Expr): Expr =>
  ({ kind: 'ineq', op: '<', l: { kind: 'ineq', op: '<', l: lo, r: mid }, r: hi });
const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const positive = (e: Expr): Expr => ({ kind: 'ineq', op: '>', l: e, r: num(0) });
/** `value` where every condition holds, 0 elsewhere (nested piecewise = AND). */
const whereAll = (conds: Expr[], value: Expr): Expr => conds.reduceRight<Expr>(
  (inner, cond) => ({ kind: 'piecewise', cases: [{ cond, value: inner }], otherwise: num(0) }),
  value,
);

/**
 * The pmf of a discrete law at `k`: P(X = k). Exactly 0 — not NaN — off the
 * support, at a k that is not a whole number, and while a parameter is
 * invalid, in every evaluator (evaluate and the stack VM share the specfn.ts
 * implementations; a shader refuses the builtins by name, since a pmf is
 * drawn as stems). Null for a continuous law.
 */
export function pmfExpr(d: BaseDist, k: Expr): Expr | null {
  switch (d.kind) {
    case 'binomial':
      return call(BINOM_PMF_FN, k, d.args[0], d.args[1]);
    case 'bernoulli':
      return call(BINOM_PMF_FN, k, num(1), d.args[0]);
    case 'poisson':
      return call(POISSON_PMF_FN, k, d.args[0]);
    case 'geometric': // trials, from 1: one more than the failures before the first success
      return call(NEGBINOM_PMF_FN, bin('-', k, num(1)), num(1), d.args[0]);
    case 'negbinomial':
      return call(NEGBINOM_PMF_FN, k, d.args[0], d.args[1]);
    case 'discreteuniform':
      return call(DUNIFORM_PMF_FN, k, d.args[0], d.args[1]);
    default:
      return null;
  }
}

/** The exact pdf of a base distribution at `x` (piecewise where the support
 *  ends). For a discrete law this is its pmf — a mass, 0 between the integers
 *  — which evaluates anywhere a pdf does but must never be handed to a shader
 *  as a curve (densityExpr and regionExpr refuse). */
export function pdfExpr(d: BaseDist, x: Expr): Expr {
  const pmf = pmfExpr(d, x);
  if (pmf) return pmf;
  switch (d.kind) {
    case 'normal':
      return { kind: 'call', name: 'normalpdf', args: [x, d.args[0], d.args[1]] };
    case 'uniform':
      // The condition is empty while hi <= lo (mid slider drag), so the pdf
      // degrades to 0 everywhere instead of going negative.
      return {
        kind: 'piecewise',
        cases: [{ cond: chain(d.args[0], x, d.args[1]), value: bin('/', num(1), bin('-', d.args[1], d.args[0])) }],
        otherwise: num(0),
      };
    case 'exponential': {
      // max(rate, 0): a non-positive rate flattens to 0 rather than blowing up.
      const r: Expr = { kind: 'call', name: 'max', args: [d.args[0], num(0)] };
      return {
        kind: 'piecewise',
        cases: [{
          cond: { kind: 'ineq', op: '>=', l: x, r: num(0) },
          value: bin('*', r, { kind: 'call', name: 'exp', args: [{ kind: 'neg', a: bin('*', r, x) }] }),
        }],
        otherwise: num(0),
      };
    }
    // The next four are builtins with a CPU and a GLSL twin (lib/specfn.ts,
    // eq_*pdf in lib/glsl.ts) rather than spelled-out formulas: x^(α−1)e^(−βx)/Γ(α)
    // written out overflows float32 from α ≈ 35, and a pole or a support edge
    // needs a branch a formula does not have. All are 0 — not NaN — outside
    // the support and while a parameter is invalid.
    case 'gamma':
      return call(GAMMA_PDF_FN, x, d.args[0], d.args[1]);
    case 'chisquared': // ChiSquared(k) is Gamma(k/2, rate 1/2)
      return call(GAMMA_PDF_FN, x, bin('/', d.args[0], num(2)), num(0.5));
    case 'beta':
      return call(BETA_PDF_FN, x, d.args[0], d.args[1]);
    case 'studentt':
      return call(T_PDF_FN, x, d.args[0]);
    case 'weibull':
      return call(WEIBULL_PDF_FN, x, d.args[0], d.args[1]);
    case 'lognormal':
      // normalpdf(ln x)/x on x > 0; the sigma > 0 guard flattens a bad slider.
      return whereAll([positive(d.args[1]), positive(x)],
        bin('/', call('normalpdf', call('ln', x), d.args[0], d.args[1]), x));
    case 'cauchy': {
      const z = bin('/', bin('-', x, d.args[0]), d.args[1]);
      return whereAll([positive(d.args[1])],
        bin('/', num(1), bin('*', bin('*', num(Math.PI), d.args[1]), bin('+', num(1), bin('*', z, z)))));
    }
    default:
      throw new Error(`${familyOf(d.kind).name} has no density.`); // discrete: answered by pmfExpr above
  }
}

const NO_DENSITY = 'A discrete distribution has no density curve: it draws as stems.';

/** The density curve for a base random variable: y = pdf(x). */
export function densityExpr(d: BaseDist): Expr {
  if (d.discrete) throw new Error(NO_DENSITY);
  return { kind: 'eq', l: v('y'), r: pdfExpr(d, v('x')) };
}

/** The readout of an `E(…)` row whose mean is not a number (RVSystem.meanUnstable). */
export const NO_MEAN_INFO = 'no stable mean (heavy tails)';

/** The inner text of a `P(…)` row, or null if the row has another shape. */
export function matchProbability(text: string): string | null {
  const m = PROB_RE.exec(text);
  return m ? m[1] : null;
}

/** The inner text of an `E(…)` row, or null if the row has another shape. */
export function matchExpectation(text: string): string | null {
  const m = EXPECT_RE.exec(text);
  return m ? m[1] : null;
}

// --- probability specs ---

/**
 * Constant bounds around one variable. Whether a bound is strict is kept
 * because a discrete law cares: P(X < 3) and P(X <= 3) differ by P(X = 3). (A
 * continuous law does not, and ignores the flags.)
 */
export interface ProbBounds {
  lo?: Expr;
  hi?: Expr;
  /** The bound is `<`/`>`, not `<=`/`>=`: its endpoint is excluded. */
  loStrict?: boolean;
  hiStrict?: boolean;
  /** A point event, `P(X = c)` (lo = hi = c, both included) or, with `not`,
   *  its complement `P(X != c)`. Only a discrete variable has these. */
  point?: boolean;
  not?: boolean;
}

export interface ProbSpec {
  /** The event to estimate, resolved: an inequality (chain), or the equation
   *  of a point event. */
  body: Expr;
  /** Random variables the body references. */
  rvs: string[];
  /**
   * Present when the body is constant bounds around one bare variable
   * (`P(a < X < b)`): the shadeable — and for closed-form laws, exact — case.
   */
  single?: { rv: string } & ProbBounds;
  /**
   * Bounds around one variable-bearing *expression* (`P(0.5 < X + Y < 1.5)`):
   * the same case once the caller registers the expression as an anonymous
   * derived variable.
   */
  inline?: { e: Expr } & ProbBounds;
}

/**
 * Apply `lower` (the caller's list lowering) to a parsed P(…) body. `==` and
 * `!=` are the filter comparisons, which list lowering rightly refuses outside
 * a filter — but at the top of a P(…) they are a point event, so there the
 * two sides lower on their own and the comparison is kept for toProbability.
 */
export function lowerProbBody(e: Expr, lower: (e: Expr) => Expr): Expr {
  if (e.kind === 'call' && (e.name === '[eq]' || e.name === '[ne]') && e.args.length === 2) {
    return { ...e, args: e.args.map(lower) };
  }
  return lower(e);
}

const POINT_SHAPE = 'P(… = …) takes a discrete random variable on its own, like P(X = 3).';

/** Interpret a parsed P(…) body against the declared random variables. */
export function toProbability(e: Expr, rvNames: ReadonlySet<string>): ProbSpec {
  // `=` parses as an equation, `==` and `!=` as the filter comparisons.
  const point = e.kind === 'eq' ? { l: e.l, r: e.r, not: false }
    : e.kind === 'call' && (e.name === '[eq]' || e.name === '[ne]') && e.args.length === 2
      ? { l: e.args[0], r: e.args[1], not: e.name === '[ne]' }
      : null;
  if (e.kind !== 'ineq' && !point) throw new Error('P(…) expects an inequality like P(X < 2).');
  const frees = freeVars(e);
  const rvs = [...frees].filter(n => rvNames.has(n));
  if (!rvs.length) {
    throw new Error('P(…) must reference a random variable, e.g. X ~ Normal(0, 1) then P(X < 2).');
  }
  for (const n of frees) {
    if (/^[xyzuvw]$/.test(n)) throw new Error(`P(…) cannot use the plot coordinate ${n}.`);
  }
  const bearing = (t: Expr): boolean => [...freeVars(t)].some(n => rvNames.has(n));
  if (point) {
    const [name, at] = point.l.kind === 'var' && rvNames.has(point.l.name) ? [point.l.name, point.r]
      : point.r.kind === 'var' && rvNames.has(point.r.name) ? [point.r.name, point.l] : [null, null];
    if (name === null || bearing(at) || at.kind === 'vec' || at.kind === 'ineq' || at.kind === 'eq') throw new Error(POINT_SHAPE);
    return { body: e, rvs, single: { rv: name, lo: at, hi: at, point: true, ...(point.not ? { not: true } : {}) } };
  }
  const comps = ineqComparisons(e as Expr & { kind: 'ineq' });
  if (new Set(comps.map(c => c.op[0])).size > 1) {
    throw new Error('Chained inequalities must point the same way.');
  }
  // Normalize to ascending order so the terms read lo … X … hi; each
  // comparison keeps whether it was strict.
  const asc = comps.map(c => ({ ...(c.op[0] === '<' ? { l: c.l, r: c.r } : { l: c.r, r: c.l }), strict: c.op.length === 1 }));
  if (comps[0].op[0] === '>') asc.reverse();
  const terms = [asc[0].l, ...asc.map(c => c.r)];
  const spec: ProbSpec = { body: e, rvs };

  // `lo < … < hi` with exactly one variable-bearing term and variable-free
  // bounds on its immediate sides shades (and computes exactly when a law is
  // derivable): a bare name yields `single`, an expression `inline`. Anything
  // else — P(Y > X), extra constraints beyond the bounds — samples.
  const idx = terms.findIndex(bearing);
  const others = terms.filter((_, k) => k !== idx);
  if (idx >= 0 && terms.length <= 3 && idx <= 1 && idx >= terms.length - 2 && !others.some(bearing)) {
    const t = terms[idx];
    const bounds: ProbBounds = {};
    if (idx > 0) {
      bounds.lo = terms[idx - 1];
      bounds.loStrict = asc[idx - 1].strict;
    }
    if (idx < terms.length - 1) {
      bounds.hi = terms[idx + 1];
      bounds.hiStrict = asc[idx].strict;
    }
    if (t.kind === 'var' && rvNames.has(t.name)) spec.single = { rv: t.name, ...bounds };
    else spec.inline = { e: t, ...bounds };
  }
  return spec;
}

export interface ExpectSpec {
  /** The scalar expression to average, resolved. */
  body: Expr;
  /** Random variables the body references. */
  rvs: string[];
}

/** Interpret a parsed E(…) body against the declared random variables. */
export function toExpectation(e: Expr, rvNames: ReadonlySet<string>): ExpectSpec {
  if (e.kind === 'ineq') {
    throw new Error('E(…) expects a value like E(X + Y); the chance of an event is P(…).');
  }
  if (e.kind === 'eq' || e.kind === 'vec' || e.kind === 'list') {
    throw new Error('E(…) expects a single value, like E(X + Y).');
  }
  const frees = freeVars(e);
  const rvs = [...frees].filter(n => rvNames.has(n));
  if (!rvs.length) {
    throw new Error('E(…) must reference a random variable, e.g. X ~ Normal(0, 1) then E(X).');
  }
  for (const n of frees) {
    if (/^[xyzuvw]$/.test(n)) throw new Error(`E(…) cannot use the plot coordinate ${n}.`);
  }
  return { body: e, rvs };
}

/**
 * The shaded region for an exact probability: the area between the x-axis and
 * the density, clipped to the bounds. Each part is normalized to F < 0 and
 * combined with max() (intersection), the same shape classify() produces for
 * inequality chains; '<=' gives the region a drawn outline.
 */
export function regionExpr(d: BaseDist, lo?: Expr, hi?: Expr): Expr {
  if (d.discrete) throw new Error(NO_DENSITY);
  const x = v('x');
  const y = v('y');
  let f: Expr = bin('-', y, pdfExpr(d, x)); // y < pdf(x)
  const parts: Expr[] = [{ kind: 'neg', a: y }]; // 0 < y
  if (lo) parts.push(bin('-', lo, x)); // lo < x
  if (hi) parts.push(bin('-', x, hi)); // x < hi
  for (const part of parts) f = { kind: 'call', name: 'max', args: [f, part] };
  return { kind: 'ineq', op: '<=', l: f, r: num(0) };
}

/**
 * Exact [P(X ≤ x), P(X > x)] of a base distribution; NaN while the parameters
 * are invalid. Both tails, each computed on its own side where the law allows
 * it: a survival probability read as 1 − cdf is 0 from the point the cdf
 * rounds to 1, long before the tail itself underflows.
 */
function cdfPQ(d: BaseDist, x: number, env: Record<string, number>): [number, number] {
  const a = d.args.map(e => evaluate(e, env));
  if (Number.isNaN(x) || !a.every(isFinite) || paramProblem(d.kind, a)) return [NaN, NaN];
  switch (d.kind) {
    case 'normal':
      // The mirror image is the upper tail (normalcdf is the shader's erf twin).
      return [normalcdf(x, a[0], a[1]), normalcdf(2 * a[0] - x, a[0], a[1])];
    case 'uniform': {
      const p = Math.min(1, Math.max(0, (x - a[0]) / (a[1] - a[0])));
      return [p, 1 - p];
    }
    case 'exponential':
      return x <= 0 ? [0, 1] : [-Math.expm1(-a[0] * x), Math.exp(-a[0] * x)];
    case 'gamma':
      return gammaPQ(a[0], a[1] * x);
    case 'chisquared':
      return gammaPQ(a[0] / 2, x / 2);
    case 'beta':
      return betaPQ(a[0], a[1], x);
    case 'studentt':
      return studentTPQ(a[0], x);
    case 'lognormal':
      return x <= 0 ? [0, 1] : normalPQ((Math.log(x) - a[0]) / a[1]);
    case 'cauchy': {
      // atan(1/z) is the tail itself; ½ − atan(z)/π would cancel it away.
      const z = (x - a[0]) / a[1];
      if (z === 0) return [0.5, 0.5];
      const tail = Math.atan(1 / Math.abs(z)) / Math.PI;
      return z > 0 ? [1 - tail, tail] : [tail, 1 - tail];
    }
    case 'weibull': {
      if (x <= 0) return [0, 1];
      const w = Math.pow(x / a[1], a[0]);
      return [-Math.expm1(-w), Math.exp(-w)];
    }
    default:
      return discretePQ(d.kind, a, x);
  }
}

/**
 * [P(X ≤ x), P(X > x)] of a discrete law with valid parameters `a`: a step
 * function, so x is floored first. Closed forms through the regularized
 * incomplete beta and gamma functions — both tails formed directly, and no
 * sum over thousands of terms for Binomial(1e6, p) or Poisson(1e5).
 */
function discretePQ(kind: BaseKind, a: number[], x: number): [number, number] {
  const k = Math.floor(x);
  const binomial = (n: number, p: number): [number, number] => {
    if (k < 0) return [0, 1];
    if (k >= n) return [1, 0];
    return betaPQ(n - k, k + 1, 1 - p, p); // P(X ≤ k) = I_{1−p}(n − k, k + 1); p = 0 and 1 land on its edges
  };
  switch (kind) {
    case 'binomial':
      return binomial(wholeNumber(a[0]), a[1]);
    case 'bernoulli':
      return binomial(1, a[0]);
    case 'poisson': {
      if (k < 0) return [0, 1];
      const [p, q] = gammaPQ(k + 1, a[0]); // P(X ≤ k) = Q(k + 1, mean)
      return [q, p];
    }
    case 'geometric': {
      if (k < 1) return [0, 1];
      const lq = k * Math.log1p(-a[0]); // ln P(X > k) = k ln(1 − p); −∞ at p = 1
      return [-Math.expm1(lq), Math.exp(lq)];
    }
    case 'negbinomial':
      return k < 0 ? [0, 1] : betaPQ(a[0], k + 1, a[1], 1 - a[1]); // I_p(r, k + 1)
    case 'discreteuniform': {
      const lo = wholeNumber(a[0]);
      const hi = wholeNumber(a[1]);
      if (k < lo) return [0, 1];
      if (k >= hi) return [1, 0];
      const n = hi - lo + 1;
      return [(k - lo + 1) / n, (hi - k) / n];
    }
    default:
      return [NaN, NaN];
  }
}

/** The whole numbers a P(…) over a discrete variable selects: kLo ≤ X ≤ kHi
 *  (either may be infinite; empty when kLo > kHi), or with `not` all the rest.
 *  This is where strictness lands: `X < 3` ends at 2, `X <= 3` at 3,
 *  `X < 2.5` and `X <= 2.5` both at 2. NaN bounds (a broken parameter) stay NaN. */
export function integerBounds(b: ProbBounds, env: Record<string, number>): { kLo: number; kHi: number; not: boolean } {
  const lo = b.lo ? evaluate(b.lo, env) : -Infinity;
  const hi = b.hi ? evaluate(b.hi, env) : Infinity;
  return {
    kLo: b.loStrict ? Math.floor(lo) + 1 : Math.ceil(lo),
    kHi: b.hiStrict ? Math.ceil(hi) - 1 : Math.floor(hi),
    not: !!b.not,
  };
}

/**
 * Exact value of P(lo < X < hi) under the given constant environment. For a
 * discrete law `edges` says which bounds are strict (and whether the event is
 * a complement): the value is the exact mass of the selected whole numbers.
 */
export function probabilityValue(
  d: BaseDist,
  lo: Expr | undefined,
  hi: Expr | undefined,
  env: Record<string, number>,
  edges?: Pick<ProbBounds, 'loStrict' | 'hiStrict' | 'not'>,
): number {
  if (d.discrete) {
    const law = discreteLaw(d, env);
    const { kLo, kHi, not } = integerBounds({ lo, hi, ...edges }, env);
    if (!law || Number.isNaN(kLo) || Number.isNaN(kHi)) return NaN; // invalid parameters or bounds
    if (kLo > kHi) return not ? 1 : 0;
    // One whole number: its mass, not a difference of two cdfs.
    if (kLo === kHi && !not) return law.pmf(kLo);
    const L = kLo === -Infinity ? [0, 1] : law.pq(kLo - 1);
    const H = kHi === Infinity ? [1, 0] : law.pq(kHi);
    // The complement is below kLo plus above kHi, each from its own tail;
    // the event itself differences whichever side is the small one.
    if (not) return L[0] + H[1];
    return L[0] > 0.5 ? L[1] - H[1] : H[0] - L[0];
  }
  const L = lo ? cdfPQ(d, evaluate(lo, env), env) : null;
  const H = hi ? cdfPQ(d, evaluate(hi, env), env) : null;
  if (!L) return H ? H[0] : 1;
  if (!H) return L[1];
  // Both bounds in the upper half: difference the (small) survival values.
  return L[0] > 0.5 ? L[1] - H[1] : H[0] - L[0];
}

// --- row scanning ---

/**
 * Decide which rows declare random variables, before definitions are built.
 * `base` rows are `name ~ …`; `derived` rows are `name = rhs` where the rhs
 * mentions a random variable (transitively — `Z = Y + 1` follows `Y = X^2`
 * into the set). Rows the caller has already claimed (comments, sequences)
 * arrive as null. Matching is textual by design — it must run before parsing,
 * because these rows must *not* become constant definitions — but it follows
 * the tokenizer's identifier rule (a maximal run starting with a letter), so
 * `2X` mentions X while `aX`, `X_1`, and `X2` are their own names. A \b-style
 * word boundary would get `2X` wrong: 2 and X are both word characters.
 */
export function scanRandomRows(texts: readonly (string | null)[]): {
  base: Map<number, { name: string; rhs: string }>;
  derived: Map<number, { name: string; rhs: string }>;
} {
  const base = new Map<number, { name: string; rhs: string }>();
  const derived = new Map<number, { name: string; rhs: string }>();
  const names = new Set<string>();
  const candidates = new Map<number, { name: string; rhs: string }>();
  texts.forEach((text, i) => {
    if (!text) return;
    const scan = scanDistribution(text);
    if (scan) {
      base.set(i, scan);
      names.add(scan.name);
      return;
    }
    const m = CONST_ROW_RE.exec(text);
    // The name must be claimable as a definition (`e = X` stays an equation).
    if (m && nameable(m[1])) {
      candidates.set(i, { name: m[1], rhs: m[2] });
    }
  });
  let changed = names.size > 0;
  while (changed) {
    changed = false;
    for (const [i, c] of candidates) {
      if (!(c.rhs.match(/[A-Za-z_]\w*/g) ?? []).some(t => names.has(t))) continue;
      candidates.delete(i);
      derived.set(i, c);
      names.add(c.name);
      changed = true;
    }
  }
  return { base, derived };
}

/**
 * Validate a resolved right-hand side as a derived random variable: a real
 * scalar in random variables, constants, and t.
 */
export function checkDerived(e: Expr, rvNames: ReadonlySet<string>, constNames: ReadonlySet<string>): void {
  if (e.kind === 'eq' || e.kind === 'ineq' || e.kind === 'vec' || e.kind === 'list') {
    throw new Error('A random variable must be a single value.');
  }
  if (usesComplex(e)) throw new Error('Random variables are real-valued.');
  for (const n of freeVars(e)) {
    if (rvNames.has(n) || constNames.has(n) || n === 't') continue;
    if (/^[xyzuv]$/.test(n)) {
      throw new Error(`A random variable cannot depend on the plot coordinate ${n}.`);
    }
    throw new Error(`${n} is not defined.`);
  }
}

// --- the sampled system ---

/** Joint sample count. Stratified streams keep marginals exact at any size;
 *  this is set by when the *derived-density* estimate looks smooth (KDE noise
 *  ~ 1/√(N·h), visible as low-frequency wobble on zoomed-in curves) while a
 *  slider drag can still resample every affected variable within a frame. */
export const SAMPLE_COUNT = 1 << 17;

export type RV =
  | { name: string; kind: 'base'; dist: BaseDist }
  | { name: string; kind: 'derived'; expr: Expr };

export interface DensityCurve {
  /** Flat [x0, y0, x1, y1, …] polyline of the continuous part's density
   *  (empty when the distribution is purely discrete). */
  pts: number[];
  /** Point masses (a piecewise branch, floor, a constant): drawn as stems of
   *  height = probability, never smeared into the density. */
  atoms?: Array<{ x: number; p: number }>;
  mean: number;
  sd: number;
  /** Fraction of samples that are finite (< 1 for partial support like sqrt(X)). */
  mass: number;
  /** Present when the tails are heavy enough that mean/sd are truncation
   *  artifacts (a 1% trim collapses the spread severalfold — 1/W through a
   *  pole has no finite moments at all): robust location/spread for the
   *  readout to show instead. `meanOk` marks the milder case — the spread is
   *  unstable but the tails are lighter than 1/x, so the mean exists (a
   *  shifted StudentT(2), a product of log-normals) — and an E(…) row may
   *  still print its number. */
  robust?: Robust;
}

/** 0 — every base law has a variance; 1 — some base has none but has a mean
 *  (StudentT, 1 < df ≤ 2); 2 — some base has no mean (Cauchy, StudentT df ≤ 1). */
type HeavyBase = 0 | 1 | 2;

export interface Robust { median: number; iqr: number; meanOk: boolean }


const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const mulberry32 = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let z = seed;
  z = Math.imul(z ^ (z >>> 15), z | 1);
  z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
  return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
};

/**
 * The stratified standard-uniform stream for a variable name: quantile
 * midpoints (i + ½)/N shuffled by a permutation seeded from the name and
 * the current sample salt. Marginals are exact at any salt; the salt only
 * redraws the *pairing* between variables — the Monte Carlo part. Streams
 * are memoized per name and refilled in place when the salt has moved on,
 * so resampling every frame allocates nothing.
 */
let streamSalt = 0;
const streams = new Map<string, { salt: number; u: Float64Array }>();
function uniformStream(name: string): Float64Array {
  let s = streams.get(name);
  if (s && s.salt === streamSalt) return s.u;
  if (!s) {
    s = { salt: streamSalt, u: new Float64Array(SAMPLE_COUNT) };
    streams.set(name, s);
  }
  const u = s.u;
  for (let i = 0; i < SAMPLE_COUNT; i++) u[i] = (i + 0.5) / SAMPLE_COUNT;
  const rand = mulberry32(fnv1a(name) ^ streamSalt);
  for (let i = SAMPLE_COUNT - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = u[i];
    u[i] = u[j];
    u[j] = t;
  }
  s.salt = streamSalt;
  return u;
}

/** Acklam's rational approximation to the standard normal quantile (~1e-9). */
function normalQuantile(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  if (p <= 0 || p >= 1) return NaN;
  if (p < plow || p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(p < plow ? p : 1 - p));
    const x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    return p < plow ? x : -x;
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Evaluate an expression column-wise over the sample vectors. Inequalities
 *  yield 1/0 masks (NaN where an operand is NaN), matching evaluate(). */
function evalCols(
  e: Expr,
  cols: ReadonlyMap<string, Float64Array>,
  env: Record<string, number>,
  n: number,
): Float64Array {
  const alloc = () => new Float64Array(n);
  switch (e.kind) {
    case 'num': {
      const out = alloc();
      out.fill(e.value);
      return out;
    }
    case 'var': {
      const col = cols.get(e.name);
      if (col) return col;
      if (!(e.name in env)) throw new Error(`Unbound variable: ${e.name}`);
      const out = alloc();
      out.fill(env[e.name]);
      return out;
    }
    case 'neg': {
      const a = evalCols(e.a, cols, env, n);
      const out = alloc();
      for (let i = 0; i < n; i++) out[i] = -a[i];
      return out;
    }
    case 'bin': {
      const a = evalCols(e.a, cols, env, n);
      const b = evalCols(e.b, cols, env, n);
      const out = alloc();
      switch (e.op) {
        case '+': for (let i = 0; i < n; i++) out[i] = a[i] + b[i]; break;
        case '-': for (let i = 0; i < n; i++) out[i] = a[i] - b[i]; break;
        case '*': for (let i = 0; i < n; i++) out[i] = a[i] * b[i]; break;
        case '/': for (let i = 0; i < n; i++) out[i] = a[i] / b[i]; break;
        case '^': for (let i = 0; i < n; i++) out[i] = Math.pow(a[i], b[i]); break;
      }
      return out;
    }
    case 'call': {
      const fn = EVAL_FNS[e.name];
      if (!fn) throw new Error(`Unknown function: ${e.name}`);
      const args = e.args.map(a => evalCols(a, cols, env, n));
      const out = alloc();
      if (args.length === 1) {
        const a = args[0];
        for (let i = 0; i < n; i++) out[i] = fn(a[i]);
      } else if (args.length === 2) {
        const [a, b] = args;
        for (let i = 0; i < n; i++) out[i] = fn(a[i], b[i]);
      } else {
        for (let i = 0; i < n; i++) out[i] = fn(...args.map(a => a[i]));
      }
      return out;
    }
    case 'eq': {
      const l = evalCols(e.l, cols, env, n);
      const r = evalCols(e.r, cols, env, n);
      const out = alloc();
      for (let i = 0; i < n; i++) out[i] = l[i] - r[i];
      return out;
    }
    case 'ineq': {
      const out = alloc();
      out.fill(1);
      for (const { op, l, r } of ineqComparisons(e)) {
        const a = evalCols(l, cols, env, n);
        const b = evalCols(r, cols, env, n);
        for (let i = 0; i < n; i++) {
          if (Number.isNaN(out[i])) continue;
          if (Number.isNaN(a[i]) || Number.isNaN(b[i])) out[i] = NaN;
          else if (!(op === '<' ? a[i] < b[i] : op === '<=' ? a[i] <= b[i]
            : op === '>' ? a[i] > b[i] : a[i] >= b[i])) out[i] = 0;
        }
      }
      return out;
    }
    case 'piecewise': {
      const out = alloc();
      out.fill(NaN);
      const taken = new Uint8Array(n);
      for (const c of e.cases) {
        const mask = evalCols(c.cond, cols, env, n);
        const val = evalCols(c.value, cols, env, n);
        for (let i = 0; i < n; i++) {
          if (!taken[i] && mask[i] === 1) {
            out[i] = val[i];
            taken[i] = 1;
          }
        }
      }
      if (e.otherwise) {
        const val = evalCols(e.otherwise, cols, env, n);
        for (let i = 0; i < n; i++) if (!taken[i]) out[i] = val[i];
      }
      return out;
    }
    case 'vec': throw new Error('Vector in scalar context.');
    case 'list':
    case 'data': throw new Error('List in scalar context.');
    case 'str':
    case 'text': throw new Error('Text has no numeric value.');
  }
}

/** Estimate a density curve from samples: point masses split off as atoms,
 *  the continuous remainder as a binned kernel density estimate (Silverman
 *  bandwidth over a robust spread) whose area equals its share of the
 *  finite-sample mass. Null when nothing is finite. */
/**
 * Clip a drawn window to where the density is visually present: iterate a
 * coarse-histogram zoom over a value pool, trimming end bins below ~1/256
 * of the peak bin — sub-pixel at plot scale. Without this, heavy tails
 * (anything through a pole, like 1/(1+X) for normal X) stretch a
 * fixed-quantile window by orders of magnitude and starve the peak of grid
 * resolution. Light-tailed pools trim nothing: their peak-to-tail ratio
 * never clears the threshold.
 */
function visualWindow(pool: ArrayLike<number>, lo0: number, hi0: number): [number, number] {
  let wlo = lo0;
  let whi = hi0;
  const NB = 256;
  const counts = new Float64Array(NB);
  for (let iter = 0; iter < 4; iter++) {
    const bw = (whi - wlo) / NB;
    if (!(bw > 0)) break;
    counts.fill(0);
    for (let i = 0; i < pool.length; i++) {
      const v = pool[i];
      if (v >= wlo && v <= whi) counts[Math.min(NB - 1, Math.floor((v - wlo) / bw))]++;
    }
    let peak = 0;
    for (let b = 0; b < NB; b++) peak = Math.max(peak, counts[b]);
    const thresh = peak / NB;
    if (thresh <= 1) break; // no dominant peak: the pool is already balanced
    let a = 0;
    while (a < NB && counts[a] < thresh) a++;
    let b = NB - 1;
    while (b >= 0 && counts[b] < thresh) b--;
    if (b < a) break;
    const nlo = wlo + a * bw;
    const nhi = wlo + (b + 1) * bw;
    // Zoom only on a genuine scale problem — the trim would collapse the
    // window several-fold. A modest proposed trim means the tails carry
    // honest visible mass (a singular peak over a light tail proposes one
    // every round); keep them and stop, or iteration would compound
    // sub-threshold trims into a real bite of probability.
    if (nhi - nlo > 0.25 * (whi - wlo)) break;
    wlo = nlo;
    whi = nhi;
  }
  return [wlo, whi];
}

function estimateCurve(col: Float64Array, heavy: HeavyBase = 0): DensityCurve | null {
  let finite: number[] = [];
  let sum = 0;
  for (let i = 0; i < col.length; i++) {
    const x = col[i];
    if (isFinite(x)) {
      finite.push(x);
      sum += x;
    }
  }
  const n = finite.length;
  if (n < 16) return null;
  const mean = sum / n;
  let ss = 0;
  for (const x of finite) ss += (x - mean) * (x - mean);
  const sd = Math.sqrt(ss / n);
  const mass = n / col.length;
  // Whether the moments are trustworthy is a question about the WHOLE law, so
  // it is asked of the same population `sd` was computed from — before the
  // atom filter below narrows `finite` to the continuous remainder. Asked of
  // that remainder instead, a distant atom reads as a collapsed tail: bounded
  // {X > 0.5: 100, X} has an exact σ, yet would be reported unstable, with the
  // median of its continuous branch standing in for the law's.
  const robust = robustIfUnstable(decimate(finite), sd, heavy);

  // Atoms: exactly repeated values are point masses — a piecewise branch, a
  // floor, a constant — and smearing them into KDE bumps would read as
  // continuous spread. Stratified streams make continuous values distinct, so
  // a duplicate probe over a prefix keeps that common case on the fast path.
  let atoms: Array<{ x: number; p: number }> | undefined;
  const probe = new Set<number>();
  for (let i = 0; i < Math.min(n, 4096); i++) probe.add(finite[i]);
  if (probe.size < Math.min(n, 4096)) {
    const counts = new Map<number, number>();
    for (const x of finite) counts.set(x, (counts.get(x) ?? 0) + 1);
    const minAtom = Math.max(8, col.length * 0.002);
    const atomValues = new Set<number>();
    for (const [x, count] of counts) {
      if (count >= minAtom) {
        atomValues.add(x);
        (atoms ??= []).push({ x, p: count / col.length });
      }
    }
    if (atoms) {
      atoms.sort((a, b) => a.x - b.x);
      finite = finite.filter(x => !atomValues.has(x));
    }
  }
  if (finite.length < 16) return { pts: [], atoms, mean, sd, mass, robust }; // purely discrete
  // The continuous part's own count and spread size the estimate below.
  const cn = finite.length;
  // Quantiles from a decimated sort: plenty for a range and bandwidth.
  const sub = Float64Array.from(finite.filter((_, i) => i % Math.ceil(cn / 4096) === 0)).sort();
  const q = quantileOf(sub);
  const spread = Math.min(sd, (q(0.75) - q(0.25)) / 1.349);
  if (!(spread > 0)) return { pts: [], atoms, mean, sd, mass, robust }; // no continuous spread
  // 1.4× Silverman's rule. His 0.9 factor is MISE-optimal for i.i.d. draws;
  // measured on these stratified columns, ~1.4× lowers BOTH the sup-error and
  // the curve's residual wobble (second-difference energy ÷2.4) — smoothness
  // is what the plotted line is judged by.
  const h = 1.26 * spread * Math.pow(cn, -0.2);
  // Drawn range: trim the extreme tails, but never past the observed support.
  // An end the trim does not reach is the support edge itself — beyond it the
  // density is truly zero, so a truncated variable like {X > 1: X, 0} has to
  // cut off straight at 1 rather than ramp up to a rounded peak past it.
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const x of finite) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  const [wlo, whi] = visualWindow(sub, x0, x1);
  let lo = Math.max(q(0.005), wlo) - 3 * h;
  let hi = Math.min(q(0.995), whi) + 3 * h;
  const hardLo = lo <= x0;
  const hardHi = hi >= x1;
  if (hardLo) lo = x0;
  if (hardHi) hi = x1;
  const B = 512;
  const dx = (hi - lo) / B;
  const hist = new Float64Array(B + 1);
  const w = 1 / (col.length * dx);
  let inWindow = 0;
  for (const x of finite) {
    // Linear binning: split each sample between its two neighboring grid
    // points, so the histogram carries no half-bin jitter into the curve.
    const k = (x - lo) / dx;
    const k0 = Math.floor(k);
    if (k0 < 0 || k0 >= B) continue;
    const f = k - k0;
    hist[k0] += w * (1 - f);
    hist[k0 + 1] += w * f;
    inWindow++;
  }
  inWindow /= col.length;
  // A grid point holds the density there, but the ones on a support edge
  // collect from one side only — half a cell — so they read half the density.
  if (hardLo) hist[0] *= 2;
  if (hardHi) hist[B] *= 2;
  // Gaussian smoothing of the histogram — the binned KDE.
  const r = Math.min(256, Math.ceil((3 * h) / dx));
  const kernel = new Float64Array(2 * r + 1);
  let ksum = 0;
  for (let k = -r; k <= r; k++) ksum += kernel[k + r] = Math.exp(-0.5 * ((k * dx) / h) ** 2);
  for (let k = 0; k <= 2 * r; k++) kernel[k] /= ksum;
  // Boundary correction, needed only where the support ends. Straight
  // truncation would halve the estimate at the edge (half the kernel hangs
  // outside) and renormalizing alone still sags wherever the density is
  // sloped, so fit a local *line* instead of a local mean: with kernel
  // moments a₀,a₁,a₂ over the part of the window inside the support,
  // f̂ = (a₂S₀ − a₁S₁)/(a₀a₂ − a₁²), which reproduces any linear density
  // exactly. In the interior a₁ = 0 and a₀ = 1, so this is the plain KDE.
  const hard = hardLo || hardHi;
  const P0 = new Float64Array(2 * r + 2);
  const P1 = new Float64Array(2 * r + 2);
  const P2 = new Float64Array(2 * r + 2);
  if (hard) {
    for (let m = 0; m <= 2 * r; m++) {
      const d = (m - r) * dx;
      P0[m + 1] = P0[m] + kernel[m];
      P1[m + 1] = P1[m] + kernel[m] * d;
      P2[m + 1] = P2[m] + kernel[m] * d * d;
    }
  }
  const pts: number[] = [];
  if (hardLo) pts.push(lo, 0); // the jump itself: a vertical at the edge
  for (let j = 0; j <= B; j++) {
    let s0 = 0;
    let s1 = 0;
    const k0 = Math.max(0, j - r);
    const k1 = Math.min(B, j + r);
    for (let k = k0; k <= k1; k++) {
      const wk = hist[k] * kernel[j - k + r];
      s0 += wk;
      if (hard) s1 += wk * (j - k) * dx;
    }
    let y = s0;
    if (hard) {
      // Clip the moment window only at the ends that are real support edges;
      // a merely trimmed tail keeps the full window (its data continues).
      const mlo = hardHi ? Math.max(0, j + r - B) : 0;
      const mhi = hardLo ? Math.min(2 * r, j + r) : 2 * r;
      const a0 = P0[mhi + 1] - P0[mlo];
      const a1 = P1[mhi + 1] - P1[mlo];
      const a2 = P2[mhi + 1] - P2[mlo];
      const den = a0 * a2 - a1 * a1;
      // Local linear can undershoot below zero where samples are sparse;
      // there, fall back to the renormalized mean, which cannot.
      const ll = den > 0 ? (a2 * s0 - a1 * s1) / den : -1;
      y = ll > 0 ? ll : (a0 > 0.05 ? s0 / a0 : s0);
    }
    pts.push(lo + j * dx, y);
  }
  if (hardHi) pts.push(hi, 0);
  // The curve's area is the probability of the drawn range — the promise a
  // density plot makes. Smoothing and the edge corrections each perturb it a
  // little (and at an integrable singularity, where no local polynomial fit
  // is meaningful, by more), so restore it exactly.
  let area = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    area += ((pts[i + 1] + pts[i + 3]) / 2) * (pts[i + 2] - pts[i]);
  }
  if (area > 0) {
    const k = inWindow / area;
    for (let i = 1; i < pts.length; i += 2) pts[i] *= k;
  }
  return { pts, atoms, mean, sd, mass, robust };
}

/** Quantiles of an already-sorted pool, by nearest rank. */
const quantileOf = (sorted: ArrayLike<number>) => (p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/** A sorted sample of at most ~4096 values: plenty for quantiles, and cheap
 *  enough to take of a full sample column. */
function decimate(xs: ArrayLike<number>): Float64Array {
  const step = Math.ceil(xs.length / 4096);
  const out = new Float64Array(Math.ceil(xs.length / step));
  for (let i = 0, j = 0; i < xs.length; i += step) out[j++] = xs[i];
  return out.sort();
}

/** Robust location/spread when the moments are truncation artifacts: a 1%
 *  trim collapsing the spread severalfold means the tails own the second
 *  moment (or it does not exist at all). Undefined while moments are sound.
 *  The pool must be the whole law, atoms included — the same population `sd`
 *  came from — or a distant atom reads as a tail that trimming collapsed. */
function robustIfUnstable(
  sortedPool: ArrayLike<number>,
  sd: number,
  heavy: HeavyBase = 0,
  tailPool?: () => ArrayLike<number>,
): Robust | undefined {
  const q = quantileOf(sortedPool);
  const tlo = q(0.005);
  const thi = q(0.995);
  let n = 0;
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < sortedPool.length; i++) {
    const v = sortedPool[i];
    if (v >= tlo && v <= thi) {
      n++;
      s += v;
      s2 += v * v;
    }
  }
  if (!n) return undefined;
  const m = s / n;
  const sdTrim = Math.sqrt(Math.max(s2 / n - m * m, 0));
  // A trimmed spread of zero is a law concentrated on one value with rare
  // company (a two-point discrete law, say) — finite moments, nothing to
  // stabilize, and the ratio below would call every one of them unstable.
  if (!(sdTrim > 0)) return undefined;
  // Whether the MEAN exists is its own question, asked of the tails and of
  // nothing else: it does exactly when both decay faster than 1/x (tail index
  // above 1). Not of the base laws — X² + Y over StudentT(2) has a base with a
  // mean and none itself — and not of the σ collapse, which a product of
  // log-normals or √|Cauchy| shows while having a perfectly good mean.
  const collapsed = sd > 3 * sdTrim;
  if (!collapsed && !heavy) return undefined;
  // The tails are read off `tailPool` where the caller has a better one: the
  // two-variable tensor grid resolves a pole-driven tail (X/Y) only down to
  // its innermost node, and flattens the outer 2% the index is measured on.
  const tails = tailPool?.() ?? sortedPool;
  const up = hillIndex(tails, q(0.5), 1);
  const down = hillIndex(tails, q(0.5), -1);
  // A mean is reported only when the index clears its bar by two standard
  // errors (Hill's se is index/√k: 8% on an 8192 pool, 5.5% on the tail
  // pool). The bar is 1 — and 1.4 when a base law has no mean at all: there
  // the analytic knowledge leads, and only a transform that visibly tames
  // the tail (atan X, |X|^¼; not X·Z + Z, whose index IS 1 and estimates
  // anywhere in 0.9–1.1) earns a mean. The price, accepted: a mean that
  // exists only just — StudentT(1.05), |Cauchy|^0.8 — reads as unstable.
  const bar = heavy === 2 ? NO_MEAN_BASE_INDEX : 1;
  const robust: Robust = {
    median: q(0.5),
    iqr: q(0.75) - q(0.25),
    meanOk: Math.min(up.index * (1 - 2 / Math.sqrt(up.k)), down.index * (1 - 2 / Math.sqrt(down.k))) > bar,
  };
  if (collapsed) return robust;
  // Under a base law KNOWN to have no variance the bar is far lower. The
  // 3× collapse above only catches tails as wild as a Cauchy's: X + 1 over
  // StudentT(2) has σ = ∞, yet its grid σ (≈ 3, growing like √ln N) survives
  // that test and would print as a confident finite number. The question is
  // whether the transform let the tail through (X + 1, X + Z, √|X| of a
  // Cauchy) or tamed it (sin X, ln|X|, |X|^0.3), and the tail index answers
  // it: a variance exists only above index 2.
  return heavy && Math.min(up.index, down.index) < HEAVY_INDEX ? robust : undefined;
}

/** The tail index a variable built on a no-mean base (Cauchy, StudentT with
 *  df ≤ 1) must clear, two standard errors included, before it reports a mean. */
const NO_MEAN_BASE_INDEX = 1.4;

/** Below this estimated tail index a law fed by an infinite-variance base is
 *  reported by median/IQR. The boundary is 2; the margin covers the Hill
 *  estimate's bias, at the price of calling an index-2.2 law unstable too. */
const HEAVY_INDEX = 2.25;

/** Hill's estimate of the tail index on one side (`side` ±1) of a sorted
 *  pool, from the outer 2% (k points) measured off `centre`: the mean
 *  log-excess over the threshold is 1/index for a power tail, and ~0 (index →
 *  ∞) for a bounded or exponential one. */
function hillIndex(sortedPool: ArrayLike<number>, centre: number, side: 1 | -1): { index: number; k: number } {
  const n = sortedPool.length;
  const k = Math.max(16, Math.floor(n * 0.02));
  if (n < 4 * k) return { index: Infinity, k };
  const at = (i: number): number => side * ((side > 0 ? sortedPool[n - 1 - i] : sortedPool[i]) - centre);
  const threshold = at(k);
  if (!(threshold > 0)) return { index: Infinity, k };
  let sum = 0;
  for (let i = 0; i < k; i++) sum += Math.log(at(i) / threshold);
  return { index: sum > 0 ? k / sum : Infinity, k };
}

/** Joint draws behind a two-variable tail estimate: k = 327 tail points a
 *  side, a Hill standard error of 5.5% — and ~3 ms, against the ~40 ms of
 *  sorting a full SAMPLE_COUNT column on every slider frame. */
export const TAIL_POOL_SIZE = 1 << 14;
/** Work counters for the perf guard: pools are built once per parameter
 *  values, and only for rows whose moments are in question. */
export const TAIL_POOL_STATS = { builds: 0, samples: 0 };

// --- deterministic conditional-CDF curves (the quadrature tier) ---
//
// Between the exact laws and the Monte Carlo estimate: a derived variable
// over ONE or TWO independent bases gets its CDF by conditioning,
//
//   F(z) = E_X[ P(g(x, Y) ≤ z) ],
//
// with both expectations taken over quantile-midpoint grids. The inner
// grid's sorted g-values are order statistics — known quantiles of the
// conditional law — so each sorted column IS a conditional CDF read off by
// linear interpolation; the outer average is the midpoint rule in
// probability space. Everything is deterministic: no pairing noise, so the
// flat plateau of Y/(X+1) renders flat, and the density (the differentiated
// CDF) keeps kinks within a couple of grid cells instead of a kernel
// bandwidth. A curve computes once per definition + parameter values and
// survives resample() — there is no noise to redraw. Three or more
// variables fall through to the sampled tier: the tensor grid would not
// scale.

const QC_OUTER = 512; // conditioning-variable quantile nodes (two-var case)
const QC_INNER = 512; // inner-variable grid per node
const QC_SINGLE = 8192; // inner grid for one-variable transforms
const QC_BINS = 512; // density grid resolution (matches estimateCurve)
const QC_ZOOM_MAX = 32; // deepest densification of a zoomed rasterization
/** Share of a conditional column one value must hold before it counts as a
 *  point mass rather than the repeats a many-to-one g makes (see the run
 *  scan in conditionalBase). At M = 512 that is a run of 6, comfortably
 *  above the branch counts real expressions produce and far below the
 *  fraction any atom worth a stem holds. */
const ATOM_RUN_FRAC = 0.01;

/** The quantile function of a base distribution at these parameter values,
 *  or null while the parameters are invalid. */
function quantileClosure(
  d: BaseDist,
  env: Record<string, number>,
): ((u: number) => number) | null {
  const a = d.args.map(e => evaluate(e, env));
  if (!a.every(isFinite)) return null;
  switch (d.kind) {
    case 'normal':
      return a[1] > 0 ? u => a[0] + a[1] * normalQuantile(u) : null;
    case 'uniform':
      return a[1] > a[0] ? u => a[0] + (a[1] - a[0]) * u : null;
    case 'exponential':
      return a[0] > 0 ? u => -Math.log(1 - u) / a[0] : null;
    default:
      return zooQuantile(d.kind, a);
  }
}

// --- quantiles of the laws with no closed-form inverse ---
//
// Every sample in this file is a quantile transform (see the header), so a
// base column costs SAMPLE_COUNT quantile calls — per frame, while a derived
// density is on screen. Inverting an incomplete gamma or beta function that
// often is out of the question; instead each (kind, shape) gets a table:
// the quantile solved exactly (safeguarded Newton on whichever tail is the
// small one) at nodes uniform in logit(u), then cubic Hermite between them
// with the EXACT slope dy/ds = u(1 − u)/density. Both axes are warped so the
// function is nearly linear where it is hard — logit(u) against ln x for a
// positive law, logit x on [0, 1], asinh x on the line — which is what makes
// a power-law tail or a pole at the support edge interpolate to ~1e-9.

/** A law in its warped coordinate y: both tails and the density dP/dy. */
interface WarpedLaw {
  pq: (y: number) => [number, number];
  dens: (y: number) => number;
  unwarp: (y: number) => number;
}

/** Work counters for the perf guard (lib/perf-guards.test.ts): a table build
 *  is the expensive step, and a base column must never trigger one per frame. */
export const QUANTILE_STATS = { builds: 0, cdfEvals: 0 };

const QT_L = 15; // table spans logit(u) ∈ [−15, 15]: u from 3e-7, inside every grid here
const QT_N = 600; // cells; Hermite error ~ h⁴ with h = 0.05
const QT_YMAX = 700; // e^700 and sinh(700) are finite doubles

/** Solve P(y) = u for y, given u and 1 − u (both exact), from a starting guess
 *  and a bracket. Newton, bisecting whenever a step leaves the bracket. */
function solveWarped(law: WarpedLaw, u: number, uc: number, guess: number, ylo: number): number {
  let lo = ylo;
  let hi = QT_YMAX;
  let y = Math.min(hi, Math.max(lo, guess));
  for (let it = 0; it < 200; it++) {
    QUANTILE_STATS.cdfEvals++;
    const [p, q] = law.pq(y);
    const r = u <= 0.5 ? p - u : uc - q; // increasing in y, zero at the root
    if (Number.isNaN(r)) return NaN;
    if (r === 0) return y;
    if (r > 0) hi = y;
    else lo = y;
    let next = y - r / law.dens(y);
    // A step this small has arrived — checked before the bracket test, which
    // a converged step landing ON the bracket edge would otherwise fail.
    if (Math.abs(next - y) <= 1e-13 * (1 + Math.abs(y))) return next;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (hi - lo <= 1e-13 * (1 + Math.abs(y))) return next;
    y = next;
  }
  return y;
}

function buildQuantile(law: WarpedLaw): ((u: number) => number) | null {
  QUANTILE_STATS.builds++;
  const ys = new Float64Array(QT_N + 1);
  const ms = new Float64Array(QT_N + 1); // dy/ds at the nodes
  const h = (2 * QT_L) / QT_N;
  for (let k = 0; k <= QT_N; k++) {
    const sk = -QT_L + k * h;
    const u = 1 / (1 + Math.exp(-sk));
    const uc = 1 / (1 + Math.exp(sk));
    const prev = k ? ys[k - 1] : -QT_YMAX;
    const y = solveWarped(law, u, uc, k ? prev + ms[k - 1] * h : 0, prev);
    if (Number.isNaN(y)) return null;
    ys[k] = y;
    const m = (u * uc) / law.dens(y);
    // Pinned at the representable edge (a Gamma(0.01) quantile below e^−700)
    // or a density that underflowed: flat/secant, not a wild exact slope.
    ms[k] = Math.abs(y) >= QT_YMAX - 1e-9 || !isFinite(m) ? (k ? (y - prev) / h : 0) : m;
  }
  return (u: number): number => {
    if (!(u > 0 && u < 1)) return NaN;
    const sv = Math.log(u / (1 - u));
    if (!(Math.abs(sv) < QT_L)) return law.unwarp(solveWarped(law, u, 1 - u, 0, -QT_YMAX));
    const f = (sv + QT_L) / h;
    const k = Math.min(QT_N - 1, Math.floor(f));
    const t = f - k;
    const t2 = t * t;
    const t3 = t2 * t;
    return law.unwarp((2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * ms[k]
      + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * ms[k + 1]);
  };
}

/** Standard-scale tables by shape: Gamma's rate (and ChiSquared's fixed one)
 *  scales the result, so dragging a rate slider never rebuilds. Small and
 *  bounded — a shape slider leaves a trail of one table per value. */
const quantileTables = new Map<string, ((u: number) => number) | null>();
function cachedQuantile(key: string, make: () => WarpedLaw | null): ((u: number) => number) | null {
  let q = quantileTables.get(key);
  if (q === undefined) {
    const law = make();
    q = law && buildQuantile(law);
    if (quantileTables.size >= 64) quantileTables.delete(quantileTables.keys().next().value!);
  } else {
    // Least RECENTLY USED goes first (a Map iterates in insertion order, so a
    // hit re-inserts): a dragged shape slider leaves a trail of dead tables,
    // and must not push out the one a fixed variable reads every frame.
    quantileTables.delete(key);
  }
  quantileTables.set(key, q);
  return q;
}

function gammaQuantile(shape: number): ((u: number) => number) | null {
  if (shape > GAMMA_UNIFORM_SHAPE) {
    // Wilson–Hilferty: relative error O(shape^−2) in the body.
    const c = 1 / (9 * shape);
    return u => shape * Math.max(0, 1 - c + Math.sqrt(c) * normalQuantile(u)) ** 3;
  }
  const lg = lgamma(shape);
  return cachedQuantile(`g${shape}`, () => ({
    pq: y => gammaPQ(shape, Math.exp(y)),
    // pdf(x)·dx/dy with x = e^y: x^α e^−x / Γ(α), finite even at a pole.
    dens: y => Math.exp(shape * y - Math.exp(y) - lg),
    unwarp: Math.exp,
  }));
}

/** Beta(a, b) quantiles for a + b > BETA_LIMIT_SUM, by the same two limits as
 *  specfn's betaLimit: a Gamma law on a modest parameter's side (X/(1 − X) →
 *  G_a/b), otherwise the normal with its first skewness correction. */
function betaLimitQuantile(al: number, be: number): ((u: number) => number) | null {
  if (al < BETA_GAMMA_SIDE || be < BETA_GAMMA_SIDE) {
    const small = Math.min(al, be);
    const g = gammaQuantile(small);
    if (!g) return null;
    const big = Math.max(al, be);
    return al <= be ? u => g(u) / (big + g(u)) : u => big / (big + g(1 - u));
  }
  const n = al + be;
  const mean = al / n;
  const sd = Math.sqrt((al * be) / (n + 1)) / n;
  const skew = (2 * (be - al) * Math.sqrt(n + 1)) / ((n + 2) * Math.sqrt(al * be));
  return u => {
    const z = normalQuantile(u);
    return Math.min(1, Math.max(0, mean + sd * (z + (skew * (z * z - 1)) / 6)));
  };
}

/** Quantile functions of the kinds quantileClosure has no formula for. */
function zooQuantile(kind: BaseKind, a: number[]): ((u: number) => number) | null {
  if (paramProblem(kind, a)) return null;
  switch (kind) {
    case 'gamma':
    case 'chisquared': {
      const [shape, rate] = kind === 'gamma' ? a : [a[0] / 2, 0.5];
      const q = gammaQuantile(shape);
      return q && (u => q(u) / rate);
    }
    case 'beta': {
      const [al, be] = a;
      // The table inverts the exact cdf for as long as there is one (~0.2 s to
      // build at a + b = 1e10, once per shape); past it, the cdf's own limits.
      if (al + be > BETA_LIMIT_SUM) return betaLimitQuantile(al, be);
      const lb = lbeta(al, be);
      // y = logit x, so x and 1 − x are both formed without cancellation.
      return cachedQuantile(`b${al},${be}`, () => ({
        pq: y => betaPQ(al, be, 1 / (1 + Math.exp(-y)), 1 / (1 + Math.exp(y))),
        dens: y => Math.exp(-al * Math.log1p(Math.exp(-y)) - be * Math.log1p(Math.exp(y)) - lb),
        unwarp: y => 1 / (1 + Math.exp(-y)),
      }));
    }
    case 'studentt': {
      const df = a[0];
      if (df === 1) return u => Math.tan(Math.PI * (u - 0.5));
      return cachedQuantile(`t${df}`, () => ({
        pq: y => studentTPQ(df, Math.sinh(y)),
        dens: y => studentTPdf(Math.sinh(y), df) * Math.cosh(y),
        unwarp: Math.sinh,
      }));
    }
    case 'lognormal':
      return u => Math.exp(a[0] + a[1] * normalQuantile(u));
    case 'cauchy':
      return u => a[0] + a[1] * Math.tan(Math.PI * (u - 0.5));
    case 'weibull':
      return u => a[1] * Math.pow(-Math.log1p(-u), 1 / a[0]);
    default:
      return null;
  }
}

/** The reusable half of the quadrature tier: the sorted tensor columns and
 *  everything derived from them once — atoms, moments, the drawn window.
 *  Rasterizing a density over ANY z-range from this is ~1ms (condDensity),
 *  which is what lets a zoomed-in viewport recompute the visible stretch of
 *  the curve at full grid resolution instead of magnifying polyline cells. */
interface QCBase {
  sorted: Float64Array[];
  M: number;
  NX: number;
  atoms?: Array<{ x: number; p: number }>;
  atomValues: Set<number>;
  mean: number;
  sd: number;
  mass: number;
  robust?: Robust;
  /** Full drawn window of the continuous part; null when purely discrete. */
  window: { lo: number; hi: number; hardLo: boolean; hardHi: boolean } | null;
}

function conditionalBase(
  g: Expr,
  vars: Array<{ name: string; quantile: (u: number) => number }>,
  env: Record<string, number>,
  heavy: HeavyBase = 0,
): QCBase | null {
  const outer = vars.length === 2 ? vars[0] : null;
  const inner = vars[vars.length - 1];
  const NX = outer ? QC_OUTER : 1;
  const M = outer ? QC_INNER : QC_SINGLE;
  const cells = NX * M;
  const innerCol = new Float64Array(M);
  for (let j = 0; j < M; j++) innerCol[j] = inner.quantile((j + 0.5) / M);
  const cols = new Map([[inner.name, innerCol]]);

  // g over the whole grid, one sorted column per conditioning node. (The
  // typed-array sort is numeric; non-finite values land at the ends.)
  const sorted: Float64Array[] = [];
  let finCount = 0;
  let sum = 0;
  let sumsq = 0;
  for (let i = 0; i < NX; i++) {
    const e = outer ? { ...env, [outer.name]: outer.quantile((i + 0.5) / NX) } : env;
    const col = evalCols(g, cols, e, M).slice(); // own copy: g = bare var hands back innerCol
    col.sort();
    sorted.push(col);
    for (let j = 0; j < M; j++) {
      const v = col[j];
      if (isFinite(v)) {
        finCount++;
        sum += v;
        sumsq += v * v;
      }
    }
  }
  if (finCount < 16) return null; // (almost) nowhere defined
  const mean = sum / finCount;
  const sd = Math.sqrt(Math.max(sumsq / finCount - mean * mean, 0));
  const mass = finCount / cells;
  // The robust readout judges the whole law, so its pool keeps the atoms the
  // continuous pool below drops (see robustIfUnstable).
  const allPool: number[] = [];
  const allStride = Math.max(1, Math.floor(finCount / 8192));
  let allSeen = 0;
  for (const col of sorted) {
    for (let j = 0; j < M; j++) {
      const v = col[j];
      if (isFinite(v) && allSeen++ % allStride === (allStride >> 1)) allPool.push(v);
    }
  }
  allPool.sort((a, b) => a - b);
  // The two-variable tensor grid resolves a pole-driven tail (X/Y) only down
  // to its innermost node and flattens the outer 2% a tail index is measured
  // on, so that tier reads its tails off a modest joint draw instead: the
  // head of each variable's own stream (a uniform random subsample, the two
  // independently shuffled), through the same quantile functions.
  const tailPool = outer && ((): Float64Array => {
    TAIL_POOL_STATS.builds++;
    TAIL_POOL_STATS.samples += TAIL_POOL_SIZE;
    const draw = (v: { name: string; quantile: (u: number) => number }): Float64Array =>
      uniformStream(v.name).subarray(0, TAIL_POOL_SIZE).map(v.quantile);
    const joint = evalCols(g, new Map([[outer.name, draw(outer)], [inner.name, draw(inner)]]), env, TAIL_POOL_SIZE);
    return joint.filter(Number.isFinite).sort();
  });
  const robust = robustIfUnstable(allPool, sd, heavy, tailPool || undefined);

  // Repeated values are point masses (piecewise branches, floor, constants):
  // pooled across columns, heavy values become stems, and the continuous CDF
  // below must not carry their jumps.
  //
  // What makes a run an atom is that it does not thin out as the grid
  // refines. A continuous many-to-one g repeats values too — the ±y pair of
  // Y², the branches of any even function — but only ever as many times as it
  // has branches, so its run is O(1) in M while an atom's run is a FRACTION
  // of M. Counting every repeat instead pooled those O(1) runs across all 512
  // columns and cleared the mass threshold on arithmetic alone: max(Y², X)
  // came out as 121 stems holding 43% of the probability, and Y² + 0X as 256
  // stems holding all of it, with no curve left to draw.
  const runMass = new Map<number, number>();
  for (const col of sorted) {
    for (let j = 0; j < M; ) {
      const v = col[j];
      let k = j + 1;
      while (k < M && col[k] === v) k++;
      if ((k - j) / M >= ATOM_RUN_FRAC && isFinite(v)) {
        runMass.set(v, (runMass.get(v) ?? 0) + (k - j) / cells);
      }
      j = k;
    }
  }
  let atoms: Array<{ x: number; p: number }> | undefined;
  const atomValues = new Set<number>();
  for (const [x, p] of runMass) {
    if (p >= 0.002) {
      atomValues.add(x);
      (atoms ??= []).push({ x, p });
    }
  }
  atoms?.sort((a, b) => a.x - b.x);

  // Drawn range from the continuous part: pooled decimated quantiles, and
  // the same hard-edge rule as the sampler — an end the tail-trim cannot
  // reach is the support edge itself and must cut off straight.
  let contCount = 0;
  let cmin = Infinity;
  let cmax = -Infinity;
  for (const col of sorted) {
    for (let j = 0; j < M; j++) {
      const v = col[j];
      if (isFinite(v) && !atomValues.has(v)) {
        contCount++;
        if (v < cmin) cmin = v;
        if (v > cmax) cmax = v;
      }
    }
  }
  const partial = { sorted, M, NX, atoms, atomValues, mean, sd, mass, robust };
  if (contCount < 16 || !(cmax > cmin)) return { ...partial, window: null };
  const stride = Math.max(1, Math.floor(contCount / 8192));
  const pool: number[] = [];
  let seen = 0;
  for (const col of sorted) {
    for (let j = 0; j < M; j++) {
      const v = col[j];
      if (isFinite(v) && !atomValues.has(v) && seen++ % stride === 0) pool.push(v);
    }
  }
  pool.sort((a, b) => a - b);
  const q = quantileOf(pool);
  const [wlo, whi] = visualWindow(pool, cmin, cmax);
  const qlo = Math.max(q(0.005), wlo);
  const qhi = Math.min(q(0.995), whi);
  const span = qhi - qlo;
  if (!(span > 0)) return { ...partial, window: null };
  const hardLo = qlo - cmin <= 0.25 * span;
  const hardHi = cmax - qhi <= 0.25 * span;
  return {
    ...partial,
    window: { lo: hardLo ? cmin : qlo, hi: hardHi ? cmax : qhi, hardLo, hardHi },
  };
}

/**
 * Rasterize the density over [lo, hi]: accumulate F on the grid — each
 * column contributes its interpolated conditional CDF with equal weight
 * (quantile midpoints carry equal probability); order statistics sit at
 * run-midpoint quantiles, and half-gap extensions carry F to 0 and to the
 * column's full continuous mass, exact for a locally linear g so a
 * uniform's support edge lands exactly — then differentiate. Returns the
 * bare polyline, no edge drops.
 */
function condDensity(base: QCBase, lo: number, hi: number): number[] {
  const { sorted, M, NX, atomValues } = base;
  const B = QC_BINS;
  const dz = (hi - lo) / B;
  const F = new Float64Array(B + 1);
  const w = 1 / NX;
  for (const col of sorted) {
    const nx: number[] = [];
    const nF: number[] = [];
    let cum = 0;
    for (let j = 0; j < M; ) {
      const v = col[j];
      let k = j + 1;
      while (k < M && col[k] === v) k++;
      if (isFinite(v) && !atomValues.has(v)) {
        nx.push(v);
        nF.push((cum + (k - j) / 2) / M);
        cum += k - j;
      }
      j = k;
    }
    if (!cum) continue;
    const top = cum / M;
    let zeroX: number;
    let topX: number;
    if (nx.length > 1) {
      const last = nx.length - 1;
      const s0 = (nF[1] - nF[0]) / (nx[1] - nx[0]);
      const s1 = (nF[last] - nF[last - 1]) / (nx[last] - nx[last - 1]);
      zeroX = nx[0] - nF[0] / s0;
      topX = nx[last] + (top - nF[last]) / s1;
    } else {
      zeroX = nx[0] - dz / 2; // a lone value: a step smeared over one cell
      topX = nx[0] + dz / 2;
    }
    const bx = [zeroX, ...nx, topX];
    const bF = [0, ...nF, top];
    let p = 0;
    for (let k = 0; k <= B; k++) {
      const z = lo + k * dz;
      if (z <= zeroX) continue;
      if (z >= topX) {
        F[k] += w * top;
        continue;
      }
      while (bx[p + 1] < z) p++;
      F[k] += w * (bF[p] + ((z - bx[p]) / (bx[p + 1] - bx[p])) * (bF[p + 1] - bF[p]));
    }
  }

  // The density is the differentiated CDF. A narrow Gaussian pass then
  // absorbs the outer midpoint rule's ripple (worst where the conditional
  // CDF has a moving square-root edge, e.g. X²+Y²). The ripple lives at the
  // FULL window's cell scale, so a zoomed-in rasterization widens the
  // radius to keep covering it — kinks round over about one full-window
  // cell either way, consistent at every zoom. One-variable transforms have
  // no outer grid and keep the minimal ±2 cells.
  const raw = new Float64Array(B + 1);
  for (let k = 0; k <= B; k++) {
    const a = k === 0 ? F[0] : F[k - 1];
    const b = k === B ? F[B] : F[k + 1];
    raw[k] = Math.max(0, (b - a) / (k === 0 || k === B ? dz : 2 * dz));
  }
  const win = base.window!;
  const r = NX === 1
    ? 2
    : Math.max(2, Math.min(64, Math.round((win.hi - win.lo) / B / dz / 2)));
  const kern = new Float64Array(2 * r + 1);
  for (let k = -r; k <= r; k++) kern[k + r] = Math.exp((-2 * k * k) / (r * r));
  const dens = new Float64Array(B + 1);
  for (let k = 0; k <= B; k++) {
    let s = 0;
    let ws = 0;
    for (let d = -r; d <= r; d++) {
      const j = k + d;
      if (j < 0 || j > B) continue; // clipped at ends, renormalized here
      s += kern[d + r] * raw[j];
      ws += kern[d + r];
    }
    dens[k] = s / ws;
  }

  const pts: number[] = [];
  for (let k = 0; k <= B; k++) pts.push(lo + k * dz, dens[k]);
  // The curve's area is the range's continuous probability — the promise a
  // density plot makes. Differencing and smoothing each perturb it a
  // little, so restore it exactly.
  let area = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    area += ((pts[i + 1] + pts[i + 3]) / 2) * (pts[i + 2] - pts[i]);
  }
  const target = F[B] - F[0];
  if (area > 0 && target > 0) {
    const scale = target / area;
    for (let i = 1; i < pts.length; i += 2) pts[i] *= scale;
  }
  return pts;
}

/** The full-window curve for a base: the density polyline between hard-edge
 *  drops, or a bare atoms-only curve when nothing continuous is drawable. */
function condAssemble(base: QCBase): DensityCurve {
  const { atoms, mean, sd, mass, robust, window: win } = base;
  if (!win) return { pts: [], atoms, mean, sd, mass, robust };
  const pts: number[] = [];
  if (win.hardLo) pts.push(win.lo, 0); // the jump itself: a vertical at the edge
  pts.push(...condDensity(base, win.lo, win.hi));
  if (win.hardHi) pts.push(win.hi, 0);
  return { pts, atoms, mean, sd, mass, robust };
}

/** Linear interpolation of a density polyline at x (0 outside its range). */
export function densityAt(curve: DensityCurve, x: number): number {
  const p = curve.pts;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (x >= p[i] && x <= p[i + 2]) {
      const f = (x - p[i]) / (p[i + 2] - p[i] || 1);
      return p[i + 1] + f * (p[i + 3] - p[i + 1]);
    }
  }
  return 0;
}

/** Clip a density curve to [lo, hi] and close it down to the x-axis: the
 *  polygon a Monte Carlo `P(…)` row fills. Null when the clip is empty. */
export function shadePolygon(curve: DensityCurve, lo?: number, hi?: number): number[] | null {
  const p = curve.pts;
  if (p.length < 4) return null;
  const xlo = lo ?? p[0];
  const xhi = hi ?? p[p.length - 2];
  if (!(xhi > xlo)) return null;
  const yAt = (x: number): number => densityAt(curve, x);
  const out: number[] = [xlo, 0, xlo, yAt(xlo)];
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] > xlo && p[i] < xhi) out.push(p[i], p[i + 1]);
  }
  out.push(xhi, yAt(xhi), xhi, 0);
  return out;
}

interface CacheEntry {
  /** Serialized definition + parameter values the fields were computed under. */
  sig: string;
  /** Joint sample column (present once columns() ran for this sig). */
  col?: Float64Array;
  /** Exact usum piecewise-polynomial curve. */
  curve?: DensityCurve | null;
  /** Quadrature-tier base: sorted tensor columns + window (the ~15ms part). */
  qcb?: QCBase | null;
  /** Deterministic conditional-CDF curve over the full window. */
  qc?: DensityCurve | null;
  /** Zoomed rasterization spliced into the full curve, keyed by its range. */
  qcz?: { lo: number; hi: number; curve: DensityCurve };
  /** Sampled KDE estimate — the last-resort tier, dropped by resample(). */
  est?: DensityCurve | null;
  /** The last curve re-issued with a quadrature-certified mean (see curve()). */
  certified?: { from: DensityCurve; curve: DensityCurve };
  /** Quadrature moments (present once quadMoments ran for this sig). */
  qm?: { mean: number; sd: number; mass: number } | null;
  /** A discrete base: its law, the whole numbers holding all but STEM_TAIL of
   *  each tail, and the stems last built, keyed by their window. */
  pmf?: { law: DiscreteLaw; kLo: number; kHi: number; key: string; stems: PmfStems | null } | null;
}

/** The pdf and support of a base distribution at these parameter values, or
 *  null while the parameters are invalid. `mid` is a point in the bulk for
 *  the integrator to split at: the (lo, ∞) change of variables alone lands
 *  ChiSquared(200)'s whole peak between two Kronrod nodes and integrates 0. */
function pdfClosure(
  d: BaseDist,
  env: Record<string, number>,
): { pdf: (x: number) => number; lo: number; hi: number; mid?: number } | null {
  const a = d.args.map(e => evaluate(e, env));
  if (!a.every(isFinite)) return null;
  switch (d.kind) {
    case 'normal':
      return a[1] > 0 ? { pdf: x => normalpdf(x, a[0], a[1]), lo: -Infinity, hi: Infinity } : null;
    case 'uniform':
      return a[1] > a[0] ? { pdf: () => 1 / (a[1] - a[0]), lo: a[0], hi: a[1] } : null;
    case 'exponential':
      return a[0] > 0 ? { pdf: x => a[0] * Math.exp(-a[0] * x), lo: 0, hi: Infinity } : null;
  }
  if (paramProblem(d.kind, a)) return null;
  switch (d.kind) {
    case 'gamma':
      return { pdf: x => gammaPdf(x, a[0], a[1]), lo: 0, hi: Infinity, mid: a[0] / a[1] };
    case 'chisquared':
      return { pdf: x => gammaPdf(x, a[0] / 2, 0.5), lo: 0, hi: Infinity, mid: a[0] };
    case 'beta':
      return { pdf: x => betaPdf(x, a[0], a[1]), lo: 0, hi: 1, mid: a[0] / (a[0] + a[1]) };
    case 'studentt':
      return { pdf: x => studentTPdf(x, a[0]), lo: -Infinity, hi: Infinity, mid: 0 };
    case 'lognormal':
      return {
        pdf: x => (x > 0 ? normalpdf(Math.log(x), a[0], a[1]) / x : 0),
        lo: 0,
        hi: Infinity,
        mid: Math.exp(a[0]),
      };
    case 'cauchy':
      return {
        pdf: x => 1 / (Math.PI * a[1] * (1 + ((x - a[0]) / a[1]) ** 2)),
        lo: -Infinity,
        hi: Infinity,
        mid: a[0],
      };
    case 'weibull':
      return { pdf: x => weibullPdf(x, a[0], a[1]), lo: 0, hi: Infinity, mid: a[1] };
    default:
      return null; // a discrete law has no pdf to integrate against (add() refuses its transforms)
  }
}

// --- discrete laws: pmf, support, quantile, stems ---

/** A discrete law at fixed parameter values. */
export interface DiscreteLaw {
  /** P(X = k); 0 off the support and at any k that is not a whole number. */
  pmf: (k: number) => number;
  /** [P(X ≤ x), P(X > x)], each tail formed directly. */
  pq: (x: number) => [number, number];
  /** The support's ends (hi may be Infinity). */
  lo: number;
  hi: number;
  mean: number;
  sd: number;
  /**
   * The quantile function, a step function: the smallest whole number k with
   * P(X ≤ k) ≥ u — or, with `upper`, with P(X > k) ≤ u, which addresses the
   * upper tail without forming 1 − u. Exact at the steps: quantile(cdf(k)) is
   * k, and anything above cdf(k) is k + 1. (The sampling tier of plan #6 draws
   * through this; here it bounds the stems worth drawing.)
   */
  quantile: (u: number, upper?: boolean) => number;
}

/** The law of a discrete base distribution at these parameter values, or null
 *  when the parameters declare none (or the distribution is continuous). */
export function discreteLaw(d: BaseDist, env: Record<string, number>): DiscreteLaw | null {
  if (!d.discrete) return null;
  const a = d.args.map(e => evaluate(e, env));
  if (!a.every(isFinite) || paramProblem(d.kind, a)) return null;
  let pmf: (k: number) => number;
  let lo = 0;
  let hi = Infinity;
  let mean: number;
  let variance: number;
  switch (d.kind) {
    case 'binomial':
    case 'bernoulli': {
      const [n, p] = d.kind === 'binomial' ? [wholeNumber(a[0]), a[1]] : [1, a[0]];
      pmf = k => binomPmf(k, n, p);
      hi = n;
      mean = n * p;
      variance = n * p * (1 - p);
      break;
    }
    case 'poisson':
      pmf = k => poissonPmf(k, a[0]);
      mean = variance = a[0];
      break;
    case 'geometric':
      pmf = k => negBinomPmf(k - 1, 1, a[0]);
      lo = 1;
      mean = 1 / a[0];
      variance = (1 - a[0]) / (a[0] * a[0]);
      break;
    case 'negbinomial':
      pmf = k => negBinomPmf(k, a[0], a[1]);
      mean = (a[0] * (1 - a[1])) / a[1];
      variance = mean / a[1];
      break;
    case 'discreteuniform': {
      lo = wholeNumber(a[0]);
      hi = wholeNumber(a[1]);
      pmf = k => discreteUniformPmf(k, lo, hi);
      mean = (lo + hi) / 2;
      const n = hi - lo + 1;
      variance = ((n - 1) / 12) * (n + 1); // (n² − 1)/12 without squaring a huge n
      break;
    }
    default:
      return null;
  }
  const kind = d.kind;
  const pq = (x: number): [number, number] => discretePQ(kind, a, x);
  const sd = Math.sqrt(variance);
  // P(X ≤ k) ≥ u, asked of whichever tail says it without rounding.
  const reached = (k: number, u: number, upper: boolean): boolean => (upper ? pq(k)[1] <= u : pq(k)[0] >= u);
  const quantile = (u: number, upper = false): number => {
    if (Number.isNaN(u) || u < 0 || u > 1) return NaN;
    if (reached(lo, u, upper)) return lo; // u = 0, or an atom holding it all
    // All the mass, of a support with no end. (A finite one is searched: its
    // answer is where the cdf reaches 1, which may be short of hi.)
    if ((upper ? u <= 0 : u >= 1) && hi === Infinity) return Infinity;
    // Bracket outward from the normal guess in doubling steps, then bisect
    // on the whole numbers: ~2 log₂(distance) cdf calls, whatever the law.
    const z = normalQuantile(upper ? 1 - u : u);
    const clamp = (x: number): number => Math.min(hi, Math.max(lo, Math.round(x)));
    let k = clamp(mean + sd * (isFinite(z) ? z : 0));
    if (!isFinite(k)) k = clamp(mean); // σ past double range: start from the mean
    if (!isFinite(k)) return NaN; // …and the mean too (Geometric(1e-320))
    let below: number; // a k that is NOT reached (or lo − 1)
    let at: number; // a k that IS reached
    if (reached(k, u, upper)) {
      at = k;
      below = lo - 1;
      for (let step = 1; at - step > lo - 1; step *= 2) {
        if (!reached(at - step, u, upper)) {
          below = at - step;
          break;
        }
        at -= step;
      }
    } else {
      below = k;
      at = hi;
      for (let step = 1; ; step *= 2) {
        const probe = below + step;
        if (probe >= hi) break; // hi itself is always reached
        if (!isFinite(probe)) return NaN;
        if (reached(probe, u, upper)) {
          at = probe;
          break;
        }
        below = probe;
      }
      if (at === Infinity) return NaN;
    }
    while (at - below > 1) {
      const mid = below + Math.floor((at - below) / 2);
      if (!(mid > below && mid < at)) break; // past 2^53 the whole numbers are coarser than 1
      if (reached(mid, u, upper)) at = mid;
      else below = mid;
    }
    return at;
  };
  return { pmf, pq, lo, hi, mean, sd, quantile };
}

/** At most this many stems are drawn; more whole numbers than that in view
 *  (Poisson(1e6) zoomed out, DiscreteUniform(-1e9, 1e9)) draw the pmf's
 *  ENVELOPE instead — the same heights at STEM_MAX evenly spaced whole
 *  numbers, joined — since stems closer than a pixel are a solid shape anyway. */
export const STEM_MAX = 1024;
/** Mass each tail may hide beyond the drawn stems: far below a pixel. */
const STEM_TAIL = 1e-12;
/** Counts pmf evaluations for the per-frame stem path: the perf guard reads it. */
export const STEM_STATS = { builds: 0, pmfEvals: 0 };

/** The drawn pmf of a discrete variable over a view. */
export interface PmfStems {
  /** Whole numbers, ascending, and P(X = k) at each. */
  ks: number[];
  ps: number[];
  /** True when `ks` is a subsample (see STEM_MAX): draw the outline through
   *  the points, not one stem per point. */
  envelope: boolean;
}

/** The stems of `law` at the whole numbers of [kLo, kHi] (finite), capped. */
function buildStems(law: DiscreteLaw, kLo: number, kHi: number): PmfStems {
  STEM_STATS.builds++;
  const ks: number[] = [];
  const count = kHi - kLo + 1;
  if (count <= STEM_MAX) {
    for (let k = kLo; k <= kHi; k++) ks.push(k);
  } else {
    // Evenly spaced whole numbers, both ends included. The spacing is a
    // double (count may be 2e9); rounding keeps every sample ON the lattice,
    // so each height is an exact pmf value, never an interpolated one.
    const step = (kHi - kLo) / (STEM_MAX - 1);
    for (let i = 0; i < STEM_MAX; i++) {
      const k = i === STEM_MAX - 1 ? kHi : Math.round(kLo + i * step);
      if (k !== ks[ks.length - 1]) ks.push(k);
    }
  }
  STEM_STATS.pmfEvals += ks.length;
  return { ks, ps: ks.map(law.pmf), envelope: count > STEM_MAX };
}

/** The dot capping each stem, in px, from the spacing of whole numbers on
 *  screen: full size while stems stand apart, small as they crowd, none once
 *  the dots would merge into a band (the lines alone carry the shape). One
 *  rule for the app and the og rasterizer. */
export const stemDotRadius = (pxPerUnit: number): number => (pxPerUnit >= 9 ? 3.5 : pxPerUnit >= 4 ? 2 : 0);

/** The part of drawn stems a P(…) row selects, as runs (two for a
 *  complement). In envelope mode each run gains its exact end points, so the
 *  shaded outline stops at the bound and not at the nearest sample. */
export function selectStems(
  stems: PmfStems, law: DiscreteLaw, sel: { kLo: number; kHi: number; not: boolean },
): PmfStems[] {
  if (Number.isNaN(sel.kLo) || Number.isNaN(sel.kHi)) return [];
  const ranges: Array<[number, number]> = sel.not
    ? (sel.kLo > sel.kHi ? [[-Infinity, Infinity]] : [[-Infinity, sel.kLo - 1], [sel.kHi + 1, Infinity]])
    : [[sel.kLo, sel.kHi]];
  const first = stems.ks[0];
  const last = stems.ks[stems.ks.length - 1];
  const out: PmfStems[] = [];
  for (const [a, b] of ranges) {
    const lo = Math.max(a, first);
    const hi = Math.min(b, last);
    if (!(lo <= hi)) continue;
    const ks: number[] = [];
    const ps: number[] = [];
    const push = (k: number, p: number): void => {
      if (k !== ks[ks.length - 1]) {
        ks.push(k);
        ps.push(p);
      }
    };
    if (stems.envelope) push(lo, law.pmf(lo));
    stems.ks.forEach((k, i) => {
      if (k >= lo && k <= hi) push(k, stems.ps[i]);
    });
    if (stems.envelope) push(hi, law.pmf(hi));
    if (ks.length) out.push({ ks, ps, envelope: stems.envelope });
  }
  return out;
}

/**
 * Whether E[h(X)] diverges, by truncation in probability space, where it is
 * ∫₀¹ h(q(u)) du: the mass the integral gains from the two outer slivers
 * u ∈ [1e-6, 1e-3] and then [1e-9, 1e-6] (and their mirrors at 1), each
 * integrated in ln u so a power-law end is smooth. A convergent integral
 * gains less from each deeper sliver; a divergent one does not — a power
 * tail gains more, and at the logarithmic boundary (tail index exactly 2)
 * the two are equal, hence the 3% tolerance. A sliver that fails to settle
 * is "unknown", never "divergent".
 */
function diverges(h: (x: number) => number, quantile: (u: number) => number): boolean {
  const sliver = (lo: number, hi: number): number => {
    const f = (s: number): number => {
      const u = Math.exp(s);
      const a = h(quantile(u));
      const b = h(quantile(1 - u));
      return ((isFinite(a) ? a : 0) + (isFinite(b) ? b : 0)) * u;
    };
    return quadrature(f, Math.log(lo), Math.log(hi));
  };
  const d1 = sliver(1e-6, 1e-3);
  const d2 = sliver(1e-9, 1e-6);
  return isFinite(d1) && isFinite(d2) && d1 > 0 && d2 >= 0.97 * d1;
}

/** An expression decomposed as Σ terms[name]·name + c, coefficients free of
 *  random variables. Affine forms over closed families have exact laws. */
interface Affine {
  terms: Map<string, Expr>;
  c: Expr;
}

/** An exact law: a closed-form pdf the shader draws, or a uniform-sum
 *  convolution evaluated as an exact piecewise polynomial per parameters. */
export type Law =
  | { kind: 'dist'; dist: BaseDist }
  | { kind: 'usum'; terms: Array<{ c: Expr; lo: Expr; hi: Expr }>; d: Expr };

/** The numeric value of a constant-folded expression, or null (frees, NaN). */
function numOf(e: Expr): number | null {
  try {
    const v = evaluate(e, {});
    return isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// --- exact piecewise-polynomial densities (uniform convolutions) ---
//
// Sums of independent uniforms stay piecewise polynomial forever: uniform is
// degree 0 and each convolution raises the degree by one and merges
// breakpoints (X + Y is the triangle, four terms the Irwin–Hall cubic). The
// integrands are polynomials, so "symbolic integration" here is the power
// rule; all the real work is the support bookkeeping below. Coefficients are
// plain numbers evaluated per parameter values — breakpoint *ordering*
// depends on slider values, so a symbolic form would need case analysis the
// numeric one sidesteps.

/** Density polynomial (ascending coefficients) per interval between breaks. */
interface PPoly {
  breaks: number[];
  pieces: number[][];
}

const padd = (a: number[], b: number[]): number[] => {
  const out = new Array(Math.max(a.length, b.length)).fill(0);
  a.forEach((v, i) => { out[i] += v; });
  b.forEach((v, i) => { out[i] += v; });
  return out;
};

const pscale = (a: number[], k: number): number[] => a.map(v => v * k);

const pmul = (a: number[], b: number[]): number[] => {
  const out = new Array(Math.max(1, a.length + b.length - 1)).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  }
  return out;
};

const peval = (a: number[], x: number): number => {
  let v = 0;
  for (let i = a.length - 1; i >= 0; i--) v = v * x + a[i];
  return v;
};

/** Antiderivative with constant 0. */
const pint = (a: number[]): number[] => [0, ...a.map((v, i) => v / (i + 1))];

/** Compose: p(k·y + t) as a polynomial in y. */
const plin = (p: number[], k: number, t: number): number[] => {
  let out: number[] = [0];
  for (let j = p.length - 1; j >= 0; j--) out = padd(pmul(out, [t, k]), [p[j]]);
  return out;
};

const uniformPP = (lo: number, hi: number): PPoly =>
  ({ breaks: [lo, hi], pieces: [[1 / (hi - lo)]] });

/** The density of c·X + t for X with density p (c ≠ 0). */
function scalePP(p: PPoly, c: number, t: number): PPoly {
  const breaks = p.breaks.map(b => c * b + t);
  // g(y) = f((y − t)/c)/|c|; composing with the inverse map keeps polynomials.
  const pieces = p.pieces.map(q => pscale(plin(q, 1 / c, -t / c), 1 / Math.abs(c)));
  if (c < 0) {
    breaks.reverse();
    pieces.reverse();
  }
  return { breaks, pieces };
}

const binom = (n: number, k: number): number => {
  let v = 1;
  for (let i = 0; i < k; i++) v = (v * (n - i)) / (i + 1);
  return v;
};

/**
 * Exact convolution of two piecewise-polynomial densities. For a piece pair
 * u on [a, b] and v on [c, e], h(z) = ∫ u(x)v(z−x) dx over
 * x ∈ [max(a, z−e), min(b, z−c)]: the antiderivative W(x; z) is computed
 * once per pair (a polynomial in x whose coefficients are polynomials in z),
 * and on each output interval — the breakpoints are the pairwise support
 * sums — each limit is either a constant or z + shift, so h is a polynomial.
 */
function convPP(p: PPoly, q: PPoly): PPoly {
  interface Pair { a: number; b: number; c: number; e: number; Wx: number[][] }
  const pairs: Pair[] = [];
  const zb: number[] = [];
  for (let i = 0; i + 1 < p.breaks.length; i++) {
    for (let k = 0; k + 1 < q.breaks.length; k++) {
      const a = p.breaks[i], b = p.breaks[i + 1];
      const c = q.breaks[k], e = q.breaks[k + 1];
      const u = p.pieces[i], v = q.pieces[k];
      // v(z−x) gathered by powers of x: Vx[r] is a polynomial in z.
      const Vx: number[][] = [];
      for (let kk = 0; kk < v.length; kk++) {
        for (let r = 0; r <= kk; r++) {
          Vx[r] ??= [];
          Vx[r][kk - r] = (Vx[r][kk - r] ?? 0) + v[kk] * binom(kk, r) * (r % 2 ? -1 : 1);
        }
      }
      // u(x)·v(z−x) by powers of x, then the antiderivative in x.
      const Px: number[][] = [];
      for (let i2 = 0; i2 < u.length; i2++) {
        for (let r = 0; r < Vx.length; r++) {
          if (!Vx[r]) continue;
          Px[i2 + r] = padd(Px[i2 + r] ?? [], pscale(Vx[r], u[i2]));
        }
      }
      const Wx: number[][] = [[]];
      for (let j = 0; j < Px.length; j++) Wx[j + 1] = Px[j] ? pscale(Px[j], 1 / (j + 1)) : [];
      pairs.push({ a, b, c, e, Wx });
      zb.push(a + c, a + e, b + c, b + e);
    }
  }
  zb.sort((x, y) => x - y);
  const eps = Math.max(1e-300, (zb[zb.length - 1] - zb[0]) * 1e-12);
  const zs = zb.filter((z, i) => i === 0 || z - zb[i - 1] > eps);
  const breaks: number[] = [zs[0]];
  const pieces: number[][] = [];
  for (let s = 0; s + 1 < zs.length; s++) {
    const mid = (zs[s] + zs[s + 1]) / 2;
    let acc: number[] = [0];
    for (const pr of pairs) {
      if (mid <= pr.a + pr.c || mid >= pr.b + pr.e) continue;
      // W at a limit that is either constant or z + shift, as a poly in z.
      const wAt = (constX: number | null, shift: number): number[] => {
        let out: number[] = [];
        let xp = 1;
        let pw: number[] = [1];
        for (let j = 0; j < pr.Wx.length; j++) {
          if (pr.Wx[j].length) {
            out = padd(out, constX !== null ? pscale(pr.Wx[j], xp) : pmul(pr.Wx[j], pw));
          }
          if (constX !== null) xp *= constX;
          else pw = pmul(pw, [shift, 1]);
        }
        return out;
      };
      const upper = pr.b <= mid - pr.c ? wAt(pr.b, 0) : wAt(null, -pr.c);
      const lower = pr.a >= mid - pr.e ? wAt(pr.a, 0) : wAt(null, -pr.e);
      acc = padd(acc, padd(upper, pscale(lower, -1)));
    }
    breaks.push(zs[s + 1]);
    pieces.push(acc);
  }
  return { breaks, pieces };
}

/** Exact CDF at x. */
function cdfPP(p: PPoly, x: number): number {
  let acc = 0;
  for (let i = 0; i + 1 < p.breaks.length; i++) {
    if (x <= p.breaks[i]) break;
    const hi = Math.min(x, p.breaks[i + 1]);
    const F = pint(p.pieces[i]);
    acc += peval(F, hi) - peval(F, p.breaks[i]);
  }
  return acc;
}

/** The exact curve as a polyline: pieces sampled densely, with every true
 *  breakpoint emitted so kinks stay corners instead of KDE shoulders. */
function curvePP(p: PPoly): number[] {
  const span = p.breaks[p.breaks.length - 1] - p.breaks[0];
  const pts: number[] = [];
  for (let i = 0; i + 1 < p.breaks.length; i++) {
    const x0 = p.breaks[i], x1 = p.breaks[i + 1];
    const n = Math.max(2, Math.ceil(((x1 - x0) / span) * 256));
    for (let k = 0; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n;
      pts.push(x, peval(p.pieces[i], x));
    }
  }
  return pts;
}

/**
 * The declared random variables of a document plus their sample columns.
 * The instance persists across recompiles (reset() clears declarations, not
 * caches); cache entries carry the serialized definition and the values of
 * the constants the variable (transitively) references, so a slider drag
 * recomputes only the variables it touches, a static scene never resamples,
 * and an edited definition can never serve stale samples.
 */
export class RVSystem {
  private rvs = new Map<string, RV>();
  private cache = new Map<string, CacheEntry>();
  private paramsMemo = new Map<string, ReadonlySet<string>>();
  private defSigMemo = new Map<string, string>();
  private affineMemo = new Map<string, Affine | null>();
  private lawMemo = new Map<string, Law | null>();
  private groundedMemo = new Map<string, Expr | null>();

  /** Start a recompile: drop declarations, keep sample caches. */
  reset(): void {
    this.rvs.clear();
    this.paramsMemo.clear();
    this.defSigMemo.clear();
    this.affineMemo.clear();
    this.lawMemo.clear();
    this.groundedMemo.clear();
  }

  /**
   * Declare a variable. A derived variable over a DISCRETE base is refused:
   * every tier below (conditional-CDF quadrature, quantile tables, the KDE)
   * assumes a density, and a KDE over atoms is a wrong picture, not a rough
   * one. Exact pmfs by enumeration are plan #6. (Callers add bases first, and
   * a derived variable over a refused one fails in turn, so checking the
   * direct dependencies covers the transitive ones.)
   */
  add(rv: RV): void {
    if (rv.kind === 'derived') this.refuseDiscrete(rv.expr);
    this.rvs.set(rv.name, rv);
  }

  /** The base distribution of a variable declared discrete, else null. */
  discreteDist(name: string): BaseDist | null {
    const rv = this.rvs.get(name);
    return rv?.kind === 'base' && rv.dist.discrete ? rv.dist : null;
  }

  /** Constants that ARE a whole-number parameter of a discrete law (the n of
   *  `X ~ Binomial(n, p)`, written as the bare name): the app steps their
   *  sliders by 1, as it does Σ bounds, so a drag never lands on n = 2.5. */
  wholeParamNames(): Set<string> {
    const out = new Set<string>();
    for (const rv of this.rvs.values()) {
      if (rv.kind !== 'base' || !rv.dist.discrete) continue;
      familyOf(rv.dist.kind).params.forEach((param, k) => {
        const arg = rv.dist.args[k];
        if (param.whole && arg.kind === 'var') out.add(arg.name);
      });
    }
    return out;
  }

  private refuseDiscrete(e: Expr): void {
    const names = [...freeVars(e)].filter(n => this.discreteDist(n));
    if (!names.length) return;
    throw new Error(`${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} discrete: arithmetic and joint events over discrete`
      + ` random variables are not supported yet. P(…) with constant bounds and E(…) take ${names[0]} on its own.`);
  }

  /**
   * What a P(…) row may ask, judged against the declarations: a point event
   * (`P(X = 3)`) only of a discrete variable — for a continuous one it is 0 by
   * definition, and saying 0 would hide that the question was probably meant
   * as an interval — and nothing sampled (`P(X > Y)`) over a discrete one.
   */
  checkProbability(spec: ProbSpec): void {
    const single = spec.single;
    if (single?.point && !this.discreteDist(single.rv)) {
      throw new Error(`P(${single.rv} ${single.not ? '!=' : '='} …) needs a discrete variable: a continuous one`
        + ` takes any single value with probability 0. Ask about an interval, like P(a < ${single.rv} < b).`);
    }
    if (!single || !this.discreteDist(single.rv)) this.refuseDiscrete(spec.body);
  }

  delete(name: string): void {
    this.rvs.delete(name);
  }

  has(name: string): boolean {
    return this.rvs.has(name);
  }

  get(name: string): RV | undefined {
    return this.rvs.get(name);
  }

  size(): number {
    return this.rvs.size;
  }

  /**
   * Redraw the joint sample: a fresh shuffle salt, and the sample-derived
   * cache fields (columns, KDE estimates) dropped so they recompute with
   * new pairing noise. The app calls this once per rendered frame — the KDE
   * wobble then shimmers like the sampling noise it is instead of freezing
   * into structure that looks real. Deterministic artifacts survive: exact
   * laws, quadrature moments, and conditional-CDF curves have no noise to
   * redraw. Tests never call this, so the default salt keeps them
   * deterministic.
   */
  resample(salt: number = (Math.random() * 0x100000000) >>> 0): void {
    // No early return on an unchanged salt: the salt is module-global (the
    // streams are shared by name) while these caches are per-system, so a
    // second system asking for a salt the first already set would keep
    // columns drawn under the old pairing beside streams drawn under the new.
    streamSalt = salt;
    for (const e of this.cache.values()) {
      delete e.col;
      delete e.est;
    }
  }

  /** End a recompile: drop cached samples of variables no longer declared. */
  prune(): void {
    for (const k of [...this.cache.keys()]) {
      if (!this.rvs.has(k)) this.cache.delete(k);
    }
  }

  /** Detect definition cycles; returns per-variable errors. */
  validate(): Map<string, string> {
    const broken = new Map<string, string>();
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (name: string, path: string[]): void => {
      const rv = this.rvs.get(name);
      if (!rv || state.get(name) === 'done') return;
      if (state.get(name) === 'visiting') {
        const cycle = path.slice(path.indexOf(name)).concat(name);
        for (const cn of cycle) broken.set(cn, `${cycle.join(' → ')} is circular.`);
        return;
      }
      state.set(name, 'visiting');
      if (rv.kind === 'derived') {
        for (const dep of freeVars(rv.expr)) {
          if (this.rvs.has(dep)) visit(dep, [...path, name]);
        }
      }
      state.set(name, 'done');
    };
    for (const name of this.rvs.keys()) visit(name, []);
    return broken;
  }

  /** Non-random free names the variable depends on, transitively (may include 't'). */
  paramsOf(name: string): ReadonlySet<string> {
    const memo = this.paramsMemo.get(name);
    if (memo) return memo;
    const out = new Set<string>();
    const seen = new Set<string>();
    const walk = (n: string): void => {
      if (seen.has(n)) return;
      seen.add(n);
      const rv = this.rvs.get(n);
      if (!rv) return;
      const frees = rv.kind === 'base'
        ? rv.dist.args.reduce((s, a) => freeVars(a, s), new Set<string>())
        : freeVars(rv.expr);
      for (const f of frees) {
        if (this.rvs.has(f)) walk(f);
        else out.add(f);
      }
    };
    walk(name);
    this.paramsMemo.set(name, out);
    return out;
  }

  /** Decompose an expression as an affine form over *base normal* names, or
   *  null where that fails (nonlinear use, or a non-normal base involved). */
  private affine(e: Expr): Affine | null {
    const rvFree = (x: Expr): boolean => ![...freeVars(x)].some(n => this.rvs.has(n));
    if (rvFree(e)) return { terms: new Map(), c: e };
    const scale = (af: Affine | null, k: Expr): Affine | null => af && {
      terms: new Map([...af.terms].map(([n, coef]) => [n, bin('*', k, coef)])),
      c: bin('*', k, af.c),
    };
    switch (e.kind) {
      case 'var': {
        const rv = this.rvs.get(e.name)!;
        if (rv.kind === 'base') return { terms: new Map([[e.name, num(1)]]), c: num(0) };
        return this.affineOf(e.name);
      }
      case 'neg':
        return scale(this.affine(e.a), num(-1));
      case 'bin': {
        if (e.op === '+' || e.op === '-') {
          const a = this.affine(e.a);
          const b = e.op === '-' ? scale(this.affine(e.b), num(-1)) : this.affine(e.b);
          if (!a || !b) return null;
          const terms = new Map(a.terms);
          for (const [n, coef] of b.terms) {
            const prev = terms.get(n);
            terms.set(n, prev ? bin('+', prev, coef) : coef);
          }
          return { terms, c: bin('+', a.c, b.c) };
        }
        if (e.op === '*') {
          if (rvFree(e.a)) return scale(this.affine(e.b), e.a);
          if (rvFree(e.b)) return scale(this.affine(e.a), e.b);
          return null; // X·Y: a product distribution, not affine
        }
        if (e.op === '/' && rvFree(e.b)) {
          return scale(this.affine(e.a), bin('/', num(1), e.b));
        }
        return null; // X^k and friends
      }
      default:
        return null; // calls, piecewise, … over random variables: sampled path
    }
  }

  private affineOf(name: string): Affine | null {
    if (this.affineMemo.has(name)) return this.affineMemo.get(name)!;
    const rv = this.rvs.get(name);
    const af = rv?.kind === 'derived' ? this.affine(rv.expr) : null;
    this.affineMemo.set(name, af);
    return af;
  }

  /**
   * The exact law of a variable, when one is derivable. Base declarations
   * pass through. A derived variable affine in independent bases (shared
   * names accumulate into one coefficient first — the covariance accounting:
   * var(aX + bX) = (a+b)²σ²) reduces by family:
   *
   * - all normal → normal, mean Σcᵢμᵢ + d, sd √(Σ(cᵢσᵢ)²);
   * - one term → the base transformed: c·U(lo,hi)+d is Uniform again (min/max
   *   endpoints keep a negative or slider-driven c honest), c·Exp(λ) with a
   *   positive literal c is Exponential(λ/c);
   * - Gamma-family terms sharing one scaled rate → Gamma (gammaSumLaw), which
   *   covers the scaled Gamma, Erlang sums of exponentials, and χ² sums;
   * - the square of a standard normal → ChiSquared(1) (squareLaw);
   * - all Cauchy → Cauchy (locations and |c|-scaled scales add); c·LogNormal
   *   with a positive literal c → LogNormal(mu + ln c, sigma);
   * - several uniform terms → 'usum', an exact piecewise-polynomial
   *   convolution (the triangle, Irwin–Hall, trapezoids) evaluated per
   *   parameter values.
   *
   * Null means "estimate from samples" (nonlinear transforms, products,
   * mixed families).
   */
  exactLaw(name: string): Law | null {
    const memo = this.lawMemo.get(name);
    if (memo !== undefined) return memo;
    const law = this.deriveLaw(name);
    this.lawMemo.set(name, law);
    return law;
  }

  private deriveLaw(name: string): Law | null {
    const rv = this.rvs.get(name);
    if (!rv) return null;
    if (rv.kind === 'base') return { kind: 'dist', dist: rv.dist };
    const af = this.affineOf(name);
    if (!af) return this.squareLaw(name);
    if (!af.terms.size) return null;
    const bases = [...af.terms].map(([n, coef]) => ({
      coef,
      dist: (this.rvs.get(n) as RV & { kind: 'base' }).dist,
    }));
    if (bases.every(b => b.dist.kind === 'normal')) {
      let mean = af.c;
      let variance: Expr | null = null;
      for (const { coef, dist } of bases) {
        mean = bin('+', mean, bin('*', coef, dist.args[0]));
        const term = bin('^', bin('*', coef, dist.args[1]), num(2));
        variance = variance ? bin('+', variance, term) : term;
      }
      const sd: Expr = { kind: 'call', name: 'sqrt', args: [variance!] };
      return { kind: 'dist', dist: { kind: 'normal', args: [mean, sd] } };
    }
    if (bases.every(b => b.dist.kind === 'cauchy' && (numOf(b.coef) ?? 0) !== 0)) {
      // Stable with index 1: locations add like means, and SCALES add (not
      // their squares), each through |c| so a flip stays a scale.
      // Independence is the affine form's — X + X arrived as 2·X. Coefficients
      // are nonzero LITERALS, as in the Gamma and LogNormal rules: a slider at
      // 0 would make this Cauchy(d, 0), no distribution, where the variable is
      // really the constant d — which the quadrature tier draws as the atom
      // it is. (The older Normal rule does take sliders, and flattens at 0.)
      let location = af.c;
      let scale: Expr | null = null;
      for (const { coef, dist } of bases) {
        location = bin('+', location, bin('*', coef, dist.args[0]));
        const term = bin('*', call('abs', coef), dist.args[1]);
        scale = scale ? bin('+', scale, term) : term;
      }
      return { kind: 'dist', dist: { kind: 'cauchy', args: [location, scale!] } };
    }
    if (bases.length === 1) {
      const { coef, dist } = bases[0];
      if (dist.kind === 'uniform') {
        const e1 = bin('+', bin('*', coef, dist.args[0]), af.c);
        const e2 = bin('+', bin('*', coef, dist.args[1]), af.c);
        const args: Expr[] = [
          { kind: 'call', name: 'min', args: [e1, e2] },
          { kind: 'call', name: 'max', args: [e1, e2] },
        ];
        return { kind: 'dist', dist: { kind: 'uniform', args } };
      }
      if (dist.kind === 'lognormal') {
        // c·X with a positive literal c shifts mu by ln c; a shift, a flip
        // or a slider that could flip leaves the family, as for exponential.
        const c = numOf(coef);
        if (c !== null && c > 0 && numOf(af.c) === 0) {
          const mu = c === 1 ? dist.args[0] : bin('+', dist.args[0], num(Math.log(c)));
          return { kind: 'dist', dist: { kind: 'lognormal', args: [mu, dist.args[1]] } };
        }
        return null;
      }
      if (dist.kind === 'exponential') {
        // Only c·X with a positive literal c stays exponential (rate λ/c);
        // a shift or flip leaves the family, and a slider c could flip live.
        const c = numOf(coef);
        if (c !== null && c > 0 && numOf(af.c) === 0) {
          const rate = c === 1 ? dist.args[0] : bin('/', dist.args[0], num(c));
          return { kind: 'dist', dist: { kind: 'exponential', args: [rate] } };
        }
        return null;
      }
    }
    const gammaSum = this.gammaSumLaw(bases, af.c);
    if (gammaSum) return gammaSum;
    if (bases.every(b => b.dist.kind === 'uniform')) {
      return {
        kind: 'usum',
        terms: bases.map(b => ({ c: b.coef, lo: b.dist.args[0], hi: b.dist.args[1] })),
        d: af.c,
      };
    }
    return null;
  }

  /**
   * Σ cᵢXᵢ over independent Gamma-family bases (Gamma, ChiSquared, and
   * Exponential = Gamma(1, λ)) is Gamma(Σαᵢ, β) when every scaled rate βᵢ/cᵢ
   * is the same β and nothing is added. Independence is the affine form's:
   * shared names were merged into one coefficient before this runs, so X + X
   * arrives as 2·X — Gamma(α, β/2), never Gamma(2α, β). Coefficients must be
   * positive LITERALS, as for the exponential rule: a slider could cross 0
   * and leave the family live. Rates count as equal when they fold to the
   * same number or are the same expression (one slider b in both).
   */
  private gammaSumLaw(bases: Array<{ coef: Expr; dist: BaseDist }>, shift: Expr): Law | null {
    if (numOf(shift) !== 0) return null;
    let shape: Expr | null = null;
    let rate: Expr | null = null;
    let rateKey: string | null = null;
    for (const { coef, dist } of bases) {
      const c = numOf(coef);
      if (c === null || !(c > 0)) return null;
      let al: Expr;
      let be: Expr;
      if (dist.kind === 'gamma') [al, be] = dist.args;
      else if (dist.kind === 'chisquared') [al, be] = [bin('/', dist.args[0], num(2)), num(0.5)];
      else if (dist.kind === 'exponential') [al, be] = [num(1), dist.args[0]];
      else return null;
      const b = numOf(be);
      const key = b !== null ? `#${b / c}` : `${JSON.stringify(be)}/${c}`;
      if (rateKey !== null && key !== rateKey) return null;
      rateKey = key;
      rate ??= b !== null ? num(b / c) : c === 1 ? be : bin('/', be, num(c));
      shape = shape ? bin('+', shape, al) : al;
    }
    return shape && rate ? { kind: 'dist', dist: { kind: 'gamma', args: [shape, rate] } } : null;
  }

  /**
   * Z² for a STANDARD normal Z is ChiSquared(1). Standard means written so:
   * mean and sd that fold to exactly 0 and 1. A slider that happens to read
   * 1 now is not a standard normal — the law would be wrong one drag later —
   * so it keeps the quadrature tier, like every other nonlinear transform.
   * Only the bare square qualifies (Z^2 or Z·Z of one base variable);
   * Z1² + Z2² is a sum of two DERIVED terms the affine form cannot see.
   */
  private squareLaw(name: string): Law | null {
    const g = this.grounded(name);
    if (g?.kind !== 'bin') return null;
    let base: Expr | null = null;
    if (g.op === '^' && g.b.kind === 'num' && g.b.value === 2) base = g.a;
    else if (g.op === '*' && g.a.kind === 'var' && g.b.kind === 'var' && g.a.name === g.b.name) base = g.a;
    if (base?.kind !== 'var') return null;
    const rv = this.rvs.get(base.name);
    if (rv?.kind !== 'base' || rv.dist.kind !== 'normal') return null;
    if (numOf(rv.dist.args[0]) !== 0 || numOf(rv.dist.args[1]) !== 1) return null;
    return { kind: 'dist', dist: { kind: 'chisquared', args: [num(1)] } };
  }

  /** Why a base variable's parameters declare no distribution at these
   *  constants (a slider dragged to sd = 0), or null. A parameter that
   *  moves — t, a state, or a constant built on one (defs.ts
   *  animatedConstNames) — is not judged: it may be invalid at this instant
   *  and fine the next, so its density just flattens to 0 while it is. */
  paramProblem(name: string, env: Record<string, number>, moving: ReadonlySet<string>): string | null {
    const rv = this.rvs.get(name);
    if (rv?.kind !== 'base') return null;
    if ([...this.paramsOf(name)].some(n => n === 't' || moving.has(n) || !(n in env))) return null;
    try {
      return paramProblem(rv.dist.kind, rv.dist.args.map(e => evaluate(e, env)));
    } catch {
      return null;
    }
  }

  /** The exact law when it is a closed-form pdf the shader can draw — so
   *  never a discrete one (discreteDist), which has a pmf and draws as stems. */
  exactDist(name: string): BaseDist | null {
    const law = this.exactLaw(name);
    return law?.kind === 'dist' && !law.dist.discrete ? law.dist : null;
  }

  /**
   * The stems of a discrete variable over the visible x-range: one per whole
   * number of the support in view, clipped to where the law has mass (all but
   * 1e-12 per tail, so an unbounded support or a view a billion wide costs
   * nothing) and capped at STEM_MAX (see PmfStems.envelope). Rebuilt only
   * when the parameters or the whole-number window change: a still view costs
   * a cache hit per frame. Null while the parameters declare no distribution
   * — a slider n at 2.5 draws nothing, because nothing is there to draw.
   */
  stems(name: string, env: Record<string, number>, view?: { lo: number; hi: number }): { stems: PmfStems; law: DiscreteLaw } | null {
    const rv = this.rvs.get(name);
    if (rv?.kind !== 'base' || !rv.dist.discrete) return null;
    const slot = this.entry(name, this.sig(rv, env));
    if (slot.pmf === undefined) {
      const law = discreteLaw(rv.dist, env);
      slot.pmf = law && { law, kLo: law.quantile(STEM_TAIL), kHi: law.quantile(STEM_TAIL, true), key: '', stems: null };
    }
    const c = slot.pmf;
    if (!c || !isFinite(c.kLo) || !isFinite(c.kHi)) return null;
    const kLo = Math.max(c.kLo, view ? Math.ceil(view.lo) : -Infinity);
    const kHi = Math.min(c.kHi, view ? Math.floor(view.hi) : Infinity);
    const key = `${kLo},${kHi}`;
    if (!c.stems || c.key !== key) {
      c.key = key;
      c.stems = kLo <= kHi ? buildStems(c.law, kLo, kHi) : { ks: [], ps: [], envelope: false };
    }
    return { stems: c.stems, law: c.law };
  }

  /** Non-random free names of a P(…) body, through the variables it references. */
  bodyParams(e: Expr): Set<string> {
    const out = new Set<string>();
    for (const f of freeVars(e)) {
      if (this.rvs.has(f)) for (const p of this.paramsOf(f)) out.add(p);
      else out.add(f);
    }
    return out;
  }

  /** Serialized definition of a variable *and its dependencies*, so editing
   *  `X ~ …` invalidates the cached samples of `Y = X + 1` too. */
  private defSig(name: string, seen = new Set<string>()): string {
    const memo = this.defSigMemo.get(name);
    if (memo !== undefined) return memo;
    if (seen.has(name)) return '@cycle'; // validate() reports it; keep sigs total
    seen.add(name);
    const rv = this.rvs.get(name);
    let s: string;
    if (!rv) s = '@missing';
    else if (rv.kind === 'base') s = rv.dist.kind + JSON.stringify(rv.dist.args);
    else {
      s = JSON.stringify(rv.expr);
      for (const dep of [...freeVars(rv.expr)].sort()) {
        if (this.rvs.has(dep)) s += `|${dep}:${this.defSig(dep, seen)}`;
      }
    }
    this.defSigMemo.set(name, s);
    return s;
  }

  private sig(rv: RV, env: Record<string, number>): string {
    let s = this.defSig(rv.name);
    for (const p of [...this.paramsOf(rv.name)].sort()) {
      if (!(p in env)) throw new Error(`Unbound variable: ${p}`);
      s += `;${p}=${env[p]}`;
    }
    return s;
  }

  /** The cache slot for this variable at these parameter values; a stale
   *  signature drops every derived field at once. */
  private entry(name: string, sig: string): CacheEntry {
    const hit = this.cache.get(name);
    if (hit && hit.sig === sig) return hit;
    const fresh: CacheEntry = { sig };
    this.cache.set(name, fresh);
    return fresh;
  }

  /** The sample column for a variable under the given constants. */
  columns(name: string, env: Record<string, number>): Float64Array {
    const rv = this.rvs.get(name);
    if (!rv) throw new Error(`${name} has an error in its definition.`);
    const slot = this.entry(name, this.sig(rv, env));
    if (slot.col) return slot.col;
    let col: Float64Array;
    if (rv.kind === 'base') {
      // Unreachable through a document (add() and probability() refuse first);
      // loud all the same, because a NaN column would read as "no data".
      if (rv.dist.discrete) throw new Error(`${name} is discrete: sampling discrete random variables is not supported yet.`);
      const u = uniformStream(name);
      const a = rv.dist.args.map(e => evaluate(e, env));
      col = new Float64Array(SAMPLE_COUNT);
      switch (rv.dist.kind) {
        case 'normal':
          if (a[1] > 0) for (let i = 0; i < SAMPLE_COUNT; i++) col[i] = a[0] + a[1] * normalQuantile(u[i]);
          else col.fill(NaN);
          break;
        case 'uniform':
          if (a[1] > a[0]) for (let i = 0; i < SAMPLE_COUNT; i++) col[i] = a[0] + (a[1] - a[0]) * u[i];
          else col.fill(NaN);
          break;
        case 'exponential':
          if (a[0] > 0) for (let i = 0; i < SAMPLE_COUNT; i++) col[i] = -Math.log(1 - u[i]) / a[0];
          else col.fill(NaN);
          break;
        default: {
          const q = a.every(isFinite) ? zooQuantile(rv.dist.kind, a) : null;
          if (q) for (let i = 0; i < SAMPLE_COUNT; i++) col[i] = q(u[i]);
          else col.fill(NaN);
        }
      }
    } else {
      const cols = new Map<string, Float64Array>();
      for (const dep of freeVars(rv.expr)) {
        if (this.rvs.has(dep)) cols.set(dep, this.columns(dep, env));
      }
      col = evalCols(rv.expr, cols, env, SAMPLE_COUNT);
    }
    slot.col = col;
    return col;
  }

  /** Numeric piecewise polynomial of a usum law at these parameter values. */
  private usumPP(law: Law & { kind: 'usum' }, env: Record<string, number>): PPoly | null {
    let acc: PPoly | null = null;
    const shift = evaluate(law.d, env);
    if (!isFinite(shift)) return null;
    for (const t of law.terms) {
      const c = evaluate(t.c, env);
      const lo = evaluate(t.lo, env);
      const hi = evaluate(t.hi, env);
      if (!isFinite(c) || !(hi > lo)) return null;
      if (c === 0) continue; // a slider zeroed this term: it contributes nothing
      const box = scalePP(uniformPP(lo, hi), c, 0);
      acc = acc ? convPP(acc, box) : box;
    }
    if (!acc) return null; // every coefficient zero: a constant, nothing to draw
    return shift !== 0 ? scalePP(acc, 1, shift) : acc;
  }

  /**
   * The density curve for a variable, by the cheapest honest tier: the
   * *exact* piecewise polynomial when its law is a uniform convolution, the
   * deterministic conditional-CDF curve for transforms of one or two
   * independent bases, the sample estimate as the last resort. (Rows whose
   * law is a closed-form pdf never come here — they draw through the
   * shader.)
   *
   * A quadrature-tier curve is view-aware: when the viewport zooms deep
   * into the drawn window, the visible stretch re-rasterizes at full grid
   * resolution from the cached base (~1ms) and splices into the global
   * polyline, so zooming reveals the density's true shape rather than the
   * grid's cells. The zoomed range carries ×3 pan headroom and recomputes
   * only when the view leaves it or outgrows its resolution.
   */
  curve(
    name: string,
    env: Record<string, number>,
    view?: { lo: number; hi: number },
  ): DensityCurve | null {
    const c = this.rawCurve(name, env, view);
    // One verdict per variable: a mean that quadrature certified (absolutely
    // convergent, see quadMoments) exists, whatever a tail-index estimate
    // near its bar made of it.
    if (!c?.robust || c.robust.meanOk || !this.quadMoments(name, env)) return c;
    const slot = this.cache.get(name)!;
    if (slot.certified?.from !== c) slot.certified = { from: c, curve: { ...c, robust: { ...c.robust, meanOk: true } } };
    return slot.certified.curve;
  }

  private rawCurve(
    name: string,
    env: Record<string, number>,
    view?: { lo: number; hi: number },
  ): DensityCurve | null {
    const law = this.exactLaw(name);
    if (law?.kind === 'usum') {
      const rv = this.rvs.get(name)!;
      const slot = this.entry(name, this.sig(rv, env));
      if (slot.curve === undefined) {
        const pp = this.usumPP(law, env);
        const m = this.exactMoments(name, env);
        slot.curve = pp && m ? { pts: curvePP(pp), mean: m.mean, sd: m.sd, mass: 1 } : null;
      }
      return slot.curve;
    }
    const rv = this.rvs.get(name);
    if (!rv) throw new Error(`${name} has an error in its definition.`);
    if (rv.kind === 'base' && rv.dist.discrete) return null; // no density: stems() draws it
    const slot = this.entry(name, this.sig(rv, env));
    if (slot.qcb === undefined) slot.qcb = this.condBase(name, env);
    const base = slot.qcb;
    if (base) {
      if (slot.qc === undefined) slot.qc = condAssemble(base);
      const full = slot.qc!;
      const win = base.window;
      if (!view || !win) return full;
      const visLo = Math.max(view.lo, win.lo);
      const visHi = Math.min(view.hi, win.hi);
      const visSpan = visHi - visLo;
      const fullSpan = win.hi - win.lo;
      if (!(visSpan > 0) || visSpan >= 0.35 * fullSpan) return full;
      const z = slot.qcz;
      if (z && visLo >= z.lo && visHi <= z.hi && visSpan >= 0.15 * (z.hi - z.lo)) {
        return z.curve;
      }
      // Densify around the view, floored so differencing never outruns the
      // base grid's own sample resolution.
      const span = Math.max(3 * visSpan, fullSpan / QC_ZOOM_MAX);
      const mid = (visLo + visHi) / 2;
      const zLo = Math.max(win.lo, mid - span / 2);
      const zHi = Math.min(win.hi, mid + span / 2);
      const zoomPts = condDensity(base, zLo, zHi);
      const fp = full.pts;
      const pts: number[] = [];
      for (let i = 0; i + 1 < fp.length; i += 2) if (fp[i] < zLo) pts.push(fp[i], fp[i + 1]);
      if (!pts.length && win.hardLo && zLo <= win.lo) pts.push(win.lo, 0);
      pts.push(...zoomPts);
      const tail: number[] = [];
      for (let i = 0; i + 1 < fp.length; i += 2) if (fp[i] > zHi) tail.push(fp[i], fp[i + 1]);
      if (!tail.length && win.hardHi && zHi >= win.hi) tail.push(win.hi, 0);
      pts.push(...tail);
      const curve = { ...full, pts };
      slot.qcz = { lo: zLo, hi: zHi, curve };
      return curve;
    }
    const col = this.columns(name, env);
    const entry = this.cache.get(name)!;
    if (entry.est === undefined) entry.est = estimateCurve(col, this.heavyBase(name, env));
    return entry.est;
  }

  /** The conditional-CDF quadrature base for a derived variable over one
   *  or two independent bases, or null when that tier does not apply. */
  private condBase(name: string, env: Record<string, number>): QCBase | null {
    const rv = this.rvs.get(name);
    if (rv?.kind !== 'derived') return null;
    const g = this.grounded(name);
    if (!g) return null;
    const bases = [...freeVars(g)].filter(n => this.rvs.has(n)).sort();
    if (!bases.length || bases.length > 2) return null;
    const vars: Array<{ name: string; quantile: (u: number) => number }> = [];
    for (const n of bases) {
      const b = this.rvs.get(n)!;
      if (b.kind !== 'base') return null;
      const quantile = quantileClosure(b.dist, env);
      if (!quantile) return null;
      vars.push({ name: n, quantile });
    }
    try {
      return conditionalBase(g, vars, env, this.heavyBase(name, env));
    } catch {
      return null; // unbound parameter or broken expression: the sampled tier reports it
    }
  }

  /** Exact mean and sd under the variable's law, or null when sampled. */
  exactMoments(name: string, env: Record<string, number>): { mean: number; sd: number } | null {
    const law = this.exactLaw(name);
    if (!law) return null;
    if (law.kind === 'dist') {
      if (law.dist.discrete) {
        const dl = discreteLaw(law.dist, env);
        return dl && { mean: dl.mean, sd: dl.sd };
      }
      const a = law.dist.args.map(e => evaluate(e, env));
      switch (law.dist.kind) {
        case 'normal':
          return a[1] > 0 ? { mean: a[0], sd: a[1] } : null;
        case 'uniform':
          return a[1] > a[0] ? { mean: (a[0] + a[1]) / 2, sd: (a[1] - a[0]) / Math.sqrt(12) } : null;
        case 'exponential':
          return a[0] > 0 ? { mean: 1 / a[0], sd: 1 / a[0] } : null;
      }
      if (!a.every(isFinite) || paramProblem(law.dist.kind, a)) return null;
      // A moment that does not exist is NaN and an infinite one Infinity —
      // said, not estimated: a Cauchy sample mean is a confident wrong number.
      switch (law.dist.kind) {
        case 'gamma':
          return { mean: a[0] / a[1], sd: Math.sqrt(a[0]) / a[1] };
        case 'chisquared':
          return { mean: a[0], sd: Math.sqrt(2 * a[0]) };
        case 'beta': {
          const n = a[0] + a[1];
          return { mean: a[0] / n, sd: Math.sqrt((a[0] * a[1]) / (n + 1)) / n };
        }
        case 'studentt':
          return {
            mean: a[0] > 1 ? 0 : NaN,
            sd: a[0] > 2 ? Math.sqrt(a[0] / (a[0] - 2)) : a[0] > 1 ? Infinity : NaN,
          };
        case 'lognormal': {
          const mean = Math.exp(a[0] + (a[1] * a[1]) / 2);
          return { mean, sd: mean * Math.sqrt(Math.expm1(a[1] * a[1])) };
        }
        case 'cauchy':
          return { mean: NaN, sd: NaN };
        case 'weibull': {
          // σ² = λ²(Γ₂ − Γ₁²) = λ²Γ₂(1 − Γ₁²/Γ₂), in logs: for a small shape
          // Γ(1 + 2/k) overflows long before σ does, and ∞ − ∞ is NaN. What is
          // left to overflow is the true value passing double range: Infinity.
          const l1 = lgamma(1 + 1 / a[0]);
          const l2 = lgamma(1 + 2 / a[0]);
          return {
            mean: a[1] * Math.exp(l1),
            sd: a[1] * Math.exp(l2 / 2) * Math.sqrt(Math.max(-Math.expm1(2 * l1 - l2), 0)),
          };
        }
        default:
          return null;
      }
    }
    let mean = evaluate(law.d, env);
    let variance = 0;
    for (const t of law.terms) {
      const c = evaluate(t.c, env);
      const lo = evaluate(t.lo, env);
      const hi = evaluate(t.hi, env);
      if (!isFinite(c) || !(hi > lo)) return null;
      mean += (c * (lo + hi)) / 2;
      variance += (c * (hi - lo)) ** 2 / 12;
    }
    return isFinite(mean) ? { mean, sd: Math.sqrt(variance) } : null;
  }

  /** The variable's expression with every derived dependency inlined, so
   *  only base variables and parameters remain — or null when the expansion
   *  blows up (shared subtrees duplicate under substitution). */
  private grounded(name: string): Expr | null {
    const memo = this.groundedMemo.get(name);
    if (memo !== undefined) return memo;
    const rv = this.rvs.get(name);
    let e: Expr | null = rv?.kind === 'derived' ? rv.expr : null;
    // Dependencies are acyclic (validate() dropped cycles); the guard bounds
    // pathological chains and substitution blowup all the same.
    for (let guard = 0; e && guard < 32; guard++) {
      const sub: Record<string, Expr> = {};
      for (const n of freeVars(e)) {
        const dep = this.rvs.get(n);
        if (dep?.kind === 'derived') sub[n] = dep.expr;
      }
      if (!Object.keys(sub).length) break;
      e = substVars(e, sub);
      if (JSON.stringify(e).length > 200_000) e = null;
    }
    this.groundedMemo.set(name, e);
    return e;
  }

  /**
   * Moments by numeric integration against the base law: for Y = g(X) with a
   * single base dependency, E[g(X)] = ∫ g(x)·pdf(x) dx by adaptive
   * quadrature (integrate.ts) — ~9 significant digits where the sample mean
   * gives ~3. Undefined regions of g drop out of both the numerator and the
   * mass, matching the sampler's "average where defined" convention. sd is
   * Infinity when the mean settles but the second moment does not. Null
   * for joint dependence (E[X·Y] still samples), broken parameters, or
   * integrals that fail to settle (heavy tails).
   */
  quadMoments(name: string, env: Record<string, number>): { mean: number; sd: number; mass: number } | null {
    const rv = this.rvs.get(name);
    if (rv?.kind !== 'derived') return null; // base laws: exactMoments has them
    const slot = this.entry(name, this.sig(rv, env));
    if (slot.qm !== undefined) return slot.qm;
    const compute = (): { mean: number; sd: number; mass: number } | null => {
      const g = this.grounded(name);
      if (!g) return null;
      const bases = [...freeVars(g)].filter(n => this.rvs.has(n));
      const base = bases.length === 1 ? this.rvs.get(bases[0])! : null;
      if (base?.kind !== 'base') return null;
      let pc: ReturnType<typeof pdfClosure>;
      try {
        pc = pdfClosure(base.dist, env);
      } catch {
        return null;
      }
      if (!pc) return null;
      const gAt = (x: number): number => {
        try {
          return evaluate(g, { ...env, [base.name]: x });
        } catch {
          return NaN;
        }
      };
      const { pdf, lo, hi, mid } = pc;
      // k = 'abs' is E|g|: the test that a mean exists at all.
      const moment = (k: 0 | 1 | 2 | 'abs'): number => {
        const f = (x: number): number => {
          const v = gAt(x);
          if (!isFinite(v)) return 0;
          return (k === 0 ? 1 : k === 1 ? v : k === 2 ? v * v : Math.abs(v)) * pdf(x);
        };
        return mid !== undefined && mid > lo && mid < hi && isFinite(mid)
          ? quadrature(f, lo, mid) + quadrature(f, mid, hi)
          : quadrature(f, lo, hi);
      };
      const mass = moment(0);
      if (!(mass > 1e-9)) return null;
      const m1 = moment(1);
      const m2 = moment(2);
      if (!isFinite(m1)) return null;
      const mean = m1 / mass;
      if (isFinite(m2)) return { mean, sd: Math.sqrt(Math.max(m2 / mass - mean * mean, 0)), mass };
      // The second moment did not settle. That is σ = ∞ (X² over StudentT(3):
      // E = 3) only if it DIVERGES — quadrature says NaN just the same for a
      // finite integral it ran out of budget on (X^-0.45 over a uniform, a g
      // with a hundred jumps), and those keep the old answer: no quadrature
      // moments, the curve's estimate instead. And the mean stands only if
      // it converged ABSOLUTELY: X³ over a Cauchy integrates to a clean 0 by
      // symmetry and has no mean at all.
      const q = quantileClosure(base.dist, env);
      if (!q || !diverges(x => gAt(x) ** 2, q)) return null;
      return isFinite(moment('abs')) ? { mean, sd: Infinity, mass } : null;
    };
    slot.qm = compute();
    return slot.qm;
  }

  /** The mean of a variable: exact under its law when one is derivable,
   *  quadrature against the base pdf for one-variable transforms, otherwise
   *  the curve's mean (quadrature-grade for conditional-CDF curves, the
   *  finite-sample mean for estimates; NaN when nothing is finite, or when
   *  the mean does not exist or cannot be estimated — see meanUnstable). */
  mean(name: string, env: Record<string, number>): number {
    const m = this.exactMoments(name, env) ?? this.quadMoments(name, env);
    if (m) return m.mean;
    if (this.discreteDist(name)) return NaN; // invalid parameters; there is no sample to fall back on
    const c = this.curve(name, env);
    // Heavy tails (E(X^2) of a Cauchy): the sample mean is whatever the
    // largest draw happened to be. NaN, and meanUnstable() says why.
    if (c) return c.robust && !c.robust.meanOk ? NaN : c.mean;
    const col = this.columns(name, env);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < col.length; i++) {
      if (isFinite(col[i])) {
        sum += col[i];
        n++;
      }
    }
    return n ? sum / n : NaN;
  }

  /**
   * What a derived row's readout says, decided in one place: exact μ, σ under
   * a closed law; median/IQR where the tails make σ (and, unless `meanOk`,
   * μ) a truncation artifact; otherwise the best estimate — quadrature where
   * it settled, the curve's moments elsewhere. Null when nothing computes.
   */
  moments(name: string, env: Record<string, number>):
    | { kind: 'exact' | 'estimate'; mean: number; sd: number; mass: number }
    | { kind: 'robust'; median: number; iqr: number; meanOk: boolean; mass: number }
    | null {
    const m = this.exactMoments(name, env);
    if (m && isFinite(m.mean) && isFinite(m.sd)) return { kind: 'exact', ...m, mass: 1 };
    const qm = this.quadMoments(name, env);
    if (qm && isFinite(qm.sd)) return { kind: 'estimate', ...qm };
    const c = this.curve(name, env);
    if (c?.robust) return { kind: 'robust', ...c.robust, mass: c.mass };
    if (qm) return { kind: 'estimate', ...qm }; // a certified mean, σ = ∞
    return c && { kind: 'estimate', mean: c.mean, sd: c.sd, mass: c.mass };
  }

  /** Why mean() is NaN, when the reason is the law and not the parameters:
   *  the mean does not exist (Cauchy, StudentT with df ≤ 1), or the tails are
   *  heavy enough that any estimate of it is a truncation artifact. */
  meanUnstable(name: string, env: Record<string, number>): boolean {
    const m = this.exactMoments(name, env);
    if (m) return Number.isNaN(m.mean);
    if (this.quadMoments(name, env)) return false;
    const r = this.curve(name, env)?.robust;
    return !!r && !r.meanOk;
  }

  /** What the base laws a variable is built from say about its tails, known
   *  before any sample is looked at (see HeavyBase). The law's ANALYTIC tail,
   *  never a computed moment: Weibull(0.004, 1) has every moment, yet its σ
   *  overflows a double. */
  private heavyBase(name: string, env: Record<string, number>): HeavyBase {
    let level: HeavyBase = 0;
    const seen = new Set<string>();
    const walk = (n: string): void => {
      if (seen.has(n)) return;
      seen.add(n);
      const rv = this.rvs.get(n);
      if (!rv) return;
      if (rv.kind === 'derived') {
        for (const dep of freeVars(rv.expr)) walk(dep);
        return;
      }
      let df = Infinity;
      if (rv.dist.kind === 'cauchy') df = 1;
      else if (rv.dist.kind === 'studentt') {
        try {
          df = evaluate(rv.dist.args[0], env);
        } catch { /* unbound parameter: the caller reports it */ }
      }
      const tail: HeavyBase = df <= 1 ? 2 : df <= 2 ? 1 : 0;
      if (tail > level) level = tail;
    };
    walk(name);
    return level;
  }

  /** Exact P(lo < name < hi) under the variable's law, or null when sampled.
   *  `edges` matters to a discrete law only (see probabilityValue). */
  exactProbability(
    name: string,
    lo: Expr | undefined,
    hi: Expr | undefined,
    env: Record<string, number>,
    edges?: Pick<ProbBounds, 'loStrict' | 'hiStrict' | 'not'>,
  ): number | null {
    const law = this.exactLaw(name);
    if (!law) return null;
    if (law.kind === 'dist') return probabilityValue(law.dist, lo, hi, env, edges);
    const pp = this.usumPP(law, env);
    if (!pp) return NaN;
    const total = cdfPP(pp, pp.breaks[pp.breaks.length - 1]);
    return (hi ? cdfPP(pp, evaluate(hi, env)) : total) - (lo ? cdfPP(pp, evaluate(lo, env)) : 0);
  }

  /**
   * Monte Carlo estimate of P(body): the fraction of joint samples where the
   * inequality holds. Samples where it is undefined count as "not the event";
   * NaN when it is undefined everywhere (broken parameters).
   */
  probability(body: Expr, env: Record<string, number>): number {
    this.refuseDiscrete(body);
    const cols = new Map<string, Float64Array>();
    for (const f of freeVars(body)) {
      if (this.rvs.has(f)) cols.set(f, this.columns(f, env));
    }
    const mask = evalCols(body, cols, env, SAMPLE_COUNT);
    let count = 0;
    let defined = 0;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      if (!Number.isNaN(mask[i])) {
        defined++;
        if (mask[i] === 1) count++;
      }
    }
    return defined ? count / SAMPLE_COUNT : NaN;
  }
}

// --- building the system from scanned rows ---

export interface BuildRVOpts {
  fnNames: ReadonlySet<string>;
  getFn: GetFn;
  ropts?: ResolveOpts;
  constNames: ReadonlySet<string>;
  /** Name already claimed by a definition row (constant, function, field, …). */
  taken: (name: string) => boolean;
}

export interface BuiltRVs {
  /** Every declared name, healthy or not — the set P(…) and bare rows resolve against. */
  names: ReadonlySet<string>;
  /** Row index → the variable it declares. */
  rowRV: Map<number, string>;
  /** Row index → error message, for rows whose declaration failed. */
  errors: Map<number, string>;
}

/**
 * Rebuild `sys` from the scanned rows: parse and resolve each declaration,
 * reject name collisions, then drop definition cycles and everything that
 * depends on a failed variable, reporting per-row errors. Shared by the app
 * and the worker so both accept exactly the same documents.
 */
export function buildRVSystem(sys: RVSystem, scan: ReturnType<typeof scanRandomRows>, opts: BuildRVOpts): BuiltRVs {
  sys.reset();
  const names = new Set([...scan.base.values(), ...scan.derived.values()].map(d => d.name));
  const rowRV = new Map<number, string>();
  const errors = new Map<number, string>();
  const rowOf = new Map<string, number>();

  const claim = (i: number, name: string): boolean => {
    rowRV.set(i, name);
    // Late-addition builtins (gamma, sinc, …) stay claimable: a graph saved
    // before they existed may use one as a random variable name.
    const builtin = builtinFn(name);
    if (RESERVED.has(name) || (builtin && !SHADOWABLE_FNS.has(builtin))) {
      errors.set(i, `Cannot use ${name} as a random variable name.`);
    } else if (sys.has(name) || opts.taken(name)) {
      errors.set(i, `${name} is already defined.`);
    } else {
      rowOf.set(name, i);
      return true;
    }
    return false;
  };

  for (const [i, { name, rhs }] of scan.base) {
    if (!claim(i, name)) continue;
    try {
      const d = parseDistribution(rhs, opts.fnNames);
      d.args = d.args.map(a => resolveExpr(a, opts.getFn, opts.ropts));
      for (const a of d.args) {
        for (const f of freeVars(a)) {
          if (names.has(f)) throw new Error('Distribution parameters cannot depend on a random variable.');
        }
        checkDerived(a, new Set(), opts.constNames);
      }
      sys.add({ name, kind: 'base', dist: d });
    } catch (e) {
      errors.set(i, e instanceof Error ? e.message : String(e));
    }
  }
  for (const [i, { name, rhs }] of scan.derived) {
    if (!claim(i, name)) continue;
    try {
      const expr = resolveExpr(parseExpr(rhs, opts.fnNames), opts.getFn, opts.ropts);
      checkDerived(expr, names, opts.constNames);
      sys.add({ name, kind: 'derived', expr });
    } catch (e) {
      errors.set(i, e instanceof Error ? e.message : String(e));
    }
  }

  // Cycles, then the ripple: a variable whose dependency failed fails too.
  const failed = sys.validate();
  for (const name of failed.keys()) sys.delete(name);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of rowOf.keys()) {
      const rv = sys.get(name);
      if (rv?.kind !== 'derived') continue;
      for (const dep of freeVars(rv.expr)) {
        if (names.has(dep) && !sys.has(dep)) {
          failed.set(name, `${dep} has an error in its definition.`);
          sys.delete(name);
          changed = true;
          break;
        }
      }
    }
  }
  for (const [name, message] of failed) {
    const row = rowOf.get(name);
    if (row !== undefined && !errors.has(row)) errors.set(row, message);
  }
  return { names, rowRV, errors };
}
