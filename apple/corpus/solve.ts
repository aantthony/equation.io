/**
 * Runs lib/solve.ts and the numeric path of lib/roots.ts over a corpus and
 * writes what they return as the Swift port's conformance fixture
 * (SolveConformanceTests.swift).
 *
 *   pnpm swift:solve-corpus
 *
 * A case is marked `exact` when its expressions use only what every IEEE
 * machine computes alike (+, -, *, /, sqrt, abs, floor, …): there the Swift
 * must return the same doubles in the same order. Elsewhere (powers, sin,
 * exp) the C library and V8 can differ in a last place, and the Swift is
 * held to the same solutions within a tolerance.
 */
import { writeFileSync } from 'node:fs';
import { childrenOf, type Expr, parseExpr } from '../../lib/expr.ts';
import { polynomialRoots } from '../../lib/poly.ts';
import { findRoots } from '../../lib/roots.ts';
import { type SolveOptions, solveLinear, solveSystem, traceSystem } from '../../lib/solve.ts';

const fixtures = new URL('../EquationCore/Tests/EquationCoreTests/Fixtures/', import.meta.url);

// Every number as text (see diff.ts): exact digits, and NaN, ±Infinity and -0.
const replacer = (key: string, value: unknown): unknown => {
  if (key === 'axes' || key === 'origin') return undefined;
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  return value;
};

const EXACT_CALLS = new Set(['sqrt', 'abs', 'floor', 'ceil', 'sign', 'min', 'max', 'mod', 'fract']);
const exactOps = (e: Expr): boolean =>
  (e.kind !== 'bin' || e.op !== '^') && (e.kind !== 'call' || EXACT_CALLS.has(e.name)) && childrenOf(e).every(exactOps);

const sys = (src: string[]): Expr[] => src.map(s => parseExpr(s));

// --- solveSystem ---

