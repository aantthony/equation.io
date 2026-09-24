import { describe, expect, it } from 'vitest';
import { parseExpr } from './expr.ts';
import { specialPoints } from './special.ts';

function points(s: string, r = 10) {
  return specialPoints(parseExpr(s), -r, r, -r, r);
}

describe('specialPoints', () => {
  it('labels roots and the y-intercept of y = f(x)', () => {
    const pts = points('x^2 - 2');
    expect(pts.length).toBe(3);
    expect(pts[0]).toMatchObject({ x: -Math.SQRT2, y: 0 });
    expect(pts[0].lines[0]).toBe('root');
    expect(pts[1]).toMatchObject({ x: Math.SQRT2, y: 0 });
    expect(pts[2]).toMatchObject({ x: 0, y: -2 });
    expect(pts[2].lines[0]).toBe('y-intercept');
  });

  it('reports multiplicity in the tooltip lines', () => {
    const pts = points('(x-1)^2 (x+2)');
    const double = pts.find(p => Math.abs(p.x - 1) < 1e-12)!;
    expect(double.lines).toContain('double root');
  });

  it('finds all four axis intercepts of a circle', () => {
    const pts = points('x^2 + y^2 = 4');
    expect(pts.map(p => [p.x, p.y])).toEqual([
      [-2, 0],
      [2, 0],
      [0, -2],
      [0, 2],
    ]);
    expect(pts[0].lines[0]).toBe('x-intercept');
  });

  it('keeps a single point at the origin', () => {
    const pts = points('y = x');
    expect(pts.length).toBe(1);
    expect(pts[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('skips lines that lie on an axis rather than reporting infinite roots', () => {
    const pts = points('y = 0');
    // F(x, 0) ≡ 0: every x is an intercept, so none are listed; the
    // y-restriction y = 0 still yields the origin.
    expect(pts.length).toBe(1);
    expect(pts[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('handles transcendental curves through the numeric path', () => {
    const pts = points('y = sin(x)', 7);
    const roots = pts.filter(p => p.y === 0);
    expect(roots.length).toBe(5); // -2π, -π, 0, π, 2π
    expect(roots[4].x).toBeCloseTo(2 * Math.PI, 12);
  });

  it('shows exact symbolic labels with the decimal as a second line', () => {
    const pts = points('y = 2 - x^2');
    const pos = pts.find(p => p.x > 1 && p.y === 0)!;
    expect(pos.lines).toEqual(['x-intercept', 'x = √2', '≈ 1.41421356237']);
  });

  it('recognizes π multiples on numerically found roots', () => {
    const pts = points('y = sin(x)', 7);
    const labels = pts.filter(p => p.y === 0).map(p => p.lines[1]);
    expect(labels).toEqual(['x = -2π', 'x = -π', 'x = 0', 'x = π', 'x = 2π']);
  });

  it('does not π-label exact algebraic roots', () => {
    // 355/113 ≈ π to 7 digits, but the root is exactly rational.
    const pts = points('y = 113x - 355');
    const root = pts.find(p => p.y === 0)!;
    expect(root.lines[1]).toBe('x = 355/113');
  });
});
