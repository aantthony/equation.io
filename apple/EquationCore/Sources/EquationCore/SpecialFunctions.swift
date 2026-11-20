#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Special functions behind the distributions (lib/specfn.ts): the
/// regularized incomplete gamma and beta functions (the cdfs of the
/// continuous laws and of Binomial, Poisson and NegativeBinomial), the
/// densities that need them, and the discrete laws' mass functions. ln Γ
/// itself is `lgammaFn` (Evaluate.swift), the same Lanczos sum.
///
/// The incomplete functions return both tails, `(lower, upper)`, each
/// computed directly where it is the small one: a survival probability read
/// as 1 − cdf has no digits left once the cdf rounds to 1.

private let LN_SQRT_2PI = 0.9189385332046727

/// The Stirling remainder: ln Γ(a) = ½ln(2π/a) + a(ln a − 1) + stirlingCorr(a).
/// Four terms; the next is ~1/(1188 a⁹), below 1e-15 from a = 20.
func stirlingCorr(_ a: Double) -> Double {
  let r = 1 / (a * a)
  return (1.0 / 12 - r * (1.0 / 360 - r * (1.0 / 1260 - r / 1680))) / a
}

/// ln(1 + d) − d without the cancellation near d = 0 (it is ≈ −d²/2).
func log1pmx(_ d: Double) -> Double {
  if abs(d) > 0.3 { return log1p(d) - d }
  // −d²/2 + d³/3 − d⁴/4 + …, summed until it stops moving.
  var term = -d
  var sum = 0.0
  for k in 2..<200 {
    term *= -d
    let add = -term / Double(k)
    sum += add
    if abs(add) <= 1e-17 * abs(sum) { break }
  }
  return sum
}

/// ln Γ(z + ½) − ln Γ(z). Each term grows like z ln z, so past z = 1e4 the
/// difference comes from its own asymptotic series, not the subtraction.
func lgammaHalfDiff(_ z: Double) -> Double {
  if z < 1e4 { return lgammaFn(z + 0.5) - lgammaFn(z) }
  let r = 1 / z
  return 0.5 * log(z) - r * (1.0 / 8 - r * r * (1.0 / 192 - (r * r) / 640))
}

/// ln of x^a e^−x / Γ(a). Large a goes through the mode-centred form: the
/// three terms of the naive one are each ~a ln a and cancel to O(1).
private func lnGammaKernel(_ a: Double, _ x: Double) -> Double {
  if a < 20 { return a * log(x) - x - lgammaFn(a) }
  return a * log1pmx((x - a) / a) + 0.5 * log(a) - LN_SQRT_2PI - stirlingCorr(a)
}

private let TINY = 1e-300
/// Convergence of a continued-fraction factor to 1. Two ulps, not fewer: for
/// huge x the factor sits one ulp off 1 forever and the loop would run out.
private let EPS = 2 * Double.ulpOfOne
/// Both expansions settle in O(√a) terms; past this the answer is NaN, not a guess.
private let MAX_ITER = 1_000_000

/// Past this shape both expansions need thousands of terms (O(√a)) and then
/// run out altogether; Temme's uniform expansion takes over.
let GAMMA_UNIFORM_SHAPE = 1e6

/// Regularized incomplete gamma: (P(a, x), Q(a, x)), a > 0. The series gives
/// P below x = a + 1 and Lentz's continued fraction gives Q above it.
func gammaPQ(_ a: Double, _ x: Double) -> (Double, Double) {
  if !(a > 0) || x.isNaN || a == .infinity { return (.nan, .nan) }
  if x <= 0 { return (0, 1) }
  if x == .infinity { return (1, 0) }
  if a > GAMMA_UNIFORM_SHAPE { return gammaUniform(a, x) }
  let pre = exp(lnGammaKernel(a, x))
  if x < a + 1 {
    var ap = a
    var del = 1 / a
    var sum = del
    var n = 0
    while true {
      if n > MAX_ITER { return (.nan, .nan) }
      ap += 1
      del *= x / ap
      sum += del
      if abs(del) < abs(sum) * 1e-16 { break }
      n += 1
    }
    let p = JS.min([1, sum * pre])
    return (p, 1 - p)
  }
  var b = x + 1 - a
  var c = 1 / TINY
  var d = 1 / b
  var h = d
  var i = 1.0
  while true {
    if i > Double(MAX_ITER) { return (.nan, .nan) }
    let an = -i * (i - a)
    b += 2
    d = an * d + b
    if abs(d) < TINY { d = TINY }
    c = b + an / c
    if abs(c) < TINY { c = TINY }
    d = 1 / d
    let del = d * c
    h *= del
    if abs(del - 1) <= EPS { break }
    i += 1
  }
  let q = JS.min([1, pre * h])
  return (1 - q, q)
}

