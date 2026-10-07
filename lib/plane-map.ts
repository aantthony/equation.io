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
  // Near the origin, and far out, for a map defined only there (ln(X - 10)).
  for (const scale of [1, 30])
    for (let i = -5; i <= 5; i++)
      for (let j = -5; j <= 5; j++) {
        const [a, b, c, d] = planeJacobian(map, scale * (i + 0.37), scale * (j + 0.61));
        if (Math.abs(a * d - b * c) > 1e-9) return true;
      }
  return false;
}

interface Compiled {
  f: (X: number, Y: number) => [number, number];
  j: (X: number, Y: number) => [number, number, number, number];
  /** f and j into `out`, for the solver's inner loop: no arrays made. */
  fInto: (X: number, Y: number, out: Float64Array) => void;
  jInto: (X: number, Y: number, out: Float64Array) => void;
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
      fInto: (X, Y, out) => {
        const v = at(X, Y);
        out[0] = fx(v);
        out[1] = fy(v);
      },
      jInto: (X, Y, out) => {
        const v = at(X, Y);
        for (let k = 0; k < 4; k++) out[k] = js[k](v);
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
/** Points tried along a long run between ends off the screen. */
const PROBES = 32;
/** A region's triangles search for copies of the plane at one in this many
 *  (PlaneInverse.triangles); the rest try the copies found. */
const SEARCH_EVERY = 16;
/** How many searches a window remembers. */
const MEMO = 1 << 17;

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
  readonly box: ScreenBox;

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
  inside(X: number, Y: number, margin = 0): boolean {
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
    const { fInto, jInto } = this.c;
    const [v, J] = [this.v, this.J];
    let [X, Y] = from;
    fInto(X, Y, v);
    let rx = v[0] - x;
    let ry = v[1] - y;
    let err = rx * rx + ry * ry;
    if (!isFinite(err)) return null;
    const scale = this.worldScale + Math.abs(x) + Math.abs(y);
    const done = (1e-10 * scale) ** 2;
    const reach = 0.5 * this.screenScale;
    let lambda = 1e-3;
    for (let it = 0; it < 60 && err > done; it++) {
      jInto(X, Y, J);
      const [a, b, c, d] = J;
      if (!(isFinite(a) && isFinite(b) && isFinite(c) && isFinite(d))) return null;
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
        if (len > reach) {
          dX *= reach / len;
          dY *= reach / len;
        }
        fInto(X + dX, Y + dY, v);
        const nrx = v[0] - x;
        const nry = v[1] - y;
        const nerr = nrx * nrx + nry * nry;
        if (isFinite(nerr) && nerr < err) {
          X += dX;
          Y += dY;
          [rx, ry, err] = [nrx, nry, nerr];
          lambda = Math.max(lambda / 3, 1e-12);
          stepped = true;
          break;
        }
        lambda *= 4;
      }
      // Wandering far off: whatever it finds there is not near this window.
      if (!stepped || !this.inside(X, Y, margin + 0.5)) break;
    }
    return err <= (1e-7 * scale) ** 2 && this.inside(X, Y, margin) ? [X, Y] : null;
  }

  /** The solver's scratch: the map's value and Jacobian at a point. */
  private readonly v = new Float64Array(2);
  private readonly J = new Float64Array(4);

