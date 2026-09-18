/**
 * Tier-1 performance guards: deterministic, count/size-based invariants.
 * These fail exactly and only when a change alters compile *structure* —
 * no wall-clock, so they are CI-stable.
 *
 * Budgets are pinned at ~2.5x the measured value at introduction. If a test
 * fails, either a regression slipped in (fix it) or a feature legitimately
 * grew the output (raise the budget in the same PR, on purpose, in review).
 * Run with PERF_MEASURE=1 to print current actuals for re-pinning.
 */
import { describe, expect, test } from 'vitest';
import { CORPUS, SUM_CASE, compileRows, countNodes } from './perfcase.ts';
import { parseExpr } from './expr.ts';
import { diff } from './diff.ts';
import { ENUM_STATS, JOINT_MAX, QUANTILE_STATS, RVSystem, buildRVSystem, scanRandomRows, markerHeight, toProbability } from './dist.ts';
import { toGLSL } from './glsl.ts';

const MEASURE = !!process.env.PERF_MEASURE;

describe('uniform parameterization (slider moves must not change compiled output)', () => {
  // The renderer caches shader programs by source; slider drags recompile
  // rows on every input event. That is only cheap because constants compile
  // to u_<name> uniforms, making the GLSL byte-identical across values.
  // A feature that bakes constant *values* into plot output turns every
  // slider tick into a shader compile — the class of regression this pins.
  for (const item of CORPUS) {
    test(item.name, () => {
      const a = compileRows(item.rows(1.25));
      const b = compileRows(item.rows(2.5));
      expect(a.errors).toEqual([]);
      expect(JSON.stringify(a.classified)).toBe(JSON.stringify(b.classified));
      expect(JSON.stringify(a.gridFields.map(g => ({ ...g, expr: null, grad: null }))))
        .toBe(JSON.stringify(b.gridFields.map(g => ({ ...g, expr: null, grad: null }))));
    });
  }
});

describe('Σ/Π is the documented exception to uniform parameterization', () => {
  // Sums expand at compile time, so the bound constant's value is baked into
  // the GLSL: every step of an N slider is a new shader source and therefore
  // a real compile. This is inherent to symbolic expansion, not a bug — but
  // it is the one place the invariant above does not hold, so pin it. If
  // someone later teaches sums to compile against a uniform, this test fails
  // and should be deleted, and a CORPUS entry added instead.
  test('output changes with the bound constant', () => {
    const a = JSON.stringify(compileRows(SUM_CASE(3)).classified);
    const b = JSON.stringify(compileRows(SUM_CASE(4)).classified);
    expect(a).not.toBe(b);
  });

  test('expansion stays linear in N and bounded', () => {
    const size = (n: number) => JSON.stringify(compileRows(SUM_CASE(n)).classified).length;
    const s10 = size(10);
    const s40 = size(40);
    if (MEASURE) console.log(`sum N=10: ${s10}  N=40: ${s40}  ratio ${(s40 / s10).toFixed(2)}`);
    // Linear growth (~4x for 4x the terms); a superlinear regression here
    // would mean expansion is duplicating work per term.
    expect(s40 / s10).toBeLessThan(6);
    // SUM_MAX_TERMS keeps a single sum bounded however far the slider goes.
    expect(() => compileRows(SUM_CASE(100000))).toThrow(/limit/);
  });
});

