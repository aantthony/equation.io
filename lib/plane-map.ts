/**
 * Plane maps: a panel whose screen shows the plane through a map that mixes
 * its coordinates, `view((x, y) = (Y cos X, Y sin X), X = -pi..pi, Y = 0..5)`.
 * The screen's X runs along the angle and Y out along the radius, so circles
 * about the origin are level lines and a spiral unrolls.
 *
 * It is lib/axis-map.ts with the axes joined. A row is drawn per pixel by
 * putting the map in for x and y; velocities and matrices are carried by its
 * Jacobian J = ∂(x, y)/∂(X, Y) instead of two slopes. What places things at
 * positions needs the way back, from (x, y) to the screen, which no peeling
 * of the map finds in general, so it is found numerically: Levenberg–
 * Marquardt from the nearest of a grid of samples over the window, or from
 * the last point along a line. A map may show a point more than once (an
 * angle range wider than 2π); a point is drawn at each, a line follows the
 * copy it started on.
 */
import { diff } from './diff.ts';
import { type Expr, evaluate, freeVars, parseExpr, substVars } from './expr.ts';
import { type Prog, compileProg, run } from './vm.ts';

export interface PlaneMap {
  /** The right side as the row wrote it, for writing the row back. */
  text: string;
  /** x and y in terms of the screen's X and Y. */
  forward: readonly [Expr, Expr];
  /** ∂x/∂X, ∂x/∂Y, ∂y/∂X, ∂y/∂Y, in X and Y. */
  jacobian: readonly [Expr, Expr, Expr, Expr];
}

/** A screen window: X from lo[0] to hi[0], Y from lo[1] to hi[1]. */
export interface ScreenBox {
  lo: readonly [number, number];
  hi: readonly [number, number];
}

const USAGE = 'A plane map writes x and y in terms of the screen’s X and Y: (x, y) = (Y cos(X), Y sin(X)).';
const CONSTANTS = new Set(['pi', 'e', 'tau']);

/** Parse the right side of `(x, y) = (Y cos X, Y sin X)` in a view row. */
export function parsePlaneMap(src: string, env: Record<string, number> = {}): PlaneMap {
  let parsed: Expr;
  try {
    parsed = parseExpr(src);
  } catch {
    throw new Error(USAGE);
  }
  if (parsed.kind !== 'vec' || parsed.items.length !== 2) throw new Error(USAGE);
  // Sliders are read at their value, as an axis map reads them.
  const values: Record<string, Expr> = {};
  let screen = false;
  for (const name of freeVars(parsed)) {
    if (name === 'X' || name === 'Y') screen = true;
    else if (!CONSTANTS.has(name)) {
      const v = env[name];
      if (typeof v !== 'number' || !isFinite(v))
        throw new Error(
          `${USAGE} It can use X, Y, numbers and sliders; ${name} has no fixed value here ` +
            `(not defined, or it changes with t).`,
        );
      values[name] = { kind: 'num', value: v };
    }
  }
  if (!screen) throw new Error(USAGE);
  const forward = parsed.items.map(e => substVars(e, values)) as [Expr, Expr];
  let jacobian: [Expr, Expr, Expr, Expr];
  try {
    jacobian = [diff(forward[0], 'X'), diff(forward[0], 'Y'), diff(forward[1], 'X'), diff(forward[1], 'Y')];
  } catch {
    throw new Error(`(x, y) = ${src.trim()} needs a derivative, to carry flows and directions: use smooth functions.`);
  }
  const map: PlaneMap = { text: src.trim(), forward, jacobian };
  if (!opens(map))
    throw new Error(`(x, y) = ${map.text} flattens the screen onto a line: x and y must vary independently.`);
  return map;
}

/** Whether the map spreads some part of the screen over an area of the
 *  plane: a map whose Jacobian vanishes everywhere shows a curve at most. */
function opens(map: PlaneMap): boolean {
  for (let i = -5; i <= 5; i++)
    for (let j = -5; j <= 5; j++) {
      const [a, b, c, d] = planeJacobian(map, i + 0.37, j + 0.61);
      if (Math.abs(a * d - b * c) > 1e-9) return true;
    }
  return false;
}

