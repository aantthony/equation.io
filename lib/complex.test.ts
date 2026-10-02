import { analyzeRows } from './analysis.ts';
import { compileGpu } from './compiler.ts';
import { describe, expect, it } from 'vitest';
import { compileTyped, usesComplex } from './complex.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import { publicKind } from './math-object.ts';
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

  it('iter binds z and seeds by whether the step sees the pixel', () => {
    const m = classify(parseExpr('iter(z^2 + w)'));
    expect(compileGpu(m)).toMatchObject({ type: 'fractal2d', seed: 'zero' });
    expect(m.needs3D).toBe(false);
    expect((compileGpu(m) as { step: string }).step).toContain('c_mul(zc, zc)');
    const j = classify(parseExpr('iter(z^2 - 0.7269 + 0.1889i)'));
    expect(compileGpu(j)).toMatchObject({ type: 'fractal2d', seed: 'pixel' });
  });

  it('iter takes an optional plain-number count', () => {
    expect(compileGpu(classify(parseExpr('iter(z^2 + w, 500)')))).toMatchObject({ maxIter: 500 });
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
    expect(compileGpu(c)).toMatchObject({ type: 'fractal2d', seed: 'pixel' });
  });

  it('threads slider constants through iter as uniforms', () => {
    const c = classify(parseExpr('iter(z^2 + a + b i)'), new Set(['a', 'b']));
    expect(c.params).toEqual(['a', 'b']);
    expect((compileGpu(c) as { step: string }).step).toContain('u_a');
  });
});

