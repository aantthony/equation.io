import { describe, expect, it } from 'vitest';
import { type Expr, evaluate } from '../lib/expr.ts';
import { boundValue } from '../lib/intshade.ts';
import { analyze } from './graph.ts';
import { compileProg, run as runProg } from '../lib/vm.ts';

/** [error ?? plot type, readout] per row. */
const out = (texts: string[]) => analyze(texts).rows.map(r => [r.error ?? r.cpu?.type ?? 'def', r.info]);

describe('distance / angle through analyze()', () => {
  it('take any single point, however it was computed', () => {
    const rows = out([
      'M = ((1, 2), (3, 4))',
      'L = [1, 2, 3]',
      'A = (1, 2)',
      'B = (5, 11)',
      'distance(M A, B)',
      'distance(A, det(M) B)',
      'distance(A, (mean(L), 2))',
      'distance(A, (total(L), count(L)))',
      'distance(A, (min(L), 5))',
      'angle(A, (0, 0), (total(L), -3))',
    ]);
    expect(rows.slice(4)).toEqual([
      ['value', '= 0'],
      ['value', '≈ 26.4008'],
      ['value', '= 1'],
      ['value', '≈ 5.09902'],
      ['value', '= 3'],
      ['value', '≈ -1.5708'],
    ]);
  });

  it('broadcast over a scalar list exactly as |A - B| does', () => {
    const rows = analyze([
      'L = [1, 2, 3]',
      'A = (0, 0)',
      '|A - (L, 0)|',
      'distance(A, (L, 0))',
      'f(k) = distance(A, (k, 0))',
      'f(L)',
      'angle((1, 0), A, (L, L))',
      'total(angle((1, 0), (0, L)))',
    ]).rows;
    expect(rows.map(r => r.error)).toEqual(Array(8).fill(undefined));
    expect(rows[3].cpu!).toEqual(rows[2].cpu!);
    expect(rows[5].cpu!).toEqual(rows[2].cpu!);
    expect(rows[6].cpu!.type).toBe(rows[2].cpu!.type);
    expect(rows[7].info).toBe(`≈ ${Number((1.5 * Math.PI).toPrecision(6))}`);
  });

  it('measures point lists and their selected elements, rejecting scalar points', () => {
    const rows = out([
      'P = [(0, 0), (1, 1)]',
      'L = [1, 2, 3]',
      'A = (1, 2)',
      'distance(P, A)',
      'distance(A, L)',
      'angle(A, [A, A], A)',
      'distance(P[1], P[2])',
      'T = sort(P, P.x)',
      'distance(T[1], T[2])',
    ]);
    expect(rows[3][0]).toBe('vlist');
    expect(rows[4][0]).toMatch(/distance takes two points/);
    expect(rows[5][0]).toBe('vlist');
    // Only a tuple has positions (docs/multisets.md §3).
    expect(rows[6][0]).toMatch(/P\[1\] needs an order/);
    expect(rows[8]).toEqual(['value', '≈ 1.41421']);
  });

  it('never shows the internal [angle] name', () => {
    const rows = out(['B = (3, 1)', 'angle((i, 0), B)']);
    expect(rows[1][0]).toBe('angle is not supported for complex values.');
    const bad = { kind: 'call' as const, name: '[angle]', args: [{ kind: 'num' as const, value: 1 }] };
    expect(() => compileProg(bad, new Map())).toThrow(/^Cannot evaluate angle\(\) here\.$/);
  });

  it('tiny arms still have a direction; only a zero arm is undefined', () => {
    const rows = out([
      'k = 10^(-200)',
      'angle((k, 0), (0, k))',
      'angle((k, 0), (0, 0), (0, 1))',
      'angle((0, 0), (0, k))',
    ]);
    expect(rows.slice(1)).toEqual([
      ['value', '≈ 1.5708'],
      ['value', '≈ 1.5708'],
      ['value', 'undefined'],
    ]);
  });

  it('a straight angle is π on the CPU, in the og VM and in GLSL, with no foldable + 0', () => {
    const { rows, constEnv } = analyze([
      'A = (-1, 0)',
      'B = (1, 0)',
      'angle(A, (0, 0), B)',
      'angle(B, (0, 0), A)',
      'y = angle(A, (0, 0), B) x',
    ]);
    expect(rows[2].info).toBe('≈ 3.14159');
    expect(rows[3].info).toBe('≈ 3.14159');
    for (const r of [rows[2], rows[3]]) {
      const names = Object.keys(constEnv);
      if (r.cpu?.type !== 'value') throw new Error('Expected scalar readout');
      const prog = compileProg(r.cpu.expr, new Map(names.map((n, i) => [n, i])));
      expect(
        runProg(
          prog,
          names.map(n => constEnv[n]),
          new Float64Array(prog.depth),
        ),
      ).toBe(Math.PI);
      expect(evaluate(r.cpu.expr, constEnv)).toBe(Math.PI);
    }
    if (rows[4].gpu?.type !== 'implicit2d') throw new Error('Expected curve shader');
    const glsl = rows[4].gpu.field;
    expect(glsl).not.toContain('+ 0.0');
    expect(glsl).toContain('eq_angle(');
  });
});

