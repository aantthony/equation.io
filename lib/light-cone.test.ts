import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { compileCpu, cpuStructureKey } from './compiler.ts';
import { plotReadout } from './plot.ts';
import {
  type ConeView,
  type LightConeSpec,
  behindHorizon,
  coneGlyphs,
  coneLattice,
  futureCone,
  indicatrix,
  indicatrixScale,
  nearestNull,
  nullAngles,
} from './light-cone.ts';
import {
  type GeodesicEnd,
  type GeodesicOptions,
  geodesicCutNote,
  geodesicPath,
  metricAt,
  metricOrientation,
  metricValues,
} from './surface-geometry.ts';

/** Light cones of a panel's metric (lib/light-cone.ts), and the geodesics
 *  of a spacetime diagram: a Lorentzian metric in x and y alone. */

const MINKOWSKI = 'ds^2 = -dy^2 + dx^2';
/** Schwarzschild's r and t, as x and y. */
const SCHWARZSCHILD_RT = ['M = 1', 'ds^2 = -(1 - 2M/x) dy^2 + dx^2/(1 - 2M/x)'];
/** Ingoing Eddington–Finkelstein: r and v, as x and y. */
const EDDINGTON = ['M = 1', 'ds^2 = -(1 - 2M/x) dy^2 + 2 dy dx'];
const EQUATORIAL = ['M = 1', 'r = sqrt(x^2 + y^2)', 'phi = atan2(y, x)'];
const SCHWARZSCHILD = [...EQUATORIAL, 'ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2'];
const kerr = (a: number) => [
  ...EQUATORIAL,
  `a = ${a}`,
  'ds^2 = -(1 - 2M/r) dt^2 - 4 M a/r dt dphi + r^2/(r^2 - 2M r + a^2) dr^2 + (r^2 + a^2 + 2M a^2/r) dphi^2',
];

const last = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!;
const errorOf = (rows: string[]) => last(rows).error;

type Window = GeodesicOptions['domain'];
const box = (x0: number, x1: number, y0: number, y1: number): Window => [
  [x0, x1],
  [y0, y1],
];

/** The points a document's last row draws (member `member` of a family),
 *  traced over `window`, and how it ended. */
function traced(rows: string[], window: Window, member = 0) {
  const analysis = analyzeRows(rows, { readouts: true });
  const r = analysis.rows.at(-1)!;
  if (r.error) throw new Error(r.error);
  let o = r.cls!.object;
  if (o.kind === 'family') o = o.members[member].object;
  if (o.kind !== 'geodesic') throw new Error(o.kind);
  const ended: GeodesicEnd = { length: 0, asked: 0, budget: false };
  const flat = geodesicPath(o, { ...analysis.constEnv, t: 0 }, { window, ended, maxSteps: 400000 });
  const pts = Array.from({ length: flat.length / 3 }, (_, k) => [flat[3 * k], flat[3 * k + 1]] as [number, number]);
  return { pts, ended, object: o };
}

/** The light-cone spec of a document's last row (member `member`), and the
 *  values it reads. */
function cones(rows: string[], member = 0) {
  const analysis = analyzeRows(rows, { readouts: true });
  const r = analysis.rows.at(-1)!;
  if (r.error) throw new Error(r.error);
  let o = r.cls!.object;
  if (o.kind === 'family') o = o.members[member].object;
  if (o.kind !== 'lightcone') throw new Error(o.kind);
  const { kind: _, ...spec } = o;
  return { spec: spec as LightConeSpec, env: { ...analysis.constEnv, t: 0 } };
}

const view = (x0: number, x1: number, y0: number, y1: number, px = 800): ConeView => {
  const upp = (x1 - x0) / px;
  return { lo: [x0, y0], hi: [x1, y1], upp, uppY: upp };
};

const angle = (u: readonly number[]) => Math.atan2(u[1], u[0]);

