/**
 * Differential geometry of a parametric surface r(u, v) in space: its
 * Gaussian and mean curvature, and its geodesics.
 *
 * `gaussian(S)` and `meancurvature(S)` expand at resolve time as
 * `curvature(C)` does (lib/curves.ts, lib/defs.ts): written out of r's
 * first and second partial derivatives, taken symbolically, so sliders and t
 * work inside them and what they expand to is an ordinary expression in u and
 * v. `geodesic(S, (u0, v0), (du, dv))` is integrated numerically as it is
 * drawn (traceGeodesic), from Christoffel symbols that are expanded the same
 * way.
 *
 * Everything is built from
 *   n  = r_u × r_v                the normal, not made unit,
 *   W² = n · n = EG − F²          the metric's determinant,
 *   E, F, G = r_u·r_u, r_u·r_v, r_v·r_v      (the first fundamental form)
 *   L′, M′, N′ = r_uu·n, r_uv·n, r_vv·n      (the second, times W)
 * so that
 *   K = (L′N′ − M′²)/W⁴,   H = (E N′ − 2F M′ + G L′)/(2 W³).
 * K needs no square root at all. W² is taken from the cross product rather
 * than Lagrange's EG − F², whose rounding (ε E G) reads a flat surface
 * parametrised at varying speed as bent — the reason lib/curves.ts takes κ
 * from r′ × r″.
 *
 * The sign of H is the normal's: n = r_u × r_v points to the side H is
 * negative toward when the surface bends away from it. The sphere
 * (R cos v cos u, R cos v sin u, R sin v) has n outward, so H = −1/R there;
 * swapping u and v (or reversing either) flips n, and H with it. K does not
 * depend on the normal.
 *
 * The geodesic equations are
 *   u″ + Γᵘ_uu u′² + 2Γᵘ_uv u′v′ + Γᵘ_vv v′² = 0   (and likewise v″),
 * with the Christoffel symbols of the metric,
 *   Γᵏ_ij = ½ gᵏˡ (∂_i g_jl + ∂_j g_il − ∂_l g_ij) = gᵏˡ (r_ij · r_l):
 * for a surface in space the bracket is exactly r_ij · r_l (differentiate
 * g_jl = r_j · r_l), which needs only the second derivatives K and H already
 * take rather than derivatives of E, F and G. christoffelFromMetric is the
 * metric's own formula, for a metric not given by an embedding (and the tests
 * check that both agree).
 */
import { NonSmoothError, add, diff, div, mul, pow, sub } from './diff.ts';
import { type Expr, evaluate, exprKey, freeVars, substVars } from './expr.ts';
import { type Prog, compileProg, run } from './vm.ts';

/** ∂e/∂v, as the resolver takes it (symbolic, with its fallbacks). */
export type Partial = (e: Expr, v: string) => Expr;

/** The surface's two parameters: u and v, or x and y on a surface panel. */
export type Params = readonly [string, string];
const UV: Params = ['u', 'v'];

const num = (value: number): Expr => ({ kind: 'num', value });
const dot = (a: readonly Expr[], b: readonly Expr[]): Expr => a.map((ak, k) => mul(ak, b[k])).reduce(add);
const cross = (a: readonly Expr[], b: readonly Expr[]): Expr[] =>
  a.map((_, k) => sub(mul(a[(k + 1) % 3], b[(k + 2) % 3]), mul(a[(k + 2) % 3], b[(k + 1) % 3])));

/** Step of the symbolic central difference used where diff() cannot go (as
 *  lib/defs.ts applyDiff). */
const FD_H = 1e-4;

/** ∂e/∂v symbolically, or a symbolic central difference where e has no
 *  usable derivative (floor, gamma, …). */
export const smoothPartial: Partial = (e, v) => {
  try {
    return diff(e, v);
  } catch (err) {
    if (!(err instanceof NonSmoothError)) throw err;
    const at = (h: number) => substVars(e, { [v]: add({ kind: 'var', name: v }, num(h)) });
    return div(sub(at(FD_H), at(-FD_H)), num(2 * FD_H));
  }
};

/** The fundamental forms of r at a general point of (a, b). */
function forms(r: readonly Expr[], d: Partial, [a, b]: Params = UV) {
  const ru = r.map(e => d(e, a));
  const rv = r.map(e => d(e, b));
  const ruu = ru.map(e => d(e, a));
  const ruv = ru.map(e => d(e, b));
  const rvv = rv.map(e => d(e, b));
  const n = cross(ru, rv);
  return {
    ru,
    rv,
    ruu,
    ruv,
    rvv,
    E: dot(ru, ru),
    F: dot(ru, rv),
    G: dot(rv, rv),
    W2: dot(n, n),
    L: dot(ruu, n),
    M: dot(ruv, n),
    N: dot(rvv, n),
  };
}

function check(r: readonly Expr[]) {
  if (r.length !== 3) throw new Error('A surface has three components, like (u, v, u^2 - v^2).');
}

/** K = (LN − M²)/(EG − F²), an expression in the parameters. */
export function gaussianOf(r: readonly Expr[], d: Partial, params: Params = UV): Expr {
  check(r);
  const { L, M, N, W2 } = forms(r, d, params);
  return div(sub(mul(L, N), pow(M, num(2))), pow(W2, num(2)));
}

/** H = (EN − 2FM + GL)/(2(EG − F²)), with the normal r_u × r_v. */
export function meanCurvatureOf(r: readonly Expr[], d: Partial, params: Params = UV): Expr {
  check(r);
  const { E, F, G, L, M, N, W2 } = forms(r, d, params);
  const top = add(sub(mul(E, N), mul(num(2), mul(F, M))), mul(G, L));
  return div(top, mul(num(2), pow(W2, num(1.5))));
}

/** The six Christoffel symbols Γᵏ_ij of a 2D metric, in this order. */
export const SYMBOLS = ['Γ¹₁₁', 'Γ¹₁₂', 'Γ¹₂₂', 'Γ²₁₁', 'Γ²₁₂', 'Γ²₂₂'] as const;

export interface Connection {
  /** Γᵘ_uu, Γᵘ_uv, Γᵘ_vv, Γᵛ_uu, Γᵛ_uv, Γᵛ_vv (with u, v the parameters). */
  symbols: Expr[];
  /** E, F, G. */
  metric: [Expr, Expr, Expr];
  /** EG − F², from the cross product. */
  det: Expr;
}

/** Raise the index of the first-kind symbols Γ_ij,l (as [ij,u], [ij,v],
 *  ij = uu, uv, vv) with the inverse metric. */
function raise(first: readonly (readonly [Expr, Expr])[], E: Expr, F: Expr, G: Expr, det: Expr): Expr[] {
  const up = first.map(([gu, gv]) => div(sub(mul(G, gu), mul(F, gv)), det));
  const vp = first.map(([gu, gv]) => div(sub(mul(E, gv), mul(F, gu)), det));
  return [...up, ...vp];
}

