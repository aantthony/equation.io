/** The continuous distribution zoo: Gamma, Beta, ChiSquared, StudentT,
 *  LogNormal, Cauchy, Weibull. Reference values are scipy.stats (1.17). */
import { describe, expect, it } from 'vitest';
import {
  type BaseDist,
  QUANTILE_STATS,
  RVSystem,
  SAMPLE_COUNT,
  buildRVSystem,
  densityExpr,
  paramProblem,
  parseDistribution,
  pdfExpr,
  probabilityValue,
  regionExpr,
  scanRandomRows,
} from './dist.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import { GLSL_PRELUDE, toGLSL } from './glsl.ts';
import { quadrature } from './integrate.ts';
import { classify } from './plot.ts';
import { compileProg, run } from './vm.ts';

const none = new Set<string>();
const dist = (rhs: string): BaseDist => parseDistribution(rhs, none);
const num = (value: number): Expr => ({ kind: 'num', value });
const pdfAt = (d: BaseDist, x: number, env: Record<string, number> = {}): number =>
  evaluate(pdfExpr(d, num(x)), env);
const cdf = (d: BaseDist, x: number, env: Record<string, number> = {}): number =>
  probabilityValue(d, undefined, num(x), env);
const sf = (d: BaseDist, x: number, env: Record<string, number> = {}): number =>
  probabilityValue(d, num(x), undefined, env);

const build = (rows: string[], constNames = new Set(['a', 'b', 'k'])) => {
  const sys = new RVSystem();
  const built = buildRVSystem(sys, scanRandomRows(rows), {
    fnNames: none,
    getFn: () => undefined,
    constNames,
    taken: () => false,
  });
  return { sys, built };
};

describe('parsing the zoo', () => {
  it('reads every family, its aliases, and any capitalization', () => {
    const kinds: Array<[string, string]> = [
      ['Gamma(2, 1)', 'gamma'], ['gamma(2, 1)', 'gamma'], ['Beta(2, 3)', 'beta'],
      ['ChiSquared(3)', 'chisquared'], ['chisq(3)', 'chisquared'], ['Chi2(3)', 'chisquared'],
      ['StudentT(5)', 'studentt'], ['T(5)', 'studentt'], ['t(5)', 'studentt'],
      ['LogNormal(0, 1)', 'lognormal'], ['Cauchy(0, 1)', 'cauchy'], ['Weibull(1.5, 2)', 'weibull'],
    ];
    for (const [rhs, kind] of kinds) expect(dist(rhs).kind).toBe(kind);
  });

  it('gives a bare name the standard member only where the family has one', () => {
    expect(dist('Cauchy').args).toEqual([num(0), num(1)]);
    expect(dist('LogNormal').args).toEqual([num(0), num(1)]);
    expect(() => dist('Gamma')).toThrow('Gamma(shape, rate) takes 2 arguments.');
    expect(() => dist('T')).toThrow('StudentT(df) takes 1 argument.');
    expect(() => dist('Beta(2)')).toThrow('Beta(a, b) takes 2 arguments.');
    expect(() => dist('Weibull(1, 2, 3)')).toThrow('Weibull(shape, scale) takes 2 arguments.');
    expect(() => dist('Poisson(3)')).toThrow(/Unknown distribution: Poisson\. Try .*Gamma\(shape, rate\)/);
  });

  it('refuses written-out parameters that declare no distribution, naming the one at fault', () => {
    expect(() => dist('Gamma(0, 1)')).toThrow('Gamma(shape, rate) needs shape > 0.');
    expect(() => dist('Gamma(2, -1)')).toThrow('Gamma(shape, rate) needs rate > 0.');
    expect(() => dist('Beta(2, 0)')).toThrow('Beta(a, b) needs b > 0.');
    expect(() => dist('Beta(-1, 2)')).toThrow('Beta(a, b) needs a > 0.');
    expect(() => dist('ChiSquared(0)')).toThrow('ChiSquared(df) needs df > 0.');
    expect(() => dist('T(-2)')).toThrow('StudentT(df) needs df > 0.');
    expect(() => dist('LogNormal(0, 0)')).toThrow('LogNormal(mu, sigma) needs sigma > 0.');
    expect(() => dist('Cauchy(0, -1)')).toThrow('Cauchy(location, scale) needs scale > 0.');
    expect(() => dist('Weibull(0, 1)')).toThrow('Weibull(shape, scale) needs shape > 0.');
    expect(() => dist('Normal(0, 0)')).toThrow('Normal(mean, sd) needs sd > 0.');
    expect(() => dist('Uniform(2, 2)')).toThrow('Uniform(lo, hi) needs lo < hi.');
    expect(() => dist('Exponential(-1)')).toThrow('Exponential(rate) needs rate > 0.');
    // Unconstrained parameters and sliders pass: their values are not known yet.
    expect(dist('LogNormal(-3, 1)').kind).toBe('lognormal');
    expect(dist('Cauchy(-3, 1)').kind).toBe('cauchy');
    expect(dist('Gamma(a, b)').kind).toBe('gamma');
  });

  it('judges slider values when they are known, and never a moving parameter', () => {
    expect(paramProblem('gamma', [2, 1])).toBeNull();
    expect(paramProblem('gamma', [null, -1])).toBe('Gamma(shape, rate) needs rate > 0.');
    expect(paramProblem('studentt', [NaN])).toBeNull();
    const { sys } = build(['X ~ Gamma(a, 1)', 'Y ~ Normal(0, b)', 'W = X + 1']);
    expect(sys.paramProblem('X', { a: -1, b: 1 }, none)).toBe('Gamma(shape, rate) needs shape > 0.');
    expect(sys.paramProblem('X', { a: 0.5, b: 1 }, none)).toBeNull();
    expect(sys.paramProblem('Y', { a: 1, b: 0 }, none)).toBe('Normal(mean, sd) needs sd > 0.');
    // b = sin(t) reads 0 at t = 0 and is a fine sd a moment later.
    expect(sys.paramProblem('Y', { a: 1, b: 0 }, new Set(['b']))).toBeNull();
    expect(sys.paramProblem('Y', { a: 1 }, none)).toBeNull(); // not evaluable here
    expect(sys.paramProblem('W', { a: -1, b: 1 }, none)).toBeNull(); // derived: its base reports
  });
});

