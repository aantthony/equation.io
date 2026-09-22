import { compileGpu } from './compiler.ts';
import { describe, expect, it } from 'vitest';
import {
  type BaseDist,
  RVSystem,
  buildRVSystem,
  checkDerived,
  densityAt,
  densityExpr,
  matchExpectation,
  matchProbability,
  parseDistribution,
  probabilityValue,
  regionExpr,
  scanDistribution,
  scanRandomRows,
  shadePolygon,
  toExpectation,
  toProbability,
} from './dist.ts';
import { evaluate, normalcdf, normalpdf, parseExpr } from './expr.ts';
import { classify } from './plot.ts';

const none = new Set<string>();

const dist = (rhs: string): BaseDist => parseDistribution(rhs, none);

const names = (...ns: string[]) => new Set(ns);

const prob = (inner: string, ns = names('X')) => toProbability(parseExpr(inner), ns);

/** Build a system from document rows, as the app and worker do. */
const build = (rows: string[], constNames = names('a', 'b', 'm', 's')) => {
  const sys = new RVSystem();
  const built = buildRVSystem(sys, scanRandomRows(rows), {
    fnNames: none,
    getFn: () => undefined,
    constNames,
    taken: () => false,
  });
  return { sys, built };
};

const P = (sys: RVSystem, body: string, env: Record<string, number> = {}) =>
  sys.probability(parseExpr(body), env);

describe('erf / normal built-ins', () => {
  it('evaluates erf accurately', () => {
    expect(evaluate(parseExpr('erf(1)'), {})).toBeCloseTo(0.8427008, 5);
    expect(evaluate(parseExpr('erf(-1)'), {})).toBeCloseTo(-0.8427008, 5);
    expect(evaluate(parseExpr('erf(0)'), {})).toBe(0);
  });

  it('evaluates normalpdf and normalcdf', () => {
    expect(evaluate(parseExpr('normalpdf(0, 0, 1)'), {})).toBeCloseTo(0.3989423, 6);
    expect(evaluate(parseExpr('normalcdf(1.959964, 0, 1)'), {})).toBeCloseTo(0.975, 5);
  });
});

describe('scanDistribution / parseDistribution', () => {
  it('detects name ~ rhs rows', () => {
    expect(scanDistribution('X ~ Normal(0, 1)')).toEqual({ name: 'X', rhs: 'Normal(0, 1)' });
    expect(scanDistribution('y = x^2')).toBeNull();
  });

  it('parses Normal with symbolic parameters', () => {
    const d = dist('Normal(0, a)');
    expect(d.kind).toBe('normal');
    expect(d.args[0]).toEqual({ kind: 'num', value: 0 });
    expect(d.args[1]).toEqual({ kind: 'var', name: 'a' });
  });

  it('parses the whole zoo, with aliases and standard defaults', () => {
    expect(dist('N').kind).toBe('normal');
    expect(dist('N').args.map(a => evaluate(a, {}))).toEqual([0, 1]);
    expect(dist('U(2, 3)').kind).toBe('uniform');
    expect(dist('uniform(2, 3)').kind).toBe('uniform');
    expect(dist('Exp(2)').kind).toBe('exponential');
    expect(dist('Exponential(2)').args).toEqual([{ kind: 'num', value: 2 }]);
  });

  it('rejects unknown distributions and wrong arity', () => {
    expect(() => dist('Zipf(3)')).toThrow(/Unknown distribution/);
    expect(() => dist('Normal(1)')).toThrow(/2 arguments/);
    expect(() => dist('Normal(1, 2, 3)')).toThrow(/2 arguments/);
    expect(() => dist('Exponential(1, 2)')).toThrow(/1 argument/);
    expect(() => dist('2x + 1')).toThrow(/Expected a distribution/);
  });
});

describe('densityExpr', () => {
  it('classifies as an implicit curve with slider params', () => {
    const c = classify(densityExpr(dist('Normal(0, a)')), new Set(['a']));
    expect(compileGpu(c).type).toBe('implicit2d');
    expect(c.params).toEqual(['a']);
    const field = (compileGpu(c) as { field: string }).field;
    expect(field).toContain('eq_normalpdf');
    expect(field).toContain('u_a');
  });

  it('evaluates the uniform density as a piecewise box', () => {
    const e = densityExpr(dist('Uniform(1, 3)'));
    expect(evaluate(e, { x: 2, y: 0.5 })).toBeCloseTo(0, 9); // on the curve
    expect(evaluate(e, { x: 0, y: 0 })).toBeCloseTo(0, 9); // outside the support
  });

  it('classifies the uniform and exponential densities as curves', () => {
    expect(compileGpu(classify(densityExpr(dist('Uniform(0, 1)')))).type).toBe('implicit2d');
    expect(compileGpu(classify(densityExpr(dist('Exponential(2)')))).type).toBe('implicit2d');
  });

  it('degrades invalid parameters to a flat 0 instead of a negative density', () => {
    // Slider-valued: written-out bad numbers are refused at parse time.
    const uni = densityExpr(dist('Uniform(3, b)'));
    expect(evaluate(uni, { x: 2, y: 0, b: 1 })).toBeCloseTo(0, 9);
    const exp = densityExpr(dist('Exponential(a)'));
    expect(evaluate(exp, { x: 2, y: 0, a: -1 })).toBeCloseTo(0, 9);
  });
});

describe('scanRandomRows', () => {
  it('finds base rows and follows derived rows transitively', () => {
    const scan = scanRandomRows(['X ~ Normal(0, 1)', 'Z = Y + 1', 'Y = X^2', 'a = 2']);
    expect([...scan.base.keys()]).toEqual([0]);
    expect(new Set(scan.derived.keys())).toEqual(new Set([1, 2]));
    expect(scan.derived.get(2)).toEqual({ name: 'Y', rhs: ' X^2' });
  });

  it('leaves plain constants and claimed rows alone', () => {
    const scan = scanRandomRows(['X ~ N', 'a = 2', null, 'b = a + 1']);
    expect(scan.derived.size).toBe(0);
  });

  it('matches identifier tokens, not word boundaries', () => {
    expect(scanRandomRows(['X ~ N', 'Y = X_1 + 2']).derived.size).toBe(0); // X_1 is not X
    expect(scanRandomRows(['X ~ N', 'Y = aX + 2']).derived.size).toBe(0); // aX is one name
    expect(scanRandomRows(['X ~ N', 'Y = 2X']).derived.size).toBe(1); // 2X is 2·X
  });

  it('never claims reserved names', () => {
    const scan = scanRandomRows(['X ~ N', 'e = X']);
    expect(scan.derived.size).toBe(0); // `e = X` stays an equation row
  });
});