/** The Levi-Civita connection of the surface's metric, from Γ_ij,l = r_ij · r_l. */
export function christoffelOf(r: readonly Expr[], d: Partial, params: Params = UV): Connection {
  check(r);
  const { ru, rv, ruu, ruv, rvv, E, F, G, W2 } = forms(r, d, params);
  const first = [ruu, ruv, rvv].map(rij => [dot(rij, ru), dot(rij, rv)] as const);
  return { symbols: raise(first, E, F, G, W2), metric: [E, F, G], det: W2 };
}

/** The same symbols from a metric E du² + 2F du dv + G dv² alone:
 *  Γ_ij,l = ½(∂_i g_jl + ∂_j g_il − ∂_l g_ij). */
export function christoffelFromMetric(E: Expr, F: Expr, G: Expr, d: Partial, [a, b]: Params = UV): Connection {
  const half = (e: Expr) => mul(num(0.5), e);
  const [Eu, Ev, Fu, Fv, Gu, Gv] = [d(E, a), d(E, b), d(F, a), d(F, b), d(G, a), d(G, b)];
  const first: [Expr, Expr][] = [
    [half(Eu), sub(Fu, half(Ev))], // uu: ½E_u, F_u − ½E_v
    [half(Ev), half(Gu)], // uv: ½E_v, ½G_u
    [sub(Fv, half(Gu)), half(Gv)], // vv: F_v − ½G_u, ½G_v
  ];
  const det = sub(mul(E, G), pow(F, num(2)));
  return { symbols: raise(first, E, F, G, det), metric: [E, F, G], det };
}

/**
 * The surface's first and second partial derivatives, the 15 numbers a
 * geodesic is integrated from: r_u, r_v, r_uu, r_uv, r_vv, three components
 * each. Everything else — E, F, G, EG − F² and the Christoffel symbols — is
 * formed from them in plain arithmetic at each point (connectionAt), rather
 * than compiled as six symbols that would each repeat the metric.
 */
export function surfaceDerivatives(r: readonly Expr[], d: Partial, params: Params = UV): Expr[] {
  check(r);
  const { ru, rv, ruu, ruv, rvv } = forms(r, d, params);
  return [...ru, ...rv, ...ruu, ...ruv, ...rvv];
}

/**
 * The connection at a point from surfaceDerivatives' 15 numbers there:
 * `out` gets Γᵘ_uu, Γᵘ_uv, Γᵘ_vv, Γᵛ_uu, Γᵛ_uv, Γᵛ_vv (SYMBOLS), then E, F, G
 * and EG − F² (from the cross product), as christoffelOf writes them.
 */
export function connectionAt(r: ArrayLike<number>, out: Float64Array): void {
  const [ux, uy, uz, vx, vy, vz] = [r[0], r[1], r[2], r[3], r[4], r[5]];
  const E = ux * ux + uy * uy + uz * uz;
  const F = ux * vx + uy * vy + uz * vz;
  const G = vx * vx + vy * vy + vz * vz;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const det = nx * nx + ny * ny + nz * nz;
  for (let ij = 0; ij < 3; ij++) {
    const k = 6 + 3 * ij;
    const a = r[k] * ux + r[k + 1] * uy + r[k + 2] * uz;
    const b = r[k] * vx + r[k + 1] * vy + r[k + 2] * vz;
    out[ij] = (G * a - F * b) / det;
    out[3 + ij] = (E * b - F * a) / det;
  }
  out[6] = E;
  out[7] = F;
  out[8] = G;
  out[9] = det;
}

/** −Γᵏ_ij w^i w^j: the parameter acceleration of a geodesic at velocity w. */
export function geodesicAcceleration(g: ArrayLike<number>, w1: number, w2: number): [number, number] {
  const a = w1 * w1;
  const b = 2 * w1 * w2;
  const c = w2 * w2;
  return [-(g[0] * a + g[1] * b + g[2] * c), -(g[3] * a + g[4] * b + g[5] * c)];
}

/** A surface's connection as numbers: at (p, q), connectionAt's ten
 *  numbers written into `out`. */
export type GeodesicSystem = (p: number, q: number, out: Float64Array) => void;

/**
 * What a geodesic is integrated from, in its two drawn coordinates (p, q):
 * a surface's connection (surfaceFlow), or a metric's with a cyclic time
 * coordinate eliminated through its conserved energy (lib/metric.ts
 * metricFlow).
 */
export interface GeodesicFlow {
  /** (d²p/ds², d²q/ds²) at (p, q) with velocity (w1, w2), written to `out`. */
  accel(p: number, q: number, w1: number, w2: number, out: number[]): void;
  /**
   * The velocity put back on the geodesic's constraint at (p, q) — unit
   * speed, or the speed its energy sets — so drift does not build up; null
   * where the metric degenerates or blows up there (a pole, a horizon).
   */
  normalize(p: number, q: number, w1: number, w2: number): [number, number] | null;
  /** Whether the flow holds at (p, q) (normalize would not refuse it there),
   *  checked at each stage of a step, when the metric can stay finite past
   *  where it stops being one (a horizon). */
  holds?(p: number, q: number): boolean;
}

/** A surface's geodesic flow, at unit speed in its metric. */
export function surfaceFlow(sys: GeodesicSystem): GeodesicFlow {
  const g = new Float64Array(10);
  return {
    accel(p, q, w1, w2, out) {
      sys(p, q, g);
      const [a1, a2] = geodesicAcceleration(g, w1, w2);
      out[0] = a1;
      out[1] = a2;
    },
    normalize(p, q, w1, w2) {
      sys(p, q, g);
      const [E, F, G, det] = [g[6], g[7], g[8], g[9]];
      const scale = Math.max(Math.abs(E), Math.abs(G));
      if (!(det > 1e-12 * scale * scale) || !Number.isFinite(det)) return null;
      const s2 = E * w1 * w1 + 2 * F * w1 * w2 + G * w2 * w2;
      if (!(s2 > 0) || !Number.isFinite(s2)) return null;
      const s = Math.sqrt(s2);
      return [w1 / s, w2 / s];
    },
  };
}

