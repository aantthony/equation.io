/**
 * Tidal forces of a panel's metric (a `ds^2 = …` row, lib/metric.ts): what
 * gravity does to a small cloud of free particles held at rest. `tidal`
 * draws a glyph on a lattice over the window, as `lightcones` does
 * (lib/light-cone.ts), and `tidal(P)` one at a point.
 *
 * The observer is static: its 4-velocity is along the time coordinate τ,
 * u = ∂τ/√(−g_ττ), so it exists only where g_ττ < 0 — not inside a horizon,
 * nor inside a spinning hole's ergoregion, where everything is dragged
 * round (no glyph there, as a light cone's ellipse leaves its point out).
 * Neighbouring free particles a separation ξ apart, orthogonal to u,
 * accelerate apart as ξ'' = −E ξ (geodesic deviation), with
 *
 *   E_ab = R_aμbν u^μ u^ν = R_aτbτ / (−g_ττ),
 *
 * the tidal tensor, in the coordinate basis of the panel's two coordinates
 * a, b. E u = 0, so on the vectors orthogonal to u it is the same form in
 * ∂_a or in ∂_a projected orthogonal to u; their inner product there is
 * h_ab = g_ab − g_aτ g_bτ / g_ττ (the static observer's space: g_τa cross
 * terms, Kerr's, change it). Its eigenvalues λ against h are the tidal
 * accelerations per unit length in an orthonormal frame: λ < 0 stretches
 * along its eigenvector, λ > 0 squeezes. Schwarzschild's static observer
 * has λ = −2M/r³ radially and M/r³ round (Newton's tides, exactly), de
 * Sitter's static patch −1/L² both ways.
 *
 * On a spacetime diagram (a 2D Lorentzian metric in x and y) there is one
 * direction of space: in 1 + 1 dimensions R_abcd = K (g_ac g_bd − g_ad g_bc),
 * so E = −K h for any observer, λ = −K (K = R/2, lib/metric-curvature.ts),
 * along the direction orthogonal to the written time's ∂τ — again only
 * where that observer exists, g_ττ < 0.
 *
 * Riemann is formed in numbers at each point from g and its first and
 * second derivatives, taken symbolically once per plot:
 *
 *   R_abcd = ½(g_ad,bc + g_bc,ad − g_ac,bd − g_bd,ac)
 *            + Γ^e_bc Γ_e,ad − Γ^e_bd Γ_e,ac,
 *
 * in the coordinates the metric is written in (r and phi, other coordinate
 * fields such as f = 1 - 2M/r written in them) — as #258's K, so a metric
 * flat in polar coordinates is exactly flat — and the eigenvectors are
 * carried to x and y through the inverse of the coordinates' Jacobian. A
 * metric mixing x and y with fields of them is pulled back to x and y
 * first (symbolically, Jᵀ g J). τ is cyclic: nothing is differentiated in it.
 *
 * Each glyph is two crossed bars along the eigenvectors (one on a diagram),
 * half as long as |λ| times one scale for the panel — a power of two in
 * pixels, from the median glyph in view, so it holds through small pans
 * and glyphs compare across the plane — with arrowheads pointing out at
 * their ends where it stretches and in where it squeezes. A glyph that
 * would reach past its cell is shrunk whole, keeping its shape: tides grow
 * as 1/r³ toward a hole.
 */

import { add, mul } from './diff.ts';
import type { Expr } from './expr.ts';
import { FLOW_NODE_LIMIT } from './flow.ts';
import { type ConeGlyphs, type ConeView, coneCell, coneLattice } from './light-cone.ts';
import { type CurvatureContext, writtenComponents } from './metric-curvature.ts';
import type { PanelMetric } from './metric.ts';
import { exceedsNodes } from './size.ts';
import { numericIn, smoothPartial } from './surface-geometry.ts';

