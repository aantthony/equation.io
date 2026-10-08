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
 * point by point (surfacePoint), a parametric region as a whole mesh
 * (surfaceOver), and a vector field as arrows along the surface's tangents
 * (surfaceArrows). See docs/axis-maps.md.
 */
import { diff } from './diff.ts';
import { type Expr, evaluate, freeVars, parseExpr, substVars } from './expr.ts';
import { type MapDoc, expandMapSums } from './defs.ts';
import { toGLSL } from './glsl.ts';
import { FLOW_NODE_LIMIT } from './flow.ts';
import type { Classified, MathObject } from './math-object.ts';
import { exceedsNodes } from './size.ts';
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
const CONSTANTS = new Set(['pi', 'e']);

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
  const shared = { ...doc, budget: doc.budget ?? { terms: 0 } };
  const items = parsed.items.map(e => expandMapSums(e, ['x', 'y'], env, shared));
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

const SLOTS: ReadonlyMap<string, number> = new Map([
  ['x', 0],
  ['y', 1],
]);

/** Expressions in x and y as one function of x and y. */
function compileXY(exprs: readonly Expr[]): (x: number, y: number) => number[] {
  const vars = new Float64Array(2);
  const progs = exprs.map(e => {
    try {
      return compileProg(e, SLOTS);
    } catch {
      return null; // evaluated
    }
  });
  const stack = new Float64Array(Math.max(1, ...progs.map(p => p?.depth ?? 0)));
  const fns = exprs.map((e, k) => {
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
  return (x, y) => {
    vars[0] = x;
    vars[1] = y;
    return fns.map(f => f());
  };
}

const compiled = new WeakMap<SurfaceMap, (x: number, y: number) => number[]>();

/** The point in space the surface puts at (x, y). */
export function surfacePoint(map: SurfaceMap, x: number, y: number): [number, number, number] {
  let f = compiled.get(map);
  if (!f) compiled.set(map, (f = compileXY(map.embed)));
  return f(x, y) as [number, number, number];
}

type Vec3 = [number, number, number];
const tangents = new WeakMap<SurfaceMap, (x: number, y: number) => number[]>();

/** The surface's tangents at (x, y): how its point moves with x, and with
 *  y. Exact where the surface differentiates, central differences where
 *  not. */
export function surfaceTangents(map: SurfaceMap, x: number, y: number): [Vec3, Vec3] {
  let f = tangents.get(map);
  if (!f) {
    try {
      f = compileXY([...map.embed.map(e => diff(e, 'x')), ...map.embed.map(e => diff(e, 'y'))]);
    } catch {
      f = (x, y) => {
        const h = 1e-5 * Math.max(1, Math.abs(x), Math.abs(y));
        const d = (a: number[], b: number[]) => a.map((v, k) => (v - b[k]) / (2 * h));
        return [
          ...d(surfacePoint(map, x + h, y), surfacePoint(map, x - h, y)),
          ...d(surfacePoint(map, x, y + h), surfacePoint(map, x, y - h)),
        ];
      };
    }
    tangents.set(map, f);
  }
  const t = f(x, y);
  return [t.slice(0, 3) as Vec3, t.slice(3) as Vec3];
}

/** Arrows along the longer side of the lattice a vector field is drawn at
 *  on a surface. */
export const SURFACE_ARROWS = 24;

/**
 * A vector field in x and y as arrows on the surface. At (x, y) the field
 * (u, v) is the tangent u ∂P/∂x + v ∂P/∂y of the surface P there; each
 * arrow is that tangent from P(x, y), at the centres of a lattice whose
 * cells are near square on the surface. An arrow is the image of a 2D arrow
 * filling most of its cell in x and y, so it shows the field's direction
 * (as a 3D panel's arrows do) and shrinks where the surface crowds the
 * cells, toward a sphere's poles. Tail and head of each, then a NaN point
 * to part them.
 */
export function surfaceArrows(
  map: SurfaceMap,
  field: (x: number, y: number) => readonly number[],
  n = SURFACE_ARROWS,
): number[] {
  const [x0, x1] = map.x;
  const [y0, y1] = map.y;
  // How far the surface runs along x and along y, on average.
  let along = 0;
  let across = 0;
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) {
      const [px, py] = surfaceTangents(map, x0 + ((x1 - x0) * (i + 0.5)) / 8, y0 + ((y1 - y0) * (j + 0.5)) / 8);
      const a = Math.hypot(...px) * (x1 - x0);
      const b = Math.hypot(...py) * (y1 - y0);
      if (Number.isFinite(a) && Number.isFinite(b)) [along, across] = [along + a, across + b];
    }
  const long = Math.max(along, across);
  if (!(long > 0)) return [];
  const nx = Math.max(2, Math.round((n * along) / long));
  const ny = Math.max(2, Math.round((n * across) / long));
  const dx = (x1 - x0) / nx;
  const dy = (y1 - y0) / ny;
  const out: number[] = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const x = x0 + (i + 0.5) * dx;
      const y = y0 + (j + 0.5) * dy;
      const [u, v] = field(x, y);
      // 0.7 of the cell, measured in cells in the direction it points.
      const s = 0.7 / Math.hypot(u / dx, v / dy);
      if (!Number.isFinite(s)) continue;
      const p = surfacePoint(map, x, y);
      const [px, py] = surfaceTangents(map, x, y);
      const head = p.map((c, k) => c + s * (u * px[k] + v * py[k]));
      if (p.every(Number.isFinite) && head.every(Number.isFinite)) out.push(...p, ...head, NaN, NaN, NaN);
    }
  return out;
}

