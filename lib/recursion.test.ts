import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { compileTyped } from './complex.ts';
import { LOOP_LIMIT, evaluate, freeVars, parseExpr as parse, substVars } from './expr.ts';
import { GLSL_PRELUDE, withHelpers } from './glsl.ts';
import { compileProg, run } from './vm.ts';

const SNOWFLAKE = ['f(z) = {re(z) >= 1: 1, f(4 - 3(z^6)^(1/6))}', 'f(x i - |y|) >= 0'];

const valueOf = (rows: string[]): number => {
  const row = analyzeRows(rows).rows.at(-1)!;
  expect(row.error).toBeUndefined();
  expect(row.cpu!.type).toBe('value');
  return evaluate((row.cpu as { expr: import('./expr.ts').Expr }).expr, {});
};
const residualOf = (rows: string[]) => {
  const row = analyzeRows(rows).rows.at(-1)!;
  expect(row.error).toBeUndefined();
  expect(row.cpu!.type).toBe('ineq2d');
  const { residual } = (row.cpu as { constraints: Array<{ residual: import('./expr.ts').Expr }> }).constraints[0];
  return residual;
};

describe('tail-recursive functions', () => {
  it('runs a fold as a loop, on the tree walker and the VM alike', () => {
    expect(valueOf(['f(n, a) = {n <= 0: a, f(n - 1, a + n)}', 'f(100, 0)'])).toBe(5050);
    const row = analyzeRows(['f(n, a) = {n <= 0: a, f(n - 1, a + n)}', 'k = 3', 'f(k, 0)']).rows[2];
    const expr = (row.cpu as { expr: import('./expr.ts').Expr }).expr;
    expect([...freeVars(expr)]).toEqual(['k']);
    const prog = compileProg(expr, new Map([['k', 0]]));
    const stack = new Float64Array(prog.depth);
    expect(run(prog, [100], stack)).toBe(5050);
    expect(run(prog, [1], stack)).toBe(1);
    expect(evaluate(expr, { k: 3 })).toBe(6);
  });

  it('runs as many passes as a counted loop caps its counter at, up to 5000', () => {
    expect(valueOf(['f(a, k) = {k >= 600: a, f(a + 1, k + 1)}', 'f(0, 0)'])).toBe(600);
    expect(valueOf(['f(a, k) = {600 <= k: a, f(a + 1, 1 + k)}', 'f(0, 0)'])).toBe(600);
    expect(valueOf(['f(a, k) = {k >= 5000: a, f(a + 1, k + 1)}', 'f(0, 0)'])).toBe(5000);
    expect(valueOf(['f(a, k) = {k >= 6000: a, f(a + 1, k + 1)}', 'f(0, 0)'])).toBeNaN();
    // Only a counter every self-call advances by one earns the passes.
    expect(valueOf(['f(a, k) = {k >= 600: a, f(a + 1, k + 2)}', 'f(0, 0)'])).toBeNaN();
    expect(valueOf(['f(a, k) = {a >= 600: a, f(a + 2, k + 1)}', 'f(0, 0)'])).toBeNaN();
  });

  it('is undefined when the passes run out, the state blows up, or no case holds', () => {
    expect(valueOf(['f(n) = {n < 0: 1, f(n + 1)}', 'f(0)'])).toBeNaN();
    expect(valueOf(['f(n) = {n > 10^300: 1, f(n + 1)}', 'f(0)'])).toBeNaN();
    expect(valueOf(['f(n) = {n >= 10^300: 1, f(n * 10^100)}', 'f(1)'])).toBe(1);
    expect(valueOf(['f(n) = {n > 10^400: 1, f(n * 10^100)}', 'f(1)'])).toBeNaN();
    expect(valueOf(['f(n) = {n < 1: f(n + 1), n < 3: n}', 'f(5)'])).toBeNaN();
    expect(valueOf(['f(n) = {n > 0: f(n - 1), 7}', `f(${LOOP_LIMIT - 1})`])).toBe(7);
    expect(valueOf(['f(n) = {n > 0: f(n - 1), 7}', `f(${LOOP_LIMIT})`])).toBeNaN();
  });

  it('accepts Desmos’s bare condition {cond, else}', () => {
    // Bare cases are marked (a reduction reads `{c1, c2: f}` as c1 and c2),
    // and otherwise mean the same.
    const unmarked = (s: string) => JSON.parse(JSON.stringify(parse(s), (k, v) => (k === 'bare' ? undefined : v)));
    expect(unmarked('{x > 0, 5}')).toEqual(parse('{x > 0: 1, 5}'));
    expect(unmarked('{x > 0, y > 0}')).toEqual(parse('{x > 0: 1, y > 0: 1}'));
    expect(parse('{x > 0}')).toEqual(parse('x > 0'));
    // A trailing bare condition is a case too, never an inequality as a value.
    expect(unmarked('{x > 0: 2, y > 0}')).toEqual(parse('{x > 0: 2, y > 0: 1}'));
  });

  it('lets other functions call a recursive one, and recursive ones call each other in exit leaves', () => {
    expect(valueOf(['f(n) = {n <= 0: 0, f(n - 1)}', 'g(x) = f(x) + 1', 'g(3)'])).toBe(1);
    expect(valueOf(['f(n) = {n <= 0: 0, f(n - 1)}', 'g(x) = f(f(x))', 'g(3)'])).toBe(0);
    // g's own call is in a seed of the inlined f loop: not a tail call of g.
    expect(analyzeRows(['f(n) = {n <= 0: 0, f(n - 1)}', 'g(x) = {x <= 0: 1, f(g(x - 1))}']).rows[1].error).toMatch(
      /whole case/,
    );
    const nested = analyzeRows([
      'g(k) = {k <= 0: x, g(k - 1)}',
      'f(x) = {x <= 0: g(3), f(x - 1)}',
      'f(x) + y > 0',
    ]).rows;
    expect(nested[2].error).toBeUndefined();
    const field = (nested[2].gpu as { field: string }).field;
    const shader = withHelpers(`${GLSL_PRELUDE}\nfloat F(float x, float y) { return ${field}; }`);
    // Each nesting depth names its own locals: the inner helper takes the outer's p0_0 as a free variable.
    expect(shader).toMatch(/\(float p1_0, float p0_0\)/);
    expect(shader).not.toMatch(/float p0_0, float p0_0/);
  });

  it('differentiates a recursive function by central difference', () => {
    const rows = analyzeRows(['f(x) = {x <= 0: 1, f(x - 1)}', 'y = d/dx f(x)']).rows;
    expect(rows[1].error).toBeUndefined();
    const rows2 = analyzeRows(['f(x, a) = {x <= 0: a, f(x - 1, a + 1)}', 'd/dx f(x, x^2)']).rows;
    expect(rows2[1].error).toBeUndefined();
  });

  it('splats a point argument into the self-call', () => {
    expect(valueOf(['f(a, b) = {a <= 0: b, f((a - 1, b + 1))}', 'f(3, 0)'])).toBe(3);
    expect(analyzeRows(['f(a, b) = {a <= 0: b, f((a - 1, b + 1, 0))}']).rows[0].error).toMatch(
      /2 arguments|components/,
    );
  });

  it('spreads a computed point or quaternion among the self-call’s other arguments', () => {
    // p ↦ p/2 + (1, 1) from the origin: (1, 1), (1.5, 1.5), (1.75, 1.75).
    expect(valueOf(['G(a, b, k) = {k >= 3: a + b, G((a, b)/2 + (1, 1), k + 1)}', 'G(0, 0, 0)'])).toBe(3.5);
    // A helper that returns a point, and a named point.
    expect(valueOf(['T(a, b) = (b, a)', 'G(a, b, k) = {k >= 1: a, G(T(a, b), k + 1)}', 'G(1, 2, 0)'])).toBe(2);
    const named = analyzeRows(['P = (1, 2)', 'G(a, b, k) = {k >= 1: a + b, G(P, k + 1)}', 'G(0, 0, 0)']).rows[2];
    expect(named.error).toBeUndefined();
    expect(evaluate((named.cpu as { expr: import('./expr.ts').Expr }).expr, { P_x: 1, P_y: 2 })).toBe(3);
    // A quaternion spreads into w, x, y, z: i² + i = −1 + i.
    expect(
      valueOf([
        'C = quat(0, 1, 0, 0)',
        'Q(a, b, c, d, k) = {k >= 1: a, Q(quat(a, b, c, d)^2 + C, k + 1)}',
        'Q(0, 1, 0, 0, 0)',
      ]),
    ).toBe(-1);
    // The count is checked once the point's size is known.
    const short = analyzeRows(['G(a, b, c, k) = {k >= 3: a, G((a, b) + (x, y), k + 1)}', 'G(x, y, z, 0) = 0.5']);
    expect(short.rows[1].error).toMatch(/passes 3 values, and the function takes 4/);
    const long = analyzeRows(['G(a, b, k) = {k >= 3: a, G((a, b) + (x, y), k + 1, 2)}', 'G(x, y, 0) = 0.5']);
    expect(long.rows[1].error).toMatch(/passes 4 values, and the function takes 3/);
  });

  it('draws the Mandelbulb, written out, as the level set of its orbit’s Green function', () => {
    const rows = [
      'n = 8',
      'r(a, b, c) = sqrt(a^2 + b^2 + c^2)',
      'T(a, b, c) = r(a, b, c)^n (sin(n acos(c/r(a, b, c))) cos(n atan2(b, a)), sin(n acos(c/r(a, b, c))) sin(n atan2(b, a)), cos(n acos(c/r(a, b, c))))',
      'G(a, b, c, k) = {r(a, b, c) > 2: ln(r(a, b, c))/n^k, k >= 12: ln(r(a, b, c))/n^k, G(T(a, b, c) + (x, y, z), k + 1)}',
      'G(x, y, z, 0) = 0.001',
    ];
    const row = analyzeRows(rows).rows.at(-1)!;
    expect(row.error).toBeUndefined();
    expect(row.cpu!.type).toBe('implicit3d');
    const residual = (row.cpu as { residual: import('./expr.ts').Expr }).residual;
    const at = (x: number, y: number, z: number) => evaluate(residual, { n: 8, x, y, z });
    // Near the origin the orbit stays bounded (below the level); far away it
    // escapes at once (above it).
    expect(at(0.1, 0.2, 0.3)).toBeLessThan(0);
    expect(at(1.5, 1.5, 1.5)).toBeGreaterThan(0);
  });

  it('draws a quaternion Julia set from an orbit written in quaternion algebra', () => {
    const rows = [
      's = 0',
      'C = quat(-0.2, 0.8, 0, 0)',
      'Q(a, b, c, d, k) = {|quat(a, b, c, d)| > 2: ln(|quat(a, b, c, d)|)/2^k, k >= 12: ln(|quat(a, b, c, d)|)/2^k, Q(quat(a, b, c, d)^2 + C, k + 1)}',
      'Q(x, y, z, s, 0) = 0.001',
    ];
    const row = analyzeRows(rows).rows.at(-1)!;
    expect(row.error).toBeUndefined();
    expect(row.cpu!.type).toBe('implicit3d');
    expect(row.cls!.params).toEqual(['s']);
    const residual = (row.cpu as { residual: import('./expr.ts').Expr }).residual;
    // 0 lies in the filled set for this C; (2, 2, 2) escapes at once.
    expect(evaluate(residual, { s: 0, x: 0, y: 0, z: 0 })).toBeLessThan(0);
    expect(evaluate(residual, { s: 0, x: 2, y: 2, z: 2 })).toBeGreaterThan(0);
  });

  it('does not capture a substituted name that matches a loop param', () => {
    // g(c) = f(2) inlines c → the slider n inside a loop whose param is also n.
    const row = analyzeRows(['f(n) = {n <= 0: c, f(n - 1)}', 'g(c) = f(2)', 'n = 7', 'g(n)']).rows[3];
    expect(row.error).toBeUndefined();
    const expr = (row.cpu as { expr: import('./expr.ts').Expr }).expr;
    expect(evaluate(expr, { n: 7 })).toBe(7);
    expect(run(compileProg(expr, new Map([['n', 0]])), [7], new Float64Array(64))).toBe(7);
  });

  it('rejects calls outside tail position and mutual recursion', () => {
    const nonTail = analyzeRows(['f(n) = {n <= 1: 1, n f(n - 1)}', 'f(3)']).rows;
    expect(nonTail[0].error).toMatch(/whole case of \{…\}/);
    const inCond = analyzeRows(['f(n) = {f(n - 1) > 0: 1, 2}', 'f(3)']).rows;
    expect(inCond[0].error).toMatch(/whole case/);
    const bare = analyzeRows(['f(n) = f(n - 1) + 1']).rows;
    expect(bare[0].error).toMatch(/whole case/);
    const mutual = analyzeRows(['f(n) = {n < 0: 0, g(n - 1)}', 'g(n) = {n < 0: 1, f(n - 1)}']).rows;
    expect(mutual[0].error ?? mutual[1].error).toMatch(/in terms of each other/);
    expect(analyzeRows(['f(n) = {n <= 0: 0, f(n - 1, 2)}']).rows[0].error).toMatch(/takes 1 argument/);
  });

  it('keeps the loop params out of the free variables and away from substitution', () => {
    const row = analyzeRows(['f(x) = {x >= 1: 1, f(x / 2)}', 'a = 2', 'f(a)']).rows[2];
    expect(row.error).toBeUndefined();
    expect(row.cls!.params).toEqual(['a']);
    const expr = (row.cpu as { expr: import('./expr.ts').Expr }).expr;
    expect(expr.kind).toBe('loop');
    // Substituting the outer name reaches the seed only.
    const swapped = substVars(expr, { a: { kind: 'num', value: 8 } });
    expect(evaluate(swapped, {})).toBe(1);
    expect(evaluate(expr, { a: -1 })).toBeNaN();
  });

  it('lets a param shadow a document list of the same name', () => {
    // 13 is 1101 in binary: the digits, fed through q ↦ 2q + s mod 3, leave 13 mod 3.
    const walk = [
      'step(q, s) = mod(2q + s, 3)',
      'digit(k) = mod(floor(13 / 2^(3 - k)), 2)',
      'run(q, k, m) = {k >= m: q, run(step(q, digit(k)), k + 1, m)}',
    ];
    expect(valueOf([...walk, 'run(0, 0, 4)'])).toBe(1);
    expect(valueOf(['k = 3', ...walk, 'run(0, 0, 4)'])).toBe(1);
    expect(valueOf(['k = [1..40]', ...walk, 'run(0, 0, 4)'])).toBe(1);
    expect(valueOf(['f(k) = {k >= 3: k, f(k + 1)}', 'k = [1..3]', 'f(0)'])).toBe(3);
    expect(valueOf(['f(k) = k^2', 'k = [1..3]', 'f(2)'])).toBe(4);
    // The list still reaches the seeds, one loop per element, as any other list would.
    for (const list of ['k', 'L']) {
      const row = analyzeRows(['k = [1..4]', 'L = [1..4]', ...walk, `run(0, 0, ${list})`]).rows.at(-1)!;
      expect(row.error).toBeUndefined();
      expect(row.cpu!.type).toBe('vlist');
      const { values } = row.cpu as { values: import('./expr.ts').Expr[] };
      expect(values.map(v => evaluate(v, {}))).toEqual([1, 0, 0, 1]);
    }
  });
});