/** What a tidal or tidal(P) row draws (lib/analysis.ts classifyTidal). */
export interface TidalSpec {
  /** 2: a spacetime diagram in the panel's two coordinates; 3: a time, then
   *  the panel's two. */
  readonly n: 2 | 3;
  /** Which coordinate is the time the static observer moves along (an
   *  index into the metric's coordinates: 0 with a time, 0 or 1 on a
   *  diagram). */
  readonly time: 0 | 1;
  /** The two coordinates the curvature is taken in: the panel's two as the
   *  metric is written (r, phi), or x and y. */
  readonly params: readonly [string, string];
  /** g's upper triangle in `params`, then its derivatives in them: ∂p, ∂q,
   *  ∂pp, ∂pq, ∂qq, each the whole triangle. */
  readonly curvature: readonly Expr[];
  /** When `params` are not x and y: they as fields of x and y, then their
   *  Jacobian ∂(p, q)/∂(x, y) row by row. */
  readonly chart?: readonly Expr[];
  /** The metric as written, in x and y, and its Jacobian (lib/metric.ts
   *  PanelMetric): what the horizon cut-off reads, shared with the panel's
   *  light cones (lib/light-cone.ts behindHorizon). */
  readonly components: readonly Expr[];
  readonly jacobian?: readonly Expr[];
  /** The point of tidal(P); without it, a lattice over the window. */
  readonly at?: readonly Expr[];
}

const num = (value: number): Expr => ({ kind: 'num', value });
const PANEL = new Set(['x', 'y']);

/** Index of g_ij (i ≤ j) in an n × n upper triangle, row by row. */
const tri = (n: number, i: number, j: number) => {
  if (i > j) [i, j] = [j, i];
  return i * n - (i * (i - 1)) / 2 + (j - i);
};

/**
 * The expressions a panel's tidal glyphs are read from, made once per
 * metric: g in the coordinates it is written in (writtenComponents) and its
 * first and second derivatives there, with the chart from x and y to them;
 * or, for a metric mixing x and y with fields of them, all pulled back to x
 * and y first. `rhs` is the ds^2 row's right side as parsed; `inXY` writes
 * a coordinate field in x and y.
 */
export function tidalSpec(
  rhs: Expr,
  metric: PanelMetric,
  ctx: CurvatureContext & { inXY: (e: Expr) => Expr },
): Omit<TidalSpec, 'at'> {
  const { n, coords } = metric;
  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) pairs.push([i, j]);
  const spatial = coords.slice(n - 2) as unknown as [string, string];
  const time: 0 | 1 = n === 3 ? 0 : (metric.timeAxis ?? 1);
  const written = writtenComponents(rhs, metric, ctx, pairs);
  let g: Expr[];
  let params: readonly [string, string];
  let chart: Expr[] | undefined;
  if (written) {
    g = written;
    params = spatial;
    // Not x and y: the coordinates as fields of them, and their Jacobian.
    if (metric.jacobian)
      chart = [
        ...spatial.map(c => (PANEL.has(c) ? { kind: 'var' as const, name: c } : ctx.inXY({ kind: 'var', name: c }))),
        ...metric.jacobian.slice(0, 4),
      ];
  } else {
    g = pulledBack(metric);
    params = ['x', 'y'];
  }
  const [p, q] = params;
  const dp = g.map(e => smoothPartial(e, p));
  const dq = g.map(e => smoothPartial(e, q));
  const curvature = [
    ...g,
    ...dp,
    ...dq,
    ...dp.map(e => smoothPartial(e, p)),
    ...dp.map(e => smoothPartial(e, q)),
    ...dq.map(e => smoothPartial(e, q)),
  ];
  if (exceedsNodes([...curvature, ...(chart ?? [])], 6 * FLOW_NODE_LIMIT))
    throw new Error('This metric is too large to take its tidal forces.');
  return {
    n,
    time,
    params,
    curvature,
    ...(chart ? { chart } : {}),
    components: metric.components,
    ...(metric.jacobian ? { jacobian: metric.jacobian } : {}),
  };
}

/** The whole metric pulled back to x and y, Jᵀ g J (the time's row through
 *  J alone), its upper triangle, from parseMetric's components and
 *  Jacobian. */
function pulledBack(metric: PanelMetric): Expr[] {
  const { n, components, jacobian } = metric;
  if (!jacobian) return [...components];
  const at = (a: number, b: number) => components[tri(n, a, b)];
  const o = n - 2;
  // J[c][k] = ∂(coordinate c)/∂(x, y)[k]; the full one, with τ to itself.
  const J = (c: number, k: number): Expr => {
    if (c < o || k < o) return num(c === k ? 1 : 0);
    return jacobian[2 * (c - o) + (k - o)];
  };
  const out: Expr[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      let sum: Expr = num(0);
      for (let a = 0; a < n; a++)
        for (let b = 0; b < n; b++) {
          const ja = J(a, i);
          const jb = J(b, j);
          if ((ja.kind === 'num' && ja.value === 0) || (jb.kind === 'num' && jb.value === 0)) continue;
          sum = add(sum, mul(mul(ja, jb), at(a, b)));
        }
      out.push(sum);
    }
  return out;
}

