import { expect, test } from 'vitest';
import { parseExpr } from './expr.ts';
import { solveSystem } from './solve.ts';

const sys = (...src: string[]) => src.map(s => parseExpr(s));
const near = (a: number[], b: number[], tol = 1e-6) =>
  a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) < tol);
const has = (sols: number[][], p: number[], tol?: number) => sols.some(s => near(s, p, tol));

test('two circles meet in two points', () => {
  const sols = solveSystem(sys('x^2 + y^2 - 1', '(x-1)^2 + y^2 - 1'), ['x', 'y'], [-3, -3], [3, 3]);
  expect(sols).toHaveLength(2);
  expect(has(sols, [0.5, -Math.sqrt(3) / 2])).toBe(true);
  expect(has(sols, [0.5, Math.sqrt(3) / 2])).toBe(true);
});

test('a line missing a circle has no solutions', () => {
  expect(solveSystem(sys('x^2 + y^2 - 1', 'y - 5'), ['x', 'y'], [-4, -4], [4, 4])).toEqual([]);
});

test('three planes meet in a point', () => {
  const sols = solveSystem(sys('x - 1', 'y + 2', 'z - 3'), ['x', 'y', 'z'], [-9, -9, -9], [9, 9, 9]);
  expect(sols).toHaveLength(1);
  expect(near(sols[0], [1, -2, 3])).toBe(true);
});

test('solutions outside the box are dropped', () => {
  const sols = solveSystem(sys('x^2 - 4', 'y'), ['x', 'y'], [0, -1], [9, 1]);
  expect(sols).toHaveLength(1);
  expect(near(sols[0], [2, 0])).toBe(true);
});

test('constants in scope are honoured', () => {
  const sols = solveSystem(sys('x - a', 'y - 2a'), ['x', 'y'], [-9, -9], [9, 9], { env: { a: 3 } });
  expect(near(sols[0], [3, 6])).toBe(true);
});

test('a repeated call returns identical points (no random seeding)', () => {
  const args = [sys('x^2 + y^2 - 4', 'x y - 1'), ['x', 'y'], [-5, -5], [5, 5]] as const;
  expect(solveSystem(...args)).toEqual(solveSystem(...args));
});

test('a high-multiplicity system root is localized to one point', () => {
  const sols = solveSystem(sys('x^8', 'y'), ['x', 'y'], [-4, -4], [4, 4]);
  expect(sols).toHaveLength(1);
  expect(near(sols[0], [0, 0], 1e-7)).toBe(true);
});

test('extrapolation retains a shifted multiple root without inventing near misses', () => {
  const boxLo = [-4, -4], boxHi = [4, 4];
  const sols = solveSystem(sys('(x-0.37)^8', 'y-0.42'), ['x', 'y'], boxLo, boxHi);
  expect(sols).toHaveLength(1);
  expect(near(sols[0], [0.37, 0.42], 1e-7)).toBe(true);
  expect(solveSystem(sys('x^8 + 0.00000001', 'y'), ['x', 'y'], boxLo, boxHi)).toEqual([]);
});

test('extrapolation does not lose nearby roots of a perturbed multiple root', () => {
  const sols = solveSystem(sys('x^8 - 0.00000000000001', 'y'), ['x', 'y'], [-4, -4], [4, 4]);
  const root = Math.pow(1e-14, 1 / 8);
  expect(sols).toHaveLength(2);
  expect(has(sols, [-root, 0])).toBe(true);
  expect(has(sols, [root, 0])).toBe(true);
});

// The Alpoge/Fable counterexample to the Jacobian conjecture: det JF = -2
// everywhere, yet three distinct points share the fiber over (-1/4, 0, 0).
const P = '(1+x y)^3 z + y^2 (1+x y)(4+3 x y)';
const Q = 'y + 3 x (1+x y)^2 z + 3 x y^2 (4+3 x y)';
const R = '2 x - 3 x^2 y - x^3 z';

test('the Jacobian counterexample fiber has its three points', () => {
  const sols = solveSystem(
    sys(`${P} + 1/4`, Q, R),
    ['x', 'y', 'z'],
    [-4, -4, -4],
    [4, 4, 12],
  );
  expect(sols).toHaveLength(3);
  expect(has(sols, [0, 0, -0.25], 1e-5)).toBe(true);
  expect(has(sols, [1, -1.5, 6.5], 1e-5)).toBe(true);
  expect(has(sols, [-1, 1.5, 6.5], 1e-5)).toBe(true);
});

test('a fiber of the same map with one real point', () => {
  // F(0,0,0) = (0,0,0); the other two preimages run off to infinity.
  const sols = solveSystem(sys(P, Q, R), ['x', 'y', 'z'], [-4, -4, -4], [4, 4, 12]);
  expect(sols).toHaveLength(1);
  expect(has(sols, [0, 0, 0], 1e-5)).toBe(true);
});
