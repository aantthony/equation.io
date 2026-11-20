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
 * Nothing here tests whether the curve is straight. The osculating circle's
 * shape is smooth in κ and is the tangent line at κ = 0; κ and
 * the plane frame are defined everywhere; what is genuinely undefined where
 * κ = 0 — a space curve's N and B, and torsion — is left to come out NaN.
 */
import { add, div, mul, neg, pow, sub } from './diff.ts';
import { childrenOf, exprKey, type Expr, freeVars, substVars } from './expr.ts';
import { applyDiff, throughFields, type Ctx } from './defs.ts';
import { lowerGeom } from './geom.ts';
import { intervalsIn, replaceIntervals } from './interval.ts';
import { SCALAR_REDUCTIONS } from './list.ts';

/** d/du, as the resolver takes it (symbolic, with its fallbacks). */
export type AlongU = (e: Expr) => Expr;

const num = (value: number): Expr => ({ kind: 'num', value });
const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const U: Expr = { kind: 'var', name: 'u' };

/**
 * The longest half arc length an osculating circle is drawn over. A circle of
 * radius R is drawn over s ∈ [−S, S] with S = min(πR, L): the whole circle,
 * closed, while πR ≤ L, and otherwise an arc 2L long of it, which as κ → 0 is
 * that stretch of the tangent line. A constant, not a size worked out from
 * the curve: a curve in u has no extent the expansion can see (u may run over
 * any range, and |r′| can vanish), and 1000 is well past any view a curve of
 * ordinary size is looked at in while leaving float32 (the GPU, 3D) a
 * resolution of 1e-4 at the ends. Circles of radius up to 1000/π ≈ 318 close;
 * larger ones are arcs 2000 long, which only a view far wider than the curve
 * could tell apart from the whole circle. S has a kink in u0 where πR = L,
 * which nothing drawn along u sees. The samples are spread evenly over the
 * angle κs, so a circle cut short is sampled more finely than a whole one,
 * never less.
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
 * so its sign does not matter there) and as |κ| in S; the side the circle
 * bends to is K's.
 * s = S v, v = 2u − 1, runs over the whole circle (S = π/|κ|), capped at
 * REACH, so the point is at u = 1/2. With Θ = κS (the half turn drawn,
 * |Θ| ≤ π, and exactly π when the circle closes) that is
 *   c = p + v sinc(Θv) S T + (v sinc(Θv/2))² (S²/2) K,
 * where p, Θ, S T and S² K / 2 do not move with u: the samplers work them out
 * once a frame (lib/path.ts foldAllExcept) rather than once per sample, and
 * each is written once, as the expression grows with every copy.
 */
