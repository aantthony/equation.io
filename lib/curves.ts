/**
 * Differential geometry of a parametric curve r(u), in the plane or in space.
 *
 * `curvature(C)`, `torsion(C)`, `osculating(C, u0)` and `frame(C, u0)` expand
 * at resolve time, as grad and d/dx do (lib/defs.ts): each is written out of
 * r′, r″ and r‴, taken symbolically along u, so sliders and t work inside
 * them and nothing downstream sees a curve operator. What they expand to is
 * ordinary syntax — a number, a parametric circle, a family of arrows — drawn
 * and read out by the machinery every other row uses.
 *
 * Everything is built from vectors that need no square root:
 *   k  = r′ × r″                 (in the plane, its one component x′y″ − y′x″)
 *   c² = |k|²
 *   w  = k × r′ = |r′|² r″ − (r′·r″) r′   (in the plane, k (−y′, x′))
 * w is r″ with its part along r′ removed, scaled: it points from the curve
 * toward its centre of curvature, with |w| = |r′| c. Both are taken from
 * the cross product and not from Lagrange's |r′|²|r″|² − (r′·r″)² (or the
 * difference on the right), whose rounding (ε|r′|²|r″|²) reads a straight
 * line traced at a varying speed as bent, and a nearly straight stretch's
 * centre as off its normal.
 *
 * Where the curve is straight nothing depends on a branch: the gate is
 * arithmetic (cos atan2, max, an even root), so a list of points u0 maps
 * element by element — a piecewise over a list would filter it instead.
 */
import { add, div, mul, neg, pow, sub } from './diff.ts';
import { type Expr, substVars } from './expr.ts';

/** d/du, as the resolver takes it (symbolic, with its fallbacks). */
export type AlongU = (e: Expr) => Expr;

const num = (value: number): Expr => ({ kind: 'num', value });
const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const U: Expr = { kind: 'var', name: 'u' };
/** How far from parallel rounding leaves r′ and r″ on a straight line. */
const ROUNDING = 1e-12;

const dot = (a: readonly Expr[], b: readonly Expr[]): Expr => a.map((ak, k) => mul(ak, b[k])).reduce(add);
const scale = (s: Expr, a: readonly Expr[]): Expr[] => a.map(ak => mul(s, ak));
const plus = (a: readonly Expr[], b: readonly Expr[]): Expr[] => a.map((ak, k) => add(ak, b[k]));
/** r′ × r″ in space; in the plane its z component alone, as a 1-vector. */
const cross = (a: readonly Expr[], b: readonly Expr[]): Expr[] =>
  a.length === 2
    ? [sub(mul(a[0], b[1]), mul(a[1], b[0]))]
    : a.map((_, k) => sub(mul(a[(k + 1) % 3], b[(k + 2) % 3]), mul(a[(k + 2) % 3], b[(k + 1) % 3])));

/**
 * The curve's pieces at u0 (or along u, with u0 = u), and its gate: `bent`
 * is 1 where the curve bends and 0 where it is straight, and dividing by
 * `defined` leaves a value where it bends and NaN (undefined) where not.
 */
function pieces(r: readonly Expr[], d: AlongU, u0: Expr = U, straight = 1e-10) {
  const at = (e: Expr): Expr => (u0 === U ? e : substVars(e, { u: u0 }));
  const r1raw = r.map(d);
  const r2raw = r1raw.map(d);
  const p = r.map(at);
  const r1 = r1raw.map(at);
  const r2 = r2raw.map(at);
  const speed2 = dot(r1, r1);
  const k = cross(r1, r2);
  const c2 = dot(k, k);
  const w = r.length === 2 ? [mul(k[0], neg(r1[1])), mul(k[0], r1[0])] : cross(k, r1);
  // At an inflection c² is 0 only up to rounding (sin 2π ≈ −2.4e-16), which
  // would draw a circle of radius 1e16 and an N pointing anywhere. u spans
  // (0, 1), so |r′| is on the curve's own scale: bending below `straight`
  // |r′| (c < straight |r′|², κ|r′| < straight) is straight. So is r″ along
  // r′ to within rounding (c < 1e-12 |r′||r″|), where a straight line
  // turns back (r′ → 0) and c is rounding over a vanishing |r′|³.
  const floor = call(
    'max',
    mul(num(straight ** 2), mul(speed2, speed2)),
    mul(num(ROUNDING ** 2), mul(speed2, dot(r2, r2))),
  );
  // 1 where it bends and −1 where not, as sign(c² − floor) is, but its
  // own derivative: atan2(0, ·) is 0 or π, flat on either side, and diff
  // takes it as exactly 0 (its y is 0), so d/du κ stays symbolic while sign
  // stays non-smooth to diff for the measures and root finders that must
  // see its jump. cos, not a sign, of π: GLSL may give atan(0, −x) as −π.
  const side = call('cos', call('atan2', num(0), sub(c2, floor)));
  const bent = call('max', side, num(0));
  // (−1)^(1/2), not sqrt(−1): both are NaN on the CPU, but GLSL leaves the
  // square root of a negative undefined (ANGLE folds it to 0), while eq_pow
  // makes an even root of one EQ_NAN.
  const defined = pow(side, num(0.5));
  const r3 = () => r2raw.map(d).map(at);
  return { p, r1, speed2, k, c2, w, bent, defined, r3 };
}

