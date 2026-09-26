/**
 * Multivectors — the Clifford algebra of the plane and of space, Cl(2) and
 * Cl(3) with the Euclidean metric (docs/clifford.md).
 *
 * A multivector is 2ⁿ symbolic coefficients, one per basis blade. Blade k is
 * the bitmask of its unit vectors: bit 0 is e_x, bit 1 e_y, bit 2 e_z, so
 * 3 is e_xy and 7 the pseudoscalar e_xyz. Like tensors (tensor.ts) they
 * vanish during geometry lowering: every operation builds the scalar
 * expressions of the result's coefficients, so a slider, t or a list inside a
 * coefficient flows through to the end.
 *
 * Quaternions are the even part of Cl(3): i = e_zy, j = e_xz, k = e_yx, so
 * i² = j² = k² = ijk = −1, and the unit quaternion cos(θ/2) + sin(θ/2) n̂
 * (n̂ read as i, j, k) is the rotor that turns by θ about n̂ in R v R̃.
 */
import { add, div, mul, neg, sub } from './diff.ts';
import type { Expr } from './expr.ts';

export type Dim = 2 | 3;

export interface Multivector {
  readonly dim: Dim;
  /** 2^dim coefficients, indexed by blade bitmask. */
  readonly data: readonly Expr[];
  /** Written as a quaternion (quat(…) or products of them): read out in i, j, k. */
  readonly quat?: true;
}

const num = (value: number): Expr => ({ kind: 'num', value });
const ZERO = num(0);
const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const isZero = (e: Expr): boolean => e.kind === 'num' && e.value === 0;

export const bladeGrade = (blade: number): number => (blade & 1) + ((blade >> 1) & 1) + ((blade >> 2) & 1);

/** The sign of the product of blades a and b: (−1)^(swaps to sort them). */
export function bladeSign(a: number, b: number): number {
  let swaps = 0;
  for (let x = a >> 1; x; x >>= 1) swaps += bladeGrade(x & b);
  return swaps & 1 ? -1 : 1;
}

/**
 * The blades as the readout and the input spell them: e_zx rather than e_xz
 * in space, the cyclic order that makes e_yz, e_zx, e_xy the duals of e_x,
 * e_y, e_z. `sign` is the stored blade's sign in that spelling.
 */
const SPELLING: Readonly<Record<Dim, ReadonlyArray<{ blade: number; name: string; sign: number }>>> = {
  2: [
    { blade: 0, name: '', sign: 1 },
    { blade: 1, name: 'e_x', sign: 1 },
    { blade: 2, name: 'e_y', sign: 1 },
    { blade: 3, name: 'e_xy', sign: 1 },
  ],
  3: [
    { blade: 0, name: '', sign: 1 },
    { blade: 1, name: 'e_x', sign: 1 },
    { blade: 2, name: 'e_y', sign: 1 },
    { blade: 4, name: 'e_z', sign: 1 },
    { blade: 3, name: 'e_xy', sign: 1 },
    { blade: 6, name: 'e_yz', sign: 1 },
    { blade: 5, name: 'e_zx', sign: -1 },
    { blade: 7, name: 'e_xyz', sign: 1 },
  ],
};

/**
 * A blade written as a name — e_xy, e_yx (= −e_xy), e_zx, e_xyz — or null.
 * Single vectors are e_x, e_y, e_z, which stay the vectors they are.
 * Like them, a blade is always in space.
 */
export function bladeByName(name: string): Multivector | null {
  const m = /^e_([xyz]{2,3})$/.exec(name);
  if (!m) return null;
  const axes = [...m[1]].map(c => 'xyz'.indexOf(c));
  if (new Set(axes).size !== axes.length) return null;
  // Sort the axes, counting swaps: each one flips the sign.
  let sign = 1;
  const order = [...axes];
  for (let i = 0; i < order.length; i++)
    for (let j = 0; j + 1 < order.length - i; j++)
      if (order[j] > order[j + 1]) {
        [order[j], order[j + 1]] = [order[j + 1], order[j]];
        sign = -sign;
      }
  const blade = order.reduce((b, a) => b | (1 << a), 0);
  // Always in space, as e_x is: (1, 0) ⟑ (0, 1) is the plane's own e_xy.
  const data = Array.from({ length: 8 }, (_, k) => (k === blade ? num(sign) : ZERO));
  return { dim: 3, data };
}