/// Temme's uniform asymptotic expansion for large a, first two orders:
/// Q(a, x) = Φ̄(η√a) + e^(−aη²/2)/√(2πa) · (c₀(η) + c₁(η)/a), where
/// η²/2 = λ − 1 − ln λ and λ = x/a.
private func gammaUniform(_ a: Double, _ x: Double) -> (Double, Double) {
  let mu = (x - a) / a
  let half = -log1pmx(mu)  // η²/2 ≥ 0
  let eta = JS.sign(mu) * (2 * half).squareRoot()
  let c0: Double
  let c1: Double
  if abs(eta) < 0.05 {
    // The closed forms below are differences of two poles at η = 0.
    c0 = -1.0 / 3 + eta * (1.0 / 12 + eta * (-2.0 / 135 + eta * (1.0 / 864 + eta / 2835)))
    c1 = -1.0 / 540 + eta * (-1.0 / 288 + eta / 378)
  } else {
    c0 = 1 / mu - 1 / eta
    c1 = 1 / (eta * eta * eta) - 1 / (mu * mu * mu) - 1 / (mu * mu) - 1 / (12 * mu)
  }
  let r = (exp(-a * half) / (2 * Double.pi * a).squareRoot()) * (c0 + c1 / a)
  let (pn, qn) = normalPQ(eta * a.squareRoot())
  return (JS.min([1, JS.max([0, pn - r])]), JS.min([1, JS.max([0, qn + r])]))
}

/// The continued fraction of the incomplete beta function (modified Lentz).
private func betaCF(_ a: Double, _ b: Double, _ x: Double) -> Double {
  let qab = a + b
  let qap = a + 1
  let qam = a - 1
  var c = 1.0
  var d = 1 - (qab * x) / qap
  if abs(d) < TINY { d = TINY }
  d = 1 / d
  var h = d
  var m = 1.0
  while true {
    if m > Double(MAX_ITER) { return .nan }
    let m2 = 2 * m
    var aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if abs(d) < TINY { d = TINY }
    c = 1 + aa / c
    if abs(c) < TINY { c = TINY }
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if abs(d) < TINY { d = TINY }
    c = 1 + aa / c
    if abs(c) < TINY { c = TINY }
    d = 1 / d
    let del = d * c
    h *= del
    if abs(del - 1) <= EPS { break }
    m += 1
  }
  return h
}

private let LN_SQRT_PI = 0.5723649429247001

/// ln B(a, b) = ln Γ(a) + ln Γ(b) − ln Γ(a + b). The half-integer partner —
/// the Student t case, where the other argument is df/2 and may be huge —
/// goes through lgammaHalfDiff instead of subtracting two giant logs.
func lbeta(_ a: Double, _ b: Double) -> Double {
  if b == 0.5 { return LN_SQRT_PI - lgammaHalfDiff(a) }
  if a == 0.5 { return LN_SQRT_PI - lgammaHalfDiff(b) }
  return lgammaFn(a) + lgammaFn(b) - lgammaFn(a + b)
}

/// ln of x^a y^b / B(a, b). For large a and b the naive three-way sum is a
/// difference of terms ~n ln n; about the mean the first-order parts cancel
/// identically and Stirling supplies the constant.
private func lnBetaKernel(_ a: Double, _ b: Double, _ x: Double, _ y: Double) -> Double {
  if a < 20 || b < 20 { return a * log(x) + b * log(y) - lbeta(a, b) }
  let n = a + b
  let x0 = a / n
  let y0 = b / n
  // Each side is w·(ln(v/v₀) − d) with d = v/v₀ − 1: log1pmx(d) near the
  // mean, the logarithm of v itself far from it.
  func side(_ w: Double, _ v: Double, _ v0: Double) -> Double {
    let d = (v - v0) / v0
    return w * (abs(d) < 0.5 ? log1pmx(d) : log(v / v0) - d)
  }
  return side(a, x, x0) + side(b, y, y0) + 0.5 * log((a * b) / n) - LN_SQRT_2PI - stirlingCorr(a) - stirlingCorr(b)
    + stirlingCorr(n)
}

