/**
 * Complex paths: a complex expression in u, split into the 2D parametric
 * curve (re, im) by lib/complex-parts.ts and sampled on the CPU.
 */
import { type Expr, evaluate, freeVars } from './expr.ts';
import { compileSampler } from './vm.ts';

/**
 * Nodes the evaluator walks for one sample of a split path. Splitting
 * duplicates subterms — every product uses both parts of both factors — so
 * nesting grows the tree geometrically (three deep of w^2 + w is ~5k nodes,
 * eight deep would be millions). The budget keeps a per-frame resample of an
 * animated path within a few milliseconds.
 */
export const PATH_NODE_BUDGET = 10000;

/** Size of an expression as the tree-walking evaluator sees it: shared
 *  subtrees count once per use. Stops counting once past `limit`. */
export function exprSize(e: Expr, limit = Infinity): number {
  let n = 0;
  const walk = (x: Expr): void => {
    if (n > limit) return;
    n++;
    switch (x.kind) {
      case 'neg': walk(x.a); return;
      case 'bin': walk(x.a); walk(x.b); return;
      case 'call': x.args.forEach(walk); return;
      case 'eq':
      case 'ineq': walk(x.l); walk(x.r); return;
      case 'vec':
      case 'list': x.items.forEach(walk); return;
      case 'piecewise':
        for (const c of x.cases) { walk(c.cond); walk(c.value); }
        if (x.otherwise) walk(x.otherwise);
        return;
      default: return;
    }
  };
  walk(e);
  return n;
}

/** Points per path, shared by the app and the og rasterizer. */
export const PATH_SAMPLES = 400;

/**
 * The polyline of a split path under env (constants, states, t): compiled
 * once for the VM — a split tree is far larger than what the user typed —
 * with the tree-walking evaluator standing in for forms the VM does not run.
 * An unevaluable sample is undefined, which lifts the pen.
 */
export function pathSampler(comps: readonly Expr[]): (env: Record<string, number>) => number[] {
  const names = new Set<string>();
  for (const c of comps) freeVars(c, names);
  names.delete('u');
  const part = (c: Expr) => compileSampler(c, 'u', [...names]) ?? ((env: Record<string, number>) => {
    const scope = { ...env };
    return (u: number) => {
      scope.u = u;
      try { return evaluate(c, scope); } catch { return NaN; }
    };
  });
  const [re, im] = comps.map(part);
  return env => {
    const x = re(env), y = im(env);
    return samplePath(u => [x(u), y(u)], PATH_SAMPLES);
  };
}

/** A chord this many times longer than both its neighbours is suspect. */
const SUSPECT_RATIO = 4;
/** Halvings of a suspect interval: a continuous path's chord shrinks with
 *  the interval, a jump's does not. */
const BISECTIONS = 12;
/** Suspect chords examined per curve, so a wild path costs a bounded number
 *  of extra evaluations each frame; the rest are drawn as sampled. */
const MAX_SUSPECTS = 32;

/**
 * Sample a plane path at u = 0, 1/(n-1), …, 1 as a flat [x0, y0, x1, y1, …],
 * breaking it (a NaN pair, which every polyline renderer lifts the pen at)
 * wherever it jumps: across a branch cut the two sides are different points,
 * and a chord between them is not part of the image.
 */
export function samplePath(at: (u: number) => [number, number], n: number): number[] {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) pts.push(at(k / (n - 1)));
  const chord = (a: [number, number], b: [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  // NaN where either end is undefined: the pen is already up there.
  const len: number[] = [];
  for (let k = 0; k + 1 < n; k++) len.push(chord(pts[k], pts[k + 1]));
  let budget = MAX_SUSPECTS;
  const jumps = new Set<number>();
  for (let k = 0; k + 1 < n && budget > 0; k++) {
    const d = len[k];
    if (!(d > 0) || !isFinite(d)) continue;
    const around = Math.max(len[k - 1] || 0, len[k + 1] || 0);
    if (d <= SUSPECT_RATIO * around) continue;
    budget--;
    let lo = k / (n - 1), hi = (k + 1) / (n - 1);
    let a = pts[k], b = pts[k + 1];
    let jump = true;
    for (let s = 0; s < BISECTIONS; s++) {
      const mid = (lo + hi) / 2;
      const m = at(mid);
      const da = chord(a, m), db = chord(m, b);
      // An undefined midpoint is a hole in the path: break there too.
      if (!isFinite(da) || !isFinite(db)) break;
      if (da >= db) { hi = mid; b = m; } else { lo = mid; a = m; }
      if (chord(a, b) < d / 2) { jump = false; break; }
    }
    if (jump) jumps.add(k);
  }
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    out.push(pts[k][0], pts[k][1]);
    if (jumps.has(k)) out.push(NaN, NaN);
  }
  return out;
}
