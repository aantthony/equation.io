/**
 * Discrete laws, stems, and exact enumeration of derived discrete variables.
 */

import { type Expr, evaluate, ineqComparisons } from './expr.ts';
import { quadrature } from './integrate.ts';
import { betaPQ, binomPmf, discreteUniformPmf, gammaPQ, negBinomPmf, poissonPmf, wholeNumber } from './specfn.ts';
import {
  type BaseDist,
  bin,
  call,
  canonicalDiscrete,
  num,
  paramProblem,
  pdfExpr,
  type ProbBounds,
} from './dist-base.ts';
import { densityAt, evalCols, normalQuantile, SAMPLE_COUNT } from './dist-sample.ts';
import { type RVSystem } from './dist-system.ts';

// --- discrete laws: pmf, support, quantile, stems ---

/** A discrete law at fixed parameter values. */
export interface DiscreteLaw {
  /** P(X = k); 0 off the support and at any k that is not a whole number. */
  pmf: (k: number) => number;
  /** [P(X ≤ x), P(X > x)], each tail formed directly. */
  pq: (x: number) => [number, number];
  /** The support's ends (hi may be Infinity). */
  lo: number;
  hi: number;
  mean: number;
  sd: number;
  /** A whole number where the pmf peaks (the envelope always samples it). */
  mode: number;
  /**
   * The quantile function, a step function: the smallest whole number k with
   * P(X ≤ k) ≥ u — or, with `upper`, with P(X > k) ≤ u, which addresses the
   * upper tail without forming 1 − u. Exact at the steps: quantile(cdf(k)) is
   * k, and anything above cdf(k) is k + 1. It bounds the stems worth drawing and
   * the support worth enumerating, and the sampled tier draws through it
   * (sortedQuantiles).
   */
  quantile: (u: number, upper?: boolean) => number;
}

/** The law of a discrete base distribution at these parameter values, or null
 *  when the parameters declare none (or the distribution is continuous). */
export function discreteLaw(d: BaseDist, env: Record<string, number>): DiscreteLaw | null {
  const c = canonicalDiscrete(d);
  if (!c) return null;
  // Judged as the family the user wrote (that is whose message a row shows)…
  const written = d.args.map(e => evaluate(e, env));
  if (!written.every(isFinite) || paramProblem(d.kind, written)) return null;
  // …computed as the core law it reduces to, moved by `shift`.
  const a = c.args.map(e => evaluate(e, env));
  const { shift } = c;
  let pmf0: (k: number) => number;
  let pq0: (k: number) => [number, number]; // at a whole number k of the support's range
  let lo = 0;
  let hi = Infinity;
  let mean: number;
  let variance: number;
  let mode: number;
  let quantileGuess: ((u: number, upper: boolean) => number) | undefined;
  switch (c.kind) {
    case 'binomial': {
      const [n, p] = [wholeNumber(a[0]), a[1]];
      pmf0 = k => binomPmf(k, n, p);
      // P(X ≤ k) = I_{1−p}(n − k, k + 1); p = 0 and 1 land on its edges.
      pq0 = k => (k >= n ? [1, 0] : betaPQ(n - k, k + 1, 1 - p, p));
      hi = n;
      mean = n * p;
      variance = n * p * (1 - p);
      mode = Math.min(n, Math.floor((n + 1) * p));
      break;
    }
    case 'poisson':
      pmf0 = k => poissonPmf(k, a[0]);
      pq0 = k => {
        const [p, q] = gammaPQ(k + 1, a[0]); // P(X ≤ k) = Q(k + 1, mean)
        return [q, p];
      };
      mean = variance = a[0];
      mode = Math.floor(a[0]);
      break;
    case 'negbinomial': {
      const [r, p] = a;
      const logq = Math.log1p(-p);
      pmf0 = k => negBinomPmf(k, r, p);
      pq0 = k => {
        if (r !== 1) return betaPQ(r, k + 1, p, 1 - p); // I_p(r, k + 1)
        const lq = (k + 1) * logq; // r = 1: ln P(X > k) = (k + 1) ln(1 − p), −∞ at p = 1
        return [-Math.expm1(lq), Math.exp(lq)];
      };
      // Geometric (and NegativeBinomial with r = 1) has a logarithmic
      // inverse. The shared search below checks neighbouring integers against
      // the actual CDF, preserving exact steps despite rounding in log/exp.
      if (r === 1) quantileGuess = (u, upper) => (upper ? Math.log(u) : Math.log1p(-u)) / logq - 1 + shift;
      mean = (r * (1 - p)) / p;
      variance = mean / p;
      mode = r > 1 ? Math.floor(((r - 1) * (1 - p)) / p) : 0;
      break;
    }
    case 'discreteuniform': {
      lo = wholeNumber(a[0]);
      hi = wholeNumber(a[1]);
      const [l, h] = [lo, hi];
      const n = h - l + 1;
      pmf0 = k => discreteUniformPmf(k, l, h);
      pq0 = k => (k >= h ? [1, 0] : [(k - l + 1) / n, (h - k) / n]);
      mean = (l + h) / 2;
      variance = ((n - 1) / 12) * (n + 1); // (n² − 1)/12 without squaring a huge n
      mode = l;
      break;
    }
  }
  const lo0 = lo;
  lo += shift;
  hi += shift;
  mean += shift;
  mode += shift;
  const pmf = shift ? (k: number): number => pmf0(k - shift) : pmf0;
  // A step function: floored first, and nothing below the support.
  const pq = (x: number): [number, number] => {
    const k = Math.floor(x) - shift;
    return k < lo0 ? [0, 1] : pq0(k);
  };
  const sd = Math.sqrt(variance);
  // P(X ≤ k) ≥ u, asked of whichever tail says it without rounding.
  const reached = (k: number, u: number, upper: boolean): boolean => (upper ? pq(k)[1] <= u : pq(k)[0] >= u);
  const quantile = (u: number, upper = false): number => {
    if (Number.isNaN(u) || u < 0 || u > 1) return NaN;
    if (reached(lo, u, upper)) return lo; // u = 0, or an atom holding it all
    // All the mass, of a support with no end. (A finite one is searched: its
    // answer is where the cdf reaches 1, which may be short of hi.)
    if ((upper ? u <= 0 : u >= 1) && hi === Infinity) return Infinity;
    // Start at a closed-form inverse where available, otherwise a normal
    // guess. Bracket and bisect to correct rounding at the CDF's steps.
    const clamp = (x: number): number => Math.min(hi, Math.max(lo, Math.round(x)));
    let k: number;
    if (quantileGuess) k = clamp(quantileGuess(u, upper));
    else {
      const z = normalQuantile(upper ? 1 - u : u);
      k = clamp(mean + sd * (isFinite(z) ? z : 0));
    }
    if (!isFinite(k)) k = clamp(mean); // σ past double range: start from the mean
    if (!isFinite(k)) return NaN; // …and the mean too (Geometric(1e-320))
    let below: number; // a k that is NOT reached (or lo − 1)
    let at: number; // a k that IS reached
    if (reached(k, u, upper)) {
      at = k;
      below = lo - 1;
      for (let step = 1; at - step > lo - 1; step *= 2) {
        if (!reached(at - step, u, upper)) {
          below = at - step;
          break;
        }
        at -= step;
      }
    } else {
      below = k;
      at = hi;
      for (let step = 1; ; step *= 2) {
        const probe = below + step;
        if (probe >= hi) break; // hi itself is always reached
        if (!isFinite(probe)) return NaN;
        if (reached(probe, u, upper)) {
          at = probe;
          break;
        }
        below = probe;
      }
      if (at === Infinity) return NaN;
    }
    while (at - below > 1) {
      const mid = below + Math.floor((at - below) / 2);
      if (!(mid > below && mid < at)) break; // past 2^53 the whole numbers are coarser than 1
      if (reached(mid, u, upper)) at = mid;
      else below = mid;
    }
    return at;
  };
  return { pmf, pq, lo, hi, mean, sd, mode, quantile };
}

