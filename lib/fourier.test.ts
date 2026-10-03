import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { parseCsv } from './csv.ts';
import { evaluate } from './expr.ts';
import { realFourier, reconstructSeries } from './fourier.ts';
import { runtimeSliderNames } from './runtime-sliders.ts';
import { shaderKey } from './compiler.ts';
import { diff } from './diff.ts';
import { compileProg, run } from './vm.ts';
import { GLSL_PRELUDE, shaderTables, toGLSL, withHelpers } from './glsl.ts';

describe('real Fourier coefficients', () => {
  it.each([8, 15, 31, 256])('recovers mean, amplitudes and phase with %i samples', n => {
    const xs = Float64Array.from(
      { length: n },
      (_, j) => 3 + 2 * Math.cos((4 * Math.PI * j) / n) - 4 * Math.sin((6 * Math.PI * j) / n),
    );
    const c = realFourier(xs);
    expect(c.cosine[0]).toBeCloseTo(3, 11);
    expect(c.cosine[2]).toBeCloseTo(2, 11);
    expect(c.sine[3]).toBeCloseTo(-4, 11);
    for (let k = 1; k < c.cosine.length; k++) {
      if (k !== 2) expect(c.cosine[k]).toBe(0);
      if (k !== 3) expect(c.sine[k]).toBe(0);
    }
  });
  it('counts the even Nyquist component once, and retains the odd final bin phase', () => {
    expect([...realFourier(Float64Array.of(2, -2, 2, -2)).cosine]).toEqual([0, 0, 2]);
    const odd = realFourier(Float64Array.from({ length: 9 }, (_, j) => 2 * Math.sin((8 * Math.PI * j) / 9)));
    expect(odd.sine[4]).toBeCloseTo(2, 11);
  });
  it.each([2, 3, 7, 8, 97, 256])('interpolates arbitrary %i-sample signals, including a shifted interval', n => {
    const xs = Float64Array.from({ length: n }, (_, j) => Math.sin((j * j) / 7) + (j % 3) - 2);
    const curve = reconstructSeries(realFourier(xs), Math.floor(n / 2), -3, 7);
    for (let j = 0; j < n; j++) expect(evaluate(curve, { x: -3 + (7 * j) / n })).toBeCloseTo(xs[j], 9);
  });
  it('preserves tiny signals rather than applying an absolute noise threshold', () => {
    const c = realFourier(Float64Array.from({ length: 16 }, (_, j) => 1e-16 * Math.sin((2 * Math.PI * j) / 16)));
    expect(c.sine[1] / 1e-16).toBeCloseTo(1, 11);
  });
  it('refuses missing/nonfinite samples and unbounded workloads', () => {
    for (const xs of [
      Float64Array.of(1, NaN),
      Float64Array.of(1, Infinity),
      new Float64Array(1),
      new Float64Array(4097),
    ]) {
      expect(() => realFourier(xs)).toThrow();
    }
  });
});

function spectrum(rows: string[]) {
  const a = analyzeRows(rows);
  const row = a.rows.at(-1)!;
  expect(row.error).toBeUndefined();
  const o = row.cls!.object;
  if (o.kind !== 'list' || o.element !== 'point' || o.storage !== 'expressions') throw new Error(o.kind);
  return o.values.map(p => p.map(c => evaluate(c, a.constEnv)));
}
function approximation(rows: string[]) {
  const a = analyzeRows(rows);
  const row = a.rows.at(-1)!;
  expect(row.error).toBeUndefined();
  const o = row.cls!.object;
  if (o.kind !== 'curve' || o.form !== 'graph') throw new Error(o.kind);
  return (x: number, y: number) => evaluate(o.rhs, { ...a.constEnv, x }) - y;
}

