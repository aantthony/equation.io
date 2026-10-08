/**
 * Finding what the pointer is over on a surface map (lib/surface-map.ts):
 * the ray from the eye through a pixel, met with the surface (x, y) ↦ P.
 * The surface is first cut into a coarse mesh, which the ray meets at a
 * triangle; Newton on P(x, y) = o + t d from there finds the surface
 * itself, as exact as the mesh is not.
 */
import { type SurfaceMap, surfacePoint } from './surface-map.ts';

type Vec3 = [number, number, number];

export interface SurfaceHit {
  /** Where on the surface, in the x and y its rows are written in. */
  x: number;
  y: number;
  /** How far along the ray, in lengths of its direction. */
  t: number;
  /** The point in space. */
  point: Vec3;
}

/** Cells along each side of the mesh a ray is first met with. */
const MESH_N = 96;

interface Mesh {
  /** The surface at the grid's (MESH_N + 1)² nodes, X, Y, Z each. */
  pos: Float64Array;
}

const meshes = new WeakMap<SurfaceMap, Mesh>();

function meshOf(map: SurfaceMap): Mesh {
  let mesh = meshes.get(map);
  if (!mesh) {
    const n = MESH_N + 1;
    const pos = new Float64Array(n * n * 3);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const p = surfacePoint(map, gridX(map, i), gridY(map, j));
        pos.set(p, (j * n + i) * 3);
      }
    mesh = { pos };
    meshes.set(map, mesh);
  }
  return mesh;
}

const gridX = (map: SurfaceMap, i: number) => map.x[0] + ((map.x[1] - map.x[0]) * i) / MESH_N;
const gridY = (map: SurfaceMap, j: number) => map.y[0] + ((map.y[1] - map.y[0]) * j) / MESH_N;

/**
 * Where the ray o + t d (t > 0) first meets the surface, or null where it
 * misses. The nearest few triangles it crosses are each refined onto the
 * surface, and the nearest of those wins: a coarse triangle can stand a
 * little in front of the true surface behind another's hit.
 */
export function raySurface(map: SurfaceMap, o: readonly number[], d: readonly number[]): SurfaceHit | null {
  const { pos } = meshOf(map);
  const n = MESH_N + 1;
  const hits: Array<{ t: number; x: number; y: number }> = [];
  const corner = (i: number, j: number) => (j * n + i) * 3;
  for (let j = 0; j < MESH_N; j++)
    for (let i = 0; i < MESH_N; i++) {
      const a = corner(i, j);
      const b = corner(i + 1, j);
      const c = corner(i, j + 1);
      const e = corner(i + 1, j + 1);
      // Two triangles a b c and e c b; (s, r) their barycentric coordinates
      // along the cell's x and y.
      let h = triangle(pos, a, b, c, o, d);
      if (h) hits.push({ t: h[0], x: gridX(map, i + h[1]), y: gridY(map, j + h[2]) });
      h = triangle(pos, e, c, b, o, d);
      if (h) hits.push({ t: h[0], x: gridX(map, i + 1 - h[2]), y: gridY(map, j + 1 - h[1]) });
    }
  if (!hits.length) return null;
  hits.sort((p, q) => p.t - q.t);
  let best: SurfaceHit | null = null;
  for (const h of hits.slice(0, 4)) {
    const r = refine(map, o, d, h.x, h.y, h.t) ?? { ...h, point: surfacePoint(map, h.x, h.y) };
    if (r.t > 0 && (!best || r.t < best.t)) best = r;
  }
  return best;
}

/** Slack at a triangle's edges, so a ray along a seam or through a corner
 *  is not lost between the triangles either side. */
const EDGE = 1e-9;

/** Möller–Trumbore: [t, along a→b, along a→c] where the ray crosses the
 *  triangle a b c, or null. */
