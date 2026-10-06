/**
 * Axis maps: a log (or any monotone) axis as a substitution, the way
 * `u = interval(0, 2pi)` rescales u.
 *
 * In a panel whose row reads `view(x = 1..1000, x = 10^X)`, X is the panel's
 * linear screen coordinate — what panning and zooming move evenly — and x,
 * the coordinate every row is written in, is 10^X. A row is drawn by putting
 * the map in for x, so `y = x^2` draws as `y = (10^X)^2` against the screen:
 * shaders, gradients and antialiasing see an ordinary expression in the
 * screen's coordinates and need no axis of their own. Y maps y the same way.
 *
 * The map must be invertible, because the window is written in x units and a
 * graph `y = f` stays a graph only as Y = g⁻¹(f). The inverse is found by
 * peeling the map one step at a time (exp ↔ ln, 10^ ↔ log, affine, powers),
 * which covers the log, log-log, sqrt and symlog (sinh) axes; a map it cannot
 * peel is an error rather than a guess.
 */
import { type Expr, evaluate, freeVars, parseExpr, substVars } from './expr.ts';
import type { MathObject } from './math-object.ts';
import { diff } from './diff.ts';
import { matchODE } from './ode.ts';

export type Axis = 'x' | 'y';

export interface AxisMap {
  /** The world coordinate, x or y. */
  axis: Axis;
  /** As the row wrote it, for writing the row back. */
  text: string;
  /** The world coordinate in terms of the screen one (X or Y). */
  forward: Expr;
  /** The screen coordinate in terms of the world one (x or y). */
  inverse: Expr;
  /** d(world)/d(screen), in the screen coordinate: how fast x moves per X,
   *  which divides a velocity in x into one on the screen. */
  slope: Expr;
}

export type AxisMaps = Partial<Record<Axis, AxisMap>>;

export const SCREEN: Record<Axis, string> = { x: 'X', y: 'Y' };

const num = (value: number): Expr => ({ kind: 'num', value });
const bin = (op: '+' | '-' | '*' | '/' | '^', a: Expr, b: Expr): Expr => ({ kind: 'bin', op, a, b });
const call = (name: string, a: Expr): Expr => ({ kind: 'call', name, args: [a] });

/** Each function the map may apply, and the one that undoes it. */
const INVERSE_FN: Record<string, (target: Expr) => Expr> = {
  exp: w => call('ln', w),
  ln: w => call('exp', w),
  log: w => bin('^', num(10), w),
  log2: w => bin('^', num(2), w),
  sqrt: w => bin('^', w, num(2)),
  sinh: w => call('asinh', w),
  asinh: w => call('sinh', w),
  tanh: w => call('atanh', w),
  atanh: w => call('tanh', w),
};

/** s such that f(s) = target, peeling f from the outside in; null when some
 *  step has no inverse here. */
function solveFor(f: Expr, s: string, target: Expr): Expr | null {
  const has = (e: Expr) => freeVars(e).has(s);
  if (f.kind === 'var' && f.name === s) return target;
  if (f.kind === 'neg') return solveFor(f.a, s, { kind: 'neg', a: target });
  if (f.kind === 'call' && f.args.length === 1 && Object.hasOwn(INVERSE_FN, f.name))
    return solveFor(f.args[0], s, INVERSE_FN[f.name](target));
  if (f.kind !== 'bin') return null;
  const [inA, inB] = [has(f.a), has(f.b)];
  if (inA === inB) return null;
  switch (f.op) {
    case '+':
      return inA ? solveFor(f.a, s, bin('-', target, f.b)) : solveFor(f.b, s, bin('-', target, f.a));
    case '-':
      return inA ? solveFor(f.a, s, bin('+', target, f.b)) : solveFor(f.b, s, bin('-', f.a, target));
    case '*':
      return inA ? solveFor(f.a, s, bin('/', target, f.b)) : solveFor(f.b, s, bin('/', target, f.a));
    case '/':
      return inA ? solveFor(f.a, s, bin('*', target, f.b)) : solveFor(f.b, s, bin('/', f.a, target));
    case '^':
      // s^p undone by the p-th root; b^s by the log base b.
      return inA
        ? solveFor(f.a, s, bin('^', target, bin('/', num(1), f.b)))
        : solveFor(f.b, s, bin('/', call('ln', target), call('ln', f.a)));
  }
}

