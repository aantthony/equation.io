import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { vertexSampler } from './figure-vertices.ts';
import { exprKey, parseExpr } from './expr.ts';
import { lowerLists } from './list.ts';
import { cpuStructureKey } from './compiler.ts';

/** The complete graph on n points of a Fibonacci sphere, as one polyline:
 *  with n prime, stepping by s = 1…(n-1)/2 walks every edge once. */
const sphere = (n: number) => [
  `n = ${n}`, 'g = pi(3 - sqrt(5))', 'm = [0..n(n-1)/2]', 'h(j) = 1 - (2j+1)/n',
  'F(j) = (sqrt(1 - h(j)^2) cos(g j), sqrt(1 - h(j)^2) sin(g j), h(j))',
  'rotate(polyline(F(mod((floor(m/n) + 1) mod(m, n), n))), t/5, (0, 1, 0))',
];

const polygonPlan = (rows: string[], at = rows.length - 1) => {
  const analysis = analyzeRows(rows, { backend: 'cpu', readouts: false });
  const row = analysis.rows[at];
  expect(row.error).toBeUndefined();
  if (row.cpu?.type !== 'polygon') throw new Error(`expected a polygon plan, got ${row.cpu?.type}`);
  return { plan: row.cpu, env: analysis.constEnv };
};

describe('lazy lists', () => {
  const list = (n: number): Float64Array => Float64Array.from({ length: n }, (_, k) => k);
  const getList = (name: string) => (name === 'L' ? { kind: 'data', values: list(5) } as const : null);

  it('keep a slider over packed numbers as one template, when asked', () => {
    const lazy = lowerLists(parseExpr('sin(a L) + a'), getList, {}, false, true);
    expect(lazy.kind).toBe('lazy');
    if (lazy.kind !== 'lazy') return;
    expect(lazy.cols).toHaveLength(1);
    expect(lazy.cols[0].values).toEqual(list(5));
  });

  it('settle into the same per-element expressions as before otherwise', () => {
    const settled = lowerLists(parseExpr('sin(a L) + a'), getList);
    expect(settled.kind).toBe('list');
    if (settled.kind !== 'list') return;
    expect(settled.items.map(exprKey)).toEqual([0, 1, 2, 3, 4].map(k => exprKey(parseExpr(`sin(a ${k}) + a`))));
  });

  it('name their columns per lowering, so a row lowers to the same template every time', () => {
    const once = lowerLists(parseExpr('(L, a L)'), getList, {}, false, true);
    const again = lowerLists(parseExpr('(L, a L)'), getList, {}, false, true);
    expect(exprKey(once)).toBe(exprKey(again));
  });
});

describe('packed figures', () => {
  it('draw a polyline through thousands of computed points as one vertex template', () => {
    const { plan } = polygonPlan(sphere(101));
    expect(plan.over?.[0].values.length).toBe(101 * 100 / 2 + 1);
    expect(plan.pts).toHaveLength(3);
  });

  it('analyze a 5051-point figure quickly', () => {
    polygonPlan(sphere(101));
    const started = performance.now();
    polygonPlan(sphere(101));
    // Unrolled, this was one tree per coordinate and over a second.
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('put every edge of the complete graph in the path, each vertex on the unit sphere', () => {
    const n = 13;
    const { plan, env } = polygonPlan(sphere(n));
    const xyz = vertexSampler(plan.pts, plan.over)(env, 0);
    const at = (k: number) => xyz.slice(3 * k, 3 * k + 3);
    for (let k = 0; k < xyz.length / 3; k++) expect(Math.hypot(...at(k))).toBeCloseTo(1, 9);
    const key = (k: number) => at(k).map(c => c.toFixed(9)).join();
    const vertices = new Map<string, number>();
    const edges = new Set<string>();
    for (let k = 0; k + 1 < xyz.length / 3; k++) {
      const [a, b] = [key(k), key(k + 1)].map(v => vertices.get(v) ?? (vertices.set(v, vertices.size), vertices.size - 1));
      edges.add([Math.min(a, b), Math.max(a, b)].join());
    }
    expect(vertices.size).toBe(n);
    expect(edges.size).toBe(n * (n - 1) / 2);
  });

  it('keep their structure across slider values that do not change the length', () => {
    const rows = (a: number) => [`a = ${a}`, 'k = [0..99]', 'polyline(rotate((k, sin(a k)), t))'];
    expect(cpuStructureKey(polygonPlan(rows(1)).plan)).toBe(cpuStructureKey(polygonPlan(rows(2)).plan));
  });

  it('keep the limits and messages of an unpacked figure', () => {
    const error = (rows: string[]) => analyzeRows(rows, { backend: 'cpu', readouts: false }).rows.at(-1)!.error;
    expect(error(['a = 1', 'k = [0]', 'polyline((k, a k))'])).toMatch(/at least 2 points/);
    expect(error(['a = 1', 'k = [0, 1]', 'polygon((k, a k))'])).toMatch(/at least 3 vertices/);
    expect(error(['a = 1', 'k = [1..2001]', 'hull((k, a k, k^2))'])).toMatch(/3D hull takes at most 2000 points/);
  });
});
