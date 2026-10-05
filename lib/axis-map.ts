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
export function parseAxisMap(axis: Axis, src: string): AxisMap {
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
  const other = free.find(n => n !== screen);
  if (other) throw new Error(`${usage} It can use only ${screen} and numbers (found ${other}).`);
  const inverse = solveFor(forward, screen, { kind: 'var', name: axis });
  if (!inverse)
    throw new Error(
      `${axis} = ${src.trim()} has no inverse that can be worked out, and the axis needs one: ` +
        `build it from exp, ln, log, powers, sqrt, sinh and arithmetic.`,
    );
  const map: AxisMap = { axis, text: src.trim(), forward, inverse };
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

/** The map's world coordinate written in the screen one, with the screen
 *  coordinate called by the world's name — the renderer's x is the screen. */
const forwardIn = (map: AxisMap): Expr =>
  substVars(map.forward, { [SCREEN[map.axis]]: { kind: 'var', name: map.axis } });

/** g⁻¹(e) for map g: the screen coordinate at which the world one is e. */
const inverseOf = (map: AxisMap, e: Expr): Expr => substVars(map.inverse, { [map.axis]: e });

const isVar = (e: Expr, name: string) => e.kind === 'var' && e.name === name;

/**
 * A row's expression as the mapped panel draws it, in screen coordinates. A
 * graph y = f keeps its shape, y = g⁻¹(f(…)), and so does x = f; everything
 * else has x and y replaced by the map.
 */
export function mapRowExpr(e: Expr, maps: AxisMaps): Expr {
  const env: Record<string, Expr> = {};
  for (const map of Object.values(maps)) env[map.axis] = forwardIn(map);
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

/**
 * Why a mapped panel cannot draw this object yet, or null when it can. What
 * is drawn per pixel from x and y (graphs, implicit curves, regions, fields)
 * is mapped by mapRowExpr; what places points — points, parametric curves,
 * geometry, data — would need the inverse at every point, which is not built
 * yet, and drawing it unmapped would put it in the wrong place.
 */
export function unmappedObject(object: MathObject): string | null {
  switch (object.kind) {
    case 'value':
    case 'note':
    case 'tuple':
    case 'color-field':
      return null;
    case 'curve':
      if (object.form === 'graph' || object.form === 'implicit') return null;
      break;
    case 'region':
      if (!object.form) return null;
      break;
    case 'scalar-field':
      if (object.dimension !== 3) return null;
      break;
  }
  return "This panel's view(…) maps its axes, and only graphs, implicit curves, regions and fields are drawn on mapped axes so far.";
}
