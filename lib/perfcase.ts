/** Performance corpus compiled through the same document pipeline as web/worker. */
import { analyzeRows } from './analysis.ts';
import type { Classified } from './plot.ts';
import { type CpuPlan, type GpuPlan, type GpuGrid, compileGridGpu } from './compiler.ts';

export interface CompiledRows {
  classified: Classified[];
  gridFields: GpuGrid[];
  cpu: CpuPlan[];
  gpu: GpuPlan[];
  errors: string[];
}

export function compileRows(rows: string[]): CompiledRows {
  const analysis = analyzeRows(rows, { readouts: false });
  const failedPlot = analysis.rows.find(row => row.error && !row.def);
  if (failedPlot) throw new Error(failedPlot.error);
  return {
    classified: analysis.rows.flatMap(row => row.cls ? [row.cls] : []),
    gridFields: analysis.gridFields.map(compileGridGpu),
    cpu: analysis.rows.flatMap(row => row.cpu ? [row.cpu] : []),
    gpu: analysis.rows.flatMap(row => row.gpu ? [row.gpu] : []),
    errors: analysis.rows.flatMap(row => row.error ? [row.error] : []),
  };
}

/**
 * Representative rows spanning every compile path, each with a slider
 * constant so uniform-parameterization can be asserted. When a new plot
 * family lands, add a case here (and a budget in perf-guards.test.ts).
 */
export const CORPUS: { name: string; rows: (c: number) => string[] }[] = [
  { name: 'scalar2d', rows: c => [`a = ${c}`, 'y = sin(a x) + x^2/4'] },
  { name: 'implicit2d', rows: c => [`c = ${c}`, 'x^2 + y^2 = c^2'] },
  { name: 'ineq2d', rows: c => [`a = ${c}`, 'y < a x^2'] },
  { name: 'complex2d', rows: c => [`a = ${c}`, 'w^2 + a'] },
  { name: 'pcurve3d', rows: c => [`k = ${c}`, '(cos(2pi k u), sin(2pi k u), u)'] },
  { name: 'psurface', rows: c => [`b = ${c}`, '(u, v, b u v)'] },
  { name: 'implicit3d', rows: c => [`b = ${c}`, 'z = sin(b x) cos(b y)'] },
  { name: 'point', rows: c => [`a = ${c}`, '(a, a^2)'] },
  { name: 'derivative', rows: c => [`a = ${c}`, 'y = d/dx (sin(a x) x^2)'] },
  { name: 'userfn', rows: c => [`a = ${c}`, 'f(x) = a x^2 + sin(x)', 'y = f(f(x))'] },
  { name: 'polarfield', rows: c => [`a = ${c}`, 'r = sqrt(x^2 + y^2)', 'r = 2a'] },
  { name: 'vfield2d', rows: c => [`a = ${c}`, '(-a y, a x)'] },
  { name: 'ode2d', rows: c => [`a = ${c}`, 'dy/dx = a x y'] },
  { name: 'domain2d', rows: c => [`a = ${c}`, 'domain((w^3 - a)/w)'] },
  { name: 'conformal2d', rows: c => [`a = ${c}`, 'conformal(w^2/a)'] },
  { name: 'fractal2d', rows: c => [`a = ${c}`, 'iter(z^2 + w/a)'] },
  // Sequences, recurrences, lists, piecewise, and number theory (README rows).
  { name: 'sequence', rows: c => [`a = ${c}`, 'a_n = a/n^2'] },
  { name: 'seq-isprime', rows: c => [`a = ${c}`, 'a_n = a isprime(n)'] },
  { name: 'seq-sum-term', rows: c => [`a = ${c}`, 'a_n = a sum(k=1..3, k^n)'] },
  { name: 'cobweb', rows: c => [`r = ${c}`, 'a_{n+1} = r a_n (1 - a_n)'] },
  { name: 'cobweb-seed', rows: c => [`a_0 = ${c}`, 'a_{n+1} = a_n/2 + 1'] },
  { name: 'bifurcation', rows: c => [`a_0 = ${c}`, 'a_{n+1} = x a_n (1 - a_n)'] },
  { name: 'vlist', rows: c => [`a = ${c}`, '[a, 1, 4, 1, 5]'] },
  { name: 'plist', rows: c => [`a = ${c}`, '[(a, 2), (3, 4)]'] },
  { name: 'plist3d', rows: c => [`a = ${c}`, '[(1, 2, a), (4, 5, 6)]'] },
  { name: 'piecewise', rows: c => [`a = ${c}`, 'y = {x < 0: -a x, x >= 0: a x^2}'] },
  { name: 'piecewise-default', rows: c => [`a = ${c}`, 'y = {x < a: sin(x), cos(x)}'] },
  { name: 'gcd2d', rows: c => [`a = ${c}`, 'y = gcd(floor(x), floor(a x))'] },
  // Square systems carry residual Exprs (CPU-solved), no GLSL.
  { name: 'system2d', rows: c => [`a = ${c}`, '(x^2 + y^2 - a, x y - 1) = (0, 0)'] },
  { name: 'system3d', rows: c => [`a = ${c}`, '(x + y, x - y, z - a) = (1, 2, 3)'] },
  // Time-integrated state (a' = …): the state a is a u_a uniform downstream,
  // so neither the deriv constant k nor the a(0) slider may leak into GLSL.
  { name: 'state', rows: c => [`k = ${c}`, "a' = -k a + sin(t)", `a(0) = ${c}`, 'y = a sin(x)'] },
];

/**
 * Σ/Π is the one compile path that deliberately breaks uniform
 * parameterization: bounds expand at compile time, so the bound constant's
 * *value* is baked into the output and every step of an N slider produces
 * new GLSL — and a new shader compile. Kept out of CORPUS (which asserts the
 * invariant) and pinned separately in perf-guards.test.ts, so the cost stays
 * measured rather than forgotten.
 */
export const SUM_CASE = (n: number) => [`N = ${n}`, 'y = (4/pi) sum(k=1..N, sin((2k-1)x)/(2k-1))'];

/** Structural size of an expression tree (perf proxy for symbolic swell). */
export { countNodes } from './size.ts';
