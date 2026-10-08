import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { parametricGLSL } from './compiler.ts';
import { evaluate } from './expr.ts';
import {
  surfaceArrows,
  surfaceInUV,
  surfaceMapping,
  surfaceOver,
  surfacePoint,
  surfaceTangents,
} from './surface-map.ts';
import { type SurfaceSpec, parseViewRow } from './view.ts';

const SPHERE = 'on((X, Y, Z) = (cos(y) cos(x), cos(y) sin(x), sin(y)), x = -pi..pi, y = -pi/2..pi/2)';
const sphere = () => (parseViewRow(SPHERE, {}) as SurfaceSpec).surface;

describe('a surface map', () => {
  it('reads the surface and the x and y it spans', () => {
    const map = sphere();
    expect(map.x[0]).toBeCloseTo(-Math.PI, 12);
    expect(map.y[1]).toBeCloseTo(Math.PI / 2, 12);
    // Longitude 0, latitude 0: (1, 0, 0); the north pole: (0, 0, 1).
    expect(surfacePoint(map, 0, 0).map(v => +v.toFixed(12))).toEqual([1, 0, 0]);
    expect(surfacePoint(map, 0, Math.PI / 2)[2]).toBeCloseTo(1, 12);
  });

  it('reads sliders at their value', () => {
    const spec = parseViewRow('on((X, Y, Z) = (R cos(x), R sin(x), y), x = 0..1, y = 0..1)', { R: 3 }) as SurfaceSpec;
    expect(surfacePoint(spec.surface, 0, 0.5)).toEqual([3, 0, 0.5]);
    expect(() => parseViewRow('on((X, Y, Z) = (R x, y, 0), x = 0..1, y = 0..1)', {})).toThrow(/R has no fixed value/);
  });

  it('writes out Σ and Π, with sliders in their bounds', () => {
    const spec = parseViewRow('on((X, Y, Z) = (x, y, sum(n=1..N, x^n/n)), x = 0..1, y = 0..1)', {
      N: 3,
    }) as SurfaceSpec;
    const by = parseViewRow('on((X, Y, Z) = (x, y, x + x^2/2 + x^3/3), x = 0..1, y = 0..1)', {}) as SurfaceSpec;
    for (const [x, y] of [
      [0.3, 0.1],
      [0.9, 0.7],
    ])
      expect(surfacePoint(spec.surface, x, y)[2]).toBeCloseTo(surfacePoint(by.surface, x, y)[2], 12);
    // Drawn on the GPU as plain arithmetic.
    expect(parametricGLSL(surfaceInUV(spec.surface).comps).comps[2]).not.toMatch(/sum/);
    const prod = parseViewRow('on((X, Y, Z) = (x, y, prod(k=1..3, 1 + x/k)), x = 0..1, y = 0..1)', {}) as SurfaceSpec;
    expect(surfacePoint(prod.surface, 0.5, 0)[2]).toBeCloseTo(1.5 * 1.25 * (1 + 0.5 / 3), 12);
  });

  it('expands only the sums: a derivative is refused with a sum or without', () => {
    for (const row of [
      'on((X, Y, Z) = (x, y, d/dx(x^3)), x = 0..1, y = 0..1)',
      'on((X, Y, Z) = (x, y, d/dx(x^3) + sum(n=1..2, y^n)), x = 0..1, y = 0..1)',
      'on((X, Y, Z) = (x, y, sum(n=1..2, d/dx(x^n))), x = 0..1, y = 0..1)',
    ])
      expect(() => parseViewRow(row, {}), row).toThrow(/d has no fixed value/);
  });

  it('says what is wrong with a row it cannot use', () => {
    for (const [row, message] of [
      ['on((X, Y, Z) = (x, y, 0))', /x = -pi..pi/],
      ['on((X, Y, Z) = (x, y), x = 0..1, y = 0..1)', /on\(\(X, Y, Z\)/],
      ['on((X, Y, Z) = (x, x, x), x = 0..1, y = 0..1)', /no surface/],
      ['on((X, Y, Z) = (x, y, 0), x = 1..0, y = 0..1)', /lo < hi/],
      ['on((X, Y, Z) = (x, y, 0), x = 0..1, y = 0..1, locked)', /camera/],
      [
        'on((X, Y, Z) = (x, y, sum(n=1..y, x^n)), x = 0..1, y = 0..1)',
        /Σ needs bounds that are fixed numbers or sliders; y changes/,
      ],
      ['on((X, Y, Z) = (x, y, sum(n=1..N, x^n)), x = 0..1, y = 0..1)', /Σ bounds must be constant/],
      ['on((X, Y, Z) = (x, y, sum(n=1..10^6, x^n)), x = 0..1, y = 0..1)', /Σ expands to 1000000 terms \(limit/],
      ['on((X, Y, Z) = (x, y, cos x), x = 0..1, y = 0..1)', /cos is a function — write it with parentheses/],
    ] as const)
      expect(() => parseViewRow(row, {}), row).toThrow(message);
  });

  it('takes a small surface, a deep one, and one it cannot differentiate', () => {
    expect(() => parseViewRow('on((X, Y, Z) = (1e-4 x, 1e-4 y, 0), x = 0..1, y = 0..1)', {})).not.toThrow();
    const deep = Array.from({ length: 80 }, () => 'x').join(' + (') + ')'.repeat(79);
    const map = (parseViewRow(`on((X, Y, Z) = (${deep}, y, 0), x = 0..1, y = 0..1)`, {}) as SurfaceSpec).surface;
    expect(surfacePoint(map, 0.5, 0)[0]).toBeCloseTo(40, 9);
    const stepped = (parseViewRow('on((X, Y, Z) = (x, y, mod(x, 1)), x = 0..2, y = 0..1)', {}) as SurfaceSpec).surface;
    expect(parametricGLSL(surfaceInUV(stepped).comps).comps[2]).toMatch(/mod/);
  });

  it('lays the surface over the unit square, with x and y there', () => {
    const { comps, uv } = surfaceInUV(sphere());
    // u = 1/2, v = 1/2 is x = 0, y = 0.
    const at = { u: 0.5, v: 0.5 };
    expect(evaluate(uv.x, at)).toBeCloseTo(0, 12);
    expect(comps.map(c => +evaluate(c, at).toFixed(12))).toEqual([1, 0, 0]);
    // At u = 3/4, x = π/2: (0, 1, 0).
    expect(evaluate(comps[1], { u: 0.75, v: 0.5 })).toBeCloseTo(1, 12);
  });
});

describe('rows on a surface', () => {
  it('paint what is drawn per pixel, carry what is placed, and refuse the rest', () => {
    const rows = [
      SPHERE,
      'y = sin(3x)/2',
      'x^2 + y^2 < 1',
      'x y',
      '(1, 0.5)',
      '(u, u/3)',
      'polygon((0, 0), (1, 0), (0, 1))',
      '(-y, x)',
      '(u cos(2 pi v), u sin(2 pi v))',
      'rgb(x, y, 0)',
      'z = x y',
    ];
    const a = analyzeRows(rows).rows;
    expect(a[0].view?.kind).toBe('surface');
    expect(a.slice(1, 9).map(r => (r.cls ? surfaceMapping(r.cls.object) : r.error))).toEqual([
      'paint',
      'paint',
      'paint',
      'carry',
      'carry',
      'carry',
      'carry',
      'carry',
    ]);
    // A colour field has no picture on it yet.
    expect(a[9].error).toMatch(/draws its rows on a surface/);
    // A row in space draws as in any 3D panel.
    expect(a[10].error).toBeUndefined();
    expect(a[10].cls!.needs3D).toBe(true);
  });

  it('carries a vector field by the surface’s tangents', () => {
    const map = sphere();
    // At longitude x, latitude y the sphere moves east with x, north with y.
    const [px, py] = surfaceTangents(map, 0.3, 0.5);
    expect(px[0]).toBeCloseTo(-Math.cos(0.5) * Math.sin(0.3), 12);
    expect(px[1]).toBeCloseTo(Math.cos(0.5) * Math.cos(0.3), 12);
    expect(px[2]).toBeCloseTo(0, 12);
    expect(py[2]).toBeCloseTo(Math.cos(0.5), 12);
    // Due east everywhere: each arrow leaves the sphere at a tangent, east,
    // as long as 0.7 of its cell there (shorter toward the poles).
    const arrows = surfaceArrows(map, () => [1, 0]);
    // 24 cells round, 19 from pole to pole: near square at mid latitudes.
    expect(arrows.length / 9).toBe(24 * 19);
    for (let k = 0; k < arrows.length; k += 9) {
      const p = arrows.slice(k, k + 3);
      const d = arrows.slice(k + 3, k + 6).map((v, i) => v - p[i]);
      expect(Math.hypot(...p)).toBeCloseTo(1, 12);
      expect(arrows.slice(k + 6, k + 9).every(Number.isNaN)).toBe(true);
      const len = Math.hypot(...d);
      // East is (-sin x, cos x, 0) at longitude x.
      const x = Math.atan2(p[1], p[0]);
      expect(d[0] / len).toBeCloseTo(-Math.sin(x), 9);
      expect(d[1] / len).toBeCloseTo(Math.cos(x), 9);
      expect(d[2]).toBeCloseTo(0, 12);
      // 0.7 of a cell 2π/24 wide, shrunk with the circle of latitude.
      expect(len / Math.hypot(p[0], p[1])).toBeCloseTo((0.7 * 2 * Math.PI) / 24, 9);
    }
  });

  it('lays its arrows out near square on the surface, and skips where the field is not', () => {
    // A torus 3 round and 1 thick: three times as many cells round as across.
    const torus = (
      parseViewRow(
        'on((X, Y, Z) = ((3 + cos(y)) cos(x), (3 + cos(y)) sin(x), sin(y)), x = -pi..pi, y = -pi..pi)',
        {},
      ) as SurfaceSpec
    ).surface;
    expect(surfaceArrows(torus, () => [0, 1]).length / 9).toBe(24 * 8);
    // A field undefined on half the surface draws on the other half.
    const half = surfaceArrows(torus, x => [Math.sqrt(x), 1]);
    expect(half.length / 9).toBe(12 * 8);
    expect(surfaceArrows(torus, () => [0, 0])).toEqual([]);
  });

  it('carries a parametric region’s own mesh onto the surface', () => {
    // The disc of radius 1/2 about (0, 0), round the sphere's (1, 0, 0).
    const [, region] = analyzeRows([SPHERE, '(u cos(2 pi v) / 2, u sin(2 pi v) / 2)']).rows;
    const obj = region.cls!.object;
    if (obj.kind !== 'region' || obj.form !== 'parametric') throw new Error(obj.kind);
    const comps = surfaceOver(sphere(), obj.coordinates);
    const at = (u: number, v: number) => comps.map(c => evaluate(c, { u, v }));
    expect(at(0, 0).map(c => +c.toFixed(12))).toEqual([1, 0, 0]);
    // Its rim on the equator: longitude 1/2.
    expect(at(1, 0)[0]).toBeCloseTo(Math.cos(0.5), 12);
    expect(at(1, 0)[1]).toBeCloseTo(Math.sin(0.5), 12);
    expect(Math.hypot(...at(0.7, 0.3))).toBeCloseTo(1, 12);
    expect(parametricGLSL(comps).du).toBeDefined();
  });

  it('draws a family as its members', () => {
    const a = analyzeRows([SPHERE, 'y = x + [0..3]/4', 'y < [1, 2] x^2']).rows;
    expect(a[1].error).toBeUndefined();
    expect(surfaceMapping(a[1].cls!.object)).toBe('paint');
    expect(a[2].error ?? surfaceMapping(a[2].cls!.object)).toBe('paint');
  });

  it('is framed by a camera, not a 2D window', () => {
    const [, view] = analyzeRows([SPHERE, 'view(x = 0..1)']).rows;
    expect(view.error).toMatch(/frame it with camera/);
    expect(analyzeRows([SPHERE, 'camera(-1, 0.5, 6)']).rows[1].error).toBeUndefined();
  });

  it('maps only its own panel', () => {
    const a = analyzeRows([SPHERE, 'rgb(x, y, 0)', '---', 'rgb(x, y, 0)']).rows;
    expect(a[1].error).toMatch(/surface/);
    expect(a[3].error).toBeUndefined();
  });
});
