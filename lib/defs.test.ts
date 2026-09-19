import { describe, expect, it } from 'vitest';
import {
  type Definition,
  buildDefs,
  constsAnimated,
  evalConstEnv,
  resolveExpr,
  scanDefinition,
} from './defs.ts';
import { evaluate, gammaFn, parseExpr } from './expr.ts';
import { toGLSL } from './glsl.ts';
import { classify } from './plot.ts';

const noFns = () => undefined;
const resolve = (s: string) => resolveExpr(parseExpr(s), noFns);

describe('scanDefinition', () => {
  it('detects constants and functions', () => {
    expect(scanDefinition('a = 2')).toEqual({ kind: 'const', name: 'a', rhs: ' 2' });
    expect(scanDefinition('f(x) = x^2')).toEqual({ kind: 'fn', name: 'f', params: ['x'], rhs: ' x^2' });
    expect(scanDefinition('g(a, b) = a b')).toMatchObject({ kind: 'fn', params: ['a', 'b'] });
  });

  it('leaves plots and built-ins alone', () => {
    expect(scanDefinition('y = x^2')).toBeNull(); // reserved
    expect(scanDefinition('sin(x) = 1')).toBeNull(); // built-in
    expect(scanDefinition('x^2 + y^2 = 4')).toBeNull();
    expect(scanDefinition('e = 3')).toBeNull();
  });

  it('lets a definition shadow a late-addition builtin', () => {
    // Graphs saved before gamma/sinc/… existed may define these names.
    expect(scanDefinition('gamma(x) = 1/sqrt(1-x^2)')).toMatchObject({ kind: 'fn', name: 'gamma' });
    expect(scanDefinition('sinc = 0.5')).toMatchObject({ kind: 'const', name: 'sinc' });
    expect(scanDefinition('vector = (1, 2)')).toMatchObject({ kind: 'const', name: 'vector' });
    expect(scanDefinition('polyline(x) = 2x')).toMatchObject({ kind: 'fn', name: 'polyline' });
    expect(scanDefinition('angle = 0.5')).toMatchObject({ kind: 'const', name: 'angle' });
    expect(scanDefinition('distance(x) = 2x')).toMatchObject({ kind: 'fn', name: 'distance' });
    const { defs, errors } = buildDefs([{ kind: 'fn', name: 'gamma', params: ['x'], rhs: '2x' }]);
    expect(errors.size).toBe(0);
    const e = resolveExpr(parseExpr('gamma(3) + 1', new Set(['gamma'])), n => defs.fns.get(n));
    expect(evaluate(e, {})).toBe(7); // the user's 2x, not Γ(3) + 1 = 3
  });
});

describe('grad', () => {
  const comps = (s: string, env: Record<string, number>) => {
    const e = resolve(s);
    if (e.kind !== 'vec') throw new Error('not a tuple');
    return e.items.map(c => evaluate(c, env));
  };

  it('expands to the tuple of partial derivatives', () => {
    expect(comps('grad(x^2 + y^2)', { x: 3, y: -2 })).toEqual([6, -4]);
    expect(comps('∇(x y)', { x: 3, y: 5 })).toEqual([5, 3]);
    expect(comps('grad(x y z)', { x: 2, y: 3, z: 4 })).toEqual([12, 8, 6]);
  });

  it('plots as a vector field and feeds point helpers', () => {
    expect(classify(resolve('grad(x^2 + y^2)')).plot.type).toBe('vfield2d');
    expect(() => classify(resolve('grad(x y z)'))).toThrow(/2D only/);
    const f = { params: ['x', 'y'], body: parseExpr('sin(x) y') };
    const e = resolveExpr(parseExpr('grad(f(x, y))', new Set(['f'])), n => (n === 'f' ? f : undefined));
    expect(classify(e).plot.type).toBe('vfield2d');
  });

  it('rejects non-scalar or missing arguments', () => {
    expect(() => resolve('grad([x, y])')).toThrow(/scalar/);
    expect(() => resolve('grad(x, y)')).toThrow(/one expression/);
  });
});

describe('d/dx derivative syntax', () => {
  const at = (s: string, env: Record<string, number>) => evaluate(resolve(s), env);

  it('differentiates with and without parens', () => {
    expect(at('d/dx (x^3)', { x: 2 })).toBe(12);
    expect(at('d/dx x^3', { x: 2 })).toBe(12);
    expect(at('d/dx sin(x)', { x: 0 })).toBe(1);
  });

  it('handles coefficients, negation, and trailing terms', () => {
    expect(at('2 d/dx (x^2)', { x: 3 })).toBe(12);
    expect(at('-d/dx (x^2)', { x: 1 })).toBe(-2);
    expect(at('d/dx (x^2) + 1', { x: 1 })).toBe(3);
  });

  it('supports higher orders and other variables', () => {
    expect(at('d^2/dx^2 (x^4)', { x: 1 })).toBe(12);
    expect(at('d/dq (q^2)', { q: 4 })).toBe(8);
  });

  it('supports the parenthesized (d/dx)(…) form', () => {
    expect(at('(d/dx)(x^2)', { x: 5 })).toBe(10);
  });

  it('nests', () => {
    expect(at('d/dx (d/dx (x^3))', { x: 2 })).toBe(12);
  });

  it('falls back to finite differences where diff() has no answer', () => {
    const fd = (f: (x: number) => number, x: number) => (f(x + 1e-4) - f(x - 1e-4)) / 2e-4;
    expect(at('d/dx (x!)', { x: 4 })).toBeCloseTo(fd(x => gammaFn(x + 1), 4), 10);
    expect(at('d/dx gamma(x)', { x: 4 })).toBeCloseTo(fd(gammaFn, 4), 10);
    expect(at('d/dx floor(x)', { x: 0.5 })).toBe(0);
  });
});