/** At most this many stems are drawn; more whole numbers than that in view
 *  (Poisson(1e6) zoomed out, DiscreteUniform(-1e9, 1e9)) draw the pmf's
 *  ENVELOPE instead — the same exact heights at up to STEM_MAX whole numbers on
 *  a fixed lattice (buildEnvelope), joined — since stems closer than a pixel
 *  are a solid shape anyway. */
export const STEM_MAX = 1024;
/** Mass each tail may hide beyond the drawn stems: far below a pixel. */
export const STEM_TAIL = 1e-12;
/** Counts pmf evaluations for the per-frame stem path: the perf guard reads it. */
export const STEM_STATS = { builds: 0, pmfEvals: 0 };

/** The drawn pmf of a discrete variable over a view. */
export interface PmfStems {
  /** Where the stems stand, ascending — whole numbers for a base law, the
   *  atoms' true values for a derived one — and the mass at each. */
  ks: number[];
  ps: number[];
  /** True when `ks` is a subsample (see STEM_MAX): draw the outline through
   *  the points, not one stem per point. */
  envelope: boolean;
  /** The spacing the stems stand at, when it is not 1: the smallest gap
   *  between a derived variable's atoms (X/2 stands every ½), which is what
   *  decides whether dots fit. */
  step?: number;
}

/** Stems drawn `k` times as tall (see scaleCurve). */
export const scaleStems = (run: PmfStems, k: number): PmfStems =>
  k === 1 ? run : { ...run, ps: run.ps.map(p => p * k) };

/** Every whole number of [kLo, kHi] (finite, at most STEM_MAX of them). */
export function buildStems(law: DiscreteLaw, kLo: number, kHi: number): PmfStems {
  STEM_STATS.builds++;
  const ks: number[] = [];
  for (let k = kLo; k <= kHi; k++) ks.push(k);
  STEM_STATS.pmfEvals += ks.length;
  return { ks, ps: ks.map(law.pmf), envelope: false };
}

/**
 * The envelope's samples: the multiples of `stride` from iLo·stride to
 * iHi·stride, kept to the law's mass range [mLo, mHi], plus that range's ends
 * and the mode wherever the lattice spans them. The lattice is the VIEW-
 * INDEPENDENT part: a power-of-two stride (so i·stride is exact at any size)
 * chosen from the window's width, and samples at its multiples — panning
 * slides the window over fixed samples instead of re-anchoring them to its
 * edge, so the outline neither shimmers nor misses the peak.
 */
export function buildEnvelope(
  law: DiscreteLaw,
  mLo: number,
  mHi: number,
  stride: number,
  iLo: number,
  iHi: number,
): PmfStems {
  STEM_STATS.builds++;
  const from = iLo * stride;
  const to = iHi * stride;
  const set = new Set<number>();
  // Counted by j, not by i: past 2^53 `i++` stops advancing (Poisson(1e300)).
  const n = Math.min(STEM_MAX + 2, Math.round((to - from) / stride));
  for (let j = 0; j <= n; j++) {
    const k = from + j * stride;
    if (k >= mLo && k <= mHi) set.add(k);
  }
  for (const k of [mLo, mHi, law.mode]) if (k >= from && k <= to && k >= mLo && k <= mHi) set.add(k);
  const ks = [...set].sort((a, b) => a - b);
  STEM_STATS.pmfEvals += ks.length;
  return { ks, ps: ks.map(law.pmf), envelope: true };
}

/** How a run of stems is drawn — one spec, consumed by the app's canvas
 *  overlay and by the og rasterizer, so the two cannot drift. Lengths are in
 *  px of the target (CSS px in the app, raster px in og). */
export interface StemGeometry {
  /** Flat [x0, y0, x1, y1, …] in plot coordinates. Stems: one segment each,
   *  NaN, NaN lifting the pen between them, so a thousand are one stroke. An
   *  envelope: the closed outline, down to the axis at both ends. */
  lines: number[];
  /** Stroke width and opacity. A selection (`heavy`) is a wide translucent
   *  band over the variable's own stems, so they — and other P(…) rows —
   *  show through. */
  width: number;
  alpha: number;
  /** A dot capping each stem, at (ks[i], ps[i]); null once they would merge
   *  (stemDotRadius). `outlined`: ringed in the background color. */
  dots: { r: number; outlined: boolean } | null;
  /** Fill opacity of an envelope's outline; null for stems. */
  fill: number | null;
}

export function stemGeometry(run: PmfStems, heavy: boolean, pxPerUnit: number): StemGeometry {
  const { ks, ps } = run;
  const lines: number[] = [];
  if (run.envelope) {
    if (ks.length) lines.push(ks[0], 0);
    ks.forEach((k, i) => lines.push(k, ps[i]));
    if (ks.length) lines.push(ks[ks.length - 1], 0);
    return { lines, width: 1.5, alpha: 1, dots: null, fill: heavy ? 0.35 : 0.16 };
  }
  ks.forEach((k, i) => lines.push(k, 0, k, ps[i], NaN, NaN));
  const pxPerStem = pxPerUnit * (run.step ?? 1);
  const r = stemDotRadius(pxPerStem);
  return {
    lines,
    width: heavy ? Math.min(9, Math.max(3, pxPerStem * 0.6)) : r ? 2 : 1,
    alpha: heavy ? 0.45 : 1,
    dots: r ? { r: heavy ? r + 3 : r, outlined: !heavy && r >= 3 } : null,
    fill: null,
  };
}

