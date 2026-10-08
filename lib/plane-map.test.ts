import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { axisMapping, mapRowExpr } from './axis-map.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import { regionSampler } from './path.ts';
import type { Components } from './math-object.ts';
import {
  type PlaneMap,
  type Segment,
  invert2,
  parsePlaneMap,
  pixelSpan,
  planeLines,
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
    // Round the origin it does not close on the screen: its outline is a
    // line, and what it encloses is filled down to the fold, Y = 0, a turn
    // at a time, with no outline of its own.
    const square = shape([
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]);
    const fills = square.filter(s => s.closed);
    expect(fills.every(s => s.stroke === false)).toBe(true);
    expect(square.filter(s => !s.closed).length).toBe(1);
    // Filled under the scallops across the screen, and not above them.
    const filled = (X: number, Y: number) => fills.some(f => inPolygon(f.pts, X, Y));
    for (const X of [-3, -1.5, 0.3, 2.9]) {
      expect(filled(X, 0.5), `${X}`).toBe(true);
      expect(filled(X, 2), `${X}`).toBe(false);
    }
  });

  it('fills round a fold only where the screen shows it', () => {
    const square = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const vertex = (k: number) => square[k] as [number, number];
    // z²: no turn repeats it, so nothing lands past where the square's
    // preimage lies (radius under 1.2), stepped across the screen.
    const z2 = parsePlaneMap('(X^2 - Y^2, 2 X Y)');
    for (const shape of planeShapes(planeInverse(z2, { lo: [-2, -2], hi: [2, 2] }), 4, vertex))
      for (let i = 0; i + 1 < shape.pts.length; i += 2)
        expect(Math.hypot(shape.pts[i], shape.pts[i + 1])).toBeLessThan(1.3);
    // Polar, with the window reaching below Y = 0, where it shows the square
    // again (the copy at (X + π, −Y)): filled on both sides.
    const both = planeShapes(planeInverse(polar(), { lo: [-Math.PI, -0.5], hi: [Math.PI, 5.5] }), 4, vertex);
    const fills = both.filter(s => s.closed);
    for (const [X, Y] of [
      [0.3, 0.5],
      [0.3, -0.3],
      [-2, -0.3],
    ])
      expect(
        fills.some(f => inPolygon(f.pts, X, Y)),
        `${X}, ${Y}`,
      ).toBe(true);
    // Zoomed in by the origin, a shape broken off is never filled.
    for (const shape of planeShapes(planeInverse(polar(), { lo: [-1, 0.2], hi: [1, 1.2] }), 4, vertex))
      if (shape.closed) expect(shape.pts.every(Number.isFinite)).toBe(true);
  });

  it('finds the points the map folds at', () => {
    const folds = planeInverse(polar(), box).foldPoints();
    expect(folds.length).toBe(1);
    expect(Math.hypot(...folds[0])).toBeLessThan(1e-9);
    // The polar origin is a point alone; (X, Y²) folds along all of y = 0,
    // the edge of what it reaches, so no point of it is.
    expect(planeInverse(polar(), box).isolated([0, 0])).toBe(true);
    expect(planeInverse(parsePlaneMap('(X, Y^2)'), box).isolated([0.5, 0])).toBe(false);
  });

  it('finds every copy, and draws a line on each, in a window wider than a turn', () => {
    const wide = planeInverse(polar(), { lo: [-8, -2.5], hi: [8, 7.5] });
    // (−4, 1) at angle 2.897 + 2πk, radius 4.12, and at angle −0.245 + 2πk,
    // radius −4.12: seven of them in and around the window.
    expect(wide.all(-4, 1).length).toBe(7);
    // The circle r = 2, round from angle 0 to 2π: on the screen, Y = 2 all
    // across, X from −8 to 8 — on more than one copy.
    const n = 200;
    const circle = (k: number): [number, number] => [
      2 * Math.cos((2 * Math.PI * k) / n),
      2 * Math.sin((2 * Math.PI * k) / n),
    ];
    const lines = planeLines(wide, n, circle, true);
    const xs: number[] = [];
    for (const line of lines)
      for (let i = 0; i + 1 < line.length; i += 2)
        if (Number.isFinite(line[i]) && Math.abs(line[i + 1] - 2) < 1e-6) xs.push(line[i]);
    expect(Math.min(...xs)).toBeLessThan(-7.9);
    expect(Math.max(...xs)).toBeGreaterThan(7.9);
    // Coarse, its straight runs cover the window with no gaps between copies.
    const m = 24;
    const coarse = (k: number): [number, number] => [
      2 * Math.cos((2 * Math.PI * k) / m),
      2 * Math.sin((2 * Math.PI * k) / m),
    ];
    const runs: Array<[number, number]> = [];
    for (const line of planeLines(wide, m, coarse, true))
      for (let i = 0; i + 3 < line.length; i += 2)
        if ([line[i], line[i + 1], line[i + 2], line[i + 3]].every(Number.isFinite) && Math.abs(line[i + 1] - 2) < 1e-6)
          runs.push([Math.min(line[i], line[i + 2]), Math.max(line[i], line[i + 2])]);
    runs.sort((p, q) => p[0] - q[0]);
    let reach = -8;
    for (const [a, b] of runs) {
      expect(a, `gap before ${a}`).toBeLessThanOrEqual(reach + 1e-9);
      reach = Math.max(reach, b);
      if (reach >= 8) break;
    }
    expect(reach).toBeGreaterThanOrEqual(8);
    // A shape round the origin there: its outline on each copy too.
    const square = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const outlines = planeShapes(wide, 4, k => square[k] as [number, number]).filter(s => !s.closed);
    expect(outlines.length).toBeGreaterThan(1);
  });

  it('finds every copy and draws each once, whatever it starts from', () => {
    const wide = planeInverse(polar(), { lo: [-3 * Math.PI, 0], hi: [3 * Math.PI, 5] });
    // A point's copies in the window: one per turn its angle fits.
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 400; i++) {
      const [r, t] = [0.2 + 4.6 * rand(), 2 * Math.PI * rand() - Math.PI];
      const expected = [-1, 0, 1].filter(k => Math.abs(t + 2 * Math.PI * k) <= 3 * Math.PI).length;
      const inWindow = wide.all(r * Math.cos(t), r * Math.sin(t)).filter(p => wide.inside(p[0], p[1]));
      expect(inWindow.length, `${r}, ${t}`).toBe(expected);
    }
    // How long a polyline is on the screen.
    const drawn = (lines: number[][]) => {
      let len = 0;
      for (const l of lines)
        for (let i = 0; i + 3 < l.length; i += 2)
          if (wide.inside(l[i], l[i + 1]) && wide.inside(l[i + 2], l[i + 3]))
            len += Math.hypot(l[i + 2] - l[i], l[i + 3] - l[i + 1]);
      return len;
    };
    // y = 1 from x = −7.5 to 7.5, its start off the screen, either way
    // along: r = 1/sin θ on each of the three turns, each once.
    const n = 300;
    const flat = (k: number): [number, number] => [-7.5 + (15 * k) / n, 1];
    const once = drawn(planeLines(wide, n, flat, false));
    const back = drawn(planeLines(wide, n, k => flat(n - k), false));
    const onScreen = (() => {
      // The same, laid out by hand: θ from atan2(1, 7.5) to π − that, r ≤ 5.
      let len = 0;
      const m = 4000;
      let last: [number, number] | null = null;
      for (let i = 0; i <= m; i++) {
        const x = -7.5 + (15 * i) / m;
        const p: [number, number] = [Math.atan2(1, x), Math.hypot(x, 1)];
        if (last && p[1] <= 5 && last[1] <= 5) len += Math.hypot(p[0] - last[0], p[1] - last[1]);
        last = p;
      }
      return 3 * len;
    })();
    expect(once / onScreen).toBeCloseTo(1, 1);
    expect(back / onScreen).toBeCloseTo(1, 1);
    // A closed circle, r = 2: Y = 2 across the window, once.
    const circle = (k: number): [number, number] => [
      2 * Math.cos((2 * Math.PI * k) / n),
      2 * Math.sin((2 * Math.PI * k) / n),
    ];
    expect(drawn(planeLines(wide, n, circle, true)) / (6 * Math.PI)).toBeCloseTo(1, 1);
    // Many turns: a copy on each.
    const wider = planeInverse(polar(), { lo: [-10 * Math.PI, 0], hi: [10 * Math.PI, 5] });
    const ys = planeLines(wider, n, circle, true).flatMap(l =>
      l.filter((_, i) => i % 2 === 0 && Number.isFinite(l[i])),
    );
    for (let k = -4; k <= 4; k++)
      expect(
        ys.some(X => Math.abs(X - 2 * Math.PI * k) < 0.1),
        `turn ${k}`,
      ).toBe(true);
  });

  it('draws a run across the screen however few of its vertices it shows', () => {
    const inverse = planeInverse(polar(), box);
    const shown = (lines: number[][]) =>
      lines.flat().filter((v, i, a) => i % 2 === 0 && inverse.inside(v, a[i + 1])).length;
    // Each run carried in steps, as the renderers do.
    const steps: Segment = (a, b, map, from) => {
      const out: number[] = [];
      let at = from;
      for (let i = 0; i < 64; i++) {
        const t = i / 64;
        const p = map(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, at && isFinite(at[0]) ? at : undefined);
        out.push(...p);
        at = isFinite(p[0]) ? p : undefined;
      }
      return [out, map(b[0], b[1], at)];
    };
    // Its ends just off the screen (radius 6.1, past Y = 5), and a triangle
    // with corners there: what crosses the screen is drawn.
    expect(
      shown(planeLines(inverse, 2, k => (k ? [5, 3.5] : [-5, 3.5]) as [number, number], false, steps)),
    ).toBeGreaterThan(0);
    const r = 5.8;
    const tri = (k: number): [number, number] => [
      r * Math.cos((2 * Math.PI * k) / 3 + 0.3),
      r * Math.sin((2 * Math.PI * k) / 3 + 0.3),
    ];
    expect(shown(planeLines(inverse, 3, tri, true, steps))).toBeGreaterThan(0);
    // A dense line dipping onto a low window for a few vertices: y = 0.99,
    // shown near angle π/2 up to radius 1.
    for (let shift = 0; shift < 20; shift++) {
      const low = planeInverse(polar(), { lo: [-Math.PI + shift * 0.01, 0], hi: [Math.PI + shift * 0.01, 1] });
      const n = 2000;
      const lines = planeLines(low, n, k => [-50 + (100 * k) / n + shift * 0.003, 0.99], false);
      expect(
        lines.flat().some((v, i, a) => i % 2 === 0 && low.inside(v, a[i + 1])),
        `${shift}`,
      ).toBe(true);
    }
  });

  it('finds the turn of a window many turns wide, and no fold where there is none', () => {
    for (const W of [75, 200]) {
      const wide = planeInverse(polar(), { lo: [-W, 0], hi: [W, 5] });
      expect(wide.turns()[0][0]).toBeCloseTo(2 * Math.PI, 6);
      const t = 1.1;
      const expected = Math.floor((W - t) / (2 * Math.PI)) + Math.floor((W + t) / (2 * Math.PI)) + 1;
      expect(wide.all(2 * Math.cos(t), 2 * Math.sin(t)).filter(p => wide.inside(p[0], p[1])).length).toBe(expected);
    }
    // det J only falls off toward one edge (log-polar), or along one axis:
    // no fold point.
    for (const map of ['(exp(Y) cos(X), exp(Y) sin(X))', '(exp(X), Y)'])
      expect(planeInverse(parsePlaneMap(map), { lo: [-3, -5], hi: [3, 5] }).foldPoints(), map).toEqual([]);
  });

  it('finds a branch point of z², and fills round it, wherever the window is', () => {
    const z2 = parsePlaneMap('(X^2 - Y^2, 2 X Y)');
    const square = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (const shift of [0, 0.013, 0.3]) {
      const inverse = planeInverse(z2, { lo: [-2 + shift, -2], hi: [2 + shift, 2] });
      expect(
        inverse.foldPoints().some(f => Math.hypot(...f) < 1e-6),
        `${shift}`,
      ).toBe(true);
      const shapes = planeShapes(inverse, 4, k => square[k] as [number, number]);
      expect(shapes.filter(s => s.closed).length, `${shift}`).toBeGreaterThan(0);
    }
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
    const m = [1, 2, 3, 4] as const;
    const inv = invert2(m);
    [-2, 1, 1.5, -0.5].forEach((v, k) => expect(inv[k]).toBeCloseTo(v, 12));
    // inv · m is the identity.
    const product = [0, 1, 2, 3].map(k => inv[k & 2] * m[k & 1] + inv[(k & 2) + 1] * m[(k & 1) + 2]);
    product.forEach((v, k) => expect(v).toBeCloseTo(k === 0 || k === 3 ? 1 : 0, 12));
    // At angle π/6, radius 2 the Jacobian is [−1, √3/2; √3, 1/2]: a pixel
    // 0.01 by 0.04 spans √(0.01² + (0.02√3)²) in x and √((0.01√3)² + 0.02²) in y.
    const [px, py] = pixelSpan(polar(), Math.PI / 6, 2, 0.01, 0.04);
    expect(px).toBeCloseTo(Math.sqrt(0.0013), 9);
    expect(py).toBeCloseTo(Math.sqrt(0.0007), 9);
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

/** Whether (X, Y) is inside polygon pts (flat, even–odd). */
function inPolygon(pts: number[], X: number, Y: number): boolean {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [ax, ay, bx, by] = [pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1]];
    if (ay > Y !== by > Y && X < ((bx - ax) * (Y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
