import { describe, expect, it } from 'vitest';
import { surfacePoint } from './surface-map.ts';
import { onSurface, raySurface, surfacePixel } from './surface-pick.ts';
import { type SurfaceSpec, parseViewRow } from './view.ts';

const surface = (row: string) => (parseViewRow(row, {}) as SurfaceSpec).surface;
const SPHERE = surface('on((X, Y, Z) = (3cos(y) cos(x), 3cos(y) sin(x), 3sin(y)), x = -pi..pi, y = -pi/2..pi/2)');
const TORUS = surface('on((X, Y, Z) = ((3 + cos(y)) cos(x), (3 + cos(y)) sin(x), sin(y)), x = -pi..pi, y = -pi..pi)');

describe('a ray met with a surface', () => {
  it('finds the longitude and latitude it hits a sphere at', () => {
    // From outside, straight in toward (longitude 1, latitude 0.4).
    const p = surfacePoint(SPHERE, 1, 0.4);
    const hit = raySurface(
      SPHERE,
      p.map(v => 3 * v),
      p.map(v => -v),
    )!;
    expect(hit.x).toBeCloseTo(1, 10);
    expect(hit.y).toBeCloseTo(0.4, 10);
    expect(hit.t).toBeCloseTo(2, 10);
    hit.point.forEach((v, k) => expect(v).toBeCloseTo(p[k], 10));
  });

  it('meets the surface itself, not its mesh, off the axes', () => {
    const hit = raySurface(SPHERE, [10, 1, 2], [-1, -0.05, -0.15])!;
    const at = [10 - hit.t, 1 - 0.05 * hit.t, 2 - 0.15 * hit.t];
    expect(Math.hypot(...at)).toBeCloseTo(3, 10);
    surfacePoint(SPHERE, hit.x, hit.y).forEach((v, k) => expect(v).toBeCloseTo(at[k], 10));
  });

  it('returns nothing for a ray that misses', () => {
    expect(raySurface(SPHERE, [10, 10, 10], [1, 0, 0])).toBeNull();
    expect(raySurface(SPHERE, [10, 0, 0], [1, 0, 0])).toBeNull(); // pointing away
    // Down through the torus's hole.
    expect(raySurface(TORUS, [0, 0, 10], [0, 0, -1])).toBeNull();
  });

  it('takes the nearer of two hits', () => {
    // Along +Y through the sphere: in at longitude −π/2, out at π/2.
    const hit = raySurface(SPHERE, [0, -10, 0], [0, 1, 0])!;
    expect(hit.x).toBeCloseTo(-Math.PI / 2, 10);
    expect(hit.y).toBeCloseTo(0, 10);
    expect(hit.t).toBeCloseTo(7, 10);
  });

  it('finds the torus’s outer and inner walls and its top', () => {
    const outer = raySurface(TORUS, [10, 0, 0], [-1, 0, 0])!;
    expect(outer.t).toBeCloseTo(6, 10);
    expect(outer.x).toBeCloseTo(0, 10);
    expect(outer.y).toBeCloseTo(0, 10);
    // From the centre out: the inner wall, cos(y) = −1.
    const inner = raySurface(TORUS, [0, 0, 0], [1, 0, 0])!;
    expect(inner.t).toBeCloseTo(2, 10);
    expect(Math.cos(inner.y)).toBeCloseTo(-1, 10);
    // Straight down onto the top of the tube.
    const top = raySurface(TORUS, [3, 0, 10], [0, 0, -1])!;
    expect(top.t).toBeCloseTo(9, 8);
    expect(top.y).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('a point in x and y', () => {
  it('is on the surface only within its ranges', () => {
    expect(onSurface(SPHERE, Math.PI, -Math.PI / 2)).toBe(true);
    expect(onSurface(SPHERE, 0, 0)).toBe(true);
    // Past x = π the sphere repeats in space, but nothing is drawn there.
    expect(onSurface(SPHERE, 4.47, 0.3)).toBe(false);
    expect(onSurface(SPHERE, 0, 1.6)).toBe(false);
    expect(onSurface(SPHERE, NaN, 0)).toBe(false);
  });
});

describe('a pixel on a surface', () => {
  it('spans x and y as the screen moves across it', () => {
    // Looking down the X axis at the sphere's front, 100 pixels a unit.
    const toScreen = (p: readonly number[]) => [100 * p[1], -100 * p[2]] as const;
    const [ux, uy] = surfacePixel(SPHERE, 0, 0, toScreen);
    // A pixel is 1/100 of a unit, 1/300 of a radian on a sphere of radius 3.
    expect(ux).toBeCloseTo(1 / 300, 6);
    expect(uy).toBeCloseTo(1 / 300, 6);
  });
});
