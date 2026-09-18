/**
 * Special functions behind the distributions (lib/dist.ts): ln Γ, the
 * regularized incomplete gamma and beta functions (the cdfs of the continuous
 * zoo AND of Binomial, Poisson and NegativeBinomial), the densities that need
 * them, and the discrete laws' mass functions. Everything here is plain double arithmetic with no imports,
 * so expr.ts can register the densities as builtins.
 *
 * The incomplete functions return BOTH tails, `[lower, upper]`, each computed
 * directly where it is the small one — a survival probability read as
 * 1 − cdf has no digits left once the cdf rounds to 1.
 */

const LN_SQRT_2PI = 0.9189385332046727;

/** Lanczos g = 7, n = 9: ln Γ to ~1e-15 relative over the positive reals. */
const LG = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln|Γ(x)|. Poles (0, −1, −2, …) are +Infinity. */
export function lgamma(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x < 0.5) {
    if (Number.isInteger(x)) return Infinity;
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  }
  if (x === Infinity) return Infinity;
  const z = x - 1;
  let a = LG[0];
  for (let i = 1; i < LG.length; i++) a += LG[i] / (z + i);
  const t = z + 7.5;
  return LN_SQRT_2PI + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** The Stirling remainder: ln Γ(a) = ½ln(2π/a) + a(ln a − 1) + stirlingCorr(a).
 *  Four terms; the next is ~1/(1188 a⁹), below 1e-15 from a = 20. */
export function stirlingCorr(a: number): number {
  const r = 1 / (a * a);
  return (1 / 12 - r * (1 / 360 - r * (1 / 1260 - r / 1680))) / a;
}

/** ln(1 + d) − d without the cancellation near d = 0 (it is ≈ −d²/2). */
export function log1pmx(d: number): number {
  if (Math.abs(d) > 0.3) return Math.log1p(d) - d;
  // −d²/2 + d³/3 − d⁴/4 + …, summed until it stops moving.
  let term = -d;
  let sum = 0;
  for (let k = 2; k < 200; k++) {
    term *= -d;
    const add = -term / k;
    sum += add;
    if (Math.abs(add) <= 1e-17 * Math.abs(sum)) break;
  }
  return sum;
}

/** ln Γ(z + ½) − ln Γ(z). Each term grows like z ln z, so past z = 1e4 the
 *  difference comes from its own asymptotic series, not the subtraction. */
export function lgammaHalfDiff(z: number): number {
  if (z < 1e4) return lgamma(z + 0.5) - lgamma(z);
  const r = 1 / z;
  return 0.5 * Math.log(z) - r * (1 / 8 - r * r * (1 / 192 - r * r / 640));
}

/** ln of x^a e^−x / Γ(a). Large a goes through the mode-centred form: the
 *  three terms of the naive one are each ~a ln a and cancel to O(1). */
function lnGammaKernel(a: number, x: number): number {
  if (a < 20) return a * Math.log(x) - x - lgamma(a);
  return a * log1pmx((x - a) / a) + 0.5 * Math.log(a) - LN_SQRT_2PI - stirlingCorr(a);
}

const TINY = 1e-300;
/** Convergence of a continued-fraction factor to 1. Two ulps, not fewer: for
 *  huge x the factor sits one ulp off 1 forever and the loop would run out. */
const EPS = 2 * Number.EPSILON;
/** Both expansions settle in O(√a) terms; past this the answer is NaN, not a guess. */
const MAX_ITER = 1_000_000;

/**
 * Regularized incomplete gamma: [P(a, x), Q(a, x)], a > 0. The series gives P
 * below x = a + 1 and Lentz's continued fraction gives Q above it, the
 * standard switch — each converges fast exactly where the other crawls.
 */
