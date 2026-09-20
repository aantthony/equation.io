/** f(P): a point (or a list of points) as the one argument of an n-parameter function. */
import { describe, expect, it } from 'vitest';
import { analyze } from '../worker/graph.ts';
import { resolveExpr } from './defs.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import { lowerGeom } from './geom.ts';
import { lowerLists, withAxes } from './list.ts';

const PRE = [
  'f(x,y) = (x + y/2, y)', 'g(x,y) = x y', 'F(x,y,z) = (x + z, y, z)',
  'A = (1, 2)', 'B = (3, 4)', 'C = (1, 2, 3)', 'J = [(0,-1),(1,0)]',
  'a = [0..2]', 'b = [0..2]', 'P = (a, b)', 'Q = [(0,0),(1,0),(1,1),(0,1)]', 'L = [1, 2, 3]',
];
const run = (row: string, pre = PRE) => {
  const an = analyze([...pre, row]);
  expect(an.rows.slice(0, -1).map(r => r.error)).toEqual(pre.map(() => undefined));
  return { row: an.rows.at(-1)!, env: { ...an.constEnv, t: 0 } };
};
/** The numeric points (or numbers) a row comes to. */
const values = (row: string, pre = PRE): number[][] => {
  const { row: r, env } = run(row, pre);
  expect(r.error, row).toBeUndefined();
  const at = (e: Expr): number[] => (e.kind === 'vec' ? e.items : [e]).map(c => evaluate(c, env) + 0);
  return r.expr!.kind === 'list' ? r.expr!.items.map(at) : [at(r.expr!)];
};
const error = (row: string, pre = PRE) => run(row, pre).row.error;

describe('a single point as the argument', () => {
  it('spreads its components over the parameters, however the point was computed', () => {
    expect(values('f(A)')).toEqual([[2, 2]]);
    expect(values('f(J A)')).toEqual([[-1.5, 1]]);
    expect(values('f(A + A)')).toEqual([[4, 4]]);
    expect(values('f(midpoint(A, B))')).toEqual([[3.5, 3]]);
    expect(values('f(rotate(A, pi))')[0][0]).toBeCloseTo(-2);
    expect(values('f(Q[3])')).toEqual([[1.5, 1]]);
    expect(values('F(C)')).toEqual([[4, 2, 3]]);
  });
  it('composes', () => {
    expect(values('f(f(1, 2))')).toEqual([[3, 2]]);
    expect(values('f(f(A))')).toEqual([[3, 2]]);
    expect(values('f(2 f(A))')).toEqual([[6, 4]]);
    expect(values('k(A)', [...PRE, 'k(p) = f(p)'])).toEqual([[2, 2]]);
  });
  it('feeds scalar functions, in values and in plots', () => {
    expect(run('g(A)').row.info).toBe('= 2');
    expect(run('g(A) + g(B)').row.info).toBe('= 14');
    expect(run('y = g(A) x').row.cls!.plot.type).toBe('implicit2d');
  });
  it('names a point: D = f(A)', () => {
    const an = analyze([...PRE, 'D = f(A)', 'D']);
    expect(an.rows.map(r => r.error).filter(Boolean)).toEqual([]);
    expect(an.defs.points.has('D')).toBe(true);
    expect([an.constEnv.D_x, an.constEnv.D_y]).toEqual([2, 2]);
  });
  it('leaves every call that already worked alone', () => {
    expect(values('f(1, 2)')).toEqual([[2, 2]]);
    expect(values('f((1, 2))')).toEqual([[2, 2]]);
    expect(values('f(A_x, A_y)')).toEqual([[2, 2]]);
    expect(values('h(A)', [...PRE, 'h(p) = 2p'])).toEqual([[2, 4]]);
  });
  it('says what is wrong with anything that is not an n-component point', () => {
    expect(error('f(C)')).toBe('f takes 2 arguments, and C has 3 components.');
    expect(error('f(F(C))')).toBe('f takes 2 arguments, and that point has 3 components.');
    expect(error('F(A)')).toBe('F takes 3 arguments, and A has 2 components.');
    for (const row of ['f(3)', 'f(L)', 'f(J)', 'f(total(L))']) expect(error(row), row).toBe('f takes 2 arguments.');
    expect(error('F(A, 3)')).toBe('F takes 3 arguments.');
    expect(error('atan2(A)')).toBe('atan2 is not defined for points.');
  });
});

