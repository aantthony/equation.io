/**
 * A plane panel's own metric: a `ds^2 = …` row, a quadratic form in the
 * differentials of the panel's two coordinates (x and y, or two coordinates
 * defined from them, like r = sqrt(x^2 + y^2) and phi = atan2(y, x)) and of
 * at most one more coordinate τ that no component depends on:
 *
 *   ds^2 = (dx^2 + dy^2)/y^2                                (Poincaré)
 *   ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2  (Schwarzschild)
 *
 * With no τ it may be Lorentzian in the panel's own two coordinates, a
 * spacetime diagram (ds^2 = -dy^2 + dx^2, or Schwarzschild's r and t as x
 * and y): which of them is time is the metric's business.
 *
 * Only in this row is `dr` the differential of r: elsewhere a name starting
 * with d means what it always has (d/dx, ∫ … dx, a slider named dr). The row
 * draws nothing; `geodesic(P, v)` and `lightray(P, d)` rows in its panel
 * trace its geodesics (lib/surface-geometry.ts metricStart), and
 * `lightcones` and `lightcone(P)` draw its light cones (lib/light-cone.ts).
 *
 * The metric is pulled back to x and y through the Jacobian of the
 * coordinates it is written in, g_xy = Jᵀ g J, so a geodesic is integrated
 * and drawn in x and y and needs no inverse of the coordinate map (r and phi
 * from x and y are all the document says).
 */
import { NonSmoothError, add, diff, div, mul, neg, pow, sub } from './diff.ts';
import { type Expr, builtinFn, evaluate, exprKey, freeVars, substVars } from './expr.ts';
import { FLOW_NODE_LIMIT } from './flow.ts';
import { exceedsNodes } from './size.ts';
import { smoothPartial } from './surface-geometry.ts';

/** A `ds^2 = …` row (or `ds² = …`). */
export const METRIC_ROW = /^\s*ds\s*(?:\^\s*2|²)\s*=/;

/** What a panel's ds^2 row gives its geodesics. */
export interface PanelMetric {
  /** 2: x and y; 3: τ, then x and y. */
  readonly n: 2 | 3;
  /** The coordinates as written: τ (if any) first, then the panel's two. */
  readonly coords: readonly string[];
  /** The upper triangle of g as written, in x and y (lib/surface-geometry.ts
   *  MetricSpec). */
  readonly components: readonly Expr[];
  /** ∂g/∂x of each component, then ∂g/∂y. */
  readonly derivatives: readonly Expr[];
  /** The written coordinates' Jacobian in x and y and its derivatives, when
   *  they are not x and y (MetricSpec.jacobian). */
  readonly jacobian?: readonly Expr[];
  /** τ's name. */
  readonly time?: string;
  /** With no τ: whether x and y make a spacetime diagram (a Lorentzian
   *  metric, like -dy^2 + dx^2) rather than a Riemannian plane. */
  readonly lorentzian?: true;
}

/** What parseMetric needs of its document. */
export interface MetricContext {
  /** The row as the resolver writes it, with coordinate fields written in
   *  (in x and y). */
  resolve: (e: Expr) => Expr;
  /** The document's coordinate fields (r = sqrt(x^2 + y^2)), as written. */
  fields: Readonly<Record<string, Expr>>;
  /** Whether the document defines a name. */
  isDefined: (name: string) => boolean;
  /** The sliders and other constants a component may read. */
  constNames: ReadonlySet<string>;
  /** Their values, to check the form at sample points. */
  values: Readonly<Record<string, number>>;
}

const num = (value: number): Expr => ({ kind: 'num', value });
const ZERO = num(0);
const PANEL = new Set(['x', 'y']);
const EXAMPLE = 'like ds^2 = (dx^2 + dy^2)/y^2, or ds^2 = -(1 - 2/r) dt^2 + dr^2/(1 - 2/r) + r^2 dphi^2';
/** The name a differential stands under while the row is resolved: one no
 *  row can spell, so no definition (a slider named dr) reaches it. */
