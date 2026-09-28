import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { curvatureOf, torsionOf } from './curves.ts';
import { diff } from './diff.ts';
import { evaluate, type Expr, parseExpr } from './expr.ts';
import { foldAllExcept } from './path.ts';
import { plotReadout } from './plot.ts';
import { countNodes } from './size.ts';
import { compileProg } from './vm.ts';
import { EXAMPLES } from '../web/examples.ts';
import { splitStatements } from './statements.ts';

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
/** The parametric circle osculating(C, u0) draws, as a function of its u. */
function circle(rows: string[]) {
  const { r, env } = row(rows);
  const o = r.cls!.object;
  if (o.kind !== 'curve' || o.form !== 'parametric' || o.source.representation !== 'real') throw new Error(o.kind);
  const { coordinates } = o.source;
  return { at: (u: number) => coordinates.map(c => evaluate(c, { ...env, u })), coordinates, env, cpu: r.cpu! };
}
const minus = (a: number[], b: number[]) => a.map((ak, k) => ak - b[k]);
const dot = (a: number[], b: number[]) => a.reduce((s, ak, k) => s + ak * b[k], 0);

describe('curvature', () => {
  it('reads 0 on a straight line traced at a varying speed', () => {
    // Lagrange's |r′|²|r″|² − (r′·r″)² left rounding the size of the terms
    // here: 0.16 on a line, and a torsion. The cross product leaves 0, or
    // rounding far below any curvature (here ~1e-17).
    expect(value(['C = (u^3, 2u^3, 3u^3)', 'curvature(C, 0.0025)'])).toBe(0);
    const line = 'C = (cos(2pi u), cos(2pi u)/3, cos(2pi u)/7)';
    expect(Math.abs(value([line, 'curvature(C, 0.3)']))).toBeLessThan(1e-15);
    // A curve that is curved but mostly speeding up still reads its κ.
    expect(value(['curvature((u^3, u^6), 0.01)'])).toBeCloseTo(2, 4);
  });
  it('reads rounding, not a gate, at an inflection', () => {
    // The figure eight's crossing: sin 2π ≈ −2.4e-16, not 0, and κ is what
    // the formula gives, a tiny number. y = x³ has its inflection exactly.
    expect(Math.abs(value(['C = (2sin(2pi u), sin(4pi u))', 'curvature(C, 1)']))).toBeLessThan(1e-15);
    expect(value(['curvature((u, u^3), 0)'])).toBe(0);
  });
  it('reads a list of points one by one', () => {
    const C = 'C = (2cos(u), sin(u))';
    expect(readout([C, 'curvature(C, [0.2, 0.4])'])).toBe('≈ [1.69094, 1.13963]');
    expect(readout([C, 's = [0.2, 0.4]', 'curvature(C, s)'])).toBe('≈ [1.69094, 1.13963]');
    // As points (s, κ), which drew nothing while κ was a piecewise.
    const { r, env } = row([C, 's = [0.2, 0.4]', '(s, curvature(C, s))']);
    const cpu = r.cpu!;
    if (cpu.type !== 'plist') throw new Error(cpu.type);
    const pts = cpu.pts.map(p => p.map(e => +evaluate(e, env).toFixed(5)));
    expect(pts).toEqual([
      [0.2, 1.69094],
      [0.4, 1.13963],
    ]);
  });
  it('names κ as a function of u', () => {
    const C = 'C = (2cos(u), sin(u))';
    expect(value([C, 'k(u) = curvature(C, u)', 'k(0.2)'])).toBeCloseTo(1.69094, 5);
    expect(value([C, 'k(u) = curvature(C, u)', 'k(0.2)'])).toBeCloseTo(value([C, 'curvature(C, 0.2)']));
  });
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
  it('plots along u inside any curve in u, and in a tube', () => {
    const C = 'C = (2cos(2pi u), sin(2pi u))';
    expect(error([C, '2(u, curvature(C))'])).toBeUndefined();
    expect(error([C, '(u, 0) + (0, curvature(C))'])).toBeUndefined();
    const helix = 'C = (cos(2pi u), sin(2pi u), u)';
    expect(error([helix, 'tube((u, curvature(C), torsion(C)))'])).toBeUndefined();
  });
  it('says how to plot κ only on a row that is κ itself', () => {
    const C = 'C = (2cos(2pi u), sin(2pi u))';
    expect(error([C, 'k(u) = curvature(C, u)', '(u, k(u))'])).toBeUndefined();
    // A row that only reads κ somewhere is its own: here a density.
    expect(error([C, 'k(u) = curvature(C, u)', 'u + k(0.3)'])).toBeUndefined();
    expect(error([C, 'k(x) = curvature(C, 0.3) x', 'k(u)'])).toBeUndefined();
  });
  it('says what a name that is no curve is', () => {
    expect(error(['a = 2', 'curvature(a)'])).toMatch(/a is a number, not a curve in u/);
    expect(error(['s = [1, 2]', 'curvature(s, 0)'])).toMatch(/s is a list, not a curve in u/);
  });
  it('says what it needs', () => {
    expect(error(['C = (cos(u), sin(u))', 'curvature(C)'])).toMatch(/\(u, curvature\(C\)\)/);
    expect(error(['C = (cos(u), sin(u))', '1/curvature(C)'])).toMatch(/\(u, curvature\(C\)\)/);
    expect(error(['C = (cos(u), sin(u))', 'torsion(C, 0)'])).toMatch(/curve in space/);
    // What is no curve says so, rather than advise plotting it against u.
    expect(error(['C = (cos(u), sin(u))', 'torsion(C)'])).toMatch(/curve in space/);
    expect(error(['curvature(3)'])).toMatch(/parametric curve in u/);
    expect(error(['curvature((1, 2))'])).toMatch(/moves with u/);
    expect(error(['curvature((1, 2), 0)'])).toMatch(/moves with u/);
    expect(error(['C = (cos(u), sin(u))', 'curvature(C, u)'])).toMatch(/not u/);
    expect(error(['curvature(x^2, 0)'])).toMatch(/parametric curve in u/);
    expect(error(['curvature(D, 0)'])).toMatch(/D is not a curve/);
  });
  it('refuses a curve that reads x, y or z through a named field', () => {
    expect(error(['curvature((u, x u^2), 0.5)'])).toMatch(/parametric curve in u/);
    expect(error(['g = x^2', 'curvature((u, g u^2), 0.5)'])).toMatch(/parametric curve in u/);
    expect(error(['g = x^2', 'osculating((u, g u^2), 0.5)'])).toMatch(/parametric curve in u/);
    expect(error(['g = y', 'torsion((cos(u), sin(u), g u), 0)'])).toMatch(/parametric curve in u/);
  });
  it('keeps a document’s own curvature', () => {
    expect(value(['curvature(a) = 2 a', 'curvature(3)'])).toBe(6);
  });
  it('leaves the names to a document that uses them itself', () => {
    // A function of its own spreads a tuple as any function does.
    expect(value(['frame(a, b, c) = a + b + c', 'frame((1, 2), 3)'])).toBe(6);
    expect(value(['osculating(a, b, c) = a b c', 'osculating((1, 2), 3)'])).toBe(6);
    // A parameter of that name is a number.
    expect(value(['f(frame) = frame(2)', 'f(3)'])).toBe(6);
    expect(value(['g(torsion, k) = torsion(k + 1)', 'g(2, 3)'])).toBe(8);
    // A Σ index of that name is a number where it is not called, and a call
    // is the builtin, as with sum(sin=1..3, sin(2)).
    expect(value(['sum(frame=1..3, frame)'])).toBe(6);
    const C = 'C = (cos(2pi u), sin(2pi u))';
    for (const row of [
      'sum(frame=1..3, frame(2))',
      'sum[frame=1..3] frame(2)',
      'Σ(frame=1..3, frame(2)) + frame(C, 0.2)',
    ]) {
      expect(error([C, row])).toMatch(/frame takes a curve and where on it/);
    }
  });
  it('differentiates along u symbolically', () => {
    // κ is a plain quotient: diff takes it whole (it throws where it would
    // fall back to finite differences), and it matches the closed form.
    const r = [parseExpr('2cos(2pi u)'), parseExpr('sin(2pi u)')];
    const d = (e: Expr) => diff(e, 'u');
    const dk = diff(curvatureOf(r, d), 'u');
    // κ = 2/q^(3/2), q = 4sin² + cos² of 2πu: dκ/du = −18 · 2π sin cos / q^(5/2).
    const at = 0.1,
      s = Math.sin(2 * Math.PI * at),
      c = Math.cos(2 * Math.PI * at);
    const q = 4 * s * s + c * c;
    expect(evaluate(dk, { u: at })).toBeCloseTo((-18 * 2 * Math.PI * s * c) / q ** 2.5, 8);
    const helix = ['cos(2pi u)', 'sin(2pi u)', 'u^2'].map(s => parseExpr(s));
    expect(() => diff(torsionOf(helix, d), 'u')).not.toThrow();
    expect(value(['C = (2cos(2pi u), sin(2pi u))', 'f(u) = d/du curvature(C, u)', 'f(0.1)'])).toBeCloseTo(
      evaluate(dk, { u: at }),
      5,
    );
  });
});

