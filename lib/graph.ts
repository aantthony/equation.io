/**
 * Graphs: `graph(from, to)` and `graph(from, to, label)` (docs/discrete.md §4).
 *
 * The arguments are read as the tuple `(from, to, label)`, so the multiset
 * rule (docs/multisets.md §1) does the combinatorics: with `k = [0..11]`,
 * `graph(k, mod(k + 1, 12))` is the cycle C₁₂ (both uses of k are chosen
 * together), and with separate lists of states and symbols
 * `graph(Q, d(Q, S), S)` is every transition of a state machine. `graph(P)`
 * takes a list of pairs as it is: `graph([(1, 2), (2, 3)])`.
 *
 * Each element is an edge. Vertices are the numbers the edges meet; an edge
 * listed twice (the same from, to and label) is one arrow with its count, as
 * a multiset of arrows is (Wildberger): the matrix A with A_ij arrows i → j.
 */
import { exactCases } from './automaton.ts';
import type { Expr } from './expr.ts';
import type { Classified } from './math-object.ts';

export const GRAPH_RE = /^\s*graph\s*\(([\s\S]*)\)\s*$/;
/** `mark(v)`: v's vertex highlighted in the graphs of the row's panel. */
export const MARK_RE = /^\s*mark\s*\(([\s\S]*)\)\s*$/;

/** The graph a `graph(…)` row denotes, from the classification of its tuple. */
export function graphObject(cls: Classified): Classified {
  const usage = 'graph(from, to) or graph(from, to, label) takes numbers, or lists of them, as vertices.';
  const o = cls.object;
  let edges: ReadonlyArray<readonly Expr[]>;
  if (o.kind === 'list' && o.element === 'point' && o.storage === 'expressions') edges = o.values;
  else if (o.kind === 'point' && o.source.representation === 'real') edges = [o.source.coordinates];
  else throw new Error(usage);
  if (edges.some(e => e.length < 2 || e.length > 3)) throw new Error(usage);
  // Vertices are whole numbers, so a case may test equality: an arrow of A
  // composes with one of B where they meet, {A.y = B.x: A.x}.
  edges = edges.map(e => e.map(exactCases));
  return { ...cls, object: { kind: 'graph', edges }, needs3D: false };
}

export interface GraphEdge {
  from: number;
  to: number;
  /** Labels on this arrow, each with how many times it is listed. */
  labels: Array<{ label: number | null; count: number }>;
}

export interface GraphData {
  /** Every vertex, ascending. */
  vertices: number[];
  /** One entry per ordered pair (from, to) that has an arrow. */
  edges: GraphEdge[];
}

/** Collect evaluated edges ([from, to] or [from, to, label]); rows with a
 *  non-finite vertex are left out. */
export function collectEdges(rows: readonly (readonly number[])[]): GraphData {
  const vertices = new Set<number>();
  const byPair = new Map<string, GraphEdge>();
  for (const [from, to, label] of rows) {
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    vertices.add(from);
    vertices.add(to);
    const key = `${from}>${to}`;
    let e = byPair.get(key);
    if (!e) byPair.set(key, (e = { from, to, labels: [] }));
    const l = label === undefined || !Number.isFinite(label) ? null : label;
    const seen = e.labels.find(x => x.label === l);
    if (seen) seen.count++;
    else e.labels.push({ label: l, count: 1 });
  }
  for (const e of byPair.values()) e.labels.sort((a, b) => (a.label ?? -Infinity) - (b.label ?? -Infinity));
  return { vertices: [...vertices].sort((a, b) => a - b), edges: [...byPair.values()] };
}

/** How an edge reads: its labels ("0, 1"), each with its count past one ("a ×2"). */
export function edgeText(e: GraphEdge): string {
  return e.labels
    .map(({ label, count }) => {
      const name = label === null ? '' : String(parseFloat(label.toPrecision(6)));
      return count > 1 ? (name ? `${name} ×${count}` : `×${count}`) : name;
    })
    .filter(Boolean)
    .join(', ');
}