describe('toProbability', () => {
  it('reads bounds around one variable, both directions', () => {
    expect(prob('X < 2').single).toEqual({ rv: 'X', hi: { kind: 'num', value: 2 }, hiStrict: true });
    expect(prob('X > 2').single).toEqual({ rv: 'X', lo: { kind: 'num', value: 2 }, loStrict: true });
    const asc = prob('-1 < X <= 2').single!;
    expect(asc.lo).toEqual({ kind: 'neg', a: { kind: 'num', value: 1 } });
    expect(asc.hi).toEqual({ kind: 'num', value: 2 });
    const desc = prob('2 > X > -1').single!;
    expect(desc.lo).toEqual({ kind: 'neg', a: { kind: 'num', value: 1 } });
    expect(desc.hi).toEqual({ kind: 'num', value: 2 });
  });

  it('reports every referenced variable', () => {
    expect(prob('Y < 4', names('X', 'Y')).rvs).toEqual(['Y']);
    expect(new Set(prob('X < Y', names('X', 'Y')).rvs)).toEqual(new Set(['X', 'Y']));
  });

  it('captures bounds around one inline expression', () => {
    const sum = prob('0.5 < X + Y < 1.5', names('X', 'Y'));
    expect(sum.single).toBeUndefined();
    expect(sum.inline!.e).toEqual(parseExpr('X + Y'));
    expect(sum.inline!.lo).toEqual({ kind: 'num', value: 0.5 });
    expect(prob('X^2 < 1').inline!.e).toEqual(parseExpr('X^2'));
  });

  it('handles bodies with no single-variable shape', () => {
    expect(prob('X < Y', names('X', 'Y')).single).toBeUndefined();
    expect(prob('X < Y', names('X', 'Y')).inline).toBeUndefined(); // two terms carry variables
    expect(prob('X < a < b').single).toBeUndefined(); // extra constraint beyond the bounds
    expect(prob('a < b < X').single).toBeUndefined(); // ditto, from the left
    expect(prob('X > X').single).toBeUndefined();
  });

  it('rejects malformed bodies', () => {
    expect(() => prob('X + 1')).toThrow(/expects an inequality/);
    expect(() => prob('a < b')).toThrow(/must reference a random variable/);
    expect(() => prob('-1 < X > 2')).toThrow(/same way/);
    expect(() => prob('X < x')).toThrow(/plot coordinate x/);
  });
});

describe('regionExpr', () => {
  it('classifies as a shaded region with an outline', () => {
    const p = prob('X < b').single!;
    const c = classify(regionExpr(dist('Normal(0, 1)'), p.lo, p.hi), new Set(['b']));
    expect(compileGpu(c).type).toBe('ineq2d');
    const plot = compileGpu(c) as { field: string; edges: string[] };
    expect(plot.field).toContain('eq_normalpdf');
    expect(plot.field).toContain('u_b');
    expect(plot.edges).toHaveLength(1);
    expect(c.params).toEqual(['b']);
  });

  it('is negative inside the area and positive outside', () => {
    const p = prob('-1 < X < 1').single!;
    const region = regionExpr(dist('Normal(0, 1)'), p.lo, p.hi);
    if (region.kind !== 'ineq') throw new Error('expected ineq');
    const f = (x: number, y: number) => evaluate(region.l, { x, y });
    expect(f(0, 0.2)).toBeLessThan(0); // under the peak
    expect(f(0, 0.5)).toBeGreaterThan(0); // above the density
    expect(f(2, 0.05)).toBeGreaterThan(0); // outside the bounds
    expect(f(0, -0.1)).toBeGreaterThan(0); // below the axis
  });
});

describe('probabilityValue (exact)', () => {
  const value = (d: string, body: string, env: Record<string, number> = {}) => {
    const p = prob(body).single!;
    return probabilityValue(dist(d), p.lo, p.hi, env);
  };

  it('computes normal probabilities', () => {
    expect(value('Normal(0, 1)', 'X < 0')).toBeCloseTo(0.5, 6);
    expect(value('Normal(0, 1)', 'X < 1.959964')).toBeCloseTo(0.975, 5);
    expect(value('Normal(0, 1)', 'X > 1')).toBeCloseTo(0.1586553, 5);
    expect(value('Normal(0, 1)', '-1 < X < 1')).toBeCloseTo(0.6826895, 5);
    expect(value('Normal(m, s)', 'X < b', { m: 1, s: 2, b: 1 })).toBeCloseTo(0.5, 6);
  });

  it('computes uniform and exponential probabilities', () => {
    expect(value('Uniform(0, 2)', 'X < 0.5')).toBeCloseTo(0.25, 9);
    expect(value('Uniform(0, 2)', 'X > 3')).toBe(0);
    expect(value('Uniform(0, 2)', '-1 < X < 5')).toBeCloseTo(1, 9);
    expect(value('Exponential(2)', 'X < 1')).toBeCloseTo(1 - Math.exp(-2), 9);
    expect(value('Exponential(2)', 'X < -1')).toBe(0);
  });

  it('is NaN while parameters are invalid', () => {
    expect(value('Normal(0, s)', 'X < 1', { s: 0 })).toBeNaN();
    expect(value('Uniform(3, b)', 'X < 1', { b: 1 })).toBeNaN();
    expect(value('Exponential(a)', 'X < 1', { a: -2 })).toBeNaN();
  });
});

describe('P(…) row matching', () => {
  it('matches only whole P(...) rows', () => {
    expect(matchProbability('P(X < 2)')).toBe('X < 2');
    expect(matchProbability(' P ( -1 < X < 2 ) ')).toBe(' -1 < X < 2 ');
    expect(matchProbability('y = P(X < 2)')).toBeNull();
    expect(matchProbability('Q(X < 2)')).toBeNull();
  });
});

