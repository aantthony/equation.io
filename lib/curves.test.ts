import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { evaluate, type Expr } from './expr.ts';
import { plotReadout } from './plot.ts';

/** The differential geometry of a curve in u: curvature, torsion, the
 *  osculating circle and the Frenet frame (lib/curves.ts). */
function row(rows: string[]) {
  const analysis = analyzeRows(rows, { readouts: true });
  const r = analysis.rows.at(-1)!;
  if (r.error) throw new Error(r.error);
  return { r, env: { ...analysis.constEnv, t: 0 } };
}
const error = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!.error;
const readout = (rows: string[]) => {
  const { r, env } = row(rows);
  return plotReadout(r.cpu!, env);
};
/** A readout's number: `= 0.5` or `≈ 0.4`. */
const value = (rows: string[]) => Number(readout(rows)!.replace(/^[=≈] /, ''));

/** The arrows of frame(C, u0), each as [tail, head]. */
function arrows(rows: string[]): number[][][] {
  const { r, env } = row(rows);
  const o = r.cls!.object;
  if (o.kind !== 'family') throw new Error(o.kind);
  return o.members.map(m => {
    const f = m.object as { form: string; dimension: number; vertices: Expr[] };
    expect(f.form).toBe('vector');
    const v = f.vertices.map(e => evaluate(e, env));
    return [v.slice(0, f.dimension), v.slice(f.dimension)];
  });
}
const minus = (a: number[], b: number[]) => a.map((ak, k) => ak - b[k]);
const dot = (a: number[], b: number[]) => a.reduce((s, ak, k) => s + ak * b[k], 0);

describe('curvature', () => {
  it('is 1/r on a circle, signed by the way a plane curve turns', () => {
    expect(value(['C = (2cos(u), 2sin(u))', 'curvature(C, 0.3)'])).toBeCloseTo(0.5);
    expect(value(['C = (2cos(u), -2sin(u))', 'curvature(C, 0.3)'])).toBeCloseTo(-0.5);
  });
  it('is 2 at the vertex of y = x², and follows sliders', () => {
    expect(value(['curvature((u, u^2), 0)'])).toBe(2);
    expect(value(['a = 3', 'C = (a cos(u), a sin(u))', 'curvature(C, 1)'])).toBeCloseTo(1 / 3);
  });
  it('takes a function of one parameter', () => {
    expect(value(['f(s) = (s, s^2)', 'curvature(f, 0)'])).toBe(2);
  });
  it('is a/(a² + b²) on a helix, with torsion b/(a² + b²)', () => {
    const helix = 'C = (2cos(u), 2sin(u), u)';
    expect(value([helix, 'curvature(C, 0.7)'])).toBeCloseTo(0.4);
    expect(value([helix, 'torsion(C, 0.7)'])).toBeCloseTo(0.2);
    // A left-handed helix twists the other way.
    expect(value(['C = (2cos(u), 2sin(u), -u)', 'torsion(C, 0.7)'])).toBeCloseTo(-0.2);
  });
  it('plots against u as a parametric curve', () => {
    const { r, env } = row(['C = (2cos(u), sin(u))', '(u, curvature(C))']);
    const o = r.cls!.object;
    if (o.kind !== 'curve' || o.form !== 'parametric' || o.source.representation !== 'real') throw new Error(o.kind);
    // An ellipse is most curved at the ends of its long axis: a/b² = 2.
    expect(evaluate(o.source.coordinates[1], { ...env, u: 0 })).toBeCloseTo(2);
    expect(evaluate(o.source.coordinates[1], { ...env, u: Math.PI / 2 })).toBeCloseTo(0.25);
  });
  it('says what it needs', () => {
    expect(error(['C = (cos(u), sin(u))', 'curvature(C)'])).toMatch(/\(u, curvature\(C\)\)/);
    expect(error(['C = (cos(u), sin(u))', 'torsion(C, 0)'])).toMatch(/curve in space/);
    expect(error(['curvature((1, 2), 0)'])).toMatch(/moves with u/);
    expect(error(['C = (cos(u), sin(u))', 'curvature(C, u)'])).toMatch(/not u/);
    expect(error(['curvature(x^2, 0)'])).toMatch(/parametric curve in u/);
  });
  it('keeps a document’s own curvature', () => {
    expect(value(['curvature(a) = 2 a', 'curvature(3)'])).toBe(6);
  });
});