export interface GeodesicOptions {
  start: readonly [number, number];
  /** The starting direction in the parameters; its length does not matter. */
  direction: readonly [number, number];
  /** Arc length to run, on the surface; negative runs back along −direction. */
  length: number;
  /** The parameters' ranges: a geodesic stops where it leaves one… */
  domain: readonly [readonly [number, number], readonly [number, number]];
  /** …unless the surface repeats across it (a torus's angles). */
  periodic?: readonly [boolean, boolean];
  /**
   * The longest gap between drawn points, in arc length: each step, which
   * the controller makes as long as the accuracy allows, is filled in by
   * its cubic Hermite interpolant (from the point and velocity at both ends,
   * no more evaluations). Without it, only the steps' own points.
   */
  spacing?: number;
  /**
   * The longest gap between drawn points measured in p and q themselves
   * (the plane a metric's geodesic is drawn on), rather than in arc length.
   */
  drawSpacing?: number;
  /**
   * Where a geodesic with no length of its own stops: after this much drawn
   * length in p and q. It also stops once it makes no visible headway (64
   * steps moving less than a millionth of the domain), as one crawling into
   * a horizon or off to an ideal boundary does. A plane's.
   */
  drawnLimit?: number;
  /** Points to draw at most; past them only the steps' own points. */
  maxPoints?: number;
  /**
   * The longest step, measured in p and q: a step that long can stride over
   * a region where the flow fails (a black hole seen from afar) between its
   * stages without the error estimate seeing it, so a plane's steps are
   * held to a small part of the window.
   */
  maxStride?: number;
  /** Steps to take at most (GEODESIC_MAX_STEPS). */
  maxSteps?: number;
  /** A performance.now() past which it stops where it has got to. */
  deadline?: number;
  /** Filled in with how far it ran, and whether its budget (maxSteps or
   *  deadline) is what stopped it short of `length`. */
  ended?: GeodesicEnd;
}

/** How a geodesic ended: the arc length it ran, out of `asked`, and whether
 *  it ran out of its budget rather than reached an end of its own. */
export interface GeodesicEnd {
  length: number;
  asked: number;
  budget: boolean;
  /** Why it could not start at all (faster than light there, say). */
  problem?: string;
}

/** Steps a geodesic takes at most. */
export const GEODESIC_MAX_STEPS = 20000;
/** Relative accuracy each step is held to. */
const TOLERANCE = 1e-9;

// Dormand–Prince 5(4): the stages' coefficients, and the weights of the
// fifth-order step and of the fourth-order one it is checked against.
const A = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
];
const B5 = A[6].concat(0);
const B4 = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40];

/** Coordinate c of the cubic Hermite interpolant of a step of length h from
 *  y to z (position and velocity, [p, q, p′, q′]), at the fraction t. */
function hermite(y: readonly number[], z: readonly number[], h: number, c: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * y[c] +
    (t3 - 2 * t2 + t) * h * y[c + 2] +
    (-2 * t3 + 3 * t2) * z[c] +
    (t3 - t2) * h * z[c + 2]
  );
}

/**
 * The geodesic from `start` in `direction`, as parameter points (p, q), from
 * the start to where it ends: after `length` of arc, where it leaves the
 * domain (cut at the edge), where the metric degenerates (a sphere's pole, a
 * cone's apex: EG − F² falls to nothing beside E and G) or stops being
 * defined, or when its step or time budget runs out. It runs at unit speed —
 * the velocity is put back to length 1 in the metric after every step — with
 * adaptive Dormand–Prince steps, so the arc length is the step variable.
 */
export function traceGeodesic(
  sys: GeodesicSystem | GeodesicFlow,
  opts: GeodesicOptions,
  /** Filled with the unit velocity (dp/ds, dq/ds) at each point but a cut
   *  end — without `spacing`, so each point is a step's. */
  velocities?: [number, number][],
): [number, number][] {
  const { domain, spacing, deadline, drawSpacing, drawnLimit } = opts;
  const flow = typeof sys === 'function' ? surfaceFlow(sys) : sys;
  const maxSteps = opts.maxSteps ?? GEODESIC_MAX_STEPS;
  const maxPoints = opts.maxPoints ?? Infinity;
  const periodic = opts.periodic ?? [false, false];
  const back = opts.length < 0;
  const total = Math.abs(opts.length);
  const [p0, q0] = opts.start;
  const out: [number, number][] = [];
  const inside = (p: number, q: number) =>
    (periodic[0] || (p >= domain[0][0] && p <= domain[0][1])) &&
    (periodic[1] || (q >= domain[1][0] && q <= domain[1][1]));
  if (!Number.isFinite(p0) || !Number.isFinite(q0) || !inside(p0, q0)) return out;
  const sign = back ? -1 : 1;
  const w0 = flow.normalize(p0, q0, sign * opts.direction[0], sign * opts.direction[1]);
  out.push([p0, q0]);
  if (opts.ended) Object.assign(opts.ended, { length: 0, asked: total, budget: false });
  if (!w0 || !(total > 0)) return out;
  velocities?.push(w0);
  const acc = [0, 0];
  const f = (y: readonly number[], k: number[]) => {
    flow.accel(y[0], y[1], y[2], y[3], acc);
    k[0] = y[2];
    k[1] = y[3];
    k[2] = acc[0];
    k[3] = acc[1];
  };
  // Tolerances: the parameters against their ranges, the velocity against
  // its starting size.
  const span = [domain[0][1] - domain[0][0], domain[1][1] - domain[1][0]].map(s =>
    Number.isFinite(s) && s > 0 ? s : 1,
  );
  // (A particle let go from rest starts with none: then 1.)
  const speed = Math.max(Math.abs(w0[0]), Math.abs(w0[1])) || 1;
  const atol = [TOLERANCE * span[0], TOLERANCE * span[1], TOLERANCE * speed, TOLERANCE * speed];
  // With no length of its own, the step sizes start from the arc it takes
  // to cross the drawn limit at the starting speed.
  const reach = Number.isFinite(total)
    ? total
    : drawnLimit !== undefined
      ? drawnLimit / (Math.hypot(w0[0], w0[1]) || 1)
      : 1;
  const hMin = reach * 1e-12;
  let y = [p0, q0, w0[0], w0[1]];
  let s = 0;
  // A first step a hundredth of the way; the controller takes it from there.
  let h = reach / 100;
  const ks = Array.from({ length: 7 }, () => [0, 0, 0, 0]);
  const tmp = [0, 0, 0, 0];
  f(y, ks[0]);
  let steps = 0;
  let outOfBudget = false;
  // Drawn length so far, and where it stood 64 steps ago (a stall).
  let drawn = 0;
  let mark = [p0, q0];
  const still = 1e-6 * Math.hypot(span[0], span[1]);
  while (s < total) {
    if (steps >= maxSteps || (deadline !== undefined && (steps & 15) === 15 && performance.now() > deadline)) {
      outOfBudget = true;
      break;
    }
    h = Math.min(h, total - s);
    if (opts.maxStride) h = Math.min(h, opts.maxStride / (Math.hypot(y[2], y[3]) || 1));
    // A stage where the flow does not hold (across a horizon, where the
    // metric is finite but no longer Lorentzian) rejects the step, as one
    // off the domain of definition does: the step shortens toward it.
    let off = false;
    for (let i = 1; i < 7; i++) {
      for (let c = 0; c < 4; c++) {
        let acc = y[c];
        for (let j = 0; j < i; j++) acc += h * A[i][j] * ks[j][c];
        tmp[c] = acc;
      }
      if (flow.holds && !flow.holds(tmp[0], tmp[1])) off = true;
      f(tmp, ks[i]);
    }
    const next = [0, 0, 0, 0];
    let err = 0;
    for (let c = 0; c < 4; c++) {
      let hi = y[c];
      let e = 0;
      for (let j = 0; j < 7; j++) {
        hi += h * B5[j] * ks[j][c];
        e += h * (B5[j] - B4[j]) * ks[j][c];
      }
      next[c] = hi;
      const sc = atol[c] + TOLERANCE * Math.max(Math.abs(y[c]), Math.abs(hi));
      err = Math.max(err, Math.abs(e) / sc);
    }
    if (off || !Number.isFinite(err)) {
      // Off the surface's domain of definition: shorten toward it, and stop
      // once the step is nothing.
      h /= 4;
      if (h < hMin) break;
      continue;
    }
    if (err > 1) {
      h = Math.max(h * Math.max(0.2, 0.9 * err ** -0.2), hMin);
      if (h <= hMin) break;
      continue;
    }
    steps++;
    // The points between, along the step's interpolant (its velocity ends
    // as integrated, before it is put back to unit length).
    const pieces =
      out.length >= maxPoints
        ? 1
        : drawSpacing
          ? Math.max(1, Math.min(256, Math.ceil(Math.hypot(next[0] - y[0], next[1] - y[1]) / drawSpacing)))
          : spacing
            ? Math.min(256, Math.ceil(h / spacing))
            : 1;
    const along = (t: number): [number, number] => [hermite(y, next, h, 0, t), hermite(y, next, h, 1, t)];
    if (!inside(next[0], next[1])) {
      // Cut at the first edge it crosses: the first piece that leaves, then
      // bisection along the interpolant within it.
      let t0 = 0;
      let t1 = 1;
      for (let k = 1; k <= pieces; k++) {
        const t = k / pieces;
        if (!inside(...along(t))) {
          t1 = t;
          break;
        }
        t0 = t;
        out.push(along(t));
      }
      for (let i = 0; i < 50; i++) {
        const t = (t0 + t1) / 2;
        if (inside(...along(t))) t0 = t;
        else t1 = t;
      }
      // On the edge exactly, in the coordinate that crossed it.
      const edge = along(t0);
      for (let c = 0; c < 2; c++) {
        if (periodic[c]) continue;
        const crossed = along(t1)[c];
        if (crossed < domain[c][0]) edge[c] = domain[c][0];
        else if (crossed > domain[c][1]) edge[c] = domain[c][1];
      }
      out.push(edge);
      break;
    }
    // Back to unit speed: the drift is rounding and truncation, and the
    // arc length s is then the parameter the steps are taken in.
    const w = flow.normalize(next[0], next[1], next[2], next[3]);
    // Where the metric degenerates (a pole), end at the last good point.
    if (!w) break;
    for (let k = 1; k < pieces; k++) out.push(along(k / pieces));
    if (drawnLimit !== undefined) drawn += Math.hypot(next[0] - y[0], next[1] - y[1]);
    y = [next[0], next[1], w[0], w[1]];
    s += h;
    out.push([y[0], y[1]]);
    velocities?.push([y[2], y[3]]);
    if (drawnLimit !== undefined) {
      if (drawn >= drawnLimit) break;
      if (steps % 64 === 0) {
        if (Math.hypot(y[0] - mark[0], y[1] - mark[1]) < still) break;
        mark = [y[0], y[1]];
      }
    }
    f(y, ks[0]);
    h = h * Math.min(5, 0.9 * Math.max(err, 1e-10) ** -0.2);
  }
  if (opts.ended) Object.assign(opts.ended, { length: s, asked: total, budget: outOfBudget });
  return out;
}