describe('Fourier through document analysis and both backends', () => {
  it('reads a signal over its interval, and reports cycles per unit of it', () => {
    const s = spectrum(['f(s) = -3 + 2cos(pi s) + 4sin(2pi s)', 'fourier(f(interval(-1, 1)), 16)']);
    expect(s[0]).toEqual([0, 3]);
    expect(s[1][0]).toBe(0.5);
    expect(s[1][1]).toBeCloseTo(2, 10);
    expect(s[2][1]).toBeCloseTo(4, 10);
  });
  it('accepts inline and named intervals, values built on them, and explicitly ordered samples', () => {
    for (const rows of [
      ['fourier(sin(2pi interval(0, 1)))'],
      ['s = interval(0, 1)', 'fourier(sin(2pi s))'],
      ['s = interval(0, 1)', 'signal = sin(2pi s)', 'fourier(signal)'],
      ['fourier((0, 1, 0, -1))'],
      ['S = (0, 1, 0, -1)', 'fourier(S)'],
    ])
      expect(spectrum(rows)[1]).toEqual([1, 1]);
  });
  it('keeps the signed mean and phase in a reconstruction', () => {
    const at = approximation(['f(s) = -3 + 2cos(pi s) + 4sin(2pi s)', 'y = reconstruct(f(interval(-1, 1)), 2, 16)']);
    for (const x of [-1, -0.7, 0, 0.3, 1, 3])
      expect(at(x, -3 + 2 * Math.cos(Math.PI * x) + 4 * Math.sin(2 * Math.PI * x))).toBeCloseTo(0, 10);
    const dc = approximation(['y = reconstruct(-3 + sin(2pi interval(0, 1)), 0)']);
    expect(dc(0.2, -3)).toBeCloseTo(0, 10);
  });
  it('scales the finished approximation when a user function is called at another argument', () => {
    const at = approximation(['f(s) = cos(2pi s)', 'g(x) = reconstruct(f(interval(0, 1)), 1)', 'y = g(2x)']);
    expect(at(0.125, 0)).toBeCloseTo(0, 10);
    expect(at(0.25, -1)).toBeCloseTo(0, 10);
  });
  it('selects harmonics with a slider and tracks all coefficient/bound dependencies', () => {
    const rows = ['a = 2', 'b = 1', 'N = 1', 's = interval(0, b)', 'y = reconstruct(a cos(2pi s) + sin(4pi s), N)'];
    const a = analyzeRows(rows);
    expect([...a.document.sumBoundConsts]).toContain('N');
    const runtime = runtimeSliderNames(a);
    for (const name of ['a', 'b', 'N']) expect(runtime.has(name)).toBe(false);
    const first = approximation(rows);
    expect(first(0.125, Math.SQRT2)).toBeCloseTo(0, 10);
    const second = approximation(rows.map(r => (r === 'N = 1' ? 'N = 2' : r)));
    expect(second(0.125, Math.SQRT2 + 1)).toBeCloseTo(0, 10);
  });
  it('keeps a bounded harmonic count live with identical shaders across the whole range', () => {
    const rows = ['N = clamp(round(5), 0, 48)', 'f(s) = sign(sin(2pi s))', 'y = reconstruct(f(interval(0, 1)), N)'];
    const a = analyzeRows(rows);
    const row = a.rows.at(-1)!;
    expect(row.error).toBeUndefined();
    expect(runtimeSliderNames(a).has('N')).toBe(true);
    expect(a.document.structuralConsts.has('N')).toBe(false);
    expect(a.document.sumBoundConsts.has('N')).toBe(true);
    const o = row.cls!.object;
    if (o.kind !== 'curve' || o.form !== 'graph') throw new Error(o.kind);
    const program = compileProg(
      o.rhs,
      new Map([
        ['x', 0],
        ['N', 1],
      ]),
    );
    const stack = new Float64Array(program.depth);
    const derivative = diff(o.rhs, 'x');
    const xs = Float64Array.from({ length: 256 }, (_, j) => Math.sign(Math.sin((2 * Math.PI * j) / 256)));
    const coefficients = realFourier(xs);
    for (const N of [0, 1, 2, 5, 24, 47, 48]) {
      const rebuilt = analyzeRows(rows.map(r => (r.startsWith('N =') ? `N = clamp(round(${N}), 0, 48)` : r)));
      expect(shaderKey(rebuilt.rows.at(-1)!.gpu!)).toBe(shaderKey(row.gpu!));
      const expected = reconstructSeries(coefficients, N, 0, 1);
      const expectedDerivative = diff(expected, 'x');
      for (const x of [-0.1, 0, 0.125, 0.5, 0.9, 1.1]) {
        const env = { x, N };
        expect(evaluate(o.rhs, env)).toBeCloseTo(evaluate(expected, env), 10);
        expect(run(program, [x, N], stack)).toBeCloseTo(evaluate(expected, env), 10);
        expect(evaluate(derivative, env)).toBeCloseTo(evaluate(expectedDerivative, env), 8);
      }
    }
  });
  it('still recompiles coefficient and interval inputs when the count is live', () => {
    const a = analyzeRows([
      'a = 2',
      'b = 1',
      'N = clamp(round(1), 0, 8)',
      's = interval(0, b)',
      'y = reconstruct(a cos(2pi s), N)',
    ]);
    const live = runtimeSliderNames(a);
    expect(live.has('N')).toBe(true);
    expect(live.has('a')).toBe(false);
    expect(live.has('b')).toBe(false);
    expect(
      runtimeSliderNames(
        analyzeRows(['N = clamp(round(1), 0, 8)', 'y = reconstruct(N cos(2pi interval(0, 1)), N)']),
      ).has('N'),
    ).toBe(false);
  });
  it('emits one compact value/slope loop with coefficients outside its source', () => {
    const a = analyzeRows(['N = clamp(round(5), 0, 48)', 'y = reconstruct(sign(sin(2pi interval(0, 1))), N)']);
    const gpu = a.rows[1].gpu!;
    if (gpu.type !== 'implicit2d') throw new Error(gpu.type);
    expect(gpu.graphEval?.slopeScale).toBe(1);
    const source = withHelpers(`${GLSL_PRELUDE}\n${gpu.field}`);
    expect(source).toContain('for (int j = 0;');
    expect(source).toContain('uniform vec4');
    expect(source.length - GLSL_PRELUDE.length).toBeLessThan(1000);
    const tables = shaderTables(source);
    expect(tables).toHaveLength(1);
    expect(tables[0].values.length).toBe(48 * 4);
    const coefficients = realFourier(
      Float64Array.from({ length: 256 }, (_, j) => Math.sign(Math.sin((2 * Math.PI * j) / 256))),
    );
    for (let k = 1; k <= 48; k++) {
      expect([...tables[0].values.subarray(4 * (k - 1), 4 * k)]).toEqual([
        k,
        Math.fround(2 * Math.PI * k),
        Math.fround(coefficients.cosine[k]),
        Math.fround(coefficients.sine[k]),
      ]);
    }
    const fallback = withHelpers(`${GLSL_PRELUDE}\n${gpu.field}`, 0);
    expect(fallback).toContain('const vec4');
    expect(fallback).not.toContain('uniform vec4');
  });
  it('includes coefficient values in helper identity and deduplicates table references', () => {
    const count = { kind: 'var', name: 'N' } as const;
    const coefficients = { cosine: Float64Array.of(3, 1, 2, 3, 4), sine: new Float64Array(5) };
    const first = toGLSL(reconstructSeries(coefficients, 4, 0, 1, count));
    const changed = toGLSL(
      reconstructSeries({ ...coefficients, cosine: Float64Array.of(3, 2, 2, 3, 4) }, 4, 0, 1, count),
    );
    expect(changed).not.toBe(first);
    expect(toGLSL(reconstructSeries(coefficients, 4, 0, 1, count))).toBe(first);
    expect(shaderTables(withHelpers(`${GLSL_PRELUDE}\n${first} + ${first}`))).toHaveLength(1);
  });
  it('uses analytic graph slopes only for complete affine Fourier graphs', () => {
    const rows = ['N = clamp(round(5), 0, 48)', 'f(s) = sign(sin(2pi s))', 'g(x) = reconstruct(f(interval(0, 1)), N)'];
    for (const [call, scale] of [
      ['g(2x + 0.3)', 2],
      ['g(-x)', -1],
    ] as const) {
      const row = analyzeRows([...rows, `y = ${call}`]).rows.at(-1)!;
      expect(row.error).toBeUndefined();
      const gpu = row.gpu!;
      if (gpu.type !== 'implicit2d') throw new Error(gpu.type);
      expect(gpu.graphEval?.slopeScale).toBe(scale);
    }
    for (const call of ['g(1/x)', 'g(floor(x))', '1/g(x)']) {
      const row = analyzeRows([...rows, `y = ${call}`]).rows.at(-1)!;
      expect(row.error).toBeUndefined();
      const gpu = row.gpu!;
      if (gpu.type !== 'implicit2d') throw new Error(gpu.type);
      expect(gpu.field).toContain('eq_loop_');
      expect(gpu.graphEval).toBeUndefined();
    }
  });
  it('keeps unsafe slider ranges structural so invalid values remain errors', () => {
    for (const declaration of [
      'N = 1',
      'N = clamp(round(1), -1, 48)',
      'N = clamp(round(1), 0, 129)',
      'N = clamp(round(0), 0, 0)',
    ]) {
      expect(
        runtimeSliderNames(analyzeRows([declaration, 'y = reconstruct(cos(2pi interval(0, 1)), N)'])).has('N'),
        declaration,
      ).toBe(false);
    }
    const rows = ['N = clamp(round(1), 0, 48)', 'y = reconstruct((0, 1, 0, -1), N)'];
    expect(runtimeSliderNames(analyzeRows(rows)).has('N')).toBe(false);
    expect(analyzeRows(['N = clamp(round(3), 0, 48)', rows[1]]).rows.at(-1)?.error).toMatch(/only 2 harmonics/);
    expect(
      analyzeRows(['N = clamp(1.5, 0, 48)', 'y = reconstruct(cos(2pi interval(0, 1)), N)']).rows.at(-1)?.error,
    ).toMatch(/whole number/);
  });
  it('recognizes rounding outside the clamp and treats range endpoints as structural', () => {
    const a = analyzeRows([
      'limit = 8',
      'N = round(clamp(1, 0, limit))',
      'y = reconstruct(cos(2pi interval(0, 1)), N)',
    ]);
    expect(runtimeSliderNames(a).has('N')).toBe(true);
    expect(runtimeSliderNames(a).has('limit')).toBe(false);
  });
  it('works with named spectra and stem geometry', () => {
    const a = analyzeRows(['S = fourier(sin(2pi interval(0, 1)), 8)', 'segment((S.x, 0), S)']);
    expect(a.rows.map(r => r.error)).toEqual([undefined, undefined]);
    expect(a.rows[1].cls?.object.kind).toBe('family');
  });
  it('reads CSV values in explicit row order and preserves missing-file semantics', () => {
    const rows = ['data = open("signal.csv", abc123abcdef)', 'S = sort(data.signal, data.row)', 'fourier(S)'];
    const a = analyzeRows(rows, { tables: () => parseCsv('signal\n0\n1\n0\n-1\n0') });
    expect(a.rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    const missing = analyzeRows(rows);
    expect(missing.rows.at(-1)?.dataLocal).toBeDefined();
    expect(missing.rows.at(-1)?.error).toBeUndefined();
    const gap = analyzeRows(rows, { tables: () => parseCsv('signal\n0\n1\n""\n-1\n0') });
    expect(gap.rows.at(-1)?.error).toMatch(/missing values cannot be skipped/);
    const reconstruction = analyzeRows([...rows.slice(0, 2), 'y = reconstruct(S, 2)'], {
      tables: () => parseCsv('signal\n0\n1\n0\n-1\n0'),
    });
    expect(reconstruction.rows.at(-1)?.error).toBeUndefined();
  });
  it('refuses a function parameter as a static coefficient even if a global shares its name', () => {
    const a = analyzeRows(['a = 2', 'g(a) = reconstruct(a cos(2pi interval(0, 1)), 1)', 'y = g(3)']);
    expect(a.rows[1].error).toMatch(/no static value/);
  });
  it.each([
    ['fourier([0, 1, 0, -1])', /order/],
    ['fourier(sin(interval(1, 0)))', /needs a < b/],
    ['fourier(sin(interval(0, 1)), 1)', /sample count/],
    ['fourier(sin(interval(0, 1)), 2.5)', /whole number/],
    ['fourier(sin(interval(0, 1)), 4097)', /sample count/],
    ['fourier(sin(interval(0, 1) + t))', /static/],
    ['fourier(interval(0, 1) + y)', /not y/],
    ['fourier(interval(0, 1) i)', /real signal/],
    ['fourier(1/interval(0, 1))', /finite real samples/],
    ['fourier((0, 1, 0, -1), 4)', /its own count/],
    ['fourier(sin(2pi x))', /read over an interval, which sets its period/],
    ['fourier(interval(0, 1) + interval(0, 1))', /one interval; this one has 2/],
    ['fourier(sin(interval(0, 1)), interval(0, 2))', /own interval sets its period/],
    ['y = reconstruct(sin(interval(0, 1)), -1)', /harmonics/],
    ['y = reconstruct(sin(interval(0, 1)), 1.5)', /harmonics/],
    ['y = reconstruct(sin(interval(0, 1)), 129)', /harmonics/],
    ['y = reconstruct((0, 1, 0, -1), 3)', /only 2 harmonics/],
    ['fourier()', /Incomplete expression/],
    ['reconstruct(sin(x))', /Use reconstruct/],
  ])('reports an actionable error for %s', (text, pattern) => {
    expect(analyzeRows([text]).rows[0].error).toMatch(pattern);
  });
  it('reads a real signal reached through complex values as its real part', () => {
    expect(spectrum(['s = interval(0, 1)', 'fourier(re(e^(2pi i s)))'])[1]).toEqual([1, 1]);
    const named = spectrum(['a = 3 + 4i', 's = interval(0, 1)', 'fourier(|a| sin(2pi s))']);
    expect(named[1][1]).toBeCloseTo(5, 10);
    expect(analyzeRows(['s = interval(0, 1)', 'fourier(e^(2pi i s))']).rows[1].error).toMatch(/real signal/);
  });
  it('names the interval a function is read over, rather than binding x behind it', () => {
    expect(analyzeRows(['f(s) = cos(4pi s)', 'fourier(f)']).rows[1].error).toBe(
      'fourier reads a signal over an interval, which sets its period: fourier(f(interval(0, 1))).',
    );
  });
  it('spreads a tuple of samples over the interval given after it', () => {
    const xs = [2, -3, 1, 5, -4, 0, 3, -1, 2];
    const at = approximation([`y = reconstruct((${xs.join(', ')}), 4, interval(-3, 4))`]);
    xs.forEach((v, j) => expect(at(-3 + (7 * j) / xs.length, v)).toBeCloseTo(0, 9));
  });
  it('preserves documents that define their own function or value with the new names', () => {
    const a = analyzeRows(['fourier(x) = x^2', 'reconstruct = 3', 'y = fourier(x) + reconstruct(x + 1)']);
    expect(a.rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
  });
});
