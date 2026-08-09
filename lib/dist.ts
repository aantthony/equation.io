/**
 * Probability distribution rows.
 *
 * - `X ~ Normal(mean, sd)` (also Uniform(a, b), Exponential(rate)) declares a
 *   random variable; the row plots its exact density. Parameters may reference
 *   constants (sliders) and t, so `X ~ Normal(0, a)` responds to the slider.
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
  EVAL_FNS,
  type Expr,
  SHADOWABLE_FNS,
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
import { quadrature } from './integrate.ts';

// --- base distributions ---

export type BaseKind = 'normal' | 'uniform' | 'exponential';

/** Argument meaning by kind — normal: [mean, sd]; uniform: [lo, hi]; exponential: [rate]. */
export interface BaseDist {
  kind: BaseKind;
  args: Expr[];
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

interface DistSpec {
  kind: BaseKind;
  arity: number;
  usage: string;
  defaults: number[];
}

const DIST_SPECS = new Map<string, DistSpec>([
  ...['normal', 'n'].map((a): [string, DistSpec] =>
    [a, { kind: 'normal', arity: 2, usage: 'Normal(mean, sd)', defaults: [0, 1] }]),
  ...['uniform', 'u'].map((a): [string, DistSpec] =>
    [a, { kind: 'uniform', arity: 2, usage: 'Uniform(lo, hi)', defaults: [0, 1] }]),
  ...['exponential', 'exp'].map((a): [string, DistSpec] =>
    [a, { kind: 'exponential', arity: 1, usage: 'Exponential(rate)', defaults: [1] }]),
]);

/** Parse the right side of `name ~ …`. Throws with a row-friendly message. */
export function parseDistribution(rhs: string, fnNames: ReadonlySet<string>): BaseDist {
  const m = DIST_RE.exec(rhs);
  const spec = m && DIST_SPECS.get(m[1].toLowerCase());
  if (!m || !spec) {
    throw new Error(m && !DIST_SPECS.has(m[1].toLowerCase())
      ? `Unknown distribution: ${m[1]}. Try Normal(mean, sd), Uniform(lo, hi), or Exponential(rate).`
      : 'Expected a distribution like Normal(0, 1).');
  }
  // A bare name takes the standard parameters: `X ~ N` is Normal(0, 1).
  if (m[2] === undefined) {
    return { kind: spec.kind, args: spec.defaults.map(value => ({ kind: 'num', value })) };
  }
  let args: Expr;
  try {
    args = parseExpr(`(${m[2]})`, fnNames);
  } catch (e) {
    if (e instanceof Error && /vector components/.test(e.message)) {
      throw new Error(`${spec.usage} takes ${spec.arity} arguments.`);
    }
    throw e;
  }
  const items = args.kind === 'vec' ? args.items : [args];
  if (items.length !== spec.arity) {
    throw new Error(`${spec.usage} takes ${spec.arity} argument${spec.arity > 1 ? 's' : ''}.`);
  }
  return { kind: spec.kind, args: items };
}

const v = (name: string): Expr => ({ kind: 'var', name });
const num = (value: number): Expr => ({ kind: 'num', value });
const bin = (op: '+' | '-' | '*' | '/' | '^', a: Expr, b: Expr): Expr => ({ kind: 'bin', op, a, b });
const chain = (lo: Expr, mid: Expr, hi: Expr): Expr =>
  ({ kind: 'ineq', op: '<', l: { kind: 'ineq', op: '<', l: lo, r: mid }, r: hi });

/** The exact pdf of a base distribution at `x` (piecewise where the support ends). */
export function pdfExpr(d: BaseDist, x: Expr): Expr {
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
  }
}

/** The density curve for a base random variable: y = pdf(x). */
export function densityExpr(d: BaseDist): Expr {
  return { kind: 'eq', l: v('y'), r: pdfExpr(d, v('x')) };
}

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

export interface ProbSpec {
  /** The inequality (chain) to estimate, resolved. */
  body: Expr & { kind: 'ineq' };
  /** Random variables the body references. */
  rvs: string[];
  /**
   * Present when the body is constant bounds around one bare variable
   * (`P(a < X < b)`): the shadeable — and for closed-form laws, exact — case.
   */
  single?: { rv: string; lo?: Expr; hi?: Expr };
  /**
   * Bounds around one variable-bearing *expression* (`P(0.5 < X + Y < 1.5)`):
   * the same case once the caller registers the expression as an anonymous
   * derived variable.
   */
  inline?: { e: Expr; lo?: Expr; hi?: Expr };
}

