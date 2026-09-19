/** Regressions from the review of the discrete distributions (plan #5). */
import { describe, expect, it } from 'vitest';
import {
  type BaseDist,
  RVSystem,
  STEM_MAX,
  STEM_STATS,
  buildRVSystem,
  discreteLaw,
  integerBounds,
  markerHeight,
  parseDistribution,
  probabilityValue,
  scanRandomRows,
  selectStems,
  stemGeometry,
  toProbability,
} from './dist.ts';
import { parseExpr } from './expr.ts';
import { binomPmf, poissonPmf } from './specfn.ts';

const none = new Set<string>();
const dist = (rhs: string): BaseDist => parseDistribution(rhs, none);
const bounds = (body: string) => toProbability(parseExpr(body, none), new Set(['X'])).single!;
const P = (rhs: string, body: string, env: Record<string, number> = {}): number => {
  const s = bounds(body);
  return probabilityValue(dist(rhs), s.lo, s.hi, env, s);
};
const build = (rows: string[]) => {
  const sys = new RVSystem();
  buildRVSystem(sys, scanRandomRows(rows), { fnNames: none, getFn: () => undefined, constNames: new Set(['a', 'p']), taken: () => false });
  return sys;
};

describe('1. bounds within rounding of a whole number are that whole number', () => {
  const B = 'Binomial(10, 0.3)';
  const up = 0.1 * 3 * 10; // 3.0000000000000004
  const down = 3 - 4e-16;
  it.each([['3 + ε', up], ['3 − ε', down]])('%s', (_, a) => {
    expect(a).not.toBe(3);
    expect(P(B, 'X < a', { a })).toBeCloseTo(0.3827827864, 10);
    expect(P(B, 'X <= a', { a })).toBeCloseTo(0.6496107184, 10);
    expect(P(B, 'X > a', { a })).toBeCloseTo(1 - 0.6496107184, 10);
    expect(P(B, 'X >= a', { a })).toBeCloseTo(1 - 0.3827827864, 10);
    expect(P(B, 'X = a', { a })).toBe(binomPmf(3, 10, 0.3));
    expect(P(B, 'X != a', { a })).toBeCloseTo(1 - binomPmf(3, 10, 0.3), 12);
    expect(integerBounds(bounds('X < a'), { a })).toMatchObject({ kHi: 2 });
    expect(integerBounds(bounds('X = a'), { a })).toMatchObject({ kLo: 3, kHi: 3 });
    const sys = build([`X ~ ${B}`]);
    const { stems, law } = sys.stems('X', {})!;
    expect(selectStems(stems, law, integerBounds(bounds('X < a'), { a })).map(r => r.ks)).toEqual([[0, 1, 2]]);
  });
  it('leaves genuinely fractional bounds alone', () => {
    expect(integerBounds(bounds('X < a'), { a: 2.5 })).toMatchObject({ kHi: 2 });
    expect(integerBounds(bounds('X <= a'), { a: 2.5 })).toMatchObject({ kHi: 2 });
    expect(integerBounds(bounds('X > a'), { a: 2.5 })).toMatchObject({ kLo: 3 });
    expect(integerBounds(bounds('X < a'), { a: 3.001 })).toMatchObject({ kHi: 3 });
    expect(integerBounds(bounds('X < a'), { a: 2.999 })).toMatchObject({ kHi: 2 });
    expect(integerBounds(bounds('X = a'), { a: 2.5 })).toMatchObject({ kLo: 3, kHi: 2 });
    expect(integerBounds(bounds('X < a'), { a: Infinity })).toMatchObject({ kHi: Infinity });
    expect(integerBounds(bounds('X < a'), { a: NaN }).kHi).toBeNaN();
  });
});

describe('2. the E(X) marker reaches the stem when the mean is a whole number up to rounding', () => {
  it('Binomial(100, 0.07): mean 7.000000000000001', () => {
    const sys = build(['X ~ Binomial(100, 0.07)', 'Y ~ Binomial(10, p)']);
    expect(sys.mean('X', {})).not.toBe(7);
    expect(markerHeight(sys, 'X', {})).toEqual({ x: 7, h: binomPmf(7, 100, 0.07) });
    expect(markerHeight(sys, 'Y', { p: 0.3 })).toEqual({ x: 3, h: binomPmf(3, 10, 0.3) });
    expect(markerHeight(sys, 'Y', { p: 0.31 })).toEqual({ x: 3.1, h: 0 }); // between stems: on the axis
    expect(markerHeight(sys, 'Y', { p: 1.5 })).toBeNull();
  });
  it('continuous variables keep pdf(mean)', () => {
    const sys = build(['Z ~ Normal(1, 2)']);
    const m = markerHeight(sys, 'Z', {})!;
    expect(m.x).toBe(1);
    expect(m.h).toBeCloseTo(1 / (2 * Math.sqrt(2 * Math.PI)), 12);
  });
});

