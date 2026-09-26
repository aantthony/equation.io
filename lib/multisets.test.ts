import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { evaluate, type Expr } from './expr.ts';

/**
 * The multiset semantics of docs/multisets.md, row by row, through the whole
 * analysis. Each block follows a section of that document.
 */
const last = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!;

/** The values of a row that draws a finite multiset of numbers, sorted:
 *  order is not part of a multiset. */
function multiset(rows: string[]): number[] {
  const row = last(rows);
  if (row.error) throw new Error(row.error);
  const object = row.cls?.object as { kind: string; values?: readonly Expr[] | Float64Array } | undefined;
  if (object?.kind === 'value') return [evaluate((object as unknown as { expr: Expr }).expr, {})];
  if (object?.kind !== 'list') throw new Error(`expected a list, got ${object?.kind}`);
  const vals = object.values!;
  const out = vals instanceof Float64Array ? [...vals] : vals.map(v => evaluate(v, {}));
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