const placeholder = (k: number) => `[d${k}]`;

/** ∂e/∂v, 0 for a part that does not read v (so abs(y) beside dx^2 is no
 *  obstacle), the derivative's rules otherwise. */
function partial(e: Expr, v: string): Expr {
  if (!freeVars(e).has(v)) return ZERO;
  if (e.kind === 'neg') return neg(partial(e.a, v));
  if (e.kind === 'bin') {
    const { a, b } = e;
    switch (e.op) {
      case '+':
        return add(partial(a, v), partial(b, v));
      case '-':
        return sub(partial(a, v), partial(b, v));
      case '*':
        return add(mul(partial(a, v), b), mul(a, partial(b, v)));
      case '/':
        if (!freeVars(b).has(v)) return div(partial(a, v), b);
        break;
      case '^':
        if (b.kind === 'num') return mul(mul(b, pow(a, num(b.value - 1))), partial(a, v));
        break;
    }
  }
  return diff(e, v);
}

/** Sample points of the plane a metric is checked at: rings round the
 *  origin, four a decade from 0.001 to 100 000 across, off the axes — so a
 *  black hole of mass 0.01 or 10 000, or a disc of radius 0.1, is seen. */
const SAMPLES: readonly [number, number][] = Array.from({ length: 33 }, (_, i) => 10 ** (-3 + i / 4)).flatMap((r, i) =>
  Array.from({ length: 7 }, (_, k) => {
    const a = 0.3 + 0.37 * i + (2 * Math.PI * k) / 7;
    return [r * Math.cos(a), r * Math.sin(a)] as [number, number];
  }),
);

/** What sampled found, by the metric's structure and the values it reads:
 *  a reanalysis (a slider elsewhere moving) does not check it again. */
const sampleCache = new Map<string, ReturnType<typeof sampleCounts>>();

/**
 * A metric checked at the sample points, with its sliders at their values:
 * whether the form is g's everywhere it is defined (`quadratic`), and at how
 * many points it is defined, its coordinates are independent, it can be
 * traced in (positive definite, or x and y space with det g < 0; with no
 * time, positive definite or Lorentzian), the panel's coordinates are space,
 * det g < 0, and (with no time) it is positive definite.
 */
function sampled(
  Q: Expr,
  g: readonly (readonly Expr[])[],
  J: readonly (readonly Expr[])[],
  vars: readonly string[],
  values: Readonly<Record<string, number>>,
) {
  const all = [Q, ...g.flat(), ...J.flat()];
  const names = [...new Set(all.flatMap(e => [...freeVars(e)]))].sort();
  const key = JSON.stringify([all.map(exprKey), vars, names.map(n => values[n] ?? null)]);
  let hit = sampleCache.get(key);
  if (!hit) {
    hit = sampleCounts(Q, g, J, vars, values);
    if (sampleCache.size > 64) sampleCache.clear();
    sampleCache.set(key, hit);
  }
  return hit;
}

