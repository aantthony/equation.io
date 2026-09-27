/**
 * Tensors — values of any rank, as symbolic entries (docs/multisets.md §4).
 *
 * A rank-k tensor is a k-deep nested tuple, and its shape is part of its
 * type: (1, 2, 3) is a 3-vector, ((1, 2, 3), (4, 5, 6)) a 2×3 matrix. Like
 * matrices (mat.ts), tensors vanish during geometry lowering: every operation
 * here builds scalar expressions for the entries, so a list inside an entry
 * is still one multiset, chosen once however many entries mention it, and
 * `a e_x ⊗ e_y` with `a = [1, 2]` is two matrices, not 2⁹ combinations.
 *
 * The operations act on coordinates, never on multiplicities:
 * - the outer product, (A ⊗ B)_ij = A_i B_j, with rank p + q;
 * - contraction of two indices of one tensor, which with ⊗ gives every
 *   other contraction: M N is contract(M ⊗ N, 2, 3), and trace is
 *   contract(M, 1, 2);
 * - the wedge, a ∧ b = a ⊗ b − b ⊗ a on vectors, and in general the
 *   antisymmetrised product (p + q)!/(p! q!) Alt(A ⊗ B), which keeps ∧
 *   associative: (a ∧ b) ∧ c is the trivector a ∧ b ∧ c.
 */
import { add, mul, neg, sub } from './diff.ts';
import type { Expr } from './expr.ts';
import type { Mat } from './mat.ts';

/** Entries row-major: the last index runs fastest, as in nested tuples. */
export interface Tensor {
  readonly shape: readonly number[];
  readonly data: readonly Expr[];
}

/** Tensor lookup during lowering; null for names that are not tensors.
 *  With `tuples`, a named tuple of points counts too (see tensorGetter). */
export type GetTensor = (name: string, tuples?: boolean) => Tensor | null;

/** Entries a tensor may hold. Every one is a symbolic expression that
 *  lowering carries to the end, so this bounds the work, not the memory. */
export const TENSOR_MAX = 729;

const size = (shape: readonly number[]): number => shape.reduce((n, d) => n * d, 1);

/** A value of this shape, for messages: 'a number', 'a 3-vector', 'a 2×3 tensor'. */
export const shapeText = (shape: readonly number[]): string =>
  shape.length === 0 ? 'a number' : shape.length === 1 ? `a ${shape[0]}-vector` : `a ${shape.join('×')} tensor`;

function checked(shape: readonly number[], data: Expr[]): Tensor {
  if (data.length > TENSOR_MAX) {
    throw new Error(`That tensor has ${data.length} entries — the limit is ${TENSOR_MAX}.`);
  }
  return { shape, data };
}

export const scalarTensor = (e: Expr): Tensor => ({ shape: [], data: [e] });
export const vectorTensor = (items: readonly Expr[]): Tensor => ({ shape: [items.length], data: [...items] });
export const fromMat = (m: Mat): Tensor => ({ shape: [m.length, m[0].length], data: m.flat() });

/** The square 2×2 or 3×3 matrix a tensor is, or null. */
export function toMat(t: Tensor): Mat | null {
  const [r, c] = t.shape;
  if (t.shape.length !== 2 || r !== c || (r !== 2 && r !== 3)) return null;
  return Array.from({ length: r }, (_, i) => t.data.slice(i * c, (i + 1) * c));
}

/** Stack tensors of one shape along a new first index: the rows of a tuple. */
export function stack(items: readonly Tensor[]): Tensor | null {
  const shape = items[0].shape;
  if (items.some(t => t.shape.length !== shape.length || t.shape.some((d, k) => d !== shape[k]))) return null;
  return checked(
    [items.length, ...shape],
    items.flatMap(t => t.data),
  );
}

