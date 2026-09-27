/**
 * Glyphs: values with no position of their own, drawn as the figures that
 * show what they are.
 *
 * The picture of a multivector, grade by grade (docs/clifford.md): its vector
 * an arrow from the origin; its bivector an oriented disc of that area in its
 * plane, with an arrow round the rim for its sense of turn; its trivector a
 * cube of that volume. Each is an ordinary figure, so every renderer that
 * draws figures draws these.
 */
import { add, div, mul, neg, pow } from './diff.ts';
import type { Column, Expr } from './expr.ts';
import { type Multivector, bladeGrade, glyphParts, isZero, magnitude, normSquared } from './clifford.ts';

const num = (value: number): Expr => ({ kind: 'num', value });
const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const figure = (form: 'vector' | 'polygon' | 'hull', dimension: 2 | 3, points: Expr[][]): Expr => ({
  kind: 'figure',
  form,
  dimension,
  vertices: points.flat(),
});

/** Vertices round the rim; how far round the arrow of turn goes, and how
 *  far in from the rim it runs, so it reads apart from the outline. */
const RIM = 48;
const TURN = 0.75;
const INSET = 0.6;

/**
 * The arc r (cos θ e1 + sin θ e2), θ from 0 to 2π·share in `steps` steps
 * (a closed rim leaves out its repeated last point), as ONE vertex template
 * run over columns of cos θ and sin θ: e1, e2 and r may be large — a slerp's
 * coefficients — and are then written once, not once per vertex.
 */
function arc(
  form: 'polygon' | 'vector',
  dimension: 2 | 3,
  r: Expr,
  e1: Expr[],
  e2: Expr[],
  share: number,
  steps: number,
  sense: Expr = num(1),
): Expr {
  const count = form === 'polygon' ? steps : steps + 1;
  const angle = (k: number) => (2 * Math.PI * share * k) / steps;
  const over: Column[] = [
    { name: ARC_COS, values: Float64Array.from({ length: count }, (_, k) => Math.cos(angle(k))) },
    { name: ARC_SIN, values: Float64Array.from({ length: count }, (_, k) => Math.sin(angle(k))) },
  ];
  const c: Expr = { kind: 'var', name: ARC_COS };
  const s = mul(sense, { kind: 'var', name: ARC_SIN });
  return { kind: 'figure', form, dimension, vertices: e1.map((a, i) => mul(r, add(mul(c, a), mul(s, e2[i])))), over };
}
/** The columns an arc runs over: not names a document can write. */
const ARC_COS = 'eqioArcCos';
const ARC_SIN = 'eqioArcSin';

/**
 * A right-handed orthonormal pair spanning the plane normal to the unit
 * vector n, in closed form (Duff et al., "Building an orthonormal basis,
 * revisited", 2017): e1 × e2 = n with no branch but the sign of n_z.
 */
function planeBasis(n: Expr[]): [Expr[], Expr[]] {
  const [x, y, z] = n;
  const s: Expr = {
    kind: 'piecewise',
    cases: [{ cond: { kind: 'ineq', op: '<', l: z, r: num(0) }, value: num(-1) }],
    otherwise: num(1),
  };
  const a = div(num(-1), add(s, z));
  const b = mul(mul(x, y), a);
  return [
    [add(num(1), mul(mul(s, mul(x, x)), a)), mul(s, b), neg(mul(s, x))],
    [b, add(s, mul(mul(y, y), a)), neg(y)],
  ];
}

/**
 * The internal call `action(M)` lowers to: its size, then its entries
 * row-major. Classify draws it with actionGlyphs and reads the matrix out.
 */
export const ACTION_CALL = '[action]';
export const actionNode = (m: readonly (readonly Expr[])[]): Expr => ({
  kind: 'call',
  name: ACTION_CALL,
  args: [num(m.length), ...m.flat()],
});
export function actionOfNode(e: Expr): Expr[][] | null {
  if (e.kind !== 'call' || e.name !== ACTION_CALL) return null;
  const n = e.args[0].kind === 'num' ? e.args[0].value : 0;
  return Array.from({ length: n }, (_, i) => e.args.slice(1 + i * n, 1 + (i + 1) * n));
}

