/** Discrete variables in derived arithmetic (plan #6): exact pmfs by
 *  enumeration, the sampled pmf past the joint cap, closure rules, mixtures. */
import { describe, expect, it } from 'vitest';
import {
  ENUM_STATS,
  JOINT_MAX,
  type ProbBounds,
  RVSystem,
  STEM_MAX,
  buildRVSystem,
  checkDerived,
  discreteLaw,
  markerHeight,
  momentsReadout,
  scanRandomRows,
  stemGeometry,
  toExpectation,
  toProbability,
} from './dist.ts';
import { parseExpr } from './expr.ts';

const none = new Set<string>();
function build(rows: string[], consts: string[] = []) {
  const sys = new RVSystem();
  const built = buildRVSystem(sys, scanRandomRows(rows), {
    fnNames: none,
    getFn: () => undefined,
    constNames: new Set(consts),
    taken: () => false,
  });
  return { sys, built };
}
/** A P(…) row as the app reads it: inline expressions become anonymous variables. */
function P(sys: RVSystem, names: string[], body: string, env: Record<string, number> = {}) {
  const spec = toProbability(parseExpr(body, none), new Set(names));
  sys.checkProbability(spec);
  let single: ({ rv: string } & ProbBounds) | undefined = spec.single;
  if (!single && spec.inline) {
    const { e, ...bounds } = spec.inline;
    const name = `@P${anon++}`; // one per row, as in the app
    sys.addAnonymous({ name, kind: 'derived', expr: e });
    single = { rv: name, ...bounds };
  }
  return sys.eventProbability(spec.body, single, env);
}
let anon = 0;
const atoms = (sys: RVSystem, name: string, env: Record<string, number> = {}) => {
  const pmf = sys.pmfOf(name, env)!;
  return Object.fromEntries([...pmf.xs].map((x, i) => [x, pmf.ps[i]]));
};
const DICE = ['X ~ DiscreteUniform(1, 6)', 'Y ~ DiscreteUniform(1, 6)'];

