/**
 * Continuous sampling: stratified streams, density estimates, and quantile curves.
 */
import { structuralDiagnostic } from './expr.ts';

import { EVAL_FNS, type Expr, evaluate, ineqComparisons, normalpdf, strayComp } from './expr.ts';
import { type BaseKind } from './dist-families.ts';
import {
  BETA_GAMMA_SIDE,
  BETA_LIMIT_SUM,
  GAMMA_UNIFORM_SHAPE,
  betaPQ,
  betaPdf,
  gammaPQ,
  gammaPdf,
  lbeta,
  lgamma,
  studentTPQ,
  studentTPdf,
  weibullPdf,
} from './specfn.ts';
import { type BaseDist, paramProblem } from './dist-base.ts';
import { type AtomSet, type DiscreteLaw, type DiscretePmf, type PmfStems, type Tail } from './dist-discrete.ts';

// --- the sampled system ---

/** Joint sample count. Stratified streams keep marginals exact at any size;
 *  this is set by when the *derived-density* estimate looks smooth (KDE noise
 *  ~ 1/√(N·h), visible as low-frequency wobble on zoomed-in curves) while a
 *  slider drag can still resample every affected variable within a frame. */
export const SAMPLE_COUNT = 1 << 17;

export type RV = { name: string; kind: 'base'; dist: BaseDist } | { name: string; kind: 'derived'; expr: Expr };

export interface DensityCurve {
  /** Flat [x0, y0, x1, y1, …] polyline of the continuous part's density
   *  (empty when the distribution is purely discrete). */
  pts: number[];
  /** Point masses (a piecewise branch, floor, a constant): drawn as stems of
   *  height = probability, never smeared into the density. */
  atoms?: Array<{ x: number; p: number }>;
  mean: number;
  sd: number;
  /** Fraction of samples that are finite (< 1 for partial support like sqrt(X)). */
  mass: number;
  /** Present when the tails are heavy enough that mean/sd are truncation
   *  artifacts (a 1% trim collapses the spread severalfold — 1/W through a
   *  pole has no finite moments at all): robust location/spread for the
   *  readout to show instead. `meanOk` marks the milder case — the spread is
   *  unstable but the tails are lighter than 1/x, so the mean exists (a
   *  shifted StudentT(2), a product of log-normals) — and an E(…) row may
   *  still print its number. */
  robust?: Robust;
}

/** A curve drawn `k` times as tall: a row over continuous intervals is drawn
 *  against their length measure, not a probability (docs/multisets.md §5). */
export function scaleCurve(c: DensityCurve, k: number): DensityCurve {
  if (k === 1) return c;
  return { ...c, pts: c.pts.map((v, i) => (i % 2 ? v * k : v)), atoms: c.atoms?.map(a => ({ ...a, p: a.p * k })) };
}

/** 0 — every base law has a variance; 1 — some base has none but has a mean
 *  (StudentT, 1 < df ≤ 2); 2 — some base has no mean (Cauchy, StudentT df ≤ 1). */
export type HeavyBase = 0 | 1 | 2;

export interface Robust {
  median: number;
  iqr: number;
  meanOk: boolean;
}

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const mulberry32 = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let z = seed;
  z = Math.imul(z ^ (z >>> 15), z | 1);
  z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
  return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
};

/**
 * The stratified standard-uniform stream for a variable name: quantile
 * midpoints (i + ½)/N shuffled by a permutation seeded from the name and
 * the current sample salt. Marginals are exact at any salt; the salt only
 * redraws the *pairing* between variables — the Monte Carlo part. Streams
 * are memoized per name and refilled in place when the salt has moved on,
 * so resampling every frame allocates nothing.
 */
let streamSalt = 0;

/** Written by RVSystem.resample. The streams that read the salt live here. */
export function setStreamSalt(salt: number): void {
  streamSalt = salt;
}
const streams = new Map<string, { salt: number; u: Float64Array }>();
export function uniformStream(name: string): Float64Array {
  let s = streams.get(name);
  if (s && s.salt === streamSalt) return s.u;
  if (!s) {
    s = { salt: streamSalt, u: new Float64Array(SAMPLE_COUNT) };
    streams.set(name, s);
  }
  const u = s.u;
  for (let i = 0; i < SAMPLE_COUNT; i++) u[i] = (i + 0.5) / SAMPLE_COUNT;
  const rand = mulberry32(fnv1a(name) ^ streamSalt);
  for (let i = SAMPLE_COUNT - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = u[i];
    u[i] = u[j];
    u[j] = t;
  }
  s.salt = streamSalt;
  return u;
}

