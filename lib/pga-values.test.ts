import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { shaderKey } from './compiler.ts';
import { type Expr, evaluate } from './expr.ts';
import { publicKind } from './math-object.ts';
import { plotReadout } from './plot.ts';
import { LINE_GLSL } from './pga-line-glsl.fixtures.ts';

/**
 * Points, lines and planes of projective geometry as values (docs/pga.md,
 * phases 2 and 3): what a row reads out and draws, the operations, and the
 * multiset rules of docs/multisets.md applied to them.
 */
function row(rows: string[]) {
  const analysis = analyzeRows(rows, { readouts: true });
  const r = analysis.rows.at(-1)!;
  if (r.error) throw new Error(r.error);
  return { r, env: { ...analysis.constEnv, t: 0 } };
}
const readout = (rows: string[]) => {
  const { r, env } = row(rows);
  return plotReadout(r.cpu!, env);
};
const value = (rows: string[]): number => {
  const { r, env } = row(rows);
  const o = r.cls!.object;
  if (o.kind !== 'value') throw new Error(`expected a value, got ${o.kind}`);
  return evaluate(o.expr, env);
};
const error = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!.error;
/** The kinds a row's members draw as. */
const drawn = (rows: string[]): string[] => {
  const o = row(rows).r.cls!.object;
  return o.kind === 'family' ? o.members.map(m => publicKind(m.object)) : [publicKind(o)];
};

const ABCD = ['A = (0, 0)', 'B = (1, 2)', 'C = (3, 0)', 'D = (3, 1)'];

describe('line(A, B) of the plane', () => {
  it('draws exactly the GLSL it did before lines were values', () => {
    for (const [doc, key] of Object.entries(LINE_GLSL)) {
      const { r } = row(doc.split('; '));
      expect(shaderKey(r.gpu!), doc).toBe(key);
    }
  });
  it('named, draws the same line and passes on as a value', () => {
    const named = [...ABCD, 'L = line(A, B)'];
    expect(drawn([...named, 'L'])).toEqual(['implicit2d']);
    expect(readout([...named, 'L'])).toBe('= y = 2x');
    expect(readout([...named, 'meet(L, line(C, D))'])).toBe('= (3, 6)');
    // Older links write the coordinates loose.
    expect(readout(['L = line(0, 0, 1, 2)', 'L'])).toBe('= y = 2x');
    // The definition draws nothing; the row naming it does.
    expect(analyzeRows([...named]).rows.at(-1)!.cls).toBeUndefined();
  });
  it('is no number or point, so arithmetic on it says what it is', () => {
    expect(error([...ABCD, 'L = join(A, B)', '2 L'])).toMatch(/A line is not a number or a point here/);
    expect(error([...ABCD, 'line(A, B) + (1, 0)'])).toMatch(/A line is not a number or a point here/);
  });
});

