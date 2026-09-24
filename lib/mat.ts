import { evaluate, exprKey, freeVars } from './expr.ts';
/**
 * Small matrices — 2×2 and 3×3 — as definition-time symbolic objects.
 *
 * `M = [(a, b), (c, d)]` (rows as tuples, or nested `[[a, b], [c, d]]`, or
 * named points as rows: `R = [r1, r2]`) names a matrix. Like sums, d/dx,
 * and points, matrices vanish before anything downstream looks: det, trace,
 * the matvec `M v`, and `solve(M, v)` (Cramer's rule) all expand during
 * geometry lowering into ordinary scalar expressions. GLSL, evaluate, diff,
 * and the state integrator never see a matrix — so matrix entries can hold
 * sliders, t, or states, and `om' = solve(M, f)` integrates like any other
 * derivative.
 *
 * Cramer is exact and symbolic at these sizes; n ≥ 4 is rejected up front.
 *
 * Matrices also combine — `s M`, `M + N`, `M N`, `M^n`, `M^-1` — and
 * exponentiate: `e^(th J)` with `J = [(0, -1), (1, 0)]` is the rotation by
 * th, and `e^(th cross(n))` the rotation about the axis n, each expanded to
 * its closed form (see expOf) so that the result is, again, only scalars.
 */
import { add, div, mul, neg, sub } from './diff.ts';
import type { Expr } from './expr.ts';

/** Row-major square matrix of scalar expressions, side 2 or 3. */
export type Mat = (readonly Expr[])[];

/** Matrix lookup during lowering; null for names that are not matrices. */
export type GetMat = (name: string) => Mat | null;

const SHAPE_HINT = 'write rows of equal length: M = [(a, b), (c, d)] or [[a, b], [c, d]]';

/**
 * Read a matrix out of a lowered list literal. The list's items are rows —
 * vecs (tuples or scattered named points) or nested lists of scalars.
 * Throws on ragged or non-square shapes; a list with no row structure at
 * all (e.g. [1, 2, 3]) returns null so callers can say what a list means
 * in their context.
 */
export function matrixFromList(e: Expr): Mat | null {
  if (e.kind !== 'list' || e.items.length === 0) return null;
  const rows: Mat = [];
  for (const item of e.items) {
    if (item.kind === 'vec') rows.push(item.items);
    else if (item.kind === 'list') {
      if (item.items.some(c => c.kind === 'vec' || c.kind === 'list')) {
        throw new Error(`Matrix rows hold numbers — ${SHAPE_HINT}.`);
      }
      rows.push(item.items);
    } else return null; // a flat data list, not a matrix
  }
  const n = rows.length;
  if (rows.some(r => r.length !== n) || (n !== 2 && n !== 3)) {
    throw new Error(`A matrix is 2×2 or 3×3 — ${SHAPE_HINT}.`);
  }
  return rows;
}

/** det for side 2 or 3 (cofactor expansion along the first row). */
export function detOf(m: Mat): Expr {
  if (m.length === 2) return sub(mul(m[0][0], m[1][1]), mul(m[0][1], m[1][0]));
  const minor = (r0: number, r1: number, c0: number, c1: number): Expr =>
    sub(mul(m[r0][c0], m[r1][c1]), mul(m[r0][c1], m[r1][c0]));
  return add(sub(mul(m[0][0], minor(1, 2, 1, 2)), mul(m[0][1], minor(1, 2, 0, 2))), mul(m[0][2], minor(1, 2, 0, 1)));
}

export function traceOf(m: Mat): Expr {
  let s = m[0][0];
  for (let k = 1; k < m.length; k++) s = add(s, m[k][k]);
  return s;
}

/** M v, componentwise dot products. */
export function matVec(m: Mat, v: Expr[]): Expr[] {
  return m.map(row => {
    let s = mul(row[0], v[0]);
    for (let k = 1; k < v.length; k++) s = add(s, mul(row[k], v[k]));
    return s;
  });
}

/**
 * The solution of M x = v by Cramer's rule: x_i = det(M with column i
 * replaced by v) / det(M). Symbolic — a singular M yields NaN at evaluation
 * time, which the consumers already treat as "hold the last good value".
 */
