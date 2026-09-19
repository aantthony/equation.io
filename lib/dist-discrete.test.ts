/** The discrete distributions: Binomial, Poisson, Geometric, NegativeBinomial,
 *  Bernoulli, DiscreteUniform. Reference values are scipy.stats (1.17). */
import { describe, expect, it, vi } from 'vitest';
import {
  type BaseDist,
  type ProbBounds,
  RVSystem,
  STEM_MAX,
  STEM_STATS,
  buildRVSystem,
  densityExpr,
  discreteLaw,
  integerBounds,
  isDiscrete,
  paramProblem,
  parseDistribution,
  pdfExpr,
  pmfExpr,
  probabilityValue,
  regionExpr,
  scanRandomRows,
  selectStems,
  toProbability,
} from './dist.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import { toGLSL } from './glsl.ts';
import { binomPmf, discreteUniformPmf, negBinomPmf, poissonPmf, wholeNumber } from './specfn.ts';
import { compileProg, run } from './vm.ts';

const none = new Set<string>();
const dist = (rhs: string): BaseDist => parseDistribution(rhs, none);
const num = (value: number): Expr => ({ kind: 'num', value });
const pmfAt = (d: BaseDist, k: number, env: Record<string, number> = {}): number =>
  evaluate(pmfExpr(d, num(k))!, env);
/** The exact value of a P(…) body over the one variable X ~ rhs. */
const P = (rhs: string, body: string, env: Record<string, number> = {}): number => {
  const s = toProbability(parseExpr(body, none), new Set(['X'])).single!;
  return probabilityValue(dist(rhs), s.lo, s.hi, env, s);
};
const bounds = (body: string): ProbBounds => toProbability(parseExpr(body, none), new Set(['X'])).single!;

const build = (rows: string[], constNames = new Set(['a', 'b', 'n', 'p'])) => {
  const sys = new RVSystem();
  const built = buildRVSystem(sys, scanRandomRows(rows), {
    fnNames: none,
    getFn: () => undefined,
    constNames,
    taken: () => false,
  });
  return { sys, built };
};

const LAWS = [
  'Binomial(10, 0.3)', 'Binomial(1000, 0.3)', 'Binomial(7, 0)', 'Binomial(7, 1)', 'Binomial(0, 0.4)',
  'Poisson(3)', 'Poisson(0.01)', 'Poisson(500)', 'Geometric(0.2)', 'Geometric(1)',
  'NegativeBinomial(3, 0.4)', 'NegativeBinomial(2.5, 0.4)', 'NegativeBinomial(4, 1)',
  'Bernoulli(0.3)', 'Bernoulli(0)', 'Bernoulli(1)', 'DiscreteUniform(-2, 4)', 'DiscreteUniform(5, 5)',
];

describe('parsing the discrete families', () => {
  it('reads every family, its aliases, any capitalization, and marks it discrete', () => {
    const kinds: Array<[string, string]> = [
      ['Binomial(10, 0.3)', 'binomial'], ['binom(10, 0.3)', 'binomial'], ['Poisson(3)', 'poisson'], ['POIS(3)', 'poisson'],
      ['Geometric(0.2)', 'geometric'], ['Geom(0.2)', 'geometric'], ['NegativeBinomial(3, 0.4)', 'negbinomial'],
      ['NegBin(3, 0.4)', 'negbinomial'], ['Bernoulli(0.5)', 'bernoulli'], ['DiscreteUniform(1, 6)', 'discreteuniform'],
    ];
    for (const [rhs, kind] of kinds) {
      expect(dist(rhs).kind).toBe(kind);
      expect(isDiscrete(dist(rhs))).toBe(true);
    }
    expect(isDiscrete(dist('Normal(0, 1)'))).toBe(false);
  });

  it('has no standard member: a bare name says what it takes', () => {
    expect(() => dist('Poisson')).toThrow('Poisson(mean) takes 1 argument.');
    expect(() => dist('Binomial(10)')).toThrow('Binomial(n, p) takes 2 arguments.');
  });

  it('refuses parameters that declare no distribution, naming the one at fault', () => {
    expect(() => dist('Binomial(2.5, 0.3)')).toThrow('Binomial(n, p) needs a whole number n ≥ 0 (n = 2.5).');
    expect(() => dist('Binomial(-1, 0.3)')).toThrow('Binomial(n, p) needs a whole number n ≥ 0 (n = -1).');
    expect(() => dist('Binomial(10, 1.2)')).toThrow('Binomial(n, p) needs 0 ≤ p ≤ 1.');
    expect(() => dist('Poisson(0)')).toThrow('Poisson(mean) needs mean > 0.');
    expect(() => dist('Geometric(0)')).toThrow('Geometric(p) needs 0 < p ≤ 1.');
    expect(() => dist('NegativeBinomial(0, 0.5)')).toThrow('NegativeBinomial(r, p) needs r > 0.');
    expect(() => dist('NegBin(2, 0)')).toThrow('NegativeBinomial(r, p) needs 0 < p ≤ 1.');
    expect(() => dist('Bernoulli(-0.1)')).toThrow('Bernoulli(p) needs 0 ≤ p ≤ 1.');
    expect(() => dist('DiscreteUniform(1, 6.5)')).toThrow('DiscreteUniform(a, b) needs a whole number b (b = 6.5).');
    expect(() => dist('DiscreteUniform(3, 2)')).toThrow('DiscreteUniform(a, b) needs a ≤ b.');
  });

  it('accepts the degenerate members and a whole number that arrives with rounding', () => {
    for (const rhs of ['Binomial(0, 0.5)', 'Binomial(5, 0)', 'Binomial(5, 1)', 'Geometric(1)', 'NegBin(0.5, 1)', 'DiscreteUniform(2, 2)']) {
      expect(() => dist(rhs)).not.toThrow();
    }
    expect(paramProblem('binomial', [0.1 * 30, 0.5])).toBeNull(); // 3.0000000000000004
    expect(wholeNumber(0.1 * 30)).toBe(3);
    expect(wholeNumber(2.5)).toBeNaN();
    expect(wholeNumber(1e15 + 0.5)).toBeNaN();
    expect(wholeNumber(Infinity)).toBeNaN();
  });
});

