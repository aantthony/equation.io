import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { axisMapping, parseAxisMap, toScreen, toWorld } from './axis-map.ts';
import { type Expr, evaluate } from './expr.ts';
import { type View2DSpec, formatViewSpec, parseViewRow } from './view.ts';

const view = (text: string) => parseViewRow(text, {}) as View2DSpec;
const object = (rows: string[], at = rows.length - 1) => {
  const row = analyzeRows(rows).rows[at];
  if (row.error) throw new Error(row.error);
  return row.cls!.object;
};

describe('axis maps', () => {
  it('invert the usual axes', () => {
    for (const [src, world] of [
      ['10^X', 1000],
      ['exp(X)', 20],
      ['2^(X/3)', 5],
      ['X^3', -8],
      ['sinh(X)', -4],
      ['3X + 1', 7],
      ['1/(1 + exp(-X))', 0.25],
    ]) {
      const map = parseAxisMap('x', src as string);
      expect(toWorld(map, toScreen(map, world as number)), src as string).toBeCloseTo(world as number, 9);
    }
  });

  it('refuse a map that does not increase wherever it is defined', () => {
    expect(() => parseAxisMap('x', '-X')).toThrow(/must increase/);
    expect(() => parseAxisMap('x', 'X^2')).toThrow(/must increase/);
    expect(() => parseAxisMap('x', 'ln(X)')).not.toThrow();
  });

  it('refuse a map that cannot be inverted or uses more than the screen', () => {
    expect(() => parseAxisMap('x', 'X + sin(X)')).toThrow(/no inverse/);
    expect(() => parseAxisMap('x', 'a^X')).toThrow(/only X and numbers \(found a\)/);
    expect(() => parseAxisMap('y', '10^X')).toThrow(/in terms of the screen's Y/);
  });
});

describe('a mapped view row', () => {
  it('holds its window in screen units and writes it back in x units', () => {
    const spec = view('view(x = 1..1000, y = -1..1, x = 10^X)');
    expect(spec.x![0]).toBeCloseTo(0, 12);
    expect(spec.x![1]).toBeCloseTo(3, 12);
    expect(spec.y).toEqual([-1, 1]);
    expect(formatViewSpec(spec)).toBe('view(x = 1..1000, y = -1..1, x = 10^X)');
  });

  it('frames a map given alone, when it can', () => {
    expect(view('view(y = 10^Y)').y).toEqual([-5, 5]);
    expect(() => view('view(x = ln(X))')).toThrow(/Give x a range/);
    expect(view('view(x = 1..10, x = ln(X))').x![0]).toBeCloseTo(Math.E, 9);
  });

  it('writes back tiny bounds of a log axis as they are, not as 0', () => {
    for (const text of ['view(x = 10^X)', 'view(x = 1..1000, x = 10^X)']) {
      const spec = { ...view(text), x: [-7, 3] as [number, number] };
      const back = formatViewSpec(spec);
      expect(back).toBe('view(x = 0.0000001..1000, x = 10^X)');
      expect(view(back).x![0]).toBeCloseTo(-7, 9);
    }
  });

  it('says when the window lies outside the map', () => {
    expect(() => view('view(x = -1..10, x = 10^X)')).toThrow(/reaches past/);
    expect(() => view('view(x = 1..10, x = -X)')).toThrow(/must increase/);
    expect(() => view('view(x = 10^X, x = 2^X)')).toThrow(/maps x twice/);
  });
});

describe('rows in a mapped panel', () => {
  const at = (e: Expr, x: number, y = 0) => evaluate(e, { x, y });

  it('keep a graph a graph, in screen coordinates', () => {
    const o = object(['view(x = 1..1000, y = 1..1000000, x = 10^X, y = 10^Y)', 'y = x^2']);
    expect(o.kind === 'curve' && o.form).toBe('graph');
    // A power law is a straight line on log-log axes: Y = 2X.
    const rhs = (o as { rhs: Expr }).rhs;
    for (const X of [0, 1.5, 3]) expect(at(rhs, X)).toBeCloseTo(2 * X, 9);
  });

  it('put the map into implicit curves, regions and fields', () => {
    const rows = ['view(x = 1..100, x = 10^X)'];
    const curve = object([...rows, 'x^2 + y^2 = 4']);
    expect(curve.kind === 'curve' && curve.form).toBe('implicit');
    const region = object([...rows, 'y < x']);
    expect(region.kind).toBe('region');
    const field = object([...rows, 'x y']);
    expect(field.kind === 'scalar-field' && at(field.expr, 2, 3)).toBeCloseTo(300, 9);
  });

  it('put the map into coordinate fields too', () => {
    const o = object(['r = sqrt(x^2 + y^2)', 'view(x = 1..100, x = 10^X)', 'r < 50']);
    const [{ residual }] = (o as { constraints: Array<{ residual: Expr }> }).constraints;
    // At screen X = 1, x = 10, so r - 50 = -40.
    expect(at(residual, 1)).toBeCloseTo(-40, 9);
  });

  it('use functions defined anywhere in the document', () => {
    const o = object(['f(x) = x^2', 'view(x = 1..100, x = 10^X)', 'y = f(x)']);
    expect(at((o as { rhs: Expr }).rhs, 1)).toBeCloseTo(100, 9);
  });

  it('map only the panel the view row is in', () => {
    const rows = ['view(x = 1..100, x = 10^X)', 'y = x', '---', 'y = x'];
    const a = analyzeRows(rows).rows;
    expect(at((a[1].cls!.object as { rhs: Expr }).rhs, 2)).toBeCloseTo(100, 9);
    expect(at((a[3].cls!.object as { rhs: Expr }).rhs, 2)).toBe(2);
  });

  it('keep what places points in x and y, for the renderer to carry over', () => {
    const rows = [
      'view(x = 1..100, x = 10^X)',
      '(10, 1)',
      '(u, u^2)',
      'A = (2, 3)',
      'segment(A, (50, 1))',
      '[(1, 2), (3, 4)]',
    ];
    const a = analyzeRows(rows).rows;
    expect(a.map(r => r.error)).toEqual(rows.map(() => undefined));
    const point = a[1].cls!.object as { source: { coordinates: Expr[] } };
    // Not log(10): the point's own coordinates, mapped as it is drawn.
    expect(evaluate(point.source.coordinates[0], {})).toBe(10);
    expect(a.slice(1).flatMap(r => (r.cls ? [axisMapping(r.cls.object)] : []))).toEqual([
      'place',
      'place',
      'place',
      'place',
    ]);
  });

  it('refuse what the map cannot carry, rather than drawing it in the wrong place', () => {
    // A system's solver searches the window as if it were x and y; a 3D
    // point would turn the panel 3D under rows written for its screen.
    for (const row of ['(-y, x)', 'hist([1, 2, 2, 3])', '(x + y, x - y) = (30, 10)', '(1, 2, 3)']) {
      const [, r] = analyzeRows(['view(x = 1..100, x = 10^X)', row]).rows;
      expect(r.error, row).toMatch(/maps its axes/);
    }
  });
});
