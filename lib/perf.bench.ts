/**
 * Micro-benchmarks for the hot lib paths: `pnpm bench`.
 *
 * No pass/fail — use these locally (quiet machine, plugged in) to compare
 * before/after when touching the parser, CAS, or codegen. The enforced
 * guards live in perf-guards.test.ts (structural) and perf-smoke.test.ts
 * (order-of-magnitude wall clock).
 */
import { describe, test } from 'vitest';
import { CORPUS, compileRows } from './perfcase.ts';
import { evaluate, parseExpr } from './expr.ts';
import { diff } from './diff.ts';
import { toGLSL } from './glsl.ts';

describe('compile pipeline', () => {
  for (const item of CORPUS) {
    test(item.name, async ({ bench }) => {
      await bench(item.name, () => {
        compileRows(item.rows(2));
      }).run();
    });
  }
});

describe('parse', () => {
  const SRC = 'y = sin(2pi x) e^(-x^2/4) + x^3/(x^2 + 1) - cos(x/2)^3';
  test('medium expression', async ({ bench }) => {
    await bench('medium expression', () => {
      parseExpr(SRC.slice(4));
    }).run();
  });
});

describe('evaluate', () => {
  const e = parseExpr('cos(2pi u) + cos(7 pi u)/3');
  const env: Record<string, number> = { u: 0 };
  test('pcurve component, 1537 samples', async ({ bench }) => {
    await bench('pcurve component, 1537 samples', () => {
      for (let i = 0; i <= 1537; i++) {
        env.u = i / 1537;
        evaluate(e, env);
      }
    }).run();
  });
});

describe('symbolic', () => {
  const e = parseExpr('sin(x) cos(x) e^x + x^5/(x^2 + 1)');
  test('diff^3', async ({ bench }) => {
    await bench('diff^3', () => {
      let d = e;
      for (let k = 0; k < 3; k++) d = diff(d, 'x');
    }).run();
  });
  const d3 = (() => {
    let d = e;
    for (let k = 0; k < 3; k++) d = diff(d, 'x');
    return d;
  })();
  test('toGLSL of diff^3', async ({ bench }) => {
    await bench('toGLSL of diff^3', () => {
      toGLSL(d3);
    }).run();
  });
});