/** Parse the right side of `x = 10^X` in a view row. */
export function parseAxisMap(axis: Axis, src: string, env: Record<string, number> = {}): AxisMap {
  const screen = SCREEN[axis];
  const usage = `An axis map writes ${axis} in terms of the screen's ${screen}, like ${axis} = 10^${screen}.`;
  let forward: Expr;
  try {
    forward = parseExpr(src);
  } catch {
    throw new Error(usage);
  }
  const free = [...freeVars(forward)].filter(n => n !== 'pi' && n !== 'e' && n !== 'tau');
  if (!free.includes(screen)) throw new Error(usage);
  // A slider (`x = b^X`) is read at its value, so the map is plain numbers
  // from here on; reading it through env marks it as one a slider move
  // reanalyses for (lib/analysis.ts structuralConsts), which reframes the axis.
  const values: Record<string, Expr> = {};
  for (const name of free) {
    if (name === screen) continue;
    const v = env[name];
    if (typeof v !== 'number' || !isFinite(v))
      throw new Error(
        `${usage} It can use ${screen}, numbers and sliders; ${name} has no fixed value here ` +
          `(not defined, or it changes with t).`,
      );
    values[name] = num(v);
  }
  forward = substVars(forward, values);
  const inverse = solveFor(forward, screen, { kind: 'var', name: axis });
  if (!inverse)
    throw new Error(
      `${axis} = ${src.trim()} has no inverse that can be worked out, and the axis needs one: ` +
        `build it from exp, ln, log, powers, sqrt, sinh and arithmetic.`,
    );
  const map: AxisMap = { axis, text: src.trim(), forward, inverse, slope: diff(forward, screen) };
  if (!increasing(map)) throw new Error(`${axis} = ${map.text} must increase with ${screen} wherever it is defined.`);
  return map;
}

/**
 * Whether the map increases, and its inverse undoes it, at every sampled
 * screen coordinate where it is defined: the peeled inverse takes one branch,
 * so X^2 is undone only for X ≥ 0, and -X runs the window backwards. Where
 * the map is undefined (ln(X) for X ≤ 0) is the window's business.
 */
function increasing(map: AxisMap): boolean {
  let last = -Infinity;
  for (let k = -100; k <= 100; k++) {
    const s = k / 10;
    const v = toWorld(map, s);
    if (!isFinite(v)) continue;
    if (v <= last || !(Math.abs(toScreen(map, v) - s) <= 1e-6 * Math.max(1, Math.abs(s)))) return false;
    last = v;
  }
  return isFinite(last);
}

/** The screen coordinate showing world value v, NaN when none does. */
export function toScreen(map: AxisMap, v: number): number {
  try {
    return evaluate(map.inverse, { [map.axis]: v });
  } catch {
    return NaN;
  }
}

/**
 * Where the screen shows world value v, or the edge (±Infinity) past which it
 * lies when the map cannot show it: y = 0 on a log axis is below every value
 * it shows. Bars and integrals stand on y = 0 there.
 */
export function toScreenOrEdge(map: AxisMap, v: number): number {
  const at = toScreen(map, v);
  if (isFinite(at) || Number.isNaN(v)) return at;
  return toWorld(map, 0) > v ? -Infinity : Infinity;
}

/** The maps' slopes (gₓ'(x), gᵧ'(y)) with the screen coordinates called x
 *  and y, as a mapped tensor field carries them (lib/math-object.ts). */
export function tensorSlope(maps: AxisMaps): [Expr, Expr] {
  return [maps.x ? slopeIn(maps.x) : { kind: 'num', value: 1 }, maps.y ? slopeIn(maps.y) : { kind: 'num', value: 1 }];
}

