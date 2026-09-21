import { describe, it, expect } from 'vitest';
import { evaluate, parseExpr } from './expr.ts';
import { classify } from './plot.ts';
import { solveSystem, traceSystem } from './solve.ts';
import { complexParts } from './complex-parts.ts';
import { diff } from './diff.ts';
import { evalConstEnv } from './defs.ts';
import { analyze } from '../worker/graph.ts';

const polar = ['r = sqrt(x^2+y^2)', 'theta = atan2(y,x)'];
const last = (rows: string[]) => {
  const a = analyze(rows);
  expect(a.rows.map(r => r.error).filter(Boolean)).toEqual([]);
  return a.rows.at(-1)!.cls!.plot;
};
const solutions = (rows: string[]) => {
  const p = last(rows);
  if (p.type !== 'system') throw new Error('expected system');
  return solveSystem(p.residuals, ['x', 'y'], [-4, -4], [4, 4], { angular: p.angular });
};

describe('coordinate objects end to end', () => {
  it('wraps a polar angle beyond the principal branch', () => {
    const pts = solutions([...polar, '(r, theta) = (2, 9pi/4)']);
    expect(pts).toHaveLength(1);
    expect(pts[0][0]).toBeCloseTo(Math.SQRT2, 7);
    expect(pts[0][1]).toBeCloseTo(Math.SQRT2, 7);
  });
  it('treats an angle(…) coordinate as periodic, like atan2', () => {
    const chart = ['r = sqrt(x^2+y^2)', 'theta = angle((1, 0), (x, y))'];
    const p = last([...chart, '(r, theta) = (2, 9pi/4)']);
    if (p.type !== 'system') throw new Error('expected system');
    expect(p.angular).toEqual([false, true]);
    const pts = solutions([...chart, '(r, theta) = (2, 9pi/4)']);
    expect(pts).toHaveLength(1);
    expect(pts[0][0]).toBeCloseTo(Math.SQRT2, 7);
    expect(pts[0][1]).toBeCloseTo(Math.SQRT2, 7);
    // Written directly, with no field: the angle at (x, y) subtended by A and B.
    const q = last(['A = (-1, 0)', 'B = (1, 0)', '(angle(A, (x, y), B), |(x, y)|) = (3.1, 2)']);
    if (q.type !== 'system') throw new Error('expected system');
    expect(q.angular).toEqual([true, false]);
    // A traced spiral crosses the ±π cut three times without a chord or a break.
    const s = last([...chart, '(r, theta) = (3u, 6pi u)']);
    if (s.type !== 'system') throw new Error('expected system');
    const paths = traceSystem(s.residuals, ['x', 'y'], [-4, -4], [4, 4], {}, 256, s.angular);
    const longest = paths.reduce((a, b) => a.length > b.length ? a : b);
    expect(longest.length).toBeGreaterThan(250);
    for (let k = 1; k < longest.length; k++) {
      expect(Math.hypot(longest[k][0] - longest[k - 1][0], longest[k][1] - longest[k - 1][1])).toBeLessThan(0.3);
    }
  });
  it('does not wrap real expressions containing nested angle calculations', () => {
    const p = last(['(x+sin(atan2(y,x)),y)=(10,0)']);
    if (p.type !== 'system') throw new Error('expected system');
    expect(p.angular).toEqual([false, false]);
    const pts = solveSystem(p.residuals, ['x', 'y'], [-12, -12], [12, 12], { angular: p.angular });
    expect(pts).toHaveLength(1);
    expect(pts[0][0]).toBeCloseTo(10, 7);
    expect(pts[0][1]).toBeCloseTo(0, 7);
  });
  it('finds every branch of the hyperbolic example', () => {
    const pts = solutions(['p = x y', 'q = (x^2-y^2)/2', '(p, q) = (1, 0)']);
    expect(pts).toHaveLength(2);
    expect(pts[0][0]).toBeCloseTo(-1, 7);
    expect(pts[1][0]).toBeCloseTo(1, 7);
  });
  it('traces all three turns of a polar spiral continuously', () => {
    const p = last([...polar, '(r, theta) = (3u, 6pi u)']);
    if (p.type !== 'system') throw new Error('expected system');
    expect(p.parametric).toBe(true);
    const paths = traceSystem(p.residuals, ['x', 'y'], [-4, -4], [4, 4], {}, 256, p.angular);
    const longest = paths.reduce((a, b) => a.length > b.length ? a : b);
    expect(longest.length).toBeGreaterThan(250);
    for (const [x, y] of longest) {
      const radius = Math.hypot(x, y);
      expect(x).toBeCloseTo(radius * Math.cos(2 * Math.PI * radius), 5);
      expect(y).toBeCloseTo(radius * Math.sin(2 * Math.PI * radius), 5);
    }
  });
  it('transforms polar velocities through the Jacobian', () => {
    const p = last([...polar, "(r', theta') = (r(1-r), 1)"]);
    if (p.type !== 'vfield2d') throw new Error('expected field');
    expect(p.comps.map(e => evaluate(e, { x: 2, y: 0 }))).toEqual([-2, 2]);
    expect(p.comps.map(e => evaluate(e, { x: 0, y: 1 }))).toEqual([-1, 0]);
  });
  it('accounts for explicitly moving coordinates', () => {
    const p = last(['p = x+t', 'q = y', "(p', q') = (0, 0)"]);
    if (p.type !== 'vfield2d') throw new Error('expected field');
    expect(p.comps.map(e => evaluate(e, { x: 2, y: 0, t: 1 }))).toEqual([-1, 0]);
  });
  it.each([
    { rows: ['a=t', 'p=x+a', 'q=y'], state: {}, velocity: [-1, 0] },
    { rows: ['a=t', 'b=a^2', 'p=x+b', 'q=y'], state: {}, velocity: [-4, 0] },
    { rows: ["a'=3", 'p=x+a', 'q=y'], state: { a: 6 }, velocity: [-3, 0] },
    { rows: ["a'=a", 'b=a^2+t', 'p=x+b', 'q=y'], state: { a: 3 }, velocity: [-19, 0] },
    { rows: ['a=t', 'p=a x', 'q=y+t'], state: {}, velocity: [-2, -1] },
    { rows: ['a=floor(2.5)', 'p=x+a', 'q=y'], state: {}, velocity: [0, 0] },
  ])('includes indirect chart time dependence: $rows', ({ rows, state, velocity }) => {
    const a = analyze([...rows, "(p',q')=(0,0)"]);
    expect(a.rows.map(r => r.error).filter(Boolean)).toEqual([]);
    const p = a.rows.at(-1)!.cls!.plot;
    if (p.type !== 'vfield2d') throw new Error('expected field');
    const env = { ...evalConstEnv(a.defs, 2, state), x: 4, y: 1, t: 2 };
    expect(p.comps.map(e => evaluate(e, env))).toEqual(velocity);
  });
  it('preserves constant Cartesian flows and state names', () => {
    expect(last(["(x', y') = (1, 0)"]).type).toBe('vfield2d');
    const a = analyze(["a' = -a", 'a(0) = 1', '(a, 0)']);
    expect(a.rows.some(r => r.error)).toBe(false);
  });
  it('rejects repeated coordinates and mixed primes', () => {
    expect(analyze([...polar, '(r, r) = (1, 2)']).rows.at(-1)?.error).toMatch(/distinct/);
    expect(analyze([...polar, "(r', theta) = (1, 2)"]).rows.at(-1)?.error).toMatch(/prime/);
  });
  it('retains coordinate expressions only for draggable positional rows', () => {
    const p = last([...polar, '(r, theta) = (2, 0.8)']);
    expect(p).toHaveProperty('coordinates');
    const q = last(['(x, y) = (y, -sin(x))']);
    expect(q).not.toHaveProperty('coordinates');
  });
});

