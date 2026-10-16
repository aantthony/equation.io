import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { REACH_ALL, REACH_NONE, REACH_SOME, imul, intervalValue, lastReach } from './certify.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import { type Cond, certified, measureSet } from './measure.ts';
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
  it('encloses lambertw, rising from −1/e', () => {
    const [lo, hi] = at('lambertw(x)', [
      [0, Math.E],
      [0, 0],
    ]);
    expect(lo).toBeLessThanOrEqual(0);
    expect(lo).toBeGreaterThan(-1e-15);
    expect(hi).toBeGreaterThanOrEqual(1);
    expect(hi).toBeLessThan(1 + 1e-14);
    expect(
      at('lambertw(x)', [
        [-1, 0],
        [0, 0],
      ])[0],
    ).toBeLessThanOrEqual(-1);
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
  it('says how much of the box a function is defined on', () => {
    const reach = (s: string, x: [number, number]) => {
      at(s, [x, [0, 0]]);
      return lastReach();
    };
    expect(reach('sqrt(x)', [1, 4])).toBe(REACH_ALL);
    expect(reach('sqrt(x)', [-1, 4])).toBe(REACH_SOME);
    expect(reach('sqrt(x)', [-4, -1])).toBe(REACH_NONE);
    expect(reach('ln(x) + 1', [-1, 1])).toBe(REACH_SOME);
    expect(reach('acos(x)', [0.5, 3])).toBe(REACH_SOME);
    expect(reach('acos(x)', [2, 3])).toBe(REACH_NONE);
    expect(reach('x^0.5', [-1, 1])).toBe(REACH_SOME);
    // Whole powers are defined everywhere, and each enclosure starts afresh.
    expect(reach('x^2', [-1, 1])).toBe(REACH_ALL);
  });
  // Code review (2026-09-27): the enclosures of sqrt, ln and acos cover only
  // where they are defined, so a box partly out of the domain was proved
  // wholly inside, and these read ∞.
  it('measures a set partly outside a function’s domain where it is defined', () => {
    expect(value(['count(sqrt(x) < 1)'])).toBeCloseTo(1, 5);
    expect(value(['count(ln(x) < 0)'])).toBeCloseTo(1, 5);
    expect(value(['count(acos(x) < 1)'])).toBeCloseTo(1 - Math.cos(1), 5);
    expect(value(['count(sqrt(1 - x^2) > y > 0)'])).toBeCloseTo(Math.PI / 2, 4);
    expect(value(['count({ln(x) < 0, -5 < x < 5})'])).toBeCloseTo(1, 5);
    expect(value(['count(x^0.5 < 1)'])).toBeCloseTo(1, 5);
    expect(value(['total({sqrt(1 - x^2) > y > 0: y})'])).toBeCloseTo(2 / 3, 4);
    // Roots where the equation is defined are still counted.
    expect(value(['count(sqrt(x) = 0.5)'])).toBe(1);
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
  it('keeps a bound across the jump of sign', () => {
    // Were sign flat either side of its jump, the mean-value bounds would
    // take a cell across it as smooth: 1.3139, and 1.8906 with gap 0.
    const line = measureSet([lt('x - 0.5 + 0.3 sign(x - 0.3)')], [], ['x'], [-1], [1], {});
    expect(line.measure).toBeCloseTo(1.3, 4);
    const plane = measureSet([lt('y - 0.5 sign(x - 0.1234)')], [], XY, [-1, -1], [1, 1], {});
    expect(plane.measure).toBeCloseTo(1.8766, 3);
    expect(plane.gap).toBeGreaterThan(0);
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

// Code review (2026-09-27): what a reduction ranges over, when names are bound.
describe('reductions and the names around them', () => {
  it('a function’s parameter is its argument, never a slider of the same name', () => {
    // It was read from the slider: f(9) was 2√2, the measure at a = 2.
    const analysis = analyzeRows(['a = 2', 'f(a) = count({x^2 < a})', 'f(9)'], { readouts: true });
    expect(analysis.rows[1].error).toMatch(/cannot follow a/);
    expect(analysis.rows[2].error).toBeDefined();
    // A closed form still follows its parameter.
    expect(value(['a = 2', 'f(a) = total({0 < x < a: x})', 'f(3)'])).toBe(4.5);
  });

  it('a reduction inside ∫ … dx runs for each value of its variable', () => {
    // It took x as a continuous set too, and diverged.
    expect(value(['int[0..1] total({0 < u < 1: x u}) dx'])).toBe(0.25);
    expect(value(['int[0..1] mean({0 < u < 1: x + u}) dx'])).toBe(1);
    expect(value(['int[0..1] count({0 < u < x}) dx'])).toBeCloseTo(0.5, 6);
  });

  it('a filter a function hands back is the same filter as written out', () => {
    expect(value(['total({0 < x < 1, x > 0.5: x})'])).toBe(0.375);
    // f(1) is its body, so the reduction reads the same {c1, c2: f}.
    expect(value(['f(k) = {0 < x < k, x > 0.5: x}', 'total(f(1))'])).toBe(0.375);
  });

  it('a lone filter over one interval keeps numbers, as one over u does', () => {
    expect(value(['total(interval(1,3) < 2)'])).toBe(1.5);
    expect(value(['mean(interval(1,3) < 2)'])).toBe(1.5);
    expect(value(['total(u < 0.5)'])).toBe(0.125);
    // Two coordinates keep points, which are not numbers.
    expect(error(['total(x^2 + interval(0, 1)^2 < 1)'])).toMatch(/members of this filter are points/);
  });
});

/** The number a readout row holds (throws its error). */
function value(rows: string[]): number {
  const analysis = analyzeRows(rows, { readouts: true });
  const row = analysis.rows.at(-1)!;
  if (row.error) throw new Error(row.error);
  const object = row.cls?.object as { kind: string; expr?: Expr } | undefined;
  if (object?.kind !== 'value') throw new Error(`expected a value, got ${object?.kind}`);
  return evaluate(object.expr!, analysis.constEnv);
}
const error = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!.error ?? '';
const info = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!.info ?? '';

// Review findings for phase 8 (docs/multisets.md §9): each one a confident
// wrong number, a freeze, or an internal error before.
describe('measures: review findings', () => {
  it('1. a finite side of a coordinate does not cut the bounding box', () => {
    expect(value(['count(x^2 < y < 1)'])).toBeCloseTo(4 / 3, 5);
    expect(value(['count({y > x^2, y < 1})'])).toBeCloseTo(4 / 3, 5);
    expect(value(['count({x > y^2, x < 4})'])).toBeCloseTo(32 / 3, 4);
    // Arc length of y = x^2 for |x| < 1, and its half.
    expect(value(['count({y = x^2, y < 1})'])).toBeCloseTo(2.9578857, 4);
    expect(value(['count({x > 0, y = x^2, y < 1})'])).toBeCloseTo(1.4789429, 4);
  });

  it('2. 0·∞ is 0 in interval products, so a quarter plane is still bounded', () => {
    const [lo, hi] = imul([0, Infinity], [0, Infinity]);
    expect(lo).toBeLessThanOrEqual(0);
    expect(lo).toBeGreaterThan(-1e-300);
    expect(hi).toBe(Infinity);
    expect(imul([0, 2], [-Infinity, 0])[0]).toBe(-Infinity);
    expect(imul([0, 2], [-Infinity, 0])[1]).toBeGreaterThanOrEqual(0);
    expect(value(['count({x^2+y^2<1, x>0, y>0})'])).toBeCloseTo(Math.PI / 4, 5);
  });

  it('3. an empty or reversed range measures 0, never negative', () => {
    expect(value(['count({2<x<1})'])).toBe(0);
    expect(value(['count({0<x<1, 2<x<3})'])).toBe(0);
    expect(value(['total({2<x<1: x})'])).toBe(0);
    expect(error(['mean({2<x<1: x})'])).toMatch(/empty/);
    // With a slider the symbolic form clamps (and stays symbolic).
    expect(value(['a = -1', 'count({0<x<a})'])).toBe(0);
    expect(value(['a = 2', 'count({0<x<a})'])).toBe(2);
    expect(value(['a = 2', 'count({0<x<a, 1<x<3})'])).toBe(1);
    expect(value(['a = -1', 'count({y = x^2, 0<x<a})'])).toBe(0);
    expect(value(['a = -1', 'total({0<x<a: x})'])).toBe(0);
  });

  it('4. a divergent integral is an error (or ∞ for a length), not a finite number', () => {
    for (const row of [
      'total({0<x<1: 1/x})',
      'total(1/u)',
      'mean({0<x<1: 1/x})',
      'total({0<x<1: 1/x^2})',
      'total({0<x<2: 1/(x-1)^2})',
      'total({0<x<1: tan(pi x/2)})',
      // Not Lebesgue integrable, though it cancels.
      'total({-1<x<1: 1/x})',
      'total({x^2+y^2<1: 1/(x^2+y^2)})',
    ]) {
      expect(error([row]), row).toMatch(/diverges/);
    }
    expect(value(['count({y=1/x,-1<x<1})'])).toBe(Infinity);
    expect(value(['count({y=ln(x),-1<x<1})'])).toBe(Infinity);
    expect(value(['count({y = tan(x), 0<x<3})'])).toBe(Infinity);
    // Integrable singularities still integrate.
    expect(value(['total({0<x<1: 1/sqrt(x)})'])).toBeCloseTo(2, 8);
    expect(value(['total({0<x<1: ln(x)})'])).toBeCloseTo(-1, 8);
    expect(value(['total({x^2+y^2<1: 1/sqrt(x^2+y^2)})'])).toBeCloseTo(2 * Math.PI, 4);
    // Outside its domain the graph is simply not there.
    expect(value(['count({y=sqrt(x),-1<x<1})'])).toBeCloseTo(1.478942857544597, 8);
  });

  it('5. a graph with an infinite end slope measures the same as its implicit form', () => {
    const graph = value(['count({y = sqrt(1-x^2), -1<x<1})']);
    expect(graph).toBeCloseTo(Math.PI, 7);
    expect(Math.abs(graph - value(['count({x^2 + y^2 = 1, y > 0})'])) / Math.PI).toBeLessThan(1e-5);
    expect(value(['count({y=sqrt(x),0<x<1})'])).toBeCloseTo(1.478942857544597, 8);
    // x = y^3 for |y| < 1: 2 ∫₀¹ √(1 + 9y⁴) dy.
    expect(value(['count({y=x^(1/3),-1<x<1})'])).toBeCloseTo(3.0957312, 6);
    expect(value(['count({x = y^3, -1<y<1})'])).toBeCloseTo(3.0957312, 6);
  });

  it('6. roots are counted with certainty, or the count is refused', () => {
    expect(value(['count({-1000<x<1000, sin(x)=0})'])).toBe(637);
    expect(value(['count({0<x<1, sin(10000x)=0})'])).toBe(3183);
    expect(value(['count({0<x<100, sin(x^2)=0})'])).toBe(3183);
    expect(value(['count({0<x<10, cos(x)=0.3})'])).toBe(3);
    expect(error(['count({-100000<x<100000, sin(x)=0})'])).toMatch(/too many roots/);
    expect(error(['count({-1000000<x<1000000, sin(x)=0.5})'])).toMatch(/too many roots/);
    // Infinitely many, piling up at 0.
    expect(error(['count({-10<x<10, sin(1/x)=0})'])).toMatch(/too many roots/);
    expect(error(['count({-1<x<1, x sin(1/x)=0})'])).toMatch(/too many roots/);
    // A double root cannot be told from two, or none.
    expect(error(['count({0<x<10, sin(x)=1})'])).toMatch(/could not be told apart/);
  });

  it('7. a region is reported only as precisely as its bounds vouch for', () => {
    expect(value(['count((x-1000)^2+y^2<1)'])).toBeCloseTo(Math.PI, 5);
    // 6367 zeros of sin, each with 2 asin(0.001) around it.
    expect(value(['count({-10000<x<10000, abs(sin(x))<0.001})'])).toBeCloseTo(12734 * Math.asin(0.001), 3);
    expect(error(['count({-1000<x<1000,-1000<y<1000,sin(x)sin(y)>0})'])).toMatch(/precisely enough/);
    // Readouts show only the digits the error bound leaves; the last is uncertain.
    expect(certified(3.14159265, 0.004)).toBeCloseTo(3.142, 12);
    expect(certified(3.14159265, 1e-9)).toBe(3.14159265);
    expect(certified(0, 0.1)).toBe(0);
  });

  it('8. an intricate set is refused by the work budget, never a freeze', () => {
    // The wall clock is off in tests (lib/test-setup.ts), so each of these
    // ends on the deterministic budget alone, whatever the runner's speed.
    // (The remembered refusal and the clock are measure-limits.test.ts's.)
    for (const rows of [
      ['count({-1000<x<1000,-1000<y<1000, sin(x y)>0, cos(x+y)>0})'],
      ['a = 3', 'count({-1000<x<1000,-1000<y<1000, sin(a x y)>0})'],
      ['count({x^2+y^2<1, sin(1000 x y)>0})'],
      ['total({-1000<x<1000,-1000<y<1000, sin(x y)>0: x^2})'],
    ]) {
      expect(error(rows), rows.at(-1)).toMatch(/precisely enough/);
    }
  });

  it('9. jumps, lemniscates and infinite counts', () => {
    expect(error(['y = count({0<v<1, v<x})'])).not.toMatch(/Cannot compile/);
    expect(error(['y = count({0<v<1, v<x})'])).toMatch(/infinite/);
    // The jump of sign at 0 is not part of the zero set.
    expect(value(['count({y=sign(x),-1<x<1})'])).toBeCloseTo(2, 2);
    // Proved bounded through its leading form (x² − y² cancels on strips).
    expect(value(['count((x^2+y^2)^2 = x^2-y^2)'])).toBeCloseTo(5.2441151, 2);
    expect(value(['count((x^2+y^2)^2 < x^2-y^2)'])).toBeCloseTo(1, 3);
    // Bounded too; its root at the origin is singular, so it cannot be proved.
    expect(error(['count({x^5-x=y, y^5-y=x})'])).toMatch(/could not all be proved/);
    expect(info(['count(x^2+y^2<1)'])).toBe('≈ 3.14159');
  });
});

// Code review (2026-09-27): readings that were right in value but not in form.
describe('measures: the exact route and the readout', () => {
  it('a total smaller than its error bound reads ≈, never an exact = 0', () => {
    expect(info(['total({x^2+y^2<1: x + 0.0000001})'])).toMatch(/^≈ /);
    expect(value(['total({x^2+y^2<1: x + 0.0000001})'])).toBeGreaterThan(0);
    expect(certified(3e-7, 1e-6)).not.toBe(0);
    expect(certified(-3e-7, 1e-6)).toBeLessThan(0);
  });

  it('x = y with a range on x is the graph y = x over it, exactly', () => {
    // The first way round has the range on its solved coordinate; the other
    // way round is a graph, and was never tried.
    expect(value(['count({x = y, 0 < x < 1})'])).toBe(Math.SQRT2);
    expect(value(['count({y = x, 0 < y < 1})'])).toBe(Math.SQRT2);
  });
});