describe('exact pmfs by enumeration', () => {
  it('the sum of two dice is the triangle, with exact moments', () => {
    const { sys, built } = build([...DICE, 'S = X + Y']);
    expect(built.errors.size).toBe(0);
    expect(sys.isDiscreteVar('S')).toBe(true);
    const pmf = sys.pmfOf('S', {})!;
    expect([...pmf.xs]).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1].forEach((k, i) => expect(pmf.ps[i]).toBeCloseTo(k / 36, 14));
    expect(pmf).toMatchObject({ exact: true, certified: true, lost: 0, mass: 1 });
    expect(sys.moments('S', {})).toMatchObject({ kind: 'exact', mass: 1 });
    expect(sys.mean('S', {})).toBeCloseTo(7, 13);
    expect(sys.moments('S', {})).toMatchObject({ sd: expect.closeTo(Math.sqrt(35 / 6), 13) });
    expect(momentsReadout(sys.moments('S', {})!)).toBe('μ = 7, σ = 2.41523');
    // Never a density: no curve, no KDE.
    expect(sys.curve('S', {})).toBeNull();
    expect(sys.exactDist('S')).toBeNull();
  });

  it('ten dice convolve part by part, far under the joint of 6^10', () => {
    const rows = Array.from({ length: 10 }, (_, k) => `D${k} ~ DiscreteUniform(1, 6)`);
    const { sys } = build([...rows, `S = ${rows.map((_, k) => `D${k}`).join(' + ')}`]);
    const before = ENUM_STATS.points;
    const pmf = sys.pmfOf('S', {})!;
    expect(pmf.exact).toBe(true);
    expect(pmf.xs.length).toBe(51);
    expect(ENUM_STATS.points - before).toBeLessThan(3000);
    expect(pmf.ps[0]).toBeCloseTo(6 ** -10, 20);
    expect(sys.mean('S', {})).toBeCloseTo(35, 12);
  });

  it('a derived variable is not whole-number valued: atoms stand where g puts them', () => {
    const { sys } = build([
      ...DICE,
      'H = X / 2',
      'T = 0.1 X',
      'Q = X^2',
      'R = sqrt(X)',
      'F = sin(X)',
      'N ~ Poisson(2)',
      'I = 1 / N',
      'J = 1 / (X - 3)',
    ]);
    expect([...sys.pmfOf('H', {})!.xs]).toEqual([0.5, 1, 1.5, 2, 2.5, 3]);
    // 0.1·3 is 0.30000000000000004 and 0.1·6 is 0.6000000000000001: canonical atoms.
    expect([...sys.pmfOf('T', {})!.xs]).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    expect([...sys.pmfOf('Q', {})!.xs]).toEqual([1, 4, 9, 16, 25, 36]); // a sparse lattice
    expect(sys.pmfOf('R', {})!.xs[1]).toBeCloseTo(Math.SQRT2, 11);
    expect([...sys.pmfOf('F', {})!.xs]).toEqual([...sys.pmfOf('F', {})!.xs].sort((a, b) => a - b));
    expect(sys.pmfOf('F', {})!.xs.length).toBe(6);
    // The stems are drawn AT the atoms, with their own spacing deciding the dots.
    const [run] = sys.pmfRuns('H', {}, { lo: 0, hi: 10 })!;
    expect(run).toMatchObject({ ks: [0.5, 1, 1.5, 2, 2.5, 3], envelope: false, step: 0.5 });
    expect(stemGeometry(run, false, 10).dots).toMatchObject({ r: 2 }); // 5 px apart: small dots
    expect(stemGeometry({ ...run, step: undefined }, false, 10).dots).toMatchObject({ r: 3.5 });
    // 1/N at N = 0 (mass e^-2) is no value: undefined mass, said so; the rest is exact.
    const inv = sys.pmfOf('I', {})!;
    expect(inv.mass).toBeCloseTo(1 - Math.exp(-2), 12);
    expect(inv.xs[inv.xs.length - 1]).toBe(1);
    expect(inv.ps[inv.ps.length - 1]).toBeCloseTo(2 * Math.exp(-2), 12);
    expect(momentsReadout(sys.moments('I', {})!)).toMatch(/^μ = .*, P\(defined\) ≈ 0\.865$/);
    expect(sys.pmfOf('J', {})!.mass).toBeCloseTo(5 / 6, 14);
    expect(Object.keys(atoms(sys, 'J')).length).toBe(5);
  });

  it('merges joint points that differ by rounding, and a sum that cancelled is 0', () => {
    const { sys } = build([
      ...DICE,
      'W ~ DiscreteUniform(1, 6)',
      'T = 0.1 X + 0.2 Y',
      'Z = 0.1 X + 0.2 Y - 0.3 W',
      'G = X (0.1 + 0.2) - 0.3 X',
    ]);
    // 0.1·1 + 0.2·2 = 0.5 and 0.1·3 + 0.2·1 = 0.5000000000000001 are one atom.
    const t = atoms(sys, 'T');
    expect([...sys.pmfOf('T', {})!.xs]).toEqual([
      0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8,
    ]);
    expect(t[0.5]).toBeCloseTo(2 / 36, 14);
    expect(P(sys, ['X', 'Y', 'T'], 'T = 0.3').value).toBeCloseTo(1 / 36, 14);
    expect(P(sys, ['X', 'Y', 'T'], 'T <= 0.1 + 0.2').value).toBeCloseTo(1 / 36, 14); // the bound is 0.30000000000000004
    expect(P(sys, ['X', 'Y', 'T'], 'T < 0.1 + 0.2').value).toBe(0);
    // Z = 0 exactly on the plane X + 2Y = 3W, though the float sum misses by 5e-17.
    const z = sys.pmfOf('Z', {})!;
    expect([...z.xs]).toContain(0);
    expect([...z.xs].filter(x => x !== 0 && Math.abs(x) < 0.05)).toEqual([]);
    let plane = 0;
    for (let x = 1; x <= 6; x++)
      for (let y = 1; y <= 6; y++) for (let w = 1; w <= 6; w++) if (x + 2 * y === 3 * w) plane++;
    expect(z.ps[[...z.xs].indexOf(0)]).toBeCloseTo(plane / 216, 14);
    expect(P(sys, ['X', 'Y', 'W'], '0.1 X + 0.2 Y = 0.3 W').value).toBeCloseTo(plane / 216, 14);
    expect(
      P(sys, ['X', 'Y', 'W'], '0.1 X + 0.2 Y <= 0.3 W').value - P(sys, ['X', 'Y', 'W'], '0.1 X + 0.2 Y < 0.3 W').value,
    ).toBeCloseTo(plane / 216, 14);
    expect(atoms(sys, 'G')).toEqual({ 0: 1 }); // shared base: brute force, and still one atom
  });

  it('a geometric ladder keeps every rung apart (no absolute tolerance)', () => {
    const { sys } = build(['G ~ Geometric(0.5)', 'L = 2^G', 'S = 0.5^G']);
    const up = sys.pmfOf('L', {})!;
    expect([...up.xs.slice(0, 5)]).toEqual([2, 4, 8, 16, 32]);
    expect(up.xs.length).toBeGreaterThan(35);
    const down = sys.pmfOf('S', {})!;
    expect(down.xs.length).toBe(up.xs.length);
    expect(down.xs[0]).toBeGreaterThan(0);
  });

  it('piecewise and comparisons read the joint of their bases', () => {
    const { sys } = build([...DICE, 'M = {X > Y: X, Y}', 'K = {X > 3: 1, 0} + {X > 3: 1, 0}']);
    const m = sys.pmfOf('M', {})!; // max of two dice: (2k − 1)/36
    [1, 3, 5, 7, 9, 11].forEach((k, i) => expect(m.ps[i]).toBeCloseTo(k / 36, 14));
    expect(atoms(sys, 'K')).toEqual({ 0: 0.5, 2: 0.5 }); // the two indicators are ONE event
  });
});

