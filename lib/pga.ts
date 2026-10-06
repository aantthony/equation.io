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

/** A point, line or plane: an element of the algebra with the grade that
 *  says which. The grade comes from how it was made, never from which
 *  coefficients happen to be zero, so dragging never changes what it is. */
export interface Flat extends Pga {
  readonly grade: number;
}

/** The internal call a flat travels in, from lowering to classify: its
 *  dimension, its grade, then its coefficients. As a call, a list in a
 *  coefficient broadcasts over it like any other. */
export const PGA_CALL = '[pga]';
export function flatNode(f: Flat): Expr {
  return { kind: 'call', name: PGA_CALL, args: [num(f.dim), num(f.grade), ...f.data] };
}
export function flatOfNode(e: Expr): Flat | null {
  if (e.kind !== 'call' || e.name !== PGA_CALL) return null;
  const at = (k: number) => {
    const a = e.args[k];
    return a.kind === 'num' ? a.value : NaN;
  };
  return { dim: at(0) as Dim, grade: at(1), data: e.args.slice(2) };
}
export const isPoint = (f: Flat): boolean => f.grade === f.dim;

/**
 * What draws a flat, as an ordinary row would write it: a point its tuple
 * (an ideal one divides by 0 and draws nothing), a line of the plane or a
 * plane its implicit equation, a line of space the curve where two planes
 * through it cross. The two planes hold the line and the axis least along
 * it, and the direction perpendicular to both, so they never coincide.
 */
export function flatFigure(f: Flat): Expr {
  const v = (name: string): Expr => ({ kind: 'var', name });
  const xyz = ['x', 'y', 'z'].slice(0, f.dim).map(v);
  // Every coordinate stays in a flat of space, even times a 0: a line of
  // space whose equations had lost z would read as a point of the plane.
  const term = (c: Expr, k: number): Expr => (f.dim === 3 ? { kind: 'bin', op: '*', a: c, b: xyz[k] } : mul(c, xyz[k]));
  const zeroEq = (p: Pga): Expr => {
    const { normal, offset } = hyperplaneParts(p);
    return normal.reduce<Expr>(
      (s, c, k) => (f.dim === 3 ? { kind: 'bin', op: '+', a: s, b: term(c, k) } : add(s, term(c, k))),
      offset,
    );
  };
  if (isPoint(f)) return { kind: 'vec', items: pointCoords(f) };
  if (f.grade === 1) return { kind: 'eq', l: zeroEq(f), r: ZERO };
  // The axis d is least along: x when |d_x| is at most |d_y| and |d_z|,
  // else y when |d_y| is at most |d_z|, else z.
  const abs = lineDirection(f).map(c => call('abs', c));
  const pick = (conds: Expr[][], k: number): Expr =>
    conds.reduceRight<Expr>(
      (inner, [l, r]) => ({
        kind: 'piecewise',
        cases: [{ cond: { kind: 'ineq', op: '<=', l, r }, value: inner }],
        otherwise: ZERO,
      }),
      num(k),
    );
  const ax = pick(
    [
      [abs[0], abs[1]],
      [abs[0], abs[2]],
    ],
    1,
  );
  const ay = mul(sub(num(1), ax), pick([[abs[1], abs[2]]], 1));
  const axis = [ax, ay, sub(sub(num(1), ax), ay)];
  const first = regressivePga(f, idealPointPga(axis));
  const normal = hyperplaneParts(first).normal;
  const second = regressivePga(f, idealPointPga(normal));
  return {
    kind: 'eq',
    l: { kind: 'vec', items: [zeroEq(first), zeroEq(second)] },
    r: { kind: 'vec', items: [ZERO, ZERO] },
  };
}

/** `2x - y + 1`: a linear form from its coefficients, zero terms left out. */
function linearText(terms: ReadonlyArray<[number, string]>, constant: number, format: (v: number) => string): string {
  let out = '';
  const push = (value: number, name: string) => {
    if (value === 0) return;
    const mag = Math.abs(value);
    const body = name ? (mag === 1 ? name : `${format(mag)}${name}`) : format(mag);
    out += out ? (value < 0 ? ` - ${body}` : ` + ${body}`) : value < 0 ? `-${body}` : body;
  };
  for (const [value, name] of terms) push(value, name);
  push(constant, '');
  return out || '0';
}

/**
 * A flat read out from its coefficients' values: a point as (x, y), or `at
 * infinity, direction (1, 2)` when its weight is 0; a line of the plane as
 * y = m x + k (or x = k); a plane as z = … (or y = …, x = …); a line of
 * space by its point nearest the origin and its direction. Rounding leaves
 * 1e-17 where a coefficient cancels: a value that small beside the largest
 * is zero.
 */
