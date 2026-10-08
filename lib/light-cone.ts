/**
 * Light cones of a panel's metric (a `ds^2 = …` row, lib/metric.ts), as
 * numbers and as glyphs: `lightcones` draws them on a lattice over the
 * window, `lightcone(P)` one at a point.
 *
 * On a spacetime diagram — a Lorentzian metric in the panel's own two
 * coordinates, like -dy^2 + dx^2 — a light cone is two null lines through
 * the point, and is drawn as a filled wedge opening toward the future, with
 * the past half as two strokes. Which half is the future is the metric's
 * business, not y's. Its time coordinate τ is the one of the two written
 * whose own d²-term is negative at more of the points checked (dt in
 * -dt^2 + dx^2, v in Eddington–Finkelstein's -(1 - 2M/r) dv^2 + 2 dv dr),
 * else y (lib/metric.ts), and the future half is the one along which τ
 * increases: dτ(axis) > 0. That is continuous wherever τ is a time — even
 * where ∂τ is not timelike, as inside Eddington–Finkelstein's horizon,
 * where every future cone still has v increasing — and changes only where
 * a cone straddles dτ = 0. Where dτ(axis) is 0 exactly (inside
 * Schwarzschild's horizon in r and t, where r is the time and the cones lie
 * along it) the future is the half along which the other coordinate
 * decreases: smaller r, into the hole. The glyph is a fixed size in pixels.
 *
 * With a time besides the panel's two coordinates (Schwarzschild or Kerr in
 * their equatorial plane, in r and phi), the cone is drawn by its section at
 * dt = 1: the coordinate velocities v = d(x, y)/dt light can have, the
 * ellipse g_tt + 2 g_ti v^i + g_ij v^i v^j = 0 (the light-speed indicatrix),
 * placed with v = 0 at the point. All ellipses in a panel share one scale
 * (κ, coordinate time: an ellipse is where light from its point gets in a
 * time κ), chosen from the median ellipse in view, so they compare across
 * the plane: light slows near a horizon, a spinning hole drags the ellipses
 * sideways, and inside its ergoregion an ellipse no longer contains its own
 * point (nothing can stand still) — the point is drawn as a dot to show it.
 */

import type { Expr } from './expr.ts';

/** What a lightcones or lightcone(P) row draws (lib/analysis.ts
 *  classifyLightCone): the panel's metric as its geodesics have it
 *  (lib/surface-geometry.ts MetricSpec, its derivatives aside), and where. */
export interface LightConeSpec {
  /** 2: a spacetime diagram in x and y; 3: a time, then x and y. */
  readonly n: 2 | 3;
  /** g's upper triangle as written, in x and y (MetricSpec.components). */
  readonly components: readonly Expr[];
  /** The written coordinates' Jacobian and its derivatives
   *  (MetricSpec.jacobian), when they are not x and y. */
  readonly jacobian?: readonly Expr[];
  /** The point of lightcone(P); without it, a lattice over the window. */
  readonly at?: readonly Expr[];
  /** A diagram's time orientation (lib/metric.ts PanelMetric.future): dτ,
   *  then the other coordinate's gradient, in x and y. */
  readonly future?: readonly Expr[];
}

/** A diagram's time orientation at a point: the gradients of its time
 *  coordinate and of the other, (τ_x, τ_y, σ_x, σ_y). */
export type Orient = (x: number, y: number) => ArrayLike<number>;

/** With no orientation of its own: τ = y, and σ = x. */
const UP: readonly number[] = [0, 1, 1, 0];

/** A metric's components in x and y at a point: 2 × 2 (x, y) or 3 × 3 (t,
 *  x, y) — null where it is not defined. */
export type MetricRead = (x: number, y: number) => readonly (readonly number[])[] | null;

/**
 * The angles (in x and y, radians) of the two null lines of a 2 × 2 metric
 * — each line is a pair of opposite half-lines, θ and θ + π — or null where
 * it is not Lorentzian (det g ≥ 0) or not defined.
 *
 * Written as Q(θ) = g(e_θ, e_θ) = A + R cos(2θ − φ), with A the mean of the
 * diagonal and (R, φ) the polar form of ((g_xx − g_yy)/2, g_xy), the null
 * angles are (φ ± α)/2 with cos α = −A/R; det g = A² − R², so there are two
 * exactly when it is negative.
 */