describe('E(…) rows', () => {
  const expectation = (inner: string, ns = names('X')) => toExpectation(parseExpr(inner), ns);

  it('matches only whole E(...) rows', () => {
    expect(matchExpectation('E(X)')).toBe('X');
    expect(matchExpectation(' E ( X^2 + Y ) ')).toBe(' X^2 + Y ');
    expect(matchExpectation('y = E(X)')).toBeNull();
    expect(matchExpectation('F(X)')).toBeNull();
  });

  it('validates the body against the declared variables', () => {
    expect(expectation('X + 1').rvs).toEqual(['X']);
    expect(() => expectation('X < 2')).toThrow(/P\(…\)/);
    expect(() => expectation('(X, 1)')).toThrow(/single value/);
    expect(() => expectation('a + 1')).toThrow(/must reference a random variable/);
    expect(() => expectation('X + x')).toThrow(/plot coordinate x/);
  });

  it('is exact under a derivable law', () => {
    const { sys } = build(['X ~ Normal(2, 3)', 'Y = 2X + 1']);
    expect(sys.mean('X', {})).toBe(2);
    expect(sys.mean('Y', {})).toBe(5);
    const { sys: u } = build(['X1 ~ Uniform(0, 1)', 'X2 ~ Uniform(0, 3)', 'S = X1 + X2']);
    expect(u.mean('S', {})).toBe(2);
    const { sys: e } = build(['X ~ Exponential(4)']);
    expect(e.mean('X', {})).toBe(0.25);
  });

  it('integrates one-variable transforms against the base pdf (quadrature)', () => {
    // (Not the standard normal: its square is the exact ChiSquared(1).)
    const { sys } = build(['X ~ Normal(0, 2)', 'Y = X^2']);
    expect(sys.exactMoments('Y', {})).toBeNull();
    const qm = sys.quadMoments('Y', {})!;
    expect(qm.mean).toBeCloseTo(4, 7); // E[X²] = Var(X) = 4, to quadrature digits
    expect(qm.sd).toBeCloseTo(4 * Math.SQRT2, 6); // Var(X²) = 2σ⁴
    expect(sys.mean('Y', {})).toBeCloseTo(4, 7);
    const { sys: r } = build(['X ~ Normal(0, 1)', 'R = sqrt(X)']);
    // Partial support averages where defined: E[√X | X > 0] =
    // 2^(-1/4)·Γ(3/4)/√(2π) / P(X > 0) ≈ 0.8222.
    const rq = r.quadMoments('R', {})!;
    expect(rq.mass).toBeCloseTo(0.5, 5);
    expect(rq.mean).toBeCloseTo(0.8222, 3);
  });

  it('quadrature moments follow chains and every base family', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Y = X^2', 'Z = Y + 1']);
    expect(sys.quadMoments('Y', {})!.mean).toBeCloseTo(1 / 3, 9);
    expect(sys.quadMoments('Y', {})!.sd).toBeCloseTo(Math.sqrt(4 / 45), 8);
    expect(sys.mean('Z', {})).toBeCloseTo(4 / 3, 8); // grounded through Y
    const { sys: e } = build(['X ~ Exponential(2)', 'Y = X^2']);
    expect(e.mean('Y', {})).toBeCloseTo(0.5, 7); // E[X²] = 2/λ²
    const { sys: s } = build(['X ~ Normal(m, s)', 'Y = X^2']);
    expect(s.mean('Y', { m: 2, s: 1 })).toBeCloseTo(5, 7); // μ² + σ²
  });

  it('leaves joint dependence to the sampler', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'W ~ Normal(0, 1)', 'M = X W']);
    expect(sys.quadMoments('M', {})).toBeNull();
    expect(sys.mean('M', {})).toBeCloseTo(0, 1); // Monte Carlo still answers
  });

  it('responds to slider constants and is NaN when broken', () => {
    const { sys } = build(['X ~ Normal(m, s)', 'Y = X^3 + a']);
    expect(sys.mean('Y', { m: 0, s: 1, a: 10 })).toBeCloseTo(10, 1);
    expect(sys.mean('X', { m: 1, s: -1 })).toBeNaN();
  });

  it('interpolates the density polyline for the marker height', () => {
    const curve = { pts: [0, 0, 1, 2, 2, 0], mean: 1, sd: 0.5, mass: 1 };
    expect(densityAt(curve, 0.5)).toBeCloseTo(1, 9);
    expect(densityAt(curve, 1)).toBeCloseTo(2, 9);
    expect(densityAt(curve, 5)).toBe(0);
  });
});

describe('buildRVSystem', () => {
  it('claims base and derived rows and reports row errors', () => {
    const { sys, built } = build(['X ~ Normal(0, 1)', 'Y = X^2', 'W ~ Zipf(3)']);
    expect(built.rowRV.get(0)).toBe('X');
    expect(built.rowRV.get(1)).toBe('Y');
    expect(sys.get('Y')?.kind).toBe('derived');
    expect(built.errors.get(2)).toMatch(/Unknown distribution/);
  });

  it('rejects name collisions and reserved names', () => {
    const { built } = build(['X ~ N', 'X ~ U']);
    expect(built.errors.get(1)).toBe('X is already defined.');
    expect(build(['pi ~ N']).built.errors.get(0)).toMatch(/Cannot use pi/);
    const taken = buildRVSystem(new RVSystem(), scanRandomRows(['X ~ N']), {
      fnNames: none, getFn: () => undefined, constNames: none, taken: () => true,
    });
    expect(taken.errors.get(0)).toBe('X is already defined.');
  });

  it('rejects random variables inside distribution parameters', () => {
    const { built } = build(['X ~ Normal(0, 1)', 'Y ~ Normal(X, 1)']);
    expect(built.errors.get(1)).toMatch(/cannot depend on a random variable/);
  });

  it('reports cycles and ripples errors to dependents', () => {
    const { sys, built } = build(['X ~ N', 'Y = Z + X', 'Z = Y + 1', 'W = Z^2']);
    expect(built.errors.get(1)).toMatch(/circular/);
    expect(built.errors.get(2)).toMatch(/circular/);
    expect(built.errors.get(3)).toMatch(/Z has an error/);
    expect(sys.has('X')).toBe(true);
    expect(sys.has('W')).toBe(false);
  });

  it('validates derived expressions', () => {
    const { built } = build(['X ~ N', 'Y = X + x']);
    expect(built.errors.get(1)).toMatch(/plot coordinate x/);
    expect(build(['X ~ N', 'Y = X + q']).built.errors.get(1)).toBe('q is not defined.');
    expect(() => checkDerived(parseExpr('(X, 1)'), names('X'), none)).toThrow(/single value/);
  });
});

