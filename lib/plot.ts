/**
 * Classify a parsed expression into a plot type, mirroring the old
 * equation.io renderable dispatcher:
 *
 * - "l = r" → implicit curve (2D) or implicit surface (3D when z appears)
 * - bare scalar in x → treated as y = expr
 * - bare scalar in x,y → 2D scalar field (density)
 * - vector literal with no free vars → a point
 * - vector with free u (and v) → parametric curve (u) / surface (u,v), u,v ∈ (0,1)
 * - vector with free x/y → 2D vector field, drawn as animated streamlines (LIC)
 * - ODEs: dy/dx = f and y' = f plot the direction field (1, f); a system
 *   (x', y') = (P, Q) plots the phase-plane field (P, Q) — all as vector fields
 * - t is always allowed and means "animated": bound to seconds since start
 */
import { coordinateRow, lowerCoordinateFlow } from './coordinate.ts';
import { SplitTooLarge, complexParts } from './complex-parts.ts';
import { SPECIAL_FORMS, WHOLE_EXPR_NAMES, compileTyped, usesComplex } from './complex.ts';
import { diff } from './diff.ts';
import type { ProbBounds } from './dist.ts';
import { ANGLE_FN, REVOLVE_AXES, builtinFn, revolveAxis, type Expr, evaluate, freeVars, ineqComparisons, substVars } from './expr.ts';
import type { FigureName } from './geom.ts';
import type { IntShade, ResolvedRow } from './intshade.ts';
import { PATH_NODE_BUDGET } from './path.ts';
import { exceedsNodes } from './size.ts';
import { toGLSL } from './glsl.ts';
import { type GridField, buildGridField } from './grid.ts';

export type Plot =
  | { type: 'family'; members: Array<{ cls: Classified; expr: Expr }> }
  /**
   * levels: set when the equation is `f(x,y) = c` with c a defined constant
   * (a slider). The renderer can then draw the whole family of level sets of
   * f — a topographic map — with the slider's level as the solid curve.
   */
  | { type: 'implicit2d'; field: string; levels?: GridField }
  /**
   * Shaded region F < 0. Strict comparisons fill with no border; each
   * non-strict comparison contributes an edge field whose zero set is drawn
   * as a solid line. Chains combine via max(), so F < 0 ⇔ all parts hold.
   */
  | { type: 'ineq2d'; field: string; edges: string[] }
  | { type: 'scalar2d'; field: string }
  /** grad: symbolic ∇F for shading normals; absent → finite differences. */
  | { type: 'implicit3d'; field: string; grad?: [string, string, string] }
  /** Complex-valued f(x+iy): level curves of im(f) (field lines) and re(f) (equipotentials). */
  | { type: 'complex2d'; field: string }
  /** domain(f): domain coloring — hue = arg f, dark at zeros, white at poles. */
  | { type: 'domain2d'; field: string }
  /** conformal(f): pullback of the image-plane grid — level curves of re f and im f. */
  | { type: 'conformal2d'; field: string }
  /** iter(step[, n]): escape-time fractal iterating z ↦ step(z). seed 'zero'
   *  when the step references the pixel (w/x/y → parameter plane, Mandelbrot);
   *  seed 'pixel' otherwise (fixed map → Julia). */
  | { type: 'fractal2d'; step: string; seed: 'pixel' | 'zero'; maxIter: number }
  | { type: 'point'; dim: 2 | 3; coords: Expr[] }
  /** A bare real expression with nothing to plot against (`2+2`, `a^2`,
   *  `sin(t)`): it draws nothing and the row reads out `= value` instead.
   *  CPU-evaluated per frame, so constants keep their original names.
   *  With `shade` — the row is exactly one definite integral — the area
   *  between the integrand and the axis is filled too (lib/intshade.ts).
   *  classifyRow attaches it, since resolution expands the ∫ away. */
  | { type: 'note'; expr: Expr; variable: boolean }
  | { type: 'value'; expr: Expr; shade?: IntShade }
  /** Live bounded history of a point's observed positions. */
  | { type: 'trail'; dim: 2 | 3; coords: Expr[] }
  /** CPU-evaluated straight-edged figure from segment()/polyline()/vector()/
   *  polygon()/square(): flat vertex expressions [x1, y1, x2, y2, …]. closed
   *  also fills; arrow (vector) draws a screen-space head at the last vertex. */
  | { type: 'polygon'; dim?: 2 | 3; pts: Expr[]; closed: boolean; arrow?: boolean }
  /**
   * A vector equation L = R, one residual per component. With as many
   * equations as unknowns the solution set is isolated points, found
   * numerically: intersections of curves in 2D, the fiber of a map in 3D.
   * Residuals keep constants under their original names (CPU-evaluated).
   */
  | { type: 'spacecurve'; residuals: Expr[] }
  | { type: 'system'; dim: 2 | 3; residuals: Expr[]; complexEquation?: Expr; parametric?: boolean; angular?: boolean[]; coordinates?: Expr[] }
  /** (Vx, Vy) as GLSL in x, y — rendered as animated line-integral convolution.
   *  comps keep the symbolic components for CPU integration (integral curves). */
  | { type: 'vfield3d'; comps: Expr[] }
  | { type: 'vfield2d'; fx: string; fy: string; comps: [Expr, Expr] }
  /** tube: set by the explicit tube(…) form — sweep a lit tube whose radius
   *  is this expression, evaluated per frame (constants, sliders, and t only)
   *  instead of a line strip. d1..d3: symbolic d/du of comps for framing
   *  (κ, τ, tubes); absent → finite differences. */
  | { type: 'pcurve'; dim: 2 | 3; comps: Expr[]; tube?: Expr; d1?: Expr[]; d2?: Expr[]; d3?: Expr[] }
  /** du/dv: symbolic tangents ∂P/∂u, ∂P/∂v for lighting; absent → finite differences. */
  | { type: 'psurface'; comps: [string, string, string]; du?: [string, string, string]; dv?: [string, string, string] }
  /** [3, 1, 4]: dots at (k, value), k = 1, 2, …; the UI can switch to bars. */
  | { type: 'vlist'; values: Expr[] }
  /** [(1,2), (3,4)]: a scatter of points. */
  | { type: 'plist'; dim: 2 | 3; pts: Expr[][] }
  /**
   * The same two shapes, but backed by typed arrays: a CSV column, or
   * constant arithmetic over one. `dlist` is dots at (k, value); `dscatter`
   * is a cloud with one array per coordinate. Nothing to evaluate per frame,
   * which is what lets these run to hundreds of thousands of points.
   */
  | { type: 'dlist'; values: Float64Array }
  | { type: 'dscatter'; dim: 2 | 3; coords: Float64Array[] }
  /** hist(L): counts per bin, drawn as touching bars of one width. */
  | { type: 'histogram'; centers: Float64Array; counts: Float64Array; width: number }
  /** a_n = f(n): dots at integer n ≥ 0; the UI can switch to partial sums. */
  | { type: 'sequence'; term: Expr; index: string }
  /**
   * a_{n+1} = f(a_n): the map's curve y = f(x) plus a CPU-iterated cobweb
   * path from the seed. recVar is the AST symbol for a_n; a0Name names the
   * seed constant (a_0) if the user defined one.
   */
  | { type: 'cobweb'; f: Expr; recVar: string; curveField: string; a0Name?: string }
  /** a_{n+1} = f(a_n, x): orbit attractor per pixel column, x as the parameter. */
  | { type: 'bifurcation'; field: string; a0Name?: string }
  /** A derived random variable (`S = X + Y`, or a bare expression in random
   *  variables): the sampled density estimate of the named variable. */
  | { type: 'density'; rv: string }
  /** A discrete random variable (`X ~ Binomial(10, 0.3)`): its pmf as stems —
   *  a dot at (k, P(X = k)) on a thin line from the axis — at the whole
   *  numbers of the support in view (RVSystem.stems; CPU overlay). */
  | { type: 'pmf'; rv: string }
  /** A `P(…)` row estimated from samples. With `shade`, the area under rv's
   *  density between the bounds fills in (single-variable bodies only); over
   *  a discrete rv the value is exact and the selected STEMS highlight, which
   *  is where the bounds' strictness shows. */
  | { type: 'prob'; body: Expr; shade?: { rv: string } & ProbBounds }
  /** An `E(…)` row: the mean lives in the row's readout; the plot is a
   *  vertical marker at x = E under the density of rv (the body itself,
   *  registered as an anonymous derived variable when not a bare name). */
  | { type: 'expect'; rv: string };