describe('densities', () => {
  // [declaration, x, pdf(x)]
  const refs: Array<[string, number, number]> = [
    ['Gamma(2, 1)', 1.5, 0.33469524022264474],
    ['Gamma(0.5, 3)', 0.2, 1.1992065834103995],
    ['Gamma(50, 1)', 30, 0.00036813080120212124],
    ['ChiSquared(200)', 190, 0.018434335718067883],
    ['ChiSquared(1)', 0.5, 0.43939128946772243],
    ['Beta(80, 120)', 0.41, 10.947687044308923],
    ['Beta(0.5, 0.5)', 0.1, 1.0610329539459686],
    ['StudentT(3)', -2, 0.06750966066389291],
    ['StudentT(1000000)', 1.2, 0.1941859672888144],
    ['LogNormal(0.5, 0.75)', 2, 0.2572866664467846],
    ['Cauchy(1, 2)', 4, 0.04897075172058318],
    ['Weibull(2.5, 2)', 1.3, 0.4659573313431132],
  ];

  it('match reference values, large parameters included', () => {
    for (const [decl, x, want] of refs) expect(pdfAt(dist(decl), x), decl).toBeCloseTo(want, 10);
  });

  it('integrate to 1 — through a pole at the support edge too', () => {
    const decls = [
      'Gamma(2, 1)', 'Gamma(0.5, 3)', 'Gamma(50, 1)', 'ChiSquared(1)', 'ChiSquared(200)',
      'Beta(2, 3)', 'Beta(0.5, 0.5)', 'Beta(80, 120)', 'Beta(0.6, 4)',
      'StudentT(0.7)', 'StudentT(5)', 'LogNormal(0, 1)', 'Cauchy(1, 2)',
      'Weibull(0.6, 2)', 'Weibull(3, 1)',
    ];
    for (const decl of decls) {
      const d = dist(decl);
      const [lo, hi] = d.kind === 'beta' ? [0, 1]
        : d.kind === 'studentt' || d.kind === 'cauchy' ? [-Infinity, Infinity] : [0, Infinity];
      // Split at the bulk, as quadMoments does: the [0, ∞) change of variables
      // alone squeezes ChiSquared(200)'s peak between two Kronrod nodes.
      const mid = build([`X ~ ${decl}`]).sys.exactMoments('X', {})!.mean || 1;
      const f = (x: number) => pdfAt(d, x);
      expect(quadrature(f, lo, mid) + quadrature(f, mid, hi), decl).toBeCloseTo(1, 5);
    }
  });

  it('are exactly 0 off the support and never NaN, so a shaded region stays a region', () => {
    for (const decl of ['Gamma(0.5, 1)', 'ChiSquared(1)', 'Beta(0.5, 0.5)', 'LogNormal(0, 1)', 'Weibull(0.5, 1)']) {
      const d = dist(decl);
      for (const x of [-3, -1e-9]) expect(pdfAt(d, x), `${decl} at ${x}`).toBe(0);
      const region = regionExpr(d, num(-1), num(0.5));
      for (const x of [-0.5, 0, 1e-12, 0.25]) {
        expect(Number.isNaN(evaluate(region.kind === 'ineq' ? region.l : region, { x, y: 0.1 })), `${decl} region at ${x}`).toBe(false);
      }
    }
    expect(pdfAt(dist('Beta(2, 3)'), 1.5)).toBe(0);
  });

  it('take the true boundary value: a pole, the finite limit, or 0', () => {
    expect(pdfAt(dist('Gamma(0.5, 1)'), 0)).toBe(Infinity);
    expect(pdfAt(dist('Gamma(1, 2)'), 0)).toBe(2); // Exponential(2)
    expect(pdfAt(dist('Gamma(3, 2)'), 0)).toBe(0);
    expect(pdfAt(dist('ChiSquared(1)'), 0)).toBe(Infinity);
    expect(pdfAt(dist('ChiSquared(2)'), 0)).toBe(0.5);
    expect(pdfAt(dist('Beta(0.5, 2)'), 0)).toBe(Infinity);
    expect(pdfAt(dist('Beta(2, 0.5)'), 1)).toBe(Infinity);
    expect(pdfAt(dist('Beta(1, 3)'), 0)).toBe(3);
    expect(pdfAt(dist('Weibull(0.5, 1)'), 0)).toBe(Infinity);
    expect(pdfAt(dist('Weibull(1, 4)'), 0)).toBe(0.25);
    expect(pdfAt(dist('LogNormal(0, 1)'), 0)).toBe(0);
  });

  it('flatten to 0 while a slider holds an invalid parameter', () => {
    const cases: Array<[string, Record<string, number>, number]> = [
      ['Gamma(a, 1)', { a: -1 }, 1], ['Gamma(2, b)', { b: 0 }, 1], ['Beta(a, b)', { a: 2, b: -3 }, 0.5],
      ['ChiSquared(k)', { k: 0 }, 1], ['StudentT(k)', { k: -1 }, 0.3], ['LogNormal(0, b)', { b: -1 }, 1],
      ['LogNormal(0, b)', { b: 0 }, 1], ['Cauchy(0, b)', { b: -2 }, 1], ['Cauchy(0, b)', { b: 0 }, 1],
      ['Weibull(a, b)', { a: 1, b: -1 }, 1],
    ];
    for (const [decl, env, x] of cases) expect(pdfAt(dist(decl), x, env), decl).toBe(0);
  });

  it('compile for the og stack VM and the shader, agreeing with evaluate()', () => {
    const slots = new Map([['x', 0]]);
    for (const [decl, x] of refs) {
      const e = pdfExpr(dist(decl), { kind: 'var', name: 'x' });
      const prog = compileProg(e, slots);
      expect(run(prog, [x], new Float64Array(prog.depth)), decl).toBe(evaluate(e, { x }));
    }
    expect(toGLSL(pdfExpr(dist('Gamma(a, b)'), { kind: 'var', name: 'x' }))).toBe('eq_gammapdf(x, a, b)');
    expect(toGLSL(pdfExpr(dist('ChiSquared(k)'), { kind: 'var', name: 'x' }))).toBe('eq_gammapdf(x, (k / 2.0), 0.5)');
    expect(toGLSL(pdfExpr(dist('Beta(a, b)'), { kind: 'var', name: 'x' }))).toBe('eq_betapdf(x, a, b)');
    expect(toGLSL(pdfExpr(dist('T(k)'), { kind: 'var', name: 'x' }))).toBe('eq_tpdf(x, k)');
    expect(toGLSL(pdfExpr(dist('Weibull(a, b)'), { kind: 'var', name: 'x' }))).toBe('eq_weibullpdf(x, a, b)');
    for (const fn of ['eq_gammapdf', 'eq_betapdf', 'eq_tpdf', 'eq_weibullpdf', 'eq_lgamma', 'eq_log1pmx']) {
      expect(GLSL_PRELUDE).toContain(`float ${fn}(`);
    }
    // Helpers are defined before their first use (GLSL has no hoisting).
    expect(GLSL_PRELUDE.indexOf('float eq_lgamma(')).toBeLessThan(GLSL_PRELUDE.indexOf('float eq_gammapdf('));
    expect(GLSL_PRELUDE.indexOf('float eq_log1p(')).toBeLessThan(GLSL_PRELUDE.indexOf('float eq_tpdf('));
  });

  it('classify as curves and regions, with slider parameters as uniforms', () => {
    for (const decl of ['Gamma(a, b)', 'Beta(a, b)', 'ChiSquared(k)', 'T(k)', 'LogNormal(a, b)', 'Cauchy(a, b)', 'Weibull(a, b)']) {
      const consts = new Set(['a', 'b', 'k']);
      expect(classify(densityExpr(dist(decl)), consts).plot.type, decl).toBe('implicit2d');
      expect(classify(regionExpr(dist(decl), num(0.2), num(0.6)), consts).plot.type, decl).toBe('ineq2d');
    }
  });
});

