import { describe, expect, it } from 'vitest';
import { buildDefs, evalConstEnv, listGetter, listNamesOf, resolveExpr, scanDefinition } from './defs.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import { lowerGeom } from './geom.ts';
import { type Seq, lowerLists, usesListReduction } from './list.ts';
import { classify } from './plot.ts';

/** A named list's elements. Every list defined in this file is symbolic; a
 *  column keeps its typed array instead (see table.test.ts). */
const items = (seq: Seq): readonly Expr[] => {
  if (seq.kind !== 'list') throw new Error(`expected a symbolic list, got ${seq.kind}`);
  return seq.items;
};

function defsOf(rows: string[]) {
  return buildDefs(rows.map(r => scanDefinition(r)!));
}

/** Run a plot row through the full pipeline: parse → resolve → lower. */
function lowerRow(text: string, defRows: string[] = []): Expr {
  const { defs } = defsOf(defRows);
  const consts = evalConstEnv(defs, 0);
  const getFn = (n: string) => defs.fns.get(n);
  let e = resolveExpr(parseExpr(text, new Set(defs.fns.keys()), listNamesOf(defs)), getFn, { consts });
  e = lowerGeom(e, () => null, n => defs.mats.get(n) ?? null);
  return lowerLists(e, listGetter(defs), { consts });
}

const values = (e: Expr, env: Record<string, number> = {}): number[] => {
  // Either representation of a list: a typed array (a column, or constant
  // arithmetic over one) or one expression per element.
  if (e.kind === 'data') return [...e.values];
  if (e.kind !== 'list') throw new Error(`expected a list, got ${e.kind}`);
  return e.items.map(it => evaluate(it, env));
};

describe('ranges', () => {
  it('expands [a..b] with step 1', () => {
    expect(values(lowerRow('[1..5]'))).toEqual([1, 2, 3, 4, 5]);
  });
  it('reads the step from the element before the range', () => {
    expect(values(lowerRow('[0, 0.5..2]'))).toEqual([0, 0.5, 1, 1.5, 2]);
  });
  it('counts down when the end is below the start', () => {
    expect(values(lowerRow('[10..7]'))).toEqual([10, 9, 8, 7]);
  });
  it('stops at the last value within the end', () => {
    expect(values(lowerRow('[1..3.5]'))).toEqual([1, 2, 3]);
  });
  it('takes bounds from sliders', () => {
    expect(values(lowerRow('[1..N]', ['N = 4']))).toEqual([1, 2, 3, 4]);
  });
  it('rejects non-constant bounds', () => {
    expect(() => lowerRow('[1..x]')).toThrow(/must be constant/);
    expect(() => lowerRow('[1..t]')).toThrow(/cannot depend on t/);
  });
  it('rejects a zero or contrary step', () => {
    expect(() => lowerRow('[1, 1..5]')).toThrow(/step is zero/);
    expect(() => lowerRow('[5, 4..10]')).toThrow(/points away/);
  });
  it('caps expansion', () => {
    expect(() => lowerRow('[1..20000]')).toThrow(/limit/);
  });
});

describe('broadcasting', () => {
  it('maps scalars over a list', () => {
    expect(values(lowerRow('[1,2,3]^2'))).toEqual([1, 4, 9]);
    expect(values(lowerRow('2[1,2,3]'))).toEqual([2, 4, 6]);
    expect(values(lowerRow('sin([0, 1])'))).toEqual([0, Math.sin(1)]);
  });
  it('zips equal-length lists and rejects mismatches', () => {
    expect(values(lowerRow('[1,2]+[3,4]'))).toEqual([4, 6]);
    expect(() => lowerRow('[1,2]+[1,2,3]')).toThrow(/different lengths \(2 vs 3\)/);
  });
  it('zips lists into points for a scatter', () => {
    const c = classify(lowerRow('([1,2,3], [4,5,6])'));
    expect(c.plot).toMatchObject({ type: 'plist', dim: 2 });
    const c2 = classify(lowerRow('([1,2,3], 0)'));
    expect(c2.plot).toMatchObject({ type: 'plist', dim: 2 });
  });
  it('classifies a broadcast list as a value list', () => {
    const c = classify(lowerRow('L^2 + 1', ['L = [1,2,3]']));
    expect(c.plot.type).toBe('vlist');
  });
  it('keeps t animating elementwise', () => {
    expect(values(lowerRow('[1,2] + t'), { t: 10 })).toEqual([11, 12]);
  });
  it('rejects lists inside equations and piecewise', () => {
    expect(() => lowerRow('y = [1,2]')).toThrow(/own row/);
    expect(() => lowerRow('{x<0: [1,2], 0}')).toThrow(/piecewise/);
  });
  it('rejects nested lists', () => {
    expect(() => lowerRow('[L, 1]', ['L = [1,2]'])).toThrow(/nested/);
  });
});