describe('complex CPU objects', () => {
  it('renders constants as Argand points', () => {
    const p = classify(parseExpr('1+2i')).plot;
    if (p.type !== 'point') throw new Error('expected point');
    expect(p.coords.map(e => evaluate(e, {}))).toEqual([1, 2]);
  });
  it('lowers real projections inside complex arithmetic', () => {
    for (const text of ['re(2)+i', '(re(2)-10)^(1/3)+i']) {
      const p = classify(parseExpr(text)).plot;
      if (p.type !== 'point') throw new Error('expected point');
      expect(p.coords.map(e => evaluate(e, {}))).toEqual([text.startsWith('re') ? 2 : -2, 1]);
    }
  });
  it('finds the three cube roots of unity', () => {
    const pts = solutions(['w^3 = 1']);
    expect(pts).toHaveLength(3);
    for (const [x, y] of pts) {
      expect(x*x*x - 3*x*y*y).toBeCloseTo(1, 7);
      expect(3*x*x*y - y*y*y).toBeCloseTo(0, 7);
    }
  });
  it('retains a high-multiplicity complex root', () => {
    const pts = solutions(['w^8 = 0']);
    expect(pts).toHaveLength(1);
    expect(Math.hypot(...pts[0])).toBeLessThan(1e-7);
  });
  it('keeps integer powers and their derivatives compact', () => {
    const parts = complexParts(parseExpr('w^16'));
    expect(JSON.stringify(parts).length).toBeLessThan(10000);
    const derivatives = parts.map(e => diff(e, 'x'));
    expect(JSON.stringify(derivatives).length).toBeLessThan(20000);
    expect(parts.map(e => evaluate(e, { x: 0, y: 0 }))).toEqual([0, 0]);
    expect(derivatives.map(e => evaluate(e, { x: 0, y: 0 }))).toEqual([0, 0]);
    for (const n of [0, 1, 2, 3, 10, 16, -1, -10]) {
      const angle = 0.3;
      const values = complexParts(parseExpr(`w^(${n})`)).map(e => evaluate(e, { x: Math.cos(angle), y: Math.sin(angle) }));
      expect(values[0]).toBeCloseTo(Math.cos(n * angle), 10);
      expect(values[1]).toBeCloseTo(Math.sin(n * angle), 10);
    }
  });
  it('finds all ten roots of unity', () => {
    const pts = solutions(['w^10 = 1']);
    expect(pts).toHaveLength(10);
    for (const [x, y] of pts) {
      expect(Math.hypot(x, y)).toBeCloseTo(1, 7);
      expect(Math.cos(10 * Math.atan2(y, x))).toBeCloseTo(1, 7);
    }
  });
  it('lowers projections in piecewise values, conditions, and fallbacks', () => {
    for (const text of ['{t<1:re(2),3}+i', '{re(0)<im(t*i)<re(1):{t<0.5:re(2),im(2i)},re(3)}+i']) {
      const p = classify(parseExpr(text)).plot;
      if (p.type !== 'point') throw new Error('expected point');
      expect(p.coords.map(e => evaluate(e, { t: 0.25 }))).toEqual([2, 1]);
      expect(p.coords.map(e => evaluate(e, { t: 0.75 }))).toEqual([2, 1]);
      expect(p.coords.map(e => evaluate(e, { t: 2 }))).toEqual([3, 1]);
    }
    const [re] = complexParts(parseExpr('{t<1:re(2)}+i'));
    expect(evaluate(re, { t: 2 })).toBeNaN();
  });
  it('does not wrap logarithm residuals as coordinate angles', () => {
    expect(solutions(['ln(w) = 9i'])).toHaveLength(0);
  });
  it('handles zero roots and principal square roots', () => {
    expect(solutions(['w^3 = 0'])).toHaveLength(1);
    const z = complexParts(parseExpr('sqrt(-1+0i)')).map(e => evaluate(e, {}));
    expect(z).toEqual([0, 1]);
  });
  it.each([
    ['1', 1, 0], ['i', -1, 0], ['1+i', 0, 2], ['1-i', 0, -2],
  ] as const)('solves principal square roots equal to %s', (rhs, x, y) => {
    const pts = solutions([`sqrt(w) = ${rhs}`]);
    expect(pts).toHaveLength(1);
    expect(pts[0][0]).toBeCloseTo(x, 7);
    expect(pts[0][1]).toBeCloseTo(y, 7);
  });
  it('preserves small square-root components close to the real axis', () => {
    const parts = complexParts(parseExpr('sqrt(w)'));
    for (const x of [-1, 1]) for (const y of [-1e-12, 1e-12]) {
      const [re, im] = parts.map(e => evaluate(e, { x, y }));
      expect(Math.abs(2 * re * im / y - 1)).toBeLessThan(1e-12);
      expect(re * re - im * im).toBeCloseTo(x, 14);
    }
    expect(parts.map(e => evaluate(e, { x: 0, y: 0 }))).toEqual([0, 0]);
    expect(solutions(['sqrt(w) = -1'])).toEqual([]);
  });
  it('keeps real projections as implicit equations', () => {
    expect(classify(parseExpr('re(w^2) = 1')).plot.type).toBe('implicit2d');
  });
});