describe('exact probabilities', () => {
  it('match closed forms and reference values', () => {
    expect(cdf(dist('Gamma(2, 3)'), 0.7)).toBeCloseTo(1 - Math.exp(-2.1) * 3.1, 12);
    expect(cdf(dist('ChiSquared(2)'), 3)).toBeCloseTo(1 - Math.exp(-1.5), 12);
    expect(cdf(dist('ChiSquared(1)'), 3.8414588206941205)).toBeCloseTo(0.95, 10);
    expect(cdf(dist('Beta(2, 3)'), 0.4)).toBeCloseTo(0.5248, 12);
    expect(cdf(dist('Beta(80, 120)'), 0.4)).toBeCloseTo(0.5038417015242476, 10);
    expect(cdf(dist('T(5)'), -2.5)).toBeCloseTo(0.027245049671188112, 10);
    expect(cdf(dist('T(1)'), 0.5)).toBeCloseTo(0.6475836176504333, 10);
    expect(cdf(dist('LogNormal(0.5, 0.75)'), 2)).toBeCloseTo(0.6016150059161275, 10);
    expect(cdf(dist('Cauchy(1, 2)'), 4)).toBeCloseTo(0.5 + Math.atan(1.5) / Math.PI, 12);
    expect(cdf(dist('Weibull(2.5, 2)'), 1.3)).toBeCloseTo(1 - Math.exp(-((1.3 / 2) ** 2.5)), 12);
    expect(probabilityValue(dist('Gamma(2, 1)'), num(1), num(3), {}))
      .toBeCloseTo(2 * Math.exp(-1) - 4 * Math.exp(-3), 12);
  });

  it('are 0 and 1 off the support, NaN under invalid sliders', () => {
    for (const decl of ['Gamma(2, 1)', 'ChiSquared(3)', 'Beta(2, 3)', 'LogNormal(0, 1)', 'Weibull(2, 1)']) {
      expect(cdf(dist(decl), -1)).toBe(0);
      expect(sf(dist(decl), -1)).toBe(1);
    }
    expect(cdf(dist('Beta(2, 3)'), 2)).toBe(1);
    expect(cdf(dist('Gamma(a, 1)'), 1, { a: -1 })).toBeNaN();
    expect(cdf(dist('T(k)'), 1, { k: 0 })).toBeNaN();
    expect(cdf(dist('Cauchy(0, b)'), 1, { b: 0 })).toBeNaN();
  });

  it('keep their digits in the survival tail instead of reading 1 − cdf', () => {
    const rel = (got: number, want: number) => expect(Math.abs(got / want - 1)).toBeLessThan(1e-9);
    rel(sf(dist('Gamma(3, 1)'), 60), 1.629586652937817e-23);
    rel(sf(dist('ChiSquared(4)'), 150), 2.035764090974152e-31);
    rel(sf(dist('Beta(2, 30)'), 0.9), 2.799999999999981e-29);
    rel(sf(dist('T(4)'), 1e5), 2.9999999979999997e-20);
    rel(sf(dist('LogNormal(0, 1)'), 1e5), 5.677979296840897e-31);
    rel(sf(dist('Cauchy(0, 1)'), 1e18), 1 / (Math.PI * 1e18));
    rel(sf(dist('Weibull(2, 1)'), 8), Math.exp(-64));
    rel(sf(dist('Exponential(2)'), 40), Math.exp(-80));
    // A window wholly in the upper tail differences the survival values.
    rel(probabilityValue(dist('Gamma(3, 1)'), num(60), num(61), {}), 1.629586652937817e-23 - 6.193026699820607e-24);
    rel(probabilityValue(dist('Cauchy(0, 1)'), num(1e17), num(2e17), {}), 1 / (Math.PI * 2e17));
  });

  it('are the integral of the density', () => {
    for (const [decl, lo, hi] of [
      ['Gamma(0.5, 3)', 0, 0.8], ['Beta(0.6, 4)', 0, 0.3], ['StudentT(2)', -1, 3],
      ['Weibull(0.6, 2)', 0, 5], ['LogNormal(0, 1)', 0.5, 4], ['ChiSquared(7)', 2, 9],
    ] as const) {
      const d = dist(decl);
      expect(probabilityValue(d, num(lo), num(hi), {}), decl)
        .toBeCloseTo(quadrature(x => pdfAt(d, x), lo, hi), 7);
    }
  });
});