type SolveCase = [src: string[], vars: string[], lo: number[], hi: number[], opts?: SolveOptions];
const P = '(1+x y)^3 z + y^2 (1+x y)(4+3 x y)';
const Q = 'y + 3 x (1+x y)^2 z + 3 x y^2 (4+3 x y)';
const R = '2 x - 3 x^2 y - x^3 z';
const xy = ['x', 'y'];
const xyz = ['x', 'y', 'z'];
const box = (n: number, r: number): [number[], number[]] => [
  new Array<number>(n).fill(-r),
  new Array<number>(n).fill(r),
];
const solveCases: SolveCase[] = [
  // lib/solve.test.ts
  [['x^2 + y^2 - 1', '(x-1)^2 + y^2 - 1'], xy, ...box(2, 3)],
  [['x^2 + y^2 - 1', 'y - 5'], xy, ...box(2, 4)],
  [['x - 1', 'y + 2', 'z - 3'], xyz, ...box(3, 9)],
  [['x^2 - 4', 'y'], xy, [0, -1], [9, 1]],
  [['x - a', 'y - 2a'], xy, ...box(2, 9), { env: { a: 3 } }],
  [['x^8', 'y'], xy, ...box(2, 4)],
  [['(x-0.37)^8', 'y-0.42'], xy, ...box(2, 4)],
  [['x^8 + 0.00000001', 'y'], xy, ...box(2, 4)],
  [['x^8 - 0.00000000000001', 'y'], xy, ...box(2, 4)],
  [[`${P} + 1/4`, Q, R], xyz, [-4, -4, -4], [4, 4, 12]],
  [[P, Q, R], xyz, [-4, -4, -4], [4, 4, 12]],
  // The same shapes in exact arithmetic.
  [['x*x + y*y - 1', '(x-1)*(x-1) + y*y - 1'], xy, ...box(2, 3)],
  [['x*x + y*y - 1', 'y - 5'], xy, ...box(2, 4)],
  [['x*x - 4', 'y'], xy, [0, -1], [9, 1]],
  [['x*x - 4', 'y'], xy, [0, -1], [1.95, 1]],
  [['x*x - 4', 'y'], xy, [0, -1], [1.95, 1], { margin: 0 }],
  [['x*x*x*x*x*x*x*x', 'y'], xy, ...box(2, 4)],
  [['(x-0.37)*(x-0.37)*(x-0.37)', 'y-0.42'], xy, ...box(2, 4)],
  [['x*x + y*y - 4', 'x*y - 1'], xy, ...box(2, 5)],
  [['x*x - y*y - 1', 'x*x + 4*y*y - 4'], xy, ...box(2, 5)],
  [['y - x*x*x + x', 'x - y*y*y + y'], xy, ...box(2, 3)],
  [['y*y - x*x*x + x', 'x + y - 0.25'], xy, ...box(2, 3)],
  [['x*y', 'x + y'], xy, ...box(2, 2)],
  [['x*y', 'x*y'], xy, ...box(2, 2)],
  [['x - y', '2*x - 2*y'], xy, ...box(2, 2)],
  [['0*x', 'y'], xy, ...box(2, 2)],
  [['sqrt(x) - y', 'x + y - 2'], xy, ...box(2, 5)],
  [['sqrt(x*x + y*y) - 2', 'y - x/3'], xy, ...box(2, 5)],
  [['abs(x) - y', 'x*x + y*y - 2'], xy, ...box(2, 5)],
  [['abs(x) + abs(y) - 1', 'x - 2*y'], xy, ...box(2, 5)],
  [['floor(x) - y', 'x + y - 3.5'], xy, ...box(2, 5)],
  [['x - floor(x) - 0.5', 'y - x'], xy, ...box(2, 3)],
  [['mod(x, 2) - 1', 'y - 0.5*x'], xy, ...box(2, 5)],
  [['max(x, y) - 1', 'min(x, y) + 1'], xy, ...box(2, 5)],
  [['1/x - y', 'x - y'], xy, ...box(2, 5)],
  [['1/(x*x + y*y) - 1', 'x - y'], xy, ...box(2, 5)],
  [['{x < 0: x + 1, x - 1} - y', 'y'], xy, ...box(2, 5)],
  [['{x < 0: x + 1} - y', 'y'], xy, ...box(2, 5)],
  [['{0 < x < 2: x*x - 1, x + 3}', 'y - x'], xy, ...box(2, 5)],
  [['x*x + y*y + 1', 'x'], xy, ...box(2, 5)],
  [['x + y + z - 6', 'x*y*z - 6', 'x*x + y*y + z*z - 14'], xyz, ...box(3, 5)],
  [['x*x + y*y + z*z - 9', 'z - 1', 'x - y'], xyz, ...box(3, 4)],
  [['x*x + y*y - z', 'z - 4', 'x*y'], xyz, [-3, -3, 0], [3, 3, 9]],
  [['x*y - z', 'y*z - x', 'z*x - y'], xyz, ...box(3, 2)],
  [['sqrt(x*x + y*y + z*z) - 3', 'abs(x) - 1', 'y - 2'], xyz, ...box(3, 4)],
  [['x - a*y', 'x*x + y*y - b'], xy, ...box(2, 6), { env: { a: 0.75, b: 13, x: 100 } }],
  [['x - q', 'y'], xy, ...box(2, 6)],
  [
    ['x*x + y*y - 4', 'x*y - 1'],
    xy,
    ...box(2, 5),
    {
      seeds: [
        [2, 0.5],
        [0.5, 2],
        [100, 100],
        [NaN, 0],
      ],
      lattice: false,
    },
  ],
  [['x*x + y*y - 4', 'x*y - 1'], xy, ...box(2, 5), { seeds: [[-1.9, -0.5]] }],
  [['x*x + y*y - 4', 'x*y - 1'], xy, ...box(2, 5), { margin: 2 }],
  [['x*x + y*y - 4', 'x*y - 1'], xy, [0, 0], [1.5, 1.5], { margin: 0.5 }],
  [['x*x + y*y - 4', 'x*y - 1'], xy, [1e-3, 1e-3], [1e3, 1e3]],
  [['x*x + y*y - 4e12', 'x*y - 1e12'], xy, ...box(2, 5e6)],
  [['x*x + y*y - 4e-12', 'x*y - 1e-12'], xy, ...box(2, 5e-6)],
  // Refused outright.
  [['x', 'y'], xy, [0, 0], [0, 1]],
  [['x', 'y'], xy, [0, 0], [Infinity, 1]],
  [['x', 'y'], xy, [1, 0], [0, 1]],
  [['x'], ['x'], [0], [1]],
  [['x', 'y'], xyz, ...box(3, 1)],
  // Powers, and what the C library computes.
  [['x^2 + y^2 - 4', 'x y - 1'], xy, ...box(2, 5)],
  [['x^3 - y', 'y^3 - x'], xy, ...box(2, 3)],
  [['sin(x) - y', 'cos(x) - y'], xy, ...box(2, 7)],
  [['sin(x + y)', 'cos(x - y)'], xy, ...box(2, 3)],
  [['exp(x) - y', 'x + y - 2'], xy, ...box(2, 5)],
  [['ln(x) - y', 'x - 2y - 1'], xy, ...box(2, 9)],
  [['x^y - 2', 'y - x'], xy, [0.1, 0.1], [5, 5]],
  [['sin(x) cos(y) - 0.25', 'x^2 + y^2 - 9', 'z - x y'], xyz, ...box(3, 5)],
  [['x - 2', 'y - 7'], xy, ...box(2, 9), { angular: [false, true] }],
  [['x - y', 'x + y - 20'], xy, ...box(2, 9), { angular: [true, true] }],
  [['floor(x) + y - 20', 'x - 0.5'], xy, ...box(2, 9), { angular: [true, false] }],
];
const solved = solveCases.map(([src, vars, lo, hi, opts]) => {
  const residuals = sys(src);
  const result = solveSystem(residuals, vars, lo, hi, opts);
  const exact = residuals.every(exactOps) && !opts?.angular?.some(Boolean);
  return { src, residuals, vars, lo, hi, opts: opts ?? {}, exact, result };
});

