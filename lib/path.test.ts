import { compileCpu } from './compiler.ts';
import { describe, expect, it } from 'vitest';
import { evaluate, parseExpr } from './expr.ts';
import { CURVE_SAMPLES, PATH_NODE_BUDGET, pathSampler, samplePath } from './path.ts';
import { countNodes, exceedsNodes } from './size.ts';
import { classify } from './plot.ts';

const comps = (s: string) => {
  const plot = classify(parseExpr(s), new Set(['a']));
  if (compileCpu(plot).type !== 'pcurve') throw new Error(`not a path: ${compileCpu(plot).type}`);
  return compileCpu(plot).comps;
};
const breaks = (pts: number[]) => pts.filter(Number.isNaN).length / 2;

describe('samplePath', () => {
  it('samples u over [0, 1] inclusive, so exp(i 2 pi u) closes', () => {
    const pts = pathSampler(comps('exp(i 2 pi u)')).sample({});
    expect(pts).toHaveLength(2 * CURVE_SAMPLES);
    expect(pts[0]).toBeCloseTo(1);
    expect(pts[1]).toBeCloseTo(0);
    expect(pts[pts.length - 2]).toBeCloseTo(1);
    expect(pts[pts.length - 1]).toBeCloseTo(0);
    for (let k = 0; k < pts.length; k += 2) expect(Math.hypot(pts[k], pts[k + 1])).toBeCloseTo(1);
  });

  it('lifts the pen where a branch cut makes the path jump', () => {
    // sqrt flips i → -i as the circle crosses the negative real axis.
    const root = pathSampler(comps('sqrt(exp(i 2 pi u))')).sample({});
    expect(breaks(root)).toBe(1);
    const at = root.findIndex(Number.isNaN);
    expect(root[at - 1]).toBeCloseTo(1, 1);
    expect(root[at + 3]).toBeCloseTo(-1, 1);
    // ln's imaginary part drops 2π there.
    expect(breaks(pathSampler(comps('ln(exp(i 2 pi u))')).sample({}))).toBe(1);
    // A fractional power of the circle, likewise.
    expect(breaks(pathSampler(comps('exp(i 2 pi u)^0.5')).sample({}))).toBe(1);
  });

  it('does not break a continuous path, however uneven its speed', () => {
    expect(breaks(pathSampler(comps('exp(i 2 pi u)')).sample({}))).toBe(0);
    expect(breaks(pathSampler(comps('(u + i)^8')).sample({}))).toBe(0);
    // Slow, then suddenly fast: a corner in speed is not a jump.
    expect(breaks(samplePath(u => [u < 0.5 ? u / 100 : 0.005 + 50 * (u - 0.5), 0], 400))).toBe(0);
    // A spike one sample wide is continuous too.
    expect(breaks(samplePath(u => [u, Math.exp(-(((u - 0.5) * 2000) ** 2))], 400))).toBe(0);
  });

  it('breaks a step between constant stretches', () => {
    const pts = samplePath(u => [u, Math.floor(3 * u)], 100);
    expect(breaks(pts)).toBe(3); // at 1/3, 2/3, and the last sample (u = 1)
  });

  it('breaks every cut of a path that crosses many, not just the first few', () => {
    // 50 turns of the circle: ln jumps 2π at each crossing of the cut.
    const pts = pathSampler(comps('ln(exp(i 100 pi u))')).sample({});
    expect(breaks(pts)).toBe(50);
    // No drawn segment spans a cut.
    for (let k = 0; k + 3 < pts.length; k += 2) {
      if (Number.isNaN(pts[k]) || Number.isNaN(pts[k + 2])) continue;
      expect(Math.abs(pts[k + 3] - pts[k + 1])).toBeLessThan(3);
    }
  });

  it('sees two jumps in neighbouring intervals: they do not vouch for each other', () => {
    const pts = samplePath(u => [u, (u > 0.5 && u < 0.5024) ? 5 : 0], 400);
    expect(breaks(pts)).toBe(2);
  });

  it('ignores rounding noise on a path that barely moves', () => {
    expect(breaks(pathSampler(comps('exp(i u)/exp(i u) + 0 i')).sample({}))).toBe(0);
    let calls = 0;
    const noisy = samplePath(u => { calls++; return [1 + (Math.round(u * 399) % 3 === 0 ? 2e-16 : 0), 0]; }, 400);
    expect(breaks(noisy)).toBe(0);
    expect(calls).toBe(400);
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
  const real = (s: string) => {
    const plot = compileCpu(classify(parseExpr(s)));
    if (plot.type !== 'pcurve') throw new Error('not a curve');
    return pathSampler(plot.comps).sample({});
  };

  it('breaks a real parametric curve at its jumps too: one sampler for every plane curve', () => {
    // Steps at u = 1/3 and 2/3 (and the lone last sample, floor(3) = 3).
    expect(breaks(real('(u, floor(3u))'))).toBe(3);
    // The pole of tan at 3u = π/2: no chord from +∞ to −∞.
    const tan = real('(u, tan(3u))');
    expect(breaks(tan)).toBe(1);
    const at = tan.findIndex(Number.isNaN);
    expect(tan[at - 1]).toBeGreaterThan(0);
    expect(tan[at + 3]).toBeLessThan(0);
  });

  it('leaves smooth real curves and their undefined stretches exactly as sampled', () => {
    const circle = real('(cos(2pi u), sin(2pi u))');
    expect(circle).toHaveLength(2 * CURVE_SAMPLES);
    expect(breaks(circle)).toBe(0);
    expect(breaks(real('(u cos(6pi u) 3, u sin(6pi u) 3)'))).toBe(0);
    // A no-default piecewise component is undefined off its condition.
    const half = real('(2cos(2pi u), {sin(2pi u) > 0: 2sin(2pi u)})');
    expect(half).toHaveLength(2 * CURVE_SAMPLES);
    expect(half[2 * 100 + 1]).toBeCloseTo(2 * Math.sin(2 * Math.PI * 100 / (CURVE_SAMPLES - 1)));
    expect(half[2 * 300 + 1]).toBeNaN();
  });

  it('reads constants and t from the frame, matching the tree-walking evaluator', () => {
    const c = comps('a exp(i (2 pi u + t))');
    const env = { a: 2, t: 0.7 };
    expect(pathSampler(c).names.sort()).toEqual(['a', 't']);
    const pts = pathSampler(c).sample(env);
    for (const k of [0, 57, 399]) {
      const u = k / (CURVE_SAMPLES - 1);
      expect(pts[2 * k]).toBeCloseTo(evaluate(c[0], { ...env, u }), 12);
      expect(pts[2 * k + 1]).toBeCloseTo(evaluate(c[1], { ...env, u }), 12);
    }
  });
});

describe('countNodes', () => {
  it('counts what the evaluator walks, a shared subtree once per use — in time linear in the objects', () => {
    expect(countNodes(parseExpr('1 + 2 x'))).toBe(5);
    const big = comps('sqrt(exp(i 2 pi u))')[0];
    expect(countNodes(big)).toBeGreaterThan(500);
    expect(countNodes(big, new WeakMap())).toBe(countNodes(big));
    expect(PATH_NODE_BUDGET).toBeGreaterThan(countNodes(big));
    // Sixty doublings: 2^60 nodes spelled by sixty objects.
    let e = parseExpr('u');
    for (let k = 0; k < 60; k++) e = { kind: 'bin', op: '*', a: e, b: e };
    expect(countNodes(e, new WeakMap())).toBeGreaterThan(1e18);
    // …and refused without walking them.
    expect(exceedsNodes(e, 10000)).toBe(true);
    expect(exceedsNodes(parseExpr('1 + 2 x'), 5)).toBe(false);
    expect(exceedsNodes(parseExpr('1 + 2 x'), 4)).toBe(true);
  });
});
