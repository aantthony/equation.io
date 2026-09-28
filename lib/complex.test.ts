import { analyzeRows } from './analysis.ts';
import { compileGpu } from './compiler.ts';
import { describe, expect, it } from 'vitest';
import { compileTyped, usesComplex } from './complex.ts';
import { escapeTimeRows } from './escape-time.ts';
import { childrenOf, type Expr, parseExpr } from './expr.ts';
import { GLSL_PRELUDE, withHelpers } from './glsl.ts';
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
    expect(compileGpu(c).type).toBe('complex2d');
    expect(c.needs3D).toBe(false);
  });

  it('routes re/im equations to implicit curves', () => {
    expect(compileGpu(classify(parseExpr('im(ln(w)) = 1'))).type).toBe('implicit2d');
    expect(compileGpu(classify(parseExpr('abs(w) = 2'))).type).toBe('implicit2d');
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
    expect(compileGpu(d).type).toBe('domain2d');
    expect(d.needs3D).toBe(false);
    expect(compileGpu(classify(parseExpr('conformal(w^2)'))).type).toBe('conformal2d');
  });

  it('rejects real-valued domain/conformal arguments', () => {
    expect(() => classify(parseExpr('domain(x^2)'))).toThrow(/complex/);
    expect(() => classify(parseExpr('conformal(x + y)'))).toThrow(/complex/);
  });

  it('reads an old iter link as the recursive rows that replaced it', () => {
    const m = classify(parseExpr('iter(z^2 + w)'));
    expect(m.needs3D).toBe(false);
    const plan = compileGpu(m) as { type: string; field: string };
    // A bare scalar field: drawn in the row's own color.
    expect(plan.type).toBe('scalar2d');
    expect(withHelpers(`${GLSL_PRELUDE}\n${plan.field}`)).toContain('c_mul(p0_0, p0_0)');
    // A fixed map starts at the pixel: the same shader as the rows one
    // would write now.
    const step = 'z^2 - 0.7269 + 0.1889i';
    const typed = analyzeRows(escapeTimeRows(step)).rows[1].gpu;
    const old = analyzeRows([`iter(${step})`]).rows[0].gpu;
    expect(old).toEqual(typed);
  });

  it('starts an old iter link that reads the plane at step(0), as iter did from 0', () => {
    const seedOf = (src: string): Expr => {
      const find = (e: Expr): Expr | undefined =>
        e.kind === 'loop' ? e.seeds[0] : childrenOf(e).map(find).find(Boolean);
      const object = classify(parseExpr(src), new Set(['a'])).object as { expr: Expr };
      return find(object.expr)!;
    };
    // z^2 + w/a from 0 visits w/a, not w: the pixel w = -3 at a = 2 is inside.
    expect(seedOf('iter(z^2 + w/a)')).toEqual(parseExpr('0^2 + w/a'));
    expect(seedOf('iter(z^2 - 0.8 + 0.156i)')).toEqual(parseExpr('w'));
  });

  it('iter takes an optional plain-number count, which lifts the recursion limit', () => {
    const helpers = (rows: string[]) => {
      const plan = analyzeRows(rows).rows.at(-1)!.gpu as { field: string };
      return withHelpers(`${GLSL_PRELUDE}\n${plan.field}`);
    };
    expect(helpers(['iter(z^2 + w, 600)'])).toContain('k < 602');
    expect(helpers(escapeTimeRows('z^2 + w', 600))).toContain('k < 602');
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
    expect(compileGpu(c).type).toBe('scalar2d');
  });

  it('threads slider constants through iter as uniforms', () => {
    const c = classify(parseExpr('iter(z^2 + a + b i)'), new Set(['a', 'b', 'k']));
    expect(c.params).toEqual(['a', 'b']);
    expect(withHelpers(`${GLSL_PRELUDE}\n${(compileGpu(c) as { field: string }).field}`)).toContain('u_a');
  });
});
