import { describe, expect, it } from 'vitest';
import { parseExpr } from './expr.ts';
import { curveTracer, fmtTraced, roundTraced, specialPoints } from './special.ts';

function points(s: string, r = 10) {
  return specialPoints(parseExpr(s), -r, r, -r, r);
}

describe('specialPoints', () => {
  it('labels the x- and y-intercepts of y = f(x)', () => {
    const pts = points('y = x^2 - 2');
    expect(pts.length).toBe(3);
    expect(pts[0]).toMatchObject({ x: -Math.SQRT2, y: 0 });
    expect(pts[0].lines[0]).toBe('x-intercept');
    expect(pts[1]).toMatchObject({ x: Math.SQRT2, y: 0 });
    expect(pts[2]).toMatchObject({ x: 0, y: -2 });
    // The vertex is the y-intercept too: one point, both headings.
    expect(pts[2].lines[0]).toBe('y-intercept, local minimum');
  });

  it('reports multiplicity in the tooltip lines', () => {
    const pts = points('y = (x-1)^2 (x+2)');
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

describe('extrema', () => {
  const find = (s: string, heading: string, r = 10) => points(s, r).filter(p => p.lines[0].includes(heading));

  it('finds the maximum and minimum of a cubic with exact x', () => {
    const [max] = find('y = x^3 - 2x', 'local maximum');
    const [min] = find('y = x^3 - 2x', 'local minimum');
    expect(max.x).toBeCloseTo(-Math.sqrt(2 / 3), 14);
    expect(max.y).toBeCloseTo((4 / 3) * Math.sqrt(2 / 3), 14);
    expect(max.lines).toEqual(['local maximum', 'x = -√6/3', '≈ -0.816496580928', 'y = 1.0886621079']);
    expect(min.x).toBeCloseTo(Math.sqrt(2 / 3), 14);
  });

  it('marks inflection points where f″ changes sign', () => {
    const pts = find('y = exp(-x^2)', 'inflection point');
    expect(pts.map(p => p.x)).toEqual([expect.closeTo(-Math.SQRT1_2, 12), expect.closeTo(Math.SQRT1_2, 12)]);
  });

  it('folds an extremum on an axis into the intercept already there', () => {
    const pts = points('y = x^2');
    expect(pts.length).toBe(1);
    expect(pts[0].lines[0]).toBe('x-intercept, local minimum');
  });

  it('tells a stationary inflection from an extremum', () => {
    expect(points('y = x^3')[0].lines[0]).toBe('x-intercept, stationary inflection point');
    // x⁴ has f″(0) = 0 without a sign change: a minimum, not an inflection.
    expect(points('y = x^4')[0].lines[0]).toBe('x-intercept, local minimum');
  });

  it('labels π-multiple extrema of trigonometric graphs', () => {
    const maxima = find('y = sin(x)', 'local maximum', 7);
    expect(maxima.map(p => p.lines[1])).toEqual(['x = -3π/2', 'x = π/2']);
    expect(maxima.every(p => p.y === 1)).toBe(true);
  });

  it('finds the top and bottom of an implicit curve', () => {
    const pts = points('y^2 = x^3 - x + 1', 3);
    const max = pts.filter(p => p.lines[0] === 'local maximum');
    const min = pts.filter(p => p.lines[0] === 'local minimum');
    expect(max.length).toBe(2);
    expect(min.length).toBe(2);
    for (const p of [...max, ...min]) {
      expect(Math.abs(p.x)).toBeCloseTo(1 / Math.sqrt(3), 14);
      expect(p.y ** 2).toBeCloseTo(p.x ** 3 - p.x + 1, 14);
    }
  });

  it('does not call the crossings of a curve extrema', () => {
    // sin(xy) = cos(x) crosses itself at x = kπ, y = (n + ½)/k: F, Fx and Fy
    // all vanish there, and the Hessian is indefinite.
    const pts = points('sin(x y) = cos(x)', 10).filter(p => p.lines[0].includes('local'));
    for (const p of pts) {
      const fy = p.x * Math.cos(p.x * p.y);
      expect(Math.abs(fy)).toBeGreaterThan(1e-3);
    }
  });

  it('reports only genuine extrema on a curve too dense to search fully', () => {
    // Hundreds of horizontal tangents in view: the seeded search finds some,
    // never past the cap, and every one it reports is real.
    const pts = points('sin(x^2 + y^2) = cos(x y)', 30).filter(p => p.lines[0].includes('local'));
    expect(pts.length).toBeLessThanOrEqual(64);
    for (const { x, y } of pts) {
      expect(Math.abs(Math.sin(x * x + y * y) - Math.cos(x * y))).toBeLessThan(1e-9);
      expect(Math.abs(2 * x * Math.cos(x * x + y * y) + y * Math.sin(x * y))).toBeLessThan(1e-6);
    }
  });

  it('finds the extremum of a curve with a singular point', () => {
    // Seeds drawn to the folium's node at the origin must not spend the
    // budget before one reaches the top of the loop at (∛2, ∛4).
    const max = points('x^3 + y^3 = 3x y', 3).filter(p => p.lines[0] === 'local maximum');
    expect(max.length).toBe(1);
    expect(max[0].x).toBeCloseTo(Math.cbrt(2), 12);
    expect(max[0].y).toBeCloseTo(Math.cbrt(4), 12);
  });

  it('bounds the work on a curve with no extrema', () => {
    const t0 = performance.now();
    points('tan(x y) = 1', 10);
    expect(performance.now() - t0).toBeLessThan(150);
  });

  it('skips the horizontal tangents outside the view', () => {
    expect(find('y = x^3 - 2x', 'local', 0.5)).toEqual([]);
  });
});

describe('curveTracer', () => {
  it('projects the pointer onto the nearest point of a circle', () => {
    const trace = curveTracer(parseExpr('x^2 + y^2 = 4'))!;
    const p = trace(1.5, 1.5, 0.01, 0.01)!;
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(2, 12);
    expect(p.x).toBeCloseTo(Math.SQRT2, 6);
    expect(p.dist).toBeCloseTo((Math.hypot(1.5, 1.5) - 2) / 0.01, 4);
  });

  it('measures distance in pixels on an anisotropic view', () => {
    // y is squashed 100×: the nearest point in pixels is straight across.
    const trace = curveTracer(parseExpr('x = 1'))!;
    const p = trace(0, 0.5, 0.01, 1)!;
    expect(p).toMatchObject({ x: 1, y: 0.5 });
    expect(p.dist).toBeCloseTo(100, 9);
  });

  it('reads an exact (x, f(x)) pair off a graph', () => {
    const trace = curveTracer(parseExpr('y = x^2'))!;
    const p = trace(1.2345678, 1.6, 0.01, 0.01)!;
    expect(p.x * 1000).toBeCloseTo(Math.round(p.x * 1000), 9); // a tenth of a pixel
    expect(p.y).toBe(p.x * p.x);
  });

  it('reads off an x the tooltip shows exactly', () => {
    // A pixel of 0.0123 is not a decimal grid: x must land on the displayed
    // digits, or y = f(x) reads one unit off in its last place.
    const trace = curveTracer(parseExpr('y = 3x'))!;
    for (const mx of [0.1, 2.5, -1.37]) {
      const p = trace(mx, 3 * mx, 0.0123, 0.0123)!;
      const sx = fmtTraced(p.x, 0.0123);
      expect(p.x).toBe(parseFloat(sx));
      expect(p.y).toBe(3 * p.x);
    }
  });

  it('uses the given constants', () => {
    const trace = curveTracer(parseExpr('y = a x'), { a: 3 })!;
    const p = trace(1, 3, 0.01, 0.01)!;
    expect(p).toMatchObject({ x: 1, y: 3, dist: 0 });
  });

  it('returns null when the curve has no real points near', () => {
    const trace = curveTracer(parseExpr('x^2 + y^2 = -1'))!;
    expect(trace(0.1, 0.1, 0.01, 0.01)).toBeNull();
  });
});

describe('fmtTraced', () => {
  it('shows one digit finer than a pixel', () => {
    expect(fmtTraced(1.23456789, 0.01)).toBe('1.235');
    expect(fmtTraced(1.5, 0.01)).toBe('1.5');
    expect(fmtTraced(1234.5678, 2)).toBe('1234.6');
    expect(fmtTraced(-0.00001, 0.01)).toBe('0');
  });

  it('reads 0 under a twentieth of a pixel, whatever the exponent', () => {
    expect(fmtTraced(8.3e-7, 0.01)).toBe('0');
    expect(fmtTraced(9.95e-10, 0.01)).toBe('0');
    // On a fine enough view the same value is a real reading.
    expect(fmtTraced(8.3e-7, 1e-9)).toBe('0.00000083');
  });

  it('round-trips through roundTraced', () => {
    for (const [v, u] of [
      [1.23456789, 0.01],
      [123456.789, 0.5],
      [3.3e-9, 1e-11],
      [-7.25, 0.0123],
    ])
      expect(fmtTraced(roundTraced(v, u), u)).toBe(fmtTraced(v, u));
  });
});
