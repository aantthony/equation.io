/**
 * Base distributions, probability rows, and the scan of `X ~ …` lines.
 */
import {
  BETA_PDF_FN,
  BINOM_PMF_FN,
  DUNIFORM_PMF_FN,
  type Expr,
  GAMMA_PDF_FN,
  NEGBINOM_PMF_FN,
  POISSON_PMF_FN,
  T_PDF_FN,
  WEIBULL_PDF_FN,
  canonicalName,
  evaluate,
  freeVars,
  ineqComparisons,
  NAME_SRC,
  normalcdf,
  parseExpr,
} from './expr.ts';
import { WHOLE_EXPR_NAMES, usesComplex } from './complex.ts';
import { GEOM_STATEMENTS } from './geom.ts';
import type { Classified } from './math-object.ts';
import { nameable } from './defs.ts';
import { type BaseKind, DIST_FAMILIES, distFamily, distUsage, familyOf } from './dist-families.ts';
import { betaPQ, gammaPQ, normalPQ, studentTPQ, wholeNumber } from './specfn.ts';
import { discreteLaw } from './dist-discrete.ts';
import { numOf, type RVSystem } from './dist-system.ts';

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
  args: readonly Expr[];
}

/** A law on the whole numbers: it has a pmf (pmfExpr, stems), a step cdf whose
 *  strict and non-strict bounds differ, and no density for a shader. Read off
 *  the family table — the one place that says so — never stored on the value. */
export const isDiscrete = (d: BaseDist): boolean => !!familyOf(d.kind).discrete;

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

/** Every name in a row's text, for reference scanning. */
const NAME_SCAN_RE = new RegExp(NAME_SRC, 'g');

const TILDE_RE = new RegExp(String.raw`^\s*(${NAME_SRC})\s*~\s*([\s\S]+)$`);
const DIST_RE = new RegExp(String.raw`^\s*(${NAME_SRC})\s*(?:\(([\s\S]*)\))?\s*$`);
const PROB_RE = /^\s*P\s*\(([\s\S]+)\)\s*$/;
const EXPECT_RE = /^\s*E\s*\(([\s\S]+)\)\s*$/;
const CONST_ROW_RE = new RegExp(String.raw`^\s*(${NAME_SRC})\s*=(?!=)([\s\S]+)$`);

/** Detect a `name ~ rhs` row before parsing ('~' is not an expression token). */
export function scanDistribution(text: string): { name: string; rhs: string } | null {
  const m = TILDE_RE.exec(text);
  return m ? { name: canonicalName(m[1]), rhs: m[2] } : null;
}

/**
 * Names (lib/dist-families.ts) are matched case-insensitively and live in
 * their own namespace, the right side of `~`, so they collide with nothing a
 * document defines: a constant T or a function gamma(x) leaves `X ~ T(5)` and
 * `X ~ Gamma(2, 1)` alone.
 */
const DIST_HINT = `Try ${DIST_FAMILIES.map((f, k, all) => (k === all.length - 1 ? 'or ' : '') + distUsage(f)).join(', ')}.`;

