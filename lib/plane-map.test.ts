import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { axisMapping, mapRowExpr } from './axis-map.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import type { Components } from './math-object.ts';
import { type PlaneMap, parsePlaneMap, planeInverse, planeToWorld, planeWorldBox } from './plane-map.ts';
import { type View2DSpec, formatViewSpec, parseViewRow } from './view.ts';

const POLAR = 'view((x, y) = (Y cos(X), Y sin(X)), X = -pi..pi, Y = 0..5)';
const polar = () => (parseViewRow(POLAR, {}) as View2DSpec).maps!.plane!;
const box = { lo: [-Math.PI, 0] as const, hi: [Math.PI, 5] as const };
const object = (rows: string[], at = rows.length - 1) => {
  const row = analyzeRows(rows).rows[at];
  if (row.error) throw new Error(row.error);
  return row.cls!.object;
};

describe('a plane map', () => {
  it('frames the screen, and writes back as it reads', () => {
    const spec = parseViewRow(POLAR, {}) as View2DSpec;
    expect(spec.x![0]).toBeCloseTo(-Math.PI, 12);
    expect(spec.y).toEqual([0, 5]);
    const again = parseViewRow(formatViewSpec(spec), {}) as View2DSpec;
    expect(again.maps!.plane!.text).toBe('(Y cos(X), Y sin(X))');
    expect(again.y).toEqual([0, 5]);
    // Alone, it frames the screen's origin.
    expect((parseViewRow('view((x, y) = (exp(X), Y))', {}) as View2DSpec).x).toEqual([-5, 5]);
  });

  it('reads sliders at their value', () => {
    const map = parsePlaneMap('(k Y cos(X), Y sin(X))', { k: 2 });
    expect(planeToWorld(map, 0, 1)).toEqual([2, 0]);
    expect(() => parsePlaneMap('(k Y, X)')).toThrow(/k has no fixed value/);
  });

  it('says what is wrong with a row it cannot use', () => {
    for (const [row, message] of [
      ['view((x, y) = (X, X))', /flattens the screen/],
      ['view((x, y) = X)', /writes x and y/],
      ['view((x, y) = (X, Y), x = 0..1)', /give X = lo..hi/],
      ['view((x, y) = (X, Y), x = 10^X)', /not both/],
      ['view((x, y) = (X, Y), i = 0..1)', /framed by X and Y/],
    ] as const)
      expect(() => parseViewRow(row, {}), row).toThrow(message);
  });

  it('finds every screen point showing a point, and only those', () => {
    const inverse = planeInverse(polar(), box);
    const map = polar();
    for (const [x, y] of [
      [1, 1],
      [3, -4],
      [-2, 0.001],
      [0.01, 0.02],
    ]) {
      const found = inverse.all(x, y);
      expect(found.length, `${x}, ${y}`).toBeGreaterThan(0);
      for (const [X, Y] of found) {
        const [wx, wy] = planeToWorld(map, X, Y);
        expect(wx).toBeCloseTo(x, 7);
        expect(wy).toBeCloseTo(y, 7);
      }
      // The one in the window: the angle and radius.
      const [X, Y] = inverse.first(x, y);
      expect(X).toBeCloseTo(Math.atan2(y, x), 6);
      expect(Y).toBeCloseTo(Math.hypot(x, y), 6);
    }
    // Far outside what the window shows: nowhere.
    expect(inverse.all(100, 100)).toEqual([]);
    expect(inverse.first(100, 100).every(Number.isNaN)).toBe(true);
  });

  it('follows a line on the copy it started on, and cuts it just past the edge', () => {
    const inverse = planeInverse(polar(), box);
    const follow = inverse.follower();
    // Round the circle r = 2 from angle 3: across the seam at π, and back.
    const angles = [3, 3.1, 3.4, 3.5];
    const out = angles.map(a => follow(2 * Math.cos(a), 2 * Math.sin(a)));
    expect(out[0][0]).toBeCloseTo(3, 6);
    expect(out[1][0]).toBeCloseTo(3.1, 6);
    // 3.4 is past the window's edge (π) by more than the follow margin, 2%
    // of the window (0.126): cut.
    expect(out[2].every(Number.isNaN)).toBe(true);
    // Then it starts afresh where the screen shows it, at the other edge.
    expect(out[3][0]).toBeCloseTo(3.5 - 2 * Math.PI, 6);
  });

  it('bounds what the window shows in x and y', () => {
    const world = planeWorldBox(polar(), box)!;
    expect(world.lo[0]).toBeCloseTo(-5, 6);
    expect(world.hi[1]).toBeCloseTo(5, 2);
  });
});

