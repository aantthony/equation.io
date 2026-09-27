import { describe, expect, it } from 'vitest';
import { fanFillable } from './figure-vertices.ts';

const flat = (pts: number[][]) => pts.flat();
const arc = (from: number, to: number, n: number, centre = false) => {
  const out = centre ? [[0, 0, 0]] : [];
  for (let k = 0; k <= n; k++) {
    const t = from + ((to - from) * k) / n;
    out.push([Math.cos(t), Math.sin(t), 0]);
  }
  return out;
};

describe('fanFillable', () => {
  it('fills triangles, convex outlines and discs, in any plane', () => {
    expect(
      fanFillable(
        flat([
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ]),
      ),
    ).toBe(true);
    expect(
      fanFillable(
        flat([
          [0, 0, 0],
          [1, 0, 1],
          [1, 1, 1],
          [0, 1, 0],
        ]),
      ),
    ).toBe(true);
    expect(fanFillable(flat(arc(0, 2 * Math.PI, 47)))).toBe(true);
  });
  it('fills a sector past 180°, which starts at its centre', () => {
    expect(fanFillable(flat(arc(0, 1.6 * Math.PI, 36, true)))).toBe(true);
    // Clockwise works too: the fan turns one way throughout.
    expect(fanFillable(flat(arc(0, -1.6 * Math.PI, 36, true)))).toBe(true);
  });
  it('leaves concave, skew and degenerate outlines unfilled', () => {
    // A U seen from a bottom corner: the fan would cover the notch.
    const u = [
      [0, 0],
      [3, 0],
      [3, 2],
      [2, 2],
      [2, 1],
      [1, 1],
      [1, 2],
      [0, 2],
    ].map(([x, y]) => [x, y, 0]);
    expect(fanFillable(flat(u))).toBe(false);
    // An L is star-shaped from its outer corner, so its fan is exact.
    expect(
      fanFillable(
        flat(
          [
            [0, 0],
            [2, 0],
            [2, 1],
            [1, 1],
            [1, 2],
            [0, 2],
          ].map(([x, y]) => [x, y, 0]),
        ),
      ),
    ).toBe(true);
    expect(
      fanFillable(
        flat([
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 1],
          [0, 1, 0],
        ]),
      ),
    ).toBe(false);
    expect(
      fanFillable(
        flat([
          [0, 0, 0],
          [1, 1, 1],
          [2, 2, 2],
        ]),
      ),
    ).toBe(false);
    expect(
      fanFillable(
        flat([
          [0, 0, 0],
          [1, 0, 0],
        ]),
      ),
    ).toBe(false);
  });
});
