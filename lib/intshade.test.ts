import { describe, expect, it } from 'vitest';
import { parseExpr } from './expr.ts';
import { SHADE_MAX_EVALS, SHADE_SAMPLES, boundValue, integralAreas, shadeAreas } from './intshade.ts';

const WIN = { xmin: -10, xmax: 10, ymin: -5, ymax: 5 };

/** Shoelace area of a closed [x0, y0, …] polygon (positive, whatever its winding). */
function area(p: number[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    s += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return Math.abs(s) / 2;
}
const total = (ps: number[][]) => ps.reduce((s, p) => s + area(p), 0);
const xs = (p: number[]) => p.filter((_, i) => i % 2 === 0);
const ys = (p: number[]) => p.filter((_, i) => i % 2 === 1);

describe('integralAreas', () => {
  it('fills between the integrand and the axis over [a, b]', () => {
    const { pos, neg } = integralAreas(x => x * x, 0, 1, WIN);
    expect(neg).toEqual([]);
    expect(pos).toHaveLength(1);
    expect(total(pos)).toBeCloseTo(1 / 3, 4);
    // Closed down to the axis at exactly a and b.
    expect(pos[0].slice(0, 2)).toEqual([0, 0]);
    expect(pos[0].slice(-2)).toEqual([1, 0]);
  });

  it('tints by the contribution to the value, so reversed bounds swap the tints', () => {
    const f = (x: number) => x;
    const fwd = integralAreas(f, -1, 2, WIN);
    expect(total(fwd.pos)).toBeCloseTo(2, 4);
    expect(total(fwd.neg)).toBeCloseTo(0.5, 4);
    // int[2..-1] x dx = -1.5: the region above the axis now SUBTRACTS.
    const rev = integralAreas(f, 2, -1, WIN);
    expect(rev.neg).toEqual(fwd.pos);
    expect(rev.pos).toEqual(fwd.neg);
    expect(total(rev.pos) - total(rev.neg)).toBeCloseTo(-1.5, 4);
  });

  it('is empty for equal, NaN, or off-screen bounds', () => {
    const none = { pos: [], neg: [] };
    expect(integralAreas(x => x, 1, 1, WIN)).toEqual(none);
    expect(integralAreas(x => x, NaN, 1, WIN)).toEqual(none);
    expect(integralAreas(x => x, 0, NaN, WIN)).toEqual(none);
    expect(integralAreas(x => x, 20, 30, WIN)).toEqual(none);
    expect(integralAreas(x => x, Infinity, Infinity, WIN)).toEqual(none);
    expect(integralAreas(() => 0, 0, 1, WIN)).toEqual(none); // encloses nothing
  });

  it('clips infinite and far-off bounds to the window, never sampling beyond it', () => {
    const seen: number[] = [];
    const f = (x: number) => { seen.push(x); return Math.exp(-x * x); };
    const { pos } = integralAreas(f, -Infinity, Infinity, WIN);
    expect(Math.min(...seen)).toBe(-10);
    expect(Math.max(...seen)).toBe(10);
    expect(total(pos)).toBeCloseTo(Math.sqrt(Math.PI), 3);
    // Zoomed far into a huge range: every sample lands in view.
    const zoom = { xmin: 0.5, xmax: 0.5001, ymin: 0, ymax: 1 };
    const z = integralAreas(x => x, -1e9, 1e9, zoom);
    expect(xs(z.pos[0])[0]).toBe(0.5);
    expect(xs(z.pos[0]).at(-1)).toBe(0.5001);
    expect(z.pos[0].length).toBe(2 * (SHADE_SAMPLES + 3));
  });

  it('splits the tints exactly at a zero crossing, not at a sample', () => {
    // The root 1/3 is not on the sample lattice of [0, 1].
    const { pos, neg } = integralAreas(x => x - 1 / 3, 0, 1, WIN);
    expect(neg).toHaveLength(1);
    expect(pos).toHaveLength(1);
    expect(xs(neg[0]).at(-1)).toBeCloseTo(1 / 3, 8);
    expect(xs(pos[0])[0]).toBeCloseTo(1 / 3, 8);
    expect(Math.max(...ys(neg[0]))).toBeLessThanOrEqual(1e-8);
    expect(Math.min(...ys(pos[0]))).toBeGreaterThanOrEqual(-1e-8);
  });

  it('a sample landing exactly on a root still separates the tints', () => {
    const { pos, neg } = integralAreas(x => x ** 3, -1, 1, WIN);
    expect([pos.length, neg.length]).toEqual([1, 1]);
    expect(Math.max(...ys(neg[0]))).toBe(0);
    expect(Math.min(...ys(pos[0]))).toBe(0);
    expect(total(pos)).toBeCloseTo(0.25, 4);
    // Touching the axis without crossing keeps one tint.
    const touch = integralAreas(x => x * x, -1, 1, WIN);
    expect(touch.neg).toEqual([]);
    expect(total(touch.pos)).toBeCloseTo(2 / 3, 4);
  });

  it('breaks at undefined stretches instead of bridging them', () => {
    // Defined on [-2, -1] and [1, 2] only: two polygons, edges refined.
    const f = (x: number) => (Math.abs(x) >= 1 ? 1 : NaN);
    const { pos } = integralAreas(f, -2, 2, WIN);
    expect(pos).toHaveLength(2);
    expect(xs(pos[0]).at(-1)).toBeCloseTo(-1, 6);
    expect(xs(pos[1])[0]).toBeCloseTo(1, 6);
    expect(total(pos)).toBeCloseTo(2, 5);
    // A domain edge inside the range: sqrt starts at 0, sharply.
    const s = integralAreas(x => Math.sqrt(x), -1, 1, WIN);
    expect(s.pos).toHaveLength(1);
    expect(xs(s.pos[0])[0]).toBeCloseTo(0, 6);
    // A throwing integrand is undefined, not an exception.
    expect(integralAreas(() => { throw new Error('unbound'); }, 0, 1, WIN)).toEqual({ pos: [], neg: [] });
  });

  it('keeps a pole two one-sided spikes, clamped near the window', () => {
    const { pos, neg } = integralAreas(x => 1 / x, -1, 1, WIN);
    expect([pos.length, neg.length]).toEqual([1, 1]);
    expect(Math.max(...xs(neg[0]))).toBeLessThanOrEqual(0);
    expect(Math.min(...xs(pos[0]))).toBeGreaterThanOrEqual(0);
    // y never leaves one window-height beyond the window.
    expect(Math.max(...ys(pos[0]))).toBe(15);
    expect(Math.min(...ys(neg[0]))).toBe(-15);
    // The axis itself is clamped when it is far off-screen.
    const high = integralAreas(() => 1e9, 0, 1, { xmin: -1, xmax: 2, ymin: 1e9 - 1, ymax: 1e9 + 1 });
    expect(Math.min(...ys(high.pos[0]))).toBe(1e9 - 3);
  });

  it('a jump across the axis keeps both one-sided values', () => {
    const { pos, neg } = integralAreas(x => (x < 0.3 ? -1 : 2), 0, 1, WIN);
    expect(xs(neg[0]).at(-1)).toBeCloseTo(0.3, 6);
    expect(ys(neg[0]).at(-2)).toBe(-1);
    expect(ys(pos[0])[1]).toBe(2);
    expect(total(neg)).toBeCloseTo(0.3, 5);
    expect(total(pos)).toBeCloseTo(1.4, 5);
  });

  it('perf guard: evaluations are capped however wild the integrand', () => {
    let evals = 0;
    const f = (x: number) => { evals++; return Math.sin(61 * x); }; // flips sign between most samples
    const { pos, neg } = integralAreas(f, -10, 10, WIN);
    expect(evals).toBeLessThanOrEqual(SHADE_MAX_EVALS);
    expect(pos.length + neg.length).toBeGreaterThan(100);
    // A tame integrand costs the samples plus one refinement per crossing.
    evals = 0;
    integralAreas(x => { evals++; return x - 1 / 3; }, 0, 1, WIN);
    expect(evals).toBeLessThanOrEqual(SHADE_SAMPLES + 1 + 20);
  });
});

describe('shadeAreas / boundValue', () => {
  it('binds the integration variable per sample, shadowing t and constants', () => {
    const shade = { body: parseExpr('a t'), v: 't', lo: parseExpr('0'), hi: parseExpr('b') };
    const { pos } = shadeAreas(shade, { a: 2, b: 1, t: 99 }, WIN);
    expect(total(pos)).toBeCloseTo(1, 4);
  });

  it('reads ±inf bounds, and NaN for a bound with no value yet', () => {
    expect(boundValue(parseExpr('inf'), {})).toBe(Infinity);
    expect(boundValue(parseExpr('-inf'), {})).toBe(-Infinity);
    expect(boundValue(parseExpr('2 a'), { a: 3 })).toBe(6);
    expect(boundValue(parseExpr('a'), {})).toBeNaN();
  });
});
