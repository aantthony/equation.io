import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { densityAt } from './dist.ts';
import { evaluate, type Expr } from './expr.ts';
import { dotPlot } from './plot.ts';

/**
 * The multiset semantics of docs/multisets.md, row by row, through the whole
 * analysis. Each block follows a section of that document.
 */
const last = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!;

/** The values of a row that draws a finite multiset of numbers, evaluated at
 *  the document's constants and sorted: order is not part of a multiset. */
function multiset(rows: string[]): number[] {
  const analysis = analyzeRows(rows, { readouts: true });
  const row = analysis.rows.at(-1)!;
  if (row.error) throw new Error(row.error);
  const env = analysis.constEnv;
  const object = row.cls?.object as { kind: string; values?: readonly Expr[] | Float64Array } | undefined;
  if (object?.kind === 'value') return [evaluate((object as unknown as { expr: Expr }).expr, env)];
  if (object?.kind !== 'list') throw new Error(`expected a list, got ${object?.kind}`);
  const vals = object.values!;
  const out = vals instanceof Float64Array ? [...vals] : vals.map(v => evaluate(v, env));
  return out.sort((a, b) => a - b);
}

describe('§1 equal vs identical', () => {
  it('separate literals take every pair', () => {
    expect(multiset(['[1,2] + [3,4]'])).toEqual([4, 5, 5, 6]);
    expect(multiset(['[1,2] * [0,1]'])).toEqual([0, 0, 1, 2]);
  });
  it('a one-element multiset changes nothing', () => {
    expect(multiset(['[1,2] * 3'])).toEqual([3, 6]);
    expect(multiset(['[1,2] + 1'])).toEqual([2, 3]);
  });
  it('a name is chosen once per row', () => {
    expect(multiset(['L = [1,2]', 'L + L'])).toEqual([2, 4]);
    expect(multiset(['f(x) = x*x', 'f([1,2])'])).toEqual([1, 4]);
  });
  it('the empty multiset annihilates', () => {
    expect(multiset(['[1,2] + []'])).toEqual([]);
    expect(multiset(['[]'])).toEqual([]);
    expect(multiset(['L = []', 'L + 1'])).toEqual([]);
  });
});

describe('§2 brackets are sums', () => {
  it('nesting flattens', () => {
    expect(multiset(['n = [1,2]', 'a = [n, 3, 5]', 'a'])).toEqual([1, 2, 3, 5]);
    expect(multiset(['[[1,2],[],[3]]'])).toEqual([1, 2, 3]);
  });
  it('a bracket of several items is a new multiset', () => {
    // n + a has 2 × 4 values: a is equal to n + [3 5], not identical to n.
    expect(multiset(['n = [1,2]', 'a = [n, 3, 5]', 'n + a'])).toHaveLength(8);
  });
  it('one item is that item unchanged', () => {
    expect(multiset(['n = [1,2]', '[n] + [n]'])).toEqual([2, 4]);
  });
  it('a family over a flattened bracket', () => {
    const row = last(['n = [1,2]', 'a = [n, 3, 5]', 'y = sin(a x)']);
    expect(row.error).toBeUndefined();
    expect(row.cls?.object).toMatchObject({ kind: 'family' });
    expect((row.cls!.object as { members: unknown[] }).members).toHaveLength(4);
  });
});

describe('§3 reductions see the whole multiset', () => {
  it('count of a product is the product of counts', () => {
    expect(multiset(['count([1,2] + [10,20,30])'])).toEqual([6]);
  });
  it('reductions of the empty multiset', () => {
    expect(multiset(['count([])'])).toEqual([0]);
    expect(multiset(['total([])'])).toEqual([0]);
    expect(last(['mean([])']).error).toMatch(/empty/);
    expect(last(['max([])']).error).toMatch(/empty/);
  });
});