describe('definite-integral rows shade their area', () => {
  const shadeOf = (texts: string[], at = texts.length - 1) => {
    const row = analyze(texts).rows[at];
    expect(row.error).toBeUndefined();
    const plot = row.cpu!;
    return plot.type === 'value' ? plot.shade : undefined;
  };

  it('exactly one definite integral carries { body, v, lo, hi }; the row stays a readout', () => {
    for (const text of ['int[0..1] x^2 dx', 'int(0..1, x^2 dx)', '∫[0..1] x^2 dx']) {
      const row = analyze([text]).rows[0];
      expect([row.cpu!.type, row.info]).toEqual(['value', '≈ 0.333333']);
      const shade = shadeOf([text])!;
      expect(shade.v).toBe('x');
      expect([evaluate(shade.lo, {}), evaluate(shade.hi, {})]).toEqual([0, 1]);
      expect(evaluate(shade.body, { x: 3 })).toBe(9);
    }
  });

  it('the variable is whatever the dx names, t included; bounds keep their order and ±inf', () => {
    expect(shadeOf(['int[0..1] u^2 du'])!.v).toBe('u');
    expect(shadeOf(['int[0..1] t^2 dt'])!.v).toBe('t');
    expect(analyze(['int[0..1] t^2 dt']).rows[0].cls!.animated).toBe(false);
    const rev = shadeOf(['int[1..0] x^2 dx'])!;
    expect([evaluate(rev.lo, {}), evaluate(rev.hi, {})]).toEqual([1, 0]);
    const inf = shadeOf(['int[-inf..inf] e^(-x^2) dx'])!;
    expect([boundValue(inf.lo, {}), boundValue(inf.hi, {})]).toEqual([-Infinity, Infinity]);
    // A measure written inside the quotient still strips cleanly.
    expect(evaluate(shadeOf(['int[0..1] dx/(1+x^2)'])!.body, { x: 1 })).toBe(0.5);
  });

  it('sliders, states, user functions, lists and points flow into the integrand and bounds', () => {
    const s = shadeOf(['a = 2', 'int[0..a] sin(a x) dx'])!;
    expect(evaluate(s.hi, { a: 2 })).toBe(2);
    expect(evaluate(s.body, { a: 2, x: 1 })).toBeCloseTo(Math.sin(2));
    expect(shadeOf(["s' = 1", 's(0) = 0', 'int[0..s] x dx'])).toBeDefined();
    // A no-default piecewise integrand: undefined past 1, so the fill breaks there.
    const f = shadeOf(['f(x) = {x < 1: x}', 'int[0..2] f(x) dx'])!;
    expect(evaluate(f.body, { x: 0.5 })).toBe(0.5);
    expect(evaluate(f.body, { x: 1.5 })).toBeNaN();
    // A Σ inside the integrand, and a user function that is itself a
    // quadrature, are still one integral of one real integrand.
    expect(evaluate(shadeOf(['int[0..1] sum[n=1..2] x^n dx'])!.body, { x: 2 })).toBe(6);
    const si = shadeOf(['F(x) = int[0..x] sin(s)/s ds', 'int[0..3] F(x) dx'])!;
    expect(evaluate(si.body, { x: 1 })).toBeCloseTo(0.946083, 5);
    // Reductions and point arithmetic are lowered exactly as in the row itself.
    expect(evaluate(shadeOf(['L = [1, 2, 3]', 'int[0..1] total(L) x dx'])!.body, { x: 2 })).toBe(12);
    const p = shadeOf(['A = (3, 4)', 'int[0..1] |A| x dx'])!;
    expect(evaluate(p.body, { x: 2, A_x: 3, A_y: 4 })).toBe(10);
  });

  it('anything more than one integral is a plain readout', () => {
    for (const texts of [
      ['2 int[0..1] x^2 dx'],
      ['int[0..1] x^2 dx + 1'],
      ['int[0..1] x dx + int[1..2] x dx'],
      ['int[0..1] int[0..y] x dx dy'],
      ['int[0..1] (int[0..x] t dt) dx'],
      ['2 + 2'],
    ]) {
      expect(analyze(texts).rows[0].cpu!).toMatchObject({ type: 'value' });
      expect(shadeOf(texts)).toBeUndefined();
    }
  });

  it('the dx variable shadows whatever else the document calls by that name', () => {
    // A slider: the readout is 0.5, and the picture is y = k over [0, 1].
    const k = shadeOf(['k = 3', 'int[0..1] k dk'])!;
    expect(analyze(['k = 3', 'int[0..1] k dk']).rows[1].info).toBe('= 0.5');
    expect(evaluate(k.body, { k: 0.25 })).toBe(0.25);
    // A list or a point: lowering must not substitute it for the bound name…
    for (const def of ['L = [1, 2, 3]', 'L = (1, 2)']) {
      const rows = [def, 'int[0..1] L^2 dL'];
      expect(analyze(rows).rows[1].info).toBe('≈ 0.333333');
      expect(shadeOf(rows)!.body).toEqual(shadeOf(['int[0..1] L^2 dL'])!.body);
      expect(evaluate(shadeOf(rows)!.body, { L: 3 })).toBe(9);
    }
    // …while in the BOUNDS the name keeps its document meaning.
    const b = shadeOf(['k = 3', 'int[0..k] k dk'])!;
    expect(evaluate(b.hi, { k: 3 })).toBe(3);
    expect(analyze(['k = 3', 'int[0..k] k dk']).rows[1].info).toBe('= 4.5');
    // And a list elsewhere in the integrand still lowers as usual.
    expect(evaluate(shadeOf(['L = [1, 2, 3]', 'int[0..1] total(L) k dk'])!.body, { k: 2 })).toBe(12);
  });

  it('rows that are not a number never shade', () => {
    const types = (texts: string[]) => analyze(texts).rows.map(r => r.error ?? r.cpu?.type ?? 'def');
    // A definition names the number (nothing draws); non-constant bounds are a
    // curve; a complex integrand a point; a list integrand a list.
    expect(types(['a = int[0..1] x^2 dx'])).toEqual(['def']);
    expect(types(['int[0..x] t^2 dt'])).toEqual(['implicit2d']);
    expect(types(['int[0..1] i x dx'])).toEqual(['point']);
    expect(types(['L = [1, 2]', 'int[0..1] L x dx'])).toEqual(['def', 'vlist']);
  });
});