/** The tides at a point, as read: one or two eigenvalues λ (per unit
 *  length per unit time², in an orthonormal frame; < 0 stretches) and their
 *  eigenvectors in x and y (not of unit length). The reader's own, and
 *  changed by its next read. */
export interface Tides {
  count: 0 | 1 | 2;
  lambda: Float64Array;
  /** (x, y) of each eigenvector in turn. */
  dir: Float64Array;
}

/** A point's tides, or null where no static observer is (g_ττ ≥ 0, x and y
 *  not space) or the metric is not defined. `count` 0: no tide there (flat,
 *  to rounding). */
export type TidalRead = (x: number, y: number) => Tides | null;

/** An eigenvalue under this part of the size of the terms it is the sum of
 *  is rounding: a flat metric pulled back to x and y. */
const ROUNDING = 1e-9;

/**
 * The tides of a TidalSpec, its sliders read from `env`: compiled once, then
 * read point by point with no allocation.
 */
export function tidalReader(spec: Omit<TidalSpec, 'at'>, env: Readonly<Record<string, number>>): TidalRead {
  const { n, time: ti } = spec;
  const m = (n * (n + 1)) / 2;
  // Only what is not a constant is compiled (most second derivatives are
  // 0): it is read into its place in `buf`, the rest filled in once.
  const live = spec.curvature.flatMap((e, k) => (e.kind === 'num' ? [] : [k]));
  const curv = numericIn(
    live.map(k => spec.curvature[k]),
    spec.params,
    env,
  );
  const chart = spec.chart ? numericIn(spec.chart, ['x', 'y'], env) : null;
  const buf = new Float64Array(6 * m);
  const lbuf = new Float64Array(live.length);
  spec.curvature.forEach((e, k) => e.kind === 'num' && (buf[k] = e.value));
  const cbuf = new Float64Array(6);
  // The first coordinate differentiated: τ (index 0) is not, with a time.
  const o = n - 2;
  const sq = () => Array.from({ length: n }, () => new Float64Array(n));
  const g = sq();
  const inv = sq();
  // dg[k][i][j] = ∂_k g_ij, dd[k][l][i][j] = ∂_k ∂_l g_ij (0 for k or l = τ).
  const dg = Array.from({ length: n }, sq);
  const dd = Array.from({ length: n }, () => Array.from({ length: n }, sq));
  // Γ_l,ij (first kind) and Γ^k_ij.
  const G1 = Array.from({ length: n }, sq);
  const G2 = Array.from({ length: n }, sq);
  const out: Tides = { count: 0, lambda: new Float64Array(2), dir: new Float64Array(4) };
  /** R_abcd, and into `size[0]` the sum of its terms' sizes. */
  const size = [0];
  const riemann = (a: number, b: number, c: number, d: number) => {
    const t1 = dd[b][c][a][d];
    const t2 = dd[a][d][b][c];
    const t3 = dd[b][d][a][c];
    const t4 = dd[a][c][b][d];
    let sum = 0.5 * (t1 + t2 - t3 - t4);
    let s = 0.5 * (Math.abs(t1) + Math.abs(t2) + Math.abs(t3) + Math.abs(t4));
    for (let e = 0; e < n; e++) {
      const u = G2[e][b][c] * G1[e][a][d];
      const v = G2[e][b][d] * G1[e][a][c];
      sum += u - v;
      s += Math.abs(u) + Math.abs(v);
    }
    size[0] = s;
    return sum;
  };
  return (x, y) => {
    let p = x;
    let q = y;
    // J[a][k] = ∂(p, q)_a/∂(x, y)_k.
    let j00 = 1;
    let j01 = 0;
    let j10 = 0;
    let j11 = 1;
    if (chart) {
      chart(x, y, cbuf);
      p = cbuf[0];
      q = cbuf[1];
      j00 = cbuf[2];
      j01 = cbuf[3];
      j10 = cbuf[4];
      j11 = cbuf[5];
    }
    curv(p, q, lbuf);
    for (let k = 0; k < live.length; k++) buf[live[k]] = lbuf[k];
    for (let k = 0; k < buf.length; k++) if (!Number.isFinite(buf[k])) return null;
    let k = 0;
    for (let i = 0; i < n; i++)
      for (let j = i; j < n; j++, k++) {
        g[i][j] = g[j][i] = buf[k];
        // ∂p, ∂q at coordinates o, o + 1.
        dg[o][i][j] = dg[o][j][i] = buf[m + k];
        dg[o + 1][i][j] = dg[o + 1][j][i] = buf[2 * m + k];
        dd[o][o][i][j] = dd[o][o][j][i] = buf[3 * m + k];
        dd[o][o + 1][i][j] = dd[o][o + 1][j][i] = buf[4 * m + k];
        dd[o + 1][o][i][j] = dd[o + 1][o][j][i] = buf[4 * m + k];
        dd[o + 1][o + 1][i][j] = dd[o + 1][o + 1][j][i] = buf[5 * m + k];
      }
    const gtt = g[ti][ti];
    // A static observer: ∂τ timelike.
    if (!(gtt < 0)) return null;
    // g⁻¹ by cofactors.
    if (n === 2) {
      const det = g[0][0] * g[1][1] - g[0][1] * g[0][1];
      if (!(det < 0)) return null;
      inv[0][0] = g[1][1] / det;
      inv[1][1] = g[0][0] / det;
      inv[0][1] = inv[1][0] = -g[0][1] / det;
    } else {
      const [A, B, C, D, E, F] = [g[0][0], g[0][1], g[0][2], g[1][1], g[1][2], g[2][2]];
      const c00 = D * F - E * E;
      const c01 = C * E - B * F;
      const c02 = B * E - C * D;
      const det = A * c00 + B * c01 + C * c02;
      if (!(det < 0)) return null;
      inv[0][0] = c00 / det;
      inv[0][1] = inv[1][0] = c01 / det;
      inv[0][2] = inv[2][0] = c02 / det;
      inv[1][1] = (A * F - C * C) / det;
      inv[1][2] = inv[2][1] = (B * C - A * E) / det;
      inv[2][2] = (A * D - B * B) / det;
    }
    for (let l = 0; l < n; l++)
      for (let i = 0; i < n; i++)
        for (let j = i; j < n; j++) G1[l][i][j] = G1[l][j][i] = 0.5 * (dg[i][j][l] + dg[j][i][l] - dg[l][i][j]);
    for (let c = 0; c < n; c++)
      for (let i = 0; i < n; i++)
        for (let j = i; j < n; j++) {
          let s = 0;
          for (let l = 0; l < n; l++) s += inv[c][l] * G1[l][i][j];
          G2[c][i][j] = G2[c][j][i] = s;
        }
    // Inverse Jacobian, to carry a vector in (p, q) to x and y.
    const jd = j00 * j11 - j01 * j10;
    if (!(Math.abs(jd) > 0)) return null;
    const toXY = (vp: number, vq: number, at: number) => {
      out.dir[at] = (j11 * vp - j01 * vq) / jd;
      out.dir[at + 1] = (-j10 * vp + j00 * vq) / jd;
    };
    if (n === 2) {
      // λ = −K = −R_0101/det g, along the direction g-orthogonal to ∂τ.
      const det = g[0][0] * g[1][1] - g[0][1] * g[0][1];
      const lam = -riemann(0, 1, 0, 1) / det;
      const noise = size[0] / Math.abs(det);
      const s = 1 - ti;
      const w = [0, 0];
      w[ti] = -g[ti][s];
      w[s] = gtt;
      toXY(w[0], w[1], 0);
      out.lambda[0] = lam;
      out.count = Math.abs(lam) > ROUNDING * noise && Number.isFinite(lam) ? 1 : 0;
      return out;
    }
    // E_ab = R_aτbτ / (−g_ττ) on the spatial coordinates 1, 2, and its
    // sizes; h_ab = g_ab − g_aτ g_bτ / g_ττ.
    const minus = -gtt;
    const e11 = riemann(1, 0, 1, 0) / minus;
    const s11 = size[0] / minus;
    const e12 = riemann(1, 0, 2, 0) / minus;
    const s12 = size[0] / minus;
    const e22 = riemann(2, 0, 2, 0) / minus;
    const s22 = size[0] / minus;
    const h11 = g[1][1] - (g[1][0] * g[1][0]) / gtt;
    const h12 = g[1][2] - (g[1][0] * g[2][0]) / gtt;
    const h22 = g[2][2] - (g[2][0] * g[2][0]) / gtt;
    const hdet = h11 * h22 - h12 * h12;
    if (!(h11 > 0) || !(hdet > 0)) return null;
    // An orthonormal basis of h: f1 = ∂1/√h11, f2 = (∂2 − (h12/h11) ∂1)/√(hdet/h11).
    const a = 1 / Math.sqrt(h11);
    const b2 = 1 / Math.sqrt(hdet / h11);
    const b1 = (-h12 / h11) * b2;
    // Ê = Fᵀ E F with F = [[a, b1], [0, b2]].
    const E11 = a * a * e11;
    const E12 = a * (b1 * e11 + b2 * e12);
    const E22 = b1 * b1 * e11 + 2 * b1 * b2 * e12 + b2 * b2 * e22;
    // What Ê's entries could be at most from the terms' sizes: their
    // rounding bounds an eigenvalue's.
    const noise = (Math.abs(a) + Math.abs(b1) + Math.abs(b2)) ** 2 * Math.max(s11, s12, s22);
    const mean = (E11 + E22) / 2;
    const spread = Math.hypot((E11 - E22) / 2, E12);
    if (!Number.isFinite(mean) || !Number.isFinite(spread)) return null;
    const th = Math.atan2(2 * E12, E11 - E22) / 2;
    const [c, s] = [Math.cos(th), Math.sin(th)];
    // Eigenvectors in the orthonormal basis (c, s) and (−s, c), in (p, q):
    // p = a·u + b1·v, q = b2·v.
    out.lambda[0] = mean + spread;
    out.lambda[1] = mean - spread;
    toXY(a * c + b1 * s, b2 * s, 0);
    toXY(-a * s + b1 * c, b2 * c, 2);
    const floor = ROUNDING * noise;
    if (Math.abs(out.lambda[0]) <= floor) out.lambda[0] = 0;
    if (Math.abs(out.lambda[1]) <= floor) out.lambda[1] = 0;
    out.count = out.lambda[0] || out.lambda[1] ? 2 : 0;
    return out;
  };
}

