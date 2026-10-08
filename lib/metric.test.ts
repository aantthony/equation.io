import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import { plotReadout } from './plot.ts';
import {
  type GeodesicEnd,
  type GeodesicOptions,
  christoffelOfMetric,
  geodesicCutNote,
  geodesicPath,
  geodesicPlanKey,
  metricAcceleration,
  metricAt,
  smoothPartial,
  traceWindow,
} from './surface-geometry.ts';

/** A plane panel's own metric (lib/metric.ts) and its geodesics. */

const SCHWARZSCHILD = [
  'M = 1',
  'r = sqrt(x^2 + y^2)',
  'phi = atan2(y, x)',
  'ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2',
];
const POINCARE = 'ds^2 = (dx^2 + dy^2)/y^2';

const last = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!;
const errorOf = (rows: string[]) => last(rows).error;

type Window = GeodesicOptions['domain'];
const box = (half: number): Window => [
  [-half, half],
  [-half, half],
];

/** The points a document's last row draws (member `member` of a family),
 *  as [x, y], traced over `window`, and how it ended. */
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

/** The angles (unwound) at which a path round the origin is nearest to it,
 *  each refined by the parabola through the nearest three points. */
function periapses(pts: readonly [number, number][]): number[] {
  const rs = pts.map(([x, y]) => Math.hypot(x, y));
  let turned = 0;
  const phis = pts.map(([x, y], k) => {
    if (k) {
      let d = Math.atan2(y, x) - Math.atan2(pts[k - 1][1], pts[k - 1][0]);
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      turned += d;
    }
    return turned + Math.atan2(pts[0][1], pts[0][0]);
  });
  const out: number[] = [];
  for (let k = 1; k + 1 < rs.length; k++) {
    if (!(rs[k] < rs[k - 1] && rs[k] <= rs[k + 1])) continue;
    // r as a parabola in φ through the three points; its vertex.
    const [a, b, c] = [phis[k - 1], phis[k], phis[k + 1]];
    const [ra, rb, rc] = [rs[k - 1], rs[k], rs[k + 1]];
    const den = (a - b) * (a - c) * (b - c);
    const A = (c * (rb - ra) + b * (ra - rc) + a * (rc - rb)) / den;
    const B = (c * c * (ra - rb) + b * b * (rc - ra) + a * a * (rb - rc)) / den;
    out.push(A > 0 ? -B / (2 * A) : b);
  }
  return out;
}

