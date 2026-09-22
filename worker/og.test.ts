import { describe, expect, it } from 'vitest';
import { ENUM_STATS } from '../lib/dist.ts';
import { analyze } from './graph.ts';
import { OG_HEIGHT, OG_WIDTH, canRenderOg, encodePng, renderRaster } from './og.ts';

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
    ['re(w)=0', 'x=0'],
    ['im(w)', 'y'],
    ['1+2i', '(1,2)'],
    ['exp(i 2pi u)', '(cos(2pi u),sin(2pi u))'],
  ])('shares CPU projections with the browser: %s', (complex, real) => {
    const actual = renderRaster([complex], 100, 100);
    expect(actual.px).toEqual(renderRaster([real], 100, 100).px);
    expect(actual.px).not.toEqual(renderRaster([], 100, 100).px);
  });

  it('uses the same nonuniform scale for curves and points in link previews', () => {
    const view = 'view(x=-5..5, y=-1..1, ratio=2)';
    for (const equation of ['y=x', '(1,1)']) {
      const scaled = renderRaster([equation, view], 100, 100);
      // x=1 is 10 pixels right; y=1 is 20 pixels up.
      expect(pixel(scaled, 60, 30)[0]).toBeLessThan(200);
      expect(pixel(scaled, 60, 40)[0]).toBeGreaterThan(200);
    }
  });

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

  it('shades a definite integral: two tints by sign, clipped, broken at gaps', () => {
    // 100×100 at view(x = -5..5): 10 px per unit, origin at (50, 50).
    const view = 'view(x = -5..5)';
    const r = renderRaster(['int[-3..3] x dx', view], 100, 100);
    // Under y = x right of 0 — world (2.5, 1.5) — the row color (blue):
    const [pr, , pb] = pixel(r, 75, 35);
    expect(pb).toBeGreaterThan(pr + 10);
    // Left of 0 — world (-2.5, -1.5) — the complement (orange): it SUBTRACTS.
    const [nr, , nb] = pixel(r, 25, 65);
    expect(nr).toBeGreaterThan(nb + 10);
    // Outside [a, b] and above the integrand: untouched.
    expect(Math.min(...pixel(r, 93, 47))).toBeGreaterThan(230);
    expect(Math.min(...pixel(r, 75, 15))).toBeGreaterThan(230);
    // Reversed bounds negate the value, so the tints swap.
    const rev = renderRaster(['int[3..-3] x dx', view], 100, 100);
    const [rr, , rb] = pixel(rev, 75, 35);
    expect(rr).toBeGreaterThan(rb + 10);
    // An infinite range is clipped to the view; a bare number draws nothing.
    const inf = renderRaster(['int[-inf..inf] 3 e^(-x^2) dx', view], 100, 100);
    expect(pixel(inf, 53, 35)[2]).toBeGreaterThan(pixel(inf, 53, 35)[0] + 10);
    const grid = renderRaster([view], 100, 100);
    expect(renderRaster(['2 int[0..1] x^2 dx', view], 100, 100).px).toEqual(grid.px);
    expect(renderRaster(['int[2..2] x dx', view], 100, 100).px).toEqual(grid.px);
    // A no-default piecewise integrand fills only where it is defined.
    const gap = renderRaster(['f(x) = {x < 1: 3}', 'int[-3..3] f(x) dx', view], 100, 100);
    expect(Math.min(...pixel(gap, 25, 35))).toBeLessThan(245);
    expect(Math.min(...pixel(gap, 75, 35))).toBeGreaterThan(230);
    // A range wider than the view has no edge at the border: the fill runs
    // off-canvas, and no vertical line is stroked where the view cut it.
    const wide = renderRaster(['int[-100..inf] (2 + x/10) dx', view], 100, 100);
    expect(pixel(wide, 0, 40)[2]).toBeGreaterThan(pixel(wide, 0, 40)[0] + 10); // filled…
    for (const x of [0, 1, 98, 99]) expect(pixel(wide, x, 40)[0]).toBeGreaterThan(200); // …not stroked
    // A bound inside the view keeps its vertical edge: world x = 3 is px 80.
    expect(pixel(r, 80, 35)[0]).toBeLessThan(120);
    // Nothing in a 3D scene, like the app.
    const solo3d = renderRaster(['z = x + y'], 100, 100);
    expect(renderRaster(['z = x + y', 'int[-3..3] x dx'], 100, 100).px).toEqual(solo3d.px);
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

  it('draws polylines open and vectors with a solid head at the tip', () => {
    // The open path (-4,-4) → (0,4) → (4,-4) strokes both legs where the
    // triangle test strokes its sides, but neither closes its base nor fills.
    const path = renderRaster(['polyline((-4, -4), (0, 4), (4, -4))'], 100, 100);
    expect(inkFraction(path)).toBeGreaterThan(inkFraction(renderRaster([], 100, 100)) + 0.01);
    expect(Math.min(...pixel(path, 55, 83))).toBeGreaterThan(230);
    expect(Math.min(...pixel(path, 62, 62))).toBeGreaterThan(240);
    // vector(A, B) along y = 0.5 (off the gridlines; the fitted view puts the
    // shaft on rows 46–47, tip near x = 83): the head widens the stroke just
    // behind the tip, and the same offset mid-shaft stays bare.
    const rows = ['A = (-4, 0.5)', 'B = (4, 0.5)', 'vector(A, B)'];
    const arrow = renderRaster(rows, 100, 100);
    expect(pixel(arrow, 60, 46)[0]).toBeLessThan(200);
    expect(pixel(arrow, 77, 44)[0]).toBeLessThan(200);
    expect(pixel(arrow, 76, 48)[0]).toBeLessThan(200);
    expect(Math.min(...pixel(arrow, 60, 44))).toBeGreaterThan(230);
    // No head at the tail, and segment() over the same points has none at all.
    expect(Math.min(...pixel(arrow, 22, 44))).toBeGreaterThan(230);
    const seg = renderRaster([...rows.slice(0, 2), 'segment(A, B)'], 100, 100);
    expect(Math.min(...pixel(seg, 77, 44))).toBeGreaterThan(230);
    // The head is sized in pixels, not world units: zoomed out (shaft on rows
    // 48–49, tip near x = 69) it still stands 2 rows clear of the shaft.
    const far = renderRaster([...rows, 'view(x = -10..10)'], 100, 100);
    expect(pixel(far, 63, 46)[0]).toBeLessThan(200);
    expect(Math.min(...pixel(far, 56, 46))).toBeGreaterThan(230);
  });

  it.each([
    ['right', -4, 0.5, 4, 0.5],
    ['up', 0.5, -4, 0.5, 4],
    ['left', 4, 0.5, -4, 0.5],
    ['down', 0.5, 4, 0.5, -4],
    ['up-left', 3.5, -3.5, -3.5, 3.5],
    ['down-right', -3.5, 3.2, 3.5, -3.7],
    ['shallow', -4, -1.3, 4, 1.2],
  ])('joins a vector head to its shaft with no gap, pointing %s', (_, ax, ay, bx, by) => {
    // 10 px per unit about (50, 50). Around where the head meets the shaft,
    // every pixel whose center lies within 1 px of the stroke's axis is
    // inked (the 2px stroke's footprint is centered ~0.75 px right and below
    // its coordinates): no notch between the shaft's end and the head's base.
    const r = renderRaster([`vector((${ax}, ${ay}), (${bx}, ${by}))`, 'view(x = -5..5, y = -5..5)'], 100, 100);
    const [x0, y0, x1, y1] = [50.75 + 10 * ax, 50.75 - 10 * ay, 50.75 + 10 * bx, 50.75 - 10 * by];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    const holes: string[] = [];
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const along = (x + 0.5 - x0) * ux + (y + 0.5 - y0) * uy;
        const across = Math.abs((x + 0.5 - x0) * uy - (y + 0.5 - y0) * ux);
        if (along < len - 11 || along > len - 3 || across > 1.0) continue;
        if (Math.min(...pixel(r, x, y)) > 200) holes.push(`${x},${y}`);
      }
    }
    expect(holes).toEqual([]);
  });

  it.each([
    ['right', -4, 1.5, 4, 1.5],
    ['left', 4, 1.33, -4, 1.33],
    ['up', 1.5, -4, 1.5, 4],
    ['down', 1.27, 4, 1.27, -4],
  ])('centers a vector head on its 2px shaft, pointing %s', (dir, ax, ay, bx, by) => {
    // Across the head, 7 px behind the tip, the inked run is centered on the
    // 2px run the bare shaft inks further back (the axis, 13+ px away, aside).
    const r = renderRaster([`vector((${ax}, ${ay}), (${bx}, ${by}))`, 'view(x = -5..5, y = -5..5)'], 100, 100);
    const horizontal = dir === 'right' || dir === 'left';
    const run = (at: number): [number, number] => {
      const dark: number[] = [];
      for (let k = 0; k < 100; k++) {
        if (k === 50) continue; // the axis
        if (Math.min(...(horizontal ? pixel(r, at, k) : pixel(r, k, at))) < 200) dark.push(k);
      }
      return [dark[0], dark[dark.length - 1]];
    };
    const tip = horizontal ? 50 + 10 * bx : 50 - 10 * by;
    const sign = Math.sign(tip - 50);
    const [s0, s1] = run(tip - sign * 30);
    const [h0, h1] = run(Math.round(tip - sign * 7));
    expect(s1 - s0).toBe(1);
    expect(h1 - h0).toBeGreaterThan(3);
    expect(h0 + h1).toBe(s0 + s1);
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

  it('draws the zoo densities through the VM builtins: Gamma curve + shaded tail', () => {
    // 0.08 units/px centred on (3, 0.2). The mode (1, 1/e) is screen (25, ~48),
    // where the curve runs level — off every gridline.
    const rows = ['view(x = -1..7, y = -0.05..0.45)', 'X ~ Gamma(2, 1)', 'P(X > 3)'];
    const r = renderRaster(rows, 100, 100);
    const near: number[] = [];
    for (const x of [24, 25, 26]) for (const y of [47, 48, 49]) near.push(Math.min(...pixel(r, x, y)));
    expect(Math.min(...near)).toBeLessThan(200);
    // Inside the shaded tail, world (4, 0.03) under pdf(4) = 0.073.
    expect(Math.min(...pixel(r, 62, 52))).toBeLessThan(245);
    // Left of the support, at the same height, nothing is tinted or drawn.
    expect(Math.min(...pixel(r, 6, 45))).toBeGreaterThan(240);
    expect(Math.min(...pixel(r, 10, 10))).toBeGreaterThan(240);
  });

  it('shades up to a pole at the support edge: ChiSquared(1) and a U-shaped Beta', () => {
    // 0.04 units/px centred on (1, 0.55). World (0.3, 0.2) lies under the
    // density (0.63 there, infinite at 0); (-0.5, 0.2) is off the support.
    const chi = renderRaster(['view(x = -1..3, y = -0.1..1.2)', 'X ~ ChiSquared(1)', 'P(X < 1)'], 100, 100);
    expect(Math.min(...pixel(chi, 32, 58))).toBeLessThan(Math.min(...pixel(chi, 12, 58)) - 5);
    // Beta(0.5, 0.5) has a pole at BOTH ends; P(X < 0.3) fills the left horn only.
    // 0.02 units/px centred on (0.5, 0.95): world (0.15, 0.5) → (32, 72), (0.7, 0.5) → (60, 72).
    const beta = renderRaster(['view(x = -0.5..1.5, y = -0.1..2)', 'X ~ Beta(0.5, 0.5)', 'P(X < 0.3)'], 100, 100);
    expect(Math.min(...pixel(beta, 32, 72))).toBeLessThan(Math.min(...pixel(beta, 60, 72)) - 5);
  });

  it('draws every zoo family without falling back to a blank plot', () => {
    const view = 'view(x = -3..5, y = -0.1..1)';
    const grid = inkFraction(renderRaster([view], 100, 100));
    for (const decl of ['Gamma(0.5, 1)', 'Beta(2, 3)', 'ChiSquared(3)', 'StudentT(2)', 'LogNormal(0, 0.5)', 'Cauchy(1, 0.5)', 'Weibull(1.5, 2)', 'Gamma(50, 25)']) {
      expect(inkFraction(renderRaster([view, `X ~ ${decl}`], 100, 100)), decl).toBeGreaterThan(grid + 0.003);
    }
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

  it('draws a discrete variable as stems, and a P(…) row over it as the heavier selected stems', () => {
    // 10 px per unit, x = 0 at px 10; y: 200 px per unit, axis at py 90.
    const view = 'view(x = -1..9, y = -0.05..0.45, ratio = 20)';
    const r = renderRaster([view, 'X ~ Binomial(6, 0.5)'], 100, 100);
    // The stem at k = 3 (px 40) runs from the axis up to 0.3125 (py ≈ 27.5).
    expect(Math.min(...pixel(r, 40, 60))).toBeLessThan(200);
    expect(Math.min(...pixel(r, 40, 15))).toBeGreaterThan(230); // above its top
    // Between the whole numbers there is nothing: a pmf is not a curve.
    expect(Math.min(...pixel(r, 45, 60))).toBeGreaterThan(230);
    expect(Math.min(...pixel(r, 35, 60))).toBeGreaterThan(230);
    // k = 7 is off the support.
    expect(Math.min(...pixel(r, 80, 85))).toBeGreaterThan(230);
    // Strictness is visible: P(X < 3) leaves the stem at 3 alone, P(X <= 3) thickens it.
    // (A plain stem inks the two columns x and x + 1; a selected one the four from x − 1 to x + 2.)
    const ink = (rows: string[], x: number) => [x - 1, x + 2].map(px => Math.min(...pixel(renderRaster([view, ...rows], 100, 100), px, 60)));
    const strict = ink(['X ~ Binomial(6, 0.5)', 'P(X < 3)'], 40);
    const closed = ink(['X ~ Binomial(6, 0.5)', 'P(X <= 3)'], 40);
    expect(Math.min(...strict)).toBeGreaterThan(230);
    expect(Math.max(...closed)).toBeLessThan(200);
    expect(Math.max(...ink(['X ~ Binomial(6, 0.5)', 'P(X < 3)'], 30))).toBeLessThan(200); // k = 2 is in both
    // A point event is its one stem; its complement every other.
    expect(Math.max(...ink(['X ~ Binomial(6, 0.5)', 'P(X = 3)'], 40))).toBeLessThan(200);
    expect(Math.min(...ink(['X ~ Binomial(6, 0.5)', 'P(X = 3)'], 30))).toBeGreaterThan(230);
    expect(Math.min(...ink(['X ~ Binomial(6, 0.5)', 'P(X != 3)'], 40))).toBeGreaterThan(230);
    expect(Math.max(...ink(['X ~ Binomial(6, 0.5)', 'P(X != 3)'], 30))).toBeLessThan(200);
  });

  it('draws a derived discrete variable as stems AT ITS ATOMS — between whole numbers, where they are', () => {
    // 20 px per unit, x = 0 at px 10; y: 200 px per unit, axis at py 90.
    const view = 'view(x = -0.5..4.5, y = -0.05..0.45, ratio = 10)';
    const rows = ['X ~ DiscreteUniform(1, 6)', 'H = X / 2'];
    const r = renderRaster([view, 'X ~ DiscreteUniform(1, 6)', 'H = X / 2'], 100, 100);
    const only = renderRaster([view, 'X ~ DiscreteUniform(1, 6)'], 100, 100);
    const inked = (a: typeof r, x: number, y: number) => Math.min(...pixel(a, x, y)) < 200;
    // H has an atom of mass 1/6 (py ≈ 56.7) at 1.5 (px 40) and at 2.5 (px 60): X has none there.
    for (const px of [40, 60]) {
      expect(inked(r, px, 75)).toBe(true);
      expect(inked(only, px, 75)).toBe(false);
    }
    expect(inked(r, 45, 75)).toBe(false); // 1.75: between atoms
    // Never a curve: the row of pixels at half height is ink only at stems.
    let columns = 0;
    for (let x = 0; x < 100; x++) if (inked(r, x, 75) && !inked(only, x, 75)) columns++;
    expect(columns).toBeLessThanOrEqual(8);
    // P(H <= 1.5) thickens the stem at 1.5 and leaves 2's alone; P(H < 1.5) leaves both.
    const band = (body: string, px: number) => inked(renderRaster([view, ...rows, body], 100, 100), px + 2, 75) && !inked(r, px + 2, 75);
    expect(band('P(H <= 1.5)', 40)).toBe(true);
    expect(band('P(H < 1.5)', 40)).toBe(false);
    expect(band('P(H <= 1.5)', 50)).toBe(false);
    expect(band('P(X / 2 = 1.5)', 40)).toBe(true); // an inline expression selects the same atom
    // E(H) = 1.75 stands on the axis (no atom there); E(X + X) = 7 on its atom.
    const mark = renderRaster([view, ...rows, 'E(H)'], 100, 100);
    expect(inked(mark, 45, 90) || inked(mark, 46, 90)).toBe(true);
    expect(inked(mark, 45, 75)).toBe(false);
  });

  it('does not pay for readouts it never shows: nothing is enumerated until a row is drawn', () => {
    const rows = ['X ~ Poisson(30)', 'Y ~ Poisson(30)', 'S = X Y', 'P(X > Y)', 'E(X Y)', 'P(X Y + X > 900)'];
    const before = { ...ENUM_STATS };
    expect(canRenderOg(rows)).toBe(true);
    const a = analyze(rows, { readouts: false });
    expect(a.rows.map(r => r.info)).toEqual(rows.map(() => undefined));
    expect(a.rows.map(r => r.cpu?.type)).toEqual(['pmf', 'pmf', 'pmf', 'prob', 'expect', 'prob']);
    expect(ENUM_STATS).toEqual(before);
    // MCP validation asks for them, and gets them.
    expect(analyze(rows).rows.map(r => r.info)).toEqual([undefined, undefined, 'μ = 900, σ = 234.307', '≈ 0.4742', '≈ 900.0000', '≈ 0.5032']);
    // Drawing enumerates what is drawn — S, the marker's variable, the selection — and not the joint event.
    const mid = { ...ENUM_STATS };
    renderRaster(['X ~ Poisson(30)', 'Y ~ Poisson(30)', 'P(X > Y)'], 100, 100);
    expect(ENUM_STATS.points).toBe(mid.points);
  });

  it('draws a selection as the app does: a band that widens with the zoom, capped by an enlarged dot', () => {
    // lib's stemGeometry: width = clamp(0.6 · px per unit, 3, 9), dot r + 3.
    const rows = ['X ~ Binomial(6, 0.5)', 'P(X = 3)'];
    const band = (view: string, x: number, y: number) => {
      const plain = renderRaster([view, rows[0]], 100, 100);
      const sel = renderRaster([view, ...rows], 100, 100);
      return Math.abs(pixel(sel, x, y)[0] - pixel(plain, x, y)[0]) + Math.abs(pixel(sel, x, y)[2] - pixel(plain, x, y)[2]);
    };
    const wide = 'view(x = 2..4.5, y = -0.05..0.45, ratio = 5)'; // 40 px per unit: x = 3 at px 40, band 9 px
    const narrow = 'view(x = -1..9, y = -0.05..0.45, ratio = 20)'; // 10 px per unit: x = 3 at px 40, band 6 px
    expect(band(wide, 44, 60)).toBeGreaterThan(20);
    expect(band(wide, 37, 60)).toBeGreaterThan(20);
    expect(band(narrow, 44, 60)).toBe(0);
    expect(band(narrow, 42, 60)).toBeGreaterThan(20);
    // The enlarged translucent dot (r = 6.5) reaches past the band at the stem's top (py ≈ 27.5).
    expect(band(wide, 46, 28)).toBeGreaterThan(10);
  });

  it('stands the E(X) marker on the stem when the mean is a whole number only up to rounding', () => {
    // Binomial(100, 0.07): mean 7.000000000000001, pmf(7) ≈ 0.1545. 10 px per
    // unit, x = 7 at px 50; 400 px per unit of y, axis at py 90, stem top ≈ py 28.
    const view = 'view(x = 2..12, y = -0.025..0.225, ratio = 40)';
    const bare = renderRaster([view, 'E(X)'], 100, 100);
    const r = renderRaster([view, 'X ~ Binomial(100, 0.07)', 'E(X)'], 100, 100);
    const only = renderRaster([view, 'X ~ Binomial(100, 0.07)'], 100, 100);
    expect(bare.px).toEqual(renderRaster([view], 100, 100).px);
    // The marker's dot caps the stem (py ≈ 28) instead of sitting on the axis (py 90).
    const diff = (x: number, y: number) => Math.abs(pixel(r, x, y)[0] - pixel(only, x, y)[0]);
    expect(diff(50, 28) + diff(51, 28) + diff(50, 27) + diff(47, 28)).toBeGreaterThan(40);
    expect(diff(47, 90) + diff(53, 92)).toBe(0);
  });

  it('draws a huge discrete law zoomed out as its envelope, in bounded time', () => {
    const t0 = performance.now();
    const r = renderRaster(['view(x = 990000..1010000, y = -0.00005..0.00045, ratio = 40000000)', 'X ~ Poisson(1000000)'], 100, 100);
    expect(performance.now() - t0).toBeLessThan(2000);
    // Under the peak (px 50; pmf ≈ 0.0004 → py ≈ 10) the outline is filled.
    expect(Math.min(...pixel(r, 50, 50))).toBeLessThan(245);
    expect(Math.min(...pixel(r, 10, 50))).toBeGreaterThan(230);
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
  it('draws a complex path in the same plane as Argand points and roots', () => {
    // The unit circle passes through all three roots of unity and through i.
    const r = renderRaster(['exp(i 2 pi u)', frame], 160, 160);
    for (const [x, y] of [[100, 80], [70, 63], [70, 97], [80, 60], [60, 80]]) {
      expect(Math.min(...pixel(r, x, y)), `${x},${y}`).toBeLessThan(150);
    }
    expect(Math.min(...pixel(r, 85, 85))).toBeGreaterThan(200);
  });
  it('draws the image of a path under a user function', () => {
    // f(1) = 2 and f(-1) = 0 lie on the image of the unit circle.
    const r = renderRaster(['f(w) = w^2 + w', 'f(exp(i 2 pi u))', frame], 160, 160);
    expect(Math.min(...pixel(r, 120, 80))).toBeLessThan(150);
  });
  it('leaves a branch-cut jump undrawn instead of bridging it', () => {
    // sqrt of the circle is the right half circle, jumping i → -i: no chord
    // down the imaginary axis.
    const r = renderRaster(['sqrt(exp(i 2 pi u))', frame], 160, 160);
    expect(Math.min(...pixel(r, 100, 80))).toBeLessThan(150);
    // …where only the grey axis shows, not the curve's colour.
    for (const y of [70, 75, 85, 90]) {
      const [red, , blue] = pixel(r, 80, y);
      expect(blue - red, `y=${y}`).toBeLessThan(10);
    }
    expect(pixel(r, 100, 80)[2] - pixel(r, 100, 80)[0]).toBeGreaterThan(50);
  });
  it('draws the spiral across the atan2 branch cut', () => {
    const r = renderRaster(['r = sqrt(x^2+y^2)', 'theta = atan2(y,x)', '(r, theta) = (3u, 6pi u)', frame], 160, 160);
    // Radius 2.5 at angle 5pi: (-2.5, 0).
    expect(Math.min(...pixel(r, 30, 80))).toBeLessThan(150);
  });
});
