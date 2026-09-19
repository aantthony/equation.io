import { describe, expect, it } from 'vitest';
import { evaluate } from '../lib/expr.ts';
import { toGLSL } from '../lib/glsl.ts';
import { analyze } from './graph.ts';
import { compileProg, run as runProg } from './vm.ts';

/** [error ?? plot type, readout] per row. */
const out = (texts: string[]) => analyze(texts).rows.map(r => [r.error ?? r.cls?.plot.type ?? 'def', r.info]);

describe('distance / angle through analyze()', () => {
  it('take any single point, however it was computed', () => {
    const rows = out(['M = [(1, 2), (3, 4)]', 'L = [1, 2, 3]', 'A = (1, 2)', 'B = (5, 11)',
      'distance(M A, B)', 'distance(A, det(M) B)', 'distance(A, (mean(L), 2))',
      'distance(A, (total(L), count(L)))', 'distance(A, (L[1], 5))', 'angle(A, (0, 0), (total(L), -3))']);
    expect(rows.slice(4)).toEqual([
      ['value', '= 0'], ['value', '≈ 26.4008'], ['value', '= 1'], ['value', '≈ 5.09902'], ['value', '= 3'],
      ['value', '≈ -1.5708'],
    ]);
  });

  it('broadcast over a scalar list exactly as |A - B| does', () => {
    const rows = analyze(['L = [1, 2, 3]', 'A = (0, 0)', '|A - (L, 0)|', 'distance(A, (L, 0))',
      'f(k) = distance(A, (k, 0))', 'f(L)', 'angle((1, 0), A, (L, L))', 'total(angle((1, 0), (0, L)))']).rows;
    expect(rows.map(r => r.error)).toEqual(Array(8).fill(undefined));
    expect(rows[3].cls!.plot).toEqual(rows[2].cls!.plot);
    expect(rows[5].cls!.plot).toEqual(rows[2].cls!.plot);
    expect(rows[6].cls!.plot.type).toBe(rows[2].cls!.plot.type);
    expect(rows[7].info).toBe(`≈ ${Number((1.5 * Math.PI).toPrecision(6))}`);
  });

  it('say so when a list stands where a point should', () => {
    const rows = out(['P = [(0, 0), (1, 1)]', 'L = [1, 2, 3]', 'A = (1, 2)',
      'distance(P, A)', 'distance(A, L)', 'angle(A, [A, A], A)']);
    for (const [msg] of rows.slice(3)) expect(msg).toMatch(/a list cannot stand for a point yet/);
  });

  it('names the list whenever one is why the points do not pair up', () => {
    const rows = out(['P = [(0, 0), (1, 1), (2, 2)]', 'L = [1, 2, 3]', 'A = (1, 2)', 'B = (3, 1)',
      'distance(2L, A)', 'distance(-P, A)', 'distance(sort(L), A)', 'distance([1..3] + 1, A)',
      'angle(A, P[1], B)', 'distance(A, P[2])',
      'distance(A, total(L))', 'distance(P, L, A)', 'angle(P, L, A, B)']);
    for (const [msg] of rows.slice(4, 8)) expect(msg).toMatch(/a list cannot stand for a point yet/);
    // An element of a point list is a point on its own row, but not yet a
    // point *value* (P[2] + A fails the same way): that is plan #13's.
    for (const [msg] of rows.slice(8, 10)) expect(msg).toMatch(/an element of a list cannot stand for a point yet.*name it first|name the point/);
    // A reduction is one number, so no list is to blame here...
    expect(rows[10][0]).toMatch(/^distance takes two points/);
    // ...and a list of points that does pair up (as a "component") is refused
    // by list lowering, in its own true words.
    expect(rows[11][0]).toMatch(/list of points is not supported yet/);
    expect(rows[12][0]).toMatch(/list of points is not supported yet/);
  });

  it('never shows the internal [angle] name', () => {
    const rows = out(['B = (3, 1)', 'angle((i, 0), B)']);
    expect(rows[1][0]).toBe('angle is not supported for complex values.');
    const bad = { kind: 'call' as const, name: '[angle]', args: [{ kind: 'num' as const, value: 1 }] };
    expect(() => compileProg(bad, new Map())).toThrow(/^Cannot evaluate angle\(\) here\.$/);
  });

  it('tiny arms still have a direction; only a zero arm is undefined', () => {
    const rows = out(['k = 10^(-200)', 'angle((k, 0), (0, k))', 'angle((k, 0), (0, 0), (0, 1))', 'angle((0, 0), (0, k))']);
    expect(rows.slice(1)).toEqual([['value', '≈ 1.5708'], ['value', '≈ 1.5708'], ['value', 'undefined']]);
  });

  it('a straight angle is π on the CPU, in the og VM and in GLSL, with no foldable + 0', () => {
    const { rows, constEnv } = analyze(['A = (-1, 0)', 'B = (1, 0)', 'angle(A, (0, 0), B)', 'angle(B, (0, 0), A)', 'y = angle(A, (0, 0), B) x']);
    expect(rows[2].info).toBe('≈ 3.14159');
    expect(rows[3].info).toBe('≈ 3.14159');
    for (const r of [rows[2], rows[3]]) {
      const names = Object.keys(constEnv);
      const prog = compileProg(r.expr!, new Map(names.map((n, i) => [n, i])));
      expect(runProg(prog, names.map(n => constEnv[n]), new Float64Array(prog.depth))).toBe(Math.PI);
      expect(evaluate(r.expr!, constEnv)).toBe(Math.PI);
    }
    const glsl = toGLSL(rows[4].expr!);
    expect(glsl).not.toContain('+ 0.0');
    expect(glsl).toContain('eq_angle(');
  });
});
