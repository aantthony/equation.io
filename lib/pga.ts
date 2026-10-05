/**
 * Projective geometric algebra — Cl(2,0,1) for the plane and Cl(3,0,1) for
 * space (docs/pga.md). The algebra of lib/clifford.ts with one more basis
 * vector, e0, whose square is 0: in it a plane of space (a line of the
 * plane) is a vector, a line of space a bivector, and a point the
 * complement of a vector, so the outer product ∧ intersects (meet) and the
 * regressive product ∨ spans (join).
 *
 * Blade k is a bitmask as in clifford.ts — bit 0 e_x, bit 1 e_y, bit 2 e_z
 * in space — with e0 the next bit up: 4 in the plane, 8 in space. A plane
 * a x + b y + c z + d = 0 is a e_x + b e_y + c e_z + d e0 (a line of the
 * plane leaves out c e_z), and the point (x, y, z) is J(x e_x + y e_y +
 * z e_z + e0), J the complement below, so p ∧ P = (a x + b y + c z + d) I:
 * zero exactly when P lies on p.
 *
 * Like multivectors, these vanish during lowering: every operation builds
 * the scalar expressions of the result's coefficients.
 */
import { add, div, mul, neg, sub } from './diff.ts';
import type { Expr } from './expr.ts';

export type Dim = 2 | 3;

/** An element of the projective algebra of the plane or space: 2^(dim+1)
 *  coefficients, indexed by blade bitmask. */
export interface Pga {
  readonly dim: Dim;
  readonly data: readonly Expr[];
}

const num = (value: number): Expr => ({ kind: 'num', value });
const ZERO = num(0);
const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const isZero = (e: Expr): boolean => e.kind === 'num' && e.value === 0;

/** The bit of e0, and the number of blades, of the algebra over `dim`. */
export const e0Bit = (dim: Dim): number => 1 << dim;
const size = (dim: Dim): number => 1 << (dim + 1);

export function popcount(k: number): number {
  let n = 0;
  for (let x = k; x; x &= x - 1) n++;
  return n;
}

/** The sign of the product of blades a and b: (−1)^(swaps to sort them). */
function bladeSign(a: number, b: number): number {
  let swaps = 0;
  for (let x = a >> 1; x; x >>= 1) swaps += popcount(x & b);
  return swaps & 1 ? -1 : 1;
}

export const zeroPga = (dim: Dim): Pga => ({ dim, data: Array.from({ length: size(dim) }, () => ZERO) });

function fromEntries(dim: Dim, entries: ReadonlyArray<[number, Expr]>): Pga {
  const data = Array.from({ length: size(dim) }, () => ZERO);
  for (const [k, c] of entries) data[k] = c;
  return { dim, data };
}

/** Sum the products of blades whose pair passes `keep`; a pair sharing e0
 *  is dropped, as e0² = 0. The one loop behind every product. */
function product(a: Pga, b: Pga, keep: (x: number, y: number) => boolean): Pga {
  if (a.dim !== b.dim) throw new Error('A flat of the plane and one of space do not combine — give the points a z.');
  const e0 = e0Bit(a.dim);
  const out: Expr[] = a.data.map(() => ZERO);
  a.data.forEach((ca, i) => {
    if (isZero(ca)) return;
    b.data.forEach((cb, j) => {
      if (isZero(cb) || i & j & e0 || !keep(i, j)) return;
      const term = mul(ca, cb);
      out[i ^ j] = bladeSign(i, j) > 0 ? add(out[i ^ j], term) : sub(out[i ^ j], term);
    });
  });
  return { dim: a.dim, data: out };
}

/** The geometric product: e_x² = e_y² = e_z² = 1, e0² = 0. */
export const geometricPga = (a: Pga, b: Pga): Pga => product(a, b, () => true);
/** The outer product — the meet: the part whose grades add. */
export const outerPga = (a: Pga, b: Pga): Pga => product(a, b, (i, j) => (i & j) === 0);
/** The inner product: the part of grade |grade(a) − grade(b)|, where one
 *  blade lies inside the other. */
export const innerPga = (a: Pga, b: Pga): Pga => product(a, b, (i, j) => (i & j) === i || (i & j) === j);

export const addPga = (a: Pga, b: Pga, minus = false): Pga => ({
  dim: a.dim,
  data: a.data.map((c, k) => (minus ? sub : add)(c, b.data[k])),
});
export const scalePga = (a: Pga, s: Expr): Pga => ({ dim: a.dim, data: a.data.map(c => mul(s, c)) });

