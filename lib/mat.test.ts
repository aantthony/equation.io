import { compileGpu } from './compiler.ts';
import { describe, expect, it } from 'vitest';
import { analyze } from '../worker/graph.ts';
import { type Definition, buildDefs, compsOf, scanDefinition } from './defs.ts';
import { evaluate, parseExpr } from './expr.ts';
import { lowerGeom } from './geom.ts';
import type { Seq } from './list.ts';
import { classify } from './plot.ts';
import { advanceState, buildStateSystem, initialState } from './state.ts';

/** A named list's elements (always symbolic here — no data file in sight). */
const items = (seq: Seq): readonly unknown[] => {
  if (seq.kind !== 'list') throw new Error(`expected a symbolic list, got ${seq.kind}`);
  return seq.items;
};

const rows = (...texts: string[]): Definition[] =>
  texts.map(t => scanDefinition(t)).filter((d): d is Definition => d !== null);

/** Build defs, then lower a plot row against them (the recompile pipeline). */
function lowRow(defRows: string[], text: string) {
  const { defs, errors } = buildDefs(rows(...defRows));
  const lowered = lowerGeom(
    parseExpr(text),
    n => compsOf(defs, n),
    n => defs.mats.get(n) ?? null,
  );
  return { defs, errors, lowered };
}

const at = (e: import('./expr.ts').Expr, env: Record<string, number>) => evaluate(e, env);

describe('matrix definitions', () => {
  it('reads a tuple of rows as a matrix, and a bracket of them as points', () => {
    const { defs, errors } = buildDefs(rows('M = ((1, 2), (3, 4))'));
    expect(errors.size).toBe(0);
    expect(defs.mats.get('M')?.length).toBe(2);
    // A bracket is a multiset: of two points, or (nested brackets flatten)
    // of four numbers — never a matrix.
    const points = buildDefs(rows('M = [(1, 2), (3, 4)]')).defs;
    expect(points.mats.has('M')).toBe(false);
    expect(items(points.lists.get('M')!)).toHaveLength(2);
    expect(items(buildDefs(rows('M = [[1, 2], [3, 4]]')).defs.lists.get('M')!)).toHaveLength(4);
  });

  it('accepts named points as rows', () => {
    const { defs, errors } = buildDefs(rows('r1 = (1, 2)', 'r2 = (3, 4)', 'M = (r1, r2)'));
    expect(errors.size).toBe(0);
    const m = defs.mats.get('M')!;
    expect(at(m[0][1], { r1_y: 2 })).toBe(2);
  });

  it('rejects ragged tuples of rows; non-square ones are tuples of points; brackets are data lists', () => {
    expect(buildDefs(rows('M = ((1, 2), (3, 4, 5))')).errors.get('M')).toMatch(/2×2 or 3×3/);
    // Not square, so no matrix: a tuple of points, kept in order (§3).
    for (const text of ['M = ((1, 2), (3, 4), (5, 6))', 'M = ((1, 2, 3), (4, 5, 6))']) {
      const { defs, errors } = buildDefs(rows(text));
      expect(errors.get('M')).toBeUndefined();
      expect(defs.mats.has('M')).toBe(false);
      expect(defs.lists.get('M')?.axes?.[0].ordered).toBe(true);
    }
    expect(buildDefs(rows('M = [(1, 2), (3, 4, 5)]')).errors.get('M')).toMatch(/same number of coordinates/);
    // Not matrices: a bracket of tuples is a named scatter, a flat list is a
    // named data list (list.ts).
    expect(items(buildDefs(rows('M = [(1, 2), (3, 4), (5, 6)]')).defs.lists.get('M')!)).toHaveLength(3);
    expect(items(buildDefs(rows('M = [1, 2, 3]')).defs.lists.get('M')!)).toHaveLength(3);
  });

  it('rejects a bare matrix name in scalar context', () => {
    const { errors } = buildDefs(rows('M = ((1, 2), (3, 4))', 'c = M + 1'));
    expect(errors.get('c')).toMatch(/Cannot add a matrix and a number/);
  });
});