export function nullAngles(gxx: number, gxy: number, gyy: number): [number, number] | null {
  const A = (gxx + gyy) / 2;
  const B = (gxx - gyy) / 2;
  const R = Math.hypot(B, gxy);
  if (!Number.isFinite(A) || !Number.isFinite(R) || !(R > Math.abs(A) * (1 + 1e-12))) return null;
  const phi = Math.atan2(gxy, B);
  const alpha = Math.acos(-A / R);
  return [(phi + alpha) / 2, (phi - alpha) / 2];
}

/**
 * The future half of a 2 × 2 Lorentzian metric's timelike cone: its axis's
 * angle in x and y and its half-width (the cone is axis ± half), or null
 * where the metric is not Lorentzian. The timelike axes are φ/2 + π/2 and
 * that + π (where Q is least); the future is the one along which the time
 * coordinate increases, given by its gradient and the other's in `orient`
 * (default τ = y, σ = x), or, where that is 0, the one along which the other
 * decreases (module comment).
 */
export function futureCone(
  gxx: number,
  gxy: number,
  gyy: number,
  orient: ArrayLike<number> = UP,
): { axis: number; half: number } | null {
  const angles = nullAngles(gxx, gxy, gyy);
  if (!angles) return null;
  const [a1, a2] = angles;
  const phi = a1 + a2;
  const half = (Math.PI - (a1 - a2)) / 2;
  let axis = phi / 2 + Math.PI / 2;
  const [c, s] = [Math.cos(axis), Math.sin(axis)];
  const along = orient[0] * c + orient[1] * s;
  const size = Math.hypot(orient[0], orient[1]);
  const back = Math.abs(along) > 1e-9 * size ? along < 0 : orient[2] * c + orient[3] * s > 0;
  if (back) axis += Math.PI;
  axis = Math.atan2(Math.sin(axis), Math.cos(axis));
  return { axis, half };
}

/** The null half-line of a 2 × 2 Lorentzian metric nearest the angle `of`
 *  (in x and y), as a unit vector in x and y, or null. */
export function nearestNull(gxx: number, gxy: number, gyy: number, of: number): [number, number] | null {
  const angles = nullAngles(gxx, gxy, gyy);
  if (!angles) return null;
  let best = NaN;
  let gap = Infinity;
  for (const a of angles)
    for (const c of [a, a + Math.PI]) {
      let d = c - of;
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      if (Math.abs(d) < gap) {
        gap = Math.abs(d);
        best = c;
      }
    }
  return [Math.cos(best), Math.sin(best)];
}

/** An ellipse: centre, semi-axes a (along `angle`) and b, in x and y. */
export interface Ellipse {
  cx: number;
  cy: number;
  a: number;
  b: number;
  angle: number;
}

/**
 * The light-speed indicatrix of a 3 × 3 metric in (t, x, y) at a point: the
 * coordinate velocities v = d(x, y)/dt along which light moves,
 * g_tt + 2 β·v + vᵀ h v = 0 (β = g_ti, h the x, y block). Completing the
 * square, (v − c)ᵀ h (v − c) = K with c = −h⁻¹β and K = βᵀh⁻¹β − g_tt
 * (= −det g / det h): an ellipse when h is positive definite and det g < 0,
 * else null (inside a horizon, x and y are no longer space). Its semi-axes
 * are √(K/λ) along h's eigenvectors. v = 0 is inside it exactly where
 * g_tt < 0: outside an ergoregion.
 */
export function indicatrix(g: readonly (readonly number[])[]): Ellipse | null {
  const [gtt, bx, by] = g[0];
  const [hxx, hxy] = [g[1][1], g[1][2]];
  const hyy = g[2][2];
  const det = hxx * hyy - hxy * hxy;
  if (!(hxx > 0) || !(det > 1e-14 * Math.max(hxx * hxx, hyy * hyy))) return null;
  const cx = -(hyy * bx - hxy * by) / det;
  const cy = -(hxx * by - hxy * bx) / det;
  const K = -(bx * cx + by * cy) - gtt;
  if (!(K > 0) || !Number.isFinite(K)) return null;
  // h's eigenvalues, the larger along `angle`.
  const mean = (hxx + hyy) / 2;
  const spread = Math.hypot((hxx - hyy) / 2, hxy);
  const [l1, l2] = [mean + spread, mean - spread];
  if (!(l2 > 0)) return null;
  return { cx, cy, a: Math.sqrt(K / l1), b: Math.sqrt(K / l2), angle: Math.atan2(2 * hxy, hxx - hyy) / 2 };
}