/** Points memoTides keeps before it starts again. */
const MEMO_POINTS = 20000;

/**
 * `read`, remembering each point's tides: the panel's scale and its glyphs
 * read the same lattice, and a pan brings in only a row or column of new
 * points (the lattice is anchored in the plane). For one set of the
 * metric's values; the caller makes a new one when they change.
 */
export function memoTides(read: TidalRead): TidalRead {
  const memo = new Map<string, Tides | null>();
  return (x, y) => {
    const key = `${x},${y}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const t = read(x, y);
    const copy = t && { count: t.count, lambda: t.lambda.slice(), dir: t.dir.slice() };
    if (memo.size >= MEMO_POINTS) memo.clear();
    memo.set(key, copy);
    return copy;
  };
}

/** A glyph's longer bar reaches this part of a lattice cell (in pixels, at
 *  the median glyph in view; within √2, as the scale is a power of two)… */
export const TIDAL_REACH = 0.2;
/** …and never further than this part of it, nor a lone tidal(P)'s past
 *  LONE_TIDAL_PX: a stronger glyph is shrunk whole. */
export const TIDAL_CAP = 0.46;
export const LONE_TIDAL_PX = 60;
/** An arrowhead's length (CSS px), at most this or half its bar. */
export const TIDAL_HEAD_PX = 6;
/** A bar shorter than this many CSS px each way is not drawn. */
const MIN_BAR_PX = 1.5;

/** How far (in powers of two) the median may drift before a panel's scale
 *  changes: the median glyph's longer bar stays within 2^±1.5 of
 *  TIDAL_REACH of a cell. */
const HOLD = 1.5;

/** The size of the strongest tide at a point, or NaN with none. */
const strongest = (t: Tides | null) =>
  !t || !t.count ? NaN : t.count === 1 ? Math.abs(t.lambda[0]) : Math.max(Math.abs(t.lambda[0]), Math.abs(t.lambda[1]));

/**
 * The panel's tidal scale over a view, in CSS px per unit of λ: a power of
 * two, so the median glyph's longer bar reaches TIDAL_REACH of a lattice
 * cell — or NaN when no glyph is in view. `skip` leaves out points the
 * caller cuts (behind a horizon). With the scale it had before
 * (`previous`), it keeps it while that is within 2^HOLD of the one the
 * median asks for, so a median near the edge between two powers of two
 * does not flip it to and fro as the view pans (the median moves in steps,
 * as lattice rows come into view, by up to ~1.5× round a hole).
 */
export function tidalScale(
  read: TidalRead,
  view: ConeView,
  { skip, previous }: { skip?: (x: number, y: number) => boolean; previous?: number } = {},
): number {
  const sizes: number[] = [];
  for (const [x, y] of coneLattice(view)) {
    const s = strongest(read(x, y));
    if (s > 0 && !skip?.(x, y)) sizes.push(s);
  }
  if (!sizes.length) return NaN;
  sizes.sort((p, q) => p - q);
  const median = sizes[Math.floor(sizes.length / 2)];
  const cellPx = coneCell(view.upp) / view.upp;
  const ideal = Math.log2((TIDAL_REACH * cellPx) / median);
  if (previous !== undefined && previous > 0 && Math.abs(ideal - Math.log2(previous)) <= HOLD) return previous;
  return 2 ** Math.round(ideal);
}

/**
 * The tidal glyphs of `read` at `at`, or over the view's lattice, at `scale`
 * px per unit λ (the panel's, tidalScale; a lone point with none takes its
 * own): bars along the eigenvectors as `lines`, arrowheads as filled
 * triangles in `rings` — out at the ends where λ < 0 stretches, in where
 * λ > 0 squeezes. Points with no static observer, no tide, or cut off
 * (`cut`: behind a horizon) are left out.
 */
export function tidalGlyphs(
  read: TidalRead,
  view: ConeView,
  {
    at,
    scale,
    cut,
  }: { at?: readonly (readonly [number, number])[]; scale?: number; cut?: (x: number, y: number) => boolean } = {},
): ConeGlyphs {
  const out: ConeGlyphs = { rings: [], lines: [], dots: [] };
  const points = at ?? coneLattice(view);
  const { upp, uppY } = view;
  const cellPx = coneCell(upp) / upp;
  const cap = at ? LONE_TIDAL_PX : TIDAL_CAP * cellPx;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const t = read(x, y);
    if (!t || !t.count) continue;
    if (cut?.(x, y)) continue;
    const big = strongest(t);
    const s =
      scale !== undefined && Number.isFinite(scale)
        ? scale
        : at
          ? 2 ** Math.round(Math.log2((TIDAL_REACH * cellPx) / big))
          : NaN;
    if (!Number.isFinite(s)) break;
    // Shrunk whole when the longer bar would pass the cap.
    const shrink = Math.min(1, cap / (s * big));
    for (let k = 0; k < t.count; k++) {
      const lam = t.lambda[k];
      const L = s * shrink * Math.abs(lam);
      if (!(L >= MIN_BAR_PX)) continue;
      // The eigenvector's direction on the screen, in pixels.
      let [dx, dy] = [t.dir[2 * k] / upp, t.dir[2 * k + 1] / uppY];
      const len = Math.hypot(dx, dy);
      if (!(len > 0)) continue;
      [dx, dy] = [dx / len, dy / len];
      const [nx, ny] = [-dy, dx];
      const H = Math.min(TIDAL_HEAD_PX, L / 2);
      const W = 0.5 * H;
      // In math units: along the bar, and across it, per pixel.
      const [ax, ay] = [dx * upp, dy * uppY];
      const [cx, cy] = [nx * upp, ny * uppY];
      out.lines.push(x - L * ax, y - L * ay, x + L * ax, y + L * ay, NaN, NaN);
      for (let side = 1; side >= -1; side -= 2) {
        // Stretch: the tip at the end, pointing out. Squeeze: the tip a
        // head's length in, pointing in.
        const tip = side * (lam < 0 ? L : L - H);
        const base = side * (lam < 0 ? L - H : L);
        const [bx, by] = [x + base * ax, y + base * ay];
        out.rings.push(x + tip * ax, y + tip * ay, bx + W * cx, by + W * cy, bx - W * cx, by - W * cy, NaN, NaN);
      }
    }
  }
  return out;
}