/** Acklam's rational approximation to the standard normal quantile (~1e-9). */
export function normalQuantile(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  if (p <= 0 || p >= 1) return NaN;
  if (p < plow || p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(p < plow ? p : 1 - p));
    const x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    return p < plow ? x : -x;
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/** Evaluate an expression column-wise over the sample vectors. Inequalities
 *  yield 1/0 masks (NaN where an operand is NaN), matching evaluate(). */
export function evalCols(
  e: Expr,
  cols: ReadonlyMap<string, Float64Array>,
  env: Record<string, number>,
  n: number,
): Float64Array {
  const alloc = () => new Float64Array(n);
  switch (e.kind) {
    case 'index':
    case 'range':
    case 'eqtest':
    case 'comp':
    case 'figure':
    case 'lazy':
    case 'trail':
    case 'label':
    case 'hist':
    case 'family':
      throw new Error(structuralDiagnostic(e));
    case 'num': {
      const out = alloc();
      out.fill(e.value);
      return out;
    }
    case 'var': {
      const col = cols.get(e.name);
      if (col) return col;
      if (!(e.name in env)) throw new Error(`Unbound variable: ${e.name}`);
      const out = alloc();
      out.fill(env[e.name]);
      return out;
    }
    case 'neg': {
      const a = evalCols(e.a, cols, env, n);
      const out = alloc();
      for (let i = 0; i < n; i++) out[i] = -a[i];
      return out;
    }
    case 'bin': {
      const a = evalCols(e.a, cols, env, n);
      const b = evalCols(e.b, cols, env, n);
      const out = alloc();
      switch (e.op) {
        case '+':
          for (let i = 0; i < n; i++) out[i] = a[i] + b[i];
          break;
        case '-':
          for (let i = 0; i < n; i++) out[i] = a[i] - b[i];
          break;
        case '*':
          for (let i = 0; i < n; i++) out[i] = a[i] * b[i];
          break;
        case '/':
          for (let i = 0; i < n; i++) out[i] = a[i] / b[i];
          break;
        case '^':
          for (let i = 0; i < n; i++) out[i] = Math.pow(a[i], b[i]);
          break;
      }
      return out;
    }
    case 'call': {
      const fn = EVAL_FNS[e.name];
      if (!fn) throw new Error(strayComp(e) ?? `Unknown function: ${e.name}`);
      const args = e.args.map(a => evalCols(a, cols, env, n));
      const out = alloc();
      if (args.length === 1) {
        const a = args[0];
        for (let i = 0; i < n; i++) out[i] = fn(a[i]);
      } else if (args.length === 2) {
        const [a, b] = args;
        for (let i = 0; i < n; i++) out[i] = fn(a[i], b[i]);
      } else {
        for (let i = 0; i < n; i++) out[i] = fn(...args.map(a => a[i]));
      }
      return out;
    }
    case 'eq': {
      const l = evalCols(e.l, cols, env, n);
      const r = evalCols(e.r, cols, env, n);
      const out = alloc();
      for (let i = 0; i < n; i++) out[i] = l[i] - r[i];
      return out;
    }
    case 'ineq': {
      const out = alloc();
      out.fill(1);
      for (const { op, l, r } of ineqComparisons(e)) {
        const a = evalCols(l, cols, env, n);
        const b = evalCols(r, cols, env, n);
        for (let i = 0; i < n; i++) {
          if (Number.isNaN(out[i])) continue;
          if (Number.isNaN(a[i]) || Number.isNaN(b[i])) out[i] = NaN;
          else if (!(op === '<' ? a[i] < b[i] : op === '<=' ? a[i] <= b[i] : op === '>' ? a[i] > b[i] : a[i] >= b[i]))
            out[i] = 0;
        }
      }
      return out;
    }
    case 'loop':
      throw new Error('A recursive function cannot be applied to a data column or random variable yet.');
    case 'piecewise': {
      const out = alloc();
      out.fill(NaN);
      const taken = new Uint8Array(n);
      for (const c of e.cases) {
        const mask = evalCols(c.cond, cols, env, n);
        const val = evalCols(c.value, cols, env, n);
        for (let i = 0; i < n; i++) {
          if (!taken[i] && mask[i] === 1) {
            out[i] = val[i];
            taken[i] = 1;
          }
        }
      }
      if (e.otherwise) {
        const val = evalCols(e.otherwise, cols, env, n);
        for (let i = 0; i < n; i++) if (!taken[i]) out[i] = val[i];
      }
      return out;
    }
    case 'vec':
      throw new Error('Vector in scalar context.');
    case 'list':
    case 'data':
      throw new Error('List in scalar context.');
    case 'str':
    case 'text':
      throw new Error('Text has no numeric value.');
  }
}

/** Estimate a density curve from samples: point masses split off as atoms,
 *  the continuous remainder as a binned kernel density estimate (Silverman
 *  bandwidth over a robust spread) whose area equals its share of the
 *  finite-sample mass. Null when nothing is finite. */
/**
 * Clip a drawn window to where the density is visually present: iterate a
 * coarse-histogram zoom over a value pool, trimming end bins below ~1/256
 * of the peak bin — sub-pixel at plot scale. Without this, heavy tails
 * (anything through a pole, like 1/(1+X) for normal X) stretch a
 * fixed-quantile window by orders of magnitude and starve the peak of grid
 * resolution. Light-tailed pools trim nothing: their peak-to-tail ratio
 * never clears the threshold.
 */
function visualWindow(pool: ArrayLike<number>, lo0: number, hi0: number): [number, number] {
  let wlo = lo0;
  let whi = hi0;
  const NB = 256;
  const counts = new Float64Array(NB);
  for (let iter = 0; iter < 4; iter++) {
    const bw = (whi - wlo) / NB;
    if (!(bw > 0)) break;
    counts.fill(0);
    for (let i = 0; i < pool.length; i++) {
      const v = pool[i];
      if (v >= wlo && v <= whi) counts[Math.min(NB - 1, Math.floor((v - wlo) / bw))]++;
    }
    let peak = 0;
    for (let b = 0; b < NB; b++) peak = Math.max(peak, counts[b]);
    const thresh = peak / NB;
    if (thresh <= 1) break; // no dominant peak: the pool is already balanced
    let a = 0;
    while (a < NB && counts[a] < thresh) a++;
    let b = NB - 1;
    while (b >= 0 && counts[b] < thresh) b--;
    if (b < a) break;
    const nlo = wlo + a * bw;
    const nhi = wlo + (b + 1) * bw;
    // Zoom only on a genuine scale problem — the trim would collapse the
    // window several-fold. A modest proposed trim means the tails carry
    // honest visible mass (a singular peak over a light tail proposes one
    // every round); keep them and stop, or iteration would compound
    // sub-threshold trims into a real bite of probability.
    if (nhi - nlo > 0.25 * (whi - wlo)) break;
    wlo = nlo;
    whi = nhi;
  }
  return [wlo, whi];
}

export function estimateCurve(col: Float64Array, heavy: HeavyBase = 0): DensityCurve | null {
  let finite: number[] = [];
  let sum = 0;
  for (let i = 0; i < col.length; i++) {
    const x = col[i];
    if (isFinite(x)) {
      finite.push(x);
      sum += x;
    }
  }
  const n = finite.length;
  if (n < 16) return null;
  const mean = sum / n;
  let ss = 0;
  for (const x of finite) ss += (x - mean) * (x - mean);
  const sd = Math.sqrt(ss / n);
  const mass = n / col.length;
  // Whether the moments are trustworthy is a question about the WHOLE law, so
  // it is asked of the same population `sd` was computed from — before the
  // atom filter below narrows `finite` to the continuous remainder. Asked of
  // that remainder instead, a distant atom reads as a collapsed tail: bounded
  // {X > 0.5: 100, X} has an exact σ, yet would be reported unstable, with the
  // median of its continuous branch standing in for the law's.
  const robust = robustIfUnstable(decimate(finite), sd, heavy);

  // Atoms: exactly repeated values are point masses — a piecewise branch, a
  // floor, a constant — and smearing them into KDE bumps would read as
  // continuous spread. Stratified streams make continuous values distinct, so
  // a duplicate probe over a prefix keeps that common case on the fast path.
  let atoms: Array<{ x: number; p: number }> | undefined;
  const probe = new Set<number>();
  for (let i = 0; i < Math.min(n, 4096); i++) probe.add(finite[i]);
  if (probe.size < Math.min(n, 4096)) {
    const counts = new Map<number, number>();
    for (const x of finite) counts.set(x, (counts.get(x) ?? 0) + 1);
    const minAtom = Math.max(8, col.length * 0.002);
    const atomValues = new Set<number>();
    for (const [x, count] of counts) {
      if (count >= minAtom) {
        atomValues.add(x);
        (atoms ??= []).push({ x, p: count / col.length });
      }
    }
    if (atoms) {
      atoms.sort((a, b) => a.x - b.x);
      finite = finite.filter(x => !atomValues.has(x));
    }
  }
  if (finite.length < 16) return { pts: [], atoms, mean, sd, mass, robust }; // purely discrete
  // The continuous part's own count and spread size the estimate below.
  const cn = finite.length;
  // Quantiles from a decimated sort: plenty for a range and bandwidth.
  const sub = Float64Array.from(finite.filter((_, i) => i % Math.ceil(cn / 4096) === 0)).sort();
  const q = quantileOf(sub);
  const spread = Math.min(sd, (q(0.75) - q(0.25)) / 1.349);
  if (!(spread > 0)) return { pts: [], atoms, mean, sd, mass, robust }; // no continuous spread
  // 1.4× Silverman's rule. His 0.9 factor is MISE-optimal for i.i.d. draws;
  // measured on these stratified columns, ~1.4× lowers BOTH the sup-error and
  // the curve's residual wobble (second-difference energy ÷2.4) — smoothness
  // is what the plotted line is judged by.
  const h = 1.26 * spread * Math.pow(cn, -0.2);
  // Drawn range: trim the extreme tails, but never past the observed support.
  // An end the trim does not reach is the support edge itself — beyond it the
  // density is truly zero, so a truncated variable like {X > 1: X, 0} has to
  // cut off straight at 1 rather than ramp up to a rounded peak past it.
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const x of finite) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  const [wlo, whi] = visualWindow(sub, x0, x1);
  let lo = Math.max(q(0.005), wlo) - 3 * h;
  let hi = Math.min(q(0.995), whi) + 3 * h;
  const hardLo = lo <= x0;
  const hardHi = hi >= x1;
  if (hardLo) lo = x0;
  if (hardHi) hi = x1;
  const B = 512;
  const dx = (hi - lo) / B;
  const hist = new Float64Array(B + 1);
  const w = 1 / (col.length * dx);
  let inWindow = 0;
  for (const x of finite) {
    // Linear binning: split each sample between its two neighboring grid
    // points, so the histogram carries no half-bin jitter into the curve.
    const k = (x - lo) / dx;
    const k0 = Math.floor(k);
    if (k0 < 0 || k0 >= B) continue;
    const f = k - k0;
    hist[k0] += w * (1 - f);
    hist[k0 + 1] += w * f;
    inWindow++;
  }
  inWindow /= col.length;
  // A grid point holds the density there, but the ones on a support edge
  // collect from one side only — half a cell — so they read half the density.
  if (hardLo) hist[0] *= 2;
  if (hardHi) hist[B] *= 2;
  // Gaussian smoothing of the histogram — the binned KDE.
  const r = Math.min(256, Math.ceil((3 * h) / dx));
  const kernel = new Float64Array(2 * r + 1);
  let ksum = 0;
  for (let k = -r; k <= r; k++) ksum += kernel[k + r] = Math.exp(-0.5 * ((k * dx) / h) ** 2);
  for (let k = 0; k <= 2 * r; k++) kernel[k] /= ksum;
  // Boundary correction, needed only where the support ends. Straight
  // truncation would halve the estimate at the edge (half the kernel hangs
  // outside) and renormalizing alone still sags wherever the density is
  // sloped, so fit a local *line* instead of a local mean: with kernel
  // moments a₀,a₁,a₂ over the part of the window inside the support,
  // f̂ = (a₂S₀ − a₁S₁)/(a₀a₂ − a₁²), which reproduces any linear density
  // exactly. In the interior a₁ = 0 and a₀ = 1, so this is the plain KDE.
  const hard = hardLo || hardHi;
  const P0 = new Float64Array(2 * r + 2);
  const P1 = new Float64Array(2 * r + 2);
  const P2 = new Float64Array(2 * r + 2);
  if (hard) {
    for (let m = 0; m <= 2 * r; m++) {
      const d = (m - r) * dx;
      P0[m + 1] = P0[m] + kernel[m];
      P1[m + 1] = P1[m] + kernel[m] * d;
      P2[m + 1] = P2[m] + kernel[m] * d * d;
    }
  }
  const pts: number[] = [];
  if (hardLo) pts.push(lo, 0); // the jump itself: a vertical at the edge
  for (let j = 0; j <= B; j++) {
    let s0 = 0;
    let s1 = 0;
    const k0 = Math.max(0, j - r);
    const k1 = Math.min(B, j + r);
    for (let k = k0; k <= k1; k++) {
      const wk = hist[k] * kernel[j - k + r];
      s0 += wk;
      if (hard) s1 += wk * (j - k) * dx;
    }
    let y = s0;
    if (hard) {
      // Clip the moment window only at the ends that are real support edges;
      // a merely trimmed tail keeps the full window (its data continues).
      const mlo = hardHi ? Math.max(0, j + r - B) : 0;
      const mhi = hardLo ? Math.min(2 * r, j + r) : 2 * r;
      const a0 = P0[mhi + 1] - P0[mlo];
      const a1 = P1[mhi + 1] - P1[mlo];
      const a2 = P2[mhi + 1] - P2[mlo];
      const den = a0 * a2 - a1 * a1;
      // Local linear can undershoot below zero where samples are sparse;
      // there, fall back to the renormalized mean, which cannot.
      const ll = den > 0 ? (a2 * s0 - a1 * s1) / den : -1;
      y = ll > 0 ? ll : a0 > 0.05 ? s0 / a0 : s0;
    }
    pts.push(lo + j * dx, y);
  }
  if (hardHi) pts.push(hi, 0);
  // The curve's area is the probability of the drawn range — the promise a
  // density plot makes. Smoothing and the edge corrections each perturb it a
  // little (and at an integrable singularity, where no local polynomial fit
  // is meaningful, by more), so restore it exactly.
  let area = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    area += ((pts[i + 1] + pts[i + 3]) / 2) * (pts[i + 2] - pts[i]);
  }
  if (area > 0) {
    const k = inWindow / area;
    for (let i = 1; i < pts.length; i += 2) pts[i] *= k;
  }
  return { pts, atoms, mean, sd, mass, robust };
}