// --- solveLinear ---

const linearCases: [J: number[][], b: number[]][] = [
  [
    [
      [2, 1],
      [1, 3],
    ],
    [3, 5],
  ],
  [
    [
      [0, 1],
      [1, 0],
    ],
    [3, 5],
  ],
  [
    [
      [1, 2],
      [2, 4],
    ],
    [3, 5],
  ],
  [
    [
      [1e-301, 0],
      [0, 1],
    ],
    [1, 1],
  ],
  [
    [
      [1e-200, 1],
      [1, 1],
    ],
    [1, 2],
  ],
  [
    [
      [NaN, 1],
      [1, 1],
    ],
    [1, 2],
  ],
  [
    [
      [1, 1],
      [1, 1 + 2 ** -52],
    ],
    [Infinity, 2],
  ],
  [
    [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 10],
    ],
    [1, 2, 3],
  ],
  [
    [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ],
    [1, 2, 3],
  ],
  [
    [
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ],
    [0.1, 0.2, 0.3],
  ],
  [
    [
      [0.1, 0.7, -0.3],
      [-2.5, 0.01, 4],
      [3, 3, 3],
    ],
    [1e10, -1e-10, 0.5],
  ],
];
const linear = linearCases.map(([J, b]) => ({ J, b, result: solveLinear(J, b, b.length) }));

// --- traceSystem ---

type TraceCase = [
  src: string[],
  vars: string[],
  lo: number[],
  hi: number[],
  env?: Record<string, number>,
  samples?: number,
  angular?: boolean[],
];
const traceCases: TraceCase[] = [
  [['x*x + y*y - 4', 'y - (2*u - 1)*x - 0.5'], xy, ...box(2, 5), {}, 64],
  [['x - (4*u - 2)', 'y - x*x'], xy, ...box(2, 5), {}, 64],
  [['x - (4*u - 2)', 'y - x*x'], xy, ...box(2, 3), {}, 256],
  [['x - a*(u - 0.5)', 'y - floor(4*u)'], xy, ...box(2, 5), { a: 6 }, 64],
  [['x - 6*(u - 0.5)', 'y - {u < 0.5: x, 0 - x}'], xy, ...box(2, 5), {}, 64],
  [['x - 6*(u - 0.5)', 'y - abs(x) - mod(8*u, 1)'], xy, ...box(2, 5), {}, 48],
  [['x*x - y*y - (u - 0.5)', 'x*y - 1'], xy, ...box(2, 4), {}, 40],
  [['x - 4*(u - 0.5)', 'y - 4*(u - 0.5)', 'z - x*y'], xyz, ...box(3, 5), {}, 32],
  [['x*x + y*y - 4', 'y - 5 - u'], xy, ...box(2, 5), {}, 16],
  [['x - 3 cos(2 pi u)', 'y - 3 sin(2 pi u)'], xy, ...box(2, 5), {}, 64],
  [['x - 3 cos(20 pi u)', 'y - 3 sin(20 pi u)'], xy, ...box(2, 5), {}, 32],
  [['x^2 + y^2 - 4', 'y - tan(3 u - 1.5) x'], xy, ...box(2, 5), {}, 48],
  [['x - 8 u', 'y - 8 u'], xy, [-4, -4], [4, 4], {}, 32, [true, true]],
];
const traced = traceCases.map(([src, vars, lo, hi, env = {}, samples = 256, angular = []]) => {
  const residuals = sys(src);
  const result = traceSystem(residuals, vars, lo, hi, env, samples, angular);
  const exact = residuals.every(exactOps) && !angular.some(Boolean);
  return { src, residuals, vars, lo, hi, env, samples, angular, exact, result };
});

// --- findRoots, the numeric path ---