describe('sampling: every column is the quantile transform of a stratified stream', () => {
  /** Sorted, a column must read back u = (i + ½)/N through the exact cdf:
   *  the sup-distance below is a Kolmogorov–Smirnov statistic with no
   *  sampling noise in it, so the bound is the quantile function's accuracy. */
  const ksOf = (decl: string): { ks: number; col: Float64Array; d: BaseDist } => {
    const { sys } = build([`X ~ ${decl}`]);
    const d = dist(decl);
    const col = sys.columns('X', {}).slice().sort();
    let ks = 0;
    // The upper half is compared on the survival side, where the digits are.
    for (let i = 0; i < SAMPLE_COUNT; i += 97) {
      const u = (i + 0.5) / SAMPLE_COUNT;
      const err = u < 0.5 ? cdf(d, col[i]) - u : (1 - u) - sf(d, col[i]);
      ks = Math.max(ks, Math.abs(err) / Math.min(u, 1 - u));
    }
    return { ks, col, d };
  };

  it('inverts the cdf to ~1e-8 RELATIVE to the tail mass, poles and power tails included', () => {
    for (const decl of [
      'Gamma(2, 1)', 'Gamma(0.3, 2)', 'Gamma(1.5, 1)', 'Gamma(50, 1)', 'Gamma(100000, 1)', 'ChiSquared(1)', 'ChiSquared(200)',
      'Beta(2, 3)', 'Beta(0.5, 0.5)', 'Beta(1.5, 1.2)', 'Beta(80, 120)', 'Beta(0.05, 5)', 'Beta(3000, 9000)',
      'StudentT(0.7)', 'StudentT(1)', 'StudentT(2)', 'StudentT(30)', 'StudentT(1000000)', 'StudentT(5000000)',
      'LogNormal(0.5, 0.75)', 'Cauchy(1, 2)', 'Weibull(0.5, 2)', 'Weibull(3, 1)',
    ]) {
      const { ks, col } = ksOf(decl);
      // LogNormal rides on the 1e-9 normalQuantile shared with Normal.
      expect(ks, decl).toBeLessThan(decl.startsWith('LogNormal') ? 1e-6 : 1e-8);
      expect(col.every(Number.isFinite), decl).toBe(true);
    }
  });

  it('falls back to Wilson–Hilferty past the table range, still a faithful Gamma', () => {
    expect(ksOf('Gamma(3000000, 1)').ks).toBeLessThan(1e-4);
  });

  it('reproduces the exact moments where they exist', () => {
    for (const decl of ['Gamma(2.5, 0.5)', 'ChiSquared(6)', 'Beta(2, 5)', 'StudentT(8)', 'LogNormal(0, 0.4)', 'Weibull(1.7, 3)']) {
      const { sys } = build([`X ~ ${decl}`]);
      const col = sys.columns('X', {});
      const m = sys.exactMoments('X', {})!;
      let s = 0;
      let s2 = 0;
      for (const x of col) { s += x; s2 += x * x; }
      const mean = s / col.length;
      expect(mean, decl).toBeCloseTo(m.mean, 4);
      expect(Math.sqrt(s2 / col.length - mean * mean), decl).toBeCloseTo(m.sd, 2);
    }
  });

  it('pins a quantile below the smallest double at the support edge, not at NaN', () => {
    // Gamma(0.01): a third of the mass sits below e^-100; the far quantiles
    // are below 1e-300 and read as (essentially) 0.
    const { sys } = build(['X ~ Gamma(0.01, 1)']);
    const col = sys.columns('X', {});
    expect(col.every(x => x >= 0 && Number.isFinite(x))).toBe(true);
    expect(sys.columns('X', {}).slice().sort()[SAMPLE_COUNT >> 1]).toBeLessThan(1e-25);
  });

  it('is NaN while a slider holds an invalid parameter', () => {
    const { sys } = build(['X ~ Gamma(a, 1)']);
    expect(Number.isNaN(sys.columns('X', { a: -2 })[0])).toBe(true);
    expect(sys.columns('X', { a: 2 })[0]).toBeGreaterThan(0);
  });
});

