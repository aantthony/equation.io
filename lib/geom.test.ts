import { describe, expect, it } from 'vitest';
import { type Definition, buildDefs, evalConstEnv, scanDefinition } from './defs.ts';
import { evaluate, parseExpr } from './expr.ts';
import { arrowHead, lowerGeom } from './geom.ts';
import { classify } from './plot.ts';

const POINTS = new Set(['A', 'B', 'C']);
const isPt = (n: string) => (POINTS.has(n) ? [n + '_x', n + '_y'] : null);
const low = (s: string) => lowerGeom(parseExpr(s), isPt);
const env = { A_x: 1, A_y: 2, B_x: 4, B_y: 6, C_x: -1, C_y: 0 };
const evalAt = (s: string) => evaluate(low(s), env);

const defsOf = (rows: string[]) => {
  const raw = rows.map(r => scanDefinition(r)).filter((d): d is Definition => !!d);
  return buildDefs(raw);
};

describe('point arithmetic lowering', () => {
  it('expands a point name to its component constants', () => {
    expect(low('A')).toEqual({
      kind: 'vec',
      items: [{ kind: 'var', name: 'A_x' }, { kind: 'var', name: 'A_y' }],
    });
  });

  it('adds, subtracts, negates, and scales componentwise', () => {
    const at = (s: string) => (low(s) as { items: [never, never] }).items.map(e => evaluate(e, env));
    expect(at('A + B')).toEqual([5, 8]);
    expect(at('B - A')).toEqual([3, 4]);
    expect(at('-A')).toEqual([-1, -2]);
    expect(at('2A')).toEqual([2, 4]);
    expect(at('B/2')).toEqual([2, 3]);
    expect(at('A + 0.5(B - A)')).toEqual([2.5, 4]);
  });

  it('computes dot, cross, |·|, perp, midpoint, unit', () => {
    expect(evalAt('dot(A, B)')).toBe(16);
    expect(evalAt('cross(A, B)')).toBe(-2);
    expect(evalAt('|B - A|')).toBe(5);
    const at = (s: string) => (low(s) as { items: [never, never] }).items.map(e => evaluate(e, env));
    expect(at('perp(A)')).toEqual([-2, 1]);
    expect(at('midpoint(A, B)')).toEqual([2.5, 4]);
    expect(at('unit(B - A)')).toEqual([0.6, 0.8]);
  });

  it('accepts tuple literals as operands', () => {
    const at = (s: string) => (low(s) as { items: [never, never] }).items.map(e => evaluate(e, env));
    expect(at('A + (1, 2)')).toEqual([2, 4]);
    expect(at('((0, 0) + B)/2')).toEqual([2, 3]); // midpoint as plain arithmetic
    expect(at('-(1, 2)')).toEqual([-1, -2]);
    expect(at('2(1, 2)')).toEqual([2, 4]);
    expect(evalAt('|(3, 4)|')).toBe(5);
    expect(evalAt('|B - (1, 2)|')).toBe(5);
    // A parenthesized series after a function name is still an argument list.
    expect(evaluate(low('max(1, 2)'), {})).toBe(2);
  });

  it('pairs flattened tuple literals back into points', () => {
    expect(evalAt('dot(A, (2, 3))')).toBe(8);
    expect(evalAt('dot((1, 0), (0, 1))')).toBe(0);
    const m = low('midpoint((0, 0), B)') as { items: [never, never] };
    expect(m.items.map(e => evaluate(e, env))).toEqual([2, 3]);
  });

  it('leaves scalar expressions untouched (same node identity)', () => {
    const e = parseExpr('sin(x) + a^2');
    expect(lowerGeom(e, isPt)).toBe(e);
  });

  it('leaves vector fields and ODE systems untouched', () => {
    expect(classify(low('(-y, x)')).plot.type).toBe('vfield2d');
    expect(classify(low("(x', y') = (y, -sin(x))")).plot.type).toBe('vfield2d');
  });

  it('rejects invalid point algebra with clear errors', () => {
    expect(() => low('A + 2')).toThrow(/add a point and a number/);
    expect(() => low('A B')).toThrow(/dot\(A, B\) or cross\(A, B\)/);
    expect(() => low('2/A')).toThrow(/divide by a point/);
    expect(() => low('A^2')).toThrow(/length/);
    expect(() => low('sin(A)')).toThrow(/sin is not defined for points/);
    expect(() => low('perp(3)')).toThrow(/write perp\(A\)/);
    expect(() => low('dot(A, 3)')).toThrow(/write dot\(A, B\)/);
    expect(() => low('A < B')).toThrow(/compared/);
    expect(() => low('y = A')).toThrow(/One side is a point/);
    expect(() => low('(A, B)')).toThrow(/segment\(A, B\)/);
  });
});