describe('null directions of a 2 × 2 metric', () => {
  it('are ±45° in Minkowski space, with the future cone up', () => {
    const [a1, a2] = nullAngles(1, 0, -1)!;
    expect([a1, a2].map(a => Math.abs(Math.tan(a)))).toEqual([expect.closeTo(1, 12), expect.closeTo(1, 12)]);
    const cone = futureCone(1, 0, -1)!;
    expect(cone.axis).toBeCloseTo(Math.PI / 2, 12);
    expect(cone.half).toBeCloseTo(Math.PI / 4, 12);
    // With x as the time (-dx^2 + dy^2), the future is toward −x.
    expect(futureCone(-1, 0, 1)!.axis).toBeCloseTo(Math.PI, 12);
    // Not Lorentzian: none.
    expect(nullAngles(1, 0, 1)).toBeNull();
    expect(nullAngles(-1, 0, -1)).toBeNull();
    expect(futureCone(1, 1, 1)).toBeNull();
    // The nearest of the four half-lines, by angle.
    expect(nearestNull(1, 0, -1, 0.2)).toEqual([expect.closeTo(Math.SQRT1_2, 12), expect.closeTo(Math.SQRT1_2, 12)]);
    expect(nearestNull(1, 0, -1, 2.9)).toEqual([expect.closeTo(-Math.SQRT1_2, 12), expect.closeTo(Math.SQRT1_2, 12)]);
  });

  it('close up toward Schwarzschild’s horizon in r and t: half-angle atan(1 − 2M/r)', () => {
    const { spec, env } = cones([...SCHWARZSCHILD_RT, 'lightcone((4, 0))']);
    const read = metricValues(spec, env);
    for (const r of [2.01, 2.5, 3, 6, 50]) {
      const g = read(r, 1)!;
      const cone = futureCone(g[0][0], g[0][1], g[1][1])!;
      expect(cone.axis).toBeCloseTo(Math.PI / 2, 10);
      expect(cone.half).toBeCloseTo(Math.atan(1 - 2 / r), 10);
    }
    // Inside, r is the time: the cone lies along x, its future toward −x
    // (smaller r).
    const g = read(1, 0)!;
    expect(Math.abs(futureCone(g[0][0], g[0][1], g[1][1])!.axis)).toBeCloseTo(Math.PI, 9);
  });

  it('tip over through Eddington–Finkelstein’s horizon, smoothly', () => {
    const { spec, env } = cones([...EDDINGTON, 'lightcones']);
    const read = metricValues(spec, env);
    let before = NaN;
    for (let r = 6; r > 0.05; r -= 0.05) {
      const g = read(r, 0)!;
      const cone = futureCone(g[0][0], g[0][1], g[1][1])!;
      // One edge is always the ingoing ray, along −x.
      const edges = [cone.axis - cone.half, cone.axis + cone.half];
      expect(Math.min(...edges.map(e => Math.abs(Math.cos(e) + 1)))).toBeLessThan(1e-9);
      // The other is dr/dv = (1 − 2M/r)/2: outward outside, inward inside.
      const other = edges.find(e => Math.abs(Math.cos(e) + 1) > 1e-9)!;
      expect(Math.cos(other) / Math.sin(other)).toBeCloseTo((1 - 2 / r) / 2, 9);
      if (Number.isFinite(before)) expect(Math.abs(cone.axis - before)).toBeLessThan(0.1);
      before = cone.axis;
    }
  });
});