/** Whether the surface P repeats across each parameter's range: P(p + span,
 *  q) = P(p, q) at a spread of points (a torus's angles, a sphere's
 *  longitude), so a geodesic runs on across that edge rather than stopping. */
export function periodicAxes(
  P: (p: number, q: number) => readonly number[],
  domain: GeodesicOptions['domain'],
): [boolean, boolean] {
  const [[p0, p1], [q0, q1]] = domain;
  const sp = p1 - p0;
  const sq = q1 - q0;
  const test = (shift: (p: number, q: number) => [number, number]) => {
    let any = false;
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 5; j++) {
        const p = p0 + (sp * (i + 0.37)) / 5;
        const q = q0 + (sq * (j + 0.41)) / 5;
        const a = P(p, q);
        const b = P(...shift(p, q));
        if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) continue;
        const size = Math.max(1, ...a.map(Math.abs));
        if (a.some((c, k) => Math.abs(c - b[k]) > 1e-9 * size)) return false;
        any = true;
      }
    return any;
  };
  return [
    Number.isFinite(sp) && sp > 0 && test((p, q) => [p + sp, q]),
    Number.isFinite(sq) && sq > 0 && test((p, q) => [p, q + sq]),
  ];
}

/** The length a geodesic runs by default: twice the diagonal of the box
 *  round the surface — once round a sphere and a little more, across a
 *  patch and out of it. */
export function defaultGeodesicLength(
  P: (p: number, q: number) => readonly number[],
  domain: GeodesicOptions['domain'],
): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const [[p0, p1], [q0, q1]] = domain;
  const n = 16;
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++) {
      const pt = P(p0 + ((p1 - p0) * i) / n, q0 + ((q1 - q0) * j) / n);
      if (!pt.every(Number.isFinite)) continue;
      pt.forEach((c, k) => {
        lo[k] = Math.min(lo[k], c);
        hi[k] = Math.max(hi[k], c);
      });
    }
  const diagonal = Math.hypot(...hi.map((h, k) => (h > lo[k] ? h - lo[k] : 0)));
  return Number.isFinite(diagonal) && diagonal > 0 ? 2 * diagonal : 1;
}

/**
 * Expressions in the parameters (and in `env`'s names, at their values) as
 * one function of (p, q): compiled to stack programs, or evaluated where a
 * program cannot be made. A value that cannot be had is NaN.
 */
export function numericIn(
  exprs: readonly Expr[],
  [a, b]: Params,
  env: Readonly<Record<string, number>> = {},
): (p: number, q: number, out: Float64Array) => void {
  const names = new Set<string>([a, b]);
  for (const e of exprs) for (const n of freeVars(e)) names.add(n);
  const slots = new Map([...names].map((n, k) => [n, k]));
  const vars = new Float64Array(slots.size);
  for (const [n, k] of slots) vars[k] = env[n] ?? NaN;
  const ia = slots.get(a)!;
  const ib = slots.get(b)!;
  const fns = exprs.map(e => {
    let prog: Prog | null = null;
    try {
      prog = compileProg(e, slots);
    } catch {
      /* evaluated */
    }
    if (prog) {
      const stack = new Float64Array(Math.max(1, prog.depth));
      const p = prog;
      return () => {
        try {
          return run(p, vars, stack);
        } catch {
          return NaN;
        }
      };
    }
    return () => {
      try {
        return evaluate(e, { ...env, [a]: vars[ia], [b]: vars[ib] });
      } catch {
        return NaN;
      }
    };
  });
  return (p, q, out) => {
    vars[ia] = p;
    vars[ib] = q;
    for (let k = 0; k < fns.length; k++) out[k] = fns[k]();
  };
}

