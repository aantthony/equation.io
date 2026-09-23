/** Review findings on plan #6 (derived discrete variables), one describe each. */
import { describe, expect, it } from 'vitest';
import {
  ENUM_STATS,
  type ProbBounds,
  RVSystem,
  buildRVSystem,
  momentsReadout,
  scanRandomRows,
  stemGeometry,
  toProbability,
} from './dist.ts';
import { parseExpr } from './expr.ts';

const none = new Set<string>();
function build(rows: string[]) {
  const sys = new RVSystem();
  const built = buildRVSystem(sys, scanRandomRows(rows), { fnNames: none, getFn: () => undefined, constNames: none, taken: () => false });
  expect([...built.errors]).toEqual([]);
  return sys;
}
let anon = 0;
function P(sys: RVSystem, names: string[], body: string) {
  const spec = toProbability(parseExpr(body, none), new Set(names));
  sys.checkProbability(spec);
  let single: ({ rv: string } & ProbBounds) | undefined = spec.single;
  if (!single && spec.inline) {
    const { e, ...bounds } = spec.inline;
    const name = `@R${anon++}`;
    sys.addAnonymous({ name, kind: 'derived', expr: e });
    single = { rv: name, ...bounds };
  }
  return sys.eventProbability(spec.body, single, {});
}

describe('1. rounding happens once, at the root — never at every node', () => {
  const dice = ['X ~ DiscreteUniform(1, 6)', 'Y ~ DiscreteUniform(1, 6)', 'Z ~ DiscreteUniform(1, 6)'];
  const names = ['X', 'Y', 'Z', 'A'];
  it('X/3*3, thirds that add to 1, sqrt(X)^2: the atoms are the whole numbers they are', () => {
    const sys = build([...dice, 'A = X / 3 * 3', 'B = sqrt(X)^2', 'C = X / 3 + Y / 3 + Z / 3']);
    expect([...sys.pmfOf('A', {})!.xs]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...sys.pmfOf('B', {})!.xs]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sys.pmfOf('C', {})!.xs.length).toBe(16);
    expect(P(sys, names, 'X / 3 * 3 = 1')).toEqual({ value: expect.closeTo(1 / 6, 14), exact: true });
    expect(P(sys, names, 'X / 3 + Y / 3 + Z / 3 = 1').value).toBeCloseTo(1 / 216, 14);
    expect(P(sys, names, 'X / 3 * 3 = Y').value).toBeCloseTo(1 / 6, 14);
    expect(P(sys, names, 'sqrt(X)^2 = Y').value).toBeCloseTo(1 / 6, 14);
    expect(P(sys, names, 'X / 3 * 3 >= Y').value).toBeCloseTo(21 / 36, 14);
    expect(P(sys, names, 'X / 3 * 3 > Y').value).toBeCloseTo(15 / 36, 14);
  });

  it('values that straddle a rounding boundary are still one atom; whole numbers never merge', () => {
    const sys = build([...dice, 'U ~ DiscreteUniform(100000000000, 100000000003)', 'V = U + 0.5 - 0.5', 'W = X / 7 * 7 / 3']);
    expect(sys.pmfOf('V', {})!.xs.length).toBe(4);
    expect(sys.pmfOf('W', {})!.xs.length).toBe(6);
  });
});

describe('2–3. the sampled tier certifies its moments, or says it cannot', () => {
  it('a divergent mean is not a number, one base or several', () => {
    const sys = build(['G ~ Geometric(0.000001)', 'H ~ Geometric(0.000001)', 'K = 1.00001^G', 'L = exp(G / 100000)', 'M = 1.00001^G + H', 'Q = G^2', 'R = G H']);
    for (const n of ['K', 'L', 'M']) {
      expect(sys.pmfOf(n, {})!.exact, n).toBe(false);
      expect(sys.meanUnstable(n, {}), n).toBe(true);
      expect(sys.mean(n, {}), n).toBeNaN();
      expect(momentsReadout(sys.moments(n, {})!), n).toMatch(/^median ≈ .* \(heavy tails: μ, σ unstable\) \(sampled.*\)$/);
    }
    // …and light tails stay certified: no false alarm on a polynomial.
    for (const n of ['Q', 'R']) {
      expect(sys.meanUnstable(n, {}), n).toBe(false);
      expect(sys.moments(n, {}), n).toMatchObject({ kind: 'estimate', sd: expect.any(Number) });
      expect(isFinite((sys.moments(n, {}) as { sd: number }).sd), n).toBe(true);
    }
    expect(Math.abs(sys.mean('Q', {}) / 2e12 - 1)).toBeLessThan(0.02);
  });

  it('small supports are judged by their own slivers, exactly: no false alarm, no miss', () => {
    const sys = build(['A ~ Poisson(60)', 'B ~ Poisson(60)', 'C ~ Poisson(60)', 'W = A B C', 'V = 1.5^A B C']);
    expect(sys.pmfOf('W', {})!.exact).toBe(false);
    expect(sys.meanUnstable('W', {})).toBe(false);
    expect(isFinite((sys.moments('W', {}) as { sd: number }).sd)).toBe(true);
    expect(sys.moments('V', {})!.kind).not.toBe('robust'); // E 1.5^A = e^30: finite, Poisson tails beat any exponential
  });

  it('the second moment is tested too: σ is never a confident truncation', () => {
    const sys = build(['G ~ Geometric(0.000001)', 'K = 1.0000005^G', 'J = 1.000002^G']);
    // E K² = Σ 1.000001^k p q^(k−1) just converges (σ ≈ 1150): no sample shows it, and the test cannot certify it.
    const k = sys.moments('K', {})!;
    expect(k).toMatchObject({ kind: 'estimate' });
    expect((k as { sd: number }).sd).toBeNaN();
    expect(momentsReadout(k)).toMatch(/^μ ≈ 2\.0\d\d, σ unstable \(sampled.*\)$/);
    // E J² diverges outright (1.000004 q > 1) while E J = 1/(1 − 2) …no: E J diverges too (1.000002 q > 1).
    expect(sys.meanUnstable('J', {})).toBe(true);
    const s = build(['G ~ Geometric(0.000001)', 'I = 1.0000008^G']);
    expect(s.meanUnstable('I', {})).toBe(false); // E I = 5
    expect((s.moments('I', {}) as { sd: number }).sd).toBe(Infinity); // 1.0000016 q > 1
  });

  it('a huge estimate prints through the number formatter, not as a raw exponent string', () => {
    expect(momentsReadout({ kind: 'estimate', mean: 1.1712345678e49, sd: 3.2e50, mass: 1 })).toBe('μ ≈ 1.17123e+49, σ ≈ 3.2e+50');
    expect(momentsReadout({ kind: 'estimate', mean: 1234.5678, sd: 0.25, mass: 1 })).toBe('μ ≈ 1234.568, σ ≈ 0.250');
  });
});