describe('compiled size budgets', () => {
  // GLSL source length per corpus case: catches codegen blowup (e.g. an
  // expansion pass or a pow-unrolling change exploding shader size, which
  // shows up as shader-compile hitches at runtime).
  // ~2.5x the measured length at introduction (2026-07); CPU-path plots
  // (point, pcurve) carry Exprs not GLSL, hence the small floors.
  const GLSL_BUDGET: Record<string, number> = {
    scalar2d: 130,
    implicit2d: 110,
    ineq2d: 70,
    complex2d: 160,
    pcurve3d: 50,
    psurface: 160,
    implicit3d: 380,
    point: 50,
    derivative: 210,
    userfn: 280,
    polarfield: 400,
    vfield2d: 80,
    ode2d: 70,
    domain2d: 240,
    conformal2d: 160,
    fractal2d: 170,
    // Sequence/list rows carry Exprs (CPU-evaluated), so only their labels
    // and the cobweb/bifurcation fields are GLSL — small floors again.
    sequence: 25,
    'seq-isprime': 25,
    'seq-sum-term': 25,
    cobweb: 110,
    'cobweb-seed': 100,
    bifurcation: 95,
    vlist: 15,
    plist: 15,
    plist3d: 15,
    piecewise: 240,
    'piecewise-default': 130,
    gcd2d: 140,
    // System rows carry residual Exprs only — no GLSL at all.
    system2d: 15,
    system3d: 15,
    // The plot row is ordinary scalar GLSL over the u_a uniform; the state's
    // own deriv/init are CPU-side Exprs and contribute nothing.
    state: 85,
  };

  const glslOf = (rows: string[]): string => {
    const { classified, gridFields } = compileRows(rows);
    const parts: string[] = [];
    for (const c of classified) {
      // Collect every string field of the plot — they are all GLSL or labels.
      for (const v of Object.values(c.plot)) {
        if (typeof v === 'string') parts.push(v);
        if (Array.isArray(v)) for (const s of v) if (typeof s === 'string') parts.push(s);
      }
    }
    for (const g of gridFields) {
      parts.push(g.glsl, ...(g.gradGlsl ?? []));
    }
    return parts.join('\n');
  };

  for (const item of CORPUS) {
    test(item.name, () => {
      const len = glslOf(item.rows(2)).length;
      if (MEASURE) console.log(`glsl ${item.name}: ${len}`);
      expect(len).toBeLessThanOrEqual(GLSL_BUDGET[item.name]);
    });
  }
});

describe('symbolic derivative swell budgets', () => {
  // diff() output is compiled into shaders (gradients, d/dx rows). Symbolic
  // swell here multiplies into every downstream compile.
  const CASES: { name: string; src: string; order: number; budget: number }[] = [
    { name: 'product chain', src: 'sin(x) cos(x) e^x', order: 3, budget: 550 },
    { name: 'power tower', src: 'sin(x)^8', order: 2, budget: 70 },
    { name: 'quotient', src: '(x^2 + 1)/(x^3 - x + 2)', order: 2, budget: 280 },
    { name: 'nested trig', src: 'sin(cos(tan(x)))', order: 2, budget: 190 },
  ];
  for (const c of CASES) {
    test(c.name, () => {
      let e = parseExpr(c.src);
      for (let k = 0; k < c.order; k++) e = diff(e, 'x');
      const n = countNodes(e);
      const len = toGLSL(e).length;
      if (MEASURE) console.log(`diff ${c.name}: nodes=${n} glsl=${len}`);
      expect(n).toBeLessThanOrEqual(c.budget);
    });
  }
});

describe('distribution quantile tables (the per-frame CPU path of a derived density)', () => {
  // A base column is SAMPLE_COUNT quantile calls, redrawn every frame while a
  // sampled density is on screen (RVSystem.resample). Gamma, Beta and StudentT
  // have no closed-form quantile, so they read a table built by inverting the
  // cdf — ~600 safeguarded Newton solves, each an incomplete gamma/beta
  // evaluation. That build must happen once per SHAPE, never per frame and
  // never per rate/scale slider tick; a regression here is a frozen UI.
  const system = (rows: string[]) => {
    const sys = new RVSystem();
    buildRVSystem(sys, scanRandomRows(rows), {
      fnNames: new Set(), getFn: () => undefined, constNames: new Set(['b']), taken: () => false,
    });
    return sys;
  };

  test('one build per shape: resampling and rate sliders reuse it', () => {
    const sys = system(['X ~ Gamma(2.125, b)', 'Y ~ ChiSquared(4.25)', 'W = X + Y']);
    const before = { ...QUANTILE_STATS };
    for (let frame = 0; frame < 5; frame++) {
      sys.resample(frame + 1);
      sys.columns('W', { b: 1 + frame });
    }
    sys.resample(0);
    // Gamma(2.125, b) and ChiSquared(4.25) = Gamma(2.125, ½) share ONE table.
    expect(QUANTILE_STATS.builds - before.builds).toBe(1);
    const evals = QUANTILE_STATS.cdfEvals - before.cdfEvals;
    if (MEASURE) console.log(`gamma table: ${evals} cdf evaluations`);
    expect(evals).toBeLessThan(4500);
  });

  test('table builds stay bounded across the hard shapes', () => {
    // Poles, power tails and near-normal bulks, each a fresh table.
    for (const decl of ['Gamma(0.0625, 1)', 'Gamma(4321, 1)', 'Beta(0.0625, 0.375)', 'Beta(321, 123)', 'StudentT(0.4375)', 'StudentT(54321)']) {
      const before = QUANTILE_STATS.cdfEvals;
      system([`X ~ ${decl}`]).columns('X', {});
      const evals = QUANTILE_STATS.cdfEvals - before;
      if (MEASURE) console.log(`${decl}: ${evals} cdf evaluations`);
      expect(evals, decl).toBeLessThan(6200);
    }
  });
});

