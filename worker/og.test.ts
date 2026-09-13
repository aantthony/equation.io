import { describe, expect, it } from 'vitest';
import { OG_HEIGHT, OG_WIDTH, encodePng, renderRaster } from './og.ts';

/** Fraction of pixels in a raster that differ from the white background. */
function inkFraction(r: { w: number; h: number; px: Uint8ClampedArray }): number {
  let ink = 0;
  for (let i = 0; i < r.px.length; i += 3) {
    if (r.px[i] < 250 || r.px[i + 1] < 250 || r.px[i + 2] < 250) ink++;
  }
  return ink / (r.w * r.h);
}

function pixel(r: { w: number; px: Uint8ClampedArray }, x: number, y: number) {
  const i = (y * r.w + x) * 3;
  return [r.px[i], r.px[i + 1], r.px[i + 2]];
}

describe('og raster renderer', () => {
  it.each([
    ['(x,y)=(1+t,2)', '(x,y)=(1,2)'],
    ['(x,y)=(1+u+t,2)', '(x,y)=(1+u,2)'],
  ])('renders animated systems at time zero: %s', (animated, stationary) => {
    const actual = renderRaster([animated], 100, 100);
    expect(actual.px).toEqual(renderRaster([stationary], 100, 100).px);
    expect(actual.px).not.toEqual(renderRaster([], 100, 100).px);
  });

  it('draws an implicit curve where expected', () => {
    const r = renderRaster(['y = x'], 100, 100);
    // y = x passes through the center; screen y grows downward so the curve
    // crosses (50, 50) and heads to the upper right.
    const [red, green, blue] = pixel(r, 50, 50);
    expect(red).toBeLessThan(200);
    expect(blue).toBeGreaterThan(red); // first palette color is blue
    expect(green).toBeLessThan(blue);
    // Far off the curve stays background/grid (near white).
    expect(pixel(r, 80, 80)[0]).toBeGreaterThan(200);
  });

  it('fills regions for inequalities, including chains', () => {
    const grid = inkFraction(renderRaster([], 100, 100));
    const disc = inkFraction(renderRaster(['x^2 + y^2 <= 25'], 100, 100));
    expect(disc).toBeGreaterThan(grid + 0.1);
    const annulus = renderRaster(['9 <= x^2 + y^2 <= 25'], 100, 100);
    // Near the center (off the axis gridlines) is outside the annulus.
    const [cr, cg, cb] = pixel(annulus, 53, 53);
    expect(Math.min(cr, cg, cb)).toBeGreaterThan(230);
  });

  it('draws a density curve and shades its probability area', () => {
    // view(x = -3..3) on a square canvas: 6 world units across, y=0 at py 50.
    const r = renderRaster(['X ~ Normal(0, 1)', 'P(-3 < X < 3)', 'view(x = -3..3)'], 100, 100);
    // Inside the shaded area, under the peak but off the y-axis gridline:
    // world (0.3, 0.18) ≈ px (55, 47).
    expect(Math.min(...pixel(r, 55, 47))).toBeLessThan(245);
    // Above the curve at the same x, off the y=1 gridline: world (0.3, 1.5).
    expect(Math.min(...pixel(r, 55, 25))).toBeGreaterThan(230);
    // The density row alone strokes its curve: more ink than the bare grid.
    const grid = inkFraction(renderRaster(['view(x = -3..3)'], 100, 100));
    const curve = inkFraction(renderRaster(['X ~ Normal(0, 1)', 'view(x = -3..3)'], 100, 100));
    expect(curve).toBeGreaterThan(grid + 0.005);
  });

  it('strokes and fills polygon figures, leaving open segments unfilled', () => {
    const tri = renderRaster(['A = (-4, -4)', 'B = (4, -4)', 'C = (0, 4)', 'polygon(A, B, C)'], 100, 100);
    // Interior (world ~(1.4, -1.4), off the unit gridlines): tinted by the
    // 0.16 fill in the row color (palette slot 3, purple — green channel dips).
    const [, ig, ib] = pixel(tri, 62, 62);
    expect(ig).toBeLessThan(235);
    expect(ib).toBeGreaterThan(ig);
    // The bottom edge (y = -4) strokes at full strength.
    expect(pixel(tri, 55, 83)[0]).toBeLessThan(200);
    // Outside the triangle stays near-white.
    expect(Math.min(...pixel(tri, 90, 10))).toBeGreaterThan(230);
    // segment() is the open figure: same span as the triangle's base, no fill.
    const seg = renderRaster(['A = (-4, -4)', 'B = (4, -4)', 'segment(A, B)'], 100, 100);
    expect(pixel(seg, 55, 83)[0]).toBeLessThan(200);
    expect(Math.min(...pixel(seg, 62, 62))).toBeGreaterThan(240);
  });

  it('draws a cobweb: curve, diagonal, and iterated path', () => {
    const rows = ['view(x = 0..1, y = 0..1)', 'r = 2.9', 'a_0 = 0.15', 'a_{n+1} = r a_n (1 - a_n)'];
    const r = renderRaster(rows, 100, 100);
    // The map's curve y = 2.9x(1 - x) peaks at (0.5, 0.725) → screen (50, ~27).
    expect(pixel(r, 50, 27)[0]).toBeLessThan(200);
    // The seed dot at (a_0, a_0) = (0.15, 0.15) → screen (15, 85), in the row
    // color (palette slot 3, purple — blue above red).
    const [sr, , sb] = pixel(r, 15, 85);
    expect(sr).toBeLessThan(200);
    expect(sb).toBeGreaterThan(sr);
    // The first vertical step of the path: x = 0.15 rising to f(0.15) ≈ 0.37.
    const [vr, , vb] = pixel(r, 15, 75);
    expect(vr).toBeLessThan(220);
    expect(vb).toBeGreaterThan(vr);
    // The y = x diagonal, lighter than the axes but present: screen (90, 10).
    expect(Math.max(...pixel(r, 90, 10))).toBeLessThan(245);
  });

  it('draws base distribution rows exactly: pdf curve + shaded P(…) region', () => {
    const rows = ['view(x = -4..4, y = -0.05..0.45)', 'X ~ Normal(0, 1)', 'P(X > 1)'];
    const r = renderRaster(rows, 100, 100);
    // The density passes (0.6, 0.333): screen (57.5, ~48) with the view
    // centered at (0, 0.2) and 0.08 units/px — off the axis gridlines, so
    // only the curve itself can ink it.
    const near: number[] = [];
    for (const x of [57, 58]) for (const y of [47, 48, 49]) near.push(Math.min(...pixel(r, x, y)));
    expect(Math.min(...near)).toBeLessThan(200);
    // Inside the shaded tail (world (1.5, 0.05)) the fill tints the pixel.
    expect(Math.min(...pixel(r, 69, 52))).toBeLessThan(245);
    // The untouched upper-left corner stays background.
    expect(Math.min(...pixel(r, 10, 10))).toBeGreaterThan(240);
  });

  it('draws the piecewise uniform pdf and its region through the VM', () => {
    const rows = ['view(x = -1..3, y = -0.1..1.2)', 'X ~ Uniform(0, 2)', 'P(0.5 < X < 1.5)'];
    const r = renderRaster(rows, 100, 100);
    // Inside the shaded band under pdf = 0.5 (world (0.8, 0.25)) vs the same
    // height outside the support (world (2.5, 0.25)).
    const inside = Math.min(...pixel(r, 45, 57));
    const outside = Math.min(...pixel(r, 87, 57));
    expect(inside).toBeLessThan(outside - 5);
    // The box top, pdf = 0.5 on (0, 2): world (1.4, 0.5) → screen (60, ~51).
    const top = [50, 51, 52].map(y => Math.min(...pixel(r, 60, y)));
    expect(Math.min(...top)).toBeLessThan(200);
  });

  it('draws sampled densities: sum of uniforms + shaded Monte Carlo P(…)', () => {
    const view = 'view(x = -1..3, y = -0.1..1.2)';
    const grid = inkFraction(renderRaster([view], 100, 100));
    const rows = [view, 'X ~ Uniform(0, 1)', 'Y ~ Uniform(0, 1)', 'S = X + Y', 'P(0.5 < S < 1.5)'];
    const r = renderRaster(rows, 100, 100);
    expect(inkFraction(r)).toBeGreaterThan(grid + 0.02);
    // Under the triangle density's peak, inside the shaded band.
    expect(Math.min(...pixel(r, 50, 51))).toBeLessThan(245);
    // Beyond the sum's support stays background.
    expect(Math.min(...pixel(r, 90, 20))).toBeGreaterThan(240);
  });

  it('draws E(…) rows as a mean marker under the density', () => {
    const rows = ['view(x = -1..3, y = -0.1..1.2)', 'X ~ Uniform(0, 1.4)', 'E(X)'];
    const r = renderRaster(rows, 100, 100);
    // E[X] = 0.7 → screen x ≈ 42.5; the stem runs from the axis (py ≈ 64)
    // up to pdf = 1/1.4 ≈ 0.714 (py ≈ 46).
    const stem = [42, 43].map(x => Math.min(...pixel(r, x, 55)));
    expect(Math.min(...stem)).toBeLessThan(210);
    // The same height away from the mean is inside the box but unmarked.
    expect(Math.min(...pixel(r, 30, 55))).toBeGreaterThan(230);
  });

  it('draws point masses as probability stems', () => {
    const rows = ['view(x = 0..3, y = -0.2..1.2)', 'X ~ Normal(0, 1)', 'Y = {X > 0: 1.3, 2.6}'];
    const r = renderRaster(rows, 100, 100);
    // The stem at x = 1.3 (screen ~43) runs from the axis up to p = 0.5.
    expect(Math.min(...pixel(r, 43, 58))).toBeLessThan(200);
    // Above the stem top there is nothing — no KDE bump smearing the atom.
    expect(Math.min(...pixel(r, 43, 40))).toBeGreaterThan(230);
  });

  it('renders a non-elementary integral curve (Si) through the VM', () => {
    // The quadrature-sum expansion is an ordinary expression, so the stack VM
    // samples it per pixel like any other implicit curve.
    const rows = ['view(x = 0..10, y = 0..2)', 'y = int[0..x] sin(t)/t dt'];
    const r = renderRaster(rows, 100, 100);
    // Uniform scale: the x span wins, 0.1 units/px with cy = 1. Si peaks at
    // x = π with Si(π) ≈ 1.852 → screen (~31, ~41.5).
    const near: number[] = [];
    for (const x of [30, 31, 32]) for (const y of [40, 41, 42, 43]) near.push(Math.min(...pixel(r, x, y)));
    expect(Math.min(...near)).toBeLessThan(200);
    // Far from the curve stays background.
    expect(Math.min(...pixel(r, 80, 80))).toBeGreaterThan(230);
  });

  it('renders definitions + slider constants (tangent-line graph)', () => {
    const rows = ['f(x) = x^2 - 2x', 'g(x) = d/dx f(x)', 'a = 3', 'y = f(x)', 'y = f(a) + g(a)(x - a)'];
    expect(inkFraction(renderRaster(rows, 120, 120))).toBeGreaterThan(0.02);
  });

  it('renders 3D rows as wireframes without throwing', () => {
    const torus = ['(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))'];
    expect(inkFraction(renderRaster(torus, 120, 120))).toBeGreaterThan(0.03);
    const height = renderRaster(['z = sin(x)cos(y)'], 120, 120);
    expect(inkFraction(height)).toBeGreaterThan(0.03);
  });

  it('grows the shared eval stack for deep expressions', () => {
    // y = 0+(0+(...x...)) needs stack depth > the initial 64; a dropped or
    // clipped stack would render garbage instead of the y = x diagonal.
    const deep = 'y = ' + '0+('.repeat(80) + 'x' + ')'.repeat(80);
    const r = renderRaster([deep], 100, 100);
    expect(pixel(r, 50, 50)[0]).toBeLessThan(200);
    expect(pixel(r, 80, 80)[0]).toBeGreaterThan(200);
  });

  it('survives invalid rows and renders the rest', () => {
    const r = renderRaster(['y = florb(x)', 'y = x'], 100, 100);
    expect(pixel(r, 50, 50)[0]).toBeLessThan(220);
  });

  it('frames 2D plots through a view(...) row', () => {
    // A parabola living near x = 100: invisible in the default ±6 window,
    // fully in frame once the row asks for it. Grid and axes are gray, so
    // only curve pixels count — total ink would be swamped by gridlines.
    const colored = (r: { w: number; h: number; px: Uint8ClampedArray }) => {
      let n = 0;
      for (let i = 0; i < r.px.length; i += 3) {
        if (Math.abs(r.px[i] - r.px[i + 1]) > 25) n++;
      }
      return n / (r.w * r.h);
    };
    const rows = ['y = (x - 100)^2'];
    expect(colored(renderRaster(rows, 100, 100))).toBeLessThan(0.002);
    expect(colored(renderRaster(['view(x = 98..102, y = 0..4)', ...rows], 100, 100))).toBeGreaterThan(0.01);
  });

  it('drops the unit grid when a view row zooms far out, keeping the axes', () => {
    const r = renderRaster(['view(x = -100000..100000)', 'y = x'], 100, 100);
    // One vertical axis + one horizontal axis + the diagonal — not a line per
    // unit, which would paint every column of the raster.
    expect(inkFraction(r)).toBeLessThan(0.2);
    expect(pixel(r, 50, 50)[0]).toBeLessThan(220); // the curve still shows
  });

  it('aims the 3D wireframe through a camera(...) row', () => {
    const rows = ['z = x^2 - y^2'];
    const def = renderRaster(rows, 120, 120);
    const aimed = renderRaster(['camera(0.8, 0.9, 7)', ...rows], 120, 120);
    expect(inkFraction(aimed)).toBeGreaterThan(0.02);
    expect(aimed.px).not.toEqual(def.px); // the camera actually moved
    const shifted = renderRaster(['camera(0.8, 0.9, 7, (0, 0, 20))', ...rows], 120, 120);
    // Target 20 units up: the surface (and grid) leave the frame almost fully.
    expect(inkFraction(shifted)).toBeLessThan(inkFraction(aimed) / 2);
  });

  it('encodes a spec-shaped PNG', async () => {
    const png = await encodePng(renderRaster(['y = sin(x)'], OG_WIDTH, OG_HEIGHT));
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer, png.byteOffset);
    expect(dv.getUint32(16)).toBe(OG_WIDTH); // IHDR width
    expect(dv.getUint32(20)).toBe(OG_HEIGHT); // IHDR height
    expect(new TextDecoder().decode(png.slice(png.length - 8, png.length - 4))).toBe('IEND');
  });
});

describe('coordinate and complex previews', () => {
  const frame = 'view(x = -4..4, y = -4..4)';
  it('draws an Argand constant at its complex coordinates', () => {
    const r = renderRaster(['1+2i', frame], 160, 160);
    expect(pixel(r, 100, 40)[0]).toBeLessThan(150);
  });
  it('draws all three roots of unity', () => {
    const r = renderRaster(['w^3 = 1', frame], 160, 160);
    for (const [x, y] of [[100, 80], [70, 63], [70, 97]]) expect(pixel(r, x, y)[0]).toBeLessThan(150);
  });
  it('draws the spiral across the atan2 branch cut', () => {
    const r = renderRaster(['r = sqrt(x^2+y^2)', 'theta = atan2(y,x)', '(r, theta) = (3u, 6pi u)', frame], 160, 160);
    // Radius 2.5 at angle 5pi: (-2.5, 0).
    expect(Math.min(...pixel(r, 30, 80))).toBeLessThan(150);
  });
});