describe('Σ sums and Π products', () => {
  const at = (s: string, env: Record<string, number> = {}, consts?: Record<string, number>) =>
    evaluate(resolveExpr(parseExpr(s), noFns, { consts }), env);

  it('expands sum(n=1..N, body)', () => {
    expect(at('sum(n=1..4, n^2)')).toBe(30);
    expect(at('sum(n=1..3, n x)', { x: 2 })).toBe(12);
    expect(at('sum(n=0..0, n + 5)')).toBe(5);
  });

  it('expands products and empty ranges', () => {
    expect(at('prod(k=1..4, k)')).toBe(24);
    expect(at('sum(n=1..0, n)')).toBe(0);
    expect(at('prod(n=1..0, n)')).toBe(1);
  });

  it('binds the trailing product chain: sum[n=1..N] f(n)', () => {
    expect(at('sum[n=1..4] n')).toBe(10);
    expect(at('2 sum[n=1..3] n')).toBe(12);
    expect(at('sum[n=1..3] n x / n', { x: 5 })).toBe(15); // /n applies per-term
    expect(at('sum[n=1..3] n + 1')).toBe(7); // '+' ends the body
  });

  it('keeps Σ brackets distinct from list literals and piecewise braces', () => {
    // `[` after a function name opens a Σ header; elsewhere it is a data list
    // or plain grouping, and `{…}` stays a piecewise.
    expect(at('sum[n=1..3] n')).toBe(6);
    expect(parseExpr('[1, 4, 2]').kind).toBe('list');
    expect(at('2[x + 1]', { x: 2 })).toBe(6);
    expect(at('{x > 0: sum(n=1..3, n), 0}', { x: 1 })).toBe(6);
    expect(at('{x > 0: sum(n=1..3, n), 0}', { x: -1 })).toBe(0);
  });

  it('accepts Σ and Π glyphs', () => {
    expect(at('Σ[n=1..4] n')).toBe(10);
    expect(at('Π(k=1..3, k)')).toBe(6);
  });

  it('evaluates bounds from expressions and constants', () => {
    expect(at('sum(n=1..2+1, n)')).toBe(6);
    expect(at('sum(n=1..N, n)', {}, { N: 3 })).toBe(6);
    expect(at('sum(n=0..N-1, 1)', {}, { N: 4 })).toBe(4);
    expect(at('sum(n=1..3.7, n)')).toBe(6); // fractional upper bound floors
  });

  it('reports which constants the bounds used', () => {
    const boundConsts = new Set<string>();
    resolveExpr(parseExpr('sum(n=1..N, n)'), noFns, { consts: { N: 3 }, boundConsts });
    expect([...boundConsts]).toEqual(['N']);
  });

  it('handles nested and index-dependent sums', () => {
    expect(at('sum(n=1..3, sum(k=1..n, k))')).toBe(10); // 1 + 3 + 6
    expect(at('sum(n=1..2, sum(n=1..3, n))')).toBe(12); // inner n shadows
  });

  it('shadows the index in the chain form too', () => {
    // The inner header's body is the rest of the product chain, not a
    // sibling factor the outer Σ may substitute into.
    expect(at('sum[n=1..2] sum[n=1..3] n')).toBe(12); // 6 + 6, not 3 + 6
    expect(at('sum[n=1..2] sum[k=1..3] k')).toBe(12); // distinct indices
    expect(at('sum[n=1..3] sum[k=1..n] k')).toBe(10); // inner bound sees outer n
    expect(at('2 sum[n=1..2] sum[n=1..2] n')).toBe(12); // coefficient outside
    expect(at('sum[n=1..2] n prod[n=1..2] n')).toBe(6); // (1·2) + (2·2)
  });

  it('differentiates through sums', () => {
    expect(at('d/dx sum(n=1..3, x^n)', { x: 1 })).toBe(6);
    expect(at('d/dx sum[n=1..3] x^n', { x: 1 })).toBe(6);
  });

  it('inlines user functions per term', () => {
    const { defs } = buildDefs([{ kind: 'fn', name: 'f', params: ['k'], rhs: 'k^2' }]);
    const e = resolveExpr(parseExpr('sum(n=1..3, f(n))', new Set(['f'])), n => defs.fns.get(n));
    expect(evaluate(e, {})).toBe(14);
  });

  it('expands inside constant definitions, using earlier constants', () => {
    const { defs, errors, sumBoundConsts } = buildDefs([
      { kind: 'const', name: 'N', rhs: '3' },
      { kind: 'const', name: 'S', rhs: 'sum(n=1..N, n)' },
    ]);
    expect(errors.size).toBe(0);
    expect(evalConstEnv(defs, 0).S).toBe(6);
    expect([...sumBoundConsts]).toEqual(['N']);
  });

  it('folds numeric subtrees so GLSL stays clean', () => {
    const e = resolveExpr(parseExpr('sum(n=1..2, (-1)^n x)'), noFns);
    expect(toGLSL(e)).not.toContain('eq_pow');
    expect(evaluate(e, { x: 7 })).toBe(0);
  });

  it('rejects bad bounds and bodyless headers', () => {
    expect(() => at('sum(n=1..N, n)')).toThrow(/constant/);
    expect(() => at('sum(n=1..t, n)')).toThrow(/t/);
    expect(() => at('sum(n=1..10000, n)')).toThrow(/terms/);
    expect(() => at('sum[n=1..3] + 1')).toThrow(/body/);
    expect(() => at('1..3')).toThrow(/sum/);
    expect(() => at('sum(x=1..3, x)')).toThrow(/reserved/);
  });
});