describe('the continuous distribution zoo through analyze()', () => {
  it('every family is a drawn density with an exact, shaded P(…)', () => {
    const rows = out([
      'X ~ Gamma(2, 1)',
      'P(X < 1)',
      'B ~ Beta(2, 3)',
      'P(B > 0.4)',
      'C ~ ChiSquared(3)',
      'P(1 < C < 4)',
      'S ~ T(5)',
      'P(-1 < S < 1)',
      'L ~ LogNormal(0, 0.5)',
      'P(L > 2)',
      'K ~ Cauchy',
      'P(K > 3)',
      'W ~ Weibull(0.7, 2)',
      'P(W > 2)',
    ]);
    expect(rows).toEqual([
      ['implicit2d', undefined],
      ['ineq2d', '≈ 0.2642'],
      ['implicit2d', undefined],
      ['ineq2d', '≈ 0.4752'],
      ['implicit2d', undefined],
      ['ineq2d', '≈ 0.5398'],
      ['implicit2d', undefined],
      ['ineq2d', '≈ 0.6368'],
      ['implicit2d', undefined],
      ['ineq2d', '≈ 0.0828'],
      ['implicit2d', undefined],
      ['ineq2d', '≈ 0.1024'],
      ['implicit2d', undefined],
      ['ineq2d', '≈ 0.3679'],
    ]);
  });

  it('draws closed laws exactly: Gamma sums, the scaled Gamma, the square of a standard normal', () => {
    const a = analyze([
      'X ~ Gamma(2, 3)',
      'Y ~ Gamma(1.5, 3)',
      'S = X + Y',
      'D = X + X',
      'V = X + 1',
      'Z ~ N',
      'Q = Z^2',
      'P(Z^2 < 3.8414588)',
      'P(X + Y < 1)',
      'E(S)',
      'E(Q)',
    ]);
    expect(a.rows.map(r => r.error)).toEqual(Array(11).fill(undefined));
    const types = a.rows.map(r => r.cpu!.type);
    // S, D and Q go to the shader as pdfs; the shifted V has no closed family.
    expect(types.slice(2, 5)).toEqual(['implicit2d', 'implicit2d', 'density']);
    expect(types[6]).toBe('implicit2d');
    expect(a.rows[2].gpu?.type === 'implicit2d' && a.rows[2].gpu.field).toContain('eq_gammapdf(');
    expect(a.rows[7].info).toBe('≈ 0.9500');
    expect(a.rows[8].info).toBe('≈ 0.4603'); // Gamma(3.5, 3) at 1
    expect(a.rows[9].info).toBe('≈ 1.1667');
    expect(a.rows[10].info).toBe('≈ 1.0000');
  });

  it('declines a mean that does not exist instead of printing the sample mean', () => {
    const rows = out([
      'X ~ Cauchy',
      'E(X)',
      'E(X^2)',
      'E(atan(X))',
      'T2 ~ StudentT(2)',
      'E(T2 + 1)',
      'T1 ~ T(1)',
      'E(3 T1)',
      'T3 ~ T(3)',
      'E(T3^2)',
      'N1 ~ N',
      'E(T2^2 + N1)',
      'E(2X + 1)',
    ]);
    expect(rows[1]).toEqual(['expect', 'no stable mean (heavy tails)']);
    expect(rows[2]).toEqual(['expect', 'no stable mean (heavy tails)']);
    expect(rows[3]).toEqual(['expect', '≈ 0.0000']); // bounded transform: a real mean
    expect(rows[5]).toEqual(['expect', '≈ 1.0000']); // σ = ∞ but the mean exists: quadrature keeps it
    expect(rows[7]).toEqual(['expect', 'no stable mean (heavy tails)']);
    expect(rows[9]).toEqual(['expect', '≈ 3.0000']); // E(X²) = 3 although Var(X²) = ∞
    expect(rows[11]).toEqual(['expect', 'no stable mean (heavy tails)']); // E(T2²) = ∞
    expect(rows[12]).toEqual(['expect', 'no stable mean (heavy tails)']); // the exact Cauchy(1, 2)
  });

  it('reports bad parameters on the row: written out, or a constant at its value', () => {
    const rows = out([
      'X ~ Gamma(-1, 1)',
      'a = -2',
      'Y ~ Beta(2, a)',
      'W ~ Weibull(a + 3, 1)',
      'N1 ~ Normal(0, a)',
      's = sin(t)',
      'M ~ Normal(0, s)',
      'G ~ Gamma',
      'F ~ Fisher(2, 3)',
    ]);
    expect(rows[0][0]).toBe('Gamma(shape, rate) needs shape > 0.');
    expect(rows[2][0]).toBe('Beta(a, b) needs b > 0.');
    expect(rows[3][0]).toBe('implicit2d');
    expect(rows[4][0]).toBe('Normal(mean, sd) needs sd > 0.');
    expect(rows[6][0]).toBe('implicit2d'); // sd = sin(t) is 0 only at this instant
    expect(rows[7][0]).toBe('Gamma(shape, rate) takes 2 arguments.');
    expect(rows[8][0]).toMatch(/^Unknown distribution: Fisher\. Try Normal/);
  });

  it('keeps distribution names out of the document namespace', () => {
    // T, gamma and beta are everyday names; the right side of ~ is its own namespace.
    const rows = out(['T = 3', 'gamma(q) = q^2', 'beta = 0.5', 'X ~ T(T)', 'Y ~ Gamma(gamma(2), beta)', 'P(Y < 2)']);
    expect(rows.map(r => r[0])).toEqual(['def', 'def', 'def', 'implicit2d', 'implicit2d', 'ineq2d']);
    expect(rows[5][1]).toBe('≈ 0.0190'); // Gamma(4, 0.5) at 2
  });

  it('compiles the pdf builtins for the og VM', () => {
    const cpu = analyze(['X ~ Beta(80, 120)']).rows[0].cpu!;
    if (cpu.type !== 'implicit2d') throw new Error('Expected density curve');
    const row = cpu.equation;
    if (row.kind !== 'eq') throw new Error('a density row is y = pdf(x)');
    const prog = compileProg(
      { kind: 'bin', op: '-', a: row.l, b: row.r },
      new Map([
        ['x', 0],
        ['y', 1],
      ]),
    );
    // y − pdf(x) at the mode x = 79/198, where the pdf is 11.5061.
    expect(runProg(prog, [79 / 198, 11.5], new Float64Array(prog.depth))).toBeCloseTo(11.5 - 11.506129392, 6);
  });
});