describe('RVSystem sampling', () => {
  it('is deterministic and matches the declared moments', () => {
    const { sys } = build(['X ~ Normal(2, 3)']);
    const { sys: sys2 } = build(['X ~ Normal(2, 3)']);
    const c = sys.curve('X', {})!;
    expect(c.mean).toBeCloseTo(2, 2);
    expect(c.sd).toBeCloseTo(3, 2);
    expect(c.mass).toBe(1);
    expect(sys.columns('X', {})).toEqual(sys2.columns('X', {}));
  });

  it('keeps distinct names independent: X + Y is the convolution', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'Y ~ Normal(0, 1)', 'S = X + Y']);
    const c = sys.curve('S', {})!;
    expect(c.mean).toBeCloseTo(0, 1);
    expect(c.sd).toBeCloseTo(Math.SQRT2, 1);
    expect(P(sys, 'S < 0')).toBeCloseTo(0.5, 1.5);
    // Against the exact normal CDF at a non-symmetric point.
    expect(P(sys, 'S < 1')).toBeCloseTo(normalcdf(1, 0, Math.SQRT2), 1.5);
  });

  it('keeps the same name dependent: X + X is 2X, not a convolution', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'D = X + X']);
    expect(sys.curve('D', {})!.sd).toBeCloseTo(2, 1);
    expect(P(sys, 'X > X')).toBe(0);
  });

  it('sums of uniforms make the CLT triangle', () => {
    const { sys } = build(['X1 ~ Uniform(0, 1)', 'X2 ~ Uniform(0, 1)', 'S = X1 + X2']);
    const c = sys.curve('S', {})!;
    expect(c.mean).toBeCloseTo(1, 2);
    expect(P(sys, 'S < 1')).toBeCloseTo(0.5, 2);
    expect(P(sys, 'S < 0.5')).toBeCloseTo(0.125, 1.5);
  });

  it('estimates product distributions', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'Y ~ Normal(0, 1)', 'M = X Y']);
    expect(P(sys, 'M > 0')).toBeCloseTo(0.5, 1.5);
  });

  it('handles piecewise conditionals: Y = {X > 0: X^2, 1}', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'Y = {X > 0: X^2, 1}']);
    // P(Y > 1/2) = P(X > 1/√2) + P(X <= 0).
    const exact = 1 - normalcdf(Math.SQRT1_2, 0, 1) + 0.5;
    expect(P(sys, 'Y > 0.5')).toBeCloseTo(exact, 1.5);
    expect(P(sys, 'Y >= 0')).toBe(1);
  });

  it('estimates joint probabilities of dependent variables', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'W ~ Normal(0, 1)', 'Y = {X > 0: X^2, 1}']);
    expect(P(sys, 'W > X')).toBeCloseTo(0.5, 1.5);
    // P(Y > X): on X <= 0, Y = 1 > X always (prob 1/2); on X > 0, X^2 > X iff
    // X > 1, so P(X > 1) adds. Exact: 0.5 + (1 - Φ(1)).
    const exact = 0.5 + 1 - normalcdf(1, 0, 1);
    expect(P(sys, 'Y > X')).toBeCloseTo(exact, 1.5);
  });

  it('responds to slider constants through the environment', () => {
    const { sys } = build(['X ~ Normal(m, s)', 'Y = X + a']);
    expect(sys.curve('Y', { m: 1, s: 2, a: 10 })!.mean).toBeCloseTo(11, 1);
    expect(P(sys, 'Y < 11', { m: 1, s: 2, a: 10 })).toBeCloseTo(0.5, 1.5);
    // Re-query under new values: the cache must not serve the old ones.
    expect(sys.curve('Y', { m: 5, s: 2, a: 0 })!.mean).toBeCloseTo(5, 1);
  });

  it('caches columns per variable: unrelated constants never resample', () => {
    // Slider drags recompile on every input event; this stays cheap only
    // because a variable resamples exactly when ITS OWN parameters move.
    const { sys } = build(['X ~ Normal(m, 1)', 'Y ~ Uniform(0, 1)']);
    const x = sys.columns('X', { m: 0, s: 7 });
    expect(sys.columns('X', { m: 0, s: 8 })).toBe(x); // s is not X's parameter
    const y = sys.columns('Y', { m: 0 });
    expect(sys.columns('Y', { m: 1 })).toBe(y); // m is not Y's parameter
    expect(sys.columns('X', { m: 1 })).not.toBe(x);
  });

  it('invalidates cached samples when a dependency is redeclared', () => {
    const sys = new RVSystem();
    const opts = { fnNames: none, getFn: () => undefined, constNames: none, taken: () => false };
    buildRVSystem(sys, scanRandomRows(['X ~ Normal(0, 1)', 'Y = X + 0']), opts);
    const before = sys.curve('Y', {})!;
    buildRVSystem(sys, scanRandomRows(['X ~ Uniform(0, 1)', 'Y = X + 0']), opts);
    const after = sys.curve('Y', {})!;
    expect(before.sd).toBeCloseTo(1, 1);
    expect(after.sd).toBeCloseTo(Math.sqrt(1 / 12), 1);
  });

  it('treats partial support honestly', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'R = sqrt(X)']);
    const c = sys.curve('R', {})!;
    expect(c.mass).toBeCloseTo(0.5, 2);
    // The event "R > -1" happens only where R is defined.
    expect(P(sys, 'R > -1')).toBeCloseTo(0.5, 2);
  });

  it('is NaN when parameters are broken', () => {
    const { sys } = build(['X ~ Normal(0, s)']);
    expect(P(sys, 'X < 1', { s: -1 })).toBeNaN();
    expect(sys.curve('X', { s: -1 })).toBeNull();
  });
});

