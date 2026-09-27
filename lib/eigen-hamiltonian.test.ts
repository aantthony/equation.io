import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { evaluate, type Expr } from './expr.ts';
import { publicKind } from './math-object.ts';
import { plotReadout } from './plot.ts';

/** eigen(M) and transpose(M) (lib/glyphs.ts, lib/mat.ts), and hamiltonian(H)
 *  (lib/defs.ts, lib/plot.ts). */
function row(rows: string[]) {
  const analysis = analyzeRows(rows, { readouts: true });
  const r = analysis.rows.at(-1)!;
  if (r.error) throw new Error(r.error);
  return { r, env: { ...analysis.constEnv, t: 0 } };
}
const error = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!.error;

type Mat = number[][];
const apply = (m: Mat, v: number[]) => m.map(row => row.reduce((s, a, k) => s + a * v[k], 0));

/** What eigen(M) draws, per real eigenvalue: its line's direction and the
 *  arrow λ v, evaluated. */
function eigen(m: Mat, prefix: string[] = []) {
  const text = `(${m.map(r => `(${r.join(', ')})`).join(', ')})`;
  const { r, env } = row([...prefix, `eigen(${text})`]);
  const o = r.cls!.object;
  if (o.kind !== 'family') throw new Error(o.kind);
  const n = m.length;
  const members = o.members.map(mm => {
    const f = mm.object as { form: string; vertices: Expr[] };
    return { form: f.form, v: f.vertices.map(e => evaluate(e, env)) };
  });
  const pairs: { line: number[]; arrow: number[] }[] = [];
  for (let k = 0; k < members.length; k += 2) {
    expect(members[k].form).toBe('segment');
    expect(members[k + 1].form).toBe('vector');
    pairs.push({ line: members[k].v.slice(n), arrow: members[k + 1].v.slice(n) });
  }
  return { readout: plotReadout(r.cpu!, env), pairs, kind: publicKind(o), needs3D: r.cls!.needs3D };
}

/** Each drawn line is invariant: M d = λ d, and the arrow is λ times the
 *  unit vector along it. */
function expectInvariant(m: Mat, pairs: { line: number[]; arrow: number[] }[], lambdas: number[]) {
  expect(pairs.map(p => p.line.every(Number.isFinite))).toEqual(lambdas.map(() => true));
  pairs.forEach(({ line, arrow }, k) => {
    const len = Math.hypot(...line);
    const d = line.map(c => c / len);
    const md = apply(m, d);
    md.forEach((c, i) => expect(c).toBeCloseTo(lambdas[k] * d[i], 9));
    arrow.forEach((c, i) => expect(c).toBeCloseTo(lambdas[k] * d[i], 9));
  });
}

describe('eigen(M)', () => {
  it('reads out the eigenvalues and draws the lines M keeps', () => {
    const m = [
      [2, 1],
      [1, 2],
    ];
    const { readout, pairs, kind } = eigen(m);
    expect(readout).toBe('= (3, 1)');
    expect(kind).toBe('eigen');
    expectInvariant(m, pairs, [3, 1]);
  });
  it('finds the invariant lines of a matrix that is not symmetric', () => {
    const m = [
      [1, 2],
      [3, 4],
    ];
    const { readout, pairs } = eigen(m);
    const s = Math.sqrt(33) / 2;
    expect(readout).toBe(`≈ (${+(2.5 + s).toPrecision(6)}, ${+(2.5 - s).toPrecision(6)})`);
    expectInvariant(m, pairs, [2.5 + s, 2.5 - s]);
    // A zero off the diagonal leaves one candidate empty; the other is used.
    expectInvariant(
      [
        [1, 0],
        [5, 2],
      ],
      eigen([
        [1, 0],
        [5, 2],
      ]).pairs,
      [2, 1],
    );
  });
  it('flips along a negative eigenvalue', () => {
    const m = [
      [0, 1],
      [1, 0],
    ];
    const { readout, pairs } = eigen(m);
    expect(readout).toBe('= (1, -1)');
    expectInvariant(m, pairs, [1, -1]);
  });
  it('reads a rotation’s eigenvalues as a complex pair and draws no line', () => {
    const { readout, pairs } = eigen([
      [0, -1],
      [1, 0],
    ]);
    expect(readout).toBe('= (0 + 1i, 0 − 1i)');
    for (const { line } of pairs) expect(line.every(Number.isNaN)).toBe(true);
    expect(
      eigen([
        [1, -2],
        [2, 1],
      ]).readout,
    ).toBe('= (1 + 2i, 1 − 2i)');
  });
  it('draws a shear’s one line twice, and nothing for a multiple of I', () => {
    const shear = [
      [1, 1],
      [0, 1],
    ];
    const { readout, pairs } = eigen(shear);
    expect(readout).toBe('= (1, 1)');
    expectInvariant(shear, pairs, [1, 1]);
    const scalar = eigen([
      [2, 0],
      [0, 2],
    ]);
    expect(scalar.readout).toBe('= (2, 2)');
    for (const { line } of scalar.pairs) expect(line.every(Number.isNaN)).toBe(true);
  });
  it('solves a 3×3 in closed form, in space', () => {
    const m = [
      [2, 0, 0],
      [0, 3, 4],
      [0, 4, 9],
    ];
    const { readout, pairs, needs3D } = eigen(m);
    expect(needs3D).toBe(true);
    expect(readout).toBe('= (11, 2, 1)');
    expectInvariant(m, pairs, [11, 2, 1]);
    const general = [
      [4, 1, 2],
      [0, 3, 1],
      [1, 0, 2],
    ];
    // λ³ − 9λ² + 24λ − 19 has three real roots, in (1, 2), (2, 3) and
    // (4, 5): they sum to the trace and multiply to the determinant, and each
    // drawn line is invariant with its arrow's λ.
    const g = eigen(general);
    const lambdas = g
      .readout!.replace(/^[=≈] \(|\)$/g, '')
      .split(', ')
      .map(Number);
    expect(lambdas).toHaveLength(3);
    expect(lambdas.reduce((a, b) => a + b)).toBeCloseTo(9, 4);
    expect(lambdas.reduce((a, b) => a * b)).toBeCloseTo(19, 3);
    expect(lambdas.map(Math.floor)).toEqual([4, 2, 1]);
    expectInvariant(
      general,
      g.pairs,
      g.pairs.map(p => {
        const len = Math.hypot(...p.line);
        return p.arrow.reduce((s, c, k) => s + (c * p.line[k]) / len, 0);
      }),
    );
  });
  it('reads a 3×3 turn as one real eigenvalue and a complex pair', () => {
    const m = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 2],
    ];
    const { readout, pairs } = eigen(m);
    expect(readout).toBe('= (2, 0 + 1i, 0 − 1i)');
    expectInvariant(m, pairs.slice(0, 1), [2]);
    for (const { line } of pairs.slice(1)) expect(line.every(Number.isNaN)).toBe(true);
  });
  it('follows sliders and named matrices', () => {
    expect(eigen([['a', 1] as unknown as number[], [0, 2]], ['a = 5']).readout).toBe('= (5, 2)');
    expect(row(['M = ((2, 1), (1, 2))', 'eigen(M)']).r.cls!.object.kind).toBe('family');
  });
  it('takes one constant matrix, on a row of its own', () => {
    expect(error(['eigen(3)'])).toMatch(/2×2 or 3×3 matrix/);
    expect(error(['2 eigen(((1, 0), (0, 1)))'])).toMatch(/whole statement/);
    expect(error(['eigen(((x, 0), (0, 1)))'])).toMatch(/constant matrix/);
  });
});

