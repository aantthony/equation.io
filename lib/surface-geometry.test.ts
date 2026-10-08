import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import { plotReadout } from './plot.ts';
import {
  christoffelFromMetric,
  christoffelOf,
  defaultGeodesicLength,
  geodesicPath,
  gaussianOf,
  geodesicSystem,
  meanCurvatureOf,
  numericIn,
  periodicAxes,
  smoothPartial,
  traceGeodesic,
} from './surface-geometry.ts';

/** The differential geometry of a parametric surface (lib/surface-geometry.ts). */
const surface = (src: string): Expr[] => {
  const e = parseExpr(src);
  if (e.kind !== 'vec') throw new Error(src);
  return e.items;
};
const at = (e: Expr, u: number, v: number, env: Record<string, number> = {}) => evaluate(e, { ...env, u, v });
const K = (src: string, u: number, v: number) => at(gaussianOf(surface(src), smoothPartial), u, v);
const H = (src: string, u: number, v: number) => at(meanCurvatureOf(surface(src), smoothPartial), u, v);

const SPHERE = '(3cos(v) cos(u), 3cos(v) sin(u), 3sin(v))';
const TORUS = '((3 + cos(v)) cos(u), (3 + cos(v)) sin(u), sin(v))';

describe('Gaussian and mean curvature', () => {
  it('reads 1/R² and −1/R on a sphere, with its outward normal', () => {
    for (const [u, v] of [
      [0.3, 0.2],
      [2, -1.1],
      [-1, 1.4],
    ]) {
      expect(K(SPHERE, u, v)).toBeCloseTo(1 / 9, 12);
      // n = r_u × r_v points out of this sphere, and the surface bends
      // away from it.
      expect(H(SPHERE, u, v)).toBeCloseTo(-1 / 3, 12);
    }
    // Swapping the parameters turns the normal inward: H flips, K does not.
    const swapped = '(3cos(u) cos(v), 3cos(u) sin(v), 3sin(u))';
    expect(H(swapped, 0.2, 0.3)).toBeCloseTo(1 / 3, 12);
    expect(K(swapped, 0.2, 0.3)).toBeCloseTo(1 / 9, 12);
  });
  it('reads cos(v)/(r(R + r cos v)) on a torus: positive outside, negative inside', () => {
    for (const v of [0, 0.7, Math.PI / 2, 2.5, Math.PI]) {
      expect(K(TORUS, 1.2, v)).toBeCloseTo(Math.cos(v) / (3 + Math.cos(v)), 12);
    }
    expect(K(TORUS, 0, 0)).toBeGreaterThan(0);
    expect(K(TORUS, 0, Math.PI)).toBeLessThan(0);
    // H = −(R + 2r cos v)/(2r(R + r cos v)) with this normal (outward).
    const v = 0.9;
    expect(H(TORUS, 0.4, v)).toBeCloseTo(-(3 + 2 * Math.cos(v)) / (2 * (3 + Math.cos(v))), 12);
  });
  it('reads 0 on planes, however they are traced', () => {
    for (const src of ['(u, v, 0)', '(u^3 + v, 2v + u^3, u^3 - v)', '(u cos(v), u sin(v), 2)']) {
      expect(Math.abs(K(src, 0.7, 0.4))).toBeLessThan(1e-15);
      expect(Math.abs(H(src, 0.7, 0.4))).toBeLessThan(1e-15);
    }
  });
  it('reads −4 at the saddle z = x² − y², and −1 − ... away from it', () => {
    expect(K('(u, v, u^2 - v^2)', 0, 0)).toBe(-4);
    expect(H('(u, v, u^2 - v^2)', 0, 0)).toBe(0);
    // A graph z = f(x, y): K = (f_xx f_yy − f_xy²)/(1 + |∇f|²)².
    const [u, v] = [0.3, -0.5];
    expect(K('(u, v, u^2 - v^2)', u, v)).toBeCloseTo(-4 / (1 + 4 * u * u + 4 * v * v) ** 2, 14);
    // The monkey saddle is flat at its centre (a degenerate saddle).
    expect(K('(u, v, u^3 - 3u v^2)', 0, 0) + 0).toBe(0);
    expect(K('(u, v, u^3 - 3u v^2)', 0.4, 0.1)).toBeLessThan(0);
  });
  it('reads H = 0 on minimal surfaces: the catenoid, Enneper’s and the helicoid', () => {
    const catenoid = '(cosh(v) cos(u), cosh(v) sin(u), v)';
    const enneper = '(u - u^3/3 + u v^2, v - v^3/3 + v u^2, u^2 - v^2)';
    const helicoid = '(v cos(u), v sin(u), u)';
    for (const src of [catenoid, enneper, helicoid])
      for (const [u, v] of [
        [0.3, 0.2],
        [1.1, -0.6],
      ]) {
        expect(Math.abs(H(src, u, v))).toBeLessThan(1e-12);
        expect(K(src, u, v)).toBeLessThan(0);
      }
    // The catenoid's K = −1/cosh⁴(v).
    expect(K(catenoid, 0.5, 0.8)).toBeCloseTo(-1 / Math.cosh(0.8) ** 4, 12);
    // Enneper's: K = −16/(4 + (1 + u² + v²)²·...)… = −4/(1 + u² + v²)⁴.
    expect(K(enneper, 0.3, 0.2)).toBeCloseTo(-4 / (1 + 0.09 + 0.04) ** 4, 12);
  });
  it('reads a surface it cannot differentiate by central differences', () => {
    // floor(2) is flat, so this is a sphere of radius 2 with no derivative
    // through floor: the difference fallback reads its K.
    const k = K('(floor(2.5) cos(v) cos(u), floor(2.5) cos(v) sin(u), floor(2.5) sin(v))', 0.3, 0.4);
    expect(k).toBeCloseTo(0.25, 5);
  });
});

