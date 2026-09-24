import { describe, expect, it } from 'vitest';
import { antiderivative, quadrature, quadratureSum, verifyDefinite } from './integrate.ts';
import { type Expr, evaluate, freeVars, parseExpr } from './expr.ts';
import { diff } from './diff.ts';
import { resolveExpr, usesIntegral } from './defs.ts';

/** Antiderivative of the parsed source, or null. */
const F = (src: string, v = 'x'): Expr | null => antiderivative(parseExpr(src), v);

/** Assert F′ = f numerically at a spread of points (the engine's own verifier
 *  already ran; this re-checks through an independent path). */
function checkDeriv(src: string, v = 'x', points = [-2.3, -0.7, 0.41, 1.13, 2.9], env: Record<string, number> = {}) {
  const f = parseExpr(src);
  const Fe = antiderivative(f, v);
  expect(Fe, `no antiderivative found for ${src}`).not.toBeNull();
  const dF = diff(Fe!, v);
  let compared = 0;
  for (const x of points) {
    let want: number;
    try {
      want = evaluate(f, { ...env, [v]: x });
    } catch {
      continue;
    }
    if (!isFinite(want)) continue;
    const got = evaluate(dF, { ...env, [v]: x });
    expect(got, `${src} at ${v} = ${x}`).toBeCloseTo(want, 5);
    compared++;
  }
  expect(compared).toBeGreaterThan(2);
}

describe('antiderivative: exact families', () => {
  it('polynomials', () => {
    checkDeriv('x^2');
    checkDeriv('3x^5 - 2x + 7');
    checkDeriv('(x^2 + 1)(x - 3)');
  });

  it('polynomials with slider coefficients stay symbolic', () => {
    const Fe = antiderivative(parseExpr('a x^2 + b'), 'x')!;
    expect(Fe).not.toBeNull();
    expect(freeVars(Fe)).toEqual(new Set(['a', 'b', 'x']));
    // d/dx (a x³/3 + b x) = a x² + b at a = 2, b = −1.
    expect(evaluate(diff(Fe, 'x'), { a: 2, b: -1, x: 1.7 })).toBeCloseTo(2 * 1.7 ** 2 - 1, 9);
  });

  it('rational functions: 1/x and friends', () => {
    checkDeriv('1/x');
    checkDeriv('1/x^2');
    checkDeriv('(3x + 2)/(x^2 + 1)');
    checkDeriv('1/(x^2 - 1)');
    checkDeriv('1/(x^2 + x + 1)');
    checkDeriv('x^3/(x^2 - 4)', 'x', [-1.3, 0.4, 1.1, 3.2]);
  });

  it('rational functions with repeated factors (Hermite/Ostrogradsky part)', () => {
    checkDeriv('1/(x - 2)^2', 'x', [-1, 0.5, 3.1, 4.7]);
    checkDeriv('1/(x^2 - 1)^2', 'x', [-0.5, 0.3, 2.2, 3.1]);
    checkDeriv('(x + 1)/(x^2 + 1)^2');
  });

  it('table forms with linear arguments', () => {
    checkDeriv('sin(x)');
    checkDeriv('cos(3x - 1)');
    checkDeriv('exp(2x)');
    checkDeriv('e^x');
    checkDeriv('tan(x)', 'x', [-0.6, 0.3, 0.9, 1.1]);
    checkDeriv('sqrt(2x + 5)', 'x', [0.2, 1.3, 2.9]);
    checkDeriv('ln(x)', 'x', [0.3, 1.2, 4.5]);
    checkDeriv('atan(x)');
    checkDeriv('asin(x)', 'x', [-0.8, -0.2, 0.4, 0.7]);
    checkDeriv('sinh(x) + cosh(2x)');
    checkDeriv('abs(x)');
    checkDeriv('erf(x)');
    checkDeriv('2^x');
    checkDeriv('normalpdf(x, 1, 2)');
  });

  it('linear-argument coefficients may be sliders', () => {
    const Fe = antiderivative(parseExpr('sin(a x + b)'), 'x')!;
    expect(Fe).not.toBeNull();
    const dF = diff(Fe, 'x');
    for (const x of [-1.1, 0.4, 2.3]) {
      expect(evaluate(dF, { a: 1.5, b: -0.7, x })).toBeCloseTo(Math.sin(1.5 * x - 0.7), 6);
    }
  });

  it('gaussians via erf', () => {
    checkDeriv('exp(-x^2)');
    checkDeriv('exp(-(x - 1)^2/2)');
    checkDeriv('exp(-3x^2 + 2x + 1)');
  });

  it('u-substitution', () => {
    checkDeriv('x exp(x^2)');
    checkDeriv('sin(x) cos(x)');
    checkDeriv('ln(x)/x', 'x', [0.4, 1.3, 3.7]);
    checkDeriv('x/(x^2 + 1)^3');
    checkDeriv('cos(x) exp(sin(x))');
    checkDeriv('x sqrt(x^2 + 1)');
  });

  it('integration by parts', () => {
    checkDeriv('x sin(x)');
    checkDeriv('x^2 exp(x)');
    checkDeriv('x ln(x)', 'x', [0.5, 1.4, 3.3]);
    checkDeriv('x exp(-x)');
    checkDeriv('x^3 cos(2x)');
    checkDeriv('x atan(x)');
  });

  it('exp × trig', () => {
    checkDeriv('exp(x) sin(x)');
    checkDeriv('exp(-x) cos(3x)');
  });

  it('trig powers and products', () => {
    checkDeriv('sin(x)^2');
    checkDeriv('cos(x)^2');
    checkDeriv('sin(x)^3');
    checkDeriv('sin(x)^2 cos(x)^2');
    checkDeriv('sin(x)^5 cos(x)^2');
    checkDeriv('sin(3x) cos(5x)');
    checkDeriv('sin(x) sin(2x)');
  });

  it('returns null (not nonsense) where no rule applies', () => {
    expect(F('exp(x^3)')).toBeNull();
    expect(F('sin(x)/x')).toBeNull();
    expect(F('exp(x)/x')).toBeNull();
    expect(F('x^x')).toBeNull();
  });
});

