/**
 * The Gaussian curvature of a panel's own metric (a `ds^2 = …` row,
 * lib/metric.ts): `gaussian(x, y)` on such a panel.
 *
 * K is taken from the metric alone, by Brioschi's formula — no embedding,
 * no square root:
 *
 *            | −½E_vv + F_uv − ½G_uu   ½E_u   F_u − ½E_v |   | 0     ½E_v  ½G_u |
 *   K W⁴  =  | F_v − ½G_u              E      F          | − | ½E_v  E     F    |
 *            | ½G_v                    F      G          |   | ½G_u  F     G    |
 *
 * with W² = EG − F². It is the algebraic identity K = R₁₂₁₂/det g, so it
 * holds for an indefinite (Lorentzian) 2D metric as well: there K = R/2, half
 * the scalar curvature, positive for de Sitter-like and negative for anti-de
 * Sitter-like spacetimes (the sign convention that makes the round sphere
 * positive).
 *
 * K is a scalar, so it is taken in the coordinates the metric is written in
 * (r and phi, say) and only then written in x and y through the coordinate
 * fields (r = sqrt(x^2 + y^2)): the derivatives are of the metric as
 * written, not of its pull-back to x and y, which would need the
 * coordinates' third derivatives and cancel away most of float32's digits in
 * a shader. A metric written partly in x and y and partly in fields of them
 * (r^2 dphi^2 + dr^2/(1 - 2M/sqrt(x^2 + y^2))) has no such coordinates to
 * differentiate in, and is pulled back to x and y first instead.
 *
 * With a time (a 3D metric in t and the panel's two coordinates), it is the
 * curvature of space at one instant: of the metric g_ij of a slice t =
 * constant, which is the spatial block of g (cross terms dt dphi do not
 * reach it). Schwarzschild's slice, dr²/(1 − 2M/r) + r² dphi², is Flamm's
 * paraboloid's, K = −M/r³.
 */
import { add, div, mul, neg, pow, sub } from './diff.ts';
import { type Expr, freeVars, substVars } from './expr.ts';
import { FLOW_NODE_LIMIT } from './flow.ts';
import { type PanelMetric, partial } from './metric.ts';
import { exceedsNodes } from './size.ts';
import { type GeodesicOptions, type Partial, type Params, divergingGain, smoothPartial } from './surface-geometry.ts';
import { inlineFields } from './axis-map.ts';

const num = (value: number): Expr => ({ kind: 'num', value });
const half = (e: Expr) => mul(num(0.5), e);
const abs = (e: Expr): Expr => ({ kind: 'call', name: 'abs', args: [e] });

/** K of a 2D metric, and the size of the two determinants it is the
 *  difference of (over W⁴): a K far below that, ~1e-6 of it, is rounding. */
export interface Curvature {
  readonly K: Expr;
  readonly size: Expr;
  /** Pulled back to x and y (writtenForm found no coordinates to
   *  differentiate in): there `size` can be as small as its rounding, and
   *  K is also floored by the view (curvatureFloor). */
  readonly pulled?: true;
}

const det3 = (m: readonly (readonly Expr[])[]): Expr =>
  add(
    sub(
      mul(m[0][0], sub(mul(m[1][1], m[2][2]), mul(m[1][2], m[2][1]))),
      mul(m[0][1], sub(mul(m[1][0], m[2][2]), mul(m[1][2], m[2][0]))),
    ),
    mul(m[0][2], sub(mul(m[1][0], m[2][1]), mul(m[1][1], m[2][0]))),
  );

/** Brioschi's formula: K of the metric E du² + 2F du dv + G dv², in u and v
 *  (`params`), whatever its signature. */
export function brioschi(E: Expr, F: Expr, G: Expr, [u, v]: Params, d: Partial = smoothPartial): Curvature {
  const [Eu, Ev, Fu, Fv, Gu, Gv] = [d(E, u), d(E, v), d(F, u), d(F, v), d(G, u), d(G, v)];
  const corner = add(sub(neg(half(d(Ev, v))), half(d(Gu, u))), d(Fu, v));
  const first = det3([
    [corner, half(Eu), sub(Fu, half(Ev))],
    [sub(Fv, half(Gu)), E, F],
    [half(Gv), F, G],
  ]);
  const second = det3([
    [num(0), half(Ev), half(Gu)],
    [half(Ev), E, F],
    [half(Gu), F, G],
  ]);
  const W4 = pow(sub(mul(E, G), mul(F, F)), num(2));
  return { K: div(sub(first, second), W4), size: div(add(abs(first), abs(second)), W4) };
}

/** What metricCurvature needs of its document besides the metric. */
export interface CurvatureContext {
  /** The row as the resolver writes it, coordinate fields left as names
   *  (r, not sqrt(x^2 + y^2)). */
  written: (e: Expr) => Expr;
  /** The document's coordinate fields, as written. */
  fields: Readonly<Record<string, Expr>>;
}