export function solveVec(m: Mat, v: Expr[]): Expr[] {
  const d = detOf(m);
  return v.map((_, i) => {
    const mi = m.map((row, r) => row.map((entry, c) => (c === i ? v[r] : entry)));
    return div(detOf(mi), d);
  });
}

const num = (value: number): Expr => ({ kind: 'num', value });
const fn = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const isNum = (e: Expr): e is Expr & { kind: 'num' } => e.kind === 'num';
/** A constant entry as its number: (1, 1, 1)/sqrt(3) is an axis of numbers,
 *  not three copies of 1/sqrt(3) in every entry of the rotation. */
const settle = (e: Expr): Expr => {
  if (isNum(e) || freeVars(e).size) return e;
  try {
    const v = evaluate(e, {});
    return Number.isFinite(v) ? num(v) : e;
  } catch {
    return e;
  }
};

/**
 * A matrix under lowering. `scale`·`base` is the same matrix with a scalar
 * factor kept apart — `th J` remembers th and J — because a rotation's angle
 * is exactly that factor, and reading it back out of the products would cost
 * a square root and a division by zero at th = 0.
 */
export interface MatValue {
  m: Mat;
  scale?: Expr;
  base?: Mat;
}

export const identity = (n: number): Mat =>
  Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => num(r === c ? 1 : 0)));
const mapMat = (m: Mat, f: (entry: Expr, r: number, c: number) => Expr): Mat =>
  m.map((row, r) => row.map((entry, c) => f(entry, r, c)));
function sameSide(op: string, a: Mat, b: Mat): void {
  if (a.length !== b.length)
    throw new Error(`Cannot ${op} a ${a.length}×${a.length} and a ${b.length}×${b.length} matrix.`);
}

export function matScale(v: MatValue, s: Expr): MatValue {
  return { m: mapMat(v.m, entry => mul(s, entry)), scale: v.scale ? mul(s, v.scale) : s, base: v.base ?? v.m };
}
export const matNeg = (v: MatValue): MatValue => ({
  m: mapMat(v.m, neg),
  scale: v.scale ? neg(v.scale) : num(-1),
  base: v.base ?? v.m,
});
export function matAdd(a: Mat, b: Mat, minus = false): Mat {
  sameSide(minus ? 'subtract' : 'add', a, b);
  return mapMat(a, (entry, r, c) => (minus ? sub : add)(entry, b[r][c]));
}
export function matMul(a: Mat, b: Mat): Mat {
  sameSide('multiply', a, b);
  return mapMat(a, (_, r, c) => a[r].map((entry, k) => mul(entry, b[k][c])).reduce(add));
}

/** The inverse as adjugate / det — singular matrices give NaN at evaluation
 *  time, like solve. */
export function inverseOf(m: Mat): Mat {
  const d = detOf(m);
  if (m.length === 2) {
    return [
      [div(m[1][1], d), div(neg(m[0][1]), d)],
      [div(neg(m[1][0]), d), div(m[0][0], d)],
    ];
  }
  const cof = (r: number, c: number): Expr => {
    const [r0, r1] = [0, 1, 2].filter(k => k !== r);
    const [c0, c1] = [0, 1, 2].filter(k => k !== c);
    const minor = sub(mul(m[r0][c0], m[r1][c1]), mul(m[r0][c1], m[r1][c0]));
    return (r + c) % 2 ? neg(minor) : minor;
  };
  return mapMat(m, (_, r, c) => div(cof(c, r), d));
}

/** Whole powers a symbolic product can afford. */
export const MAT_POWER_MAX = 8;
export function matPow(m: Mat, n: number): Mat {
  if (n === -1) return inverseOf(m);
  if (!Number.isInteger(n) || n < 0 || n > MAT_POWER_MAX) {
    throw new Error(
      `A matrix power is a whole number from 0 to ${MAT_POWER_MAX}, or -1 for the inverse — for a rotation by any angle write e^(th J).`,
    );
  }
  let out = identity(m.length);
  for (let k = 0; k < n; k++) out = matMul(out, m);
  return out;
}

/** [n]×, the matrix of v ↦ n × v: the generator of rotations about n. */
export const hatOf = (n: Expr[]): Mat => [
  [num(0), neg(n[2]), n[1]],
  [n[2], num(0), neg(n[0])],
  [neg(n[1]), n[0], num(0)],
];

