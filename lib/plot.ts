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
import { complexParts } from './complex-parts.ts';
import { SPECIAL_FORMS, compileTyped, usesComplex } from './complex.ts';
import { diff } from './diff.ts';
import type { ProbBounds } from './dist.ts';
import { ANGLE_FN, builtinFn, type Expr, evaluate, freeVars, ineqComparisons, substVars } from './expr.ts';
import type { FigureName } from './geom.ts';
import type { IntShade, ResolvedRow } from './intshade.ts';
import { toGLSL } from './glsl.ts';
import { type GridField, buildGridField } from './grid.ts';

export type Plot =
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
  | { type: 'value'; expr: Expr; shade?: IntShade }
  /** Live bounded history of a point's observed positions. */
  | { type: 'trail'; dim: 2 | 3; coords: Expr[] }
  /** CPU-evaluated straight-edged figure from segment()/polyline()/vector()/
   *  polygon()/square(): flat vertex expressions [x1, y1, x2, y2, …]. closed
   *  also fills; arrow (vector) draws a screen-space head at the last vertex. */
  | { type: 'polygon'; pts: Expr[]; closed: boolean; arrow?: boolean }
  /**
   * A vector equation L = R, one residual per component. With as many
   * equations as unknowns the solution set is isolated points, found
   * numerically: intersections of curves in 2D, the fiber of a map in 3D.
   * Residuals keep constants under their original names (CPU-evaluated).
   */
  | { type: 'system'; dim: 2 | 3; residuals: Expr[]; parametric?: boolean; angular?: boolean[]; coordinates?: Expr[] }
  /** (Vx, Vy) as GLSL in x, y — rendered as animated line-integral convolution.
   *  comps keep the symbolic components for CPU integration (integral curves). */
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
const WHOLE_EXPR_FORMS = new Set([...SPECIAL_FORMS, 'tube', '[trail]']);

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

export function classify(expr: Expr, defined: ReadonlySet<string> = new Set(), fields: Record<string, Expr> = {}, timeDerivative?: (e: Expr) => Expr): Classified {
  const coordinate = coordinateRow(expr, fields);
  expr = lowerCoordinateFlow(expr, fields, timeDerivative);
  const ode = matchODE(expr);
  if (ode) expr = ode;
  const tube = matchTube(expr);
  if (tube) expr = tube.inner;
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
  if (usesComplex(expr) && (vars.has('z') || hasParam)) {
    throw new Error('Complex expressions plot in 2D only (x, y, w).');
  }

  const done = (plot: Plot): Classified => ({
    plot,
    // Vector-field streamlines drift continuously, so they always animate.
    animated: animated || plot.type === 'vfield2d',
    needs3D: plot.type === 'implicit3d' || plot.type === 'psurface'
      || ((plot.type === 'point' || plot.type === 'trail' || plot.type === 'pcurve' || plot.type === 'plist'
        || plot.type === 'dscatter' || plot.type === 'system') && plot.dim === 3),
    params,
  });

  if (expr.kind === 'call' && expr.name === '[trail]') {
    if (hasSpace || hasParam || usesComplex(expr) || expr.args.some(c => c.kind === 'data' || c.kind === 'list')) {
      throw new Error('trail needs a real point using constants, states, and t; use u for a parametric curve.');
    }
    return done({ type: 'trail', dim: expr.args.length as 2 | 3, coords: expr.args });
  }

  // Desugared segment()/polyline()/vector()/polygon()/square(): CPU-evaluated
  // each frame with the constants' original names, like points and parametric
  // curves.
  const figure = expr.kind === 'call' && Object.hasOwn(FIGURES, expr.name) ? FIGURES[expr.name] : undefined;
  if (expr.kind === 'call' && figure) {
    if (hasSpace || hasParam) {
      throw new Error(`${figure.what} must be constant — they cannot use x, y, u, or v.`);
    }
    return done({
      type: 'polygon', pts: expr.args, closed: figure.closed,
      ...(expr.name === '[vector]' ? { arrow: true } : {}),
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
      if (vars.has('z')) throw new Error('Vector fields are 2D only (components in x, y).');
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
    if (l.items.length !== dim) {
      const eqs = `${l.items.length} equation${l.items.length === 1 ? '' : 's'}`;
      throw new Error(`${eqs} in ${dim} unknowns — a system needs one equation per unknown.`);
    }
    const residuals = l.items.map((a, k): Expr => ({ kind: 'bin', op: '-', a, b: r.items[k] }));
    const positional = coordinate && !hasParam && !coordinate.rhs.some(e =>
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
      const a = complexParts(expr.kind === 'eq' ? expr.l : expr);
      const b = complexParts(expr.kind === 'eq' ? expr.r : expr);
      return done({ type: 'system', dim: 2, residuals: a.map((c, k) => ({ kind: 'bin', op: '-', a: c, b: b[k] })) });
    }
    const field = compileTyped(g).code;
    if (vars.has('z')) return done({ type: 'implicit3d', field, grad: gradOf(g) });
    return done({ type: 'implicit2d', field, levels: levelFamily(expr, params, defined) });
  }

  // Bare scalar expression.
  const compiled = compileTyped(g);
  if (compiled.type === 'complex') {
    if (!hasSpace && !hasParam) return done({ type: 'point', dim: 2, coords: complexParts(expr) });
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
  const parsed = lower(row.expr);
  const cls = classify(parsed, known, fields, timeDerivative);
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