/** The window glyphs are laid out over, and its scale: math units per CSS
 *  pixel across (upp) and up (uppY). */
export interface ConeView {
  lo: readonly [number, number];
  hi: readonly [number, number];
  upp: number;
  uppY: number;
}

/** Lattice spacing, near this many CSS px: as the tensor-field glyphs'
 *  (web/render2d.ts tfieldFrag), the power of two in x nearest it (within
 *  √2), anchored in the plane so the glyphs move with a pan and keep their
 *  places through a zoom until the spacing halves or doubles. */
export const CONE_CELL_PX = 56;
/** A spacetime diagram's cone, its edges this many CSS px long… */
export const CONE_RADIUS_PX = 15;
/** …and a lone lightcone(P)'s. */
export const LONE_CONE_RADIUS_PX = 30;
/** The reach of the median indicatrix in view, as a part of the lattice's
 *  cell (within a factor of √2: κ is a power of two, so it holds through
 *  small pans and zooms; and the cell is one, so the ellipses keep their
 *  size on the screen as it halves or doubles). */
export const ELLIPSE_REACH = 0.36;
/** The lattice's cell across, in x, at `upp` units a CSS px. */
export const coneCell = (upp: number) => 2 ** Math.round(Math.log2(CONE_CELL_PX * upp));

/** Glyphs a lattice has at most. */
const MAX_GLYPHS = 6000;

/** The lattice's points over the view: cell centres (i + ½) w, a cell beyond
 *  each edge so a glyph half in view still draws. */
export function coneLattice(view: ConeView): [number, number][] {
  const wx = coneCell(view.upp);
  const wy = (wx * view.uppY) / view.upp;
  const out: [number, number][] = [];
  if (!(wx > 0) || !(wy > 0) || !Number.isFinite(wx) || !Number.isFinite(wy)) return out;
  const i0 = Math.floor(view.lo[0] / wx) - 1;
  const i1 = Math.ceil(view.hi[0] / wx);
  const k0 = Math.floor(view.lo[1] / wy) - 1;
  const k1 = Math.ceil(view.hi[1] / wy);
  if ((i1 - i0 + 1) * (k1 - k0 + 1) > MAX_GLYPHS) return out;
  for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) out.push([(i + 0.5) * wx, (k + 0.5) * wy]);
  return out;
}

/** What glyphs draw, in x and y: closed rings filled lightly and outlined,
 *  open strokes, and dots; each ring and stroke ends with NaN, NaN. */
export interface ConeGlyphs {
  rings: number[];
  lines: number[];
  dots: number[];
}

/**
 * The scale κ indicatrices are drawn at over a view: a power of two, so the
 * median ellipse's reach from its point (|c| + the larger semi-axis) is
 * near ELLIPSE_REACH of a lattice cell — or NaN when none is defined in
 * view.
 */
export function indicatrixScale(read: MetricRead, view: ConeView): number {
  const reach: number[] = [];
  for (const [x, y] of coneLattice(view)) {
    const g = read(x, y);
    const e = g && indicatrix(g);
    if (e) reach.push(Math.hypot(e.cx, e.cy) + Math.max(e.a, e.b));
  }
  if (!reach.length) return NaN;
  reach.sort((p, q) => p - q);
  const median = reach[Math.floor(reach.length / 2)];
  const cell = coneCell(view.upp);
  return 2 ** Math.round(Math.log2((ELLIPSE_REACH * cell) / median));
}

/** Whether x and y are space in a 3 × 3 metric (t, x, y): its x, y block
 *  positive definite. Not so inside a horizon. */
function spatial(g: readonly (readonly number[])[]): boolean {
  const [hxx, hxy, hyy] = [g[1][1], g[1][2], g[2][2]];
  return hxx > 0 && hxx * hyy - hxy * hxy > 0;
}

/**
 * Whether a point is cut off from the outside by a horizon, as inside a
 * spinning hole's inner horizon r₋, where x and y are space again and an
 * ellipse could be drawn: the straight line from it, away from the middle
 * of the horizon points on the view's lattice, crosses one (x and y not
 * space) before the edge of a box twice the view's size. Stepped a quarter
 * of a cell at a time, so a band thinner than that is missed (then the
 * inner ellipses are a cell or two across the hole). False everywhere when
 * no lattice point in view is inside a horizon.
 */
