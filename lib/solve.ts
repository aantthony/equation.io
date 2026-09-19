/**
 * Numeric solution of a square system F(p) = 0 in 2 or 3 real unknowns.
 *
 * One unknown has an exact enumerator (poly.ts, via roots.ts): every root
 * once, with its true multiplicity. Nothing like that exists for arbitrary
 * expressions in several unknowns, so this is a seeded search — damped Newton
 * from a lattice of starts spread over the view box, then dedupe. The
 * Jacobian is symbolic when the residuals differentiate and finite
 * differences otherwise, the same fallback roots.ts uses.
 *
 * Seeds are a deterministic function of their index (a hashed lattice, never
 * Math.random), so re-solving the same box returns the same points in the
 * same order. Markers would otherwise jitter between frames.
 *
 * The search is honest but not certified: it reports what it finds, and a
 * root can hide between seeds. Isolating every solution needs interval
 * subdivision with a Krawczyk/Newton existence test — the natural next step,
 * and the reason this lives behind a narrow interface.
 */
import { diff } from './diff.ts';
import { type Expr, evaluate, ineqComparisons } from './expr.ts';

/** Newton iterations per seed. Converging seeds take well under 20. */
const MAX_ITER = 64;
/** Step halvings before a seed is abandoned. */
const MAX_BACKTRACK = 24;
/** Lattice divisions per axis; 2D can afford a finer net than 3D. */
const LATTICE = { 2: 24, 3: 6 } as const;
/** Solutions returned at most, so a degenerate system cannot flood the scene. */
const MAX_SOLUTIONS = 64;

export interface SolveOptions {
  /** Extra values in scope (constants, t). Unknowns are overwritten per step. */
  env?: Record<string, number>;
  /** Fraction of the box width a solution may sit outside and still count. */
  margin?: number;
  /** Warm starts, tried before the deterministic lattice. */
  seeds?: number[][];
  /** Disable the lattice while following already discovered branches. */
  lattice?: boolean;
  /** Coordinate residuals measured modulo 2pi; ordinary equations never wrap. */
  angular?: boolean[];
}

/**
 * Every solution of `residuals = 0` found inside the box, as coordinate
 * tuples in the order of `vars`. `lo`/`hi` are per-unknown bounds.
 */