/** Interpret a parsed P(…) body against the declared random variables. */
export function toProbability(e: Expr, rvNames: ReadonlySet<string>): ProbSpec {
  if (e.kind !== 'ineq') throw new Error('P(…) expects an inequality like P(X < 2).');
  const frees = freeVars(e);
  const rvs = [...frees].filter(n => rvNames.has(n));
  if (!rvs.length) {
    throw new Error('P(…) must reference a random variable, e.g. X ~ Normal(0, 1) then P(X < 2).');
  }
  for (const n of frees) {
    if (/^[xyzuvw]$/.test(n)) throw new Error(`P(…) cannot use the plot coordinate ${n}.`);
  }
  const comps = ineqComparisons(e);
  if (new Set(comps.map(c => c.op[0])).size > 1) {
    throw new Error('Chained inequalities must point the same way.');
  }
  // Normalize to ascending order so the terms read lo … X … hi.
  const asc = comps.map(c => (c.op[0] === '<' ? { l: c.l, r: c.r } : { l: c.r, r: c.l }));
  if (comps[0].op[0] === '>') asc.reverse();
  const terms = [asc[0].l, ...asc.map(c => c.r)];
  const spec: ProbSpec = { body: e, rvs };

  // `lo < … < hi` with exactly one variable-bearing term and variable-free
  // bounds on its immediate sides shades (and computes exactly when a law is
  // derivable): a bare name yields `single`, an expression `inline`. Anything
  // else — P(Y > X), extra constraints beyond the bounds — samples.
  const idx = terms.findIndex(t => [...freeVars(t)].some(n => rvNames.has(n)));
  const others = terms.filter((_, k) => k !== idx);
  if (idx >= 0 && terms.length <= 3 && idx <= 1 && idx >= terms.length - 2
    && others.every(t => [...freeVars(t)].every(n => !rvNames.has(n)))) {
    const t = terms[idx];
    const lo = idx > 0 ? terms[idx - 1] : undefined;
    const hi = idx < terms.length - 1 ? terms[idx + 1] : undefined;
    if (t.kind === 'var' && rvNames.has(t.name)) spec.single = { rv: t.name, lo, hi };
    else spec.inline = { e: t, lo, hi };
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
  const x = v('x');
  const y = v('y');
  let f: Expr = bin('-', y, pdfExpr(d, x)); // y < pdf(x)
  const parts: Expr[] = [{ kind: 'neg', a: y }]; // 0 < y
  if (lo) parts.push(bin('-', lo, x)); // lo < x
  if (hi) parts.push(bin('-', x, hi)); // x < hi
  for (const part of parts) f = { kind: 'call', name: 'max', args: [f, part] };
  return { kind: 'ineq', op: '<=', l: f, r: num(0) };
}

/** Exact CDF of a base distribution; NaN while the parameters are invalid. */
function cdf(d: BaseDist, x: number, env: Record<string, number>): number {
  const a = d.args.map(e => evaluate(e, env));
  switch (d.kind) {
    case 'normal':
      return a[1] > 0 ? normalcdf(x, a[0], a[1]) : NaN;
    case 'uniform':
      return a[1] > a[0] ? Math.min(1, Math.max(0, (x - a[0]) / (a[1] - a[0]))) : NaN;
    case 'exponential':
      return a[0] > 0 ? (x <= 0 ? 0 : 1 - Math.exp(-a[0] * x)) : NaN;
  }
}

/** Exact value of P(lo < X < hi) under the given constant environment. */
export function probabilityValue(
  d: BaseDist,
  lo: Expr | undefined,
  hi: Expr | undefined,
  env: Record<string, number>,
): number {
  return (hi ? cdf(d, evaluate(hi, env), env) : 1) - (lo ? cdf(d, evaluate(lo, env), env) : 0);
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
   *  readout to show instead. */
  robust?: { median: number; iqr: number };
}

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

function estimateCurve(col: Float64Array): DensityCurve | null {
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
  const robust = robustIfUnstable(decimate(finite), sd);

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
): { median: number; iqr: number } | undefined {
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
  if (!(sdTrim > 0) || sd <= 3 * sdTrim) return undefined;
  return { median: q(0.5), iqr: q(0.75) - q(0.25) };
}

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
  robust?: { median: number; iqr: number };
  /** Full drawn window of the continuous part; null when purely discrete. */
  window: { lo: number; hi: number; hardLo: boolean; hardHi: boolean } | null;
}

