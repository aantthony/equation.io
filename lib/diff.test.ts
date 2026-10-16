import { compileGpu } from './compiler.ts';
import { describe, expect, it } from 'vitest';
import { diff } from './diff.ts';
import { evaluate, parseExpr } from './expr.ts';
import { classify } from './plot.ts';

function ddx(s: string, at: Record<string, number>, wrt = 'x'): number {
  return evaluate(diff(parseExpr(s), wrt), at);
}

describe('diff', () => {
  it('differentiates polynomials', () => {
    expect(ddx('x^2', { x: 3 })).toBe(6);
    expect(ddx('x^3 - 2x', { x: 2 })).toBe(10);
    expect(ddx('5', { x: 1 })).toBe(0);
  });

  it('applies product, quotient, chain rules', () => {
    expect(ddx('x sin(x)', { x: 2 })).toBeCloseTo(Math.sin(2) + 2 * Math.cos(2));
    expect(ddx('sin(x^2)', { x: 1.3 })).toBeCloseTo(Math.cos(1.69) * 2.6);
    expect(ddx('1/x', { x: 4 })).toBeCloseTo(-1 / 16);
    expect(ddx('e^x', { x: 1 })).toBeCloseTo(Math.E);
    expect(ddx('ln(x)', { x: 5 })).toBeCloseTo(0.2);
    expect(ddx('sqrt(x)', { x: 9 })).toBeCloseTo(1 / 6);
    expect(ddx('x^x', { x: 2 })).toBeCloseTo(4 * (Math.log(2) + 1));
  });

  it('treats other variables as constants', () => {
    expect(ddx('u v', { u: 7, v: 5 }, 'u')).toBe(5);
    expect(ddx('cos(2pi v)', { v: 0.3 }, 'u')).toBe(0);
  });

  it('differentiates sech and inverse hyperbolics', () => {
    const fd = (f: (x: number) => number, x: number) => (f(x + 1e-6) - f(x - 1e-6)) / 2e-6;
    expect(ddx('sech(x)', { x: 0.7 })).toBeCloseTo(fd(x => 1 / Math.cosh(x), 0.7));
    expect(ddx('asinh(x)', { x: 0.7 })).toBeCloseTo(fd(Math.asinh, 0.7));
    expect(ddx('acosh(x)', { x: 1.7 })).toBeCloseTo(fd(Math.acosh, 1.7), 4);
    expect(ddx('atanh(x)', { x: 0.7 })).toBeCloseTo(fd(Math.atanh, 0.7), 4);
    expect(ddx('|x^2-1|', { x: 0.5 })).toBe(-1); // sign(x^2-1)*2x = -1
  });

  it('differentiates lambertw, through 0 and near −1/e', () => {
    const fd = (f: (x: number) => number, x: number) => (f(x + 1e-6) - f(x - 1e-6)) / 2e-6;
    const W = (x: number) => evaluate(parseExpr('lambertw(x)'), { x });
    expect(ddx('lambertw(x)', { x: 0 })).toBe(1);
    for (const x of [-0.3, 0.4, 2, 50]) expect(ddx('lambertw(x)', { x })).toBeCloseTo(fd(W, x), 6);
    // W′ = W/(x(1 + W)).
    expect(ddx('lambertw(x^2)', { x: 1.5 })).toBeCloseTo((2 * W(2.25)) / (1.5 * (1 + W(2.25))), 12);
  });

  it('differentiates sinc, including the removable hole at 0', () => {
    const fd = (f: (x: number) => number, x: number) => (f(x + 1e-6) - f(x - 1e-6)) / 2e-6;
    expect(ddx('sinc(x)', { x: 0 })).toBe(0);
    expect(ddx('sinc(x)', { x: 2 })).toBeCloseTo(fd(x => Math.sin(x) / x, 2));
    expect(ddx('sinc(x)', { x: -0.7 })).toBeCloseTo(fd(x => Math.sin(x) / x, -0.7));
  });

  it('differentiates sinc again and again, right at and around 0', () => {
    // sinc″(0) = −1/3: the hole filled with a constant 0 differentiated to 0.
    const d1 = diff(parseExpr('sinc(x)'), 'x');
    const d2 = diff(d1, 'x');
    const d3 = diff(d2, 'x');
    const at = (e: typeof d1, x: number) => evaluate(e, { x });
    expect(at(d1, 0)).toBe(0);
    expect(at(d2, 0)).toBeCloseTo(-1 / 3, 15);
    expect(at(d3, 0)).toBe(0);
    // Closed forms, by Leibniz on sin x · (1/x).
    const { sin, cos } = Math;
    const closed = [
      (x: number) => (x * cos(x) - sin(x)) / x ** 2,
      (x: number) => -sin(x) / x - (2 * cos(x)) / x ** 2 + (2 * sin(x)) / x ** 3,
      (x: number) => -cos(x) / x + (3 * sin(x)) / x ** 2 + (6 * cos(x)) / x ** 3 - (6 * sin(x)) / x ** 4,
    ];
    // Taylor series, where the closed forms cancel.
    const series = [
      (x: number) => -x / 3 + x ** 3 / 30 - x ** 5 / 840,
      (x: number) => -1 / 3 + x ** 2 / 10 - x ** 4 / 168,
      (x: number) => x / 5 - x ** 3 / 42,
    ];
    const ds = [d1, d2, d3];
    for (const x of [0.7, -0.7, 0.5, 0.3, 0.21, 0.2, -0.19, -2]) {
      ds.forEach((d, k) => expect(at(d, x)).toBeCloseTo(closed[k](x), 11));
    }
    for (const x of [1e-3, -1e-6, 1e-9]) {
      ds.forEach((d, k) => expect(at(d, x)).toBeCloseTo(series[k](x), 14));
    }
    // And against a finite difference of the step below.
    const h = 1e-5;
    for (const [lo, hi] of [
      [d1, d2],
      [d2, d3],
    ]) {
      expect(at(hi, 0.7)).toBeCloseTo((at(lo, 0.7 + h) - at(lo, 0.7 - h)) / (2 * h), 8);
    }
  });

  it('differentiates min and max branchwise, as the chosen argument', () => {
    expect(ddx('min(x, 1)', { x: 0.5 })).toBe(1);
    expect(ddx('min(x, 1)', { x: 2 })).toBe(0);
    expect(ddx('max(x^2, 3x, 1)', { x: 2 })).toBe(3);
    expect(ddx('max(x^2, 3x, 1)', { x: 4 })).toBe(8);
    // clamp(x², 0, 1), as definitions lower it.
    expect(ddx('min(max(x^2, 0), 1)', { x: 0.5 })).toBeCloseTo(1);
    expect(ddx('min(max(x^2, 0), 1)', { x: 2 })).toBe(0);
    // Constant in x: plain 0, not a conditional that always gives 0.
    expect(diff(parseExpr('min(max(a, 0), 2)'), 'x')).toEqual({ kind: 'num', value: 0 });
  });

  it('throws for non-smooth functions', () => {
    expect(() => diff(parseExpr('floor(x)'), 'x')).toThrow(/differentiate/);
  });
});