/** Quantiles of an already-sorted pool, by nearest rank. */
const quantileOf =
  (sorted: ArrayLike<number>) =>
  (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/** A sorted sample of at most ~4096 values: plenty for quantiles, and cheap
 *  enough to take of a full sample column. */
function decimate(xs: ArrayLike<number>): Float64Array {
  const step = Math.ceil(xs.length / 4096);
  const out = new Float64Array(Math.ceil(xs.length / step));
  for (let i = 0, j = 0; i < xs.length; i += step) out[j++] = xs[i];
  return out.sort();
}

/** Robust location/spread when the moments are truncation artifacts: a 1%
 *  trim collapsing the spread severalfold means the tails own the second
 *  moment (or it does not exist at all). Undefined while moments are sound.
 *  The pool must be the whole law, atoms included — the same population `sd`
 *  came from — or a distant atom reads as a tail that trimming collapsed. */
function robustIfUnstable(
  sortedPool: ArrayLike<number>,
  sd: number,
  heavy: HeavyBase = 0,
  tailPool?: () => ArrayLike<number>,
): Robust | undefined {
  const q = quantileOf(sortedPool);
  const tlo = q(0.005);
  const thi = q(0.995);
  let n = 0;
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < sortedPool.length; i++) {
    const v = sortedPool[i];
    if (v >= tlo && v <= thi) {
      n++;
      s += v;
      s2 += v * v;
    }
  }
  if (!n) return undefined;
  const m = s / n;
  const sdTrim = Math.sqrt(Math.max(s2 / n - m * m, 0));
  // A trimmed spread of zero is a law concentrated on one value with rare
  // company (a two-point discrete law, say) — finite moments, nothing to
  // stabilize, and the ratio below would call every one of them unstable.
  if (!(sdTrim > 0)) return undefined;
  // Whether the MEAN exists is its own question, asked of the tails and of
  // nothing else: it does exactly when both decay faster than 1/x (tail index
  // above 1). Not of the base laws — X² + Y over StudentT(2) has a base with a
  // mean and none itself — and not of the σ collapse, which a product of
  // log-normals or √|Cauchy| shows while having a perfectly good mean.
  const collapsed = sd > 3 * sdTrim;
  if (!collapsed && !heavy) return undefined;
  // The tails are read off `tailPool` where the caller has a better one: the
  // two-variable tensor grid resolves a pole-driven tail (X/Y) only down to
  // its innermost node, and flattens the outer 2% the index is measured on.
  const tails = tailPool?.() ?? sortedPool;
  const up = hillIndex(tails, q(0.5), 1);
  const down = hillIndex(tails, q(0.5), -1);
  // A mean is reported only when the index clears its bar by two standard
  // errors (Hill's se is index/√k: 8% on an 8192 pool, 5.5% on the tail
  // pool). The bar is 1 — and 1.4 when a base law has no mean at all: there
  // the analytic knowledge leads, and only a transform that visibly tames
  // the tail (atan X, |X|^¼; not X·Z + Z, whose index IS 1 and estimates
  // anywhere in 0.9–1.1) earns a mean. The price, accepted: a mean that
  // exists only just — StudentT(1.05), |Cauchy|^0.8 — reads as unstable.
  const bar = heavy === 2 ? NO_MEAN_BASE_INDEX : 1;
  const robust: Robust = {
    median: q(0.5),
    iqr: q(0.75) - q(0.25),
    meanOk: Math.min(up.index * (1 - 2 / Math.sqrt(up.k)), down.index * (1 - 2 / Math.sqrt(down.k))) > bar,
  };
  if (collapsed) return robust;
  // Under a base law KNOWN to have no variance the bar is far lower. The
  // 3× collapse above only catches tails as wild as a Cauchy's: X + 1 over
  // StudentT(2) has σ = ∞, yet its grid σ (≈ 3, growing like √ln N) survives
  // that test and would print as a confident finite number. The question is
  // whether the transform let the tail through (X + 1, X + Z, √|X| of a
  // Cauchy) or tamed it (sin X, ln|X|, |X|^0.3), and the tail index answers
  // it: a variance exists only above index 2.
  return heavy && Math.min(up.index, down.index) < HEAVY_INDEX ? robust : undefined;
}