/**
 * What a matrix does, drawn: the image of the unit square (a filled
 * parallelogram, whose signed area is det M) or cube, of the unit circle (an
 * ellipse, its axes the singular vectors), and the arrows M e_x, M e_y
 * (and M e_z) — the columns.
 */
export function actionGlyphs(m: readonly (readonly Expr[])[]): Expr[] {
  const n = m.length as 2 | 3;
  const col = (j: number): Expr[] => m.map(row => row[j]);
  const origin = Array.from({ length: n }, () => num(0));
  const sum = (...vs: Expr[][]): Expr[] => vs.reduce((acc, v) => acc.map((c, i) => add(c, v[i])), origin);
  const out: Expr[] = [];
  if (n === 2) {
    out.push(figure('polygon', 2, [origin, col(0), sum(col(0), col(1)), col(1)]));
    const circle = Array.from({ length: RIM + 1 }, (_, k) => {
      const th = (2 * Math.PI * k) / RIM;
      return m.map(row => add(mul(row[0], num(Math.cos(th))), mul(row[1], num(Math.sin(th)))));
    });
    out.push({ kind: 'figure', form: 'polyline', dimension: 2, vertices: circle.flat() });
  } else {
    const corners: Expr[][] = [];
    for (const a of [0, 1])
      for (const b of [0, 1])
        for (const c of [0, 1]) {
          corners.push(sum(...[a, b, c].flatMap((on, j) => (on ? [col(j)] : []))));
        }
    out.push(figure('hull', 3, corners));
  }
  for (let j = 0; j < n; j++) out.push(figure('vector', n, [origin, col(j)]));
  return out;
}

/**
 * A sweep through `angle` (radians, either sign) of the circle of radius r
 * in the plane of e1, e2, as one template over the fraction of the sweep: a
 * `sector` starts at the centre, so the polygon fills the wedge. The angle
 * may be any expression — a quaternion's, which moves with its sliders.
 */
function sweep(
  form: 'polygon' | 'vector',
  dimension: 2 | 3,
  r: Expr,
  e1: Expr[],
  e2: Expr[],
  angle: Expr,
  steps: number,
  sector = false,
): Expr {
  const n = steps + 1 + (sector ? 1 : 0);
  const over: Column[] = [
    { name: SWEEP_F, values: Float64Array.from({ length: n }, (_, k) => Math.max(0, k - (sector ? 1 : 0)) / steps) },
    { name: SWEEP_R, values: Float64Array.from({ length: n }, (_, k) => (sector && k === 0 ? 0 : 1)) },
  ];
  const th = mul({ kind: 'var', name: SWEEP_F }, angle);
  const rr = mul({ kind: 'var', name: SWEEP_R }, r);
  const c = call('cos', th);
  const sn = call('sin', th);
  return { kind: 'figure', form, dimension, vertices: e1.map((a, i) => mul(rr, add(mul(c, a), mul(sn, e2[i])))), over };
}
const SWEEP_F = 'eqioSweepF';
const SWEEP_R = 'eqioSweepR';

/**
 * A quaternion or a rotor — a scalar and a bivector — drawn as the rotation
 * it makes in R v R̃: q = w + v turns by θ = 2 atan2(|v|, w) about v, so the
 * picture is an arrow along the axis, |q| long, and a filled sector of
 * radius |q| sweeping θ with an arrow for the turn. Moving w moves θ, which
 * a disc of the bivector alone could not show. Null when the multivector is
 * not one: an odd part, no bivector, or no scalar (a pure bivector is an
 * oriented area, drawn as one — unless it was written as a quaternion).
 */