/**
 * Where an E(…) row's marker stands: x = the mean, reaching up to the law
 * there. For a discrete variable that is the stem at the mean when the mean is
 * a whole number — within rounding, by wholeNumber's tolerance: Binomial(100,
 * 0.07) has mean 7.000000000000001, and pmf(that) is 0 — and the axis when it
 * falls between stems; for a derived one, the atom the mean lands on, if any. For a continuous one, the exact pdf or the drawn curve.
 * Null when there is no mean to mark. Throws what evaluate throws (a missing
 * parameter this frame).
 */
export function markerHeight(
  sys: RVSystem,
  name: string,
  env: Record<string, number>,
  view?: { lo: number; hi: number },
): { x: number; h: number } | null {
  const m = sys.mean(name, env);
  if (!isFinite(m)) return null;
  if (sys.isDiscreteVar(name)) return sys.atomNear(name, m, env);
  const exact = sys.exactDist(name);
  let h = exact ? evaluate(pdfExpr(exact, num(m)), env) : (c => (c ? densityAt(c, m) : 0))(sys.curve(name, env, view));
  if (!isFinite(h) || h < 0) h = 0;
  return { x: m, h };
}

/** The dot capping each stem, in px, from the spacing of whole numbers on
 *  screen: full size while stems stand apart, small as they crowd, none once
 *  the dots would merge into a band (the lines alone carry the shape). One
 *  rule for the app and the og rasterizer. */
export const stemDotRadius = (pxPerUnit: number): number => (pxPerUnit >= 9 ? 3.5 : pxPerUnit >= 4 ? 2 : 0);

/** The part of drawn stems a P(…) row selects, as runs (two for a
 *  complement). In envelope mode each run gains its exact end points, so the
 *  shaded outline stops at the bound and not at the nearest sample. */
export function selectStems(
  stems: PmfStems,
  law: DiscreteLaw,
  sel: { kLo: number; kHi: number; not: boolean },
): PmfStems[] {
  if (Number.isNaN(sel.kLo) || Number.isNaN(sel.kHi)) return [];
  const ranges: Array<[number, number]> = sel.not
    ? sel.kLo > sel.kHi
      ? [[-Infinity, Infinity]]
      : [
          [-Infinity, sel.kLo - 1],
          [sel.kHi + 1, Infinity],
        ]
    : [[sel.kLo, sel.kHi]];
  const first = stems.ks[0];
  const last = stems.ks[stems.ks.length - 1];
  const out: PmfStems[] = [];
  for (const [a, b] of ranges) {
    const lo = Math.max(a, first);
    const hi = Math.min(b, last);
    if (!(lo <= hi)) continue;
    const ks: number[] = [];
    const ps: number[] = [];
    const push = (k: number, p: number): void => {
      if (k !== ks[ks.length - 1]) {
        ks.push(k);
        ps.push(p);
      }
    };
    if (stems.envelope) push(lo, law.pmf(lo));
    stems.ks.forEach((k, i) => {
      if (k >= lo && k <= hi) push(k, stems.ps[i]);
    });
    if (stems.envelope) push(hi, law.pmf(hi));
    if (ks.length) out.push({ ks, ps, envelope: stems.envelope });
  }
  return out;
}

// --- derived discrete variables: exact atoms by enumeration, else a sampled pmf ---
//
// A variable built only on discrete bases (`S = X1 + X2`, `X^2`, `X/2`,
// `sin(X)`) is itself discrete: finitely many ATOMS carry all but a
// negligible part of its mass. They sit wherever g puts them — X/2 on the
// half-integers, X^2 on a sparse lattice, sin(X) nowhere regular — so nothing
// below assumes whole numbers: atoms are (value, mass) pairs, drawn at their
// true locations. Two joint points that differ only by rounding are ONE atom
// (0.1 + 0.2 and 0.3; 0.1 X + 0.2 Y − 0.3 Z at X = Y = Z and 0), so every
// FINISHED value is made `canonical` — whole numbers trusted, a sum that
// cancelled to within the rounding of its operands read as 0, the rest rounded
// to 12 significant digits — and a P(…) bound is compared the same way. Only
// finished values: a variable's atoms, an event's terms. Intermediate ones
// stay the floats they are (X/3 rounded and then tripled is 0.999999999999).
//
// EXACT TIER. Each base is cut to the whole numbers holding all but ENUM_TAIL
// of each tail (a bounded support of at most FULL_SUPPORT is kept whole), and
// the expression is evaluated over the JOINT of the bases — never over derived
// marginals, so `X - X` is the atom 0 and `A = X + Y; B = X - Y` stay as
// dependent as they are. Subexpressions over DISJOINT bases are independent,
// so they are enumerated on their own and combined (convolution, for a sum):
// ten dice cost 10 × 51 × 6 evaluations, not 6^10. Operands that DO share
// bases are conditioned on the shared ones (T + D0, T the ten dice: six cheap
// enumerations, one per value of D0). Any one product may hold at most
// JOINT_MAX points, and one enumeration 2·JOINT_MAX in all — the cost of the
// sampling tier it would otherwise fall back to, so a slider dragging a
// parameter past the cap degrades to sampling instead of hanging. The mass ignored is at most 2·ENUM_TAIL per
// base (AtomSet.lost).
//
// What truncation does to a MEAN is a separate question — E(2^X) over a
// Geometric diverges, and its truncated sum is a confident wrong number — so
// every atom also carries how much of its mass came from the outer slivers of
// a truncated tail (tail probability ENUM_TAIL..1e-9, and 1e-9..1e-6): the
// same test `diverges` makes for a density, read off the enumeration (see
// momentVerdict).
//
// SAMPLED TIER. Past the cap the joint sample stands in: base columns are the
// exact step-function quantile of the stratified streams, and the variable's
// pmf is the frequency of each distinct sampled value — stems again. Only when
// there are too many distinct values for a frequency to mean anything
// (Poisson(1e6)·Bernoulli) is it a HISTOGRAM, and then on the variable's own
// lattice (the common step of its values, whole numbers or not), with heavy
// atoms kept apart; values on no lattice at all stay stems at the sampled
// values, and the readout says the pmf is unresolved. Never a KDE.

/** Most joint points one enumeration step may evaluate (see above). */
export const JOINT_MAX = SAMPLE_COUNT;
/** Mass each truncated tail of a base may hide from the enumeration. */
const ENUM_TAIL = STEM_TAIL;
/** A bounded support this small is enumerated whole: nothing is truncated, so
 *  no moment of it can be in doubt (2^X over Binomial(1000, ½) lives 10σ out). */
const FULL_SUPPORT = 1024;
/** Most joint values of shared bases an enumeration conditions on (jointBlock). */
export const CONDITION_MAX = 4096;
/** The inner edges of the two tail slivers the moment test compares. */
const SLIVER_A = 1e-9;
const SLIVER_B = 1e-6;
/** An atom is a value to this many significant digits (`canonical`), and ONE
 *  tolerance follows from it: canonical values a grid step apart — two float
 *  results that straddled a rounding boundary — are the same atom, and a sum
 *  this small against the magnitude of its operands cancelled to 0. */