describe('geometry statements', () => {
  it('segment and polygon desugar to CPU polygon plots', () => {
    const seg = classify(low('segment(A, B)'), new Set(Object.keys(env)));
    expect(seg.plot).toMatchObject({ type: 'polygon', closed: false });
    expect((seg.plot as { pts: never[] }).pts).toHaveLength(4);

    const poly = classify(low('polygon(A, B, C)'), new Set(Object.keys(env)));
    expect(poly.plot).toMatchObject({ type: 'polygon', closed: true });
    expect((poly.plot as { pts: never[] }).pts).toHaveLength(6);
  });

  it('polyline is the open figure through any number of points', () => {
    const c = classify(low('polyline((0, 0), (1, 1), (2, 0))'), new Set()).plot;
    expect(c).toMatchObject({ type: 'polygon', closed: false });
    expect(c).not.toHaveProperty('arrow');
    expect((c as { pts: never[] }).pts.map(e => evaluate(e, {}))).toEqual([0, 0, 1, 1, 2, 0]);
    // Named points and point arithmetic mix with literals; n = 2 is a segment.
    const mixed = classify(low('polyline(A, (A + B)/2, (0, 0), C)'), new Set(Object.keys(env))).plot as { pts: never[] };
    expect(mixed.pts.map(e => evaluate(e, env))).toEqual([1, 2, 2.5, 4, 0, 0, -1, 0]);
    expect((classify(low('polyline(A, B)'), new Set(Object.keys(env))).plot as { pts: never[] }).pts).toHaveLength(4);
  });

  it('vector is an arrow from A to B, or from the origin', () => {
    const ab = classify(low('vector(A, B)'), new Set(Object.keys(env))).plot;
    expect(ab).toMatchObject({ type: 'polygon', closed: false, arrow: true });
    expect((ab as { pts: never[] }).pts.map(e => evaluate(e, env))).toEqual([1, 2, 4, 6]);
    const v = classify(low('vector((1, 2))'), new Set()).plot as { pts: never[] };
    expect(v.pts.map(e => evaluate(e, {}))).toEqual([0, 0, 1, 2]);
    const sum = classify(low('vector(A, A + 2B)'), new Set(Object.keys(env))).plot as { pts: never[] };
    expect(sum.pts.map(e => evaluate(e, env))).toEqual([1, 2, 9, 14]);
    // A pair of points is still not a value: the wrapper has to be asked for.
    expect(() => low('(A, B)')).toThrow(/segment\(A, B\)/);
  });

  it('polyline and vector fail loudly on what they do not cover yet', () => {
    expect(() => low('polyline(A)')).toThrow(/at least 2 points/);
    expect(() => low('vector(A, B, C)')).toThrow(/one or two points/);
    expect(() => low('polyline([(0, 0), (1, 1)])')).toThrow(/one by one.*polyline\(A, B, C\)/);
    expect(() => low('vector([A, B])')).toThrow(/one by one.*vector\(A, B\)/);
    expect(() => low('vector((1, 2, 3))')).toThrow(/2D points, not 3-component/);
    expect(() => low('vector((0, 0), (1, 1), (2, 2))')).toThrow(/one or two points/);
    expect(() => low('polyline(A, 3)')).toThrow(/write polyline\(A, B, C\)/);
    expect(() => low('1 + vector(A, B)')).toThrow(/whole statement/);
    expect(() => low('2 polyline(A, B)')).toThrow(/whole statement/);
  });

  it('arrowHead is a screen-space triangle behind the tip', () => {
    // Shaft along +x: base 10px behind the tip, wings ±4px across it.
    expect(arrowHead(0, 0, 100, 0, 10)).toEqual({ base: [90, 0], left: [90, 4], right: [90, -4] });
    // A shaft shorter than the head shrinks the head to fit it.
    expect(arrowHead(0, 0, 0, 5, 10)!.base).toEqual([0, 0]);
    // No direction, no head.
    expect(arrowHead(3, 3, 3, 3, 10)).toBeNull();
    expect(arrowHead(0, 0, NaN, 0, 10)).toBeNull();
  });

  it('square erects on the left of A→B', () => {
    const sq = classify(low('square((0, 0), (2, 0))'), new Set()).plot as { pts: never[] };
    expect(sq.pts.map(e => evaluate(e, {}))).toEqual([0, 0, 2, 0, 2, 2, 0, 2]);
  });

  it('line desugars to an implicit equation through both points', () => {
    expect(classify(low('line((0, 0), (1, 2))')).plot.type).toBe('implicit2d');
    const e = low('line((0, 0), (1, 2))') as Extract<ReturnType<typeof low>, { kind: 'eq' }>;
    // On-line points zero the field (including beyond the segment); off-line
    // points do not.
    expect(evaluate(e.l, { x: 2, y: 4 })).toBe(0);
    expect(evaluate(e.l, { x: -3, y: -6 })).toBe(0);
    expect(evaluate(e.l, { x: 1, y: 0 })).not.toBe(0);
    expect(() => low('line(A)')).toThrow(/line takes two points/);
  });

  it('circle desugars to an implicit equation', () => {
    const c = classify(low('circle((1, 2), 3)'));
    expect(c.plot.type).toBe('implicit2d');
    // On-circle point (4, 2) zeroes the field: (x-1)^2 + (y-2)^2 - 9.
    const e = low('circle((1, 2), 3)') as { kind: 'eq'; l: never; r: never };
    expect(evaluate(e.l, { x: 4, y: 2 }) - evaluate(e.r, {})).toBe(0);
  });

  it('rejects nested geometry forms and bad arities', () => {
    expect(() => low('1 + segment(A, B)')).toThrow(/whole statement/);
    expect(() => low('polygon(A, B)')).toThrow(/at least 3/);
    expect(() => low('circle(A)')).toThrow(/center, radius/);
    // Unknown names lower to scalars and pair into a single point: the error
    // still points at the fix (define the points above).
    expect(() => lowerGeom(parseExpr('segment(P, Q)'), () => false)).toThrow(/defined above/);
  });

  it('rejects vertices that depend on the plane, named for the statement', () => {
    expect(() => classify(low('segment((x, 0), (1, 1))'))).toThrow(/Segment endpoints must be constant/);
    expect(() => classify(low('square((x, 0), (1, 1))'))).toThrow(/Square vertices must be constant/);
    expect(() => classify(low('polygon((x, 0), (1, 1), (0, 2))'))).toThrow(/Polygon vertices must be constant/);
    expect(() => classify(low('polyline((x, 0), (1, 1), (0, 2))'))).toThrow(/Polyline vertices must be constant/);
    expect(() => classify(low('vector((u, 0), (1, 1))'))).toThrow(/Vector endpoints must be constant/);
  });

  it('animates vertices that use t', () => {
    const c = classify(low('segment((cos(t), sin(t)), (0, 0))'));
    expect(c.animated).toBe(true);
  });
});