describe('P(…) over derived discrete variables keeps its strictness', () => {
  const names = ['X', 'Y', 'S', 'A', 'B', 'H'];
  const { sys } = build([...DICE, 'S = X + Y', 'A = X + Y', 'B = X - Y', 'H = X / 2']);
  const p = (body: string) => P(sys, names, body);

  it('bounds on one variable: <, <=, =, != and chains', () => {
    expect(p('S <= 5')).toEqual({ value: expect.closeTo(10 / 36, 14), exact: true });
    expect(p('S < 5').value).toBeCloseTo(6 / 36, 14);
    expect(p('S = 5').value).toBeCloseTo(4 / 36, 14);
    expect(p('S != 5').value).toBeCloseTo(32 / 36, 14);
    expect(p('5 = S').value).toBeCloseTo(4 / 36, 14);
    expect(p('S == 5').value).toBeCloseTo(4 / 36, 14);
    expect(p('3 < S <= 5').value).toBeCloseTo(7 / 36, 14);
    expect(p('3 <= S < 5').value).toBeCloseTo(5 / 36, 14);
    expect(p('S > 12').value).toBe(0);
    expect(p('S >= 12').value).toBeCloseTo(1 / 36, 14);
    expect(p('S = 4.5').value).toBe(0);
    expect(p('H = 1.5').value).toBeCloseTo(1 / 6, 14);
    expect(p('H < 1.5').value).toBeCloseTo(2 / 6, 14);
    expect(p('H <= 1.5').value).toBeCloseTo(3 / 6, 14);
    expect(p('X + Y = 7').value).toBeCloseTo(1 / 6, 14); // an inline expression
    expect(p('X Y != 6').value).toBeCloseTo(32 / 36, 14);
    expect(P(sys, names, 'S <= b', { b: NaN }).value).toBeNaN();
  });

  it('joint events: ties have mass', () => {
    expect(p('X > Y')).toEqual({ value: expect.closeTo(15 / 36, 14), exact: true });
    expect(p('X >= Y').value).toBeCloseTo(21 / 36, 14);
    expect(p('X = Y').value).toBeCloseTo(6 / 36, 14);
    expect(p('X != Y').value).toBeCloseTo(30 / 36, 14);
    expect(p('X < Y < 5').value).toBeCloseTo(6 / 36, 14);
    expect(p('X <= Y <= 5').value).toBeCloseTo(15 / 36, 14);
  });

  it('dependence: the joint is over the BASES, never over derived marginals', () => {
    expect(p('X > X').value).toBe(0);
    expect(p('X >= X').value).toBe(1);
    expect(p('X = X').value).toBe(1);
    expect(p('A > B').value).toBe(1); // X + Y > X − Y ⇔ Y > 0: certain, though the marginals overlap
    expect(p('A = B').value).toBe(0);
    expect(p('A + B = 2 X').value).toBe(1);
    expect(p('S > A').value).toBe(0); // S and A are the same variable
    const d = build([...DICE, 'D = X - X', 'E = X + X', 'W = X Y', 'V = A B', 'A = X + Y', 'B = X - Y']).sys;
    expect(atoms(d, 'D')).toEqual({ 0: 1 });
    expect([...d.pmfOf('E', {})!.xs]).toEqual([2, 4, 6, 8, 10, 12]); // 2X: never the triangle
    expect(d.pmfOf('W', {})!.xs.length).toBe(18);
    expect(d.mean('V', {})).toBeCloseTo(0, 13); // X² − Y²
    expect(atoms(d, 'V')[0]).toBeCloseTo(6 / 36, 14);
  });

  it('a point event needs discrete variables throughout, and says which is not', () => {
    const m = build(['N ~ Poisson(3)', 'Z ~ Normal(0, 1)', 'M = N + Z']).sys;
    const check = (body: string) => m.checkProbability(toProbability(parseExpr(body, none), new Set(['N', 'Z', 'M'])));
    expect(() => check('N = 3')).not.toThrow();
    expect(() => check('N + N = 4')).not.toThrow();
    expect(() => check('N > Z')).not.toThrow();
    expect(() => check('Z = 3')).toThrow('P(Z = …) needs a discrete variable');
    expect(() => check('M = 3')).toThrow('P(M = …) needs a discrete variable');
    expect(() => check('N = Z')).toThrow('P(… = …) needs discrete variables, and Z is not:');
    expect(() => check('N + Z = 3')).toThrow('and Z is not');
    expect(() => toProbability(parseExpr('(N, N) = 3', none), new Set(['N']))).toThrow('compares single values');
  });
});

