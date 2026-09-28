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
 * w is r″ with its part along r′ removed, scaled: the curvature vector
 * K = κN = w/|r′|⁴, which points from the curve toward its centre of
 * curvature and is 0 where the curve is straight. Both are taken from the
 * cross product and not from Lagrange's |r′|²|r″|² − (r′·r″)² (or the
 * difference on the right), whose rounding (ε|r′|²|r″|²) reads a straight
 * line traced at a varying speed as bent.
 *
 * Nothing here tests whether the curve is straight. The osculating circle is
 * written so that it is smooth in κ and is the tangent line at κ = 0; κ and
 * the plane frame are defined everywhere; what is genuinely undefined where
 * κ = 0 — a space curve's N and B, and torsion — is left to come out NaN.
 */
import { add, div, mul, neg, pow, sub } from './diff.ts';
import { type Expr, substVars } from './expr.ts';

/** d/du, as the resolver takes it (symbolic, with its fallbacks). */
export type AlongU = (e: Expr) => Expr;

const num = (value: number): Expr => ({ kind: 'num', value });
const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const U: Expr = { kind: 'var', name: 'u' };

/**
 * Half the arc length an osculating circle is drawn over when it is a line.
 * A circle of radius R is drawn over s ∈ [−S, S] with S = π/√(κ² + (π/L)²):
 * the whole circle (S ≈ πR) while πR is well under L, and a stretch 2L long
 * of its tangent line as κ → 0. A constant, not a size worked out from the
 * curve: a curve in u has no extent the expansion can see (u may run over
 * any range, and |r′| can vanish), and 1000 is well past any view a curve of
 * ordinary size is looked at in while leaving float32 (the GPU, 3D) a
 * resolution of 1e-4 at the ends. Circles of radius up to about 100 close;
 * larger ones are arcs 2L long, which only a view far wider than the curve
 * could tell apart from the whole circle. The samples are spread evenly over
 * the angle κs, so a circle cut short is sampled more finely than a whole
 * one, never less.
 */
const REACH = 1000;

const dot = (a: readonly Expr[], b: readonly Expr[]): Expr => a.map((ak, k) => mul(ak, b[k])).reduce(add);
const scale = (s: Expr, a: readonly Expr[]): Expr[] => a.map(ak => mul(s, ak));
const plus = (a: readonly Expr[], b: readonly Expr[]): Expr[] => a.map((ak, k) => add(ak, b[k]));
/** r′ × r″ in space; in the plane its z component alone, as a 1-vector. */
const cross = (a: readonly Expr[], b: readonly Expr[]): Expr[] =>
  a.length === 2
    ? [sub(mul(a[0], b[1]), mul(a[1], b[0]))]
    : a.map((_, k) => sub(mul(a[(k + 1) % 3], b[(k + 2) % 3]), mul(a[(k + 2) % 3], b[(k + 1) % 3])));

/** The curve's pieces at u0 (or along u, with u0 = u). */
function pieces(r: readonly Expr[], d: AlongU, u0: Expr = U) {
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
  // κ: signed in the plane (positive turning left), |r′ × r″|/|r′|³ in space.
  const kappa = div(r.length === 2 ? k[0] : call('sqrt', c2), pow(speed2, num(1.5)));
  const r3 = () => r2raw.map(d).map(at);
  return { p, r1, speed2, k, c2, w, kappa, r3 };
}

/**
 * κ along the curve, an expression in u. In the plane it is signed —
 * (x′y″ − y′x″)/|r′|³, positive where the curve turns left — so a figure
 * eight changes sign at its crossing; in space it is |r′ × r″|/|r′|³ ≥ 0.
 */
export function curvatureOf(r: readonly Expr[], d: AlongU): Expr {
  return pieces(r, d).kappa;
}

/** τ along a space curve: (r′ × r″) · r‴ / |r′ × r″|², undefined (0/0)
 *  where it is straight. */
export function torsionOf(r: readonly Expr[], d: AlongU): Expr {
  const { k, c2, r3 } = pieces(r, d);
  return div(dot(k, r3()), c2);
}

/**
 * The osculating circle at u0, as a parametric curve in u, in the plane or
 * in the osculating plane of a space curve. By arc length s from the point,
 *   c(s) = p + (sin κs/κ) T + ((1 − cos κs)/κ) N
 *        = p + s sinc(κs) T + (s²/2) sinc²(κs/2) K,     K = κN = w/|r′|⁴,
 * which is smooth in κ and at κ = 0 is the tangent line p + sT: an inflection
 * needs no case of its own, and a curve just off one draws a large circle
 * that flattens into the line continuously. κ appears only inside sinc (even,
 * so its sign does not matter there) and squared in S; the side the circle
 * bends to is K's.
 * s = S v, v = 2u − 1, runs over the whole circle (S = π/|κ|), capped
 * smoothly at REACH, so the point is at u = 1/2. With Θ = κS (the half
 * turn drawn, |Θ| < π) that is
 *   c = p + v sinc(Θv) S T + (v sinc(Θv/2))² (S²/2) K,
 * where p, Θ, S T and S² K / 2 do not move with u: the samplers work them out
 * once a frame (lib/path.ts foldAllExcept) rather than once per sample, and
 * each is written once, as the expression grows with every copy.
 */
export function osculatingOf(r: readonly Expr[], d: AlongU, u0: Expr): Expr {
  const { p, r1, speed2, c2, w, kappa } = pieces(r, d, u0);
  // κ² = c²/|r′|⁶, the smooth cap under the root.
  const reach = div(num(Math.PI), call('sqrt', add(div(c2, pow(speed2, num(3))), num((Math.PI / REACH) ** 2))));
  const turn = mul(kappa, reach);
  const v = sub(mul(num(2), U), num(1));
  const ahead = mul(v, call('sinc', mul(turn, v)));
  const inward = pow(mul(v, call('sinc', mul(mul(num(0.5), turn), v))), num(2));
  const along = scale(div(reach, call('sqrt', speed2)), r1);
  const across = scale(div(pow(reach, num(2)), mul(num(2), pow(speed2, num(2)))), w);
  return { kind: 'vec', items: plus(p, plus(scale(ahead, along), scale(inward, across))) };
}

/**
 * The Frenet frame at u0 as unit arrows from the point — `vector(P, P + [T,
 * N, B])`, a family of arrows. In the plane N is T turned a quarter left,
 * defined everywhere: with κ signed, κN points toward the centre of
 * curvature. In space N = K/|K| (toward the centre) and B = (r′ × r″)/c,
 * which are undefined where κ = 0 and come out NaN there.
 */
export function frameOf(r: readonly Expr[], d: AlongU, u0: Expr): Expr {
  const { p, r1, speed2, k, c2, w } = pieces(r, d, u0);
  const T = scale(div(num(1), call('sqrt', speed2)), r1);
  const frame =
    r.length === 2
      ? [T, [neg(T[1]), T[0]]]
      : [T, scale(div(num(1), call('sqrt', mul(speed2, c2))), w), scale(div(num(1), call('sqrt', c2)), k)];
  const P: Expr = { kind: 'vec', items: p };
  const heads: Expr[] = frame.map(v => ({ kind: 'vec', items: plus(p, v) }));
  return call('vector', P, { kind: 'list', items: heads });
}