describe('transpose(M)', () => {
  it('swaps rows and columns, and works inside products', () => {
    const { r, env } = row(['M = ((1, 2), (3, 4))', 'transpose(M)']);
    expect(plotReadout(r.cpu!, env)).toBe('= ((1, 3), (2, 4))');
    const p = row(['M = ((1, 2), (3, 4))', 'transpose(M) M']);
    expect(plotReadout(p.r.cpu!, p.env)).toBe('= ((10, 14), (14, 20))');
    expect(error(['transpose(3)'])).toMatch(/takes a matrix/);
  });
});

describe('hamiltonian(H)', () => {
  it('flows along the level sets of H: q′ = ∂H/∂p, p′ = −∂H/∂q', () => {
    const { r } = row(['hamiltonian(y^2/2 - cos(x))']);
    const o = r.cls!.object;
    if (o.kind !== 'vector-field') throw new Error(o.kind);
    expect(publicKind(o)).toBe('vfield2d');
    const H = o.levels!.expr;
    for (const [x, y] of [
      [0.3, 1.2],
      [-2, 0.5],
      [1, -1],
    ]) {
      const [dq, dp] = o.components.map(c => evaluate(c, { x, y }));
      expect(dq).toBeCloseTo(y);
      expect(dp).toBeCloseTo(-Math.sin(x));
      // The flow is perpendicular to ∇H, so it keeps H fixed.
      const h = 1e-6;
      const gx = (evaluate(H, { x: x + h, y }) - evaluate(H, { x: x - h, y })) / (2 * h);
      const gy = (evaluate(H, { x, y: y + h }) - evaluate(H, { x, y: y - h })) / (2 * h);
      expect(dq * gx + dp * gy).toBeCloseTo(0, 6);
    }
    expect(r.cpu).toMatchObject({ type: 'vfield2d', levels: { params: [] } });
  });
  it('takes a named H(x, y) and sliders', () => {
    const { r } = row(['k = 2', 'H(x, y) = y^2/2 + k x^2/2', 'hamiltonian(H)']);
    const o = r.cls!.object;
    if (o.kind !== 'vector-field') throw new Error(o.kind);
    expect(o.components.map(c => evaluate(c, { x: 1, y: 3, k: 2 }))).toEqual([3, -2]);
    expect(o.levels!.params).toEqual(['k']);
  });
  it('says which variables it takes', () => {
    expect(error(['hamiltonian(p^2/2 + q^2/2)'])).toMatch(/q as x and p as y/);
    expect(error(['hamiltonian(3)'])).toMatch(/constant/);
    expect(error(['hamiltonian(x + z)'])).toMatch(/x \(the position q\)/);
    expect(error(['hamiltonian((x, y))'])).toMatch(/hamiltonian takes H/);
  });
});