/** Centre and radius of a circle through three of its points in the plane. */
function circumcircle([a, b, c]: number[][]): { centre: number[]; radius: number } {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const sq = (p: number[]) => p[0] ** 2 + p[1] ** 2;
  const x = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
  const y = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
  return { centre: [x, y], radius: Math.hypot(a[0] - x, a[1] - y) };
}

describe('osculating(C, u0)', () => {
  /** u from 0 to 1, as a curve is sampled. */
  const us = Array.from({ length: 101 }, (_, k) => k / 100);
  it('is the circle of radius 1/κ through the point, on its concave side', () => {
    // The ellipse (2cos u, sin u) at u = 0: the point (2, 0), κ = 2, so the
    // circle has radius 1/2 and centre (1.5, 0), inside the ellipse. The
    // point is at u = 1/2, and u = 0 and 1 run round to the far side.
    const { at } = circle(['C = (2cos(u), sin(u))', 'osculating(C, 0)']);
    expect(at(0.5).map(c => +c.toFixed(12))).toEqual([2, 0]);
    for (const p of us.map(at)) expect(Math.hypot(p[0] - 1.5, p[1])).toBeCloseTo(0.5, 12);
    expect(at(0)[0]).toBeCloseTo(1);
    expect(at(1)[0]).toBeCloseTo(1);
  });
  it('touches the curve at a general point, matching it to second order', () => {
    // At u0 = 0.6 on y = x³ − x: the circle passes through the point, and
    // the curve's neighbours stay within O(h³) of it.
    const { at } = circle(['osculating((u, u^3 - u), 0.6)']);
    const { centre, radius } = circumcircle([0.2, 0.5, 0.7].map(at));
    const f = (s: number) => Math.hypot(s - centre[0], s ** 3 - s - centre[1]) - radius;
    expect(f(0.6)).toBeCloseTo(0, 9);
    const h = 1e-2;
    expect(Math.abs(f(0.6 + h))).toBeLessThan(1e-5);
    expect(Math.abs(f(0.6 - h))).toBeLessThan(1e-5);
  });
  it('is a circle in u whose centre and radius are worked out once a frame', () => {
    // An implicit circle made the og renderer (and the GPU, per pixel) work
    // out the centre from the curve's derivatives at every point of its grid.
    const { coordinates, env } = circle(['C = (3cos(2pi u), 1.5sin(2pi u))', 'osculating(C, t/10)']);
    expect(coordinates.reduce((n, c) => n + countNodes(c), 0)).toBeGreaterThan(1000);
    const folded = foldAllExcept(coordinates, 'u', { ...env, t: 3 });
    expect(folded.reduce((n, c) => n + countNodes(c), 0)).toBeLessThan(100);
  });
  it('draws one circle per point of a list', () => {
    const { r, env } = row(['C = (2cos(u), sin(u))', 'osculating(C, [0, pi/2])']);
    const o = r.cls!.object;
    if (o.kind !== 'family') throw new Error(o.kind);
    expect(o.members).toHaveLength(2);
    const [first, second] = o.members.map(m => {
      const c = m.object;
      if (c.kind !== 'curve' || c.form !== 'parametric' || c.source.representation !== 'real') throw new Error(c.kind);
      return (u: number) => c.source.coordinates.map(e => evaluate(e, { ...env, u }));
    });
    // Through (2, 0) with radius 1/2, and through (0, 1) with radius 4.
    expect(Math.hypot(first(0.5)[0] - 2, first(0.5)[1])).toBeCloseTo(0, 12);
    for (const p of us.map(first)) expect(Math.hypot(p[0] - 1.5, p[1])).toBeCloseTo(0.5, 9);
    expect(Math.hypot(second(0.5)[0], second(0.5)[1] - 1)).toBeCloseTo(0, 12);
    for (const p of us.map(second)) expect(Math.hypot(p[0], p[1] + 3)).toBeCloseTo(4, 9);
  });
  it('moves with t', () => {
    const { r } = row(['C = (cos(u), sin(u))', 'osculating(C, t)']);
    expect(r.cls!.animated).toBe(true);
  });
  it('lies in the osculating plane of a space curve', () => {
    // The helix (2cos u, 2sin u, u) at u = 0: the point (2, 0, 0), κ = 0.4,
    // N toward the axis, so radius 2.5 about (−0.5, 0, 0).
    const { at } = circle(['C = (2cos(u), 2sin(u), u)', 'osculating(C, 0)']);
    expect(Math.hypot(...minus(at(0.5), [2, 0, 0]))).toBeLessThan(1e-12);
    for (const p of us.map(at)) expect(Math.hypot(...minus(p, [-0.5, 0, 0]))).toBeCloseTo(2.5, 9);
    // Its plane is the osculating plane: normal to B = (0, −1, 2)/√5 there.
    for (const p of us.map(at)) expect(dot(minus(p, [2, 0, 0]), [0, -1, 2])).toBeCloseTo(0, 12);
  });
  it('keeps a space osculating circle small enough to sample every frame', () => {
    // Its derivatives along u (for a κ comb) were the circle's whole
    // centre and frame differentiated: 733K nodes on the trefoil, 5 s/frame.
    const trefoil = 'C = (sin(2pi u) + 2sin(4pi u), cos(2pi u) - 2cos(4pi u), -sin(6pi u))';
    const { cpu, env } = circle([trefoil, 'osculating(C, t/20)']);
    if (cpu.type !== 'pcurve') throw new Error(cpu.type);
    // Symbolic, so the combs are not finite differences (a jagged τ comb).
    expect(cpu.d3).toBeDefined();
    const perFrame = [cpu.comps, cpu.d1, cpu.d2, cpu.d3].flatMap(v => v ?? []);
    // What a frame samples: folded, and each part that recurs (sinc and its
    // derivatives, in every product-rule term) worked out once.
    const folded = foldAllExcept(perFrame, 'u', { ...env, t: 7 });
    const ops = folded.reduce((n, c) => n + compileProg(c, new Map([['u', 0]])).code.length / 2, 0);
    expect(ops).toBeLessThan(2000);
  });
  it('needs a point on the curve', () => {
    expect(error(['C = (cos(u), sin(u))', 'osculating(C)'])).toMatch(/where on it/);
  });

  // The figure eight crosses itself at u = 1 with an inflection: κ is 0
  // there, up to rounding (sin 2π ≈ −2.4e-16).
  const eight = 'C = (2sin(2pi u), sin(4pi u))';
  it('is the tangent line at an inflection', () => {
    // At (0, 0) the tangent is along (1, 1): the line y = x.
    const { at } = circle([eight, 'osculating(C, 1)']);
    const pts = us.map(at);
    for (const [x, y] of pts) expect(Math.abs(y - x)).toBeLessThan(1e-9);
    expect(Math.hypot(...at(0.5))).toBeLessThan(1e-12);
    // It runs far past any view, both ways.
    expect(pts[0][0]).toBeLessThan(-500);
    expect(pts[100][0]).toBeGreaterThan(500);
  });
  it('is a large circle on the concave side just off an inflection', () => {
    const kappa = value([eight, 'curvature(C, 0.96)']);
    expect(1 / Math.abs(kappa)).toBeCloseTo(6.23, 2);
    const { at } = circle([eight, 'osculating(C, 0.96)']);
    const { centre, radius } = circumcircle([0.1, 0.5, 0.9].map(at));
    expect(radius).toBeCloseTo(1 / Math.abs(kappa), 4); // κ as read out, to 6 digits
    for (const p of us.map(at)) expect(Math.hypot(...minus(p, centre))).toBeCloseTo(radius, 9);
    // The curve bends toward the centre: its second difference points there.
    const curve = (u: number) => [2 * Math.sin(2 * Math.PI * u), Math.sin(4 * Math.PI * u)];
    const bend = minus(minus(curve(0.97), curve(0.96)), minus(curve(0.96), curve(0.95)));
    expect(dot(bend, minus(centre, at(0.5)))).toBeGreaterThan(0);
  });
  it('touches the curve with its tangent nearer the inflection', () => {
    const { at } = circle([eight, 'osculating(C, 0.99)']);
    const p = [2 * Math.sin(2 * Math.PI * 0.99), Math.sin(4 * Math.PI * 0.99)];
    expect(Math.hypot(...minus(at(0.5), p))).toBeLessThan(1e-12);
    const T = [Math.cos(2 * Math.PI * 0.99), Math.cos(4 * Math.PI * 0.99)];
    const h = 1e-6;
    const along = minus(at(0.5 + h), at(0.5 - h));
    expect(Math.abs(along[0] * T[1] - along[1] * T[0]) / Math.hypot(...along) / Math.hypot(...T)).toBeLessThan(1e-6);
    expect(dot(along, T)).toBeGreaterThan(0);
  });
  it('moves continuously through the inflection', () => {
    // Within the view (|s| < 4 about the point), the circle a hair before
    // u0 = 1 and the line at it are the same to far below a pixel.
    const before = circle([eight, 'osculating(C, 0.999999999)']).at;
    const on = circle([eight, 'osculating(C, 1)']).at;
    for (let k = -8; k <= 8; k++) {
      const u = 0.5 + k * 0.00025;
      expect(Math.hypot(...minus(before(u), on(u)))).toBeLessThan(1e-6);
    }
  });
  it('is the line itself on a straight line in space', () => {
    const { at } = circle(['osculating((u, 2u, 3u), 0.3)']);
    const pts = us.map(at);
    for (const p of pts) {
      expect(p.every(Number.isFinite)).toBe(true);
      const off = minus(p, [0.3, 0.6, 0.9]);
      const t = off[0];
      expect(Math.hypot(...minus(off, [t, 2 * t, 3 * t]))).toBeLessThan(1e-9);
    }
    expect(Math.hypot(...minus(pts[100], pts[0]))).toBeGreaterThan(1000);
  });
  it('is the line where a straight line turns back', () => {
    // (cos 2πu, 2cos 2πu) runs along y = 2x and back: at u = 0.50001 the
    // Lagrange form drew a circle of radius 0.74 about the point.
    const { at } = circle(['C = (cos(2pi u), 2cos(2pi u))', 'osculating(C, 0.50001)']);
    for (const [x, y] of us.map(at)) expect(Math.abs(y - 2 * x)).toBeLessThan(1e-6);
  });
});