describe('discrete distributions through analyze()', () => {
  it('every family is a pmf row with an exact P(…) that keeps its strictness', () => {
    const rows = out([
      'X ~ Binomial(10, 0.3)',
      'P(X < 3)',
      'P(X <= 3)',
      'P(X = 3)',
      'P(X != 3)',
      'P(2 < X <= 5)',
      'P(X < 2.5)',
      'E(X)',
      'K ~ Pois(3)',
      'P(K >= 2)',
      'G ~ Geometric(0.2)',
      'P(G = 1)',
      'W ~ NegBin(3, 0.4)',
      'P(W = 0)',
      'E(W)',
      'B ~ Bernoulli(0.3)',
      'P(B > 0)',
      'D ~ DiscreteUniform(1, 6)',
      'P(1 < D < 6)',
      'E(D)',
    ]);
    expect(rows).toEqual([
      ['pmf', undefined],
      ['prob', '≈ 0.3828'],
      ['prob', '≈ 0.6496'],
      ['prob', '≈ 0.2668'],
      ['prob', '≈ 0.7332'],
      ['prob', '≈ 0.5699'],
      ['prob', '≈ 0.3828'],
      ['expect', '≈ 3.0000'],
      ['pmf', undefined],
      ['prob', '≈ 0.8009'],
      ['pmf', undefined],
      ['prob', '≈ 0.2000'],
      ['pmf', undefined],
      ['prob', '≈ 0.0640'],
      ['expect', '≈ 4.5000'],
      ['pmf', undefined],
      ['prob', '≈ 0.3000'],
      ['pmf', undefined],
      ['prob', '≈ 0.6667'],
      ['expect', '≈ 3.5000'],
    ]);
    const a = analyze(['X ~ Binomial(10, 0.3)', 'P(2 < X <= 5)']);
    expect(a.rows[0].dist).toBe('pmf');
    expect(a.rows[1].cpu!).toMatchObject({ type: 'prob', shade: { rv: 'X', loStrict: true, hiStrict: false } });
  });

  it('follows constants, and reports bad parameters on the row at their values', () => {
    const rows = out([
      'n = 20',
      'p = 0.3',
      'X ~ Binomial(n, p)',
      'P(X <= 4)',
      'h = 2.5',
      'Y ~ Binomial(h, p)',
      'q = 1.5',
      'Z ~ Bernoulli(q)',
      'W ~ Poisson(0)',
      's = 3 + sin(t)',
      'V ~ Binomial(s, 0.5)',
      'P(V < 2)',
      'U ~ Binomial(10)',
      'A ~ DiscreteUniform(4, 1)',
    ]);
    expect(rows[2]).toEqual(['pmf', undefined]);
    expect(rows[3]).toEqual(['prob', '≈ 0.2375']);
    expect(rows[5][0]).toBe('Binomial(n, p) needs a whole number n ≥ 0 (n = 2.5).');
    expect(rows[7][0]).toBe('Bernoulli(p) needs 0 ≤ p ≤ 1.');
    expect(rows[8][0]).toBe('Poisson(mean) needs mean > 0.');
    expect(rows[10][0]).toBe('pmf'); // n = 3 + sin(t): not judged while it moves
    expect(analyze(['s = 3 + sin(t)', 'V ~ Binomial(s, 0.5)']).rows[1].cls!.params).toEqual(['s']); // redrawn as s moves
    expect(analyze(['V ~ Binomial(3, 0.5 + sin(t)/4)']).rows[0].cls!.animated).toBe(true);
    expect(rows[12][0]).toBe('Binomial(n, p) takes 2 arguments.');
    expect(rows[13][0]).toBe('DiscreteUniform(a, b) needs a ≤ b.');
  });

  it('derived discrete rows are pmf rows with exact readouts; mixtures are densities', () => {
    const rows = out([
      'X ~ DiscreteUniform(1, 6)',
      'Y ~ DiscreteUniform(1, 6)',
      'Z ~ Normal(0, 1)',
      'S = X + Y',
      'Q = X^2',
      'H = X / 2',
      'M = X + Z',
      'P(X > Y)',
      'P(X >= Y)',
      'P(X = Y)',
      'P(S <= 5)',
      'P(S < 5)',
      'P(X + Y = 7)',
      'E(X Y)',
      'E(X + Z)',
      'X - X',
      'X Z',
      'P(X > Z)',
      'P(H = 1.5)',
      'I = 1 / (X - 3)',
    ]);
    expect(rows.slice(3, 7)).toEqual([
      ['pmf', 'μ = 7, σ = 2.41523'],
      ['pmf', 'μ = 15.1667, σ = 12.2122'],
      ['pmf', 'μ = 1.75, σ = 0.853913'],
      ['density', undefined],
    ]);
    expect(rows.slice(7, 13).map(r => r[1])).toEqual([
      '≈ 0.4167',
      '≈ 0.5833',
      '≈ 0.1667',
      '≈ 0.2778',
      '≈ 0.1667',
      '≈ 0.1667',
    ]);
    expect(rows[13]).toEqual(['expect', '≈ 12.2500']);
    expect(rows[14]).toEqual(['expect', '≈ 3.500']); // a mixture: the sampled-density tier, three places
    expect(rows[15]).toEqual(['pmf', 'μ = 0, σ = 0']);
    expect(rows[16][0]).toBe('density');
    expect(rows[17][0]).toBe('prob');
    expect(rows[17][1]).toMatch(/^≈ 0\.9[67]\d$/); // mean of Φ(k): 0.9695 — sampled, three places
    expect(rows[18]).toEqual(['prob', '≈ 0.1667']);
    expect(rows[19]).toEqual(['pmf', 'μ = 0.0666667, σ = 0.719568, P(defined) ≈ 0.833']);
    const a = analyze([
      'X ~ DiscreteUniform(1, 6)',
      'Y ~ DiscreteUniform(1, 6)',
      'S = X + Y',
      'P(3 < S <= 5)',
      'X + Y',
    ]);
    expect(a.rows[2].dist).toBe('pmf');
    expect(a.rows[2].cpu!).toEqual({ type: 'pmf', rv: 'S' });
    expect(a.rows[3].cpu!).toMatchObject({ type: 'prob', shade: { rv: 'S', loStrict: true, hiStrict: false } });
    expect(a.rows[4].dist).toBe('pmf');
  });

  it('closure, the sampled fallback, and what is still refused — by the names the user wrote', () => {
    const rows = out([
      'A ~ Poisson(1000000)',
      'B ~ Poisson(1000000)',
      'S = A + B',
      'P(S > 2000000)',
      'C ~ Poisson(30)',
      'W = A B C',
      'Z ~ Normal(0, 1)',
      'P(A + Z = 3)',
      'P(A = Z)',
      'P(Z = 1)',
      'P(Z < 1)',
      'P((A, B) = 3)',
    ]);
    expect(rows[2]).toEqual(['pmf', 'μ = 2000000, σ = 1414.21']);
    expect(rows[3]).toEqual(['prob', '≈ 0.4998']);
    expect(rows[5][0]).toBe('pmf');
    expect(rows[5][1]).toMatch(/^μ ≈ 3\d{13}\.\d{3}, σ ≈ .* \(sampled\)$/);
    expect(rows[7][0]).toBe(
      'P(… = …) needs discrete variables, and Z is not: a continuous value equals any given one with probability 0. Ask about an interval, like P(a < … < b).',
    );
    expect(rows[8][0]).toMatch(/^P\(… = …\) needs discrete variables, and Z is not/);
    expect(rows[9][0]).toMatch(/^P\(Z = …\) needs a discrete variable/);
    expect(rows[10]).toEqual(['ineq2d', '≈ 0.8413']); // the continuous path is untouched
    expect(rows[11][0]).toBe('P(… = …) compares single values, like P(X = 3) or P(X = Y).');
    // No internal name reaches a message.
    for (const r of rows) expect(String(r[0])).not.toMatch(/\[|pmf\]|@/);
  });

  it('keeps the names out of the document namespace, and regressions over declared data alone', () => {
    const rows = out([
      'Poisson = 3',
      'binom(q) = q^2',
      'Geom = 0.5',
      'X ~ Poisson(Poisson)',
      'Y ~ Binom(binom(2), Geom)',
      'P(Y = 2)',
    ]);
    expect(rows.map(r => r[0])).toEqual(['def', 'def', 'def', 'pmf', 'pmf', 'prob']);
    expect(rows[5][1]).toBe('≈ 0.3750');
    // A declared list on the left does not turn a law's name into a model…
    expect(out(['L = [1, 2, 3]', 'L ~ Poisson(3)'])[1][0]).toBe('L is already defined.');
    // …and an ordinary fit whose coefficients happen to be p and n is still a fit.
    const fit = analyze(['X1 = [1, 2, 3, 4]', 'Y1 = [2.1, 3.9, 6.2, 7.8]', 'Y1 ~ p X1 + n']);
    expect(fit.rows[2].error).toBeUndefined();
  });

  it('a bound that is a whole number up to rounding reads as that whole number', () => {
    const rows = out([
      'a = 0.1*3*10',
      'X ~ Binomial(10, 0.3)',
      'P(X < a)',
      'P(X <= a)',
      'P(X = a)',
      'P(X != a)',
      'U ~ DiscreteUniform(-10^17, 10^17)',
      'P(0 <= U <= 2)',
    ]);
    expect(rows.slice(2, 6).map(r => r[1])).toEqual(['≈ 0.3828', '≈ 0.6496', '≈ 0.2668', '≈ 0.7332']);
    expect(rows[7]).toEqual(['prob', '≈ 0.0000']); // 1.5e-17, not the 0 of two differenced cdfs (lib test has the digits)
  });

  it('labels a discrete declaration from its family even when its parameter is bad', () => {
    const a = analyze(['m = 3', 'W ~ Poisson(m - 3)', 'G ~ Gamma(m - 3, 1)']);
    expect(a.rows[1].error).toBe('Poisson(mean) needs mean > 0.');
    expect(a.rows[1].dist).toBe('pmf');
    expect(a.rows[2].dist).toBe('density');
  });
});