export const scalarMv = (e: Expr, dim: Dim = 2): Multivector => ({
  dim,
  data: Array.from({ length: 1 << dim }, (_, k) => (k === 0 ? e : ZERO)),
});

/** A point or vector as a grade-1 multivector. */
export function vectorMv(items: readonly Expr[]): Multivector {
  if (items.length !== 2 && items.length !== 3) {
    throw new Error(`A vector in a geometric product has 2 or 3 components, not ${items.length}.`);
  }
  const dim = items.length as Dim;
  const data = Array.from({ length: 1 << dim }, () => ZERO);
  items.forEach((c, k) => (data[1 << k] = c));
  return { dim, data };
}

/** w + x i + y j + z k. */
export function quaternion(w: Expr, x: Expr, y: Expr, z: Expr): Multivector {
  const data = Array.from({ length: 8 }, () => ZERO);
  data[0] = w;
  data[6] = neg(x); // i = e_zy = −e_yz
  data[5] = y; // j = e_xz
  data[3] = neg(z); // k = e_yx = −e_xy
  return { dim: 3, data, quat: true };
}

/** A quaternion's w, x, y, z, from the even part of a multivector. */
export function quaternionParts(a: Multivector): [Expr, Expr, Expr, Expr] {
  const d = widen(a, 3).data;
  return [d[0], neg(d[6]), d[5], neg(d[3])];
}

/** The same multivector in space: the plane's blades keep their bitmasks. */
function widen(a: Multivector, dim: Dim): Multivector {
  if (a.dim === dim) return a;
  return { ...a, dim, data: Array.from({ length: 1 << dim }, (_, k) => a.data[k] ?? ZERO) };
}
const common = (a: Multivector, b: Multivector): [Multivector, Multivector] => {
  const dim: Dim = a.dim === 3 || b.dim === 3 ? 3 : 2;
  return [widen(a, dim), widen(b, dim)];
};
/** Only products of quaternions stay written as quaternions, and only while even. */
function quatFlag(data: readonly Expr[], ...from: Multivector[]): { quat?: true } {
  if (!from.every(m => m.quat || isScalar(m))) return {};
  if (!from.some(m => m.quat)) return {};
  return data.every((c, k) => bladeGrade(k) % 2 === 0 || isZero(c)) ? { quat: true } : {};
}

/** Whether every coefficient beyond grade 0 is written as zero. */
export const isScalar = (a: Multivector): boolean => a.data.every((c, k) => k === 0 || isZero(c));
/** The grades whose coefficients are not all written as zero. */
export const gradesOf = (a: Multivector): Set<number> =>
  new Set(a.data.flatMap((c, k) => (isZero(c) ? [] : [bladeGrade(k)])));

export function mvAdd(a: Multivector, b: Multivector, minus = false): Multivector {
  const [x, y] = common(a, b);
  const data = x.data.map((c, k) => (minus ? sub : add)(c, y.data[k]));
  return { dim: x.dim, data, ...quatFlag(data, a, b) };
}
export const mvScale = (a: Multivector, s: Expr): Multivector => ({ ...a, data: a.data.map(c => mul(s, c)) });
export const mvNeg = (a: Multivector): Multivector => ({ ...a, data: a.data.map(neg) });

/** Sum the products of blades whose pair passes `keep`: the one loop behind
 *  the geometric, outer and inner products. */
function product(a: Multivector, b: Multivector, keep: (x: number, y: number) => boolean): Multivector {
  const [x, y] = common(a, b);
  const out: Expr[] = x.data.map(() => ZERO);
  x.data.forEach((ca, i) => {
    if (isZero(ca)) return;
    y.data.forEach((cb, j) => {
      if (isZero(cb) || !keep(i, j)) return;
      const term = mul(ca, cb);
      out[i ^ j] = bladeSign(i, j) > 0 ? add(out[i ^ j], term) : sub(out[i ^ j], term);
    });
  });
  return { dim: x.dim, data: out, ...quatFlag(out, a, b) };
}

/** The geometric product: e_i e_i = 1, e_i e_j = −e_j e_i. */
export const geometric = (a: Multivector, b: Multivector): Multivector => product(a, b, () => true);
/** The outer product: the part of the geometric product whose grades add. */
export const outerMv = (a: Multivector, b: Multivector): Multivector => product(a, b, (i, j) => (i & j) === 0);
/** The left contraction a ⌋ b: the part of grade grade(b) − grade(a). */
export const innerMv = (a: Multivector, b: Multivector): Multivector => product(a, b, (i, j) => (i & j) === i);