describe('join and meet', () => {
  it('read out the line through two points and the point where two cross', () => {
    expect(readout([...ABCD, 'join(A, B)'])).toBe('= y = 2x');
    expect(readout([...ABCD, 'join(C, D)'])).toBe('= x = 3');
    expect(readout([...ABCD, 'meet(join(A, B), join(C, D))'])).toBe('= (3, 6)');
    expect(publicKind(row([...ABCD, 'join(A, B)']).r.cls!.object)).toBe('flat');
  });
  it('meet parallel lines at an ideal point, which draws nothing', () => {
    const rows = [...ABCD, 'meet(join(A, B), join(C, C + B - A))'];
    expect(readout(rows)).toBe('= at infinity, direction (1, 2)');
    expect(drawn(rows)).toEqual(['point']);
  });
  it('give a point that every point construction takes', () => {
    const X = 'X = meet(join(A, B), join(C, D))';
    expect(readout([...ABCD, X, 'midpoint(X, A)'])).toBeNull();
    const { r, env } = row([...ABCD, X, 'midpoint(X, A)']);
    const o = r.cls!.object;
    expect(o.kind).toBe('point');
    if (o.kind === 'point' && o.source.representation === 'real')
      expect(o.source.coordinates.map((c: Expr) => evaluate(c, env))).toEqual([1.5, 3]);
    expect(drawn([...ABCD, 'polygon(meet(join(A, B), join(C, D)), A, C)'])).toEqual(['polygon']);
  });
  it('make planes, and lines of space where planes cross', () => {
    expect(readout(['plane((1, 0, 0), (0, 1, 0), (0, 0, 1))'])).toBe('= z = -x - y + 1');
    expect(readout(['join((1, 0, 0), (0, 1, 0), (0, 0, 1))'])).toBe('= z = -x - y + 1');
    expect(readout(['plane((0, 0, 2), (0, 0, 1))'])).toBe('= z = 2');
    expect(readout(['plane((0, 0, 0), (1, 0, 0))'])).toBe('= x = 0');
    expect(readout(['meet(plane((0, 0, 1), (0, 0, 1)), plane((0, 0, 0), (1, 0, 0)))'])).toBe(
      '= through (0, 0, 1), direction (0, -1, 0)',
    );
    expect(readout(['meet(line((0, 0, 0), (1, 1, 1)), plane((0, 0, 2), (0, 0, 1)))'])).toBe('= (2, 2, 2)');
  });
  it('draw a line of space as a curve of intersection, whatever its direction', () => {
    expect(readout(['line((0, 0, 0), (2, 1, 1))'])).toBe('= through (0, 0, 0), direction (2, 1, 1)');
    expect(drawn(['line((0, 0, 0), (2, 1, 1))'])).toEqual(['spacecurve']);
    // Along an axis its equations still name z, so it stays a line of space.
    expect(drawn(['line((1, 0, 0), (1, 0, 1))'])).toEqual(['spacecurve']);
    expect(drawn(['plane((0, 0, 0), (1, 0, 0))'])).toEqual(['implicit3d']);
  });
  it('refuse what has no meet or join', () => {
    expect(
      error(['line((0, 0, 0), (1, 0, 0))', 'meet(line((0, 0, 0), (1, 0, 0)), line((0, 1, 0), (0, 1, 1)))']),
    ).toMatch(/Two lines in space seldom cross/);
    expect(error([...ABCD, 'meet(A, B)'])).toMatch(/A point meets nothing more/);
    expect(error([...ABCD, 'join(A)'])).toMatch(/join takes points/);
    expect(error([...ABCD, 'join(join(A, B), C)'])).toMatch(/join takes points/);
    expect(error([...ABCD, 'meet(join(A, B), plane((0, 0, 1), (0, 0, 1)))'])).toMatch(/one in space/);
  });
});

describe('measures, projection and reflection', () => {
  it('measure from a point to a line or plane', () => {
    expect(value([...ABCD, 'distance(D, join(A, B))'])).toBeCloseTo(5 / Math.sqrt(5), 12);
    expect(value([...ABCD, 'distance(join(A, B), D)'])).toBeCloseTo(5 / Math.sqrt(5), 12);
    expect(value(['distance((3, 4, 5), plane((0, 0, 1), (0, 0, 1)))'])).toBeCloseTo(4, 12);
    expect(value(['distance((0, 5, 0), line((0, 0, 0), (1, 0, 0)))'])).toBeCloseTo(5, 12);
    // Points alone keep their own path.
    expect(value([...ABCD, 'distance(A, B)'])).toBeCloseTo(Math.sqrt(5), 12);
  });
  it('measure between flats: 0 where they cross, the gap where parallel or skew', () => {
    expect(value([...ABCD, 'distance(join(A, B), join(C, D))'])).toBe(0);
    expect(value([...ABCD, 'distance(join(A, B), join(C, C + B - A))'])).toBeCloseTo(6 / Math.sqrt(5), 12);
    expect(value(['distance(plane((0, 0, 1), (0, 0, 1)), plane((0, 0, 4), (0, 0, 2)))'])).toBeCloseTo(3, 12);
    expect(value(['distance(line((0, 0, 0), (1, 0, 0)), line((0, 0, 2), (0, 1, 2)))'])).toBeCloseTo(2, 12);
    expect(value(['distance(line((0, 0, 0), (1, 0, 0)), line((0, 3, 0), (1, 3, 0)))'])).toBeCloseTo(3, 12);
    expect(value(['distance(line((0, 0, 1), (1, 0, 1)), plane((0, 0, 0), (0, 0, 1)))'])).toBeCloseTo(1, 12);
  });
  it('take the acute angle between lines and planes', () => {
    expect(value([...ABCD, 'angle(join(A, B), join(C, D))'])).toBeCloseTo(Math.atan(1 / 2), 12);
    expect(value(['angle(plane((0, 0, 0), (0, 0, 1)), plane((0, 0, 0), (0, 1, 1)))'])).toBeCloseTo(Math.PI / 4, 12);
    expect(value(['angle(line((0, 0, 0), (1, 0, 1)), plane((0, 0, 0), (0, 0, 1)))'])).toBeCloseTo(Math.PI / 4, 12);
    expect(error([...ABCD, 'angle(A, join(A, B))'])).toMatch(/angle takes/);
  });
  it('project and reflect points', () => {
    expect(readout([...ABCD, 'project(D, join(A, B))'])).toBe('= (1, 2)');
    expect(readout([...ABCD, 'reflect(D, join(A, B))'])).toBe('= (-1, 3)');
    expect(readout([...ABCD, 'reflect(D, A)'])).toBe('= (-3, -1)');
    expect(readout(['project((3, 4, 5), plane((0, 0, 1), (0, 0, 1)))'])).toBe('= (3, 4, 1)');
    expect(readout(['reflect((3, 4, 5), plane((0, 0, 1), (0, 0, 1)))'])).toBe('= (3, 4, -3)');
  });
});