describe('moments and the readout branch', () => {
  it('reports exact μ and σ', () => {
    const m = (decl: string) => build([`X ~ ${decl}`]).sys.exactMoments('X', {})!;
    expect(m('Gamma(3, 2)')).toEqual({ mean: 1.5, sd: Math.sqrt(3) / 2 });
    expect(m('ChiSquared(8)')).toEqual({ mean: 8, sd: 4 });
    expect(m('Beta(2, 6)').mean).toBeCloseTo(0.25, 12);
    expect(m('Beta(2, 6)').sd).toBeCloseTo(Math.sqrt(12 / (64 * 9)), 12);
    expect(m('StudentT(6)')).toEqual({ mean: 0, sd: Math.sqrt(1.5) });
    expect(m('LogNormal(0, 1)').mean).toBeCloseTo(Math.exp(0.5), 12);
    expect(m('LogNormal(0, 1)').sd).toBeCloseTo(Math.sqrt((Math.E - 1) * Math.E), 12);
    expect(m('Weibull(1, 4)').mean).toBeCloseTo(4, 10); // Exponential(1/4)
    expect(m('Weibull(1, 4)').sd).toBeCloseTo(4, 10);
    expect(m('Weibull(2, 1)').mean).toBeCloseTo(Math.sqrt(Math.PI) / 2, 10);
  });

  it('says a moment does not exist rather than estimating it', () => {
    const m = (decl: string) => build([`X ~ ${decl}`]).sys.exactMoments('X', {})!;
    expect(m('Cauchy(3, 2)')).toEqual({ mean: NaN, sd: NaN });
    expect(m('StudentT(1)')).toEqual({ mean: NaN, sd: NaN });
    expect(m('StudentT(0.5)')).toEqual({ mean: NaN, sd: NaN });
    expect(m('StudentT(1.5)')).toEqual({ mean: 0, sd: Infinity });
    expect(m('StudentT(2)')).toEqual({ mean: 0, sd: Infinity });
    expect(m('StudentT(2.01)').sd).toBeCloseTo(Math.sqrt(201), 6);
    const { sys } = build(['X ~ Cauchy(3, 2)', 'T1 ~ StudentT(1)']);
    expect(sys.mean('X', {})).toBeNaN();
    expect(sys.meanUnstable('X', {})).toBe(true);
    expect(sys.meanUnstable('T1', {})).toBe(true);
  });

  it('routes variables built on Cauchy and low-df StudentT to median/IQR', () => {
    // No mean at all: the robust readout, and E(…) declines a number.
    for (const decl of ['Cauchy(0, 1)', 'StudentT(1)', 'StudentT(0.8)']) {
      const { sys } = build([`X ~ ${decl}`, 'Y = X + 1', 'Z ~ Normal(0, 1)', 'S = X + Z']);
      expect(sys.quadMoments('Y', {}), decl).toBeNull();
      const r = sys.curve('Y', {})!.robust!;
      expect(r, decl).toBeDefined();
      expect(r.meanOk, decl).toBe(false);
      expect(r.median, decl).toBeCloseTo(1, 2);
      expect(sys.mean('Y', {}), decl).toBeNaN();
      expect(sys.meanUnstable('Y', {}), decl).toBe(true);
      expect(sys.curve('S', {})!.robust, decl).toBeDefined(); // two bases: the other tier
    }
    const { sys: c } = build(['X ~ Cauchy(0, 1)', 'Y = X + 1']);
    expect(c.curve('Y', {})!.robust!.iqr).toBeCloseTo(2, 2); // quartiles at ±1
  });

  it('routes an infinite variance to median/IQR while keeping the mean that exists', () => {
    // σ = ∞ for 1 < df ≤ 2, but the grid σ is a finite number (≈ 3 at df = 2)
    // that would print as fact. The mean, 1, exists and is kept for E(…).
    for (const df of [1.5, 2]) {
      const { sys } = build([`X ~ StudentT(${df})`, 'Y = X + 1', 'Z ~ Normal(0, 1)', 'S = X + Z']);
      expect(sys.quadMoments('Y', {})).toEqual({ mean: expect.closeTo(1, 9), sd: Infinity, mass: expect.closeTo(1, 9) });
      const r = sys.curve('Y', {})!.robust!;
      expect(r, `df ${df}`).toBeDefined();
      expect(r.meanOk).toBe(true);
      expect(sys.mean('Y', {})).toBeCloseTo(1, 6);
      expect(sys.meanUnstable('Y', {})).toBe(false);
      expect(sys.curve('S', {})!.robust, `df ${df}`).toBeDefined();
    }
  });

  it('keeps μ, σ where the transform tames the tail or the variance exists', () => {
    const { sys } = build([
      'X ~ StudentT(2)', 'C ~ Cauchy(0, 1)', 'A = sin(X)', 'B = ln(abs(X))', 'D = atan(C)', 'F = abs(C)^0.3',
      'T3 ~ StudentT(3)', 'G = T3 + 1', 'L ~ LogNormal(0, 1)', 'H = 2L + 1',
    ]);
    for (const name of ['A', 'B', 'D', 'F']) expect(sys.curve(name, {})!.robust, name).toBeUndefined();
    expect(sys.quadMoments('G', {})!.sd).toBeCloseTo(Math.sqrt(3), 6);
    expect(sys.quadMoments('H', {})!.mean).toBeCloseTo(2 * Math.exp(0.5) + 1, 6);
  });
});