/** Parse the right side of `name ~ …`. Throws with a row-friendly message. */
export function parseDistribution(
  rhs: string,
  fnNames: ReadonlySet<string>,
  valueNames: ReadonlySet<string> = new Set(),
): BaseDist {
  const m = DIST_RE.exec(rhs);
  const spec = m && distFamily(m[1]);
  if (!m || !spec) {
    throw new Error(
      m && !distFamily(m[1])
        ? `Unknown distribution: ${m[1]}. ${DIST_HINT}`
        : 'Expected a distribution like Normal(0, 1).',
    );
  }
  const arity = spec.params.length;
  const arityError = `${distUsage(spec)} takes ${arity} argument${arity > 1 ? 's' : ''}.`;
  // A bare name takes the standard parameters: `X ~ N` is Normal(0, 1).
  if (m[2] === undefined) {
    if (!spec.defaults) throw new Error(arityError);
    return { kind: spec.kind, args: spec.defaults.map(value => ({ kind: 'num', value })) };
  }
  let args: Expr;
  try {
    args = parseExpr(`(${m[2]})`, fnNames, undefined, valueNames);
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
  return { kind: spec.kind, args: items };
}

export const v = (name: string): Expr => ({ kind: 'var', name });
export const num = (value: number): Expr => ({ kind: 'num', value });
export const bin = (op: '+' | '-' | '*' | '/' | '^', a: Expr, b: Expr): Expr => ({ kind: 'bin', op, a, b });
const chain = (lo: Expr, mid: Expr, hi: Expr): Expr => ({
  kind: 'ineq',
  op: '<',
  l: { kind: 'ineq', op: '<', l: lo, r: mid },
  r: hi,
});
export const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const positive = (e: Expr): Expr => ({ kind: 'ineq', op: '>', l: e, r: num(0) });
/** `value` where every condition holds, 0 elsewhere (nested piecewise = AND). */
const whereAll = (conds: Expr[], value: Expr): Expr =>
  conds.reduceRight<Expr>(
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
  const c = canonicalDiscrete(d);
  return c && call(c.fn, c.shift ? bin('-', k, num(c.shift)) : k, ...c.args);
}

/**
 * The discrete families reduced to the four that have an implementation, ONCE:
 * Bernoulli(p) is Binomial(1, p), and Geometric(p) — trials, from 1 — is
 * 1 + NegativeBinomial(1, p). Everything downstream (pmfExpr, the cdf, the
 * law's moments, quantile and stems, and the enumeration of derived variables) reads this and
 * applies `shift`; none of them names Bernoulli or Geometric again. Messages
 * are not built from it: validation judges the family the user wrote.
 */
type CoreKind = 'binomial' | 'poisson' | 'negbinomial' | 'discreteuniform';
export function canonicalDiscrete(
  d: BaseDist,
): { kind: CoreKind; fn: string; args: readonly Expr[]; shift: number } | null {
  switch (d.kind) {
    case 'binomial':
      return { kind: 'binomial', fn: BINOM_PMF_FN, args: d.args, shift: 0 };
    case 'bernoulli':
      return { kind: 'binomial', fn: BINOM_PMF_FN, args: [num(1), d.args[0]], shift: 0 };
    case 'poisson':
      return { kind: 'poisson', fn: POISSON_PMF_FN, args: d.args, shift: 0 };
    case 'geometric':
      return { kind: 'negbinomial', fn: NEGBINOM_PMF_FN, args: [num(1), d.args[0]], shift: 1 };
    case 'negbinomial':
      return { kind: 'negbinomial', fn: NEGBINOM_PMF_FN, args: d.args, shift: 0 };
    case 'discreteuniform':
      return { kind: 'discreteuniform', fn: DUNIFORM_PMF_FN, args: d.args, shift: 0 };
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
        cases: [
          {
            cond: { kind: 'ineq', op: '>=', l: x, r: num(0) },
            value: bin('*', r, { kind: 'call', name: 'exp', args: [{ kind: 'neg', a: bin('*', r, x) }] }),
          },
        ],
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
      return whereAll(
        [positive(d.args[1]), positive(x)],
        bin('/', call('normalpdf', call('ln', x), d.args[0], d.args[1]), x),
      );
    case 'cauchy': {
      const z = bin('/', bin('-', x, d.args[0]), d.args[1]);
      return whereAll(
        [positive(d.args[1])],
        bin('/', num(1), bin('*', bin('*', num(Math.PI), d.args[1]), bin('+', num(1), bin('*', z, z)))),
      );
    }
    default:
      throw new Error(`${familyOf(d.kind).name} has no density.`); // discrete: answered by pmfExpr above
  }
}

const NO_DENSITY = 'A discrete distribution has no density curve: it draws as stems.';

/** The density curve for a base random variable: y = pdf(x). */
export function densityExpr(d: BaseDist): Expr {
  if (isDiscrete(d)) throw new Error(NO_DENSITY);
  return { kind: 'eq', l: v('y'), r: pdfExpr(d, v('x')) };
}

/**
 * How the row of a variable — declared, derived, or the anonymous one of a
 * bare `X + Y` — draws, decided once for the app and analyze(): a pmf as stems
 * when it is built on discrete bases alone; the exact density `y = pdf(x)`
 * (the caller classifies it for the shader) when its law is a closed-form pdf
 * — a continuous declaration, or a derived variable a closure rule reduces
 * (affine in normals, a scaled uniform/exponential, a Gamma-family sum, the
 * square of a standard normal); else a density drawn on the CPU (a uniform
 * sum's exact piecewise polynomial, the quadrature curve, the sample estimate).
 */
export function variableRow(
  sys: RVSystem,
  name: string,
): { kind: 'pmf' | 'density'; cls: Classified } | { kind: 'exact'; density: Expr } {
  const discrete = sys.isDiscreteVar(name);
  const exact = discrete ? null : sys.exactDist(name);
  if (exact) return { kind: 'exact', density: densityExpr(exact) };
  const ps = sys.paramsOf(name);
  const kind = discrete ? 'pmf' : 'density';
  return {
    kind,
    cls: {
      object: { kind: 'distribution', form: kind, rv: name },
      animated: ps.has('t'),
      needs3D: false,
      params: [...ps].filter(p => p !== 't'),
    },
  };
}

/** A derived row's readout, from RVSystem.moments' verdict: `μ = …, σ = …`
 *  under an exact law, `≈` for an estimate, median/IQR where the tails make
 *  μ and σ truncation artifacts; then what part of the mass is defined, and
 *  the verdict's note (a sampled pmf says so). One wording for the app and
 *  analyze(). */
export function momentsReadout(m: NonNullable<ReturnType<RVSystem['moments']>>): string {
  const about = (x: number): string => readoutNumber(x, 3);
  return (
    (m.kind === 'exact'
      ? `μ = ${readoutNumber(m.mean)}, σ = ${readoutNumber(m.sd)}`
      : m.kind === 'robust'
        ? `median ≈ ${about(m.median)}, IQR ≈ ${about(m.iqr)} (heavy tails: ${m.meanOk ? 'σ' : 'μ, σ'} unstable)`
        : `μ ≈ ${about(m.mean)}, σ ${isFinite(m.sd) ? `≈ ${about(m.sd)}` : m.sd === Infinity ? '= ∞' : 'unstable'}`) +
    (m.mass < 0.9995 ? `, P(defined) ≈ ${m.mass.toFixed(3)}` : '') +
    (m.note ? ` (${m.note})` : '')
  );
}

/** A readout's number: to `places` decimals while that is a number a reader
 *  can take in, else (and without `places`) six significant digits — toFixed
 *  of 1.17e49 is forty-nine digits, and past 1e21 a raw exponent string. */
export function readoutNumber(x: number, places?: number): string {
  return places !== undefined && Math.abs(x) < 1e15 ? x.toFixed(places) : String(parseFloat(x.toPrecision(6)));
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
  /** The body is a point event (`=`, `==`, `!=`): only discrete variables
   *  have those (RVSystem.checkProbability). */
  point?: boolean;
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
  if (e.kind === 'eqtest' && e.args.length === 2) {
    return { ...e, args: [lower(e.args[0]), lower(e.args[1])] };
  }
  return lower(e);
}

const POINT_SHAPE = 'P(… = …) compares single values, like P(X = 3) or P(X = Y).';

/** Interpret a parsed P(…) body against the declared random variables. */
export function toProbability(e: Expr, rvNames: ReadonlySet<string>): ProbSpec {
  // `=` parses as an equation, `==` and `!=` as the filter comparisons.
  const point =
    e.kind === 'eq'
      ? { l: e.l, r: e.r, not: false }
      : e.kind === 'eqtest' && e.args.length === 2
        ? { l: e.args[0], r: e.args[1], not: e.op === '!=' }
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
    const scalar = (t: Expr): boolean => t.kind !== 'vec' && t.kind !== 'ineq' && t.kind !== 'eq' && t.kind !== 'list';
    if (!scalar(point.l) || !scalar(point.r)) throw new Error(POINT_SHAPE);
    // Random on both sides (`P(X = Y)`): a joint event, like `P(X > Y)`.
    if (bearing(point.l) && bearing(point.r)) return { body: e, rvs, point: true };
    const [t, at] = bearing(point.l) ? [point.l, point.r] : [point.r, point.l];
    const bounds: ProbBounds = { lo: at, hi: at, point: true, ...(point.not ? { not: true } : {}) };
    return t.kind === 'var'
      ? { body: e, rvs, point: true, single: { rv: t.name, ...bounds } }
      : { body: e, rvs, point: true, inline: { e: t, ...bounds } };
  }
  const comps = ineqComparisons(e as Expr & { kind: 'ineq' });
  if (new Set(comps.map(c => c.op[0])).size > 1) {
    throw new Error('Chained inequalities must point the same way.');
  }
  // Normalize to ascending order so the terms read lo … X … hi; each
  // comparison keeps whether it was strict.
  const asc = comps.map(c => ({
    ...(c.op[0] === '<' ? { l: c.l, r: c.r } : { l: c.r, r: c.l }),
    strict: c.op.length === 1,
  }));
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
  if (isDiscrete(d)) throw new Error(NO_DENSITY);
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
    default: // discrete (probabilityValue answers those itself; kept total)
      return discreteLaw(d, env)?.pq(x) ?? [NaN, NaN];
  }
}