/// Past this a + b the continued fraction (O(√n) terms) is out of reach and
/// the law is one of its limits to more digits than a readout shows.
let BETA_LIMIT_SUM = 1e10
/// Below this, the smaller parameter's side is a Gamma law, not a normal.
let BETA_GAMMA_SIDE = 1e5

/// Beta(a, b) for a + b > BETA_LIMIT_SUM: a Gamma cdf with one parameter
/// modest, the normal limit with its skewness correction with both huge.
private func betaLimit(_ a: Double, _ b: Double, _ x: Double, _ y: Double) -> (Double, Double) {
  if a < BETA_GAMMA_SIDE { return gammaPQ(a, (b * x) / y) }
  if b < BETA_GAMMA_SIDE {
    let (p, q) = gammaPQ(b, (a * y) / x)
    return (q, p)
  }
  let n = a + b
  let sd = ((a * b) / (n + 1)).squareRoot() / n
  // x − a/n formed from whichever of x, y is small, so neither side cancels.
  let z = (x < y ? x - a / n : b / n - y) / sd
  let skew = (2 * (b - a) * (n + 1).squareRoot()) / ((n + 2) * (a * b).squareRoot())
  let corr = (skew * (z * z - 1) * exp(-0.5 * z * z)) / (6 * (2 * Double.pi).squareRoot())
  let (p, q) = normalPQ(z)
  return (JS.min([1, JS.max([0, p - corr])]), JS.min([1, JS.max([0, q + corr])]))
}

/// Regularized incomplete beta: (I_x(a, b), 1 − I_x(a, b)), a, b > 0. Takes
/// y = 1 − x as well, so a caller that knows the complement exactly keeps it.
func betaPQ(_ a: Double, _ b: Double, _ x: Double, _ y: Double? = nil) -> (Double, Double) {
  let y = y ?? 1 - x
  if !(a > 0 && b > 0) || x.isNaN || a == .infinity || b == .infinity { return (.nan, .nan) }
  if x <= 0 { return (0, 1) }
  if y <= 0 { return (1, 0) }
  if a + b > BETA_LIMIT_SUM { return betaLimit(a, b, x, y) }
  let bt = exp(lnBetaKernel(a, b, x, y))
  if x < (a + 1) / (a + b + 2) {
    let p = JS.min([1, (bt * betaCF(a, b, x)) / a])
    return (p, 1 - p)
  }
  let q = JS.min([1, (bt * betaCF(b, a, y)) / b])
  return (1 - q, q)
}

/// Standard normal (Φ(z), 1 − Φ(z)) to double precision (`erfFn` is the
/// 1.5e-7 shader twin; this one backs limits that must match a t law).
func normalPQ(_ z: Double) -> (Double, Double) {
  if z.isNaN { return (.nan, .nan) }
  let (p, q) = gammaPQ(0.5, 0.5 * z * z)  // P(|Z| < |z|) and its complement
  let tail = 0.5 * q
  return z > 0 ? (0.5 + 0.5 * p, tail) : (tail, 0.5 + 0.5 * p)
}

/// Above this many degrees of freedom the t cdf comes from its expansion
/// about the normal (error O(df⁻³)): the beta fraction needs O(√df) terms.
let T_NORMAL_DF = 1e6

