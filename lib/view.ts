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

export interface View2DSpec {
  kind: 'view';
  /** Pixels per y unit divided by pixels per x unit; defaults to 1. */
  ratio?: number;
  /** [lo, hi] of the axis, when given. At least one axis is always present. */
  x?: [number, number];
  y?: [number, number];
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
}

export type ViewSpec = View2DSpec | Camera3DSpec;

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
  const m = HEAD_RE.exec(text);
  if (!m) return null;
  const args = splitArgs(m[2]);
  if (m[1] === 'view') {
    const usage = 'Expected view(x = lo..hi, y = lo..hi, ratio = 1) — either axis alone works.';
    const spec: View2DSpec = { kind: 'view' };
    if (!args.length || args.length > 3) throw new Error(usage);
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
      if (axis !== 'x' && axis !== 'y') throw new Error(`view(...) frames the x and y axes, not "${axis}".`);
      if (spec[axis]) throw new Error(`view(...) sets ${axis} twice.`);
      const range = splitRange(named[2]);
      if (!range) throw new Error(usage);
      const lo = num(range[0], env, `view ${axis} lower bound`);
      const hi = num(range[1], env, `view ${axis} upper bound`);
      if (lo >= hi) throw new Error(`view ${axis} range needs lo < hi (got ${lo}..${hi}).`);
      spec[axis] = [lo, hi];
    }
    if (!spec.x && !spec.y) throw new Error(usage);
    return spec;
  }
  const usage = 'Expected camera(theta, phi, radius?, (x, y, z)?, spin = rate?) — angles in radians.';
  // spin = … is named and comes last, so the positional arguments keep their meaning.
  const spinArg = args.length && /^\s*spin\s*=([\s\S]*)$/.exec(args[args.length - 1]);
  if (spinArg) args.pop();
  if (args.length < 2 || args.length > 4) throw new Error(usage);
  const spec: Camera3DSpec = {
    kind: 'camera',
    theta: num(args[0], env, 'camera theta'),
    phi: num(args[1], env, 'camera phi'),
  };
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

/** Same 6-significant-digit trim sliders use, so rewritten rows stay tidy. */
const fmt = (v: number, digits = 6) => String(parseFloat(v.toPrecision(digits)));

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
  return `${fmt(lo, digits)}..${fmt(hi, digits)}`;
}

/** Serialize the visible window back into row text (the writeback half). */
export function formatViewRow(x0: number, x1: number, y0: number, y1: number, ratio = 1): string {
  return `view(x = ${fmtRange(x0, x1)}, y = ${fmtRange(y0, y1)}${ratio === 1 ? '' : `, ratio = ${fmt(ratio)}`})`;
}

export function formatCameraRow(c: {
  theta: number;
  phi: number;
  radius: number;
  target: [number, number, number];
  spin?: number;
}): string {
  // A spun or eased camera accumulates turns and float dust: write the angle
  // it shows, in (-pi, pi], and 0 for 0.
  const turn = 2 * Math.PI;
  const wrapped = c.theta - turn * Math.round(c.theta / turn);
  const theta = Math.abs(wrapped) < 1e-9 ? 0 : wrapped;
  const parts = [fmt(theta), fmt(c.phi), fmt(c.radius)];
  if (c.target.some(v => Math.abs(v) > 1e-9)) {
    parts.push(`(${c.target.map(v => fmt(v)).join(', ')})`);
  }
  if (c.spin) parts.push(`spin = ${fmt(c.spin)}`);
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