describe('derived discrete variables (enumeration per parameter change, never per frame)', () => {
  // `S = X Y` over discrete bases is exact by enumerating the joint of the
  // bases: thousands of evaluations, fine once per slider tick and a frozen UI
  // per frame. The app redraws stems, the E(…) marker and P(…) selections every
  // frame and calls resample() every frame; none of that may re-enumerate.
  const system = (rows: string[]) => {
    const sys = new RVSystem();
    buildRVSystem(sys, scanRandomRows(rows), {
      fnNames: new Set(), getFn: () => undefined, constNames: new Set(['a']), taken: () => false,
    });
    return sys;
  };
  const bounds = (body: string) => toProbability(parseExpr(body), new Set(['S'])).single!;

  test('a still or panning view, a P(…) row, a marker and a resample reuse one enumeration', () => {
    const sys = system(['X ~ Poisson(a)', 'Y ~ Binomial(40, 0.5)', 'S = X Y']);
    sys.pmfRuns('S', { a: 30 }, { lo: 0, hi: 50 });
    const before = { ...ENUM_STATS };
    for (let frame = 0; frame < 20; frame++) {
      sys.resample(frame + 1);
      sys.pmfRuns('S', { a: 30 }, { lo: frame, hi: 50 + frame });
      sys.pmfRuns('S', { a: 30 }, { lo: frame, hi: 50 + frame }, bounds('S <= 600'));
      sys.moments('S', { a: 30 });
      markerHeight(sys, 'S', { a: 30 });
      sys.eventProbability(parseExpr('S <= 600'), { rv: 'S', ...bounds('S <= 600') }, { a: 30 });
    }
    sys.resample(0);
    expect(ENUM_STATS).toEqual(before);
    // A slider tick re-enumerates once: X's support, then one product.
    sys.pmfRuns('S', { a: 31 }, { lo: 0, hi: 50 });
    sys.pmfRuns('S', { a: 31 }, { lo: 0, hi: 60 });
    expect(ENUM_STATS.builds - before.builds).toBe(1);
    const points = ENUM_STATS.points - before.points;
    if (MEASURE) console.log(`X Y enumeration: ${points} joint points`);
    expect(points).toBeLessThan(8000);
  });

  test('no step passes JOINT_MAX, and a sampled base tabulates its quantile once per parameter value', () => {
    const sys = system(['X ~ Poisson(a)', 'Y ~ Poisson(a)', 'Z ~ Poisson(a)', 'S = X Y + Z']);
    for (const a of [3, 30, 300, 3000]) {
      const before = ENUM_STATS.points;
      sys.pmfRuns('S', { a });
      expect(ENUM_STATS.points - before, `a = ${a}`).toBeLessThanOrEqual(2 * JOINT_MAX);
    }
    expect(sys.pmfOf('S', { a: 3000 })!.exact).toBe(false);
    const before = { ...ENUM_STATS };
    for (let frame = 0; frame < 5; frame++) {
      sys.resample(frame + 1);
      sys.pmfRuns('S', { a: 3000 });
    }
    sys.resample(0);
    expect(ENUM_STATS).toEqual(before); // the columns were re-read; nothing was re-tabulated
  });
});