function triangle(
  pos: Float64Array,
  a: number,
  b: number,
  c: number,
  o: readonly number[],
  d: readonly number[],
): [number, number, number] | null {
  const e1x = pos[b] - pos[a],
    e1y = pos[b + 1] - pos[a + 1],
    e1z = pos[b + 2] - pos[a + 2];
  const e2x = pos[c] - pos[a],
    e2y = pos[c + 1] - pos[a + 1],
    e2z = pos[c + 2] - pos[a + 2];
  const px = d[1] * e2z - d[2] * e2y,
    py = d[2] * e2x - d[0] * e2z,
    pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  // Edge-on, or a corner where the surface is undefined (NaN fails it too).
  if (!(Math.abs(det) > 1e-300)) return null;
  const sx = o[0] - pos[a],
    sy = o[1] - pos[a + 1],
    sz = o[2] - pos[a + 2];
  const u = (sx * px + sy * py + sz * pz) / det;
  if (u < -EDGE || u > 1 + EDGE) return null;
  const qx = sy * e1z - sz * e1y,
    qy = sz * e1x - sx * e1z,
    qz = sx * e1y - sy * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
  if (v < -EDGE || u + v > 1 + EDGE) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) / det;
  return t > 0 ? [t, u, v] : null;
}

/**
 * Newton on P(x, y) − o − t d = 0 from a mesh hit: three equations in x, y
 * and t. Null when it does not settle, or leaves the ranges the surface is
 * drawn over (where the mesh's hit is the better answer).
 */
function refine(
  map: SurfaceMap,
  o: readonly number[],
  d: readonly number[],
  x: number,
  y: number,
  t: number,
): SurfaceHit | null {
  const spanX = map.x[1] - map.x[0];
  const spanY = map.y[1] - map.y[0];
  const hx = 1e-6 * spanX;
  const hy = 1e-6 * spanY;
  for (let k = 0; k < 20; k++) {
    const p = surfacePoint(map, x, y);
    const px = surfacePoint(map, x + hx, y);
    const mx = surfacePoint(map, x - hx, y);
    const py = surfacePoint(map, x, y + hy);
    const my = surfacePoint(map, x, y - hy);
    const fx = [0, 1, 2].map(i => (px[i] - mx[i]) / (2 * hx));
    const fy = [0, 1, 2].map(i => (py[i] - my[i]) / (2 * hy));
    const g = [0, 1, 2].map(i => p[i] - o[i] - t * d[i]);
    // Solve [fx fy −d] (δx, δy, δt) = −g by Cramer's rule.
    const nd = [-d[0], -d[1], -d[2]];
    const det = det3(fx, fy, nd);
    if (!isFinite(det) || Math.abs(det) < 1e-14 * norm(fx) * norm(fy) * norm(d)) return null;
    const r = g.map(v => -v);
    const dx = det3(r, fy, nd) / det;
    const dy = det3(fx, r, nd) / det;
    const dt = det3(fx, fy, r) / det;
    x += dx;
    y += dy;
    t += dt;
    if (!isFinite(x) || !isFinite(y) || !isFinite(t)) return null;
    if (x < map.x[0] - 1e-9 * spanX || x > map.x[1] + 1e-9 * spanX) return null;
    if (y < map.y[0] - 1e-9 * spanY || y > map.y[1] + 1e-9 * spanY) return null;
    if (Math.abs(dx) < 1e-12 * spanX && Math.abs(dy) < 1e-12 * spanY) {
      x = Math.min(Math.max(x, map.x[0]), map.x[1]);
      y = Math.min(Math.max(y, map.y[0]), map.y[1]);
      return { x, y, t, point: surfacePoint(map, x, y) };
    }
  }
  return null;
}

const det3 = (a: readonly number[], b: readonly number[], c: readonly number[]) =>
  a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
const norm = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);

/**
 * How much x and y change across a pixel at (x, y) on the surface, given
 * where a point in space lands on the screen (in pixels): each read from
 * how far the screen moves as it steps. For readouts to the pixel, and
 * for tracing a curve there in pixel units.
 */
export function surfacePixel(
  map: SurfaceMap,
  x: number,
  y: number,
  toScreen: (p: Vec3) => readonly [number, number] | null,
): [number, number] {
  const hx = 1e-5 * (map.x[1] - map.x[0]);
  const hy = 1e-5 * (map.y[1] - map.y[0]);
  const at = toScreen(surfacePoint(map, x, y));
  const ax = toScreen(surfacePoint(map, x + hx, y));
  const ay = toScreen(surfacePoint(map, x, y + hy));
  const per = (h: number, q: readonly [number, number] | null) => {
    const moved = at && q ? Math.hypot(q[0] - at[0], q[1] - at[1]) : NaN;
    return moved > 0 ? h / moved : NaN;
  };
  return [per(hx, ax), per(hy, ay)];
}