describe('the light-speed indicatrix', () => {
  it('is the unit circle round its point in flat space', () => {
    const e = indicatrix([
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ])!;
    expect([e.cx, e.cy, e.a, e.b]).toEqual([0, 0, 1, 1].map(v => expect.closeTo(v, 12)));
    // Inside a horizon (x and y not space), none.
    expect(
      indicatrix([
        [1, 0, 0],
        [0, -1, 0],
        [0, 0, 1],
      ]),
    ).toBeNull();
  });

  it('is 1 − 2M/r across and √(1 − 2M/r) round Schwarzschild, at r', () => {
    const { spec, env } = cones([...SCHWARZSCHILD, 'lightcones']);
    const read = metricValues(spec, env);
    for (const r of [2.2, 3, 5, 20]) {
      const f = 1 - 2 / r;
      // On the x axis: radial is x, tangential y.
      const e = indicatrix(read(r, 0)!)!;
      expect(Math.hypot(e.cx, e.cy)).toBeLessThan(1e-12);
      const [radial, round] = Math.abs(Math.cos(e.angle)) > 0.5 ? [e.a, e.b] : [e.b, e.a];
      expect(radial).toBeCloseTo(f, 10);
      expect(round).toBeCloseTo(Math.sqrt(f), 10);
      // …and anywhere on the circle, the same shape turned.
      const e2 = indicatrix(read(r * Math.cos(1), r * Math.sin(1))!)!;
      expect(Math.min(e2.a, e2.b)).toBeCloseTo(f, 9);
      expect(Math.max(e2.a, e2.b)).toBeCloseTo(Math.sqrt(f), 9);
    }
  });

  it('is dragged round a spinning hole, and leaves its point out inside the ergoregion', () => {
    const { spec, env } = cones([...kerr(0.9), 'lightcones']);
    const read = metricValues(spec, env);
    // Outside the ergosurface r = 2M: dragged in +φ (+y on the x axis) but
    // still round its point.
    const outside = indicatrix(read(4, 0)!)!;
    expect(outside.cy).toBeGreaterThan(0);
    expect(Math.abs(outside.cx)).toBeLessThan(1e-9);
    expect(outside.cy).toBeLessThan(Math.min(outside.a, outside.b));
    // Inside it (r+ ≈ 1.44 < r < 2): the point is outside its ellipse.
    const inside = indicatrix(read(1.8, 0)!)!;
    const [c, s] = [Math.cos(inside.angle), Math.sin(inside.angle)];
    const [u, v] = [-inside.cx * c - inside.cy * s, inside.cx * s - inside.cy * c];
    expect((u / inside.a) ** 2 + (v / inside.b) ** 2).toBeGreaterThan(1);
    expect(inside.cy).toBeGreaterThan(0);
    // The other way round for a < 0.
    const back = cones([...kerr(-0.9), 'lightcones']);
    expect(indicatrix(metricValues(back.spec, back.env)(4, 0)!)!.cy).toBeLessThan(0);
  });
});

