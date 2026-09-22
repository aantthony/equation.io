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

  it('differentiates sinc, including the removable hole at 0', () => {
    const fd = (f: (x: number) => number, x: number) => (f(x + 1e-6) - f(x - 1e-6)) / 2e-6;
    expect(ddx('sinc(x)', { x: 0 })).toBe(0);
    expect(ddx('sinc(x)', { x: 2 })).toBeCloseTo(fd(x => Math.sin(x) / x, 2));
    expect(ddx('sinc(x)', { x: -0.7 })).toBeCloseTo(fd(x => Math.sin(x) / x, -0.7));
  });

  it('throws for non-smooth functions', () => {
    expect(() => diff(parseExpr('min(x, 1)'), 'x')).toThrow(/differentiate/);
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

  it('provides gradients for smooth implicit surfaces', () => {
    const c = classify(parseExpr('x^2+y^2+z^2=9'));
    if (compileGpu(c).type !== 'implicit3d') throw new Error('expected implicit3d');
    expect(compileGpu(c).grad).toBeDefined();
    expect(evaluate(diff(parseExpr('x^2+y^2+z^2-9'), 'z'), { x: 0, y: 0, z: 2 })).toBe(4);
  });
});