describe('moments of derived discrete variables', () => {
  it('E(g(X)) is the exact sum, at full precision', () => {
    const { sys } = build(['X ~ Poisson(3)', 'N ~ Binomial(10, 0.3)', 'Q = X^2', 'C = X N']);
    expect(sys.quadMoments('Q', {})!.mean).toBeCloseTo(12, 9); // λ + λ²
    expect(sys.quadMoments('C', {})!.mean).toBeCloseTo(9, 9);
    expect(sys.moments('Q', {})!.kind).toBe('exact');
    expect(sys.pmfOf('Q', {})!.lost).toBeLessThan(2e-12);
    // As the app registers an E(…) row.
    const ex = toExpectation(parseExpr('(X - 3)^2', none), new Set(['X']));
    checkDerived(ex.body, new Set(['X']), none);
    sys.addAnonymous({ name: '@E1', kind: 'derived', expr: ex.body });
    expect(sys.quadMoments('@E1', {})!.mean).toBeCloseTo(3, 9);
    expect(markerHeight(sys, '@E1', {})).toMatchObject({ x: expect.closeTo(3, 9), h: 0 }); // 3 is no atom of (X − 3)²
  });

  it('truncation does not bias the mean of a long-tailed law', () => {
    const { sys } = build([
      'G ~ Geometric(0.001)',
      'R ~ NegativeBinomial(0.5, 0.01)',
      'A = G + 0.5',
      'B = R^2',
      'C = G R',
    ]);
    expect(sys.pmfOf('A', {})!.exact).toBe(true);
    expect(sys.mean('A', {}) / 1000.5 - 1).toBeLessThan(1e-9);
    expect(Math.abs(sys.mean('A', {}) / 1000.5 - 1)).toBeLessThan(1e-9);
    const r = discreteLaw(
      {
        kind: 'negbinomial',
        args: [
          { kind: 'num', value: 0.5 },
          { kind: 'num', value: 0.01 },
        ],
      },
      {},
    )!;
    expect(Math.abs(sys.mean('B', {}) / (r.sd ** 2 + r.mean ** 2) - 1)).toBeLessThan(1e-9);
    expect(sys.quadMoments('B', {})).not.toBeNull(); // the mean is certified (σ, an x⁴ sum, only to ≈)
    // G × R is 27,000 × 2,600 joint points: over the cap, so it samples — and says so.
    expect(sys.pmfOf('C', {})!.exact).toBe(false);
    expect(Math.abs(sys.mean('C', {}) / (1000 * r.mean) - 1)).toBeLessThan(0.02);
    expect(momentsReadout(sys.moments('C', {})!)).toMatch(/\(sampled\)$/);
  });

  it('a mean that diverges is said to, not summed', () => {
    const { sys } = build(['G ~ Geometric(0.3)', 'A = 2^G', 'B = 1.2^G', 'C = 1.1^G']);
    expect(sys.meanUnstable('A', {})).toBe(true); // Σ 2^k 0.7^k diverges
    expect(sys.mean('A', {})).toBeNaN();
    expect(sys.quadMoments('A', {})).toBeNull();
    expect(sys.moments('A', {})).toMatchObject({ kind: 'robust', median: 4, meanOk: false });
    // 1.2·0.7 < 1 < 1.44·0.7: a mean (0.36/0.16), and no variance.
    expect(sys.mean('B', {})).toBeCloseTo(2.25, 3);
    expect(sys.moments('B', {})).toMatchObject({ kind: 'estimate', sd: Infinity });
    expect(sys.mean('C', {})).toBeCloseTo(0.33 / 0.23, 6);
    expect(sys.meanUnstable('C', {})).toBe(false);
  });

  it('a bounded law never reads as heavy-tailed', () => {
    const { sys } = build([
      'N ~ Binomial(1000, 0.5)',
      'B ~ Bernoulli(0.0055)',
      'K ~ Binomial(50, 0.5)',
      'A = 2^N',
      'C = 1000000 K B',
      'D = N^3',
    ]);
    // 2^N lives ten σ out, where a truncated sum would miss it: the whole support is kept.
    const a = sys.moments('A', {})!;
    expect(a.kind).toBe('exact');
    expect(Math.log((a as { mean: number }).mean)).toBeCloseTo(1000 * Math.log(1.5), 6);
    // A far atom with rare company is what fools a tail-index estimate.
    expect(sys.moments('C', {})).toMatchObject({ kind: 'exact', mean: expect.closeTo(137500, 6) });
    expect(sys.moments('D', {})!.kind).toBe('exact');
    for (const n of ['A', 'C', 'D']) expect(sys.meanUnstable(n, {})).toBe(false);
  });
});

