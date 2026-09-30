import { describe, expect, it } from 'vitest';
import { prepareDocument } from './analysis.ts';
import { describeName, highlightSpans } from './highlight.ts';

const envOf = (rows: string[]) => prepareDocument(rows).defs;

/** Each coloured span as `text:class`, for compact assertions. */
const spans = (text: string, rows: string[] = []) =>
  highlightSpans(text, envOf(rows)).map(s => `${text.slice(s.start, s.end)}:${s.cls}`);

describe('highlightSpans', () => {
  it('colours numbers, builtins, coordinates and relations', () => {
    expect(spans('y = sin(2x) + 0.5')).toEqual(['y:coord', '=:op', 'sin:fn', '2:num', 'x:coord', '0.5:num']);
  });

  it('colours names by what the document binds them to', () => {
    const rows = ['a = 2', 'f(x) = a x^2', 'A = (1, 2)'];
    expect(spans('y = f(x) + a', rows)).toEqual(['y:coord', '=:op', 'f:fn', 'x:coord', 'a:name']);
    expect(spans('A.x + A_y', rows)).toEqual(['A.x:name', 'A_y:name']);
    // An undefined name has no colour: it is not yet anything.
    expect(spans('b x', rows)).toEqual(['x:coord']);
  });

  it('lets a value shadow a shadowable builtin', () => {
    expect(spans('mean(L)')).toEqual(['mean:fn']);
    expect(spans('mean + 1', ['mean = [1, 4, 2]'])).toEqual(['mean:name', '1:num']);
  });

  it('keeps ranges, primes, text, glyphs and superscripts apart', () => {
    expect(spans('[1..N]')).toEqual(['1:num']);
    expect(spans('int[0..1] x dx')).toEqual(['int:fn', '0:num', '1:num', 'x:coord']);
    expect(spans('[.5..2]')).toEqual(['.5:num', '2:num']);
    // A sum's index is not Normal by its alias N, nor T the t distribution.
    expect(spans('sum[n=1..3] n T')).toEqual(['sum:fn', '=:op', '1:num', '3:num']);
    expect(spans("th' = om")).toEqual(['=:op']);
    expect(spans('label(A, "it\'s")', ['A = (0, 0)'])).toEqual(['label:fn', 'A:name', '"it\'s":str']);
    expect(spans('2πr²')).toEqual(['2:num', 'π:const', '²:num']);
    expect(spans('X ~ Normal(0, 1)')).toEqual(['~:op', 'Normal:fn', '0:num', '1:num']);
    expect(spans('P(X < 1) + E(X)', ['X ~ Normal(0, 1)'])).toEqual([
      'P:fn',
      'X:name',
      '<:op',
      '1:num',
      'E:fn',
      'X:name',
    ]);
  });

  it('leaves comments, notes and half-typed rows readable', () => {
    expect(spans('# tangent lines')).toEqual([]);
    expect(spans('y = x # the diagonal')).toEqual(['y:coord', '=:op', 'x:coord']);
    expect(spans('y = sin(x + "abc')).toEqual(['y:coord', '=:op', 'sin:fn', 'x:coord', '"abc:str']);
  });
});

describe('describeName', () => {
  const env = envOf([
    'a = 2',
    'f(x, k) = k x',
    'A = (1, 2, 3)',
    'c = (cos(2pi u), sin(2pi u))',
    'L = [3, 1, 4]',
    'M = ((1, 2), (3, 4))',
    "th' = om",
    "om' = -th",
    'X ~ Normal(0, 1)',
  ]);
  const type = (name: string) => describeName(name, env)?.type;

  it('names the type of a document value', () => {
    expect(type('a')).toBe('number');
    expect(describeName('f', env)).toMatchObject({ signature: 'f(x, k)', type: 'function', defined: 'f' });
    expect(type('A')).toBe('point (3D)');
    expect(type('c')).toBe('curve (2D)');
    expect(type('L')).toBe('list of 3 numbers');
    expect(type('M')).toBe('matrix (2×2)');
    expect(type('th')).toBe('state');
    expect(type('X')).toBe('random variable');
  });

  it('points a component at its owner', () => {
    expect(describeName('A_z', env)).toMatchObject({ type: 'number', defined: 'A' });
    expect(describeName('A.x', env)).toMatchObject({ type: 'number', defined: 'A' });
  });

  it('describes builtins and the plot variables', () => {
    expect(describeName('sin', env)).toMatchObject({ signature: 'sin(x)', type: 'built-in' });
    expect(describeName('π', env)).toMatchObject({ type: 'constant' });
    expect(type('t')).toBe('time');
    expect(describeName('nope', env)).toBeNull();
  });
});