describe('rows through a plane map', () => {
  const map = (): PlaneMap => polar();
  const at = (e: Expr, X: number, Y: number) => evaluate(e, { x: X, y: Y });

  it('put the map in for x and y, a graph included', () => {
    // The circle r = 2 is the screen's line Y = 2.
    const circle = mapRowExpr(parseExpr('x^2 + y^2 = 4'), { plane: map() }) as Expr & { kind: 'eq' };
    const residual = (X: number, Y: number) => at(circle.l, X, Y) - at(circle.r, X, Y);
    expect(residual(1.2, 2)).toBeCloseTo(0, 12);
    expect(residual(1.2, 3)).not.toBeCloseTo(0, 3);
    // y = x is no graph on the screen: both sides carry the map.
    const line = mapRowExpr(parseExpr('y = x'), { plane: map() }) as Expr & { kind: 'eq' };
    expect(at(line.l, Math.PI / 4, 2) - at(line.r, Math.PI / 4, 2)).toBeCloseTo(0, 12);
  });

  it('carry a flow back through the Jacobian', () => {
    // A rotation (−y, x) turns the angle at rate 1 and leaves the radius:
    // (1, 0) on the screen, everywhere.
    const rotation = object([POLAR, '(-y, x)']) as { components: Components };
    const [P, Q] = rotation.components;
    for (const [X, Y] of [
      [0.3, 1],
      [2, 4],
    ]) {
      expect(at(P, X, Y)).toBeCloseTo(1, 9);
      expect(at(Q, X, Y)).toBeCloseTo(0, 9);
    }
    // A source (x, y) moves the radius at the radius.
    const [U, V] = (object([POLAR, "(x', y') = (x, y)"]) as { components: Components }).components;
    expect(at(U, 1, 3)).toBeCloseTo(0, 9);
    expect(at(V, 1, 3)).toBeCloseTo(3, 9);
  });

  it('carry a tensor field by the full Jacobian', () => {
    const tensor = object([POLAR, '((x, 0), (0, 1))']) as { entries: Expr[]; jacobian: Expr[] };
    // ∂(x, y)/∂(X, Y) at (X, Y) = (π/2, 2): ((−2, 0), (0, 1)).
    const J = tensor.jacobian.map(e => at(e, Math.PI / 2, 2));
    expect(J.map(v => +v.toFixed(9))).toEqual([-2, 0, 0, 1]);
  });

  it('place what the map’s way back carries, and refuse bars and shading', () => {
    const rows = [POLAR, '(1, 1)', 'polygon((1, 1), (2, 0), (0, 2))', 'w^3 = 8', 'hist([1, 2, 2])', 'int[0..1] x dx'];
    const a = analyzeRows(rows).rows;
    const maps = { plane: map() };
    expect(a.slice(1, 4).map(r => axisMapping(r.cls!.object, maps))).toEqual(['place', 'place', 'place']);
    expect(a[4].error).toMatch(/maps its axes/);
    // An integral is still a value, but there is no y = 0 line to shade to.
    expect(a[5].error).toBeUndefined();
    expect(a[5].cls!.object).not.toHaveProperty('shade');
  });
});