describe('a list of points as the argument', () => {
  it('maps the list: f(P) is f(a, b) point for point, not a crossing of its own components', () => {
    expect(values('f(P)')).toEqual(values('f(a, b)'));
    expect(values('f(P)')).toHaveLength(9);
    expect(values('f(Q)')).toEqual([[0, 0], [1, 0], [1.5, 1], [0.5, 1]]);
    expect(values('f([A, B])')).toEqual([[2, 2], [5, 4]]);
    const lattice = ['f(x,y) = (x + y/2, y)', 'a = [-1, -0.9..1]', 'b = [-1, -0.9..1]', 'P = (a, b)'];
    expect(values('f(P)', lattice)).toHaveLength(441);
    expect(values('f(f(f(P)))', lattice)).toHaveLength(441);
  });
  it('composes with the other point-list operations', () => {
    expect(values('f(f(P))')).toEqual(values('f(f(a, b))'));
    // (Same points; -b and a meet the crossing in the other order.)
    const sorted = (pts: number[][]) => pts.map(p => p.join()).sort();
    expect(sorted(values('f(J P)'))).toEqual(sorted(values('f(-b, a)')));
    expect(values('f(P + (1, 0))')).toEqual(values('f(a + 1, b)'));
    expect(values('J f(Q)')).toEqual([[0, 0], [0, 1], [-1, 1.5], [-1, 0.5]]);
    expect(values('k(P)', [...PRE, 'k(p) = f(p)'])).toEqual(values('f(P)'));
  });
  it('gives a scalar function a value list', () => {
    expect(run('g(P)').row.cls!.plot.type).toBe('vlist');
    expect(values('g(P)').flat()).toEqual([0, 0, 0, 0, 1, 2, 0, 2, 4]);
  });
  it('still crosses with an independent list, and a filtered list keeps its pairing', () => {
    expect(values('(g(P), [0, 10])')).toHaveLength(18);
    const cut = [...PRE, 'c = a[a > 0]', 'R = (c, c^2)'];
    expect(values('f(R)', cut)).toEqual([[1.5, 1], [4, 4]]);
  });
  it('names a list: Q2 = f(Q)', () => {
    expect(values('Q2', [...PRE, 'Q2 = f(Q)'])).toEqual(values('f(Q)'));
  });
  it('reads a data scatter by its columns', () => {
    // (The columns of one file run over the same rows.)
    const col = (...xs: number[]): Expr => withAxes({ kind: 'data', values: Float64Array.from(xs) }, [{ id: 'S', n: xs.length }]);
    const S: Expr = { kind: 'vec', items: [col(1, 2, 3), col(10, 20, 30)] };
    const getFn = (n: string) => (n === 'g' ? { params: ['x', 'y'], body: parseExpr('x y') } : undefined);
    const e = resolveExpr(parseExpr('g(S)', new Set(['g'])), getFn as never);
    const low = lowerLists(lowerGeom(e, () => null, () => null, n => n === 'S'), n => (n === 'S' ? S : null));
    expect(low.kind === 'data' && [...low.values]).toEqual([10, 40, 90]);
  });
  it('rejects a list that is not of n-component points', () => {
    expect(error('f([C, C])')).toBe('f takes 2 arguments, and that point has 3 components.');
    expect(error('f(2 L)')).toBe('f takes 2 arguments.');
  });
});

describe('families over f(P)', () => {
  it('draws one figure per point', () => {
    for (const row of ['vector(P, f(P))', 'segment(P, f(P))']) {
      const p = run(row).row.cls!.plot;
      expect(p.type, row).toBe('family');
      if (p.type === 'family') expect(p.members).toHaveLength(9);
    }
    const lines = run('y = g(Q) x').row.cls!.plot;
    expect(lines.type).toBe('family');
  });
  it('takes the image of a shape whole', () => {
    expect(run('hull(f(Q))').row.cls!.plot.type).toBe('polygon');
    expect(run('polyline(f(Q))').row.cls!.plot.type).toBe('polygon');
    expect(run('hull(f(Q) + (1, 0))').row.cls!.plot.type).toBe('polygon');
  });
  it('draws the whole lattice of arrows', () => {
    const lattice = ['f(x,y) = (x + y/2, y)', 'a = [-1, -0.9..1]', 'b = [-1, -0.9..1]', 'P = (a, b)'];
    const p = run('vector(P, f(P))', lattice).row.cls!.plot;
    expect(p.type === 'family' && p.members.length).toBe(441);
  });
});

describe('the documented example', () => {
  it('deforms a lattice with one name for the points', () => {
    const an = analyze('a = [-10..10]/2; b = [-10..10]/2; P = (a, b); f(x,y) = (x + sin(y + t)/3, y + sin(x)/3); vector(P, f(P)); f(P)'.split('; '));
    expect(an.rows.map(r => r.error).filter(Boolean)).toEqual([]);
    const [arrows, dots] = an.rows.slice(-2).map(r => r.cls!);
    expect(arrows.plot.type === 'family' && arrows.plot.members.length).toBe(441);
    expect(arrows.animated).toBe(true);
    expect(dots.plot.type).toBe('plist');
  });
});

describe('cost', () => {
  it('lowers a shared argument once, however deep the composition', () => {
    const nest = (n: number, inner: string) => { let s = inner; for (let k = 0; k < n; k++) s = `f(${s})`; return s; };
    const pre = ['f(x,y) = (x + y/2, y - x/2)', 'A = (1, 2)', 'J = [(0,-1),(1,0)]'];
    const t0 = performance.now();
    expect(values(nest(8, 'J A'), pre)).toHaveLength(1);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