function conditionalBase(
  g: Expr,
  vars: Array<{ name: string; quantile: (u: number) => number }>,
  env: Record<string, number>,
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
      if (isFinite(v) && allSeen++ % allStride === 0) allPool.push(v);
    }
  }
  allPool.sort((a, b) => a - b);
  const robust = robustIfUnstable(allPool, sd);

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
  /** Quadrature moments (present once quadMoments ran for this sig). */
  qm?: { mean: number; sd: number; mass: number } | null;
}

/** The pdf and support of a base distribution at these parameter values, or
 *  null while the parameters are invalid. */
function pdfClosure(
  d: BaseDist,
  env: Record<string, number>,
): { pdf: (x: number) => number; lo: number; hi: number } | null {
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

  add(rv: RV): void {
    this.rvs.set(rv.name, rv);
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
    if (!af || !af.terms.size) return null;
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
    if (bases.every(b => b.dist.kind === 'uniform')) {
      return {
        kind: 'usum',
        terms: bases.map(b => ({ c: b.coef, lo: b.dist.args[0], hi: b.dist.args[1] })),
        d: af.c,
      };
    }
    return null;
  }

  /** The exact law when it is a closed-form pdf the shader can draw. */
  exactDist(name: string): BaseDist | null {
    const law = this.exactLaw(name);
    return law?.kind === 'dist' ? law.dist : null;
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
    if (entry.est === undefined) entry.est = estimateCurve(col);
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
      return conditionalBase(g, vars, env);
    } catch {
      return null; // unbound parameter or broken expression: the sampled tier reports it
    }
  }

  /** Exact mean and sd under the variable's law, or null when sampled. */
  exactMoments(name: string, env: Record<string, number>): { mean: number; sd: number } | null {
    const law = this.exactLaw(name);
    if (!law) return null;
    if (law.kind === 'dist') {
      const a = law.dist.args.map(e => evaluate(e, env));
      switch (law.dist.kind) {
        case 'normal':
          return a[1] > 0 ? { mean: a[0], sd: a[1] } : null;
        case 'uniform':
          return a[1] > a[0] ? { mean: (a[0] + a[1]) / 2, sd: (a[1] - a[0]) / Math.sqrt(12) } : null;
        case 'exponential':
          return a[0] > 0 ? { mean: 1 / a[0], sd: 1 / a[0] } : null;
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
   * mass, matching the sampler's "average where defined" convention. Null
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
      const moment = (k: 0 | 1 | 2) => quadrature(x => {
        const v = gAt(x);
        if (!isFinite(v)) return 0;
        return (k === 0 ? 1 : k === 1 ? v : v * v) * pc!.pdf(x);
      }, pc!.lo, pc!.hi);
      const mass = moment(0);
      if (!(mass > 1e-9)) return null;
      const m1 = moment(1);
      const m2 = moment(2);
      if (!isFinite(m1) || !isFinite(m2)) return null;
      const mean = m1 / mass;
      return { mean, sd: Math.sqrt(Math.max(m2 / mass - mean * mean, 0)), mass };
    };
    slot.qm = compute();
    return slot.qm;
  }

  /** The mean of a variable: exact under its law when one is derivable,
   *  quadrature against the base pdf for one-variable transforms, otherwise
   *  the curve's mean (quadrature-grade for conditional-CDF curves, the
   *  finite-sample mean for estimates; NaN when nothing is finite). */
  mean(name: string, env: Record<string, number>): number {
    const m = this.exactMoments(name, env) ?? this.quadMoments(name, env);
    if (m) return m.mean;
    const c = this.curve(name, env);
    if (c) return c.mean;
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

  /** Exact P(lo < name < hi) under the variable's law, or null when sampled. */
  exactProbability(
    name: string,
    lo: Expr | undefined,
    hi: Expr | undefined,
    env: Record<string, number>,
  ): number | null {
    const law = this.exactLaw(name);
    if (!law) return null;
    if (law.kind === 'dist') return probabilityValue(law.dist, lo, hi, env);
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