describe('the sampled tier: past the joint cap, still a pmf', () => {
  it('Poisson(1e6) × Poisson(30) samples through the exact quantile, as a histogram on its lattice', () => {
    const { sys } = build(['L ~ Poisson(1000000)', 'M ~ Poisson(30)', 'B ~ Bernoulli(0.5)', 'W = L M B']);
    const pmf = sys.pmfOf('W', {})!;
    expect(pmf.exact).toBe(false);
    expect(sys.curve('W', {})).toBeNull(); // never a KDE
    expect(Math.abs(sys.mean('W', {}) / 15e6 - 1)).toBeLessThan(0.01);
    expect(sys.moments('W', {})).toMatchObject({ kind: 'estimate', note: 'sampled' });
    // Bernoulli's 0 is an atom of its own, not smeared into a bin.
    const runs = sys.pmfRuns('W', {})!;
    const heavy = runs.find(r => !r.envelope)!;
    expect(heavy.ks).toEqual([0]);
    expect(heavy.ps[0]).toBeCloseTo(0.5, 2);
    const bulk = runs.find(r => r.envelope)!;
    expect(bulk.ks.length).toBeLessThanOrEqual(3 * 256);
    expect(Math.max(...bulk.ps)).toBeLessThan(1e-6); // a pmf height per whole number, not a bin's mass
    expect(P(sys, ['W'], 'W = 0')).toEqual({ value: expect.closeTo(0.5, 2), exact: false });
    expect(P(sys, ['W'], 'W > 0').value + P(sys, ['W'], 'W = 0').value).toBeCloseTo(1, 12);
  });

  it('the sampled histogram is the exact pmf, binned: the spikes of X Y + Z are real', () => {
    // 78³ joint points: over the cap. Products of whole numbers cluster (each x
    // contributes a lattice of spacing x), and Z's σ of 6 does not wash that out.
    const { sys } = build(['X ~ Poisson(40)', 'Y ~ Poisson(40)', 'Z ~ Poisson(40)', 'W = X Y + Z']);
    const pmf = sys.pmfOf('W', {})!;
    expect(pmf.exact).toBe(false);
    const law = discreteLaw(sys.discreteDist('X')!, {})!;
    const truth = new Float64Array(12000);
    for (let x = 0; x < 100; x++) {
      for (let y = 0; y < 100; y++) {
        const w = law.pmf(x) * law.pmf(y);
        if (w > 1e-14) for (let z = 0; z < 100; z++) truth[x * y + z] += w * law.pmf(z);
      }
    }
    const { ks, ps } = pmf.binned!.bulk;
    const width = ks[2] - ks[1];
    expect(Number.isInteger(width)).toBe(true); // bins of whole lattice points
    let compared = 0;
    let spiky = 0;
    for (let i = 2; i + 2 < ks.length; i++) {
      if (!(ps[i] > 5e-4)) continue;
      let mass = 0;
      for (let k = Math.ceil(ks[i] - width / 2); k < ks[i] + width / 2; k++) mass += truth[k];
      expect(Math.abs(ps[i] / (mass / width) - 1), `bin at ${ks[i]}`).toBeLessThan(0.12);
      compared++;
      if (Math.abs(ps[i] / ps[i - 1] - 1) > 0.25) spiky++;
    }
    expect(compared).toBeGreaterThan(40);
    expect(spiky).toBeGreaterThan(10);
  });

  it('counts ties in a sampled joint event', () => {
    const { sys } = build(['A ~ Poisson(40000)', 'B ~ Poisson(40000)']);
    const [gt, ge, eq, lt] = ['A > B', 'A >= B', 'A = B', 'A < B'].map(b => P(sys, ['A', 'B'], b));
    expect(gt.exact).toBe(false);
    expect(eq.value).toBeGreaterThan(0.0005); // 1/(2√(πλ)) ≈ 0.0014
    expect(eq.value).toBeLessThan(0.003);
    expect(ge.value - gt.value).toBeCloseTo(eq.value, 12);
    expect(gt.value + eq.value + lt.value).toBeCloseTo(1, 12);
  });

  it('few distinct values stay stems at the sampled values, lattice or not', () => {
    const { sys } = build([
      'L ~ Poisson(1000000)',
      'M ~ Poisson(1000000)',
      'S = sin(L) {M > 0: 0, 1} + {L > M: 0.25, 0.75}',
    ]);
    const pmf = sys.pmfOf('S', {})!;
    expect(pmf.exact).toBe(false);
    expect([...pmf.xs]).toEqual([0.25, 0.75]);
    expect(pmf.binned).toBeUndefined();
    expect(pmf.ps[0] + pmf.ps[1]).toBeCloseTo(1, 12);
  });

  it('values on no lattice, too many to resolve, say so', () => {
    const { sys } = build(['L ~ DiscreteUniform(1, 10000000)', 'R = sqrt(L)']);
    const pmf = sys.pmfOf('R', {})!;
    expect(pmf).toMatchObject({ exact: false, unresolved: true, binned: null });
    expect(momentsReadout(sys.moments('R', {})!)).toMatch(/\(sampled: too many distinct values to resolve the pmf\)$/);
    expect(sys.pmfRuns('R', {})![0].ks.length).toBeLessThanOrEqual(2 * STEM_MAX + 2);
  });

  it('degenerate and invalid parameters', () => {
    const { sys } = build(
      ['X ~ Binomial(n, p)', 'Y ~ Bernoulli(p)', 'S = X + 2 Y', 'L ~ Poisson(1000000)', 'M ~ Poisson(30)', 'W = L M Y'],
      ['n', 'p'],
    );
    expect(atoms(sys, 'S', { n: 4, p: 0 })).toEqual({ 0: 1 });
    expect(atoms(sys, 'S', { n: 4, p: 1 })).toEqual({ 6: 1 });
    expect(sys.pmfOf('S', { n: 2.5, p: 0.5 })).toBeNull();
    expect(sys.pmfRuns('S', { n: 2.5, p: 0.5 })).toBeNull();
    expect(sys.mean('S', { n: 2.5, p: 0.5 })).toBeNaN();
    expect(sys.moments('S', { n: 4, p: 1.5 })).toBeNull();
    expect(atoms(sys, 'W', { n: 1, p: 0 })).toEqual({ 0: 1 }); // sampled, and an atom all the same
    expect(sys.pmfOf('W', { n: 1, p: 1.5 })).toBeNull();
    expect(() => sys.pmfOf('S', { n: 4 })).toThrow('Unbound variable: p');
  });

  it('a law wider than any table interpolates its exact quantile', () => {
    const { sys } = build(['L ~ Poisson(1000000000000000)', 'B ~ Bernoulli(0.25)', 'W = L B']);
    const col = sys.columns('L', {});
    expect(col.every(Number.isInteger)).toBe(true);
    let sum = 0;
    for (const v of col) sum += v;
    expect(Math.abs(sum / col.length - 1e15)).toBeLessThan(1e5); // σ = 3.2e7
    expect(sys.pmfOf('W', {})!.ps[0]).toBeCloseTo(0.75, 3);
  });

  it('a sampled column is the exact quantile of each stratum', () => {
    const { sys } = build(['X ~ Binomial(10, 0.3)', 'G ~ Geometric(0.2)']);
    for (const name of ['X', 'G']) {
      const law = discreteLaw(sys.discreteDist(name)!, {})!;
      const col = sys.columns(name, {});
      const counts = new Map<number, number>();
      for (const v of col) counts.set(v, (counts.get(v) ?? 0) + 1);
      for (const [k, c] of counts) expect(Math.abs(c / col.length - law.pmf(k))).toBeLessThan(1 / col.length + 1e-12);
    }
  });
});

