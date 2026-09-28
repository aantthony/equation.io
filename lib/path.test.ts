import { compileCpu } from './compiler.ts';
import { describe, expect, it } from 'vitest';
import { evaluate, parseExpr } from './expr.ts';
import { CURVE_SAMPLES, PATH_NODE_BUDGET, foldAllExcept, pathSampler, samplePath } from './path.ts';
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
    const pts = samplePath(u => [u, u > 0.5 && u < 0.5024 ? 5 : 0], 400);
    expect(breaks(pts)).toBe(2);
  });

  it('ignores rounding noise on a path that barely moves', () => {
    expect(breaks(pathSampler(comps('exp(i u)/exp(i u) + 0 i')).sample({}))).toBe(0);
    let calls = 0;
    const noisy = samplePath(u => {
      calls++;
      return [1 + (Math.round(u * 399) % 3 === 0 ? 2e-16 : 0), 0];
    }, 400);
    expect(breaks(noisy)).toBe(0);
    expect(calls).toBe(400);
  });

  it('keeps undefined samples as they are: the pen is already up', () => {
    const pts = samplePath(u => [u, u > 0.4 && u < 0.6 ? NaN : 0], 50);
    expect(pts).toHaveLength(100);
  });

  it('bounds the refinement work on a path that is all jumps', () => {
    let calls = 0;
    samplePath(u => {
      calls++;
      return [u, Math.floor(200 * u) % 7 === 0 ? 5 : 0];
    }, 400);
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
    expect(half[2 * 100 + 1]).toBeCloseTo(2 * Math.sin((2 * Math.PI * 100) / (CURVE_SAMPLES - 1)));
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

describe('foldAllExcept', () => {
  it('works out once what does not move with u', () => {
    const e = parseExpr('sqrt(a^2 + t) cos(2pi u) + sum(n=1..3, n a) + b');
    const [folded] = foldAllExcept([e], 'u', { a: 3, t: 7, b: 1 });
    // Only u (and pi, a constant) is left to read: sqrt(16), the sum and b are numbers.
    expect(countNodes(folded)).toBeLessThan(countNodes(e));
    for (const u of [0, 0.3, 0.8]) {
      expect(evaluate(folded, { u })).toBeCloseTo(evaluate(e, { a: 3, t: 7, b: 1, u }));
    }
  });
  it('folds several expressions at once, and leaves them be if folding fails', () => {
    const shared = parseExpr('sqrt(a^2 + t)');
    const es = [
      { kind: 'bin', op: '*', a: shared, b: parseExpr('cos(u)') },
      { kind: 'bin', op: '*', a: shared, b: parseExpr('sin(u)') },
    ] as const;
    const folded = foldAllExcept(es, 'u', { a: 3, t: 7 });
    expect(folded.map(e => evaluate(e, { u: 0 }))).toEqual([4, 0]);
    // Folding runs outside the per-sample guard: a throw there keeps the input.
    const hostile = { a: 3 } as Record<string, number>;
    Object.defineProperty(hostile, 't', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(foldAllExcept(es, 'u', hostile)).toBe(es);
  });
  it('leaves a sum over a name the frame also binds alone', () => {
    // n is a slider and the sum's own variable: the sum must still bind it.
    const e = parseExpr('sum(n=1..3, n u)');
    expect(evaluate(foldAllExcept([e], 'u', { n: 100 })[0], { u: 2 })).toBe(12);
  });
});

describe('pathSampler folding', () => {
  it('samples a large curve whose bulk does not move with u as it would unfolded', () => {
    // An osculating circle's size: its centre is ~2k nodes in t alone.
    let centre = parseExpr('cos(t) + a');
    for (let k = 0; k < 9; k++) centre = { kind: 'bin', op: '+', a: centre, b: centre };
    const comps = [
      { kind: 'bin', op: '+', a: centre, b: parseExpr('cos(2pi u)') },
      { kind: 'bin', op: '+', a: centre, b: parseExpr('sin(2pi u)') },
    ] as const;
    expect(countNodes(comps[0])).toBeGreaterThan(500);
    const env = { a: 0.25, t: 1.5 };
    const pts = pathSampler(comps).sample(env);
    const c = 512 * (Math.cos(1.5) + 0.25);
    expect(pts[0]).toBeCloseTo(c + 1, 9);
    expect(pts[1]).toBeCloseTo(c, 9);
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