function rotationGlyphs(m: Multivector): Expr[] | null {
  const odd = m.data.some((c, k) => bladeGrade(k) % 2 === 1 && !isZero(c));
  const { bivector } = glyphParts(m);
  if (odd || !bivector || (isZero(m.data[0]) && !m.quat)) return null;
  const w = m.data[0];
  const size = call('sqrt', normSquared(m));
  const steps = Math.round(RIM * 0.75);
  if ('plane' in bivector) {
    // R = cos(θ/2) − sin(θ/2) e_xy turns the plane by θ counterclockwise.
    const angle = mul(num(2), call('atan2', neg(bivector.plane), w));
    const e1 = [num(1), num(0)];
    const e2 = [num(0), num(1)];
    return [
      sweep('polygon', 2, size, e1, e2, angle, steps, true),
      sweep('vector', 2, mul(num(1.12), size), e1, e2, angle, steps),
    ];
  }
  // The quaternion's vector part is minus the bivector's dual (i = e_zy).
  const v = bivector.normal.map(neg);
  const len = magnitude(v);
  const axis = v.map(c => div(c, len));
  const [e1, e2] = planeBasis(axis);
  const angle = mul(num(2), call('atan2', len, w));
  return [
    sweep('polygon', 3, size, e1, e2, angle, steps, true),
    sweep('vector', 3, mul(num(1.12), size), e1, e2, angle, steps),
    figure('vector', 3, [axis.map(() => num(0)), axis.map(c => mul(size, c))]),
  ];
}

/** The figures that draw a multivector: none for a plain number, which
 *  plot.ts reads out alone, and at least one for anything else. */
export function multivectorGlyphs(m: Multivector): Expr[] {
  const turn = rotationGlyphs(m);
  if (turn) return turn;
  const { vector, bivector, trivector } = glyphParts(m);
  const dim = m.dim;
  const origin = Array.from({ length: dim }, () => num(0));
  const out: Expr[] = [];
  if (bivector) {
    if ('plane' in bivector) {
      // Area |b|: radius √(|b|/π). The rim arrow turns the way b does.
      const b = bivector.plane;
      const r = call('sqrt', div(call('abs', b), num(Math.PI)));
      const e1 = [num(1), num(0)];
      const e2 = [num(0), num(1)];
      out.push(arc('polygon', 2, r, e1, e2, 1, RIM));
      out.push(arc('vector', 2, mul(num(INSET), r), e1, e2, TURN, Math.round(RIM * TURN), call('sign', b)));
    } else {
      // In space the disc lies across its dual, turning counterclockwise
      // seen from the tip of the normal, which is the bivector's sense.
      const n = bivector.normal;
      const len = magnitude(n);
      const [e1, e2] = planeBasis(n.map(c => div(c, len)));
      const r = call('sqrt', div(len, num(Math.PI)));
      out.push(arc('polygon', 3, r, e1, e2, 1, RIM));
      out.push(arc('vector', 3, mul(num(INSET), r), e1, e2, TURN, Math.round(RIM * TURN)));
    }
  }
  if (trivector) {
    // A cube of volume |p|, centred on the origin.
    const h = div(pow(call('abs', trivector), num(1 / 3)), num(2));
    const corners: Expr[][] = [];
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push([sx, sy, sz].map(k => mul(num(k), h)));
    out.push(figure('hull', 3, corners));
  }
  if (vector) out.push(figure('vector', dim, [origin, vector]));
  return out;
}

/**
 * How much a tensor glyph scales the matrix ((a, b), (c, d)): tanh(σ₁)/σ₁,
 * for σ₁ its largest singular value. A small matrix draws at its own size
 * (a glyph of radius σ₁ cells), a large one saturates at a whole cell, so
 * magnitude still reads where it is modest and no glyph overlaps another.
 * (The same formula is written in GLSL in web/render2d.ts tfieldFrag.)
 */
export function glyphScale(a: number, b: number, c: number, d: number): number {
  const s1 = largestSingular(a, b, c, d);
  if (!Number.isFinite(s1)) return NaN;
  return s1 < 1e-9 ? 1 : Math.tanh(s1) / s1;
}

