/**
 * view(...) / camera(...) rows: the viewport as document state.
 *
 * The row list is the whole document, so initial framing lives in a row like
 * everything else: `view(x = -5..5, y = -2..2)` frames the 2D window and
 * `camera(theta, phi, radius, (tx, ty, tz))` aims the 3D orbit camera. In the
 * app the binding is two-way — panning or orbiting rewrites the row exactly
 * the way dragging a slider rewrites its constant — so the URL always names
 * the picture on screen. Without a viewport row the view stays ephemeral.
 *
 * Scanned by regex before expression parsing (the scanDistribution pattern)
 * because `,` binds tighter than `=` in the grammar: parsing the whole row
 * would nest the axes inside one another (the sum(n=1..N, …) shape). The
 * pieces between top-level commas are parsed as ordinary scalar expressions,
 * so `pi` and defined constants work; callers evaluate at t = 0.
 */
import { evaluate, parseExpr } from './expr.ts';
import { type GridRowSpec, type SplitSpec, parseDividerRow, parseGridRow } from './panels.ts';
import { type AxisMaps, SCREEN, parseAxisMap, screenWindowOk, toWorld, windowToScreen } from './axis-map.ts';

export interface View2DSpec {
  kind: 'view';
  /** Pixels per y unit divided by pixels per x unit; defaults to 1. */
  ratio?: number;
  /** [lo, hi] of the axis, when given. At least one axis is always present. */
  x?: [number, number];
  y?: [number, number];
  /** Pinned: pointer gestures leave this panel's window where the row puts it. */
  locked?: boolean;
  /**
   * A lattice view names its index axes instead of x and y —
   * `view(i = -60..60, n = 0..80)` (docs/discrete.md). x and y still hold
   * the window in plane units: x is the first index, y minus the second, so
   * row n + 1 sits below row n. A panel whose rows run the axes the other
   * way round swaps them (orientLattice).
   */
  axes?: [string, string];
  /**
   * `view(x = 1..1000, x = 10^X)`: x is 10^X, X the panel's linear screen
   * coordinate (lib/axis-map.ts). With a map, x and y above hold the window
   * in screen units — the row writes it in x units.
   */
  maps?: AxisMaps;
}

export interface Camera3DSpec {
  kind: 'camera';
  /** Orbit angles in radians (the app's Camera3D convention). */
  theta: number;
  phi: number;
  radius?: number;
  target?: [number, number, number];
  /** Keeps the camera orbiting about the vertical axis, radians per second.
   *  theta is where the orbit starts; the row does not change as it turns. */
  spin?: number;
  /** Pinned: dragging orbits nothing; the camera stays where the row aims it. */
  locked?: boolean;
}

/** Viewport rows: the framing rows, plus the split-view rows of lib/panels.ts
 *  (a `---` divider, a `grid(…)`), which are document structure the same way. */
export type ViewSpec = View2DSpec | Camera3DSpec | SplitSpec | GridRowSpec;

const HEAD_RE = /^\s*(view|camera)\s*\(([\s\S]*)\)\s*$/;

/** Split on top-level commas only, so a (tx, ty, tz) target stays one arg. */
function splitArgs(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

/** Split `lo..hi` at the top-level `..`, or null when there is none. */
function splitRange(s: string): [string, string] | null {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === '.' && s[i + 1] === '.' && depth === 0) {
      return [s.slice(0, i), s.slice(i + 2)];
    }
  }
  return null;
}

