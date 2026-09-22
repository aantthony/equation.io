import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { runtimeSliderNames } from './runtime-sliders.ts';

const names = (rows: string[]) => [...runtimeSliderNames(analyzeRows(rows))].sort();

describe('runtime-only sliders', () => {
  it('keeps scalar uniforms and figure transforms live without recompilation', () => {
    expect(names(['s=.24', 'R=3', 'P=[(0,0,0),(1,0,0),(0,1,0),(0,0,1)]',
      'a=pi[1..3]/4', 'rotate(s hull(P),a,(0,1,0))+(R,0,0)'])).toEqual(['R', 's']);
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
    for (const definition of ['b=2a', 'L=[0,a..2]', 'f(x)=a x', 'M=[(a,0),(0,a)]']) {
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