describe('complex paths through analyze()', () => {
  const last = (texts: string[]) => analyze(texts).rows[texts.length - 1];

  it('inlines a user function before splitting: f(path) is the image of the path', () => {
    const row = last(['f(w) = w^2 + w', 'f(exp(i 2 pi u))']);
    expect(row.error).toBeUndefined();
    expect(row.cpu!).toMatchObject({ type: 'pcurve', dim: 2 });
    const { comps } = row.cpu! as { comps: Expr[] };
    // u = 1/4: w = i, f(i) = -1 + i.
    expect(evaluate(comps[0], { u: 0.25 })).toBeCloseTo(-1);
    expect(evaluate(comps[1], { u: 0.25 })).toBeCloseTo(1);
    expect(last(['g(s) = exp(i s)', 'g(u)']).cpu!.type).toBe('pcurve');
  });

  it('takes sliders as parameters of the path', () => {
    const row = last(['a = 2', 'a exp(i 2 pi u)']);
    expect(row.cls).toMatchObject({ params: ['a'], object: { kind: 'curve', form: 'parametric' } });
  });

  it('refuses a huge composition without first splitting it', () => {
    const nest = (n: number, inner: string) => {
      let s = inner;
      for (let k = 0; k < n; k++) s = `f(${s})`;
      return s;
    };
    // The shared pipeline (inlining, lowering) is what a non-path row of the
    // same size costs; the path may not add a split of the whole tree on top.
    const time = (row: string) => {
      const t0 = performance.now();
      const r = last(['f(w) = w*w + w', row]);
      return { ms: performance.now() - t0, error: r.error };
    };
    const field = time(nest(12, 'w'));
    expect(field.error).toBeUndefined();
    const path = time(nest(12, 'exp(i 2 pi u)'));
    expect(path.error).toMatch(/too large to sample/);
    expect(path.ms).toBeLessThan(3 * field.ms + 250);
  }, 60000);

  it('protects the other users of the split the same way: root systems and Argand points', () => {
    const nest = (n: number, inner: string) => {
      let s = inner;
      for (let k = 0; k < n; k++) s = `f(${s})`;
      return s;
    };
    expect(last(['f(w) = w*w + w', `${nest(2, 'w')} = 1`]).cpu!.type).toBe('system');
    expect(last(['f(w) = w*w + w', `${nest(10, 'w')} = 1`]).error).toBe(
      'This complex equation is too large to solve once split into real and imaginary parts — reduce the nesting or the powers.',
    );
    expect(last(['f(w) = w*w + w', nest(2, 'i')]).cpu!.type).toBe('point');
    expect(last(['f(w) = w*w + w', nest(10, 'i')]).error).toMatch(/^This complex point is too large to evaluate/);
  }, 60000);

  it('refuses a composition whose split is too large, rather than stalling every frame', () => {
    expect(last(['f(w) = w^2 + w', 'f(f(f(exp(i 2 pi u))))']).error).toBeUndefined();
    expect(last(['f(w) = w^2 + w', 'f(f(f(f(f(exp(i 2 pi u))))))']).error).toMatch(/too large to sample/);
  });
});

