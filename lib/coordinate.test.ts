import { describe, it, expect } from 'vitest';
import { evaluate, parseExpr } from './expr.ts';
import { classify } from './plot.ts';
import { solveSystem, traceSystem } from './solve.ts';
import { complexParts } from './complex-parts.ts';
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
  it('does not wrap logarithm residuals as coordinate angles', () => {
    expect(solutions(['ln(w) = 9i'])).toHaveLength(0);
  });
  it('handles zero roots and principal square roots', () => {
    expect(solutions(['w^3 = 0'])).toHaveLength(1);
    const z = complexParts(parseExpr('sqrt(-1+0i)')).map(e => evaluate(e, {}));
    expect(z).toEqual([0, 1]);
  });
  it('keeps real projections as implicit equations', () => {
    expect(classify(parseExpr('re(w^2) = 1')).plot.type).toBe('implicit2d');
  });
});

describe('parametric system branches', () => {
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
});