/** Flip each grade k whose sign(k) is −1. */
const gradeSigns = (a: Multivector, sign: (k: number) => number): Multivector => ({
  ...a,
  data: a.data.map((c, k) => (sign(bladeGrade(k)) < 0 ? neg(c) : c)),
});
/** Reversion Ã: the order of every blade's vectors reversed. */
export const reverse = (a: Multivector): Multivector => gradeSigns(a, k => (k % 4 === 2 || k % 4 === 3 ? -1 : 1));
/** Clifford conjugation Ā: reversion and grade involution together. */
export const conjugate = (a: Multivector): Multivector => gradeSigns(a, k => (k % 4 === 1 || k % 4 === 2 ? -1 : 1));

/** The grade-k part. */
export function gradePart(a: Multivector, k: number): Multivector {
  if (!Number.isInteger(k) || k < 0 || k > a.dim) {
    throw new Error(
      `grade takes a grade from 0 to ${a.dim} for a multivector of ${a.dim === 2 ? 'the plane' : 'space'}.`,
    );
  }
  return { dim: a.dim, data: a.data.map((c, blade) => (bladeGrade(blade) === k ? c : ZERO)) };
}

/** |A|² = ⟨A Ã⟩₀, the sum of the squared coefficients in a Euclidean algebra. */
export function normSquared(a: Multivector): Expr {
  return a.data.reduce<Expr>((s, c) => (isZero(c) ? s : add(s, mul(c, c))), ZERO);
}

/** The pseudoscalar of the multivector's space. */
const pseudoscalar = (dim: Dim): Multivector => ({
  dim,
  data: Array.from({ length: 1 << dim }, (_, k) => (k === (1 << dim) - 1 ? num(1) : ZERO)),
});

/** The dual A I⁻¹: in space e_xy ↦ e_z, and a vector ↦ the plane it is normal to. */
export function dual(a: Multivector): Multivector {
  const i = pseudoscalar(a.dim);
  // I⁻¹ = Ĩ / |I|², and |I| = 1.
  return geometric(a, reverse(i));
}

/**
 * The inverse. In the plane A Ā is a number; in space it lies in the centre,
 * s + p I with I² = −1, so A⁻¹ = Ā (s − p I) / (s² + p²) — for every
 * invertible multivector, not only versors. (The other grades of A Ā
 * cancel identically; only s and p are read.)
 */
export function inverse(a: Multivector): Multivector {
  const bar = conjugate(a);
  const n = geometric(a, bar);
  const s = n.data[0];
  if (a.dim === 2) return { ...mvScale(bar, div(num(1), s)), ...quatFlag(bar.data, a) };
  const p = n.data[7];
  const centre = { dim: 3 as const, data: n.data.map((_, k) => (k === 0 ? s : k === 7 ? neg(p) : ZERO)) };
  const out = mvScale(geometric(bar, centre), div(num(1), add(mul(s, s), mul(p, p))));
  return { ...out, ...quatFlag(out.data, a) };
}

/** A whole power, n from −8 to 8: repeated products, a negative through the inverse. */
export function mvPower(a: Multivector, n: number): Multivector {
  if (!Number.isInteger(n) || Math.abs(n) > 8) {
    throw new Error('A multivector power is a whole number from −8 to 8 — for e^A write e^(…).');
  }
  const base = n < 0 ? inverse(a) : a;
  let out: Multivector = { ...scalarMv(num(1), a.dim), ...(a.quat ? { quat: true as const } : {}) };
  for (let k = 0; k < Math.abs(n); k++) out = geometric(out, base);
  return out;
}

/** sqrt of a sum of squares, left as |c| for one coefficient. */
function magnitude(coeffs: readonly Expr[]): Expr {
  if (coeffs.length === 1) return call('abs', coeffs[0]);
  return call(
    'sqrt',
    coeffs.reduce<Expr>((s, c) => add(s, mul(c, c)), ZERO),
  );
}

/**
 * e^A. Scalars and the pseudoscalar of space commute with everything, so
 * they split off as e^s and cos p + I sin p. What is left must be a bivector,
 * which squares to −|B|² (every bivector of the plane or space is a blade),
 * so e^B = cos|B| + B sin|B|/|B|; or a vector, which squares to |v|², so
 * e^v = cosh|v| + v sinh|v|/|v|. A vector and a bivector together have no
 * closed form here.
 */