describe('multisets of flats (docs/multisets.md)', () => {
  const P = ['P = [(1, 1), (2, 0)]', 'C = (0, 0)', 'D = (0, 3)'];
  it('broadcast a list argument: join(P, C) is two lines', () => {
    expect(readout([...P, 'join(P, C)'])).toBe('= [y = x; y = 0]');
    expect(drawn([...P, 'join(P, C)'])).toEqual(['implicit2d', 'implicit2d']);
    expect(value([...P, 'count(join(P, C))'])).toBe(2);
  });
  it('keep a name identical: meet(L, L) pairs each line with itself', () => {
    const rows = [...P, 'L = join(P, C)', 'meet(L, L)'];
    // Two results, not four: a line meets itself nowhere in particular.
    expect(readout(rows)).toBe('= [undefined; undefined]');
    expect(readout([...P, 'L = join(P, C)', 'L'])).toBe('= [y = x; y = 0]');
  });
  it('move every use of one list together', () => {
    expect(readout([...P, 'meet(join(P, C), join(P, D))'])).toBe('= [(1, 1); (2, 0)]');
  });
  it('meet a line with a family of planes in the multiset of crossings', () => {
    const rows = [
      'H = [plane((0, 0, 1), (0, 0, 1)), plane((0, 0, 2), (0, 0, 1)), plane((0, 0, 3), (0, 0, 1))]',
      'K = line((0, 0, 0), (1, 1, 1))',
    ];
    expect(readout([...rows, 'H'])).toBe('= [z = 1; z = 2; z = 3]');
    expect(readout([...rows, 'meet(K, H)'])).toBe('= [(1, 1, 1); (2, 2, 2); (3, 3, 3)]');
    expect(value([...rows, 'count(meet(K, H))'])).toBe(3);
    expect(value([...rows, 'count(H)'])).toBe(3);
    expect(error([...rows, 'total(H)'])).toMatch(/total is not defined for lines and planes/);
    const { r, env } = row([...rows, 'mean(meet(K, H))']);
    const o = r.cls!.object;
    expect(o.kind).toBe('point');
    if (o.kind === 'point' && o.source.representation === 'real')
      expect(o.source.coordinates.map((c: Expr) => evaluate(c, env))).toEqual([2, 2, 2]);
  });
  it('name a list of lines written with line(…)', () => {
    expect(readout([...P, 'N = line(P, C)', 'N'])).toBe('= [y = x; y = 0]');
  });
  it('count an ideal point like any other', () => {
    const rows = ['A = (0, 0)', 'B = (1, 2)', 'Q = [(1, 0), (0, 1)]'];
    expect(readout([...rows, 'meet(join(A, B), join(Q, Q + B - A))'])).toBe(
      '= [at infinity, direction (1, 2); at infinity, direction (1, 2)]',
    );
    expect(value([...rows, 'count(meet(join(A, B), join(Q, Q + B - A)))'])).toBe(2);
  });
});