/** The tail index a variable built on a no-mean base (Cauchy, StudentT with
 *  df ≤ 1) must clear, two standard errors included, before it reports a mean. */
const NO_MEAN_BASE_INDEX = 1.4;

/** Below this estimated tail index a law fed by an infinite-variance base is
 *  reported by median/IQR. The boundary is 2; the margin covers the Hill
 *  estimate's bias, at the price of calling an index-2.2 law unstable too. */
const HEAVY_INDEX = 2.25;

/** Hill's estimate of the tail index on one side (`side` ±1) of a sorted
 *  pool, from the outer 2% (k points) measured off `centre`: the mean
 *  log-excess over the threshold is 1/index for a power tail, and ~0 (index →
 *  ∞) for a bounded or exponential one. */
function hillIndex(sortedPool: ArrayLike<number>, centre: number, side: 1 | -1): { index: number; k: number } {
  const n = sortedPool.length;
  const k = Math.max(16, Math.floor(n * 0.02));
  if (n < 4 * k) return { index: Infinity, k };
  const at = (i: number): number => side * ((side > 0 ? sortedPool[n - 1 - i] : sortedPool[i]) - centre);
  const threshold = at(k);
  if (!(threshold > 0)) return { index: Infinity, k };
  let sum = 0;
  for (let i = 0; i < k; i++) sum += Math.log(at(i) / threshold);
  return { index: sum > 0 ? k / sum : Infinity, k };
}

/** Joint draws behind a two-variable tail estimate: k = 327 tail points a
 *  side, a Hill standard error of 5.5% — and ~3 ms, against the ~40 ms of
 *  sorting a full SAMPLE_COUNT column on every slider frame. */
export const TAIL_POOL_SIZE = 1 << 14;
/** Work counters for the perf guard: pools are built once per parameter
 *  values, and only for rows whose moments are in question. */
export const TAIL_POOL_STATS = { builds: 0, samples: 0 };

// --- deterministic conditional-CDF curves (the quadrature tier) ---
//
// Between the exact laws and the Monte Carlo estimate: a derived variable
// over ONE or TWO independent bases gets its CDF by conditioning,
//
//   F(z) = E_X[ P(g(x, Y) ≤ z) ],
//
// with both expectations taken over quantile-midpoint grids. The inner
// grid's sorted g-values are order statistics — known quantiles of the
// conditional law — so each sorted column IS a conditional CDF read off by
// linear interpolation; the outer average is the midpoint rule in
// probability space. Everything is deterministic: no pairing noise, so the
// flat plateau of Y/(X+1) renders flat, and the density (the differentiated
// CDF) keeps kinks within a couple of grid cells instead of a kernel
// bandwidth. A curve computes once per definition + parameter values and
// survives resample() — there is no noise to redraw. Three or more
// variables fall through to the sampled tier: the tensor grid would not
// scale.

const QC_OUTER = 512; // conditioning-variable quantile nodes (two-var case)
const QC_INNER = 512; // inner-variable grid per node
const QC_SINGLE = 8192; // inner grid for one-variable transforms
const QC_BINS = 512; // density grid resolution (matches estimateCurve)
export const QC_ZOOM_MAX = 32; // deepest densification of a zoomed rasterization
/** Share of a conditional column one value must hold before it counts as a
 *  point mass rather than the repeats a many-to-one g makes (see the run
 *  scan in conditionalBase). At M = 512 that is a run of 6, comfortably
 *  above the branch counts real expressions produce and far below the
 *  fraction any atom worth a stem holds. */
const ATOM_RUN_FRAC = 0.01;

/** The quantile function of a base distribution at these parameter values,
 *  or null while the parameters are invalid. */
