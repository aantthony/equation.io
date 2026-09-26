import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { parseCsv } from './csv.ts';
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
    expect(last(['L = [3,1,2]', 'L[2]']).error).toMatch(/L\[2\] needs an order.*sort\(L\)\[2\]/);
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

/** The tensors a row reads out: their shape, and each one's entries in
 *  row-major order — sorted, since a multiset of them has no order. */
function tensors(rows: string[]): { shape: readonly number[]; values: number[][] } {
  const analysis = analyzeRows(rows, { readouts: true });
  const row = analysis.rows.at(-1)!;
  if (row.error) throw new Error(row.error);
  const object = row.cls?.object;
  if (object?.kind !== 'tuple' || !object.shape) throw new Error(`expected a tensor, got ${object?.kind}`);
  const shape = object.shape;
  const size = shape.reduce((n, d) => n * d, 1);
  const flat = object.values.map(v => evaluate(v, analysis.constEnv) + 0);
  const values = Array.from({ length: object.count ?? 1 }, (_, k) => flat.slice(k * size, (k + 1) * size));
  return { shape, values: values.sort((a, b) => a.join().localeCompare(b.join())) };
}

describe('§4 tensors', () => {
  it('rank-k tuples are values whose shape is part of the type', () => {
    expect(tensors(['((1,2,3,4),(5,6,7,8))'])).toEqual({ shape: [2, 4], values: [[1, 2, 3, 4, 5, 6, 7, 8]] });
    expect(tensors(['(((1,2),(3,4)),((5,6),(7,8)))']).shape).toEqual([2, 2, 2]);
    expect(tensors(['T = (((1,2),(3,4)),((5,6),(7,8)))', '2 T - T']).values).toEqual([[1, 2, 3, 4, 5, 6, 7, 8]]);
    expect(last(['((1,2,3,4),(5,6))']).error).toMatch(/one shape/);
  });
  it('a matrix or tensor alone on a row reads out', () => {
    expect(last(['((1,0),(0,2))']).info).toBe('= ((1, 0), (0, 2))');
    expect(last(['M = ((1,2),(3,4))', '2 M']).info).toBe('= ((2, 4), (6, 8))');
    expect(last(['(((1,2),(3,4)),((5,6),(7,8)))']).info).toBe('= (((1, 2), (3, 4)), ((5, 6), (7, 8)))');
    expect(last(['(x,0) ⊗ (0,1)']).error).toMatch(/no picture/);
    // Points, point lists and arrows draw as before.
    expect(last(['((1,2),(3,4),(5,6))']).cpu).toMatchObject({ type: 'plist' });
    expect(last(['A = (0,0)', 'B = (1,1)', 'vector(A, B)']).cpu).toMatchObject({ type: 'polygon' });
  });
  it('the outer product: (A ⊗ B)_ij = A_i B_j', () => {
    expect(tensors(['(1,2) ⊗ (3,4,5,6)'])).toEqual({ shape: [2, 4], values: [[3, 4, 5, 6, 6, 8, 10, 12]] });
    expect(tensors(['outer((1,2), (3,4,5,6))'])).toEqual(tensors(['(1,2) ⊗ (3,4,5,6)']));
    // A 2×3 tensor is a tuple of two 3D points, and draws as its value written out.
    expect(vectors(['(1,2) ⊗ (3,4,5)'])).toEqual(vectors(['((3,4,5),(6,8,10))']));
    expect(vectors(['L = sort([3,1,2])', 'L ⊗ (1,1)'])).toEqual(vectors(['((1,1),(2,2),(3,3))']));
    expect(tensors(['L = sort([3,1,2])', 'L ⊗ L']).values).toEqual([[1, 2, 3, 2, 4, 6, 3, 6, 9]]);
    expect(tensors(['e_x ⊗ e_y']).values).toEqual([[0, 1, 0, 0, 0, 0, 0, 0, 0]]);
    expect(tensors(['M = ((1,2),(3,4))', 'M ⊗ (1,1)']).shape).toEqual([2, 2, 2]);
    // ⊗ binds like *: 2 e_x ⊗ e_y is (2 e_x) ⊗ e_y.
    expect(tensors(['2 e_x ⊗ e_y']).values[0][1]).toBe(2);
  });
  it('contraction, and products that contract', () => {
    expect(multiset(['M = ((1,2),(3,4))', 'contract(M, 1, 2)'])).toEqual([5]);
    expect(tensors(['A = ((1,2),(3,4))', 'B = ((0,1),(1,0))', 'contract(A ⊗ B, 2, 3)'])).toEqual(
      tensors(['A = ((1,2),(3,4))', 'B = ((0,1),(1,0))', 'A B']),
    );
    expect(vectors(['T = (((1,2),(3,4)),((5,6),(7,8)))', 'contract(T, 1, 3)'])).toEqual([[7, 11]]);
    expect(tensors(['T = (((1,2),(3,4)),((5,6),(7,8)))', 'T (1,1)']).values).toEqual([[3, 7, 11, 15]]);
    // A tuple of points that is not square is a matrix to a product.
    expect(tensors(['((1,2,3),(4,5,6)) ((1,2),(3,4),(5,6))']).values).toEqual([[22, 28, 49, 64]]);
    expect(vectors(['A = ((1,2,3),(4,5,6))', 'A (1,1,1)'])).toEqual([[6, 15]]);
    expect(multiset(['det(((1,2,3),(4,5,6)) ((1,2),(3,4),(5,6)))'])).toEqual([36]);
    expect(last(['contract(e_x ⊗ e_y, 1, 1)']).error).toMatch(/two different indices/);
    expect(last(['k = 1', 'contract(e_x ⊗ e_y, k, 2)']).error).toMatch(/written out/);
  });
  it('the wedge is a ⊗ b − b ⊗ a, and its 3D dual is the cross product', () => {
    expect(tensors(['(1,0) ∧ (0,1)'])).toEqual({ shape: [2, 2], values: [[0, 1, -1, 0]] });
    expect(tensors(['wedge((1,2,3), (4,5,6))'])).toEqual(tensors(['(1,2,3) ⊗ (4,5,6) - (4,5,6) ⊗ (1,2,3)']));
    const [w] = tensors(['(1,2,3) ∧ (4,5,6)']).values;
    expect([w[5], -w[2], w[1]]).toEqual(vectors(['(1,2,3) × (4,5,6)'])[0]);
    // A bivector is a matrix too: (a ∧ b) v = a (b·v) − b (a·v).
    expect(vectors(['(e_x ∧ e_y) (1,2,3)'])).toEqual([[2, -1, 0]]);
    // ∧ is associative: the volume element is antisymmetric in every pair.
    const [vol] = tensors(['e_x ∧ e_y ∧ e_z']).values;
    expect([vol[5], vol[7], vol[11], vol[15], vol[19], vol[21]]).toEqual([1, -1, -1, 1, 1, -1]);
    expect(tensors(['wedge(e_x, e_y, e_z)']).values).toEqual([vol]);
    expect(last(['(1,2) ∧ (1,2,3)']).error).toMatch(/one dimension/);
  });
  it('named tensors and their slices', () => {
    const T = 'T = (((1,2),(3,4)),((5,6),(7,8)))';
    expect(tensors([T, 'T[2]'])).toEqual({ shape: [2, 2], values: [[5, 6, 7, 8]] });
    expect(multiset([T, 'det(T[2])'])).toEqual([-2]);
    expect(tensors([T, 'U = T[1]', 'U']).values).toEqual([[1, 2, 3, 4]]);
    expect(last([T, 'sin(T)']).error).toMatch(/2×2×2 tensor is not a number/);
  });
  it('a multiset of tensors: identical names are chosen together', () => {
    const a = 'a = [1,2]';
    // A list in an entry: two matrices.
    expect(tensors([a, 'a e_x ⊗ e_y']).values.map(t => t[1])).toEqual([1, 2]);
    // Both Ms are the one M: 2 rank-4 tensors, not 4.
    const MM = tensors([a, 'M = ((a,0),(0,1))', 'M ⊗ M']);
    expect(MM.shape).toEqual([2, 2, 2, 2]);
    expect(MM.values.map(t => t[0])).toEqual([1, 4]);
    expect(tensors([a, 'M = ((a,0),(0,1))', 'M']).values).toEqual([
      [1, 0, 0, 1],
      [2, 0, 0, 1],
    ]);
    // Identity through ∧: a named multiset of vectors wedged with itself is
    // [0, 0]; separate literals cross.
    expect(tensors(['p = [e_x, e_y]', 'p ∧ p']).values).toEqual([Array(9).fill(0), Array(9).fill(0)]);
    expect(tensors(['p = [e_x, e_y]', 'q = [e_y, e_z]', 'p ∧ q']).values).toHaveLength(4);
    expect(tensors([a, '(a e_x) ∧ (a e_y)']).values.map(t => t[1])).toEqual([1, 4]);
    expect(tensors(['[1,2] e_x ∧ [1,2] e_y']).values.map(t => t[1])).toEqual([1, 2, 2, 4]);
    // Identity through ⊗: p ⊗ p is two matrices, each p_i ⊗ p_i.
    expect(tensors(['p = [e_x, e_y]', 'p ⊗ p']).values.map(t => t[0] + t[4])).toEqual([1, 1]);
    expect(last(['M = ((1,0),(0,2))', 'a = [1,2]', 'M ⊗ (a, 0)']).info).toBe(
      '= [(((1, 0), (0, 0)), ((0, 0), (2, 0))), (((2, 0), (0, 0)), ((0, 0), (4, 0)))]',
    );
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

/** The height a number-line row draws at x = at: its exact density, or the
 *  sampled curve times the measure of its intervals. */
function drawnDensity(rows: string[], at: number): number {
  const a = analyzeRows(rows, { readouts: true });
  const row = a.rows.at(-1)!;
  if (row.error) throw new Error(row.error);
  const object = row.cls!.object;
  if (object.kind === 'curve' && object.form === 'graph') return evaluate(object.rhs, { ...a.constEnv, x: at });
  if (object.kind !== 'distribution' || object.form !== 'density') throw new Error(object.kind);
  const mass = object.mass ? evaluate(object.mass, a.constEnv) : 1;
  return mass * densityAt(a.rvs.curve(object.rv, a.constEnv)!, at);
}

describe('§5 continuous intervals', () => {
  const kind = (rows: string[]) => {
    const row = last(rows);
    if (row.error) throw new Error(row.error);
    return row.cpu?.type;
  };
  it('a name is one parameter, each literal its own', () => {
    // r + r is 2r: identical, so a curve over one parameter.
    expect(kind(['r = interval(1, 2)', '(r + r, r)'])).toBe('pcurve');
    // Two literals are separate: two parameters fill a region.
    expect(kind(['(interval(0, 1), interval(0, 1))'])).toBe('pregion');
    // A function's argument is one multiset, used twice inside it.
    expect(kind(['f(s) = (s, s^2)', 'f(interval(0, 1))'])).toBe('pcurve');
    // A definition built from r is r too.
    expect(kind(['r = interval(1, 2)', 's = 2 r', '(r, s)'])).toBe('pcurve');
  });
  it('with u and v an interval traces curves, regions and surfaces', () => {
    expect(kind(['r = interval(1, 2)', '(r cos(2 pi u), r sin(2 pi u))'])).toBe('pregion');
    expect(kind(['(u cos(2 pi v), u sin(2 pi v))'])).toBe('pregion');
    expect(kind(['r = interval(1, 2)', '(r cos(2 pi u), r sin(2 pi u), r)'])).toBe('psurface');
    expect(last(['(u, v, interval(0, 1))']).error).toMatch(/at most two parameters/);
  });
  it('the annulus is the points at radius 1 to 2', () => {
    const cpu = last(['r = interval(1, 2)', '(r cos(2 pi u), r sin(2 pi u))']).cpu;
    if (cpu?.type !== 'pregion') throw new Error(cpu?.type);
    const radii = [0, 0.5, 1].map(v => Math.hypot(...cpu.comps.map(c => evaluate(c, { u: 0.3, v }))));
    expect(radii[0]).toBeCloseTo(1, 9);
    expect(radii[1]).toBeCloseTo(1.5, 9);
    expect(radii[2]).toBeCloseTo(2, 9);
  });
  it('beside x and y an interval sweeps the region of its family', () => {
    const cpu = last(['a = interval(1, 2)', 'y = sin(a x)']).cpu;
    if (cpu?.type !== 'projected2d') throw new Error(cpu?.type);
    // F(x, y, u), with a = 1 + u: zero where the member a passes.
    expect(evaluate(cpu.constraints[0].residual, { x: 1, y: Math.sin(1.5), u: 0.5 })).toBeCloseTo(0, 12);
    expect(kind(['a = interval(1, 2)', 'y < a x'])).toBe('projected2d');
    expect(last(['a = interval(1, 2)', 'sin(a x)']).error).toMatch(/cannot range over an interval/);
    expect(last(['y = interval(0, 1) x + interval(0, 1)']).error).toMatch(/one interval/);
  });
  it('alone an interval draws its values against length', () => {
    // interval(0, 10) holds each number once: height 1, not 1/10.
    expect(drawnDensity(['interval(0, 10)'], 5)).toBeCloseTo(1, 9);
    expect(drawnDensity(['interval(1, 2)'], 1.5)).toBeCloseTo(1, 9);
    expect(drawnDensity(['interval(1, 2)'], 2.5)).toBe(0);
    // Squared, each b in (0, 1) comes from √b, as u² does.
    expect(drawnDensity(['interval(0, 1)^2'], 0.25)).toBeCloseTo(1, 1);
    // Sliders set the bounds.
    expect(drawnDensity(['b = 4', 'interval(0, b)'], 2)).toBeCloseTo(1, 9);
    // r + r: 2r spreads the length 2 of r over [0, 4].
    expect(drawnDensity(['r = interval(0, 2)', 'r + r'], 1)).toBeCloseTo(0.5, 9);
  });
  it('checks its bounds', () => {
    expect(last(['interval(2, 1)']).error).toMatch(/a < b/);
    expect(last(['interval(1)']).error).toMatch(/two bounds/);
    expect(last(['(interval(0, x), u)']).error).toMatch(/constants, sliders and t/);
  });
});

describe('§3 figures over multisets of tuples', () => {
  /** Each member's vertices, as numbers: one array per figure drawn. */
  const figures = (rows: string[]): number[][] => {
    const row = last(rows);
    if (row.error) throw new Error(row.error);
    const object = row.cls!.object;
    const members = object.kind === 'family' ? object.members.map(m => m.object) : [object];
    return members.map(m => {
      if (m.kind !== 'figure') throw new Error(m.kind);
      if (m.over) {
        const n = m.over[0].values.length;
        return Array.from({ length: n }, (_, k) => {
          const env = Object.fromEntries(m.over!.map(c => [c.name, c.values[k]]));
          return m.vertices.map(v => evaluate(v, env));
        }).flat();
      }
      return m.vertices.map(v => evaluate(v, {}));
    });
  };
  it('walks the tuple, and gives one figure per element of every other axis', () => {
    expect(figures(['a = [1,2]', 'T = ((0,0),(a,0),(0,1))', 'polyline(T)'])).toEqual([
      [0, 0, 1, 0, 0, 1],
      [0, 0, 2, 0, 0, 1],
    ]);
    // No edge joins the two copies.
    expect(figures(['P = [(3,1),(1,2),(2,0)]', 'a = [0,10]', 'polyline(sort(P, P.x) + (a,0))'])).toEqual([
      [1, 2, 2, 0, 3, 1],
      [11, 2, 12, 0, 13, 1],
    ]);
    // …packed as well: two paths of 3 vertices, not one of 6.
    expect(figures(['L = [1,5]', 'polyline((sort([1,2,3]), L))'])).toEqual([
      [1, 1, 2, 1, 3, 1],
      [1, 5, 2, 5, 3, 5],
    ]);
    // A multiset of matrices walks each one's rows.
    expect(figures(['a = [1,2]', 'M = ((a,0),(0,1))', 'polyline(M)'])).toEqual([
      [1, 0, 0, 1],
      [2, 0, 0, 1],
    ]);
  });
  it('reads a square tuple of points the same way inside a figure and out', () => {
    const T3 = 'T = ((0,0,0),(1,0,0),(0,1,0))';
    expect(figures([T3, 'polygon(T + (0,0,1))'])).toEqual([[0, 0, 1, 1, 0, 1, 0, 1, 1]]);
    const turned = figures([T3, 'polygon(rotate(T, pi/2, (0,0,1)))'])[0];
    [0, 0, 0, 0, 1, 0, -1, 0, 0].forEach((v, k) => expect(turned[k]).toBeCloseTo(v, 12));
    const T = 'T = ((0,0),(1,1))';
    expect(figures([T, 'polyline(T + (1,0))'])).toEqual([[1, 0, 2, 1]]);
    expect(figures([T, 'polyline(2 T)'])).toEqual([[0, 0, 2, 2]]);
    // R T is the matrix product R·T, whose rows are not the turned points;
    // a transform of the figure turns each point.
    expect(figures([T, 'R = ((0,-1),(1,0))', 'polyline(R T)'])).toEqual([[-1, -1, 0, 0]]);
    expect(figures([T, 'R = ((0,-1),(1,0))', 'R polyline(T)'])).toEqual([[0, 0, -1, 1]]);
    const spun = figures([T, 'polyline(rotate(T, pi))'])[0];
    [0, 0, -1, -1].forEach((v, k) => expect(spun[k]).toBeCloseTo(v, 12));
    // On a row of its own, T + p adds p to every row too.
    expect(last([T, 'T + (1,0)']).info).toBe('= ((1, 0), (2, 1))');
    expect(last([T, '(1,0) - T']).info).toBe('= ((1, 0), (0, -1))');
  });
  it('draws the same figure whether the matrix is named or not', () => {
    const M = ['M = ((1,2),(3,4))', 'N = ((0,1),(1,0))'];
    for (const X of ['M N', 'M M', '2 M', 'M + (1,1)', 'N M']) {
      const inline = figures([...M, `polyline(${X})`]);
      expect(inline).toEqual(figures([...M, `P = ${X}`, 'polyline(P)']));
    }
    expect(figures([...M, 'polyline(M N)'])).toEqual([[2, 1, 4, 3]]);
    expect(figures([...M, 'polyline(M N)'])).toEqual(figures(['polyline(((2,1),(4,3)))']));
    expect(figures([...M, 'polyline(M M)'])).toEqual([[7, 10, 15, 22]]);
    // A multiset of matrices: one figure per element, named or not.
    const a = ['a = [1,2]', 'M = ((a,0),(0,1))', 'N = ((0,1),(1,0))'];
    expect(figures([...a, 'polyline(M N)'])).toEqual([
      [0, 1, 1, 0],
      [0, 2, 1, 0],
    ]);
    expect(figures([...a, 'polyline(M N)'])).toEqual(figures([...a, 'P = M N', 'polyline(P)']));
  });
});

describe('§3 indexing is written against its brackets', () => {
  it('multiplies with a space, indexes without', () => {
    expect(last(['L = [3,1,2]', 'sort(L)[2]']).info).toBe('= 2');
    const spaced = last(['L = [3,1,2]', 'sort(L) [2]']).cls!.object;
    if (spaced.kind !== 'point') throw new Error(spaced.kind);
    expect(spaced.source.coordinates.map(c => evaluate(c, {}))).toEqual([2, 4, 6]);
    expect(multiset(['L = [3,1,2]', 'L [2]'])).toEqual([2, 4, 6]);
  });
  it('indexes a named point, which is a tuple', () => {
    expect(last(['T = (3,1,2)', 'T[2]']).info).toBe('= 1');
    expect(last(['T = (3,1)', 'T[2]']).info).toBe('= 1');
    expect(last(['T = (3,1)', 'q = T[2] + 1', 'q']).info).toBe('= 2');
    expect(last(['T = (3,1)', 'k = 1', 'T[k]']).info).toBe('= 3');
    expect(last(['T = (3,1)', 'T[3]']).error).toMatch(/out of range/);
    // A matrix's first index is its rows, as a tensor's is its slices.
    const row = last(['M = ((1,2),(3,4))', 'M[1]']).cls!.object;
    if (row.kind !== 'point') throw new Error(row.kind);
    expect(row.source.coordinates.map(c => evaluate(c, {}))).toEqual([1, 2]);
    // A named point is still no list: d/ds of a function of it is symbolic.
    expect(last(['A = (1,2)', 'G(x,y) = x^2 y', 's = 1', 'd/ds G(s A)']).info).toBe('= 6');
  });
});

describe('§2 a bracket of tuples', () => {
  it('is a multiset of tuples, not of their values', () => {
    expect(last(['[(1,2,3,4),(5,6,7,8)]']).info).toBe('= [(1, 2, 3, 4), (5, 6, 7, 8)]');
    expect(last(['count([(1,2,3,4),(5,6,7,8)])']).info).toBe('= 2');
    expect(last(['mean([(1,2,3,4),(5,6,7,8)])']).info).toBe('= (3, 4, 5, 6)');
    expect(last(['P = ([1,2],3,4,5)', 'count(P)']).info).toBe('= 2');
    expect(last(['[(1,2,3,4), 5]']).error).toMatch(/4-tuples cannot also hold numbers/);
    expect(last(['[(1,2,3,4), (1,2,3,4,5)]']).error).toMatch(/tuples of one length/);
    // Short tuples are points, and join as points.
    expect(last(['[sort([1,2]), (3,4)]']).cls!.object).toMatchObject({ kind: 'list', element: 'point' });
  });
});

describe('§4 a vector on the left of a tuple of points', () => {
  it('contracts with it', () => {
    const v = last(['T = ((1,2,3),(4,5,6))', '(1,1) T']);
    expect(v.error).toBeUndefined();
    if (v.cls!.object.kind !== 'point') throw new Error(v.cls!.object.kind);
    expect(v.cls!.object.source.coordinates.map(c => evaluate(c, {}))).toEqual([5, 7, 9]);
    expect(last(['T = ((1,2,3),(4,5,6))', '(1,1,1) T']).error).toMatch(/need one length/);
    expect(last(['a = [1,2]', 'T = ((1,2,3),(4,5,a))', '(1,1) T']).error).not.toMatch(/not a value of its own/);
  });
});

describe('§3 indexing, filters and reductions', () => {
  it('indexes a sort(…) call; a literal list has no order', () => {
    expect(last(['L = [3,1,2]', 'sort(L)[2]']).info).toBe('= 2');
    expect(last(['sort([3,1,2])[2]']).info).toBe('= 2');
    expect(last(['q = sort([3,1,2])[3] + 1', 'q']).info).toBe('= 4');
    expect(last(['[1,2,3][2]']).error).toMatch(/needs an order.*sort\(\[ … \]\)\[2\]/);
    // With a space between them, brackets still multiply.
    expect(multiset(['[1,2,3] [2]'])).toEqual([2, 4, 6]);
  });
  it('a filter that keeps nothing is []', () => {
    expect(multiset(['L = [1,2]', 'L[L > 5]'])).toEqual([]);
    expect(last(['L = [1,2]', 'M = L[L > 5]', 'count(M)']).info).toBe('= 0');
  });
  it('sorts by a key over some of the instances, ties in order', () => {
    expect(last(['L = [2,1]', 'M = [10,20]', 'sort(L + M, L)']).info).toBe('= (11, 21, 12, 22)');
    expect(last(['L = [2,1]', 'M = [10,20]', 'sort(L + M, [1,2])']).error).toMatch(/written in the list it sorts/);
  });
  it('counts any multiset, computed points included', () => {
    expect(last(['count(2 [(1,2),(3,4)])']).info).toBe('= 2');
    expect(last(['count([0,1] e_x)']).info).toBe('= 2');
    expect(last(['P = [(1,2),(3,4)]', 'count(P + (1,0))']).info).toBe('= 2');
    const mean = last(['P = [(1,2),(3,4)]', 'mean(2 P)']).cls!.object;
    if (mean.kind !== 'point') throw new Error(mean.kind);
    expect(mean.source.coordinates.map(c => evaluate(c, {}))).toEqual([4, 6]);
  });
  it('reads out a sorted column without a node per value', () => {
    let csv = 'age\n';
    for (let k = 0; k < 20000; k++) csv += `${(k * 7919) % 97}\n`;
    const tables = () => parseCsv(csv);
    for (const row of ['sort(q.age)', 'sort(q.age) + 1']) {
      const out = analyzeRows(['q = open("big.csv")', row], { readouts: true, tables }).rows[1];
      const object = out.cls!.object;
      if (object.kind !== 'tuple') throw new Error(object.kind);
      expect(object.values.length).toBe(8);
      expect(object.length).toBe(20000);
      expect(out.info).toMatch(/^= \(\d+(, \d+){7}, …\)$/);
    }
  });
});

describe('§4 multisets of matrices', () => {
  it('chooses M once when it meets points made from it', () => {
    const rows = ['a = [1,2]', 'M = ((a,0),(0,1))', 'Q = M (1,1)'];
    const points = (rs: string[]) => {
      const object = last(rs).cls!.object;
      if (object.kind !== 'list' || object.element !== 'point' || object.storage !== 'expressions')
        throw new Error(JSON.stringify(object).slice(0, 200));
      return object.values.map(p => p.map(c => evaluate(c, {})));
    };
    expect(points([...rows, 'M Q'])).toEqual([
      [1, 1],
      [4, 1],
    ]);
    expect(points([...rows, 'R = M Q', 'R'])).toEqual([
      [1, 1],
      [4, 1],
    ]);
  });
});

describe('§4 unit vectors', () => {
  it('a parameter of that name shadows the built-in', () => {
    expect(last(['f(e_x) = e_x^2', 'f(3)']).info).toBe('= 9');
    expect(last(['g(e_y, k) = e_y + k', 'g(3,1)']).info).toBe('= 4');
    expect(last(['sum(e_z = 1..3, e_z)']).info).toBe('= 6');
    // Outside the function it is the vector again.
    expect(last(['f(e_x) = e_x^2', 'e_x']).cls?.needs3D).toBe(true);
  });
});

describe('§5 measures', () => {
  /** A reduction row's value, at the document's constants. */
  const value = (rows: string[]) => multiset(rows)[0];

  it('a reduction over u or an interval is an integral against length', () => {
    expect(value(['total(u^2)'])).toBeCloseTo(1 / 3, 12);
    expect(value(['count(u)'])).toBe(1);
    expect(value(['mean(u)'])).toBeCloseTo(0.5, 12);
    expect(value(['count(interval(1, 3))'])).toBe(2);
    expect(value(['r = interval(1, 3)', 'total(r)'])).toBeCloseTo(4, 12);
    expect(value(['r = interval(1, 3)', 'mean(r)'])).toBeCloseTo(2, 12);
    expect(value(['total(u v)'])).toBeCloseTo(0.25, 12);
    // A parametric set carries its parameter's measure: the parabola arc
    // (u, u²) has measure 1, not its arc length.
    expect(value(['count((u, u^2))'])).toBe(1);
  });
  it('stays live with sliders, as ∫ rows do', () => {
    const row = last(['a = 2', 'total(a u)']);
    const object = row.cls?.object as unknown as { expr: Expr };
    expect(evaluate(object.expr, { a: 6 })).toBeCloseTo(3, 12);
  });
  it('over x is over all of ℝ', () => {
    expect(value(['total(exp(-x^2))'])).toBeCloseTo(Math.sqrt(Math.PI), 8);
    expect(value(['count(x)'])).toBe(Infinity);
    expect(value(['total(u exp(-x^2))'])).toBeCloseTo(Math.sqrt(Math.PI) / 2, 8);
    expect(last(['total(x)']).error).toMatch(/diverges/);
    expect(last(['mean(exp(-x^2))']).error).toMatch(/infinite measure/);
    expect(last(['total(x y)']).error).toMatch(/unbounded plane/);
  });
  it('a region is measured by its area', () => {
    expect(value(['count(x^2 + y^2 < 1)'])).toBeCloseTo(Math.PI, 5);
    expect(value(['total({x^2 + y^2 < 1: x^2})'])).toBeCloseTo(Math.PI / 4, 5);
    expect(value(['mean({x^2 + y^2 < 1: x y})'])).toBeCloseTo(0, 8);
    // Sliders are read when the row resolves, as Σ bounds are.
    expect(value(['a = 2', 'count(x^2 + y^2 < a)'])).toBeCloseTo(2 * Math.PI, 4);
    // An unbounded region has infinite area.
    expect(value(['count(y > x^2)'])).toBe(Infinity);
    expect(value(['count(x > 0)'])).toBe(Infinity);
    expect(last(['total(y > x^2)']).error).toMatch(/members of this filter are points/);
    // On a line, a region is a length.
    expect(value(['count(x^2 < 2)'])).toBeCloseTo(2 * Math.SQRT2, 6);
    expect(value(['total({0 < x < 1: x^2})'])).toBeCloseTo(1 / 3, 12);
    expect(value(['total({x > 0: exp(-x)})'])).toBeCloseTo(1, 10);
  });
  it('a curve is measured by its length, whatever the equation’s spelling', () => {
    expect(value(['count(x^2 + y^2 = 1)'])).toBeCloseTo(2 * Math.PI, 4);
    const arc = Math.sqrt(5) / 2 + Math.asinh(2) / 4;
    expect(value(['count({y = x^2, 0 < x < 1})'])).toBeCloseTo(arc, 8);
    expect(value(['count({2y = 2x^2, 0 < x < 1})'])).toBeCloseTo(arc, 4);
    const graph = value(['mean({y = x^2, 0 < x < 1: y})']);
    expect(value(['mean({2y = 2x^2, 0 < x < 1: y})'])).toBeCloseTo(graph, 4);
    expect(value(['count(y = sin(x))'])).toBe(Infinity);
  });
  it('points are counted', () => {
    expect(value(['count(x^2 = 2)'])).toBe(2);
    expect(value(['count(x^2 = 0)'])).toBe(1);
    expect(value(['count({x^3 - x = 0, x > 0})'])).toBe(1);
    expect(value(['count({x^3 - x = 0, x >= 0})'])).toBe(2);
    expect(value(['total({x^2 = 2: x^2})'])).toBeCloseTo(4, 9);
    expect(value(['max({x^3 - x = 0: x})'])).toBe(1);
    expect(value(['count({x^2 + y^2 = 1, y = x})'])).toBe(2);
    expect(value(['count({-4 < x < 4, sin(x) = 0})'])).toBe(3);
    // Infinitely many, or not all found: never a short count.
    expect(last(['count(sin(x) = 0)']).error).toMatch(/could not all be found/);
  });
  it('min and max search the set', () => {
    expect(value(['min(u^2 - u)'])).toBeCloseTo(-0.25, 10);
    expect(value(['max(sin(5u))'])).toBeCloseTo(1, 10);
    expect(last(['max(x)']).error).toMatch(/bounded set/);
  });
  it('a finite multiset in the argument keeps the list reduction', () => {
    expect(last(['L = [1, 2, 3]', 'y = total(L x)']).error).toBeUndefined();
    expect(value(['L = [1, 2, 3]', 'total(L)'])).toBe(6);
  });
  it('what is not measured yet says so', () => {
    expect(last(['stdev(u)']).error).toMatch(/not supported yet/);
    expect(last(['median(interval(0, 1))']).error).toMatch(/not supported yet/);
    expect(last(['count(x^2 + y^2 + z^2 < 1)']).error).toMatch(/in space/);
    expect(last(['count(x^2 + y^2 < 1 + t)']).error).toMatch(/cannot follow t/);
  });
  it('an equation condition belongs to a reduction', () => {
    expect(last(['{y = x^2: 1}']).error).toMatch(/filter for a reduction/);
    expect(last(['y = {x > 0, 2}']).error).toBeUndefined();
  });
});

describe('§5 a comparison keeps the members it holds for', () => {
  const value = (rows: string[]) => multiset(rows)[0];
  it('keeps members of a finite multiset', () => {
    expect(multiset(['[1,2,3] < 3'])).toEqual([1, 2]);
    expect(multiset(['L = [1,2,3]', 'L < 3'])).toEqual([1, 2]);
    expect(multiset(['L = [1,2,3]', '1 < L <= 3'])).toEqual([2, 3]);
    expect(multiset(['L = [1,2,3]', 'L == 2'])).toEqual([2]);
    expect(multiset(['L = [1,2,3]', 'L > 5'])).toEqual([]);
  });
  it('keeps members of the multiset, not the values compared', () => {
    expect(multiset(['L = [1,2,3]', 'L^2 < 4'])).toEqual([1]);
    const pts = last(['P = [(1,2),(-1,3)]', 'P.x < 0']).cpu as { type: string; pts: unknown[] };
    expect(pts.type).toBe('plist');
    expect(pts.pts).toHaveLength(1);
  });
  it('is the same as the filter it abbreviates', () => {
    expect(multiset(['L = [4,1,3]', 'L > 2'])).toEqual(multiset(['L = [4,1,3]', 'L[L > 2]']));
    expect(multiset(['L = [4,1,3]', 'F = L > 2', '2 F'])).toEqual([6, 8]);
  });
  it('reduces by its members', () => {
    expect(multiset(['L = [1,2,3]', 'count(L < 3)'])).toEqual([2]);
    expect(multiset(['L = [1,2,3]', 'total(L < 3)'])).toEqual([3]);
    expect(value(['total(0 < x < 1)'])).toBeCloseTo(0.5, 9);
    expect(value(['mean(0 < x < 2)'])).toBeCloseTo(1, 9);
    expect(value(['count(0 < x < 1)'])).toBeCloseTo(1, 9);
    expect(last(['total(x^2 + y^2 < 1)']).error).toMatch(/use count/);
  });
  it('in parentheses is an operand, not a link of a chain', () => {
    expect(multiset(['([1,2,3] > 1) > 1'])).toEqual([2, 3]);
    expect(multiset(['([1,2,3] > 1) > 2'])).toEqual([3]);
    expect(multiset(['[1,2,3] > 1 > 1'])).toEqual([]);
    expect(multiset(['L = [1,2,3]', '(L^2 > 1) < 3'])).toEqual([2]);
    expect(multiset(['L = [1,2,3]', '1 < (L > 1)'])).toEqual([2, 3]);
    expect(last(['(0 < y) < x']).error).toBeUndefined();
  });
  it('stays a condition inside a condition, and a family with x', () => {
    expect(multiset(['L = [1,2,3]', 'L[L < 3]'])).toEqual([1, 2]);
    expect(last(['a = [1,2]', 'y < a x']).cpu?.type).toBe('family');
  });
});

describe('§5 a row in u is drawn by its value type', () => {
  const plan = (rows: string[]) => {
    const row = last(rows);
    if (row.error) throw new Error(row.error);
    return row.cpu!;
  };
  it('a vector-valued row is a curve or surface, however it is spelled', () => {
    for (const row of ['(0,0,1) u', 'u (0,0,1)', 'u e_z'])
      expect(plan([row])).toMatchObject({ type: 'pcurve', dim: 3 });
    expect(plan(['(1,2) u'])).toMatchObject({ type: 'pcurve', dim: 2 });
    expect(plan(['r = interval(0,1)', '(0,0,1) r'])).toMatchObject({ type: 'pcurve', dim: 3 });
    expect(plan(['u e_x + v e_y + u v e_z'])).toMatchObject({ type: 'psurface' });
    // The same curve as the tuple written out.
    expect(plan(['(0,0,1) u'])).toEqual(plan(['(0,0,u)']));
  });
  it('a number-valued row keeps its density, even with a tuple inside', () => {
    for (const row of ['u^2', 'abs((u, v))', 'dot((1,2),(u,v))']) expect(plan([row]).type).toBe('density');
  });
});