/** Symbolically differentiate each component; undefined if any is non-smooth. */
function tryGrad(exprs: Expr[], v: string): [string, string, string] | undefined {
  try {
    const out = exprs.map(c => toGLSL(diff(c, v)));
    return out as [string, string, string];
  } catch {
    return undefined;
  }
}

export interface Classified {
  uniforms?: Record<string, number>;
  plot: Plot;
  animated: boolean;
  needs3D: boolean;
  /**
   * User-defined constants the expression references. In GLSL fields they
   * appear as `u_<name>` uniforms; CPU-evaluated plots read them from the
   * constant environment by their original names.
   */
  params: string[];
}

const SPACE_VARS = new Set(['x', 'y', 'z']);
const PARAM_VARS = new Set(['u', 'v']);

const isVarNamed = (e: Expr, name: string): boolean => e.kind === 'var' && e.name === name;

/**
 * Match an equation that spells an ODE — dy/dx = f, y' = f, or a system
 * (x', y') = (P, Q) — and return its direction field as a tuple.
 */
function matchODE(e: Expr): (Expr & { kind: 'vec' }) | null {
  if (e.kind !== 'eq') return null;
  const { l, r } = e;
  const one: Expr = { kind: 'num', value: 1 };
  const vec = (items: Expr[]): Expr & { kind: 'vec' } => ({ kind: 'vec', items });
  if (l.kind === 'bin' && l.op === '/') {
    if (isVarNamed(l.a, 'dy') && isVarNamed(l.b, 'dx')) return vec([one, r]);
    if (isVarNamed(l.a, 'dx') && isVarNamed(l.b, 'dy')) return vec([r, one]);
  }
  if (isVarNamed(l, "y'")) return vec([one, r]);
  if (l.kind === 'vec' && l.items.length === 3 && l.items.every((e, k) => isVarNamed(e, ["x'", "y'", "z'"][k]))) {
    if (r.kind !== 'vec' || r.items.length !== 3) throw new Error('A 3D flow needs three velocity components.');
    return r;
  }
  if (l.kind === 'vec' && l.items.length === 2
    && isVarNamed(l.items[0], "x'") && isVarNamed(l.items[1], "y'")) {
    if (r.kind !== 'vec' || r.items.length !== 2) {
      throw new Error("A system needs two components on the right: (x', y') = (P, Q).");
    }
    return r;
  }
  return null;
}

/** Default sweep radius for tube(…) when no explicit radius is given. */
const DEFAULT_TUBE_RADIUS = 0.1;

/** lowerGeom's figure calls: whether each closes (and fills), and how its
 *  vertices are named in an error, after the statement the user wrote. */
const FIGURES: Partial<Record<string, { closed: boolean; what: string }>> = {
  '[segment]': { closed: false, what: 'Segment endpoints' },
  '[polyline]': { closed: false, what: 'Polyline vertices' },
  '[vector]': { closed: false, what: 'Vector endpoints' },
  '[polygon]': { closed: true, what: 'Polygon vertices' },
  '[square]': { closed: true, what: 'Square vertices' },
} satisfies Record<FigureName, unknown>;

/** Calls that describe the whole plot and cannot appear as a subterm. */
const WHOLE_EXPR_FORMS = new Set([...WHOLE_EXPR_NAMES].map(n => (n === 'trail' ? '[trail]' : n))); // trail arrives lowered

/**
 * tube(curve[, radius]): sweep a 3D parametric curve as a lit tube.
 *
 * Opt-in by design. A bare curve stays a line strip, so a tube can never
 * swallow points, other curves, or anything else sharing the scene — you
 * ask for the solid only when the solid is the point.
 */