describe('quadrature', () => {
  const q = (src: string, lo: number, hi: number) => {
    const e = parseExpr(src);
    return quadrature(x => evaluate(e, { x }), lo, hi);
  };

  it('matches known integrals', () => {
    expect(q('x^2', 0, 1)).toBeCloseTo(1 / 3, 9);
    expect(q('sin(x)', 0, Math.PI)).toBeCloseTo(2, 9);
    expect(q('exp(-x^2)', -6, 6)).toBeCloseTo(Math.sqrt(Math.PI), 8);
    expect(q('1/x', 1, Math.E)).toBeCloseTo(1, 9);
    expect(q('sin(x)/x', 0, 10)).toBeCloseTo(1.658347594218874, 7); // Si(10)
  });

  it('is sign-aware for reversed bounds', () => {
    expect(q('x^2', 1, 0)).toBeCloseTo(-1 / 3, 9);
  });

  it('handles integrable endpoint singularities', () => {
    expect(q('1/sqrt(x)', 0, 1)).toBeCloseTo(2, 4);
  });

  it('reports NaN for divergent integrals instead of a confident number', () => {
    expect(q('1/x^2', -1, 1)).toBeNaN();
  });

  it('transforms infinite ranges', () => {
    expect(q('exp(-x^2)', -Infinity, Infinity)).toBeCloseTo(Math.sqrt(Math.PI), 7);
    expect(q('exp(-x)', 0, Infinity)).toBeCloseTo(1, 8);
    expect(q('1/x^2', 1, Infinity)).toBeCloseTo(1, 7);
    expect(q('exp(x)', -Infinity, 0)).toBeCloseTo(1, 8);
    expect(q('1/x^2', Infinity, 1)).toBeCloseTo(-1, 7); // reversed
  });
});

describe('verifyDefinite', () => {
  it('accepts a true closed form and rejects FTC across a pole', () => {
    const body = parseExpr('x^2');
    const good = parseExpr('1/3');
    expect(verifyDefinite(good, body, 'x', parseExpr('0'), parseExpr('1'))).toBe(true);
    // ∫₋₁¹ x⁻² is divergent; naive FTC gives −2.
    const pole = parseExpr('1/x^2');
    const naive = parseExpr('0 - 2');
    expect(verifyDefinite(naive, pole, 'x', parseExpr('0 - 1'), parseExpr('1'))).toBe(false);
  });
});