const ATOM_DIGITS = 12;
const ATOM_REL = 1.5 * 10 ** (1 - ATOM_DIGITS);
/** INTERMEDIATE values are never rounded (rounding at every node compounds:
 *  X/3 rounded, then ×3, is 0.999999999999, an atom of its own). They merge
 *  only when they are the same float, or differ by less than this against
 *  their magnitude — float variants of one value (0.1 + 0.2 + 0.3 in two
 *  orders), so a long sum's atom count stays the lattice's. */
const FLOAT_REL = 2 ** -50;
/** Whole numbers a sampled base column tabulates exactly (see sortedQuantiles). */
const TABLE_MAX = 1 << 20;
/** Counts enumeration work: joint points evaluated, and pmf evaluations spent
 *  on base supports and sampling tables. The perf guard reads it. */
export const ENUM_STATS = { builds: 0, points: 0, pmfEvals: 0 };

/** Whether two CANONICAL values are one atom. Whole numbers are exact, and
 *  never merge with each other. */
export const sameAtom = (a: number, b: number): boolean =>
  a === b ||
  (Number.isNaN(a) && Number.isNaN(b)) ||
  (isFinite(a) &&
    isFinite(b) &&
    !(Number.isInteger(a) && Number.isInteger(b)) &&
    Math.abs(a - b) <= ATOM_REL * Math.max(Math.abs(a), Math.abs(b)));

/** Whether a sum of magnitude `mag` that came to x cancelled: its operands'
 *  rounding is all that is left. (Whole operands add exactly: 0 is then 0.) */
export const cancelled = (x: number, mag: number): boolean => x !== 0 && Math.abs(x) <= ATOM_REL * mag;

/** A computed value as the atom it names (see the section comment): rounded
 *  to ATOM_DIGITS of `mag`, the magnitude of what was added up to make it —
 *  |a| + |b| for a ± b, so (X + 0.1) − X is 0.1 to the digits X left it, and
 *  |x| itself where nothing cancelled. A whole number is trusted as it stands.
 *  Applied ONCE, to a finished value: see FLOAT_REL. */
function canonical(x: number, mag: number): number {
  if (!isFinite(x) || Number.isInteger(x)) return x;
  const m = Math.max(Math.abs(x), isFinite(mag) ? mag : 0);
  if (cancelled(x, m)) return 0;
  const e = ATOM_DIGITS - 1 - Math.floor(Math.log10(m));
  if (e < 0 || e > 22) return m > Math.abs(x) ? x : Number(x.toPrecision(ATOM_DIGITS));
  const s = 10 ** e; // exact up to 1e22, so the quotient is the correctly rounded decimal
  return Math.round(x * s) / s;
}

/** An expression bounding the magnitude of what `e` adds up: |a| + |b| for
 *  a ± b, through products; null when nothing in it can cancel. */
function magnitude(e: Expr): Expr | null {
  const cancels = (x: Expr): boolean =>
    x.kind === 'bin'
      ? x.op === '+' || x.op === '-' || cancels(x.a) || cancels(x.b)
      : x.kind === 'neg'
        ? cancels(x.a)
        : x.kind === 'call'
          ? x.args.some(cancels)
          : x.kind === 'piecewise';
  const mag = (x: Expr): Expr => {
    if (x.kind === 'neg') return mag(x.a);
    if (x.kind === 'bin' && (x.op === '+' || x.op === '-')) return bin('+', mag(x.a), mag(x.b));
    if (x.kind === 'bin' && x.op === '*') return bin('*', mag(x.a), mag(x.b));
    return call('abs', x);
  };
  return cancels(e) ? mag(e) : null;
}

/** `e` over columns, unrounded, with the magnitude of each value (see
 *  `canonical`); a sum that cancelled is already 0. (A bare variable is its
 *  column, untouched.) */
export function columnOf(
  e: Expr,
  cols: ReadonlyMap<string, Float64Array>,
  env: Record<string, number>,
  count: number,
): { vals: Float64Array; mags: Float64Array } {
  const vals = evalCols(e, cols, env, count);
  const mag = magnitude(e);
  if (!mag) return { vals, mags: vals.map(Math.abs) };
  const mags = evalCols(mag, cols, env, count);
  for (let i = 0; i < count; i++) if (cancelled(vals[i], mags[i])) vals[i] = 0;
  return { vals, mags };
}

/** `e` over columns, as canonical values: a finished column — an event's
 *  term, a sampled variable. */
export function canonicalColumn(
  e: Expr,
  cols: ReadonlyMap<string, Float64Array>,
  env: Record<string, number>,
  count: number,
): Float64Array {
  if (e.kind === 'var') return evalCols(e, cols, env, count);
  const { vals, mags } = columnOf(e, cols, env, count);
  return canonicalize(vals, mags);
}

/** Make a column canonical in place, against its magnitude column. */
export function canonicalize(vals: Float64Array, mags: ArrayLike<number>): Float64Array {
  for (let i = 0; i < vals.length; i++) vals[i] = canonical(vals[i], mags[i]);
  return vals;
}

/** Atoms of an intermediate value: ascending, then ±∞ and NaN kept as atoms
 *  of their own (atan(1/X) at X = 0 is π/2, exactly as the sampler has it). */
export interface AtomSet {
  xs: Float64Array;
  /** The magnitude of what was added up to make each value (see `canonical`). */
  mag: Float64Array;
  /** Mass of each atom… */
  p: Float64Array;
  /** …the part of it NOT from the outermost sliver of any truncated tail… */
  n: Float64Array;
  /** …and the part from neither sliver. */
  c: Float64Array;
  /** Mass the truncation ignored, at most. */
  lost: number;
}

/** Merge joint points into atoms; `vals` in any order. With `finished` the
 *  values are made canonical first and merge as atoms do (sameAtom, or a grid
 *  step of their magnitude apart); without, they stay the floats they are and
 *  only float variants of one value merge (FLOAT_REL). */