function matchTube(e: Expr): { inner: Expr; radius: Expr } | null {
  if (e.kind !== 'call' || e.name !== 'tube') return null;
  // A parenthesized vector inside a call flattens into the argument list, so
  // tube((x, y, z)) and tube(x, y, z) arrive here identically — both spell
  // the same thing, and a fourth argument is the radius.
  if (e.args.length !== 3 && e.args.length !== 4) {
    throw new Error('tube takes three components and an optional radius: tube(cos(u), sin(u), u/4, 0.1).');
  }
  let radius: Expr = { kind: 'num', value: DEFAULT_TUBE_RADIUS };
  if (e.args.length === 4) {
    const r = e.args[3];
    if (r.kind === 'num' && !(r.value > 0)) throw new Error('The tube radius must be a positive number.');
    radius = r;
  }
  return { inner: { kind: 'vec', items: e.args.slice(0, 3) }, radius };
}

const REVOLVE_USAGE = 'revolve takes a profile and an optional axis: revolve(sqrt(x)), or revolve(y^2, y) about the y-axis.';

/**
 * revolve(f[, axis]): the surface swept by turning the curve y = f(x) about
 * the x-axis — or a profile in y or z about that axis. It is nothing but the
 * implicit surface y^2 + z^2 = f(x)^2, so the raymarcher and the symbolic
 * gradient render it as they would the hand-written equation. Squaring
 * revolves |f|, which is the same surface: where f is negative the curve has
 * merely swung to the far side of the axis. A no-default piecewise f is NaN
 * outside its conditions, and no surface is drawn there.
 */
function matchRevolve(e: Expr): Expr | null {
  if (e.kind !== 'call' || e.name !== 'revolve') return null;
  if (e.args.length !== 1 && e.args.length !== 2) throw new Error(REVOLVE_USAGE);
  const [f, ax] = e.args;
  const axis = revolveAxis(ax);
  const form = ax ? `revolve(f, ${axis})` : 'revolve(f)';
  if (f.kind === 'list' || f.kind === 'data') {
    throw new Error('revolve of a list is not supported yet — write one revolve(…) row per profile.');
  }
  if (f.kind === 'vec' || f.kind === 'eq' || f.kind === 'ineq' || f.kind === 'str' || f.kind === 'text') {
    throw new Error(`${form} takes a single real expression in ${axis}, like revolve(sqrt(x)).`);
  }
  // The profile was split off before the root-only check in classify, so a
  // whole-expression form hiding inside it needs its own rejection.
  const nested = nestedSpecial(f);
  if (nested) throw new Error(`${nested === '[trail]' ? 'trail' : nested}(…) must be the whole expression.`);
  if (usesComplex(f)) throw new Error(`${form} takes a real expression in ${axis}; complex values cannot be revolved.`);
  for (const v of freeVars(f)) {
    if (v !== axis && (SPACE_VARS.has(v) || PARAM_VARS.has(v))) {
      throw new Error(`${form} takes an expression in ${axis} only.`);
    }
  }
  const sq = (a: Expr): Expr => ({ kind: 'bin', op: '^', a, b: { kind: 'num', value: 2 } });
  const [p, q] = [...REVOLVE_AXES].filter(v => v !== axis);
  return {
    kind: 'eq',
    l: { kind: 'bin', op: '+', a: sq({ kind: 'var', name: p }), b: sq({ kind: 'var', name: q }) },
    r: sq(f),
  };
}

/** First special-form call at any position other than the root itself. */
function nestedSpecial(e: Expr, isRoot = false): string | undefined {
  if (e.kind === 'call' && !isRoot && WHOLE_EXPR_FORMS.has(e.name)) return e.name;
  switch (e.kind) {
    case 'num':
    case 'var': return undefined;
    case 'neg': return nestedSpecial(e.a);
    case 'bin': return nestedSpecial(e.a) ?? nestedSpecial(e.b);
    case 'call': {
      for (const a of e.args) {
        const f = nestedSpecial(a);
        if (f) return f;
      }
      return undefined;
    }
    case 'eq': return nestedSpecial(e.l) ?? nestedSpecial(e.r);
    case 'ineq': return nestedSpecial(e.l) ?? nestedSpecial(e.r);
    case 'list':
    case 'vec': {
      for (const a of e.items) {
        const f = nestedSpecial(a);
        if (f) return f;
      }
      return undefined;
    }
    case 'piecewise': {
      for (const c of e.cases) {
        const f = nestedSpecial(c.cond) ?? nestedSpecial(c.value);
        if (f) return f;
      }
      return e.otherwise ? nestedSpecial(e.otherwise) : undefined;
    }
  }
}

/**
 * `f(x,y) = c` (either way around) where c is a defined constant: build the
 * level-set family of f so the plot can render the whole contour stack.
 * Real-valued f only — the family renderer and CPU spacing sampler both
 * evaluate f as a plain scalar.
 */
function levelFamily(e: Expr, params: readonly string[], defined: ReadonlySet<string>): GridField | undefined {
  if (e.kind !== 'eq') return undefined;
  const isLevel = (s: Expr) => s.kind === 'var' && params.includes(s.name);
  const f = isLevel(e.r) ? e.l : isLevel(e.l) ? e.r : undefined;
  if (!f || usesComplex(f)) return undefined;
  const fv = freeVars(f);
  if (!fv.has('x') && !fv.has('y')) return undefined;
  try {
    return buildGridField('F', f, defined);
  } catch {
    return undefined;
  }
}

/**
 * The readout of a `value` row: `= 4` when six significant figures say it
 * all, `≈ 1.41421` when they round, `undefined` when there is no number.
 */
export function valueReadout(value: number): string {
  if (Number.isNaN(value)) return 'undefined';
  if (!isFinite(value)) return value > 0 ? '= ∞' : '= −∞';
  const shown = Number(value.toPrecision(6));
  return `${shown === value ? '=' : '≈'} ${shown}`;
}

const tooLarge = (what: string, verb: string) =>
  `This complex ${what} is too large to ${verb} once split into real and imaginary parts — reduce the nesting or the powers.`;