/** The world value at screen coordinate s. */
export function toWorld(map: AxisMap, s: number): number {
  try {
    return evaluate(map.forward, { [SCREEN[map.axis]]: s });
  } catch {
    return NaN;
  }
}

/**
 * A view row's window, given in world units, as screen coordinates. The map
 * must take both ends somewhere, in order: `x = 10^X` with x = -1..10 has no
 * screen place for -1.
 */
export function windowToScreen(map: AxisMap, lo: number, hi: number): [number, number] {
  const [a, b] = [toScreen(map, lo), toScreen(map, hi)];
  const back = (s: number, v: number) => Math.abs(toWorld(map, s) - v) <= 1e-9 * Math.max(1, Math.abs(v));
  if (!isFinite(a) || !isFinite(b) || !back(a, lo) || !back(b, hi))
    throw new Error(`view ${map.axis} range ${lo}..${hi} reaches past what ${map.axis} = ${map.text} can show.`);
  if (a >= b) throw new Error(`${map.axis} = ${map.text} must increase with ${SCREEN[map.axis]}.`);
  return [a, b];
}

/** Whether screen window [a, b] shows only world values the map can name:
 *  a pan past ln(X)'s X = 0 has no x to write. */
export function screenWindowOk(map: AxisMap, a: number, b: number): boolean {
  return [a, b].every(s => isFinite(toWorld(map, s))) && toWorld(map, a) < toWorld(map, b);
}

/**
 * Write the document's coordinate fields (`r = sqrt(x^2 + y^2)`, which may be
 * built from other fields) into a row, so the map reaches the x and y inside
 * them. The renderer would otherwise put them in later, unmapped.
 */
export function inlineFields(e: Expr, fields: Record<string, Expr>): Expr {
  for (let depth = 0; depth < 32; depth++) {
    if (![...freeVars(e)].some(n => Object.hasOwn(fields, n))) return e;
    e = substVars(e, fields);
  }
  throw new Error('The coordinate fields this row uses refer to each other in a loop.');
}

/**
 * The part of screen window [lo, hi] the map can show, as world values
 * (ln(X) shows nothing left of X = 0), or null when it shows none of it.
 */
export function shownRange(
  map: AxisMap,
  lo: number,
  hi: number,
): { screen: [number, number]; world: [number, number] } | null {
  const n = 64;
  let [a, b] = [lo, hi];
  for (let k = 0; k <= n && !isFinite(toWorld(map, a)); k++) a = lo + ((hi - lo) * k) / n;
  for (let k = 0; k <= n && !isFinite(toWorld(map, b)); k++) b = hi - ((hi - lo) * k) / n;
  if (!(a < b) || !isFinite(toWorld(map, a)) || !isFinite(toWorld(map, b))) return null;
  return { screen: [a, b], world: [toWorld(map, a), toWorld(map, b)] };
}

/** The map's world coordinate written in the screen one, with the screen
 *  coordinate called by the world's name — the renderer's x is the screen. */
const forwardIn = (map: AxisMap): Expr =>
  substVars(map.forward, { [SCREEN[map.axis]]: { kind: 'var', name: map.axis } });

/** The map's slope with the screen coordinate called by the world's name. */
const slopeIn = (map: AxisMap): Expr => substVars(map.slope, { [SCREEN[map.axis]]: { kind: 'var', name: map.axis } });

/** g⁻¹(e) for map g: the screen coordinate at which the world one is e. */
const inverseOf = (map: AxisMap, e: Expr): Expr => substVars(map.inverse, { [map.axis]: e });

const isVar = (e: Expr, name: string) => e.kind === 'var' && e.name === name;

/**
 * A row's expression as the mapped panel draws it, in screen coordinates. A
 * graph y = f keeps its shape, y = g⁻¹(f(…)), and so does x = f; everything
 * else has x and y replaced by the map.
 */
