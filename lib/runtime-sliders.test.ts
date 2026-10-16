import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { evaluate } from './expr.ts';
import { runtimeSliderNames } from './runtime-sliders.ts';

const names = (rows: string[]) => [...runtimeSliderNames(analyzeRows(rows))].sort();

describe('runtime-only sliders', () => {
  it('keeps scalar uniforms and figure transforms live without recompilation', () => {
    expect(
      names([
        's=.24',
        'R=3',
        'P=[(0,0,0),(1,0,0),(0,1,0),(0,0,1)]',
        'a=pi[1..3]/4',
        'rotate(s hull(P),a,(0,1,0))+(R,0,0)',
      ]),
    ).toEqual(['R', 's']);
    expect(names(['a=1', 'y=sin(a x)', 'a+2'])).toEqual(['a']);
  });

  it('recompiles static plot inputs, including fractional range steps and camera values', () => {
    for (const plot of ['[0,a..2]', '[0..a]', 'sum(k=1..a,k x)', 'camera(a,0.5,8)']) {
      expect(names(['a=1', plot]), plot).toEqual([]);
    }
    expect(names(['a=1', 'L=[1,2,3]', 'L[a]'])).toEqual([]);
    expect(names(['a=1', 'view(x=-a..a)'])).toEqual([]);
  });

  it('recompiles values referenced by definitions even if lowering consumed the reference', () => {
    for (const definition of ['b=2a', 'L=[0,a..2]', 'f(x)=a x', 'M=((a,0),(0,a))']) {
      expect(names(['a=1', definition]), definition).toEqual([]);
    }
    expect(names(['a=1', 'b=2a', '[0..b]'])).toEqual([]);
  });

  it('leaves diagnostics, distributions and state initialization on the compiler path', () => {
    expect(names(['a=1', '[0..1/a]', 'unknown(x)'])).toEqual([]);
    expect(names(['a=1', 'X~Normal(a,1)'])).toEqual([]);
    expect(names(['a=1', "v'=-v", 'v(0)=a', 'v'])).toEqual([]);
  });
});

describe('Σ up to a clamped slider', () => {
  const series = 'y = (4/pi) sum(k=1..N, sin((2k-1)x)/(2k-1))';

  it('keeps the bound live: a drag moves a uniform rather than re-expanding', () => {
    expect(names(['N = round(clamp(19, 1, 50))', series])).toEqual(['N']);
    expect(names(['N = clamp(round(3), 0, 16)', 'y = sum(k=1..N, cos(k x)/k^2)'])).toEqual(['N']);
    // Without a declared range there is no last term to expand to.
    expect(names(['N = 19', series])).toEqual([]);
  });

  it('expands the current value for anything the shader cannot loop over', () => {
    for (const rows of [
      // A general body would evaluate every term up to the maximum at every N.
      ['N = round(clamp(3, 1, 50))', 'y = sum(k=1..N, x^k/k)'],
      ['N = round(clamp(3, 1, 50))', 'y = prod(k=1..N, 1 + x/k)'],
      // Past fourierLoop's 128 harmonics.
      ['N = round(clamp(3, 1, 500))', 'y = sum(k=1..N, sin(k x)/k)'],
      // Not a whole number: rounding can pass the declared end, or a float N
      // land just under one.
      ['N = ceil(clamp(8.2, 1, 8.2))', 'y = sum(k=1..N, sin(k x)/k)'],
      ['N = clamp(3, 1, 50)', series],
    ]) {
      const a = analyzeRows(rows);
      expect(a.rows.map(row => row.error).filter(Boolean), rows[1]).toEqual([]);
      expect(runtimeSliderNames(a).has('N'), rows[1]).toBe(false);
    }
  });

  it('leaves points, and a parameter named like the slider, to the plain expansion', () => {
    const point = analyzeRows(['N = round(clamp(3, 1, 50))', 'P = sum(k=1..N, (k, 1))', 'P']);
    expect(point.rows.map(row => row.error).filter(Boolean)).toEqual([]);
    // Whatever a parameter's bound reads, it must not take the slider's range.
    const value = (n: string) => {
      const object = analyzeRows([n, 'f(N) = sum(k=1..N, k)', 'y = f(100)']).rows[2].cls!.object;
      if (object.kind !== 'curve' || object.form !== 'graph') throw new Error(object.kind);
      return evaluate(object.rhs, { x: 0 });
    };
    expect(value('N = round(clamp(3, 1, 50))')).toBe(value('N = 3'));
  });

  it('gates each term on the slider, matching the plain expansion at every value', () => {
    const rhs = (rows: string[]) => {
      const object = analyzeRows(rows).rows[1].cls!.object;
      if (object.kind !== 'curve' || object.form !== 'graph') throw new Error(object.kind);
      return object.rhs;
    };
    const gated = rhs(['N = round(clamp(19, 1, 50))', series]);
    for (const n of [1, 2, 19, 37, 50]) {
      const plain = rhs([`N = ${n}`, series]);
      for (const x of [-2.5, 0.3, 1.7]) expect(evaluate(gated, { x, N: n })).toBeCloseTo(evaluate(plain, { x }), 12);
    }
  });

  it('draws as one runtime loop with an analytic graph slope', () => {
    const gpu = analyzeRows(['N = round(clamp(19, 1, 50))', series]).rows[1].gpu!;
    if (gpu.type !== 'implicit2d') throw new Error(gpu.type);
    expect(gpu.params).toEqual(['N']);
    expect(gpu.field).toContain('eq_loop_');
    expect(gpu.field).not.toContain('sin(');
    expect(gpu.graphEval?.slopeScale).toBe(1);
  });

  it('expands the current value when the full range is over the term limit', () => {
    const a = analyzeRows(['N = round(clamp(3, 1, 100000))', series]);
    expect(a.rows[1].error).toBeUndefined();
    expect(runtimeSliderNames(a).has('N')).toBe(false);
  });
});