describe('symbolic derivatives in classification', () => {
  it('provides tangents for smooth parametric surfaces', () => {
    const c = classify(parseExpr('(cos(2pi u), sin(2pi u), v)'));
    if (compileGpu(c).type !== 'psurface') throw new Error('expected psurface');
    expect(compileGpu(c).du).toBeDefined();
    expect(compileGpu(c).dv).toBeDefined();
    expect(compileGpu(c).dv![2]).toBe('1.0');
  });

  it('falls back to undefined tangents for non-smooth components', () => {
    const c = classify(parseExpr('(u, v, floor(4u))'));
    if (compileGpu(c).type !== 'psurface') throw new Error('expected psurface');
    expect(compileGpu(c).du).toBeUndefined();
  });

  it('provides tangents through min and max', () => {
    const c = classify(parseExpr('(u, v, max(u, v)^2)'));
    if (compileGpu(c).type !== 'psurface') throw new Error('expected psurface');
    expect(compileGpu(c).du).toBeDefined();
  });

  it('leaves tangents to finite differences when they are much larger than P', () => {
    // Every product-rule term repeats the whole (inlined) factor it multiplies.
    const f = Array.from({ length: 20 }, (_, k) => `sin(${k + 2}u + v)`).join(' ');
    const c = classify(parseExpr(`(u, v, ${f})`));
    if (compileGpu(c).type !== 'psurface') throw new Error('expected psurface');
    expect(compileGpu(c).du).toBeUndefined();
  });

  it('provides gradients for smooth implicit surfaces', () => {
    const c = classify(parseExpr('x^2+y^2+z^2=9'));
    if (compileGpu(c).type !== 'implicit3d') throw new Error('expected implicit3d');
    expect(compileGpu(c).grad).toBeDefined();
    expect(evaluate(diff(parseExpr('x^2+y^2+z^2-9'), 'z'), { x: 0, y: 0, z: 2 })).toBe(4);
  });
});