/** The slices along the first index: a tensor's rows, as nested tuples list them. */
export function rows(t: Tensor): Tensor[] {
  const inner = t.shape.slice(1);
  const n = size(inner);
  return Array.from({ length: t.shape[0] }, (_, i) => ({ shape: inner, data: t.data.slice(i * n, (i + 1) * n) }));
}

function sameShape(op: string, a: Tensor, b: Tensor): void {
  if (a.shape.length !== b.shape.length || a.shape.some((d, k) => d !== b.shape[k])) {
    throw new Error(`Cannot ${op} ${shapeText(a.shape)} and ${shapeText(b.shape)} — the shapes differ.`);
  }
}

export function tensorAdd(a: Tensor, b: Tensor, minus = false): Tensor {
  sameShape(minus ? 'subtract' : 'add', a, b);
  return { shape: a.shape, data: a.data.map((x, k) => (minus ? sub : add)(x, b.data[k])) };
}
export const tensorScale = (t: Tensor, s: Expr): Tensor => ({ shape: t.shape, data: t.data.map(x => mul(s, x)) });
export const tensorNeg = (t: Tensor): Tensor => ({ shape: t.shape, data: t.data.map(neg) });

/** (A ⊗ B)_{i…j…} = A_{i…} B_{j…}. */
export function outer(a: Tensor, b: Tensor): Tensor {
  return checked(
    [...a.shape, ...b.shape],
    a.data.flatMap(x => b.data.map(y => mul(x, y))),
  );
}

/** Strides of a row-major shape: how far one step along each index moves. */
const strides = (shape: readonly number[]): number[] => shape.map((_, k) => size(shape.slice(k + 1)));

/**
 * Sum over index i = index j (0-based, i ≠ j), which drops both: rank k
 * becomes rank k − 2. The two indices need one length.
 */
export function contract(t: Tensor, i: number, j: number): Tensor {
  const k = t.shape.length;
  if (i === j || i < 0 || j < 0 || i >= k || j >= k) {
    throw new Error(`contract takes two different indices of the tensor, 1 to ${k}.`);
  }
  if (t.shape[i] !== t.shape[j]) {
    throw new Error(
      `contract needs two indices of one length — index ${i + 1} runs to ${t.shape[i]} and index ${j + 1} to ${t.shape[j]}.`,
    );
  }
  const st = strides(t.shape);
  const rest = t.shape.map((_, d) => d).filter(d => d !== i && d !== j);
  const shape = rest.map(d => t.shape[d]);
  const out: Expr[] = [];
  for (let flat = 0; flat < size(shape); flat++) {
    // The offset of this result entry's own indices in t.
    let base = 0;
    for (let r = rest.length - 1, left = flat; r >= 0; r--) {
      base += (left % shape[r]) * st[rest[r]];
      left = Math.floor(left / shape[r]);
    }
    let sum: Expr | null = null;
    for (let m = 0; m < t.shape[i]; m++) {
      const x = t.data[base + m * (st[i] + st[j])];
      sum = sum ? add(sum, x) : x;
    }
    out.push(sum!);
  }
  return { shape, data: out };
}

/** The product that juxtaposition writes, M N: contract the last index of a
 *  with the first of b — the matrix product, matvec, and dot product. */
export function product(a: Tensor, b: Tensor): Tensor {
  const p = a.shape.length;
  if (a.shape[p - 1] !== b.shape[0]) {
    throw new Error(
      `Cannot multiply ${shapeText(a.shape)} by ${shapeText(b.shape)} — the last index of the first and the first index of the second need one length.`,
    );
  }
  // Summed directly rather than through contract(outer(a, b)), which would
  // build every product only to add most of them away.
  const n = b.shape[0];
  const left = a.data.length / n;
  const right = b.data.length / n;
  const out: Expr[] = [];
  for (let r = 0; r < left; r++) {
    for (let c = 0; c < right; c++) {
      let sum = mul(a.data[r * n], b.data[c]);
      for (let m = 1; m < n; m++) sum = add(sum, mul(a.data[r * n + m], b.data[m * right + c]));
      out.push(sum);
    }
  }
  return checked([...a.shape.slice(0, -1), ...b.shape.slice(1)], out);
}

