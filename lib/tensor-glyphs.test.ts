import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { evaluate, type Expr } from './expr.ts';
import { glyphScale, largestSingular, majorAngle } from './glyphs.ts';
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

describe('tensor streamlines', () => {
  /** S e = λ e for e at angle θ, S the symmetric part, λ its larger eigenvalue. */
  function isMajor(a: number, b: number, c: number, d: number) {
    const th = majorAngle(a, b, c, d);
    const o = (b + c) / 2;
    const [ex, ey] = [Math.cos(th), Math.sin(th)];
    const lam = (a + d) / 2 + Math.hypot((a - d) / 2, o);
    expect(a * ex + o * ey).toBeCloseTo(lam * ex, 9);
    expect(o * ex + d * ey).toBeCloseTo(lam * ey, 9);
    expect(th).toBeGreaterThan(-Math.PI / 2 - 1e-12);
    expect(th).toBeLessThanOrEqual(Math.PI / 2);
  }
  it('follows the eigenvector of the larger signed eigenvalue', () => {
    expect(majorAngle(2, 0, 0, -2)).toBeCloseTo(0);
    expect(majorAngle(-2, 0, 0, 2)).toBeCloseTo(Math.PI / 2);
    expect(majorAngle(0, 1, 1, 0)).toBeCloseTo(Math.PI / 4);
    for (const m of [
      [1, 2, 2, -3],
      [-5, 0.3, 0.3, -1],
      [0.2, -4, -4, 0.1],
      [3, 1, -2, 0],
    ] as const)
      isMajor(...m);
  });
  it('reads a non-symmetric matrix by its symmetric part', () => {
    // A pure rotation has an isotropic (zero) symmetric part.
    expect(majorAngle(0, -1, 1, 0)).toBeNaN();
    expect(majorAngle(1, 3, -1, 0)).toBeCloseTo(majorAngle(1, 1, 1, 0));
  });
  it('is undefined where the tensor is isotropic', () => {
    expect(majorAngle(2, 0, 0, 2)).toBeNaN();
    expect(majorAngle(0, 0, 0, 0)).toBeNaN();
    expect(majorAngle(1, 1e-12, 0, 1)).toBeNaN();
  });
});
