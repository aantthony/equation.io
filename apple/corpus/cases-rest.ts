/**
 * Targeted documents for the kinds the other passes left: graphs and marks,
 * trails in space, sequences and recurrences over tuples and lists, a matrix
 * read as its rows, the derivative of a list. apple/corpus/analysis.ts runs
 * them with its own. One concern each, rows separated as the examples' are.
 */
import { collectEdges, edgeEvaluator, edgeText, layoutGraph } from '../../lib/graph.ts';
import type { Expr } from '../../lib/expr.ts';
import { pathSampler } from '../../lib/path.ts';

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
  // Trails in space, and trails and complex numbers on a surface panel.
  'a = 2; trail((cos(t), sin(t), a t)); trail(cos(t), sin(t), t); A = (1, 2, 3); trail(A); trail(A + (t, 0, 0)); trail((x, 1, 2))',
  "p' = (10(p_2 - p_1), p_1(28 - p_3) - p_2, p_1 p_2 - 8 p_3/3); p(0) = (1, 1, 20); trail(p); trail((p_1, p_2)); trail(2 p)",
  'on((X, Y, Z) = (x, y, x y), x = -1..1, y = -1..1); trail((cos(t), sin(t))/2); 0.5 e^(i t); e^(2 pi i u)/2; ' +
    '[1, i, -1]/2; trail((t, 1, 2)); B = (0.2, 0.3); trail(B); w^3 = 1',
  'z = x y; trail((cos(t), sin(t))); trail((cos(t), sin(t), 1)); (1, 2); i',
  // Tuple-valued recurrences: a stack over time, the orbit of a point.
  's_0 = (); s_{n+1} = push(s_n, n); s_3; count(s_3); top(s_4); s_2[1]; s_0; count(s_0); s_1; pop(s_3); top(s_0)',
  'p_0 = (0, 0); a = 1.4; b = 0.3; p_{n+1} = (1 - a p_n[1]^2 + p_n[2], b p_n[1]); p_3; p_2[1]; (p_5[1], p_5[2])',
  'p_0 = (1, 2, 3); p_{n+1} = (p_n[2], p_n[3], p_n[1]); p_2; q_{n+1} = (q_n[1] + 1, 2); q_3; q_0',
  'D = (1, 2, 1, 3, 4, 2, 2, 4, 4, 3); s_0 = (); ' +
    's_{n+1} = {D[n + 1] <= 2: push(s_n, D[n + 1]), top(s_n) = D[n + 1] - 2: pop(s_n)}; s_4; count(s_10); s_11; top(s_2)',
  'D = (1, 1, 1, 2, 2, 2); s_0 = (); s_{n+1} = {D[n + 1] = 1: push(s_n, 1), pop(s_n)}; ' +
    'step(q, a) = {q = 0: {a = 1: 0, 1}, q = 1: {a = 2: 1, 2}, 2}; q_0 = 0; q_{n+1} = step(q_n, D[n + 1]); ' +
    'N = floor(clamp(0, 0, 6)); mark(q_N); q_N; q_6; q_7; s_N; count(s_N)',
  's_0 = (); s_0 = (); s_{n+1} = push(s_n, 1); ---; r_0 = 2; r_0 = (); r_{n+1} = push(r_n, 1); r_2; ---; u_0 = ()',
  's_{n+1} = push(s_n, t); r_{n+1} = push(r_n, x); k = 2; u_0 = (1, 2, 3, 4); u_{n+1} = k u_n; u_2; u_1[4]',
  'v_0 = (1, 2); v_{n+1} = v_n + (1, 1); v_3; w_0 = (1, 2, 3); w_{n+1} = -pop(w_n); w_1; w_3; w_4',
  'h_{h+1} = push(h_h, h); h_2; L = [1, 2, 3]; s_{n+1} = push(s_n, L); r_{n+1} = push(r_n, sort(L)[1]); r_2',
  's_0 = (); s_{n+1} = push(s_n, n); a_n = top(s_n); b_{n+1} = b_n + top(s_n); b_0 = 0; b_3; ' +
    'c_{n+1} = {count(s_n) = 0: 0, top(s_n)}; c_4; d_{n+1} = d_n + count(s_n); d_3',
  'push((1, 2), 3); pop((1, 2, 3)); top((1, 2, 3)); push(1, 2); pop(1); top(()); push(); pop((1, 2), 3); push((1, 2), x)',
  'push((1, 2, 3), 4, 5); pop((1, 2, 3, 4, 5)); f(s) = top(s) + 1; f((1, 2)); g(s) = push(s, 0); g((1, 2)); count(pop((1, 2)))',
  // Sequences and recurrences over lists and tuples.
  'a_n = n^2; L = [1, 2, 3]; a_L; a_[L]; a_[1..4]; K = a_[2..5]; K; mean(K); a_[1, 3]; a_[L + 1]; y = a_L x',
  'a_n = n^2; N = 3; a_N; a_[N]; a_[0..N]; a_[N..5]; a_[1.5]; a_[-1]; a_[1..2000]; hist(a_[1..30])',
  'D = (1, 1, 0, 1); step(q, s) = mod(2q + s, 3); q_0 = 0; q_{n+1} = step(q_n, D[n + 1]); q_4; q_5; q_[0..4]; ' +
    'N = 2; q_N; r_{n+1} = r_n + q_n; r_3; r_6',
  'w = (1, 2, 3); a_{n+1} = a_n + w[n + 1]; a_2; a_4; b_n = w[n]; L = [1, 2]; c_{n+1} = c_n + L; d_{n+1} = d_n mean(L)',
  'a_{n+1} = b_n + 1; b_{n+1} = a_n; a_0 = 1; b_0 = 2; a_3; b_3; a_[0..3]; (a_2, b_2)',
  'a_{n+1} = 2 a_n; b_n = a_n + 1; b_3; c_{n+1} = c_n + a_n; s_n = sum(k=0..n, a_k); s_3; b_[1..3]; c_4',
  'a_n = [1, 2, 3][n]; b_n = mean([n, 2n]); c_{n+1} = [1, 2][1] c_n; L = [3, 1, 2]; d_n = L[n]; e_n = n count(L)',
  'L = [3, 1, 4, 1, 5]; b_0 = 0; b_{n+1} = b_n + L[n + 1]; b_3; b_5; b_6; b_9; T = sort(L); c_{n+1} = c_n T[n + 1]; c_2',
  // Plane curves that jump: a step, a pole, a branch cut, a hole; and ones that only turn sharply.
  '(u, floor(4 u)); (4 u - 2, 1/(4 u - 2)); (u, sign(sin(12 pi u))); (cos(2 pi u), sin(2 pi u)); (u, abs(u - 0.5))',
  '(4 u - 2, tan(4 u - 2)); (u, sqrt(u - 0.5)); (u, fract(8 u)/4); (u, {u < 0.3: 1, u > 0.6: 2}); (u, 1e-12 floor(3 u))',
  'e^(2 pi i u); ln(e^(2 pi i u)); sqrt(e^(2 pi i u) - 1); (u + i/4)^(1/3); 1/(u - 0.5 + 0.001 i)',
  'a = 3; (u, mod(a u, 1)); (u, round(a u) + t); (u, 100000 u); (u, sin(200 u)); (u, 0/0); (0/0, u)',
  // The derivative of a list: a named one is a constant to x, y and z; one written out goes item by item.
  'N = [1..4]; y = d/dx x^N; y = d/dx [x, x^2, sin(x)]; L = [1, 2]; y = d/dx (L x); d/dt L; a = 2; d/da (L a)',
  'N = [1..3]; y = d^2/dx^2 x^N; y = d/dx [1..3]; d/du (N u); x = d/dy (y^N); d/dx (N x y); d/dz (N z); y = d/dx floor(N x)',
  'L = [1, 2]; grad(L x y); div((L x, y)); f(x) = x^L; y = d/dx f(x); g = x^L; d/dx g; hessian(L x^2); laplacian(L x^2)',
  'y = d/dx (x^[1, 2]); y = d/dx ([x, 2x] [1, 2]); y = d/dx ([x, 2x]^2); y = d^2/dx^2 [x^2, x^3]; y = d/dx (2^[x, 2x])',
  'f(a) = d/dx (a x^2 + a); y = f([1, 2]); g(a) = a + d/dx (a x); y = g([1, 2]); y = d/dx sum(n=1..2, [1, 2] x^n)',
  'a_n = n^2; y = d/dx (x a_[1..3]); y = d/dx (x^[1, 2] + [x, 1]); P = [(1, 2), (3, 4)]; d/dx (P.x x); y = d/dx (x P)',
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

/** What web/scene.ts samples of a plane curve (lib/path.ts pathSampler, at t = 0): how many points, where
 *  the pen lifts (a jump's NaN pair, an undefined sample), and the sum of the rest. */
export function recordPath(plan: { type: string } | undefined, constEnv: Record<string, number>): unknown {
  const curve = plan as { type: string; dim?: number; comps?: Expr[] } | undefined;
  if (curve?.type !== 'pcurve' || curve.dim !== 2 || !curve.comps) return null;
  const pts = pathSampler(curve.comps).sample({ ...constEnv, t: 0 });
  const gaps: number[] = [];
  let sum = 0;
  for (let k = 0; k < pts.length; k += 2) {
    if (Number.isFinite(pts[k]) && Number.isFinite(pts[k + 1])) sum += Math.abs(pts[k]) + Math.abs(pts[k + 1]);
    else gaps.push(k / 2);
  }
  return { points: pts.length / 2, gaps, sum };
}