/** Reversion: grade k flips when k mod 4 is 2 or 3. */
export const reversePga = (a: Pga): Pga => ({
  dim: a.dim,
  data: a.data.map((c, k) => (popcount(k) % 4 >= 2 ? neg(c) : c)),
});

/** The grade-k part. */
export const gradePartPga = (a: Pga, k: number): Pga => ({
  dim: a.dim,
  data: a.data.map((c, blade) => (popcount(blade) === k ? c : ZERO)),
});

/** The sign s_k with e_k ∧ s_k e_{~k} = +I, I the blade of every bit. */
const complementSign = (k: number, full: number): number => bladeSign(k, full & ~k);

/**
 * The complement J: each blade to the blade of the bits it lacks, signed so
 * that e_k ∧ J(e_k) = I. The metric is degenerate, so this — not A I⁻¹ — is
 * the duality of PGA. J of a vector (x, y, z, w) is the point (x, y, z)/w.
 */
export function complement(a: Pga): Pga {
  const full = size(a.dim) - 1;
  // J(e_k) = s_k e_{~k}, so J(a) at m is s_{~m} a(~m).
  return { dim: a.dim, data: a.data.map((_, m) => signed(complementSign(full & ~m, full), a.data[full & ~m])) };
}
/** The inverse of J: J⁻¹(e_{~k}) = s_k e_k. */
export function uncomplement(a: Pga): Pga {
  const full = size(a.dim) - 1;
  return { dim: a.dim, data: a.data.map((_, k) => signed(complementSign(k, full), a.data[full & ~k])) };
}
const signed = (s: number, c: Expr): Expr => (s < 0 ? neg(c) : c);

/** The regressive product — the join: J⁻¹(J(a) ∧ J(b)), the span of a and b. */
export const regressivePga = (a: Pga, b: Pga): Pga => uncomplement(outerPga(complement(a), complement(b)));

/** The vector a e_x + b e_y (+ c e_z) + d e0: a line of the plane, a plane of space. */
export function hyperplane(normal: readonly Expr[], offset: Expr): Pga {
  const dim = normal.length as Dim;
  return fromEntries(dim, [...normal.map((c, k): [number, Expr] => [1 << k, c]), [e0Bit(dim), offset]]);
}

/** The point at `coords` (2 or 3 of them), of weight 1. */
export const pointPga = (coords: readonly Expr[]): Pga => complement(hyperplane(coords, num(1)));
/** The ideal point in direction `dir`: a point of weight 0. */
export const idealPointPga = (dir: readonly Expr[]): Pga => complement(hyperplane(dir, ZERO));

/** A point's weight: 0 for an ideal point. */
export const weight = (p: Pga): Expr => uncomplement(p).data[e0Bit(p.dim)];
/** A point's homogeneous coordinates: what it divides by its weight to be (x, y, z). */
export function pointParts(p: Pga): { coords: Expr[]; weight: Expr } {
  const v = uncomplement(p);
  return { coords: Array.from({ length: p.dim }, (_, k) => v.data[1 << k]), weight: v.data[e0Bit(p.dim)] };
}
/** A finite point as the tuple it is. */
export function pointCoords(p: Pga): Expr[] {
  const { coords, weight: w } = pointParts(p);
  return coords.map(c => div(c, w));
}

/** The squared size of the part without e0: what a flat normalises by. */
export function euclideanNormSq(a: Pga): Expr {
  const e0 = e0Bit(a.dim);
  return a.data.reduce<Expr>((s, c, k) => (k & e0 || isZero(c) ? s : add(s, mul(c, c))), ZERO);
}

/** The direction of a line, of the plane or of space: where it meets the
 *  ideal plane (line) e0, read as a vector. For join(A, B) it is B − A. */
export function lineDirection(l: Pga): Expr[] {
  const ideal = outerPga(l, fromEntries(l.dim, [[e0Bit(l.dim), num(1)]]));
  // The sign that makes join(A, B) run from A to B.
  return pointParts(ideal).coords.map(c => (l.dim === 3 ? neg(c) : c));
}

