import { describe, expect, it } from 'vitest';
import { type Expr, evaluate } from './expr.ts';
import {
  type Tensor,
  contract,
  nestedText,
  outer,
  product,
  stack,
  tensorNode,
  tensorOfNode,
  vectorTensor,
  wedge,
} from './tensor.ts';

const num = (value: number): Expr => ({ kind: 'num', value });
const vec = (...xs: number[]): Tensor => vectorTensor(xs.map(num));
const values = (t: Tensor): number[] => t.data.map(e => evaluate(e, {}) + 0);
const matrix = (...rows: number[][]): Tensor => stack(rows.map(r => vec(...r)))!;

describe('tensor algebra on entries', () => {
  it('outer multiplies every pair, shapes concatenated', () => {
    const t = outer(vec(1, 2), vec(3, 4, 5));
    expect(t.shape).toEqual([2, 3]);
    expect(values(t)).toEqual([3, 4, 5, 6, 8, 10]);
    expect(outer(matrix([1, 2], [3, 4]), vec(1, 0)).shape).toEqual([2, 2, 2]);
  });
  it('contract sums a pair of indices away', () => {
    expect(values(contract(matrix([1, 2], [3, 4]), 0, 1))).toEqual([5]);
    const T: Tensor = { shape: [2, 2, 2], data: [1, 2, 3, 4, 5, 6, 7, 8].map(num) };
    expect(values(contract(T, 0, 2))).toEqual([1 + 6, 3 + 8]);
    expect(values(contract(T, 1, 0))).toEqual([1 + 7, 2 + 8]);
    expect(() => contract(outer(vec(1, 2), vec(1, 2, 3)), 0, 1)).toThrow(/one length/);
  });
  it('product contracts the last index with the first, and agrees with contract ∘ outer', () => {
    const A = matrix([1, 2, 3], [4, 5, 6]);
    const B = matrix([1, 2], [3, 4], [5, 6]);
    expect(values(product(A, B))).toEqual([22, 28, 49, 64]);
    expect(values(product(A, B))).toEqual(values(contract(outer(A, B), 1, 2)));
    expect(values(product(A, vec(1, 1, 1)))).toEqual([6, 15]);
    expect(() => product(A, A)).toThrow(/one length/);
  });
  it('wedge is a ⊗ b − b ⊗ a on vectors and associative beyond', () => {
    const a = vec(1, 2, 3);
    const b = vec(4, 5, 6);
    const c = vec(0, 1, 7);
    expect(values(wedge(a, b))).toEqual(values(outer(a, b)).map((x, k) => x - values(outer(b, a))[k]));
    expect(values(wedge(wedge(a, b), c))).toEqual(values(wedge(a, wedge(b, c))));
    // a ∧ a = 0, and more factors than dimensions vanish.
    expect(values(wedge(a, a)).every(x => x === 0)).toBe(true);
    expect(values(wedge(wedge(vec(1, 0), vec(0, 1)), vec(1, 1))).every(x => x === 0)).toBe(true);
    // A scalar wedges as multiplication.
    expect(values(wedge({ shape: [], data: [num(2)] }, a))).toEqual([2, 4, 6]);
  });
  it('travels as a [tensor] call and reads out as nested tuples', () => {
    const t = matrix([1, 0], [0, 2]);
    expect(tensorOfNode(tensorNode(t))).toEqual(t);
    expect(tensorOfNode(num(1))).toBeNull();
    expect(nestedText([2, 2], ['1', '0', '0', '2'])).toBe('((1, 0), (0, 2))');
    expect(nestedText([2, 1, 2], ['1', '2', '3', '4'])).toBe('(((1, 2)), ((3, 4)))');
  });
});