/** The vertices of a figure row, in the order it joins them. */
function path(rows: string[]): string[] {
  const analysis = analyzeRows(rows, { readouts: true });
  const row = analysis.rows.at(-1)!;
  if (row.error) throw new Error(row.error);
  const cpu = row.cpu;
  if (cpu?.type !== 'polygon') throw new Error(`expected a figure, got ${cpu?.type}`);
  const at = (e: Expr, k: number) =>
    evaluate(e, { ...analysis.constEnv, ...Object.fromEntries((cpu.over ?? []).map(c => [c.name, c.values[k]])) });
  const n = cpu.over ? cpu.over[0].values.length : cpu.pts.length / cpu.dim;
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    const vertex = cpu.over ? cpu.pts : cpu.pts.slice(k * cpu.dim, (k + 1) * cpu.dim);
    out.push(vertex.map(c => +at(c, k).toFixed(6)).join(','));
  }
  return out;
}

describe('§3 order lives in tuples', () => {
  it('sort bridges a multiset to a tuple: 2 or 3 numbers are a point, more read out', () => {
    expect(last(['sort([3,1,2])']).cpu).toMatchObject({ type: 'point', dim: 3 });
    expect(last(['sort([3,1,2])']).cls?.needs3D).toBe(true);
    expect(last(['L = [3,1,2]', 'T = sort(L)', 'T']).cpu).toMatchObject({ type: 'point', dim: 3 });
    const five = last(['sort([5,3,8,1,2])']);
    expect(five.cpu?.type).toBe('tuple');
    expect(five.info).toBe('= (1, 2, 3, 5, 8)');
    expect(last(['(1, 2, 3, 5, 8)']).info).toBe('= (1, 2, 3, 5, 8)');
  });
  it('sort(P, key) orders by a key written in the same multiset', () => {
    const P = ['P = [(1,2),(3,0),(2,5)]'];
    expect(path([...P, 'polyline(sort(P, P.x))'])).toEqual(['1,2', '2,5', '3,0']);
    expect(path([...P, 'polyline(sort(P, -P.y))'])).toEqual(['2,5', '1,2', '3,0']);
    expect(path(['s = [3,1,2]', 'polyline(sort((s, s^2), s))'])).toEqual(['1,1', '2,4', '3,9']);
    // Through a slider, the points stay one template, permuted by the key.
    expect(path(['a = 2', 's = [3,1,2]', 'polyline(sort((s, a s), s))'])).toEqual(['1,2', '2,4', '3,6']);
    expect(last([...P, 'L = [1,2]', 'sort(P, L)']).error).toMatch(/key has to be written in the list it sorts/);
    expect(last([...P, 'sort(P)']).error).toMatch(/sort\(P, P\.x\)/);
  });
  it('a path, a polygon and an index need an order; a multiset has none', () => {
    const P = ['P = [(0,0),(1,1),(2,0)]'];
    expect(last([...P, 'polyline(P)']).error).toMatch(/polyline needs an order.*polyline\(sort\(P, P\.x\)\)/);
    expect(last([...P, 'polygon(P)']).error).toMatch(/polygon needs an order/);
    expect(last(['L = [3,1,2]', 'L[2]']).error).toMatch(/L\[2\] needs an order.*T = sort\(L\).*T\[2\]/);
    expect(multiset(['L = [3,1,2]', 'T = sort(L)', 'T[2]'])).toEqual([2]);
    // Order-free: a hull, a filter, and points written out one by one.
    expect(last([...P, 'hull(P)']).cpu?.type).toBe('polygon');
    expect(multiset(['L = [3,1,2]', 'L[L > 1]'])).toEqual([2, 3]);
    expect(path(['A = (0,0)', 'B = (1,1)', 'C = (2,0)', 'polyline(A, B, C)'])).toEqual(['0,0', '1,1', '2,0']);
  });
  it('a tuple of points is walked in order, square or not', () => {
    expect(path(['polyline(((0,0),(1,1),(2,0)))'])).toEqual(['0,0', '1,1', '2,0']);
    expect(path(['T = ((0,0),(2,0),(2,1),(0,1))', 'polygon(T)'])).toEqual(['0,0', '2,0', '2,1', '0,1']);
    expect(points(['T = ((0,0),(2,0),(2,1),(0,1))', 'T[3]'])).toEqual(['2,1']);
    // Square, it is also a matrix: the consumer decides.
    expect(path(['M = ((0,0),(1,1))', 'polyline(M)'])).toEqual(['0,0', '1,1']);
    expect(points(['M = ((1,2),(3,4))', 'M (1,0)'])).toEqual(['1,3']);
    expect(points(['M = ((1,2),(3,4))', 'M[2]'])).toEqual(['3,4']);
  });
  it('tuples combine by position, never by crossing', () => {
    expect(last(['A = sort([4,1,3,2])', 'B = sort([40,10,30,20])', 'A + B']).info).toBe('= (11, 22, 33, 44)');
    expect(last(['A = sort([1,2,3,4])', 'B = sort([1,2,3])', 'A + B']).error).toMatch(/different lengths/);
    // A multiset over a tuple is a multiset of tuples: here, of 2D points.
    expect(points(['sort([2,1]) + [0,10]'])).toEqual(['1,2', '11,12']);
    expect(multiset(['T = sort([2,1]) + [0,10]', 'T[1]'])).toEqual([1, 11]);
  });
  it('a filter of a tuple, and a slice, keep its order', () => {
    expect(last(['T = sort([5,1,4,2,3])', 'T[T > 1]']).info).toBe('= (2, 3, 4, 5)');
    expect(last(['T = sort([5,1,4,2,3])', 'T[2..5]']).info).toBe('= (2, 3, 4, 5)');
  });
  it('state families are numbered only when they start from a tuple', () => {
    const run = ["p' = -p", 'p(0) = (sort([1..4])/4, 0)', 'p[2]'];
    expect(last(run).cpu?.type).toBe('point');
    expect(last(["p' = -p", 'p(0) = ([1..4]/4, 0)', 'p[2]']).error).toMatch(/Start them from a tuple/);
  });
});