describe('light-cone glyphs', () => {
  it('lie on a lattice anchored in the plane, the power of two nearest 56 px', () => {
    const v = view(-10, 10, -6, 6);
    const pts = coneLattice(v);
    const w = 2 ** Math.round(Math.log2(56 * v.upp));
    for (const [x, y] of pts) {
      expect(Math.abs(x / w - 0.5 - Math.round(x / w - 0.5))).toBeLessThan(1e-9);
      expect(Math.abs(y / w - 0.5 - Math.round(y / w - 0.5))).toBeLessThan(1e-9);
    }
    // A small pan keeps them where they were.
    const moved = coneLattice(view(-9.9, 10.1, -6, 6));
    expect(moved.filter(([x]) => x > -9 && x < 9).map(String)).toEqual(
      pts.filter(([x]) => x > -9 && x < 9).map(String),
    );
  });

  it('draw a spacetime diagram’s future wedges a fixed size on the screen', () => {
    const { spec, env } = cones([MINKOWSKI, 'lightcones']);
    for (const v of [view(-5, 5, -3, 3), view(-50, 50, -30, 30)]) {
      const glyphs = coneGlyphs(metricValues(spec, env), v);
      expect(glyphs.dots).toEqual([]);
      // Each ring: its apex at a lattice point, its arc 15 px out, above it
      // between 45° and 135°.
      const ring = glyphs.rings.slice(0, glyphs.rings.findIndex(Number.isNaN));
      const [x, y] = ring;
      for (let k = 2; k < ring.length; k += 2) {
        const [dx, dy] = [(ring[k] - x) / v.upp, (ring[k + 1] - y) / v.uppY];
        expect(Math.hypot(dx, dy)).toBeCloseTo(15, 9);
        expect(Math.atan2(dy, dx)).toBeGreaterThan(Math.PI / 4 - 1e-9);
        expect(Math.atan2(dy, dx)).toBeLessThan((3 * Math.PI) / 4 + 1e-9);
      }
      expect(glyphs.rings.filter(Number.isNaN).length / 2).toBe(coneLattice(v).length);
    }
  });

  it('scale indicatrices by one power of two for the panel, the median a third of a cell', () => {
    const { spec, env } = cones([...SCHWARZSCHILD, 'lightcones']);
    const read = metricValues(spec, env);
    const v = view(-16, 16, -10, 10);
    const k = indicatrixScale(read, v);
    expect(Math.log2(k) % 1).toBe(0);
    const reach = (0.36 * 2 ** Math.round(Math.log2(56 * v.upp))) / k;
    // Far out the ellipses are nearly unit circles.
    expect(reach).toBeGreaterThan(0.5);
    expect(reach).toBeLessThan(1.5);
    const glyphs = coneGlyphs(read, v);
    // One dot per ellipse, none inside the horizon.
    expect(glyphs.dots.length / 2).toBe(glyphs.rings.filter(Number.isNaN).length / 2);
    for (let i = 0; i < glyphs.dots.length; i += 2)
      expect(Math.hypot(glyphs.dots[i], glyphs.dots[i + 1])).toBeGreaterThan(2);
    // A lone one at a point uses the scale it is given.
    const lone = coneGlyphs(read, v, { at: [[10, 0]], kappa: 1 });
    const xs = lone.rings.filter((_, i) => i % 2 === 0 && Number.isFinite(lone.rings[i]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2 * (1 - 2 / 10), 3);
  });
});

describe('lightcones and lightcone(P) rows', () => {
  it('say what they need', () => {
    expect(errorOf(['lightcones'])).toMatch(/this panel has none/);
    expect(errorOf(['lightcone((1, 2))'])).toMatch(/this panel has none/);
    expect(errorOf(['ds^2 = (dx^2 + dy^2)/y^2', 'lightcones'])).toMatch(/Riemannian metric has no light cones/);
    expect(errorOf(['ds^2 = dx^3 + dy^2', 'lightcones'])).toMatch(/has an error/);
    expect(errorOf([MINKOWSKI, 'lightcone(1)'])).toMatch(/a pair/);
    expect(errorOf([MINKOWSKI, 'lightcone((x, 1))'])).toMatch(/, not x/);
    expect(errorOf([MINKOWSKI, 'lightcone((1, 2), (1, 0))'])).toMatch(/lightcone\(P\) draws/);
    expect(errorOf([MINKOWSKI, '2 lightcone((1, 2))'])).toMatch(/whole row/);
    expect(errorOf([MINKOWSKI, '---', 'lightcones'])).toMatch(/this panel has none/);
    // A document's own lightcones is its own.
    expect(errorOf(['lightcones = 2', 'y = lightcones x'])).toBeUndefined();
  });

  it('draw as light cones, a point a member, a list a family', () => {
    const row = last([MINKOWSKI, 'lightcones']);
    expect(row.cls!.object).toMatchObject({ kind: 'lightcone', n: 2 });
    expect(row.cpu).toMatchObject({ type: 'lightcone', n: 2 });
    const one = last([MINKOWSKI, 'P = (1, 2)', 'lightcone(P)']);
    expect(one.cls!.object).toMatchObject({ kind: 'lightcone', at: [{ name: 'P_x' }, { name: 'P_y' }] });
    const fan = last([...SCHWARZSCHILD_RT, 'r = [3..8]', 'lightcone((r, 0))']);
    expect(fan.cls!.object.kind).toBe('family');
    if (fan.cls!.object.kind === 'family') expect(fan.cls!.object.members).toHaveLength(6);
  });

  it('key their plan by the metric and the point', () => {
    const key = (rows: string[]) => cpuStructureKey(compileCpu(last(rows).cls!));
    const a = key([MINKOWSKI, 'lightcones']);
    expect(key([MINKOWSKI, 'lightcones'])).toBe(a);
    expect(key(['ds^2 = -2dy^2 + dx^2', 'lightcones'])).not.toBe(a);
    expect(key([MINKOWSKI, 'lightcone((1, 2))'])).not.toBe(a);
    expect(key([MINKOWSKI, 'lightcone((1, 3))'])).not.toBe(key([MINKOWSKI, 'lightcone((1, 2))']));
  });
});

describe('spacetime diagrams', () => {
  it('are read out as Lorentzian, in x and y', () => {
    const row = last([MINKOWSKI]);
    expect(row.error).toBeUndefined();
    expect(row.cls!.object).toMatchObject({ kind: 'metric', n: 2, lorentzian: true });
    expect(plotReadout(row.cpu!, {})).toMatch(/^Lorentzian metric in x, y \(a spacetime diagram\)/);
    // In declared coordinates too, pulled back through their Jacobian:
    // Rindler's -X^2 dT^2 + dX^2, with T and X stretched from x and y.
    const declared = last(['X = 2x', 'T = y/3', 'ds^2 = -dT^2 + dX^2', 'lightcones']);
    expect(declared.error).toBeUndefined();
    // Negative for every direction: nothing to draw.
    expect(errorOf(['ds^2 = -dx^2 - dy^2'])).toMatch(/negative for every direction/);
    // Positive definite in places and Lorentzian in others: mixed.
    expect(last(['ds^2 = dx^2 + x dy^2']).cls!.object).toMatchObject({ lorentzian: true, mixed: true });
    // Positive definite everywhere: a plane, as before.
    expect(last(['ds^2 = (dx^2 + dy^2)/y^2']).cls!.object).not.toHaveProperty('lorentzian');
  });

  it('pull a declared coordinate’s metric back to x and y', () => {
    const analysis = analyzeRows(['X = 2x', 'T = y/3', 'ds^2 = -dT^2 + dX^2', 'geodesic((0, 0), (0, 1))']);
    const o = analysis.rows.at(-1)!.cls!.object;
    if (o.kind !== 'geodesic' || !o.metric) throw new Error(o.kind);
    expect(o.metric).toMatchObject({ n: 2, motion: 'timelike' });
    const { g } = metricAt(o.metric, {}, 0.3, 0.4);
    expect(g[0][0]).toBeCloseTo(4, 12);
    expect(g[1][1]).toBeCloseTo(-1 / 9, 12);
  });

  it('trace Minkowski’s timelike geodesics and light rays straight', () => {
    const { pts, object, ended } = traced([MINKOWSKI, 'geodesic((0, 0), (0.6, 1), 5)'], box(-20, 20, -20, 20));
    expect(object.metric).toMatchObject({ n: 2, motion: 'timelike' });
    for (const [x, y] of pts) expect(Math.abs(x - 0.6 * y)).toBeLessThan(1e-9);
    // Proper time 5 at speed 0.6: coordinate time 5/0.8.
    expect(pts.at(-1)![1]).toBeCloseTo(5 / 0.8, 6);
    expect(ended.length).toBeCloseTo(5, 9);
    // Light along whichever null line is nearest: (1, 2) is nearest +45°.
    const ray = traced([MINKOWSKI, 'lightray((0, 0), (1, 2), 4)'], box(-20, 20, -20, 20));
    expect(ray.object.metric).toMatchObject({ motion: 'null' });
    for (const [x, y] of ray.pts) expect(Math.abs(x - y)).toBeLessThan(1e-9);
    // Its affine parameter is distance in the panel at the start.
    expect(Math.hypot(...ray.pts.at(-1)!)).toBeCloseTo(4, 6);
    const back = traced([MINKOWSKI, 'lightray((0, 0), (-3, -1), 2)'], box(-20, 20, -20, 20));
    for (const [x, y] of back.pts) expect(Math.abs(x - y)).toBeLessThan(1e-9);
    expect(back.pts.at(-1)![0]).toBeLessThan(0);
  });

  it('refuse a particle faster than light, as the row’s note', () => {
    const { pts, ended } = traced([MINKOWSKI, 'geodesic((0, 0), (1, 0.5))'], box(-20, 20, -20, 20));
    expect(pts).toHaveLength(1);
    expect(geodesicCutNote(ended)).toMatch(/v must point inside the light cone here/);
    const along = traced([MINKOWSKI, 'geodesic((0, 0), (1, 1))'], box(-20, 20, -20, 20));
    expect(geodesicCutNote(along.ended)).toMatch(/inside the light cone/);
  });

  it('let a particle fall toward Schwarzschild’s horizon in r and t, never reaching it', () => {
    for (const L of ['', ', 30']) {
      const { pts, ended } = traced([...SCHWARZSCHILD_RT, `geodesic((6, 0), (0, 1)${L})`], box(-32, 32, -32, 32));
      expect(pts.length).toBeGreaterThan(10);
      for (const [x, y] of pts) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        expect(x).toBeGreaterThan(2);
      }
      // It creeps up the horizon as t runs on, to the box's edge.
      const [xe, ye] = pts.at(-1)!;
      expect(xe).toBeLessThan(2.1);
      expect(ye).toBeGreaterThan(20);
      expect(ended.problem).toBeUndefined();
    }
  });

  it('carry an infalling particle through Eddington–Finkelstein’s horizon to r → 0', () => {
    const { pts } = traced([...EDDINGTON, 'geodesic((6, 0), (0, 1))'], box(-32, 32, -32, 32));
    for (const [x, y] of pts) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    expect(pts.some(([x]) => x < 1.9)).toBe(true);
    const xe = pts.at(-1)![0];
    expect(xe).toBeGreaterThan(-1e-9);
    expect(xe).toBeLessThan(0.05);
    // Its proper time to r = 0 from rest at r = 6 is π (r³/8M)^½ ≈ 16.3.
    const timed = traced([...EDDINGTON, 'geodesic((6, 0), (0, 1), 100)'], box(-32, 32, -32, 32));
    expect(timed.ended.length).toBeGreaterThan(16);
    expect(timed.ended.length).toBeLessThan(16.4);
  });

  it('keep even outgoing light inside Eddington–Finkelstein’s horizon falling in', () => {
    // Outgoing (dr/dv = (1 − 2M/r)/2) from r = 1: nearest (0, 1).
    const { pts } = traced([...EDDINGTON, 'lightray((1, 0), (0, 1))'], box(-32, 32, -32, 32));
    expect(pts.length).toBeGreaterThan(10);
    for (let k = 1; k < pts.length; k++) expect(pts[k][0]).toBeLessThanOrEqual(pts[k - 1][0] + 1e-12);
    expect(pts.at(-1)![0]).toBeLessThan(0.05);
    // Outside, it escapes.
    const out = traced([...EDDINGTON, 'lightray((2.5, 0), (0, 1))'], box(-32, 32, -32, 32));
    expect(out.pts.at(-1)![0]).toBeGreaterThan(10);
    // And along dr/dv = (1 − 2M/r)/2 as it goes.
    const [x0, y0] = out.pts[0];
    const [x1, y1] = out.pts[3];
    expect((x1 - x0) / (y1 - y0)).toBeCloseTo((1 - 2 / 2.5) / 2, 2);
  });

  it('send lightray along a cone that closes at Schwarzschild’s horizon', () => {
    // Outgoing from r = 2.5, it climbs dr/dt = 1 − 2M/r.
    const { pts } = traced([...SCHWARZSCHILD_RT, 'lightray((2.5, 0), (1, 1))'], box(-32, 32, -32, 32));
    const [x0, y0] = pts[0];
    const [x1, y1] = pts[2];
    expect(angle([x1 - x0, y1 - y0])).toBeCloseTo(Math.atan2(1, 1 - 2 / 2.5), 2);
    expect(pts.at(-1)![0]).toBeGreaterThan(10);
  });
});