export function gammaPQ(a: number, x: number): [number, number] {
  if (!(a > 0) || Number.isNaN(x) || a === Infinity) return [NaN, NaN];
  if (x <= 0) return [0, 1];
  if (x === Infinity) return [1, 0];
  if (a > GAMMA_UNIFORM_SHAPE) return gammaUniform(a, x);
  const pre = Math.exp(lnGammaKernel(a, x));
  if (x < a + 1) {
    let ap = a;
    let del = 1 / a;
    let sum = del;
    for (let n = 0; ; n++) {
      if (n > MAX_ITER) return [NaN, NaN];
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
    }
    const p = Math.min(1, sum * pre);
    return [p, 1 - p];
  }
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; ; i++) {
    if (i > MAX_ITER) return [NaN, NaN];
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) <= EPS) break;
  }
  const q = Math.min(1, pre * h);
  return [1 - q, q];
}

/** Past this shape both expansions need thousands of terms (O(√a)) and then
 *  run out altogether; Temme's uniform expansion takes over. dist.ts switches
 *  its Gamma quantiles to a closed form at the same point. */
export const GAMMA_UNIFORM_SHAPE = 1e6;

/**
 * Temme's uniform asymptotic expansion for large a, first two orders:
 * Q(a, x) = Φ̄(η√a) + e^(−aη²/2)/√(2πa) · (c₀(η) + c₁(η)/a), where
 * η²/2 = λ − 1 − ln λ and λ = x/a. Error O(a⁻²) relative to the correction,
 * below 1e-12 absolute from a = 1e6, uniformly in x — the bulk and both tails.
 */
function gammaUniform(a: number, x: number): [number, number] {
  const mu = (x - a) / a;
  const half = -log1pmx(mu); // η²/2 ≥ 0
  const eta = Math.sign(mu) * Math.sqrt(2 * half);
  let c0: number;
  let c1: number;
  if (Math.abs(eta) < 0.05) {
    // The closed forms below are differences of two poles at η = 0.
    c0 = -1 / 3 + eta * (1 / 12 + eta * (-2 / 135 + eta * (1 / 864 + eta / 2835)));
    c1 = -1 / 540 + eta * (-1 / 288 + eta / 378);
  } else {
    c0 = 1 / mu - 1 / eta;
    c1 = 1 / (eta * eta * eta) - 1 / (mu * mu * mu) - 1 / (mu * mu) - 1 / (12 * mu);
  }
  const r = (Math.exp(-a * half) / Math.sqrt(2 * Math.PI * a)) * (c0 + c1 / a);
  const [pn, qn] = normalPQ(eta * Math.sqrt(a));
  return [Math.min(1, Math.max(0, pn - r)), Math.min(1, Math.max(0, qn + r))];
}

/** The continued fraction of the incomplete beta function (modified Lentz). */
function betaCF(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; ; m++) {
    if (m > MAX_ITER) return NaN;
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) <= EPS) break;
  }
  return h;
}

const LN_SQRT_PI = 0.5723649429247001;

/** ln B(a, b) = ln Γ(a) + ln Γ(b) − ln Γ(a + b). The half-integer partner —
 *  the Student t case, where the other argument is df/2 and may be huge —
 *  goes through lgammaHalfDiff instead of subtracting two giant logs. */
export function lbeta(a: number, b: number): number {
  if (b === 0.5) return LN_SQRT_PI - lgammaHalfDiff(a);
  if (a === 0.5) return LN_SQRT_PI - lgammaHalfDiff(b);
  return lgamma(a) + lgamma(b) - lgamma(a + b);
}

/** ln of x^a y^b / B(a, b). For large a and b the naive three-way sum is a
 *  difference of terms ~n ln n; about the mean x₀ = a/n the first-order parts
 *  cancel identically (a·d₁ + b·d₂ = n(x + y − 1) = 0) and Stirling supplies
 *  the constant, leaving only O(1) pieces. */
function lnBetaKernel(a: number, b: number, x: number, y: number): number {
  if (a < 20 || b < 20) return a * Math.log(x) + b * Math.log(y) - lbeta(a, b);
  const n = a + b;
  const x0 = a / n;
  const y0 = b / n;
  // Each side is w·(ln(v/v₀) − d) with d = v/v₀ − 1. Near the mean that is
  // log1pmx(d); far from it the logarithm is taken of v itself, so a tiny x —
  // or a tiny y handed in exactly — keeps every digit it came with.
  const side = (w: number, v: number, v0: number): number => {
    const d = (v - v0) / v0;
    return w * (Math.abs(d) < 0.5 ? log1pmx(d) : Math.log(v / v0) - d);
  };
  return side(a, x, x0) + side(b, y, y0)
    + 0.5 * Math.log((a * b) / n) - LN_SQRT_2PI - stirlingCorr(a) - stirlingCorr(b) + stirlingCorr(n);
}