describe('Christoffel symbols', () => {
  it('agree with the metric’s own formula', () => {
    for (const src of [TORUS, SPHERE, '(u, v, u^2 v - sin(v))', '(cosh(v) cos(u), cosh(v) sin(u), v)']) {
      const r = surface(src);
      const embedded = christoffelOf(r, smoothPartial);
      const [E, F, G] = embedded.metric;
      const intrinsic = christoffelFromMetric(E, F, G, smoothPartial);
      for (let k = 0; k < 6; k++)
        expect(at(embedded.symbols[k], 0.4, 0.3)).toBeCloseTo(at(intrinsic.symbols[k], 0.4, 0.3), 10);
    }
  });
  it('are the sphere’s known ones', () => {
    // Longitude u, latitude v: Γᵘ_uv = −tan v, Γᵛ_uu = sin v cos v, the rest 0.
    const { symbols } = christoffelOf(surface(SPHERE), smoothPartial);
    const v = 0.6;
    const got = symbols.map(s => at(s, 1, v));
    const want = [0, -Math.tan(v), 0, Math.sin(v) * Math.cos(v), 0, 0];
    got.forEach((g, k) => expect(g).toBeCloseTo(want[k], 12));
  });
});

/** Trace a geodesic of the surface `src` (in u, v) and return its points in
 *  space with its parameter points. */
function geodesic(
  src: string,
  start: [number, number],
  direction: [number, number],
  length: number,
  domain: [[number, number], [number, number]] = [
    [-10, 10],
    [-10, 10],
  ],
  periodic: [boolean, boolean] = [false, false],
) {
  const r = surface(src);
  const sys = geodesicSystem(christoffelOf(r, smoothPartial));
  const uv = traceGeodesic(sys, { start, direction, length, domain, periodic });
  const P = numericIn(r, ['u', 'v']);
  const out = new Float64Array(3);
  const xyz = uv.map(([u, v]) => {
    P(u, v, out);
    return [...out];
  });
  return { uv, xyz };
}
const sub3 = (a: number[], b: number[]) => a.map((c, k) => c - b[k]);
const cross3 = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const arc = (xyz: number[][]) => xyz.slice(1).reduce((s, p, k) => s + Math.hypot(...sub3(p, xyz[k])), 0);