export function quantileClosure(d: BaseDist, env: Record<string, number>): ((u: number) => number) | null {
  const a = d.args.map(e => evaluate(e, env));
  if (!a.every(isFinite)) return null;
  switch (d.kind) {
    case 'normal':
      return a[1] > 0 ? u => a[0] + a[1] * normalQuantile(u) : null;
    case 'uniform':
      return a[1] > a[0] ? u => a[0] + (a[1] - a[0]) * u : null;
    case 'exponential':
      return a[0] > 0 ? u => -Math.log(1 - u) / a[0] : null;
    default:
      return zooQuantile(d.kind, a);
  }
}

// --- quantiles of the laws with no closed-form inverse ---
//
// Every sample in this file is a quantile transform (see the header), so a
// base column costs SAMPLE_COUNT quantile calls — per frame, while a derived
// density is on screen. Inverting an incomplete gamma or beta function that
// often is out of the question; instead each (kind, shape) gets a table:
// the quantile solved exactly (safeguarded Newton on whichever tail is the
// small one) at nodes uniform in logit(u), then cubic Hermite between them
// with the EXACT slope dy/ds = u(1 − u)/density. Both axes are warped so the
// function is nearly linear where it is hard — logit(u) against ln x for a
// positive law, logit x on [0, 1], asinh x on the line — which is what makes
// a power-law tail or a pole at the support edge interpolate to ~1e-9.

/** A law in its warped coordinate y: both tails and the density dP/dy. */
interface WarpedLaw {
  pq: (y: number) => [number, number];
  dens: (y: number) => number;
  unwarp: (y: number) => number;
}

/** Work counters for the perf guard (lib/perf-guards.test.ts): a table build
 *  is the expensive step, and a base column must never trigger one per frame. */
export const QUANTILE_STATS = { builds: 0, cdfEvals: 0 };

const QT_L = 15; // table spans logit(u) ∈ [−15, 15]: u from 3e-7, inside every grid here
const QT_N = 600; // cells; Hermite error ~ h⁴ with h = 0.05
const QT_YMAX = 700; // e^700 and sinh(700) are finite doubles

/** Solve P(y) = u for y, given u and 1 − u (both exact), from a starting guess
 *  and a bracket. Newton, bisecting whenever a step leaves the bracket. */
function solveWarped(law: WarpedLaw, u: number, uc: number, guess: number, ylo: number): number {
  let lo = ylo;
  let hi = QT_YMAX;
  let y = Math.min(hi, Math.max(lo, guess));
  for (let it = 0; it < 200; it++) {
    QUANTILE_STATS.cdfEvals++;
    const [p, q] = law.pq(y);
    const r = u <= 0.5 ? p - u : uc - q; // increasing in y, zero at the root
    if (Number.isNaN(r)) return NaN;
    if (r === 0) return y;
    if (r > 0) hi = y;
    else lo = y;
    let next = y - r / law.dens(y);
    // A step this small has arrived — checked before the bracket test, which
    // a converged step landing ON the bracket edge would otherwise fail.
    if (Math.abs(next - y) <= 1e-13 * (1 + Math.abs(y))) return next;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (hi - lo <= 1e-13 * (1 + Math.abs(y))) return next;
    y = next;
  }
  return y;
}

function buildQuantile(law: WarpedLaw): ((u: number) => number) | null {
  QUANTILE_STATS.builds++;
  const ys = new Float64Array(QT_N + 1);
  const ms = new Float64Array(QT_N + 1); // dy/ds at the nodes
  const h = (2 * QT_L) / QT_N;
  for (let k = 0; k <= QT_N; k++) {
    const sk = -QT_L + k * h;
    const u = 1 / (1 + Math.exp(-sk));
    const uc = 1 / (1 + Math.exp(sk));
    const prev = k ? ys[k - 1] : -QT_YMAX;
    const y = solveWarped(law, u, uc, k ? prev + ms[k - 1] * h : 0, prev);
    if (Number.isNaN(y)) return null;
    ys[k] = y;
    const m = (u * uc) / law.dens(y);
    // Pinned at the representable edge (a Gamma(0.01) quantile below e^−700)
    // or a density that underflowed: flat/secant, not a wild exact slope.
    ms[k] = Math.abs(y) >= QT_YMAX - 1e-9 || !isFinite(m) ? (k ? (y - prev) / h : 0) : m;
  }
  return (u: number): number => {
    if (!(u > 0 && u < 1)) return NaN;
    const sv = Math.log(u / (1 - u));
    if (!(Math.abs(sv) < QT_L)) return law.unwarp(solveWarped(law, u, 1 - u, 0, -QT_YMAX));
    const f = (sv + QT_L) / h;
    const k = Math.min(QT_N - 1, Math.floor(f));
    const t = f - k;
    const t2 = t * t;
    const t3 = t2 * t;
    return law.unwarp(
      (2 * t3 - 3 * t2 + 1) * ys[k] +
        (t3 - 2 * t2 + t) * h * ms[k] +
        (-2 * t3 + 3 * t2) * ys[k + 1] +
        (t3 - t2) * h * ms[k + 1],
    );
  };
}

/** Standard-scale tables by shape: Gamma's rate (and ChiSquared's fixed one)
 *  scales the result, so dragging a rate slider never rebuilds. Small and
 *  bounded — a shape slider leaves a trail of one table per value. */
const quantileTables = new Map<string, ((u: number) => number) | null>();
function cachedQuantile(key: string, make: () => WarpedLaw | null): ((u: number) => number) | null {
  let q = quantileTables.get(key);
  if (q === undefined) {
    const law = make();
    q = law && buildQuantile(law);
    if (quantileTables.size >= 64) quantileTables.delete(quantileTables.keys().next().value!);
  } else {
    // Least RECENTLY USED goes first (a Map iterates in insertion order, so a
    // hit re-inserts): a dragged shape slider leaves a trail of dead tables,
    // and must not push out the one a fixed variable reads every frame.
    quantileTables.delete(key);
  }
  quantileTables.set(key, q);
  return q;
}

function gammaQuantile(shape: number): ((u: number) => number) | null {
  if (shape > GAMMA_UNIFORM_SHAPE) {
    // Wilson–Hilferty: relative error O(shape^−2) in the body.
    const c = 1 / (9 * shape);
    return u => shape * Math.max(0, 1 - c + Math.sqrt(c) * normalQuantile(u)) ** 3;
  }
  const lg = lgamma(shape);
  return cachedQuantile(`g${shape}`, () => ({
    pq: y => gammaPQ(shape, Math.exp(y)),
    // pdf(x)·dx/dy with x = e^y: x^α e^−x / Γ(α), finite even at a pole.
    dens: y => Math.exp(shape * y - Math.exp(y) - lg),
    unwarp: Math.exp,
  }));
}

/** Beta(a, b) quantiles for a + b > BETA_LIMIT_SUM, by the same two limits as
 *  specfn's betaLimit: a Gamma law on a modest parameter's side (X/(1 − X) →
 *  G_a/b), otherwise the normal with its first skewness correction. */