export function flatText(
  f: { dim: Dim; grade: number },
  values: readonly number[],
  format: (v: number) => string,
): string {
  const floor = 1e-12 * Math.max(0, ...values.map(Math.abs).filter(Number.isFinite));
  const clean = values.map(v => (Math.abs(v) <= floor ? 0 : v));
  if (clean.some(v => !Number.isFinite(v))) return 'undefined';
  if (clean.every(v => v === 0)) return 'undefined';
  const flat: Flat = { ...f, data: clean.map(num) };
  const tuple = (vs: readonly number[]) => `(${vs.map(v => (v < 0 ? `-${format(-v)}` : format(v))).join(', ')})`;
  const read = (e: Expr): number => (e.kind === 'num' ? e.value : NaN);
  const small = (vs: readonly number[]) => {
    const top = Math.max(...vs.map(Math.abs));
    return vs.map(v => (Math.abs(v) <= 1e-12 * top ? 0 : v));
  };
  if (isPoint(flat)) {
    const { coords, weight: w } = pointParts(flat);
    const c = coords.map(read);
    if (read(w) === 0) {
      // A direction has no size: scaled so its first component is 1.
      const lead = c.find(v => v !== 0) ?? 1;
      return `at infinity, direction ${tuple(small(c.map(v => v / lead)))}`;
    }
    return tuple(c.map(v => v / read(w)));
  }
  if (f.grade === 1) {
    const { normal, offset } = hyperplaneParts(flat);
    const n = normal.map(read);
    const d = read(offset);
    const names = ['x', 'y', 'z'].slice(0, f.dim);
    // Solve for the last axis the normal has: z = …, then y = …, then x = ….
    const k = n.reduce((last, c, j) => (c !== 0 ? j : last), -1);
    if (k < 0) return 'at infinity';
    const terms = n.flatMap((c, j): Array<[number, string]> => (j < k ? [[-c / n[k], names[j]]] : []));
    return `${names[k]} = ${linearText(terms, -d / n[k], format)}`;
  }
  const dir = small(lineDirection(flat).map(read));
  if (dir.every(v => v === 0)) return 'at infinity';
  const at = small(pointCoords(nearestOrigin(flat)).map(read));
  return `through ${tuple(at)}, direction ${tuple(dir)}`;
}

const sqrt = (e: Expr): Expr => call('sqrt', e);
const dotOf = (u: readonly Expr[], v: readonly Expr[]): Expr => u.reduce<Expr>((s, c, k) => add(s, mul(c, v[k])), ZERO);
/** |u × v|: of 2D vectors the size of their 2D cross product. */
function crossSize(u: readonly Expr[], v: readonly Expr[]): Expr {
  if (u.length === 2) return call('abs', sub(mul(u[0], v[1]), mul(u[1], v[0])));
  const c = [0, 1, 2].map(k => sub(mul(u[(k + 1) % 3], v[(k + 2) % 3]), mul(u[(k + 2) % 3], v[(k + 1) % 3])));
  return sqrt(dotOf(c, c));
}
/** `cond ? yes : no`, where cond is `l > r`. */
const above = (l: Expr, r: Expr, yes: Expr, no: Expr): Expr => ({
  kind: 'piecewise',
  cases: [{ cond: { kind: 'ineq', op: '>', l, r }, value: yes }],
  otherwise: no,
});
/** Whether a flat's sizes say it is ideal, relative to the sizes it came from. */
const PARALLEL = 1e-18;

/** The direction a flat runs in that an angle is measured by: a line's
 *  direction, a hyperplane's normal. */
const heading = (f: Flat): Expr[] => (f.grade === 1 ? hyperplaneParts(f).normal : lineDirection(f));

/**
 * The distance between two flats, one of which may be a point: from a
 * point, the size of its join with the other over both weights; between
 * skew lines of space, |L ∨ M| over |d × e|; between flats that cross, 0,
 * and between parallel ones the distance from the first's point nearest
 * the origin to the second.
 */
export function flatDistance(a: Flat, b: Flat): Expr {
  if (isPoint(b) && !isPoint(a)) return flatDistance(b, a);
  if (isPoint(a)) {
    if (isPoint(b)) {
      const [p, q] = [pointCoords(a), pointCoords(b)];
      return sqrt(p.reduce<Expr>((s, c, k) => add(s, mul(sub(c, q[k]), sub(c, q[k]))), ZERO));
    }
    const w = call('abs', weight(a));
    const j = regressivePga(a, b);
    // A hyperplane: the join is a number. A line of space: a plane, by its size.
    const size = b.grade === 1 ? call('abs', j.data[0]) : sqrt(euclideanNormSq(j));
    return div(size, mul(w, sqrt(euclideanNormSq(b))));
  }
  const apart = flatDistance({ ...nearestOrigin(a), grade: a.dim }, b);
  if (a.dim === 3 && a.grade === 2 && b.grade === 2) {
    const [d, e] = [lineDirection(a), lineDirection(b)];
    const sin = crossSize(d, e);
    const skew = div(call('abs', regressivePga(a, b).data[0]), sin);
    return above(mul(sin, sin), mul(num(PARALLEL), mul(dotOf(d, d), dotOf(e, e))), skew, apart);
  }
  // Two flats that are not both lines of space meet in something finite
  // unless they are parallel.
  const m = outerPga(a, b);
  return above(euclideanNormSq(m), mul(num(PARALLEL), mul(euclideanNormSq(a), euclideanNormSq(b))), ZERO, apart);
}

/** The acute angle between two lines or planes, 0 to π/2: between their
 *  directions or normals, and from π/2 down for a line and a plane. */
export function flatAngle(a: Flat, b: Flat): Expr {
  const [u, v] = [heading(a), heading(b)];
  const between = call('atan2', crossSize(u, v), call('abs', dotOf(u, v)));
  // A line of space against a plane: the normal's angle, turned to the plane's.
  const mixed = a.dim === 3 && a.grade !== b.grade;
  return mixed ? sub(num(Math.PI / 2), between) : between;
}