export function mergeAtoms(
  vals: Float64Array,
  mags: ArrayLike<number>,
  wp: ArrayLike<number>,
  wn: ArrayLike<number>,
  wc: ArrayLike<number>,
  lost: number,
  finished: boolean,
): AtomSet {
  if (finished) canonicalize(vals, mags);
  const count = vals.length;
  const idx = new Uint32Array(count);
  let sorted = true;
  for (let i = 0; i < count; i++) {
    idx[i] = i;
    if (i && !(vals[i - 1] <= vals[i])) sorted = false;
  }
  // NaN last; a − b would be NaN between two infinities.
  if (!sorted) {
    idx.sort((i, j) => {
      const [a, b] = [vals[i], vals[j]];
      if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
  const same = (a: number, ma: number, b: number, mb: number): boolean => {
    if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return true;
    if (!isFinite(a) || !isFinite(b) || (Number.isInteger(a) && Number.isInteger(b))) return false;
    return Math.abs(a - b) <= (finished ? ATOM_REL : FLOAT_REL) * Math.max(ma, mb);
  };
  const xs: number[] = [];
  const mag: number[] = [];
  const p: number[] = [];
  const n: number[] = [];
  const c: number[] = [];
  let first = NaN; // the value that opened the current atom: merging never chains
  let firstMag = 0;
  for (let k = 0; k < count; k++) {
    const i = idx[k];
    if (!(wp[i] > 0)) continue; // the pmf underflowed: no atom
    const x = vals[i];
    const last = xs.length - 1;
    if (last >= 0 && same(first, firstMag, x, mags[i])) {
      p[last] += wp[i];
      n[last] += wn[i];
      c[last] += wc[i];
      if (mags[i] > mag[last]) mag[last] = mags[i];
    } else {
      xs.push(x);
      mag.push(mags[i]);
      p.push(wp[i]);
      n.push(wn[i]);
      c.push(wc[i]);
      first = x;
      firstMag = mags[i];
    }
  }
  return {
    xs: Float64Array.from(xs),
    mag: Float64Array.from(mag),
    p: Float64Array.from(p),
    n: Float64Array.from(n),
    c: Float64Array.from(c),
    lost,
  };
}

/** The atoms of a base law: its mass range, or 'cap' when that is too wide to
 *  enumerate (Poisson(1e9), Geometric(1e-6)). */
export function baseAtoms(law: DiscreteLaw): AtomSet | 'cap' {
  const full = law.hi - law.lo < FULL_SUPPORT;
  const kLo = full ? law.lo : law.quantile(ENUM_TAIL);
  const kHi = full ? law.hi : law.quantile(ENUM_TAIL, true);
  if (!isFinite(kLo) || !isFinite(kHi) || !(kHi - kLo < JOINT_MAX)) return 'cap';
  // Slivers only on a side the truncation actually cut.
  const cutLo = kLo > law.lo;
  const cutHi = kHi < law.hi;
  const aLo = cutLo ? law.quantile(SLIVER_A) : -Infinity;
  const bLo = cutLo ? law.quantile(SLIVER_B) : -Infinity;
  const aHi = cutHi ? law.quantile(SLIVER_A, true) : Infinity;
  const bHi = cutHi ? law.quantile(SLIVER_B, true) : Infinity;
  const size = kHi - kLo + 1;
  const xs = new Float64Array(size);
  const p = new Float64Array(size);
  const n = new Float64Array(size);
  const c = new Float64Array(size);
  for (let j = 0; j < size; j++) {
    const k = kLo + j;
    xs[j] = k;
    p[j] = law.pmf(k);
    n[j] = k < aLo || k > aHi ? 0 : p[j];
    c[j] = k < bLo || k > bHi ? 0 : p[j];
  }
  ENUM_STATS.pmfEvals += size;
  const lost = (cutLo ? law.pq(kLo - 1)[0] : 0) + (cutHi ? law.pq(kHi)[1] : 0);
  return { xs, mag: xs.map(Math.abs), p, n, c, lost };
}

/** Jointly enumerated values of some terms: one row per joint point, with
 *  its weights (as AtomSet's p, n, c). `terms` says whose columns these are. */
export interface Block {
  terms: number[];
  cols: Float64Array[];
  mags: Float64Array[];
  p: Float64Array;
  n: Float64Array;
  c: Float64Array;
  lost: number;
}

/** Columns for every term over one product of joint points. */
export interface Joint {
  cols: Float64Array[];
  mags: Float64Array[];
  wp: Float64Array;
  wn: Float64Array;
  wc: Float64Array;
  lost: number;
}

export const blockOf = (term: number, atoms: AtomSet): Block => ({
  terms: [term],
  cols: [atoms.xs],
  mags: [atoms.mag],
  p: atoms.p,
  n: atoms.n,
  c: atoms.c,
  lost: atoms.lost,
});

/** INDEPENDENT blocks laid out over their product: every combination once,
 *  with the product of the weights. Null past JOINT_MAX. Columns of terms no
 *  block holds (constants) are left for the caller. */
export function tensor(blocks: Block[], termCount: number): Joint | null {
  let size = 1;
  for (const block of blocks) {
    size *= block.p.length;
    if (size > JOINT_MAX) return null;
  }
  ENUM_STATS.builds++;
  ENUM_STATS.points += size;
  const wp = new Float64Array(size).fill(1);
  const wn = new Float64Array(size).fill(1);
  const wc = new Float64Array(size).fill(1);
  const cols: Float64Array[] = new Array(termCount);
  const mags: Float64Array[] = new Array(termCount);
  let period = 1;
  let kept = 1;
  for (const block of blocks) {
    const m = block.p.length;
    const at = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      const j = Math.floor(i / period) % m;
      at[i] = j;
      wp[i] *= block.p[j];
      wn[i] *= block.n[j];
      wc[i] *= block.c[j];
    }
    block.terms.forEach((term, k) => {
      const [col, mag] = [new Float64Array(size), new Float64Array(size)];
      for (let i = 0; i < size; i++) {
        col[i] = block.cols[k][at[i]];
        mag[i] = block.mags[k][at[i]];
      }
      cols[term] = col;
      mags[term] = mag;
    });
    period *= m;
    kept *= 1 - block.lost;
  }
  return { cols, mags, wp, wn, wc, lost: 1 - kept };
}

/** The comparisons of a P(…) body as terms and the operators between them:
 *  `a < X <= b` is [a, X, b] with ['<', '<=']; a point event is two terms. */
export function eventShape(body: Expr): { terms: readonly Expr[]; ops: string[] } | null {
  if (body.kind === 'eq') return { terms: [body.l, body.r], ops: ['='] };
  if (body.kind === 'eqtest' && body.args.length === 2) {
    return { terms: body.args, ops: [body.op === '==' ? '=' : '!='] };
  }
  if (body.kind !== 'ineq') return null;
  const comps = ineqComparisons(body);
  return { terms: [comps[0].l, ...comps.map(c => c.r)], ops: comps.map(c => c.op) };
}

/**
 * The event's mask over term columns: 1 where every comparison holds, 0 where
 * one fails, NaN where a side is undefined. Discrete values TIE with positive
 * probability, so strictness is the whole difference between P(X > Y) and
 * P(X >= Y) — and a tie is judged as atoms are told apart (the columns are
 * canonical), so 0.1 X + 0.2 Y at X = Y = 1 equals 0.3 here as in the drawn pmf.
 */
export function eventMask(cols: ArrayLike<number>[], ops: string[], count: number): Float64Array {
  const out = new Float64Array(count).fill(1);
  ops.forEach((op, k) => {
    const [a, b] = [cols[k], cols[k + 1]];
    for (let i = 0; i < count; i++) {
      if (Number.isNaN(out[i])) continue;
      if (Number.isNaN(a[i]) || Number.isNaN(b[i])) {
        out[i] = NaN;
        continue;
      }
      const tie = sameAtom(a[i], b[i]);
      const holds =
        op === '='
          ? tie
          : op === '!='
            ? !tie
            : op === '<'
              ? !tie && a[i] < b[i]
              : op === '>'
                ? !tie && a[i] > b[i]
                : op === '<='
                  ? tie || a[i] < b[i]
                  : tie || a[i] > b[i];
      if (!holds) out[i] = 0;
    }
  });
  return out;
}

/** How a truncated sum of h over the atoms stands to the true E[h]. The
 *  slivers A (tail probability ENUM_TAIL..1e-9) and B (1e-9..1e-6) play the
 *  part of `diverges`'s: a convergent sum gains less from the deeper one, and
 *  then the unseen tail beyond A is about A·r/(1 − r) with r = A/B. 'exact'
 *  when that is invisible (1e-7 of the total: a readout shows six digits), 'estimate' up to 1e-3, and
 *  'diverges' beyond — or when A does not fall short of B at all. */
function momentVerdict(set: AtomSet, h: (x: number) => number): 'exact' | 'estimate' | 'diverges' {
  let total = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < set.xs.length; i++) {
    const w = h(set.xs[i]);
    if (!isFinite(w)) continue;
    total += w * set.p[i];
    a += w * (set.p[i] - set.n[i]);
    b += w * (set.n[i] - set.c[i]);
  }
  if (!(a > 0)) return 'exact'; // nothing truncated, or h vanishes out there
  const r = a / b;
  if (b > 0 && r >= 0.97) return 'diverges';
  // (A lumpy law may leave sliver B empty; then A itself bounds the unseen.)
  const unseen = (b > 0 ? (a * r) / (1 - r) : a) / total;
  return unseen <= 1e-7 ? 'exact' : unseen <= 1e-3 ? 'estimate' : 'diverges';
}

/** The pmf of a derived discrete variable, by either tier. */
export interface DiscretePmf {
  /** Atoms with a finite value, ascending, and the mass of each. */
  xs: Float64Array;
  ps: Float64Array;
  /** Enumerated (else: frequencies of the joint sample). */
  exact: boolean;
  /** P(defined): 1/X at X = 0, sqrt(X − 2) below 2 and an overflow are no
   *  value, as in the density tiers. */
  mass: number;
  /** Mean and sd where defined. The mean is NaN unless `meanOk`; sd is
   *  Infinity where the second moment diverges, NaN where (sampled tier) its
   *  tail could not be certified either way. */
  mean: number;
  sd: number;
  /** False when the mean's sum diverges, or truncation hides a visible part. */
  meanOk: boolean;
  /** Exact tier, and nothing the truncation hid could show in μ (`meanExact`)
   *  or in μ and σ both (`certified`). */
  meanExact: boolean;
  certified: boolean;
  /** Mass the truncation ignored, at most (0 for the sampled tier). */
  lost: number;
  /** Sampled, with too many distinct values for frequencies to mean anything:
   *  the histogram on the variable's lattice, heavy atoms apart — or, with no
   *  lattice, null and `unresolved`. */
  binned?: { bulk: PmfStems; heavy: PmfStems } | null;
  unresolved?: boolean;
}

/** The smallest gap between neighbouring stems (Infinity for a lone one):
 *  the spacing that decides whether THESE stems have room for dots. */
function minGap(ks: ArrayLike<number>): number {
  let step = Infinity;
  for (let i = 1; i < ks.length; i++) step = Math.min(step, ks[i] - ks[i - 1]);
  return step;
}

/** Mean and sd of atoms, averaged where defined. */
function atomMoments(xs: ArrayLike<number>, ps: ArrayLike<number>): { mean: number; sd: number; sum: number } {
  let sum = 0;
  let m1 = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += ps[i];
    m1 += xs[i] * ps[i];
  }
  const mean = m1 / sum;
  let m2 = 0;
  for (let i = 0; i < xs.length; i++) m2 += (xs[i] - mean) ** 2 * ps[i];
  return { mean, sd: Math.sqrt(m2 / sum), sum };
}

