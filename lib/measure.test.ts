import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { intervalValue } from './certify.ts';
import { parseExpr } from './expr.ts';
import { type Cond, measureSet } from './measure.ts';
import { runtimeSliderNames } from './runtime-sliders.ts';

const lt = (s: string, strict = true): Cond => ({ d: parseExpr(s), eq: false, strict });
const eq = (s: string): Cond => ({ d: parseExpr(s), eq: true, strict: false });
const XY = ['x', 'y'];
const PLANE = [-Infinity, -Infinity];
const PLANE_HI = [Infinity, Infinity];

describe('intervalValue', () => {
  const at = (s: string, box: Array<[number, number]>) => intervalValue(parseExpr(s), XY, box, {});
  it('encloses even powers from 0', () => {
    const [lo, hi] = at('x^2', [
      [-1, 2],
      [0, 0],
    ]);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThanOrEqual(4);
  });
  it('proves a far strip out of the disc', () => {
    const [lo] = at('x^2 + y^2 - 1', [
      [2, Infinity],
      [-Infinity, Infinity],
    ]);
    expect(lo).toBeGreaterThan(0);
  });
  it('bounds sin and cos by their peaks', () => {
    const [lo, hi] = at('sin(x)', [
      [0, Math.PI],
      [0, 0],
    ]);
    expect(lo).toBeLessThanOrEqual(0);
    expect(lo).toBeGreaterThan(-1e-15);
    expect(hi).toBe(1);
    expect(
      at('cos(x)', [
        [0.1, 0.2],
        [0, 0],
      ])[1],
    ).toBeLessThan(1);
  });
  it('encloses what it does not know as the whole line', () => {
    expect(
      at('gamma(x)', [
        [1, 2],
        [0, 0],
      ]),
    ).toEqual([-Infinity, Infinity]);
  });
});

describe('measureSet', () => {
  it('measures a region by its area, and integrates over it', () => {
    const disc = measureSet([lt('x^2 + y^2 - 1')], [parseExpr('x^2 + y^2')], XY, PLANE, PLANE_HI, {});
    expect(disc.measure).toBeCloseTo(Math.PI, 5);
    // ∫∫ r² over the unit disc is π/2.
    expect(disc.totals[0]).toBeCloseTo(Math.PI / 2, 5);
  });
  it('reads constants from the environment', () => {
    expect(measureSet([lt('x^2 + y^2 - a')], [], XY, PLANE, PLANE_HI, { a: 4 }).measure).toBeCloseTo(4 * Math.PI, 4);
  });
  it('intersects several conditions', () => {
    // The unit square's corner of the disc: a quarter disc.
    const quarter = measureSet([lt('x^2 + y^2 - 1'), lt('-x'), lt('-y')], [], XY, PLANE, PLANE_HI, {});
    expect(quarter.measure).toBeCloseTo(Math.PI / 4, 4);
  });
  it('measures a curve by its length', () => {
    expect(measureSet([eq('x^2 + y^2 - 1')], [], XY, PLANE, PLANE_HI, {}).measure).toBeCloseTo(2 * Math.PI, 4);
    // An ellipse, 2x by 1: its perimeter.
    expect(measureSet([eq('x^2/4 + y^2 - 1')], [], XY, PLANE, PLANE_HI, {}).measure).toBeCloseTo(9.688448, 4);
  });
  it('an unbounded set is infinite, never the part in a view', () => {
    expect(measureSet([lt('x^2 - y')], [], XY, PLANE, PLANE_HI, {}).measure).toBe(Infinity);
    expect(measureSet([lt('-x')], [], ['x'], [-Infinity], [Infinity], {}).measure).toBe(Infinity);
  });
  it('counts distinct points', () => {
    expect(measureSet([eq('x^2 - 2')], [], ['x'], [-Infinity], [Infinity], {}).measure).toBe(2);
    expect(measureSet([eq('(x - 1)^2')], [], ['x'], [-Infinity], [Infinity], {}).measure).toBe(1);
    expect(measureSet([eq('x^2 + y^2 - 4'), eq('x y - 1')], [], XY, PLANE, PLANE_HI, {}).measure).toBe(4);
  });
  it('refuses a count it cannot complete', () => {
    expect(() => measureSet([eq('sin(x)')], [], ['x'], [-Infinity], [Infinity], {})).toThrow(/could not all be found/);
  });
  it('keeps the ends of a range apart for points: < and ≤ differ', () => {
    const roots = (strict: boolean) =>
      measureSet([eq('x^3 - x'), lt('-x', strict)], [], ['x'], [-Infinity], [Infinity], {}).measure;
    expect(roots(true)).toBe(1);
    expect(roots(false)).toBe(2);
  });
});

describe('slider-dependent measures', () => {
  it('re-resolve when the slider moves', () => {
    // A numeric measure reads a's value, so a drag re-analyzes the document
    // instead of evaluating a stale number.
    expect([...runtimeSliderNames(analyzeRows(['a = 2', 'count(x^2 + y^2 < a)']))]).not.toContain('a');
    // A symbolic one keeps a in its expression, so it stays a runtime slider.
    expect([...runtimeSliderNames(analyzeRows(['a = 2', 'total(a u)']))]).toContain('a');
  });
});