describe('exact normal propagation (affine in normal bases)', () => {
  it('recognizes affine combinations of independent normals', () => {
    const { sys } = build(['X ~ Normal(1, 0.5)', 'Y ~ Normal(3.35, 0.5)', 'Z = (X + Y)/2']);
    const d = sys.exactDist('Z')!;
    expect(d.kind).toBe('normal');
    expect(evaluate(d.args[0], {})).toBeCloseTo(2.175, 9);
    expect(evaluate(d.args[1], {})).toBeCloseTo(Math.sqrt(0.5) / 2, 9);
  });

  it('accounts for dependence through shared names: X + X is 2X', () => {
    const { sys } = build(['X ~ Normal(1, 0.5)', 'D = X + X']);
    const d = sys.exactDist('D')!;
    expect(evaluate(d.args[0], {})).toBeCloseTo(2, 9);
    expect(evaluate(d.args[1], {})).toBeCloseTo(1, 9); // (1+1)·σ, not √2·σ
  });

  it('keeps coefficients symbolic (sliders, chains through derived names)', () => {
    const { sys } = build(['X ~ Normal(1, 0.5)', 'V = a X + 1', 'W = V - X']);
    const v = sys.exactDist('V')!;
    expect(evaluate(v.args[0], { a: 2 })).toBeCloseTo(3, 9);
    expect(evaluate(v.args[1], { a: 2 })).toBeCloseTo(1, 9);
    const w = sys.exactDist('W')!; // (a−1)·X + 1
    expect(evaluate(w.args[0], { a: 3 })).toBeCloseTo(3, 9);
    expect(evaluate(w.args[1], { a: 3 })).toBeCloseTo(1, 9);
  });

  it('declines everything without a closed form', () => {
    const { sys } = build([
      'X ~ Normal(0, 1)', 'Y ~ Normal(0, 1)', 'U1 ~ Uniform(0, 1)',
      'Q = X^3', 'M = X Y', 'C = {X > 0: X^2, 1}', 'S = X + U1',
    ]);
    for (const name of ['Q', 'M', 'C', 'S']) expect(sys.exactDist(name)).toBeNull();
    expect(sys.exactDist('U1')!.kind).toBe('uniform'); // bases pass through
  });

  it('agrees with the sampled estimate', () => {
    const { sys } = build(['X ~ Normal(1, 0.5)', 'Y ~ Normal(3.35, 0.5)', 'Z = (X + Y)/2']);
    const d = sys.exactDist('Z')!;
    const c = sys.curve('Z', {})!;
    expect(c.mean).toBeCloseTo(evaluate(d.args[0], {}), 2);
    expect(c.sd).toBeCloseTo(evaluate(d.args[1], {}), 2);
  });
});

describe('exact laws (law propagation + uniform convolution)', () => {
  it('passes a bare or affine variable of a uniform through exactly', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Y = X', 'W = 2X + 1', 'V = 1 - X']);
    const y = sys.exactDist('Y')!;
    expect(y.kind).toBe('uniform');
    expect(y.args.map(e => evaluate(e, {}))).toEqual([0, 1]);
    expect(sys.exactDist('W')!.args.map(e => evaluate(e, {}))).toEqual([1, 3]);
    expect(sys.exactDist('V')!.args.map(e => evaluate(e, {}))).toEqual([0, 1]); // flipped
    expect(sys.exactMoments('W', {})).toEqual({ mean: 2, sd: 2 / Math.sqrt(12) });
  });

  it('keeps scaled exponentials exponential, and only those', () => {
    const { sys } = build(['X ~ Exponential(2)', 'Y = X', 'H = 2X', 'S = X + 1']);
    expect(evaluate(sys.exactDist('Y')!.args[0], {})).toBe(2);
    expect(evaluate(sys.exactDist('H')!.args[0], {})).toBe(1); // rate λ/c
    expect(sys.exactDist('S')).toBeNull(); // a shift leaves the family
  });

  it('collapses a repeated name before choosing a law: X + X is a box', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'D = X + X']);
    const d = sys.exactDist('D')!;
    expect(d.kind).toBe('uniform');
    expect(d.args.map(e => evaluate(e, {}))).toEqual([0, 2]);
  });

  it('convolves two uniforms into the exact triangle', () => {
    const { sys } = build(['X1 ~ Uniform(0, 1)', 'X2 ~ Uniform(0, 1)', 'S = X1 + X2']);
    const c = sys.curve('S', {})!;
    const at = (x: number) => {
      for (let i = 0; i + 1 < c.pts.length; i += 2) if (c.pts[i] === x) return c.pts[i + 1];
      return NaN;
    };
    expect(at(1)).toBeCloseTo(1, 12); // the apex is a corner, not a KDE shoulder
    expect(at(0)).toBeCloseTo(0, 12);
    expect(at(2)).toBeCloseTo(0, 12);
    expect(at(0.5)).toBeCloseTo(0.5, 12);
    expect(sys.exactProbability('S', undefined, parseExpr('1'), {})).toBeCloseTo(0.5, 12);
    expect(sys.exactMoments('S', {})!.sd).toBeCloseTo(Math.sqrt(1 / 6), 12);
    expect(c.mass).toBe(1);
  });

  it('matches Irwin–Hall for the four-fold sum', () => {
    const rows = ['X1 ~ Uniform(0, 1)', 'X2 ~ Uniform(0, 1)', 'X3 ~ Uniform(0, 1)', 'X4 ~ Uniform(0, 1)',
      'S = X1 + X2 + X3 + X4'];
    const { sys } = build(rows);
    const c = sys.curve('S', {})!;
    const mid = c.pts.findIndex((v, i) => i % 2 === 0 && v === 2);
    expect(c.pts[mid + 1]).toBeCloseTo(2 / 3, 12); // Irwin–Hall density at n/2
    expect(sys.exactProbability('S', parseExpr('3'), undefined, {})).toBeCloseTo(1 / 24, 12);
    expect(sys.exactMoments('S', {})).toEqual({ mean: 2, sd: Math.sqrt(4 / 12) });
  });

  it('handles slider coefficients and differences', () => {
    const { sys } = build(['X1 ~ Uniform(0, 1)', 'X2 ~ Uniform(0, 1)', 'S = a X1 + X2', 'D = X1 - X2']);
    // a = 2: U(0,2) ∗ U(0,1) is a trapezoid on [0, 3]; its CDF at 1.5 is 1/2.
    expect(sys.exactProbability('S', undefined, parseExpr('1.5'), { a: 2 })).toBeCloseTo(0.5, 12);
    expect(sys.exactMoments('S', { a: 2 })!.mean).toBeCloseTo(1.5, 12);
    const d = sys.curve('D', {})!;
    expect(d.pts[0]).toBeCloseTo(-1, 12); // support [-1, 1], apex at 0
    expect(Math.max(...d.pts.filter((_, i) => i % 2 === 1))).toBeCloseTo(1, 12);
    expect(sys.exactProbability('D', undefined, parseExpr('0'), {})).toBeCloseTo(0.5, 12);
  });

  it('agrees with the sampled estimate', () => {
    const { sys } = build(['X1 ~ Uniform(0, 1)', 'X2 ~ Uniform(0, 1)', 'S = X1 + X2']);
    const exact = sys.exactProbability('S', undefined, parseExpr('0.75'), {})!;
    expect(Math.abs(exact - P(sys, 'S < 0.75'))).toBeLessThan(0.01);
  });

  it('leaves mixed and nonlinear forms to the sampler', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Y ~ Normal(0, 1)', 'M = X + Y', 'Q = X^2']);
    expect(sys.exactLaw('M')).toBeNull();
    expect(sys.exactLaw('Q')).toBeNull();
    expect(sys.curve('M', {})!.mass).toBe(1); // KDE path still serves these
  });

  it('degrades broken parameters to no curve, not a wrong one', () => {
    const { sys } = build(['X1 ~ Uniform(0, s)', 'X2 ~ Uniform(0, 1)', 'S = X1 + X2']);
    expect(sys.curve('S', { s: -1 })).toBeNull();
    expect(sys.exactProbability('S', undefined, parseExpr('1'), { s: -1 })).toBeNaN();
    expect(sys.curve('S', { s: 1 })).not.toBeNull();
  });
});