describe('geodesics', () => {
  it('are great circles on a sphere: every point on the plane through the centre', () => {
    const { xyz } = geodesic(SPHERE, [0.3, 0.4], [1, 0.7], 18);
    expect(xyz.length).toBeGreaterThan(400);
    const normal = cross3(xyz[0], xyz[20]);
    const n = Math.hypot(...normal);
    for (const p of xyz) {
      expect(Math.abs(dot3(p, normal)) / n).toBeLessThan(1e-6);
      expect(Math.hypot(...p)).toBeCloseTo(3, 9);
    }
    // At unit speed: the drawn length is the length asked for.
    expect(arc(xyz)).toBeCloseTo(18, 3);
  });
  it('are straight lines on a plane, in any parametrisation', () => {
    const { xyz } = geodesic('(u + v^3, v, 0)', [0.1, 0.2], [1, 1], 2);
    const d = sub3(xyz.at(-1)!, xyz[0]);
    for (const p of xyz) expect(Math.hypot(...cross3(sub3(p, xyz[0]), d)) / Math.hypot(...d)).toBeLessThan(1e-7);
    expect(Math.hypot(...d)).toBeCloseTo(2, 6);
    // Polar coordinates on the plane: a straight line that misses the origin.
    const polar = geodesic('(u cos(v), u sin(v), 0)', [1, 0], [0, 1], 3);
    for (const p of polar.xyz) expect(p[0]).toBeCloseTo(1, 7);
  });
  it('are helices on a cylinder: straight in the unrolled chart', () => {
    // Unrolled, the cylinder of radius 2 is the plane (2u, v).
    const { uv, xyz } = geodesic('(2cos(u), 2sin(u), v)', [0, 0], [1, 0.5], 20);
    for (const [u, v] of uv) expect(v).toBeCloseTo(u * 0.5, 7);
    for (const p of xyz) expect(Math.hypot(p[0], p[1])).toBeCloseTo(2, 9);
  });
  it('keep Clairaut’s r cos ψ on a surface of revolution', () => {
    // A torus, revolved about z: r = 3 + cos v the distance from the axis,
    // ψ the angle to the parallel. At unit speed r cos ψ = r · r du/ds.
    const sys = geodesicSystem(christoffelOf(surface(TORUS), smoothPartial));
    const velocities: [number, number][] = [];
    const uv = traceGeodesic(
      sys,
      {
        start: [0, 0.3],
        direction: [0.2, 1],
        length: 60,
        domain: [
          [-Math.PI, Math.PI],
          [-Math.PI, Math.PI],
        ],
        periodic: [true, true],
      },
      velocities,
    );
    expect(uv.length).toBe(velocities.length);
    const clairaut = (k: number) => (3 + Math.cos(uv[k][1])) ** 2 * velocities[k][0];
    const c0 = clairaut(0);
    expect(c0).toBeGreaterThan(0.5);
    for (let k = 1; k < uv.length; k++) expect(clairaut(k)).toBeCloseTo(c0, 7);
    // It winds round the hole, past the edge of the chart.
    expect(Math.max(...uv.map(p => Math.abs(p[0])))).toBeGreaterThan(2 * Math.PI);
  });
  it('stop where they leave the domain, at its edge', () => {
    const { uv } = geodesic('(u, v, u^2 - v^2)', [0.5, 0.5], [1, 0], 100, [
      [0, 1],
      [0, 1],
    ]);
    const end = uv.at(-1)!;
    expect(Math.max(...uv.map(p => p[0]))).toBeLessThanOrEqual(1);
    expect(end[0] === 1 || end[0] === 0 || end[1] === 0 || end[1] === 1).toBe(true);
  });
  it('stop cleanly at a pole, the edge of the sphere’s latitude', () => {
    const domain: [[number, number], [number, number]] = [
      [-Math.PI, Math.PI],
      [-Math.PI / 2, Math.PI / 2],
    ];
    // Up a meridian: latitude runs to π/2 and stops there.
    const { uv, xyz } = geodesic(SPHERE, [0.2, 0], [0, 1], 30, domain, [true, false]);
    expect(uv.every(p => p.every(Number.isFinite))).toBe(true);
    expect(uv.at(-1)![1]).toBeCloseTo(Math.PI / 2, 12);
    expect(xyz.at(-1)![2]).toBeCloseTo(3, 9);
    // Just past the pole the longitude turns half round in an instant, and
    // the steps shrink to follow it: still a great circle.
    const near = geodesic(SPHERE, [0.2, 0], [1e-4, 1], 18, domain, [true, false]);
    expect(near.uv.length).toBeGreaterThan(400);
    const normal = cross3(near.xyz[0], near.xyz[50]);
    for (const p of near.xyz) expect(Math.abs(dot3(p, normal)) / Math.hypot(...normal)).toBeLessThan(1e-5);
    expect(arc(near.xyz)).toBeCloseTo(18, 2);
  });
  it('stop where the metric degenerates', () => {
    // A cone's apex, reached exactly: E = 2, G = u², so EG − F² = 0 there.
    const { uv } = geodesic('(u cos(v), u sin(v), u)', [1, 0], [-1, 0], 5, [
      [-1, 1],
      [-10, 10],
    ]);
    expect(uv.every(p => p.every(Number.isFinite))).toBe(true);
    expect(uv.at(-1)![0]).toBeGreaterThanOrEqual(-1);
  });
  it('run backwards for a negative length, and not at all with no direction', () => {
    const forward = geodesic(SPHERE, [0, 0], [1, 0], 2).uv.at(-1)!;
    const back = geodesic(SPHERE, [0, 0], [1, 0], -2).uv.at(-1)!;
    expect(back[0]).toBeCloseTo(-forward[0], 9);
    expect(geodesic(SPHERE, [0, 0], [0, 0], 2).uv).toEqual([[0, 0]]);
  });
});