function sampleCounts(
  Q: Expr,
  g: readonly (readonly Expr[])[],
  J: readonly (readonly Expr[])[],
  vars: readonly string[],
  values: Readonly<Record<string, number>>,
) {
  const n = g.length;
  const at = (e: Expr, env: Record<string, number>) => {
    try {
      return evaluate(e, { ...values, ...env });
    } catch {
      return NaN;
    }
  };
  const counts = { quadratic: true, defined: 0, independent: 0, traceable: 0, space: 0, lorentz: 0, riemann: 0 };
  for (const [k, [x, y]] of SAMPLES.entries()) {
    const w = vars.map((_, i) => Math.sin(1.7 * k + 2.3 * i + 0.4));
    const env: Record<string, number> = { x, y };
    vars.forEach((v, i) => (env[v] = w[i]));
    const q = at(Q, env);
    const G = g.map(row => row.map(e => at(e, env)));
    if (!Number.isFinite(q) || !G.flat().every(Number.isFinite)) continue;
    counts.defined++;
    let sum = 0;
    let size = Math.abs(q);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        sum += G[i][j] * w[i] * w[j];
        size += Math.abs(G[i][j] * w[i] * w[j]);
      }
    if (Math.abs(sum - q) > 1e-7 * size) return { ...counts, quadratic: false };
    const j = J.map(row => row.map(e => at(e, env)));
    if (Math.abs(j[0][0] * j[1][1] - j[0][1] * j[1][0]) > 1e-12 * Math.max(...j.flat().map(Math.abs)))
      counts.independent++;
    if (n === 2) {
      // Positive definite (a Riemannian plane) or Lorentzian (a spacetime
      // diagram): either can be traced.
      const det = G[0][0] * G[1][1] - G[0][1] ** 2;
      if (G[0][0] > 0 && det > 0) counts.riemann++;
      if (det < 0) counts.lorentz++;
      if ((G[0][0] > 0 && det > 0) || det < 0) counts.traceable++;
      continue;
    }
    const det =
      G[0][0] * (G[1][1] * G[2][2] - G[1][2] ** 2) -
      G[0][1] * (G[0][1] * G[2][2] - G[0][2] * G[1][2]) +
      G[0][2] * (G[0][1] * G[1][2] - G[0][2] * G[1][1]);
    if (det < 0) counts.lorentz++;
    // The panel's coordinates are space here; with det g < 0, the other is
    // a time (in an ergoregion too, where g_ττ > 0).
    if (G[1][1] > 0 && G[1][1] * G[2][2] - G[1][2] ** 2 > 0) {
      counts.space++;
      if (det < 0) counts.traceable++;
    }
  }
  return counts;
}

/** The names of a time: d<name> is its differential in a ds^2 row even
 *  where the document defines d<name> or the name itself. */
const TIME_NAMES: ReadonlySet<string> = new Set(['t', 'τ', 'tau']);

/** Names a differential cannot be of: constants and the imaginary unit. */
const NOT_COORDINATES: ReadonlySet<string> = new Set(['pi', 'e', 'i', 'inf']);

/**
 * The metric of a `ds^2 = rhs` row, or an error saying what is wrong with it:
 * a differential of the panel's coordinates missing, more than one other
 * coordinate, a component that reads that coordinate (it must be cyclic: a
 * static or stationary spacetime) or t, a term that is not quadratic in the
 * differentials, coordinates whose Jacobian vanishes, or a signature it
 * cannot trace (with no time, neither positive definite nor Lorentzian
 * anywhere; no time direction with one). With no time it is a plane where
 * it is positive definite anywhere checked, as before spacetime diagrams,
 * and otherwise a spacetime diagram (`lorentzian`).
 */