/** Layout radius: every vertex lands within this distance of the origin. */
export const GRAPH_RADIUS = 4.5;
/** The layout's pull toward the origin, growing with distance. */
const GRAVITY = 0.2;

/** The radius n vertices are fitted to: small graphs stay small. */
export const graphRadius = (n: number): number => Math.min(GRAPH_RADIUS, Math.max(2.75, 1.25 * Math.sqrt(n)));

/**
 * Place the vertices: a force layout (Fruchterman–Reingold) started from a
 * circle in vertex order, so a cycle stays a circle and the result is the
 * same every time. `prev` positions (same vertices) start it where it was,
 * so an edit that keeps the vertices keeps the picture. Fitted to
 * graphRadius(n) about the origin.
 */
export function layoutGraph(g: GraphData, prev?: ReadonlyMap<number, [number, number]>): Map<number, [number, number]> {
  const n = g.vertices.length;
  const index = new Map(g.vertices.map((v, k) => [v, k]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const reuse = !!prev && prev.size === n && g.vertices.every(v => prev.has(v));
  g.vertices.forEach((v, k) => {
    const p = reuse ? prev!.get(v)! : null;
    const a = (2 * Math.PI * k) / Math.max(1, n) - Math.PI / 2;
    xs[k] = p ? p[0] : Math.cos(a) * GRAPH_RADIUS;
    ys[k] = p ? p[1] : -Math.sin(a) * GRAPH_RADIUS;
  });
  // Undirected, without loops or repeats: a force per pair of neighbours.
  const links: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (const e of g.edges) {
    const a = index.get(e.from)!,
      b = index.get(e.to)!;
    if (a === b) continue;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push([a, b]);
  }
  if (n > 1 && n <= 400) {
    const area = (2 * GRAPH_RADIUS) ** 2;
    const k = Math.sqrt(area / n);
    const steps = reuse ? 60 : 300;
    let temp = reuse ? k * 0.2 : GRAPH_RADIUS;
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let s = 0; s < steps; s++) {
      dx.fill(0);
      dy.fill(0);
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          let ex = xs[i] - xs[j],
            ey = ys[i] - ys[j];
          let d2 = ex * ex + ey * ey;
          if (d2 < 1e-9) {
            // Coincident: part them along a fixed direction.
            ex = 1e-3 * (i - j);
            ey = 1e-3;
            d2 = ex * ex + ey * ey;
          }
          const f = (k * k) / d2;
          dx[i] += ex * f;
          dy[i] += ey * f;
          dx[j] -= ex * f;
          dy[j] -= ey * f;
        }
      for (const [a, b] of links) {
        const ex = xs[a] - xs[b],
          ey = ys[a] - ys[b];
        const d = Math.sqrt(ex * ex + ey * ey) || 1e-9;
        const f = d / k;
        dx[a] -= ex * f;
        dy[a] -= ey * f;
        dx[b] += ex * f;
        dy[b] += ey * f;
      }
      // Gravity toward the centre, so separate components stay in view
      // instead of flying apart (then the fit would crush each one).
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(xs[i], ys[i]);
        dx[i] -= xs[i] * GRAVITY * d;
        dy[i] -= ys[i] * GRAVITY * d;
      }
      for (let i = 0; i < n; i++) {
        const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
        if (d > 0) {
          const m = Math.min(d, temp) / d;
          xs[i] += dx[i] * m;
          ys[i] += dy[i] * m;
        }
      }
      temp *= 0.985;
    }
  }
  // Centre and fit.
  let cx = 0,
    cy = 0;
  for (let i = 0; i < n; i++) {
    cx += xs[i] / n;
    cy += ys[i] / n;
  }
  let r = 0;
  for (let i = 0; i < n; i++) r = Math.max(r, Math.hypot(xs[i] - cx, ys[i] - cy));
  const scale = r > 0 ? graphRadius(n) / r : 1;
  return new Map(g.vertices.map((v, i) => [v, [(xs[i] - cx) * scale, (ys[i] - cy) * scale] as [number, number]]));
}