export function behindHorizon(read: MetricRead, view: ConeView): (x: number, y: number) => boolean {
  let [sx, sy, count] = [0, 0, 0];
  for (const [x, y] of coneLattice(view)) {
    const g = read(x, y);
    if (g && g.length === 3 && !spatial(g)) {
      sx += x;
      sy += y;
      count++;
    }
  }
  if (!count) return () => false;
  const [cx, cy] = [sx / count, sy / count];
  const step = coneCell(view.upp) / 4;
  const reach = 2 * Math.hypot(view.hi[0] - view.lo[0], view.hi[1] - view.lo[1]);
  return (x, y) => {
    const d = Math.hypot(x - cx, y - cy);
    if (!(d > 0)) return true;
    const [ux, uy] = [(x - cx) / d, (y - cy) / d];
    for (let s = step; s < reach; s += step) {
      const g = read(x + s * ux, y + s * uy);
      if (g && !spatial(g)) return true;
    }
    return false;
  };
}

/**
 * The light-cone glyphs of a metric read through `read` (2 × 2: a spacetime
 * diagram's wedges, oriented by `orient`; 3 × 3: indicatrices at scale κ) at
 * `at`, or over the view's lattice. Points where the metric gives no cone
 * are left out, and so are indicatrices cut off from the outside by a
 * horizon (behindHorizon). A lattice's indicatrix reaching further than its
 * cell is left out too, so one near a coordinate singularity does not cover
 * the panel. A lone one with no κ (no indicatrix on the lattice in view) is
 * drawn at its own scale, as the median would be.
 */
export function coneGlyphs(
  read: MetricRead,
  view: ConeView,
  {
    at,
    kappa,
    radius,
    orient,
  }: { at?: readonly (readonly [number, number])[]; kappa?: number; radius?: number; orient?: Orient } = {},
): ConeGlyphs {
  const out: ConeGlyphs = { rings: [], lines: [], dots: [] };
  const points = at ?? coneLattice(view);
  const { upp, uppY } = view;
  const R = radius ?? (at ? LONE_CONE_RADIUS_PX : CONE_RADIUS_PX);
  const cell = coneCell(upp);
  let k = kappa;
  let cut: ((x: number, y: number) => boolean) | undefined;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const g = read(x, y);
    if (!g) continue;
    if (g.length === 2) {
      const cone = futureCone(g[0][0], g[0][1], g[1][1], orient?.(x, y) ?? UP);
      if (!cone) continue;
      // The edges' angles on the screen, where a pixel is upp across and
      // uppY up; the cap is an arc between them, through the axis.
      const screen = (t: number) => Math.atan2(Math.sin(t) / uppY, Math.cos(t) / upp);
      const s1 = screen(cone.axis - cone.half);
      let sweep = screen(cone.axis + cone.half) - s1;
      sweep -= 2 * Math.PI * Math.floor(sweep / (2 * Math.PI));
      const steps = Math.max(2, Math.ceil(sweep / 0.2));
      out.rings.push(x, y);
      for (let j = 0; j <= steps; j++) {
        const s = s1 + (sweep * j) / steps;
        out.rings.push(x + R * Math.cos(s) * upp, y + R * Math.sin(s) * uppY);
      }
      out.rings.push(NaN, NaN);
      const s2 = s1 + sweep;
      out.lines.push(
        x - R * Math.cos(s1) * upp,
        y - R * Math.sin(s1) * uppY,
        x,
        y,
        x - R * Math.cos(s2) * upp,
        y - R * Math.sin(s2) * uppY,
        NaN,
        NaN,
      );
      continue;
    }
    const e = indicatrix(g);
    if (!e) continue;
    cut ??= behindHorizon(read, view);
    if (cut(x, y)) continue;
    k ??= indicatrixScale(read, view);
    const reach = Math.hypot(e.cx, e.cy) + Math.max(e.a, e.b);
    const scale = Number.isFinite(k) ? k : at ? 2 ** Math.round(Math.log2((ELLIPSE_REACH * cell) / reach)) : NaN;
    if (!Number.isFinite(scale)) break;
    if (!at && scale * reach > cell) continue;
    const [c, s] = [Math.cos(e.angle), Math.sin(e.angle)];
    const steps = 48;
    for (let j = 0; j <= steps; j++) {
      const t = (2 * Math.PI * j) / steps;
      const [u, v] = [e.a * Math.cos(t), e.b * Math.sin(t)];
      out.rings.push(x + scale * (e.cx + c * u - s * v), y + scale * (e.cy + s * u + c * v));
    }
    out.rings.push(NaN, NaN);
    out.dots.push(x, y);
  }
  return out;
}