/// Student t (cdf, survival) with df > 0 degrees of freedom.
func studentTPQ(_ df: Double, _ t: Double) -> (Double, Double) {
  if !(df > 0) || t.isNaN { return (.nan, .nan) }
  if t == .infinity { return (1, 0) }
  if t == -.infinity { return (0, 1) }
  var tail: Double  // P(T > |t|)
  if df > T_NORMAL_DF {
    let a = abs(t)
    let a2 = a * a
    let phi = exp(-0.5 * a2) / (2 * Double.pi).squareRoot()
    tail = normalPQ(a).1
    // (Guarded: past |t| ≈ 38 the density underflows while the polynomial
    // overflows, and 0 · ∞ is not the 0 the correction has become.)
    if phi > 0 {
      let c1 = (a * (a2 + 1)) / 4
      let c2 = (a * (((3 * a2 - 7) * a2 - 5) * a2 - 3)) / 96
      tail = JS.max([0, tail + phi * (c1 / df + c2 / (df * df))])
    }
  } else {
    // x = df/(df + t²), y = t²/(df + t²): both formed directly, so neither
    // the centre (y → 0) nor the far tail (x → 0) is a rounded 1 − something.
    let t2 = t * t
    let x = t2 == .infinity ? 0 : df / (df + t2)
    let y = t2 == .infinity ? 1 : t2 / (df + t2)
    tail = 0.5 * betaPQ(df / 2, 0.5, x, y).0
  }
  return t > 0 ? (1 - tail, tail) : (tail, 1 - tail)
}

// MARK: - Densities (the CPU twins of eq_gammapdf & co. in the shader prelude)
//
// 0 outside the support and 0 while a parameter is invalid (a slider dragged
// through 0 flattens the curve) — never NaN, which would poison a shaded
// region. A pole at a support edge is +∞.

/// Gamma(shape α, rate β) density.
func gammaPdf(_ x: Double, _ shape: Double, _ rate: Double) -> Double {
  if !(shape > 0 && rate > 0) || !(x >= 0) { return 0 }
  if x == 0 { return shape < 1 ? .infinity : shape == 1 ? rate : 0 }
  if x == .infinity { return 0 }
  // β · (βx)^(α−1) e^(−βx) / Γ(α), through the kernel of α (not α − 1, which may be ≤ 0).
  return exp(lnGammaKernel(shape, rate * x)) / x
}

/// Beta(a, b) density on [0, 1].
func betaPdf(_ x: Double, _ a: Double, _ b: Double) -> Double {
  if !(a > 0 && b > 0) || !(x >= 0 && x <= 1) { return 0 }
  if x == 0 { return a < 1 ? .infinity : a == 1 ? b : 0 }
  if x == 1 { return b < 1 ? .infinity : b == 1 ? a : 0 }
  return exp((a - 1) * log(x) + (b - 1) * log1p(-x) - lbeta(a, b))
}

/// Student t density with df degrees of freedom.
func studentTPdf(_ x: Double, _ df: Double) -> Double {
  if !(df > 0) || x.isNaN { return 0 }
  if !x.isFinite { return 0 }
  let kernel = -0.5 * (df + 1) * log1p((x * x) / df)
  return exp(kernel + lgammaHalfDiff(df / 2) - 0.5 * log(df * Double.pi))
}

/// Weibull(shape k, scale λ) density.
func weibullPdf(_ x: Double, _ shape: Double, _ scale: Double) -> Double {
  if !(shape > 0 && scale > 0) || !(x >= 0) { return 0 }
  if x == 0 { return shape < 1 ? .infinity : shape == 1 ? 1 / scale : 0 }
  if x == .infinity { return 0 }
  let lr = log(x / scale)
  let w = exp(shape * lr)  // (x/λ)^k
  if w == .infinity { return 0 }
  return (shape / scale) * exp((shape - 1) * lr - w)
}

// MARK: - Probability mass functions (pmfExpr emits them)
//
// Exactly 0 — never NaN — off the support, at a k that is not a whole number,
// and while a parameter is invalid. Everything is formed in log space from
// Loader's saddle-point pieces, so Binomial(1000, 0.3) and Poisson(1e9)
// neither overflow nor lose their digits to ln Γ differences.

/// x as a whole number, or NaN when it is not one. Within rounding counts:
/// a slider value 0.1·30 = 3.0000000000000004 is 3.
func wholeNumber(_ x: Double) -> Double {
  let r = JS.round(x)
  return r.isFinite && abs(x - r) <= JS.min([1e-6, 1e-9 * JS.max([1, abs(r)])]) ? r : .nan
}

/// ln n! − [½ln(2πn) + n ln n − n]: the error of Stirling's formula, n > 0.
private func stirlerr(_ n: Double) -> Double {
  if n >= 20 { return stirlingCorr(n) }
  return lgammaFn(n + 1) - (0.5 * log(2 * Double.pi * n) + n * (log(n) - 1))
}

/// x ln(x/m) + m − x ≥ 0, the deviance part, without cancellation near x = m.
private func bd0(_ x: Double, _ m: Double) -> Double { -x * log1pmx((m - x) / x) }

