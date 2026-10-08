/**
 * Surface maps: a panel whose 2D rows are printed onto a surface in space,
 * `on((X, Y, Z) = (cos(y) cos(x), cos(y) sin(x), sin(y)), x = -pi..pi,
 * y = -pi/2..pi/2)` — the sphere, with x as longitude and y as latitude.
 *
 * The panel is 3D. X, Y and Z are the scene's coordinates; x and y are the
 * coordinates the panel's rows are written in, which the surface carries
 * into space over the ranges given. What is drawn per pixel in 2D (curves,
 * regions, fields) is painted on the surface per pixel the same way: its
 * shader reads x and y at each fragment (web/render3d.ts paintFrag). What
 * places things (points, parametric curves, figures, labels) is carried
 * point by point (surfacePoint). See docs/axis-maps.md.
 */
import { type Expr, evaluate, freeVars, parseExpr, substVars } from './expr.ts';
import { type MapDoc, expandMapSums } from './defs.ts';
import { toGLSL } from './glsl.ts';
import type { MathObject } from './math-object.ts';
import { type Prog, compileProg, run } from './vm.ts';

export interface SurfaceMap {
  /** The right side as the row wrote it, for writing the row back. */
  text: string;
  /** X, Y and Z in terms of x and y. */
  embed: readonly [Expr, Expr, Expr];
  /** The ranges of x and y the surface is drawn over. */
  x: readonly [number, number];
  y: readonly [number, number];
}

export interface SurfaceSpec {
  kind: 'surface';
  surface: SurfaceMap;
}

const USAGE =
  'Expected on((X, Y, Z) = (cos(y) cos(x), cos(y) sin(x), sin(y)), x = lo..hi, y = lo..hi): the surface the panel’s rows are drawn on.';
const CONSTANTS = new Set(['pi', 'e', 'tau']);

/**
 * Parse the right side of `(X, Y, Z) = (…)` in an on(…) row, with the
 * ranges of x and y. Sliders are read at their value, as a view map reads
 * them, so moving one reanalyses.
 */
export function parseSurfaceMap(
  src: string,
  x: [number, number],
  y: [number, number],
  env: Record<string, number> = {},
  doc: MapDoc = {},
): SurfaceMap {
  let parsed: Expr;
  try {
    parsed = parseExpr(src);
  } catch {
    throw new Error(USAGE);
  }
  if (parsed.kind !== 'vec' || parsed.items.length !== 3) throw new Error(USAGE);
  const items = parsed.items.map(e => expandMapSums(e, ['x', 'y'], env, doc));
  const values: Record<string, Expr> = {};
  let uses = false;
  for (const name of freeVars({ kind: 'vec', items })) {
    if (name === 'x' || name === 'y') uses = true;
    else if (!CONSTANTS.has(name)) {
      const v = env[name];
      if (typeof v !== 'number' || !isFinite(v))
        throw new Error(
          `The surface is written in x, y, numbers and sliders; ${name} has no fixed value here ` +
            `(not defined, or it changes with t).`,
        );
      values[name] = { kind: 'num', value: v };
    }
  }
  if (!uses) throw new Error(USAGE);
  const embed = items.map(e => substVars(e, values)) as [Expr, Expr, Expr];
  const map: SurfaceMap = { text: src.trim(), embed, x, y };
  // The surface and what is painted on it are drawn on the GPU.
  for (const e of embed)
    try {
      toGLSL(e);
    } catch (err) {
      throw new Error(`The surface cannot be drawn: ${(err as Error).message}`);
    }
  if (!spreads(map))
    throw new Error(`(X, Y, Z) = ${map.text} is no surface over these x and y: it is a curve or a point.`);
  return map;
}

/** Whether some of the surface spreads over an area: its tangents along x
 *  and y are apart somewhere. */
function spreads(map: SurfaceMap): boolean {
  const h = 1e-4;
  for (let i = 1; i < 8; i++)
    for (let j = 1; j < 8; j++) {
      const x = map.x[0] + ((map.x[1] - map.x[0]) * i) / 8;
      const y = map.y[0] + ((map.y[1] - map.y[0]) * j) / 8;
      const p = surfacePoint(map, x, y);
      const px = surfacePoint(map, x + h, y);
      const py = surfacePoint(map, x, y + h);
      const a = px.map((v, k) => v - p[k]);
      const b = py.map((v, k) => v - p[k]);
      const n = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
      // Apart relative to their lengths, so a small surface counts.
      if (n > 1e-9 * Math.hypot(...a) * Math.hypot(...b)) return true;
    }
  return false;
}