export function exactPmf(set: AtomSet): DiscretePmf | null {
  let total = 0;
  let from = 0;
  let to = 0;
  for (let i = 0; i < set.xs.length; i++) {
    total += set.p[i];
    if (set.xs[i] === -Infinity) from = i + 1;
    if (isFinite(set.xs[i])) to = i + 1;
  }
  if (!(total > 0)) return null;
  const xs = set.xs.slice(from, to);
  // Of the mass enumerated (all but `lost`): P(D = 0) of D = X − X is 1.
  const ps = set.p.slice(from, to).map(w => w / total);
  const m = atomMoments(xs, ps);
  const v1 = momentVerdict(set, Math.abs);
  const v2 = momentVerdict(set, x => x * x);
  const meanOk = v1 !== 'diverges' && isFinite(m.mean);
  return {
    xs,
    ps,
    exact: true,
    mass: from === 0 && to === set.xs.length ? 1 : m.sum,
    mean: meanOk ? m.mean : NaN,
    sd: !meanOk ? NaN : v2 === 'diverges' ? Infinity : m.sd,
    meanOk,
    meanExact: meanOk && v1 === 'exact',
    certified: meanOk && v1 === 'exact' && v2 === 'exact',
    lost: set.lost,
  };
}

/** What a tail says of a moment's sum: it converges, it diverges, or the test
 *  could not tell — which certifies nothing, and is said as such. */
export type Tail = 'ok' | 'diverges' | 'unknown';

/** The two tail slivers compared (`deep`: tail probability 1e-12..1e-9 or
 *  1e-9..1e-6, `shallow`: the 1000× likelier one inside it). A sum that
 *  converges comfortably gains far less from the deeper one (u^-a: 1000^(a−1));
 *  within a factor 2 of equal it is at the boundary, where no finite look
 *  decides — E K² of K = 1.0000005^G over Geometric(1e-6) converges, barely. */
export function tailOf(deep: number, shallow: number): Tail {
  if (!isFinite(deep) || !isFinite(shallow)) return 'unknown';
  if (!(deep > 0)) return 'ok';
  if (!(shallow > 0)) return 'unknown';
  const r = deep / shallow;
  return r < 0.5 ? 'ok' : r > 2 ? 'diverges' : 'unknown';
}

/** Divergence along ANY path settles it (the path has positive probability);
 *  short of that, one 'unknown' leaves the moment uncertified. */