function betaLimitQuantile(al: number, be: number): ((u: number) => number) | null {
  if (al < BETA_GAMMA_SIDE || be < BETA_GAMMA_SIDE) {
    const small = Math.min(al, be);
    const g = gammaQuantile(small);
    if (!g) return null;
    const big = Math.max(al, be);
    return al <= be ? u => g(u) / (big + g(u)) : u => big / (big + g(1 - u));
  }
  const n = al + be;
  const mean = al / n;
  const sd = Math.sqrt((al * be) / (n + 1)) / n;
  const skew = (2 * (be - al) * Math.sqrt(n + 1)) / ((n + 2) * Math.sqrt(al * be));
  return u => {
    const z = normalQuantile(u);
    return Math.min(1, Math.max(0, mean + sd * (z + (skew * (z * z - 1)) / 6)));
  };
}

/** Quantile functions of the kinds quantileClosure has no formula for. */
export function zooQuantile(kind: BaseKind, a: number[]): ((u: number) => number) | null {
  if (paramProblem(kind, a)) return null;
  switch (kind) {
    case 'gamma':
    case 'chisquared': {
      const [shape, rate] = kind === 'gamma' ? a : [a[0] / 2, 0.5];
      const q = gammaQuantile(shape);
      return q && (u => q(u) / rate);
    }
    case 'beta': {
      const [al, be] = a;
      // The table inverts the exact cdf for as long as there is one (~0.2 s to
      // build at a + b = 1e10, once per shape); past it, the cdf's own limits.
      if (al + be > BETA_LIMIT_SUM) return betaLimitQuantile(al, be);
      const lb = lbeta(al, be);
      // y = logit x, so x and 1 − x are both formed without cancellation.
      return cachedQuantile(`b${al},${be}`, () => ({
        pq: y => betaPQ(al, be, 1 / (1 + Math.exp(-y)), 1 / (1 + Math.exp(y))),
        dens: y => Math.exp(-al * Math.log1p(Math.exp(-y)) - be * Math.log1p(Math.exp(y)) - lb),
        unwarp: y => 1 / (1 + Math.exp(-y)),
      }));
    }
    case 'studentt': {
      const df = a[0];
      if (df === 1) return u => Math.tan(Math.PI * (u - 0.5));
      return cachedQuantile(`t${df}`, () => ({
        pq: y => studentTPQ(df, Math.sinh(y)),
        dens: y => studentTPdf(Math.sinh(y), df) * Math.cosh(y),
        unwarp: Math.sinh,
      }));
    }
    case 'lognormal':
      return u => Math.exp(a[0] + a[1] * normalQuantile(u));
    case 'cauchy':
      return u => a[0] + a[1] * Math.tan(Math.PI * (u - 0.5));
    case 'weibull':
      return u => a[1] * Math.pow(-Math.log1p(-u), 1 / a[0]);
    default:
      return null;
  }
}

/** The reusable half of the quadrature tier: the sorted tensor columns and
 *  everything derived from them once — atoms, moments, the drawn window.
 *  Rasterizing a density over ANY z-range from this is ~1ms (condDensity),
 *  which is what lets a zoomed-in viewport recompute the visible stretch of
 *  the curve at full grid resolution instead of magnifying polyline cells. */
export interface QCBase {
  sorted: Float64Array[];
  M: number;
  NX: number;
  atoms?: Array<{ x: number; p: number }>;
  atomValues: Set<number>;
  mean: number;
  sd: number;
  mass: number;
  robust?: Robust;
  /** Full drawn window of the continuous part; null when purely discrete. */
  window: { lo: number; hi: number; hardLo: boolean; hardHi: boolean } | null;
}

export function conditionalBase(
  g: Expr,
  vars: Array<{ name: string; quantile: (u: number) => number }>,
  env: Record<string, number>,
  heavy: HeavyBase = 0,
): QCBase | null {
  const outer = vars.length === 2 ? vars[0] : null;
  const inner = vars[vars.length - 1];
  const NX = outer ? QC_OUTER : 1;
  const M = outer ? QC_INNER : QC_SINGLE;
  const cells = NX * M;
  const innerCol = new Float64Array(M);
  for (let j = 0; j < M; j++) innerCol[j] = inner.quantile((j + 0.5) / M);
  const cols = new Map([[inner.name, innerCol]]);

  // g over the whole grid, one sorted column per conditioning node. (The
  // typed-array sort is numeric; non-finite values land at the ends.)
  const sorted: Float64Array[] = [];
  let finCount = 0;
  let sum = 0;
  let sumsq = 0;
  for (let i = 0; i < NX; i++) {
    const e = outer ? { ...env, [outer.name]: outer.quantile((i + 0.5) / NX) } : env;
    const col = evalCols(g, cols, e, M).slice(); // own copy: g = bare var hands back innerCol
    col.sort();
    sorted.push(col);
    for (let j = 0; j < M; j++) {
      const v = col[j];
      if (isFinite(v)) {
        finCount++;
        sum += v;
        sumsq += v * v;
      }
    }
  }
  if (finCount < 16) return null; // (almost) nowhere defined
  const mean = sum / finCount;
  const sd = Math.sqrt(Math.max(sumsq / finCount - mean * mean, 0));
  const mass = finCount / cells;
  // The robust readout judges the whole law, so its pool keeps the atoms the
  // continuous pool below drops (see robustIfUnstable).
  const allPool: number[] = [];
  const allStride = Math.max(1, Math.floor(finCount / 8192));
  let allSeen = 0;
  for (const col of sorted) {
    for (let j = 0; j < M; j++) {
      const v = col[j];
      if (isFinite(v) && allSeen++ % allStride === allStride >> 1) allPool.push(v);
    }
  }
  allPool.sort((a, b) => a - b);
  // The two-variable tensor grid resolves a pole-driven tail (X/Y) only down
  // to its innermost node and flattens the outer 2% a tail index is measured
  // on, so that tier reads its tails off a modest joint draw instead: the
  // head of each variable's own stream (a uniform random subsample, the two
  // independently shuffled), through the same quantile functions.
  const tailPool =
    outer &&
    ((): Float64Array => {
      TAIL_POOL_STATS.builds++;
      TAIL_POOL_STATS.samples += TAIL_POOL_SIZE;
      const draw = (v: { name: string; quantile: (u: number) => number }): Float64Array =>
        uniformStream(v.name).subarray(0, TAIL_POOL_SIZE).map(v.quantile);
      const joint = evalCols(
        g,
        new Map([
          [outer.name, draw(outer)],
          [inner.name, draw(inner)],
        ]),
        env,
        TAIL_POOL_SIZE,
      );
      return joint.filter(Number.isFinite).sort();
    });
  const robust = robustIfUnstable(allPool, sd, heavy, tailPool || undefined);

  // Repeated values are point masses (piecewise branches, floor, constants):
  // pooled across columns, heavy values become stems, and the continuous CDF
  // below must not carry their jumps.
  //
  // What makes a run an atom is that it does not thin out as the grid
  // refines. A continuous many-to-one g repeats values too — the ±y pair of
  // Y², the branches of any even function — but only ever as many times as it
  // has branches, so its run is O(1) in M while an atom's run is a FRACTION
  // of M. Counting every repeat instead pooled those O(1) runs across all 512
  // columns and cleared the mass threshold on arithmetic alone: max(Y², X)
  // came out as 121 stems holding 43% of the probability, and Y² + 0X as 256
  // stems holding all of it, with no curve left to draw.
  const runMass = new Map<number, number>();
  for (const col of sorted) {
    for (let j = 0; j < M;) {
      const v = col[j];
      let k = j + 1;
      while (k < M && col[k] === v) k++;
      if ((k - j) / M >= ATOM_RUN_FRAC && isFinite(v)) {
        runMass.set(v, (runMass.get(v) ?? 0) + (k - j) / cells);
      }
      j = k;
    }
  }
  let atoms: Array<{ x: number; p: number }> | undefined;
  const atomValues = new Set<number>();
  for (const [x, p] of runMass) {
    if (p >= 0.002) {
      atomValues.add(x);
      (atoms ??= []).push({ x, p });
    }
  }
  atoms?.sort((a, b) => a.x - b.x);

  // Drawn range from the continuous part: pooled decimated quantiles, and
  // the same hard-edge rule as the sampler — an end the tail-trim cannot
  // reach is the support edge itself and must cut off straight.
  let contCount = 0;
  let cmin = Infinity;
  let cmax = -Infinity;
  for (const col of sorted) {
    for (let j = 0; j < M; j++) {
      const v = col[j];
      if (isFinite(v) && !atomValues.has(v)) {
        contCount++;
        if (v < cmin) cmin = v;
        if (v > cmax) cmax = v;
      }
    }
  }
  const partial = { sorted, M, NX, atoms, atomValues, mean, sd, mass, robust };
  if (contCount < 16 || !(cmax > cmin)) return { ...partial, window: null };
  const stride = Math.max(1, Math.floor(contCount / 8192));
  const pool: number[] = [];
  let seen = 0;
  for (const col of sorted) {
    for (let j = 0; j < M; j++) {
      const v = col[j];
      if (isFinite(v) && !atomValues.has(v) && seen++ % stride === 0) pool.push(v);
    }
  }
  pool.sort((a, b) => a - b);
  const q = quantileOf(pool);
  const [wlo, whi] = visualWindow(pool, cmin, cmax);
  const qlo = Math.max(q(0.005), wlo);
  const qhi = Math.min(q(0.995), whi);
  const span = qhi - qlo;
  if (!(span > 0)) return { ...partial, window: null };
  const hardLo = qlo - cmin <= 0.25 * span;
  const hardHi = cmax - qhi <= 0.25 * span;
  return {
    ...partial,
    window: { lo: hardLo ? cmin : qlo, hi: hardHi ? cmax : qhi, hardLo, hardHi },
  };
}