describe('ds^2 rows', () => {
  it('give the panel a metric, read out and drawn as nothing', () => {
    const p = last([POINCARE]);
    expect(p.error).toBeUndefined();
    expect(p.cls!.object).toMatchObject({ kind: 'metric', n: 2, coords: ['x', 'y'] });
    expect(p.cpu).toMatchObject({ type: 'metric' });
    expect(plotReadout(p.cpu!, {})).toMatch(/^Riemannian metric in x, y/);
    const s = last(SCHWARZSCHILD);
    expect(s.error).toBeUndefined();
    expect(s.cls!.object).toMatchObject({ kind: 'metric', n: 3, coords: ['t', 'r', 'phi'] });
    expect(plotReadout(s.cpu!, {})).toMatch(/^Lorentzian metric in t; r, phi/);
    // ds² with a superscript, and a θ written as a letter.
    expect(last(['ds² = dx^2 + dy^2']).cls!.object).toMatchObject({ kind: 'metric' });
    expect(last(['r = sqrt(x^2 + y^2)', 'θ = atan2(y, x)', 'ds^2 = dr^2 + r^2 dθ^2']).cls!.object).toMatchObject({
      kind: 'metric',
      coords: ['r', 'θ'],
    });
  });

  it('pull the metric back to x and y through the coordinates’ Jacobian', () => {
    // Polar coordinates' flat metric is the plane's: g_xy = identity.
    const analysis = analyzeRows([
      'r = sqrt(x^2 + y^2)',
      'phi = atan2(y, x)',
      'ds^2 = dr^2 + r^2 dphi^2',
      'geodesic((1, 2), (1, 0))',
    ]);
    const o = analysis.rows.at(-1)!.cls!.object;
    if (o.kind !== 'geodesic' || !o.metric) throw new Error(o.kind);
    const flat = metricAt(o.metric, {}, 0.7, -1.3);
    expect(flat.g[0][0]).toBeCloseTo(1, 12);
    expect(flat.g[0][1]).toBeCloseTo(0, 12);
    expect(flat.g[1][1]).toBeCloseTo(1, 12);
    // …and so are its derivatives.
    for (const m of flat.d) for (const row of m) for (const v of row) expect(v).toBeCloseTo(0, 10);
    // A cross term dt dphi (a rotating frame) becomes g_tx and g_ty.
    const rotating = analyzeRows([
      'k = 0.1',
      'r = sqrt(x^2 + y^2)',
      'phi = atan2(y, x)',
      'ds^2 = -(1 - k^2 r^2) dt^2 + 2 k r^2 dt dphi + dr^2 + r^2 dphi^2',
      'geodesic((1, 2), (0.1, 0))',
    ]);
    const spun = rotating.rows.at(-1)!;
    if (spun.error) throw new Error(spun.error);
    const o2 = spun.cls!.object;
    if (o2.kind !== 'geodesic' || !o2.metric) throw new Error(o2.kind);
    const { g, d } = metricAt(o2.metric, { k: 0.1 }, 3, 4);
    const [gtt, gtx, gty] = g[0];
    // g_tφ = k r², and dφ = (x dy − y dx)/r²: g_tx = −k y, g_ty = k x.
    expect(gtt).toBeCloseTo(-(1 - 0.01 * 25), 12);
    expect(gtx).toBeCloseTo(-0.1 * 4, 12);
    expect(gty).toBeCloseTo(0.1 * 3, 12);
    // ∂g_tt/∂x = 2 k² x, ∂g_ty/∂x = k, against central differences.
    expect(d[0][0][0]).toBeCloseTo(2 * 0.01 * 3, 10);
    expect(d[0][0][2]).toBeCloseTo(0.1, 10);
    const h = 1e-5;
    const [ga, gb] = [metricAt(o2.metric, { k: 0.1 }, 3, 4 + h).g, metricAt(o2.metric, { k: 0.1 }, 3, 4 - h).g];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) expect(d[1][i][j]).toBeCloseTo((ga[i][j] - gb[i][j]) / (2 * h), 6);
  });

  it('say what is wrong with a metric', () => {
    expect(errorOf(['ds^2 = dx^2'])).toMatch(/both of the panel's coordinates.*only dx/);
    expect(errorOf(['ds^2 = -dt^2 + dw^2 + dx^2 + dy^2'])).toMatch(/at most one more.*dt, dw|dw, dt/);
    expect(errorOf(['r = sqrt(x^2 + y^2)', 'ds^2 = dr^2 + dx^2 + dy^2'])).toMatch(/two of the panel's coordinates/);
    expect(errorOf(['ds^2 = -(1 + t) dt^2 + dx^2 + dy^2'])).toMatch(/depends on t: metrics that change with time/);
    expect(errorOf(['ds^2 = -dw^2 + w dx^2 + dy^2'])).toMatch(/depends on w: .* must be cyclic/);
    expect(errorOf(['ds^2 = dx^3 + dy^2'])).toMatch(/quadratic form/);
    expect(errorOf(['ds^2 = dx^2 + dy^2 + dx'])).toMatch(/quadratic form/);
    expect(errorOf(['ds^2 = dx^2 + dy^2 + 1'])).toMatch(/quadratic form/);
    expect(errorOf(['ds^2 = -dx^2 + dy^2'])).toMatch(/positive for every direction/);
    expect(errorOf(['ds^2 = dt^2 + dx^2 + dy^2'])).toMatch(/t must be a time/);
    expect(errorOf(['ds^2 = -dt^2 - dx^2 + dy^2'])).toMatch(/one minus sign, for dt/);
    expect(errorOf(['r = sqrt(x^2 + y^2)', 's = 2r', 'ds^2 = dr^2 + ds^2'])).toBeDefined();
    expect(errorOf(['r = sqrt(x^2 + y^2)', 's = 2r', 'ds^2 = dr^2 + r^2 ds^2'])).toMatch(/Jacobian/);
    expect(errorOf(['a = 2', 'ds^2 = da^2 + dx^2 + dy^2'])).toMatch(/a is not a coordinate/);
    expect(errorOf(['ds^2 = q dx^2 + dy^2'])).toMatch(/Unknown variable: q/);
    // One a panel; and not on a surface's panel, which has its metric.
    expect(errorOf([POINCARE, 'ds^2 = dx^2 + dy^2'])).toMatch(/already has a metric/);
    expect(errorOf([POINCARE, '---', 'ds^2 = dx^2 + dy^2'])).toBeUndefined();
    expect(errorOf(['on((X, Y, Z) = (x, y, x y), x = -1..1, y = -1..1)', 'ds^2 = dx^2 + dy^2'])).toMatch(
      /drawn on a surface/,
    );
  });

  it('leave other names starting with d as they were', () => {
    expect(last(['d/dx x^2']).cls!.object.kind).toBe('scalar-field');
    expect(last(['dr = 3', 'y = dr x']).error).toBeUndefined();
    // A slider named dr is still one beside a metric in polar coordinates,
    // where dr in the ds^2 row is r's differential.
    const rows = ['dr = 3', 'r = sqrt(x^2 + y^2)', 'phi = atan2(y, x)', 'ds^2 = dr^2 + r^2 dphi^2', 'y = dr x'];
    expect(analyzeRows(rows).rows.map(r => r.error)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(last(['y = int[0..x] t dt']).error).toBeUndefined();
    // A document's own ds is no metric.
    expect(last(['ds = 2', 'ds^2 = 4']).cls!.object.kind).toBe('note');
  });
});

describe('geodesic and lightray rows under a metric', () => {
  it('say what they need', () => {
    expect(errorOf(['lightray((1, 2), (1, 0))'])).toMatch(/this panel has none/);
    expect(errorOf([POINCARE, 'lightray((1, 2), (1, 0))'])).toMatch(/lightray needs a spacetime/);
    expect(errorOf(['ds^2 = dx^3 + dy^2', 'geodesic((1, 2), (1, 0))'])).toMatch(
      /metric \(its ds\^2 row\) has an error/,
    );
    expect(errorOf([...SCHWARZSCHILD, '2 lightray((10, 0), (0, 1))'])).toMatch(/whole row/);
    expect(errorOf([...SCHWARZSCHILD, 'lightray((10, 0), 1)'])).toMatch(/a pair/);
    expect(errorOf([...SCHWARZSCHILD, 'geodesic((10, x), (0, 1))'])).toMatch(/, not x/);
    // A metric belongs to its own panel.
    expect(errorOf([POINCARE, '---', 'geodesic((0, 1), (1, 0))'])).toMatch(/this panel has neither/);
  });

  it('follow the Poincaré half-plane’s geodesics: half-circles on the boundary', () => {
    const { pts, ended, object } = traced([POINCARE, 'geodesic((0, 1), (1, 0))'], box(4));
    expect(object).toMatchObject({ dim: 2, metric: { n: 2, motion: 'riemannian' } });
    for (const [x, y] of pts) expect(Math.abs(x * x + y * y - 1)).toBeLessThan(1e-6);
    // It runs toward (1, 0) on the boundary, at infinite distance, and stops
    // once it makes no headway there.
    const [xe, ye] = pts.at(-1)!;
    expect(xe).toBeGreaterThan(0.999);
    expect(ye).toBeLessThan(1e-3);
    expect(ended.budget).toBe(false);
    expect(geodesicCutNote(ended)).toBeNull();
    // Its length is hyperbolic: from (0, 1), artanh(x) along the circle.
    const L = traced([POINCARE, 'geodesic((0, 1), (1, 0), 1)'], box(4)).pts.at(-1)!;
    expect(L[0]).toBeCloseTo(Math.tanh(1), 6);
  });

  it('hold a circular orbit round a black hole: coordinate speed sqrt(M/r)', () => {
    const { pts, object } = traced([...SCHWARZSCHILD, 'geodesic((10, 0), (0, sqrt(1/10)), 1000)'], box(64));
    expect(object).toMatchObject({ metric: { n: 3, motion: 'timelike', time: 't' } });
    for (const [x, y] of pts) expect(Math.abs(Math.hypot(x, y) - 10)).toBeLessThan(1e-4);
    // Proper time 1000 at dτ/dt = sqrt(1 − 3M/r): t = 1195, ω = sqrt(M/r³).
    let turned = 0;
    for (let k = 1; k < pts.length; k++) {
      let d = Math.atan2(pts[k][1], pts[k][0]) - Math.atan2(pts[k - 1][1], pts[k - 1][0]);
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      turned += d;
    }
    expect(turned).toBeCloseTo((1000 / Math.sqrt(0.7)) * Math.sqrt(1 / 1000), 4);
  });

  it('precess: a near-circular orbit’s periapsis moves on by 2π((1 − 6M/r)^−½ − 1) an orbit', () => {
    // At r = 20 that is 1.227 rad, against 6πM/r = 0.942 to first order in
    // M/r; far out the two agree.
    for (const [r0, L, exact, firstOrder] of [
      [20, 6000, 2 * Math.PI * (1 / Math.sqrt(1 - 6 / 20) - 1), (6 * Math.PI) / 20],
      [200, 60000, 2 * Math.PI * (1 / Math.sqrt(1 - 6 / 200) - 1), (6 * Math.PI) / 200],
    ]) {
      const v = Math.sqrt(1 / r0) * 1.002;
      const { pts } = traced([...SCHWARZSCHILD, `geodesic((${r0}, 0), (0, ${v}), ${L})`], box(4 * r0));
      const at = periapses(pts);
      expect(at.length).toBeGreaterThanOrEqual(2);
      const shift = (at.at(-1)! - at[0]) / (at.length - 1) - 2 * Math.PI;
      expect(Math.abs(shift / exact - 1)).toBeLessThan(0.01);
      if (r0 === 200) expect(Math.abs(shift / firstOrder - 1)).toBeLessThan(0.04);
    }
  });

  it('keeps a light ray on the photon sphere r = 3M for a while', () => {
    const { pts, object } = traced([...SCHWARZSCHILD, 'lightray((3, 0), (0, 1), 80)'], box(16));
    expect(object).toMatchObject({ metric: { motion: 'null' } });
    // Unstable: it leaves in the end, but holds for one and a half turns.
    let turned = 0;
    for (let k = 1; k < pts.length && turned < 3 * Math.PI; k++) {
      let d = Math.atan2(pts[k][1], pts[k][0]) - Math.atan2(pts[k - 1][1], pts[k - 1][0]);
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      turned += d;
      expect(Math.abs(Math.hypot(...pts[k]) - 3)).toBeLessThan(1e-3);
    }
    expect(turned).toBeGreaterThanOrEqual(3 * Math.PI);
  });

  it('bends a passing light ray by about 4M/b', () => {
    const b = 200;
    const { pts } = traced([...SCHWARZSCHILD, `lightray((-4000, ${b}), (1, 0))`], box(8192));
    const [x1, y1] = pts.at(-2)!;
    const [x2, y2] = pts.at(-1)!;
    const bent = -Math.atan2(y2 - y1, x2 - x1);
    // 4M/b, with (15π/4)(M/b)² more, a little less from ±4000 than from ±∞.
    expect(Math.abs(bent / (4 / b) - 1)).toBeLessThan(0.03);
    expect(bent).toBeGreaterThan(4 / b);
  });

  it('draws a fan of light rays, those within 3√3 M falling in at the horizon', () => {
    const rows = [...SCHWARZSCHILD, 'b = [-6..6]', 'lightray((-30, b), (1, 0))'];
    const r = last(rows);
    expect(r.cls!.object.kind).toBe('family');
    for (let k = 0; k < 13; k++) {
      const b = k - 6;
      const { pts, ended } = traced(rows, box(64), k);
      const end = Math.hypot(...pts.at(-1)!);
      if (Math.abs(b) < 3 * Math.sqrt(3)) expect(end).toBeLessThan(2.01);
      else expect(end).toBeGreaterThan(60);
      expect(geodesicCutNote(ended)).toBeNull();
    }
  });

  it('refuses a particle faster than light, saying how fast it may go', () => {
    const { pts, ended } = traced([...SCHWARZSCHILD, 'geodesic((10, 0), (0, 1))'], box(64));
    expect(pts).toEqual([[10, 0]]);
    // Across the line of sight at r = 10: sqrt(1 − 2M/r) = 0.894.
    expect(geodesicCutNote(ended)).toBe('faster than light here: at most ≈ 0.894 in this direction');
    // Released from rest it falls in.
    const fall = traced([...SCHWARZSCHILD, 'geodesic((10, 0), (0, 0))'], box(64)).pts;
    expect(Math.hypot(...fall.at(-1)!)).toBeLessThan(2.01);
  });

  it('change their plan key with an edit to the metric', () => {
    const key = (metric: string) => {
      const o = last(['r = sqrt(x^2 + y^2)', 'phi = atan2(y, x)', metric, 'lightray((10, 0), (0, 1))']).cls!.object;
      if (o.kind !== 'geodesic') throw new Error(o.kind);
      return geodesicPlanKey(o);
    };
    const a = key('ds^2 = -(1 - 2/r) dt^2 + dr^2/(1 - 2/r) + r^2 dphi^2');
    expect(key('ds^2 = -(1 - 2/r) dt^2 + dr^2/(1 - 2/r) + r^2 dphi^2')).toBe(a);
    expect(key('ds^2 = -(1 - 3/r) dt^2 + dr^2/(1 - 3/r) + r^2 dphi^2')).not.toBe(a);
  });
});

describe('the connection of a metric', () => {
  it('is formed from g and its derivatives as christoffelOfMetric writes it', () => {
    // A metric in t, x, y with every component, depending on x and y.
    const src = [
      ['-(1 - 1/(x^2 + y^2 + 3))', '0.1 y', '-0.2 x'],
      ['0.1 y', '1 + x^2/5', '0.1 x y'],
      ['-0.2 x', '0.1 x y', '2 + sin(y)'],
    ];
    const g: Expr[][] = src.map(row => row.map(e => parseExpr(e)));
    const coords = ['t', 'x', 'y'];
    const symbols = christoffelOfMetric(g, coords, smoothPartial);
    const at = { x: 0.4, y: -0.7 };
    const num = g.map(row => row.map(e => evaluate(e, at)));
    const d = ['x', 'y'].map(v => g.map(row => row.map(e => evaluate(smoothPartial(e, v), at))));
    const U = [1.3, -0.4, 0.6];
    const [, ax, ay] = metricAcceleration(num, d, U);
    const want = [1, 2].map(i => {
      let sum = 0;
      for (let m = 0; m < 3; m++) for (let n = 0; n < 3; n++) sum -= evaluate(symbols[i][m][n], at) * U[m] * U[n];
      return sum;
    });
    expect(ax).toBeCloseTo(want[0], 10);
    expect(ay).toBeCloseTo(want[1], 10);
  });
});

describe('traceWindow', () => {
  it('holds the window well inside, and stays put through small pans and zooms', () => {
    const w = traceWindow([-10, -6], [10, 6]);
    expect(w[0][0]).toBeLessThanOrEqual(-10 - 20);
    expect(w[0][1]).toBeGreaterThanOrEqual(10 + 20);
    expect(traceWindow([-9, -6], [11, 6])).toEqual(w);
    expect(traceWindow([-11, -7], [11, 7])).toEqual(w);
    expect(traceWindow([-40, -6], [40, 6])).not.toEqual(w);
  });
});
describe('review fixes', () => {
  it('traces a ray that starts outside the window it is drawn in (zoomed in on the hole)', () => {
    const window = traceWindow([-2, -1.5], [2, 1.5]);
    const { pts } = traced([...SCHWARZSCHILD, 'lightray((-30, 1), (1, 0))'], window);
    expect(pts[0]).toEqual([-30, 1]);
    // It reaches the window and falls in there.
    expect(pts.some(([x, y]) => Math.abs(x) < 2 && Math.abs(y) < 1.5)).toBe(true);
    expect(Math.hypot(...pts.at(-1)!)).toBeLessThan(2.01);
    // One passing wide still bends and leaves.
    const wide = traced([...SCHWARZSCHILD, 'lightray((-30, 7), (1, 0))'], window).pts;
    expect(wide.at(-1)![0]).toBeGreaterThan(window[0][1] - 1e-9);
  });

  it('checks metrics at large and small scales', () => {
    const heavy = ['M = 40', ...SCHWARZSCHILD.slice(1)];
    expect(errorOf(heavy)).toBeUndefined();
    const v = Math.sqrt(40 / 400);
    const { pts } = traced([...heavy, `geodesic((400, 0), (0, ${v}), 20000)`], box(1024));
    for (const p of pts) expect(Math.abs(Math.hypot(...p) - 400)).toBeLessThan(0.05);
    expect(errorOf(['ds^2 = (dx^2 + dy^2)/(0.01 - x^2 - y^2)'])).toBeUndefined();
    const disc = traced(['ds^2 = (dx^2 + dy^2)/(0.01 - x^2 - y^2)', 'geodesic((0, 0), (1, 0.3))'], box(0.25)).pts;
    expect(disc.length).toBeGreaterThan(10);
    for (const p of disc) expect(Math.hypot(...p)).toBeLessThan(0.1);
  });

  it('lets a particle go from nearly at rest', () => {
    for (const speed of ['10^-9', '10^-12', '0']) {
      const { pts } = traced([...SCHWARZSCHILD, `geodesic((10, 0), (0, ${speed}))`], box(64));
      expect(Math.hypot(...pts.at(-1)!)).toBeLessThan(2.01);
    }
  });

  describe('a spinning black hole (Kerr, in its equatorial plane)', () => {
    // M = 1, a = 0.9: the horizon is at r = 1 + sqrt(1 − a²) = 1.436, the
    // ergosurface, where g_tt = 0, at r = 2.
    const KERR = [
      'a = 0.9',
      'r = sqrt(x^2 + y^2)',
      'phi = atan2(y, x)',
      'ds^2 = -(1 - 2/r) dt^2 - (4a/r) dt dphi + r^2/(r^2 - 2r + a^2) dr^2 + (r^2 + a^2 + 2a^2/r) dphi^2',
    ];
    const horizon = 1 + Math.sqrt(1 - 0.81);
    it('traces into the ergoregion, down to the horizon', () => {
      expect(errorOf(KERR)).toBeUndefined();
      const { pts } = traced([...KERR, 'lightray((10, 0), (-1, 0))'], box(16));
      const end = Math.hypot(...pts.at(-1)!);
      expect(end).toBeLessThan(horizon + 0.05);
      expect(end).toBeGreaterThan(horizon - 0.01);
      // Dragged round with the hole as it falls.
      const turned = Math.atan2(pts.at(-1)![1], pts.at(-1)![0]);
      expect(Math.abs(turned)).toBeGreaterThan(0.1);
    });
    it('starts light in the ergoregion, but nothing standing still', () => {
      const ray = traced([...KERR, 'lightray((1.9, 0), (0, 1), 2)'], box(16));
      expect(ray.ended.problem).toBeUndefined();
      expect(ray.pts.length).toBeGreaterThan(5);
      const still = traced([...KERR, 'geodesic((1.9, 0), (0, 0))'], box(16));
      expect(geodesicCutNote(still.ended)).toMatch(/nothing can stand still here \(inside an ergoregion/);
      const inside = traced([...KERR, 'geodesic((1.2, 0), (0, 0.1))'], box(16));
      expect(geodesicCutNote(inside.ended)).toMatch(/not space at the start \(inside a horizon\?\)/);
    });
  });

  it('reads dt as a differential beside a dt slider, and says when a d-name is a value', () => {
    expect(errorOf(['dt = 0.1', ...SCHWARZSCHILD])).toBeUndefined();
    expect(errorOf(['dw = 2', 'ds^2 = -dw^2 + dx^2 + dy^2'])).toMatch(
      /quadratic form.*dw is defined elsewhere in the document, so it is that value here/,
    );
  });

  it('says what a metric’s differentials need', () => {
    expect(errorOf(['M = 1', 'ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2'])).toMatch(
      /dr, dphi are differentials of no coordinate yet: define r and phi from x and y first/,
    );
    expect(last(['ds^2 = -dτ^2 + dx^2 + dy^2']).cls!.object).toMatchObject({ kind: 'metric', coords: ['τ', 'x', 'y'] });
    expect(errorOf(['ds^2 = dpi^2 + dx^2 + dy^2'])).toMatch(/dpi is no differential — pi is a constant/);
    expect(errorOf(['ds^2 = de^2 + dx^2 + dy^2'])).toMatch(/de is no differential — e is a constant/);
  });
});