export function solveSystem(
  residuals: Expr[],
  vars: string[],
  lo: number[],
  hi: number[],
  opts: SolveOptions = {},
): number[][] {
  const n = residuals.length;
  if (n !== vars.length || (n !== 2 && n !== 3)) return [];
  if (lo.some((v, k) => !(hi[k] > v) || !isFinite(v) || !isFinite(hi[k]))) return [];

  const angular = opts.angular ?? [];
  const wrap = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
  const env: Record<string, number> = { ...opts.env };
  const margin = opts.margin ?? 0.05;

  // Symbolic Jacobian where it exists; null entries fall back to differences.
  const jac: Array<Array<Expr | null>> = residuals.map(r => vars.map(v => {
    try {
      return diff(r, v);
    } catch {
      return null;
    }
  }));

  const evalAt = (e: Expr): number => {
    try {
      const y = evaluate(e, env);
      return typeof y === 'number' ? y : NaN;
    } catch {
      return NaN;
    }
  };
  const setPoint = (p: number[]): void => {
    for (let k = 0; k < n; k++) env[vars[k]] = p[k];
  };
  const residualAt = (p: number[], out: number[]): boolean => {
    setPoint(p);
    for (let i = 0; i < n; i++) {
      const v = evalAt(residuals[i]);
      if (!isFinite(v)) return false;
      out[i] = angular[i] ? wrap(v) : v;
    }
    return true;
  };
  /** Row-major Jacobian at p; false if any entry is not finite. */
  const jacobianAt = (p: number[], out: number[][]): boolean => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const sym = jac[i][j];
        let v: number;
        if (sym) {
          setPoint(p);
          v = evalAt(sym);
        } else {
          const h = 1e-6 * (1 + Math.abs(p[j]));
          const q = p.slice();
          q[j] = p[j] + h;
          setPoint(q);
          const a = evalAt(residuals[i]);
          q[j] = p[j] - h;
          setPoint(q);
          const b = evalAt(residuals[i]);
          v = (angular[i] ? wrap(a - b) : a - b) / (2 * h);
        }
        if (!isFinite(v)) return false;
        out[i][j] = v;
      }
    }
    return true;
  };

  const norm = (v: number[]): number => Math.hypot(...v);
  const r = new Array<number>(n).fill(0);
  const rTrial = new Array<number>(n).fill(0);
  const J = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  const width = lo.map((v, k) => hi[k] - v);
  const boxScale = Math.max(...width);

  /**
   * Backward error: the residual has reached the noise floor of evaluating a
   * linearization this steep at this point. An absolute threshold would
   * reject badly scaled systems and accept flat ones.
   */
  const converged = (p: number[], res: number[]): boolean => {
    let scale = 1;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < n; k++) scale = Math.max(scale, Math.abs(J[i][k]) * (1 + Math.abs(p[k])));
    }
    return norm(res) <= 1e-11 * scale * Math.max(1, boxScale);
  };

  /** Damped Newton from one seed; null when it fails to converge. */
  const refine = (seed: number[]): number[] | null => {
    const p = seed.slice();
    if (!residualAt(p, r)) return null;
    let rn = norm(r);
    let previous: number[] | null = null;
    let older: number[] | null = null;
    for (let it = 0; it < MAX_ITER; it++) {
      if (rn === 0) return p;
      if (!jacobianAt(p, J)) return null;
      // Test with J freshly evaluated at p, so the scale matches the point.
      const step = solveLinear(J, r, n);
      // A tiny residual alone is misleading near a multiple root (w^3=0).
      // Require positional convergence as well, otherwise one root becomes
      // a cloud of apparently distinct solutions.
      if (converged(p, r) && step && norm(step) <= 1e-9 * (1 + norm(p))) return p;
      if (!step) return null;
      const earlier = older, prior = previous;
      if (converged(p, r) && earlier && prior) {
        // Multiple roots make Newton converge only linearly. Extrapolate the
        // last three iterates to their common limit. Verify its Newton
        // correction too: a small residual at a nearby stationary point can
        // otherwise divert every seed from two distinct, close roots.
        const limit = p.map((v, k) => {
          const before = prior[k] - earlier[k];
          const after = v - prior[k];
          const bend = after - before;
          return Math.abs(bend) > 1e-15 * Math.max(Math.abs(before), Math.abs(after))
            ? v - after * after / bend : v;
        });
        if (limit.every(isFinite) && residualAt(limit, rTrial) && norm(rTrial) < rn) {
          if (norm(rTrial) === 0) return limit;
          if (jacobianAt(limit, J)) {
            const correction = solveLinear(J, rTrial, n);
            if (correction && converged(limit, rTrial) &&
              norm(correction) <= 1e-9 * (1 + norm(limit))) return limit;
          }
        }
      }
      // Backtrack until the residual actually drops.
      let scale = 1;
      let accepted = false;
      for (let k = 0; k < MAX_BACKTRACK; k++) {
        const q = p.map((v, i) => v - scale * step[i]);
        if (q.every(isFinite) && residualAt(q, rTrial) && norm(rTrial) < rn) {
          older = previous;
          previous = p.slice();
          for (let i = 0; i < n; i++) {
            p[i] = q[i];
            r[i] = rTrial[i];
          }
          rn = norm(rTrial);
          accepted = true;
          break;
        }
        scale /= 2;
      }
      if (!accepted) break; // stalled: either converged or stuck
    }
    return null;
  };

  const found: number[][] = [];
  const same = (a: number[], b: number[]): boolean =>
    a.every((v, k) => Math.abs(v - b[k]) <= 1e-7 * (1 + Math.max(Math.abs(v), Math.abs(b[k]))));

  const div = LATTICE[n as 2 | 3];
  const total = opts.lattice === false ? 0 : div ** n;
  const seeds = opts.seeds ?? [];
  for (let s = 0; s < total + seeds.length; s++) {
    const seed: number[] = [];
    const index = s - seeds.length;
    let rest = index;
    for (let k = 0; k < n; k++) {
      const cell = rest % div;
      rest = Math.floor(rest / div);
      // Cell centre, nudged by a hash of the seed index so seeds do not line
      // up with the symmetry axes that so many systems are built around.
      seed.push(lo[k] + width[k] * (cell + 0.5 + 0.32 * (hash(index * 3 + k) - 0.5)) / div);
    }
    const sol = refine(s < seeds.length ? seeds[s] : seed);
    if (!sol) continue;
    if (sol.some((v, k) => v < lo[k] - margin * width[k] || v > hi[k] + margin * width[k])) continue;
    if (found.some(f => same(f, sol))) continue;
    found.push(sol);
    if (found.length >= MAX_SOLUTIONS) break;
  }

  // Stable order so colours and labels do not shuffle between redraws.
  found.sort((a, b) => {
    for (let k = 0; k < n; k++) if (a[k] !== b[k]) return a[k] - b[k];
    return 0;
  });
  return found;
}