interface Compiled {
  f: (X: number, Y: number) => [number, number];
  j: (X: number, Y: number) => [number, number, number, number];
}
const compiledMaps = new WeakMap<PlaneMap, Compiled>();
const SLOTS: ReadonlyMap<string, number> = new Map([
  ['X', 0],
  ['Y', 1],
]);

/** One expression in X and Y as a fast function; the tree walker when the
 *  compiler declines it. */
function fn(e: Expr): (vars: Float64Array) => number {
  let prog: Prog | null = null;
  try {
    prog = compileProg(e, SLOTS);
  } catch {
    /* evaluated below */
  }
  const stack = new Float64Array(64);
  if (prog) {
    const p = prog;
    return vars => {
      try {
        return run(p, vars, stack);
      } catch {
        return NaN;
      }
    };
  }
  return vars => {
    try {
      return evaluate(e, { X: vars[0], Y: vars[1] });
    } catch {
      return NaN;
    }
  };
}

function compiled(map: PlaneMap): Compiled {
  let c = compiledMaps.get(map);
  if (!c) {
    const [fx, fy] = map.forward.map(fn);
    const js = map.jacobian.map(fn);
    const vars = new Float64Array(2);
    const at = (X: number, Y: number) => {
      vars[0] = X;
      vars[1] = Y;
      return vars;
    };
    c = {
      f: (X, Y) => {
        const v = at(X, Y);
        return [fx(v), fy(v)];
      },
      j: (X, Y) => {
        const v = at(X, Y);
        return [js[0](v), js[1](v), js[2](v), js[3](v)];
      },
    };
    compiledMaps.set(map, c);
  }
  return c;
}

/** The world point (x, y) the screen shows at (X, Y). */
export function planeToWorld(map: PlaneMap, X: number, Y: number): [number, number] {
  return compiled(map).f(X, Y);
}

/** ∂x/∂X, ∂x/∂Y, ∂y/∂X, ∂y/∂Y at screen point (X, Y). */
export function planeJacobian(map: PlaneMap, X: number, Y: number): [number, number, number, number] {
  return compiled(map).j(X, Y);
}

/** The part of the plane screen window `box` shows, as a box in x and y
 *  (sampled), or null when it shows none. */
export function planeWorldBox(map: PlaneMap, box: ScreenBox): ScreenBox | null {
  const n = 32;
  const lo: [number, number] = [Infinity, Infinity];
  const hi: [number, number] = [-Infinity, -Infinity];
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++) {
      const [x, y] = planeToWorld(
        map,
        box.lo[0] + ((box.hi[0] - box.lo[0]) * i) / n,
        box.lo[1] + ((box.hi[1] - box.lo[1]) * j) / n,
      );
      if (!isFinite(x) || !isFinite(y)) continue;
      lo[0] = Math.min(lo[0], x);
      lo[1] = Math.min(lo[1], y);
      hi[0] = Math.max(hi[0], x);
      hi[1] = Math.max(hi[1], y);
    }
  return lo[0] <= hi[0] && lo[1] <= hi[1] ? { lo, hi } : null;
}

/** Seeds across the window and this far past each edge, as a share of it,
 *  so a point just off the screen is still found. */
const MARGIN = 0.25;
/** How far past the window a line is followed before it is cut, as a share
 *  of it: just off the screen, so the cut is hidden, and no further, so a
 *  line leaving across the seam of an angle is picked up where it comes
 *  back (planeOverlay) rather than followed on out of sight. */
export const FOLLOW_MARGIN = 0.02;
const SEEDS = 24;
/** How many of the nearest seeds a fresh search starts from. */
const STARTS = 8;

/**
 * The way back from the plane to one screen window. Built per window (a pan
 * makes a new one), from a grid of samples of the map over it.
 */
export class PlaneInverse {
  private readonly c: Compiled;
  /** X, Y, x, y per seed. */
  private readonly seeds: Float64Array;
  private readonly count: number;
  /** The window with its margin. */
  private readonly lo: [number, number];
  private readonly hi: [number, number];
  /** How big the window looks in x and y, and on the screen. */
  private readonly worldScale: number;
  private readonly screenScale: number;
  private readonly center: [number, number];
  private readonly box: ScreenBox;