describe('point definitions', () => {
  it('registers pairs as points with component constants', () => {
    const { defs, errors } = defsOf(['A = (1, 2)', 'B = A + (0, 0)']);
    expect(errors.size).toBe(0);
    expect([...defs.points]).toEqual(['A', 'B']);
    const values = evalConstEnv(defs, 0);
    expect([values.A_x, values.A_y, values.B_x, values.B_y]).toEqual([1, 2, 1, 2]);
  });

  it('derives points from point arithmetic', () => {
    const { defs, errors } = defsOf(['B = (4, 0.5)', 'D = (1, 2.5)', 'C = B + D', 'M = midpoint(B, D)']);
    expect(errors.size).toBe(0);
    const values = evalConstEnv(defs, 0);
    expect([values.C_x, values.C_y]).toEqual([5, 3]);
    expect([values.M_x, values.M_y]).toEqual([2.5, 1.5]);
  });

  it('supports scalar constants over points', () => {
    const { defs } = defsOf(['B = (4, 0)', 'D = (0, 3)', 'n = cross(B, D)', 'L = |B|']);
    const values = evalConstEnv(defs, 0);
    expect(values.n).toBe(12);
    expect(values.L).toBe(4);
  });

  it('inlines user functions over points', () => {
    const { defs, errors } = defsOf(['refl(P, Q) = 2Q - P', 'A = (1, 0)', 'O = (0, 0)', 'R = refl(A, O)']);
    expect(errors.size).toBe(0);
    const values = evalConstEnv(defs, 0);
    expect([values.R_x, values.R_y]).toEqual([-1, 0]);
  });

  it('reports a point used before its definition', () => {
    const { errors } = defsOf(['C = B + D', 'B = (4, 0.5)', 'D = (1, 2.5)']);
    expect(errors.get('C')).toMatch(/move its definition above/);
  });

  it('rejects component-name collisions and plane-dependent points', () => {
    expect(defsOf(['A = (1, 2)', 'A_x = 5']).errors.get('A')).toMatch(/A_x is already defined/);
    expect(defsOf(['A = (x, 0)']).errors.get('A')).toMatch(/cannot depend on x or y/);
    expect(defsOf(['s = x + y', 'A = (s, 0)']).errors.get('A')).toMatch(/cannot depend on x or y/);
  });

  it('keeps coordinate fields working alongside points', () => {
    const { defs, errors } = defsOf(['r = sqrt(x^2 + y^2)', 'A = (1, 2)']);
    expect(errors.size).toBe(0);
    expect(defs.fields.has('r')).toBe(true);
    expect(defs.points.has('A')).toBe(true);
  });

  it('animates points through t', () => {
    const { defs } = defsOf(['A = (cos(t), sin(t))']);
    const values = evalConstEnv(defs, Math.PI);
    expect(values.A_x).toBeCloseTo(-1);
    expect(values.A_y).toBeCloseTo(0);
  });
});