describe('closure rules', () => {
  it('sums of independent Poissons, Binomials with one p, NegativeBinomials with one p', () => {
    const { sys } = build(
      [
        'A ~ Poisson(2)',
        'B ~ Poisson(a)',
        'S = A + B',
        'N ~ Binomial(4, p)',
        'M ~ Binomial(6, p)',
        'C ~ Bernoulli(p)',
        'T = N + M + C',
        'R1 ~ NegBin(1.5, 0.3)',
        'R2 ~ NegBin(2, 0.3)',
        'R = R1 + R2',
        'V = S + 0',
      ],
      ['a', 'p'],
    );
    expect(sys.discreteDist('S')).toMatchObject({ kind: 'poisson' });
    expect(sys.exactMoments('S', { a: 3.5 })).toEqual({ mean: 5.5, sd: Math.sqrt(5.5) });
    expect(sys.discreteDist('T')).toMatchObject({ kind: 'binomial' });
    expect(sys.exactMoments('T', { p: 0.25 })!.mean).toBeCloseTo(11 * 0.25, 14);
    expect(sys.discreteDist('R')).toMatchObject({ kind: 'negbinomial' });
    expect(sys.exactMoments('R', {})!.mean).toBeCloseTo((3.5 * 0.7) / 0.3, 12);
    expect(sys.discreteDist('V')).toMatchObject({ kind: 'poisson' });
    // The law answers P(…) and draws the stems; nothing is enumerated.
    const before = ENUM_STATS.points;
    expect(P(sys, ['S'], 'S <= 5', { a: 3.5 })).toEqual({ value: expect.closeTo(0.5289, 4), exact: true });
    expect(P(sys, ['S'], 'S = 5', { a: 3.5 }).value).toBeCloseTo((Math.exp(-5.5) * 5.5 ** 5) / 120, 12);
    expect(sys.pmfRuns('S', { a: 3.5 }, { lo: 0, hi: 4 })![0].ks).toEqual([0, 1, 2, 3, 4]);
    expect(sys.pmfOf('S', { a: 3.5 })).toBeNull();
    expect(ENUM_STATS.points).toBe(before);
    expect(sys.exactDist('S')).toBeNull(); // still never the shader's
  });

  it('Poisson(1e6) + Poisson(1e6) is Poisson(2e6): the envelope, in no time', () => {
    const { sys } = build(['A ~ Poisson(1000000)', 'B ~ Poisson(1000000)', 'S = A + B']);
    const [run] = sys.pmfRuns('S', {})!;
    expect(run.envelope).toBe(true);
    expect(Math.max(...run.ps)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI * 2e6), 9);
    expect(sys.moments('S', {})).toMatchObject({ kind: 'exact', mean: 2e6 });
  });

  it('only where it is true', () => {
    const { sys } = build(
      [
        'A ~ Poisson(2)',
        'N ~ Binomial(4, 0.5)',
        'M ~ Binomial(6, 0.25)',
        'G ~ Geometric(0.5)',
        'H ~ Geometric(0.5)',
        'D = A + A',
        'E = 2 A',
        'F = A + 1',
        'I = N + M',
        'J = G + H',
        'K = A + N',
        'L = A - A',
        'O = N - M',
      ],
      [],
    );
    for (const n of ['D', 'E', 'F', 'I', 'J', 'K', 'L', 'O']) expect(sys.discreteDist(n), n).toBeNull();
    // X + X is 2X — on the even numbers, with Poisson(2)'s masses — not Poisson(4).
    const d = sys.pmfOf('D', {})!;
    expect([...d.xs.slice(0, 4)]).toEqual([0, 2, 4, 6]);
    expect(d.ps[1]).toBeCloseTo(2 * Math.exp(-2), 12);
    expect(sys.moments('D', {})).toMatchObject({ mean: expect.closeTo(4, 9), sd: expect.closeTo(Math.sqrt(8), 9) });
    // Unequal p: enumerated, exactly.
    expect(sys.pmfOf('I', {})!.exact).toBe(true);
    expect(sys.mean('I', {})).toBeCloseTo(3.5, 12);
    expect(atoms(sys, 'L')).toEqual({ 0: 1 });
  });

  it('a closed sum over an invalid base is no law', () => {
    const { sys } = build(['N ~ Binomial(n, 0.5)', 'M ~ Binomial(n, 0.5)', 'S = N + M'], ['n']);
    expect(sys.exactMoments('S', { n: 3 })).toMatchObject({ mean: 3 });
    expect(sys.exactMoments('S', { n: 2.5 })).toBeNull(); // 2.5 + 2.5 is whole; Binomial(2.5, ½) is not a law
    expect(sys.pmfRuns('S', { n: 2.5 })).toBeNull();
    expect(P(sys, ['S'], 'S <= 2', { n: 2.5 }).value).toBeNaN();
  });
});

