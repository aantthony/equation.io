/**
 * Exact piecewise-polynomial laws and the random-variable system.
 */
import { exprKey } from './expr.ts';

import { type Expr, SHADOWABLE_FNS, builtinFn, evaluate, freeVars, parseExpr, substVars } from './expr.ts';
import { type GetFn, RESERVED, type ResolveOpts, resolveExpr } from './defs.ts';
import { familyOf } from './dist-families.ts';
import { quadrature } from './integrate.ts';
import { lgamma, wholeNumber } from './specfn.ts';
import {
  type BaseDist,
  bin,
  call,
  checkDerived,
  integerBounds,
  isDiscrete,
  num,
  paramProblem,
  parseDistribution,
  probabilityValue,
  type ProbBounds,
  type ProbSpec,
  scanRandomRows,
  v,
} from './dist-base.ts';
import {
  atomQuantile,
  atomRange,
  type AtomSet,
  baseAtoms,
  type Block,
  blockOf,
  buildEnvelope,
  buildStems,
  cancelled,
  canonicalColumn,
  canonicalize,
  columnOf,
  CONDITION_MAX,
  discreteLaw,
  type DiscreteLaw,
  type DiscretePmf,
  diverges,
  eventMask,
  eventShape,
  exactPmf,
  firstAbove,
  type Joint,
  JOINT_MAX,
  mergeAtoms,
  type PmfStems,
  quantileTail,
  sameAtom,
  sampledPmf,
  selectStems,
  sortedQuantiles,
  STEM_MAX,
  STEM_TAIL,
  type Tail,
  tailOf,
  tensor,
  windowAtoms,
  worseTail,
} from './dist-discrete.ts';
import {
  type CacheEntry,
  condAssemble,
  condDensity,
  conditionalBase,
  type DensityCurve,
  estimateCurve,
  evalCols,
  type HeavyBase,
  normalQuantile,
  pdfClosure,
  QC_ZOOM_MAX,
  type QCBase,
  quantileClosure,
  type RV,
  SAMPLE_COUNT,
  setStreamSalt,
  uniformStream,
  zooQuantile,
} from './dist-sample.ts';

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
export function numOf(e: Expr): number | null {
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
  a.forEach((v, i) => {
    out[i] += v;
  });
  b.forEach((v, i) => {
    out[i] += v;
  });
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

const uniformPP = (lo: number, hi: number): PPoly => ({ breaks: [lo, hi], pieces: [[1 / (hi - lo)]] });

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
  interface Pair {
    a: number;
    b: number;
    c: number;
    e: number;
    Wx: number[][];
  }
  const pairs: Pair[] = [];
  const zb: number[] = [];
  for (let i = 0; i + 1 < p.breaks.length; i++) {
    for (let k = 0; k + 1 < q.breaks.length; k++) {
      const a = p.breaks[i],
        b = p.breaks[i + 1];
      const c = q.breaks[k],
        e = q.breaks[k + 1];
      const u = p.pieces[i],
        v = q.pieces[k];
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
    const x0 = p.breaks[i],
      x1 = p.breaks[i + 1];
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
  private declarations: ReadonlyMap<string, RV> = new Map();
  private readonly anonymous = new Map<string, RV>();
  /** Derived index only; named declarations remain owned by the provider. */
  private rvs: ReadonlyMap<string, RV> = this.declarations;
  private cache = new Map<string, CacheEntry>();
  private paramsMemo = new Map<string, ReadonlySet<string>>();
  private defSigMemo = new Map<string, string>();
  private affineMemo = new Map<string, Affine | null>();
  private lawMemo = new Map<string, Law | null>();
  private groundedMemo = new Map<string, Expr | null>();
  private basesMemo = new Map<string, readonly string[]>();

  /** Start a recompile: drop declarations, keep sample caches. */
  reset(): void {
    this.declarations = new Map();
    this.anonymous.clear();
    this.rvs = this.declarations;
    this.paramsMemo.clear();
    this.defSigMemo.clear();
    this.affineMemo.clear();
    this.lawMemo.clear();
    this.groundedMemo.clear();
    this.basesMemo.clear();
  }

  /** Attach canonical declarations without discarding numerical sample caches. */
  useDeclarations(declarations: ReadonlyMap<string, RV>): void {
    this.reset();
    this.declarations = declarations;
    this.rvs = declarations;
  }

  /** Expression rows have engine-owned names outside the user namespace. */
  addAnonymous(rv: RV): void {
    if (!rv.name.startsWith('@')) throw new Error('Anonymous random variables need an internal name.');
    if (this.declarations.has(rv.name)) throw new Error(`${rv.name} is already defined.`);
    this.anonymous.set(rv.name, rv);
    this.rvs = new Map([...this.declarations, ...this.anonymous]);
  }

  /**
   * The law of a variable that IS one of the discrete families: a discrete
   * declaration, or a derived variable a closure rule reduces to one (a sum of
   * independent Poissons). Such a variable draws and answers through the law
   * itself — incomplete beta/gamma functions, at any size — and never through
   * enumeration.
   */
  discreteDist(name: string): BaseDist | null {
    const law = this.exactLaw(name);
    return law?.kind === 'dist' && isDiscrete(law.dist) ? law.dist : null;
  }

  /** The base variables a variable is built on, through every derived one. */
  private basesOf(name: string): readonly string[] {
    const memo = this.basesMemo.get(name);
    if (memo) return memo;
    const out = new Set<string>();
    const seen = new Set<string>();
    const walk = (n: string): void => {
      if (seen.has(n)) return;
      seen.add(n);
      const rv = this.rvs.get(n);
      if (rv?.kind === 'base') out.add(n);
      else if (rv) for (const dep of freeVars(rv.expr)) walk(dep);
    };
    walk(name);
    const bases = [...out];
    this.basesMemo.set(name, bases);
    return bases;
  }

  /** Random variables of `e` that are not discrete (see isDiscreteVar). */
  private continuousIn(e: Expr): string[] {
    return [...freeVars(e)].filter(n => this.rvs.has(n) && !this.isDiscreteVar(n));
  }

  /**
   * Whether a variable is discrete: built on discrete bases only. Decided by
   * the declarations, never by parameter values, so a row is a pmf row or a
   * density row for good. One continuous base makes it a continuous MIXTURE
   * (`N + Z` with N Poisson, Z Normal has a density), which is not discrete.
   */
  isDiscreteVar(name: string): boolean {
    const bases = this.basesOf(name);
    return bases.length > 0 && bases.every(n => isDiscrete((this.rvs.get(n) as RV & { kind: 'base' }).dist));
  }

  /** Constants that ARE a whole-number parameter of a discrete law (the n of
   *  `X ~ Binomial(n, p)`, written as the bare name): the app steps their
   *  sliders by 1, as it does Σ bounds, so a drag never lands on n = 2.5. */
  wholeParamNames(): Set<string> {
    const out = new Set<string>();
    for (const rv of this.rvs.values()) {
      if (rv.kind !== 'base' || !isDiscrete(rv.dist)) continue;
      familyOf(rv.dist.kind).params.forEach((param, k) => {
        const arg = rv.dist.args[k];
        if (param.whole && arg.kind === 'var') out.add(arg.name);
      });
    }
    return out;
  }

  /**
   * What a P(…) row may ask, judged against the declarations: a point event
   * (`P(X = 3)`, `P(X + Y = 7)`, `P(X = Y)`) only of discrete variables. With
   * a continuous one anywhere in it the event has probability 0 by definition
   * — true of the mixture `N + Z` too — and saying 0 would hide that the
   * question was probably meant as an interval.
   */
  checkProbability(spec: ProbSpec): void {
    if (!spec.point) return;
    const continuous = this.continuousIn(spec.body);
    if (!continuous.length) return;
    const single = spec.single;
    if (single) {
      throw new Error(
        `P(${single.rv} ${single.not ? '!=' : '='} …) needs a discrete variable: a continuous one` +
          ` takes any single value with probability 0. Ask about an interval, like P(a < ${single.rv} < b).`,
      );
    }
    throw new Error(
      `P(… = …) needs discrete variables, and ${continuous.join(', ')} ${continuous.length > 1 ? 'are' : 'is'} not:` +
        ' a continuous value equals any given one with probability 0. Ask about an interval, like P(a < … < b).',
    );
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
    setStreamSalt(salt);
    for (const e of this.cache.values()) {
      delete e.col;
      delete e.est;
      // (A sampled pmf over ONE base has no pairing to redraw: its strata are
      // the exact marginal at any salt.)
      if (e.spmf !== undefined && !e.spmfStill) {
        delete e.spmf;
        delete e.runs;
      }
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
    return validateDeclarations(this.rvs);
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
      const frees =
        rv.kind === 'base' ? rv.dist.args.reduce((s, a) => freeVars(a, s), new Set<string>()) : freeVars(rv.expr);
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
    const scale = (af: Affine | null, k: Expr): Affine | null =>
      af && {
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
    const discreteSum = this.discreteSumLaw(bases, af.c);
    if (discreteSum) return discreteSum;
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
      const key = b !== null ? `#${b / c}` : `${exprKey(be)}/${c}`;
      if (rateKey !== null && key !== rateKey) return null;
      rateKey = key;
      rate ??= b !== null ? num(b / c) : c === 1 ? be : bin('/', be, num(c));
      shape = shape ? bin('+', shape, al) : al;
    }
    return shape && rate ? { kind: 'dist', dist: { kind: 'gamma', args: [shape, rate] } } : null;
  }

  /**
   * A plain sum of independent discrete bases that stays in its family:
   * Poissons (means add), Binomials — Bernoulli is Binomial(1, p) — sharing
   * one p (the n add), NegativeBinomials sharing one p (the r add). The sum is
   * then the law itself, exact at any size: Poisson(1e6) + Poisson(1e6) is
   * Poisson(2e6), which no enumeration could reach. Independence is the affine
   * form's: X + X arrived as 2·X, whose coefficient is not 1, so it is never
   * Poisson(2λ) — it enumerates, onto the even numbers. Every coefficient must
   * be the literal 1 and nothing added: 2X and X + 1 leave the family
   * (Geometric, a shifted law, is never in it). p's are equal as the Gamma
   * rule's rates are: the same number, or the same expression.
   */
  private discreteSumLaw(bases: Array<{ coef: Expr; dist: BaseDist }>, shift: Expr): Law | null {
    if (numOf(shift) !== 0) return null;
    let kind: 'poisson' | 'binomial' | 'negbinomial' | null = null;
    let total: Expr | null = null;
    let p: Expr | null = null;
    let pKey: string | null = null;
    for (const { coef, dist } of bases) {
      if (numOf(coef) !== 1) return null;
      const d = dist.kind === 'bernoulli' ? { kind: 'binomial' as const, args: [num(1), dist.args[0]] } : dist;
      if (d.kind !== 'poisson' && d.kind !== 'binomial' && d.kind !== 'negbinomial') return null;
      if (kind !== null && d.kind !== kind) return null;
      kind = d.kind;
      if (d.kind !== 'poisson') {
        const value = numOf(d.args[1]);
        const key = value !== null ? `#${value}` : exprKey(d.args[1]);
        if (pKey !== null && key !== pKey) return null;
        pKey = key;
        p ??= d.args[1];
      }
      total = total ? bin('+', total, d.args[0]) : d.args[0];
    }
    if (!kind || !total) return null;
    return { kind: 'dist', dist: { kind, args: p ? [total, p] : [total] } };
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
      return paramProblem(
        rv.dist.kind,
        rv.dist.args.map(e => evaluate(e, env)),
      );
    } catch {
      return null;
    }
  }

  /** The exact law when it is a closed-form pdf the shader can draw — so
   *  never a discrete one (discreteDist), which has a pmf and draws as stems. */
  exactDist(name: string): BaseDist | null {
    const law = this.exactLaw(name);
    return law?.kind === 'dist' && !isDiscrete(law.dist) ? law.dist : null;
  }

  /**
   * The stems of a discrete variable over the visible x-range: one per whole
   * number of the support in view, clipped to where the law has mass (all but
   * 1e-12 per tail, so an unbounded support or a view a billion wide costs
   * nothing) and capped at STEM_MAX (see PmfStems.envelope). Rebuilt only
   * when the parameters change or the window reaches a new whole number (a
   * new lattice cell, for an envelope): a still view, or a second row reading
   * the same variable, costs a cache hit. Null while the parameters declare no distribution
   * — a slider n at 2.5 draws nothing, because nothing is there to draw.
   */
  stems(
    name: string,
    env: Record<string, number>,
    view?: { lo: number; hi: number },
  ): { stems: PmfStems; law: DiscreteLaw } | null {
    const rv = this.rvs.get(name);
    if (!rv || !this.discreteDist(name)) return null;
    const slot = this.entry(name, this.sig(rv, env));
    if (slot.pmf === undefined) {
      const law = this.lawOf(name, env);
      slot.pmf = law && { law, kLo: law.quantile(STEM_TAIL), kHi: law.quantile(STEM_TAIL, true), key: '', stems: null };
    }
    const c = slot.pmf;
    if (!c || !isFinite(c.kLo) || !isFinite(c.kHi)) return null;
    // The window: the view clipped to the mass range. Its WIDTH decides
    // between stems and envelope, and the envelope's stride — a pan leaves the
    // width alone, so neither flips as ceil(view.lo) ticks over.
    const lo = Math.max(c.kLo, view ? view.lo : -Infinity);
    const hi = Math.min(c.kHi, view ? view.hi : Infinity);
    let key: string;
    let build: () => PmfStems;
    if (!(lo <= hi)) {
      key = 'none';
      build = () => ({ ks: [], ps: [], envelope: false });
    } else if (hi - lo < STEM_MAX) {
      const [kLo, kHi] = [Math.ceil(lo), Math.floor(hi)];
      key = `${kLo},${kHi}`;
      build = () => buildStems(c.law, kLo, kHi);
    } else {
      // Keyed by the lattice cells the window touches: a pan shorter than a
      // stride — every frame of a drag — is a cache hit, for the variable's
      // row and for each P(…) row over it alike.
      const stride = 2 ** Math.ceil(Math.log2((hi - lo) / STEM_MAX));
      const [iLo, iHi] = [Math.floor(lo / stride), Math.ceil(hi / stride)];
      key = `e${stride},${iLo},${iHi}`;
      build = () => buildEnvelope(c.law, c.kLo, c.kHi, stride, iLo, iHi);
    }
    if (!c.stems || c.key !== key) {
      c.key = key;
      c.stems = build();
    }
    return { stems: c.stems, law: c.law };
  }

  /** The law of a variable that is one of the discrete families (discreteDist)
   *  at these parameter values; null while any base under it declares none — a
   *  sum of two Binomials with n = 2.5 each is not Binomial(5, p). */
  private lawOf(name: string, env: Record<string, number>): DiscreteLaw | null {
    const d = this.discreteDist(name);
    if (!d) return null;
    for (const b of this.basesOf(name)) {
      if (b !== name && !discreteLaw((this.rvs.get(b) as RV & { kind: 'base' }).dist, env)) return null;
    }
    return discreteLaw(d, env);
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
    else if (rv.kind === 'base') s = rv.dist.kind + exprKey(rv.dist.args);
    else {
      s = exprKey(rv.expr);
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
      if (isDiscrete(rv.dist)) {
        // The exact step-function quantile of each stratum, tabulated once per
        // parameter values (sortedQuantiles) and read in the stream's order.
        const law = discreteLaw(rv.dist, env);
        col = new Float64Array(SAMPLE_COUNT);
        if (law) {
          const strata = (slot.strata ??= sortedQuantiles(law));
          for (let i = 0; i < SAMPLE_COUNT; i++) col[i] = strata[Math.floor(u[i] * SAMPLE_COUNT)];
        } else col.fill(NaN);
        slot.col = col;
        return col;
      }
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
  curve(name: string, env: Record<string, number>, view?: { lo: number; hi: number }): DensityCurve | null {
    const c = this.rawCurve(name, env, view);
    // One verdict per variable: a mean that quadrature certified (absolutely
    // convergent, see quadMoments) exists, whatever a tail-index estimate
    // near its bar made of it.
    if (!c?.robust || c.robust.meanOk || !this.quadMoments(name, env)) return c;
    const slot = this.cache.get(name)!;
    if (slot.certified?.from !== c)
      slot.certified = { from: c, curve: { ...c, robust: { ...c.robust, meanOk: true } } };
    return slot.certified.curve;
  }

  private rawCurve(name: string, env: Record<string, number>, view?: { lo: number; hi: number }): DensityCurve | null {
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
    if (this.isDiscreteVar(name)) return null; // no density: pmfRuns() draws it
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
      // The tier integrates over a quantile grid as over a density: a discrete
      // base (the mixture N + Z) has steps there, and takes the sampled tier.
      if (isDiscrete(b.dist)) return null;
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
      if (isDiscrete(law.dist)) {
        const dl = this.lawOf(name, env);
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
    const e = rv?.kind === 'derived' ? this.ground(rv.expr) : null;
    this.groundedMemo.set(name, e);
    return e;
  }

  /** `e` with every derived variable inlined (see grounded). */
  private ground(expr: Expr): Expr | null {
    let e: Expr | null = expr;
    // Dependencies are acyclic (validate() dropped cycles); the guard bounds
    // pathological chains and substitution blowup all the same.
    for (let guard = 0; e && guard < 32; guard++) {
      // No prototype: substVars looks names up, and a variable may be called
      // `constructor` or `toString`.
      const sub: Record<string, Expr> = Object.create(null);
      for (const n of freeVars(e)) {
        const dep = this.rvs.get(n);
        if (dep?.kind === 'derived') sub[n] = dep.expr;
      }
      if (!Object.keys(sub).length) break;
      e = substVars(e, sub);
      if (exprKey(e).length > 200_000) e = null;
    }
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
      if (this.isDiscreteVar(name)) {
        // The discrete twin: the sum against the base pmfs, where enumeration
        // reached and truncation is certified invisible in the mean.
        const pmf = this.pmfOf(name, env);
        return pmf?.meanExact ? { mean: pmf.mean, sd: pmf.sd, mass: pmf.mass } : null;
      }
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
    if (this.isDiscreteVar(name)) {
      // Uncertified enumeration, or the sample; NaN while parameters are
      // invalid or the mean's sum diverges (meanUnstable says which).
      const pmf = this.pmfOf(name, env);
      return pmf?.meanOk ? pmf.mean : NaN;
    }
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
  moments(
    name: string,
    env: Record<string, number>,
  ):
    | { kind: 'exact' | 'estimate'; mean: number; sd: number; mass: number; note?: string }
    | { kind: 'robust'; median: number; iqr: number; meanOk: boolean; mass: number; note?: string }
    | null {
    const m = this.exactMoments(name, env);
    if (m && isFinite(m.mean) && isFinite(m.sd)) return { kind: 'exact', ...m, mass: 1 };
    if (this.isDiscreteVar(name)) {
      // Never the Hill estimate: that reads a sample's tail, and a bounded law
      // with a far atom looks like one. Whether a discrete mean exists is
      // read off the enumeration itself (momentVerdict).
      const pmf = this.pmfOf(name, env);
      if (!pmf) return null;
      // A sampled pmf is said to be one — loudly where it could not be resolved.
      const note = pmf.exact
        ? undefined
        : pmf.unresolved
          ? 'sampled: too many distinct values to resolve the pmf'
          : 'sampled';
      if (!pmf.meanOk) {
        const q = (u: number): number => atomQuantile(pmf, u);
        return { kind: 'robust', median: q(0.5), iqr: q(0.75) - q(0.25), meanOk: false, mass: pmf.mass, note };
      }
      return { kind: pmf.certified ? 'exact' : 'estimate', mean: pmf.mean, sd: pmf.sd, mass: pmf.mass, note };
    }
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
    if (this.isDiscreteVar(name)) return this.pmfOf(name, env)?.meanOk === false;
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
        } catch {
          /* unbound parameter: the caller reports it */
        }
      }
      const tail: HeavyBase = df <= 1 ? 2 : df <= 2 ? 1 : 0;
      if (tail > level) level = tail;
    };
    walk(name);
    return level;
  }

  /** Exact P(lo < name < hi) under the variable's law, or null when sampled
   *  (or enumerated: eventProbability). `edges` matters to a discrete law only
   *  (see probabilityValue). */
  exactProbability(
    name: string,
    lo: Expr | undefined,
    hi: Expr | undefined,
    env: Record<string, number>,
    edges?: Pick<ProbBounds, 'loStrict' | 'hiStrict' | 'not'>,
  ): number | null {
    const law = this.exactLaw(name);
    if (!law) return null;
    if (law.kind === 'dist') {
      if (isDiscrete(law.dist) && !this.lawOf(name, env)) return NaN; // a base under a closed sum is invalid
      return probabilityValue(law.dist, lo, hi, env, edges);
    }
    const pp = this.usumPP(law, env);
    if (!pp) return NaN;
    const total = cdfPP(pp, pp.breaks[pp.breaks.length - 1]);
    return (hi ? cdfPP(pp, evaluate(hi, env)) : total) - (lo ? cdfPP(pp, evaluate(lo, env)) : 0);
  }

  /**
   * The value of a P(…) row, and whether it is exact (shown to 4 places) or a
   * joint-sample estimate (3). Constant bounds on one variable go through its
   * law or its atoms; any other event over discrete variables alone is
   * enumerated over the joint of their bases (so `P(X > X)` is 0, and
   * `A = X + Y; B = X - Y; P(A > B)` sees the X they share), and sampled past
   * JOINT_MAX. Either way a discrete event keeps its strictness — ties have
   * mass — by eventMask. Everything else is the Monte Carlo fraction it
   * always was. `single` is the row's bounded variable, when it has that shape.
   */
  eventProbability(
    body: Expr,
    single: ({ rv: string } & ProbBounds) | undefined,
    env: Record<string, number>,
  ): { value: number; exact: boolean } {
    if (single) {
      const value = this.exactProbability(single.rv, single.lo, single.hi, env, single);
      if (value !== null) return { value, exact: true };
      if (this.isDiscreteVar(single.rv)) {
        const pmf = this.pmfOf(single.rv, env);
        const range = pmf && atomRange(pmf, single, env);
        if (!pmf || !range) return { value: NaN, exact: true };
        let inside = 0;
        for (let i = range.i0; i <= range.i1; i++) inside += pmf.ps[i];
        // Where the variable is undefined the event did not happen — nor did
        // its complement: `not` is the rest of the DEFINED mass.
        let defined = 0;
        for (let i = 0; i < pmf.ps.length; i++) defined += pmf.ps[i];
        return { value: single.not ? Math.max(0, defined - inside) : inside, exact: pmf.exact };
      }
    }
    const shape = this.continuousIn(body).length ? null : eventShape(body);
    if (!shape) return { value: this.sampleFraction(body, env), exact: false };
    const terms = shape.terms.map(t => this.ground(t));
    this.budget = 2 * JOINT_MAX;
    const joint = terms.every((t): t is Expr => t !== null) ? this.enumerateTerms(terms, env) : 'cap';
    if (joint === null) return { value: NaN, exact: true };
    if (joint !== 'cap') {
      // The terms are finished values: canonical, as atoms are (mergeAtoms).
      const cols = joint.cols.map((col, k) => canonicalize(col, joint.mags[k]));
      const mask = eventMask(cols, shape.ops, joint.wp.length);
      // Of the mass enumerated (all but `lost`), so a certain event is 1.
      let value = 0;
      let total = 0;
      for (let i = 0; i < mask.length; i++) {
        total += joint.wp[i];
        if (mask[i] === 1) value += joint.wp[i];
      }
      return { value: Math.min(1, value / total), exact: true };
    }
    // Past the cap: the same event, with the same tie rule, over the sample.
    const mask = eventMask(
      shape.terms.map((t, k) => this.sampledColumn(terms[k] ?? t, env)),
      shape.ops,
      SAMPLE_COUNT,
    );
    let count = 0;
    let defined = 0;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      if (Number.isNaN(mask[i])) continue;
      defined++;
      if (mask[i] === 1) count++;
    }
    return { value: defined ? count / SAMPLE_COUNT : NaN, exact: false };
  }

  /** The number alone (see eventProbability). */
  probability(body: Expr, env: Record<string, number>): number {
    return this.eventProbability(body, undefined, env).value;
  }

  /**
   * Monte Carlo estimate of P(body): the fraction of joint samples where the
   * inequality holds. Samples where it is undefined count as "not the event";
   * NaN when it is undefined everywhere (broken parameters).
   */
  private sampleFraction(body: Expr, env: Record<string, number>): number {
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

  // --- derived discrete variables (see the section above RVSystem) ---

  /** A discrete base's atoms at these parameter values, cached with them. */
  private baseAtomsOf(name: string, env: Record<string, number>): AtomSet | 'cap' | null {
    const rv = this.rvs.get(name);
    if (rv?.kind !== 'base') return null;
    const slot = this.entry(name, this.sig(rv, env));
    if (slot.atoms === undefined) {
      const law = discreteLaw(rv.dist, env);
      slot.atoms = law && baseAtoms(law);
    }
    return slot.atoms;
  }

  /** The random names of a grounded expression (bases, all of them). */
  private randomIn(e: Expr): string[] {
    return [...freeVars(e)].filter(n => this.rvs.has(n));
  }

  /**
   * The joint of several grounded terms, as columns over one product. Terms
   * are grouped by the bases they share (transitively). A term that shares
   * none is independent of the rest: it is enumerated on its own, and its
   * atoms — far fewer than its joint points — enter the product. Terms that do
   * share are enumerated together (jointBlock), group by group. `whole`: all
   * of them as one group, over the joint of their bases. 'cap' past JOINT_MAX
   * (or the work budget); null while a base declares no distribution.
   */
  private enumerateTerms(terms: readonly Expr[], env: Record<string, number>, whole = false): Joint | 'cap' | null {
    const random = terms.map(t => this.randomIn(t));
    const group = terms.map((_, k) => k);
    const find = (k: number): number => (group[k] === k ? k : (group[k] = find(group[k])));
    const owner = new Map<string, number>();
    random.forEach((names, k) => {
      for (const n of names) {
        const other = whole ? owner.values().next().value : owner.get(n);
        if (other !== undefined) group[find(k)] = find(other);
        owner.set(n, k);
      }
    });
    const blocks: Block[] = [];
    for (let root = 0; root < terms.length; root++) {
      if (find(root) !== root || !random[root].length) continue;
      const members = terms.map((_, k) => k).filter(k => random[k].length && find(k) === root);
      let block: Block | 'cap' | null;
      if (members.length === 1 && !whole) {
        const atoms = this.enumerate(terms[root], env);
        block = atoms && atoms !== 'cap' ? blockOf(root, atoms) : atoms;
      } else
        block = this.jointBlock(
          members.map(k => terms[k]),
          members,
          env,
          whole,
        );
      if (!block || block === 'cap') return block;
      blocks.push(block);
    }
    if (!this.charge(blocks.reduce((size, b) => size * b.p.length, 1))) return 'cap';
    const joint = tensor(blocks, terms.length);
    if (!joint) return 'cap';
    terms.forEach((t, k) => {
      if (!random[k].length)
        ({ vals: joint.cols[k], mags: joint.mags[k] } = columnOf(t, new Map(), env, joint.wp.length));
    });
    return joint;
  }

  /** Work left to the enumeration in progress: no chain of steps, each under
   *  the cap, may add up to a stall (conditioning nests). */
  private budget = 0;
  private charge(points: number): boolean {
    this.budget -= points + 64; // a step costs something however small it is
    return this.budget >= 0;
  }

  /**
   * Terms that share bases, enumerated together. Conditioned on the SHARED
   * bases where that leaves something independent: given D0, `T = D0 + … + D9`
   * and `D0` share nothing, so each value of D0 costs one cheap enumeration of
   * T — 6 of them, not the 6^10 joint points of all ten dice. Otherwise
   * (nothing left over, too many shared values, or `whole`) the joint of the
   * bases, each term evaluated over it.
   */
  private jointBlock(terms: Expr[], ids: number[], env: Record<string, number>, whole: boolean): Block | 'cap' | null {
    const counts = new Map<string, number>();
    for (const t of terms) for (const n of this.randomIn(t)) counts.set(n, (counts.get(n) ?? 0) + 1);
    const atomsOf = (names: string[]): Block[] | 'cap' | null => {
      const out: Block[] = [];
      for (const [k, n] of names.entries()) {
        const atoms = this.baseAtomsOf(n, env);
        if (!atoms || atoms === 'cap') return atoms;
        out.push(blockOf(k, atoms));
      }
      return out;
    };
    const all = [...counts.keys()];
    const shared = all.filter(n => counts.get(n)! > 1);
    const given = whole || shared.length === all.length ? null : atomsOf(shared);
    if (given === 'cap') return 'cap';
    if (given && given.reduce((size, b) => size * b.p.length, 1) <= CONDITION_MAX) {
      const over = tensor(given, shared.length)!;
      const rows = over.wp.length;
      if (!this.charge(rows)) return 'cap';
      const parts: Joint[] = [];
      let size = 0;
      for (let i = 0; i < rows; i++) {
        // A computed key is an own property whatever the name (`__proto__`).
        const at: Record<string, Expr> = {};
        shared.forEach((n, k) => {
          at[n] = num(over.cols[k][i]);
        });
        const part = this.enumerateTerms(
          terms.map(t => substVars(t, at)),
          env,
        );
        if (!part || part === 'cap') return part;
        size += part.wp.length;
        if (size > JOINT_MAX) return 'cap';
        parts.push(part);
      }
      const block: Block = {
        terms: ids,
        cols: ids.map(() => new Float64Array(size)),
        mags: ids.map(() => new Float64Array(size)),
        p: new Float64Array(size),
        n: new Float64Array(size),
        c: new Float64Array(size),
        lost: 1 - (1 - over.lost) * (1 - Math.max(0, ...parts.map(part => part.lost))),
      };
      let at = 0;
      parts.forEach((part, i) => {
        ids.forEach((_, k) => {
          block.cols[k].set(part.cols[k], at);
          block.mags[k].set(part.mags[k], at);
        });
        for (let j = 0; j < part.wp.length; j++) {
          block.p[at + j] = over.wp[i] * part.wp[j];
          block.n[at + j] = over.wn[i] * part.wn[j];
          block.c[at + j] = over.wc[i] * part.wc[j];
        }
        at += part.wp.length;
      });
      return block;
    }
    const bases = atomsOf(all);
    if (!bases || bases === 'cap') return bases;
    if (!this.charge(bases.reduce((size, b) => size * b.p.length, 1))) return 'cap';
    const joint = tensor(bases, all.length);
    if (!joint) return 'cap';
    const byName = new Map(all.map((n, k) => [n, joint.cols[k]]));
    const columns = terms.map(t => columnOf(t, byName, env, joint.wp.length));
    return {
      terms: ids,
      cols: columns.map(col => col.vals),
      mags: columns.map(col => col.mags),
      p: joint.wp,
      n: joint.wn,
      c: joint.wc,
      lost: joint.lost,
    };
  }

  /** The atoms of a grounded expression over discrete bases (see above):
   *  unrounded, unless `finished` (the root: see mergeAtoms). */
  private enumerate(e: Expr, env: Record<string, number>, finished = false): AtomSet | 'cap' | null {
    if (e.kind === 'var' && this.rvs.has(e.name)) return this.baseAtomsOf(e.name, env);
    // An operator or call over INDEPENDENT operands combines their atoms.
    const kids = e.kind === 'neg' ? [e.a] : e.kind === 'bin' ? [e.a, e.b] : e.kind === 'call' ? e.args : null;
    // (Anything else — a piecewise, a comparison — reads the joint of its bases.)
    const joint = kids ? this.enumerateTerms(kids, env) : this.enumerateTerms([e], env, true);
    if (!joint || joint === 'cap') return joint;
    const size = joint.wp.length;
    let vals = joint.cols[0];
    let mags = joint.mags[0];
    if (kids) {
      const names = kids.map((_, k) => `\u0000${k}`); // no identifier: cannot collide with a user's name
      const at = (k: number): Expr => v(names[k]);
      const node: Expr =
        e.kind === 'neg'
          ? { kind: 'neg', a: at(0) }
          : e.kind === 'bin'
            ? { kind: 'bin', op: e.op, a: at(0), b: at(1) }
            : { kind: 'call', name: (e as Expr & { kind: 'call' }).name, args: kids.map((_, k) => at(k)) };
      vals = evalCols(node, new Map(names.map((n, k) => [n, joint.cols[k]])), env, size);
      // What this node added up: |a| + |b| for a sum (which may have cancelled
      // to 0), carried through a product or quotient, else the value's own.
      const b = joint.cols[1];
      const [ma, mb] = joint.mags;
      const op = e.kind === 'bin' ? e.op : e.kind;
      if (op === 'neg') mags = ma;
      else if (op === '+' || op === '-') {
        mags = ma.map((m, i) => m + mb[i]);
        for (let i = 0; i < size; i++) if (cancelled(vals[i], mags[i])) vals[i] = 0;
      } else if (op === '*') mags = ma.map((m, i) => m * mb[i]);
      else if (op === '/') mags = ma.map((m, i) => Math.max(Math.abs(vals[i]), m / Math.abs(b[i])));
      else mags = vals.map(Math.abs);
    }
    return mergeAtoms(vals, mags, joint.wp, joint.wn, joint.wc, joint.lost, finished);
  }

  /** `enumerate` at the root, within a fresh work budget. */
  private enumerateRoot(e: Expr, env: Record<string, number>): AtomSet | 'cap' | null {
    this.budget = 2 * JOINT_MAX;
    return this.enumerate(e, env, true);
  }

  /**
   * The pmf of a derived discrete variable at these parameter values — exact
   * where the enumeration fits, sampled where it does not — or null: not such
   * a variable (a law of its own answers through discreteDist), or a base
   * declares no distribution. Enumerated once per parameter values; the
   * sampled one is redrawn with the sample (resample).
   */
  pmfOf(name: string, env: Record<string, number>): DiscretePmf | null {
    const rv = this.rvs.get(name);
    if (rv?.kind !== 'derived' || !this.isDiscreteVar(name) || this.discreteDist(name)) return null;
    const slot = this.entry(name, this.sig(rv, env));
    if (slot.dpmf === undefined) {
      const g = this.grounded(name);
      const atoms = g ? this.enumerateRoot(g, env) : 'cap';
      slot.dpmf = atoms === 'cap' ? 'cap' : atoms && exactPmf(atoms);
    }
    if (slot.dpmf !== 'cap') return slot.dpmf;
    if (slot.spmf === undefined) {
      slot.tails ??= this.sampledTails(name, env);
      slot.spmfStill = this.basesOf(name).length === 1;
      slot.spmf = sampledPmf(this.sampledColumn(this.grounded(name) ?? rv.expr, env), slot.tails);
    }
    return slot.spmf;
  }

  /** An expression over the joint sample, as canonical values (the sampled
   *  tier's twin of an enumerated column). */
  private sampledColumn(e: Expr, env: Record<string, number>): Float64Array {
    const cols = new Map<string, Float64Array>();
    for (const f of freeVars(e)) {
      if (this.rvs.has(f)) cols.set(f, this.columns(f, env));
    }
    return canonicalColumn(e, cols, env, SAMPLE_COUNT);
  }

  /**
   * Whether the first two moments of a sampled-tier variable exist — a sample
   * mean is finite either way, and 1.00001^G over Geometric(1e-6) prints as a
   * confident 1e49. The discrete families' own tails are exponentially light,
   * so only g can make a sum diverge, and only along a base with no upper end.
   * Each such base is walked out its tail with the others held at their median
   * and at both their 1e-6 quantiles (so a g that grows through a product is
   * seen): exactly, by the base's own sliver masses, where its support
   * enumerates (momentVerdict's test); by quadrature over its exact quantile
   * where it does not. Conservative: what cannot be certified is 'unknown'.
   */
  private sampledTails(name: string, env: Record<string, number>): { mean: Tail; second: Tail } {
    const out: { mean: Tail; second: Tail } = { mean: 'ok', second: 'ok' };
    const g = this.grounded(name);
    if (!g) return { mean: 'unknown', second: 'unknown' };
    const laws = new Map<string, DiscreteLaw>();
    for (const b of this.basesOf(name)) {
      const law = discreteLaw((this.rvs.get(b) as RV & { kind: 'base' }).dist, env);
      if (!law) return out; // no distribution: nothing is sampled either
      laws.set(b, law);
    }
    for (const [b, law] of laws) {
      if (law.hi !== Infinity) continue;
      const atoms = this.baseAtomsOf(b, env);
      const memo = new Map<number, number>();
      const upper = (u: number): number => {
        let k = memo.get(u);
        if (k === undefined) memo.set(u, (k = law.quantile(u, true)));
        return k;
      };
      for (const others of [
        (l: DiscreteLaw) => l.quantile(0.5),
        (l: DiscreteLaw) => l.quantile(1e-6, true),
        (l: DiscreteLaw) => l.quantile(1e-6),
      ]) {
        const at: Record<string, number> = { ...env };
        for (const [n, l] of laws) at[n] = others(l);
        const gAt = (x: number): number => {
          at[b] = x;
          try {
            return Math.abs(evaluate(g, at));
          } catch {
            return NaN;
          }
        };
        for (const [key, h] of [
          ['mean', gAt],
          ['second', (x: number) => gAt(x) ** 2],
        ] as const) {
          let tail: Tail;
          if (atoms && atoms !== 'cap') {
            let deep = 0;
            let shallow = 0;
            for (let i = 0; i < atoms.xs.length; i++) {
              if (atoms.p[i] === atoms.c[i]) continue; // not in a sliver
              const w = h(atoms.xs[i]);
              deep += w * (atoms.p[i] - atoms.n[i]);
              shallow += w * (atoms.n[i] - atoms.c[i]);
            }
            tail = tailOf(deep, shallow);
          } else tail = quantileTail(h, upper);
          out[key] = worseTail(out[key], tail);
        }
      }
    }
    return out;
  }

  /**
   * What a discrete variable draws over the visible x-range, as runs of stems:
   * a law of its own through stems() (whole numbers, the envelope when there
   * are too many), a derived one at its atoms' TRUE locations (windowAtoms),
   * or as the sampled histogram. With `select` — a P(…) row's bounds — only
   * the part it selects, strictness and all. Null for a variable that is not
   * discrete, or while its parameters declare no distribution. Cached per
   * parameter values, window and selection.
   */
  pmfRuns(
    name: string,
    env: Record<string, number>,
    view?: { lo: number; hi: number },
    select?: ProbBounds,
  ): PmfStems[] | null {
    if (this.discreteDist(name)) {
      const drawn = this.stems(name, env, view);
      if (!drawn) return null;
      return select ? selectStems(drawn.stems, drawn.law, integerBounds(select, env)) : [drawn.stems];
    }
    const pmf = this.pmfOf(name, env);
    if (!pmf) return null;
    const range = select ? atomRange(pmf, select, env) : { i0: 0, i1: pmf.xs.length - 1 };
    if (!range) return [];
    const ranges = select?.not
      ? [
          { i0: 0, i1: range.i0 - 1 },
          { i0: range.i1 + 1, i1: pmf.xs.length - 1 },
        ]
      : [range];
    if (pmf.binned) {
      // The histogram is one shape whatever the window; a selection keeps the
      // bins (and heavy atoms) whose centres it covers.
      const [from, to] = [pmf.xs[range.i0] ?? Infinity, pmf.xs[range.i1] ?? -Infinity];
      const keep = (x: number): boolean => !select || (x >= from && x <= to) !== !!select.not;
      return [pmf.binned.bulk, pmf.binned.heavy]
        .map(run => {
          const ks = run.ks.filter(keep);
          return { ...run, ks, ps: run.ps.filter((_, i) => keep(run.ks[i])) };
        })
        .filter(run => run.ks.length);
    }
    // Keyed by the atoms in view — which decide everything drawn, the stride
    // past STEM_MAX included — and the atoms selected: a pan that brings none
    // in or out is a hit.
    const slot = this.cache.get(name)!;
    const v0 = view ? firstAbove(pmf.xs, view.lo, true) : 0;
    const v1 = view ? firstAbove(pmf.xs, view.hi, false) - 1 : pmf.xs.length - 1;
    const key = `${v0},${v1};${ranges.map(r => `${r.i0},${r.i1}`).join(';')}`;
    slot.runs ??= new Map();
    let runs = slot.runs.get(key);
    if (!runs) {
      if (slot.runs.size >= 16) slot.runs.clear();
      runs = ranges.map(r => windowAtoms(pmf, r.i0, r.i1, view)).filter(run => run.ks.length);
      slot.runs.set(key, runs);
    }
    return runs;
  }

  /** The stem an E(…) marker stands on: the atom at x, within rounding, and
   *  its mass — else x itself, on the axis. */
  atomNear(name: string, x: number, env: Record<string, number>): { x: number; h: number } {
    const law = this.lawOf(name, env);
    if (law) {
      const k = wholeNumber(x);
      return Number.isNaN(k) ? { x, h: 0 } : { x: k, h: law.pmf(k) };
    }
    const pmf = this.pmfOf(name, env);
    if (pmf) {
      const i = firstAbove(pmf.xs, x, true);
      for (const j of [i - 1, i]) {
        if (j >= 0 && j < pmf.xs.length && sameAtom(pmf.xs[j], x)) return { x: pmf.xs[j], h: pmf.ps[j] };
      }
    }
    return { x, h: 0 };
  }
}

function validateDeclarations(declarations: ReadonlyMap<string, RV>): Map<string, string> {
  const broken = new Map<string, string>();
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, path: string[]): void => {
    const rv = declarations.get(name);
    if (!rv || state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      const cycle = path.slice(path.indexOf(name)).concat(name);
      for (const cn of cycle) broken.set(cn, `${cycle.join(' → ')} is circular.`);
      return;
    }
    state.set(name, 'visiting');
    if (rv.kind === 'derived') {
      for (const dep of freeVars(rv.expr)) {
        if (declarations.has(dep)) visit(dep, [...path, name]);
      }
    }
    state.set(name, 'done');
  };
  for (const name of declarations.keys()) visit(name, []);
  return broken;
}

// --- building the system from scanned rows ---

export interface BuildRVOpts {
  fnNames: ReadonlySet<string>;
  getFn: GetFn;
  ropts?: ResolveOpts;
  constNames: ReadonlySet<string>;
  /** The document's shadowed names (shadowedNames): `e` after `e := 2`. */
  valueNames?: ReadonlySet<string>;
  /** Name already claimed by a definition row (constant, function, field, …). */
  taken: (name: string) => boolean;
}

export interface BuiltRVs {
  /** Prepared declarations; callers transfer ownership to their Env. */
  declarations: ReadonlyMap<string, RV>;
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
export function buildRVDeclarations(scan: ReturnType<typeof scanRandomRows>, opts: BuildRVOpts): BuiltRVs {
  const declarations = new Map<string, RV>();
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
    } else if (declarations.has(name) || opts.taken(name)) {
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
      const d = parseDistribution(rhs, opts.fnNames, opts.valueNames);
      d.args = d.args.map(a => resolveExpr(a, opts.getFn, opts.ropts));
      for (const a of d.args) {
        for (const f of freeVars(a)) {
          if (names.has(f)) throw new Error('Distribution parameters cannot depend on a random variable.');
        }
        checkDerived(a, new Set(), opts.constNames);
      }
      declarations.set(name, { name, kind: 'base', dist: d });
    } catch (e) {
      errors.set(i, e instanceof Error ? e.message : String(e));
    }
  }
  for (const [i, { name, rhs }] of scan.derived) {
    if (!claim(i, name)) continue;
    try {
      const expr = resolveExpr(parseExpr(rhs, opts.fnNames, undefined, opts.valueNames), opts.getFn, opts.ropts);
      checkDerived(expr, names, opts.constNames);
      declarations.set(name, { name, kind: 'derived', expr });
    } catch (e) {
      errors.set(i, e instanceof Error ? e.message : String(e));
    }
  }

  // Cycles, then the ripple: a variable whose dependency failed fails too.
  const failed = validateDeclarations(declarations);
  for (const name of failed.keys()) declarations.delete(name);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of rowOf.keys()) {
      const rv = declarations.get(name);
      if (rv?.kind !== 'derived') continue;
      for (const dep of freeVars(rv.expr)) {
        if (names.has(dep) && !declarations.has(dep)) {
          failed.set(name, `${dep} has an error in its definition.`);
          declarations.delete(name);
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
  return { names, rowRV, errors, declarations };
}

/** Convenience for standalone probability clients; document analysis attaches
 * its Env declaration provider directly. */
export function buildRVSystem(sys: RVSystem, scan: ReturnType<typeof scanRandomRows>, opts: BuildRVOpts): BuiltRVs {
  const built = buildRVDeclarations(scan, opts);
  sys.useDeclarations(built.declarations);
  return built;
}