/** A surface's connection as numbers, from its surfaceDerivatives, its
 *  sliders read from `env`: one evaluation of the 15 derivatives a point. */
export function geodesicSystem(
  derivatives: readonly Expr[],
  params: Params = UV,
  env: Readonly<Record<string, number>> = {},
): GeodesicSystem {
  const at = numericIn(derivatives, params, env);
  const r = new Float64Array(15);
  return (p, q, out) => {
    at(p, q, r);
    connectionAt(r, out);
  };
}

/**
 * The gain a diverging colouring multiplies a scalar on a surface by before
 * tanh, so its typical size reads as strong colour: 1.5 over the 90th
 * percentile of |f| at a lattice of points (the largest few are left out, as
 * curvature runs off to infinity at a cusp). 1 when f is no larger than
 * `floor` (rounding: a plane's K) everywhere, or nowhere defined.
 */
export function divergingGain(
  f: (p: number, q: number) => number,
  [[p0, p1], [q0, q1]]: GeodesicOptions['domain'],
  floor = 0,
): number {
  const n = 24;
  const sizes: number[] = [];
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++) {
      const k = Math.abs(f(p0 + ((p1 - p0) * (i + 0.5)) / (n + 1), q0 + ((q1 - q0) * (j + 0.5)) / (n + 1)));
      if (Number.isFinite(k)) sizes.push(k);
    }
  if (!sizes.length) return 1;
  sizes.sort((a, b) => a - b);
  const typical = sizes[Math.floor(0.9 * (sizes.length - 1))];
  return typical > floor ? 1.5 / typical : 1;
}

/** What a geodesic row draws (lib/analysis.ts classifyGeodesic). */
export interface GeodesicSpec {
  /** 3: on the surface, in space; 2: in the parameters themselves (a panel's
   *  x and y), for an on(…) panel to carry onto its surface. */
  readonly dim: 2 | 3;
  readonly params: Params;
  /** The surface in the parameters. */
  readonly surface: readonly Expr[];
  /** Its first and second derivatives (surfaceDerivatives). */
  readonly derivatives: readonly Expr[];
  readonly start: readonly Expr[];
  readonly direction: readonly Expr[];
  /** Arc length; when absent, defaultGeodesicLength. */
  readonly length?: Expr;
  /** The parameters' ranges: lo and hi of the first, then of the second. */
  readonly domain: readonly Expr[];
  /**
   * A plane panel's own metric (a `ds^2 = …` row, lib/metric.ts), which the
   * geodesic follows instead of a surface's: then `surface` is (x, y, 0),
   * `derivatives` and `domain` are empty, and it is traced over the window
   * it is drawn in.
   */
  readonly metric?: MetricSpec;
}

/** How a geodesic of a metric moves, and so what its velocity's size means. */
export type Motion = 'riemannian' | 'timelike' | 'null';

/**
 * A metric written in a plane panel's x and y, and maybe one more coordinate
 * τ (first) that no component depends on — a stationary spacetime's time.
 */
export interface MetricSpec {
  /** 2: x and y; 3: τ, x and y. */
  readonly n: 2 | 3;
  /** g_ij as written — in the panel's coordinates A, B (x and y, or r and
   *  phi), each a function of x and y — the upper triangle row by row:
   *  g_AA, g_AB, g_BB, or g_ττ, g_τA, g_τB, g_AA, g_AB, g_BB. */
  readonly components: readonly Expr[];
  /** ∂g/∂x of each, then ∂g/∂y. */
  readonly derivatives: readonly Expr[];
  /**
   * When A and B are not x and y: their Jacobian ∂(A, B)/∂(x, y), row-major
   * (∂A/∂x, ∂A/∂y, ∂B/∂x, ∂B/∂y), then its ∂/∂x, then its ∂/∂y. The metric
   * is pulled back to x and y with it at each point, g_xy = Jᵀ g J — in
   * numbers, which is several times cheaper than the pulled-back
   * components written out and differentiated.
   */
  readonly jacobian?: readonly Expr[];
  /** Unit speed (a Riemannian metric), proper time (a massive particle) or
   *  a light ray's affine parameter. */
  readonly motion: Motion;
  /** τ's name, for what it says. */
  readonly time?: string;
}

const NAN: Expr = { kind: 'num', value: NaN };

/**
 * What a geodesic's trace depends on besides the values of the names it
 * reads, as a string: its plan — the surface, start, direction, length and
 * domain as written in, after lists and definitions are inlined, which an
 * edit to another row (S's formula, a list of directions, the panel's
 * surface) changes. It is traced again when this or those values change.
 */
export function geodesicPlanKey(spec: GeodesicSpec): string {
  return JSON.stringify([
    spec.dim,
    spec.params,
    ...[spec.surface, spec.start, spec.direction, spec.domain].map(list => list.map(exprKey)),
    spec.length ? exprKey(spec.length) : null,
    spec.metric
      ? [
          spec.metric.n,
          spec.metric.motion,
          ...[spec.metric.components, spec.metric.derivatives, spec.metric.jacobian ?? []].map(l => l.map(exprKey)),
        ]
      : null,
  ]);
}

/** The note for a geodesic its budget stopped short, or null. */
export function geodesicCutNote(end: GeodesicEnd): string | null {
  if (end.problem) return end.problem;
  // One run with no length of its own (a metric's, to the window's edge)
  // has no length to fall short of, only a place.
  if (!Number.isFinite(end.asked)) return end.budget ? `cut short at L ≈ ${Number(end.length.toPrecision(3))}` : null;
  if (!end.budget || !(end.length < end.asked)) return null;
  const n = (x: number) => Number(x.toPrecision(3));
  return `cut short at L ≈ ${n(end.length)} of ${n(end.asked)}`;
}

/** Points a geodesic is drawn with along the size of its surface's box, at
 *  least where its length allows. */
const DRAWN_ACROSS = 150;
/** Points a geodesic is drawn with at most, unless its budget says fewer. */
export const GEODESIC_MAX_POINTS = 4000;

/**
 * The geodesic a row draws, at the values in `env` (sliders, t, a named
 * point's coordinates): its points on the surface in space, flat — for a
 * panel's surface too (dim 2), which so need not carry them itself.
 * Empty when its domain cannot be had; the start alone when it has no
 * direction. `budget` caps its steps and the time it may take
 * (traceGeodesic), and the points it is drawn with, so a long one, or many,
 * cannot run on unbounded.
 */