describe('periodicity and default length', () => {
  const fn = (src: string) => {
    const P = numericIn(surface(src), ['u', 'v']);
    const out = new Float64Array(3);
    return (u: number, v: number) => {
      P(u, v, out);
      return [...out];
    };
  };
  it('tells a torus’s angles from a sphere’s latitude', () => {
    const domain: [[number, number], [number, number]] = [
      [-Math.PI, Math.PI],
      [-Math.PI, Math.PI],
    ];
    expect(periodicAxes(fn(TORUS), domain)).toEqual([true, true]);
    expect(
      periodicAxes(fn(SPHERE), [
        [-Math.PI, Math.PI],
        [-Math.PI / 2, Math.PI / 2],
      ]),
    ).toEqual([true, false]);
    expect(
      periodicAxes(fn('(u, v, u v)'), [
        [0, 1],
        [0, 1],
      ]),
    ).toEqual([false, false]);
  });
  it('runs a little more than once round a sphere', () => {
    const L = defaultGeodesicLength(fn(SPHERE), [
      [-Math.PI, Math.PI],
      [-Math.PI / 2, Math.PI / 2],
    ]);
    expect(L).toBeGreaterThan(6 * Math.PI);
    expect(L).toBeLessThan(8 * Math.PI);
  });
});

/** Rows that use them (lib/defs.ts surfaceGeometry, lib/plot.ts paintedSurface). */
describe('gaussian and meancurvature rows', () => {
  const last = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!;
  const readout = (rows: string[]) => {
    const analysis = analyzeRows(rows, { readouts: true });
    const r = analysis.rows.at(-1)!;
    if (r.error) throw new Error(r.error);
    return plotReadout(r.cpu!, { ...analysis.constEnv, t: 0 });
  };
  const S = `S = ${SPHERE}`;
  const ON_SPHERE = 'on((X, Y, Z) = (3cos(y) cos(x), 3cos(y) sin(x), 3sin(y)), x = -pi..pi, y = -pi/2..pi/2)';
  it('read out at a point, given as two numbers, a tuple or a named point', () => {
    expect(readout([S, 'gaussian(S, 0.2, 0.3)'])).toBe('≈ 0.111111');
    expect(readout([S, 'meancurvature(S, (0.2, 0.3))'])).toBe('≈ -0.333333');
    expect(readout(['S = (u, v, u^2 - v^2)', 'P = (0, 0)', 'gaussian(S, P)'])).toBe('= -4');
    expect(readout(['gaussian((u, v, u v), 0, 0)'])).toBe('= -1');
    expect(readout(['f(a, b) = (a, b, a b)', 'gaussian(f, 0, 0)'])).toBe('= -1');
    // A list of points reads each.
    expect(readout(['a = [0..2]', 'S = (u, v, u^2 - v^2)', 'gaussian(S, a/2, 0)'])).toBe('= [-4, -1, -0.16]');
  });
  it('read a surface over intervals at their own values', () => {
    const torus = ['u = interval(0, 2pi)', 'v = interval(0, 2pi)', `S = ${TORUS}`];
    expect(readout([...torus, 'gaussian(S, 0, pi)'])).toBe('= -0.5');
    expect(readout([...torus, 'gaussian(S, 0, 0)'])).toBe('= 0.25');
  });
  it('slide with a slider', () => {
    expect(readout(['R = 2', 'S = (R cos(v) cos(u), R cos(v) sin(u), R sin(v))', 'gaussian(S, 0, 0)'])).toBe('= 0.25');
  });
  it('alone on a row colour the surface by the curvature', () => {
    for (const rows of [
      [S, 'gaussian(S)'],
      ['u = interval(0, 2pi)', 'v = interval(0, 2pi)', `S = ${TORUS}`, 'meancurvature(S)'],
    ]) {
      const r = last(rows);
      expect(r.error).toBeUndefined();
      const o = r.cls!.object;
      if (o.kind !== 'surface' || o.form !== 'parametric') throw new Error(o.kind);
      expect(o.paint).toBeDefined();
      expect(r.cpu).toMatchObject({ type: 'psurface' });
      expect(r.gpu).toMatchObject({ type: 'psurface' });
      expect((r.gpu as { paint?: string }).paint).toBeTypeOf('string');
    }
    // The torus over intervals: its paint is swept to the mesh's u and v as
    // the surface is, in the order they appear in it — v first here — so
    // the inner equator (v = π) is at mesh u = 1/2, and reads −1/2.
    const r = last(['u = interval(0, 2pi)', 'v = interval(0, 2pi)', `S = ${TORUS}`, 'gaussian(S)']);
    const o = r.cls!.object as { paint: Expr; coordinates: Expr[] };
    expect(evaluate(o.paint, { u: 0.5, v: 0.3 })).toBeCloseTo(-0.5, 12);
    expect(evaluate(o.coordinates[2], { u: 0.25, v: 0.3 })).toBeCloseTo(1, 12);
    // Elsewhere K is a number in u and v: as a height over the parameters.
    expect(last(['S = (u, v, u^2 - v^2)', '(u, v, gaussian(S))']).cls!.object.kind).toBe('surface');
  });
  it('read the panel’s own surface on an on(…) panel', () => {
    const field = last([ON_SPHERE, 'gaussian(x, y)']);
    expect(field.error).toBeUndefined();
    expect(field.cls!.object).toMatchObject({ kind: 'scalar-field', autoscale: true });
    expect(readout([ON_SPHERE, 'gaussian(0.2, 0.3)'])).toBe('≈ 0.111111');
    expect(readout([ON_SPHERE, 'P = (0.2, 0.3)', 'meancurvature(P)'])).toBe('≈ -0.333333');
    // A surface of its own still reads as one there.
    expect(readout([ON_SPHERE, 'S = (u, v, u^2 - v^2)', 'gaussian(S, 0, 0)'])).toBe('= -4');
  });
  it('say what they need', () => {
    expect(last(['gaussian(x, y)']).error).toMatch(/on\(…\) row, and this panel has none/);
    expect(last(['C = (cos(u), sin(u), u)', 'gaussian(C)']).error).toMatch(/moves with both u and v/);
    expect(last(['gaussian(T)']).error).toMatch(/T is not a surface — define one first/);
    expect(last(['S = (u, v, u v)', 'gaussian(S, 1, 2, 3)']).error).toMatch(/takes a surface/);
  });
});

