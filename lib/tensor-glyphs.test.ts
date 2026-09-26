import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { evaluate, type Expr } from './expr.ts';
import { glyphScale, largestSingular } from './glyphs.ts';
import { plotReadout } from './plot.ts';

/** Tensors drawn by what they do: action(M), matrix fields, jacobian and hessian. */
function row(rows: string[]) {
  const analysis = analyzeRows(rows, { readouts: true });
  const r = analysis.rows.at(-1)!;
  if (r.error) throw new Error(r.error);
  return { r, env: { ...analysis.constEnv, t: 0 } };
}
const error = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!.error;
const at = (e: Expr, x: number, y: number) => evaluate(e, { x, y });

describe('action(M)', () => {
  it('draws the image of the unit square, circle and axes, and reads out M', () => {
    const { r, env } = row(['action(((1, 1), (0, 1)))']);
    const o = r.cls!.object;
    if (o.kind !== 'family') throw new Error(o.kind);
    expect(o.members.map(m => (m.object as { form: string }).form)).toEqual([
      'polygon',
      'polyline',
      'vector',
      'vector',
    ]);
    const square = (o.members[0].object as { vertices: Expr[] }).vertices.map(v => evaluate(v, env));
    expect(square).toEqual([0, 0, 1, 0, 2, 1, 1, 1]);
    expect(plotReadout(r.cpu!, env)).toBe('= ((1, 1), (0, 1))');
  });
  it('draws a 3×3 as the image of the cube', () => {
    const o = row(['action(((1, 0, 0), (0, 2, 0), (0, 0, 1)))']).r.cls!;
    expect(o.needs3D).toBe(true);
  });
  it('takes a matrix only, on a row of its own', () => {
    expect(error(['action(3)'])).toMatch(/2×2 or 3×3 matrix/);
    expect(error(['2 action(((1, 0), (0, 1)))'])).toMatch(/whole statement/);
    expect(error(['action(((x, 0), (0, 1)))'])).toMatch(/constant matrix/);
  });
});

describe('matrix fields', () => {
  it('draws a 2×2 in x and y as glyphs', () => {
    const o = row(['((x, y), (y, -x))']).r.cls!.object;
    if (o.kind !== 'tensor-field') throw new Error(o.kind);
    expect(o.entries.map(e => at(e, 2, 3))).toEqual([2, 3, 3, -2]);
  });
  it('jacobian is the matrix of partials, hessian of second partials', () => {
    const j = row(['jacobian((x^2 - y^2, 2 x y))']).r.cls!.object;
    if (j.kind !== 'tensor-field') throw new Error(j.kind);
    expect(j.entries.map(e => at(e, 1, 2))).toEqual([2, -4, 4, 2]);
    const h = row(['f(x, y) = x^3 y', 'hessian(f)']).r.cls!.object;
    if (h.kind !== 'tensor-field') throw new Error(h.kind);
    expect(h.entries.map(e => at(e, 1, 2))).toEqual([12, 3, 3, 0]);
    const { r, env } = row(['hessian(x^2 - y^2)']);
    expect(plotReadout(r.cpu!, env)).toBe('= ((2, 0), (0, -2))');
  });
  it('says what it cannot draw', () => {
    expect(error(['jacobian((x y, y z, x z))'])).toMatch(/Only a 2×2 matrix/);
    expect(error(['hessian((x, y))'])).toMatch(/scalar field/);
    expect(error(['jacobian(x y)'])).toMatch(/map of 2 or 3 components/);
  });
  it('keeps a document’s own jacobian', () => {
    expect(row(['jacobian(a) = 2 a', 'jacobian(3)']).r.cls!.object.kind).toBe('value');
  });
});

describe('glyph scale', () => {
  it('is the true size while small and saturates', () => {
    expect(largestSingular(3, 0, 0, 1)).toBeCloseTo(3);
    expect(largestSingular(1, 1, 0, 1)).toBeCloseTo((1 + Math.sqrt(5)) / 2);
    expect(glyphScale(0.01, 0, 0, 0.01)).toBeCloseTo(1, 3);
    expect(glyphScale(100, 0, 0, 1) * 100).toBeCloseTo(1);
    expect(glyphScale(0, 0, 0, 0)).toBe(1);
  });
});