describe('exact closure rules', () => {
  const law = (rows: string[], name: string) => build(rows).sys.exactDist(name);
  const val = (e: Expr, env: Record<string, number> = {}) => evaluate(e, env);

  it('sums independent Gammas that share a rate', () => {
    const d = law(['X ~ Gamma(2, 3)', 'Y ~ Gamma(0.5, 3)', 'S = X + Y'], 'S')!;
    expect(d.kind).toBe('gamma');
    expect(d.args.map(a => val(a))).toEqual([2.5, 3]);
    // One slider in both rates is the same rate, whatever it reads.
    const s = law(['X ~ Gamma(2, b)', 'Y ~ Gamma(a, b)', 'S = X + Y'], 'S')!;
    expect(s.args.map(a => val(a, { a: 1.5, b: 0.25 }))).toEqual([3.5, 0.25]);
  });

  it('declines different rates, shifts, and coefficients that could leave the family', () => {
    expect(law(['X ~ Gamma(2, 3)', 'Y ~ Gamma(2, 4)', 'S = X + Y'], 'S')).toBeNull();
    expect(law(['X ~ Gamma(2, a)', 'Y ~ Gamma(2, b)', 'S = X + Y'], 'S')).toBeNull(); // equal only by accident
    expect(law(['X ~ Gamma(2, 3)', 'S = X + 1'], 'S')).toBeNull();
    expect(law(['X ~ Gamma(2, 3)', 'S = -X'], 'S')).toBeNull();
    expect(law(['X ~ Gamma(2, 3)', 'S = a X'], 'S')).toBeNull(); // a slider may cross 0
    expect(law(['X ~ Gamma(2, 3)', 'Y ~ Gamma(2, 3)', 'S = X - Y'], 'S')).toBeNull();
    expect(law(['X ~ Gamma(2, 3)', 'Y ~ Gamma(2, 3)', 'S = X Y'], 'S')).toBeNull();
    expect(law(['X ~ Gamma(2, 3)', 'N1 ~ Normal(0, 1)', 'S = X + N1'], 'S')).toBeNull();
  });

  it('scales: c·Gamma(α, β) is Gamma(α, β/c), and scaled rates may then agree', () => {
    const d = law(['X ~ Gamma(2, 3)', 'S = 4X'], 'S')!;
    expect(d.args.map(a => val(a))).toEqual([2, 0.75]);
    const m = law(['X ~ Gamma(2, 3)', 'Y ~ Gamma(5, 6)', 'S = X + 2Y'], 'S')!; // 6/2 = 3
    expect(m.args.map(a => val(a))).toEqual([7, 3]);
    const sl = law(['X ~ Gamma(a, b)', 'S = X/2'], 'S')!;
    expect(sl.args.map(a => val(a, { a: 3, b: 5 }))).toEqual([3, 10]);
  });

  it('never mistakes X + X for a sum of independent copies', () => {
    // 2X is Gamma(α, β/2): same shape, doubled scale. Gamma(2α, β) is what
    // two INDEPENDENT copies would give.
    const d = law(['X ~ Gamma(2, 3)', 'S = X + X'], 'S')!;
    expect(d.args.map(a => val(a))).toEqual([2, 1.5]);
    const mixed = law(['X ~ Gamma(2, 3)', 'Y ~ Gamma(1, 1.5)', 'S = X + Y + X'], 'S')!;
    expect(mixed.args.map(a => val(a))).toEqual([3, 1.5]);
    const { sys } = build(['X ~ Gamma(2, 3)', 'S = X + X']);
    expect(sys.exactMoments('S', {})!.sd).toBeCloseTo(2 * Math.sqrt(2) / 3, 12);
  });

  it('treats ChiSquared and Exponential as the Gammas they are', () => {
    const chi = law(['X ~ ChiSquared(3)', 'Y ~ ChiSquared(4)', 'S = X + Y'], 'S')!;
    expect(chi.args.map(a => val(a))).toEqual([3.5, 0.5]); // ChiSquared(7)
    const erlang = law(['X ~ Exponential(2)', 'Y ~ Exponential(2)', 'W ~ Exponential(2)', 'S = X + Y + W'], 'S')!;
    expect(erlang.args.map(a => val(a))).toEqual([3, 2]);
    // A lone scaled exponential stays an Exponential (the older rule).
    expect(law(['X ~ Exponential(2)', 'S = 4X'], 'S')!.kind).toBe('exponential');
    const { sys } = build(['X ~ ChiSquared(3)', 'Y ~ ChiSquared(4)', 'S = X + Y']);
    expect(sys.exactProbability('S', undefined, num(14.067140449340167), {})).toBeCloseTo(0.95, 10);
  });

  it('squares a standard normal into ChiSquared(1) — and only a standard one', () => {
    for (const rhs of ['Z^2', 'Z Z', 'Z*Z']) {
      const d = law(['Z ~ Normal(0, 1)', `Q = ${rhs}`], 'Q')!;
      expect(d.kind, rhs).toBe('chisquared');
      expect(d.args).toEqual([num(1)]);
    }
    expect(law(['Z ~ N', 'Q = Z^2'], 'Q')!.kind).toBe('chisquared');
    expect(law(['Z ~ N', 'W = Z', 'Q = W^2'], 'Q')!.kind).toBe('chisquared'); // through a rename
    expect(law(['Z ~ Normal(0, 2)', 'Q = Z^2'], 'Q')).toBeNull();
    expect(law(['Z ~ Normal(1, 1)', 'Q = Z^2'], 'Q')).toBeNull();
    // Sliders reading 0 and 1 right now are not a standard normal.
    expect(law(['Z ~ Normal(a, b)', 'Q = Z^2'], 'Q')).toBeNull();
    expect(law(['Z ~ N', 'Y ~ N', 'Q = Z Y'], 'Q')).toBeNull(); // independent product
    expect(law(['Z ~ N', 'Q = Z^3'], 'Q')).toBeNull();
    expect(law(['Z ~ N', 'Q = Z^2 + 1'], 'Q')).toBeNull();
    expect(law(['U1 ~ Uniform(0, 1)', 'Q = U1^2'], 'Q')).toBeNull();
    const { sys } = build(['Z ~ N', 'Q = Z^2']);
    expect(sys.exactProbability('Q', undefined, num(3.8414588206941205), {})).toBeCloseTo(0.95, 10);
  });

  it('agrees with the sampled law it replaces', () => {
    const { sys } = build(['X ~ Gamma(2, 3)', 'Y ~ Gamma(1.5, 3)', 'S = X + Y', 'Z ~ N', 'Q = Z^2']);
    const d = sys.exactDist('S')!;
    expect(sys.probability(parseExpr('S < 1'), {})).toBeCloseTo(cdf(d, 1), 2);
    expect(sys.probability(parseExpr('Q < 1'), {})).toBeCloseTo(cdf(sys.exactDist('Q')!, 1), 2);
  });
});

