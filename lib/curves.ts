/**
 * Differential geometry of a parametric curve r(u), in the plane or in space.
 *
 * `curvature(C)`, `torsion(C)`, `osculating(C, u0)` and `frame(C, u0)` expand
 * at resolve time, as grad and d/dx do (lib/defs.ts): each is written out of
 * r′, r″ and r‴, taken symbolically along u, so sliders and t work inside
 * them and nothing downstream sees a curve operator. What they expand to is
 * ordinary syntax — a number, a circle, a family of arrows — drawn and read
 * out by the machinery every other row uses.
 *
 * Everything is built from two vectors that need no square root:
 *   c² = |r′|²|r″|² − (r′·r″)²   (|r′ × r″|², by Lagrange's identity)
 *   w  = |r′|² r″ − (r′·r″) r′   (r″ with its part along r′ removed, scaled)
 * w points from the curve toward its centre of curvature, in the plane or in
 * space alike, with |w| = |r′| c.
 */
import { add, div, mul, pow, sub } from './diff.ts';
import { type Expr, substVars } from './expr.ts';

/** d/du, as the resolver takes it (symbolic, with its fallbacks). */
export type AlongU = (e: Expr) => Expr;

const num = (value: number): Expr => ({ kind: 'num', value });
const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const U: Expr = { kind: 'var', name: 'u' };

const dot = (a: readonly Expr[], b: readonly Expr[]): Expr => a.map((ak, k) => mul(ak, b[k])).reduce(add);
const scale = (s: Expr, a: readonly Expr[]): Expr[] => a.map(ak => mul(s, ak));
const plus = (a: readonly Expr[], b: readonly Expr[]): Expr[] => a.map((ak, k) => add(ak, b[k]));
const cross = (a: readonly Expr[], b: readonly Expr[]): Expr[] =>
  a.map((_, k) => sub(mul(a[(k + 1) % 3], b[(k + 2) % 3]), mul(a[(k + 2) % 3], b[(k + 1) % 3])));

/** The curve's pieces at u0 (or along u, with u0 = u). */
function pieces(r: readonly Expr[], d: AlongU, u0: Expr = U) {
  const at = (e: Expr): Expr => (u0 === U ? e : substVars(e, { u: u0 }));
  const r1raw = r.map(d);
  const r2raw = r1raw.map(d);
  const p = r.map(at);
  const r1 = r1raw.map(at);
  const r2 = r2raw.map(at);
  const speed2 = dot(r1, r1);
  const along = dot(r1, r2);
  const c2 = sub(mul(speed2, dot(r2, r2)), mul(along, along));
  const w = r2.map((a, k) => sub(mul(speed2, a), mul(along, r1[k])));
  return { p, r1, r2, speed2, c2, w };
}

/**
 * κ along the curve, an expression in u. In the plane it is signed —
 * (x′y″ − y′x″)/|r′|³, positive where the curve turns left — so a figure
 * eight changes sign at its crossing; in space it is |r′ × r″|/|r′|³ ≥ 0.
 */
export function curvatureOf(r: readonly Expr[], d: AlongU): Expr {
  const { r1, r2, speed2, c2 } = pieces(r, d);
  const top = r.length === 2 ? sub(mul(r1[0], r2[1]), mul(r1[1], r2[0])) : call('sqrt', c2);
  return div(top, pow(speed2, num(1.5)));
}

/** τ along a space curve: (r′ × r″) · r‴ / |r′ × r″|². */
export function torsionOf(r: readonly Expr[], d: AlongU): Expr {
  const { r1, r2, c2 } = pieces(r, d);
  return div(dot(cross(r1, r2), r2.map(d)), c2);
}

/**
 * The osculating circle at u0: centre r + |r′|² w / c², radius |r′|³ / c.
 * In the plane it is `circle(centre, radius)`; in space the parametric circle
 * centre + R (cos 2πu T + sin 2πu N) in the osculating plane. Where the curve
 * is straight (c = 0) the radius is infinite and nothing is drawn.
 */
export function osculatingOf(r: readonly Expr[], d: AlongU, u0: Expr): Expr {
  const { p, speed2, c2, w } = pieces(r, d, u0);
  const centre = plus(p, scale(div(speed2, c2), w));
  const radius = div(pow(speed2, num(1.5)), call('sqrt', c2));
  if (r.length === 2) return call('circle', { kind: 'vec', items: centre }, radius);
  const { T, N } = frameAt(r, d, u0);
  const turn = mul(num(2 * Math.PI), U);
  const rim = plus(scale(call('cos', turn), T), scale(call('sin', turn), N));
  return { kind: 'vec', items: plus(centre, scale(radius, rim)) };
}

/** The unit tangent, normal (toward the centre of curvature) and, in space,
 *  binormal T × N at u0. */
function frameAt(r: readonly Expr[], d: AlongU, u0: Expr): { p: Expr[]; T: Expr[]; N: Expr[]; B?: Expr[] } {
  const { p, r1, speed2, c2, w } = pieces(r, d, u0);
  const T = scale(div(num(1), call('sqrt', speed2)), r1);
  const N = scale(div(num(1), call('sqrt', mul(speed2, c2))), w);
  return r.length === 2 ? { p, T, N } : { p, T, N, B: cross(T, N) };
}

/**
 * The Frenet frame at u0 as unit arrows from the point: T, N, and in space
 * B — `vector(P, P + [T, N, B])`, a family of arrows. N is undefined where
 * the curve is straight (an inflection in the plane), and is not drawn there.
 */
export function frameOf(r: readonly Expr[], d: AlongU, u0: Expr): Expr {
  const { p, T, N, B } = frameAt(r, d, u0);
  const P: Expr = { kind: 'vec', items: p };
  const heads: Expr[] = [T, N, ...(B ? [B] : [])].map(v => ({ kind: 'vec', items: plus(p, v) }));
  return call('vector', P, { kind: 'list', items: heads });
}
