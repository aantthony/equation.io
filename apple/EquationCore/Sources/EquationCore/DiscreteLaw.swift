#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Discrete laws at fixed parameter values, and the stems they draw as
/// (lib/dist.ts "discrete laws: pmf, support, quantile, stems").

/// Acklam's rational approximation to the standard normal quantile (~1e-9)
/// (lib/dist.ts `normalQuantile`).
func normalQuantile(_ p: Double) -> Double {
  let a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
    2.506628277459239,
  ]
  let b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1,
  ]
  let c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ]
  let d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  let plow = 0.02425
  if p <= 0 || p >= 1 { return .nan }
  if p < plow || p > 1 - plow {
    let q = (-2 * log(p < plow ? p : 1 - p)).squareRoot()
    let x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    return p < plow ? x : -x
  }
  let q = p - 0.5
  let r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q)
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/// A discrete law at fixed parameter values (lib/dist.ts `DiscreteLaw`).
public struct DiscreteLaw: Sendable {
  /// P(X = k); 0 off the support and at any k that is not a whole number.
  public var pmf: @Sendable (Double) -> Double
  /// (P(X ≤ x), P(X > x)), each tail formed directly.
  public var pq: @Sendable (Double) -> (Double, Double)
  /// The support's ends (hi may be infinite).
  public var lo: Double
  public var hi: Double
  public var mean: Double
  public var sd: Double
  /// A whole number where the pmf peaks (the envelope always samples it).
  public var mode: Double
  /// The quantile function, a step function: the smallest whole number k
  /// with P(X ≤ k) ≥ u — or, with `upper`, with P(X > k) ≤ u, which addresses
  /// the upper tail without forming 1 − u. Exact at the steps.
  public var quantile: @Sendable (_ u: Double, _ upper: Bool) -> Double
}