export const worseTail = (a: Tail, b: Tail): Tail =>
  a === 'diverges' || b === 'diverges' ? 'diverges' : a === 'unknown' || b === 'unknown' ? 'unknown' : 'ok';

/** The upper tail of E[h(X)] for a law too wide to enumerate, by quadrature in
 *  ln u over the slivers u ∈ [1e-9, 1e-6] and [1e-6, 1e-3] (as `diverges`
 *  does for a density). An integral that does not settle, or an h that
 *  overflows out there, is 'unknown' — never "fine". */
export function quantileTail(h: (x: number) => number, upperQuantile: (u: number) => number): Tail {
  const sliver = (lo: number, hi: number): number =>
    quadrature(
      s => {
        const u = Math.exp(s);
        return h(upperQuantile(u)) * u;
      },
      Math.log(lo),
      Math.log(hi),
    );
  return tailOf(sliver(1e-9, 1e-6), sliver(1e-6, 1e-3));
}

/** Distinct sampled values above which frequencies stop meaning anything. */
const SAMPLED_ATOMS_MAX = STEM_MAX;
/** A sampled value this frequent is an atom in its own right, kept out of the
 *  histogram's bins (the 0 of Poisson(1e6)·Bernoulli). */
const HEAVY_ATOM = 0.01;
const HIST_BINS = 256;

/**
 * The common step of ascending values, or 0 when they sit on no lattice.
 * Whole numbers are exact, and so is Euclid on their gaps. Anything else
 * (X/2 + 0.1, sqrt of a near-constant) carries rounding: Euclid stops at a
 * remainder under `floor`, the step is refit over the whole range, and then
 * every gap must be a whole multiple of it to 1e-3 — values on no lattice
 * pass Euclid with a meaningless tiny step, and fail that at once.
 */
function latticeStep(xs: ArrayLike<number>): number {
  const n = xs.length;
  let whole = true;
  for (let i = 0; i < n && whole; i++) whole = Number.isInteger(xs[i]);
  const range = xs[n - 1] - xs[0];
  const floor = whole ? 0.5 : Math.max(range, Math.abs(xs[0]), Math.abs(xs[n - 1])) / 2 ** 28;
  let g = 0;
  for (let i = 1; i < n; i++) {
    let a = xs[i] - xs[i - 1];
    let b = g;
    while (b > floor) [a, b] = [b, a % b];
    g = a;
    if (!(g > floor)) return 0;
  }
  if (whole) return g;
  g = range / Math.round(range / g);
  for (let i = 1; i < n; i++) {
    const m = (xs[i] - xs[i - 1]) / g;
    if (Math.abs(m - Math.round(m)) > 1e-3) return 0;
  }
  return g;
}

/** The pmf the joint sample shows: the frequency of each distinct value of a
 *  (canonical) sample column. */
export function sampledPmf(col: Float64Array, tails: { mean: Tail; second: Tail }): DiscretePmf | null {
  const finite = col.filter(isFinite).sort();
  if (!finite.length) return null;
  const xs: number[] = [];
  const counts: number[] = [];
  let first = NaN;
  for (let i = 0; i < finite.length; i++) {
    if (xs.length && sameAtom(first, finite[i])) counts[counts.length - 1]++;
    else {
      xs.push((first = finite[i]));
      counts.push(1);
    }
  }
  const ps = Float64Array.from(counts, k => k / col.length);
  const m = atomMoments(xs, ps);
  // A sample's moments are finite whatever the law's are: each is reported
  // only as far as its tail was certified (RVSystem.sampledTails).
  const meanOk = tails.mean === 'ok';
  const pmf: DiscretePmf = {
    xs: Float64Array.from(xs),
    ps,
    exact: false,
    mass: finite.length / col.length,
    mean: meanOk ? m.mean : NaN,
    sd: !meanOk ? NaN : tails.second === 'ok' ? m.sd : tails.second === 'diverges' ? Infinity : NaN,
    meanOk,
    meanExact: false,
    certified: false,
    lost: 0,
  };
  if (xs.length <= SAMPLED_ATOMS_MAX) return pmf;
  // Too many distinct values: a histogram on the values' own lattice.
  const light = xs.filter((_, i) => ps[i] < HEAVY_ATOM);
  const step = light.length > 1 ? latticeStep(light) : 0;
  if (!step) return { ...pmf, binned: null, unresolved: true };
  const heavy: PmfStems = { ks: [], ps: [], envelope: false };
  const origin = light[0];
  const cells = Math.round((light[light.length - 1] - origin) / step) + 1;
  const per = 2 ** Math.max(0, Math.ceil(Math.log2(cells / HIST_BINS))); // lattice points per bin
  const bins = new Float64Array(Math.ceil(cells / per));
  xs.forEach((x, i) => {
    if (ps[i] >= HEAVY_ATOM) {
      heavy.ks.push(x);
      heavy.ps.push(ps[i]);
    } else bins[Math.floor(Math.round((x - origin) / step) / per)] += ps[i];
  });
  // Each bin at its centre, as the mass PER LATTICE POINT — a pmf height, so
  // it sits on the same axis as the exact stems would. An empty stretch is
  // drawn empty: the outline comes down to the axis at its ends.
  const bulk: PmfStems = { ks: [], ps: [], envelope: true };
  const width = per * step;
  bins.forEach((mass, b) => {
    if (!(mass > 0)) return;
    const centre = origin + (b + 0.5) * width - step / 2;
    if (b === 0 || !(bins[b - 1] > 0)) {
      bulk.ks.push(centre - width / 2);
      bulk.ps.push(0);
    }
    bulk.ks.push(centre);
    bulk.ps.push(mass / per);
    if (b === bins.length - 1 || !(bins[b + 1] > 0)) {
      bulk.ks.push(centre + width / 2);
      bulk.ps.push(0);
    }
  });
  heavy.step = minGap(heavy.ks);
  return { ...pmf, binned: { bulk, heavy } };
}

/**
 * The exact quantile of a discrete law at every stratum of the sampling
 * streams, ascending: out[j] = quantile((j + ½)/N). A column is this, read in
 * the stream's shuffled order — so it is built once per parameter values, not
 * per frame. Within TABLE_MAX whole numbers the cdf is walked once (one pmf
 * evaluation per whole number of the sampled range). Past that (Poisson(1e12),
 * sd ≥ 1e5) the quantile is solved exactly at every 64th stratum and
 * interpolated between in the normal score, rounded: every value stays inside
 * its own 64-strata cell, so the marginal is right to 5e-4 in probability,
 * and the whole numbers there are 1e-5 of σ apart — nothing a sample resolves.
 */