  constructor(map: PlaneMap, box: ScreenBox) {
    this.c = compiled(map);
    this.box = box;
    const w = box.hi[0] - box.lo[0];
    const h = box.hi[1] - box.lo[1];
    this.lo = [box.lo[0] - MARGIN * w, box.lo[1] - MARGIN * h];
    this.hi = [box.hi[0] + MARGIN * w, box.hi[1] + MARGIN * h];
    this.center = [(box.lo[0] + box.hi[0]) / 2, (box.lo[1] + box.hi[1]) / 2];
    this.screenScale = Math.hypot(w, h);
    const seeds = new Float64Array(4 * (SEEDS + 1) ** 2);
    let n = 0;
    let [xlo, ylo, xhi, yhi] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i <= SEEDS; i++)
      for (let j = 0; j <= SEEDS; j++) {
        const X = this.lo[0] + ((this.hi[0] - this.lo[0]) * (i + 0.5)) / (SEEDS + 1);
        const Y = this.lo[1] + ((this.hi[1] - this.lo[1]) * (j + 0.5)) / (SEEDS + 1);
        const [x, y] = this.c.f(X, Y);
        if (!isFinite(x) || !isFinite(y)) continue;
        seeds.set([X, Y, x, y], 4 * n++);
        [xlo, ylo, xhi, yhi] = [Math.min(xlo, x), Math.min(ylo, y), Math.max(xhi, x), Math.max(yhi, y)];
      }
    this.seeds = seeds;
    this.count = n;
    this.worldScale = n ? Math.hypot(xhi - xlo, yhi - ylo) : 1;
  }

  /** Whether (X, Y) is in the window, or within `margin` of it (a share of
   *  its size). */
  private inside(X: number, Y: number, margin: number): boolean {
    const { lo, hi } = this.box;
    const [mx, my] = [margin * (hi[0] - lo[0]), margin * (hi[1] - lo[1])];
    return X >= lo[0] - mx && X <= hi[0] + mx && Y >= lo[1] - my && Y <= hi[1] + my;
  }

  /**
   * The screen point near `from` that shows (x, y), by Levenberg–Marquardt:
   * Newton's step where the map is regular, a short gradient step where it
   * folds (the polar map's Y = 0). Null when it does not get there, or gets
   * there further than `margin` (a share of the window) past its edges.
   */
  solve(x: number, y: number, from: readonly [number, number], margin = FOLLOW_MARGIN): [number, number] | null {
    const { f, j } = this.c;
    let [X, Y] = from;
    let [fx, fy] = f(X, Y);
    let [rx, ry] = [fx - x, fy - y];
    let err = rx * rx + ry * ry;
    if (!isFinite(err)) return null;
    const scale = this.worldScale + Math.abs(x) + Math.abs(y);
    const done = (1e-11 * scale) ** 2;
    const reach = 0.5 * this.screenScale;
    let lambda = 1e-3;
    for (let it = 0; it < 60 && err > done; it++) {
      const [a, b, c, d] = j(X, Y);
      if (![a, b, c, d].every(isFinite)) return null;
      // Normal equations of the step: (JᵀJ + λ diag) δ = −Jᵀr.
      const A00 = a * a + c * c;
      const A01 = a * b + c * d;
      const A11 = b * b + d * d;
      const g0 = a * rx + c * ry;
      const g1 = b * rx + d * ry;
      const floor = 1e-12 * (A00 + A11) + 1e-300;
      let stepped = false;
      for (let tries = 0; tries < 12; tries++) {
        const m00 = A00 + lambda * Math.max(A00, floor);
        const m11 = A11 + lambda * Math.max(A11, floor);
        const det = m00 * m11 - A01 * A01;
        let dX = -(m11 * g0 - A01 * g1) / det;
        let dY = -(m00 * g1 - A01 * g0) / det;
        // No leaping across the screen: a branch far off is not this one.
        const len = Math.hypot(dX, dY);
        if (len > reach) [dX, dY] = [(dX * reach) / len, (dY * reach) / len];
        const [nX, nY] = [X + dX, Y + dY];
        const [nx, ny] = f(nX, nY);
        const nerr = (nx - x) ** 2 + (ny - y) ** 2;
        if (isFinite(nerr) && nerr < err) {
          [X, Y, rx, ry, err] = [nX, nY, nx - x, ny - y, nerr];
          lambda = Math.max(lambda / 3, 1e-12);
          stepped = true;
          break;
        }
        lambda *= 4;
      }
      // Wandering far off: whatever it finds there is not near this window.
      if (!stepped || !this.inside(X, Y, 2)) break;
    }
    return err <= (1e-7 * scale) ** 2 && this.inside(X, Y, margin) ? [X, Y] : null;
  }

  /** Every screen point in or just around the window showing (x, y). */
  all(x: number, y: number): Array<[number, number]> {
    const near: Array<[number, number]> = [];
    for (let k = 0; k < this.count; k++) {
      const dist = (this.seeds[4 * k + 2] - x) ** 2 + (this.seeds[4 * k + 3] - y) ** 2;
      if (near.length < STARTS || dist < near[near.length - 1][1]) {
        near.push([k, dist]);
        near.sort((p, q) => p[1] - q[1]);
        if (near.length > STARTS) near.pop();
      }
    }
    const out: Array<[number, number]> = [];
    const same = 1e-6 * this.screenScale;
    for (const [k] of near) {
      const s = this.solve(x, y, [this.seeds[4 * k], this.seeds[4 * k + 1]], MARGIN);
      if (s && !out.some(o => Math.abs(o[0] - s[0]) + Math.abs(o[1] - s[1]) < same)) out.push(s);
    }
    return out;
  }

  /** One screen point showing (x, y): in the window if one is, nearest its
   *  middle; NaN when none is. */
  first(x: number, y: number): [number, number] {
    const { lo, hi } = this.box;
    let best: [number, number] = [NaN, NaN];
    let bestScore = Infinity;
    for (const s of this.all(x, y)) {
      const outside = s[0] < lo[0] || s[0] > hi[0] || s[1] < lo[1] || s[1] > hi[1];
      const score = (outside ? 1e6 : 0) + Math.hypot(s[0] - this.center[0], s[1] - this.center[1]);
      if (score < bestScore) [best, bestScore] = [s, score];
    }
    return best;
  }

  /**
   * A carrier for a line: each point is followed on from the last one
   * carried, so the line stays on the copy it started on, and is cut (NaN)
   * just past the window's edge. After a cut it starts afresh, on the copy
   * in the window if there is one: where a line crossing the seam of an
   * angle comes back.
   */
  follower(): (x: number, y: number) => [number, number] {
    let last: [number, number] | null = null;
    return (x, y) => {
      const s = last ? this.solve(x, y, last) : this.first(x, y);
      last = s && isFinite(s[0]) && this.inside(s[0], s[1], FOLLOW_MARGIN) ? s : null;
      return s ?? [NaN, NaN];
    };
  }
}

const inverses = new WeakMap<PlaneMap, { key: string; inverse: PlaneInverse }>();

/** The way back for `map` on window `box`, kept while the window stays. */
export function planeInverse(map: PlaneMap, box: ScreenBox): PlaneInverse {
  const key = [...box.lo, ...box.hi].join();
  const hit = inverses.get(map);
  if (hit?.key === key) return hit.inverse;
  const inverse = new PlaneInverse(map, box);
  inverses.set(map, { key, inverse });
  return inverse;
}

/** The map's x and y, and its Jacobian, with the screen's X and Y called x
 *  and y — the renderer's x and y are the screen's. */
export function planeIn(map: PlaneMap): { forward: [Expr, Expr]; jacobian: [Expr, Expr, Expr, Expr] } {
  const rename = (e: Expr) => substVars(e, { X: { kind: 'var', name: 'x' }, Y: { kind: 'var', name: 'y' } });
  return {
    forward: map.forward.map(rename) as [Expr, Expr],
    jacobian: map.jacobian.map(rename) as [Expr, Expr, Expr, Expr],
  };
}
