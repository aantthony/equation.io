import { describe, expect, it } from 'vitest';
import { evaluate } from '../lib/expr.ts';
import { boundValue } from '../lib/intshade.ts';
import { toGLSL } from '../lib/glsl.ts';
import { analyze } from './graph.ts';
import { compileProg, run as runProg } from '../lib/vm.ts';

/** [error ?? plot type, readout] per row. */
const out = (texts: string[]) => analyze(texts).rows.map(r => [r.error ?? r.cls?.plot.type ?? 'def', r.info]);

describe('distance / angle through analyze()', () => {
  it('take any single point, however it was computed', () => {
    const rows = out(['M = [(1, 2), (3, 4)]', 'L = [1, 2, 3]', 'A = (1, 2)', 'B = (5, 11)',
      'distance(M A, B)', 'distance(A, det(M) B)', 'distance(A, (mean(L), 2))',
      'distance(A, (total(L), count(L)))', 'distance(A, (L[1], 5))', 'angle(A, (0, 0), (total(L), -3))']);
    expect(rows.slice(4)).toEqual([
      ['value', '= 0'], ['value', '≈ 26.4008'], ['value', '= 1'], ['value', '≈ 5.09902'], ['value', '= 3'],
      ['value', '≈ -1.5708'],
    ]);
  });

  it('broadcast over a scalar list exactly as |A - B| does', () => {
    const rows = analyze(['L = [1, 2, 3]', 'A = (0, 0)', '|A - (L, 0)|', 'distance(A, (L, 0))',
      'f(k) = distance(A, (k, 0))', 'f(L)', 'angle((1, 0), A, (L, L))', 'total(angle((1, 0), (0, L)))']).rows;
    expect(rows.map(r => r.error)).toEqual(Array(8).fill(undefined));
    expect(rows[3].cls!.plot).toEqual(rows[2].cls!.plot);
    expect(rows[5].cls!.plot).toEqual(rows[2].cls!.plot);
    expect(rows[6].cls!.plot.type).toBe(rows[2].cls!.plot.type);
    expect(rows[7].info).toBe(`≈ ${Number((1.5 * Math.PI).toPrecision(6))}`);
  });

  it('say so when a list stands where a point should', () => {
    const rows = out(['P = [(0, 0), (1, 1)]', 'L = [1, 2, 3]', 'A = (1, 2)',
      'distance(P, A)', 'distance(A, L)', 'angle(A, [A, A], A)']);
    for (const [msg] of rows.slice(3)) expect(msg).toMatch(/a list cannot stand for a point yet/);
  });

  it('names the list whenever one is why the points do not pair up', () => {
    const rows = out(['P = [(0, 0), (1, 1), (2, 2)]', 'L = [1, 2, 3]', 'A = (1, 2)', 'B = (3, 1)',
      'distance(2L, A)', 'distance(-P, A)', 'distance(sort(L), A)', 'distance([1..3] + 1, A)',
      'angle(A, P[1], B)', 'distance(A, P[2])',
      'distance(A, total(L))', 'distance(P, L, A)', 'angle(P, L, A, B)']);
    for (const [msg] of rows.slice(4, 8)) expect(msg).toMatch(/a list cannot stand for a point yet/);
    // An element of a point list is a point on its own row, but not yet a
    // point *value* (P[2] + A fails the same way): that is plan #13's.
    for (const [msg] of rows.slice(8, 10)) expect(msg).toMatch(/an element of a list cannot stand for a point yet.*name it first|name the point/);
    // A reduction is one number, so no list is to blame here...
    expect(rows[10][0]).toMatch(/^distance takes two points/);
    // ...and a list of points that does pair up (as a "component") is refused
    // by list lowering, in its own true words.
    expect(rows[11][0]).toMatch(/list of points is not supported yet/);
    expect(rows[12][0]).toMatch(/list of points is not supported yet/);
  });

  it('never shows the internal [angle] name', () => {
    const rows = out(['B = (3, 1)', 'angle((i, 0), B)']);
    expect(rows[1][0]).toBe('angle is not supported for complex values.');
    const bad = { kind: 'call' as const, name: '[angle]', args: [{ kind: 'num' as const, value: 1 }] };
    expect(() => compileProg(bad, new Map())).toThrow(/^Cannot evaluate angle\(\) here\.$/);
  });

  it('tiny arms still have a direction; only a zero arm is undefined', () => {
    const rows = out(['k = 10^(-200)', 'angle((k, 0), (0, k))', 'angle((k, 0), (0, 0), (0, 1))', 'angle((0, 0), (0, k))']);
    expect(rows.slice(1)).toEqual([['value', '≈ 1.5708'], ['value', '≈ 1.5708'], ['value', 'undefined']]);
  });

  it('a straight angle is π on the CPU, in the og VM and in GLSL, with no foldable + 0', () => {
    const { rows, constEnv } = analyze(['A = (-1, 0)', 'B = (1, 0)', 'angle(A, (0, 0), B)', 'angle(B, (0, 0), A)', 'y = angle(A, (0, 0), B) x']);
    expect(rows[2].info).toBe('≈ 3.14159');
    expect(rows[3].info).toBe('≈ 3.14159');
    for (const r of [rows[2], rows[3]]) {
      const names = Object.keys(constEnv);
      const prog = compileProg(r.expr!, new Map(names.map((n, i) => [n, i])));
      expect(runProg(prog, names.map(n => constEnv[n]), new Float64Array(prog.depth))).toBe(Math.PI);
      expect(evaluate(r.expr!, constEnv)).toBe(Math.PI);
    }
    const glsl = toGLSL(rows[4].expr!);
    expect(glsl).not.toContain('+ 0.0');
    expect(glsl).toContain('eq_angle(');
  });
});