/** Gaussian elimination with partial pivoting; null when J is singular. */
export function solveLinear(J: number[][], b: number[], n: number): number[] | null {
  const m = J.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(m[k][i]) > Math.abs(m[piv][i])) piv = k;
    if (!(Math.abs(m[piv][i]) > 1e-300)) return null;
    [m[i], m[piv]] = [m[piv], m[i]];
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const f = m[k][i] / m[i][i];
      for (let j = i; j <= n; j++) m[k][j] -= f * m[i][j];
    }
  }
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = m[i][n] / m[i][i];
    if (!isFinite(out[i])) return null;
  }
  return out;
}

/** Deterministic [0,1) hash of a seed index (xorshift-style integer mix). */
function hash(i: number): number {
  let h = (i + 1) * 0x9e3779b1;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Trace moving constraints with warm starts and periodic branch discovery.
 * Unmatched or discontinuous branches start a new polyline, never a chord. */
export function traceSystem(residuals: Expr[], vars: string[], lo: number[], hi: number[],
  env: Record<string, number> = {}, samples = 256, angular: boolean[] = []): number[][][] {
  const paths: number[][][] = [];
  let active: number[][][] = [];
  const scale = Math.hypot(...hi.map((v, k) => v - lo[k]));
  const maxStep = scale / 16;

  // A small step on a curved path can hide a still smaller jump. Retain the
  // discrete operations so an interval crossing one receives extra continuity
  // probes before curvature alone is allowed to certify the chord.
  const discreteProbes: Array<Extract<Expr, { kind: 'call' | 'piecewise' }>> = [];
  const collectDiscrete = (e: Expr): void => {
    switch (e.kind) {
      case 'call':
        if (['floor', 'ceil', 'round', 'sign', 'fract', 'mod'].includes(e.name)) discreteProbes.push(e);
        e.args.forEach(collectDiscrete);
        break;
      case 'bin': collectDiscrete(e.a); collectDiscrete(e.b); break;
      case 'neg': collectDiscrete(e.a); break;
      case 'eq': case 'ineq': collectDiscrete(e.l); collectDiscrete(e.r); break;
      case 'vec': case 'list': e.items.forEach(collectDiscrete); break;
      case 'piecewise':
        discreteProbes.push(e);
        e.cases.forEach(c => { collectDiscrete(c.cond); collectDiscrete(c.value); });
        if (e.otherwise) collectDiscrete(e.otherwise);
        break;
    }
  };
  residuals.forEach(collectDiscrete);
  const discreteValue = (probe: Extract<Expr, { kind: 'call' | 'piecewise' }>,
    p: number[], u: number): number => {
    const scope: Record<string, number> = { ...env, u };
    vars.forEach((name, k) => { scope[name] = p[k]; });
    const at = (e: Expr): number => {
      try {
        const v = evaluate(e, scope);
        return typeof v === 'number' ? v : NaN;
      } catch { return NaN; }
    };
    if (probe.kind === 'piecewise') {
      try {
        for (let i = 0; i < probe.cases.length; i++) {
          const cond = probe.cases[i].cond;
          if (cond.kind !== 'ineq') return NaN;
          if (ineqComparisons(cond).every(({ op, l, r }) => {
            const a = at(l), b = at(r);
            return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
          })) return i;
        }
        return probe.cases.length;
      } catch { return NaN; }
    }
    if (probe.name === 'fract') return Math.floor(at(probe.args[0]));
    if (probe.name === 'mod') return Math.floor(at(probe.args[0]) / at(probe.args[1]));
    return at(probe);
  };

  // A large step can be ordinary motion in a zoomed-in view. Follow it at
  // intermediate parameter values before deciding the branch has jumped.
  const bridge = (a: number[], b: number[], u0: number, u1: number): number[][] | null => {
    let remaining = 96; // bound work when several branches compete for a match
    const minDepth = discreteProbes.some(probe => {
      const before = discreteValue(probe, a, u0);
      const after = discreteValue(probe, b, u1);
      return isFinite(before) && isFinite(after) && before !== after;
    }) ? 4 : 0;
    const subdivide = (start: number[], end: number[], t0: number, t1: number,
      depth: number, parentDeviation?: number): number[][] | null => {
      if (remaining-- <= 0) return null;
      const t = (t0 + t1) / 2;
      if (t === t0 || t === t1) return null;
      const center = start.map((v, k) => (v + end[k]) / 2);
      const distance = Math.hypot(...start.map((v, k) => v - end[k]));
      const mids = solveSystem(residuals, vars, lo, hi, {
        env: { ...env, u: t }, angular, seeds: [center, start, end], lattice: false,
      });
      mids.sort((p, q) =>
        Math.hypot(...p.map((v, k) => v - center[k])) - Math.hypot(...q.map((v, k) => v - center[k])));
      for (const mid of mids) {
        // Smooth curvature shrinks under subdivision; a jump's deviation does
        // not. Compare successive midpoints independently of the view-scaled
        // step limit so jumps smaller than maxStep can still break the path.
        const deviation = Math.hypot(...mid.map((v, k) => v - center[k]));
        if (distance < maxStep && depth >= minDepth &&
          (deviation <= 1e-12 * (1 + distance) ||
            (parentDeviation !== undefined && deviation < 0.5 * parentDeviation))) return [];
        const left = subdivide(start, mid, t0, t, depth + 1, deviation);
        if (!left) continue;
        const right = subdivide(mid, end, t, t1, depth + 1, deviation);
        if (right) return distance < maxStep ? [] : [...left, mid, ...right];
      }
      return null;
    };
    return subdivide(a, b, u0, u1, 0);
  };

  for (let i = 0; i <= samples; i++) {
    const seeds = active.map(p => p[p.length - 1]);
    const discover = i % 32 === 0 || seeds.length === 0;
    let points = solveSystem(residuals, vars, lo, hi, {
      env: { ...env, u: i / samples }, angular, seeds, lattice: discover,
    });
    if (!discover && points.length < seeds.length) {
      points = solveSystem(residuals, vars, lo, hi, { env: { ...env, u: i / samples }, angular, seeds: points });
    }
    const available = new Set(active);
    active = points.map(point => {
      let best: number[][] | undefined;
      let bestBridge: number[][] = [];
      let distance = Infinity;
      for (const path of available) {
        const last = path[path.length - 1];
        const d = Math.hypot(...point.map((v, k) => v - last[k]));
        if (d >= distance) continue;
        const mids = bridge(last, point, (i - 1) / samples, i / samples);
        if (mids) { distance = d; best = path; bestBridge = mids; }
      }
      if (best) { available.delete(best); best.push(...bestBridge, point); return best; }
      const path = [point]; paths.push(path); return path;
    });
  }
  return paths;
}