describe('point masses (atoms)', () => {
  it('renders a purely discrete variable as stems, not KDE bumps', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'Y = {X > 0: 1, 2}']);
    const c = sys.curve('Y', {})!;
    expect(c.pts).toEqual([]);
    expect(c.atoms).toEqual([{ x: 1, p: 0.5 }, { x: 2, p: 0.5 }]);
    expect(c.mean).toBeCloseTo(1.5, 12);
    expect(c.sd).toBeCloseTo(0.5, 12);
  });

  it('finds the masses of a discretized uniform exactly', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'F = floor(4X)']);
    expect(sys.curve('F', {})!.atoms).toEqual([
      { x: 0, p: 0.25 }, { x: 1, p: 0.25 }, { x: 2, p: 0.25 }, { x: 3, p: 0.25 },
    ]);
  });

  it('splits a mixed distribution into its atom and continuous part', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'Y = {X > 0: X^2, 1}']);
    const c = sys.curve('Y', {})!;
    expect(c.atoms).toEqual([{ x: 1, p: 0.5 }]);
    let area = 0;
    for (let i = 0; i + 3 < c.pts.length; i += 2) {
      area += ((c.pts[i + 1] + c.pts[i + 3]) / 2) * (c.pts[i + 2] - c.pts[i]);
    }
    expect(area).toBeCloseTo(0.5, 1); // the continuous part carries the other half
  });

  it('leaves continuous estimates atom-free', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Y ~ Normal(0, 1)', 'S = X + Y']);
    expect(sys.curve('S', {})!.atoms).toBeUndefined();
  });
});

describe('support edges', () => {
  const curveArea = (pts: number[]) => {
    let a = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) a += ((pts[i + 1] + pts[i + 3]) / 2) * (pts[i + 2] - pts[i]);
    return a;
  };

  it('cuts a truncated variable off straight at its edge', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'Y = {X > 1: X, 0}']);
    const c = sys.curve('Y', {})!;
    // Nothing below the edge, and the curve steps up from the axis at it.
    expect(c.pts[0]).toBeGreaterThanOrEqual(1);
    expect(c.pts[1]).toBe(0);
    for (let i = 0; i < c.pts.length; i += 2) expect(c.pts[i]).toBeGreaterThanOrEqual(1);
    // On (1, ∞) the density is φ itself: full height at the jump, no ramp.
    expect(c.pts[3]).toBeCloseTo(normalpdf(1, 0, 1), 2);
    let worst = 0;
    for (let i = 0; i < c.pts.length; i += 2) {
      if (c.pts[i] > 1.001 && c.pts[i] < 3) {
        worst = Math.max(worst, Math.abs(c.pts[i + 1] - normalpdf(c.pts[i], 0, 1)));
      }
    }
    expect(worst).toBeLessThan(0.005);
    // The atom carries the other branch: P(X ≤ 1) = Φ(1).
    expect(c.atoms).toHaveLength(1);
    expect(c.atoms![0].x).toBe(0);
    expect(c.atoms![0].p).toBeCloseTo(normalcdf(1, 0, 1), 4);
  });

  it('keeps full height at a half-normal edge', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'H = abs(X)']);
    const c = sys.curve('H', {})!;
    expect(c.pts[0]).toBeGreaterThanOrEqual(0);
    expect(c.pts[3]).toBeCloseTo(2 * normalpdf(0, 0, 1), 2);
  });

  it('leaves a trimmed tail alone (no false edge)', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'Z = X + 0']);
    const c = sys.curve('Z', {})!;
    // The drawn range stops in the tails, where the density is ~0 and must
    // not be lifted by an edge correction.
    expect(Math.abs(c.pts[1])).toBeLessThan(0.02);
    let worst = 0;
    for (let i = 0; i < c.pts.length; i += 2) {
      if (Math.abs(c.pts[i]) <= 2.5) worst = Math.max(worst, Math.abs(c.pts[i + 1] - normalpdf(c.pts[i], 0, 1)));
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('draws the probability of the range it covers, even at a singularity', () => {
    // X² near 0 has an integrable singularity (density → ∞), where no local
    // fit is meaningful; the area must still come out right.
    const { sys } = build(['X ~ Normal(0, 1)', 'Y = {X > 0: X^2, 1}']);
    expect(curveArea(sys.curve('Y', {})!.pts)).toBeCloseTo(0.5, 2);
    const { sys: sys2 } = build(['X ~ Normal(0, 1)', 'Y = {X > 1: X, 0}']);
    expect(curveArea(sys2.curve('Y', {})!.pts)).toBeCloseTo(1 - normalcdf(1, 0, 1), 2);
  });
});

