import { describe, expect, it } from 'vitest';
import { coordinateDragWriter, dragAxes, splitPair } from './drag.ts';
import { definitionDependencies } from './defs.ts';
import { freeVars, parseExpr } from './expr.ts';
import { analyze } from '../worker/graph.ts';

describe('splitPair', () => {
  it('splits a simple pair at the top-level comma', () => {
    expect(splitPair('(2, 3)')).toEqual(['2', '3']);
  });

  it('ignores commas nested in parens or brackets', () => {
    expect(splitPair('(f(1, 2), [3, 4][1])')).toEqual(['f(1, 2)', '[3, 4][1]']);
  });

  it('rejects non-pairs', () => {
    expect(splitPair('(1, 2, 3)')).toBeNull(); // triple
    expect(splitPair('(1)')).toBeNull(); // no comma
    expect(splitPair('(1, 2) + (3, 4)')).toBeNull(); // outer parens don't wrap the row
    expect(splitPair('x + 1')).toBeNull();
  });
});

describe('dragAxes', () => {
  const sliders = (names: string[]) => (name: string) => (names.includes(name) ? 'slider' : null);

  it('classifies literal and slider coordinates as movable', () => {
    const drag = dragAxes('(2, a)', sliders(['a']));
    expect(drag).not.toBeNull();
    expect(drag!.axes).toEqual(['literal', 'slider']);
  });

  it('pins computed coordinates but keeps the pair grabbable if one axis moves', () => {
    expect(dragAxes('(a+1, 3)', sliders(['a']))!.axes).toEqual([null, 'literal']);
  });

  it('returns null when nothing can move', () => {
    expect(dragAxes('(2cos(t), a+1)', sliders(['a']))).toBeNull();
    expect(dragAxes('(b, c)', sliders([]))).toBeNull(); // names that are not sliders
  });

  it.each(['p=x/a; q=y', 'b=a^2; p=x/b; q=y', 'p=x; q=y/a'])('pins sliders defining either chart coordinate: %s', chart => {
    const a = analyze(['a=2', ...chart.split(';'), '(p,q)=(a,0)']);
    expect(a.rows.some(r => r.error)).toBe(false);
    const plot = a.rows.at(-1)!.cls!.plot;
    if (plot.type !== 'system' || !plot.coordinates) throw new Error('expected coordinate point');
    const coords = plot.coordinates;
    const pinned = definitionDependencies(coords.flatMap(c => [...freeVars(c)]), a.defs);
    expect(dragAxes('(a,0)', sliders(['a']), pinned)?.axes).toEqual([null, 'literal']);
    expect(dragAxes('(a,a)', sliders(['a']), pinned)).toBeNull();
    expect(dragAxes('(c,0)', sliders(['a', 'c']), pinned)?.axes).toEqual(['slider', 'literal']);
  });
});

describe('coordinateDragWriter', () => {
  it('reads current time and dependency values throughout the same drag', () => {
    let env = { t: 1, a: 2 };
    const values: number[][] = [];
    const write = coordinateDragWriter([parseExpr('x+t'), parseExpr('y+a')], () => env, (a, b) => values.push([a, b]));
    write(4, 5);
    env = { t: 7, a: 9 };
    write(4, 5);
    expect(values).toEqual([[5, 7], [11, 14]]);
  });

  it('rounds the pointer before transforming and ignores singular updates', () => {
    const values: number[][] = [];
    const write = coordinateDragWriter([parseExpr('1/x'), parseExpr('y/3')], () => ({}), (a, b) => values.push([a, b]), Math.round);
    write(1.8, 4.8);
    write(0.2, 3);
    expect(values).toEqual([[0.5, 5 / 3]]);
  });
});