export function mvExp(a: Multivector): Multivector {
  const dim = a.dim;
  const top = (1 << dim) - 1;
  const at = (grade: number) =>
    a.data.map((c, k) => (bladeGrade(k) === grade && k !== 0 && !(dim === 3 && k === top) ? c : ZERO));
  const vec = at(1);
  const biv = at(2);
  const hasVec = vec.some(c => !isZero(c));
  const hasBiv = biv.some(c => !isZero(c));
  if (hasVec && hasBiv) {
    throw new Error('e^ takes a multivector whose non-scalar part is a bivector (a rotor) or a vector, not both.');
  }
  const parts = (hasVec ? vec : biv).filter(c => !isZero(c));
  let out: Expr[];
  if (!parts.length) {
    out = a.data.map((_, k) => (k === 0 ? num(1) : ZERO));
  } else if (parts.length === 1) {
    // One blade: cos b + B̂ sin b, or cosh b + v̂ sinh b, with no magnitude to take.
    const [even, odd] = hasVec ? ['cosh', 'sinh'] : ['cos', 'sin'];
    out = a.data.map((_, k) => {
      if (k === 0) return call(even, parts[0]);
      const own = (hasVec ? vec : biv)[k];
      return isZero(own) ? ZERO : call(odd, own);
    });
  } else {
    const r = magnitude(parts);
    // sin r / r is sinc; sinh r / r needs its limit 1 at r = 0 written in.
    const ratio: Expr = hasVec
      ? {
          kind: 'piecewise',
          cases: [{ cond: { kind: 'ineq', op: '>', l: r, r: ZERO } as Expr, value: div(call('sinh', r), r) }],
          otherwise: num(1),
        }
      : call('sinc', r);
    out = a.data.map((_, k) => {
      if (k === 0) return call(hasVec ? 'cosh' : 'cos', r);
      const own = (hasVec ? vec : biv)[k];
      return isZero(own) ? ZERO : mul(ratio, own);
    });
  }
  let result: Multivector = { dim, data: out };
  const s = a.data[0];
  if (!isZero(s)) result = mvScale(result, call('exp', s));
  const p = dim === 3 ? a.data[top] : ZERO;
  if (!isZero(p)) {
    const turn = {
      dim,
      data: result.data.map((_, k) => (k === 0 ? call('cos', p) : k === top ? call('sin', p) : ZERO)),
    };
    result = geometric(result, turn);
  }
  return { ...result, ...quatFlag(result.data, a) };
}

/**
 * The spherical interpolation from a to b at u ∈ [0, 1], along the shorter
 * arc: both are normalised, and b turned to the same side as a (q and −q are
 * one rotation). sin(uΩ)/sin Ω is written u sinc(uΩ)/sinc(Ω), which stays
 * finite as a and b meet.
 */
export function slerp(a: Multivector, b: Multivector, u: Expr): Multivector {
  const [x, y] = common(a, b);
  const nx = call('sqrt', normSquared(x));
  const ny = call('sqrt', normSquared(y));
  const dot = x.data.reduce<Expr>((s, c, k) => add(s, mul(c, y.data[k])), ZERO);
  const cos = div(dot, mul(nx, ny));
  const side: Expr = {
    kind: 'piecewise',
    cases: [{ cond: { kind: 'ineq', op: '<', l: cos, r: ZERO } as Expr, value: num(-1) }],
    otherwise: num(1),
  };
  const omega = call('acos', call('min', call('abs', cos), num(1)));
  const v = sub(num(1), u);
  const wa = div(mul(v, call('sinc', mul(v, omega))), mul(call('sinc', omega), nx));
  const wb = div(mul(mul(side, u), call('sinc', mul(u, omega))), mul(call('sinc', omega), ny));
  const out = mvAdd(mvScale(x, wa), mvScale(y, wb));
  return { ...out, ...quatFlag(out.data, a, b) };
}

/**
 * The matrix of v ↦ ⟨A v A⁻¹⟩₁, column j the image of e_j: for a rotor or a
 * unit quaternion the rotation it makes, for a vector n the reflection
 * along n. A⁻¹ is written Ã / |A|², which is the inverse of every versor.
 */