/** A hyperplane's normal (a, b[, c]) and offset d, for a x + b y + c z + d = 0. */
export function hyperplaneParts(p: Pga): { normal: Expr[]; offset: Expr } {
  return { normal: Array.from({ length: p.dim }, (_, k) => p.data[1 << k]), offset: p.data[e0Bit(p.dim)] };
}

/** The point of a flat nearest the origin: the origin projected onto it. */
export const nearestOrigin = (flat: Pga): Pga => project(pointPga(Array.from({ length: flat.dim }, () => ZERO)), flat);

/** X ↦ M X M̃: a motor moving X, or a flat reflecting it (up to sign). */
export const sandwich = (m: Pga, x: Pga): Pga => geometricPga(geometricPga(m, x), reversePga(m));

/** ⟨b b̃⟩₀: |b|² for a plane or a line, its weight squared for a point. */
const selfProduct = (b: Pga): Expr => geometricPga(b, reversePga(b)).data[0];

/** a projected onto b: (a · b) b̃ / ⟨b b̃⟩₀ — the point of a line nearest a
 *  point, the shadow of a line on a plane, the plane through a point
 *  parallel to a plane. */
export function project(a: Pga, b: Pga): Pga {
  return scalePga(geometricPga(innerPga(a, b), reversePga(b)), div(num(1), selfProduct(b)));
}

/** a reflected in b: b a b̃ / ⟨b b̃⟩₀. A point reflected in a point, line or
 *  plane is the point; a flat comes back the same set, its orientation
 *  aside. */
export const reflect = (a: Pga, b: Pga): Pga => scalePga(sandwich(b, a), div(num(1), selfProduct(b)));

/** The pseudoscalar I, the blade of every bit. */
const pseudoscalar = (dim: Dim): Pga => fromEntries(dim, [[size(dim) - 1, num(1)]]);

/**
 * e^B for a bivector B: the motor that screws about B's line. B's
 * Euclidean part (no e0) squares to −a², a its size; the rest of B² is a
 * multiple π I of the pseudoscalar, zero for a simple B and always in the
 * plane. With I² = 0, a + δI (δ = −π/2a) behaves as a dual number, so
 *   e^B = cos a + sinc(a) B + (π/2)(sinc(a) I + h(a) B I),
 * h(a) = (sin a − a cos a)/a³, which tends to 1/3 as a → 0. With no
 * Euclidean part, B is a translation and e^B = 1 + B.
 */
export function expPga(b: Pga): Pga {
  const dim = b.dim;
  const e0 = e0Bit(dim);
  const biv = gradePartPga(b, 2);
  if (b.data.some((c, k) => !isZero(c) && popcount(k) !== 2)) {
    throw new Error('e^ takes a bivector of the projective algebra: a line, scaled by half the turn.');
  }
  const euclid = biv.data.filter((c, k) => !(k & e0) && !isZero(c));
  const one = fromEntries(dim, [[0, num(1)]]);
  if (!euclid.length) return addPga(one, biv);
  const a = euclid.length === 1 ? call('abs', euclid[0]) : call('sqrt', euclidSum(euclid));
  const sinc = call('sinc', a);
  let out = addPga(fromEntries(dim, [[0, call('cos', a)]]), scalePga(biv, sinc));
  const pi = dim === 3 ? geometricPga(biv, biv).data[size(dim) - 1] : ZERO;
  if (!isZero(pi)) {
    const h: Expr = {
      kind: 'piecewise',
      cases: [
        {
          cond: { kind: 'ineq', op: '>', l: a, r: num(1e-3) },
          value: div(sub(call('sin', a), mul(a, call('cos', a))), mul(a, mul(a, a))),
        },
      ],
      otherwise: sub(num(1 / 3), div(mul(a, a), num(30))),
    };
    const i = pseudoscalar(dim);
    const dual = addPga(scalePga(i, sinc), scalePga(geometricPga(biv, i), h));
    out = addPga(out, scalePga(dual, div(pi, num(2))));
  }
  return out;
}
const euclidSum = (cs: readonly Expr[]): Expr => cs.reduce<Expr>((s, c) => add(s, mul(c, c)), ZERO);

/** What a flat of a given grade is, in the plane or in space. */
export function flatName(dim: Dim, grade: number): 'point' | 'line' | 'plane' | null {
  if (dim === 2) return grade === 1 ? 'line' : grade === 2 ? 'point' : null;
  return grade === 1 ? 'plane' : grade === 2 ? 'line' : grade === 3 ? 'point' : null;
}
