import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { compileGpu } from './compiler.ts';
import { buildDefs, resolveExpr, scanDefinition } from './defs.ts';
import { parseExpr } from './expr.ts';
import { intervalsIn, sweep } from './interval.ts';
import { regionSampler } from './path.ts';
import { classify } from './plot.ts';

/** A row resolved in a document, before anything replaces its intervals. */
function resolved(rows: string[], row: string) {
  const { defs } = buildDefs(rows.map(r => scanDefinition(r)!));
  return resolveExpr(parseExpr(row, new Set(defs.fns.keys())), n => defs.fns.get(n), {
    interval: n => defs.intervals.get(n),
  });
}

describe('hidden intervals', () => {
  it('every mention of a name is one parameter', () => {
    expect(intervalsIn(resolved(['r = interval(1, 2)'], 'r + r'))).toHaveLength(1);
    expect(intervalsIn(resolved(['r = interval(1, 2)', 's = r^2'], 'r s'))).toHaveLength(1);
  });
  it('each literal is its own', () => {
    expect(intervalsIn(resolved([], 'interval(1, 2) + interval(1, 2)'))).toHaveLength(2);
    expect(intervalsIn(resolved(['r = interval(1, 2)'], 'r + interval(1, 2)'))).toHaveLength(2);
  });
  it('keeps a literal through an inlined function', () => {
    expect(intervalsIn(resolved(['f(s) = s + s'], 'f(interval(0, 1))'))).toHaveLength(1);
    // A literal in the body is written once, so every call shares it — as a
    // list literal in a body does.
    expect(intervalsIn(resolved(['g(s) = s + interval(0, 1)'], 'g(1) + g(2)'))).toHaveLength(1);
  });
  it('a parameter shadows a named interval', () => {
    expect(intervalsIn(resolved(['r = interval(1, 2)', 'f(r) = r^2'], 'f(3)'))).toHaveLength(0);
  });
  it('sweeps its bounds with a parameter over [0, 1]', () => {
    const [h] = intervalsIn(resolved(['a = 3'], 'interval(1, a)'));
    expect(sweep(h, 'u')).toEqual({
      kind: 'bin',
      op: '+',
      a: { kind: 'num', value: 1 },
      b: {
        kind: 'bin',
        op: '*',
        a: { kind: 'bin', op: '-', a: { kind: 'var', name: 'a' }, b: { kind: 'num', value: 1 } },
        b: { kind: 'var', name: 'u' },
      },
    });
    const [unit] = intervalsIn(resolved([], 'interval(0, 1)'));
    expect(sweep(unit, 'v')).toEqual({ kind: 'var', name: 'v' });
  });
});

describe('drawing over an interval', () => {
  it('a projected family searches u in its shader, with ∂F/∂u', () => {
    const row = analyzeRows(['a = interval(1, 2)', 'y = sin(a x)']).rows[1];
    expect(row.gpu).toMatchObject({
      type: 'projected2d',
      relation: 'eq',
      field: '(y - sin(((1.0 + u) * x)))',
      slope: '(-(cos(((1.0 + u) * x)) * x))',
    });
    const ineq = analyzeRows(['a = interval(1, 2)', '0 < y < a x']).rows[1].gpu;
    expect(ineq).toMatchObject({
      type: 'projected2d',
      relation: 'ineq',
      field: 'max((0.0 - y), (y - ((1.0 + u) * x)))',
    });
    expect(ineq).not.toHaveProperty('slope');
  });
  it('slider bounds are uniforms', () => {
    const row = analyzeRows(['b = 2', 'a = interval(1, b)', 'y = a x']).rows[2];
    expect(row.gpu).toMatchObject({ type: 'projected2d', params: ['b'] });
  });
  it('a filled region is a flat surface in a 3D scene', () => {
    const cls = classify(parseExpr('(u cos(2 pi v), u sin(2 pi v))'));
    expect(compileGpu(cls)).toMatchObject({ type: 'psurface', comps: [expect.any(String), expect.any(String), '0.0'] });
  });
  it('samples a region as counter-clockwise triangles covering it', () => {
    const tris = regionSampler([parseExpr('u cos(2 pi v)'), parseExpr('u sin(2 pi v)')]).sample({});
    expect(tris.length % 6).toBe(0);
    let area = 0;
    for (let i = 0; i < tris.length; i += 6) {
      const [ax, ay, bx, by, cx, cy] = tris.subarray(i, i + 6);
      const turn = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      expect(turn).toBeGreaterThan(0);
      area += turn / 2;
    }
    // The unit disc, as a 64-gon: overlaps and slivers would change it.
    expect(area).toBeCloseTo(32 * Math.sin((2 * Math.PI) / 64), 9);
  });
});