/** The whole numbers a P(…) over a discrete variable selects: kLo ≤ X ≤ kHi
 *  (either may be infinite; empty when kLo > kHi), or with `not` all the rest.
 *  This is where strictness lands: `X < 3` ends at 2, `X <= 3` at 3,
 *  `X < 2.5` and `X <= 2.5` both at 2. NaN bounds (a broken parameter) stay NaN. */
export function integerBounds(b: ProbBounds, env: Record<string, number>): { kLo: number; kHi: number; not: boolean } {
  // A bound within rounding of a whole number IS that number, by the same
  // tolerance the parameters get (wholeNumber): `a = 0.1·3·10` is 3, so
  // `X < a` stops at 2 — floor(3.0000000000000004) + strictness would take 3.
  const snap = (x: number): number => {
    const w = wholeNumber(x);
    return Number.isNaN(w) ? x : w;
  };
  const lo = snap(b.lo ? evaluate(b.lo, env) : -Infinity);
  const hi = snap(b.hi ? evaluate(b.hi, env) : Infinity);
  return {
    kLo: b.loStrict ? Math.floor(lo) + 1 : Math.ceil(lo),
    kHi: b.hiStrict ? Math.ceil(hi) - 1 : Math.floor(hi),
    not: !!b.not,
  };
}

