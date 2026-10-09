/**
 * Light cones of a panel's metric (a `ds^2 = …` row, lib/metric.ts), as
 * numbers and as glyphs: `lightcones` draws them on a lattice over the
 * window, `lightcone(P)` one at a point.
 *
 * On a spacetime diagram — a Lorentzian metric in the panel's own two
 * coordinates, like -dy^2 + dx^2 — a light cone is two null lines through
 * the point, and is drawn as a filled wedge opening toward the future, with
 * the past half as two strokes. Which half is the future is the metric's
 * business, not y's, and the row's: its time coordinate τ is that of the
 * first term written as a squared differential with a minus sign (−dt^2,
 * -(1 - 2M/r) dt^2, dx^2 - f dy^2 for y), else y (lib/metric.ts
 * writtenTime) — as physics writes it, and fixed however a slider moves
 * the metric's values, which no rule could read a time from without
 * turning. The future half is the one along which τ increases,
 * dτ(axis) > 0: continuous wherever τ is a time, even where ∂τ is not
 * timelike (inside Eddington–Finkelstein's horizon every future cone still
 * has v increasing), and changing only where a cone straddles dτ = 0.
 * Where dτ(axis) is 0 exactly (inside Schwarzschild's horizon in r and t,
 * where r is the time and the cones lie along it) the future is the half
 * along which the other coordinate decreases: smaller r, into the hole.
 * The glyph is a fixed size in pixels.
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

/** Nodes behindHorizon's grid has at most: a few milliseconds. */
const HORIZON_NODES = 2000;
/** Pieces an edge near a horizon is checked in: a nearly extremal hole's
 *  band (a = 0.9999: 0.03 wide) between two nodes is not missed. */
const EDGE_SAMPLES = 32;
/** Glyphs a lattice has at most. */
const MAX_GLYPHS = 6000;

/** The lattice's points over the view: cell centres (i + ½) w, a cell beyond
 *  each edge so a glyph half in view still draws. */
export function coneLattice(view: ConeView): [number, number][] {
  const out: [number, number][] = [];
  const b = latticeBounds(view);
  if (!b || (b.i1 - b.i0 + 1) * (b.k1 - b.k0 + 1) > MAX_GLYPHS) return out;
  for (let i = b.i0; i <= b.i1; i++) for (let k = b.k0; k <= b.k1; k++) out.push([(i + 0.5) * b.wx, (k + 0.5) * b.wy]);
  return out;
}

/** The lattice's cells across and up, and the range of its cells' indices
 *  over the view, or null. */
function latticeBounds(view: ConeView) {
  const wx = coneCell(view.upp);
  const wy = (wx * view.uppY) / view.upp;
  if (!(wx > 0) || !(wy > 0) || !Number.isFinite(wx) || !Number.isFinite(wy)) return null;
  return {
    wx,
    wy,
    i0: Math.floor(view.lo[0] / wx) - 1,
    i1: Math.ceil(view.hi[0] / wx),
    k0: Math.floor(view.lo[1] / wy) - 1,
    k1: Math.ceil(view.hi[1] / wy),
  };
}

/**
 * What a lattice's glyphs, the panel's indicatrix scale and its horizon
 * cut-off depend on in a view: the scale (pixels to units) and which cells
 * are in it — so a pan within a cell reuses them all (web/main.ts).
 */