/** Past this a + b the continued fraction (O(√n) terms) is out of reach and
 *  the law is one of its limits to more digits than a readout shows. */
export const BETA_LIMIT_SUM = 1e10;
/** Below this, the smaller parameter's side is a Gamma law, not a normal. */
export const BETA_GAMMA_SIDE = 1e5;

/**
 * Beta(a, b) for a + b > BETA_LIMIT_SUM. With one parameter modest,
 * X/(1 − X) = G_a/G_b → G_a/b: a Gamma cdf, error O(a/b) ≤ 1e-5. With both
 * huge, the normal limit with its skewness correction (Edgeworth, first
 * order): error O(1/min(a, b)) ≤ 1e-5.
 */
function betaLimit(a: number, b: number, x: number, y: number): [number, number] {
  if (a < BETA_GAMMA_SIDE) return gammaPQ(a, (b * x) / y);
  if (b < BETA_GAMMA_SIDE) {
    const [p, q] = gammaPQ(b, (a * y) / x);
    return [q, p];
  }
  const n = a + b;
  const sd = Math.sqrt((a * b) / (n + 1)) / n;
  // x − a/n formed from whichever of x, y is small, so neither side cancels.
  const z = (x < y ? x - a / n : b / n - y) / sd;
  const skew = (2 * (b - a) * Math.sqrt(n + 1)) / ((n + 2) * Math.sqrt(a * b));
  const corr = (skew * (z * z - 1) * Math.exp(-0.5 * z * z)) / (6 * Math.sqrt(2 * Math.PI));
  const [p, q] = normalPQ(z);
  return [Math.min(1, Math.max(0, p - corr)), Math.min(1, Math.max(0, q + corr))];
}

/**
 * Regularized incomplete beta: [I_x(a, b), 1 − I_x(a, b)], a, b > 0. Takes
 * y = 1 − x as well, so a caller that knows the complement exactly (the
 * Student t tail, a logit-space quantile) keeps it. The fraction converges
 * fast below the mean-ish point (a + 1)/(a + b + 2); above it the symmetry
 * I_x(a, b) = 1 − I_y(b, a) swaps in the mirror image.
 */
export function betaPQ(a: number, b: number, x: number, y: number = 1 - x): [number, number] {
  if (!(a > 0 && b > 0) || Number.isNaN(x) || a === Infinity || b === Infinity) return [NaN, NaN];
  if (x <= 0) return [0, 1];
  if (y <= 0) return [1, 0];
  if (a + b > BETA_LIMIT_SUM) return betaLimit(a, b, x, y);
  const bt = Math.exp(lnBetaKernel(a, b, x, y));
  if (x < (a + 1) / (a + b + 2)) {
    const p = Math.min(1, (bt * betaCF(a, b, x)) / a);
    return [p, 1 - p];
  }
  const q = Math.min(1, (bt * betaCF(b, a, y)) / b);
  return [1 - q, q];
}

/** Standard normal [Φ(z), 1 − Φ(z)] to double precision (erf in expr.ts is
 *  the 1.5e-7 shader twin; this one backs limits that must match a t law). */
export function normalPQ(z: number): [number, number] {
  if (Number.isNaN(z)) return [NaN, NaN];
  const [p, q] = gammaPQ(0.5, 0.5 * z * z); // P(|Z| < |z|) and its complement
  const tail = 0.5 * q;
  return z > 0 ? [0.5 + 0.5 * p, tail] : [tail, 0.5 + 0.5 * p];
}

/** Above this many degrees of freedom the t cdf comes from its expansion
 *  about the normal (error O(df⁻³)): the beta fraction needs O(√df) terms. */