describe('frame(C, u0)', () => {
  it('draws unit T and N from the point, N toward the centre of curvature', () => {
    const [T, N] = arrows(['C = (2cos(u), 2sin(u))', 'frame(C, 0)']);
    expect(T[0]).toEqual([2, 0]);
    expect(minus(T[1], T[0]).map(c => +c.toFixed(9))).toEqual([0, 1]);
    expect(minus(N[1], N[0]).map(c => +c.toFixed(9))).toEqual([-1, 0]);
  });
  it('turns N a quarter left of T in the plane, so κN points to the concave side', () => {
    // y = x³: concave down left of 0 (κ < 0), up right of it (κ > 0).
    for (const u0 of [-0.5, 0.5]) {
      const [T, N] = arrows([`frame((u, u^3), ${u0})`]).map(([tail, head]) => minus(head, tail));
      expect(N[0]).toBeCloseTo(-T[1], 12);
      expect(N[1]).toBeCloseTo(T[0], 12);
      const kappa = value([`curvature((u, u^3), ${u0})`]);
      expect(Math.sign(kappa * N[1])).toBe(Math.sign(u0));
    }
  });
  it('is defined through a plane inflection', () => {
    const [T, N] = arrows(['C = (2sin(2pi u), sin(4pi u))', 'frame(C, 1)']).map(([tail, head]) => minus(head, tail));
    const r = Math.SQRT1_2;
    [r, r, -r, r].forEach((c, k) => expect([...T, ...N][k]).toBeCloseTo(c, 9));
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
  it('fits a knot that winds many times', () => {
    // B = T × N copied T and N whole into each component: 39,547 nodes,
    // past the 32,768 a family may expand to.
    const torus = 'C = ((2 + cos(10pi u)) cos(4pi u), (2 + cos(10pi u)) sin(4pi u), sin(10pi u))';
    const frame = arrows([torus, 'frame(C, 0.3)']);
    const [T, N, B] = frame.map(([tail, head]) => minus(head, tail));
    for (const v of [T, N, B]) expect(dot(v, v)).toBeCloseTo(1);
    expect(T[1] * N[2] - T[2] * N[1]).toBeCloseTo(B[0]);
    expect(T[2] * N[0] - T[0] * N[2]).toBeCloseTo(B[1]);
  });
  it('takes one point at a time', () => {
    expect(error(['C = (2cos(u), sin(u))', 'frame(C, [0.2, 0.4])'])).toMatch(/one point on the curve at a time/);
    expect(error(['C = (2cos(u), sin(u))', 's = [0.2, 0.4]', 'frame(C, s)'])).toMatch(/one point/);
    expect(error(['C = (2cos(u), sin(u))', 's = [0.2, 0.4]', 'frame(C, 2s)'])).toMatch(/one point/);
    // A filter, a mask or a slice of a list is still a list.
    for (const u0 of ['s[s > 0.3]', 's[s > 0.1]', 's[[1, 2]]', 's[1..2]']) {
      expect(error(['C = (2cos(u), sin(u))', 's = [0.2, 0.4, 0.5]', `frame(C, ${u0})`])).toMatch(/one point/);
    }
    // An index or a reduction of a list is one number.
    for (const u0 of ['sort(s)[1]', 'mean(s)', 'total(s)/4']) {
      expect(arrows(['C = (2cos(u), sin(u))', 's = [0.2, 0.4]', `frame(C, ${u0})`])).toHaveLength(2);
    }
  });
});

describe('the curve examples', () => {
  const examples = new Map(EXAMPLES.flatMap(([, items]) => items.map(([label, text]) => [label, text] as const)));
  it('keep the helix’s frame on the helix however long the graph runs', () => {
    // u0 = t/10 left the helix (z from −1.5 to 1.5) after ten seconds.
    const rows = splitStatements(examples.get('Frenet frame on a helix')!)
      .map(r => r.trim())
      .filter(Boolean);
    const analysis = analyzeRows(rows);
    const frameRow = analysis.rows[rows.findIndex(r => r.startsWith('frame'))];
    const o = frameRow.cls!.object;
    if (o.kind !== 'family') throw new Error(o.kind);
    const tail = o.members[0].object as { vertices: Expr[] };
    for (const t of [0, 7, 12, 120, 3601]) {
      const z = evaluate(tail.vertices[2], { ...analysis.constEnv, t });
      expect(Math.abs(z)).toBeLessThanOrEqual(1.5 + 1e-9);
    }
  });
});
