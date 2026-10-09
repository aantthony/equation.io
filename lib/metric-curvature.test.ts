import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import {
  type GainClock,
  GAIN_FINE_MS,
  fineInterval,
  brioschi,
  curvatureFloor,
  curvatureGain,
  gainRead,
  isRealCurvature,
} from './metric-curvature.ts';
import { divergingGain } from './surface-geometry.ts';
import { plotReadout } from './plot.ts';

/** gaussian(x, y) on a plane panel with a metric (lib/metric-curvature.ts). */

const POLAR = ['r = sqrt(x^2 + y^2)', 'phi = atan2(y, x)'];
const HALF_PLANE = 'ds^2 = (dx^2 + dy^2)/y^2';
const DISK = 'ds^2 = 4(dx^2 + dy^2)/(1 - x^2 - y^2)^2';
const SPHERE = 'ds^2 = 4(dx^2 + dy^2)/(1 + x^2 + y^2)^2';
const SCHWARZSCHILD = ['M = 1', ...POLAR, 'ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2'];

const analyze = (rows: string[]) => {
  const analysis = analyzeRows(rows, { readouts: true });
  return { r: analysis.rows.at(-1)!, env: { ...analysis.constEnv, t: 0 } };
};
const errorOf = (rows: string[]) => analyze(rows).r.error;

/** The value a row reads out, as a number. */
function value(rows: string[]): number {
  const { r, env } = analyze(rows);
  if (r.error) throw new Error(r.error);
  const o = r.cls!.object;
  if (o.kind !== 'value') throw new Error(o.kind);
  return evaluate(o.expr, env);
}

/** gaussian(x, y)'s field, as a function of x and y, and its object. */
function field(rows: string[]) {
  const { r, env } = analyze([...rows, 'gaussian(x, y)']);
  if (r.error) throw new Error(r.error);
  const o = r.cls!.object;
  if (o.kind !== 'scalar-field') throw new Error(o.kind);
  return {
    K: (x: number, y: number) => evaluate(o.expr, { ...env, x, y }),
    size: (x: number, y: number) => evaluate(o.rounding!, { ...env, x, y }),
    object: o,
    cpu: r.cpu,
  };
}

const POINTS: [number, number][] = [
  [0.3, 0.2],
  [-0.5, 0.4],
  [0.1, -0.7],
  [2, 3],
  [-4, 0.5],
];