/// The law of a discrete base distribution at these parameter values, or nil
/// when the parameters declare none (or the distribution is continuous)
/// (`discreteLaw`).
func discreteLaw(_ d: BaseDist, _ env: [String: Double]) throws -> DiscreteLaw? {
  guard let c = canonicalDiscrete(d) else { return nil }
  // Judged as the family the user wrote (that is whose message a row shows)…
  let written = try d.args.map { try evaluate($0, env) }
  if !written.allSatisfy(\.isFinite) || paramProblem(d.kind, written) != nil { return nil }
  // …computed as the core law it reduces to, moved by `shift`.
  let a = try c.args.map { try evaluate($0, env) }
  let shift = c.shift
  let pmf0: @Sendable (Double) -> Double
  let pq0: @Sendable (Double) -> (Double, Double)  // at a whole number k of the support's range
  var lo = 0.0
  var hi = Double.infinity
  var mean: Double
  let variance: Double
  var mode: Double
  var quantileGuess: (@Sendable (Double, Bool) -> Double)?
  switch c.kind {
  case .binomial:
    let (n, p) = (wholeNumber(a[0]), a[1])
    pmf0 = { binomPmf($0, n, p) }
    // P(X ≤ k) = I_{1−p}(n − k, k + 1); p = 0 and 1 land on its edges.
    pq0 = { k in k >= n ? (1, 0) : betaPQ(n - k, k + 1, 1 - p, p) }
    hi = n
    mean = n * p
    variance = n * p * (1 - p)
    mode = JS.min([n, ((n + 1) * p).rounded(.down)])
  case .poisson:
    let m = a[0]
    pmf0 = { poissonPmf($0, m) }
    pq0 = { k in
      let (p, q) = gammaPQ(k + 1, m)  // P(X ≤ k) = Q(k + 1, mean)
      return (q, p)
    }
    mean = m
    variance = m
    mode = m.rounded(.down)
  case .negbinomial:
    let (r, p) = (a[0], a[1])
    let logq = log1p(-p)
    pmf0 = { negBinomPmf($0, r, p) }
    pq0 = { k in
      if r != 1 { return betaPQ(r, k + 1, p, 1 - p) }  // I_p(r, k + 1)
      let lq = (k + 1) * logq  // r = 1: ln P(X > k) = (k + 1) ln(1 − p), −∞ at p = 1
      return (-expm1(lq), exp(lq))
    }
    // Geometric (and NegativeBinomial with r = 1) has a logarithmic inverse.
    // The shared search below checks neighbouring integers against the
    // actual CDF, preserving exact steps despite rounding in log/exp.
    if r == 1 { quantileGuess = { u, upper in (upper ? log(u) : log1p(-u)) / logq - 1 + shift } }
    mean = (r * (1 - p)) / p
    variance = mean / p
    mode = r > 1 ? (((r - 1) * (1 - p)) / p).rounded(.down) : 0
  case .discreteuniform:
    lo = wholeNumber(a[0])
    hi = wholeNumber(a[1])
    let (l, h) = (lo, hi)
    let n = h - l + 1
    pmf0 = { discreteUniformPmf($0, l, h) }
    pq0 = { k in k >= h ? (1, 0) : ((k - l + 1) / n, (h - k) / n) }
    mean = (l + h) / 2
    variance = ((n - 1) / 12) * (n + 1)  // (n² − 1)/12 without squaring a huge n
    mode = l
  }
  let lo0 = lo
  lo += shift
  hi += shift
  mean += shift
  mode += shift
  let pmf: @Sendable (Double) -> Double = { k in pmf0(k - shift) }
  // A step function: floored first, and nothing below the support.
  let pq: @Sendable (Double) -> (Double, Double) = { x in
    let k = x.rounded(.down) - shift
    return k < lo0 ? (0, 1) : pq0(k)
  }
  let sd = variance.squareRoot()
  let (low, high, centre) = (lo, hi, mean)
  let guess = quantileGuess
  // P(X ≤ k) ≥ u, asked of whichever tail says it without rounding.
  @Sendable func reached(_ k: Double, _ u: Double, _ upper: Bool) -> Bool { upper ? pq(k).1 <= u : pq(k).0 >= u }
  @Sendable func quantile(_ u: Double, _ upper: Bool) -> Double {
    if u.isNaN || u < 0 || u > 1 { return .nan }
    if reached(low, u, upper) { return low }  // u = 0, or an atom holding it all
    // All the mass, of a support with no end. (A finite one is searched: its
    // answer is where the cdf reaches 1, which may be short of hi.)
    if (upper ? u <= 0 : u >= 1) && high == .infinity { return .infinity }
    // Start at a closed-form inverse where available, otherwise a normal
    // guess. Bracket and bisect to correct rounding at the CDF's steps.
    func clamp(_ x: Double) -> Double { JS.min([high, JS.max([low, JS.round(x)])]) }
    var k: Double
    if let guess {
      k = clamp(guess(u, upper))
    } else {
      let z = normalQuantile(upper ? 1 - u : u)
      k = clamp(centre + sd * (z.isFinite ? z : 0))
    }
    if !k.isFinite { k = clamp(centre) }  // σ past double range: start from the mean
    if !k.isFinite { return .nan }  // …and the mean too (Geometric(1e-320))
    var below: Double  // a k that is NOT reached (or lo − 1)
    var at: Double  // a k that IS reached
    if reached(k, u, upper) {
      at = k
      below = low - 1
      var step = 1.0
      while at - step > low - 1 {
        if !reached(at - step, u, upper) {
          below = at - step
          break
        }
        at -= step
        step *= 2
      }
    } else {
      below = k
      at = high
      var step = 1.0
      while true {
        let probe = below + step
        if probe >= high { break }  // hi itself is always reached
        if !probe.isFinite { return .nan }
        if reached(probe, u, upper) {
          at = probe
          break
        }
        below = probe
        step *= 2
      }
      if at == .infinity { return .nan }
    }
    while at - below > 1 {
      let mid = below + ((at - below) / 2).rounded(.down)
      if !(mid > below && mid < at) { break }  // past 2^53 the whole numbers are coarser than 1
      if reached(mid, u, upper) { at = mid } else { below = mid }
    }
    return at
  }
  return DiscreteLaw(pmf: pmf, pq: pq, lo: lo, hi: hi, mean: mean, sd: sd, mode: mode, quantile: quantile)
}

