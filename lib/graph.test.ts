import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { evaluate } from './expr.ts';
import { collectEdges, edgeEvaluator, edgeText, graphRadius, layoutGraph } from './graph.ts';

/** The graph the last graph(…) row of `rows` draws, compiled as the app
 *  runs it and checked against evaluate(). */
function graphOf(rows: string[]) {
  const a = analyzeRows(rows);
  const bad = a.rows.find(r => r.error);
  if (bad) throw new Error(bad.error);
  const row = a.rows.findLast(r => r.cpu?.type === 'graph');
  if (row?.cpu?.type !== 'graph') throw new Error('no graph row');
  const env = { ...a.constEnv, t: 0 };
  const g = collectEdges(edgeEvaluator(row.cpu.edges)(env));
  expect(g).toEqual(collectEdges(row.cpu.edges.map(e => e.map(c => evaluate(c, env)))));
  return g;
}
const arrows = (g: ReturnType<typeof collectEdges>) =>
  g.edges.map(e => `${e.from}>${e.to}${edgeText(e) && ':' + edgeText(e)}`).sort();

describe('graph rows', () => {
  it('a Cayley graph of ℤ/n: one name, chosen together', () => {
    const g = graphOf(['k = [0..5]', 'graph(k, mod(k + 1, 6))']);
    expect(g.vertices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(arrows(g)).toEqual(['0>1', '1>2', '2>3', '3>4', '4>5', '5>0']);
  });

  it('separate lists cross: every transition of a state machine', () => {
    // Remainder mod 3 of a binary number read left to right.
    const g = graphOf(['Q = [0..2]', 'S = [0, 1]', 'step(q, s) = mod(2q + s, 3)', 'graph(Q, step(Q, S), S)']);
    expect(arrows(g)).toEqual(['0>0:0', '0>1:1', '1>0:1', '1>2:0', '2>1:0', '2>2:1']);
  });

  it('a list of pairs as it is, and a repeated arrow counted', () => {
    const g = graphOf(['graph([(1, 2), (2, 3), (1, 2)])']);
    expect(arrows(g)).toEqual(['1>2:×2', '2>3']);
    expect(arrows(graphOf(['graph(1, 2)']))).toEqual(['1>2']);
  });

  it('is a graph row only when the call is the whole row', () => {
    const graphed = (text: string) => analyzeRows([text]).rows[0].cpu?.type === 'graph';
    expect(graphed('graph(1, 2)*(3)')).toBe(false);
    expect(graphed('graph(1, 2) + graph(3, 4)')).toBe(false);
    expect(graphed('mark(1) + (2)')).toBe(false);
    expect(arrows(graphOf(['graph(1, (2))']))).toEqual(['1>2']);
  });

  it('a case may test equality in any row not drawn over the plane', () => {
    const value = (rows: string[]) => {
      const a = analyzeRows(rows, { readouts: true });
      const row = a.rows.at(-1)!;
      return row.error ?? row.info;
    };
    const c = 'c(m) = {mod(m, 2) = 0: m/2, 3m + 1}';
    expect(value([c, 'c(4)'])).toBe('= 2');
    expect(value([c, 'c(7)'])).toBe('= 22');
    expect(value(['s = 3', '{s = 3: 1, 0}'])).toBe('= 1');
    // At x it would be a curve's sliver: refused on the row that draws it.
    expect(value(['y = {x = 0: 1, 0}'])).toMatch(/piecewise conditions are inequalities/);
    expect(value(['f(x) = {x = 0: 1, sin(x)/x}', 'y = f(x)'])).toMatch(/inequalities/);
  });

  it('a document that defines graph or mark calls its own function', () => {
    const value = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!.info;
    expect(value(['graph(x) = x^2', 'graph(3)'])).toBe('= 9');
    expect(value(['mark(x) = x + 1', 'mark(3)'])).toBe('= 4');
  });

  it('matrix multiplication as composing arrows (Wildberger)', () => {
    // A = [[1 1] [0 2]] and B = [[0 1] [1 1]] as multisets of arrows i → j.
    const g = graphOf([
      'A = [(1, 1), (1, 2), (2, 2), (2, 2)]',
      'B = [(1, 2), (2, 1), (2, 2)]',
      'graph({A.y = B.x: A.x}, B.y)',
    ]);
    // AB = [[1 2] [2 2]]: (AB)_ik counts the two-step paths i → j → k.
    expect(arrows(g)).toEqual(['1>1', '1>2:×2', '2>1:×2', '2>2:×2']);
  });

  it('composition as a function of two arrows, named, chained and squared', () => {
    const AB = ['A = [(1, 1), (1, 2), (2, 2), (2, 2)]', 'B = [(1, 2), (2, 1), (2, 2)]'];
    // i → j then j → k is i → k; a pair that does not meet is no arrow.
    const c = 'c(p, q) = {p.y = q.x: (p.x, q.y)}';
    const product = ['1>1', '1>2:×2', '2>1:×2', '2>2:×2'];
    expect(arrows(graphOf([...AB, c, 'graph(c(A, B))']))).toEqual(product);
    expect(arrows(graphOf([...AB, c, 'AB = c(A, B)', 'graph(AB)']))).toEqual(product);
    expect(arrows(graphOf([...AB, 'AB = {A.y = B.x: (A.x, B.y)}', 'graph(AB)']))).toEqual(product);
    // A named value stays tied to the lists it is built from: AB's arrows
    // each keep the B arrow they came from, so c(AB, B) pairs each with that
    // one (1→1 then 1→2 is 1→2; 2→2 then 2→2 twice). Composing AB with B
    // again, ABB, takes a second draw from B: a binder, q ∈ B.
    expect(arrows(graphOf([...AB, c, 'AB = c(A, B)', 'graph(c(AB, B))']))).toEqual(['1>2', '2>2:×2']);
    // One name is one choice: c(A, A) pairs each arrow with itself, the
    // loops, and so does c(A, [A]): [A] is A. (A², two independent draws
    // from A, is for binders, p ∈ A and q ∈ A: docs/multisets.md §0.)
    expect(arrows(graphOf([...AB, c, 'graph(c(A, A))']))).toEqual(['1>1', '2>2:×2']);
    expect(arrows(graphOf([...AB, c, 'graph(c(A, [A]))']))).toEqual(['1>1', '2>2:×2']);
    // A coordinate read takes a point of any dimension that has it.
    const x = analyzeRows(['f(p) = p.x', 'P = [(1, 2, 5), (3, 4, 6)]', 'f(P + (0, 0, 0))'], { readouts: true });
    expect(x.rows.at(-1)!.info).toBe('= [1, 3]');
    // A named point or a matrix gives its own coordinates.
    expect(analyzeRows(['P = (1, 2)', 'f(p) = p.x + p.y', 'f(P)'], { readouts: true }).rows.at(-1)!.info).toBe('= 3');
    const z = analyzeRows(['f(p) = p.z', 'P = [(1, 2), (3, 4)]', 'f(P + (0, 0))']);
    expect(z.rows.at(-1)!.error).toMatch(/reads a coordinate that point does not have/);
  });

  it('every step of the Collatz orbits of 1..10: recursion over two lists', () => {
    // Each (k, j) member inlines f's loop several times, so the cost grows
    // with both lists (docs/shared-loop-bodies-plan.md): kept small here.
    const g = graphOf([
      'c(m) = {mod(m, 2) = 0: m/2, 3m + 1}',
      'f(m, j) = {m <= 1: 1, j <= 0: m, f(c(m), j - 1)}',
      'k = [1..10]',
      'j = [0..19]',
      'graph({f(k, j) > 1: f(k, j)}, c(f(k, j)))',
    ]);
    // A tree into 1: every vertex but 1 has one arrow out. 9 takes the
    // longest, 19 steps, and peaks at 52.
    expect(g.vertices).toHaveLength(22);
    expect(g.edges).toHaveLength(21);
    expect(new Set(g.edges.map(e => e.from))).toEqual(new Set(g.vertices.filter(v => v !== 1)));
    expect(g.vertices.at(-1)).toBe(52);
  });

  it('refuses what is not vertices', () => {
    expect(analyzeRows(['graph(sin(x))']).rows[0].error).toMatch(/graph\(from, to\)/);
  });

  it('mark(v) is a value, flagged for its panel', () => {
    const a = analyzeRows([
      'step(q, s) = mod(2q + s, 3)',
      'digit(k) = mod(floor(13 / 2^(3 - k)), 2)',
      'run(q, k, m) = {k >= m: q, run(step(q, digit(k)), k + 1, m)}',
      'mark(run(0, 0, 4))',
    ]);
    const row = a.rows[3];
    expect(row.mark).toBe(true);
    if (row.cpu?.type !== 'value') throw new Error('not a value');
    // 13 = 1101 in binary, and 13 mod 3 = 1.
    expect(evaluate(row.cpu.expr, a.constEnv)).toBe(1);
    expect(analyzeRows(['mark(sin(x))']).rows[0].error).toMatch(/one number/);
  });
});

describe('layout', () => {
  it('is deterministic, fits the radius, and keeps a cycle round', () => {
    const g = graphOf(['k = [0..7]', 'graph(k, mod(k + 1, 8))']);
    const a = layoutGraph(g);
    expect(layoutGraph(g)).toEqual(a);
    const r = [...a.values()].map(([x, y]) => Math.hypot(x, y));
    expect(Math.max(...r)).toBeCloseTo(graphRadius(8));
    expect(Math.min(...r)).toBeGreaterThan(graphRadius(8) * 0.9);
  });

  it('starts from where it was when the vertices are the same', () => {
    const g = graphOf(['graph([(1, 2), (2, 3)])']);
    const a = layoutGraph(g);
    const b = layoutGraph(g, a);
    for (const v of g.vertices) {
      expect(Math.hypot(b.get(v)![0] - a.get(v)![0], b.get(v)![1] - a.get(v)![1])).toBeLessThan(0.2);
    }
  });
});
