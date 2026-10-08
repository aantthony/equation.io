import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { parametricGLSL } from './compiler.ts';
import { evaluate } from './expr.ts';
import { surfaceInUV, surfaceMapping, surfacePoint } from './surface-map.ts';
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

  it('says what is wrong with a row it cannot use', () => {
    for (const [row, message] of [
      ['on((X, Y, Z) = (x, y, 0))', /x = -pi..pi/],
      ['on((X, Y, Z) = (x, y), x = 0..1, y = 0..1)', /on\(\(X, Y, Z\)/],
      ['on((X, Y, Z) = (x, x, x), x = 0..1, y = 0..1)', /no surface/],
      ['on((X, Y, Z) = (x, y, 0), x = 1..0, y = 0..1)', /lo < hi/],
      ['on((X, Y, Z) = (x, y, 0), x = 0..1, y = 0..1, locked)', /camera/],
      ['on((X, Y, Z) = (x, y, sum(n=1..3, x^n)), x = 0..1, y = 0..1)', /cannot take Σ yet: write its terms out/],
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
      'z = x y',
    ];
    const a = analyzeRows(rows).rows;
    expect(a[0].view?.kind).toBe('surface');
    expect(a.slice(1, 7).map(r => (r.cls ? surfaceMapping(r.cls.object) : r.error))).toEqual([
      'paint',
      'paint',
      'paint',
      'carry',
      'carry',
      'carry',
    ]);
    // A vector field has no picture on it yet.
    expect(a[7].error).toMatch(/draws its rows on a surface/);
    // A row in space draws as in any 3D panel.
    expect(a[8].error).toBeUndefined();
    expect(a[8].cls!.needs3D).toBe(true);
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
    const a = analyzeRows([SPHERE, '(-y, x)', '---', '(-y, x)']).rows;
    expect(a[1].error).toMatch(/surface/);
    expect(a[3].error).toBeUndefined();
  });
});