/** geodesic rows (lib/analysis.ts classifyGeodesic), drawn by geodesicPath. */
describe('geodesic rows', () => {
  const analyze = (rows: string[]) => {
    const analysis = analyzeRows(rows, { readouts: true });
    const r = analysis.rows.at(-1)!;
    return { r, env: { ...analysis.constEnv, t: 0 } };
  };
  /** The points one geodesic row draws, as [x, y, z]. */
  const traced = (rows: string[], member?: number) => {
    const { r, env } = analyze(rows);
    if (r.error) throw new Error(r.error);
    let o = r.cls!.object;
    if (o.kind === 'family') o = o.members[member ?? 0].object;
    if (o.kind !== 'geodesic') throw new Error(o.kind);
    const flat = geodesicPath(o, env);
    return Array.from({ length: flat.length / 3 }, (_, k) => flat.slice(3 * k, 3 * k + 3));
  };
  const SPHERE_UV = ['u = interval(-pi, pi)', 'v = interval(-pi/2, pi/2)', `S = ${SPHERE}`];
  const ON_TORUS = 'on((X, Y, Z) = ((3 + cos(y)) cos(x), (3 + cos(y)) sin(x), sin(y)), x = -pi..pi, y = -pi..pi)';

  it('draws a great circle on a sphere, in space', () => {
    const { r } = analyze([...SPHERE_UV, 'geodesic(S, (0.2, 0.3), (1, 0.5))']);
    expect(r.cls).toMatchObject({ needs3D: true, object: { kind: 'geodesic', dim: 3 } });
    expect(r.cpu?.type).toBe('geodesic');
    const pts = traced([...SPHERE_UV, 'geodesic(S, (0.2, 0.3), (1, 0.5))']);
    const normal = cross3(pts[0], pts[30]);
    for (const p of pts) {
      expect(Math.hypot(...p)).toBeCloseTo(3, 8);
      expect(Math.abs(dot3(p, normal)) / Math.hypot(...normal)).toBeLessThan(1e-6);
    }
    // Round the longitude's seam and on: a little more than once round.
    expect(arc(pts)).toBeGreaterThan(6 * Math.PI);
  });
  it('runs as far as asked, and stops at the edge of u and v’s ranges', () => {
    expect(arc(traced([...SPHERE_UV, 'geodesic(S, (0.2, 0.3), (1, 0.5), 2)']))).toBeCloseTo(2, 6);
    // Without intervals u and v run over [0, 1]: a saddle patch, left at its edge.
    const pts = traced(['S = (u, v, u^2 - v^2)', 'geodesic(S, (0.5, 0.5), (1, 0.2))']);
    const end = pts.at(-1)!;
    expect(end[0]).toBeCloseTo(1, 9);
    expect(pts.every(p => p[0] <= 1 + 1e-12 && p[1] >= 0 && p[1] <= 1)).toBe(true);
  });
  it('reads sliders, t and named points', () => {
    const rows = (P: string) => [...SPHERE_UV, `P = ${P}`, 'R = 2', 'geodesic(S, P, (cos(t), 1), R)'];
    const { r } = analyze(rows('(0.2, 0.3)'));
    expect(r.cls!.params).toEqual(['P_x', 'P_y', 'R']);
    expect(r.cls!.animated).toBe(true);
    const a = traced(rows('(0.2, 0.3)'));
    const b = traced(rows('(0.4, 0.3)'));
    expect(a[0]).not.toEqual(b[0]);
    expect(a[0][0]).toBeCloseTo(3 * Math.cos(0.3) * Math.cos(0.2), 9);
    expect(arc(a)).toBeCloseTo(2, 6);
  });
  it('draws a fan from a list of directions', () => {
    const rows = [...SPHERE_UV, 'a = [0..5] pi/3', 'geodesic(S, (0, 0.4), (cos(a), sin(a)), 3)'];
    const { r } = analyze(rows);
    const o = r.cls!.object;
    if (o.kind !== 'family') throw new Error(o.kind);
    expect(o.members).toHaveLength(6);
    const ends = o.members.map((_, k) => traced(rows, k).at(-1)!);
    expect(new Set(ends.map(e => e.map(c => c.toFixed(6)).join())).size).toBe(6);
    // Each 3 from the start, along the sphere: the angle 1 at the centre.
    const start = traced(rows, 0)[0];
    for (const e of ends) expect(Math.acos(dot3(e, start) / 9)).toBeCloseTo(1, 6);
    expect(analyze([...SPHERE_UV, 'a = [1, 2]', 'b = [1, 2, 3]', 'geodesic(S, (0, a), (1, b))']).r.error).toMatch(
      /as long/,
    );
  });
  it('draws on a panel’s surface in its x and y, carried onto it', () => {
    const rows = [ON_TORUS, 'P = (0.5, 0.3)', 'geodesic(P, (1, 0.3), 30)'];
    const { r } = analyze(rows);
    expect(r.cls).toMatchObject({ needs3D: false, object: { kind: 'geodesic', dim: 2, params: ['x', 'y'] } });
    const pts = traced(rows);
    expect(pts[0]).toEqual([0.5, 0.3, 0]);
    // The torus repeats across its angles, so the geodesic runs on past the
    // edge of x, round the hole.
    expect(Math.max(...pts.map(p => p[0]))).toBeGreaterThan(Math.PI);
    const embed = (x: number, y: number) => [
      (3 + Math.cos(y)) * Math.cos(x),
      (3 + Math.cos(y)) * Math.sin(x),
      Math.sin(y),
    ];
    const onSurface = pts.map(([x, y]) => embed(x, y));
    expect(arc(onSurface)).toBeCloseTo(30, 2);
  });
  it('says what it needs', () => {
    expect(analyze(['geodesic((0.2, 0.3), (1, 1))']).r.error).toMatch(/this panel has none/);
    expect(analyze([`S = ${SPHERE}`, 'geodesic(S, (0.2, x), (1, 1))']).r.error).toMatch(/found x/);
    expect(analyze([ON_TORUS, 'geodesic((0.2, y), (1, 1))']).r.error).toMatch(/, not y/);
    expect(analyze([`S = ${SPHERE}`, '2 geodesic(S, (0.2, 0.3), (1, 1))']).r.error).toMatch(/whole row/);
    expect(analyze(['geodesic(T, (0.2, 0.3), (1, 1))']).r.error).toMatch(/T is not a surface/);
    expect(analyze([`S = ${SPHERE}`, 'geodesic(S, (0.2, 0.3), 1)']).r.error).toMatch(/a pair/);
    expect(analyze([ON_TORUS, 'geodesic(1, 2)']).r.error).toMatch(/a pair/);
  });
});