describe('density estimation', () => {
  it('recovers the standard normal density closely', () => {
    const { sys } = build(['X ~ Normal(0, 1)']);
    const { pts } = sys.curve('X', {})!;
    let worst = 0;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      if (Math.abs(pts[i]) > 2.5) continue;
      worst = Math.max(worst, Math.abs(pts[i + 1] - normalpdf(pts[i], 0, 1)));
    }
    expect(worst).toBeGreaterThan(0); // the sweep saw the curve at all
    expect(worst).toBeLessThan(0.02);
  });

  it('integrates to the sample mass', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Y ~ Normal(0, 1)', 'S = X + Y']);
    const { pts } = sys.curve('S', {})!;
    let area = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      area += ((pts[i + 1] + pts[i + 3]) / 2) * (pts[i + 2] - pts[i]);
    }
    expect(area).toBeCloseTo(1, 1);
  });

  it('clips a shade polygon to the bounds and closes it to the axis', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Y ~ Uniform(0, 1)', 'S = X + Y']);
    const curve = sys.curve('S', {})!;
    const poly = shadePolygon(curve, 0.5, 1.5)!;
    expect(poly[0]).toBeCloseTo(0.5, 9);
    expect(poly[1]).toBe(0);
    expect(poly[poly.length - 2]).toBeCloseTo(1.5, 9);
    expect(poly[poly.length - 1]).toBe(0);
    for (let i = 0; i < poly.length; i += 2) {
      expect(poly[i]).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(poly[i]).toBeLessThanOrEqual(1.5 + 1e-9);
    }
    expect(shadePolygon(curve, 5, 6)).not.toBeNull(); // empty clip yields a flat sliver
  });
});

describe('conditional-CDF curves (the quadrature tier)', () => {
  it('renders Y/(X+1) to reference accuracy: flat 3/2 plateau, then (1/z²−1)/2', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Y ~ Uniform(0, 1)', 'Z = Y/(X+1)']);
    const c = sys.curve('Z', {})!;
    for (let z = 0.05; z <= 0.45; z += 0.05) expect(densityAt(c, z)).toBeCloseTo(1.5, 3);
    for (let z = 0.55; z <= 0.95; z += 0.1) {
      expect(densityAt(c, z)).toBeCloseTo((1 / (z * z) - 1) / 2, 2);
    }
    expect(c.mean).toBeCloseTo(Math.LN2 / 2, 6);
    expect(c.sd).toBeCloseTo(Math.sqrt(1 / 6 - (Math.LN2 / 2) ** 2), 5);
    expect(c.mass).toBe(1);
  });

  it('renders X²+Y²: the π/4 plateau is flat, then the arccos tail', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Y ~ Uniform(0, 1)', 'Z = X^2+Y^2']);
    const c = sys.curve('Z', {})!;
    const plateau: number[] = [];
    for (let z = 0.1; z <= 0.9; z += 0.1) plateau.push(densityAt(c, z));
    for (const f of plateau) expect(f).toBeCloseTo(Math.PI / 4, 2);
    expect(Math.max(...plateau) - Math.min(...plateau)).toBeLessThan(0.006);
    for (const z of [1.2, 1.5, 1.8]) {
      expect(densityAt(c, z)).toBeCloseTo(Math.PI / 4 - Math.acos(1 / Math.sqrt(z)), 2);
    }
    expect(c.mean).toBeCloseTo(2 / 3, 5);
    expect(c.sd).toBeCloseTo(Math.sqrt(8 / 45), 5);
  });

  it('renders the product X·Y as −ln z', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Y ~ Uniform(0, 1)', 'Z = X Y']);
    const c = sys.curve('Z', {})!;
    for (let z = 0.1; z <= 0.9; z += 0.1) expect(densityAt(c, z)).toBeCloseTo(-Math.log(z), 2);
    expect(c.mean).toBeCloseTo(0.25, 6);
  });

  it('renders a one-variable transform: X² is 1/(2√z) with hard edges', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Z = X^2']);
    const c = sys.curve('Z', {})!;
    for (let z = 0.2; z <= 0.9; z += 0.1) expect(densityAt(c, z)).toBeCloseTo(0.5 / Math.sqrt(z), 2);
    expect(c.pts[1]).toBe(0); // the support edge cuts off straight down
    expect(c.pts[c.pts.length - 1]).toBe(0);
    expect(c.mean).toBeCloseTo(1 / 3, 6);
  });

  it('keeps point masses as stems: floor(2X) is two atoms and no curve', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Z = floor(2X)']);
    const c = sys.curve('Z', {})!;
    expect(c.pts.length).toBe(0);
    expect(c.atoms).toEqual([{ x: 0, p: 0.5 }, { x: 1, p: 0.5 }]);
  });

  it('responds to slider constants through the environment', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Y ~ Uniform(0, 1)', 'Z = Y/(X+a)']);
    expect(densityAt(sys.curve('Z', { a: 1 })!, 0.25)).toBeCloseTo(1.5, 3);
    // a = 2: Z = Y/(X+2) is flat at 5/2 up to 1/3.
    expect(densityAt(sys.curve('Z', { a: 2 })!, 0.25)).toBeCloseTo(2.5, 3);
  });

  it('is deterministic: resample() leaves the curve and mean untouched', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Y ~ Uniform(0, 1)', 'Z = Y/(X+1)']);
    const c1 = sys.curve('Z', {});
    const m1 = sys.mean('Z', {});
    sys.resample(7);
    expect(sys.curve('Z', {})).toBe(c1);
    expect(sys.mean('Z', {})).toBe(m1);
    sys.resample(0); // restore the default salt for the rest of the suite
  });

  it('zooms the drawn window past heavy tails: 1/(1+X) resolves its peak', () => {
    // 1+X crosses its pole, so Z has ~1/z² tails: the 0.5% quantiles sit
    // near ±48 and would starve the peak (true height ≈ 0.97 near z ≈ ½)
    // down to a handful of grid cells. The visual window must collapse to
    // the bulk while a light-tailed χ² keeps its full quantile range.
    const { sys } = build(['X ~ Normal(0, 1)', 'Z = 1/(1+X)']);
    const c = sys.curve('Z', {})!;
    expect(c.pts[0]).toBeGreaterThan(-20);
    expect(c.pts[c.pts.length - 2]).toBeLessThan(20);
    const exact = (z: number) =>
      Math.exp(-((1 / z - 1) ** 2) / 2) / (Math.sqrt(2 * Math.PI) * z * z);
    expect(densityAt(c, 0.5)).toBeCloseTo(exact(0.5), 1);
    expect(densityAt(c, 1)).toBeCloseTo(exact(1), 2);
    // No finite moments (1+X crosses its pole): μ/σ are truncation
    // artifacts, so the curve carries robust stand-ins for the readout.
    expect(c.robust).toBeDefined();
    expect(c.robust!.median).toBeCloseTo(0.7099, 2); // Φ(1/m − 1) = 0.6587
    expect(c.robust!.iqr).toBeCloseTo(0.8716, 2);
  });

  it('keeps sound moments unflagged: X²+Y² shows μ/σ, not median/IQR', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Y ~ Uniform(0, 1)', 'Z = X^2+Y^2']);
    expect(sys.curve('Z', {})!.robust).toBeUndefined();
  });

  it('re-rasterizes the visible stretch on deep zoom, at full accuracy', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'Z = 1/(1+X)']);
    const exact = (z: number) =>
      Math.exp(-((1 / z - 1) ** 2) / 2) / (Math.sqrt(2 * Math.PI) * z * z);
    const full = sys.curve('Z', {})!;
    const zoomed = sys.curve('Z', {}, { lo: 0.35, hi: 0.59 })!;
    // The full-window curve's grid is too coarse to land the peak; the
    // zoomed rasterization must nail it (true height ≈ 0.9679).
    expect(densityAt(full, 0.5)).not.toBeCloseTo(exact(0.5), 2);
    expect(densityAt(zoomed, 0.5)).toBeCloseTo(exact(0.5), 3);
    // Still one global curve: the dense stretch splices into the polyline.
    expect(zoomed.pts[0]).toBe(full.pts[0]);
    expect(zoomed.pts[zoomed.pts.length - 2]).toBe(full.pts[full.pts.length - 2]);
    // Pan headroom: a nearby view reuses the cached zoom, no recompute.
    expect(sys.curve('Z', {}, { lo: 0.36, hi: 0.6 })).toBe(zoomed);
    // Zooming out far enough returns the plain full-window curve.
    expect(sys.curve('Z', {}, { lo: -30, hi: 30 })).toBe(full);
  });

  it('leaves three-variable expressions to the sampled tier', () => {
    const { sys } = build(['X ~ Uniform(0, 1)', 'Y ~ Uniform(0, 1)', 'W ~ Uniform(0, 1)', 'T = X Y W']);
    const c1 = sys.curve('T', {})!;
    expect(c1.mean).toBeCloseTo(0.125, 2); // sample-grade, not quadrature-grade
    sys.resample(7);
    expect(sys.curve('T', {})).not.toBe(c1); // sampled curves DO redraw
    sys.resample(0);
  });
});