/** A parametric region's (x, y) carried onto the surface, in the region's
 *  own u and v: a mesh that lies on the surface wherever the region does. */
export function surfaceOver(map: SurfaceMap, coordinates: readonly [Expr, Expr]): [Expr, Expr, Expr] {
  const at = { x: coordinates[0], y: coordinates[1] };
  return map.embed.map(e => substVars(e, at)) as [Expr, Expr, Expr];
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
 *   figures, point lists, labels), each carried onto the surface; a
 *   parametric region's mesh is carried whole (surfaceOver), and a vector
 *   field's arrows by the surface's tangents (surfaceArrows);
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
      return object.form === 'projected' ? null : object.form === 'parametric' ? 'carry' : 'paint';
    case 'scalar-field':
      return object.dimension === 3 ? null : 'paint';
    case 'vector-field':
      return object.components.length === 2 ? 'carry' : null;
    case 'point':
    case 'trail':
    case 'label':
      return 'carry';
    case 'geodesic':
      // geodesic(P, d): traced in x and y, on this surface.
      return object.dim === 2 ? 'carry' : null;
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

/**
 * A 2D row as a surface panel draws it. A 2D vector field is marked
 * animated for its moving streaks (lib/plot.ts); on a surface it is still
 * arrows, which move only with t. Its arrows are traced on the CPU, so a
 * field too large to trace is refused here rather than left undrawn.
 */
export function onSurface(cls: Classified): Classified {
  const { object } = cls;
  if (object.kind === 'family') {
    const members = object.members.map(onSurface);
    if (members.every((m, k) => m === object.members[k])) return cls;
    return { ...cls, object: { ...object, members }, animated: members.some(m => m.animated) };
  }
  if (object.kind !== 'vector-field' || object.components.length !== 2) return cls;
  if (object.components.some(c => exceedsNodes(c, FLOW_NODE_LIMIT)))
    throw new Error(`This field is too large to draw on a surface (${FLOW_NODE_LIMIT} nodes per component).`);
  const animated = object.components.some(c => freeVars(c).has('t'));
  return animated === cls.animated ? cls : { ...cls, animated };
}

export const OFF_SURFACE_MESSAGE =
  'This panel draws its rows on a surface (its on(…) row), which takes curves, inequalities, scalar fields, vector fields, points, parametric curves and regions, and figures in x and y — not this.';