describe('∫ syntax through resolveExpr', () => {
  const r = (s: string, fns: ReadonlySet<string> = new Set()) => resolveExpr(parseExpr(s, fns), () => undefined);
  const val = (s: string, env: Record<string, number> = {}) => evaluate(r(s), env);

  it('integrates definite forms exactly', () => {
    expect(val('int[0..2] x^2 dx')).toBeCloseTo(8 / 3, 12);
    expect(val('int[1..e] 1/x dx')).toBeCloseTo(1, 9);
    expect(val('∫[0..pi] sin(x) dx')).toBeCloseTo(2, 12);
    expect(val('int[2..0] x^2 dx')).toBeCloseTo(-8 / 3, 12); // reversed bounds
    expect(val('int[0..1] dx')).toBe(1);
  });

  it('keeps slider parameters symbolic', () => {
    const e = r('int[0..a] x^2 dx');
    expect(freeVars(e)).toEqual(new Set(['a']));
    expect(evaluate(e, { a: 3 })).toBeCloseTo(9, 9);
  });

  it('stays symbolic when the bound variable is also the ambient plot variable', () => {
    // int[a..x] cos(x) dx: the dx binds the body's x, the bound's x is the
    // plot coordinate. The closed form sin(x) − sin(a) must survive
    // verification — at x = 150 a fixed-order quadrature fallback would be
    // wildly wrong (this is the visible regression: a bounded sine wave, not
    // hundred-unit spikes).
    const e = r('int[a..x] cos(x) dx');
    expect(freeVars(e)).toEqual(new Set(['a', 'x']));
    for (const x of [1.3, 42, 150, -180]) {
      expect(evaluate(e, { a: 0.5, x })).toBeCloseTo(Math.sin(x) - Math.sin(0.5), 8);
    }
  });

  it('produces functions from indefinite and variable-bound forms', () => {
    expect(val('int(x^2 dx)', { x: 3 })).toBeCloseTo(9, 12);
    expect(val('∫ cos(x) dx', { x: 1 })).toBeCloseTo(Math.sin(1), 12); // bare chain form
    expect(val('int[0..x] exp(-t^2) dt', { x: 1 })).toBeCloseTo(0.7468241328, 5);
  });

  it('falls back to a quadrature sum when no closed form is found', () => {
    // Si(x) is not elementary; the expansion is an ordinary expression in x.
    const si = r('int[0..x] sin(t)/t dt');
    expect(freeVars(si)).toEqual(new Set(['x']));
    expect(evaluate(si, { x: 10 })).toBeCloseTo(1.658347594218874, 5);
  });

  it('supports the classic notations', () => {
    expect(val('int[0..1] dx/(1+x^2)')).toBeCloseTo(Math.PI / 4, 9); // measure first
    expect(val('int[0..1] int[0..y] x dx dy')).toBeCloseTo(1 / 6, 9); // iterated, inside-out
    expect(val('int[0..1] int[0..y] x dx y dy')).toBeCloseTo(1 / 8, 9);
    expect(val('2 int[0..1] x dx + 1')).toBeCloseTo(2, 12); // coefficient stays outside
    expect(val('int[0..1] sum[n=1..3] x^n dx')).toBeCloseTo(1 / 2 + 1 / 3 + 1 / 4, 9);
    expect(val('int[0..2] (d/dt (t^2)) dt')).toBeCloseTo(4, 12); // d/dt consumes its own dt
  });

  it('supports ±inf bounds (symbolic limits, transformed quadrature fallback)', () => {
    // The limit of the antiderivative replaces the infinite end…
    expect(val('int[-inf..x] exp(t) dt', { x: 1.3 })).toBeCloseTo(Math.exp(1.3), 6);
    expect(val('int[0..inf] exp(-x) dx')).toBeCloseTo(1, 8);
    expect(val('int[1..inf] 1/x^2 dx')).toBeCloseTo(1, 6);
    expect(val('int[-inf..inf] exp(-x^2) dx')).toBeCloseTo(Math.sqrt(Math.PI), 6);
    expect(val('int[inf..1] 1/x^2 dx')).toBeCloseTo(-1, 6); // downhill range
    // …the ∞ glyph works, and the normal cdf falls out of its pdf…
    expect(val('∫[-∞..x] normalpdf(t, 0, 1) dt', { x: 0.7 })).toBeCloseTo(0.7580363, 5);
    // …and a non-elementary tail still evaluates via the transformed sum:
    // ∫₀^∞ e^(−x)/(1+x) dx = e·E₁(1).
    expect(val('int[0..inf] exp(-x)/(1+x) dx')).toBeCloseTo(0.5963474, 4);
  });

  it('rejects malformed integrals with usable messages', () => {
    expect(() => r('int[0..2]')).toThrow(/needs a body/);
    expect(() => r('int(x^2, x)')).toThrow(/int\(f\(x\) dx\)/);
    expect(() => r('int[0..1] x^2 dq')).not.toThrow(); // dq: integrand constant in q
    expect(() => r('int(x^2)')).toThrow(/dx factor/);
  });

  it('refuses FTC across a non-integrable pole (falls back to quadrature)', () => {
    // ∫₋₁¹ x⁻² diverges; the naive closed form −1/x would report −2. The
    // fallback sum reports a large positive number — wrong-magnitude beats
    // confidently negative for a positive integrand.
    expect(val('int[-1..1] 1/x^2 dx')).toBeGreaterThan(0);
  });

  it('flags ∫ usage on the parse for row readouts', () => {
    expect(usesIntegral(parseExpr('int[0..1] x^2 dx'))).toBe(true);
    expect(usesIntegral(parseExpr('∫ x dx'))).toBe(true);
    expect(usesIntegral(parseExpr('y = sin(x)'))).toBe(false);
  });
});

describe('quadratureSum', () => {
  it('expands to a plain expression whose value matches the integral', () => {
    const sum = quadratureSum(parseExpr('exp(-x^2)'), 'x', parseExpr('0'), parseExpr('2'));
    expect(evaluate(sum, {})).toBeCloseTo(0.8820813907624215, 8); // √π/2·erf(2)
    // Variable upper bound: a function of x.
    const si = quadratureSum(parseExpr('sin(q)/q'), 'q', parseExpr('0'), parseExpr('x'));
    expect(freeVars(si)).toEqual(new Set(['x']));
    expect(evaluate(si, { x: 10 })).toBeCloseTo(1.658347594218874, 5);
  });
});
