/**
 * Targeted documents for the kinds the other passes left: graphs and marks,
 * trails in space, sequences and recurrences over tuples and lists, a matrix
 * read as its rows, the derivative of a list. apple/corpus/analysis.ts runs
 * them with its own. One concern each, rows separated as the examples' are.
 */
import { collectEdges, edgeEvaluator, edgeText, layoutGraph } from '../../lib/graph.ts';
import type { Expr } from '../../lib/expr.ts';

export const REST_CASES: string[] = [
  // Graphs: the tuple of the arguments, one edge per element.
  'graph(1, 2); graph(1, 2, 3); graph((1, 2)); graph([(1, 2), (2, 3)]); graph(1); graph(1, 2, 3, 4)',
  'graph(x, 1); graph(1, 2) * (3); graph(); graph(1, 2; graph("a", 1); graph (1, 2) ; graph([1, 2])',
  'k = [0..5]; graph(k, mod(k + 1, 6)); graph(k, k); graph(k, mod(2 k, 6), k); mark(2); mark(k); mark((1, 2)); mark()',
  'graph(a, b) = a + b; graph(1, 2); mark(v) = 2 v; mark(3)',
  'graph(1, floor(t)); n = 3; k = [0..n]; graph(k, mod(2 k, n + 1), k); mark(n); mark(floor(t)); mark(x)',
  'c(p, q) = {p.y = q.x: (p.x, q.y)}; A = [(1, 1), (1, 2), (2, 2), (2, 2)]; graph(c(A, A)); a ∈ A; b ∈ A; graph(c(a, b))',
  'c(m) = {mod(m, 2) = 0: m/2, 3m + 1}; k = [1..12]; graph(k, c(k)); mark(c(4)); graph(k, {k = 3: 1, 2})',
  'Q = [0..2]; S = [0, 1]; step(q, s) = mod(2q + s, 3); graph(Q, step(Q, S), S); graph(Q, 1/0); graph(Q, 0.5 Q, 1/0)',
  'graph(1, 2); grid(on); ---; graph(1, 2); y = x; ---; graph(2, 2); 1 + 1; mark(2)',
  'view(x = 1..100, x = 10^X); graph(1, 2); mark(1)',
  'graph(i, 2); graph(1.5, 2.25, -0.5); graph((1, 2), 3); graph([1, 2], [3, 4, 5]); graph(1, 2) # note',
];

/** What web/scene.ts draws of a graph's plan, from lib/graph.ts: its vertices, its arrows as they read, and
 *  where the layout moves each vertex from a given start (`from`, as an edit that keeps the vertices lays
 *  it out again). The layout from scratch starts on a circle of Math.cos and Math.sin, which Node rounds an
 *  ulp apart from the platform's in a few values of each hundred, and a symmetric graph settles by its
 *  rounding. (Chromium on a Mac agrees with the platform: shots of the site and of the port match.) */
export function recordGraph(plan: { type: string } | undefined, constEnv: Record<string, number>): unknown {
  if (plan?.type !== 'graph') return null;
  const env = { ...constEnv, t: 0 };
  const data = collectEdges(edgeEvaluator((plan as unknown as { edges: Expr[][] }).edges)(env));
  const start = (k: number): [number, number] => [((k * 37) % 11) - 5 + 0.1 * k, ((k * 53) % 7) - 3];
  const from = new Map(data.vertices.map((v, k) => [v, start(k)]));
  const pos = layoutGraph(data, from);
  return {
    vertices: data.vertices,
    edges: data.edges.map(e => ({ from: e.from, to: e.to, text: edgeText(e) })),
    from: data.vertices.map(v => from.get(v)),
    pos: data.vertices.map(v => pos.get(v)),
  };
}