function numExpr(e: ReturnType<typeof parseExpr>, env: Record<string, number>, what: string): number {
  let v: number;
  try {
    v = evaluate(e, env);
  } catch (err) {
    throw new Error(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isFinite(v)) throw new Error(`${what} is not a finite number.`);
  return v;
}

function num(src: string, env: Record<string, number>, what: string): number {
  let parsed;
  try {
    parsed = parseExpr(src);
  } catch (err) {
    throw new Error(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return numExpr(parsed, env, what);
}

/**
 * Parse a viewport row. Returns null when the text is not one (so ordinary
 * rows fall through to the expression parser); throws a row-friendly error
 * when it is one but malformed. `env` supplies constant values (t = 0).
 */
export function parseViewRow(text: string, env: Record<string, number>): ViewSpec | null {
  const split = parseDividerRow(text);
  if (split) return split;
  const grid = parseGridRow(text);
  if (grid) return grid;
  const m = HEAD_RE.exec(text);
  if (!m) return null;
  const args = splitArgs(m[2]);
  // A bare `locked` pins the panel; it may sit anywhere among the arguments.
  const lockAt = args.findIndex(a => /^locked$/i.test(a));
  const locked = lockAt >= 0;
  if (locked) args.splice(lockAt, 1);
  if (m[1] === 'view') {
    const usage = 'Expected view(x = lo..hi, y = lo..hi, ratio = 1, locked) — either axis alone works.';
    const spec: View2DSpec = { kind: 'view' };
    if (locked) spec.locked = true;
    if (!args.length || args.length > 5) throw new Error(usage);
    const maps: AxisMaps = {};
    const lattice: Array<[string, [number, number]]> = [];
    for (const arg of args) {
      const named = /^([A-Za-z]\w*)\s*=\s*([\s\S]+)$/.exec(arg);
      if (!named) throw new Error(usage);
      const axis = named[1];
      if (axis === 'ratio') {
        if (spec.ratio !== undefined) throw new Error('view(...) sets ratio twice.');
        spec.ratio = num(named[2], env, 'view ratio');
        if (spec.ratio <= 0) throw new Error('The view ratio must be positive.');
        continue;
      }
      const range = splitRange(named[2]);
      // `x = 10^X`: no range, and the screen's X, so a map from the screen to x.
      if (!range && (axis === 'x' || axis === 'y') && new RegExp(`\\b${SCREEN[axis]}\\b`).test(named[2])) {
        if (maps[axis]) throw new Error(`view(...) maps ${axis} twice.`);
        maps[axis] = parseAxisMap(axis, named[2], env);
        continue;
      }
      if (spec[axis as 'x'] || lattice.some(([a]) => a === axis)) throw new Error(`view(...) sets ${axis} twice.`);
      if (!range) throw new Error(usage);
      const lo = num(range[0], env, `view ${axis} lower bound`);
      const hi = num(range[1], env, `view ${axis} upper bound`);
      if (lo >= hi) throw new Error(`view ${axis} range needs lo < hi (got ${lo}..${hi}).`);
      // Any other letter names an index axis: the view is a lattice.
      if (axis === 'x' || axis === 'y') spec[axis] = [lo, hi];
      else lattice.push([axis, [lo, hi]]);
    }
    if (lattice.length) {
      if (spec.x || spec.y || lattice.length > 2)
        throw new Error(
          'A lattice view names its index axes, across then down: view(i = -60..60, n = 0..80). ' +
            'The plane is framed with x and y.',
        );
      if (lattice.length === 1) {
        // One axis, as a panel sharing the other writes it: taken as across
        // here, and turned down by orientLattice when that is its axis.
        const [[a, range]] = lattice;
        spec.axes = [a, ''];
        spec.x = range;
      } else {
        const [[a, across], [b, down]] = lattice;
        spec.axes = [a, b];
        spec.x = across;
        spec.y = [-down[1], -down[0]];
      }
    }
    if (maps.x || maps.y) {
      if (lattice.length) throw new Error('A lattice view cannot map its axes.');
      spec.maps = maps;
      for (const axis of ['x', 'y'] as const) {
        const map = maps[axis];
        const range = spec[axis];
        if (map && range) spec[axis] = windowToScreen(map, range[0], range[1]);
      }
      // A map alone frames its axis around the screen's origin, when it can.
      if (!spec.x && !spec.y) {
        const map = (maps.x ?? maps.y)!;
        if (!screenWindowOk(map, -5, 5))
          throw new Error(
            `Give ${map.axis} a range that ${map.axis} = ${map.text} can show, like ${map.axis} = 1..10.`,
          );
        spec[map.axis] = [-5, 5];
      }
    }
    if (!spec.x && !spec.y) throw new Error(usage);
    return spec;
  }
  const usage = 'Expected camera(theta, phi, radius?, (x, y, z)?, spin = rate?, locked?) — angles in radians.';
  // spin = … is named and comes last, so the positional arguments keep their meaning.
  const spinArg = args.length && /^\s*spin\s*=([\s\S]*)$/.exec(args[args.length - 1]);
  if (spinArg) args.pop();
  if (args.length < 2 || args.length > 4) throw new Error(usage);
  const spec: Camera3DSpec = {
    kind: 'camera',
    theta: num(args[0], env, 'camera theta'),
    phi: num(args[1], env, 'camera phi'),
  };
  if (locked) spec.locked = true;
  for (const arg of args.slice(2)) {
    let parsed;
    try {
      parsed = parseExpr(arg);
    } catch {
      throw new Error(usage);
    }
    if (parsed.kind === 'vec') {
      if (spec.target) throw new Error('camera(...) sets the target twice.');
      if (parsed.items.length !== 3) throw new Error('The camera target needs 3 components: (x, y, z).');
      spec.target = parsed.items.map(c => numExpr(c, env, 'camera target')) as [number, number, number];
    } else {
      if (spec.radius !== undefined) throw new Error('camera(...) sets the radius twice.');
      const r = num(arg, env, 'camera radius');
      if (r <= 0) throw new Error('The camera radius must be positive.');
      spec.radius = r;
    }
  }
  if (spinArg) {
    if (!spinArg[1].trim()) throw new Error(usage);
    const spin = num(spinArg[1], env, 'camera spin');
    if (spin) spec.spin = spin;
  }
  return spec;
}

/** The app clamps phi short of the poles so "up" never flips; match it. */
export const clampPhi = (phi: number): number => Math.min(Math.PI / 2 - 0.01, Math.max(-Math.PI / 2 + 0.01, phi));

/**
 * Fit the requested box into a w×h viewport: specified axis ratio (default 1), whole box
 * visible, centered. A single-axis spec centers the other axis at 0 with its
 * span implied by the aspect ratio.
 */
export function fitView2D(
  spec: View2DSpec,
  w: number,
  h: number,
): { cx: number; cy: number; upp: number; ratio?: number } {
  const sx = spec.x ? spec.x[1] - spec.x[0] : 0;
  const sy = spec.y ? spec.y[1] - spec.y[0] : 0;
  const upp = Math.max(sx / w, (sy * (spec.ratio ?? 1)) / h);
  return {
    cx: spec.x ? (spec.x[0] + spec.x[1]) / 2 : 0,
    cy: spec.y ? (spec.y[0] + spec.y[1]) / 2 : 0,
    upp,
    ...(spec.ratio !== undefined ? { ratio: spec.ratio } : {}),
  };
}

/**
 * Same 6-significant-digit trim sliders use, so rewritten rows stay tidy,
 * always as plain decimals: the row language has no exponent notation, and
 * reads `-4.44089e-16` as -4.44089·e − 16.
 */
function fmt(v: number, digits = 6): string {
  const n = parseFloat(v.toPrecision(digits));
  const s = String(n);
  if (!s.includes('e')) return s;
  if (Math.abs(n) >= 1) return BigInt(n).toString();
  // toFixed takes at most 100 places; anything smaller is 0 at any scale a view shows.
  const places = digits - 1 - Math.floor(Math.log10(Math.abs(n)));
  return places > 100 ? '0' : n.toFixed(places).replace(/\.?0+$/, '');
}

/** Float dust (from easing, or equal and opposite drags) at `scale`, written as 0. */
const clean = (v: number, scale = 1) => (Math.abs(v) < scale * 1e-9 ? 0 : v);

/**
 * A range's ends at the fewest digits that reproduce it. Six read well, but a
 * window zoomed deep at a large offset (99.99995..100.00005) needs more: at
 * six its ends round to one number, which parseViewRow rejects, and just short
 * of that the round-off shifts the window by its own width. Digits grow until
 * the rounding quantum is under 1% of the span.
 */
function fmtRange(lo: number, hi: number): string {
  const span = hi - lo;
  const scale = Math.max(Math.abs(lo), Math.abs(hi));
  let digits = 6;
  while (digits < 17 && scale * 10 ** (1 - digits) > span / 100) digits++;
  return `${fmt(clean(lo, span), digits)}..${fmt(clean(hi, span), digits)}`;
}

/** Serialize the visible window back into row text (the writeback half). */
export function formatViewRow(x0: number, x1: number, y0: number, y1: number, ratio = 1, locked = false): string {
  return formatViewSpec({ x: [x0, x1], y: [y0, y1], ratio, locked });
}

/**
 * A lattice view's window for a panel whose rows run `axes` = [across,
 * down]. The row names its axes in either order — `view(i = …, j = …)`
 * frames a table's row i and column j alike — so when it names them the
 * other way round, its ranges swap. Anything else is left as it is.
 */
export function orientLattice(spec: View2DSpec, axes: readonly [string, string]): View2DSpec {
  const [a, b] = spec.axes ?? [];
  // One axis named (b empty): the lattice says which way it runs.
  if (b === '' && spec.x && a) {
    if (a === axes[1]) return { ...spec, axes: [axes[0], a], x: undefined, y: [-spec.x[1], -spec.x[0]] };
    return { ...spec, axes: [a, axes[1]] };
  }
  if (!spec.x || !spec.y || a !== axes[1] || b !== axes[0]) return spec;
  return { ...spec, axes: [b, a], x: [-spec.y[1], -spec.y[0]], y: [-spec.x[1], -spec.x[0]] };
}

/** A view row naming only some axes: a panel sharing x with another frames y alone.
 *  A lattice view's axes go in `order` when given (as its row wrote them). */
export function formatViewSpec(spec: Omit<View2DSpec, 'kind'>, order?: readonly [string, string]): string {
  const parts: string[] = [];
  const [across, down] = spec.axes ?? ['x', 'y'];
  // A mapped axis's window is held in screen units and written in its own,
  // each end to six significant digits: on a log axis 0.00001 is a real
  // bound, not float dust beside 100000, and 0 is no bound at all.
  const range = (axis: 'x' | 'y', [lo, hi]: [number, number]): string => {
    const map = spec.maps?.[axis];
    return map ? `${fmt(toWorld(map, lo))}..${fmt(toWorld(map, hi))}` : fmtRange(lo, hi);
  };
  if (spec.x) parts.push(`${across} = ${range('x', spec.x)}`);
  if (spec.y) parts.push(`${down} = ${spec.axes ? fmtRange(-spec.y[1], -spec.y[0]) : range('y', spec.y)}`);
  for (const map of Object.values(spec.maps ?? {})) parts.push(`${map.axis} = ${map.text}`);
  if (spec.axes && parts.length === 2 && order?.[0] === down && order[1] === across) parts.reverse();
  if (spec.ratio !== undefined && spec.ratio !== 1) parts.push(`ratio = ${fmt(spec.ratio)}`);
  if (spec.locked) parts.push('locked');
  return `view(${parts.join(', ')})`;
}

export function formatCameraRow(c: {
  theta: number;
  phi: number;
  radius: number;
  target: [number, number, number];
  spin?: number;
  locked?: boolean;
}): string {
  // A spun or eased camera accumulates turns and float dust: write the angle
  // it shows, in (-pi, pi], and 0 for 0.
  const turn = 2 * Math.PI;
  const theta = clean(c.theta - turn * Math.round(c.theta / turn));
  const parts = [fmt(theta), fmt(clean(c.phi)), fmt(c.radius)];
  const target = c.target.map(v => clean(v, c.radius));
  if (target.some(v => v !== 0)) parts.push(`(${target.map(v => fmt(v)).join(', ')})`);
  const spin = clean(c.spin ?? 0);
  if (spin) parts.push(`spin = ${fmt(spin)}`);
  if (c.locked) parts.push('locked');
  return `camera(${parts.join(', ')})`;
}

/** Scale each axis around a fixed device-pixel offset from the view center. */
export function scaleViewAt(
  view: { cx: number; cy: number; upp: number; ratio?: number },
  px: number,
  py: number,
  factorX: number,
  factorY: number,
): { cx: number; cy: number; upp: number; ratio: number } {
  const oldY = view.upp / (view.ratio ?? 1);
  const clamp = (n: number) => Math.max(1e-12, Math.min(1e12, n));
  const upp = clamp(view.upp * factorX);
  const uppY = clamp(oldY * factorY);
  return {
    cx: view.cx + px * (view.upp - upp),
    cy: view.cy + py * (oldY - uppY),
    upp,
    ratio: upp / uppY,
  };
}

/** A 2D window: center, math units per pixel across, and pixels per y unit
 *  over pixels per x unit (web/render2d.ts View2D). */
export interface Window2D {
  cx: number;
  cy: number;
  upp: number;
  ratio?: number;
}

const uppY = (v: Window2D) => v.upp / (v.ratio ?? 1);

/**
 * A panel's window with its shared axes taken from the panels that own them
 * (`from.x`, `from.y`; see lib/panels.ts linkRoot). Sharing x shares the center and the
 * units per pixel across, and the panel keeps its own ratio, so zooming one
 * zooms the other's y by the same factor; sharing y is the transpose. Sharing
 * both takes the whole window.
 */
export function linkedWindow(
  own: Window2D,
  shared: { x: boolean; y: boolean },
  from: { x?: Window2D; y?: Window2D },
): Window2D {
  const x = shared.x ? from.x : undefined;
  const y = shared.y ? from.y : undefined;
  if (x && y) return { cx: x.cx, cy: y.cy, upp: x.upp, ratio: x.upp / uppY(y) };
  if (x) return { ...own, cx: x.cx, upp: x.upp };
  if (y) return { ...own, cy: y.cy, upp: uppY(y) * (own.ratio ?? 1) };
  return { ...own };
}

/**
 * The window a panel's view row asks for, given the window its shared axes
 * already put it in (`linked`, from linkedWindow). A panel sharing x frames
 * y alone — the row's y range fits the panel exactly, through its ratio —
 * and one sharing y frames x alone. One sharing both has nothing to frame.
 */
export function fitPanelWindow(
  spec: View2DSpec,
  w: number,
  h: number,
  shared: { x: boolean; y: boolean },
  linked: Window2D,
): Window2D {
  if (shared.x && shared.y) return { ...linked };
  if (shared.x) {
    if (!spec.y) return { ...linked };
    return { ...linked, cy: (spec.y[0] + spec.y[1]) / 2, ratio: linked.upp / ((spec.y[1] - spec.y[0]) / h) };
  }
  if (shared.y) {
    if (!spec.x) return { ...linked };
    const upp = (spec.x[1] - spec.x[0]) / w;
    return { ...linked, cx: (spec.x[0] + spec.x[1]) / 2, upp, ratio: upp / uppY(linked) };
  }
  return { ratio: 1, ...fitView2D(spec, w, h) };
}
