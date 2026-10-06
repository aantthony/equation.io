import { describe, expect, it } from 'vitest';
import { cameraMatrices, pointFade, pointSpacing } from '../web/render3d.ts';

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

describe('pointFade', () => {
  const cam = { theta: 0, phi: 0, radius: 10, target: [0, 0, 0] as [number, number, number] };
  const { vp } = cameraMatrices(cam, 1);

  it('runs from the nearest point over the points’ depth range', () => {
    // The eye is at (10, 0, 0), looking down -x.
    const [near, span] = pointFade(vp, [{ pos: [3, 0, 0] }, { pos: [-3, 0, 0] }], 1);
    expect(near).toBeCloseTo(7);
    expect(span).toBeCloseTo(6);
  });

  it('spans at least the given size', () => {
    const [near, span] = pointFade(vp, [{ pos: [0, 0, 0] }], 4);
    expect(near).toBeCloseTo(10);
    expect(span).toBe(4);
  });

  it('ignores points behind the camera', () => {
    const [near] = pointFade(vp, [{ pos: [20, 0, 0] }, { pos: [0, 0, 0] }], 1);
    expect(near).toBeCloseTo(10);
  });
});