describe('pmf', () => {
  it('matches scipy', () => {
    expect(pmfAt(dist('Binomial(10, 0.3)'), 3)).toBeCloseTo(0.26682793200000005, 14);
    expect(pmfAt(dist('Poisson(3)'), 2)).toBeCloseTo(0.22404180765538775, 14);
    expect(pmfAt(dist('Geometric(0.2)'), 1)).toBeCloseTo(0.2, 15); // trials: the support starts at 1
    expect(pmfAt(dist('Geometric(0.2)'), 4)).toBeCloseTo(0.1024, 14);
    expect(pmfAt(dist('Geometric(0.2)'), 0)).toBe(0);
    expect(pmfAt(dist('NegativeBinomial(3, 0.4)'), 0)).toBeCloseTo(0.064, 15); // failures: the support starts at 0
    expect(pmfAt(dist('NegativeBinomial(3, 0.4)'), 2)).toBeCloseTo(0.13824, 14);
    expect(pmfAt(dist('NegativeBinomial(2.5, 0.4)'), 3)).toBeCloseTo(0.1434409146652377, 13);
    expect(pmfAt(dist('Bernoulli(0.3)'), 1)).toBeCloseTo(0.3, 15);
    expect(pmfAt(dist('Bernoulli(0.3)'), 0)).toBeCloseTo(0.7, 15);
    expect(pmfAt(dist('DiscreteUniform(-2, 4)'), -2)).toBeCloseTo(1 / 7, 15);
  });

  it('stays in range for huge parameters: no overflow, no NaN, digits intact', () => {
    expect(binomPmf(300, 1000, 0.3)).toBeCloseTo(0.027521003821268583, 13);
    expect(binomPmf(0, 1000, 0.3) / 1.2532566399655038e-155).toBeCloseTo(1, 10); // (0.7)^1000
    expect(poissonPmf(500, 500)).toBeCloseTo(0.017838267869512373, 13);
    expect(poissonPmf(1e9, 1e9) * Math.sqrt(2 * Math.PI * 1e9)).toBeCloseTo(1, 9);
    expect(binomPmf(5e11, 1e12, 0.5) * Math.sqrt(Math.PI * 5e11)).toBeCloseTo(1, 9);
    expect(negBinomPmf(1e6, 1e6, 0.5)).toBeGreaterThan(0);
    for (const v of [binomPmf(1e5, 1e6, 0.3), poissonPmf(10, 1e6), negBinomPmf(3, 1e8, 0.999)]) {
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(LAWS)('%s sums to 1 over its support', rhs => {
    const law = discreteLaw(dist(rhs), {})!;
    const hi = Math.min(law.hi, law.quantile(1e-15, true) + 5);
    let sum = 0;
    for (let k = law.lo; k <= hi; k++) sum += law.pmf(k);
    expect(sum).toBeCloseTo(1, 12);
  });

  it('is exactly 0 — never NaN — off the support and between the whole numbers', () => {
    for (const rhs of LAWS) {
      const d = dist(rhs);
      for (const k of [-1, -0.5, 0.5, 2.5, 1e9 + 0.5, 1e300, -1e300, Infinity, -Infinity]) {
        if (rhs.startsWith('DiscreteUniform') && k === -1) continue; // on that support
        expect(pmfAt(d, k), `${rhs} at ${k}`).toBe(0);
      }
      expect(pmfAt(d, NaN)).toBe(0);
    }
    expect(pmfAt(dist('Binomial(10, 0.3)'), 11)).toBe(0);
    expect(pmfAt(dist('DiscreteUniform(-2, 4)'), 5)).toBe(0);
  });

  it('is 0 while a parameter is invalid, like the densities', () => {
    expect(binomPmf(1, 2.5, 0.3)).toBe(0);
    expect(binomPmf(1, 3, 1.5)).toBe(0);
    expect(binomPmf(1, NaN, 0.5)).toBe(0);
    expect(binomPmf(1, Infinity, 0.5)).toBe(0);
    expect(poissonPmf(1, 0)).toBe(0);
    expect(poissonPmf(1, Infinity)).toBe(0);
    expect(negBinomPmf(1, -1, 0.5)).toBe(0);
    expect(negBinomPmf(1, 2, 0)).toBe(0);
    expect(discreteUniformPmf(1, 3, 2)).toBe(0);
    expect(discreteUniformPmf(1, 0.5, 2)).toBe(0);
  });

  it('puts the degenerate members on their atom (no 0·ln 0)', () => {
    expect(pmfAt(dist('Binomial(7, 0)'), 0)).toBe(1);
    expect(pmfAt(dist('Binomial(7, 0)'), 1)).toBe(0);
    expect(pmfAt(dist('Binomial(7, 1)'), 7)).toBe(1);
    expect(pmfAt(dist('Binomial(7, 1)'), 6)).toBe(0);
    expect(pmfAt(dist('Binomial(0, 0.4)'), 0)).toBe(1);
    expect(pmfAt(dist('Geometric(1)'), 1)).toBe(1);
    expect(pmfAt(dist('Geometric(1)'), 2)).toBe(0);
    expect(pmfAt(dist('NegativeBinomial(4, 1)'), 0)).toBe(1);
  });

  it('evaluates identically through evaluate and the stack VM; a shader refuses it', () => {
    for (const rhs of LAWS) {
      const e = pmfExpr(dist(rhs), { kind: 'var', name: 'k' })!;
      const prog = compileProg(e, new Map([['k', 0]]));
      for (const k of [-1, 0, 1, 2, 2.5, 7, 300]) {
        expect(run(prog, [k], new Float64Array(prog.depth)), `${rhs} at ${k}`).toBe(evaluate(e, { k }));
      }
      expect(() => toGLSL(e)).toThrow('drawn as stems');
      // pdfExpr of a discrete law IS its pmf; the curve builders refuse it.
      expect(pdfExpr(dist(rhs), num(1))).toEqual(pmfExpr(dist(rhs), num(1)));
      expect(() => densityExpr(dist(rhs))).toThrow('no density curve');
      expect(() => regionExpr(dist(rhs))).toThrow('no density curve');
    }
    expect(pmfExpr(dist('Normal(0, 1)'), num(0))).toBeNull();
  });
});

describe('cdf: closed forms, both tails', () => {
  it.each(LAWS)('%s: the cdf steps by exactly the pmf, and the tails add to 1', rhs => {
    const law = discreteLaw(dist(rhs), {})!;
    const hi = Math.min(law.hi, law.quantile(1e-13, true));
    let run = 0;
    for (let k = law.lo; k <= hi; k++) {
      run += law.pmf(k);
      const [p, q] = law.pq(k);
      expect(p, `${rhs} cdf(${k})`).toBeCloseTo(run, 12);
      expect(p + q).toBeCloseTo(1, 14);
      expect(law.pq(k + 0.5)).toEqual([p, q]); // a step function
    }
    expect(law.pq(law.lo - 1)).toEqual([0, 1]);
    expect(law.pq(-Infinity)).toEqual([0, 1]);
  });

  it('matches scipy, including tails a 1 − cdf would round away', () => {
    expect(P('Binomial(10, 0.3)', 'X <= 3')).toBeCloseTo(0.6496107184000002, 13);
    expect(P('Poisson(3)', 'X <= 2')).toBeCloseTo(0.42319008112684353, 13);
    expect(P('NegativeBinomial(2.5, 0.4)', 'X <= 3')).toBeCloseTo(0.5558019215511943, 12);
    expect(P('Geometric(0.2)', 'X <= 4')).toBeCloseTo(0.5904, 14);
    // Survival far out: scipy binom.sf(900, 1000, 0.3), poisson.sf(100, 3), geom.sf(2000, 0.2).
    expect(P('Binomial(1000, 0.3)', 'X > 400') / 7.0301475302670815e-12).toBeCloseTo(1, 9);
    expect(P('Poisson(3)', 'X > 100') / 8.413939063213629e-114).toBeCloseTo(1, 9);
    expect(P('Geometric(0.2)', 'X > 2000') / Math.exp(2000 * Math.log(0.8))).toBeCloseTo(1, 12);
    expect(P('Binomial(1000, 0.3)', 'X < 200') / 2.880763518256114e-13).toBeCloseTo(1, 9);
  });

  it('costs no sum: Binomial(1e6, p), Poisson(1e5) and beyond answer at once', () => {
    expect(P('Binomial(1000000, 0.3)', 'X <= 300000')).toBeCloseTo(0.5004933190684713, 9);
    expect(P('Poisson(100000)', 'X <= 100000')).toBeCloseTo(0.5008410430993401, 9);
    expect(P('Poisson(100000000)', '99990000 < X <= 100010000')).toBeCloseTo(0.6826894909272322, 7);
    expect(P('DiscreteUniform(-1000000000, 1000000000)', 'X <= 0')).toBeCloseTo(0.5, 9);
  });
});

describe('P(…): strict and non-strict bounds are different events', () => {
  it('keeps each comparison\'s strictness through both directions and chains', () => {
    expect(bounds('X < 3')).toMatchObject({ hiStrict: true });
    expect(bounds('X <= 3')).toMatchObject({ hiStrict: false });
    expect(bounds('3 > X')).toMatchObject({ hiStrict: true });
    expect(bounds('3 >= X')).toMatchObject({ hiStrict: false });
    expect(bounds('X > 3')).toMatchObject({ loStrict: true });
    expect(bounds('2 < X <= 5')).toMatchObject({ loStrict: true, hiStrict: false });
    expect(bounds('5 >= X > 2')).toMatchObject({ loStrict: true, hiStrict: false });
    expect(bounds('5 > X >= 2')).toMatchObject({ loStrict: false, hiStrict: true });
    expect(toProbability(parseExpr('2 <= X + 1 < 5', none), new Set(['X'])).inline).toMatchObject({ loStrict: false, hiStrict: true });
  });

  it('lands each bound on the right whole number', () => {
    const at = (body: string) => integerBounds(bounds(body), {});
    expect(at('X < 3')).toMatchObject({ kLo: -Infinity, kHi: 2 });
    expect(at('X <= 3')).toMatchObject({ kHi: 3 });
    expect(at('X < 2.5')).toMatchObject({ kHi: 2 });
    expect(at('X <= 2.5')).toMatchObject({ kHi: 2 });
    expect(at('X > 2.5')).toMatchObject({ kLo: 3, kHi: Infinity });
    expect(at('X >= 3')).toMatchObject({ kLo: 3 });
    expect(at('X > 3')).toMatchObject({ kLo: 4 });
    expect(at('2 < X <= 5')).toMatchObject({ kLo: 3, kHi: 5 });
    expect(at('X = 3')).toMatchObject({ kLo: 3, kHi: 3, not: false });
    expect(at('X != 3')).toMatchObject({ kLo: 3, kHi: 3, not: true });
    expect(at('X = 2.5')).toMatchObject({ kLo: 3, kHi: 2 }); // empty
  });

  it('values: Binomial(10, 0.3)', () => {
    const B = 'Binomial(10, 0.3)';
    const pmf = (k: number) => binomPmf(k, 10, 0.3);
    expect(P(B, 'X < 3')).toBeCloseTo(pmf(0) + pmf(1) + pmf(2), 14);
    expect(P(B, 'X <= 3')).toBeCloseTo(pmf(0) + pmf(1) + pmf(2) + pmf(3), 14);
    expect(P(B, 'X <= 3') - P(B, 'X < 3')).toBeCloseTo(pmf(3), 14);
    expect(P(B, 'X = 3')).toBe(pmf(3));
    expect(P(B, '3 = X')).toBe(pmf(3));
    expect(P(B, 'X == 3')).toBe(pmf(3));
    expect(P(B, 'X != 3')).toBeCloseTo(1 - pmf(3), 14);
    expect(P(B, '2 < X <= 5')).toBeCloseTo(pmf(3) + pmf(4) + pmf(5), 14);
    expect(P(B, '2 <= X < 5')).toBeCloseTo(pmf(2) + pmf(3) + pmf(4), 14);
    expect(P(B, 'X < 2.5')).toBeCloseTo(P(B, 'X <= 2'), 15);
    expect(P(B, 'X > 2.5')).toBeCloseTo(P(B, 'X >= 3'), 15);
    expect(P(B, 'X >= 3') + P(B, 'X < 3')).toBeCloseTo(1, 14);
    expect(P(B, 'X = 2.5')).toBe(0);
    expect(P(B, 'X != 2.5')).toBe(1);
    expect(P(B, '3 < X < 4')).toBe(0); // no whole number strictly between
    expect(P(B, '3 <= X <= 3')).toBe(pmf(3));
    expect(P(B, 'X < 0')).toBe(0);
    expect(P(B, 'X <= 0')).toBeCloseTo(pmf(0), 15);
    expect(P(B, 'X >= 0')).toBe(1);
    expect(P(B, 'X <= 10')).toBe(1);
    expect(P(B, 'X > 10')).toBe(0);
    expect(P(B, 'X = 11')).toBe(0);
  });

  it('values: the conventions show in the first atom', () => {
    expect(P('Geometric(0.2)', 'X = 0')).toBe(0);
    expect(P('Geometric(0.2)', 'X <= 1')).toBeCloseTo(0.2, 15);
    expect(P('NegativeBinomial(1, 0.2)', 'X = 0')).toBeCloseTo(0.2, 15); // Geometric − 1
    expect(P('DiscreteUniform(1, 6)', 'X >= 5')).toBeCloseTo(2 / 6, 15);
    expect(P('DiscreteUniform(1, 6)', '1 < X < 6')).toBeCloseTo(4 / 6, 15);
    expect(P('Bernoulli(0.3)', 'X > 0')).toBeCloseTo(0.3, 15);
  });

  it('follows parameters and bounds in the environment; NaN while they are invalid', () => {
    expect(P('Binomial(n, p)', 'X <= b', { n: 10, p: 0.3, b: 3 })).toBeCloseTo(0.6496107184, 10);
    expect(P('Binomial(n, p)', 'X <= b', { n: 10.5, p: 0.3, b: 3 })).toBeNaN();
    expect(P('Binomial(n, p)', 'X = b', { n: 10.5, p: 0.3, b: 3 })).toBeNaN();
    expect(P('Binomial(n, p)', 'X != b', { n: 10, p: 1.3, b: 3 })).toBeNaN();
    expect(P('Poisson(a)', 'X <= b', { a: 3, b: NaN })).toBeNaN();
  });

  it('refuses shapes it cannot mean', () => {
    const names = new Set(['X', 'Y']);
    expect(() => toProbability(parseExpr('X + 1 = 3', none), names)).toThrow('takes a discrete random variable on its own');
    expect(() => toProbability(parseExpr('X = Y', none), names)).toThrow('takes a discrete random variable on its own');
    expect(() => toProbability(parseExpr('a = 3', none), names)).toThrow('must reference a random variable');
  });
});

describe('quantile: a step function, exact at the steps', () => {
  it('the geometric inverse preserves CDF boundaries and their adjacent doubles', () => {
    const bits = new DataView(new ArrayBuffer(8));
    const adjacent = (x: number, direction: bigint): number => {
      bits.setFloat64(0, x);
      bits.setBigUint64(0, bits.getBigUint64(0) + direction);
      return bits.getFloat64(0);
    };
    for (const p of [0.000001, 0.2, 0.5, 0.999999]) {
      for (const rhs of [`Geometric(${p})`, `NegativeBinomial(1, ${p})`]) {
        const law = discreteLaw(dist(rhs), {})!;
        for (const k of [law.lo, law.lo + 1, law.lo + 7, Math.floor(1 / p), Math.floor(20 / p)]) {
          const [cdf, sf] = law.pq(k);
          const [prevCdf, prevSf] = law.pq(k - 1);
          if (cdf > prevCdf && cdf < 1) {
            expect(law.quantile(cdf), `${rhs} lower step ${k}`).toBe(k);
            expect(law.quantile(adjacent(cdf, 1n))).toBeGreaterThan(k);
          }
          if (sf > 0 && sf < prevSf) {
            expect(law.quantile(sf, true), `${rhs} upper step ${k}`).toBe(k);
            expect(law.quantile(adjacent(sf, -1n), true)).toBeGreaterThan(k);
          }
        }
        expect(law.quantile(1)).toBe(Infinity);
        expect(law.quantile(0, true)).toBe(Infinity);
        expect(law.quantile(-0.1)).toBeNaN();
        expect(law.quantile(1.1, true)).toBeNaN();
      }
    }
    const certain = discreteLaw(dist('Geometric(1)'), {})!;
    expect(certain.quantile(1)).toBe(1);
    expect(certain.quantile(0, true)).toBe(1);
  });

  it('wide geometric quantiles need only neighbouring CDF checks', () => {
    const law = discreteLaw(dist('Geometric(0.000001)'), {})!;
    // Count actual CDF work instead of depending on the CI runner's speed.
    const cdf = vi.spyOn(Math, 'expm1');
    try {
      for (const upper of [false, true]) {
        for (const u of [1e-12, 0.1, 0.5, 0.9]) {
          cdf.mockClear();
          const k = law.quantile(u, upper);
          expect(Number.isFinite(k)).toBe(true);
          expect(cdf.mock.calls.length).toBeLessThanOrEqual(4);
          expect(upper ? law.pq(k)[1] <= u : law.pq(k)[0] >= u).toBe(true);
          if (k > law.lo) expect(upper ? law.pq(k - 1)[1] > u : law.pq(k - 1)[0] < u).toBe(true);
        }
      }
    } finally {
      cdf.mockRestore();
    }
  });

  it.each(LAWS)('%s', rhs => {
    const law = discreteLaw(dist(rhs), {})!;
    const hi = Math.min(law.hi, law.quantile(1e-9, true));
    for (let k = law.lo; k <= hi; k++) {
      const [p, q] = law.pq(k);
      const below = law.pq(k - 1)[0];
      if (!(p > below)) continue; // no mass here (a degenerate member)
      expect(law.quantile(p), `${rhs} q(cdf(${k}))`).toBe(k);
      expect(law.quantile((p + below) / 2)).toBe(k);
      if (below > 0) expect(law.quantile(below)).toBeLessThan(k);
      if (q > 0 && q < law.pq(k - 1)[1]) { // (the upper tail's own steps; it rounds to 1 deep in the lower one)
        expect(law.quantile(q, true)).toBe(k);
        expect(law.quantile(Math.min(1, p * (1 + 1e-12) + 1e-300))).toBeGreaterThanOrEqual(k);
      }
    }
    expect(law.quantile(0)).toBe(law.lo);
    expect(law.quantile(1, true)).toBe(law.lo);
    expect(law.quantile(NaN)).toBeNaN();
  });

  it('reaches far tails and huge laws in a handful of cdf calls', () => {
    const pois = discreteLaw(dist('Poisson(1000000)'), {})!;
    expect(pois.quantile(0.5)).toBe(1000000); // scipy: poisson.ppf(0.5, 1e6)
    expect(pois.quantile(1e-12)).toBe(992974);
    expect(pois.quantile(1e-12, true)).toBe(1007043);
    expect(discreteLaw(dist('DiscreteUniform(-1000000000, 1000000000)'), {})!.quantile(0.5)).toBe(0);
    expect(discreteLaw(dist('Geometric(0.000001)'), {})!.quantile(1e-12, true)).toBe(27631008); // ⌈ln 1e-12 / ln(1 − 1e-6)⌉ (scipy's isf is 21 off here)
    expect(discreteLaw(dist('Poisson(3)'), {})!.quantile(0, true)).toBe(Infinity);
  });
});

describe('RVSystem over discrete variables', () => {
  it('declares, takes exact moments, and answers P(…) and E(…) exactly', () => {
    const { sys, built } = build(['X ~ Binomial(10, 0.3)', 'K ~ Poisson(a)', 'G ~ Geom(0.2)', 'W ~ NegBin(3, 0.4)',
      'B ~ Bernoulli(0.3)', 'D ~ DiscreteUniform(1, 6)']);
    expect([...built.errors]).toEqual([]);
    const env = { a: 3 };
    const mom = (n: string) => sys.exactMoments(n, env)!;
    expect(mom('X').mean).toBe(3);
    expect(mom('X').sd).toBeCloseTo(Math.sqrt(2.1), 14);
    expect(mom('K')).toEqual({ mean: 3, sd: Math.sqrt(3) });
    expect(mom('G').mean).toBeCloseTo(5, 14);
    expect(mom('G').sd).toBeCloseTo(Math.sqrt(20), 14);
    expect(mom('W').mean).toBeCloseTo(4.5, 14);
    expect(mom('W').sd).toBeCloseTo(Math.sqrt(11.25), 14);
    expect(mom('B').mean).toBe(0.3);
    expect(mom('B').sd).toBeCloseTo(Math.sqrt(0.21), 14);
    expect(mom('D').mean).toBe(3.5);
    expect(mom('D').sd).toBeCloseTo(Math.sqrt(35 / 12), 14);
    expect(sys.mean('X', env)).toBe(3);
    expect(sys.moments('X', env)).toMatchObject({ kind: 'exact', mean: 3 });
    // The closed-form moments are the pmf's own.
    for (const n of ['X', 'K', 'G', 'W', 'B', 'D']) {
      const law = discreteLaw(sys.discreteDist(n)!, env)!;
      let m1 = 0;
      let m2 = 0;
      for (let k = law.lo; k <= Math.min(law.hi, 400); k++) {
        m1 += k * law.pmf(k);
        m2 += k * k * law.pmf(k);
      }
      expect(m1).toBeCloseTo(law.mean, 10);
      expect(Math.sqrt(m2 - m1 * m1)).toBeCloseTo(law.sd, 9);
    }
    const s = bounds('X <= 3');
    expect(sys.exactProbability('X', s.lo, s.hi, env, s)).toBeCloseTo(0.6496107184, 10);
    const strict = bounds('X < 3');
    expect(sys.exactProbability('X', strict.lo, strict.hi, env, strict)).toBeCloseTo(0.3827827864, 10);
  });

  it('is never handed to the density pipeline', () => {
    const { sys } = build(['X ~ Poisson(3)', 'Z ~ Normal(0, 1)']);
    expect(sys.exactDist('X')).toBeNull(); // the shader gate
    expect(sys.discreteDist('X')).toMatchObject({ kind: 'poisson' });
    expect(sys.discreteDist('Z')).toBeNull();
    expect(sys.curve('X', {})).toBeNull();
    expect(sys.quadMoments('X', {})).toBeNull();
    expect(sys.meanUnstable('X', {})).toBe(false);
    expect(() => sys.columns('X', {})).toThrow('X is discrete: sampling discrete random variables is not supported yet.');
    expect(() => sys.probability(parseExpr('X > Z', none), {})).toThrow('X is discrete');
    expect(sys.stems('Z', {})).toBeNull();
  });

  it('refuses derived arithmetic with a specific "not yet", never a KDE', () => {
    const { sys, built } = build(['X ~ Poisson(3)', 'N ~ Binomial(5, 0.5)', 'Z ~ Normal(0, 1)', 'S = X + N', 'Y = X^2',
      'M = N + Z', 'V = Y + 1', 'W = Z + 1']);
    expect(built.errors.get(3)).toMatch(/^X, N are discrete: arithmetic and joint events over discrete random variables are not supported yet\./);
    expect(built.errors.get(4)).toMatch(/^X is discrete: .* P\(…\) with constant bounds and E\(…\) take X on its own\.$/);
    expect(built.errors.get(5)).toMatch(/^N is discrete/);
    expect(built.errors.get(6)).toBe('Y has an error in its definition.');
    expect(built.errors.has(7)).toBe(false);
    expect(sys.has('S') || sys.has('Y') || sys.has('M') || sys.has('V')).toBe(false);
    // The anonymous variables of `E(2 X)`, `P(X + 1 < 3)` and a bare `X + Z` take the same door.
    expect(() => sys.add({ name: '@E1', kind: 'derived', expr: parseExpr('2 X', none) })).toThrow('X is discrete');
  });

  it('checkProbability: point events need a discrete variable; joint events a continuous one', () => {
    const { sys } = build(['X ~ Poisson(3)', 'Z ~ Normal(0, 1)', 'W ~ Normal(0, 1)']);
    const names = new Set(['X', 'Z', 'W']);
    const check = (body: string) => sys.checkProbability(toProbability(parseExpr(body, none), names));
    expect(() => check('X = 3')).not.toThrow();
    expect(() => check('X != 3')).not.toThrow();
    expect(() => check('2 < X <= 5')).not.toThrow();
    expect(() => check('Z > W')).not.toThrow();
    expect(() => check('Z = 3')).toThrow('P(Z = …) needs a discrete variable: a continuous one takes any single value with probability 0.');
    expect(() => check('Z != 3')).toThrow('P(Z != …) needs a discrete variable');
    expect(() => check('X > Z')).toThrow('X is discrete');
    expect(() => check('X + Z < 2')).toThrow('X is discrete');
    expect(() => check('0 < X < Z')).toThrow('X is discrete');
  });

  it('judges a slider at its value, skips a moving one, and draws nothing while invalid', () => {
    const { sys } = build(['X ~ Binomial(n, p)']);
    const still = new Set<string>();
    expect(sys.paramProblem('X', { n: 10, p: 0.3 }, still)).toBeNull();
    expect(sys.paramProblem('X', { n: 2.5, p: 0.3 }, still)).toBe('Binomial(n, p) needs a whole number n ≥ 0 (n = 2.5).');
    expect(sys.paramProblem('X', { n: 10, p: 1.5 }, still)).toBe('Binomial(n, p) needs 0 ≤ p ≤ 1.');
    expect(sys.paramProblem('X', { n: 2.5, p: 0.3 }, new Set(['n']))).toBeNull(); // animated: fine the next instant
    // …and at the instant n = 2.5 there is no Binomial(2.5, p): nothing is drawn, nothing is claimed.
    expect(sys.stems('X', { n: 2.5, p: 0.3 })).toBeNull();
    expect(sys.exactMoments('X', { n: 2.5, p: 0.3 })).toBeNull();
    expect(sys.mean('X', { n: 2.5, p: 0.3 })).toBeNaN();
    expect(sys.stems('X', { n: 3, p: 0.3 })!.stems.ks).toEqual([0, 1, 2, 3]);
    expect(() => sys.stems('X', { p: 0.3 })).toThrow('Unbound variable: n');
  });
});

describe('stems', () => {
  it('one per whole number of the support in view, heights exact', () => {
    const { sys } = build(['X ~ Binomial(10, 0.3)']);
    const all = sys.stems('X', {})!.stems;
    expect(all.ks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(all.ps).toEqual(all.ks.map(k => binomPmf(k, 10, 0.3)));
    expect(all.envelope).toBe(false);
    expect(sys.stems('X', {}, { lo: 2.2, hi: 6.9 })!.stems.ks).toEqual([3, 4, 5, 6]);
    expect(sys.stems('X', {}, { lo: 3, hi: 6 })!.stems.ks).toEqual([3, 4, 5, 6]);
    expect(sys.stems('X', {}, { lo: -50, hi: -1 })!.stems.ks).toEqual([]);
    expect(sys.stems('X', {}, { lo: 3.2, hi: 3.8 })!.stems.ks).toEqual([]);
    expect(sys.stems('X', {}, { lo: -1e12, hi: 1e12 })!.stems.ks).toHaveLength(11);
  });

  it('an unbounded support stops where the mass does', () => {
    const { sys } = build(['X ~ Geometric(0.2)', 'K ~ Poisson(3)']);
    const g = sys.stems('X', {}, { lo: -1e6, hi: 1e6 })!.stems;
    expect(g.ks[0]).toBe(1);
    expect(g.ks[g.ks.length - 1]).toBe(124); // (0.8)^124 ≈ 1e-12
    expect(sys.stems('K', {}, { lo: -5, hi: 1e9 })!.stems.ks.length).toBeLessThan(40);
  });

  it('caps what it draws: past STEM_MAX whole numbers in view the envelope takes over, heights still exact', () => {
    const { sys } = build(['X ~ Poisson(1000000)', 'D ~ DiscreteUniform(-1000000000, 1000000000)']);
    const before = { ...STEM_STATS };
    const far = sys.stems('X', {}, { lo: -1e7, hi: 1e7 })!.stems;
    expect(far.envelope).toBe(true);
    expect(far.ks.length).toBeLessThanOrEqual(STEM_MAX);
    expect(far.ks.length).toBeGreaterThan(STEM_MAX / 2);
    expect(far.ks.every(Number.isInteger)).toBe(true);
    // The samples cover the mass (±7σ about 1e6), not the 2e7-wide view: the peak is resolved.
    expect(far.ks[0]).toBe(992974);
    expect(far.ks[far.ks.length - 1]).toBe(1007043);
    expect(Math.max(...far.ps)).toBeGreaterThan(0.999 * poissonPmf(1000000, 1000000));
    far.ks.forEach((k, i) => expect(far.ps[i]).toBe(poissonPmf(k, 1000000)));
    const d = sys.stems('D', {}, { lo: -2e9, hi: 2e9 })!.stems;
    expect(d.envelope).toBe(true);
    expect(d.ks.length).toBeLessThanOrEqual(STEM_MAX);
    expect(new Set(d.ps)).toEqual(new Set([1 / 2000000001]));
    expect(STEM_STATS.pmfEvals - before.pmfEvals).toBeLessThanOrEqual(2 * STEM_MAX);
    // Zoomed in, the same law is stems again.
    const near = sys.stems('X', {}, { lo: 999990.5, hi: 1000010.5 })!.stems;
    expect(near.envelope).toBe(false);
    expect(near.ks).toHaveLength(20);
  });

  it('perf guard: a still frame is a cache hit, a pan rebuilds once, no frame evaluates more than STEM_MAX pmfs', () => {
    const { sys } = build(['X ~ Binomial(n, 0.3)']);
    const env = { n: 5000 };
    const view = { lo: 1399.5, hi: 1600.5 };
    sys.stems('X', env, view);
    const base = { ...STEM_STATS };
    for (let frame = 0; frame < 100; frame++) sys.stems('X', env, view);
    expect(STEM_STATS).toEqual(base); // nothing moved: nothing recomputed
    sys.stems('X', env, { lo: 1399.8, hi: 1600.9 }); // a sub-unit pan: same whole numbers
    expect(STEM_STATS).toEqual(base);
    sys.stems('X', env, { lo: 1410, hi: 1610 });
    expect(STEM_STATS.builds - base.builds).toBe(1);
    expect(STEM_STATS.pmfEvals - base.pmfEvals).toBe(201);
    const mid = { ...STEM_STATS };
    sys.stems('X', { n: 5001 }, { lo: 1410, hi: 1610 }); // the slider moved: one rebuild
    expect(STEM_STATS.builds - mid.builds).toBe(1);
    for (let frame = 0; frame < 50; frame++) sys.stems('X', { n: 5001 }, { lo: frame * 100, hi: 5000 });
    expect(STEM_STATS.pmfEvals - mid.pmfEvals).toBeLessThanOrEqual(51 * STEM_MAX);
  });

  it('selectStems: what a P(…) row highlights is what it counts', () => {
    const { sys } = build(['X ~ Binomial(10, 0.3)']);
    const { stems, law } = sys.stems('X', {})!;
    const sel = (body: string) => selectStems(stems, law, integerBounds(bounds(body), {})).map(r => r.ks);
    expect(sel('X < 3')).toEqual([[0, 1, 2]]);
    expect(sel('X <= 3')).toEqual([[0, 1, 2, 3]]);
    expect(sel('X < 2.5')).toEqual([[0, 1, 2]]);
    expect(sel('2 < X <= 5')).toEqual([[3, 4, 5]]);
    expect(sel('X = 3')).toEqual([[3]]);
    expect(sel('X != 3')).toEqual([[0, 1, 2], [4, 5, 6, 7, 8, 9, 10]]);
    expect(sel('X != 2.5')).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
    expect(sel('X != 0')).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
    expect(sel('X > 10')).toEqual([]);
    expect(sel('3 < X < 4')).toEqual([]);
    expect(selectStems(stems, law, { kLo: NaN, kHi: 3, not: false })).toEqual([]);
    // The highlighted mass IS the readout.
    for (const body of ['X < 3', 'X <= 3', '2 < X <= 5', 'X != 3', 'X = 3', 'X >= 4']) {
      const b = bounds(body);
      const mass = selectStems(stems, law, integerBounds(b, {})).flatMap(r => r.ps).reduce((s, p) => s + p, 0);
      expect(mass).toBeCloseTo(probabilityValue(sys.discreteDist('X')!, b.lo, b.hi, {}, b), 13);
    }
  });

  it('selectStems on an envelope ends exactly at the bounds', () => {
    const { sys } = build(['X ~ Poisson(1000000)']);
    const { stems, law } = sys.stems('X', {}, { lo: 0, hi: 2e6 })!;
    const [run] = selectStems(stems, law, integerBounds(bounds('999000.5 < X <= 1001003'), {}));
    expect(run.envelope).toBe(true);
    expect(run.ks[0]).toBe(999001);
    expect(run.ks[run.ks.length - 1]).toBe(1001003);
    expect(run.ps[0]).toBe(poissonPmf(999001, 1000000));
    expect(run.ks.every((k, i) => i === 0 || k > run.ks[i - 1])).toBe(true);
  });
});

describe('edges of double range', () => {
  it('an invalid law has no probabilities, even for the sure event', () => {
    expect(P('Binomial(n, p)', 'X >= 0', { n: 2.5, p: 0.3 })).toBeNaN();
    expect(P('Binomial(n, p)', 'X >= 0', { n: 3, p: 0.3 })).toBe(1);
  });

  it('terminates on supports wider than 2^53', () => {
    const law = discreteLaw(dist('DiscreteUniform(-10^300, 10^300)'), {})!;
    expect(Math.abs(law.quantile(0.5))).toBeLessThan(1e285);
    expect(law.quantile(0.75) / 0.5e300).toBeCloseTo(1, 9);
    const { sys } = build(['X ~ DiscreteUniform(-10^300, 10^300)', 'K ~ Poisson(10^300)']);
    expect(sys.stems('X', {}, { lo: -10.5, hi: 10.5 })!.stems.ks).toHaveLength(21);
    expect(sys.stems('X', {}, { lo: -1e301, hi: 1e301 })!.stems.envelope).toBe(true);
    const k = sys.stems('K', {}, { lo: 0, hi: 2e300 });
    expect(k === null || k.stems.ks.length <= STEM_MAX).toBe(true);
  });
});