/** Runs of at most this many whole numbers are summed term by term. */
const SUM_RUN = 64;

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
  if (isDiscrete(d)) {
    const law = discreteLaw(d, env);
    const { kLo, kHi, not } = integerBounds({ lo, hi, ...edges }, env);
    if (!law || Number.isNaN(kLo) || Number.isNaN(kHi)) return NaN; // invalid parameters or bounds
    if (kLo > kHi) return not ? 1 : 0;
    // A short run is the sum of its masses, not a difference of two cdfs:
    // three whole numbers of DiscreteUniform(-1e17, 1e17), or near the median
    // of Binomial(1e6, p), difference to 0 or to a digit or two.
    if (!not && kHi - kLo < SUM_RUN) {
      let sum = 0;
      for (let k = kLo; k <= kHi; k++) sum += law.pmf(k);
      return sum;
    }
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
    if (m && nameable(canonicalName(m[1]))) {
      candidates.set(i, { name: canonicalName(m[1]), rhs: m[2] });
    }
  });
  let changed = names.size > 0;
  while (changed) {
    changed = false;
    for (const [i, c] of candidates) {
      if (!randomNameIn(c.rhs, names)) continue;
      candidates.delete(i);
      derived.set(i, c);
      names.add(c.name);
      changed = true;
    }
  }
  return { base, derived };
}

/** The first random variable a row's text names, if any: the scan's own
 *  identifier rule, so `2X` mentions X and `X2` does not. */
export function randomNameIn(text: string, names: ReadonlySet<string>): string | null {
  for (const t of text.match(NAME_SCAN_RE) ?? []) if (names.has(canonicalName(t))) return canonicalName(t);
  return null;
}

/**
 * A whole-row form or geometry statement is a picture, never a value, so an
 * expression holding one is not a derived random variable. Refused here, for
 * every form at once, because rows that mention a random variable turn off
 * toward the sampler before classify could refuse them.
 */
function wholeRowForm(e: Expr, rvNames: ReadonlySet<string>): void {
  const kids: readonly Expr[] =
    e.kind === 'neg'
      ? [e.a]
      : e.kind === 'bin'
        ? [e.a, e.b]
        : e.kind === 'call'
          ? e.args
          : e.kind === 'piecewise'
            ? [...e.cases.flatMap(c => [c.cond, c.value]), ...(e.otherwise ? [e.otherwise] : [])]
            : e.kind === 'ineq' || e.kind === 'eq'
              ? [e.l, e.r]
              : e.kind === 'vec' || e.kind === 'list'
                ? e.items
                : [];
  if (e.kind === 'call' && rvNames.size && (WHOLE_EXPR_NAMES.has(e.name) || GEOM_STATEMENTS.has(e.name))) {
    throw new Error(
      [...freeVars(e)].some(n => rvNames.has(n))
        ? `${e.name}(…) cannot take a random variable.`
        : `${e.name}(…) must be the whole expression.`,
    );
  }
  for (const k of kids) wholeRowForm(k, rvNames);
}

/**
 * Validate a resolved right-hand side as a derived random variable: a real
 * scalar in random variables, constants, and t.
 */
export function checkDerived(e: Expr, rvNames: ReadonlySet<string>, constNames: ReadonlySet<string>): void {
  if (e.kind === 'eq' || e.kind === 'ineq' || e.kind === 'vec' || e.kind === 'list') {
    throw new Error('A random variable must be a single value.');
  }
  wholeRowForm(e, rvNames);
  if (usesComplex(e)) throw new Error('Random variables are real-valued.');
  for (const n of freeVars(e)) {
    if (rvNames.has(n) || constNames.has(n) || n === 't') continue;
    if (/^[xyzuv]$/.test(n)) {
      throw new Error(`A random variable cannot depend on the plot coordinate ${n}.`);
    }
    throw new Error(`${n} is not defined.`);
  }
}