/**
 * Rasterize the density over [lo, hi]: accumulate F on the grid — each
 * column contributes its interpolated conditional CDF with equal weight
 * (quantile midpoints carry equal probability); order statistics sit at
 * run-midpoint quantiles, and half-gap extensions carry F to 0 and to the
 * column's full continuous mass, exact for a locally linear g so a
 * uniform's support edge lands exactly — then differentiate. Returns the
 * bare polyline, no edge drops.
 */
export function condDensity(base: QCBase, lo: number, hi: number): number[] {
  const { sorted, M, NX, atomValues } = base;
  const B = QC_BINS;
  const dz = (hi - lo) / B;
  const F = new Float64Array(B + 1);
  const w = 1 / NX;
  for (const col of sorted) {
    const nx: number[] = [];
    const nF: number[] = [];
    let cum = 0;
    for (let j = 0; j < M;) {
      const v = col[j];
      let k = j + 1;
      while (k < M && col[k] === v) k++;
      if (isFinite(v) && !atomValues.has(v)) {
        nx.push(v);
        nF.push((cum + (k - j) / 2) / M);
        cum += k - j;
      }
      j = k;
    }
    if (!cum) continue;
    const top = cum / M;
    let zeroX: number;
    let topX: number;
    if (nx.length > 1) {
      const last = nx.length - 1;
      const s0 = (nF[1] - nF[0]) / (nx[1] - nx[0]);
      const s1 = (nF[last] - nF[last - 1]) / (nx[last] - nx[last - 1]);
      zeroX = nx[0] - nF[0] / s0;
      topX = nx[last] + (top - nF[last]) / s1;
    } else {
      zeroX = nx[0] - dz / 2; // a lone value: a step smeared over one cell
      topX = nx[0] + dz / 2;
    }
    const bx = [zeroX, ...nx, topX];
    const bF = [0, ...nF, top];
    let p = 0;
    for (let k = 0; k <= B; k++) {
      const z = lo + k * dz;
      if (z <= zeroX) continue;
      if (z >= topX) {
        F[k] += w * top;
        continue;
      }
      while (bx[p + 1] < z) p++;
      F[k] += w * (bF[p] + ((z - bx[p]) / (bx[p + 1] - bx[p])) * (bF[p + 1] - bF[p]));
    }
  }

  // The density is the differentiated CDF. A narrow Gaussian pass then
  // absorbs the outer midpoint rule's ripple (worst where the conditional
  // CDF has a moving square-root edge, e.g. X²+Y²). The ripple lives at the
  // FULL window's cell scale, so a zoomed-in rasterization widens the
  // radius to keep covering it — kinks round over about one full-window
  // cell either way, consistent at every zoom. One-variable transforms have
  // no outer grid and keep the minimal ±2 cells.
  const raw = new Float64Array(B + 1);
  for (let k = 0; k <= B; k++) {
    const a = k === 0 ? F[0] : F[k - 1];
    const b = k === B ? F[B] : F[k + 1];
    raw[k] = Math.max(0, (b - a) / (k === 0 || k === B ? dz : 2 * dz));
  }
  const win = base.window!;
  const r = NX === 1 ? 2 : Math.max(2, Math.min(64, Math.round((win.hi - win.lo) / B / dz / 2)));
  const kern = new Float64Array(2 * r + 1);
  for (let k = -r; k <= r; k++) kern[k + r] = Math.exp((-2 * k * k) / (r * r));
  const dens = new Float64Array(B + 1);
  for (let k = 0; k <= B; k++) {
    let s = 0;
    let ws = 0;
    for (let d = -r; d <= r; d++) {
      const j = k + d;
      if (j < 0 || j > B) continue; // clipped at ends, renormalized here
      s += kern[d + r] * raw[j];
      ws += kern[d + r];
    }
    dens[k] = s / ws;
  }

  const pts: number[] = [];
  for (let k = 0; k <= B; k++) pts.push(lo + k * dz, dens[k]);
  // The curve's area is the range's continuous probability — the promise a
  // density plot makes. Differencing and smoothing each perturb it a
  // little, so restore it exactly.
  let area = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    area += ((pts[i + 1] + pts[i + 3]) / 2) * (pts[i + 2] - pts[i]);
  }
  const target = F[B] - F[0];
  if (area > 0 && target > 0) {
    const scale = target / area;
    for (let i = 1; i < pts.length; i += 2) pts[i] *= scale;
  }
  return pts;
}

