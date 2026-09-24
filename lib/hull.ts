/**
 * Convex hulls of evaluated points — the numeric half of `hull(…)`.
 *
 * The vertices are ordinary expressions (they may move with sliders or t), so
 * which of them are extreme is only known once they have values: every
 * renderer evaluates the points, then asks here for the figure to draw. The
 * answer is a list of FACES — one in the plane, the polygon itself; in space
 * the facets of the solid, with coplanar triangles merged so a cube has six
 * square faces rather than twelve triangles with a diagonal each.
 */

type P2 = [number, number];
type P3 = [number, number, number];

/** One flat face: its outline in order (not repeated at the end), and the
 *  triangles that fill it, as indices into the outline. */
export interface HullFace {
  outline: P3[];
  triangles: Array<[number, number, number]>;
}

/** Points a 3D hull accepts: the incremental build is quadratic in the worst case. */
export const HULL_3D_MAX = 2000;

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: P3, b: P3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: P3): number => Math.hypot(a[0], a[1], a[2]);

/** Andrew's monotone chain: the hull counterclockwise, collinear points dropped. */
export function hull2(points: readonly P2[]): P2[] {
  const pts = [...points]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((p, k, all) => k === 0 || p[0] !== all[k - 1][0] || p[1] !== all[k - 1][1]);
  if (pts.length < 3) return pts;
  const turn = (o: P2, a: P2, b: P2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (from: P2[]): P2[] => {
    const out: P2[] = [];
    for (const p of from) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

const fan = (n: number): Array<[number, number, number]> =>
  Array.from({ length: Math.max(0, n - 2) }, (_, k): [number, number, number] => [0, k + 1, k + 2]);

/** The hull of points that all lie in one plane (or on a line, or at a point). */
function flatHull(pts: P3[], origin: P3, normal: P3 | null, along: P3 | null): HullFace[] {
  if (!along) return [{ outline: [origin], triangles: [] }];
  const u: P3 = along.map(c => c / norm(along)) as P3;
  if (!normal) {
    // Collinear: the segment between the extremes.
    const ts = pts.map(p => dot(sub(p, origin), u));
    return [{ outline: [pts[ts.indexOf(Math.min(...ts))], pts[ts.indexOf(Math.max(...ts))]], triangles: [] }];
  }
  const w = cross(normal, u);
  const v: P3 = w.map(c => c / norm(w)) as P3;
  const outline = hull2(pts.map((p): P2 => [dot(sub(p, origin), u), dot(sub(p, origin), v)])).map(([a, b]): P3 => [
    origin[0] + a * u[0] + b * v[0],
    origin[1] + a * u[1] + b * v[1],
    origin[2] + a * u[2] + b * v[2],
  ]);
  return [{ outline, triangles: fan(outline.length) }];
}

/** The convex hull of points in space, as merged flat faces wound outward. */
export function hull3(points: readonly P3[]): HullFace[] {
  const seen = new Set<string>();
  const pts = points.filter(p => !seen.has(p.join()) && seen.add(p.join()));
  if (!pts.length) return [];
  const size = Math.max(...[0, 1, 2].map(k => Math.max(...pts.map(p => p[k])) - Math.min(...pts.map(p => p[k]))));
  const eps = 1e-9 * (size || 1);

  // A first tetrahedron: two distinct points, a third off their line, a
  // fourth off their plane. Short of that the figure is flat.
  const a = pts[0];
  const b = pts.find(p => norm(sub(p, a)) > eps);
  if (!b) return flatHull(pts, a, null, null);
  const ab = sub(b, a);
  const c = pts.find(p => norm(cross(ab, sub(p, a))) > eps * norm(ab));
  if (!c) return flatHull(pts, a, null, ab);
  const n0 = cross(ab, sub(c, a));
  const d = pts.find(p => Math.abs(dot(n0, sub(p, a))) > eps * norm(n0));
  if (!d) return flatHull(pts, a, n0, ab);

  // Triangles as index triples, wound so their normals point away from a
  // point known to be inside.
  const inside: P3 = [0, 1, 2].map(k => (a[k] + b[k] + c[k] + d[k]) / 4) as P3;
  type Tri = [number, number, number];
  const normalOf = (t: Tri): P3 => cross(sub(pts[t[1]], pts[t[0]]), sub(pts[t[2]], pts[t[0]]));
  const outward = (t: Tri): Tri => (dot(normalOf(t), sub(inside, pts[t[0]])) > 0 ? [t[0], t[2], t[1]] : t);
  const [ia, ib, ic, id] = [a, b, c, d].map(p => pts.indexOf(p));
  let faces: Tri[] = (
    [
      [ia, ib, ic],
      [ia, ib, id],
      [ia, ic, id],
      [ib, ic, id],
    ] as Tri[]
  ).map(outward);

  for (let k = 0; k < pts.length; k++) {
    if (k === ia || k === ib || k === ic || k === id) continue;
    const sees = faces.map(t => {
      const n = normalOf(t);
      return dot(n, sub(pts[k], pts[t[0]])) > eps * norm(n);
    });
    if (!sees.some(Boolean)) continue;
    // The horizon: edges of a visible face whose other side stays hidden.
    const hiddenEdges = new Set<string>();
    faces.forEach((t, f) => {
      if (!sees[f]) for (let e = 0; e < 3; e++) hiddenEdges.add(`${t[e]},${t[(e + 1) % 3]}`);
    });
    const next = faces.filter((_, f) => !sees[f]);
    faces.forEach((t, f) => {
      if (!sees[f]) return;
      for (let e = 0; e < 3; e++) {
        const [from, to] = [t[e], t[(e + 1) % 3]];
        if (hiddenEdges.has(`${to},${from}`)) next.push([from, to, k]);
      }
    });
    faces = next;
  }

  // Merge coplanar neighbours: group triangles by plane, walk each group's
  // boundary (edges no other triangle of the group shares) into an outline.
  const unit = (t: Tri): P3 => {
    const n = normalOf(t);
    const len = norm(n);
    return [n[0] / len, n[1] / len, n[2] / len];
  };
  const groups: Array<{ n: P3; tris: Tri[] }> = [];
  for (const t of faces) {
    const n = unit(t);
    const home = groups.find(
      g => dot(g.n, n) > 1 - 1e-9 && Math.abs(dot(g.n, sub(pts[t[0]], pts[g.tris[0][0]]))) <= 1e-7 * (size || 1),
    );
    if (home) home.tris.push(t);
    else groups.push({ n, tris: [t] });
  }
  return groups.map(({ tris }): HullFace => {
    const edges = new Map<number, number>();
    const all = new Set(tris.flatMap(t => [0, 1, 2].map(e => `${t[e]},${t[(e + 1) % 3]}`)));
    for (const t of tris) {
      for (let e = 0; e < 3; e++) {
        const [from, to] = [t[e], t[(e + 1) % 3]];
        if (!all.has(`${to},${from}`)) edges.set(from, to);
      }
    }
    const loop: number[] = [];
    const start = edges.keys().next().value!;
    for (let at = start, guard = 0; guard <= edges.size; guard++) {
      loop.push(at);
      at = edges.get(at)!;
      if (at === start || at === undefined) break;
    }
    // A convex face: drop the vertices that only split a straight edge, then fan.
    const corners = loop.filter((v, i) => {
      const prev = pts[loop[(i + loop.length - 1) % loop.length]];
      const nextP = pts[loop[(i + 1) % loop.length]];
      return norm(cross(sub(pts[v], prev), sub(nextP, pts[v]))) > eps * eps;
    });
    const outline = (corners.length >= 3 ? corners : loop).map(v => pts[v]);
    return { outline, triangles: fan(outline.length) };
  });
}

/** The faces `hull(…)` draws for a flat vertex list of the given dimension. */
export function hullFaces(values: readonly number[], dim: 2 | 3): HullFace[] {
  if (dim === 2) {
    const pts: P2[] = [];
    for (let k = 0; k + 1 < values.length; k += 2) pts.push([values[k], values[k + 1]]);
    const outline = hull2(pts).map(([x, y]): P3 => [x, y, 0]);
    return [{ outline, triangles: fan(outline.length) }];
  }
  const pts: P3[] = [];
  for (let k = 0; k + 2 < values.length; k += 3) pts.push([values[k], values[k + 1], values[k + 2]]);
  return hull3(pts);
}

/**
 * The faces as one flat-shaded mesh: every face gets its own copies of its
 * corners, so each carries that face's normal and the facets stay crisp
 * rather than being smoothed into a ball. UVs are constant — the lit-mesh
 * material paints its checker from them, and a solid has none.
 */
export function hullMesh(faces: readonly HullFace[]): {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
} {
  const positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  for (const { outline, triangles } of faces) {
    if (!triangles.length) continue;
    const n = cross(sub(outline[1], outline[0]), sub(outline[2], outline[0]));
    const len = norm(n) || 1;
    const base = positions.length / 3;
    for (const p of outline) {
      positions.push(...p);
      normals.push(n[0] / len, n[1] / len, n[2] / len);
    }
    for (const tri of triangles) indices.push(...tri.map(i => base + i));
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array((positions.length / 3) * 2),
    indices: new Uint32Array(indices),
  };
}