describe('the Koch snowflake', () => {
  it('classifies as a region with a loop over complex state', () => {
    const { rows } = analyzeRows(SNOWFLAKE);
    expect(rows[0].error).toBeUndefined();
    expect(rows[1].error).toBeUndefined();
    expect(rows[1].cls!.object.kind).toBe('region');
    expect(rows[1].cls!.needs3D).toBe(false);
    expect(rows[1].gpu!.type).toBe('ineq2d');
    const field = (rows[1].gpu as { field: string }).field;
    expect(field).toMatch(/eq_loop_[0-9a-f]+\(\(c_mul/);
    const shader = withHelpers(`${GLSL_PRELUDE}\nfloat F(float x, float y) { return ${field}; }`);
    expect(shader).toContain(`for (int k = 0; k < ${LOOP_LIMIT}; k++)`);
    expect(shader).toMatch(/float eq_loop_[0-9a-f]+\(vec2 p0_0\)/);
    expect(shader.indexOf('eq_loop_')).toBeLessThan(shader.indexOf('float F('));
  });

  it('is inside at the center and outside far away, on the CPU', () => {
    const residual = residualOf(SNOWFLAKE);
    // The residual is 0 - f: -1 inside (f = 1), undefined outside.
    expect(evaluate(residual, { x: 0.3, y: 0.2 })).toBe(-1);
    expect(evaluate(residual, { x: 0.5, y: -0.5 })).toBe(-1);
    expect(evaluate(residual, { x: 3, y: 3 })).toBeNaN();
    expect(evaluate(residual, { x: 0, y: 2.2 })).toBeNaN();
    const prog = compileProg(
      residual,
      new Map([
        ['x', 0],
        ['y', 1],
      ]),
    );
    const stack = new Float64Array(prog.depth);
    expect(run(prog, [0.3, 0.2], stack)).toBe(-1);
    expect(run(prog, [-1.2, 0.1], stack)).toBe(-1);
    expect(run(prog, [3, 3], stack)).toBeNaN();
    expect(run(prog, [1.9, 0], stack)).toBeNaN();
  });

  it('passes sliders into the helper as uniforms, so dragging never recompiles', () => {
    const rows = analyzeRows(['a = 1', 'f(z) = {re(z) >= a: 1, f(4 - 3(z^6)^(1/6))}', 'f(x i - |y|) >= 0']).rows;
    expect(rows[2].error).toBeUndefined();
    expect(rows[2].cls!.params).toEqual(['a']);
    const field = (rows[2].gpu as { field: string }).field;
    expect(field).toMatch(/eq_loop_[0-9a-f]+\(.*, u_a\)\)$/);
    expect(withHelpers(`${GLSL_PRELUDE}\n${field}`)).toMatch(/\(vec2 p0_0, float u_a\)/);
  });

  it('feeds a colour field without hoisting the loop body into shared locals', () => {
    const rows = analyzeRows([
      'a = 60',
      'm(z, c, n) = {abs(z) > 2: n, n >= a: a, m(z^2 + c, c, n + 1)}',
      'hsl(8 m(0, w, 0), 90, 50)',
    ]).rows;
    expect(rows[2].error).toBeUndefined();
    const gpu = rows[2].gpu as { type: string; field: string; locals: string };
    expect(gpu.type).toBe('hsl2d');
    // The loop is one call inside a local; none of its body reaches a local.
    expect(gpu.locals).toMatch(/eq_loop_[0-9a-f]+\(vec2\(0\.0, 0\.0\), vec2\(x, y\), 0\.0, u_a\)/);
    expect(gpu.locals).not.toMatch(/p0_0/);
    const julia = analyzeRows([
      'j(z, n) = {abs(z) > 2: n, n >= 60: 60, j(z^2 - 0.8 + 0.156i, n + 1)}',
      'hsl(8 j(w, 0) + 200, 90, 50)',
    ]).rows;
    expect(julia[1].error).toBeUndefined();
  });

  it('shares one helper between equal loops and types complex results', () => {
    const rows = analyzeRows(['g(z) = {abs(z) < 1: z, g(z / 2)}', 're(g(w)) = 0.1']).rows;
    expect(rows[1].error).toBeUndefined();
    const field = (rows[1].gpu as { field: string }).field;
    expect(field).toMatch(/\(eq_loop_[0-9a-f]+\(vec2\(x, y\)\)\)\.x/);
    const again = compileTyped((rows[1].cpu as { residual: import('./expr.ts').Expr }).residual);
    expect(again.type).toBe('real');
  });
});
