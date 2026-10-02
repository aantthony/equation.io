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
    // An undefined name is not yet anything: it greys until a row binds it.
    expect(spans('b x', rows)).toEqual(['b:unbound', 'x:coord']);
  });

  it('lets a value shadow a shadowable builtin', () => {
    expect(spans('mean(L)', ['L = [1, 2]'])).toEqual(['mean:fn', 'L:name']);
    expect(spans('mean + 1', ['mean = [1, 4, 2]'])).toEqual(['mean:name', '1:num']);
  });

  it('keeps ranges, primes, text, glyphs and superscripts apart', () => {
    expect(spans('[1..N]', ['N = 5'])).toEqual(['1:num', 'N:name']);
    expect(spans('int[0..1] x dx')).toEqual(['int:fn', '0:num', '1:num', 'x:coord', 'dx:coord']);
    expect(spans('[.5..2]')).toEqual(['.5:num', '2:num']);
    // A sum's index is not Normal by its alias N, nor T the t distribution.
    expect(spans('sum[n=1..3] n T')).toEqual(['sum:fn', 'n:name', '=:op', '1:num', '3:num', 'n:name', 'T:unbound']);
    expect(spans("th' = om", ["th' = om", "om' = -th"])).toEqual(["th':name", '=:op', 'om:name']);
    expect(spans('label(A, "it\'s")', ['A = (0, 0)'])).toEqual(['label:fn', 'A:name', '"it\'s":str']);
    expect(spans('2πr²')).toEqual(['2:num', 'π:const', 'r:unbound', '²:num']);
    expect(spans('X ~ Normal(0, 1)', ['X ~ Normal(0, 1)'])).toEqual(['X:name', '~:op', 'Normal:fn', '0:num', '1:num']);
    expect(spans('P(X < 1) + E(X)', ['X ~ Normal(0, 1)'])).toEqual([
      'P:fn',
      'X:name',
      '<:op',
      '1:num',
      'E:fn',
      'X:name',
    ]);
  });

  it('binds what a row binds for itself', () => {
    expect(spans('g(x, k) = k x^2 + c')).toEqual([
      'g:unbound',
      'x:coord',
      'k:name',
      '=:op',
      'k:name',
      'x:coord',
      '2:num',
      'c:unbound',
    ]);
    expect(spans('prod(k=1..N, k)', ['N = 3'])).toEqual(['prod:fn', 'k:name', '=:op', '1:num', 'N:name', 'k:name']);
    const seq = ['a_0 = 1', 'a_{n+1} = a_n / 2 + 1'];
    expect(spans('a_{n+1} = a_n / 2', seq)).toEqual(['a_:name', 'n:name', '1:num', '=:op', 'a_n:name', '2:num']);
    expect(spans('d/dx (x^3)')).toEqual(['d:coord', 'dx:coord', 'x:coord', '3:num']);
  });

  it('leaves viewport rows to the stylesheet', () => {
    expect(spans('view(x = -2..2, y = -1..1)')).toEqual([]);
    expect(spans('---')).toEqual([]);
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

  it('names a complex value, and a real one reached through it', () => {
    const complex = envOf(['a = e^(i pi/3)', 'b = re(a)', 'S = e^(i pi [0..5]/5)', 'q = x + i y', 'R = [a, 1]']);
    const typeIn = (name: string) => describeName(name, complex)?.type;
    expect(typeIn('a')).toBe('complex number');
    expect(typeIn('b')).toBe('number');
    expect(typeIn('S')).toBe('list of 6 complex numbers');
    expect(typeIn('q')).toBe('field');
    expect(typeIn('R')).toBe('list of 2 complex numbers');
  });

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