const rootCases: [src: string, lo: number, hi: number, v?: string][] = [
  // lib/roots.test.ts
  ['sin(x)', -10, 10],
  ['sin(x)^2', 1, 5],
  ['sin(x)^2 + 0.001', -5, 5],
  ['tan(x)', 1, 2],
  ['exp(x) - 2', -5, 5],
  ['ln(x)', -5, 5],
  ['(0.1x - 0.3)^16', -10, 10],
  ['(0.1x - 0.3)^128', -10, 10],
  ['(x - 0.1)^32 (x - 0.3)^32', -10, 10],
  // Exact arithmetic that is not a polynomial.
  ['sqrt(x) - 1', -5, 5],
  ['sqrt(x) - 1', 0, 1],
  ['sqrt(x*x)', -5, 5],
  ['abs(x) - 1', -5, 5],
  ['abs(x)', -5, 5],
  ['abs(x) - 1', -1, 1],
  ['abs(x*x - 2) - 1', -3, 3],
  ['abs(x*x*x - x)', -2, 2],
  ['1/x - 2', -5, 5],
  ['1/x', -5, 5],
  ['(x*x - 1)/(x - 1)', -5, 5],
  ['x/abs(x) + x', -5, 5],
  ['x*x*x - 2*x + floor(x)', -5, 5],
  ['floor(x)', -3, 3],
  ['floor(x) - 0.5', -3, 3],
  ['x - floor(x) - 0.5', -3, 3],
  ['mod(x, 2) - 1', -5, 5],
  ['sign(x) + x', -5, 5],
  ['max(x, 0)', -1, 1],
  ['max(x*x - 1, 0 - x)', -3, 3],
  ['min(abs(x - 1), abs(x + 1))', -3, 3],
  ['sqrt(abs(x)) - x*x', -3, 3],
  ['abs(x)*abs(x)', -3, 3],
  ['abs(x)*x*x - 1e-9', -3, 3],
  ['{x < 0: x + 1, x*x - 2}', -5, 5],
  ['{x < 0: x + 1}', -5, 5],
  ['{0 < x < 2: (x - 1)*(x - 1)}', -5, 5],
  ['sqrt(0 - 1 - x*x)', -5, 5],
  ['abs(x) - abs(x)', -5, 5],
  ['abs(t) - a', -5, 5, 't'],
  ['abs(x) - 1', 5, -5],
  ['abs(x) - 1', 0, Infinity],
  ['abs(x) - 1', 1, 1],
  ['abs(x - 1e6) - 1', 0, 2e6],
  ['abs(x) - 1e-9', -1e-6, 1e-6],
  ['1e12*abs(x) - 1e12', -5, 5],
  // The C library's.
  ['cos(x) - x', -5, 5],
  ['x sin(1/x)', 0.05, 1],
  ['exp(-x^2) - 0.5', -5, 5],
  ['sqrt(x) - x^2', -3, 3],
  ['x^x - 2', 0, 5],
  ['sin(x) + floor(x)', -5, 5],
  ['(x - 1)^3 exp(x)', -5, 5],
  ['1 - cos(x)', -10, 10],
  ['tan(x) - x', -5, 5],
  ['ln(x^2) - 1', -5, 5],
];
const roots = rootCases.flatMap(([src, lo, hi, v = 'x']) => {
  const f = parseExpr(src);
  // A polynomial takes lib/poly.ts's exact path, which the Swift does not have yet.
  if (hi > lo && isFinite(lo) && isFinite(hi) && polynomialRoots(f, v) !== null) {
    throw new Error(`${src} is a polynomial: not the numeric path`);
  }
  const found = findRoots(f, v, lo, hi);
  const result = found === 'zero' ? 'zero' : found.map(r => ({ x: r.x, mult: r.mult, exact: r.exact }));
  return [{ src, f, v, lo, hi, exact: exactOps(f), result }];
});

const fixture = { solve: solved, linear, trace: traced, roots };
writeFileSync(new URL('solve-corpus.json', fixtures), JSON.stringify(fixture, replacer) + '\n');
const count = (list: { exact: boolean }[]): string => `${list.length} (${list.filter(c => c.exact).length} exact)`;
console.log(
  `${count(solved)} systems, ${linear.length} linear, ${count(traced)} traces, ${count(roots)} root searches;`,
  `${solved.reduce((n, c) => n + c.result.length, 0)} solutions,`,
  `${traced.reduce((n, c) => n + c.result.reduce((m, p) => m + p.length, 0), 0)} traced points,`,
  `${roots.reduce((n, c) => n + (c.result === 'zero' ? 0 : c.result.length), 0)} roots`,
);