/** complexParts within the node budget every CPU consumer of a split shares
 *  (a path sampled per frame, a root system solved from many seeds): the
 *  split stops as soon as a subterm outgrows it, so refusing is cheap. */
function splitWithin(e: Expr, what: string, verb: string): [Expr, Expr] {
  try {
    return complexParts(e, PATH_NODE_BUDGET);
  } catch (err) {
    if (err instanceof SplitTooLarge) throw new Error(tooLarge(what, verb));
    throw err;
  }
}

export function classify(expr: Expr, defined: ReadonlySet<string> = new Set(), fields: Record<string, Expr> = {}, timeDerivative?: (e: Expr) => Expr): Classified {
  return classifyLowered(expr, defined, fields, timeDerivative).cls;
}

/** Merge scalar differences into one uniform-selected expression. Structural
 * nodes (equations, vectors and figure calls) retain their shape. */
function familyTemplate(es: Expr[], index: string): Expr {
  if (es.every(e => JSON.stringify(e) === JSON.stringify(es[0]))) return es[0];
  const first = es[0];
  if (es.every(e => e.kind === first.kind)) {
    if (first.kind === 'eq' || first.kind === 'ineq') {
      const rows = es as Array<Expr & { kind: 'eq' | 'ineq' }>;
      if (first.kind === 'eq' || rows.every(r => r.kind === 'ineq' && r.op === first.op))
        return { ...first, l: familyTemplate(rows.map(r => r.l), index), r: familyTemplate(rows.map(r => r.r), index) };
    }
    if (first.kind === 'vec') {
      const vs = es as Array<Expr & { kind: 'vec' }>;
      if (vs.every(v => v.items.length === first.items.length)) return { kind: 'vec', items: first.items.map((_, k) => familyTemplate(vs.map(v => v.items[k]), index)) };
    }
    if (first.kind === 'call') {
      const cs = es as Array<Expr & { kind: 'call' }>;
      if (cs.every(c => c.name === first.name && c.args.length === first.args.length)) return { ...first, args: first.args.map((_, k) => familyTemplate(cs.map(c => c.args[k]), index)) };
    }
    if (first.kind === 'bin') {
      const bs = es as Array<Expr & { kind: 'bin' }>;
      if (bs.every(b => b.op === first.op)) return { ...first, a: familyTemplate(bs.map(b => b.a), index), b: familyTemplate(bs.map(b => b.b), index) };
    }
  }
  if (es.some(e => e.kind === 'eq' || e.kind === 'ineq' || e.kind === 'vec')) throw new Error('Family members need matching object shapes.');
  return { kind: 'piecewise', cases: es.slice(0, -1).map((value, k) => ({
    cond: { kind: 'ineq', op: '<', l: { kind: 'var', name: index }, r: { kind: 'num', value: k + .5 } }, value,
  })), otherwise: es[es.length - 1] };
}

/** classify, also handing back the equation a revolve(…) row desugared to
 *  (`surface`) — the one place that desugaring happens, after coordinate
 *  fields have expanded, so a field hiding y or z is seen for what it is. */