describe('det, trace, matvec, solve', () => {
  const M2 = 'M = ((1, 2), (3, 4))';
  const M3 = 'M = ((2, 0, 1), (1, 3, 0), (0, 1, 1))';

  it('det and trace expand to scalars', () => {
    expect(at(lowRow([M2], 'det(M)').lowered, {})).toBe(-2);
    expect(at(lowRow([M2], 'trace(M)').lowered, {})).toBe(5);
    expect(at(lowRow([M3], 'det(M)').lowered, {})).toBe(2 * 3 - 0 + 1 * 1); // 7
    expect(at(lowRow([M3], 'trace(M)').lowered, {})).toBe(6);
  });

  it('M v multiplies a tuple, a named point, and a 3-vector', () => {
    const mv = lowRow([M2], 'M (5, 6)').lowered as { items: [never, never] };
    expect(mv.items.map(e => at(e, {}))).toEqual([17, 39]);
    const named = lowRow([M2, 'p = (5, 6)'], 'M p').lowered as { items: [never, never] };
    expect(named.items.map(e => at(e, { p_x: 5, p_y: 6 }))).toEqual([17, 39]);
    const mv3 = lowRow([M3], 'M (1, 1, 1)').lowered as { items: never[] };
    expect(mv3.items.map(e => at(e, {}))).toEqual([3, 4, 2]);
  });

  it('solve inverts the matvec, 2×2 and 3×3', () => {
    const s2 = lowRow([M2], 'solve(M, (17, 39))').lowered as { items: never[] };
    expect(s2.items.map(e => at(e, {}))).toEqual([5, 6]);
    const s3 = lowRow([M3], 'solve(M, (3, 4, 2))').lowered as { items: never[] };
    for (const [got, want] of s3.items.map((e, k) => [at(e, {}), [1, 1, 1][k]])) {
      expect(got).toBeCloseTo(want as number, 12);
    }
  });

  it('solve takes an inline literal matrix', () => {
    const s = lowRow([], 'solve(((0, 1), (1, 0)), (7, 9))').lowered as { items: never[] };
    expect(s.items.map(e => at(e, {}))).toEqual([9, 7]);
  });

  it('keeps slider constants symbolic through the expansion', () => {
    // det of a slider-backed matrix compiles to a GLSL field in u_a.
    const { defs, lowered } = lowRow(['a = 2', 'M = ((a, 0), (0, a))'], 'y = det(M) x');
    const cls = classify(lowered, new Set(defs.consts.keys()));
    expect(cls.params).toEqual(['a']);
    expect((compileGpu(cls) as { field: string }).field).toContain('u_a');
  });

  it('errors name the mismatch', () => {
    expect(() => lowRow([M2], 'M (1, 2, 3)')).toThrow(/2×2.*2-component/);
    expect(() => lowRow([M2], 'solve(M, 1)')).toThrow(/2-component vector/);
    expect(() => lowRow([M2], '(1, 2) M')).toThrow(/multiply on the left/);
    expect(() => lowRow([], 'det(3)')).toThrow(/takes a matrix/);
  });
});