  /**
   * A polyline with a point added where a long run crosses the screen
   * between ends the screen does not show (a chord across the window, its
   * ends far off): carried as it is, that run would be a gap.
   */
  through(
    count: number,
    vertex: (k: number) => [number, number],
    closed: boolean,
  ): [number, (k: number) => [number, number]] {
    const long = 0.1 * this.worldScale;
    const off = (p: [number, number]) => !isFinite(this.first(...p)[0]);
    let out: Array<[number, number]> | null = null;
    for (let k = 0; k < (closed ? count : count - 1); k++) {
      const [a, b] = [vertex(k), vertex((k + 1) % count)];
      const added: Array<[number, number]> = [];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > long && off(a) && off(b))
        for (let i = 1; i < PROBES; i++) {
          const p: [number, number] = [a[0] + ((b[0] - a[0]) * i) / PROBES, a[1] + ((b[1] - a[1]) * i) / PROBES];
          if (!off(p)) added.push(p);
        }
      if (added.length && !out) out = Array.from({ length: k + 1 }, (_, i) => vertex(i));
      if (out) out.push(...added, ...(k + 1 < count ? [b] : []));
    }
    if (!out) return [count, vertex];
    const pts = out;
    return [pts.length, k => pts[k]];
  }

  /** The world point at screen point (X, Y). */
  world(X: number, Y: number): [number, number] {
    return this.c.f(X, Y);
  }

  /** Whether the map folds at screen point (X, Y), showing one point of the
   *  plane all along a line there (the polar origin, along Y = 0). */
  folds(X: number, Y: number): boolean {
    const [a, b, c, d] = this.c.j(X, Y);
    return !(Math.abs(a * d - b * c) > 1e-6 * (a * a + b * b + c * c + d * d));
  }

  /** all(), remembered while the window stays: a still picture redraws its
   *  points without solving for them again. */
  private readonly memo = new Map<string, Array<[number, number]>>();

  /** Every screen point in or just around the window showing (x, y). */
  all(x: number, y: number): Array<[number, number]> {
    const key = `${x},${y}`;
    let hit = this.memo.get(key);
    if (!hit) {
      hit = this.search(x, y);
      if (this.memo.size >= MEMO) this.memo.clear();
      this.memo.set(key, hit);
    }
    return hit;
  }

  private search(x: number, y: number): Array<[number, number]> {
    const near: Array<[number, number]> = [];
    for (let k = 0; k < this.count; k++) {
      const dist = (this.seeds[4 * k + 2] - x) ** 2 + (this.seeds[4 * k + 3] - y) ** 2;
      if (near.length < STARTS || dist < near[near.length - 1][1]) {
        // Kept in order: inserted where it belongs, the furthest dropped.
        let at = near.length;
        while (at > 0 && near[at - 1][1] > dist) at--;
        near.splice(at, 0, [k, dist]);
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
   * Triangles [x0, y0, x1, y1, x2, y2, …] carried to the screen: each on
   * the copy of the plane its neighbour was on, its corners followed on from
   * the first, well off the screen; and on every other copy the screen
   * shows, so a region across the seam of an angle fills both sides, and a
   * window wider than a full turn shows it twice.
   */
  triangles(tris: ArrayLike<number>): Float64Array {
    // Corners are shared between neighbouring triangles: each is carried
    // once, followed on from the corner before it (a neighbour, in a
    // sampled grid), and once more per copy of the plane found.
    const ids = new Map<number, Map<number, number>>();
    const xy: number[] = [];
    const corner = new Int32Array(tris.length / 2);
    for (let k = 0; k < corner.length; k++) {
      const [x, y] = [tris[2 * k], tris[2 * k + 1]];
      let row = ids.get(x);
      if (!row) ids.set(x, (row = new Map()));
      let id = row.get(y);
      if (id === undefined) {
        row.set(y, (id = xy.length / 2));
        xy.push(x, y);
      }
      corner[k] = id;
    }
    const count = xy.length / 2;
    const same = (p: readonly [number, number], q: readonly [number, number]) =>
      Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) < 1e-6 * (1 + Math.abs(p[0]) + Math.abs(p[1]));
    // Each corner on the copy its neighbour is on, well off the screen, and
    // the screen offsets of the other copies found by searching now and
    // then: on the polar screen, 2π along X.
    const main = new Float64Array(2 * count).fill(NaN);
    const offsets: Array<[number, number]> = [];
    // An offset found, and its opposite: copies of a turn lie both ways.
    const record = (d: [number, number]) => {
      for (const o of [d, [-d[0], -d[1]] as [number, number]])
        if (offsets.length < 8 && !offsets.some(p => same(p, o))) offsets.push(o);
    };
    // Where the map folds (the polar origin, which the screen shows all
    // along Y = 0) one corner has no one place: it is placed per triangle,
    // from a corner that has, and says nothing of where the copies are.
    const folded = new Uint8Array(count);
    let prev: [number, number] | null = null;
    for (let i = 0; i < count; i++) {
      const [x, y] = [xy[2 * i], xy[2 * i + 1]];
      let s: [number, number] | null = prev && this.solve(x, y, prev, 1);
      // Followed off the window, onto a copy the screen does not show, when
      // it shows another (across the seam of an angle, or polar's copy at
      // (X + π, −Y)): that one.
      if (!s || !this.inside(s[0], s[1])) {
        const found = this.first(x, y);
        if (isFinite(found[0]) && (!s || this.inside(found[0], found[1]))) {
          // Where it came back is how far apart those copies are.
          if (s) record([found[0] - s[0], found[1] - s[1]]);
          s = found;
        }
      }
      if (!s) continue;
      [main[2 * i], main[2 * i + 1], prev] = [s[0], s[1], s];
      folded[i] = this.folds(s[0], s[1]) ? 1 : 0;
      if (folded[i] || i % SEARCH_EVERY) continue;
      for (const other of this.all(x, y))
        // Kept only if it shows on the screen: polar's copy at (X + π, −Y)
        // lies below it, at an offset that changes with Y.
        if (!same(other, s) && this.inside(other[0], other[1])) record([other[0] - s[0], other[1] - s[1]]);
    }
    const copies = offsets.map(([dX, dY]) => {
      const at = new Float64Array(2 * count).fill(NaN);
      for (let i = 0; i < count; i++) {
        const [X, Y] = [main[2 * i] + dX, main[2 * i + 1] + dY];
        // A copy off past the margin is none the screen shows.
        if (!this.inside(X, Y, MARGIN)) continue;
        const s = this.solve(xy[2 * i], xy[2 * i + 1], [X, Y], MARGIN);
        if (s && !same(s, [main[2 * i], main[2 * i + 1]])) [at[2 * i], at[2 * i + 1]] = s;
      }
      return at;
    });
    // A triangle whose corners were followed onto different copies spans
    // the screen: its corners are followed on from one of them instead.
    const far = 0.25 * this.screenScale;
    const out: number[] = [];
    // Each triangle's copies drawn so far, by first corner: two copies of the
    // plane can carry it to the same place.
    let drawn: Array<readonly [number, number]> = [];
    const emit = (on: Float64Array, k: number, first: boolean) => {
      const ids = [corner[k], corner[k + 1], corner[k + 2]];
      const anchor = ids.findIndex(i => !folded[i] && isFinite(on[2 * i]));
      if (anchor < 0) return;
      const pa: [number, number] = [on[2 * ids[anchor]], on[2 * ids[anchor] + 1]];
      const placed = ids.map((i, n): [number, number] | null => {
        if (n === anchor) return pa;
        const p: [number, number] = [on[2 * i], on[2 * i + 1]];
        if (!folded[i] && Math.abs(p[0] - pa[0]) + Math.abs(p[1] - pa[1]) < far) return p;
        return this.solve(xy[2 * i], xy[2 * i + 1], pa, 1);
      });
      if (placed.some(p => !p)) return;
      const tri = placed as Array<[number, number]>;
      if (!first && !tri.some(p => this.inside(p[0], p[1]))) return;
      if (drawn.some(p => same(p, tri[0]))) return;
      drawn.push(tri[0]);
      out.push(...tri.flat());
      // A folded corner is a whole edge on the screen (the polar origin, all
      // along Y = 0 between its neighbours' angles): the triangle is a quad,
      // that corner placed from each of the other two.
      const fold = ids.findIndex(i => folded[i]);
      if (fold < 0 || ids.filter(i => folded[i]).length > 1) return;
      const [next, other] = [(fold + 1) % 3, (fold + 2) % 3];
      const from = next === anchor ? other : next;
      const again = this.solve(xy[2 * ids[fold]], xy[2 * ids[fold] + 1], tri[from], 1);
      if (again && !same(again, tri[fold])) out.push(...tri[fold], ...tri[from], ...again);
    };
    for (let k = 0; k + 2 < corner.length; k += 3) {
      drawn = [];
      emit(main, k, true);
      for (const at of copies) emit(at, k, false);
    }
    return Float64Array.from(out);
  }

  /**
   * A polyline's vertices carried to the screen, NaN pairs where it breaks.
   * Each run is followed on from the last point and cut just past the
   * window's edge (or `margin` past it: a filled shape is followed far off
   * the screen, so it stays one shape to fill). Where a run is cut but its
   * end is on the screen after all, it crossed the seam of an angle and
   * comes back at the other edge: it is traced back from there, through
   * earlier segments, until it leaves the window, so it re-enters at the
   * edge. `segment` carries one straight run a → b, a included and b not,
   * from a's neighbour `from`, handing back b carried; by default its ends
   * only (a renderer cuts the run where the map bends it).
   */
  line(
    count: number,
    vertex: (k: number) => [number, number],
    closed: boolean,
    margin = FOLLOW_MARGIN,
    segment?: Segment,
    start?: readonly [number, number],
  ): number[] {
    [count, vertex] = this.through(count, vertex, closed);
    const shown = (p?: readonly [number, number] | null): p is [number, number] =>
      !!p && isFinite(p[0]) && isFinite(p[1]);
    const carry = (x: number, y: number, hint?: readonly [number, number]): [number, number] =>
      hint ? (this.solve(x, y, hint, margin) ?? [NaN, NaN]) : this.first(x, y);
    const seg: Segment =
      segment ??
      ((a, b, map, from) => {
        const pa = map(a[0], a[1], shown(from) ? from : undefined);
        return [[...pa], map(b[0], b[1], shown(pa) ? pa : undefined)];
      });
    const out: number[] = [];
    const runs = closed ? count : count - 1;
    let last: [number, number] | undefined = start ? [start[0], start[1]] : undefined;
    for (let k = 0; k < runs; k++) {
      const [a, b] = [vertex(k), vertex((k + 1) % count)];
      // A line starts on the copy its next point is on, followed back: where
      // the screen shows its start along a whole line (the polar origin, at
      // every angle), that picks the angle it leaves at.
      if (!last) {
        const next = this.first(...b);
        last = (shown(next) && this.solve(a[0], a[1], next, margin)) || undefined;
      }
      const [piece, end] = seg(a, b, carry, last);
      out.push(...piece);
      last = shown(end) ? end : undefined;
      if (last) continue;
      // Back on the screen on another copy (the same copy, just off it, is
      // no re-entry): traced back to where it comes in.
      const back = this.first(...b);
      if (!shown(back) || !this.inside(back[0], back[1], FOLLOW_MARGIN)) continue;
      const rev: number[] = [];
      let from: [number, number] = back;
      for (let j = k, steps = 0; steps < count && (closed || j >= 0); j--, steps++) {
        const i = (j + count) % count;
        const [p, e] = seg(vertex((i + 1) % count), vertex(i), carry, from);
        rev.push(...p);
        if (!shown(e)) break;
        // Back at the line's start: that point too, then stop.
        if (!closed && i === 0) {
          rev.push(...e);
          break;
        }
        from = e;
      }
      out.push(NaN, NaN);
      // Reversed, without b itself, which the next run starts with.
      for (let i = rev.length - 2; i >= 2; i -= 2) out.push(rev[i], rev[i + 1]);
      last = back;
    }
    if (!closed && count) out.push(...(count > 1 && last ? last : carry(...vertex(count - 1))));
    return out;
  }
}

/** Carries a straight run a → b (see PlaneInverse.line). */
export type Segment = (
  a: [number, number],
  b: [number, number],
  map: (x: number, y: number, hint?: readonly [number, number]) => [number, number],
  from?: readonly [number, number],
) => [number[], [number, number]];

/**
 * A closed shape to fill, carried to the screen whole on each copy of the
 * plane it shows on: followed on from each place the screen shows its first
 * vertex, well off the screen (PlaneInverse.line, margin 1), so a shape
 * across the seam of an angle fills at both edges. One that does not close
 * on the screen (round a point the map folds at) is an outline only.
 */
export function planeShapes(
  inverse: PlaneInverse,
  count: number,
  vertex: (k: number) => [number, number],
  segment?: Segment,
): Array<{ pts: number[]; closed: boolean }> {
  const out: Array<{ pts: number[]; closed: boolean }> = [];
  // Edges crossing the screen between far-off vertices have a point there.
  [count, vertex] = inverse.through(count, vertex, true);
  // From a vertex the screen shows at points apart, not along a whole line
  // (the polar origin): the shape's outline is the same from any vertex.
  let from = 0;
  while (from < count - 1 && inverse.folds(...inverse.first(...vertex(from)))) from++;
  const turned = (k: number) => vertex((k + from) % count);
  let open = false;
  for (const start of inverse.all(...turned(0))) {
    const pts = inverse.line(count, turned, true, 1, segment, start);
    let shows = false;
    for (let i = 0; i + 1 < pts.length && !shows; i += 2) shows = inverse.inside(pts[i], pts[i + 1]);
    if (!shows) continue;
    // Round a point the map folds at (a square about the polar origin), the
    // outline does not come back to where it started: it is open on the
    // screen, a curve with nothing inside it to fill.
    const back = inverse.solve(...turned(0), [pts[pts.length - 2], pts[pts.length - 1]], 1);
    if (
      back &&
      Math.abs(back[0] - start[0]) + Math.abs(back[1] - start[1]) < 1e-6 * (1 + Math.abs(start[0]) + Math.abs(start[1]))
    )
      out.push({ pts, closed: true });
    else open = true;
  }
  // Drawn as a line instead, cut at the edges and picked up where it comes
  // back, once.
  if (open) out.push({ pts: inverse.line(count, turned, true, FOLLOW_MARGIN, segment), closed: false });
  // Nothing of it on the screen, but the screen inside it: filled edge to
  // edge, its outline (just past them) out of sight.
  if (!out.length && contains(count, vertex, inverse.world(...centre(inverse.box)))) {
    const { lo, hi } = inverse.box;
    const [mx, my] = [0.01 * (hi[0] - lo[0]), 0.01 * (hi[1] - lo[1])];
    const [x0, y0, x1, y1] = [lo[0] - mx, lo[1] - my, hi[0] + mx, hi[1] + my];
    out.push({ pts: [x0, y0, x1, y0, x1, y1, x0, y1], closed: true });
  }
  return out;
}

const centre = ({ lo, hi }: ScreenBox): [number, number] => [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];

/** Whether polygon `vertex` contains point p (even–odd). */
function contains(count: number, vertex: (k: number) => [number, number], [x, y]: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const [a, b] = [vertex(i), vertex(j)];
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
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