function classifyLowered(
  expr: Expr, defined: ReadonlySet<string>, fields: Record<string, Expr>, timeDerivative?: (e: Expr) => Expr,
): { cls: Classified; surface?: Expr } {
  if (expr.kind === 'call' && expr.name === '[family]') {
    if (!expr.args.length || expr.args.length > 32) throw new Error('An object family needs 1–32 members.');
    if (expr.args.some(e => exceedsNodes(e, 8192))) throw new Error('A family element is too large to render (8192 nodes).');
    const members = expr.args.map((e, i) => {
      try { const result = classifyLowered(e, defined, fields, timeDerivative); return { cls: result.cls, expr: result.surface ?? substVars(e, fields) }; }
      catch (err) { throw new Error(`Family element ${i + 1}: ${err instanceof Error ? err.message : err}`); }
    });
    const first = members[0].cls.plot;
    const unsupported = new Set(['family', 'scalar2d', 'domain2d', 'complex2d', 'conformal2d', 'fractal2d', 'density', 'pmf', 'prob', 'expect', 'trail']);
    if (unsupported.has(first.type)) throw new Error(`Families of ${first.type} do not superimpose meaningfully — select a list element L[k] instead.`);
    const odd = members.findIndex(m => m.cls.plot.type !== first.type || ('dim' in m.cls.plot && 'dim' in first && m.cls.plot.dim !== first.dim));
    if (odd >= 0) throw new Error(`Family element ${odd + 1} has a different object kind or dimension.`);
    if (members.some(m => m.cls.needs3D) && members.length > 8) throw new Error('A 3D object family has at most 8 members.');
    const shaders = new Set(['implicit2d', 'ineq2d', 'implicit3d', 'psurface', 'vfield2d']);
    if (shaders.has(first.type)) {
      let index = 'eqioFamilyIndex';
      while (defined.has(index) || expr.args.some(e => freeVars(e).has(index))) index += 'X';
      const merged = familyTemplate(expr.args, index);
      if (exceedsNodes(merged, 32768)) throw new Error('The shared family program is too large (32768 nodes).');
      const shared = classifyLowered(merged, new Set([...defined, index]), fields, timeDerivative);
      for (let k = 0; k < members.length; k++) members[k] = {
        cls: { ...shared.cls, uniforms: { [index]: k } }, expr: shared.surface ?? substVars(merged, fields),
      };
    }
    return { cls: { plot: { type: 'family', members }, animated: members.some(m => m.cls.animated),
      needs3D: members.some(m => m.cls.needs3D), params: [...new Set(members.flatMap(m => m.cls.params))].filter(n => !Object.hasOwn(members[0].cls.uniforms ?? {}, n)) } };
  }
  const coordinate = coordinateRow(expr, fields);
  expr = lowerCoordinateFlow(expr, fields, timeDerivative);
  const ode = matchODE(expr);
  if (ode) expr = ode;
  const tube = matchTube(expr);
  if (tube) expr = tube.inner;
  const surface = matchRevolve(expr) ?? undefined;
  if (surface) expr = surface;
  const special = expr.kind === 'call' && SPECIAL_FORMS.has(expr.name) ? expr.name : undefined;
  const nested = nestedSpecial(expr, true);
  if (nested) throw new Error(`${nested === '[trail]' ? 'trail' : nested}(…) must be the whole expression.`);
  const vars = freeVars(expr);
  if (tube) {
    const r = tube.radius;
    if (r.kind === 'vec' || r.kind === 'list' || r.kind === 'eq' || r.kind === 'ineq' || usesComplex(r)) {
      throw new Error('The tube radius must be a single real number.');
    }
    // The radius was split off before the root-only check below, so whole-
    // expression forms hiding inside it need their own rejection.
    const form = nestedSpecial(r);
    if (form) throw new Error(`${form}(…) must be the whole expression.`);
    // The radius sweeps one circle for the whole tube, so it may vary with
    // time and sliders but not along the curve or across space.
    for (const v of freeVars(r)) {
      if (SPACE_VARS.has(v) || PARAM_VARS.has(v)) {
        throw new Error('The tube radius can only use constants, sliders, and t.');
      }
      vars.add(v);
    }
  }
  vars.delete('i');
  // iter binds z as the iterate: z ↦ step(z) starting from the seed.
  if (special === 'iter') vars.delete('z');
  if (vars.delete('w')) { vars.add('x'); vars.add('y'); }
  const params: string[] = [];
  for (const v of [...vars]) {
    if (defined.has(v)) {
      params.push(v);
      vars.delete(v);
    }
  }
  params.sort();
  for (const v of vars) {
    if (!SPACE_VARS.has(v) && !PARAM_VARS.has(v) && v !== 't') {
      if (v.endsWith("'")) throw new Error(`${v} can only appear on the left of an ODE like y' = x - y.`);
      if (v === 'd' || /^d[A-Za-z]$/.test(v)) throw new Error('Write derivatives as d/dx (…).');
      const fn = builtinFn(v);
      if (fn) throw new Error(`${v} is a function — write it with parentheses, e.g. ${fn}(x).`);
      throw new Error(`Unknown variable: ${v}. Define "${v} = 1" to make a slider.`);
    }
  }
  const animated = vars.has('t');
  const hasParam = vars.has('u') || vars.has('v');
  const hasSpace = vars.has('x') || vars.has('y') || vars.has('z');
  const paramSystem = expr.kind === 'eq' && expr.l.kind === 'vec' && vars.has('u') && !vars.has('v');
  if (hasParam && hasSpace && !paramSystem) throw new Error('Cannot mix u/v with x/y/z.');
  // A bare complex expression in u alone is a path in the plane (below);
  // every other complex use of u, v, or z has no 2D reading.
  const scalar = expr.kind !== 'vec' && expr.kind !== 'list' && expr.kind !== 'eq' && expr.kind !== 'ineq';
  const complexPath = usesComplex(expr) && scalar && !special && !tube && vars.has('u') && !vars.has('v');
  // (Vectors, lists, and domain(…)-style forms each say below what they take.)
  if (usesComplex(expr) && hasParam && !complexPath && !special && expr.kind !== 'vec' && expr.kind !== 'list') {
    throw new Error('A complex path is a bare expression in u alone, like exp(i 2 pi u).');
  }
  if (usesComplex(expr) && vars.has('z')) {
    throw new Error('Complex expressions plot in 2D only (x, y, w).');
  }

  const done = (plot: Plot): { cls: Classified; surface?: Expr } => ({ surface, cls: {
    plot,
    // Vector-field streamlines drift continuously, so they always animate.
    animated: animated || plot.type === 'vfield2d',
    needs3D: plot.type === 'spacecurve' || plot.type === 'vfield3d' || plot.type === 'implicit3d' || plot.type === 'psurface'
      || ((plot.type === 'point' || plot.type === 'trail' || plot.type === 'pcurve' || plot.type === 'plist'
        || plot.type === 'dscatter' || plot.type === 'system' || plot.type === 'polygon') && plot.dim === 3),
    params,
  } });

  if ((expr.kind === 'eq' || expr.kind === 'ineq') && expr.l.kind !== 'vec' && expr.r.kind !== 'vec' && !hasSpace && !hasParam) return done({ type: 'note', expr, variable: animated || params.length > 0 });

  if (expr.kind === 'call' && expr.name === '[trail]') {
    if (hasSpace || hasParam || usesComplex(expr) || expr.args.some(c => c.kind === 'data' || c.kind === 'list')) {
      throw new Error('trail needs a real point using constants, states, and t; use u for a parametric curve.');
    }
    return done({ type: 'trail', dim: expr.args.length as 2 | 3, coords: expr.args });
  }

  // Desugared segment()/polyline()/vector()/polygon()/square(): CPU-evaluated
  // each frame with the constants' original names, like points and parametric
  // curves.
  const figureName = expr.kind === 'call' ? expr.name.replace('3]', ']') : '';
  const figure = Object.hasOwn(FIGURES, figureName) ? FIGURES[figureName] : undefined;
  if (expr.kind === 'call' && figure) {
    if (hasSpace || hasParam) {
      throw new Error(`${figure.what} must be constant — they cannot use x, y, u, or v.`);
    }
    return done({
      type: 'polygon', pts: expr.args, closed: figure.closed,
      ...(expr.name.endsWith('3]') ? { dim: 3 as const } : {}),
      ...(figureName === '[vector]' ? { arrow: true } : {}),
    });
  }

  if (expr.kind === 'text' || expr.kind === 'str') {
    throw new Error('Text cannot be plotted — compare it inside a filter, like people[people.city == "NYC"].');
  }
  // Typed-array lists: a column plots with nothing to evaluate at all.
  if (expr.kind === 'call' && expr.name === '[hist]') {
    const [centers, counts, width] = expr.args;
    return done({
      type: 'histogram',
      centers: (centers as Expr & { kind: 'data' }).values,
      counts: (counts as Expr & { kind: 'data' }).values,
      width: (width as Expr & { kind: 'num' }).value,
    });
  }
  if (expr.kind === 'data') return done({ type: 'dlist', values: expr.values });
  if (expr.kind === 'vec' && expr.items.some(it => it.kind === 'data')) {
    const n = (expr.items.find(it => it.kind === 'data') as Expr & { kind: 'data' }).values.length;
    if (expr.items.length !== 2 && expr.items.length !== 3) {
      throw new Error('Expected 2 or 3 vector components.');
    }
    // A scalar coordinate rides along as a constant column: (col, 0) is a
    // row of points on the axis.
    const coords = expr.items.map(it => {
      if (it.kind === 'data') return it.values;
      if (it.kind !== 'num') throw new Error('A point mixing data with an expression is not supported yet.');
      return new Float64Array(n).fill(it.value);
    });
    return done({ type: 'dscatter', dim: expr.items.length as 2 | 3, coords });
  }

  if (expr.kind === 'list') {
    if (usesComplex(expr)) throw new Error('Complex values are not supported in lists.');
    for (const v of vars) {
      if (v !== 't') throw new Error(`A list may only use constants and t (found ${v}).`);
    }
    const vecs = expr.items.filter((it): it is Expr & { kind: 'vec' } => it.kind === 'vec');
    if (vecs.length === 0) return done({ type: 'vlist', values: expr.items });
    if (vecs.length !== expr.items.length) throw new Error('Lists cannot mix numbers and points.');
    const dims = new Set(vecs.map(it => it.items.length));
    if (dims.size > 1) throw new Error('All points in a list need the same number of coordinates.');
    return done({ type: 'plist', dim: vecs[0].items.length as 2 | 3, pts: vecs.map(it => it.items) });
  }

  // GLSL compilation sees constants as u_<name> uniforms; CPU evaluation
  // (points, parametric curves) keeps the original names.
  const g = params.length
    ? substVars(expr, Object.fromEntries(params.map(p => [p, { kind: 'var', name: 'u_' + p } as Expr])))
    : expr;

  if (special) {
    if (vars.has('z')) throw new Error(`Use w (= x + iy) in ${special}(…); z is the 3D axis.`);
    if (vars.has('u') || vars.has('v')) throw new Error(`Cannot use u/v in ${special}(…).`);
    const call = g as Expr & { kind: 'call' };
    if (special === 'iter') {
      if (call.args.length < 1 || call.args.length > 2) {
        throw new Error('iter takes iter(step) or iter(step, count).');
      }
      let maxIter = 250;
      if (call.args.length === 2) {
        try {
          maxIter = evaluate(call.args[1], {});
        } catch {
          throw new Error('The iteration count must be a plain number.');
        }
        if (!isFinite(maxIter) || maxIter < 1) throw new Error('The iteration count must be at least 1.');
        maxIter = Math.min(5000, Math.round(maxIter));
      }
      const step = compileTyped(call.args[0], { z: { type: 'complex', code: 'zc' } });
      const stepCode = step.type === 'complex' ? step.code : `vec2(${step.code}, 0.0)`;
      // The pixel enters either as a parameter (w/x/y in the step → seed 0,
      // the Mandelbrot convention) or as the seed (fixed map → Julia set).
      const bodyVars = freeVars(call.args[0]);
      const seed = bodyVars.has('w') || bodyVars.has('x') || bodyVars.has('y') ? 'zero' : 'pixel';
      return done({ type: 'fractal2d', step: stepCode, seed, maxIter });
    }
    if (call.args.length !== 1) throw new Error(`${special} takes one argument.`);
    const typed = compileTyped(call.args[0]);
    if (typed.type !== 'complex') {
      throw new Error(`${special}(…) needs a complex expression — use w for x + iy.`);
    }
    return done({ type: special === 'domain' ? 'domain2d' : 'conformal2d', field: typed.code });
  }

  if (expr.kind === 'vec') {
    if (usesComplex(expr)) throw new Error('Complex values are not supported in vectors.');
    const dim = expr.items.length as 2 | 3;
    if (hasSpace || ode) {
      if (hasParam) throw new Error('Vector fields cannot use u or v.');
      if (dim === 3) return done({ type: 'vfield3d', comps: expr.items });
      if (vars.has('z')) throw new Error('A field using z needs three components.');
      if (dim !== 2) throw new Error('A vector field needs exactly 2 components.');
      const [a, b] = (g as Expr & { kind: 'vec' }).items;
      return done({
        type: 'vfield2d',
        fx: toGLSL(a),
        fy: toGLSL(b),
        comps: [expr.items[0], expr.items[1]],
      });
    }
    if (vars.has('v') && !vars.has('u')) throw new Error('Parametric surfaces use u (and v).');
    if (vars.has('u') && vars.has('v')) {
      if (dim !== 3) throw new Error('A parametric surface needs 3 components.');
      const gItems = (g as Expr & { kind: 'vec' }).items;
      const [a, b, c] = gItems;
      return done({
        type: 'psurface',
        comps: [toGLSL(a), toGLSL(b), toGLSL(c)],
        du: tryGrad(gItems, 'u'),
        dv: tryGrad(gItems, 'v'),
      });
    }
    if (vars.has('u')) {
      // Successive u-derivatives for Frenet framing; stop at the first
      // non-smooth level (the renderer falls back to finite differences).
      const tryDiff = (es?: Expr[]): Expr[] | undefined => {
        try {
          return es?.map(c => diff(c, 'u'));
        } catch {
          return undefined;
        }
      };
      const d1 = tryDiff(expr.items);
      const d2 = tryDiff(d1);
      return done({ type: 'pcurve', dim, comps: expr.items, tube: tube?.radius, d1, d2, d3: tryDiff(d2) });
    }
    if (tube) throw new Error('tube(…) needs a curve in u, like tube((cos(u), sin(u), u/4)).');
    return done({ type: 'point', dim, coords: expr.items });
  }

  // A complex-valued expression in u is the image of a path: its real and
  // imaginary parts are an ordinary 2D parametric curve in the Argand plane
  // (the plane of w = x + iy, where complex points and roots already sit).
  if (complexPath) {
    // Sized before anything walks it: typing and splitting a huge inlined
    // composition would cost seconds just to learn it cannot be sampled.
    if (exceedsNodes(expr, PATH_NODE_BUDGET)) throw new Error(tooLarge('path', 'sample'));
    // An expression that mentions i but is real (|exp(i u)|) traces nothing
    // in the plane: it is a number for each u, and the row says so.
    if (compileTyped(g).type !== 'complex') {
      throw new Error('This is a real number for each u, not a path — a complex path needs an imaginary part, like exp(i 2 pi u); for a real curve write (u, …).');
    }
    return done({ type: 'pcurve', dim: 2, comps: splitWithin(expr, 'path', 'sample') });
  }
  if (hasParam && !paramSystem) throw new Error('u/v need a vector expression like (cos(u), sin(u), v).');

  // A vector equation is a system, one residual per component: F(x,y,z) =
  // (a, b, c) is the fiber of a map, (f, g) = (0, 0) an intersection of
  // curves. Square systems (as many equations as unknowns) cut out isolated
  // points; the solver finds them numerically.
  if (expr.kind === 'eq' && (expr.l.kind === 'vec' || expr.r.kind === 'vec')) {
    const { l, r } = expr;
    if (l.kind !== 'vec' || r.kind !== 'vec') {
      throw new Error('A vector equation needs components on both sides, like (f, g) = (0, 0).');
    }
    if (l.items.length !== r.items.length) {
      throw new Error(`Mismatched components: ${l.items.length} on the left, ${r.items.length} on the right.`);
    }
    if (usesComplex(expr)) throw new Error('Complex values are not supported in systems.');
    const dim = vars.has('z') ? 3 : 2;
    if (l.items.length === 2 && dim === 3 && !hasParam) return done({ type: 'spacecurve', residuals: l.items.map((a, k): Expr => {
      const residual: Expr = { kind: 'bin', op: '-', a, b: r.items[k] };
      return a.kind === 'call' && (a.name === 'atan2' || a.name === ANGLE_FN || (a.name === 'atan' && a.args.length === 2))
        ? { kind: 'call', name: 'atan2', args: [{ kind: 'call', name: 'sin', args: [residual] }, { kind: 'call', name: 'cos', args: [residual] }] } : residual;
    }) });
    if (l.items.length !== dim) {
      const eqs = `${l.items.length} equation${l.items.length === 1 ? '' : 's'}`;
      throw new Error(`${eqs} in ${dim} unknowns — a system needs one equation per unknown.`);
    }
    const residuals = l.items.map((a, k): Expr => ({ kind: 'bin', op: '-', a, b: r.items[k] }));
    // (Dragging writes the pointer's chart coordinates back, and a pointer
    // ray does not determine a point in space: planar rows only.)
    const positional = coordinate && dim === 2 && !hasParam && !coordinate.rhs.some(e =>
      [...freeVars(e)].some(v => ['x', 'y', 'z'].includes(v) || Object.hasOwn(fields, v)));
    // Only a direct angle coordinate — atan2, or the angle(…) measurement —
    // is periodic; nesting one inside a real expression does not make that
    // expression an angle.
    return done({
      type: 'system', dim, residuals, angular: l.items.map(e => e.kind === 'call' && (e.name === 'atan2' || e.name === ANGLE_FN || (e.name === 'atan' && e.args.length === 2))),
      ...(paramSystem ? { parametric: true } : {}),
      ...(positional ? { coordinates: coordinate.coords } : {}),
    });
  }

  if (g.kind === 'ineq') {
    if (vars.has('z')) throw new Error('Inequalities are 2D only.');
    const comps = ineqComparisons(g);
    if (new Set(comps.map(c => c.op[0])).size > 1) {
      throw new Error('Chained inequalities must point the same way.');
    }
    const fields = comps.map(c => {
      // Normalize to F < 0: l < r gives l - r, l > r gives r - l.
      const [lo, hi] = c.op[0] === '<' ? [c.l, c.r] : [c.r, c.l];
      const typed = compileTyped({ kind: 'bin', op: '-', a: lo, b: hi });
      if (typed.type === 'complex') throw new Error('Complex inequality: compare re(…) or im(…) instead.');
      return { code: typed.code, edge: c.op.length === 2 };
    });
    let combined = fields[0].code;
    for (let k = 1; k < fields.length; k++) combined = `max(${combined}, ${fields[k].code})`;
    return done({ type: 'ineq2d', field: combined, edges: fields.filter(f => f.edge).map(f => f.code) });
  }

  const gradOf = (f: Expr): [string, string, string] | undefined => {
    try {
      return ['x', 'y', 'z'].map(v => toGLSL(diff(f, v))) as [string, string, string];
    } catch {
      return undefined;
    }
  };

  if (g.kind === 'eq') {
    // Complex equality supplies two real residuals. Real projections such as
    // re(w) remain ordinary implicit equations.
    if (compileTyped(g.l).type === 'complex' || compileTyped(g.r).type === 'complex') {
      if (!hasSpace) throw new Error('A constant complex comparison has no isolated roots — use w as the unknown.');
      const a = splitWithin(expr.kind === 'eq' ? expr.l : expr, 'equation', 'solve');
      const b = splitWithin(expr.kind === 'eq' ? expr.r : expr, 'equation', 'solve');
      return done({ type: 'system', dim: 2, complexEquation: expr, residuals: a.map((c, k) => ({ kind: 'bin', op: '-', a: c, b: b[k] })) });
    }
    const field = compileTyped(g).code;
    if (vars.has('z')) return done({ type: 'implicit3d', field, grad: gradOf(g) });
    return done({ type: 'implicit2d', field, levels: levelFamily(expr, params, defined) });
  }

  // Bare scalar expression.
  const compiled = compileTyped(g);
  if (compiled.type === 'complex') {
    if (!hasSpace && !hasParam) return done({ type: 'point', dim: 2, coords: splitWithin(expr, 'point', 'evaluate') });
    return done({ type: 'complex2d', field: compiled.code });
  }
  if (vars.has('z')) return done({ type: 'implicit3d', field: compiled.code, grad: gradOf(g) });
  if (vars.has('y')) return done({ type: 'scalar2d', field: compiled.code });
  // A number is not a graph: `2+2` answers "= 4" rather than drawing y = 4.
  if (!hasSpace && !hasParam) return done({ type: 'value', expr });
  // Only x: plot as y = expr.
  const asY: Expr = { kind: 'eq', l: { kind: 'var', name: 'y' }, r: g };
  return done({ type: 'implicit2d', field: compileTyped(asY).code });
}

