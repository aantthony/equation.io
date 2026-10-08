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
import { type Expr, evaluate, freeVars, substVars } from './expr.ts';
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
  /** Steps to take at most (GEODESIC_MAX_STEPS). */
  maxSteps?: number;
  /** A performance.now() past which it stops where it has got to. */
  deadline?: number;
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
  sys: GeodesicSystem,
  opts: GeodesicOptions,
  /** Filled with the unit velocity (dp/ds, dq/ds) at each point but a cut
   *  end — without `spacing`, so each point is a step's. */
  velocities?: [number, number][],
): [number, number][] {
  const { domain, spacing, deadline } = opts;
  const maxSteps = opts.maxSteps ?? GEODESIC_MAX_STEPS;
  const periodic = opts.periodic ?? [false, false];
  const back = opts.length < 0;
  const total = Math.abs(opts.length);
  const [p0, q0] = opts.start;
  const out: [number, number][] = [];
  const inside = (p: number, q: number) =>
    (periodic[0] || (p >= domain[0][0] && p <= domain[0][1])) &&
    (periodic[1] || (q >= domain[1][0] && q <= domain[1][1]));
  if (!Number.isFinite(p0) || !Number.isFinite(q0) || !inside(p0, q0)) return out;
  const g = new Float64Array(10);
  /** The velocity w scaled to unit length in the metric at (p, q), or null. */
  const unit = (p: number, q: number, w1: number, w2: number): [number, number] | null => {
    sys(p, q, g);
    const [E, F, G, det] = [g[6], g[7], g[8], g[9]];
    const scale = Math.max(Math.abs(E), Math.abs(G));
    if (!(det > 1e-12 * scale * scale) || !Number.isFinite(det)) return null;
    const s2 = E * w1 * w1 + 2 * F * w1 * w2 + G * w2 * w2;
    if (!(s2 > 0) || !Number.isFinite(s2)) return null;
    const s = Math.sqrt(s2);
    return [w1 / s, w2 / s];
  };
  const sign = back ? -1 : 1;
  const w0 = unit(p0, q0, sign * opts.direction[0], sign * opts.direction[1]);
  out.push([p0, q0]);
  if (!w0 || !(total > 0)) return out;
  velocities?.push(w0);
  const f = (y: readonly number[], k: number[]) => {
    sys(y[0], y[1], g);
    const [a1, a2] = geodesicAcceleration(g, y[2], y[3]);
    k[0] = y[2];
    k[1] = y[3];
    k[2] = a1;
    k[3] = a2;
  };
  // Tolerances: the parameters against their ranges, the velocity against
  // its starting size.
  const span = [domain[0][1] - domain[0][0], domain[1][1] - domain[1][0]].map(s =>
    Number.isFinite(s) && s > 0 ? s : 1,
  );
  const speed = Math.max(Math.abs(w0[0]), Math.abs(w0[1]));
  const atol = [TOLERANCE * span[0], TOLERANCE * span[1], TOLERANCE * speed, TOLERANCE * speed];
  const hMin = total * 1e-12;
  let y = [p0, q0, w0[0], w0[1]];
  let s = 0;
  // A first step a hundredth of the way; the controller takes it from there.
  let h = total / 100;
  const ks = Array.from({ length: 7 }, () => [0, 0, 0, 0]);
  const tmp = [0, 0, 0, 0];
  f(y, ks[0]);
  for (let steps = 0; steps < maxSteps && s < total;) {
    if (deadline !== undefined && (steps & 15) === 15 && performance.now() > deadline) break;
    h = Math.min(h, total - s);
    for (let i = 1; i < 7; i++) {
      for (let c = 0; c < 4; c++) {
        let acc = y[c];
        for (let j = 0; j < i; j++) acc += h * A[i][j] * ks[j][c];
        tmp[c] = acc;
      }
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
    if (!Number.isFinite(err)) {
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
    const pieces = spacing ? Math.min(256, Math.ceil(h / spacing)) : 1;
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
    const w = unit(next[0], next[1], next[2], next[3]);
    // Where the metric degenerates (a pole), end at the last good point.
    if (!w) break;
    for (let k = 1; k < pieces; k++) out.push(along(k / pieces));
    y = [next[0], next[1], w[0], w[1]];
    s += h;
    out.push([y[0], y[1]]);
    velocities?.push([y[2], y[3]]);
    f(y, ks[0]);
    h = h * Math.min(5, 0.9 * Math.max(err, 1e-10) ** -0.2);
  }
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
}

const NAN: Expr = { kind: 'num', value: NaN };

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
  { maxPoints = GEODESIC_MAX_POINTS, ...budget }: { maxSteps?: number; deadline?: number; maxPoints?: number } = {},
): number[] {
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