export function geodesicPath(
  spec: GeodesicSpec,
  env: Readonly<Record<string, number>>,
  {
    maxPoints = GEODESIC_MAX_POINTS,
    window,
    ...budget
  }: {
    maxSteps?: number;
    deadline?: number;
    maxPoints?: number;
    ended?: GeodesicEnd;
    /** Where a metric's geodesic is traced: the box round the window it is
     *  drawn in (traceWindow). */
    window?: GeodesicOptions['domain'];
  } = {},
): number[] {
  if (spec.metric) return metricPath(spec, spec.metric, env, { maxPoints, window, ...budget });
  const values = new Float64Array(9);
  numericIn([...spec.start, ...spec.direction, ...spec.domain, spec.length ?? NAN], spec.params, env)(NaN, NaN, values);
  const v = [...values];
  const domain: GeodesicOptions['domain'] = [
    [v[4], v[5]],
    [v[6], v[7]],
  ];
  if (!(v[5] > v[4]) || !(v[7] > v[6]) || !domain.flat().every(Number.isFinite)) return [];
  const embed = numericIn(spec.surface, spec.params, env);
  const out = new Float64Array(3);
  const P = (p: number, q: number): number[] => (embed(p, q, out), [out[0], out[1], out[2]]);
  const size = defaultGeodesicLength(P, domain);
  const length = spec.length ? v[8] : size;
  if (!Number.isFinite(length)) return [];
  const path = traceGeodesic(geodesicSystem(spec.derivatives, spec.params, env), {
    start: [v[0], v[1]],
    direction: [v[2], v[3]],
    length,
    domain,
    periodic: periodicAxes(P, domain),
    spacing: Math.max(size / 2 / DRAWN_ACROSS, Math.abs(length) / maxPoints),
    ...budget,
  });
  const pts: number[] = [];
  for (const [p, q] of path) pts.push(...P(p, q));
  return pts;
}

/*
 * Geodesics of a metric on a plane panel (a `ds^2 = …` row, lib/metric.ts).
 *
 * The metric is written in the panel's x and y — pulled back through the
 * Jacobian of the coordinates it was written in, so the curve is integrated
 * and drawn in x and y with no inverse map — and at most one more coordinate
 * τ that no component depends on (a static or stationary spacetime's time).
 * Only g and its first derivatives in x and y are compiled; the connection
 * Γ_λμν U^μ U^ν = (∂_μ g_λν) U^μ U^ν − ½ (∂_λ g_μν) U^μ U^ν is formed from
 * them at each point and raised by solving g z = (…), as connectionAt does
 * for a surface.
 *
 * τ is eliminated: its momentum E = −g_τμ U^μ is conserved, so
 * U^τ = −(E + g_τi U^i)/g_ττ, and the state is the position and velocity in
 * x and y alone. The constraint g(U, U) = κ (−1 for a massive particle, 0
 * for light) then fixes the spatial speed: γ(U, U) = κ + E²/(−g_ττ), with
 * γ_ij = g_ij − g_τi g_τj / g_ττ the metric of space, and the velocity is put
 * back to it after every step, as a surface's is put back to unit speed.
 */

/** A metric's components (MetricSpec.components), then their x and y
 *  derivatives, then its Jacobian's 12 numbers if it has one, at (x, y). */
export type MetricSystem = (p: number, q: number, out: Float64Array) => void;

/** a b c for n × n matrices (b and c may be transposed: `ta`). */
function times(a: number[][], b: number[][], ta = false): number[][] {
  const n = b.length;
  return b.map((_, i) =>
    b.map((_, j) => {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += (ta ? a[k][i] : a[i][k]) * b[k][j];
      return sum;
    }),
  );
}

/**
 * g and ∂g/∂x, ∂g/∂y in x and y as symmetric matrices at a point, read
 * through `sys` (the last point's kept, as the integrator asks for it
 * twice); pulled back through the Jacobian J when `pulled`:
 * g = Jᵀ g_AB J, ∂g = ∂Jᵀ g_AB J + Jᵀ ∂g_AB J + Jᵀ g_AB ∂J, with
 * ∂g_AB/∂x as compiled (the components are functions of x and y already).
 */
function metricReader(sys: MetricSystem, n: 2 | 3, pulled = false) {
  const m = (n * (n + 1)) / 2;
  const buf = new Float64Array(3 * m + (pulled ? 12 : 0));
  const square = () => Array.from({ length: n }, () => new Array<number>(n).fill(0));
  let g = square();
  let d = [square(), square()];
  const s0 = n - 2;
  // The full Jacobian, τ to itself, and its derivatives.
  const J = square();
  const dJ = [square(), square()];
  if (s0) J[0][0] = 1;
  let lp = NaN;
  let lq = NaN;
  return (p: number, q: number) => {
    if (p !== lp || q !== lq) {
      sys(p, q, buf);
      lp = p;
      lq = q;
      let k = 0;
      for (let i = 0; i < n; i++)
        for (let j = i; j < n; j++, k++) {
          g[i][j] = g[j][i] = buf[k];
          d[0][i][j] = d[0][j][i] = buf[m + k];
          d[1][i][j] = d[1][j][i] = buf[2 * m + k];
        }
      if (pulled) {
        for (let a = 0; a < 2; a++)
          for (let i = 0; i < 2; i++) {
            J[s0 + a][s0 + i] = buf[3 * m + 2 * a + i];
            dJ[0][s0 + a][s0 + i] = buf[3 * m + 4 + 2 * a + i];
            dJ[1][s0 + a][s0 + i] = buf[3 * m + 8 + 2 * a + i];
          }
        const gJ = times(g, J);
        const pulledG = times(J, gJ, true);
        d = [0, 1].map(v => {
          const one = times(dJ[v], gJ, true);
          const two = times(J, times(d[v], J), true);
          return one.map((row, i) => row.map((x, j) => x + one[j][i] + two[i][j]));
        });
        g = pulledG;
      }
    }
    return { g, d };
  };
}

/** A metric's g and ∂g/∂x, ∂g/∂y in x and y at (p, q), its sliders read
 *  from `env`. */
export function metricAt(
  metric: MetricSpec,
  env: Readonly<Record<string, number>>,
  p: number,
  q: number,
): { g: number[][]; d: number[][][] } {
  const sys = numericIn([...metric.components, ...metric.derivatives, ...(metric.jacobian ?? [])], ['x', 'y'], env);
  const { g, d } = metricReader(sys, metric.n, !!metric.jacobian)(p, q);
  return { g: g.map(row => [...row]), d: d.map(m => m.map(row => [...row])) };
}