const same = (a: Expr, b: Expr): boolean => exprKey(a) === exprKey(b);
const opposite = (a: Expr, b: Expr): boolean =>
  isNum(a) && isNum(b) ? a.value === -b.value : same(neg(a), b) || same(a, neg(b));

/**
 * e^M in closed form.
 *
 * 2×2, `[(p, -w), (w, p)]` — a rotation generator plus a multiple of I — is
 * e^p times the rotation by w. Any other 2×2 uses
 *   e^M = e^s (C I + S (M − s I)),  s = tr/2,  δ = s² − det,
 * with C = cosh √δ and S = sinh √δ / √δ, which continue to cos and sin / ·
 * for δ < 0: one formula for spirals, saddles and nodes alike, smooth across
 * δ = 0 — so e^(t A) (x0, y0) is the exact flow of (x', y') = A (x, y).
 *
 * 3×3 must be skew-symmetric — cross(n), or s cross(n) — and is Rodrigues'
 * rotation about n by |n|. (A general 3×3 exponential needs the roots of a
 * cubic; nothing here wants one.)
 */
export function expOf(v: MatValue): Mat {
  const scale = v.scale ?? num(1);
  const base = (v.base ?? v.m).map(row => row.map(settle));
  const eye = identity(base.length);
  if (base.length === 2) {
    const [[a, b], [c, d]] = base;
    if (same(a, d) && opposite(b, c)) {
      const angle = mul(scale, c);
      const grow = isNum(a) && a.value === 0 ? num(1) : fn('exp', mul(scale, a));
      const cos = mul(grow, fn('cos', angle));
      const sin = mul(grow, fn('sin', angle));
      return [
        [cos, neg(sin)],
        [sin, cos],
      ];
    }
    const m = v.m;
    const s = div(traceOf(m), num(2));
    const delta = sub(mul(s, s), detOf(m));
    const q = fn('sqrt', fn('abs', delta));
    // √δ guarded away from 0 where it divides (no branch may hold a 0/0,
    // taken or not), and S read off its series 1 + δ/6 + … across δ = 0.
    const qs = fn('max', q, num(1e-4));
    const real: Expr = { kind: 'ineq', op: '>=', l: delta, r: num(0) };
    const tiny: Expr = { kind: 'ineq', op: '<', l: fn('abs', delta), r: num(1e-6) };
    const C: Expr = { kind: 'piecewise', cases: [{ cond: real, value: fn('cosh', q) }], otherwise: fn('cos', q) };
    const S: Expr = {
      kind: 'piecewise',
      cases: [
        { cond: tiny, value: add(num(1), div(delta, num(6))) },
        { cond: real, value: div(fn('sinh', qs), qs) },
      ],
      otherwise: div(fn('sin', qs), qs),
    };
    const es = fn('exp', s);
    return mapMat(m, (entry, r, col) => mul(es, add(mul(C, eye[r][col]), mul(S, sub(entry, mul(s, eye[r][col]))))));
  }
  const skew = base.every((row, r) =>
    row.every((entry, c) => (r === c ? isNum(entry) && entry.value === 0 : opposite(entry, base[c][r]))),
  );
  if (!skew) {
    throw new Error('e^M for a 3×3 matrix needs a rotation generator: e^(th cross(n)) turns by th about the axis n.');
  }
  const w = [base[2][1], base[0][2], base[1][0]];
  const numeric = w.every(isNum);
  const len = numeric
    ? num(Math.hypot(...w.map(c => (c as Expr & { kind: 'num' }).value)))
    : fn('sqrt', w.map(c => mul(c, c)).reduce(add));
  // A zero axis turns nothing: the guard makes that the identity, not 0/0.
  const safe = numeric ? len : fn('max', len, num(1e-6));
  if (isNum(safe) && safe.value === 0) return eye;
  const angle = mul(scale, len);
  const first = div(fn('sin', angle), safe);
  const second = div(sub(num(1), fn('cos', angle)), mul(safe, safe));
  const squared = matMul(base, base);
  return mapMat(eye, (one, r, c) => add(add(one, mul(first, base[r][c])), mul(second, squared[r][c])));
}