describe('3. the envelope is a view-independent lattice that includes the mode', () => {
  it('Poisson(1e6): the peak is sampled exactly, from any window', () => {
    const sys = build(['X ~ Poisson(1000000)']);
    for (const view of [{ lo: -1e7, hi: 1e7 }, { lo: 990000.3, hi: 1010000.7 }, { lo: 999000, hi: 1003000 }]) {
      const { stems } = sys.stems('X', {}, view)!;
      expect(stems.envelope).toBe(true);
      expect(stems.ks.length).toBeLessThanOrEqual(STEM_MAX + 3);
      expect(Math.max(...stems.ps)).toBe(poissonPmf(1000000, 1000000));
      expect(stems.ks.every((k, i) => Number.isInteger(k) && (i === 0 || k > stems.ks[i - 1]))).toBe(true);
    }
  });
  it('includes the support ends when they are in view', () => {
    const sys = build(['X ~ DiscreteUniform(-5000, 7001)']);
    const { stems } = sys.stems('X', {}, { lo: -1e5, hi: 1e5 })!;
    expect(stems.envelope).toBe(true);
    expect(stems.ks[0]).toBe(-5000);
    expect(stems.ks[stems.ks.length - 1]).toBe(7001);
  });
  it('a pan moves no sample: the same whole numbers, rebuilt only per stride crossed', () => {
    const sys = build(['X ~ Poisson(1000000)']);
    const width = 20000;
    const first = sys.stems('X', {}, { lo: 990000, hi: 990000 + width })!.stems;
    const stride = first.ks[2] - first.ks[1];
    expect(stride).toBeGreaterThan(1);
    const before = { ...STEM_STATS };
    const seen = new Set(first.ks);
    const frames = 200;
    for (let f = 1; f <= frames; f++) {
      const lo = 990000 + f * 1.7; // 1.7 units a frame: 340 units in all
      const { stems } = sys.stems('X', {}, { lo, hi: lo + width })!;
      // Interior samples sit on multiples of the stride whatever the window.
      for (const k of stems.ks.slice(1, -1)) if (k !== 1000000) expect(k % stride).toBe(0);
      stems.ks.forEach(k => seen.add(k));
    }
    // One rebuild per stride the window's edges cross, not one per frame.
    expect(STEM_STATS.builds - before.builds).toBeLessThanOrEqual(2 * Math.ceil((frames * 1.7) / stride) + 2);
    expect(STEM_STATS.builds - before.builds).toBeLessThan(frames / 2);
    // …and a second consumer (a P(…) row) of the same frame rebuilds nothing.
    const mid = { ...STEM_STATS };
    const lo = 990000 + frames * 1.7;
    sys.stems('X', {}, { lo, hi: lo + width });
    sys.stems('X', {}, { lo, hi: lo + width });
    expect(STEM_STATS).toEqual(mid);
  });
});

describe('5. a short run of whole numbers is summed, not differenced', () => {
  it('a narrow interval of a very wide uniform', () => {
    expect(P('DiscreteUniform(-10^17, 10^17)', '0 <= X <= 2') / 1.5e-17).toBeCloseTo(1, 12);
    expect(P('DiscreteUniform(-10^17, 10^17)', '0 < X < 2') / 0.5e-17).toBeCloseTo(1, 12);
  });
  it('a narrow interval near the median of a wide Binomial / Poisson keeps its digits', () => {
    let sum = 0;
    for (let k = 300000; k <= 300002; k++) sum += binomPmf(k, 1000000, 0.3);
    expect(P('Binomial(1000000, 0.3)', '300000 <= X <= 300002') / sum).toBeCloseTo(1, 13);
    let ps = 0;
    for (let k = 99999999; k <= 100000001; k++) ps += poissonPmf(k, 1e8);
    expect(P('Poisson(100000000)', '99999999 <= X <= 100000001') / ps).toBeCloseTo(1, 13);
  });
  it('long runs still difference the tails (no thousand-term sums), and agree at the seam', () => {
    const law = discreteLaw(dist('Binomial(1000, 0.3)'), {})!;
    for (const [lo, hi] of [[290, 353], [290, 354], [290, 355], [100, 900]]) {
      let sum = 0;
      for (let k = lo; k <= hi; k++) sum += law.pmf(k);
      expect(P('Binomial(1000, 0.3)', `${lo} <= X <= ${hi}`)).toBeCloseTo(sum, 12);
    }
    expect(P('Poisson(100000000)', '99990000 < X <= 100010000')).toBeCloseTo(0.6826894909272322, 7);
  });
});