describe('review follow-ups', () => {
  const analyzeLike = (rows: string[]) => build(rows).sys;

  it('#1 a mean that does not exist is not printed just because the base law has one', () => {
    // E(X²) = ∞ for StudentT(2); the + Y changes nothing about that.
    const sys = analyzeLike(['X ~ T(2)', 'Y ~ Normal(0, 1)', 'W = X^2 + Y']);
    expect(sys.mean('W', {})).toBeNaN();
    expect(sys.meanUnstable('W', {})).toBe(true);
    expect(sys.curve('W', {})!.robust!.meanOk).toBe(false);
  });

  it('#2 a mean that exists is still printed when only the variance is unstable', () => {
    const ln = analyzeLike(['X ~ LogNormal(0, 1.5)', 'Y ~ LogNormal(0, 1.5)', 'W = X Y']);
    expect(ln.curve('W', {})!.robust).toBeDefined();
    expect(ln.meanUnstable('W', {})).toBe(false);
    expect(ln.mean('W', {})).toBeGreaterThan(8.5); // true e^2.25 = 9.49; the grid reads ≈ 9.15
    expect(ln.mean('W', {})).toBeLessThan(10);
    const c = analyzeLike(['X ~ Cauchy', 'Z ~ Normal(0, 1)', 'W = sqrt(abs(X)) + 0 Z']);
    expect(c.meanUnstable('W', {})).toBe(false);
    expect(c.mean('W', {})).toBeCloseTo(Math.SQRT2, 1);
    // Pre-existing families: rows that printed a mean on main keep printing it.
    const u = analyzeLike(['X ~ Uniform(0, 1)', 'Z ~ Uniform(0, 1)', 'W = X^(-0.6) + 0 Z']);
    expect(u.mean('W', {})).toBeCloseTo(2.5, 0);
    const e = analyzeLike(['X ~ Exponential(1)', 'Z ~ Normal(0, 1)', 'W = exp(0.6 X) + 0 Z']);
    expect(e.mean('W', {})).toBeCloseTo(2.5, 0);
    const n = analyzeLike(['X ~ Normal(0, 1)', 'Z ~ Normal(0, 1)', 'W = exp(0.5 X Z)']);
    expect(n.mean('W', {})).toBeCloseTo(1 / Math.sqrt(0.75), 1); // tail index 2: σ = ∞, mean fine
    // …and an index-1 tail (no mean) is declined whatever the family.
    const r = analyzeLike(['X ~ Normal(0, 1)', 'Y ~ Normal(0, 1)', 'W = X/Y']);
    expect(r.mean('W', {})).toBeNaN();
  });

  it('#3 quadrature keeps a converged mean when only the second moment diverges', () => {
    const sys = analyzeLike(['X ~ T(3)', 'Y = X^2']);
    const qm = sys.quadMoments('Y', {})!;
    expect(qm.mean).toBeCloseTo(3, 6);
    expect(qm.sd).toBe(Infinity);
    expect(sys.mean('Y', {})).toBeCloseTo(3, 6);
    expect(sys.meanUnstable('Y', {})).toBe(false);
    // An odd integrand cancels to 0 by symmetry without converging absolutely.
    const c = analyzeLike(['X ~ T(1)', 'Y = X^3']);
    expect(c.quadMoments('Y', {})).toBeNull();
  });

  it('#5 location–scale closure: Cauchy sums and shifts, scaled LogNormal', () => {
    const law = (rows: string[], name: string) => build(rows).sys.exactDist(name);
    const vals = (d: BaseDist, env: Record<string, number> = {}) => d.args.map(a => evaluate(a, env));
    expect(vals(law(['X ~ Cauchy(0, 1)', 'Y = X + 1'], 'Y')!)).toEqual([1, 1]);
    expect(law(['X ~ Cauchy(0, 1)', 'Y = X + 1'], 'Y')!.kind).toBe('cauchy');
    expect(vals(law(['X ~ Cauchy(0, 1)', 'Y = 2X'], 'Y')!)).toEqual([0, 2]);
    expect(vals(law(['X ~ Cauchy(1, 2)', 'Y = -3X + 1'], 'Y')!)).toEqual([-2, 6]);
    expect(vals(law(['X ~ Cauchy(1, 2)', 'C ~ Cauchy(3, 0.5)', 'Y = X + C'], 'Y')!)).toEqual([4, 2.5]);
    expect(vals(law(['X ~ Cauchy(1, 2)', 'Y = X + X'], 'Y')!)).toEqual([2, 4]); // 2X, not two copies
    expect(vals(law(['X ~ Cauchy(1, 2)', 'Y = a X'], 'Y')!, { a: -2 })).toEqual([-2, 4]);
    expect(law(['X ~ Cauchy(1, 2)', 'Z ~ Normal(0, 1)', 'Y = X + Z'], 'Y')).toBeNull();
    const ln = law(['X ~ LogNormal(0.5, 0.75)', 'Y = 4X'], 'Y')!;
    expect(ln.kind).toBe('lognormal');
    expect(vals(ln)[0]).toBeCloseTo(0.5 + Math.log(4), 12);
    expect(vals(ln)[1]).toBe(0.75);
    expect(law(['X ~ LogNormal(0, 1)', 'Y = -X'], 'Y')).toBeNull();
    expect(law(['X ~ LogNormal(0, 1)', 'Y = X + 1'], 'Y')).toBeNull();
    expect(law(['X ~ LogNormal(0, 1)', 'Y = a X'], 'Y')).toBeNull();
  });

  it('#8 Weibull moments survive tiny shapes: log space, Infinity past double range', () => {
    const m = (decl: string) => build([`X ~ ${decl}`]).sys.exactMoments('X', {})!;
    const w = m('Weibull(0.05, 1)'); // mean Γ(21) = 20!, sd √(Γ(41) − Γ(21)²)
    expect(w.mean / 2432902008176640000).toBeCloseTo(1, 10);
    expect(w.sd / Math.sqrt(8.159152832419786e47)).toBeCloseTo(1, 8);
    const huge = m('Weibull(0.01, 1)');
    expect(huge.mean / 9.332621544394415e157).toBeCloseTo(1, 8); // 100!
    expect(huge.sd / 2.8083053027846e187).toBeCloseTo(1, 8); // √200!, though 200! itself overflows
    expect(m('Weibull(0.004, 1)')).toEqual({ mean: Infinity, sd: Infinity }); // finite in truth, never NaN
    // A finite-variance law is not a heavy-tailed base, whatever its moments overflow to.
    const sys = analyzeLike(['X ~ Weibull(0.004, 1)', 'Z ~ Normal(0, 1)', 'S = min(X, 1) + Z']);
    expect(sys.curve('S', {})!.robust).toBeUndefined();
  });

  it('#9 exact probabilities stay exact-grade at astronomically large parameters', () => {
    expect(cdf(dist('Beta(1000000000000, 1000000000000)'), 0.5)).toBeCloseTo(0.5, 9);
    expect(cdf(dist('Gamma(10000000000000, 1)'), 1e13)).toBeCloseTo(0.5 + 1 / (3 * Math.sqrt(2 * Math.PI * 1e13)), 9);
    expect(cdf(dist('Gamma(10000000000000, 1)'), 1e13 + 2e6 * Math.sqrt(10))).toBeCloseTo(0.9772, 3);
    expect(cdf(dist('Beta(3, 1000000000000)'), 2.6740603137235617e-12)).toBeCloseTo(0.5, 6); // → Gamma(3)/b
    expect(sf(dist('ChiSquared(40000000000000)'), 4e13)).toBeCloseTo(0.5, 6);
    const { sys } = build(['X ~ Beta(30000000, 50000000)']);
    const col = sys.columns('X', {}).slice().sort();
    expect(col.every(Number.isFinite)).toBe(true);
    expect(col[SAMPLE_COUNT >> 1]).toBeCloseTo(0.375, 6);
  });

  it('#10 the quantile-table cache is LRU: a table read every frame outlives a slider trail', () => {
    const fixed = build(['X ~ Gamma(7.0625, 1)']).sys;
    fixed.columns('X', {});
    const before = QUANTILE_STATS.builds;
    for (let k = 0; k < 150; k++) {
      build([`S ~ Gamma(${9 + k / 1024}, 1)`]).sys.columns('S', {}); // the dragged shape
      fixed.resample(k + 1);
      fixed.columns('X', {}); // the fixed variable, every frame
    }
    fixed.resample(0);
    expect(QUANTILE_STATS.builds - before).toBe(150);
  });
});