export function osculatingOf(r: readonly Expr[], d: AlongU, u0: Expr): Expr {
  const { p, r1, speed2, c2, w, kappa } = pieces(r, d, u0);
  // S = min(π/|κ|, L) as π/max(|κ|, π/L), which divides by nothing that can
  // be 0: at κ = 0 it is L, and Θ = κS is 0.
  const absKappa = div(call('sqrt', c2), pow(speed2, num(1.5)));
  const reach = div(num(Math.PI), call('max', absKappa, num(Math.PI / REACH)));
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

/** Axis names, as in lib/defs.ts. Local so this file's tables do not read defs during startup. */
const SPACE: ReadonlySet<string> = new Set(['x', 'y', 'z']);

/** The operators on a parametric curve in u. */
export const CURVE_OPS: ReadonlySet<string> = new Set(['curvature', 'torsion', 'osculating', 'frame']);
const CURVE_OP_EXAMPLE: Record<string, string> = {
  curvature: 'curvature(C) or curvature(C, 0.25)',
  torsion: 'torsion(C) or torsion(C, 0.25)',
  osculating: 'osculating(C, 0.25)',
  frame: 'frame(C, 0.25)',
};
/** The curve parameter: a definition over it is a named curve. A named
 *  field over x, y or z is written out too, to be refused. */
const ALONG: ReadonlySet<string> = new Set(['u', ...SPACE]);

/**
 * What a curve operator acts on, as its components in u: a tuple, a named
 * curve (c = (cos(2pi u), sin(2pi u)), written out through any scalar it
 * uses), or a function of one parameter, called at u. A curve over one
 * interval instead (`u = interval(0, 2pi)` above, or `s = interval(…)`) is
 * read over that interval's own values, written as u; `over` is the interval,
 * to put back where the result is a function along the curve.
 */
function curveOperand(name: string, arg: Expr, ctx: Ctx): { items: readonly Expr[]; over?: Expr } {
  const usage = `${name} takes a parametric curve in u, like ${CURVE_OP_EXAMPLE[name]} with C = (cos(2pi u), sin(2pi u)).`;
  const U: Expr = { kind: 'var', name: 'u' };
  const uInterval = ctx.opts.interval?.('u');
  let r: Expr = arg;
  if (arg.kind === 'var') {
    const fn = ctx.getFn(arg.name);
    if (fn) {
      if (fn.params.length !== 1 || fn.recursive) throw new Error(usage);
      r = substVars(fn.body, { [fn.params[0]]: uInterval ?? U });
    }
  }
  if (ctx.opts.comps) r = lowerGeom(r, ctx.opts.comps, () => null, ctx.opts.isList);
  r = throughFields(r, ctx.opts, ALONG);
  if (r.kind === 'var' && arg.kind === 'var') {
    const n = arg.name;
    const what = ctx.opts.consts?.[n] !== undefined ? 'a number' : ctx.opts.isList?.(n) ? 'a list' : null;
    if (what) throw new Error(`${name}: ${n} is ${what}, not a curve in u. ${usage}`);
    if (!ctx.opts.documentNames?.has(n)) {
      throw new Error(`${name}: ${n} is not a curve — define one first, like ${n} = (cos(2pi u), sin(2pi u)).`);
    }
  }
  // The interval the curve runs along, read at its own values as u: u's own
  // (`u = interval(0, 2pi)`), or else the one interval of a curve without u.
  // Any other interval stays, a family of curves.
  const hidden = intervalsIn(r);
  const uKey = uInterval && exprKey(uInterval);
  const along =
    hidden.find(h => h.key === uKey) ?? (hidden.length === 1 && !freeVars(r).has('u') ? hidden[0] : undefined);
  if (along) r = replaceIntervals(r, h => (h.key === along.key ? U : h.node));
  if (r.kind !== 'vec' || (r.items.length !== 2 && r.items.length !== 3)) throw new Error(usage);
  const vars = freeVars(r);
  if (!vars.has('u')) throw new Error(`${name} needs a curve, which moves with u — this is a fixed point. ${usage}`);
  if (vars.has('v') || [...SPACE].some(n => vars.has(n))) throw new Error(usage);
  return { items: r.items, over: along?.node };
}

/** Whether e is a list: a literal, a data column or a named list, or one
 *  mapped over, filtered (s[s > 0.3]) or sliced — not one reduced or
 *  indexed to a number (as staysList). */
function listValued(e: Expr, ctx: Ctx): boolean {
  if (e.kind === 'list' || e.kind === 'data') return true;
  if (e.kind === 'var') return !!ctx.opts.isList?.(e.name);
  if (e.kind === 'index') return e.args[1].kind === 'range' || listValued(e.args[1], ctx);
  if (
    e.kind === 'call' &&
    (SCALAR_REDUCTIONS.has(e.name) || ((e.name === 'min' || e.name === 'max') && e.args.length === 1))
  )
    return false;
  return childrenOf(e).some(c => listValued(c, ctx));
}

/**
 * curvature and torsion (along u, or at a point u0 of the curve), the
 * osculating circle at u0 and the Frenet frame at u0.
 */
export function curveGeometry(name: string, args: readonly Expr[], ctx: Ctx): Expr {
  const example = CURVE_OP_EXAMPLE[name];
  const needsPoint = name === 'osculating' || name === 'frame';
  if (args.length !== 2 && (needsPoint || args.length !== 1)) {
    throw new Error(
      needsPoint
        ? `${name} takes a curve and where on it: ${example}.`
        : `${name} takes a curve, and optionally where on it: ${example}.`,
    );
  }
  const { items: r, over } = curveOperand(name, args[0], ctx);
  const u0 = args[1];
  // κ(u) and τ(u) are functions of u, so k(u) = curvature(C, u) is κ; the
  // circle and frame are drawn over u of their own, which a u0 in u
  // would capture.
  const ownU = !needsPoint && !!ctx.opts.params?.has('u');
  if (u0 && (u0.kind === 'vec' || (freeVars(u0).has('u') && !ownU))) {
    throw new Error(`${name}: the second argument is where on the curve — a number, slider or t, not u: ${example}.`);
  }
  // Several points map element by element (the formulas have no branch), and the
  // circles make a family; the frame's arrows take one point at a time.
  if (name === 'frame' && u0 && listValued(u0, ctx)) {
    throw new Error(
      'frame takes one point on the curve at a time — a number, slider or t, like frame(C, 0.25) — not a list.',
    );
  }
  if (name === 'torsion' && r.length !== 3) {
    throw new Error('torsion needs a curve in space — a plane curve has none, and its curvature is signed.');
  }
  const d = (e: Expr): Expr => applyDiff(e, 'u', 1, ctx.opts, ctx.getFn);
  if (name === 'osculating') return osculatingOf(r, d, u0);
  if (name === 'frame') return frameOf(r, d, u0);
  const along = name === 'curvature' ? curvatureOf(r, d) : torsionOf(r, d);
  return u0 ? substVars(along, { u: u0 }) : over ? substVars(along, { u: over }) : along;
}