describe('6. Bernoulli and Geometric are canonicalised once', () => {
  it('to the same law as their Binomial / shifted NegativeBinomial spelling', () => {
    const bern = discreteLaw(dist('Bernoulli(0.3)'), {})!;
    const bin = discreteLaw(dist('Binomial(1, 0.3)'), {})!;
    const geom = discreteLaw(dist('Geometric(0.2)'), {})!;
    const nb = discreteLaw(dist('NegativeBinomial(1, 0.2)'), {})!;
    for (const k of [-1, 0, 1, 2, 2.5, 7]) {
      expect(bern.pmf(k)).toBe(bin.pmf(k));
      expect(bern.pq(k)).toEqual(bin.pq(k));
      expect(geom.pmf(k + 1)).toBe(nb.pmf(k));
      expect(geom.pq(k + 1)).toEqual(nb.pq(k));
    }
    expect([geom.lo, geom.mean]).toEqual([nb.lo + 1, nb.mean + 1]);
    expect(geom.sd).toBe(nb.sd);
    expect(geom.quantile(0.9)).toBe(nb.quantile(0.9) + 1);
  });
  it('messages still name the family the user wrote', () => {
    expect(() => dist('Bernoulli(2)')).toThrow('Bernoulli(p) needs 0 ≤ p ≤ 1.');
    expect(() => dist('Geometric(0)')).toThrow('Geometric(p) needs 0 < p ≤ 1.');
  });
});

describe('7. one stem geometry for the app and the og rasterizer', () => {
  it('describes stems, selected bands and envelopes', () => {
    const run = { ks: [1, 2], ps: [0.25, 0.5], envelope: false };
    expect(stemGeometry(run, false, 40)).toEqual({
      lines: [1, 0, 1, 0.25, NaN, NaN, 2, 0, 2, 0.5, NaN, NaN], width: 2, alpha: 1, dots: { r: 3.5, outlined: true }, fill: null,
    });
    const heavy = stemGeometry(run, true, 40);
    expect(heavy).toMatchObject({ width: 9, alpha: 0.45, dots: { r: 6.5, outlined: false }, fill: null });
    expect(stemGeometry(run, true, 5).width).toBe(3);
    expect(stemGeometry(run, false, 2)).toMatchObject({ width: 1, dots: null });
    const env = stemGeometry({ ...run, envelope: true }, false, 0.01);
    expect(env).toMatchObject({ lines: [1, 0, 1, 0.25, 2, 0.5, 2, 0], fill: 0.16, dots: null, alpha: 1 });
    expect(stemGeometry({ ...run, envelope: true }, true, 0.01).fill).toBe(0.35);
  });
});

describe('8. discreteness has one source of truth: the family', () => {
  it('a hand-built BaseDist is discrete because its kind is', () => {
    const d: BaseDist = { kind: 'poisson', args: [{ kind: 'num', value: 3 }] };
    expect(discreteLaw(d, {})!.mean).toBe(3);
    expect(probabilityValue(d, undefined, { kind: 'num', value: 2 }, {}, { hiStrict: false })).toBeCloseTo(0.42319008112684353, 12);
    const sys = new RVSystem();
    sys.add({ name: 'X', kind: 'base', dist: d });
    expect(sys.discreteDist('X')).toBe(d);
    expect(sys.exactDist('X')).toBeNull();
    // …and so is what is built on it (plan #6): X + 1 is a pmf, shifted.
    sys.add({ name: 'Y', kind: 'derived', expr: parseExpr('X + 1', none) });
    expect(sys.isDiscreteVar('Y')).toBe(true);
    expect(sys.pmfOf('Y', {})!.xs[0]).toBe(1);
  });
});
