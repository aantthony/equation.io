import { describe, expect, it } from 'vitest';
import { POINT_STRIDE, cameraMatrices, pointSpacing, pointVertices } from '../web/render3d.ts';

const fib = (n: number, r = 1): Float32Array => {
  const pos = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const h = 1 - (2 * (k + 0.5)) / n;
    const s = Math.sqrt(1 - h * h);
    pos.set([r * s * Math.cos(2.39996 * k), r * s * Math.sin(2.39996 * k), r * h], k * 3);
  }
  return pos;
};

describe('pointSpacing', () => {
  it('is the nearest-neighbour distance of an even lattice', () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]);
    expect(pointSpacing(pos)).toBeCloseTo(1);
  });

  it('shrinks as a cloud gets denser, by the square root for a surface', () => {
    const a = pointSpacing(fib(500));
    const b = pointSpacing(fib(2000));
    expect(a / b).toBeGreaterThan(1.7);
    expect(a / b).toBeLessThan(2.3);
  });

  it('scales with the cloud', () => {
    expect(pointSpacing(fib(1000, 10)) / pointSpacing(fib(1000))).toBeCloseTo(10, 1);
  });

  it('is infinite for one point, or one point repeated', () => {
    expect(pointSpacing(new Float32Array([1, 2, 3]))).toBe(Infinity);
    expect(pointSpacing(new Float32Array([1, 2, 3, 1, 2, 3]))).toBe(Infinity);
  });
});

describe('pointVertices', () => {
  // The eye is at (10, 0, 0), looking down -x.
  const cam = { theta: 0, phi: 0, radius: 10, target: [0, 0, 0] as [number, number, number] };
  const { vp } = cameraMatrices(cam, 1);
  const opts = { loneD: 0.5, minD: 0.1, minSpan: 1 };
  const red: [number, number, number] = [1, 0, 0];
  const blue: [number, number, number] = [0, 0, 1];
  const vertex = (v: Float32Array, i: number) => Array.from(v.subarray(i * POINT_STRIDE, (i + 1) * POINT_STRIDE));

  it('sorts farthest first', () => {
    const v = pointVertices(
      vp,
      [
        { pos: [3, 0, 0], color: red },
        { pos: [-3, 0, 0], color: blue },
      ],
      opts,
    );
    expect(vertex(v, 0)[0]).toBe(-3);
    expect(vertex(v, 1)[0]).toBe(3);
  });

  it('fades a cloud from its own nearest point over its depth range', () => {
    const row = {};
    const v = pointVertices(
      vp,
      [
        { pos: [9, 0, 0], color: blue, group: {} },
        { pos: [3, 0, 0], color: red, group: row },
        { pos: [-3, 0, 0], color: red, group: row },
      ],
      opts,
    );
    const cloud = vertex(v, 0);
    expect(cloud[7]).toBeCloseTo(7);
    expect(cloud[8]).toBeCloseTo(6);
    // The lone point nearer the eye is solid and full size.
    const lone = vertex(v, 2);
    expect(lone[0]).toBe(9);
    expect(lone[6]).toBe(0.5);
    expect(lone[8]).toBe(0);
  });

  it('keeps separate rows of one colour apart', () => {
    const v = pointVertices(
      vp,
      [
        { pos: [0, 0, 0], color: red, group: {} },
        { pos: [0, 0.05, 0], color: red, group: {} },
      ],
      opts,
    );
    for (const i of [0, 1]) {
      expect(vertex(v, i)[6]).toBe(0.5);
      expect(vertex(v, i)[8]).toBe(0);
    }
  });

  it('sizes a cloud by its spacing, between minD and loneD', () => {
    const row = {};
    const at = (pos: [number, number, number][]) =>
      vertex(
        pointVertices(
          vp,
          pos.map(p => ({ pos: p, color: red, group: row })),
          opts,
        ),
        0,
      )[6];
    expect(
      at([
        [0, 0, 0],
        [0, 0.4, 0],
        [0, 0.8, 0],
      ]),
    ).toBeCloseTo(0.2);
    // Two roots a hair apart do not shrink the dots to nothing.
    expect(
      at([
        [0, 0, 0],
        [0, 0, 0.001],
        [0, 5, 5],
      ]),
    ).toBeCloseTo(0.1);
    expect(
      at([
        [0, 0, 0],
        [0, 5, 0],
      ]),
    ).toBe(0.5);
  });
});