/** z with g z = a, g symmetric 2 × 2 or 3 × 3. */
function solveSymmetric(g: readonly (readonly number[])[], a: readonly number[]): number[] {
  if (g.length === 2) {
    const det = g[0][0] * g[1][1] - g[0][1] * g[0][1];
    return [(g[1][1] * a[0] - g[0][1] * a[1]) / det, (g[0][0] * a[1] - g[0][1] * a[0]) / det];
  }
  const [[A, B, C], [, D, E], [, , F]] = g;
  const c00 = D * F - E * E;
  const c01 = C * E - B * F;
  const c02 = B * E - C * D;
  const c11 = A * F - C * C;
  const c12 = B * C - A * E;
  const c22 = A * D - B * B;
  const det = A * c00 + B * c01 + C * c02;
  return [
    (c00 * a[0] + c01 * a[1] + c02 * a[2]) / det,
    (c01 * a[0] + c11 * a[1] + c12 * a[2]) / det,
    (c02 * a[0] + c12 * a[1] + c22 * a[2]) / det,
  ];
}

/**
 * −Γ^i_μν U^μ U^ν for the two drawn coordinates i, from g and its x and y
 * derivatives (no coordinate but x and y is differentiated: τ is cyclic).
 * U is (U^τ, U^x, U^y), or (U^x, U^y) for a metric in x and y alone.
 */
export function metricAcceleration(
  g: readonly (readonly number[])[],
  d: readonly (readonly (readonly number[])[])[],
  U: readonly number[],
): [number, number] {
  const n = g.length;
  const s0 = n - 2;
  const lower = new Array<number>(n).fill(0);
  for (let k = 0; k < 2; k++) {
    const dk = d[k];
    const uk = U[s0 + k];
    let quad = 0;
    for (let l = 0; l < n; l++) {
      let row = 0;
      for (let v = 0; v < n; v++) row += dk[l][v] * U[v];
      lower[l] += uk * row;
      quad += U[l] * row;
    }
    lower[s0 + k] -= quad / 2;
  }
  const z = solveSymmetric(g, lower);
  return [-z[s0], -z[s0 + 1]];
}

/** How much more than its size at the start a metric may grow (or less it
 *  may shrink to) before a geodesic is taken to have met a singularity. */
const METRIC_RANGE = 1e12;

/** The largest |g_ij|. */
const metricSize = (g: readonly (readonly number[])[]) => Math.max(...g.flat().map(Math.abs));

/** The metric of space γ_ij = g_ij − g_τi g_τj / g_ττ of a 3 × 3 metric, as
 *  [γ_xx, γ_xy, γ_yy], or null unless g_ττ < 0 and γ is positive definite
 *  (a Lorentzian metric with τ timelike). */
function spaceMetric(g: readonly (readonly number[])[], size: number): [number, number, number] | null {
  const gtt = g[0][0];
  if (!(gtt < -size / METRIC_RANGE)) return null;
  const a = g[1][1] - (g[0][1] * g[0][1]) / gtt;
  const b = g[1][2] - (g[0][1] * g[0][2]) / gtt;
  const c = g[2][2] - (g[0][2] * g[0][2]) / gtt;
  const scale = Math.max(Math.abs(a), Math.abs(c));
  if (!(a > 0) || !(a * c - b * b > 1e-12 * scale * scale)) return null;
  return [a, b, c];
}

/** Whether a 2 × 2 metric is positive definite (and not nearly degenerate). */
function positive(g: readonly (readonly number[])[]): boolean {
  const [[E, F], [, G]] = g;
  const scale = Math.max(Math.abs(E), Math.abs(G));
  return E > 0 && E * G - F * F > 1e-12 * scale * scale;
}

const short = (x: number) => Number(x.toPrecision(3));

/**
 * The flow of a metric's geodesic from (p, q), set off with `direction` in x
 * and y, and the velocity it starts with — or why it cannot start there.
 *
 * - riemannian: at unit speed; only the direction matters.
 * - timelike: `direction` is the coordinate velocity d(x, y)/dτ, so its
 *   size matters; U^τ comes from g(U, U) = −1, and the step is proper time.
 * - null: only the direction matters; U^τ = 1 at the start, so the affine
 *   parameter runs like τ there.
 *
 * `sign` −1 runs it back (U and E reversed). Null when there is nothing to
 * trace (a light ray with no direction).
 */
export function metricStart(
  sys: MetricSystem,
  n: 2 | 3,
  motion: Motion,
  [p, q]: readonly [number, number],
  [a, b]: readonly [number, number],
  sign = 1,
  time = 't',
  pulled = false,
): { flow: GeodesicFlow; velocity: [number, number] } | { problem: string } | null {
  const read = metricReader(sys, n, pulled);
  const { g } = read(p, q);
  const size0 = metricSize(g);
  if (!Number.isFinite(size0) || !(size0 > 0)) return { problem: 'the metric is not defined at the start' };
  const inRange = (g: readonly (readonly number[])[]) => {
    const size = metricSize(g);
    return size < size0 * METRIC_RANGE && Number.isFinite(size);
  };
  if (n === 2) {
    if (!positive(g)) return { problem: 'the metric is not positive definite at the start' };
    const flow: GeodesicFlow = {
      accel(p, q, w1, w2, out) {
        const { g, d } = read(p, q);
        [out[0], out[1]] = metricAcceleration(g, d, [w1, w2]);
      },
      holds(p, q) {
        const { g } = read(p, q);
        return inRange(g) && positive(g);
      },
      normalize(p, q, w1, w2) {
        const { g } = read(p, q);
        if (!inRange(g) || !positive(g)) return null;
        const s2 = g[0][0] * w1 * w1 + 2 * g[0][1] * w1 * w2 + g[1][1] * w2 * w2;
        if (!(s2 > 0) || !Number.isFinite(s2)) return null;
        const s = Math.sqrt(s2);
        return [w1 / s, w2 / s];
      },
    };
    return { flow, velocity: [sign * a, sign * b] };
  }
  const gamma = spaceMetric(g, size0);
  if (!gamma)
    return {
      problem:
        g[0][0] >= 0
          ? `${time} is not timelike at the start: g_${time}${time} ≥ 0 there (inside a horizon?)`
          : 'the metric is not Lorentzian at the start',
    };
  const gtt = g[0][0];
  const beta = (u: number, v: number) => g[0][1] * u + g[0][2] * v;
  const h = (u: number, v: number) => g[1][1] * u * u + 2 * g[1][2] * u * v + g[2][2] * v * v;
  /** The rate of τ a light ray moving along (u, v) has: g(U, U) = 0 with
   *  U = (rate, u, v), the root moving forward in τ. */
  const lightRate = (u: number, v: number) => {
    const bd = beta(u, v);
    const disc = bd * bd - gtt * h(u, v);
    return (bd + Math.sqrt(Math.max(disc, 0))) / -gtt;
  };
  let w: [number, number];
  let ut: number;
  if (motion === 'null') {
    if (a === 0 && b === 0) return null;
    const rate = lightRate(a, b);
    w = [a / rate, b / rate];
    ut = 1;
  } else {
    const gvv = gtt + 2 * beta(a, b) + h(a, b);
    if (!(gvv < 0)) {
      const len = Math.hypot(a, b);
      const c = 1 / lightRate(a / len, b / len);
      return { problem: `faster than light here: at most ≈ ${short(c)} in this direction` };
    }
    ut = 1 / Math.sqrt(-gvv);
    w = [ut * a, ut * b];
  }
  // τ's momentum, conserved along it.
  const E = -sign * (gtt * ut + beta(w[0], w[1]));
  const kappa = motion === 'null' ? 0 : -1;
  const flow: GeodesicFlow = {
    accel(p, q, w1, w2, out) {
      const { g, d } = read(p, q);
      const rate = -(E + g[0][1] * w1 + g[0][2] * w2) / g[0][0];
      [out[0], out[1]] = metricAcceleration(g, d, [rate, w1, w2]);
    },
    holds(p, q) {
      const { g } = read(p, q);
      return inRange(g) && !!spaceMetric(g, size0);
    },
    normalize(p, q, w1, w2) {
      const { g } = read(p, q);
      if (!inRange(g)) return null;
      const gamma = spaceMetric(g, size0);
      if (!gamma) return null;
      const target = kappa + (E * E) / -g[0][0];
      const now = gamma[0] * w1 * w1 + 2 * gamma[1] * w1 * w2 + gamma[2] * w2 * w2;
      // Near a turning point at rest both are nearly 0, and their ratio is
      // rounding: left alone there.
      if (target > 0 && now > 0) {
        const k = Math.sqrt(target / now);
        if (Math.abs(k - 1) < 0.1) return [w1 * k, w2 * k];
      }
      return Number.isFinite(w1) && Number.isFinite(w2) ? [w1, w2] : null;
    },
  };
  return { flow, velocity: [sign * w[0], sign * w[1]] };
}