describe('atoms vs. the repeats a many-to-one transform makes', () => {
  // A continuous g that is k-to-1 in the inner variable repeats values — the
  // ±y pair of Y², the branches of any even function — but only k times per
  // conditional column, however fine the grid. Pooling those O(1) runs across
  // all 512 columns used to clear the mass threshold on arithmetic alone.
  const curveOf = (rhs: string) =>
    build(['X ~ Uniform(0, 1)', 'Y ~ Normal(0, 1)', `Z = ${rhs}`]).sys.curve('Z', {})!;

  it.each([['max(Y^2, X)'], ['min(Y^2, X)'], ['max(abs(Y), X)'], ['Y^2 + 0X']])(
    'draws %s as a curve, with no stems',
    rhs => {
      const c = curveOf(rhs);
      expect(c.atoms).toBeUndefined();
      expect(c.pts.length).toBeGreaterThan(64);
      // The probability is in the curve, not stranded in stems. What the
      // drawn area misses is the trimmed tail — the two-variable window keeps
      // ~0.94 of a singular-peak law, against 0.57 and 0 when these were read
      // as atoms.
      let area = 0;
      for (let i = 0; i + 3 < c.pts.length; i += 2) {
        area += ((c.pts[i + 1] + c.pts[i + 3]) / 2) * (c.pts[i + 2] - c.pts[i]);
      }
      expect(area).toBeGreaterThan(0.9);
    },
  );

  it('still finds the point masses a piecewise branch really makes', () => {
    const c = curveOf('floor(Y) + 0X');
    expect(c.atoms?.length).toBeGreaterThan(3);
    expect(c.atoms!.reduce((s, a) => s + a.p, 0)).toBeCloseTo(1, 2);
    // The atom at 0 is P(0 ≤ Y < 1) ≈ 0.341.
    expect(c.atoms!.find(a => a.x === 0)!.p).toBeCloseTo(0.341, 2);
  });
});

describe('robust readout judges the whole law', () => {
  it('leaves a bounded mixed law to its exact μ/σ', () => {
    // 50% at 100, the rest uniform on [0, 0.5]: both moments are exact, and
    // the median of the continuous branch alone is not this law's median.
    const { sys } = build(['X ~ Uniform(0, 1)', 'Z = {X > 0.5: 100, X}']);
    const c = sys.curve('Z', {})!;
    expect(c.atoms).toEqual([{ x: 100, p: 0.5 }]);
    expect(c.mean).toBeCloseTo(50.125, 2);
    expect(c.robust).toBeUndefined();
  });

  it('still reports median/IQR where the moments do not exist', () => {
    const { sys } = build(['X ~ Normal(0, 1)', 'Z = 1/(1+X)']);
    const c = sys.curve('Z', {})!;
    expect(c.robust).toBeDefined();
    expect(c.robust!.median).toBeCloseTo(0.71, 1);
  });

  it('does not call a two-point law unstable', () => {
    // A rare distant atom collapses the trimmed spread to zero; the moments
    // are finite all the same.
    const { sys } = build(['X ~ Uniform(0, 1)', 'Z = {X > 0.999: 1000, 0}']);
    expect(sys.curve('Z', {})!.robust).toBeUndefined();
  });
});