describe('buildDefs', () => {
  const cdef = (name: string, rhs: string): Definition => ({ kind: 'const', name, rhs });
  const fdef = (name: string, params: string[], rhs: string): Definition => ({ kind: 'fn', name, params, rhs });

  it('resolves constants that depend on each other and t', () => {
    const { defs, errors } = buildDefs([cdef('a', '2'), cdef('b', 'a^2 + t')]);
    expect(errors.size).toBe(0);
    expect(evalConstEnv(defs, 3)).toEqual({ a: 2, b: 7 });
    expect(constsAnimated(defs)).toBe(true);
  });

  it('inlines functions, including calls to other functions', () => {
    const { defs, errors } = buildDefs([
      fdef('f', ['x'], 'x^2 + c'),
      fdef('g', ['x'], 'f(x) + 1'),
      cdef('c', '3'),
    ]);
    expect(errors.size).toBe(0);
    const e = resolveExpr(parseExpr('g(2)', new Set(['g'])), n => defs.fns.get(n));
    expect(evaluate(e, { c: 3 })).toBe(8);
  });

  it('differentiates through function definitions', () => {
    const { defs, errors } = buildDefs([
      fdef('f', ['x'], 'sin(x)'),
      fdef('g', ['x'], 'd/dx f(x)'),
    ]);
    expect(errors.size).toBe(0);
    const e = resolveExpr(parseExpr('g(0)', new Set(['g'])), n => defs.fns.get(n));
    expect(evaluate(e, {})).toBe(1);
  });

  it('rejects cycles', () => {
    const consts = buildDefs([cdef('a', 'b'), cdef('b', 'a')]);
    expect(consts.errors.get('a')).toMatch(/itself/);
    expect(consts.errors.get('b')).toMatch(/itself/);
    expect(consts.defs.consts.size).toBe(0);

    const fns = buildDefs([fdef('f', ['x'], 'f(x) + 1')]);
    expect(fns.errors.get('f')).toMatch(/itself/);
  });

  it('turns x/y-dependent definitions into coordinate fields, not constants', () => {
    const { errors, defs } = buildDefs([cdef('a', 'x + 1')]);
    expect(errors.size).toBe(0);
    expect(defs.consts.size).toBe(0);
    expect(defs.fields.has('a')).toBe(true);
  });

  it('rejects constants that depend on other plot variables', () => {
    const { errors, defs } = buildDefs([cdef('a', 'z + 1')]);
    expect(errors.get('a')).toMatch(/found z/);
    expect(defs.consts.size).toBe(0);
  });

  it('checks arity when inlining', () => {
    const { defs } = buildDefs([fdef('f', ['a', 'b'], 'a + b')]);
    expect(() => resolveExpr(parseExpr('f(1)', new Set(['f'])), n => defs.fns.get(n)))
      .toThrow(/2 arguments/);
  });
});

describe('classify with defined constants', () => {
  it('turns constants into u_ uniforms and reports them as params', () => {
    const cls = classify(resolve('y = a x^2'), new Set(['a']));
    expect(cls.params).toEqual(['a']);
    expect(cls.plot).toMatchObject({ type: 'implicit2d' });
    expect((cls.plot as { field: string }).field).toContain('u_a');
  });

  it('suggests a slider for unknown single names', () => {
    expect(() => classify(resolve('y = k x'))).toThrow(/slider/);
    expect(() => classify(resolve('y = d x'))).toThrow(/d\/dx/);
  });

  it('keeps original names for CPU-evaluated plots', () => {
    const cls = classify(resolve('(a, 2a)'), new Set(['a']));
    expect(cls.params).toEqual(['a']);
    const plot = cls.plot as { type: 'point'; coords: import('./expr.ts').Expr[] };
    expect(plot.type).toBe('point');
    expect(evaluate(plot.coords[1], { a: 3 })).toBe(6);
  });
});
