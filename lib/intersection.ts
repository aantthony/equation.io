/** Bounded predictor–corrector continuation of F=G=0 in three dimensions.
 * A seeded numerical search: this never claims branch completeness. */
import { diff } from './diff.ts';
import type { Expr } from './expr.ts';
import { fieldEvaluator } from './flow.ts';
import { solveLinear } from './solve.ts';

export const INTERSECTION_STEPS = 512;
export const INTERSECTION_BRANCHES = 24;
const dot = (a: number[], b: number[]) => a.reduce((s, v, k) => s + v * b[k], 0);
const cross = (a: number[], b: number[]) => a.map((_, k) => a[(k + 1) % 3] * b[(k + 2) % 3] - a[(k + 2) % 3] * b[(k + 1) % 3]);

export function traceIntersection(residuals: Expr[], lo: number[], hi: number[], env: Record<string, number> = {}): number[][][] {
  if (residuals.length !== 2 || lo.length !== 3) throw new Error('A space intersection needs two equations in three unknowns.');
  const f = fieldEvaluator(residuals, env);
  let gradient: ReturnType<typeof fieldEvaluator> | undefined;
  try { gradient = fieldEvaluator(residuals.flatMap(r => ['x', 'y', 'z'].map(v => diff(r, v))), env); } catch { /* finite differences */ }
  const scale = Math.max(...hi.map((v, k) => v - lo[k]));
  if (!(scale > 0) || !Number.isFinite(scale)) return [];
  const step = scale / 180;
  let budget = 180000;
  const inside = (p: number[]) => p.every((v, k) => Number.isFinite(v) && v >= lo[k] && v <= hi[k]);
  const jac = (p: number[]) => {
    if (--budget < 0) return [[NaN, NaN, NaN], [NaN, NaN, NaN]];
    if (gradient) { const g = gradient(p); return [g.slice(0, 3), g.slice(3)]; }
    const out = [[], []] as number[][];
    for (let k = 0; k < 3; k++) {
      const h = 1e-6 * Math.max(1, Math.abs(p[k]));
      const a = p.slice(), b = p.slice(); a[k] += h; b[k] -= h;
      const fa = f(a), fb = f(b);
      for (let j = 0; j < 2; j++) out[j][k] = (fa[j] - fb[j]) / (2 * h);
    }
    return out;
  };
  const tangent = (p: number[]) => {
    const j = jac(p), v = cross(j[0], j[1]), n = Math.hypot(...v);
    return n > 1e-12 && Number.isFinite(n) ? v.map(c => c / n) : null;
  };
  const correct = (seed: number[], plane?: number[]) => {
    let p = seed.slice();
    for (let i = 0; i < 24; i++) {
      const r = f(p), j = jac(p);
      if (!r.every(Number.isFinite) || !j.flat().every(Number.isFinite)) return null;
      let delta: number[] | null;
      if (plane) delta = solveLinear([...j, plane], [...r, dot(p.map((c, k) => c - seed[k]), plane)], 3);
      else {
        const weights = solveLinear(j.map(a => j.map(b => dot(a, b))), r, 2);
        delta = weights && [0, 1, 2].map(k => weights[0] * j[0][k] + weights[1] * j[1][k]);
      }
      if (!delta || !delta.every(Number.isFinite)) return null;
      const error = Math.hypot(...delta);
      if (error < scale * 1e-10 && inside(p)) return p;
      const damping = Math.min(1, scale * .2 / Math.max(error, 1e-30));
      p = p.map((v, k) => v - damping * delta[k]);
      if (!inside(p)) return null;
    }
    return null;
  };
  const paths: number[][][] = [];
  for (let i = 0; i < 216 && paths.length < INTERSECTION_BRANCHES && budget > 0; i++) {
    const seed = lo.map((v, k) => v + (hi[k] - v) * ((Math.floor(i / 6 ** k) % 6 + .43) / 6));
    const root = correct(seed); if (!root) continue;
    if (paths.some(path => path.some(p => Math.hypot(...p.map((v, k) => v - root[k])) < step * 1.3))) continue;
    const t0 = tangent(root); if (!t0) continue;
    let closed = false;
    const side = (sign: number) => {
      const out: number[][] = [];
      let p = root, last = t0.map(v => sign * v);
      for (let n = 0; n < INTERSECTION_STEPS && budget > 0; n++) {
        let t = tangent(p); if (!t) break;
        if (dot(t, last) < 0) t = t.map(v => -v);
        const predicted = p.map((v, k) => v + step * t[k]);
        const next = correct(predicted, t);
        if (!next || Math.hypot(...next.map((v, k) => v - predicted[k])) > step * .5) break;
        if (n > 8 && Math.hypot(...next.map((v, k) => v - root[k])) < step * .75) { out.push(root); closed = true; break; }
        out.push(next); p = next; last = t;
      }
      return out;
    };
    const forward = side(1);
    const backward = closed ? [] : side(-1).reverse();
    if (forward.length || backward.length) paths.push([...backward, root, ...forward]);
  }
  return paths;
}