describe('named lists', () => {
  it('defines and substitutes', () => {
    const { defs, errors } = defsOf(['L = [1,4,2]', 'M = L*2']);
    expect(errors.size).toBe(0);
    expect(defs.lists.has('L')).toBe(true);
    expect(items(defs.lists.get('M')!).map(e => evaluate(e, {}))).toEqual([2, 8, 4]);
  });
  it('keeps 2×2 tuple lists as matrices', () => {
    const { defs } = defsOf(['M = [(1,2),(3,4)]']);
    expect(defs.mats.has('M')).toBe(true);
    expect(defs.lists.has('M')).toBe(false);
  });
  it('names a scatter of points when the shape is not a matrix', () => {
    const { defs } = defsOf(['P = [(1,2),(3,4),(5,6)]']);
    expect(items(defs.lists.get('P')!)).toHaveLength(3);
    const c = classify(lowerRow('P', ['P = [(1,2),(3,4),(5,6)]']));
    expect(c.plot).toMatchObject({ type: 'plist', dim: 2 });
  });
  it('reports a list used above its definition', () => {
    const { errors } = defsOf(['a = mean(L)', 'L = [1,2,3]']);
    expect(errors.get('a')).toMatch(/list defined above/);
    const fwd = defsOf(['a = L*2', 'L = [1,2,3]']);
    expect(fwd.errors.get('a')).toMatch(/move its definition above/);
  });
  it('rejects elements that depend on the plane', () => {
    const { errors } = defsOf(['L = [x, 1]']);
    expect(errors.get('L')).toMatch(/found x/);
  });
  it('accepts range definitions', () => {
    const { defs } = defsOf(['L = [1..3]']);
    expect(items(defs.lists.get('L')!).map(e => evaluate(e, {}))).toEqual([1, 2, 3]);
  });
});

describe('reductions', () => {
  const val = (text: string, defRows: string[] = [], env = {}) => evaluate(lowerRow(text, defRows), env);
  it('mean/total/count lower symbolically', () => {
    expect(val('mean([1,2,3])')).toBe(2);
    expect(val('total([1,2,3])')).toBe(6);
    expect(val('count([1,2,3])')).toBe(3);
    expect(val('mean([t, 2])', [], { t: 4 })).toBe(3);
  });
  it('min/max reduce a single list and stay variadic otherwise', () => {
    expect(val('min([3,1,2])')).toBe(1);
    expect(val('max([3,1,2])')).toBe(3);
    expect(val('min(2, 5)')).toBe(2);
  });
  it('stdev is the sample standard deviation', () => {
    expect(val('stdev([2,4,4,4,5,5,7,9])')).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });
  it('median and sort', () => {
    expect(val('median([3,1,2])')).toBe(2);
    expect(val('median([4,1,3,2])')).toBe(2.5);
    expect(values(lowerRow('sort([3,1,2])'))).toEqual([1, 2, 3]);
  });
  it('order-dependent reductions need a constant list', () => {
    expect(() => lowerRow('stdev([t, 1, 2])')).toThrow(/constant/);
  });
  it('rejects a scalar argument', () => {
    expect(() => lowerRow('mean(5)')).toThrow(/needs a list/);
  });
  it('flags rows for the readout', () => {
    expect(usesListReduction(parseExpr('mean([1,2])'))).toBe(true);
    expect(usesListReduction(parseExpr('sin(x)'))).toBe(false);
    // One-argument min/max reduce a list too, so they earn the same readout.
    expect(usesListReduction(parseExpr('min([1,2])'))).toBe(true);
    expect(usesListReduction(parseExpr('max([1,2])'))).toBe(true);
    expect(usesListReduction(parseExpr('min(x, 2)'))).toBe(false);
  });
});

describe('indexing', () => {
  const L = ['L = [5,6,7]'];
  it('is 1-based', () => {
    expect(evaluate(lowerRow('L[2]', L), {})).toBe(6);
    expect(() => lowerRow('L[0]', L)).toThrow(/1-based/);
  });
  it('checks bounds and integrality', () => {
    expect(() => lowerRow('L[4]', L)).toThrow(/out of range/);
    expect(() => lowerRow('L[1.5]', L)).toThrow(/whole numbers/);
  });
  it('takes the index from a slider', () => {
    expect(evaluate(lowerRow('L[k]', [...L, 'k = 3']), {})).toBe(7);
  });
  it('rejects slicing for now', () => {
    expect(() => lowerRow('L[1..2]', L)).toThrow(/Slicing/);
  });
  it('leaves non-list brackets as multiplication', () => {
    expect(evaluate(lowerRow('x[2]'), { x: 3 })).toBe(6);
  });
});