describe('review fixes', () => {
  /** The future cone of a document's metric at a point. */
  const futureAt = (rows: string[], x: number, y: number) => {
    const { spec, env } = cones([...rows, 'lightcones']);
    const g = metricValues(spec, env)(x, y)!;
    return futureCone(g[0][0], g[0][1], g[1][1], metricOrientation(spec.future, env)!(x, y))!;
  };

  it('takes a 2D metric Lorentzian anywhere as a spacetime diagram, mixed where it is a plane too', () => {
    const repros = [
      ['g = 0.1', 'ds^2 = -(1 + 2 g x) dy^2 + dx^2'],
      ['M = 1', 'ds^2 = -(1 - 2M/abs(x)) dy^2 + (1 + 2M/abs(x)) dx^2'],
      ['M = 1', 'ds^2 = -(1 - 2M/x) dy^2 + dx^2'],
      ['ds^2 = -(1 - x^2/100) dy^2 + dx^2'],
      ['ds^2 = -x dy^2 + dx^2'],
      ['ds^2 = -cos(x) dy^2 + dx^2'],
    ];
    for (const rows of repros) {
      const row = last(rows);
      expect(row.error, rows.join('; ')).toBeUndefined();
      expect(row.cls!.object, rows.join('; ')).toMatchObject({ kind: 'metric', n: 2, lorentzian: true, mixed: true });
      expect(plotReadout(row.cpu!, {})).toMatch(/^Metric of mixed signature in x, y/);
      expect(errorOf([...rows, 'lightcones'])).toBeUndefined();
      expect(errorOf([...rows, 'lightray((0.5, 0), (1, 1))'])).toBeUndefined();
    }
    // The uniform field: a particle at rest falls toward −x, a diagram's
    // geodesic, stopping before 1 + 2 g x reaches 0 at x = −5.
    const field = ['g = 0.1', 'ds^2 = -(1 + 2 g x) dy^2 + dx^2'];
    const fall = traced([...field, 'geodesic((0, 0), (0, 1))'], box(-32, 32, -32, 32));
    expect(fall.ended.problem).toBeUndefined();
    expect(fall.pts.length).toBeGreaterThan(10);
    expect(fall.pts.at(-1)![0]).toBeLessThan(-1);
    for (const [x] of fall.pts) expect(x).toBeGreaterThan(-5);
    const light = traced([...field, 'lightray((0, 0), (1, 1))'], box(-32, 32, -32, 32));
    expect(light.pts.length).toBeGreaterThan(10);
    // Where it is positive definite (x < −5), a geodesic runs as a plane's,
    // straight here, and stops where the signature changes; light has none.
    const plane = traced([...field, 'geodesic((-10, 0), (1, 0))'], box(-32, 32, -32, 32));
    for (const [, y] of plane.pts) expect(Math.abs(y)).toBeLessThan(1e-9);
    expect(plane.pts.at(-1)![0]).toBeLessThanOrEqual(-5 + 1e-6);
    expect(plane.pts.at(-1)![0]).toBeGreaterThan(-5.01);
    const none = traced([...field, 'lightray((-10, 0), (1, 1))'], box(-32, 32, -32, 32));
    expect(geodesicCutNote(none.ended)).toMatch(/positive definite at the start/);
    // Light cones only where it is Lorentzian.
    const { spec, env } = cones([...field, 'lightcones']);
    const glyphs = coneGlyphs(metricValues(spec, env), view(-12, 12, -8, 8), {
      orient: metricOrientation(spec.future, env),
    });
    for (let i = 0; i < glyphs.rings.length; i += 2)
      if (Number.isFinite(glyphs.rings[i])) expect(glyphs.rings[i]).toBeGreaterThan(-5.5);
    expect(glyphs.rings.length).toBeGreaterThan(0);
  });

  it('orients cones by the metric’s own time, wherever it is drawn', () => {
    // Time along x: the future is +x.
    expect(futureAt(['ds^2 = -dx^2 + dy^2'], 1, 1).axis).toBeCloseTo(0, 12);
    expect(futureAt(['ds^2 = -dy^2 + dx^2'], 1, 1).axis).toBeCloseTo(Math.PI / 2, 12);
    // Schwarzschild with t along x and r along y: +x outside; inside, the
    // cones lie along r and the future is smaller r.
    const sideways = ['M = 1', 'ds^2 = -(1 - 2M/y) dx^2 + dy^2/(1 - 2M/y)'];
    expect(futureAt(sideways, 0, 5).axis).toBeCloseTo(0, 9);
    expect(futureAt(sideways, 0, 1).axis).toBeCloseTo(-Math.PI / 2, 9);
    // Eddington–Finkelstein with v along x: v increases on every future
    // cone, and the cones turn smoothly through the horizon y = 2M.
    const ef = ['M = 1', 'ds^2 = -(1 - 2M/y) dx^2 + 2 dx dy'];
    let before = NaN;
    for (let r = 6; r > 0.05; r -= 0.05) {
      const cone = futureAt(ef, 0, r);
      const edges = [cone.axis - cone.half, cone.axis + cone.half];
      // One edge is the ingoing ray, −y; the other has v increasing.
      expect(Math.min(...edges.map(e => Math.abs(Math.sin(e) + 1)))).toBeLessThan(1e-9);
      expect(Math.cos(cone.axis)).toBeGreaterThan(0);
      if (Number.isFinite(before)) expect(Math.abs(cone.axis - before)).toBeLessThan(0.1);
      before = cone.axis;
    }
    // The original orientations stay: Schwarzschild in r, t and EF in r, v.
    expect(futureAt(SCHWARZSCHILD_RT, 4, 0).axis).toBeCloseTo(Math.PI / 2, 9);
    expect(Math.abs(futureAt(SCHWARZSCHILD_RT, 1, 0).axis)).toBeCloseTo(Math.PI, 9);
    expect(Math.sin(futureAt(EDDINGTON, 1, 0).axis)).toBeGreaterThan(0);
    // Declared coordinates: time T = -x/2 runs toward −x.
    expect(Math.abs(futureAt(['T = -x/2', 'X = y', 'ds^2 = -dT^2 + dX^2'], 1, 1).axis)).toBeCloseTo(Math.PI, 9);
  });

  it('leaves out the ellipses inside a spinning hole’s inner horizon', () => {
    const { spec, env } = cones([...kerr(0.95), 'lightcones']);
    const read = metricValues(spec, env);
    // r₋ = 1 − √(1 − 0.95²) ≈ 0.688: inside it x and y are space again.
    expect(indicatrix(read(0.25, 0.25)!)).not.toBeNull();
    const v = view(-3.2, 3.2, -2.4, 2.4);
    const cut = behindHorizon(read, v);
    expect(cut(0.25, 0.25)).toBe(true);
    expect(cut(2.5, 0.5)).toBe(false);
    const glyphs = coneGlyphs(read, v);
    expect(glyphs.dots.length).toBeGreaterThan(0);
    for (let i = 0; i < glyphs.dots.length; i += 2)
      expect(Math.hypot(glyphs.dots[i], glyphs.dots[i + 1])).toBeGreaterThan(1.3);
    // Schwarzschild has no inside to cut off.
    const s = cones([...SCHWARZSCHILD, 'lightcones']);
    const plain = behindHorizon(metricValues(s.spec, s.env), v);
    expect(plain(2.5, 0.5)).toBe(false);
  });

  it('draws a lone indicatrix at its own scale when none is in view, and shares a family’s metric', () => {
    const { spec, env } = cones([...SCHWARZSCHILD, 'lightcone((10, 0))']);
    const read = metricValues(spec, env);
    // A window wholly inside the horizon: no lattice ellipse, no κ.
    const inside = view(-1, 1, -0.75, 0.75);
    expect(indicatrixScale(read, inside)).toBeNaN();
    const lone = coneGlyphs(read, inside, { at: [[10, 0]], kappa: NaN });
    expect(lone.dots).toEqual([10, 0]);
    expect(lone.rings.length).toBeGreaterThan(0);
    // The lattice draws nothing there.
    expect(coneGlyphs(read, inside).rings).toEqual([]);
    const fan = last([...SCHWARZSCHILD, 'lightcone(([3..8], 0))']).cls!.object;
    if (fan.kind !== 'family') throw new Error(fan.kind);
    const comps = fan.members.map(m => (m.object.kind === 'lightcone' ? m.object.components : null));
    expect(new Set(comps).size).toBe(1);
  });
});