/** The sign of a permutation (an array of 0…n−1), by counting inversions. */
function sign(perm: readonly number[]): number {
  let s = 1;
  for (let i = 0; i < perm.length; i++) for (let j = i + 1; j < perm.length; j++) if (perm[i] > perm[j]) s = -s;
  return s;
}
function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  return permutations(n - 1).flatMap(p =>
    Array.from({ length: n }, (_, k) => [...p.slice(0, k), n - 1, ...p.slice(k)]),
  );
}
const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));

/**
 * The exterior product. On two vectors it is a ⊗ b − b ⊗ a (Wildberger's
 * negative coefficients are its antisymmetry); in general it is
 * (p + q)!/(p! q!) Alt(A ⊗ B), where Alt averages the signed permutations of
 * the indices. A scalar wedges as multiplication (a 0-vector).
 */
export function wedge(a: Tensor, b: Tensor): Tensor {
  const p = a.shape.length;
  const q = b.shape.length;
  if (p === 0 || q === 0) return outer(a, b);
  const t = outer(a, b);
  const n = p + q;
  const dim = t.shape[0];
  if (t.shape.some(d => d !== dim)) {
    throw new Error(`∧ joins vectors of one dimension, not ${shapeText(a.shape)} and ${shapeText(b.shape)}.`);
  }
  if (n > dim) return { shape: t.shape, data: t.data.map(() => ({ kind: 'num', value: 0 })) };
  const perms = permutations(n).map(perm => ({ perm, sign: sign(perm) }));
  const st = strides(t.shape);
  const weight = factorial(p) * factorial(q);
  const out: Expr[] = [];
  const index = new Array<number>(n);
  for (let flat = 0; flat < t.data.length; flat++) {
    for (let d = n - 1, left = flat; d >= 0; d--) {
      index[d] = left % dim;
      left = Math.floor(left / dim);
    }
    let sum: Expr = { kind: 'num', value: 0 };
    for (const { perm, sign: s } of perms) {
      const x = t.data[perm.reduce((at, from, d) => at + index[from] * st[d], 0)];
      sum = s > 0 ? add(sum, x) : sub(sum, x);
    }
    out.push(weight === 1 ? sum : mul({ kind: 'num', value: 1 / weight }, sum));
  }
  return { shape: t.shape, data: out };
}

/** The internal call a tensor value travels in, from geometry lowering to
 *  classify: its rank, its shape, then its entries. As a call, a list in an
 *  entry broadcasts over it like any other, so a multiset of tensors arrives
 *  as a list of these. */
export const TENSOR_CALL = '[tensor]';
export function tensorNode(t: Tensor): Expr {
  const num = (value: number): Expr => ({ kind: 'num', value });
  return { kind: 'call', name: TENSOR_CALL, args: [num(t.shape.length), ...t.shape.map(num), ...t.data] };
}
/** The tensor a `[tensor]` call holds, or null for any other node. */
export function tensorOfNode(e: Expr): Tensor | null {
  if (e.kind !== 'call' || e.name !== TENSOR_CALL) return null;
  const rank = e.args[0].kind === 'num' ? e.args[0].value : 0;
  const shape = e.args.slice(1, 1 + rank).map(a => (a.kind === 'num' ? a.value : 0));
  return { shape, data: e.args.slice(1 + rank) };
}

/** `((1, 0), (0, 2))`: a tensor's values as the nested tuples that write it. */
export function nestedText(shape: readonly number[], values: readonly string[]): string {
  if (shape.length === 0) return values[0];
  const n = size(shape.slice(1));
  const parts = Array.from({ length: shape[0] }, (_, i) =>
    nestedText(shape.slice(1), values.slice(i * n, (i + 1) * n)),
  );
  return `(${parts.join(', ')})`;
}
