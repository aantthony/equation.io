import { describe, expect, it } from 'vitest';
import { compileTyped, usesComplex } from './complex.ts';
import { parseExpr } from './expr.ts';
import { classify } from './plot.ts';

const typed = (s: string) => compileTyped(parseExpr(s));

describe('compileTyped', () => {
  it('leaves real expressions real', () => {
    expect(typed('x^2 + y')).toEqual({ type: 'real', code: expect.stringContaining('x') });
    expect(typed('sin(x)').type).toBe('real');
  });

  it('detects complex expressions', () => {
    expect(usesComplex(parseExpr('ln(w)'))).toBe(true);
    expect(usesComplex(parseExpr('x + i y'))).toBe(true);
    expect(usesComplex(parseExpr('x + y'))).toBe(false);
  });

  it('compiles complex arithmetic to vec2 code', () => {
    const c = typed('ln(w - 1) - ln(w + 1)');
    expect(c.type).toBe('complex');
    expect(c.code).toContain('c_ln');
    expect(c.code).toContain('vec2(x, y)');
  });

  it('compiles i as the imaginary unit', () => {
    const c = typed('x + i y');
    expect(c.type).toBe('complex');
    expect(c.code).toContain('c_mul');
  });

  it('re/im/arg/abs take complex back to real', () => {
    expect(typed('re(ln(w))').type).toBe('real');
    expect(typed('im(w^2)').type).toBe('real');
    expect(typed('arg(w)').type).toBe('real');
    expect(typed('abs(w)')).toEqual({ type: 'real', code: 'length(vec2(x, y))' });
  });

  it('conj stays complex', () => {
    expect(typed('conj(w)').type).toBe('complex');
  });

  it('rejects complex equations without re/im', () => {
    expect(() => typed('w = 1')).toThrow(/re\(/);
  });
});

describe('classify (complex)', () => {
  it('routes complex-valued expressions to complex2d', () => {
    const c = classify(parseExpr('ln(w-1) - ln(w+1)'));
    expect(c.plot.type).toBe('complex2d');
    expect(c.needs3D).toBe(false);
  });

  it('routes re/im equations to implicit curves', () => {
    expect(classify(parseExpr('im(ln(w)) = 1')).plot.type).toBe('implicit2d');
    expect(classify(parseExpr('abs(w) = 2')).plot.type).toBe('implicit2d');
  });

  it('rejects complex in 3D or parametric contexts', () => {
    expect(() => classify(parseExpr('z + i'))).toThrow(/2D only/);
    expect(() => classify(parseExpr('(i u, 1, 1)'))).toThrow(/not supported in vectors/);
    expect(() => classify(parseExpr('i u v'))).toThrow(/bare expression in u alone/);
    expect(() => classify(parseExpr('(i x, 1, 1)'))).toThrow(/vector/i);
  });
});

describe('classify (special forms)', () => {
  it('routes domain coloring and conformal grids', () => {
    const d = classify(parseExpr('domain(w^2 + 1)'));
    expect(d.plot.type).toBe('domain2d');
    expect(d.needs3D).toBe(false);
    expect(classify(parseExpr('conformal(w^2)')).plot.type).toBe('conformal2d');
  });

  it('rejects real-valued domain/conformal arguments', () => {
    expect(() => classify(parseExpr('domain(x^2)'))).toThrow(/complex/);
    expect(() => classify(parseExpr('conformal(x + y)'))).toThrow(/complex/);
  });

  it('iter binds z and seeds by whether the step sees the pixel', () => {
    const m = classify(parseExpr('iter(z^2 + w)'));
    expect(m.plot).toMatchObject({ type: 'fractal2d', seed: 'zero' });
    expect(m.needs3D).toBe(false);
    expect((m.plot as { step: string }).step).toContain('c_mul(zc, zc)');
    const j = classify(parseExpr('iter(z^2 - 0.7269 + 0.1889i)'));
    expect(j.plot).toMatchObject({ type: 'fractal2d', seed: 'pixel' });
  });

  it('iter takes an optional plain-number count', () => {
    expect(classify(parseExpr('iter(z^2 + w, 500)')).plot).toMatchObject({ maxIter: 500 });
    expect(() => classify(parseExpr('iter(z^2 + w, x)'))).toThrow(/plain number/);
  });

  it('special forms must stand alone', () => {
    expect(() => classify(parseExpr('1 + iter(z^2 - 1)'))).toThrow(/whole expression/);
    expect(() => classify(parseExpr('domain(w) = 1'))).toThrow(/whole expression/);
    expect(() => classify(parseExpr('domain(iter(z^2 + w))'))).toThrow(/whole expression/);
  });

  it('flags t-animated julia sets', () => {
    const c = classify(parseExpr('iter(z^2 + e^(i t/8))'));
    expect(c.animated).toBe(true);
    expect(c.plot).toMatchObject({ type: 'fractal2d', seed: 'pixel' });
  });

  it('threads slider constants through iter as uniforms', () => {
    const c = classify(parseExpr('iter(z^2 + a + b i)'), new Set(['a', 'b']));
    expect(c.params).toEqual(['a', 'b']);
    expect((c.plot as { step: string }).step).toContain('u_a');
  });
});
