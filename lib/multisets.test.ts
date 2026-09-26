import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { evaluate, type Expr } from './expr.ts';

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