export function coneViewKey(view: ConeView): string {
  const b = latticeBounds(view);
  return JSON.stringify([view.upp, view.uppY, b && [b.i0, b.i1, b.k0, b.k1]]);
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
 * Which points are cut off from the outside by a horizon, as inside a
 * spinning hole's inner horizon r₋, where x and y are space again and an
 * ellipse could be drawn. A grid at half the lattice's spacing (coarser, to
 * hold it to HORIZON_NODES) over the view and a cell round it is
 * flood-filled from the outside (seeds at its corners and sides checked by a
 * ray out to a thousand times the view) through the nodes where x and y are space (or
 * the metric is undefined), never through one where they are not, nor
 * along an edge with a horizon inside it (crosses: a nearly extremal hole's
 * band, thinner than the grid); a point is cut off when neither its nearest
 * node nor any of that node's four neighbours was reached. One read a node,
 * and 31 more along each edge near a horizon, and eight rays. When no
 * seed's ray escapes (de Sitter's cosmological horizon is round every
 * point; a view wholly inside r₋) nothing is cut. Worked out once per view and metric values (web/main.ts shares it
 * between a panel's light-cone rows).
 */
export function behindHorizon(read: MetricRead, view: ConeView): (x: number, y: number) => boolean {
  // Over the lattice's cells and one more round them, so the grid stays put
  // as long as they do.
  const b = latticeBounds(view);
  if (!b) return () => false;
  const [cell, cellY] = [b.wx, b.wy];
  const x0 = (b.i0 - 1) * cell;
  const y0 = (b.k0 - 1) * cellY;
  const [w, h] = [(b.i1 + 2) * cell - x0, (b.k1 + 2) * cellY - y0];
  // Half a cell, or coarser to hold the grid to HORIZON_NODES (a lattice
  // of tiny cells on a large screen).
  const grow = Math.max(1, Math.sqrt(((w / (cell / 2)) * (h / (cellY / 2))) / HORIZON_NODES));
  const [hx, hy] = [(cell / 2) * grow, (cellY / 2) * grow];
  const nx = Math.ceil(w / hx) + 1;
  const ny = Math.ceil(h / hy) + 1;
  if (!(nx > 1 && ny > 1) || !Number.isFinite(nx * ny)) return () => false;
  // 1: a horizon's (x and y not space); 2: reached from the edge. And at
  // each node its x, y block and that block's size (NaN where undefined).
  const state = new Uint8Array(nx * ny);
  const block = new Float64Array(3 * nx * ny);
  const norms: number[] = [];
  let defined = false;
  for (let k = 0; k < ny; k++)
    for (let i = 0; i < nx; i++) {
      const j = k * nx + i;
      const g = read(x0 + i * hx, y0 + k * hy);
      if (!g || g.length !== 3) {
        block.fill(NaN, 3 * j, 3 * j + 3);
        continue;
      }
      defined = true;
      [block[3 * j], block[3 * j + 1], block[3 * j + 2]] = [g[1][1], g[1][2], g[2][2]];
      norms.push(Math.max(Math.abs(g[1][1]), Math.abs(g[1][2]), Math.abs(g[2][2])));
      if (!spatial(g)) state[j] = 1;
    }
  if (!defined) return () => false;
  norms.sort((a, b) => a - b);
  const typical = norms[Math.floor(norms.length / 2)];
  // A horizon thinner than the grid between two nodes (a nearly extremal
  // hole's r₋ < r < r₊) shows as x and y's metric growing large, or
  // changing fast, across the edge: those edges are checked at seven points
  // between, and closed if one is not space. Others are not read again.
  const between = (xa: number, ya: number, A: ArrayLike<number>, xb: number, yb: number, B: ArrayLike<number>) => {
    let big = 0;
    let change = 0;
    for (let c = 0; c < 3; c++) {
      const [p, q] = [A[c], B[c]];
      if (!Number.isFinite(p) || !Number.isFinite(q)) return false;
      big = Math.max(big, Math.abs(p), Math.abs(q));
      change = Math.max(change, Math.abs(p - q) / Math.max(Math.abs(p), Math.abs(q), 1e-300));
    }
    if (!(big > 4 * typical) && !(change > 0.5)) return false;
    for (let t = 1; t < EDGE_SAMPLES; t++) {
      const g = read(xa + ((xb - xa) * t) / EDGE_SAMPLES, ya + ((yb - ya) * t) / EDGE_SAMPLES);
      if (g && g.length === 3 && !spatial(g)) return true;
    }
    return false;
  };
  const at = (j: number): [number, number] => [x0 + (j % nx) * hx, y0 + Math.floor(j / nx) * hy];
  const crosses = (j: number, j2: number) =>
    between(...at(j), block.subarray(3 * j, 3 * j + 3), ...at(j2), block.subarray(3 * j2, 3 * j2 + 3));
  const queue = new Int32Array(nx * ny);
  let head = 0;
  let tail = 0;
  const visit = (i: number, k: number, from = -1) => {
    const j = k * nx + i;
    if (state[j]) return;
    if (from >= 0 && crosses(from, j)) return;
    state[j] = 2;
    queue[tail++] = j;
  };
  // Seeds: the grid's corners and the middles of its sides that are
  // outside — a ray from each away from the view's middle, out to a
  // thousand times the view's size in steps growing 30% a time, meets no
  // point where x and y are not space (stepping finer where their metric
  // grows large, as it does at a horizon). The edge of the view alone is
  // no sure outside: zoomed in on a spinning hole it can run inside r₋.
  const [mx, my] = [(view.lo[0] + view.hi[0]) / 2, (view.lo[1] + view.hi[1]) / 2];
  const far = 1000 * Math.hypot(view.hi[0] - view.lo[0], view.hi[1] - view.lo[1]);
  const outside = (j: number) => {
    const [px, py] = at(j);
    const d = Math.hypot(px - mx, py - my);
    if (!(d > 0)) return false;
    const [ux, uy] = [(px - mx) / d, (py - my) / d];
    let [lx, ly] = [px, py];
    let last: ArrayLike<number> = block.subarray(3 * j, 3 * j + 3);
    for (let step = Math.min(hx, hy); step < far; step *= 1.3) {
      const [qx, qy] = [lx + ux * step, ly + uy * step];
      const g = read(qx, qy);
      if (g && g.length === 3 && !spatial(g)) return false;
      const here = g && g.length === 3 ? [g[1][1], g[1][2], g[2][2]] : [NaN, NaN, NaN];
      if (between(lx, ly, last, qx, qy, here)) return false;
      [lx, ly, last] = [qx, qy, here];
    }
    return true;
  };
  const [ci, ck] = [Math.floor(nx / 2), Math.floor(ny / 2)];
  for (const [i, k] of [
    [0, 0],
    [nx - 1, 0],
    [0, ny - 1],
    [nx - 1, ny - 1],
    [ci, 0],
    [ci, ny - 1],
    [0, ck],
    [nx - 1, ck],
  ])
    if (state[k * nx + i] !== 1 && outside(k * nx + i)) visit(i, k);
  // No seed escapes — a cosmological horizon round everything (de Sitter),
  // or a view wholly inside r₋: there is no outside to be cut off from,
  // and nothing is cut.
  if (!tail) return () => false;
  while (head < tail) {
    const j = queue[head++];
    const [i, k] = [j % nx, Math.floor(j / nx)];
    if (i > 0) visit(i - 1, k, j);
    if (i + 1 < nx) visit(i + 1, k, j);
    if (k > 0) visit(i, k - 1, j);
    if (k + 1 < ny) visit(i, k + 1, j);
  }
  return (x, y) => {
    const i = Math.round((x - x0) / hx);
    const k = Math.round((y - y0) / hy);
    if (!(i >= 0 && i < nx && k >= 0 && k < ny)) return false;
    for (const [di, dk] of [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const [a, b] = [i + di, k + dk];
      if (!(a >= 0 && a < nx && b >= 0 && b < ny && state[b * nx + a] === 2)) continue;
      // Reached, and no horizon between it and the point.
      const g = read(x, y);
      const here = g && g.length === 3 ? [g[1][1], g[1][2], g[2][2]] : [NaN, NaN, NaN];
      const j = b * nx + a;
      if (!between(x, y, here, ...at(j), block.subarray(3 * j, 3 * j + 3))) return false;
    }
    return true;
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
    cut: cutOff,
  }: {
    at?: readonly (readonly [number, number])[];
    kappa?: number;
    radius?: number;
    orient?: Orient;
    /** behindHorizon over this view, when the caller has it. */
    cut?: (x: number, y: number) => boolean;
  } = {},
): ConeGlyphs {
  const out: ConeGlyphs = { rings: [], lines: [], dots: [] };
  const points = at ?? coneLattice(view);
  const { upp, uppY } = view;
  const R = radius ?? (at ? LONE_CONE_RADIUS_PX : CONE_RADIUS_PX);
  const cell = coneCell(upp);
  let k = kappa;
  let cut = cutOff;
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
    const steps = 32;
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