/// Loader's binomial kernel, C(n, x) p^x q^(n−x) for real 0 ≤ x ≤ n (the
/// negative binomial calls it off the integers), 0 < p < 1, q = 1 − p.
private func binomRaw(_ x: Double, _ n: Double, _ p: Double, _ q: Double) -> Double {
  if n == 0 { return 1 }
  if x == 0 { return exp(n * (p < 0.1 ? log1p(-p) : log(q))) }
  if x == n { return exp(n * (q < 0.1 ? log1p(-q) : log(p))) }
  let lc = stirlerr(n) - stirlerr(x) - stirlerr(n - x) - bd0(x, n * p) - bd0(n - x, n * q)
  return exp(lc + 0.5 * log(n / (2 * Double.pi * x * (n - x))))
}

/// Binomial(n, p) at k: n a whole number ≥ 0, 0 ≤ p ≤ 1 (0 and 1 are atoms).
func binomPmf(_ k: Double, _ n: Double, _ p: Double) -> Double {
  let n = wholeNumber(n)
  if !(n >= 0 && p >= 0 && p <= 1) || !JS.isInteger(k) || k < 0 || k > n { return 0 }
  if p == 0 { return k == 0 ? 1 : 0 }
  if p == 1 { return k == n ? 1 : 0 }
  return binomRaw(k, n, p, 1 - p)
}

/// Poisson(mean) at k, mean > 0.
func poissonPmf(_ k: Double, _ mean: Double) -> Double {
  if !(mean > 0 && mean < .infinity) || !JS.isInteger(k) || k < 0 { return 0 }
  if k == 0 { return exp(-mean) }
  return exp(-stirlerr(k) - bd0(k, mean)) / (2 * Double.pi * k).squareRoot()
}

/// NegativeBinomial(r, p) at k failures before the r-th success: r > 0 real,
/// 0 < p ≤ 1 (p = 1 is the atom at 0). Γ(k + r)/(k! Γ(r)) p^r (1 − p)^k.
func negBinomPmf(_ k: Double, _ r: Double, _ p: Double) -> Double {
  if !(r > 0 && r < .infinity && p > 0 && p <= 1) || !JS.isInteger(k) || k < 0 { return 0 }
  if p == 1 { return k == 0 ? 1 : 0 }
  if k == 0 { return exp(r * log(p)) }
  // r/(r + k) · binom(r; r + k, p): the kernel symmetric in (r, k).
  return (r / (r + k)) * binomRaw(r, r + k, p, 1 - p)
}

/// DiscreteUniform(a, b) at k: whole numbers a ≤ b, both included.
func discreteUniformPmf(_ k: Double, _ a: Double, _ b: Double) -> Double {
  let a = wholeNumber(a)
  let b = wholeNumber(b)
  if !(a <= b) || !JS.isInteger(k) || k < a || k > b { return 0 }
  return 1 / (b - a + 1)
}

/// The densities and mass functions as `evaluate` runs them (lib/expr.ts
/// `EVAL_FNS`): a missing argument is NaN.
let distributionEvalFunctions: [String: @Sendable ([Double]) -> Double] = {
  @Sendable func arg(_ xs: [Double], _ k: Int) -> Double { xs.count > k ? xs[k] : .nan }
  return [
    GAMMA_PDF_FN: { gammaPdf(arg($0, 0), arg($0, 1), arg($0, 2)) },
    BETA_PDF_FN: { betaPdf(arg($0, 0), arg($0, 1), arg($0, 2)) },
    T_PDF_FN: { studentTPdf(arg($0, 0), arg($0, 1)) },
    WEIBULL_PDF_FN: { weibullPdf(arg($0, 0), arg($0, 1), arg($0, 2)) },
    BINOM_PMF_FN: { binomPmf(arg($0, 0), arg($0, 1), arg($0, 2)) },
    POISSON_PMF_FN: { poissonPmf(arg($0, 0), arg($0, 1)) },
    NEGBINOM_PMF_FN: { negBinomPmf(arg($0, 0), arg($0, 1), arg($0, 2)) },
    DUNIFORM_PMF_FN: { discreteUniformPmf(arg($0, 0), arg($0, 1), arg($0, 2)) },
  ]
}()