export const T_NORMAL_DF = 1e6;

/** Student t [cdf, survival] with df > 0 degrees of freedom. */
export function studentTPQ(df: number, t: number): [number, number] {
  if (!(df > 0) || Number.isNaN(t)) return [NaN, NaN];
  if (t === Infinity) return [1, 0];
  if (t === -Infinity) return [0, 1];
  let tail: number; // P(T > |t|)
  if (df > T_NORMAL_DF) {
    const a = Math.abs(t);
    const a2 = a * a;
    const phi = Math.exp(-0.5 * a2) / Math.sqrt(2 * Math.PI);
    tail = normalPQ(a)[1];
    // (Guarded: past |t| ≈ 38 the density underflows while the polynomial
    // overflows, and 0 · ∞ is not the 0 the correction has become.)
    if (phi > 0) {
      const c1 = (a * (a2 + 1)) / 4;
      const c2 = (a * (((3 * a2 - 7) * a2 - 5) * a2 - 3)) / 96;
      tail = Math.max(0, tail + phi * (c1 / df + c2 / (df * df)));
    }
  } else {
    // x = df/(df + t²), y = t²/(df + t²): both formed directly, so neither
    // the centre (y → 0) nor the far tail (x → 0) is a rounded 1 − something.
    const t2 = t * t;
    const x = t2 === Infinity ? 0 : df / (df + t2);
    const y = t2 === Infinity ? 1 : t2 / (df + t2);
    tail = 0.5 * betaPQ(df / 2, 0.5, x, y)[0];
  }
  return t > 0 ? [1 - tail, tail] : [tail, 1 - tail];
}

// --- densities (the CPU twins of eq_gammapdf & co. in glsl.ts) ---
//
// Conventions shared by all of them: 0 outside the support and 0 while a
// parameter is invalid (a slider dragged through 0 flattens the curve, like
// Exponential's max(rate, 0)) — never NaN, which would poison a shaded
// region. A pole at a support edge is +Infinity.

/** Gamma(shape α, rate β) density. */
export function gammaPdf(x: number, shape: number, rate: number): number {
  if (!(shape > 0 && rate > 0) || !(x >= 0)) return 0;
  if (x === 0) return shape < 1 ? Infinity : shape === 1 ? rate : 0;
  if (x === Infinity) return 0;
  const bx = rate * x;
  // β · (βx)^(α−1) e^(−βx) / Γ(α), through the kernel of α (not α − 1, which
  // may be ≤ 0): (βx)^α e^(−βx)/Γ(α) / x.
  return Math.exp(lnGammaKernel(shape, bx)) / x;
}

/** Beta(a, b) density on [0, 1]. */
export function betaPdf(x: number, a: number, b: number): number {
  if (!(a > 0 && b > 0) || !(x >= 0 && x <= 1)) return 0;
  if (x === 0) return a < 1 ? Infinity : a === 1 ? b : 0;
  if (x === 1) return b < 1 ? Infinity : b === 1 ? a : 0;
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - lbeta(a, b));
}

/** Student t density with df degrees of freedom. */
export function studentTPdf(x: number, df: number): number {
  if (!(df > 0) || Number.isNaN(x)) return 0;
  if (!isFinite(x)) return 0;
  const kernel = -0.5 * (df + 1) * Math.log1p((x * x) / df);
  return Math.exp(kernel + lgammaHalfDiff(df / 2) - 0.5 * Math.log(df * Math.PI));
}

/** Weibull(shape k, scale λ) density. */
export function weibullPdf(x: number, shape: number, scale: number): number {
  if (!(shape > 0 && scale > 0) || !(x >= 0)) return 0;
  if (x === 0) return shape < 1 ? Infinity : shape === 1 ? 1 / scale : 0;
  if (x === Infinity) return 0;
  const lr = Math.log(x / scale);
  const w = Math.exp(shape * lr); // (x/λ)^k
  if (w === Infinity) return 0;
  return (shape / scale) * Math.exp((shape - 1) * lr - w);
}

