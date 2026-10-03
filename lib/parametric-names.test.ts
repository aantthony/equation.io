import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { type Expr, evaluate } from './expr.ts';

const kinds = (rows: string[]) => analyzeRows(rows).rows.map(r => r.error ?? r.cls?.object.kind ?? r.def?.kind);

describe('named curves and surfaces', () => {
  it('inline a named parametric vector into later rows', () => {
    // Before, c_y failed: "can only depend on other constants and t (found u)".
    expect(kinds(['c = (cos(2pi u), sin(2pi u))', 'c', '2c', 'c + (1, 0)'])).toEqual([
      'const',
      'curve',
      'curve',
      'curve',
    ]);
    expect(kinds(['A = ((2, 1), (1, 1))', 'c = (cos(2pi u), sin(2pi u))', 'A c'])).toEqual(['const', 'const', 'curve']);
    expect(kinds(['S = (sin(pi v)cos(2pi u), sin(pi v)sin(2pi u), cos(pi v))', '2S'])).toEqual(['const', 'surface']);
    expect(kinds(['k = u^2', '(u, k)'])).toEqual(['const', 'curve']);
  });

  it('draws the same curve as writing it inline', () => {
    const named = analyzeRows(['A = ((2, 1), (1, 1))', 'c = (cos(2pi u), sin(2pi u))', 'A c']).rows[2].cls!.object;
    const inline = analyzeRows(['A = ((2, 1), (1, 1))', 'A (cos(2pi u), sin(2pi u))']).rows[1].cls!.object;
    expect(named).toEqual(inline);
  });

  it('draws no grid of its own', () => {
    expect(analyzeRows(['k = u^2', 'c = (u, u^2)']).gridFields).toEqual([]);
  });

  it('says what went wrong in the terms of a curve', () => {
    // c_y = k holds no u itself, but it is part of the curve c.
    for (const row of ['c = (u, k)', 'c = (k, u)', 'm = u + k']) {
      const [r] = analyzeRows([row]).rows;
      expect(r.error, row).toMatch(/is a curve or surface \(it uses u or v\).*found k/);
    }
    expect(analyzeRows(['s = (x, u)']).rows[0].error).toMatch(/mixes position.*found u/);
  });

  it('treats a second definition of a curve value as a redefinition', () => {
    expect(analyzeRows(['k = u', 'k = 0.5']).rows[1].error).toBe('k is already defined.');
    // A field over position keeps its level sets: r = 2 is a circle.
    expect(kinds(['r = sqrt(x^2 + y^2)', 'r = 2'])).toEqual(['const', 'curve']);
    expect(kinds(['rho = sqrt(x^2 + y^2 + z^2)', 'rho = 2'])).toEqual(['const', 'surface']);
  });
});

describe('a range for u and v', () => {
  const value = (rows: string[]): number => {
    const a = analyzeRows(rows, { readouts: true });
    const row = a.rows.at(-1)!;
    if (row.error) throw new Error(row.error);
    return evaluate((row.cls!.object as { expr: Expr }).expr, a.constEnv);
  };

  it('u = interval(a, b) is the range u runs over, (0, 1) when unset', () => {
    // The whole circle: the default range scaled by 2pi.
    const set = analyzeRows(['u = interval(0, 2pi)', '(cos(u), sin(u))']).rows[1].cls!.object;
    const scaled = analyzeRows(['(cos((2pi - 0) u), sin((2pi - 0) u))']).rows[0].cls!.object;
    expect(set).toEqual(scaled);
    expect(kinds(['u = interval(0, 2pi)', 'v = interval(0, pi)', '(cos(u) sin(v), sin(u) sin(v), cos(v))'])).toEqual([
      'const',
      'const',
      'surface',
    ]);
    expect(kinds(['v = interval(0, pi)', '(u, v)'])).toEqual(['const', 'region']);
    expect(kinds(['a = 1', 'u = interval(-a, a)', '(u, u^2)'])).toEqual(['const', 'const', 'curve']);
    expect(kinds(['u = interval(0, 2pi)', 'c = (cos(u), sin(u))', '2c'])).toEqual(['const', 'const', 'curve']);
    expect(kinds(['u = interval(0, 2pi)', '(x, y) = (cos(u), sin(u))'])).toEqual(['const', 'system']);
    expect(value(['u = interval(0, 2pi)', 'total(u)'])).toBeCloseTo(2 * Math.PI ** 2);
    expect(value(['u = interval(0, 2pi)', 'count(u)'])).toBeCloseTo(2 * Math.PI);
  });

  it('only an interval redefines u', () => {
    expect(analyzeRows(['u = 0.5']).rows[0].error).toMatch(/u = interval\(0, 2pi\)/);
    expect(analyzeRows(['u = interval(0, 1)', 'u = interval(0, 2)']).rows[1].error).toBe('u is already defined.');
    // A function's own u is still its parameter.
    expect(kinds(['u = interval(0, 2pi)', 'f(u) = u^2', '(u, f(1))'])).toEqual(['const', 'fn', 'curve']);
  });

  it('curve operators read the curve at values of u in its range', () => {
    expect(value(['u = interval(0, 2pi)', 'curvature((2cos(u), 2sin(u)), 1)'])).toBeCloseTo(0.5);
    // The ellipse (cos u, 2 sin u) at u = 0: κ = a/b² = 1/4.
    expect(value(['u = interval(0, 2pi)', 'C = (cos(u), 2sin(u))', 'curvature(C, 0)'])).toBeCloseTo(0.25);
    expect(value(['u = interval(0, 2pi)', 'C = (cos(u), 2sin(u))', 'k(s) = curvature(C, s)', 'k(0)'])).toBeCloseTo(
      0.25,
    );
    expect(value(['u = interval(0, 2pi)', 'C = (cos(u), sin(u), u)', 'torsion(C, 0)'])).toBeCloseTo(0.5);
    expect(kinds(['u = interval(0, 2pi)', 'C = (cos(u), 2sin(u))', '(u, curvature(C))'])).toEqual([
      'const',
      'const',
      'curve',
    ]);
  });
});