describe('revolve(f) through analyze()', () => {
  const plot = (texts: string[], at = texts.length - 1) => {
    const row = analyze(texts).rows[at];
    expect(row.error).toBeUndefined();
    return row.gpu!;
  };

  it('is exactly the hand-written implicit surface: same field, same gradient, so the same shader', () => {
    expect(plot(['revolve(sqrt(x))'])).toEqual(plot(['y^2 + z^2 = sqrt(x)^2']));
    expect(plot(['revolve(sin(x) + 2)'])).toEqual(plot(['y^2 + z^2 = (sin(x) + 2)^2']));
    expect(plot(['revolve(y^2, y)'])).toEqual(plot(['x^2 + z^2 = (y^2)^2']));
    expect(plot(['revolve(1 + z/2, z)'])).toEqual(plot(['x^2 + y^2 = (1 + z/2)^2']));
    expect(plot(['revolve(2)'])).toEqual(plot(['y^2 + z^2 = 2^2'])); // no axis variable: a cylinder
    const a = analyze(['revolve(sqrt(x))']).rows[0];
    expect(a.cls).toMatchObject({ object: { kind: 'surface', form: 'implicit' }, needs3D: true, animated: false });
    expect((a.gpu! as { grad?: unknown }).grad).toBeDefined();
  });

  it('takes the profile as an expression, a call, or a function by name', () => {
    const want = plot(['y^2 + z^2 = (x^3 - x)^2']);
    expect(plot(['f(x) = x^3 - x', 'revolve(f)'])).toEqual(want);
    expect(plot(['f(x) = x^3 - x', 'revolve(f(x))'])).toEqual(want);
    expect(plot(['f(q) = q^3 - q', 'revolve(f)'])).toEqual(want); // whatever the parameter is called
    expect(plot(['f(x) = x^3 - x', 'revolve(f, y)'])).toEqual(plot(['x^2 + z^2 = (y^3 - y)^2']));
    expect(plot(['f(x) = x^3 - x', 'revolve(f(y), y)'])).toEqual(plot(['x^2 + z^2 = (y^3 - y)^2']));
  });

  it('keeps sliders as uniforms and t as animation', () => {
    const row = analyze(['a = 1', 'revolve(a sin(x) + 2 + sin(t))']).rows[1];
    expect(row.cls).toMatchObject({ object: { kind: 'surface', form: 'implicit' }, params: ['a'], animated: true });
    expect((row.gpu! as { field: string }).field).toContain('u_a');
  });

  it('a no-default piecewise profile bounds the solid: the field is NaN outside it', () => {
    const row = analyze(['revolve({0 < x < 2: sqrt(x)})']).rows[0];
    expect(row.error).toBeUndefined();
    expect((row.gpu! as { field: string }).field).toContain('EQ_NAN');
    // The row's expression is the surface itself, so the CPU agrees.
    if (row.cpu?.type !== 'implicit3d') throw new Error('Expected surface');
    const e = row.cpu.equation;
    if (e.kind !== 'eq') throw new Error('Expected equation');
    expect(e.kind).toBe('eq');
    const residual = (x: number) => evaluate({ kind: 'bin', op: '-', a: e.l, b: e.r }, { x, y: 1, z: 0 });
    expect(residual(1)).toBeCloseTo(0);
    expect(residual(-1)).toBeNaN();
    expect(residual(3)).toBeNaN();
  });

  it('stays shadowable by a document that already uses the name', () => {
    expect(out(['revolve = 3', 'revolve(x)'])[1][0]).toBe('implicit2d'); // the product 3x
    expect(out(['revolve = 3', '2 revolve'])[1]).toEqual(['value', '= 6']);
    const fn = analyze(['revolve(x) = 2x', 'y = revolve(x) + 1', 'revolve(4)']);
    expect(fn.rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    expect(fn.rows[1].cpu!.type).toBe('implicit2d');
    expect(fn.rows[2].info).toBe('= 8');
  });

  it('refuses what it cannot revolve, truthfully', () => {
    const err = (texts: string[]) => analyze(texts).rows[texts.length - 1].error;
    expect(err(['revolve(x + y)'])).toBe('revolve(f) takes an expression in x only.');
    expect(err(['revolve(x z)'])).toBe('revolve(f) takes an expression in x only.');
    expect(err(['revolve(u)'])).toBe('revolve(f) takes an expression in x only.');
    expect(err(['revolve(x, y)'])).toBe('revolve(f, y) takes an expression in y only.');
    expect(err(['h(a) = a + y', 'revolve(h)'])).toBe('revolve(f) takes an expression in x only.');
    expect(err(['revolve(x, 2)'])).toBe('The revolve axis must be x, y, or z: revolve(y^2, y).');
    expect(err(['a = 1', 'revolve(x, a)'])).toBe('The revolve axis must be x, y, or z: revolve(y^2, y).');
    expect(err(['revolve(x, w)'])).toBe('The revolve axis must be x, y, or z: revolve(y^2, y).');
    expect(err(['revolve(x, y, z)'])).toMatch(/^revolve takes a profile and an optional axis/);
    expect(err(['revolve(i x)'])).toMatch(/complex values cannot be revolved/);
    expect(err(['revolve(w)'])).toMatch(/complex values cannot be revolved/);
    expect(analyze(['revolve([1, 2])']).rows[0].cpu?.type).toBe('family');
    expect(analyze(['L = [1, 2]', 'revolve(L x)']).rows[1].cpu?.type).toBe('family');
    expect(analyze(['L = [1, 2]', 'revolve(L)']).rows[1].cpu?.type).toBe('family');
    expect(err(['revolve(x = 1)'])).toMatch(/single real expression in x/);
    expect(err(['revolve(x < 1, y)'])).toMatch(/single real expression in y/);
    expect(err(['A = (1, 2)', 'revolve(A)'])).toBe('revolve is not defined for points.');
    expect(err(['g(x, y) = x y', 'revolve(g)'])).toBe('revolve(g) needs a function of one variable; g takes 2.');
    expect(err(['revolve(q)'])).toMatch(/^Unknown variable: q/);
  });

  it('must be the whole row', () => {
    const err = (texts: string[]) => analyze(texts).rows[texts.length - 1].error;
    for (const t of [
      '2 revolve(x)',
      'y = revolve(x)',
      'revolve(revolve(x))',
      'revolve(x) + 1',
      '(revolve(x), 1)',
      'revolve(iter(z^2 + x))',
    ]) {
      expect(err([t]), t).toMatch(/\(…\) must be the whole expression\.$/);
    }
    expect(err(['s = revolve(x)'])).toBe('revolve(…) must be a whole row, not part of a definition.');
    expect(err(['s(x) = 2 revolve(x)'])).toBe('revolve(…) must be a whole row, not part of a definition.');
  });

  it('never reads a user name through a prototype', () => {
    const err = (texts: string[]) => analyze(texts).rows[texts.length - 1].error;
    expect(err(['revolve(constructor)'])).toMatch(/^Unknown variable: constructor/);
    expect(err(['revolve(x, toString)'])).toBe('The revolve axis must be x, y, or z: revolve(y^2, y).');
  });

  it('checks the profile after coordinate fields expand, at one stage for every entry point', () => {
    const err = (texts: string[]) => analyze(texts).rows[texts.length - 1].error;
    const polar = ['r = sqrt(x^2 + y^2)'];
    expect(err([...polar, 'revolve(r)'])).toBe('revolve(f) takes an expression in x only.');
    expect(err([...polar, 'revolve(x r)'])).toBe('revolve(f) takes an expression in x only.');
    expect(err([...polar, 'revolve(r, z)'])).toBe('revolve(f, z) takes an expression in z only.');
    // A field of the axis variable alone is an honest profile.
    expect(plot(['s = x^2 + 1', 'revolve(s)'])).toEqual(plot(['y^2 + z^2 = (x^2 + 1)^2']));
  });

  it('names a function used without parentheses inside the profile', () => {
    const err = (texts: string[]) => analyze(texts).rows[texts.length - 1].error;
    for (const t of ['revolve(-f)', 'revolve(2f)', 'revolve(f + 1, y)', 'revolve(sqrt(f))']) {
      expect(err(['f(x) = x', t]), t).toBe('f is a function — write it with parentheses, e.g. f(x).');
    }
    expect(err(['f(x) = x', 'revolve(2f(x))'])).toBeUndefined();
  });

  it('blames the axis, not the profile, for a bad axis of any kind', () => {
    const err = (texts: string[]) => analyze(texts).rows[texts.length - 1].error;
    const AXIS = 'The revolve axis must be x, y, or z: revolve(y^2, y).';
    expect(err(['L = [1, 2]', 'revolve(x, L)'])).toBe(AXIS);
    expect(err(['revolve(x, [1, 2])'])).toBe(AXIS);
    expect(err(['f(x) = x', 'revolve(f, 2)'])).toBe(AXIS);
    expect(err(['f(x) = x', 'L = [1, 2]', 'revolve(f, L)'])).toBe(AXIS);
    expect(err(['g(x, y) = x y', 'revolve(g, 2)'])).toBe(AXIS);
  });

  it('emits a big profile once in the field, as the hand-written square does', () => {
    const big = 'sum[n=1..40] sin(n x)/n';
    const field = (plot([`revolve(${big})`]) as { field: string }).field;
    expect(plot([`revolve(${big})`])).toEqual(plot([`y^2 + z^2 = (${big})^2`]));
    expect(field.match(/sin\(\(40\.0 \* x\)\)/g)).toHaveLength(1);
  });
});

describe('whole-row forms over a random variable', () => {
  it('are refused by name instead of becoming a derived density', () => {
    const forms = [
      'revolve(X)',
      'tube(X, X, X)',
      'tube((X, 1, 2))',
      'domain(X)',
      'conformal(X)',
      'iter(X)',
      'trail((X, 1))',
      'segment((0, 0), (X, 1))',
      'polyline((0, 0), (X, 1), (2, 2))',
      'vector((X, 1))',
      'line((0, 0), (X, 1))',
      'polygon((0, 0), (X, 1), (2, 0))',
      'square((0, 0), (X, 1))',
      'circle((0, 0), X)',
    ];
    for (const t of forms) {
      const name = t.slice(0, t.indexOf('('));
      const row = analyze(['X ~ Normal(0, 1)', t]).rows[1];
      expect(row.error, t).toBe(`${name}(…) cannot take a random variable.`);
      expect(row.cls, t).toBeUndefined();
    }
    // Nested too, and inside P and E.
    expect(analyze(['X ~ Normal(0, 1)', '2 revolve(X)']).rows[1].error).toBe(
      'revolve(…) cannot take a random variable.',
    );
    expect(analyze(['X ~ Normal(0, 1)', 'E(domain(X))']).rows[1].error).toBe(
      'domain(…) cannot take a random variable.',
    );
    // Ordinary derived variables are untouched.
    expect(analyze(['X ~ Normal(0, 1)', 'X^2 + 1']).rows[1].cpu?.type).toBe('density');
  });
});

describe('coordinate fields over z through analyze()', () => {
  const types = (rows: string[]) => analyze(rows).rows.map(r => r.error ?? r.cpu?.type ?? 'def');
  const polar = ['r = sqrt(x^2+y^2)', 'theta = atan2(y,x)'];

  it('leaves every planar chart row what it was', () => {
    expect(
      types([
        ...polar,
        'r = 1 + cos(theta)',
        '(r, theta) = (2, pi/4)',
        '(r, theta) = (3u, 6 pi u)',
        "(r', theta') = (r(1-r), 1)",
        'theta = pi',
        'theta = 3 + 2 pi',
      ]),
    ).toEqual(['def', 'def', 'implicit2d', 'system', 'system', 'vfield2d', 'implicit2d', 'implicit2d']);
    const point = analyze([...polar, '(r, theta) = (2, pi/4)']).rows.at(-1)!.cpu!;
    expect(point.type === 'system' && point.dim === 2 && point.coordinates?.length === 2).toBe(true);
    // A planar field in a z equation was a surface before fields could use z.
    expect(types(['s = sqrt(x^2+y^2)', 's = 1 + z^2'])).toEqual(['def', 'implicit3d']);
  });

  it('mixes a planar chart with a spherical one built on it', () => {
    const rows = [
      ...polar,
      'rho = sqrt(r^2 + z^2)',
      'phi = atan2(r, z)',
      'rho = 2',
      'r = 1',
      '(rho, theta, phi) = (2, pi/4, pi/3)',
      '(r, theta, z) = (1, 6 pi u, u)',
    ];
    expect(types(rows)).toEqual(['def', 'def', 'def', 'def', 'implicit3d', 'implicit2d', 'system', 'system']);
    const a = analyze(rows);
    // The chart alone is planar; its rows in space are what make the scene 3D.
    expect(analyze(rows.slice(0, 4)).rows.some(r => r.cls?.needs3D)).toBe(false);
    expect(a.rows.map(r => !!r.cls?.needs3D)).toEqual([false, false, false, false, true, false, true, true]);
  });
});

describe('label(point, "text") rows', () => {
  const plan = (rows: string[]) => {
    const row = analyze(rows).rows.at(-1)!;
    return { error: row.error, cpu: row.cpu, needs3D: row.cls?.needs3D };
  };

  it('anchors text at a tuple, a named point, or a 3D point', () => {
    expect(plan(['label((1, 2), "peak")']).cpu).toMatchObject({ type: 'label', dim: 2, text: 'peak' });
    expect(plan(['A = (1, 1)', 'label(A, "vertex")']).cpu).toMatchObject({ type: 'label', text: 'vertex' });
    const top = plan(['label((1, 2, 3), "top")']);
    expect(top.cpu).toMatchObject({ type: 'label', dim: 3 });
    expect(top.needs3D).toBe(true);
  });

  it('follows sliders: the point is live math, the text is data', () => {
    const { cpu } = plan(['a = 2', 'label((a, a^2), "a;b # not a note")']);
    expect(cpu).toMatchObject({ type: 'label', text: 'a;b # not a note' });
    const coords = (cpu as { coords: Expr[] }).coords;
    expect(coords.map(c => evaluate(c, { a: 3 }))).toEqual([3, 9]);
  });

  it.each([
    ['label((x, 1), "bad")', 'real point'],
    ['label((1, 2))', 'quoted text'],
    ['label("peak", (1, 2))', 'quoted text'],
    ['y = label((1, 2), "n")', 'whole expression'],
    ['f = label((1, 2), "n")', 'whole row'],
  ])('refuses %s', (row, message) => {
    expect(plan([row]).error).toContain(message);
  });
});
