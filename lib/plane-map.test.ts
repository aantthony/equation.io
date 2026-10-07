import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { axisMapping, mapRowExpr } from './axis-map.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import { regionSampler } from './path.ts';
import type { Components } from './math-object.ts';
import {
  type PlaneMap,
  invert2,
  parsePlaneMap,
  pixelSpan,
  planeInverse,
  planeShapes,
  planeToWorld,
  planeWorldBox,
} from './plane-map.ts';
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

  it('carries a line across the seam without a gap, and an exit only once', () => {
    const inverse = planeInverse(polar(), box);
    // The circle r = 2 from angle 2.5 to 4.1, across the seam at π.
    const n = 400;
    const circle = (k: number): [number, number] => {
      const a = 2.5 + (1.6 * k) / (n - 1);
      return [2 * Math.cos(a), 2 * Math.sin(a)];
    };
    const out = inverse.line(n, circle, false);
    const runs: number[][] = [[]];
    for (let i = 0; i + 1 < out.length; i += 2)
      if (Number.isNaN(out[i])) runs.push([]);
      else runs[runs.length - 1].push(out[i]);
    const shown = runs.filter(r => r.some(X => Math.abs(X) <= Math.PI));
    expect(shown.length).toBe(2);
    // One leaves at the right edge, the other comes back in at the left.
    expect(Math.max(...shown[0])).toBeGreaterThanOrEqual(Math.PI);
    expect(Math.min(...shown[1])).toBeLessThanOrEqual(-Math.PI + 0.02);
    // Leaving through an edge with no seam (out past r = 5): drawn once.
    const exit = inverse.line(
      3,
      k =>
        [
          [1, 0.5],
          [6, 0.5],
          [6, 1],
        ][k] as [number, number],
      false,
    );
    const inside = [];
    for (let i = 0; i + 1 < exit.length; i += 2) if (inverse.inside(exit[i], exit[i + 1])) inside.push(exit[i]);
    expect(inside.length).toBe(1);
  });

  it('carries triangles at the window’s edge, and across the seam on both sides', () => {
    const inverse = planeInverse(polar(), box);
    // Its corners just past r = 5, the top edge: kept, not dropped.
    const edge = inverse.triangles([4.8, 0, 5.6, 0, 4.8 * Math.cos(0.2), 4.8 * Math.sin(0.2)]);
    expect(edge.length).toBe(6);
    // Across the negative x axis: one copy at each edge.
    const seam = inverse.triangles([-2, 0.3, -2, -0.3, -3, 0]);
    expect(seam.length).toBe(12);
    const firsts = [seam[0], seam[6]].sort((p, q) => p - q);
    expect(firsts[0]).toBeLessThan(0);
    expect(firsts[1]).toBeGreaterThan(0);
  });

  it('fills a region larger than the window, once, with no holes', () => {
    const tris = regionSampler([parseExpr('6u cos(2pi v)'), parseExpr('6u sin(2pi v)')]).sample({});
    const covered = (out: Float64Array, px: number, py: number) => {
      let n = 0;
      for (let k = 0; k + 5 < out.length; k += 6) {
        const [ax, ay, bx, by, cx, cy] = out.subarray(k, k + 6);
        const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
        const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
        const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) n++;
      }
      return n;
    };
    // The window, and one wider than a full turn, which shows it twice.
    for (const w of [Math.PI, 6.9]) {
      const out = planeInverse(polar(), { lo: [-w, 0], hi: [w, 5] }).triangles(tris);
      for (let X = -w + 0.03; X < w; X += 0.4)
        for (const Y of [0.05, 0.13, 1.7, 4.9]) {
          // Inside the disc of radius 6: covered, and not over and over.
          const n = covered(out, X, Y);
          expect(n, `${w}: ${X}, ${Y}`).toBeGreaterThan(0);
          expect(n, `${w}: ${X}, ${Y}`).toBeLessThanOrEqual(2);
        }
    }
  });

  it('fills a shape on each copy it shows on, and one round the origin not at all', () => {
    const inverse = planeInverse(polar(), box);
    const shape = (pts: number[][]) => planeShapes(inverse, pts.length, k => pts[k] as [number, number]);
    // Across the negative x axis: whole, and filled, at each edge.
    const seam = shape([
      [-4, 1],
      [-4, -1],
      [-2, 0],
    ]);
    expect(seam.map(s => s.closed)).toEqual([true, true]);
    // Starting at the origin, which the screen shows all along Y = 0: one.
    expect(
      shape([
        [0, 0],
        [6, 0],
        [6, 1],
      ]).map(s => s.closed),
    ).toEqual([true]);
    // Round the origin, it does not close on the screen: an outline only.
    const square = shape([
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]);
    expect(square.map(s => s.closed)).toEqual([false]);
  });

  it('draws what crosses the screen between ends far off it', () => {
    const inverse = planeInverse(polar(), box);
    // A chord from (-10, 0.5) to (10, 0.5): over the screen near angle π/2.
    const chord = inverse.line(2, k => (k ? [10, 0.5] : [-10, 0.5]) as [number, number], false);
    const shown = [];
    for (let i = 0; i + 1 < chord.length; i += 2) if (inverse.inside(chord[i], chord[i + 1])) shown.push(chord[i]);
    expect(shown.length).toBeGreaterThan(2);
    // A square far round the screen: the screen is inside it, filled.
    const square = [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
    ];
    const fill = planeShapes(inverse, 4, k => square[k] as [number, number]);
    expect(fill.map(s => s.closed)).toEqual([true]);
  });

  it('inverts the Jacobian, and sizes a pixel in x and y', () => {
    expect(invert2([2, 0, 0, 4])).toEqual([0.5, -0, -0, 0.25]);
    // At angle π/2, radius 2: a step along X moves x by −2, along Y moves y.
    const [px, py] = pixelSpan(polar(), Math.PI / 2, 2, 0.01, 0.02);
    expect(px).toBeCloseTo(0.02, 9);
    expect(py).toBeCloseTo(0.02, 9);
  });

  it('takes a map defined only away from the origin', () => {
    expect(() => parsePlaneMap('(ln(X - 10) cos(Y), ln(X - 10) sin(Y))')).not.toThrow();
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
    expect(a[4].error).toMatch(/bends the line y = 0/);
    // An integral is still a value, but there is no y = 0 line to shade to.
    expect(a[5].error).toBeUndefined();
    expect(a[5].cls!.object).not.toHaveProperty('shade');
  });
});