/** A stand-in for the integration variable while the integrand is lowered:
 *  no document name can collide with it (it is not an identifier). */
const INT_VAR = '[dx]';

/**
 * Lower and classify a resolved row (lib/defs.ts resolveRow) — THE way a
 * plain row is classified, in the app and in analyze() alike, so neither can
 * miss what rides along: a `value` row that is exactly one definite integral
 * of a real integrand also carries the area it shades.
 *
 * `lower` is the row's geometry/list lowering; `known` the names that have a
 * value each frame. Being a `value` is what makes the bounds constant
 * (sliders, states and t included).
 */
export function classifyRow(
  row: ResolvedRow, lower: (e: Expr) => Expr, known: ReadonlySet<string>,
  fields: Record<string, Expr> = {}, timeDerivative?: (e: Expr) => Expr,
): { cls: Classified; parsed: Expr } {
  const lowered = lower(row.expr);
  // A revolve(…) row hands back the surface it draws, not a call nothing
  // evaluates.
  const { cls, surface } = classifyLowered(lowered, known, fields, timeDerivative);
  const parsed = surface ?? lowered;
  if (cls.plot.type === 'value' && row.integral) {
    const shade = lowerShade(row.integral, lower, known);
    if (shade) cls.plot.shade = shade;
  }
  return { cls, parsed };
}