describe('discrete × continuous is a continuous mixture', () => {
  const { sys } = build(['N ~ Poisson(3)', 'Z ~ Normal(0, 1)', 'Y = N + Z', 'W = N Z']);

  it('takes the sampled-density tier; the conditional-CDF quadrature declines it', () => {
    expect(sys.isDiscreteVar('Y')).toBe(false);
    expect(sys.pmfOf('Y', {})).toBeNull();
    expect(sys.pmfRuns('Y', {})).toBeNull();
    expect(sys.exactLaw('Y')).toBeNull();
    // The quadrature tier integrates over a quantile grid as over a density.
    expect((sys as unknown as { condBase(n: string, e: object): unknown }).condBase('Y', {})).toBeNull();
    expect(sys.quadMoments('Y', {})).toBeNull();
    const c = sys.curve('Y', {})!;
    expect(c.pts.length).toBeGreaterThan(100);
    expect(c.atoms ?? []).toEqual([]);
    expect(c.mean).toBeCloseTo(3, 1);
    expect(c.sd).toBeCloseTo(2, 1);
    // The mixture's density: Σ pmf(k) φ(y − k) — at y = 3 about 0.189.
    let truth = 0;
    for (let k = 0; k < 40; k++)
      truth +=
        (discreteLaw(sys.discreteDist('N')!, {})!.pmf(k) * Math.exp(-((3 - k) ** 2) / 2)) / Math.sqrt(2 * Math.PI);
    const i = c.pts.findIndex((x, j) => j % 2 === 0 && x >= 3);
    expect(Math.abs(c.pts[i + 1] / truth - 1)).toBeLessThan(0.08);
    expect(sys.moments('Y', {})).toMatchObject({ kind: 'estimate' });
  });

  it('keeps the atom N = 0 of N·Z as an atom', () => {
    const c = sys.curve('W', {})!;
    expect(c.atoms).toHaveLength(1);
    expect(c.atoms![0].x).toBe(0);
    expect(c.atoms![0].p).toBeCloseTo(Math.exp(-3), 3);
  });

  it('events over it sample, as continuous ones do', () => {
    const r = P(sys, ['N', 'Z', 'Y'], 'N > Z');
    expect(r.exact).toBe(false);
    expect(r.value).toBeGreaterThan(0.9);
    expect(P(sys, ['N', 'Z', 'Y'], 'Y < 3').exact).toBe(false);
  });
});

