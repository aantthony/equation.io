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
    for (const row of ['f(3)', 'f(L)', 'f(total(L))']) expect(error(row), row).toBe('f takes 2 arguments.');
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
  it('reads a matrix as its rows, like every call that asks for points — a named list of 2 points is one', () => {
    const pre = [...PRE, 'S = [(1,2),(3,4)]', 'T = [(1,2,0),(3,4,0),(0,0,1)]'];
    expect(values('g(S)', pre).flat()).toEqual([2, 12]);
    expect(values('g(S)', pre)).toEqual(values('g([(1,2),(3,4)])', pre));
    expect(values('f(J)')).toEqual([[-0.5, -1], [1, 0]]);
    expect(values('f(2 J)')).toEqual([[-1, -2], [2, 0]]);
    expect(values('F(T)', pre)).toEqual([[1, 2, 0], [3, 4, 0], [1, 0, 1]]);
    expect(run('hull(F(T))', pre).row.cls!.plot.type).toBe('polygon');
    const arrows = run('vector(S, f(S))', pre).row.cls!.plot;
    expect(arrows.type === 'family' && arrows.members.length).toBe(2);
    expect(error('F(S)', pre)).toBe('F takes 3 arguments, and that point has 2 components.');
    // One-parameter functions substitute textually: still matrix algebra.
    expect(values('h(S) A', [...pre, 'h(p) = 2p'])).toEqual([[10, 22]]);
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
  it('draws a lattice of arrows through a deep composition over a computed list', () => {
    const lattice = ['f(x,y) = (x + y/2, y - x/2)', 'a = [-1, -0.9..1]', 'b = [-1, -0.9..1]', 'P = (a, b)'];
    const p = run('vector(P, f(f(f(f(f(f(P + (1, 0))))))))', lattice).row.cls!.plot;
    expect(p.type === 'family' && p.members.length).toBe(441);
  });
  it('draws the whole lattice of arrows', () => {
    const lattice = ['f(x,y) = (x + y/2, y)', 'a = [-1, -0.9..1]', 'b = [-1, -0.9..1]', 'P = (a, b)'];
    const p = run('vector(P, f(P))', lattice).row.cls!.plot;
    expect(p.type === 'family' && p.members.length).toBe(441);
  });
});

describe('the argument stays one list, however the row copies it', () => {
  it('zips an anonymous literal through point-list arithmetic', () => {
    expect(values('g(2 [A, B])').flat()).toEqual([8, 48]);
    expect(values('g(-[A, B])').flat()).toEqual([2, 12]);
    expect(values('f(2 [A, B])')).toEqual([[4, 4], [10, 8]]);
    const p = run('vector([A, B], f(2 [A, B]))').row.cls!.plot;
    // (The two literals are independent, so 2 × 2 — not 2 × 2 × 2 × 2.)
    expect(p.type === 'family' && p.members.length).toBe(4);
  });
  it('zips through the clones Σ and a finite difference make', () => {
    expect(values('sum(n=1..2, g([(1,2),(3,4)]))').flat()).toEqual([4, 24]);
    expect(values('sum(n=1..2, g(n [(1,2),(3,4)]))').flat()).toEqual([10, 60]);
    const d = values('d/dc g([(1,2),(3,4)] + (c, floor(c)))', [...PRE, 'c = 1.5']) // (floor forces the finite difference).flat();
    expect(d).toHaveLength(2);
    expect(d[0]).toBeCloseTo(3); expect(d[1]).toBeCloseTo(5);
  });
  it('reduces over a computed point list', () => {
    expect(run('mean(g(2 Q))').row.info).toBe('= 1');
    expect(run('total(g(Q + (1, 1)))').row.info).toBe('= 9');
    expect(run('mean(g(2 [A, B]))').row.info).toBe('= 28');
  });
  it('differentiates through f(P) symbolically', () => {
    const pre = [...PRE, 'G(x,y) = x^2 y', 's = 1'];
    expect(run('d/ds G(s A)', pre).row.info).toBe('= 6');
    expect(run('d/ds G(s A_x, s A_y)', pre).row.info).toBe('= 6');
    // A tuple inside arithmetic is beyond diff(): the finite difference still answers.
    expect(run('d/ds G((s, s) + A)', pre).row.info).toMatch(/^≈ 16/);
  });
  it('never shows its internal name', () => {
    const an = analyze(['g(x,y) = x y', "s' = g([(1,2),(3,4)]) - s", 's(0) = 1']);
    for (const r of an.rows) expect(String(r.error ?? '')).not.toMatch(/\[comp\]/);
    expect(an.rows.some(r => r.error === 'g takes 2 arguments.')).toBe(true);
  });
  it('reads a point inside P(…) and a regression', () => {
    const an = analyze([...PRE, 'X ~ Normal(0, 1)', 'P(X < g(A))']);
    expect(an.rows.at(-1)!.error).toBeUndefined();
    expect(an.rows.at(-1)!.info).toBe('≈ 0.9772');
    const fit = analyze([...PRE, 'X1 = [1, 2, 3]', 'Y1 = [2, 4, 6]', 'Y1 ~ m g(A) X1 + c']);
    expect(fit.rows.at(-1)!.error).toBeUndefined();
  });
});

describe('what the same rule changes outside f(P)', () => {
  it('a computed point list moves with the list it came from', () => {
    const p = run('segment(P, Q1)', [...PRE, 'Q1 = P + (1, 0)']).row.cls!.plot;
    expect(p.type === 'family' && p.members.length).toBe(9);
  });
  it('a literal in a Σ body is one list in every term', () => {
    expect(values('sum(n=1..2, [1, 2] n)').flat()).toEqual([3, 6]);
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
