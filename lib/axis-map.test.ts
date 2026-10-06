import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { axisMapping, parseAxisMap, toScreen, toScreenOrEdge, toWorld } from './axis-map.ts';
import { runPaths, shadeRuns } from './intshade.ts';
import { type Expr, evaluate, parseExpr } from './expr.ts';
import type { Components } from './math-object.ts';
import { runtimeSliderNames } from './runtime-sliders.ts';
import { mappedSpecialPoints } from './special.ts';
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
    expect(() => parseAxisMap('x', 'a^X')).toThrow(/sliders; a has no fixed value/);
    expect(() => parseAxisMap('y', '10^X')).toThrow(/in terms of the screen's Y/);
  });
});

describe('a map with a slider', () => {
  it('reads the slider at its value', () => {
    const a = analyzeRows(['b = 2', 'view(x = 1..1024, x = b^X)', 'y = x']);
    expect(a.rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    const spec = a.rows[1].view as View2DSpec;
    expect(spec.x![1]).toBeCloseTo(10, 9);
    expect(formatViewSpec(spec)).toBe('view(x = 1..1024, x = b^X)');
    // y = x is Y = 2^X on the screen.
    expect(evaluate((a.rows[2].cls!.object as { rhs: Expr }).rhs, { x: 3 })).toBeCloseTo(8, 9);
  });

  it('reanalyses when the slider moves, rather than passing it to the shader alone', () => {
    // The window is in screen units, which the slider changes.
    expect(runtimeSliderNames(analyzeRows(['b = 2', 'view(x = 1..1024, x = b^X)', 'y = sin(x)']))).not.toContain('b');
  });

  it('says why a map cannot use what changes with t', () => {
    const [, , r] = analyzeRows(['b = 2 + sin(t)', 'y = b', 'view(x = 1..100, x = b^X)']).rows;
    expect(r.error).toMatch(/b has no fixed value here \(not defined, or it changes with t\)/);
  });

  it('says when the slider makes the map stop increasing', () => {
    const [, r] = analyzeRows(['b = 0.5', 'view(x = 1..1024, x = b^X)']).rows;
    expect(r.error).toMatch(/must increase/);
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

  it('rewrite a system, so its solver searches the screen', () => {
    const rows = ['view(x = 1..100, y = 1..100, x = 10^X, y = 10^Y)', '(x y, x/y) = (100, 4)'];
    const [, sys] = analyzeRows(rows).rows;
    expect(sys.error).toBeUndefined();
    const o = sys.cls!.object as { source: { residuals: Components } };
    // x = 20, y = 5 solves it: at screen (log 20, log 5) both residuals vanish.
    const at = { x: Math.log10(20), y: Math.log10(5) };
    for (const r of o.source.residuals) expect(evaluate(r, at)).toBeCloseTo(0, 9);
  });

  it('find hover points on the screen and read them in x and y', () => {
    const hover = (rows: string[], box: [number, number, number, number]) => {
      const a = analyzeRows(rows);
      const maps = (a.rows[0].view as View2DSpec).maps!;
      const o = a.rows.at(-1)!.cls!.object as { equation: Expr };
      return mappedSpecialPoints(o.equation, maps, ...box).map(p => [p.lines.join('; '), p.x]);
    };
    // A minimum stays one through an increasing map, placed on the screen.
    const [[min, at]] = hover(
      ['view(x = 0.1..100, y = 0.1..100, x = 10^X, y = 10^Y)', 'y = (x - 3)^2 + 1'],
      [-1, 2, -1, 2],
    );
    expect(min).toBe('local minimum; x = 3; y = 1');
    expect(at).toBeCloseTo(Math.log10(3), 9);
    const lines = (rows: string[], box: [number, number, number, number]) => hover(rows, box).map(([l]) => l);
    // A log axis shows no x = 0, so no y-intercept; y is plain, so the
    // x-intercept stays.
    expect(lines(['view(x = 0.1..100, y = -5..5, x = 10^X)', 'y = x - 2'], [-1, 2, -5, 5])).toEqual([
      'x-intercept; x = 2; y = 0',
    ]);
    // Nor y = 0 on a log y axis — but the y-intercept at the screen's
    // origin stays.
    expect(lines(['view(x = -5..5, y = 0.1..100, y = 10^Y)', 'y = x + 1'], [-5, 5, -1, 2])).toEqual([
      'y-intercept; x = 0; y = 1',
    ]);
    // A map that moves x = 0 off the screen's axis is searched where it is.
    expect(lines(['view(x = -5..5, y = -5..5, x = X + 1)', 'y = x - 2'], [-6, 4, -5, 5])).toEqual([
      'x-intercept; x = 2; y = 0',
      'y-intercept; x = 0; y = -2',
    ]);
    // Symlog reaches 0: both intercepts read where they are; the curve's bend
    // there is the screen's, not an inflection of y = x - 2.
    expect(lines(['view(x = -10..10, y = -5..5, x = sinh(X))', 'y = x - 2'], [-3, 3, -5, 5])).toEqual([
      'x-intercept; x = 2; y = 0',
      'y-intercept; x = 0; y = -2',
    ]);
    // x = X^3 flattens y = x at 0 on the screen: no stationary point there.
    expect(lines(['view(x = -8..8, y = -8..8, x = X^3)', 'y = x'], [-2, 2, -8, 8])).toEqual([
      'x-intercept, y-intercept; x = 0; y = 0',
    ]);
    // A tangent root keeps its multiplicity; a parabola keeps no inflection.
    expect(lines(['view(x = 0.1..100, y = -5..5, x = 10^X)', 'y = (x - 2)^2'], [-1, 2, -5, 5])).toEqual([
      'x-intercept, local minimum; x = 2; y = 0; double root',
    ]);
  });

  it('refuse what the map cannot carry, rather than drawing it in the wrong place', () => {
    // A 3D point would turn the panel 3D under rows written for its screen.
    for (const row of ['(1, 2, 3)', 'x^2 + y^2 + z^2 = 1']) {
      const [, r] = analyzeRows(['view(x = 1..100, x = 10^X)', row]).rows;
      expect(r.error, row).toMatch(/maps its axes/);
    }
  });

  it("carry a flow to the screen through the map's slope", () => {
    // x' = x is uniform motion on a log x axis: X' = 1/ln 10 everywhere.
    const field = object(['view(x = 1..100, x = 10^X)', '(x, 0)']);
    expect(field.kind).toBe('vector-field');
    const [P, Q] = (field as { components: Components }).components;
    for (const X of [0, 1, 2]) expect(at(P, X)).toBeCloseTo(1 / Math.LN10, 9);
    expect(at(Q, 1)).toBe(0);
    // A slope field too: y' = 2y on a log y axis is the slope 2/ln 10.
    const slope = object(['view(x = 0..5, y = 1..100, y = 10^Y)', "y' = 2y"]);
    const [dX, dY] = (slope as { components: Components }).components;
    for (const Y of [0, 1, 2])
      expect(evaluate(dY, { x: 1, y: Y }) / evaluate(dX, { x: 1, y: Y })).toBeCloseTo(2 / Math.LN10, 9);
    // A coordinate flow is lowered to x' and y' first: a rotation in polar
    // coordinates is (-y, x), whichever way it is written.
    const view = 'view(x = 1..100, y = 1..100, x = 10^X, y = 10^Y)';
    const polar = object(['r = sqrt(x^2 + y^2)', 'theta = atan2(y, x)', view, "(r', theta') = (0, 1)"]);
    const plain = object([view, "(x', y') = (-y, x)"]);
    for (const [k, c] of (polar as { components: Components }).components.entries())
      expect(evaluate(c, { x: 0.5, y: 1.2 })).toBeCloseTo(
        evaluate((plain as { components: Components }).components[k], { x: 0.5, y: 1.2 }),
        9,
      );
    // And the phase plane, with both axes mapped: x' = x, y' = -y.
    const phase = object(['view(x = 1..100, y = 1..100, x = 10^X, y = 10^Y)', "(x', y') = (x, -y)"]);
    const [u, v] = (phase as { components: Components }).components;
    expect(evaluate(u, { x: 1, y: 1 })).toBeCloseTo(1 / Math.LN10, 9);
    expect(evaluate(v, { x: 1, y: 1 })).toBeCloseTo(-1 / Math.LN10, 9);
  });

  it('read a tensor field at the screen point, and carry it by the Jacobian', () => {
    const rows = ['view(x = 1..100, y = 1..100, x = 10^X, y = 10^Y)', '((x, y), (1, 2))'];
    const tensor = object(rows) as { entries: Expr[]; jacobian: Expr[] };
    const at = { x: 1, y: 2 };
    // x = 10 and y = 100 at the screen point (1, 2).
    expect(tensor.entries.map(e => evaluate(e, at))).toEqual([10, 100, 1, 2]);
    // x = 10^X moves at ln 10 · 10^X, and not with Y.
    const [a, b, c, d] = tensor.jacobian.map(e => evaluate(e, at));
    expect(a).toBeCloseTo(Math.LN10 * 10, 9);
    expect([b, c]).toEqual([0, 0]);
    expect(d).toBeCloseTo(Math.LN10 * 100, 9);
    // Unmapped, it carries none.
    expect(object(['((x, y), (1, 2))'])).not.toHaveProperty('jacobian');
  });

  it('place histogram bars and a complex system’s roots, and keep an integral’s shade', () => {
    const rows = [
      'view(x = 1..100, y = 1..100, x = 10^X, y = 10^Y)',
      'hist([1, 2, 2, 3])',
      'w^2 = -4',
      'int[1..10] x dx',
    ];
    const a = analyzeRows(rows).rows;
    expect(a.map(r => r.error)).toEqual(rows.map(() => undefined));
    expect(a.slice(1, 3).map(r => axisMapping(r.cls!.object))).toEqual(['place', 'place']);
    expect(a[3].cls!.object).toHaveProperty('shade');
  });
});

describe('an integral on mapped axes', () => {
  const log = (axis: 'x' | 'y') => parseAxisMap(axis, axis === 'x' ? '10^X' : '10^Y');
  const shade = (body: string, lo: string, hi: string) => ({
    body: parseExpr(body),
    v: 'x',
    lo: parseExpr(lo),
    hi: parseExpr(hi),
  });

  it('samples evenly along a log x axis and reads its signs before y is mapped', () => {
    const runs = shadeRuns(shade('x - 10', '1', '100'), {}, 0, 2, undefined, { x: log('x') });
    // Below the axis left of x = 10 (X = 1), above it right of there.
    expect(runs.map(r => r.sign)).toEqual([-1, 1]);
    expect(runs[0].pts[0]).toBeCloseTo(0, 9);
    expect(runs[1].pts.at(-2)).toBeCloseTo(2, 9);
    expect(runs[0].pts.at(-2)).toBeCloseTo(1, 3);
  });

  it('stands on the bottom edge of a log y axis, which cannot show y = 0', () => {
    const y = log('y');
    const [run] = shadeRuns(shade('x', '1', '100'), {}, 0, 200, undefined, { y });
    // y = x read on the log y axis: at x = 100, Y = 2.
    expect(run.pts.at(-1)).toBeCloseTo(2, 9);
    expect(toScreenOrEdge(y, 0)).toBe(-Infinity);
    const { fill } = runPaths(run, 0, 3, toScreenOrEdge(y, 0));
    // The fill closes along the bottom, past the window, not at NaN.
    expect(fill[1]).toBe(-3);
    expect(fill.every(Number.isFinite)).toBe(true);
    // A value the axis cannot show lies past the same edge.
    expect(toScreenOrEdge(y, -5)).toBe(-Infinity);
    expect(toScreenOrEdge(parseAxisMap('y', 'sinh(Y)'), 0)).toBe(0);
  });

  it('does not take what the map never reaches for what it shows', () => {
    // y = sqrt(Y) has the inverse Y = y^2, which sends y = -3 to 9.
    const y = parseAxisMap('y', 'sqrt(Y)');
    expect(toScreen(y, -3)).toBeNaN();
    expect(toScreenOrEdge(y, -3)).toBe(-Infinity);
    const [run] = shadeRuns(shade('-3', '0', '1'), {}, 0, 2, undefined, { y });
    expect(run.sign).toBe(-1);
    expect(run.pts[1]).toBe(-Infinity);
    // And x from -4 is shaded from x = 0, where the axis starts.
    const x = parseAxisMap('x', 'sqrt(X)');
    const [whole] = shadeRuns(shade('1', '-4', '9'), {}, 0, 100, undefined, { x });
    expect(whole.pts[0]).toBe(0);
    expect(whole.pts.at(-2)).toBeCloseTo(81, 9);
  });
});