/// At most this many stems are drawn; more whole numbers than that in view
/// draw the pmf's envelope instead — the same exact heights at up to
/// STEM_MAX whole numbers on a fixed lattice, joined.
public let STEM_MAX = 1024.0
/// Mass each tail may hide beyond the drawn stems: far below a pixel.
let STEM_TAIL = 1e-12

/// The drawn pmf of a discrete variable over a view (lib/dist.ts `PmfStems`).
public struct PmfStems: Equatable, Sendable {
  /// Where the stems stand, ascending — whole numbers for a base law — and the mass at each.
  public var ks: [Double]
  public var ps: [Double]
  /// True when `ks` is a subsample (see STEM_MAX): draw the outline through
  /// the points, not one stem per point.
  public var envelope: Bool
  /// The spacing the stems stand at, when it is not 1.
  public var step: Double?

  public init(ks: [Double], ps: [Double], envelope: Bool, step: Double? = nil) {
    self.ks = ks
    self.ps = ps
    self.envelope = envelope
    self.step = step
  }

  /// Stems drawn `k` times as tall (`scaleStems`).
  public func scaled(_ k: Double) -> PmfStems {
    if k == 1 { return self }
    var out = self
    out.ps = ps.map { $0 * k }
    return out
  }
}

/// Every whole number of [kLo, kHi] (finite, at most STEM_MAX of them).
func buildStems(_ law: DiscreteLaw, _ kLo: Double, _ kHi: Double) -> PmfStems {
  var ks: [Double] = []
  var k = kLo
  while k <= kHi {
    ks.append(k)
    k += 1
  }
  return PmfStems(ks: ks, ps: ks.map(law.pmf), envelope: false)
}

/// The envelope's samples: the multiples of `stride` from iLo·stride to
/// iHi·stride, kept to the law's mass range [mLo, mHi], plus that range's
/// ends and the mode wherever the lattice spans them (`buildEnvelope`). The
/// lattice is view-independent, so panning slides the window over fixed
/// samples: the outline neither shimmers nor misses the peak.
func buildEnvelope(
  _ law: DiscreteLaw, _ mLo: Double, _ mHi: Double, _ stride: Double, _ iLo: Double, _ iHi: Double
) -> PmfStems {
  let from = iLo * stride
  let to = iHi * stride
  var seen: Set<Double> = []
  var ks: [Double] = []
  // Counted by j, not by i: past 2^53 `i++` stops advancing (Poisson(1e300)).
  let n = JS.min([STEM_MAX + 2, JS.round((to - from) / stride)])
  var j = 0.0
  while j <= n {
    let k = from + j * stride
    if k >= mLo && k <= mHi, seen.insert(k).inserted { ks.append(k) }
    j += 1
  }
  for k in [mLo, mHi, law.mode] where k >= from && k <= to && k >= mLo && k <= mHi {
    if seen.insert(k).inserted { ks.append(k) }
  }
  ks.sort()
  return PmfStems(ks: ks, ps: ks.map(law.pmf), envelope: true)
}