/** The full-window curve for a base: the density polyline between hard-edge
 *  drops, or a bare atoms-only curve when nothing continuous is drawable. */
export function condAssemble(base: QCBase): DensityCurve {
  const { atoms, mean, sd, mass, robust, window: win } = base;
  if (!win) return { pts: [], atoms, mean, sd, mass, robust };
  const pts: number[] = [];
  if (win.hardLo) pts.push(win.lo, 0); // the jump itself: a vertical at the edge
  pts.push(...condDensity(base, win.lo, win.hi));
  if (win.hardHi) pts.push(win.hi, 0);
  return { pts, atoms, mean, sd, mass, robust };
}

/** Linear interpolation of a density polyline at x (0 outside its range). */
export function densityAt(curve: DensityCurve, x: number): number {
  const p = curve.pts;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (x >= p[i] && x <= p[i + 2]) {
      const f = (x - p[i]) / (p[i + 2] - p[i] || 1);
      return p[i + 1] + f * (p[i + 3] - p[i + 1]);
    }
  }
  return 0;
}

/** Clip a density curve to [lo, hi] and close it down to the x-axis: the
 *  polygon a Monte Carlo `P(…)` row fills. Null when the clip is empty. */
export function shadePolygon(curve: DensityCurve, lo?: number, hi?: number): number[] | null {
  const p = curve.pts;
  if (p.length < 4) return null;
  const xlo = lo ?? p[0];
  const xhi = hi ?? p[p.length - 2];
  if (!(xhi > xlo)) return null;
  const yAt = (x: number): number => densityAt(curve, x);
  const out: number[] = [xlo, 0, xlo, yAt(xlo)];
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] > xlo && p[i] < xhi) out.push(p[i], p[i + 1]);
  }
  out.push(xhi, yAt(xhi), xhi, 0);
  return out;
}

export interface CacheEntry {
  /** Serialized definition + parameter values the fields were computed under. */
  sig: string;
  /** Joint sample column (present once columns() ran for this sig). */
  col?: Float64Array;
  /** Exact usum piecewise-polynomial curve. */
  curve?: DensityCurve | null;
  /** Quadrature-tier base: sorted tensor columns + window (the ~15ms part). */
  qcb?: QCBase | null;
  /** Deterministic conditional-CDF curve over the full window. */
  qc?: DensityCurve | null;
  /** Zoomed rasterization spliced into the full curve, keyed by its range. */
  qcz?: { lo: number; hi: number; curve: DensityCurve };
  /** Sampled KDE estimate — the last-resort tier, dropped by resample(). */
  est?: DensityCurve | null;
  /** The last curve re-issued with a quadrature-certified mean (see curve()). */
  certified?: { from: DensityCurve; curve: DensityCurve };
  /** Quadrature moments (present once quadMoments ran for this sig). */
  qm?: { mean: number; sd: number; mass: number } | null;
  /** A discrete base: its law, the whole numbers holding all but STEM_TAIL of
   *  each tail, and the stems last built, keyed by their window. */
  pmf?: { law: DiscreteLaw; kLo: number; kHi: number; key: string; stems: PmfStems | null } | null;
  /** A discrete base: its atoms for enumeration ('cap': too wide), and its
   *  exact quantile at every stratum (sortedQuantiles) — per parameter values,
   *  so resample() leaves both alone. */
  atoms?: AtomSet | 'cap' | null;
  strata?: Float64Array;
  /** A derived discrete variable: the enumerated pmf ('cap': sample instead;
   *  null: a base declares no distribution)… */
  dpmf?: DiscretePmf | 'cap' | null;
  /** …the sampled one, dropped by resample() unless `spmfStill`… */
  spmf?: DiscretePmf | null;
  spmfStill?: boolean;
  /** …what the bases' tails say of its first two moments, for the sampled tier… */
  tails?: { mean: Tail; second: Tail };
  /** …and the windows last drawn, by view and selection. */
  runs?: Map<string, PmfStems[]>;
}

/** The pdf and support of a base distribution at these parameter values, or
 *  null while the parameters are invalid. `mid` is a point in the bulk for
 *  the integrator to split at: the (lo, ∞) change of variables alone lands
 *  ChiSquared(200)'s whole peak between two Kronrod nodes and integrates 0. */
export function pdfClosure(
  d: BaseDist,
  env: Record<string, number>,
): { pdf: (x: number) => number; lo: number; hi: number; mid?: number } | null {
  const a = d.args.map(e => evaluate(e, env));
  if (!a.every(isFinite)) return null;
  switch (d.kind) {
    case 'normal':
      return a[1] > 0 ? { pdf: x => normalpdf(x, a[0], a[1]), lo: -Infinity, hi: Infinity } : null;
    case 'uniform':
      return a[1] > a[0] ? { pdf: () => 1 / (a[1] - a[0]), lo: a[0], hi: a[1] } : null;
    case 'exponential':
      return a[0] > 0 ? { pdf: x => a[0] * Math.exp(-a[0] * x), lo: 0, hi: Infinity } : null;
  }
  if (paramProblem(d.kind, a)) return null;
  switch (d.kind) {
    case 'gamma':
      return { pdf: x => gammaPdf(x, a[0], a[1]), lo: 0, hi: Infinity, mid: a[0] / a[1] };
    case 'chisquared':
      return { pdf: x => gammaPdf(x, a[0] / 2, 0.5), lo: 0, hi: Infinity, mid: a[0] };
    case 'beta':
      return { pdf: x => betaPdf(x, a[0], a[1]), lo: 0, hi: 1, mid: a[0] / (a[0] + a[1]) };
    case 'studentt':
      return { pdf: x => studentTPdf(x, a[0]), lo: -Infinity, hi: Infinity, mid: 0 };
    case 'lognormal':
      return {
        pdf: x => (x > 0 ? normalpdf(Math.log(x), a[0], a[1]) / x : 0),
        lo: 0,
        hi: Infinity,
        mid: Math.exp(a[0]),
      };
    case 'cauchy':
      return {
        pdf: x => 1 / (Math.PI * a[1] * (1 + ((x - a[0]) / a[1]) ** 2)),
        lo: -Infinity,
        hi: Infinity,
        mid: a[0],
      };
    case 'weibull':
      return { pdf: x => weibullPdf(x, a[0], a[1]), lo: 0, hi: Infinity, mid: a[1] };
    default:
      return null; // a discrete law has no pdf to integrate against (its transforms enumerate: pmfOf)
  }
}