describe('parametric system branches', () => {
  it('draws a fast line in a narrow view', () => {
    const p = last(['(x, y) = (100u, 0)']);
    if (p.type !== 'system') throw new Error('expected system');
    const paths = traceSystem(p.residuals, ['x', 'y'], [-1, -1], [1, 1]);
    const visible = paths.find(path => path.length > 1 && path[0][0] < 0.01 && path.at(-1)![0] > 0.7);
    expect(visible).toBeDefined();
    for (const [x, y] of visible ?? []) {
      expect(y).toBeCloseTo(0, 8);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1.1);
    }
  });
  it('keeps disconnected preimages on separate paths', () => {
    const p = last(['(x^2, y) = (1+u, u)']);
    if (p.type !== 'system') throw new Error('expected system');
    const paths = traceSystem(p.residuals, ['x', 'y'], [-3, -3], [3, 3]);
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      expect(path).toHaveLength(257);
      expect(new Set(path.map(p => Math.sign(p[0]))).size).toBe(1);
    }
  });
  it('never connects a curve across an undefined interval', () => {
    const p = last(['(x, y) = (u, sqrt((u-0.4)(u-0.6)))']);
    if (p.type !== 'system') throw new Error('expected system');
    const paths = traceSystem(p.residuals, ['x', 'y'], [-1, -1], [2, 2]);
    expect(paths.length).toBeGreaterThanOrEqual(2);
    for (const path of paths) expect(path.some(p => p[0] < 0.4) && path.some(p => p[0] > 0.6)).toBe(false);
  });
  it('does not bridge a finite jump', () => {
    const p = last(['(x, y) = (u, floor(2u))']);
    if (p.type !== 'system') throw new Error('expected system');
    const paths = traceSystem(p.residuals, ['x', 'y'], [-1, -1], [2, 2]);
    expect(paths.some(path => path.some(point => point[1] === 0) && path.some(point => point[1] === 1))).toBe(false);
  });
  it.each([0.1, 0.00001])('does not bridge a jump of size %s', jump => {
    const p = last([`(x, y) = (u, ${jump} floor(2u))`]);
    if (p.type !== 'system') throw new Error('expected system');
    const paths = traceSystem(p.residuals, ['x', 'y'], [-1, -1], [2, 2]);
    expect(paths.some(path => path.some(point => point[1] === 0) && path.some(point => point[1] === jump))).toBe(false);
    expect(paths.some(path => path.some(point => point[1] === jump) && path.some(point => point[1] === 2 * jump))).toBe(false);
  });
  it('detects a small jump even when smooth curvature is larger', () => {
    for (const y of [
      '0.1u^2+0.0000001floor(u+0.25)',
      '0.1u^2+{u<0.75:0,0.0000001}',
    ]) {
      const paths = traceSystem([parseExpr('x-u'), parseExpr(`y-(${y})`)],
        ['x', 'y'], [-1, -1], [2, 2], {}, 256);
      expect(paths.some(path => path.some(point => point[0] < 0.75) &&
        path.some(point => point[0] >= 0.75))).toBe(false);
    }
  });
  it('does not mistake evenly spaced jumps for a straight midpoint', () => {
    const paths = traceSystem(
      [parseExpr('x-u'), parseExpr('y-0.1floor(512u)')],
      ['x', 'y'], [-1, -1], [2, 60], {}, 256,
    );
    expect(paths).toHaveLength(257);
    expect(paths.every(path => path.length === 1)).toBe(true);
  });
  it('keeps a steep but continuous curve connected', () => {
    const paths = traceSystem(
      [parseExpr('x-u'), parseExpr('y-0.02atan(10000000(u-0.501))')],
      ['x', 'y'], [-1, -1], [2, 2], {}, 256,
    );
    expect(paths).toHaveLength(1);
    expect(paths[0]).toHaveLength(257);
  });
});