/** σ₁ of ((a, b), (c, d)): the root of the larger eigenvalue of MᵀM. */
export function largestSingular(a: number, b: number, c: number, d: number): number {
  const p = a * a + c * c;
  const q = b * b + d * d;
  const r = a * b + c * d;
  const half = (p + q) / 2;
  return Math.sqrt(half + Math.sqrt(Math.max(0, ((p - q) / 2) ** 2 + r * r)));
}

/**
 * The internal call `eigen(M)` lowers to, laid out as ACTION_CALL is.
 * Classify reads the eigenvalues out and draws eigenGlyphs.
 */
export const EIGEN_CALL = '[eigen]';
export const eigenNode = (m: readonly (readonly Expr[])[]): Expr => ({
  kind: 'call',
  name: EIGEN_CALL,
  args: [num(m.length), ...m.flat()],
});
export function eigenOfNode(e: Expr): Expr[][] | null {
  if (e.kind !== 'call' || e.name !== EIGEN_CALL) return null;
  return actionOfNode({ ...e, name: ACTION_CALL });
}

const sub = (a: Expr, b: Expr): Expr => add(a, neg(b));
const sqrt = (e: Expr): Expr => call('sqrt', e);
const when = (cond: Expr, value: Expr, otherwise?: Expr): Expr => ({
  kind: 'piecewise',
  cases: [{ cond, value }],
  ...(otherwise ? { otherwise } : {}),
});
const atLeast = (l: Expr, r: Expr): Expr => ({ kind: 'ineq', op: '>=', l, r });
const dot = (a: readonly Expr[], b: readonly Expr[]): Expr => a.map((ak, k) => mul(ak, b[k])).reduce(add);
const cross = (a: readonly Expr[], b: readonly Expr[]): Expr[] =>
  a.map((_, k) => sub(mul(a[(k + 1) % 3], b[(k + 2) % 3]), mul(a[(k + 2) % 3], b[(k + 1) % 3])));
/** The real cube root, of either sign. */
const cbrt = (e: Expr): Expr => mul(call('sign', e), pow(call('abs', e), num(1 / 3)));
const minor = (m: readonly (readonly Expr[])[], r0: number, r1: number, c0: number, c1: number): Expr =>
  sub(mul(m[r0][c0], m[r1][c1]), mul(m[r0][c1], m[r1][c0]));

/**
 * The eigenvalues of a 2×2 or 3×3 matrix in closed form, each as its real
 * and imaginary parts: real ones first, largest first, then any conjugate
 * pair with its positive imaginary part first.
 *
 * 2×2: s ± √δ with s = tr/2 and δ = s² − det, the pair s ± i√−δ when δ < 0.
 * 3×3: the roots of λ³ − tr λ² + c λ − det (c the sum of the principal 2×2
 * minors), shifted to μ³ + p μ + q by λ = μ + tr/3. Three real roots — the
 * discriminant D = (q/2)² + (p/3)³ ≤ 0 — come from Viète's cosines, one
 * real root and a conjugate pair from Cardano's cube roots.
 */