describe('definite-integral rows shade their area', () => {
  const shadeOf = (texts: string[], at = texts.length - 1) => {
    const row = analyze(texts).rows[at];
    expect(row.error).toBeUndefined();
    const plot = row.cls!.plot;
    return plot.type === 'value' ? plot.shade : undefined;
  };

  it('exactly one definite integral carries { body, v, lo, hi }; the row stays a readout', () => {
    for (const text of ['int[0..1] x^2 dx', 'int(0..1, x^2 dx)', '∫[0..1] x^2 dx']) {
      const row = analyze([text]).rows[0];
      expect([row.cls!.plot.type, row.info]).toEqual(['value', '≈ 0.333333']);
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
      expect(analyze(texts).rows[0].cls!.plot).toMatchObject({ type: 'value' });
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
    const types = (texts: string[]) => analyze(texts).rows.map(r => r.error ?? r.cls?.plot.type ?? 'def');
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
      'X ~ Gamma(2, 1)', 'P(X < 1)', 'B ~ Beta(2, 3)', 'P(B > 0.4)', 'C ~ ChiSquared(3)', 'P(1 < C < 4)',
      'S ~ T(5)', 'P(-1 < S < 1)', 'L ~ LogNormal(0, 0.5)', 'P(L > 2)', 'K ~ Cauchy', 'P(K > 3)',
      'W ~ Weibull(0.7, 2)', 'P(W > 2)',
    ]);
    expect(rows).toEqual([
      ['implicit2d', undefined], ['ineq2d', '≈ 0.2642'], ['implicit2d', undefined], ['ineq2d', '≈ 0.4752'],
      ['implicit2d', undefined], ['ineq2d', '≈ 0.5398'], ['implicit2d', undefined], ['ineq2d', '≈ 0.6368'],
      ['implicit2d', undefined], ['ineq2d', '≈ 0.0828'], ['implicit2d', undefined], ['ineq2d', '≈ 0.1024'],
      ['implicit2d', undefined], ['ineq2d', '≈ 0.3679'],
    ]);
  });

  it('draws closed laws exactly: Gamma sums, the scaled Gamma, the square of a standard normal', () => {
    const a = analyze(['X ~ Gamma(2, 3)', 'Y ~ Gamma(1.5, 3)', 'S = X + Y', 'D = X + X', 'V = X + 1',
      'Z ~ N', 'Q = Z^2', 'P(Z^2 < 3.8414588)', 'P(X + Y < 1)', 'E(S)', 'E(Q)']);
    expect(a.rows.map(r => r.error)).toEqual(Array(11).fill(undefined));
    const types = a.rows.map(r => r.cls!.plot.type);
    // S, D and Q go to the shader as pdfs; the shifted V has no closed family.
    expect(types.slice(2, 5)).toEqual(['implicit2d', 'implicit2d', 'density']);
    expect(types[6]).toBe('implicit2d');
    expect(toGLSL(a.rows[2].expr!)).toContain('eq_gammapdf(');
    expect(a.rows[7].info).toBe('≈ 0.9500');
    expect(a.rows[8].info).toBe('≈ 0.4603'); // Gamma(3.5, 3) at 1
    expect(a.rows[9].info).toBe('≈ 1.1667');
    expect(a.rows[10].info).toBe('≈ 1.0000');
  });

  it('declines a mean that does not exist instead of printing the sample mean', () => {
    const rows = out(['X ~ Cauchy', 'E(X)', 'E(X^2)', 'E(atan(X))', 'T2 ~ StudentT(2)', 'E(T2 + 1)', 'T1 ~ T(1)', 'E(3 T1)',
      'T3 ~ T(3)', 'E(T3^2)', 'N1 ~ N', 'E(T2^2 + N1)', 'E(2X + 1)']);
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
    const rows = out(['X ~ Gamma(-1, 1)', 'a = -2', 'Y ~ Beta(2, a)', 'W ~ Weibull(a + 3, 1)', 'N1 ~ Normal(0, a)',
      's = sin(t)', 'M ~ Normal(0, s)', 'G ~ Gamma', 'F ~ Fisher(2, 3)']);
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
    const row = analyze(['X ~ Beta(80, 120)']).rows[0].expr!;
    if (row.kind !== 'eq') throw new Error('a density row is y = pdf(x)');
    const prog = compileProg({ kind: 'bin', op: '-', a: row.l, b: row.r }, new Map([['x', 0], ['y', 1]]));
    // y − pdf(x) at the mode x = 79/198, where the pdf is 11.5061.
    expect(runProg(prog, [79 / 198, 11.5], new Float64Array(prog.depth))).toBeCloseTo(11.5 - 11.506129392, 6);
  });
});