describe('matrices with states', () => {
  it("drives a linear phase portrait: (x', y') = A (x, y)", () => {
    const { defs, lowered } = lowRow(['A = ((0, 1), (-1, -0.2))'], "(x', y') = A (x, y)");
    const cls = classify(lowered, new Set(defs.consts.keys()));
    expect(compileGpu(cls)).toMatchObject({ type: 'vfield2d' });
  });

  it("om' = solve(M, f) matches the hand-derived double pendulum", () => {
    // Lagrangian form: M(th) om' = f(th, om), against the explicit formulas
    // used by the examples menu. Same physics, so the trajectories agree.
    const matrix = [
      'g = 9.8',
      'M = ((2, cos(th_1 - th_2)), (cos(th_1 - th_2), 1))',
      'f = (-om_2^2 sin(th_1 - th_2) - 2 g sin(th_1), om_1^2 sin(th_1 - th_2) - g sin(th_2))',
      "th' = om",
      "om' = solve(M, f)",
      'th(0) = (2.5, 2.4)',
    ];
    // The examples-menu formulas with m1 = m2 = L1 = L2 = 1 substituted.
    const explicit = [
      'g = 9.8',
      'D = 3 - cos(2a - 2b)',
      "a' = p",
      "b' = q",
      "p' = (-3g sin(a) - g sin(a-2b) - 2sin(a-b)(q^2 + p^2 cos(a-b)))/D",
      "q' = (2sin(a-b)(2p^2 + 2g cos(a) + q^2 cos(a-b)))/D",
      'a(0) = 2.5',
      'b(0) = 2.4',
    ];
    const run = (texts: string[]) => {
      const { defs, errors } = buildDefs(rows(...texts));
      expect([...errors.entries()]).toEqual([]);
      const sys = buildStateSystem(defs)!;
      const values = initialState(defs, sys);
      let now = 0;
      for (let fme = 1; fme <= 120; fme++) now = advanceState(defs, sys, values, now, fme / 60);
      return values;
    };
    const m = run(matrix);
    const e = run(explicit);
    expect(m.th_1).toBeCloseTo(e.a, 6);
    expect(m.th_2).toBeCloseTo(e.b, 6);
    expect(m.om_1).toBeCloseTo(e.p, 6);
    expect(m.om_2).toBeCloseTo(e.q, 6);
  });

  it('solve works inside a vector-state derivative', () => {
    // (State-dependent entries are covered by the pendulum test above, where
    // M carries cos(th_1 - th_2) and is re-evaluated at every RK4 stage.)
    const { defs, errors } = buildDefs(rows('M = ((1, 0), (0, 1))', "r' = solve(M, (r_2, -r_1))", 'r(0) = (1, 0)'));
    expect(errors.size).toBe(0);
    const sys = buildStateSystem(defs)!;
    const values = initialState(defs, sys);
    let now = 0;
    for (let f = 1; f <= 120; f++) now = advanceState(defs, sys, values, now, f / 60);
    expect(values.r_1).toBeCloseTo(Math.cos(2), 5);
    expect(values.r_2).toBeCloseTo(-Math.sin(2), 5);
  });
});