describe('drawing: windows, selections, markers', () => {
  it('more atoms than stems: the tallest of each cell, at true locations, stable under a pan', () => {
    const { sys } = build(['L ~ Poisson(1000000)', 'R = sqrt(L)']);
    const pmf = sys.pmfOf('R', {})!;
    expect(pmf.exact).toBe(true);
    expect(pmf.xs.length).toBeGreaterThan(10000);
    const [run] = sys.pmfRuns('R', {}, { lo: 990, hi: 1010 })!;
    expect(run.ks.length).toBeLessThanOrEqual(2 * STEM_MAX);
    expect(run.ks.length).toBeGreaterThan(STEM_MAX / 2);
    const all = new Map([...pmf.xs].map((x, i) => [x, pmf.ps[i]]));
    run.ks.forEach((k, i) => expect(all.get(k)).toBe(run.ps[i]));
    // Zoomed in, every atom is its own stem.
    const [near] = sys.pmfRuns('R', {}, { lo: 1000, hi: 1000.05 })!;
    expect(near.ks.length).toBeGreaterThan(50);
    expect(near.step!).toBeLessThan(0.001); // the spacing of the atoms on screen
  });

  it('a P(…) row selects atoms with its strictness, complements as two runs', () => {
    const { sys } = build([...DICE, 'H = (X + Y) / 2']);
    const sel = (body: string) => {
      const s = toProbability(parseExpr(body, none), new Set(['H'])).single!;
      return sys.pmfRuns('H', {}, { lo: 0, hi: 10 }, s)!.map(r => r.ks);
    };
    expect(sel('H < 2')).toEqual([[1, 1.5]]);
    expect(sel('H <= 2')).toEqual([[1, 1.5, 2]]);
    expect(sel('2 < H <= 3')).toEqual([[2.5, 3]]);
    expect(sel('H = 2.5')).toEqual([[2.5]]);
    expect(sel('H = 2.25')).toEqual([]);
    expect(sel('H != 2.5')).toEqual([
      [1, 1.5, 2],
      [3, 3.5, 4, 4.5, 5, 5.5, 6],
    ]);
  });

  it('the E(…) marker stands on the atom the mean lands on', () => {
    const { sys } = build([...DICE, 'S = X + Y', 'H = X / 2', 'A ~ Poisson(2)', 'B ~ Poisson(1)', 'C = A + B']);
    expect(markerHeight(sys, 'S', {})).toEqual({ x: 7, h: expect.closeTo(1 / 6, 14) });
    expect(markerHeight(sys, 'H', {})).toEqual({ x: expect.closeTo(1.75, 12), h: 0 });
    expect(markerHeight(sys, 'C', {})).toEqual({ x: 3, h: expect.closeTo(Math.exp(-3) * 4.5, 12) }); // a closed sum: its law
  });
});

describe('cost is bounded past the cap (the per-frame guards are in perf-guards.test.ts)', () => {
  it('no enumeration step exceeds JOINT_MAX: a slider dragged past the cap degrades to sampling', () => {
    const { sys } = build(['X ~ Poisson(a)', 'Y ~ Poisson(a)', 'Z ~ Poisson(a)', 'W = X Y + Z'], ['a']);
    const t0 = performance.now();
    const exact: boolean[] = [];
    for (const a of [1, 3, 10, 30, 100, 300, 1000, 3000]) {
      const before = ENUM_STATS.points;
      const pmf = sys.pmfOf('W', { a })!;
      exact.push(pmf.exact);
      expect(ENUM_STATS.points - before).toBeLessThanOrEqual(2 * JOINT_MAX);
      expect(Math.abs(sys.mean('W', { a }) / (a * a + a) - 1)).toBeLessThan(0.02);
      expect(sys.pmfRuns('W', { a })!.length).toBeGreaterThan(0);
    }
    expect(exact).toEqual([true, true, true, false, false, false, false, false]);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe('names', () => {
  it('a variable may be called anything an identifier can be', () => {
    const { sys, built } = build([
      'constructor ~ DiscreteUniform(1, 6)',
      'toString = constructor + 1',
      'valueOf = toString + constructor',
    ]);
    expect([...built.errors]).toEqual([]);
    expect([...sys.pmfOf('valueOf', {})!.xs]).toEqual([3, 5, 7, 9, 11, 13]);
  });

  it('anonymous variables never reach an error message', () => {
    const { sys } = build(['N ~ Poisson(3)', 'Z ~ Normal(0, 1)']);
    const spec = toProbability(parseExpr('N + Z = 3', none), new Set(['N', 'Z']));
    sys.addAnonymous({ name: '@P7', kind: 'derived', expr: spec.inline!.e });
    let message = '';
    try {
      sys.checkProbability({ ...spec, single: undefined });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('Z is not');
    expect(message).not.toContain('@');
  });
});