export function sandwichMatrix(a: Multivector, dim: Dim): Expr[][] {
  const x = widen(a, dim === 3 || a.dim === 3 ? 3 : 2);
  if (x.dim > dim) throw new Error('A multivector of space cannot turn a point of the plane — give the point a z.');
  const n2 = normSquared(x);
  const rev = reverse(x);
  const cols = Array.from({ length: dim }, (_, j) => {
    const ej = vectorMv(Array.from({ length: dim }, (_, k) => num(k === j ? 1 : 0)));
    const img = geometric(geometric(x, ej), rev);
    return Array.from({ length: dim }, (_, i) => div(img.data[1 << i], n2));
  });
  return Array.from({ length: dim }, (_, i) => cols.map(col => col[i]));
}

/** The internal call a multivector travels in, from lowering to classify:
 *  its dimension, a quaternion flag, then its 2^dim coefficients. As a call,
 *  a list in a coefficient broadcasts over it like any other. */
export const MV_CALL = '[mv]';
export function mvNode(a: Multivector): Expr {
  return { kind: 'call', name: MV_CALL, args: [num(a.dim), num(a.quat ? 1 : 0), ...a.data] };
}
export function mvOfNode(e: Expr): Multivector | null {
  if (e.kind !== 'call' || e.name !== MV_CALL) return null;
  const dim = (e.args[0].kind === 'num' ? e.args[0].value : 2) as Dim;
  const quat = e.args[1].kind === 'num' && e.args[1].value === 1;
  return { dim, data: e.args.slice(2), ...(quat ? { quat: true as const } : {}) };
}

/** The blades a readout lists, in their written order: [blade, name, sign]. */
export const readoutBlades = (dim: Dim) => SPELLING[dim];

/**
 * `1 + 2 e_xy - e_zx`, or `1 + 2i + 3j - 4k` for a quaternion, from the
 * coefficients' values. Terms that are zero are left out; all zero is `0`.
 */
export function mvText(
  a: { dim: Dim; quat?: boolean },
  values: readonly number[],
  format: (v: number) => string,
): string {
  const terms: Array<{ value: number; name: string }> = [];
  if (a.quat) {
    const [w, x, y, z] = [values[0], -values[6], values[5], -values[3]];
    terms.push({ value: w, name: '' }, { value: x, name: 'i' }, { value: y, name: 'j' }, { value: z, name: 'k' });
  } else {
    for (const { blade, name, sign } of SPELLING[a.dim]) terms.push({ value: sign * values[blade], name });
  }
  // Rounding leaves 1e-17 where a coefficient cancels (q⁻¹ q): a term that
  // small beside the largest is zero.
  const floor = 1e-12 * Math.max(0, ...terms.map(t => Math.abs(t.value)).filter(Number.isFinite));
  let out = '';
  for (const { value, name } of terms) {
    if (value === 0 || Math.abs(value) <= floor) continue;
    const mag = Math.abs(value);
    const coeff = name && mag === 1 ? '' : format(mag);
    const body = name ? (a.quat ? `${coeff}${name}` : coeff ? `${coeff} ${name}` : name) : coeff;
    out += out ? (value < 0 ? ` - ${body}` : ` + ${body}`) : value < 0 ? `-${body}` : body;
  }
  return out || '0';
}

/** The glyph parts of a multivector: its vector, its bivector (as the vector
 *  normal to its plane in space, or its one coefficient in the plane), and
 *  its trivector coefficient. */
export function glyphParts(a: Multivector): {
  vector: Expr[] | null;
  bivector: { normal: Expr[] } | { plane: Expr } | null;
  trivector: Expr | null;
} {
  const d = a.data;
  const any = (ks: number[]) => ks.some(k => !isZero(d[k]));
  if (a.dim === 2) {
    return {
      vector: any([1, 2]) ? [d[1], d[2]] : null,
      bivector: any([3]) ? { plane: d[3] } : null,
      trivector: null,
    };
  }
  return {
    vector: any([1, 2, 4]) ? [d[1], d[2], d[4]] : null,
    // The dual of b_xy e_xy + b_yz e_yz + b_zx e_zx is (b_yz, b_zx, b_xy).
    bivector: any([3, 5, 6]) ? { normal: [d[6], neg(d[5]), d[3]] } : null,
    trivector: any([7]) ? d[7] : null,
  };
}