describe('complex lists', () => {
  /** The last row, and its members as numbers when it draws points. */
  const last = (rows: string[], env: Record<string, number> = {}) => {
    const row = analyzeRows(rows, { readouts: true }).rows.at(-1)!;
    const cpu = row.cpu as { type: string; pts?: Expr[][] } | undefined;
    const pts = cpu?.pts?.map(p => p.map(c => evaluate(c, env)));
    return { row, kind: row.cls && publicKind(row.cls.object), pts };
  };
  const close = (pts: number[][] | undefined, want: number[][]) => {
    expect(pts).toHaveLength(want.length);
    pts!.forEach((p, k) => p.forEach((c, j) => expect(c, `member ${k}`).toBeCloseTo(want[k][j], 12)));
  };

  it('draws each member on the Argand plane, as one complex value draws', () => {
    const { kind, pts } = last(['e^(i π [0..5]/5)']);
    expect(kind).toBe('plist');
    close(
      pts,
      [0, 1, 2, 3, 4, 5].map(k => [Math.cos((Math.PI * k) / 5), Math.sin((Math.PI * k) / 5)]),
    );
  });

  it('is complex throughout when one member is: 1 in [1, i] is 1 + 0i', () => {
    close(last(['[1, i, -1]']).pts, [
      [1, 0],
      [0, 1],
      [-1, 0],
    ]);
    expect(last(['[1 + i, (1, 2)]']).row.error).toBe('Lists cannot mix complex numbers and points.');
  });

  it('names a complex list, and a complex value', () => {
    close(last(['S = e^(2 π i [0..2]/3)', 'S']).pts, [
      [1, 0],
      [-0.5, Math.sqrt(3) / 2],
      [-0.5, -Math.sqrt(3) / 2],
    ]);
    expect(last(['a = e^(i π/3)', 'a']).kind).toBe('point');
    // Through complex values to a real one: a number to read, and a constant.
    expect(last(['a = e^(i π/3)', 'b = re(a)', 'b']).row.info).toBe('≈ 0.5');
    expect(last(['b = |3 + 4i|', 'b']).row.info).toBe('= 5');
    expect(last(['a = 2 + i', 'domain(w - a)']).row.error).toBeUndefined();
  });

  it('keeps real projections of the members real', () => {
    expect(last(['re([1 + 2i, 3 - i])']).row.info).toBe('= [1, 3]');
    expect(last(['|[3 + 4i, 5i]|']).row.info).toBe('= [5, 5]');
    close(last(['L = e^(i π [0..2]/2)', '(re(L), im(L))']).pts, [
      [1, 0],
      [0, 1],
      [-1, 0],
    ]);
  });

  it('moves with sliders and t', () => {
    close(last(['k = 4', 'e^(2 π i [0..k-1]/k)'], { k: 4 }).pts, [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ]);
    close(last(['e^(i (t + π [0, 1]))'], { t: Math.PI / 2 }).pts, [
      [0, 1],
      [0, -1],
    ]);
  });

  it('reduces by sum and mean, and refuses an order it does not have', () => {
    expect(last(['count(e^(i π [0..5]/5))']).row.info).toBe('= 6');
    expect(last(['mean(e^(2 π i [0..4]/5))']).kind).toBe('point');
    for (const f of ['sort', 'median', 'stdev', 'max', 'hist'])
      expect(last([`${f}([2, i])`]).row.error).toBe(
        `${f}(…) takes real numbers, and these are complex: reduce them with abs(…), re(…) or im(…) first.`,
      );
    expect(last(['max(abs([3, 4i, 1 + i]))']).row.info).toBe('= 4');
    expect(last(['[1..i]']).row.error).toBe('A ".." range bound must be real — take re(…), im(…) or abs(…).');
  });

  it('bounds the split across every member', () => {
    // Constant members fold to two numbers each.
    expect(last(['e^(2 π i [0..4999]/5000)']).pts).toHaveLength(5000);
    expect(last(['a = 0.4', '((a + i [0..4999]/4999)^5 + 1)^3']).row.error).toMatch(
      /^This complex list is too large to draw/,
    );
  });

  it('keeps a complex value that has no meaning to its own row', () => {
    const rows = analyzeRows(['b = floor(1 + i)', 'y = x']).rows;
    expect(rows[0].error).toBe('floor is not supported for complex values.');
    expect(rows[1].error).toBeUndefined();
  });

  it('holds a real value through a named complex one as a constant', () => {
    expect(last(['a = 3 + 4i', 'b = |a|', '[1..b]']).row.info).toBe('= [1, 2, 3, 4, 5]');
    expect(last(['k = 2', 'a = k + i', 'b = re(a)', '[1..b]']).row.info).toBe('= [1, 2]');
  });

  it('lists named complex values', () => {
    close(last(['a = 1 + i', 'S = [a, 1]', 'S']).pts, [
      [1, 1],
      [1, 0],
    ]);
    const { kind, pts } = last(['a = e^(i pi/3)', '[a, 2a]']);
    expect(kind).toBe('plist');
    close(pts, [
      [0.5, Math.sqrt(3) / 2],
      [1, Math.sqrt(3)],
    ]);
  });

  it('reads real projections in reductions, filters and sort keys', () => {
    expect(last(['median(re([3 + 4i, 1, 2]))']).row.info).toBe('= 2');
    expect(last(['L = [1 + i, 2]', 'count(L[re(L) > 0])']).row.info).toBe('= 2');
    expect(last(['L = [1 + i, 2]', 'L[L > 0]']).row.error).toBe('A filter must be real — take re(…), im(…) or abs(…).');
    // Ordered by distance from -i: -1 (√2), 2 (√5), 3 (√10).
    const sorted = last(['L = [3, -1, 2]', 'sort(L, |L + i|)']).row.cls!.object;
    expect(sorted.kind === 'point' && sorted.source.representation === 'real').toBe(true);
    const coords = (sorted as { source: { coordinates: Expr[] } }).source.coordinates;
    expect(coords.map(c => evaluate(c, {}))).toEqual([-1, 2, 3]);
  });

  it('keeps a point real, in a list as on its own', () => {
    expect(last(['S = [1, 2i]', '(S, 1)']).row.error).toBe('Complex values are not supported in vectors.');
  });

  it('says when a complex member draws a different kind than the real ones', () => {
    expect(last(['y = [1, i] x']).row.error).toMatch(/^Family element 2 is complex where element 1 is not/);
    // All complex, a family is fine: the roots of w^2 = 1 and of w^2 = i.
    expect(last(['w^2 = [1, i]']).kind).toBe('family');
  });

  it('names the variable a list may not use', () => {
    expect(last(['[w, 2w]']).row.error).toBe('A list may only use constants and t (found w).');
  });
});
