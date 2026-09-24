/**
 * Tier-2 performance smoke tests: wall-clock budgets with ~10-20x headroom.
 * These only trip on order-of-magnitude regressions (an accidental O(n^2),
 * an unbounded loop), not on machine noise. For precise numbers use
 * `pnpm bench` (lib/perf.bench.ts) on a quiet machine.
 *
 * Budget rationale: each case's measured time on a 2024 laptop is <10% of
 * its budget. If one of these fails in CI, something is catastrophically
 * slower — treat it as a real regression, not flake, until proven otherwise.
 */
import { describe, expect, test } from 'vitest';
import { CORPUS, compileRows } from './perfcase.ts';
import { evaluate, parseExpr } from './expr.ts';
import { diff } from './diff.ts';
import { traceSystem } from './solve.ts';
import { classify } from './plot.ts';
import { compileCpu } from './compiler.ts';
import { buildGridField } from './grid.ts';

const timed = (fn: () => void): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe('compile pipeline', () => {
  test('full corpus x50 (keystroke path) under 2s', () => {
    const ms = timed(() => {
      for (let i = 0; i < 50; i++) for (const item of CORPUS) compileRows(item.rows(i + 1));
    });
    expect(ms).toBeLessThan(2000);
  });
});

describe('CPU sampling (per-frame path)', () => {
  test('parametric curve at render resolution x20 frames under 1s', () => {
    // web/main.ts samples pcurves at ~1537 points per component per frame.
    const comps = ['cos(2pi u) + cos(7 pi u)/3', 'sin(2pi u) + sin(7 pi u)/3'].map(s => parseExpr(s));
    const env: Record<string, number> = { u: 0 };
    const ms = timed(() => {
      for (let frame = 0; frame < 20; frame++) {
        for (let i = 0; i <= 1537; i++) {
          env.u = i / 1537;
          for (const c of comps) evaluate(c, env);
        }
      }
    });
    expect(ms).toBeLessThan(1000);
  });
});

describe('symbolic paths', () => {
  test('third derivatives x100 under 1s', () => {
    const e = parseExpr('sin(x) cos(x) e^x + x^5/(x^2 + 1)');
    const ms = timed(() => {
      for (let i = 0; i < 100; i++) {
        let d = e;
        for (let k = 0; k < 3; k++) d = diff(d, 'x');
      }
    });
    expect(ms).toBeLessThan(1000);
  });

  test('grid field build (polar) x200 under 1s', () => {
    const r = parseExpr('sqrt(x^2 + y^2)');
    const th = parseExpr('atan(y, x)');
    const none = new Set<string>();
    const ms = timed(() => {
      for (let i = 0; i < 200; i++) {
        buildGridField('r', r, none);
        buildGridField('theta', th, none);
      }
    });
    expect(ms).toBeLessThan(1000);
  });
});

test('polar continuation stays within a 1s smoke budget', () => {
  const fields = { r: parseExpr('sqrt(x^2+y^2)'), theta: parseExpr('atan2(y,x)') };
  const p = compileCpu(classify(parseExpr('(r, theta) = (3u, 6pi u)'), new Set(), fields));
  if (p.type !== 'system') throw new Error('expected system');
  const ms = timed(() => {
    const paths = traceSystem(p.residuals, ['x', 'y'], [-4, -4], [4, 4], {}, 256, p.angular);
    expect(paths.some(p => p.length > 250)).toBe(true);
  });
  expect(ms).toBeLessThan(1000);
});