/** The points a row draws — one, or a finite multiset — as sorted `x,y[,z]`
 *  strings, evaluated at the document's constants. */
function points(rows: string[]): string[] {
  const analysis = analyzeRows(rows, { readouts: true });
  const row = analysis.rows.at(-1)!;
  if (row.error) throw new Error(row.error);
  const cpu = row.cpu as { type: string; coords?: Expr[]; pts?: Expr[][] } | undefined;
  const pts = cpu?.type === 'point' ? [cpu.coords!] : cpu?.type === 'plist' ? cpu.pts! : null;
  if (!pts) throw new Error(`expected points, got ${cpu?.type}`);
  return pts.map(p => p.map(c => evaluate(c, analysis.constEnv)).join(',')).sort();
}

describe('§4 tuple matrices', () => {
  const M = ['a = [1,2]', 'M = ((a,0),(0,1))', 'P = (1,1)'];
  it('a tuple of rows is a matrix, named or not', () => {
    expect(points(['M = ((1,2),(3,4))', 'M (1,0)'])).toEqual(['1,3']);
    expect(points(['((1,2),(3,4)) (1,0)'])).toEqual(['1,3']);
    expect(points(['M = ((1,2,3),(4,5,6),(7,8,10))', 'M (1,1,1)'])).toEqual(['6,15,25']);
    expect(multiset(['det(((1,2,3),(4,5,6),(7,8,10)))'])).toEqual([-3]);
    expect(multiset(['M = ((1,2),(3,4))', 'trace(M)'])).toEqual([5]);
  });
  it('a tuple of named points is a matrix of rows', () => {
    expect(points(['A = (1,2)', 'B = (3,4)', 'M = (A, B)', 'M (1,0)'])).toEqual(['1,3']);
    expect(multiset(['A = (1,2)', 'B = (3,4)', 'det((A, B))'])).toEqual([-2]);
  });
  it('matrix algebra and the exponential take tuples', () => {
    expect(
      points(['J = ((0,-1),(1,0))', 'e^((pi/2) J) (1,0)']).map(p => p.split(',').map(Math.round).join(',')),
    ).toEqual(['0,1']);
    expect(points(['M = ((1,2),(3,4))', 'M^-1 (M (5,6))'])).toEqual(['5,6']);
  });
  it('a multiset of matrices carries through, one choice per name', () => {
    expect(points([...M, 'M P'])).toEqual(['1,1', '2,1']);
    // Both Ms are the one M: two points, not four.
    expect(points([...M, 'M M P'])).toEqual(['1,1', '4,1']);
    expect(multiset([...M, 'det(M)'])).toEqual([1, 2]);
  });
  it('a bracket of tuples is a multiset of points, never a matrix', () => {
    expect(points(['[(1,2),(3,4)]'])).toEqual(['1,2', '3,4']);
    expect(points(['M = [(1,2),(3,4)]', 'M'])).toEqual(['1,2', '3,4']);
    expect(last(['M = [(1,2),(3,4)]', 'det(M)']).error).toMatch(/takes a matrix/);
  });
  it('a bare pair of points says what it is', () => {
    expect(last(['A = (1,2)', 'B = (3,4)', '(A, B)']).error).toMatch(/2×2 matrix.*segment\(A, B\)/);
  });
});