/** {cond: value} with no otherwise: undefined (NaN) where cond fails. */
const where = (l: Expr, value: Expr): Expr => ({
  kind: 'piecewise',
  cases: [{ cond: { kind: 'ineq', op: '>', l, r: num(0) }, value }],
});

/**
 * K of a panel's metric — or, with a time, of its slice at one instant — in
 * the panel's x and y, from the ds^2 row's right side `rhs` as parsed and
 * the metric parseMetric made of it. A Riemannian K (no time, or a slice) is
 * left undefined where the metric is not positive definite: inside a
 * horizon, where the slice is no longer space.
 */
export function metricCurvature(rhs: Expr, metric: PanelMetric, ctx: CurvatureContext): Curvature {
  const { n, coords } = metric;
  const spatial = coords.slice(n - 2) as unknown as Params;
  const riemannian = n === 3 || metric.time === undefined;
  const written = writtenForm(rhs, metric, ctx);
  let E: Expr, F: Expr, G: Expr;
  let curvature: Curvature;
  if (written) {
    [E, F, G] = written;
    curvature = brioschi(E, F, G, spatial);
  } else {
    [E, F, G] = pulledBack(metric);
    curvature = brioschi(E, F, G, ['x', 'y']);
  }
  let { K, size } = curvature;
  if (riemannian) K = where(E, where(sub(mul(E, G), mul(F, F)), K));
  // Into x and y, through the coordinate fields.
  K = inlineFields(K, ctx.fields);
  size = inlineFields(size, ctx.fields);
  if (exceedsNodes(K, 4 * FLOW_NODE_LIMIT)) throw new Error('This metric is too large to take the curvature of.');
  return { K, size, ...(written ? {} : { pulled: true as const }) };
}

/**
 * E, F and G of the metric (of its slice, with a time) in the coordinates it
 * is written in, other coordinate fields (f = 1 - 2M/r) written in them — or
 * null where a component still reads x or y that are not those coordinates.
 */
function writtenForm(rhs: Expr, metric: PanelMetric, ctx: CurvatureContext): [Expr, Expr, Expr] | null {
  const { n, coords } = metric;
  const spatial = coords.slice(n - 2);
  // d<c> for each coordinate c is its differential (parseMetric decided so).
  const slot = (k: number) => `[d${k}]`;
  const renamed: Record<string, Expr> = {};
  coords.forEach((c, k) => (renamed[`d${c}`] = { kind: 'var', name: slot(k) }));
  let Q = ctx.written(substVars(rhs, renamed));
  // Every other field in terms of the coordinates.
  const others = Object.fromEntries(Object.entries(ctx.fields).filter(([name]) => !spatial.includes(name)));
  for (let depth = 0; depth < 32; depth++) {
    if (![...freeVars(Q)].some(name => Object.hasOwn(others, name))) break;
    Q = substVars(Q, others);
  }
  const vars = freeVars(Q);
  if (['x', 'y', 'z', 't'].some(v => vars.has(v) && !spatial.includes(v))) return null;
  const [i, j] = [n - 2, n - 1].map(slot);
  const g = (a: string, b: string) => mul(num(0.5), partial(partial(Q, a), b));
  const form: [Expr, Expr, Expr] = [g(i, i), g(i, j), g(j, j)];
  for (const e of form) for (const name of freeVars(e)) if (name.startsWith('[d')) return null;
  return form;
}

/** E, F and G of the metric's spatial block pulled back to x and y,
 *  Jᵀ g J, from the components and Jacobian parseMetric wrote in x and y. */
function pulledBack(metric: PanelMetric): [Expr, Expr, Expr] {
  const { n, components, jacobian } = metric;
  // The upper triangle, row by row: n = 2 is 00 01 11; n = 3 is 00 01 02 11 12 22.
  const at = (a: number, b: number): Expr => {
    const [i, j] = a <= b ? [a, b] : [b, a];
    return components[i * n - (i * (i - 1)) / 2 + (j - i)];
  };
  const o = n - 2;
  const g = [
    [at(o, o), at(o, o + 1)],
    [at(o + 1, o), at(o + 1, o + 1)],
  ];
  if (!jacobian) return [g[0][0], g[0][1], g[1][1]];
  // J[c][k] = ∂(coordinate c)/∂(x, y)[k].
  const J = [
    [jacobian[0], jacobian[1]],
    [jacobian[2], jacobian[3]],
  ];
  const pull = (k: number, l: number): Expr => {
    let sum: Expr = num(0);
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) sum = add(sum, mul(mul(J[a][k], J[b][l]), g[a][b]));
    return sum;
  };
  return [pull(0, 0), pull(0, 1), pull(1, 1)];
}

/** A view's box, [[x0, x1], [y0, y1]]. */
type Box = GeodesicOptions['domain'];