export function eigenvalues(m: readonly (readonly Expr[])[]): Array<[Expr, Expr]> {
  const zero = num(0);
  if (m.length === 2) {
    const [[a, b], [c, d]] = m;
    const s = div(add(a, d), num(2));
    const delta = sub(mul(s, s), sub(mul(a, d), mul(b, c)));
    const real = sqrt(call('max', delta, zero));
    const imag = sqrt(call('max', neg(delta), zero));
    return [
      [add(s, real), imag],
      [sub(s, real), neg(imag)],
    ];
  }
  const tr = add(add(m[0][0], m[1][1]), m[2][2]);
  const c = add(add(minor(m, 0, 1, 0, 1), minor(m, 0, 2, 0, 2)), minor(m, 1, 2, 1, 2));
  const det = add(
    sub(mul(m[0][0], minor(m, 1, 2, 1, 2)), mul(m[0][1], minor(m, 1, 2, 0, 2))),
    mul(m[0][2], minor(m, 1, 2, 0, 1)),
  );
  const shift = div(tr, num(3));
  const p = sub(c, div(mul(tr, tr), num(3)));
  const q = sub(sub(div(mul(c, tr), num(3)), div(mul(num(2), pow(tr, num(3))), num(27))), det);
  const halfQ = div(q, num(2));
  const D = add(mul(halfQ, halfQ), pow(div(p, num(3)), num(3)));
  const three = atLeast(zero, D);
  // Viète: μ_k = 2ρ cos(θ − 2πk/3), ρ = √(−p/3), θ ∈ [0, π/3]; k = 0, 1, −1
  // is largest first. (ρ = 0 only with q = 0 too: a triple root, μ = 0.)
  const rho = sqrt(call('max', neg(div(p, num(3))), zero));
  const cosArg = div(neg(halfQ), call('max', pow(rho, num(3)), num(1e-300)));
  const theta = div(call('acos', call('max', num(-1), call('min', num(1), cosArg))), num(3));
  const viete = (k: number): Expr => mul(mul(num(2), rho), call('cos', sub(theta, num((2 * Math.PI * k) / 3))));
  // Cardano: A + B is the real root, −(A + B)/2 ± i(√3/2)(A − B) the pair.
  const root = sqrt(call('max', D, zero));
  const A = cbrt(add(neg(halfQ), root));
  const B = cbrt(sub(neg(halfQ), root));
  const pairRe = neg(div(add(A, B), num(2)));
  const pairIm = mul(num(Math.sqrt(3) / 2), sub(A, B));
  return [
    [add(shift, when(three, viete(0), add(A, B))), zero],
    [add(shift, when(three, viete(1), pairRe)), when(three, zero, pairIm)],
    [add(shift, when(three, viete(-1), pairRe)), when(three, zero, neg(pairIm))],
  ];
}

/** How far each invariant line runs from the origin: past any sensible view. */
const LINE_REACH = 1000;

/**
 * What eigen(M) draws for each real eigenvalue λ: its invariant line through
 * the origin, and the arrow M v = λ v for the unit eigenvector v — the line
 * is the direction M keeps, the arrow how far it stretches (or flips) it. A
 * complex pair has no real eigenvector and draws nothing; neither does a
 * multiple of the identity, whose every line is invariant.
 *
 * The eigenvector is a nonzero column of the adjugate of M − λI: in 2×2,
 * (b, λ − a) or (λ − d, c); in 3×3 the cross product of two rows of M − λI.
 * The longest candidate is taken, so a zero entry never loses it.
 */
export function eigenGlyphs(m: readonly (readonly Expr[])[]): Expr[] {
  const n = m.length as 2 | 3;
  const out: Expr[] = [];
  for (const [lambda, imag] of eigenvalues(m)) {
    const shifted = m.map((row, i) => row.map((entry, j) => (i === j ? sub(entry, lambda) : entry)));
    const candidates: Expr[][] =
      n === 2
        ? [
            [m[0][1], neg(shifted[0][0])],
            [neg(shifted[1][1]), m[1][0]],
          ]
        : [cross(shifted[0], shifted[1]), cross(shifted[0], shifted[2]), cross(shifted[1], shifted[2])];
    // The longest candidate, one comparison per rival.
    let best = candidates[0];
    let size = dot(best, best);
    for (const v of candidates.slice(1)) {
      const vs = dot(v, v);
      const longer = atLeast(vs, size);
      best = best.map((c, k) => when(longer, v[k], c));
      size = when(longer, vs, size);
    }
    // A complex λ leaves the vector undefined, so nothing is drawn for it.
    const real: Expr = { kind: 'ineq', op: '<', l: call('abs', imag), r: num(1e-9) };
    const len = sqrt(size);
    const unit = best.map(c => when(real, div(c, len)));
    const origin = unit.map(() => num(0));
    out.push({
      kind: 'figure',
      form: 'segment',
      dimension: n,
      vertices: [...unit.map(c => mul(num(-LINE_REACH), c)), ...unit.map(c => mul(num(LINE_REACH), c))],
    });
    out.push(figure('vector', n, [origin, unit.map(c => mul(lambda, c))]));
  }
  return out;
}
