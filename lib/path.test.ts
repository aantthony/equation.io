import { describe, expect, it } from 'vitest';
import { evaluate, parseExpr } from './expr.ts';
import { PATH_NODE_BUDGET, PATH_SAMPLES, exprSize, pathSampler, samplePath } from './path.ts';
import { classify } from './plot.ts';

const comps = (s: string) => {
  const plot = classify(parseExpr(s), new Set(['a']));
  if (plot.plot.type !== 'pcurve') throw new Error(`not a path: ${plot.plot.type}`);
  return plot.plot.comps;
};
const breaks = (pts: number[]) => pts.filter(Number.isNaN).length / 2;

describe('samplePath', () => {
  it('samples u over [0, 1] inclusive, so exp(i 2 pi u) closes', () => {
    const pts = pathSampler(comps('exp(i 2 pi u)'))({});
    expect(pts).toHaveLength(2 * PATH_SAMPLES);
    expect(pts[0]).toBeCloseTo(1);
    expect(pts[1]).toBeCloseTo(0);
    expect(pts[pts.length - 2]).toBeCloseTo(1);
    expect(pts[pts.length - 1]).toBeCloseTo(0);
    for (let k = 0; k < pts.length; k += 2) expect(Math.hypot(pts[k], pts[k + 1])).toBeCloseTo(1);
  });

  it('lifts the pen where a branch cut makes the path jump', () => {
    // sqrt flips i → -i as the circle crosses the negative real axis.
    const root = pathSampler(comps('sqrt(exp(i 2 pi u))'))({});
    expect(breaks(root)).toBe(1);
    const at = root.findIndex(Number.isNaN);
    expect(root[at - 1]).toBeCloseTo(1, 1);
    expect(root[at + 3]).toBeCloseTo(-1, 1);
    // ln's imaginary part drops 2π there.
    expect(breaks(pathSampler(comps('ln(exp(i 2 pi u))'))({}))).toBe(1);
    // A fractional power of the circle, likewise.
    expect(breaks(pathSampler(comps('exp(i 2 pi u)^0.5'))({}))).toBe(1);
  });

  it('does not break a continuous path, however uneven its speed', () => {
    expect(breaks(pathSampler(comps('exp(i 2 pi u)'))({}))).toBe(0);
    expect(breaks(pathSampler(comps('(u + i)^8'))({}))).toBe(0);
    // Slow, then suddenly fast: a corner in speed is not a jump.
    expect(breaks(samplePath(u => [u < 0.5 ? u / 100 : 0.005 + 50 * (u - 0.5), 0], 400))).toBe(0);
    // A spike one sample wide is continuous too.
    expect(breaks(samplePath(u => [u, Math.exp(-(((u - 0.5) * 2000) ** 2))], 400))).toBe(0);
  });

  it('breaks a step between constant stretches', () => {
    const pts = samplePath(u => [u, Math.floor(3 * u)], 100);
    expect(breaks(pts)).toBe(3); // at 1/3, 2/3, and the last sample (u = 1)
  });

  it('keeps undefined samples as they are: the pen is already up', () => {
    const pts = samplePath(u => [u, u > 0.4 && u < 0.6 ? NaN : 0], 50);
    expect(pts).toHaveLength(100);
  });

  it('bounds the refinement work on a path that is all jumps', () => {
    let calls = 0;
    samplePath(u => { calls++; return [u, Math.floor(200 * u) % 7 === 0 ? 5 : 0]; }, 400);
    expect(calls).toBeLessThanOrEqual(400 + 32 * 12);
  });
});

describe('pathSampler', () => {
  it('reads constants and t from the frame, matching the tree-walking evaluator', () => {
    const c = comps('a exp(i (2 pi u + t))');
    const env = { a: 2, t: 0.7 };
    const pts = pathSampler(c)(env);
    for (const k of [0, 57, 399]) {
      const u = k / (PATH_SAMPLES - 1);
      expect(pts[2 * k]).toBeCloseTo(evaluate(c[0], { ...env, u }), 12);
      expect(pts[2 * k + 1]).toBeCloseTo(evaluate(c[1], { ...env, u }), 12);
    }
  });
});

describe('exprSize', () => {
  it('counts what the evaluator walks and stops at its limit', () => {
    expect(exprSize(parseExpr('1 + 2 x'))).toBe(5);
    const big = comps('sqrt(exp(i 2 pi u))')[0];
    expect(exprSize(big)).toBeGreaterThan(500);
    expect(exprSize(big, 100)).toBeLessThan(110);
    expect(PATH_NODE_BUDGET).toBeGreaterThan(exprSize(big));
  });
});