/**
 * Below this a K pulled back to x and y over the box is rounding whatever
 * its terms say: 10⁻⁹ of 1/R and 1/R², R the box's half-size or its
 * distance from the origin if that is more — a flat metric pulled back has
 * terms as small as its K, and a field of x and y (r = sqrt(x^2 + y^2))
 * varies on the scale of that distance, not of the window, so zooming in
 * far from the origin does not raise it. A K in the coordinates the metric
 * is written in needs no floor (0): its terms' size says what is rounding.
 */
export function curvatureFloor([[x0, x1], [y0, y1]]: Box, pulled = true): number {
  if (!pulled) return 0;
  const R = Math.max((x1 - x0) / 2, (y1 - y0) / 2, Math.hypot((x0 + x1) / 2, (y0 + y1) / 2));
  return 1e-9 * Math.min(1 / R, 1 / R ** 2);
}

/** Whether K, beside the size of the terms it is the difference of (Curvature.size),
 *  is curvature rather than their rounding, over a box with this floor. */
export function isRealCurvature(k: number, size: number, floor: number): boolean {
  return Math.abs(k) > floor && Math.abs(k) > 1e-6 * Math.abs(size);
}

/**
 * The gain gaussian(x, y) under a metric is shaded with over a box: 1.5
 * over the typical |K| among the samples where it is real (divergingGain),
 * at most 1.5 over a thousandth of the largest so a thin tail does not
 * saturate, and 0 — nothing painted — where almost none are real (a flat
 * metric). `pulled`: K was pulled back to x and y (Curvature.pulled); `n`:
 * the lattice, coarser while things move.
 */
export function curvatureGain(
  K: (x: number, y: number) => number,
  size: (x: number, y: number) => number,
  box: Box,
  { pulled = false, n }: { pulled?: boolean; n?: number } = {},
): number {
  const floor = curvatureFloor(box, pulled);
  return divergingGain(K, box, 0, { real: (k, x, y) => isRealCurvature(k, size(x, y), floor), fallback: 0, n });
}

/** When the app reads a gain again (gainRead), and what it last read. */
export interface GainClock {
  /** The box and values (a key) of the last read; none before the first. */
  box?: Box;
  values?: string;
  /** When the last read, and the last fine one, were (ms). */
  at: number;
  fine: number;
  /** Set once things have stood still since a coarse read. */
  stale?: boolean;
  /** What a fine read cost (ms), once one has been made. */
  cost?: number;
}

/** A fine read under this many ms is made every time. */
export const GAIN_CHEAP_MS = 12;
/** Reads while something moves are this far apart at least… */
export const GAIN_THROTTLE_MS = 120;
/** …and a fine one comes at least this often, even while it never stops (t). */
export const GAIN_FINE_MS = 500;

/** How often a value that keeps changing forces a fine read: GAIN_FINE_MS,
 *  or ten times what one costs if more, so they take at most a tenth of
 *  the main thread (a pulled-back metric animated by t: ~130 ms each). */
export const fineInterval = (cost = 0) => Math.max(GAIN_FINE_MS, 10 * cost);

const same = (a: Box, b: Box) => a.every((r, k) => r[0] === b[k][0] && r[1] === b[k][1]);
const span = (b: Box, k: 0 | 1) => b[k][1] - b[k][0];
/** Moved by more than a quarter of the box, or grown or shrunk by a quarter. */
const far = (a: Box, b: Box) =>
  ([0, 1] as const).some(
    k =>
      Math.abs((a[k][0] + a[k][1]) / 2 - (b[k][0] + b[k][1]) / 2) > 0.25 * span(a, k) ||
      Math.abs(Math.log(span(b, k) / span(a, k))) > Math.log(1.25),
  );

/**
 * Whether to read the gain again now, finely (the full lattice) or not,
 * and whether to ask for a fine read once things stand still (`settle`).
 * The first read, and one after things have stood still, are fine. While a
 * slider or t moves, a read comes at most every GAIN_THROTTLE_MS; while the
 * view moves, at once when it has moved by a quarter (and every
 * GAIN_THROTTLE_MS when reads are cheap). A read is fine when fine reads
 * are cheap, or when values keep changing and none has come for
 * fineInterval (GAIN_FINE_MS, longer for a costly read) — so a metric
 * animated by t is read finely now and then,
 * not never.
 */
export function gainRead(
  c: GainClock,
  box: Box,
  values: string,
  now: number,
): { read: boolean; fine: boolean; settle: boolean } {
  if (!c.box || c.stale) return { read: true, fine: true, settle: false };
  const moved = !same(c.box, box);
  const changed = c.values !== values;
  if (!moved && !changed) return { read: false, fine: false, settle: false };
  const cheap = c.cost !== undefined && c.cost < GAIN_CHEAP_MS;
  // A value that keeps changing (t) is read finely now and then anyway.
  const due = changed && now - c.fine >= fineInterval(c.cost);
  const read = far(c.box, box) || ((changed || cheap) && now - c.at >= GAIN_THROTTLE_MS) || due;
  if (!read) return { read: false, fine: false, settle: true };
  const fine = cheap || due;
  return { read, fine, settle: !fine };
}