export function sortedQuantiles(law: DiscreteLaw): Float64Array {
  const N = SAMPLE_COUNT;
  const out = new Float64Array(N);
  const kLo = law.quantile(0.5 / N);
  const kHi = law.quantile(0.5 / N, true);
  if (!isFinite(kLo) || !isFinite(kHi)) return out.fill(NaN);
  if (kHi - kLo < TABLE_MAX) {
    let k = kLo;
    let cum = law.pq(k)[0];
    let evals = 0;
    for (let j = 0; j < N; j++) {
      const u = (j + 0.5) / N;
      while (cum < u && k < kHi) {
        cum += law.pmf(++k);
        evals++;
      }
      out[j] = k;
    }
    ENUM_STATS.pmfEvals += evals;
    return out;
  }
  const at = (j: number): number => {
    const u = (j + 0.5) / N;
    return u < 0.5 ? law.quantile(u) : law.quantile(1 - u, true);
  };
  const STRIDE = 64;
  for (let j0 = 0; j0 < N; j0 += STRIDE) {
    const j1 = Math.min(N - 1, j0 + STRIDE);
    const [k0, k1] = [at(j0), at(j1)];
    const [z0, z1] = [normalQuantile((j0 + 0.5) / N), normalQuantile((j1 + 0.5) / N)];
    for (let j = j0; j <= j1; j++) {
      const s = (normalQuantile((j + 0.5) / N) - z0) / (z1 - z0);
      out[j] = Math.min(k1, Math.max(k0, Math.round(k0 + (k1 - k0) * s)));
    }
  }
  return out;
}

/** The first index of ascending `xs` whose value is above x (or, at least x). */
export function firstAbove(xs: ArrayLike<number>, x: number, orEqual: boolean): number {
  let [a, z] = [0, xs.length];
  while (a < z) {
    const mid = (a + z) >> 1;
    if (orEqual ? xs[mid] >= x : xs[mid] > x) z = mid;
    else a = mid + 1;
  }
  return a;
}

/** The atoms [i0, i1] of a drawn window: all of them while they are few, else the
 *  TALLEST in each cell of a fixed lattice (multiples of a power-of-two
 *  stride, so a pan slides over the same choice) — exact heights at true
 *  locations, which is what a thousand stems per pixel column look like. */
export function windowAtoms(pmf: DiscretePmf, i0: number, i1: number, view?: { lo: number; hi: number }): PmfStems {
  const { xs, ps } = pmf;
  const v0 = view ? firstAbove(xs, view.lo, true) : 0;
  const v1 = view ? firstAbove(xs, view.hi, false) - 1 : xs.length - 1;
  i0 = Math.max(i0, v0);
  i1 = Math.min(i1, v1);
  const out: PmfStems = { ks: [], ps: [], envelope: false };
  if (i1 - i0 < STEM_MAX) {
    for (let i = i0; i <= i1; i++) {
      out.ks.push(xs[i]);
      out.ps.push(ps[i]);
    }
    // Room for dots is a matter of the atoms ON SCREEN — all of them, so a
    // selected stem is drawn to its neighbours' measure — not of the closest
    // pair anywhere: 1/N crowds toward 0 and stands well apart at 1, ½, ⅓.
    out.step = v1 - v0 < STEM_MAX ? minGap(xs.subarray(v0, v1 + 1)) : 0;
    return out;
  }
  const stride = 2 ** Math.ceil(Math.log2((xs[i1] - xs[i0]) / STEM_MAX));
  let cell = NaN;
  for (let i = i0; i <= i1; i++) {
    const at = Math.floor(xs[i] / stride);
    if (at !== cell) {
      cell = at;
      out.ks.push(xs[i]);
      out.ps.push(ps[i]);
    } else if (ps[i] > out.ps[out.ps.length - 1]) {
      out.ks[out.ks.length - 1] = xs[i];
      out.ps[out.ps.length - 1] = ps[i];
    }
  }
  out.step = stride;
  return out;
}

/** The smallest atom with at least u of the defined mass at or below it. */
export function atomQuantile(pmf: DiscretePmf, u: number): number {
  let total = 0;
  for (let i = 0; i < pmf.ps.length; i++) total += pmf.ps[i];
  let cum = 0;
  for (let i = 0; i < pmf.xs.length; i++) {
    cum += pmf.ps[i];
    if (cum >= u * total) return pmf.xs[i];
  }
  return pmf.xs[pmf.xs.length - 1] ?? NaN;
}

/** The atoms a P(…) selects, as an index range of `xs` (with `not`: all the
 *  rest); null while a bound is NaN. A bound within rounding of an atom IS
 *  that atom, so strictness decides it: `S <= 0.3` takes the atom 0.1 + 0.2. */
export function atomRange(
  pmf: DiscretePmf,
  b: ProbBounds,
  env: Record<string, number>,
): { i0: number; i1: number } | null {
  const at = (e: Expr): number => {
    const mag = magnitude(e);
    return canonical(evaluate(e, env), mag ? evaluate(mag, env) : 0);
  };
  const lo = b.lo ? at(b.lo) : -Infinity;
  const hi = b.hi ? at(b.hi) : Infinity;
  if (Number.isNaN(lo) || Number.isNaN(hi)) return null;
  const { xs } = pmf;
  let i0 = firstAbove(xs, lo, true);
  if (i0 > 0 && sameAtom(xs[i0 - 1], lo)) i0--;
  if (b.loStrict && i0 < xs.length && sameAtom(xs[i0], lo)) i0++;
  let i1 = firstAbove(xs, hi, false) - 1;
  if (i1 + 1 < xs.length && sameAtom(xs[i1 + 1], hi)) i1++;
  if (b.hiStrict && i1 >= 0 && sameAtom(xs[i1], hi)) i1--;
  return { i0, i1 };
}

/**
 * Whether E[h(X)] diverges, by truncation in probability space, where it is
 * ∫₀¹ h(q(u)) du: the mass the integral gains from the two outer slivers
 * u ∈ [1e-6, 1e-3] and then [1e-9, 1e-6] (and their mirrors at 1), each
 * integrated in ln u so a power-law end is smooth. A convergent integral
 * gains less from each deeper sliver; a divergent one does not — a power
 * tail gains more, and at the logarithmic boundary (tail index exactly 2)
 * the two are equal, hence the 3% tolerance. A sliver that fails to settle
 * is "unknown", never "divergent".
 */
export function diverges(h: (x: number) => number, quantile: (u: number) => number): boolean {
  const sliver = (lo: number, hi: number): number => {
    const f = (s: number): number => {
      const u = Math.exp(s);
      const a = h(quantile(u));
      const b = h(quantile(1 - u));
      return ((isFinite(a) ? a : 0) + (isFinite(b) ? b : 0)) * u;
    };
    return quadrature(f, Math.log(lo), Math.log(hi));
  };
  const d1 = sliver(1e-6, 1e-3);
  const d2 = sliver(1e-9, 1e-6);
  return isFinite(d1) && isFinite(d2) && d1 > 0 && d2 >= 0.97 * d1;
}