describe('matrix algebra and the exponential', () => {
  const J = 'J = ((0, -1), (1, 0))';
  const point = (defRows: string[], text: string, env: Record<string, number> = {}): number[] => {
    const { lowered } = lowRow(defRows, text);
    if (lowered.kind !== 'vec') throw new Error(`expected a point, got ${lowered.kind}`);
    return lowered.items.map(c => at(c, { e: Math.E, pi: Math.PI, ...env }));
  };
  const close = (got: number[], want: number[]) => got.forEach((g, k) => expect(g).toBeCloseTo(want[k], 9));

  it('rotates by e^(a J), exactly cos and sin of the angle kept apart', () => {
    close(point([J], 'e^(a J) (1, 0)', { a: Math.PI / 2 }), [0, 1]);
    close(point([J], 'exp(-a J) (1, 0)', { a: Math.PI / 2 }), [0, -1]);
    close(point([J], 'e^(a J) (1, 0)', { a: 0 }), [1, 0]);
    // No square roots or guards: the angle is the scalar factor itself.
    expect(JSON.stringify(lowRow([J], 'e^(a J) (1, 0)').lowered)).not.toMatch(/sqrt|piecewise/);
  });
  it('exponentiates any 2×2: spirals, saddles and the defective case', () => {
    // Against the power series, on both sides of δ = 0 and at it.
    const series = (m: number[][]): number[][] => {
      let term = [
        [1, 0],
        [0, 1],
      ];
      let sum = [
        [1, 0],
        [0, 1],
      ];
      for (let k = 1; k < 40; k++) {
        term = term.map(r => [0, 1].map(c => (r[0] * m[0][c] + r[1] * m[1][c]) / k));
        sum = sum.map((r, i) => r.map((v, c) => v + term[i][c]));
      }
      return sum;
    };
    for (const m of [
      [
        [0.1, -1],
        [1, 0.3],
      ],
      [
        [0, 1],
        [1, 0],
      ],
      [
        [1, 1],
        [0, 1],
      ],
      [
        [2, 0],
        [0, -1],
      ],
      [
        [0, 0],
        [0, 0],
      ],
    ]) {
      const want = series(m);
      const def = `A = ((${m[0].join(', ')}), (${m[1].join(', ')}))`;
      close(point([def], 'e^(1 A) (1, 0)'), [want[0][0], want[1][0]]);
      close(point([def], 'exp(A) (0, 1)'), [want[0][1], want[1][1]]);
    }
  });
  it('rotates about an axis with cross(n), including a zero axis and zero angle', () => {
    close(point([], 'e^(a cross((0, 0, 1))) (1, 0, 0)', { a: Math.PI / 2 }), [0, 1, 0]);
    close(point([], 'e^(a cross((0, 0, 2))) (1, 0, 0)', { a: Math.PI / 4 }), [0, 1, 0]);
    close(point([], 'e^(a cross((1, 1, 1)/sqrt(3))) (1, 0, 0)', { a: (2 * Math.PI) / 3 }), [0, 1, 0]);
    close(point(['b = 0', 'n = (0, 0, b)'], 'e^(a cross(n)) (1, 0, 0)', { a: 1, n_x: 0, n_y: 0, n_z: 0 }), [1, 0, 0]);
    close(point(['b = 0', 'n = (0, 0, b)'], 'e^(a cross(n)) (1, 0, 0)', { a: 0, n_x: 0, n_y: 0, n_z: 1 }), [1, 0, 0]);
    expect(() => lowRow(['S = ((1, 0, 0), (0, 1, 0), (0, 0, 1))'], 'e^(a S) (1, 0, 0)')).toThrow(/rotation generator/);
  });
  it('combines matrices: scale, sum, product, powers and the inverse', () => {
    const M = 'M = ((1, 2), (3, 4))';
    close(point([M, J], '(2 M) (1, 0)'), [2, 6]);
    close(point([M, J], '(M + J) (1, 0)'), [1, 4]);
    close(point([M, J], '(M - M/2) (1, 0)'), [0.5, 1.5]);
    close(point([M, J], 'M J (1, 0)'), [2, 4]);
    close(point([M], 'M^2 (1, 0)'), [7, 15]);
    close(point([M], 'M^0 (5, 6)'), [5, 6]);
    close(point([M], 'M^-1 (M (5, 6))'), [5, 6]);
    close(point(['N = ((2, 0, 1), (1, 3, 0), (0, 1, 4))'], 'N^-1 (N (5, 6, 7))'), [5, 6, 7]);
    expect(at(lowRow([M], 'det(M^2)').lowered, {})).toBe(4);
    expect(() => lowRow([M], 'M^9 (1, 0)')).toThrow(/0 to 8/);
    expect(() => lowRow([M], 'M^0.5 (1, 0)')).toThrow(/e\^\(th J\)/);
    expect(() => lowRow([M], 'M + 1')).toThrow(/matrix and a number/);
    expect(() => lowRow([M], '2^M (1, 0)')).toThrow(/Only e/);
    expect(() => lowRow([M], 'e^(a/2 M) (1, 0)')).toThrow(/\(a\/2\) J/);
    expect(() => lowRow([M], '2 M')).toThrow(/not a value on its own/);
    expect(analyze([M, '2 M']).rows[1].error).toMatch(/not a value on its own/);
    expect(() => lowRow([M], '(1, 0) M')).toThrow(/on the left/);
  });
  it('names a computed matrix', () => {
    const { defs, errors } = buildDefs(rows(J, 'a = 1', 'R = e^(a J)', 'Q = R R^-1'));
    expect(errors.size).toBe(0);
    expect(defs.mats.has('R')).toBe(true);
    close(point([J, 'a = 1', 'R = e^(a J)'], 'R (1, 0)', { a: Math.PI }), [-1, 0]);
  });
  it('rotate is the same turn, about a centre or an axis', () => {
    close(point([], 'rotate((1, 0), a)', { a: Math.PI / 2 }), [0, 1]);
    close(point([], 'rotate((1, 0), a, (1, 1))', { a: Math.PI }), [1, 2]);
    close(
      point(['P = (1, 0)', 'C = (1, 1)'], 'rotate(P, a, C)', { a: Math.PI, P_x: 1, P_y: 0, C_x: 1, C_y: 1 }),
      [1, 2],
    );
    close(point([], 'rotate((1, 0, 0), a, (0, 0, 5))', { a: Math.PI / 2 }), [0, 1, 0]);
    expect(() => lowRow([], 'rotate((1, 0))')).toThrow(/rotate takes/);
  });
});