/**
 * κ along the curve, an expression in u. In the plane it is signed —
 * (x′y″ − y′x″)/|r′|³, positive where the curve turns left — so a figure
 * eight changes sign at its crossing; in space it is |r′ × r″|/|r′|³ ≥ 0.
 * Where the curve is straight it is 0.
 */
export function curvatureOf(r: readonly Expr[], d: AlongU): Expr {
  const { speed2, k, c2, bent } = pieces(r, d);
  const top = r.length === 2 ? k[0] : call('sqrt', c2);
  // + 0: a straight stretch reads 0, not the −0 of 0 × a negative top.
  const kappa = div(mul(top, bent), pow(speed2, num(1.5)));
  return { kind: 'bin', op: '+', a: kappa, b: num(0) };
}

/** τ along a space curve: (r′ × r″) · r‴ / |r′ × r″|², undefined where it
 *  is straight. */
export function torsionOf(r: readonly Expr[], d: AlongU): Expr {
  const { k, c2, defined, r3 } = pieces(r, d);
  return div(dot(k, r3()), mul(c2, defined));
}

/**
 * The osculating circle at u0, as a parametric circle in u through the point
 * (u = 0 is the point itself), in the plane or in the osculating plane of a
 * space curve:
 *   p + (1 − cos 2πu) R N + sin 2πu R T,  R N = |r′|² w / c²,  R T = |r′|² r′ / c
 * with R = |r′|³/c. Its centre and size do not move with u, so the samplers
 * work them out once a frame (lib/path.ts foldAllExcept) rather than once per
 * pixel, as an implicit circle would. Where the curve is straight (c = 0) the
 * radius is infinite and nothing is drawn.
 */
export function osculatingOf(r: readonly Expr[], d: AlongU, u0: Expr): Expr {
  // The circle is drawn in float32, where the rounding is 1e-7: past 10⁴
  // times the curve's size it is its tangent line anyway.
  const { p, r1, speed2, c2, w, defined } = pieces(r, d, u0, 1e-4);
  const toCentre = div(speed2, mul(c2, defined));
  const alongT = div(speed2, mul(call('sqrt', c2), defined));
  const turn = mul(num(2 * Math.PI), U);
  const inward = sub(num(1), call('cos', turn));
  const ahead = call('sin', turn);
  return {
    kind: 'vec',
    items: plus(p, plus(scale(mul(inward, toCentre), w), scale(mul(ahead, alongT), r1))),
  };
}

/**
 * The Frenet frame at u0 as unit arrows from the point: T, N (toward the
 * centre of curvature) and, in space, B = (r′ × r″)/c —
 * `vector(P, P + [T, N, B])`, a family of arrows. N and B are undefined where
 * the curve is straight (an inflection in the plane), and are not drawn there.
 */
export function frameOf(r: readonly Expr[], d: AlongU, u0: Expr): Expr {
  const { p, r1, speed2, k, c2, w, defined } = pieces(r, d, u0);
  const T = scale(div(num(1), call('sqrt', speed2)), r1);
  const N = scale(div(num(1), mul(call('sqrt', mul(speed2, c2)), defined)), w);
  const B = r.length === 3 ? [scale(div(num(1), mul(call('sqrt', c2), defined)), k)] : [];
  const P: Expr = { kind: 'vec', items: p };
  const heads: Expr[] = [T, N, ...B].map(v => ({ kind: 'vec', items: plus(p, v) }));
  return call('vector', P, { kind: 'list', items: heads });
}