/// How a run of stems is drawn (lib/dist.ts `StemGeometry`). Lengths are in
/// points of the target.
public struct StemGeometry: Equatable, Sendable {
  /// Flat [x0, y0, x1, y1, …] in plot coordinates. Stems: one segment each,
  /// NaN, NaN lifting the pen between them. An envelope: the closed outline,
  /// down to the axis at both ends.
  public var lines: [Double]
  /// Stroke width and opacity. A selection (`heavy`) is a wide translucent
  /// band over the variable's own stems, so they show through.
  public var width: Double
  public var alpha: Double
  /// A dot capping each stem; nil once they would merge. `outlined`: ringed
  /// in the background color.
  public var dots: (r: Double, outlined: Bool)?
  /// Fill opacity of an envelope's outline; nil for stems.
  public var fill: Double?

  public static func == (a: StemGeometry, b: StemGeometry) -> Bool {
    a.lines == b.lines && a.width == b.width && a.alpha == b.alpha && a.dots?.r == b.dots?.r
      && a.dots?.outlined == b.dots?.outlined && a.fill == b.fill
  }
}

/// The dot capping each stem, from the spacing of whole numbers on screen:
/// full size while stems stand apart, small as they crowd, none once the
/// dots would merge into a band (`stemDotRadius`).
public func stemDotRadius(_ pxPerUnit: Double) -> Double { pxPerUnit >= 9 ? 3.5 : pxPerUnit >= 4 ? 2 : 0 }

public func stemGeometry(_ run: PmfStems, heavy: Bool, pxPerUnit: Double) -> StemGeometry {
  var lines: [Double] = []
  if run.envelope {
    if let first = run.ks.first { lines += [first, 0] }
    for (k, p) in zip(run.ks, run.ps) { lines += [k, p] }
    if let last = run.ks.last { lines += [last, 0] }
    return StemGeometry(lines: lines, width: 1.5, alpha: 1, dots: nil, fill: heavy ? 0.35 : 0.16)
  }
  for (k, p) in zip(run.ks, run.ps) { lines += [k, 0, k, p, .nan, .nan] }
  let pxPerStem = pxPerUnit * (run.step ?? 1)
  let r = stemDotRadius(pxPerStem)
  return StemGeometry(
    lines: lines, width: heavy ? JS.min([9, JS.max([3, pxPerStem * 0.6])]) : r != 0 ? 2 : 1,
    alpha: heavy ? 0.45 : 1, dots: r != 0 ? (heavy ? r + 3 : r, !heavy && r >= 3) : nil, fill: nil)
}

/// The part of drawn stems a P(…) row selects, as runs (two for a
/// complement). In envelope mode each run gains its exact end points, so the
/// shaded outline stops at the bound and not at the nearest sample
/// (`selectStems`).
func selectStems(_ stems: PmfStems, _ law: DiscreteLaw, _ sel: (kLo: Double, kHi: Double, not: Bool)) -> [PmfStems] {
  if sel.kLo.isNaN || sel.kHi.isNaN { return [] }
  let ranges: [(Double, Double)] =
    sel.not
    ? sel.kLo > sel.kHi
      ? [(-.infinity, .infinity)] : [(-.infinity, sel.kLo - 1), (sel.kHi + 1, .infinity)]
    : [(sel.kLo, sel.kHi)]
  // (No stems at all: every comparison below is with NaN, and nothing is selected.)
  let first = stems.ks.first ?? .nan
  let last = stems.ks.last ?? .nan
  var out: [PmfStems] = []
  for (a, b) in ranges {
    let lo = JS.max([a, first])
    let hi = JS.min([b, last])
    if !(lo <= hi) { continue }
    var ks: [Double] = []
    var ps: [Double] = []
    func push(_ k: Double, _ p: Double) {
      if k != ks.last {
        ks.append(k)
        ps.append(p)
      }
    }
    if stems.envelope { push(lo, law.pmf(lo)) }
    for (k, p) in zip(stems.ks, stems.ps) where k >= lo && k <= hi { push(k, p) }
    if stems.envelope { push(hi, law.pmf(hi)) }
    if !ks.isEmpty { out.append(PmfStems(ks: ks, ps: ps, envelope: stems.envelope)) }
  }
  return out
}