export function parseMetric(rhs: Expr, ctx: MetricContext): PanelMetric {
  // The differentials: d<name> for x, y, coordinate fields and t (τ)
  // always; for any other name only when d<name> is not itself something
  // the document defines, which then keeps its value here (`shadowed`).
  const panel: string[] = [];
  const extra: string[] = [];
  const shadowed: string[] = [];
  const names = new Map<string, string>();
  for (const name of freeVars(rhs)) {
    if (name.length < 2 || name[0] !== 'd') continue;
    const of = name.slice(1);
    if (PANEL.has(of) || Object.hasOwn(ctx.fields, of)) {
      panel.push(of);
      names.set(name, of);
      continue;
    }
    if (!TIME_NAMES.has(of) && ctx.isDefined(name)) {
      shadowed.push(name);
      continue;
    }
    if (NOT_COORDINATES.has(of) || builtinFn(of))
      throw new Error(
        `ds^2: ${name} is no differential — ${of} is ${builtinFn(of) ? 'a function' : 'a constant'}, not a coordinate.`,
      );
    // A time keeps its name inside ds^2 even beside a slider τ elsewhere.
    if (ctx.isDefined(of) && !TIME_NAMES.has(of))
      throw new Error(
        `ds^2: ${of} is not a coordinate, so ${name} is no differential — define ${of} from x and y (like r = sqrt(x^2 + y^2)), or use a coordinate of its own, like dt.`,
      );
    extra.push(of);
    names.set(name, of);
  }
  const listed = (list: readonly string[]) => list.map(n => `d${n}`).join(', ');
  if (panel.length < 2) {
    // dr and dphi with no r and phi defined read as coordinates of their own.
    const loose = extra.filter(n => !TIME_NAMES.has(n));
    throw new Error(
      `ds^2 needs the differentials of both of the panel's coordinates — dx and dy, or of two coordinates defined from x and y${panel.length ? ` (it has only ${listed(panel)})` : ''}. ` +
        (loose.length
          ? `${listed(loose)} ${loose.length === 1 ? 'is the differential' : 'are differentials'} of no coordinate yet: define ${loose.join(' and ')} from x and y first, like r = sqrt(x^2 + y^2) and phi = atan2(y, x).`
          : `Write it ${EXAMPLE}.`),
    );
  }
  if (extra.length > 1)
    throw new Error(
      `ds^2 takes the panel's two coordinates and at most one more, a time no component depends on: ${listed(extra)} are ${extra.length}.`,
    );
  if (panel.length > 2)
    throw new Error(
      `ds^2 is drawn on the plane, in two of the panel's coordinates: ${listed(panel)} are ${panel.length}.`,
    );
  // τ first, then the panel's two: x before y, coordinate fields in the
  // order they are defined (r before phi).
  const fieldOrder = Object.keys(ctx.fields);
  const rank = (c: string) => (c === 'x' ? -2 : c === 'y' ? -1 : fieldOrder.indexOf(c));
  panel.sort((a, b) => rank(a) - rank(b));
  const coords = [...extra, ...panel];
  const time = extra[0];
  const n = coords.length as 2 | 3;
  const slot = new Map(coords.map((c, k) => [c, placeholder(k)]));
  const renamed: Record<string, Expr> = {};
  for (const [name, of] of names) renamed[name] = { kind: 'var', name: slot.get(of)! };
  const Q = ctx.resolve(substVars(rhs, renamed));

  // What the components may read: x, y, the differentials and constants.
  const vars = [...coords.map(c => slot.get(c)!)];
  for (const v of freeVars(Q)) {
    // The extra coordinate first: a slider of the same name (τ = 2) is not
    // what a component in the time τ reads.
    if (v === time)
      throw new Error(
        TIME_NAMES.has(v)
          ? `ds^2 depends on ${v}: metrics that change with time are not supported yet (inside ds^2, d${v} is the differential of the time coordinate ${v}).`
          : `ds^2 depends on ${v}: its coordinate besides the panel's two must be cyclic — no component may depend on it.`,
      );
    if (PANEL.has(v) || vars.includes(v) || ctx.constNames.has(v)) continue;
    throw new Error(`Unknown variable: ${v}. Define "${v} = 1" to make a slider.`);
  }

  // g_ij = ½ ∂²Q/∂dᵢ∂dⱼ, each free of the differentials, and Q = gᵢⱼ dⁱ dʲ.
  const notQuadratic = new Error(
    'ds^2 is a quadratic form in the differentials: each term a coefficient times two of them, like r^2 dphi^2 or 2 a dt dphi.' +
      (shadowed.length
        ? ` (${shadowed.join(', ')} ${shadowed.length === 1 ? 'is' : 'are'} defined elsewhere in the document, so ${shadowed.length === 1 ? 'it is' : 'they are'} that value here, not a differential: rename the definition to use ${shadowed.length === 1 ? 'it' : 'them'} as one.)`
        : ''),
  );
  const g: Expr[][] = [];
  try {
    for (let i = 0; i < n; i++) {
      g.push([]);
      for (let j = 0; j < n; j++) g[i].push(j < i ? g[j][i] : mul(num(0.5), partial(partial(Q, vars[i]), vars[j])));
    }
  } catch (err) {
    if (err instanceof NonSmoothError) throw notQuadratic;
    throw err;
  }
  for (const row of g) for (const e of row) if (vars.some(v => freeVars(e).has(v))) throw notQuadratic;

  // The coordinates in x and y, and their Jacobian.
  const field = (c: string): Expr => {
    if (PANEL.has(c)) return { kind: 'var', name: c };
    const e = ctx.resolve({ kind: 'var', name: c });
    const used = freeVars(e);
    if (used.has('z')) throw new Error(`ds^2 is drawn on the plane, and ${c} uses z.`);
    if (used.has('t'))
      throw new Error(`ds^2: ${c} changes with t, and metrics that change with time are not supported yet.`);
    return e;
  };
  const spatial = coords.slice(n - 2);
  const J = spatial.map(c => {
    const e = field(c);
    return [smoothPartial(e, 'x'), smoothPartial(e, 'y')];
  });

  // Checked at sample points (with the sliders at their values): the form is
  // g's, the coordinates are independent, and the signature is one a
  // geodesic can be traced in somewhere.
  const { defined, independent, traceable, space, lorentz, riemann, quadratic } = sampled(Q, g, J, vars, ctx.values);
  if (!quadratic) throw notQuadratic;
  if (defined && !independent && !spatial.every(c => PANEL.has(c)))
    throw new Error(
      `ds^2: ${spatial.join(' and ')} do not make coordinates on the plane — their Jacobian in x and y vanishes.`,
    );
  if (defined && !traceable)
    throw new Error(
      n === 2
        ? 'ds^2 in two coordinates must be positive for every direction (a Riemannian metric, like (dx^2 + dy^2)/y^2) or have one minus sign (a spacetime diagram, like -dy^2 + dx^2) somewhere; this one is negative for every direction wherever it was checked.'
        : space
          ? `ds^2: ${time} must be a time, with one minus sign, like -dt^2 + dx^2 + dy^2.`
          : lorentz
            ? `ds^2: the panel's coordinates are not space anywhere it was checked, at distances from 0.001 to 100 000 from the origin — inside a horizon everywhere there?`
            : `ds^2 must have one minus sign, for d${time}: the panel's coordinates are space.`,
    );

  // With no time, a plane where it is positive definite anywhere checked
  // (traced where it is so, as before spacetime diagrams), and otherwise a
  // spacetime diagram.
  const lorentzian = n === 2 && !riemann && lorentz > 0;

  // g as written, its x and y derivatives, and — unless it is written in x
  // and y — the Jacobian it is pulled back to x and y with as it is traced
  // (lib/surface-geometry.ts metricReader: g_xy = Jᵀ g J).
  const components: Expr[] = [];
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) components.push(g[i][j]);
  const derivatives = ['x', 'y'].flatMap(v => components.map(c => smoothPartial(c, v)));
  const plain = spatial[0] === 'x' && spatial[1] === 'y';
  const entries = J.flat();
  const jacobian = plain ? undefined : [...entries, ...['x', 'y'].flatMap(v => entries.map(e => smoothPartial(e, v)))];
  if (exceedsNodes([...components, ...derivatives, ...(jacobian ?? [])], 4 * FLOW_NODE_LIMIT))
    throw new Error('This metric is too large to trace geodesics in.');
  return {
    n,
    coords,
    components,
    derivatives,
    ...(jacobian ? { jacobian } : {}),
    ...(time !== undefined ? { time } : {}),
    ...(lorentzian ? { lorentzian: true as const } : {}),
  };
}

/** What a metric row reads out: its signature and coordinates. */
export function metricSummary(metric: Pick<PanelMetric, 'n' | 'coords' | 'lorentzian'>): string {
  const [first, ...rest] = metric.coords;
  return metric.n === 2
    ? metric.lorentzian
      ? `Lorentzian metric in ${metric.coords.join(', ')} (a spacetime diagram): geodesic(P, v) for a particle, lightray(P, d) for light, lightcones for its cones`
      : `Riemannian metric in ${metric.coords.join(', ')}: geodesic(P, d) traces it`
    : `Lorentzian metric in ${first}; ${rest.join(', ')}: geodesic(P, v) for a particle, lightray(P, d) for light, lightcones for its cones`;
}
