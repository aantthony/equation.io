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
    expect(parse('{x > 0, 5}')).toEqual(parse('{x > 0: 1, 5}'));
    expect(parse('{x > 0, y > 0}')).toEqual(parse('{x > 0: 1, y > 0: 1}'));
    expect(parse('{x > 0}')).toEqual(parse('x > 0'));
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
    expect(shader).toMatch(/float eq_loop_[0-9a-f]+\(vec2 p0\)/);
    expect(shader.indexOf('eq_loop_')).toBeLessThan(shader.indexOf('float F('));
  });

  it('is inside at the center and outside far away, on the CPU', () => {
    const residual = residualOf(SNOWFLAKE);
    // The residual is 0 - f: -1 inside (f = 1), undefined outside.
    expect(evaluate(residual, { x: 0.3, y: 0.2 })).toBe(-1);
    expect(evaluate(residual, { x: 0.5, y: -0.5 })).toBe(-1);
    expect(evaluate(residual, { x: 3, y: 3 })).toBeNaN();
    expect(evaluate(residual, { x: 0, y: 2.2 })).toBeNaN();
    const prog = compileProg(residual, new Map([['x', 0], ['y', 1]]));
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
    expect(withHelpers(`${GLSL_PRELUDE}\n${field}`)).toMatch(/\(vec2 p0, float u_a\)/);
  });

  it('feeds a colour field without hoisting the loop body into shared locals', () => {
    const rows = analyzeRows(['a = 60', 'm(z, c, n) = {abs(z) > 2: n, n >= a: a, m(z^2 + c, c, n + 1)}', 'hsl(8 m(0, w, 0), 90, 50)']).rows;
    expect(rows[2].error).toBeUndefined();
    const gpu = rows[2].gpu as { type: string; field: string; locals: string };
    expect(gpu.type).toBe('hsl2d');
    expect(gpu.locals).toMatch(/float eqColor\d+ = eq_loop_[0-9a-f]+\(vec2\(0\.0, 0\.0\), vec2\(x, y\), 0\.0, u_a\);/);
    const julia = analyzeRows(['j(z, n) = {abs(z) > 2: n, n >= 60: 60, j(z^2 - 0.8 + 0.156i, n + 1)}', 'hsl(8 j(w, 0) + 200, 90, 50)']).rows;
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