const compiled = new WeakMap<SurfaceMap, (x: number, y: number) => [number, number, number]>();
const SLOTS: ReadonlyMap<string, number> = new Map([
  ['x', 0],
  ['y', 1],
]);

/** The point in space the surface puts at (x, y). */
export function surfacePoint(map: SurfaceMap, x: number, y: number): [number, number, number] {
  let f = compiled.get(map);
  if (!f) {
    const vars = new Float64Array(2);
    const progs = map.embed.map(e => {
      try {
        return compileProg(e, SLOTS);
      } catch {
        return null; // evaluated
      }
    });
    const stack = new Float64Array(Math.max(1, ...progs.map(p => p?.depth ?? 0)));
    const fns = map.embed.map((e, k) => {
      const prog: Prog | null = progs[k];
      return prog
        ? () => {
            try {
              return run(prog, vars, stack);
            } catch {
              return NaN;
            }
          }
        : () => {
            try {
              return evaluate(e, { x: vars[0], y: vars[1] });
            } catch {
              return NaN;
            }
          };
    });
    f = (x, y) => {
      vars[0] = x;
      vars[1] = y;
      return [fns[0](), fns[1](), fns[2]()];
    };
    compiled.set(map, f);
  }
  return f(x, y);
}

/**
 * The surface over the unit square, as a parametric surface's mesh is laid
 * out (u, v in 0..1): x and y swept over their ranges. `uv` gives the same
 * x and y, for a shader that paints rows written in them.
 */
export function surfaceInUV(map: SurfaceMap): {
  comps: [Expr, Expr, Expr];
  uv: { x: Expr; y: Expr };
} {
  const sweep = ([lo, hi]: readonly [number, number], p: string): Expr => ({
    kind: 'bin',
    op: '+',
    a: { kind: 'num', value: lo },
    b: { kind: 'bin', op: '*', a: { kind: 'num', value: hi - lo }, b: { kind: 'var', name: p } },
  });
  const uv = { x: sweep(map.x, 'u'), y: sweep(map.y, 'v') };
  const comps = map.embed.map(e => substVars(e, uv)) as [Expr, Expr, Expr];
  return { comps, uv };
}

/**
 * How a surface panel draws a 2D row, or null when it cannot:
 *
 * - `paint`: drawn per pixel from x and y in 2D (curves, regions, fields),
 *   so painted on the surface per pixel (web/render3d.ts paintFrag);
 * - `carry`: it puts things at positions (points, parametric curves,
 *   figures, point lists, labels), each carried onto the surface;
 * - `none`: nothing drawn (a value, a note).
 *
 * A row in space (3D) draws as in any 3D panel, and is not asked.
 */
export type SurfaceMapping = 'paint' | 'carry' | 'none';

export function surfaceMapping(object: MathObject): SurfaceMapping | null {
  switch (object.kind) {
    case 'value':
    case 'note':
    case 'tuple':
      return 'none';
    case 'curve':
      return object.form === 'parametric' ? 'carry' : 'paint';
    case 'region':
      return object.form === 'parametric' || object.form === 'projected' ? null : 'paint';
    case 'scalar-field':
      return object.dimension === 3 ? null : 'paint';
    case 'point':
    case 'trail':
    case 'label':
      return 'carry';
    case 'family': {
      // A family draws as its members, each drawn as it is.
      const each = object.members.map(m => surfaceMapping(m.object));
      return each.every(Boolean) ? (each[0] ?? 'none') : null;
    }
    case 'figure':
      return object.dimension === 2 ? 'carry' : null;
    case 'list':
      return object.element === 'point' && object.dimension === 2 ? 'carry' : null;
  }
  return null;
}

export const OFF_SURFACE_MESSAGE =
  'This panel draws its rows on a surface (its on(…) row), which takes curves, inequalities, scalar fields, points, parametric curves and figures in x and y — not this.';