describe('osculating(C, u0)', () => {
  it('is the circle of radius 1/κ through the point, on its concave side', () => {
    // The ellipse (2cos u, sin u) at u = 0: the point (2, 0), κ = 2, so the
    // circle has radius 1/2 and centre (1.5, 0), inside the ellipse.
    const { r, env } = row(['C = (2cos(u), sin(u))', 'osculating(C, 0)']);
    const o = r.cls!.object;
    if (o.kind !== 'curve' || o.form !== 'implicit') throw new Error(o.kind);
    const f = (x: number, y: number) => evaluate(o.residual, { ...env, x, y });
    expect(f(2, 0)).toBeCloseTo(0);
    expect(f(1, 0)).toBeCloseTo(0);
    expect(f(1.5, 0.5)).toBeCloseTo(0);
    expect(f(1.5, 0)).toBeLessThan(0);
    expect(f(2.5, 0)).toBeGreaterThan(0);
  });
  it('touches the curve at a general point, matching it to second order', () => {
    // At u0 = 0.6 on y = x³ − x: the circle passes through the point, and
    // the curve's neighbours stay within O(h³) of it.
    const { r, env } = row(['osculating((u, u^3 - u), 0.6)']);
    const o = r.cls!.object;
    if (o.kind !== 'curve' || o.form !== 'implicit') throw new Error(o.kind);
    const f = (s: number) => evaluate(o.residual, { ...env, x: s, y: s ** 3 - s });
    expect(f(0.6)).toBeCloseTo(0, 9);
    const h = 1e-2;
    expect(Math.abs(f(0.6 + h))).toBeLessThan(1e-5);
    expect(Math.abs(f(0.6 - h))).toBeLessThan(1e-5);
  });
  it('moves with t', () => {
    const { r } = row(['C = (cos(u), sin(u))', 'osculating(C, t)']);
    expect(r.cls!.animated).toBe(true);
  });
  it('lies in the osculating plane of a space curve', () => {
    // The helix (2cos u, 2sin u, u): radius 1/κ = 2.5, through the point.
    const { r, env } = row(['C = (2cos(u), 2sin(u), u)', 'osculating(C, 0)']);
    const o = r.cls!.object;
    if (o.kind !== 'curve' || o.form !== 'parametric' || o.source.representation !== 'real') throw new Error(o.kind);
    const at = (u: number) => o.source.coordinates.map(c => evaluate(c, { ...env, u }));
    const rim = [0, 0.25, 0.5, 0.75].map(at);
    const centre = rim[0].map((c, k) => (c + rim[2][k]) / 2);
    for (const p of rim) expect(Math.hypot(...minus(p, centre))).toBeCloseTo(2.5);
    // The point of the curve is on it, and the centre is toward the axis.
    expect(rim.some(p => Math.hypot(...minus(p, [2, 0, 0])) < 1e-9)).toBe(true);
    expect(centre[0]).toBeCloseTo(-0.5);
  });
  it('needs a point on the curve', () => {
    expect(error(['C = (cos(u), sin(u))', 'osculating(C)'])).toMatch(/where on it/);
  });
});

describe('frame(C, u0)', () => {
  it('draws unit T and N from the point, N toward the centre of curvature', () => {
    const [T, N] = arrows(['C = (2cos(u), 2sin(u))', 'frame(C, 0)']);
    expect(T[0]).toEqual([2, 0]);
    expect(minus(T[1], T[0]).map(c => +c.toFixed(9))).toEqual([0, 1]);
    expect(minus(N[1], N[0]).map(c => +c.toFixed(9))).toEqual([-1, 0]);
  });
  it('keeps N on the concave side as a plane curve turns either way', () => {
    // y = x³: concave down left of 0, up right of it.
    const [, left] = arrows(['frame((u, u^3), -0.5)']);
    const [, right] = arrows(['frame((u, u^3), 0.5)']);
    expect(minus(left[1], left[0])[1]).toBeLessThan(0);
    expect(minus(right[1], right[0])[1]).toBeGreaterThan(0);
  });
  it('adds B = T × N in space, all three orthonormal', () => {
    const frame = arrows(['C = (2cos(u), 2sin(u), u)', 'frame(C, 0.9)']);
    expect(frame).toHaveLength(3);
    const [T, N, B] = frame.map(([tail, head]) => minus(head, tail));
    for (const v of [T, N, B]) expect(dot(v, v)).toBeCloseTo(1);
    expect(dot(T, N)).toBeCloseTo(0);
    expect(dot(T, B)).toBeCloseTo(0);
    expect(dot(N, B)).toBeCloseTo(0);
    // T × N = B, and N points at the helix's axis.
    expect(T[1] * N[2] - T[2] * N[1]).toBeCloseTo(B[0]);
    const P = frame[0][0];
    expect(dot(N, [-P[0], -P[1], 0])).toBeCloseTo(Math.hypot(P[0], P[1]));
  });
});
