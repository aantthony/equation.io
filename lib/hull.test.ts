import { describe, expect, it } from 'vitest';
import { analyze } from '../worker/graph.ts';
import { evaluate } from './expr.ts';
import { canRenderOg, renderRaster } from '../worker/og.ts';
import { hull2, hull3, hullFaces, hullMesh } from './hull.ts';

type P3 = [number, number, number];
const cube: P3[] = [];
for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) cube.push([x, y, z]);

/** Volume from the outward-wound faces (divergence theorem): wrong winding or
 *  a missing face shows up here before it shows up on screen. */
const volume = (faces: ReturnType<typeof hull3>): number => faces.reduce((sum, f) =>
  sum + f.triangles.reduce((s, [a, b, c]) => {
    const [p, q, r] = [f.outline[a], f.outline[b], f.outline[c]];
    return s + (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
  }, 0), 0);

describe('hull2', () => {
  it('keeps the extreme points, counterclockwise, dropping interior, collinear and repeated ones', () => {
    expect(hull2([[0, 0], [2, 0], [1, 0], [2, 2], [0, 2], [1, 1], [0, 0]])).toEqual([[0, 0], [2, 0], [2, 2], [0, 2]]);
    expect(hull2([[0, 0], [1, 1]])).toHaveLength(2);
    expect(hull2([[0, 0], [1, 1], [2, 2]])).toHaveLength(2);
  });
});

describe('hull3', () => {
  it('merges coplanar triangles: a cube has six square faces', () => {
    const faces = hull3([...cube, [.5, .5, .5], [1, .5, .5], [0, 0, 0]]);
    expect(faces.map(f => f.outline.length).sort()).toEqual([4, 4, 4, 4, 4, 4]);
    expect(volume(faces)).toBeCloseTo(1, 12);
  });
  it('builds an icosahedron: 20 triangles, the right volume', () => {
    const phi = (1 + Math.sqrt(5)) / 2;
    const pts: P3[] = [];
    for (const a of [-1, 1]) for (const b of [-phi, phi]) pts.push([0, a, b], [a, b, 0], [b, 0, a]);
    const faces = hull3(pts);
    expect(faces).toHaveLength(20);
    expect(faces.every(f => f.outline.length === 3)).toBe(true);
    expect(volume(faces)).toBeCloseTo(5 * (3 + Math.sqrt(5)) / 12 * 8, 9);
  });
  it('is the same solid whatever order the points arrive in', () => {
    const pts: P3[] = Array.from({ length: 200 }, (_, k): P3 => [Math.sin(k * 12.9898) * 3, Math.sin(k * 78.233) * 2, Math.sin(k * 37.719)]);
    const v = volume(hull3(pts));
    expect(v).toBeGreaterThan(0);
    expect(volume(hull3([...pts].reverse()))).toBeCloseTo(v, 9);
  });
  it('degrades to a flat polygon, a segment, or a point', () => {
    const square = hull3([[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1], [.5, .5, 1]]);
    expect(square).toHaveLength(1);
    expect(square[0].outline).toHaveLength(4);
    expect(hull3([[0, 0, 0], [1, 1, 1], [2, 2, 2]])[0].outline).toEqual([[0, 0, 0], [2, 2, 2]]);
    expect(hull3([[1, 2, 3], [1, 2, 3]])[0].outline).toEqual([[1, 2, 3]]);
    expect(hullFaces([0, 0, 4, 0, 4, 4, 2, 1], 2)[0].outline).toEqual([[0, 0, 0], [4, 0, 0], [4, 4, 0]]);
  });
});

describe('shading', () => {
  it('meshes a solid flat-shaded: each face owns its corners and one unit normal', () => {
    const mesh = hullMesh(hull3(cube));
    expect(mesh.positions.length / 3).toBe(24); // 6 faces × 4 corners, none shared
    expect(mesh.indices.length).toBe(36);
    expect(mesh.uvs.length).toBe(48);
    const normals = new Set<string>();
    for (let k = 0; k < mesh.normals.length; k += 3) {
      const n = [...mesh.normals.slice(k, k + 3)];
      expect(Math.hypot(...n)).toBeCloseTo(1, 6);
      normals.add(n.map(c => Math.round(c) + 0).join());
    }
    expect([...normals].sort()).toEqual(['-1,0,0', '0,-1,0', '0,0,-1', '0,0,1', '0,1,0', '1,0,0']);
    expect(hullMesh(hull3([[0, 0, 0], [1, 1, 1]])).indices).toHaveLength(0);
  });
  it('lights the static preview: faces are filled in shades of the row colour, darker than its edges', () => {
    const rows = ['hull(([-2,2],[-2,2],[-2,2]))'];
    expect(canRenderOg(rows)).toBe(true);
    const { px } = renderRaster(rows, 160, 120); // RGB
    const areas = new Map<string, number>();
    for (let k = 0; k < px.length; k += 3) {
      if (px[k] === px[k + 1] && px[k + 1] === px[k + 2]) continue; // paper and grid
      const key = `${px[k]},${px[k + 1]},${px[k + 2]}`;
      areas.set(key, (areas.get(key) ?? 0) + 1);
    }
    const big = [...areas].filter(([, n]) => n > 100).map(([key]) => key.split(',').map(Number));
    // The edge colour, and at least two differently lit faces (the top, and
    // the sides — which may share a shade when both face away from the light).
    expect(big.length).toBeGreaterThanOrEqual(3);
    const brightness = big.map(c => c[0] + c[1] + c[2]).sort((a, b) => b - a);
    expect(new Set(brightness).size).toBe(brightness.length);
  });
});

describe('hull(…) rows', () => {
  const plot = (rows: string[]) => {
    const a = analyze(rows);
    expect(a.rows.map(r => r.error)).toEqual(rows.map(() => undefined));
    return { cpu: a.rows.at(-1)!.cpu!, env: a.constEnv, needs3D: a.rows.at(-1)!.cls!.needs3D };
  };
  it('takes points one by one, or a whole list — literal, crossed, or rotated', () => {
    expect(plot(['hull((0,0),(2,0),(1,1),(2,2),(0,2))']).cpu).toMatchObject({ type: 'polygon', hull: true, closed: true });
    const cubeRow = plot(['hull(([0,1],[0,1],[0,1]))']);
    expect(cubeRow.cpu).toMatchObject({ type: 'polygon', hull: true, dim: 3 });
    expect(cubeRow.needs3D).toBe(true);
    const ico = plot(['phi=(1+sqrt(5))/2', 'k=2pi [0..2]/3', 'hull(rotate((0,[-1,1],[-phi,phi]),k,(1,1,1)))']);
    if (ico.cpu.type !== 'polygon') throw new Error(ico.cpu.type);
    expect(hullFaces(ico.cpu.pts.map(e => evaluate(e, ico.env)), 3)).toHaveLength(20);
    expect(plot(['P=[(0,0),(3,0),(1,1),(0,3)]', 'hull(P)']).cpu).toMatchObject({ hull: true });
    // Vertices may move: which are extreme is settled per frame.
    expect(plot(['hull((0,0),(2,0),(1,sin(t)),(1,2))']).cpu).toMatchObject({ hull: true });
  });
  it('transforms as a whole: the figure of the transformed points', () => {
    const P = 'P=[(0,0),(2,0),(1,1),(1,0.2)]';
    const verts = (rows: string[]) => {
      const { cpu: p, env } = plot(rows);
      if (p.type !== 'polygon') throw new Error(p.type);
      return hullFaces(p.pts.map(e => evaluate(e, { ...env, t: 0 })), p.dim ?? 2)[0].outline.map(q => q.slice(0, p.dim ?? 2).map(c => +c.toFixed(6) + 0).join());
    };
    const quarter = ['0,0', '0,2', '-1,1'];
    expect(verts(['J=[(0,-1),(1,0)]', 'R=e^((pi/2) J)', P, 'R hull(P)']).sort()).toEqual([...quarter].sort());
    expect(verts(['J=[(0,-1),(1,0)]', 'R=e^((pi/2) J)', P, 'hull(R P)']).sort()).toEqual([...quarter].sort());
    expect(verts([P, 'rotate(hull(P), pi/2)']).sort()).toEqual([...quarter].sort());
    expect(verts([P, '2 hull(P) + (1,1)']).sort()).toEqual(['1,1', '3,3', '5,1']);
    expect(verts([P, '-hull(P)/2']).sort()).toEqual(['-0.5,-0.5', '-1,0', '0,0']);
    // Other point figures move the same way, point by point.
    expect(plot(['2 segment((0,0),(1,1)) + (1,0)']).cpu).toMatchObject({ type: 'polygon', closed: false });
    expect(plot(['rotate(polygon((1,0),(2,0),(2,1)), t, (1,1))']).cpu).toMatchObject({ type: 'polygon', closed: true });
    expect(plot(['rotate(hull(([0,1],[0,1],[0,1])), t, (1,1,1)) + (2,0,0)']).cpu).toMatchObject({ hull: true, dim: 3 });
  });
  it('a list in the transform is one figure per element, not one figure of every copy', () => {
    const members = (rows: string[]) => {
      const p = plot(rows).cpu;
      return p.type === 'family' ? p.members.map(m => m.cpu.type) : [p.type];
    };
    const P = 'P=[(1,0),(2,0),(2,1)]';
    expect(members(['J=[(0,-1),(1,0)]', 'th=2pi [0..2]/3', P, 'e^(th J) hull(P)'])).toEqual(['polygon', 'polygon', 'polygon']);
    expect(members(['th=2pi [0..4]/5', P, 'rotate(hull(P), th)'])).toHaveLength(5);
    expect(members([P, 'hull(P) + ([0,3],0)'])).toHaveLength(2);
    expect(members(['th=2pi [0..2]/3', 'rotate(polygon((1,0),(2,0),(2,1)), th)'])).toHaveLength(3);
    // A constant axis written as arithmetic is its numbers, so each tumbling
    // cube stays small enough to draw hundreds of.
    expect(members(['e^(t cross((1, 1, 1)/sqrt(3))) hull(([-1,1], [-1,1], [-1,1])) + (0, 0, 3[1..200])'])).toHaveLength(200);
    // A slider-dependent axis stays symbolic, and large, but a few dozen draw;
    // past the family's budget in all, it says so.
    const turning = (n: number) => ['a = 1', `e^(t cross((1, 1, a)/sqrt(2+a^2))) hull(([-1,1], [-1,1], [-1,1])) + (0, 0, 3[1..${n}])`];
    expect(members(turning(30))).toHaveLength(30);
    expect(analyze(turning(200)).rows[1].error).toMatch(/too large to render .* in all/);
    // …while a list INSIDE the figure is its points.
    expect(members(['J=[(0,-1),(1,0)]', 'th=2pi [0..2]/3', P, 'hull(e^(th J) P)'])).toEqual(['polygon']);
  });
  it('explains itself', () => {
    expect(analyze(['vector((1,1)) + (1,0)']).rows[0].error).toMatch(/write vector\(A, B\)/);
    expect(analyze(['P=[(0,0),(1,0),(0,1)]', 'hull(P) hull(P)']).rows[1].error).toMatch(/one figure at a time/);
    expect(analyze(['hull((0,0),(1,1))']).rows[0].error).toMatch(/at least 3 points/);
    expect(analyze(['hull((0,0),(1,1),(x,2))']).rows[0].error).toMatch(/must be constant/);
    expect(analyze(['hull((0,0),(1,1),(1,2))^2']).rows[0].error).toMatch(/whole statement/);
    expect(analyze(['hull(([1..13],[1..13],[1..13]))']).rows[0].error).toMatch(/at most 2000 points/);
  });
});