export function mapRowExpr(e: Expr, maps: AxisMaps, flow = false): Expr {
  const env: Record<string, Expr> = {};
  for (const map of Object.values(maps)) env[map.axis] = forwardIn(map);
  if (flow) {
    // A velocity in x and y is one on the screen times the map's slope
    // there: x = g(X) moves at g'(X) dX/dt. So arrows, streamlines and traced
    // trajectories all run on the screen as they do anywhere else.
    const v = planeFlow(e);
    if (!v) throw new Error(UNMAPPED_MESSAGE);
    const items = (['x', 'y'] as const).map((axis, k): Expr => {
      const item = substVars(v.items[k], env);
      const map = maps[axis];
      return map ? { kind: 'bin', op: '/', a: item, b: slopeIn(map) } : item;
    });
    return { kind: 'vec', items };
  }
  if (e.kind === 'eq')
    for (const axis of ['y', 'x'] as const) {
      const [lhs, rhs] = isVar(e.l, axis) ? [e.l, e.r] : isVar(e.r, axis) ? [e.r, e.l] : [null, null];
      if (!lhs || freeVars(rhs).has(axis)) continue;
      // The first form found decides, so y = x stays a graph of y.
      const side = substVars(rhs, env);
      const map = maps[axis];
      return { ...e, l: lhs, r: map ? inverseOf(map, side) : side };
    }
  return substVars(e, env);
}

/** The velocities of a 2D flow row: a tuple in x and y, or a slope field
 *  or system spelled as an ODE (`y' = f`, `(x', y') = (P, Q)`). */
function planeFlow(e: Expr): (Expr & { kind: 'vec' }) | null {
  const v = e.kind === 'vec' ? e : matchODE(e);
  return v?.items.length === 2 ? v : null;
}

/**
 * How a mapped panel draws an object, or null when it cannot:
 *
 * - `substitute`: drawn per pixel from x and y (graphs, implicit curves,
 *   regions, fields), or solved for (real systems), so the row is rewritten
 *   by mapRowExpr and the shader or solver sees screen coordinates; a
 *   tensor field is read there too, and carried by the maps' slopes
 *   (tensorSlope);
 * - `place`: it puts things at positions (points, parametric curves and
 *   regions, figures, point lists, labels, histogram bars, a complex
 *   system's roots), so it is computed in x and y as anywhere else and each
 *   position it produces is carried to the screen by the inverse
 *   (web/render2d.ts mapOverlay);
 * - `none`: nothing drawn, or drawn by its own rule (a value, whose integral
 *   is shaded on the screen by lib/intshade.ts shadeRuns; a note).
 *
 * What is left (graphs, sequences, distributions, 3D) is refused rather than
 * drawn in the wrong place.
 */
export type AxisMapping = 'substitute' | 'place' | 'none';

export function axisMapping(object: MathObject): AxisMapping | null {
  switch (object.kind) {
    case 'value':
    case 'note':
    case 'tuple':
      return 'none';
    case 'color-field':
      return 'substitute';
    case 'curve':
      return object.form === 'parametric' ? 'place' : 'substitute';
    case 'region':
      return object.form === 'projected' ? null : object.form === 'parametric' ? 'place' : 'substitute';
    case 'scalar-field':
      return object.dimension === 3 ? null : 'substitute';
    case 'vector-field':
      // Rewritten with the map's slope (mapRowExpr): a 2D flow only.
      return object.components.length === 2 ? 'substitute' : null;
    case 'tensor-field':
      return 'substitute';
    case 'histogram':
      return 'place';
    case 'point':
    case 'trail':
    case 'label':
      return 'place';
    case 'system':
      // Its residuals rewritten like a curve's, the solver searches the
      // window in screen coordinates, evenly, and its solutions are there.
      // A complex system solves in w, which no rewrite of x and y reaches,
      // so it solves in x and y and its roots are placed.
      return object.source.representation === 'real' ? 'substitute' : 'place';
    case 'figure':
      return object.dimension === 2 ? 'place' : null;
    case 'list':
      return object.element === 'point' && object.dimension === 2 ? 'place' : null;
  }
  return null;
}

export const UNMAPPED_MESSAGE =
  "This panel's view(…) maps its axes, which draw curves, regions, fields, points, figures and histograms — not this yet.";