describe('4. shared bases are conditioned on, not multiplied out', () => {
  const dice = Array.from({ length: 10 }, (_, k) => `D${k} ~ DiscreteUniform(1, 6)`);
  const sum = dice.map((_, k) => `D${k}`).join(' + ');
  it('T + D0 over ten dice is exact, and so are events between T and a die it contains', () => {
    const sys = build([...dice, `T = ${sum}`, 'U = T + D0', 'E ~ DiscreteUniform(1, 6)', 'F ~ DiscreteUniform(1, 6)', 'V = E F + E']);
    const before = ENUM_STATS.points;
    const u = sys.pmfOf('U', {})!;
    expect(u.exact).toBe(true);
    expect(u.xs[0]).toBe(11);
    expect(u.ps[0]).toBeCloseTo(6 ** -10, 22); // all ones
    expect(sys.mean('U', {})).toBeCloseTo(38.5, 10);
    const names = [...dice.map((_, k) => `D${k}`), 'T', 'U'];
    const gt = P(sys, names, 'T > D0');
    expect(gt).toEqual({ value: 1, exact: true });
    const tail = P(sys, names, 'T + D0 > 40');
    expect(tail.exact).toBe(true);
    let want = 0;
    for (let i = 0; i < u.xs.length; i++) if (u.xs[i] > 40) want += u.ps[i];
    expect(tail.value).toBeCloseTo(want, 12);
    expect(ENUM_STATS.points - before).toBeLessThan(60000);
    expect(sys.mean('V', {})).toBeCloseTo(3.5 * 3.5 + 3.5, 12);
  });

  it('independent groups of terms are enumerated group by group', () => {
    const sys = build(['A ~ Poisson(30)', 'B ~ Poisson(30)', 'C ~ Poisson(30)', 'D ~ Poisson(30)']);
    // (A, B) and (C, D) each share within, nothing across: 78² + 78² + the two atom sets' product, not 78⁴.
    const r = P(sys, ['A', 'B', 'C', 'D'], 'max(A, B) + min(A, B) > max(C, D) + min(C, D)');
    expect(r.exact).toBe(true);
    expect(r.value).toBeGreaterThan(0.45);
    expect(r.value).toBeLessThan(0.5);
  });
});

describe('5. dots and widths follow the stems in the window, not the closest pair anywhere', () => {
  it('R = 1/N: the atoms 1, 1/2, 1/3 on screen stand apart, whatever 1/20 and 1/21 do', () => {
    const sys = build(['N ~ Poisson(3)', 'R = 1 / N']);
    const [run] = sys.pmfRuns('R', {}, { lo: 0.3, hi: 1.1 })!;
    expect(run.ks).toEqual([0.333333333333, 0.5, 1]);
    expect(run.step).toBeCloseTo(1 / 6, 10);
    expect(stemGeometry(run, false, 600).dots).toMatchObject({ r: 3.5 });
    const [all] = sys.pmfRuns('R', {}, { lo: 0, hi: 1.1 })!;
    expect(all.step!).toBeLessThan(0.01);
    const [one] = sys.pmfRuns('R', {}, { lo: 0.9, hi: 1.1 })!;
    expect(stemGeometry(one, false, 600).dots).toMatchObject({ r: 3.5 }); // a lone stem has room
  });
});

describe('7. a panned window is a cache hit while no atom enters or leaves', () => {
  it('more atoms than stems: the key is the index range', () => {
    const sys = build(['L ~ Poisson(1000000)', 'R = sqrt(L)']);
    const a = sys.pmfRuns('R', {}, { lo: 990, hi: 1010 })!;
    expect(sys.pmfRuns('R', {}, { lo: 989.5, hi: 1010.5 })).toBe(a);
  });
});
