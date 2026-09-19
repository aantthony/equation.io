/**
 * CPU sampling of 2D parametric curves, complex paths included: a complex
 * expression in u is split into the curve (re, im) by lib/complex-parts.ts.
 */
import { type Expr, evaluate, freeVars } from './expr.ts';
import { compileSampler } from './vm.ts';

/**
 * Nodes (lib/size.ts) evaluated for one sample of a split path. Splitting
 * duplicates subterms — every product uses both parts of both factors — so
 * nesting grows the tree geometrically (three deep of w^2 + w is ~5k nodes,
 * eight deep would be millions). The budget keeps a per-frame resample of an
 * animated path within a few milliseconds.
 */
export const PATH_NODE_BUDGET = 10000;

/** Points per parametric curve, shared by the app (2D and 3D) and the og
 *  rasterizer. */
export const CURVE_SAMPLES = 400;

/**
 * The polyline of a 2D parametric curve — a real (x(u), y(u)) or the split
 * parts of a complex path — under env (constants, states, t): compiled once
 * for the VM (a split tree is far larger than what the user typed), with the
 * tree-walking evaluator standing in for forms the VM does not run. An
 * unevaluable sample is undefined, which lifts the pen.
 */
export interface PathSampler {
  /** The names (other than u) the curve reads: what a cached polyline is
   *  keyed on, t included when the curve is animated. */
  names: string[];
  sample: (env: Record<string, number>) => number[];
}

export function pathSampler(comps: readonly Expr[]): PathSampler {
  const read = new Set<string>();
  for (const c of comps) freeVars(c, read);
  read.delete('u');
  const names = [...read];
  const part = (c: Expr) => compileSampler(c, 'u', names) ?? ((env: Record<string, number>) => {
    const scope = { ...env };
    return (u: number) => {
      scope.u = u;
      try { return evaluate(c, scope); } catch { return NaN; }
    };
  });
  const [re, im] = comps.map(part);
  return {
    names,
    sample: env => {
      const x = re(env), y = im(env);
      return samplePath(u => [x(u), y(u)], CURVE_SAMPLES);
    },
  };
}

/** A chord this many times the local scale is suspect. */
const SUSPECT_RATIO = 4;
/** Chords on each side whose median is the local scale: a robust measure, so
 *  jumps in neighbouring intervals do not vouch for each other. */
const SCALE_WINDOW = 4;
/** Halvings of a suspect interval: a continuous path's chord shrinks with
 *  the interval, a jump's does not. */
const BISECTIONS = 12;
/** Suspect chords refined per curve, worst first, so a wild path costs a
 *  bounded number of extra evaluations each frame. A suspect past the budget
 *  lifts the pen unrefined: a false break loses one short segment, a false
 *  chord draws a line that is not part of the curve. */
const MAX_SUSPECTS = 32;
/** A chord below this fraction of the path's extent (or of its distance from
 *  the origin, where rounding noise lives) is never suspect. */
const EXTENT_FLOOR = 1e-9;
const NOISE_FLOOR = 1e-12;

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Sample a plane path at u = 0, 1/(n-1), …, 1 as a flat [x0, y0, x1, y1, …],
 * breaking it wherever it jumps: across a branch cut, a step, or a pole the
 * two sides are different points, and a chord between them is not part of
 * the curve. A break is a NaN pair — consumers lift the pen there (the 2D
 * canvas and og loops skip non-finite points; the 3D line renderer splits
 * its strips, web/render3d.ts).
 */
export function samplePath(at: (u: number) => [number, number], n: number): number[] {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) pts.push(at(k / (n - 1)));
  const chord = (a: [number, number], b: [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  // NaN where either end is undefined: the pen is already up there.
  const len: number[] = [];
  for (let k = 0; k + 1 < n; k++) len.push(chord(pts[k], pts[k + 1]));

  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, far = 0;
  for (const [x, y] of pts) {
    if (!isFinite(x) || !isFinite(y)) continue;
    xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
    ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
    far = Math.max(far, Math.abs(x), Math.abs(y));
  }
  const floor = Math.max(EXTENT_FLOOR * Math.hypot(xmax - xmin, ymax - ymin), NOISE_FLOOR * far);

  const suspects: Array<{ k: number; severity: number }> = [];
  for (let k = 0; k + 1 < n; k++) {
    const d = len[k];
    if (!(d > floor) || !isFinite(d)) continue;
    const near: number[] = [];
    for (let j = k - SCALE_WINDOW; j <= k + SCALE_WINDOW; j++) {
      if (j !== k && j >= 0 && j < len.length && isFinite(len[j])) near.push(len[j]);
    }
    const scale = median(near);
    if (d > SUSPECT_RATIO * scale) suspects.push({ k, severity: d / scale });
  }
  suspects.sort((a, b) => b.severity - a.severity);

  const jumps = new Set<number>();
  suspects.forEach(({ k }, rank) => {
    if (rank >= MAX_SUSPECTS) { jumps.add(k); return; }
    const d = len[k];
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
  });
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    out.push(pts[k][0], pts[k][1]);
    if (jumps.has(k)) out.push(NaN, NaN);
  }
  return out;
}
