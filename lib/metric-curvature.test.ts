import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import { brioschi } from './metric-curvature.ts';
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
    expect(errorOf(['ds^2 = dx^2 - dy^2', 'gaussian(1, 2)'])).toBe("This panel's metric (its ds^2 row) has an error.");
    expect(errorOf([HALF_PLANE, 'meancurvature(x, y)'])).toMatch(
      /needs a surface in space; a metric \(this panel's ds\^2 row\) has a Gaussian curvature, gaussian\(x, y\), and no meancurvature/,
    );
    // A surface of its own still reads as one there.
    expect(value([HALF_PLANE, 'S = (u, v, u^2 - v^2)', 'gaussian(S, 0, 0)'])).toBe(-4);
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