function lowerShade(int: IntShade, lower: (e: Expr) => Expr, known: ReadonlySet<string>): IntShade | null {
  const { v } = int;
  const isInf = (b: Expr) => { const a = b.kind === 'neg' ? b.a : b; return a.kind === 'var' && a.name === 'inf'; };
  try {
    // Inside the integrand v is the bound variable, whatever else the
    // document calls by that name: a slider it merely shadows, but a list or
    // a point would be substituted in by lowering — so it lowers under a
    // stand-in name. In the bounds the name keeps its document meaning.
    const hidden = lower(substVars(int.body, { [v]: { kind: 'var', name: INT_VAR } }));
    const body = substVars(hidden, { [INT_VAR]: { kind: 'var', name: v } });
    const [lo, hi] = [int.lo, int.hi].map(b => (isInf(b) ? b : lower(b)));
    const scalar = (e: Expr) => e.kind !== 'vec' && e.kind !== 'list' && e.kind !== 'data'
      && e.kind !== 'eq' && e.kind !== 'ineq' && !usesComplex(e);
    if (![body, lo, hi].every(scalar)) return null;
    const free = (e: Expr, bound?: string) => [...freeVars(e)].every(n => n === bound || n === 't' || known.has(n));
    if (!free(body, v) || ![lo, hi].every(b => isInf(b) || free(b))) return null;
    return { body, v, lo, hi };
  } catch {
    return null; // not drawable; the readout is unaffected
  }
}