/** The points a row draws, each as its coordinates, sorted. */
function vectors(rows: string[]): number[][] {
  const analysis = analyzeRows(rows, { readouts: true });
  const row = analysis.rows.at(-1)!;
  if (row.error) throw new Error(row.error);
  const at = (p: readonly Expr[]) => p.map(c => evaluate(c, analysis.constEnv));
  const cpu = row.cpu;
  if (cpu?.type === 'point') return [at(cpu.coords)];
  if (cpu?.type !== 'plist') throw new Error(`expected points, got ${cpu?.type}`);
  return cpu.pts.map(at).sort((a, b) => a.join().localeCompare(b.join()));
}

describe('§4 vectors in 3D', () => {
  it('e_x, e_y, e_z are the unit vectors', () => {
    expect(vectors(['e_x'])).toEqual([[1, 0, 0]]);
    expect(vectors(['e_x + 2 e_y'])).toEqual([[1, 2, 0]]);
    expect(vectors(['e_{z}'])).toEqual([[0, 0, 1]]);
    expect(last(['e_y']).cls?.needs3D).toBe(true);
  });
  it('a multiset of vectors', () => {
    expect(vectors(['[0,1] e_x'])).toEqual([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    expect(vectors(['[0,1] e_x'])).toEqual(vectors(['([0,1],0,0)']));
    expect(vectors(['[e_x, e_z]'])).toEqual([
      [0, 0, 1],
      [1, 0, 0],
    ]);
    expect(vectors(['A = (1,0,0)', '[0,1]A + [0,1]e_y'])).toEqual([
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
    ]);
    expect(vectors(['f(s) = s e_x + e_z', 'f([1,2])'])).toEqual([
      [1, 0, 1],
      [2, 0, 1],
    ]);
  });
  it('a document that defines the name keeps its own', () => {
    expect(multiset(['e_x = 3', 'e_x + 1'])).toEqual([4]);
    expect(multiset(['e_y = [1,2]', 'e_y + 1'])).toEqual([2, 3]);
    expect(multiset(['e_z(s) = 2s', 'e_z(3)'])).toEqual([6]);
    expect(last(['e_x = x^2', 'y = e_x']).cls?.object.kind).toBe('curve');
  });
  it('leaves e, subscripts of e and a sequence named e alone', () => {
    expect(multiset(['e'])).toEqual([Math.E]);
    expect(multiset(['e_1 = 3', 'e_1 + 1'])).toEqual([4]);
    expect(multiset(['e_n = n^2', 'e_3'])).toEqual([9]);
    expect(multiset(['N = 2', 'e_n = n^2', 'e_N'])).toEqual([4]);
  });
  it('a point list in space is drawn as dots', () => {
    const cube = last(['([0,1],[0,1],[0,1])']);
    expect(cube.cls?.needs3D).toBe(true);
    expect(cube.cpu).toMatchObject({ type: 'plist', dim: 3 });
    expect(vectors(['([0,1],[0,1],[0,1])'])).toHaveLength(8);
    expect(vectors(['[(0,0,0),(1,1,1)]'])).toHaveLength(2);
  });
});

describe('§5 what a row draws', () => {
  const kind = (rows: string[]) => {
    const row = last(rows);
    if (row.error) throw new Error(row.error);
    return row.cpu!.type;
  };

  it('a row that depends on x or y is drawn per pixel', () => {
    expect(kind(['y = x^2'])).toBe('implicit2d'); // a filter: the parabola
    expect(kind(['x^2 + y^2 < 1'])).toBe('ineq2d'); // a filter: the disc
    expect(kind(['sin(x y)'])).toBe('scalar2d');
    expect(kind(['(y, -x)'])).toBe('vfield2d');
    expect(kind(['(x, x^2)'])).toBe('vfield2d');
  });

  it('has no implicit graph: a scalar in x alone is a field, constant along y', () => {
    for (const text of ['sin(x)', 'x']) {
      const row = last([text]);
      expect(row.cpu?.type, text).toBe('scalar2d');
      expect(row.info, text).toBe(`scalar field — for the curve write y = ${text}`);
    }
    expect(last(['y^2']).info).toBe('scalar field — for the curve write x = y^2');
    // A field of several variables is plainly a field; no hint.
    expect(last(['sin(x y)']).info).toBeUndefined();
  });

  it('refuses what it cannot draw per pixel, and says what to write', () => {
    expect(last(['x y z']).error).toMatch(/field in space, which cannot be drawn yet .* = 0/);
    expect(last(['a = [1, 2]', 'sin(a x)']).error).toMatch(/family of scalar fields .* y = /);
    expect(kind(['a = [1, 2]', 'y = sin(a x)'])).toBe('family'); // two curves
  });

  it('a row that does not depend on x or y is drawn as its values', () => {
    expect(kind(['(u, u^2)'])).toBe('pcurve');
    expect(kind(['(1, 2)'])).toBe('point');
    expect(kind(['[1, 2, 3]'])).toBe('vlist');
    expect(kind(['[1, 2] + [1, 2]'])).toBe('vlist');
    expect(kind(['exp(i 2 pi u)'])).toBe('pcurve'); // a complex path stays a path
    const readout = last(['2 + 2']);
    expect([readout.cpu?.type, readout.info]).toEqual(['value', '= 4']);
  });

  it('numbers are a dot plot on the number line, copies stacked', () => {
    const { xs, ys } = dotPlot([3, 1, 3, NaN, 2, 3]);
    expect([...xs]).toEqual([3, 1, 3, 2, 3]);
    expect([...ys]).toEqual([1, 1, 2, 1, 3]); // height = multiplicity
    // A large column stacks in dot-wide columns instead.
    const binned = dotPlot([0.1, 0.2, 0.9, 1.1], 0.5);
    expect([...binned.xs]).toEqual([0.25, 0.25, 0.75, 1.25]);
    expect([...binned.ys]).toEqual([1, 2, 1, 1]);
  });

  it('u and v alone are each [0, 1]: the row draws the density of its values', () => {
    const density = (rows: string[], at: number) => {
      const a = analyzeRows(rows, { readouts: true });
      const row = a.rows.at(-1)!;
      if (row.error) throw new Error(row.error);
      expect(row.dist).toBe('density');
      const object = row.cls!.object;
      if (object.kind === 'curve' && object.form === 'graph') return evaluate(object.rhs, { x: at });
      if (object.kind !== 'distribution' || object.form !== 'density') throw new Error(object.kind);
      return densityAt(a.rvs.curve(object.rv, a.constEnv)!, at);
    };
    // u: the line at height 1 over [0, 1], and nothing outside it.
    expect(density(['u'], 0.5)).toBeCloseTo(1, 9);
    expect(density(['u'], 1.5)).toBe(0);
    // u²: each b in (0, 1) comes from √b, with density 1/(2√b).
    for (const b of [0.25, 0.5]) expect(density(['u^2'], b)).toBeCloseTo(1 / (2 * Math.sqrt(b)), 1);
    // u v: two separate draws, density −ln(b).
    expect(density(['u v'], 0.3)).toBeCloseTo(-Math.log(0.3), 1);
  });
});