// --- probability mass functions (lib/dist.ts pmfExpr emits them) ---
//
// Same conventions as the densities: exactly 0 — never NaN — off the support,
// at a k that is not a whole number, and while a parameter is invalid (a
// slider n passing through 2.5 draws nothing, since no Binomial(2.5, p)
// exists). Everything is formed in log space from Loader's saddle-point
// pieces, so Binomial(1000, 0.3) and Poisson(1e9) neither overflow nor lose
// their digits to ln Γ differences of order n ln n.

/**
 * x as a whole number, or NaN when it is not one. Within rounding counts:
 * a slider value 0.1·30 = 3.0000000000000004 is 3.
 */
export function wholeNumber(x: number): number {
  const r = Math.round(x);
  return isFinite(r) && Math.abs(x - r) <= Math.min(1e-6, 1e-9 * Math.max(1, Math.abs(r))) ? r : NaN;
}

/** ln n! − [½ln(2πn) + n ln n − n]: the error of Stirling's formula, n > 0. */
function stirlerr(n: number): number {
  if (n >= 20) return stirlingCorr(n);
  return lgamma(n + 1) - (0.5 * Math.log(2 * Math.PI * n) + n * (Math.log(n) - 1));
}

/** x ln(x/m) + m − x ≥ 0, the deviance part, without cancellation near x = m. */
const bd0 = (x: number, m: number): number => -x * log1pmx((m - x) / x);

/** Loader's binomial kernel, C(n, x) p^x q^(n−x) for REAL 0 ≤ x ≤ n (the
 *  negative binomial calls it off the integers), 0 < p < 1, q = 1 − p. */
function binomRaw(x: number, n: number, p: number, q: number): number {
  if (n === 0) return 1;
  if (x === 0) return Math.exp(n * (p < 0.1 ? Math.log1p(-p) : Math.log(q)));
  if (x === n) return Math.exp(n * (q < 0.1 ? Math.log1p(-q) : Math.log(p)));
  const lc = stirlerr(n) - stirlerr(x) - stirlerr(n - x) - bd0(x, n * p) - bd0(n - x, n * q);
  return Math.exp(lc + 0.5 * Math.log(n / (2 * Math.PI * x * (n - x))));
}

/** Binomial(n, p) at k: n a whole number ≥ 0, 0 ≤ p ≤ 1 (0 and 1 are atoms). */
export function binomPmf(k: number, n: number, p: number): number {
  n = wholeNumber(n);
  if (!(n >= 0 && p >= 0 && p <= 1) || !Number.isInteger(k) || k < 0 || k > n) return 0;
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  return binomRaw(k, n, p, 1 - p);
}

/** Poisson(mean) at k, mean > 0. */
export function poissonPmf(k: number, mean: number): number {
  if (!(mean > 0 && mean < Infinity) || !Number.isInteger(k) || k < 0) return 0;
  if (k === 0) return Math.exp(-mean);
  return Math.exp(-stirlerr(k) - bd0(k, mean)) / Math.sqrt(2 * Math.PI * k);
}

/** NegativeBinomial(r, p) at k FAILURES before the r-th success: r > 0 real,
 *  0 < p ≤ 1 (p = 1 is the atom at 0). Γ(k + r)/(k! Γ(r)) p^r (1 − p)^k. */
export function negBinomPmf(k: number, r: number, p: number): number {
  if (!(r > 0 && r < Infinity && p > 0 && p <= 1) || !Number.isInteger(k) || k < 0) return 0;
  if (p === 1) return k === 0 ? 1 : 0;
  if (k === 0) return Math.exp(r * Math.log(p));
  // r/(r + k) · binom(r; r + k, p): the kernel symmetric in (r, k), so huge r
  // or huge k costs nothing.
  return (r / (r + k)) * binomRaw(r, r + k, p, 1 - p);
}

/** DiscreteUniform(a, b) at k: whole numbers a ≤ b, both included. */
export function discreteUniformPmf(k: number, a: number, b: number): number {
  a = wholeNumber(a);
  b = wholeNumber(b);
  if (!(a <= b) || !Number.isInteger(k) || k < a || k > b) return 0;
  return 1 / (b - a + 1);
}