/** A decided comparison is a note, independent of the view and render mode. */
export function comparisonReadout(plot: Extract<Plot, { type: 'note' }>, env: Record<string, number>): string {
  const e = plot.expr;
  if (e.kind !== 'eq' && e.kind !== 'ineq') return '';
  let truth: boolean;
  let values: string;
  if (e.kind === 'eq') {
    const parts = (x: Expr) => usesComplex(x) ? complexParts(x).map(c => evaluate(c, env)) : [evaluate(x, env), 0];
    const a = parts(e.l), b = parts(e.r);
    if (![...a, ...b].every(Number.isFinite)) return 'Undefined comparison';
    truth = a.every((v, k) => v === b[k]);
    const fmt = (p: number[]) => p[1] === 0 ? String(Number(p[0].toPrecision(6))) : `${Number(p[0].toPrecision(6))}${p[1] < 0 ? '' : '+'}${Number(p[1].toPrecision(6))}i`;
    values = `${fmt(a)} ${truth ? '=' : '≠'} ${fmt(b)}`;
  } else {
    const comparisons = ineqComparisons(e);
    const vals = comparisons.map(c => [evaluate(c.l, env), evaluate(c.r, env)]);
    if (!vals.flat().every(Number.isFinite)) return 'Undefined comparison';
    truth = comparisons.every((c, k) => { const [a, b] = vals[k]; return c.op === '<' ? a < b : c.op === '<=' ? a <= b : c.op === '>' ? a > b : a >= b; });
    values = comparisons.map((c, k) => `${Number(vals[k][0].toPrecision(6))} ${c.op} ${Number(vals[k][1].toPrecision(6))}`).join(', ');
  }
  return `${plot.variable ? (truth ? 'True now' : 'False now') : (truth ? 'Always true' : 'Never true')} (${values})`;
}

/** One readout per source row, including lists and families of readouts. */
export function plotReadout(plot: Plot, env: Record<string, number>): string | null {
  if (plot.type === 'value') return valueReadout(evaluate(plot.expr, env));
  if (plot.type === 'note') return comparisonReadout(plot, env);
  if (plot.type === 'vlist') {
    const values = plot.values.slice(0, 8).map(e => valueReadout(evaluate(e, env)));
    const prefix = values.some(v => v.startsWith('≈')) ? '≈' : '=';
    return `${prefix} [${values.map(v => v.replace(/^[=≈] /, '')).join(', ')}${plot.values.length > 8 ? ', …' : ''}]`;
  }
  if (plot.type === 'family') {
    const parts = plot.members.map(m => plotReadout(m.cls.plot, { ...env, ...m.cls.uniforms }));
    if (parts.every(p => p !== null)) return `[${parts.slice(0, 8).join('; ')}${parts.length > 8 ? '; …' : ''}]`;
  }
  return null;
}