describe('coordinate fields over z', () => {
  const spherical = ['rho = sqrt(x^2+y^2+z^2)', 'theta = atan2(y,x)', 'phi = acos(z/rho)'];
  const box = { lo: [-6, -6, -6], hi: [6, 6, 6] };
  const errorsOf = (rows: string[]) => analyze(rows).rows.map(r => r.error);

  it('lets a field use z, and only defines: no plot row, no 3D scene', () => {
    const a = analyze(spherical);
    expect(a.rows.map(r => r.error).filter(Boolean)).toEqual([]);
    expect([...a.defs.fields.keys()]).toEqual(['rho', 'theta', 'phi']);
    expect(a.rows.some(r => r.cls)).toBe(false);
    // z alone reaches space too, so `h = z` is a field rather than an error.
    expect([...analyze(['h = z', 'h = 2']).defs.fields.keys()]).toEqual(['h']);
    expect(last(['h = z', 'h = 2']).type).toBe('implicit3d');
  });

  it('plots a second row over a z-using field as a surface', () => {
    for (const row of ['rho = 2', 'phi = pi/4', 'rho = 1 + cos(3 theta)', 'z = rho cos(phi)']) {
      expect(last([...spherical, row]).type).toBe('implicit3d');
    }
    // A planar field in the same document keeps its planar reading.
    const a = analyze([...spherical, 'theta = pi/4']);
    expect(a.rows.at(-1)!.cls!.plot.type).toBe('implicit2d');
    expect(a.rows.at(-1)!.cls!.needs3D).toBe(false);
  });

  it('leaves slider constants with chart-like names alone', () => {
    const a = analyze(['r = 2', 'theta = 1', 'rho = 3', 'phi = 0.5', 'y = r x + theta + rho + phi']);
    expect(a.rows.map(r => r.error).filter(Boolean)).toEqual([]);
    expect(a.defs.fields.size).toBe(0);
    expect(a.rows.at(-1)!.cls!.plot.type).toBe('implicit2d');
    expect(a.rows.at(-1)!.cls!.params).toEqual(['phi', 'r', 'rho', 'theta']);
  });

  it('resolves fields built from fields, in either order, and reports cycles', () => {
    const viaPolar = ['rho = sqrt(r^2 + z^2)', 'phi = atan2(r, z)', 'r = sqrt(x^2+y^2)', 'theta = atan2(y,x)'];
    const a = analyze([...viaPolar, 'rho = 2']);
    expect(a.rows.map(r => r.error).filter(Boolean)).toEqual([]);
    expect(a.rows.at(-1)!.cls!.plot.type).toBe('implicit3d');
    expect(evaluate(a.defs.fields.get('rho')!, { x: 1, y: 2, z: 2 })).toBeCloseTo(3, 12);
    expect(errorsOf(['a = b + z', 'b = a + x'])).toEqual([
      'a is defined in terms of itself.', 'b is defined in terms of itself.',
    ]);
    expect(errorsOf(['rho = sqrt(x^2+y^2+w)'])[0])
      .toBe('rho defines a coordinate (it uses x, y, or z), so it may only use x, y, z, t, and constants (found w).');
    expect(errorsOf(['s = (x, u)'])[0]).toMatch(/found u/);
  });

  it('draws the unit circle from the position vector', () => {
    const a = analyze(['s = (x, y)', 'dot(s, s) = 1']);
    expect(a.rows.map(r => r.error).filter(Boolean)).toEqual([]);
    expect(a.rows[0]!.def?.name).toBe('s');
    expect(a.rows[1]!.cls!.plot.type).toBe('implicit2d');
    expect(evaluate(a.rows[1]!.expr!, { x: 1, y: 0 })).toBe(0);
    expect(evaluate(a.rows[1]!.expr!, { x: 0, y: 0 })).toBe(-1);
  });

  it('accepts |s| = 1 and |s| < 1 as the same circle and disk', () => {
    expect(last(['s = (x, y)', '|s| = 1']).type).toBe('implicit2d');
    expect(last(['s = (x, y)', '|s| < 1']).type).toBe('ineq2d');
  });

  it('scales, rotates, and lifts the same construction', () => {
    const half = analyze(['s = (x, y)', 'q = 2 s', 'dot(q, q) = 1']);
    expect(half.rows.map(r => r.error).filter(Boolean)).toEqual([]);
    expect(half.rows.at(-1)!.cls!.plot.type).toBe('implicit2d');
    expect(evaluate(half.rows.at(-1)!.expr!, { x: 0.5, y: 0 })).toBe(0);

    expect(last(['F = (y, -x)', 'dot(F, F) = 1']).type).toBe('implicit2d');

    const sphere = last(['s = (x, y, z)', 'dot(s, s) = 1']);
    expect(sphere.type).toBe('implicit3d');
  });

  it('plots a bare vector-field name as a vector field, and does not grid it', () => {
    expect(last(['s = (x, y)', 's']).type).toBe('vfield2d');
    const a = analyze(['s = (x, y)', 'r = sqrt(x^2 + y^2)']);
    expect(a.rows.map(r => r.error).filter(Boolean)).toEqual([]);
    expect([...a.defs.fields.keys()].sort()).toEqual(['r', 's_x', 's_y']);
  });

  it('solves a spherical point, wrapping only the atan2-valued coordinate', () => {
    const p = last([...spherical, '(rho, theta, phi) = (2, 9pi/4, pi/3)']);
    if (p.type !== 'system') throw new Error('expected system');
    expect(p.dim).toBe(3);
    expect(p.angular).toEqual([false, true, false]);
    expect(p.coordinates).toBeUndefined(); // no drag in space
    const pts = solveSystem(p.residuals, ['x', 'y', 'z'], box.lo, box.hi, { angular: p.angular });
    expect(pts).toHaveLength(1);
    expect(pts[0][0]).toBeCloseTo(Math.sqrt(1.5), 7);
    expect(pts[0][1]).toBeCloseTo(Math.sqrt(1.5), 7);
    expect(pts[0][2]).toBeCloseTo(1, 7);
    // acos ranges over [0, π]: a polar angle past it names no point.
    const q = last([...spherical, '(rho, theta, phi) = (2, pi/4, pi/3 + 2pi)']);
    if (q.type !== 'system') throw new Error('expected system');
    expect(solveSystem(q.residuals, ['x', 'y', 'z'], box.lo, box.hi, { angular: q.angular })).toEqual([]);
  });

  it('reports no point where the chart is singular', () => {
    // theta is undefined on the z-axis, so the pole is not a solution of it.
    const p = last([...spherical, '(rho, theta, phi) = (2, 0, 0)']);
    if (p.type !== 'system') throw new Error('expected system');
    expect(solveSystem(p.residuals, ['x', 'y', 'z'], box.lo, box.hi, { angular: p.angular })).toEqual([]);
  });

  it('keeps cylindrical and Cartesian triples working', () => {
    const p = last([...polar, '(r, theta, z) = (1, 2, 3)']);
    if (p.type !== 'system') throw new Error('expected system');
    expect(p.dim).toBe(3);
    expect(p.angular).toEqual([false, true, false]);
    const pts = solveSystem(p.residuals, ['x', 'y', 'z'], box.lo, box.hi, { angular: p.angular });
    expect(pts).toHaveLength(1);
    expect(pts[0][0]).toBeCloseTo(Math.cos(2), 7);
    expect(pts[0][2]).toBeCloseTo(3, 7);
  });

  it('traces a space curve in the chart through every wrap of theta', () => {
    const p = last([...spherical, '(rho, theta, phi) = (2, 6 pi u, pi u)']);
    if (p.type !== 'system') throw new Error('expected system');
    expect(p.parametric).toBe(true);
    const paths = traceSystem(p.residuals, ['x', 'y', 'z'], box.lo, box.hi, {}, 256, p.angular);
    const longest = paths.reduce((a, b) => a.length > b.length ? a : b);
    expect(longest.length).toBeGreaterThan(250);
    for (let k = 1; k < longest.length; k++) {
      expect(Math.hypot(...longest[k].map((v, i) => v - longest[k - 1][i]))).toBeLessThan(0.3);
      expect(Math.hypot(...longest[k])).toBeCloseTo(2, 5);
    }
  });

  it('says truthfully what it does not cover', () => {
    expect(errorsOf([...spherical, '(rho, theta) = (2, pi/4)']).at(-1))
      .toBeUndefined();
    expect(errorsOf([...polar, '(r, theta, x) = (1, 2, 3)']).at(-1))
      .toBe('3 equations in 2 unknowns — a system needs one equation per unknown.');
    expect(errorsOf([...spherical, '(rho, rho, phi) = (1, 2, 3)']).at(-1))
      .toBe('(rho, rho, phi) repeats a coordinate — use distinct coordinates to determine a point or flow.');
    expect(errorsOf([...spherical, "(rho', theta') = (1, 1)"]).at(-1))
      .toBe('rho uses z, and coordinate flows are 2D only.');
    expect(errorsOf([...spherical, "(rho', theta', phi') = (1, 1, 1)"]).at(-1))
      .toBeUndefined();
    expect(errorsOf(["(x', z') = (1, 2)"]).at(-1))
      .toBe('Coordinate flows are 2D only — z cannot be a flow coordinate.');
    expect(errorsOf([...spherical, '(rho, theta, phi) = (1, 2)']).at(-1))
      .toBe('Mismatched components: 3 on the left, 2 on the right.');
  });
});
