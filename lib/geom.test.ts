import { compileCpu } from './compiler.ts';
import { evaluateFrame } from './env.ts';
import { describe, expect, it } from 'vitest';
import { type Definition, buildDefs, scanDefinition } from './defs.ts';
import { diff } from './diff.ts';
import { angleFn, evaluate, parseExpr } from './expr.ts';
import { arrowHead, lowerGeom } from './geom.ts';
import { GLSL_PRELUDE, toGLSL } from './glsl.ts';
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
      items: [
        { kind: 'var', name: 'A_x' },
        { kind: 'var', name: 'A_y' },
      ],
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
    expect(compileCpu(classify(low('(-y, x)'))).type).toBe('vfield2d');
    expect(compileCpu(classify(low("(x', y') = (y, -sin(x))"))).type).toBe('vfield2d');
  });

  it('rejects invalid point algebra with clear errors', () => {
    expect(() => low('A + 2')).toThrow(/add a point and a number/);
    expect(() => low('A B')).toThrow(/A · B or A × B/);
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

describe('distance and angle measurements', () => {
  const lowL = (s: string) =>
    lowerGeom(
      parseExpr(s),
      isPt,
      n => (n === 'M' ? [[parseExpr('1')]] : null) as never,
      n => n === 'L',
    );

  it('distance(A, B) is |A - B|', () => {
    expect(evalAt('distance(A, B)')).toBe(5);
    expect(evalAt('distance(B, A)')).toBe(5);
    expect(evalAt('distance(A, A)')).toBe(0);
    expect(evalAt('distance((0, 0), (3, 4))')).toBe(5);
    expect(evalAt('distance(A, (1, 0))')).toBe(2);
    expect(evalAt('distance(midpoint(A, B), A + (B - A)/2)')).toBe(0);
    expect(low('distance(A, B)')).toEqual(low('|A - B|'));
  });

  it('angle(A, B, C) is the signed angle at B, counterclockwise from B→A to B→C', () => {
    expect(evalAt('angle((1, 0), (0, 0), (0, 1))')).toBeCloseTo(Math.PI / 2, 12);
    expect(evalAt('angle((0, 1), (0, 0), (1, 0))')).toBeCloseTo(-Math.PI / 2, 12);
    expect(evalAt('angle((3, 2), (2, 2), (3, 3))')).toBeCloseTo(Math.PI / 4, 12); // the vertex is B, not the origin
    expect(evalAt('angle(A, B, C)')).toBeCloseTo(Math.atan2(-3 * -6 - -4 * -5, -3 * -5 + -4 * -6), 12);
    expect(evalAt('angle(A, B, C) + angle(C, B, A)')).toBeCloseTo(0, 12);
  });

  it('angle(U, V) is the angle between two vectors', () => {
    expect(evalAt('angle((1, 0), (1, 1))')).toBeCloseTo(Math.PI / 4, 12);
    expect(evalAt('angle((1, 1), (1, 0))')).toBeCloseTo(-Math.PI / 4, 12);
    expect(evalAt('angle(B - A, perp(B - A))')).toBeCloseTo(Math.PI / 2, 12);
    expect(evalAt('angle(A, B)')).toBeCloseTo(Math.atan2(6, 4) - Math.atan2(2, 1), 12);
  });

  it('a straight angle is π from either side: the range is (−π, π]', () => {
    expect(evalAt('angle((1, 0), (0, 0), (-1, 0))')).toBe(Math.PI);
    expect(evalAt('angle((-1, 0), (0, 0), (1, 0))')).toBe(Math.PI); // cross is −0 here
    expect(evalAt('angle((0, -2), (0, 0), (0, 3))')).toBe(Math.PI);
    expect(evalAt('angle((-1, 0), (1, 0))')).toBe(Math.PI);
    expect(evalAt('angle((2, 0), (0, 0), (5, 0))')).toBe(0);
  });

  it('a zero-length arm has no direction: undefined, not a confident 0', () => {
    expect(evalAt('angle(A, A, C)')).toBeNaN();
    expect(evalAt('angle(A, C, C)')).toBeNaN();
    expect(evalAt('angle((0, 0), B)')).toBeNaN();
    // Tiny is not zero (there is no 1e-200 literal: that parses as 1 e − 200),
    // and huge does not overflow: arms are scaled before they are multiplied.
    expect(evaluate(parseExpr('10^(-200)'), {})).toBe(1e-200);
    expect(evalAt('angle((10^(-200), 0), (0, 10^(-200)))')).toBeCloseTo(Math.PI / 2, 12);
    expect(evalAt('angle((10^(-200), 0), (0, 0), (0, 10^200))')).toBeCloseTo(Math.PI / 2, 12);
    expect(evalAt('angle((10^200, 10^200), (0, 10^200))')).toBeCloseTo(Math.PI / 4, 12);
    expect(evalAt('distance(A, A)')).toBe(0); // ...while a zero distance is a fine number
  });

  it('lowers angle to one internal call: each arm component appears once', () => {
    expect(low('angle(A, B, C)')).toEqual({
      kind: 'call',
      name: '[angle]',
      args: [low('A_x - B_x'), low('A_y - B_y'), low('C_x - B_x'), low('C_y - B_y')],
    });
    const glsl = toGLSL(low('angle((1, 0), (x, y))'));
    expect(glsl).toBe('eq_angle(1.0, 0.0, x, y)');
    expect(GLSL_PRELUDE).toContain('float eq_angle(float u0, float u1, float v0, float v1)');
  });

  it('differentiates like atan2(cross, dot)', () => {
    const e = low('angle((1, 2), (x, 3 - x^2))');
    const at = { x: 0.7 };
    const h = 1e-6;
    const numeric = (evaluate(e, { x: 0.7 + h }) - evaluate(e, { x: 0.7 - h })) / (2 * h);
    expect(evaluate(diff(e, 'x'), at)).toBeCloseTo(numeric, 6);
  });

  it('differentiates tiny and huge arms without under- or overflow', () => {
    // The angle does not depend on the arms' lengths, so neither may its derivative.
    const at1 = evaluate(diff(low('angle((1, 2), (x, 3 - x^2))'), 'x'), { x: 0.7 });
    for (const k of [1e-200, 1e-30, 1e30, 1e150]) {
      const d = diff(low('angle((k, 2k), (k x, k (3 - x^2)))'), 'x');
      expect(evaluate(d, { x: 0.7, k }), String(k)).toBeCloseTo(at1, 9);
    }
    // Both arms moving, and the second derivative still exists.
    const both = low('angle((x, 1), (1, x^2))');
    const h = 1e-5;
    const num1 = (evaluate(both, { x: 0.4 + h }) - evaluate(both, { x: 0.4 - h })) / (2 * h);
    expect(evaluate(diff(both, 'x'), { x: 0.4 })).toBeCloseTo(num1, 6);
    const d1 = diff(both, 'x');
    const num2 = (evaluate(d1, { x: 0.4 + h }) - evaluate(d1, { x: 0.4 - h })) / (2 * h);
    expect(evaluate(diff(d1, 'x'), { x: 0.4 })).toBeCloseTo(num2, 5);
    // A fixed arm contributes nothing, so it is not emitted at all.
    expect(toGLSL(diff(low('angle((1, 0), (x, y))'), 'x'))).toBe('eq_angle_rate(x, y, 1.0, 0.0)');
  });

  it('angleFn and its GLSL twin agree on every edge', () => {
    expect(angleFn(1, 0, 0, 1)).toBeCloseTo(Math.PI / 2, 15);
    expect(angleFn(-1, 0, 1, 0)).toBe(Math.PI);
    expect(angleFn(0, 0, 1, 0)).toBeNaN();
    expect(angleFn(NaN, 1, 1, 0)).toBeNaN();
    expect(angleFn(1, NaN, 1, 0)).toBeNaN();
    expect(angleFn(1, 0, NaN, 5)).toBeNaN();
    expect(angleFn(Infinity, 0, 1, 0)).toBeNaN();
    // GLSL max() may drop a NaN that Math.max propagates, and the c == 0
    // branch must not invent a 0 where the CPU says NaN: mirror both.
    const body = GLSL_PRELUDE.slice(GLSL_PRELUDE.indexOf('float eq_angle('));
    expect(body).toContain('isnan(u0) || isnan(u1) || isnan(v0) || isnan(v1)');
    expect(body).toContain('d > 0.0 ? 0.0 : EQ_NAN');
  });

  it('never shows the internal name in an error', () => {
    const internal: ReturnType<typeof parseExpr> = { kind: 'call', name: '[angle]', args: [parseExpr('x')] };
    expect(() => diff(internal, 'x')).toThrow(/^Cannot differentiate angle\.$/);
  });

  it('are scalars: they compose inside larger expressions and plots', () => {
    expect(evalAt('2 distance(A, B)')).toBe(10);
    expect(evalAt('angle((1, 0), (0, 0), (0, 1)) 180/pi')).toBeCloseTo(90, 10);
    expect(evalAt('distance(A, B)^2 + sin(angle((1, 0), (0, 1)))')).toBeCloseTo(26, 12);
    const at = (s: string) => (low(s) as { items: [never, never] }).items.map(e => evaluate(e, env));
    expect(at('A + distance(A, B) unit(B - A)')).toEqual([4, 6]);
    expect(compileCpu(classify(low('distance(A, B)'), new Set(Object.keys(env)))).type).toBe('value');
    expect(compileCpu(classify(low('angle(A, B, C)'), new Set(Object.keys(env)))).type).toBe('value');
    expect(
      compileCpu(classify(low('y = distance(A, B) sin(x + angle(A, B, C))'), new Set(Object.keys(env)))).type,
    ).toBe('implicit2d');
    expect(compileCpu(classify(low('circle(A, distance(A, B))'), new Set(Object.keys(env)))).type).toBe('implicit2d');
    expect(
      compileCpu(classify(low('distance((x, y), A) + distance((x, y), B) = 6'), new Set(Object.keys(env)))).type,
    ).toBe('implicit2d');
    expect(classify(low('distance((cos(t), sin(t)), A)'), new Set(Object.keys(env))).animated).toBe(true);
  });

  it('distance and unsigned angle support 3-component vectors', () => {
    const is3 = (n: string) => (n === 'p' || n === 'q' ? [n + '_1', n + '_2', n + '_3'] : isPt(n));
    const e3 = { p_1: 1, p_2: 2, p_3: 3, q_1: 3, q_2: 5, q_3: 9 };
    expect(evaluate(lowerGeom(parseExpr('distance(p, q)'), is3), e3)).toBe(7);
    expect(() => lowerGeom(parseExpr('distance(p, A)'), is3)).toThrow(/same number of components, not 3 and 2/);
    expect(evaluate(lowerGeom(parseExpr('angle(p, q)'), is3), e3)).toBeCloseTo(Math.acos(40 / Math.sqrt(14 * 115)));
    expect(() => lowerGeom(parseExpr('angle(A, p, B)'), is3)).toThrow(/matching dimensions/);
  });

  it('fail loudly, with messages true however the tuples flattened', () => {
    for (const row of [
      'distance(A)',
      'distance(A, B, C)',
      'distance(A, 3)',
      'distance(3, A)',
      'distance(1, 2, 3)',
      'distance(a)',
    ]) {
      expect(() => low(row), row).toThrow(/^distance takes two points: distance\(A, B\)/);
    }
    for (const row of [
      'angle(A)',
      'angle(A, B, C, A)',
      'angle(A, 3)',
      'angle(1, 2, 3)',
      'angle(a)',
      'angle(A, B, 0.5)',
    ]) {
      expect(() => low(row), row).toThrow(
        /^angle takes three matching points — angle\(A, B, C\), the angle at B — or two vectors/,
      );
    }
    // A list *as* an argument would be a list of points: families (plan #13).
    const listy = /a list cannot stand for a point yet/;
    expect(() => low('distance([(0, 0), (1, 1)], A)')).toThrow(
      /^distance takes points, and a list cannot stand for a point yet — distance\(A, B\)/,
    );
    expect(() => low('angle(A, [A, B], C)')).toThrow(
      /^angle takes points, and a list cannot stand for a point yet — angle\(A, B, C\)/,
    );
    expect(() => lowL('distance(L, A)')).toThrow(listy);
    expect(() => lowL('distance(M, A)')).toThrow(listy);
    // ...but a list inside a component is an ordinary scalar list: it stays
    // in the lowered expression and broadcasts later, as in |A - (L, 1)|.
    expect(lowL('distance((L, 1), A)')).toEqual(lowL('|(L, 1) - A|'));
    expect(() => lowL('angle(A, (2L, 0), B)')).not.toThrow();
    // A measurement is a number, so it is no vertex.
    expect(() => low('segment(A, distance(A, B))')).toThrow(/segment takes points/);
  });

  it('point-function lookup ignores Object.prototype names', () => {
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const e: ReturnType<typeof parseExpr> = { kind: 'call', name, args: [{ kind: 'var', name: 'x' }] };
      expect(lowerGeom(e, isPt)).toBe(e);
    }
  });
});

describe('geometry statements', () => {
  it('segment and polygon desugar to CPU polygon plots', () => {
    const seg = classify(low('segment(A, B)'), new Set(Object.keys(env)));
    expect(compileCpu(seg)).toMatchObject({ type: 'polygon', closed: false });
    expect((compileCpu(seg) as { pts: never[] }).pts).toHaveLength(4);

    const poly = classify(low('polygon(A, B, C)'), new Set(Object.keys(env)));
    expect(compileCpu(poly)).toMatchObject({ type: 'polygon', closed: true });
    expect((compileCpu(poly) as { pts: never[] }).pts).toHaveLength(6);
  });

  it('polyline is the open figure through any number of points', () => {
    const c = compileCpu(classify(low('polyline((0, 0), (1, 1), (2, 0))'), new Set()));
    expect(c).toMatchObject({ type: 'polygon', closed: false });
    expect(c).not.toHaveProperty('arrow');
    expect((c as { pts: never[] }).pts.map(e => evaluate(e, {}))).toEqual([0, 0, 1, 1, 2, 0]);
    // Named points and point arithmetic mix with literals; n = 2 is a segment.
    const mixed = compileCpu(classify(low('polyline(A, (A + B)/2, (0, 0), C)'), new Set(Object.keys(env)))) as {
      pts: never[];
    };
    expect(mixed.pts.map(e => evaluate(e, env))).toEqual([1, 2, 2.5, 4, 0, 0, -1, 0]);
    expect(
      (compileCpu(classify(low('polyline(A, B)'), new Set(Object.keys(env)))) as { pts: never[] }).pts,
    ).toHaveLength(4);
  });

  it('vector is an arrow from A to B, or from the origin', () => {
    const ab = compileCpu(classify(low('vector(A, B)'), new Set(Object.keys(env))));
    expect(ab).toMatchObject({ type: 'polygon', closed: false, arrow: true });
    expect((ab as { pts: never[] }).pts.map(e => evaluate(e, env))).toEqual([1, 2, 4, 6]);
    const v = compileCpu(classify(low('vector((1, 2))'), new Set())) as { pts: never[] };
    expect(v.pts.map(e => evaluate(e, {}))).toEqual([0, 0, 1, 2]);
    const sum = compileCpu(classify(low('vector(A, A + 2B)'), new Set(Object.keys(env)))) as { pts: never[] };
    expect(sum.pts.map(e => evaluate(e, env))).toEqual([1, 2, 9, 14]);
    // A pair of points is still not a value: the wrapper has to be asked for.
    expect(() => low('(A, B)')).toThrow(/segment\(A, B\)/);
  });

  it('polyline and vector fail loudly on what they do not cover yet', () => {
    expect(() => low('polyline(A)')).toThrow(/at least 2 points/);
    expect(() => low('vector(A, B, C)')).toThrow(/one or two points/);
    expect(() => low('polyline([(0, 0), (1, 1)])')).toThrow(/one by one.*polyline\(A, B, C\)/);
    expect(() => low('vector([A, B])')).toThrow(/one by one.*vector\(A, B\)/);
    for (const row of ['vector((1, 2), 3)', 'vector(a, b, c)', 'vector((0, 0), (1, 1), (2, 2))']) {
      expect(() => low(row)).toThrow(/vector takes/);
    }
    expect(classify(low('vector((1, 2, 3))')).needs3D).toBe(true);
    expect(compileCpu(classify(low('vector((1, 2, 3), (4, 5, 6))'))).type).toBe('polygon');
    // A named list of points (or a 2×2 one, which reads as a matrix) is a list too.
    const lowL = (s: string) =>
      lowerGeom(
        parseExpr(s),
        isPt,
        n => (n === 'M' ? [[parseExpr('1')]] : null) as never,
        n => n === 'L',
      );
    expect(() => lowL('polyline(L)')).toThrow(/one by one for now.*not as a list/);
    expect(() => lowL('vector(A, L)')).toThrow(/one by one for now.*not as a list/);
    expect(() => lowL('polyline(M)')).toThrow(/one by one for now.*not as a list/);
    expect(() => low('polyline(A, 3)')).toThrow(/polyline takes points/);
    expect(() => low('1 + vector(A, B)')).toThrow(/whole statement/);
    expect(() => low('2 polyline(A, B)')).toThrow(/whole statement/);
  });

  it('figure lookup ignores Object.prototype names', () => {
    // A call that merely shares a name with an inherited property is not a figure.
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const c = classify({ kind: 'call', name, args: [{ kind: 'num', value: 2 }] });
      expect(compileCpu(c).type).not.toBe('polygon');
    }
  });

  it('arrowHead is a screen-space triangle behind the tip', () => {
    // Shaft along +x: base 10px behind the tip, wings ±4px across it.
    // The stroke stops a quarter of the way into the head.
    expect(arrowHead(0, 0, 100, 0, 10)).toEqual({ tip: [100, 0], left: [90, 4], right: [90, -4], shaftEnd: [92.5, 0] });
    // A shaft shorter than the head shrinks the head to fit it.
    expect(arrowHead(0, 0, 0, 5, 10)).toMatchObject({ left: [-2, 0], right: [2, 0] });
    // No direction, no head.
    expect(arrowHead(3, 3, 3, 3, 10)).toBeNull();
    expect(arrowHead(0, 0, NaN, 0, 10)).toBeNull();
  });

  it('square erects on the left of A→B', () => {
    const sq = compileCpu(classify(low('square((0, 0), (2, 0))'), new Set())) as { pts: never[] };
    expect(sq.pts.map(e => evaluate(e, {}))).toEqual([0, 0, 2, 0, 2, 2, 0, 2]);
  });

  it('line desugars to an implicit equation through both points', () => {
    expect(compileCpu(classify(low('line((0, 0), (1, 2))'))).type).toBe('implicit2d');
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
    expect(compileCpu(c).type).toBe('implicit2d');
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
    const values = evaluateFrame(defs, 0);
    expect([values.A_x, values.A_y, values.B_x, values.B_y]).toEqual([1, 2, 1, 2]);
  });

  it('derives points from point arithmetic', () => {
    const { defs, errors } = defsOf(['B = (4, 0.5)', 'D = (1, 2.5)', 'C = B + D', 'M = midpoint(B, D)']);
    expect(errors.size).toBe(0);
    const values = evaluateFrame(defs, 0);
    expect([values.C_x, values.C_y]).toEqual([5, 3]);
    expect([values.M_x, values.M_y]).toEqual([2.5, 1.5]);
  });

  it('supports scalar constants over points', () => {
    const { defs } = defsOf(['B = (4, 0)', 'D = (0, 3)', 'n = cross(B, D)', 'L = |B|']);
    const values = evaluateFrame(defs, 0);
    expect(values.n).toBe(12);
    expect(values.L).toBe(4);
  });

  it('inlines user functions over points', () => {
    const { defs, errors } = defsOf(['refl(P, Q) = 2Q - P', 'A = (1, 0)', 'O = (0, 0)', 'R = refl(A, O)']);
    expect(errors.size).toBe(0);
    const values = evaluateFrame(defs, 0);
    expect([values.R_x, values.R_y]).toEqual([-1, 0]);
  });

  it('reports a point used before its definition', () => {
    const { errors } = defsOf(['C = B + D', 'B = (4, 0.5)', 'D = (1, 2.5)']);
    expect(errors.get('C')).toMatch(/move its definition above/);
  });

  it('rejects component-name collisions', () => {
    expect(defsOf(['A = (1, 2)', 'A_x = 5']).errors.get('A')).toMatch(/A_x is already defined/);
  });

  it('treats a named vector that depends on x, y, or z as a vector field', () => {
    const { defs, errors } = defsOf(['s = (x, y)']);
    expect(errors.size).toBe(0);
    expect(defs.points.has('s')).toBe(true);
    expect(defs.fields.has('s_x')).toBe(true);
    expect(defs.fields.has('s_y')).toBe(true);
    expect(defs.consts.has('s_x')).toBe(false);
    expect(evaluate(defs.fields.get('s_x')!, { x: 3, y: 4 })).toBe(3);
    expect(evaluate(defs.fields.get('s_y')!, { x: 3, y: 4 })).toBe(4);

    const viaField = defsOf(['q = x + y', 'A = (q, 0)']);
    expect(viaField.errors.size).toBe(0);
    expect(viaField.defs.points.has('A')).toBe(true);
    expect(evaluate(viaField.defs.fields.get('A_x')!, { x: 3, y: 4 })).toBe(7);

    const space = defsOf(['A = (z, 0)']);
    expect(space.errors.size).toBe(0);
    expect(evaluate(space.defs.fields.get('A_x')!, { z: 2 })).toBe(2);

    const scaled = defsOf(['s = (x, y)', 'q = 2 s']);
    expect(scaled.errors.size).toBe(0);
    expect(evaluate(scaled.defs.fields.get('q_x')!, { x: 3, y: 4 })).toBe(6);
    expect(evaluate(scaled.defs.fields.get('q_y')!, { x: 3, y: 4 })).toBe(8);
  });

  it('reports a named vector that mixes position with a parameter on the point row', () => {
    expect(defsOf(['s = (x, u)']).errors.get('s')).toMatch(/mixes position.*found u/);
    expect(defsOf(['s = (x, w)']).errors.get('s')).toMatch(/found w/);
  });

  it('keeps coordinate fields working alongside points', () => {
    const { defs, errors } = defsOf(['r = sqrt(x^2 + y^2)', 'A = (1, 2)']);
    expect(errors.size).toBe(0);
    expect(defs.fields.has('r')).toBe(true);
    expect(defs.points.has('A')).toBe(true);
  });

  it('animates points through t', () => {
    const { defs } = defsOf(['A = (cos(t), sin(t))']);
    const values = evaluateFrame(defs, Math.PI);
    expect(values.A_x).toBeCloseTo(-1);
    expect(values.A_y).toBeCloseTo(0);
  });
});
