import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { type Column, evaluate, type Expr } from './expr.ts';
import { vertexSampler } from './figure-vertices.ts';
import { plotReadout } from './plot.ts';

/**
 * Multivectors and quaternions through the whole analysis (docs/clifford.md):
 * what a row reads out, what it draws, and where a multivector reduces to
 * the number or point it is written as.
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
const kinds = (rows: string[]): string[] => {
  const o = row(rows).r.cls!.object;
  return o.kind === 'family' ? o.members.map(m => (m.object as { form?: string }).form ?? m.object.kind) : [o.kind];
};
const point = (rows: string[]): number[] => {
  const { r, env } = row(rows);
  const o = r.cls!.object;
  if (o.kind !== 'point' || o.source.representation !== 'real') throw new Error(`expected a point, got ${o.kind}`);
  return o.source.coordinates.map((c: Expr) => Math.round(evaluate(c, env) * 1e9) / 1e9 + 0);
};
const error = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!.error;

describe('the geometric product', () => {
  it('makes blades of vectors, and numbers of parallel ones', () => {
    expect(readout(['e_x ⟑ e_y'])).toBe('= e_xy');
    expect(readout(['gp(e_x, e_y, e_z)'])).toBe('= e_xyz');
    expect(readout(['e_x ⟑ e_x'])).toBe('= 1');
    expect(readout(['(1, 2, 3) ⟑ (4, 5, 6)'])).toBe('= 32 - 3 e_xy - 3 e_yz + 6 e_zx');
  });
  it('is juxtaposition once a multivector is involved, and not before', () => {
    expect(readout(['e_xy e_xy'])).toBe('= -1');
    expect(point(['e_xy (1, 0, 0)'])).toEqual([0, -1, 0]);
    expect(error(['e_x e_y'])).toMatch(/A · B or A × B/);
    // Two vectors wedge as tensors; a multivector makes it the outer product.
    expect(row(['e_x ∧ e_y']).r.cls!.object.kind).toBe('tuple');
    expect(readout(['e_x ∧ e_yz'])).toBe('= e_xyz');
  });
  it('reads names written in any order', () => {
    expect(readout(['e_yx'])).toBe('= -e_xy');
    expect(readout(['e_xz + e_zx'])).toBe('= 0');
  });
  it('keeps a document’s own e_xy', () => {
    expect(readout(['e_xy = 3', '2 e_xy'])).toBe('= 6');
  });
  it('refuses division by a multivector, which a/2 e_xy would quietly be', () => {
    expect(error(['-pi/4 e_xy'])).toMatch(/\(a\/2\) e_xy/);
    expect(readout(['A = 1 + e_xy', 'A A^-1'])).toBe('= 1');
    expect(readout(['e_xy / 2'])).toBe('= 0.5 e_xy');
  });
});

describe('drawing', () => {
  it('draws each grade', () => {
    expect(kinds(['e_x ⟑ e_y'])).toEqual(['polygon', 'vector']);
    expect(kinds(['1 + e_x + e_xy'])).toEqual(['polygon', 'vector', 'vector']);
    expect(kinds(['e_xyz'])).toEqual(['hull']);
    expect(row(['e_xyz']).r.cls!.needs3D).toBe(true);
    expect(row(['(1, 0) ⟑ (0, 1)']).r.cls!.needs3D).toBe(false);
  });
  it('gives the disc the bivector’s area', () => {
    const { r, env } = row(['3 e_xy']);
    const o = r.cls!.object as { members: Array<{ object: { vertices: Expr[]; over?: Column[] } }> };
    const rim = o.members[0].object;
    const vs = vertexSampler(rim.vertices, rim.over)(env);
    const pts = Array.from({ length: vs.length / 3 }, (_, k) => vs.slice(3 * k, 3 * k + 3));
    let area = 0;
    pts.forEach(([x0, y0, z0], k) => {
      const [x1, y1] = pts[(k + 1) % pts.length];
      area += x0 * y1 - x1 * y0;
      expect(z0).toBeCloseTo(0);
    });
    // A 48-gon inscribed in the circle of area 3.
    expect(area / 2).toBeCloseTo(3 * (48 / (2 * Math.PI)) * Math.sin((2 * Math.PI) / 48), 6);
  });
  it('writes a large coefficient once, not once per rim vertex', () => {
    // A slerp's coefficients are long; the rim is one template over columns.
    const kinds = row(['slerp(quat(1, 0, 0, 0), quat(0, 1, 1, 1), 0.5)']).r.cls!.object;
    expect(kinds.kind).toBe('family');
  });
  it('reads out a multiset of multivectors', () => {
    expect(readout(['[1, 2] e_xy'])).toBe('= [e_xy, 2 e_xy]');
  });
  it('has no picture in x or u', () => {
    expect(error(['x e_xy'])).toMatch(/no picture yet/);
  });
});

describe('rotors', () => {
  it('turn a vector by the sandwich, which reduces to a point', () => {
    expect(point(['R = e^(-(pi/4) e_xy)', 'grade(R ⟑ e_x ⟑ rev(R), 1)'])).toEqual([0, 1, 0]);
    expect(point(['R = e^(-(pi/4) e_xy)', 'R e_x rev(R)'])).toEqual([0, 1, 0]);
    expect(point(['R = e^(-(pi/4) e_xy)', 'rotate((1, 0, 0), R)'])).toEqual([0, 1, 0]);
    expect(readout(['e^(-(pi/4) e_xy)'])).toBe('≈ 0.707107 - 0.707107 e_xy');
  });
  it('turn figures and lists of points', () => {
    expect(row(['R = e^(-(t/2) e_xy)', 'rotate(polygon((1,0,0),(0,1,0),(0,0,1)), R)']).r.cls!.object.kind).toBe(
      'figure',
    );
    expect(row(['P = [(1,0,0),(0,1,0)]', 'rotate(P, quat(1, 1, 0, 0))']).r.cls!.object.kind).toBe('list');
  });
  it('take the dual and the grades', () => {
    expect(point(['dual(e_xy)'])).toEqual([0, 0, 1]);
    expect(readout(['grade((1, 2, 3) ⟑ (4, 5, 6), 0)'])).toBe('= 32');
    expect(error(['grade(e_xy, 5)'])).toMatch(/grade from 0 to 3/);
    expect(readout(['|quat(1, 1, 1, 1)|'])).toBe('= 2');
  });
});

describe('quaternions', () => {
  it('multiply as i² = j² = k² = ijk = −1', () => {
    expect(readout(['quat(0, 1, 0, 0) quat(0, 0, 1, 0)'])).toBe('= k');
    expect(readout(['i1 = quat(0, 1, 0, 0)', 'i1 i1'])).toBe('= -1');
    expect(readout(['q = quat(1, 2, 3, 4)', 'q^-1 q'])).toBe('= 1');
    expect(readout(['conj(quat(1, 2, 3, 4))'])).toBe('= 1 - 2i - 3j - 4k');
  });
  it('turn about their axis', () => {
    expect(point(['th = pi/2', 'q = quat(cos(th/2), sin(th/2) (0, 0, 1))', 'rotate((1, 0, 0), q)'])).toEqual([0, 1, 0]);
  });
  it('slerp the shorter arc', () => {
    expect(readout(['slerp(quat(1, 0, 0, 0), quat(0, 0, 0, 1), 0.5)'])).toBe('≈ 0.707107 + 0.707107k');
  });
  it('are named and described as quaternions', () => {
    const analysis = analyzeRows(['q = quat(1, 2, 3, 4)', 'q'], { readouts: true });
    expect(analysis.rows[1].error).toBeUndefined();
    expect(error(['quat(1, 2)'])).toMatch(/quat\(w, x, y, z\)/);
  });
});

describe('quaternion Julia sets', () => {
  it('draw as the implicit surface of the orbit’s Green function', () => {
    const { r } = row(['c = quat(-0.2, 0.8, 0, 0)', 'qjulia(c)']);
    expect(r.cpu!.type).toBe('implicit3d');
    const residual = (r.cpu as { residual: Expr }).residual;
    const at = (x: number, y: number, z: number) => evaluate(residual, { x, y, z });
    // Far away the orbit escapes at once, well above the level; at a point of
    // the filled set (0 lies in it for this c) it stays below.
    expect(at(2, 2, 2)).toBeGreaterThan(0);
    expect(at(0, 0, 0)).toBeLessThan(0);
  });
  it('takes a slice, and says what it takes', () => {
    expect(row(['qjulia(quat(-0.2, 0.8, 0, 0), 0.3)']).r.cpu!.type).toBe('implicit3d');
    expect(error(['qjulia(2)'])).toMatch(/qjulia takes a quaternion/);
    expect(error(['1 + qjulia(quat(0, 0, 0, 0))'])).toMatch(/whole statement/);
  });
});
