import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { curvatureOf, torsionOf } from './curves.ts';
import { diff } from './diff.ts';
import { evaluate, type Expr, parseExpr } from './expr.ts';
import { foldAllExcept } from './path.ts';
import { plotReadout } from './plot.ts';
import { countNodes, exceedsNodes } from './size.ts';
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
    // here: 0.16 on a line, 1e24 where it turns back, and a torsion.
    expect(value(['C = (u^3, 2u^3, 3u^3)', 'curvature(C, 0.0025)'])).toBe(0);
    const line = 'C = (cos(2pi u), cos(2pi u)/3, cos(2pi u)/7)';
    expect(value([line, 'curvature(C, 0.5)'])).toBe(0);
    expect(value([line, 'curvature(C, 0.3)'])).toBe(0);
    expect(readout([line, 'torsion(C, 0.3)'])).toBe('undefined');
    // A curve that is curved but mostly speeding up still reads its κ.
    expect(value(['curvature((u^3, u^6), 0.01)'])).toBeCloseTo(2, 4);
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
  it('is undefined on the GPU where the curve is straight', () => {
    const rows = ['C = (u, {u < 0.5: 0, (u - 0.5)^3}, {u < 0.5: 0, (u - 0.5)^4})', 'y = torsion(C, x)'];
    const r = analyzeRows(rows, { backend: 'gpu' }).rows.at(-1)!;
    expect(r.error).toBeUndefined();
    const glsl = JSON.stringify(r.gpu);
    // GLSL leaves sqrt of a negative undefined (ANGLE folds sqrt(-1.0) to
    // 0): the gate is an even root, which eq_pow makes EQ_NAN.
    expect(glsl).not.toMatch(/sqrt\(sign/);
    expect(glsl).toMatch(/eq_pow\(sign\(/);
  });
  it('plots along u inside any curve in u, and in a tube', () => {
    const C = 'C = (2cos(2pi u), sin(2pi u))';
    expect(error([C, '2(u, curvature(C))'])).toBeUndefined();
    expect(error([C, '(u, 0) + (0, curvature(C))'])).toBeUndefined();
    const helix = 'C = (cos(2pi u), sin(2pi u), u)';
    expect(error([helix, 'tube((u, curvature(C), torsion(C)))'])).toBeUndefined();
  });
  it('says how to plot κ named as a function of u', () => {
    const C = 'C = (2cos(2pi u), sin(2pi u))';
    expect(error([C, 'k(u) = curvature(C, u)', 'k(u)'])).toMatch(/\(u, curvature\(C\)\)/);
    expect(error([C, 'k(u) = curvature(C, u)', '(u, k(u))'])).toBeUndefined();
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
    // A parameter or a Σ index of that name is a number.
    expect(value(['f(frame) = frame(2)', 'f(3)'])).toBe(6);
    expect(value(['g(torsion, k) = torsion(k + 1)', 'g(2, 3)'])).toBe(8);
    expect(value(['sum(frame=1..3, frame(2))'])).toBe(12);
    expect(value(['sum(curvature=1..3, curvature)'])).toBe(6);
    // Only inside its own sum: outside it, the builtin is the builtin.
    expect(arrows(['frame((cos(2pi u), sin(2pi u)), sum(frame=1..3, frame)/10)'])).toHaveLength(2);
    const outside = parseExpr('sum(frame=1..3, frame(2)) + frame(C, 0.2)');
    expect(outside.kind === 'bin' && outside.b).toMatchObject({ kind: 'call', name: 'frame' });
    // Nor does a Σ written with a subscript bind it before the Σ.
    const before = parseExpr('frame(C, 0.2) + Σ_(frame=1)^3 frame');
    expect(before.kind === 'bin' && before.a).toMatchObject({ kind: 'call', name: 'frame' });
    // And `==` compares: it binds no index.
    const compared = parseExpr('Σ_(frame==1)^3 1 + frame(C, 0.2)');
    expect(compared.kind === 'bin' && compared.b).toMatchObject({ kind: 'call', name: 'frame' });
  });
  it('differentiates along u symbolically', () => {
    // The straight-line gate is flat away from its jump, as a piecewise is:
    // no finite difference stands in for d/du κ.
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
  it('is the circle of radius 1/κ through the point, on its concave side', () => {
    // The ellipse (2cos u, sin u) at u = 0: the point (2, 0), κ = 2, so the
    // circle has radius 1/2 and centre (1.5, 0), inside the ellipse.
    const { at } = circle(['C = (2cos(u), sin(u))', 'osculating(C, 0)']);
    expect(at(0).map(c => +c.toFixed(12))).toEqual([2, 0]);
    const rim = [0, 0.1, 0.25, 0.5, 0.8].map(at);
    for (const p of rim) expect(Math.hypot(p[0] - 1.5, p[1])).toBeCloseTo(0.5, 12);
    expect(at(0.5)[0]).toBeCloseTo(1);
  });
  it('touches the curve at a general point, matching it to second order', () => {
    // At u0 = 0.6 on y = x³ − x: the circle passes through the point, and
    // the curve's neighbours stay within O(h³) of it.
    const { at } = circle(['osculating((u, u^3 - u), 0.6)']);
    const { centre, radius } = circumcircle([0, 0.3, 0.6].map(at));
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
    const folded = foldAllExcept(coordinates, 'u', { ...env, t: 3 });
    expect(folded.reduce((n, c) => n + countNodes(c), 0)).toBeLessThan(80);
  });
  it('draws one circle per point of a list', () => {
    const { r, env } = row(['C = (2cos(u), sin(u))', 'osculating(C, [0, pi/2])']);
    const o = r.cls!.object;
    if (o.kind !== 'family') throw new Error(o.kind);
    expect(o.members).toHaveLength(2);
    const [first] = o.members.map(m => {
      const c = m.object;
      if (c.kind !== 'curve' || c.form !== 'parametric' || c.source.representation !== 'real') throw new Error(c.kind);
      return (u: number) => c.source.coordinates.map(e => evaluate(e, { ...env, u }));
    });
    expect(Math.hypot(first(0.5)[0] - 1, first(0.5)[1])).toBeCloseTo(0, 12);
  });
  it('moves with t', () => {
    const { r } = row(['C = (cos(u), sin(u))', 'osculating(C, t)']);
    expect(r.cls!.animated).toBe(true);
  });
  it('lies in the osculating plane of a space curve', () => {
    // The helix (2cos u, 2sin u, u): radius 1/κ = 2.5, through the point.
    const { at } = circle(['C = (2cos(u), 2sin(u), u)', 'osculating(C, 0)']);
    const rim = [0, 0.25, 0.5, 0.75].map(at);
    const centre = rim[0].map((c, k) => (c + rim[2][k]) / 2);
    for (const p of rim) expect(Math.hypot(...minus(p, centre))).toBeCloseTo(2.5);
    // The point of the curve is on it, and the centre is toward the axis.
    expect(Math.hypot(...minus(at(0), [2, 0, 0]))).toBeLessThan(1e-9);
    expect(centre[0]).toBeCloseTo(-0.5);
    // Its plane is the osculating plane: normal to B = (0, −1, 2)/√5 there.
    for (const p of [0.1, 0.3, 0.6, 0.9].map(at)) expect(dot(minus(p, [2, 0, 0]), [0, -1, 2])).toBeCloseTo(0, 12);
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
    expect(exceedsNodes(perFrame, 100000)).toBe(false);
    const folded = foldAllExcept(perFrame, 'u', { ...env, t: 7 });
    expect(folded.reduce((n, c) => n + countNodes(c), 0)).toBeLessThan(400);
  });
  it('needs a point on the curve', () => {
    expect(error(['C = (cos(u), sin(u))', 'osculating(C)'])).toMatch(/where on it/);
  });
  it('is straight at an inflection that rounding leaves slightly bent', () => {
    // The figure eight's crossing at u = 1: sin 2π ≈ −2.4e-16, not 0.
    const eight = 'C = (2sin(2pi u), sin(4pi u))';
    expect(value([eight, 'curvature(C, 1)'])).toBe(0);
    expect(circle([eight, 'osculating(C, 1)']).at(0.3).every(Number.isNaN)).toBe(true);
    // Just off it the circle is back, of radius 1/κ on the concave side.
    const kappa = value([eight, 'curvature(C, 0.96)']);
    expect(1 / kappa).toBeCloseTo(6.23, 2);
    const near = circle([eight, 'osculating(C, 0.96)']);
    const { radius } = circumcircle([0, 0.3, 0.6].map(near.at));
    expect(radius).toBeCloseTo(1 / kappa, 4); // κ as read out, to 6 digits
    // N is undefined there; T is still drawn.
    const [T, N] = arrows([eight, 'frame(C, 1)']);
    expect(minus(T[1], T[0]).every(Number.isFinite)).toBe(true);
    expect(minus(N[1], N[0]).some(Number.isNaN)).toBe(true);
  });
  it('is not drawn where a straight line turns back', () => {
    // (cos 2πu, 2cos 2πu) runs along a line and back: at u = 0.50001 the
    // Lagrange form drew a circle of radius 0.74 about the point.
    const { at } = circle(['C = (cos(2pi u), 2cos(2pi u))', 'osculating(C, 0.50001)']);
    expect(at(0.3).every(Number.isNaN)).toBe(true);
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