describe('gaussian(x, y) under a ds^2 metric', () => {
  it('is −1 all over the Poincaré half-plane', () => {
    const { K, object, cpu } = field([HALF_PLANE]);
    expect(object.autoscale).toBe(true);
    expect(object.rounding).toBeDefined();
    expect(cpu).toMatchObject({ type: 'scalar2d', autoscale: true });
    expect(analyze([HALF_PLANE, 'gaussian(x, y)']).r.info).toBe(
      "the metric's Gaussian curvature K: row colour where K > 0, its complement where K < 0",
    );
    for (const [x, y] of POINTS) if (y > 0) expect(K(x, y)).toBeCloseTo(-1, 12);
    for (const y of [1e-3, 0.01, 1, 100, 1e4]) expect(K(0.7, y)).toBeCloseTo(-1, 10);
  });
  it('is −1 all over the Poincaré disk, and +1 on the stereographic sphere', () => {
    const disk = field([DISK]).K;
    const sphere = field([SPHERE]).K;
    for (const [x, y] of POINTS) {
      if (x * x + y * y < 1) expect(disk(x, y)).toBeCloseTo(-1, 10);
      expect(sphere(x, y)).toBeCloseTo(1, 10);
    }
    expect(disk(0.99, 0)).toBeCloseTo(-1, 8);
  });
  it('is taken in the coordinates the metric is written in', () => {
    // The sphere of radius 1 about a pole, and the flat plane, in polar
    // coordinates; and the same plane as dx^2 + dy^2.
    const round = field([...POLAR, 'ds^2 = dr^2 + sin(r)^2 dphi^2']).K;
    const flat = field([...POLAR, 'ds^2 = dr^2 + r^2 dphi^2']);
    for (const [x, y] of POINTS) {
      if (Math.hypot(x, y) < 3) expect(round(x, y)).toBeCloseTo(1, 10);
      expect(Math.abs(flat.K(x, y))).toBeLessThan(1e-12 * flat.size(x, y));
    }
    // Written in x and y, the flat plane's K is 0 outright: a number.
    expect(value(['ds^2 = dx^2 + dy^2', 'gaussian(x, y)'])).toBe(0);
    // A field built from the coordinates (f = 1 - 2M/r) is written in them.
    const f = field(['M = 1', ...POLAR, 'f = 1 - 2M/r', 'ds^2 = -f dt^2 + dr^2/f + r^2 dphi^2']).K;
    expect(f(3, 4)).toBeCloseTo(-1 / 125, 12);
  });
  it('is the curvature of space at one instant with a time: Flamm’s −M/r³', () => {
    const { K } = field(SCHWARZSCHILD);
    for (const [x, y] of [
      [3, 4],
      [-10, 0.5],
      [0, 2.5],
      [30, -40],
    ])
      expect(K(x, y)).toBeCloseTo(-1 / Math.hypot(x, y) ** 3, 12);
    expect(analyze([...SCHWARZSCHILD, 'gaussian(x, y)']).r.info).toMatch(
      /^the curvature of space at one instant \(K of the slice t = constant\)/,
    );
    // Inside the horizon the slice is not space: nothing there.
    expect(K(1, 0.5)).toBeNaN();
    const heavy = field(['M = 3', ...POLAR, 'ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2']).K;
    expect(heavy(6, 8)).toBeCloseTo(-3 / 1000, 12);
    // Cross terms in dt do not reach the slice: equatorial Kerr's is
    // dr^2/Δ·r^2 + (r^2 + a^2 + 2Ma^2/r) dphi^2, whatever its dt dphi.
    const kerr = field([
      'M = 1',
      'a = 0.6',
      ...POLAR,
      'ds^2 = -(1 - 2M/r) dt^2 - 4M a/r dt dphi + r^2/(r^2 - 2M r + a^2) dr^2 + (r^2 + a^2 + 2M a^2/r) dphi^2',
    ]).K;
    const slice = field([
      'M = 1',
      'a = 0.6',
      ...POLAR,
      'ds^2 = r^2/(r^2 - 2M r + a^2) dr^2 + (r^2 + a^2 + 2M a^2/r) dphi^2',
    ]).K;
    expect(kerr(3, 4)).toBeCloseTo(slice(3, 4), 12);
  });
  it('is pulled back to x and y when the metric mixes them with its coordinates', () => {
    const mixed = field(['M = 1', ...POLAR, 'ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/sqrt(x^2 + y^2)) + r^2 dphi^2']).K;
    expect(mixed(3, 4)).toBeCloseTo(-1 / 125, 8);
    expect(mixed(-6, 2)).toBeCloseTo(-1 / Math.hypot(6, 2) ** 3, 8);
  });
  it('moves with a slider', () => {
    const rows = (R: number) => [`R = ${R}`, 'ds^2 = 4R^2 (dx^2 + dy^2)/(1 + x^2 + y^2)^2'];
    expect(field(rows(2)).K(0.4, 0.3)).toBeCloseTo(0.25, 12);
    expect(field(rows(0.5)).K(0.4, 0.3)).toBeCloseTo(4, 12);
    expect(value([...rows(2), 'gaussian(1, 1)'])).toBeCloseTo(0.25, 12);
  });
  it('reads a number at a point', () => {
    const { r, env } = analyze([HALF_PLANE, 'gaussian(0.3, 2)']);
    expect(plotReadout(r.cpu!, env)).toBe('= -1');
    expect(value([DISK, 'P = (0.3, 0.5)', 'gaussian(P)'])).toBeCloseTo(-1, 12);
    expect(value([SPHERE, 'gaussian((1.3, 0.5))'])).toBeCloseTo(1, 12);
    expect(value([...SCHWARZSCHILD, 'gaussian(3, 4)'])).toBeCloseTo(-0.008, 12);
    // Inside other expressions, as a number of x and y.
    expect(value([HALF_PLANE, '2 gaussian(1, 1) + 1'])).toBeCloseTo(-1, 12);
  });
  it('reads only its own panel’s metric', () => {
    expect(errorOf([HALF_PLANE, '---', 'gaussian(x, y)'])).toMatch(
      /on\(…\) row, or its metric \(a ds\^2 row\), and this panel has neither/,
    );
    expect(field(['---', HALF_PLANE]).K(0, 1)).toBeCloseTo(-1, 12);
  });
  it('say what they need', () => {
    expect(errorOf(['gaussian(x, y)'])).toMatch(/or its metric \(a ds\^2 row\), and this panel has neither/);
    expect(errorOf(['gaussian(P)'])).toBeDefined();
    expect(errorOf(['ds^2 = dx^2 + dz', 'gaussian(x, y)'])).toBe("This panel's metric (its ds^2 row) has an error.");
    expect(errorOf(['ds^2 = -dx^2 - dy^2', 'gaussian(1, 2)'])).toBe("This panel's metric (its ds^2 row) has an error.");
    expect(errorOf([HALF_PLANE, 'meancurvature(x, y)'])).toMatch(
      /needs a surface in space; a metric \(this panel's ds\^2 row\) has a Gaussian curvature, gaussian\(x, y\), and no meancurvature/,
    );
    // Only a point is read under the metric: anything else is a surface.
    expect(errorOf([HALF_PLANE, 'gaussian(T)'])).toMatch(/T is not a surface — define one first/);
    // A surface of its own still reads as one there.
    expect(value([HALF_PLANE, 'S = (u, v, u^2 - v^2)', 'gaussian(S, 0, 0)'])).toBe(-4);
  });
});

describe('gaussian(x, y) on a spacetime diagram', () => {
  it('is K = R/2 where it is Lorentzian', () => {
    // Schwarzschild's (r, t) plane: 2M/r³.
    for (const M of [1, 3]) {
      const { K, cpu } = field([`M = ${M}`, 'ds^2 = -(1 - 2M/x) dy^2 + dx^2/(1 - 2M/x)']);
      expect(cpu).toMatchObject({ type: 'scalar2d' });
      for (const [x, y] of [
        [3 * M, 0],
        [10 * M, 4],
        [M, -2],
      ])
        expect(K(x, y)).toBeCloseTo((2 * M) / x ** 3, 10);
    }
    // In Eddington–Finkelstein's r and v too.
    expect(field(['M = 1', 'ds^2 = -(1 - 2M/x) dy^2 + 2 dy dx']).K(4, 1)).toBeCloseTo(2 / 64, 10);
    // Rindler is flat; de Sitter's static patch +1/L², anti-de Sitter's −1/L².
    expect(field(['ds^2 = -x^2 dy^2 + dx^2']).K(2, 1)).toBeCloseTo(0, 10);
    for (const L of [0.5, 2]) {
      const dS = field([`L = ${L}`, 'ds^2 = -(1 - x^2/L^2) dy^2 + dx^2/(1 - x^2/L^2)']).K;
      expect(dS(0.3 * L, 1)).toBeCloseTo(1 / L ** 2, 9);
      const AdS = field([`L = ${L}`, 'ds^2 = -(1 + x^2/L^2) dy^2 + dx^2/(1 + x^2/L^2)']).K;
      expect(AdS(1.7 * L, 1)).toBeCloseTo(-1 / L ** 2, 9);
    }
    expect(analyze(['ds^2 = -x^2 dy^2 + dx^2', 'gaussian(x, y)']).r.info).toMatch(
      /^the spacetime's curvature K = R\/2/,
    );
    expect(value(['M = 1', 'ds^2 = -(1 - 2M/x) dy^2 + dx^2/(1 - 2M/x)', 'gaussian(4, 0)'])).toBeCloseTo(2 / 64, 10);
  });

  it('is undefined where it degenerates, and the plane’s K where a mixed metric is positive definite', () => {
    // The weak-field uniform field -(1 + 2 g x) dy^2 + dx^2: Lorentzian for
    // x > −5, a plane beyond, degenerate at −5; K = g²/(1 + 2 g x)² on both
    // sides (it is not quite Rindler's -x^2 dy^2 + dx^2, which is flat).
    const { K } = field(['g = 0.1', 'ds^2 = -(1 + 2 g x) dy^2 + dx^2']);
    expect(K(0, 0)).toBeCloseTo(0.01, 10);
    expect(K(3, 0)).toBeCloseTo(0.01 / 1.6 ** 2, 10);
    expect(K(-10, 0)).toBeCloseTo(0.01, 10);
    expect(K(-5, 0)).toBeNaN();
    // -x dy^2 + dx^2: K = 1/(4x²), Lorentzian for x > 0 and a plane for x < 0.
    const mixed = field(['ds^2 = -x dy^2 + dx^2']).K;
    expect(mixed(2, 0)).toBeCloseTo(1 / 16, 10);
    expect(mixed(-2, 0)).toBeCloseTo(1 / 16, 10);
    expect(mixed(0, 0)).toBeNaN();
  });
});

describe('Brioschi’s formula', () => {
  const e = (s: string): Expr => parseExpr(s);
  const K = (E: string, F: string, G: string, params: [string, string], at: Record<string, number>) =>
    evaluate(brioschi(e(E), e(F), e(G), params).K, at);
  it('gives the Riemannian classics', () => {
    // The sphere of radius 2 in latitude and longitude, a torus, a plane.
    expect(K('4', '0', '4 cos(u)^2', ['u', 'v'], { u: 0.4, v: 1 })).toBeCloseTo(0.25, 12);
    expect(K('1', '0', '(2 + cos(u))^2', ['u', 'v'], { u: 0.3, v: 0 })).toBeCloseTo(
      Math.cos(0.3) / (2 + Math.cos(0.3)),
      12,
    );
    // A non-orthogonal form of the flat plane: (u + v, v) is a linear map.
    expect(K('1', '1', '2', ['u', 'v'], { u: 1, v: 2 })).toBe(0);
  });
  it('is K = R/2 for a 2D Lorentzian metric: positive de Sitter-like, negative anti-de Sitter-like', () => {
    // 2D Schwarzschild, -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r): R = 4M/r^3.
    for (const r of [3, 5, 12])
      expect(K('-(1 - 2/r)', '0', '1/(1 - 2/r)', ['t', 'r'], { t: 0, r })).toBeCloseTo(2 / r ** 3, 12);
    // Rindler, -x^2 dt^2 + dx^2, is flat.
    expect(K('-x^2', '0', '1', ['t', 'x'], { t: 0.3, x: 2 })).toBeCloseTo(0, 12);
    // de Sitter, -dt^2 + cosh(t)^2 dx^2: R = 2, K = 1, everywhere.
    for (const t of [-1, 0, 0.7]) expect(K('-1', '0', 'cosh(t)^2', ['t', 'x'], { t, x: 0.2 })).toBeCloseTo(1, 12);
    // Anti-de Sitter, -cosh(x)^2 dt^2 + dx^2: K = -1.
    for (const x of [-1, 0, 0.7]) expect(K('-cosh(x)^2', '0', '1', ['t', 'x'], { t: 0, x })).toBeCloseTo(-1, 12);
    // Off-diagonal: de Sitter in null-ish coordinates u = t, v = x - t.
    // -dt^2 + cosh(t)^2 dx^2 with dx = du + dv: E = cosh^2 - 1, F = cosh^2, G = cosh^2.
    expect(K('cosh(u)^2 - 1', 'cosh(u)^2', 'cosh(u)^2', ['u', 'v'], { u: 0.4, v: 0 })).toBeCloseTo(1, 12);
  });
});

type Box = [[number, number], [number, number]];
const box = (half: number): Box => [
  [-half, half],
  [-half, half],
];

/** The gain gaussian(x, y) (or `row`) is shaded with over ±half, as the
 *  app reads it, and its K and term size as functions. */
function gainOf(rows: string[], view: number | Box, row = 'gaussian(x, y)') {
  const window = typeof view === 'number' ? box(view) : view;
  const { r, env } = analyze([...rows, row]);
  if (r.error) throw new Error(r.error);
  const o = r.cls!.object;
  if (o.kind !== 'scalar-field' || !o.rounding) throw new Error(o.kind);
  const at = (e: Expr) => (x: number, y: number) => {
    try {
      return evaluate(e, { ...env, x, y });
    } catch {
      return NaN;
    }
  };
  const pulled = !!o.pulled;
  const K = at(o.expr);
  const size = at(o.rounding);
  return {
    gain: curvatureGain(K, size, window, { pulled }),
    K,
    size,
    /** Whether hover reads K at (x, y), or 0 (web/main.ts). */
    real: (x: number, y: number) => isRealCurvature(K(x, y), size(x, y), curvatureFloor(window, pulled)),
    pulled,
  };
}

describe('the gain gaussian(x, y) is shaded with', () => {
  it('is 0 for a flat metric, however it is written', () => {
    for (const rows of [
      [...POLAR, 'ds^2 = dr^2 + r^2 dphi^2'],
      // Pulled back to x and y: its terms are as small as its rounding.
      [...POLAR, 'ds^2 = dr^2 + (x^2 + y^2) dphi^2'],
      ['M = 0', ...POLAR, 'ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/sqrt(x^2 + y^2)) + r^2 dphi^2'],
    ]) {
      const { gain, real } = gainOf(rows, 16);
      expect(gain, rows.at(-1)).toBe(0);
      // And hover reads 0 there (web/main.ts): rounding, not curvature.
      expect(real(3, 4)).toBe(false);
    }
  });
  it('brings the typical size of a real K to 1.5', () => {
    expect(gainOf([HALF_PLANE], 4).gain).toBeCloseTo(1.5, 10);
    expect(gainOf([DISK], 0.5).gain).toBeCloseTo(1.5, 10);
    const { gain } = gainOf(SCHWARZSCHILD, 16);
    expect(gain).toBeGreaterThan(10);
    expect(gain).toBeLessThan(1000);
  });
  it('sees K where it is local, and does not saturate its tail', () => {
    // K = −6 at the centre, gone within r ≈ 3: in a ±16 view most samples
    // are its tail, real but tiny.
    const { gain, K } = gainOf([...POLAR, 'ds^2 = dr^2 + (r + r^3 exp(-r^2))^2 dphi^2'], 16);
    expect(K(1e-3, 1e-3)).toBeCloseTo(-6, 3);
    expect(gain).toBeGreaterThan(0);
    // At most 1.5 over a thousandth of the largest |K| sampled (≈ 5–6).
    expect(gain).toBeLessThanOrEqual(1.5 / (1e-3 * 4));
  });
  it('counts real samples only, and falls back where almost none are', () => {
    const domain = box(1);
    // Real only where p > 0: the typical size is that half's.
    const half = (p: number) => (p > 0 ? 2 : 1e-20);
    expect(divergingGain(half, domain, 0, { real: k => k > 1e-10, fallback: 0 })).toBeCloseTo(0.75, 12);
    // Real at a single sample (under 1% of them): the fallback.
    const spike = (p: number, q: number) => (Math.abs(p) < 0.04 && Math.abs(q) < 0.04 ? 1 : 0);
    expect(divergingGain(spike, domain, 0, { real: k => k > 0, fallback: 0 })).toBe(0);
    // Without `real`, as before: 1 where f is nowhere above the floor.
    expect(divergingGain(() => 1e-12, domain, 1e-9)).toBe(1);
    expect(divergingGain(() => NaN, domain, 0, { fallback: 0 })).toBe(0);
    // A thin tail: with `real` (a metric's K) the typical size is at least
    // a thousandth of the largest; a surface's gain (no `real`) is as #255
    // made it, the 90th percentile alone.
    const tail = (p: number, q: number) => (p * p + q * q < 0.01 ? 100 : 1e-9);
    expect(divergingGain(tail, domain, 0, { real: () => true })).toBeCloseTo(1.5 / 0.1, 10);
    expect(divergingGain(tail, domain) / 1.5e9).toBeCloseTo(1, 12);
  });
  it('shades −gaussian(x, y) and c gaussian(x, y) to their own size', () => {
    for (const row of ['-gaussian(x, y)', '3 gaussian(x, y)', 'gaussian(x, y) c', 'gaussian(x, y)/c']) {
      const { r } = analyze(['c = 2', HALF_PLANE, row]);
      expect(r.cls!.object, row).toMatchObject({ kind: 'scalar-field', autoscale: true });
    }
    expect(gainOf(['c = 2', HALF_PLANE], 4, '-gaussian(x, y)').gain).toBeCloseTo(1.5, 10);
    expect(gainOf(['c = 2', HALF_PLANE], 4, 'c gaussian(x, y)').gain).toBeCloseTo(0.75, 10);
    // Not a sum, nor a product with something in x and y.
    expect(analyze([HALF_PLANE, 'gaussian(x, y) + 1']).r.cls!.object).not.toMatchObject({ autoscale: true });
    expect(analyze([HALF_PLANE, 'gaussian(x, y) x']).r.cls!.object).not.toMatchObject({ autoscale: true });
  });
});

describe('the gain gaussian(x, y) is shaded with, further', () => {
  it('sees small K zoomed in far from the origin', () => {
    // K = −1e-9 at r = 1000, in a 0.2-wide window there.
    const far: Box = [
      [999.9, 1000.1],
      [-0.1, 0.1],
    ];
    const hole = gainOf(SCHWARZSCHILD, far);
    expect(hole.K(1000, 0) / -1e-9).toBeCloseTo(1, 6);
    expect(hole.gain).toBeGreaterThan(1e8);
    expect(hole.real(1000, 0.05)).toBe(true);
    // Pulled back to x and y, floored by the distance from the origin, not
    // the window's size.
    const mixed = gainOf(
      ['M = 1', ...POLAR, 'ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/sqrt(x^2 + y^2)) + r^2 dphi^2'],
      far,
    );
    expect(mixed.pulled).toBe(true);
    expect(mixed.gain).toBeGreaterThan(1e8);
    expect(mixed.real(1000, 0.05)).toBe(true);
    // A sphere of radius 2000 (K = 2.5e-7) in a window 0.002 wide.
    const sphere = gainOf(['R = 2000', 'ds^2 = 4R^2 (dx^2 + dy^2)/(1 + x^2 + y^2)^2'], 1e-3);
    expect(sphere.K(0, 0) / 2.5e-7).toBeCloseTo(1, 10);
    expect(sphere.gain * 2.5e-7).toBeCloseTo(1.5, 6);
    expect(sphere.real(5e-4, 0)).toBe(true);
    // In its own coordinates a K has no view floor; pulled back it has.
    expect(curvatureFloor(far, false)).toBe(0);
    expect(curvatureFloor(far) / 1e-15).toBeCloseTo(1, 3);
    expect(curvatureFloor(box(16)) / (1e-9 / 256)).toBeCloseTo(1, 10);
  });
  it('is read finely at least twice a second, even while t runs', () => {
    const clock: GainClock = { at: 0, fine: 0 };
    const view = box(16);
    // The first read is fine; then a costly metric (a fine read 60 ms)…
    expect(gainRead(clock, view, '0', 0)).toEqual({ read: true, fine: true, settle: false });
    Object.assign(clock, { box: view, values: '0', at: 0, fine: 0, cost: 60 });
    // …is not read again unchanged; as a value moves it is read coarsely,
    // at most every GAIN_THROTTLE_MS, and asks for a fine read once it
    // stands still.
    expect(gainRead(clock, view, '0', 50)).toEqual({ read: false, fine: false, settle: false });
    expect(gainRead(clock, view, '1', 50)).toEqual({ read: false, fine: false, settle: true });
    expect(gainRead(clock, view, '1', 130)).toEqual({ read: true, fine: false, settle: true });
    expect(gainRead({ ...clock, stale: true }, view, '1', 140).fine).toBe(true);
    // t moving every frame: fine reads still come every GAIN_FINE_MS (or
    // ten times their cost, if more).
    expect(fineInterval(60)).toBe(600);
    expect(fineInterval(5)).toBe(GAIN_FINE_MS);
    const c: GainClock = { box: view, values: '0', at: 0, fine: 0, cost: 60 };
    const fines: number[] = [];
    for (let now = 16; now <= 2000; now += 16) {
      const { read, fine } = gainRead(c, view, `${now}`, now);
      if (!read) continue;
      Object.assign(c, { values: `${now}`, at: now });
      if (fine) {
        c.fine = now;
        fines.push(now);
      }
    }
    expect(fines.length).toBeGreaterThanOrEqual(3);
    for (let k = 1; k < fines.length; k++) expect(fines[k] - fines[k - 1]).toBeLessThanOrEqual(fineInterval(60) + 16);
    for (let k = 1; k < fines.length; k++) expect(fines[k] - fines[k - 1]).toBeGreaterThanOrEqual(fineInterval(60));
    // A cheap metric (a fine read 5 ms) is read finely every time.
    const cheap: GainClock = { box: view, values: '0', at: 0, fine: 0, cost: 5 };
    expect(gainRead(cheap, view, '1', 130)).toEqual({ read: true, fine: true, settle: false });
    // The view moved by over a quarter: read at once.
    const moved: Box = [
      [-6, 26],
      [-16, 16],
    ];
    expect(gainRead({ ...clock, at: 100 }, moved, '1', 110).read).toBe(true);
  });
  it('says which colour is which under a negative factor', () => {
    expect(analyze([HALF_PLANE, '-gaussian(x, y)']).r.info).toBe(
      "the metric's Gaussian curvature K: row colour where K < 0, its complement where K > 0",
    );
    expect(analyze(['c = -2', HALF_PLANE, 'c gaussian(x, y)']).r.info).toMatch(/row colour where K < 0/);
    expect(analyze(['c = 2', HALF_PLANE, 'c gaussian(x, y)']).r.info).toMatch(/row colour where K > 0/);
  });
  it('leaves a surface’s gain (#255) as it was: the 90th percentile alone', () => {
    // A near-cone: its K is all at the tip, so the 90th percentile is far
    // below a thousandth of the largest — a broad wash, as on main.
    const { r, env } = analyze(['S = (u, v, sqrt(u^2 + v^2 + 0.0001))', 'gaussian(S)']);
    const o = r.cls!.object as { paint: Expr };
    const f = (u: number, v: number) => evaluate(o.paint, { ...env, u, v });
    const unit: Box = [
      [0, 1],
      [0, 1],
    ];
    const sizes: number[] = [];
    for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) sizes.push(Math.abs(f((i + 0.5) / 25, (j + 0.5) / 25)));
    sizes.sort((a, b) => a - b);
    const p90 = sizes[Math.floor(0.9 * (sizes.length - 1))];
    expect(p90).toBeLessThan(1e-3 * sizes.at(-1)!);
    expect(divergingGain(f, unit) * p90).toBeCloseTo(1.5, 12);
  });
  it('reads K at any point-valued expression', () => {
    expect(value([HALF_PLANE, 'P = (0.3, 1)', 'gaussian(P + (0, 1))'])).toBeCloseTo(-1, 12);
    expect(value([SPHERE, 'P = (0.3, 1)', 'gaussian(2P)'])).toBeCloseTo(1, 10);
  });
});