/**
 * The box a metric's geodesics are traced over for a window [lo, hi]: four
 * times the power of two at least as large as the window's larger side, on
 * a lattice of half that, so panning and zooming within a factor of two keep
 * it (and the traces) as they are, while the window stays well inside it.
 */
export function traceWindow(lo: readonly [number, number], hi: readonly [number, number]): GeodesicOptions['domain'] {
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
  const s = 2 ** Math.ceil(Math.log2(Number.isFinite(size) && size > 0 ? size : 1));
  const snap = (c: number) => Math.round(c / (s / 2)) * (s / 2);
  const cx = snap((lo[0] + hi[0]) / 2);
  const cy = snap((lo[1] + hi[1]) / 2);
  return [
    [cx - 2 * s, cx + 2 * s],
    [cy - 2 * s, cy + 2 * s],
  ];
}

/** A metric geodesic's points, (x, y, 0) flat, over `window` (a box round
 *  the start when none is given). */
function metricPath(
  spec: GeodesicSpec,
  metric: MetricSpec,
  env: Readonly<Record<string, number>>,
  {
    maxPoints,
    window,
    ended,
    ...budget
  }: {
    maxSteps?: number;
    deadline?: number;
    maxPoints: number;
    ended?: GeodesicEnd;
    window?: GeodesicOptions['domain'];
  },
): number[] {
  const values = new Float64Array(5);
  numericIn([...spec.start, ...spec.direction, spec.length ?? NAN], ['x', 'y'], env)(NaN, NaN, values);
  const [x0, y0, a, b, L] = values;
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return [];
  const length = spec.length ? L : Infinity;
  if (Number.isNaN(length) || !Number.isFinite(a) || !Number.isFinite(b)) return [x0, y0, 0];
  const domain = window ?? traceWindow([x0 - 10, y0 - 10], [x0 + 10, y0 + 10]);
  const sys = numericIn([...metric.components, ...metric.derivatives, ...(metric.jacobian ?? [])], ['x', 'y'], env);
  const start = metricStart(
    sys,
    metric.n,
    metric.motion,
    [x0, y0],
    [a, b],
    length < 0 ? -1 : 1,
    metric.time,
    !!metric.jacobian,
  );
  if (ended) Object.assign(ended, { length: 0, asked: Math.abs(length), budget: false, problem: undefined });
  if (!start) return [x0, y0, 0];
  if ('problem' in start) {
    if (ended) ended.problem = start.problem;
    return [x0, y0, 0];
  }
  const diagonal = Math.hypot(domain[0][1] - domain[0][0], domain[1][1] - domain[1][0]);
  // With no length of its own, as far as the box is across.
  const drawnLimit = spec.length ? undefined : diagonal;
  const path = traceGeodesic(start.flow, {
    start: [x0, y0],
    direction: start.velocity,
    length: Math.abs(length),
    domain,
    drawSpacing: Math.max(diagonal / 1500, (drawnLimit ?? 0) / maxPoints),
    maxStride: diagonal / 500,
    drawnLimit,
    maxPoints,
    ended,
    ...budget,
  });
  const pts: number[] = [];
  for (const [p, q] of path) pts.push(p, q, 0);
  return pts;
}

/**
 * The Christoffel symbols Γᵏ_ij of an n-dimensional metric g (n × n, in
 * `coords`), symbolically: Γᵏ_ij = gᵏˡ Γ_l,ij with
 * Γ_l,ij = ½(∂_i g_jl + ∂_j g_il − ∂_l g_ij), g⁻¹ by cofactors. A coordinate
 * the metric does not depend on (a cyclic τ) differentiates to 0. The
 * integrator forms the same from numbers (metricAcceleration); this is its
 * reference.
 */
export function christoffelOfMetric(
  g: readonly (readonly Expr[])[],
  coords: readonly string[],
  d: Partial,
): Expr[][][] {
  const n = g.length;
  const dg = coords.map(c => g.map(row => row.map(e => d(e, c))));
  const first = (l: number, i: number, j: number) => mul(num(0.5), sub(add(dg[i][j][l], dg[j][i][l]), dg[l][i][j]));
  let inverse: Expr[][];
  if (n === 2) {
    const det = sub(mul(g[0][0], g[1][1]), mul(g[0][1], g[1][0]));
    inverse = [
      [div(g[1][1], det), div(mul(num(-1), g[0][1]), det)],
      [div(mul(num(-1), g[1][0]), det), div(g[0][0], det)],
    ];
  } else if (n === 3) {
    const cof = (i: number, j: number) => {
      const r = [0, 1, 2].filter(k => k !== i);
      const c = [0, 1, 2].filter(k => k !== j);
      const minor = sub(mul(g[r[0]][c[0]], g[r[1]][c[1]]), mul(g[r[0]][c[1]], g[r[1]][c[0]]));
      return (i + j) % 2 ? mul(num(-1), minor) : minor;
    };
    const det = [0, 1, 2].map(j => mul(g[0][j], cof(0, j))).reduce(add);
    inverse = [0, 1, 2].map(i => [0, 1, 2].map(j => div(cof(j, i), det)));
  } else throw new Error('A metric here has two or three coordinates.');
  const idx = [...Array(n).keys()];
  return idx.map(k => idx.map(i => idx.map(j => idx.map(l => mul(inverse[k][l], first(l, i, j))).reduce(add))));
}
