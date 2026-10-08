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
import { type Partial, type Params, smoothPartial } from './surface-geometry.ts';
import { inlineFields } from './axis-map.ts';

const num = (value: number): Expr => ({ kind: 'num', value });
const half = (e: Expr) => mul(num(0.5), e);
const abs = (e: Expr): Expr => ({ kind: 'call', name: 'abs', args: [e] });

/** K of a 2D metric, and the size of the two determinants it is the
 *  difference of (over W⁴): a K far below that, ~1e-6 of it, is rounding. */
export interface Curvature {
  readonly K: Expr;
  readonly size: Expr;
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
  return { K, size };
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
