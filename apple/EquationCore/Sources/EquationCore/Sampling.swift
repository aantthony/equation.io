#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif
import Synchronization

/// Continuous sampling (lib/dist-sample.ts): the stratified streams every
/// base variable's sample is the quantile transform of, and the density a
/// sample column is estimated to have.
///
/// Port: the site redraws the pairing between streams once a frame
/// (`RVSystem.resample`), so an estimated curve shimmers with its sampling
/// noise. Here the salt stays 0 — the pairing the site's tests and analysis
/// see — and an estimate stands still.

/// Joint sample count (lib/dist-sample.ts `SAMPLE_COUNT`).
let SAMPLE_COUNT = 1 << 17

/// A point mass of a density (a piecewise branch, a floor, a constant):
/// drawn as a stem of height = probability, never smeared into the curve.
public struct DensityAtom: Equatable, Sendable {
  public var x: Double
  public var p: Double
}

/// Robust location and spread, shown where the tails make mean and sd
/// truncation artifacts. `meanOk`: the spread is unstable but the tails are
/// lighter than 1/x, so the mean exists (lib/dist-sample.ts `Robust`).
public struct Robust: Equatable, Sendable {
  public var median: Double
  public var iqr: Double
  public var meanOk: Bool
}

/// 0 — every base law has a variance; 1 — some base has none but has a mean
/// (StudentT, 1 < df ≤ 2); 2 — some base has no mean (`HeavyBase`).
typealias HeavyBase = Int

private func fnv1a(_ s: String) -> UInt32 {
  var h: UInt32 = 0x811c_9dc5
  for unit in s.utf16 {
    h ^= UInt32(unit)
    h = h &* 0x0100_0193
  }
  return h
}

/// The generator the site shuffles with: the same numbers from the same seed.
private struct Mulberry32 {
  var seed: UInt32

  mutating func next() -> Double {
    seed = seed &+ 0x6d2b_79f5
    var z = seed
    z = (z ^ (z >> 15)) &* (z | 1)
    z ^= z &+ ((z ^ (z >> 7)) &* (z | 61))
    return Double(z ^ (z >> 14)) / 4294967296
  }
}

/// The streams drawn so far, by name. A stream is a megabyte, and an
/// expression row's uniforms are named by the row: only the last few are kept.
private let streams = Mutex<(order: [String], byName: [String: [Double]])>(([], [:]))
private let STREAMS_KEPT = 48

/// The stratified standard-uniform stream for a variable name: quantile
/// midpoints (i + ½)/N shuffled by a permutation seeded from the name
/// (`uniformStream`). Marginals are exact; the shuffle is the pairing
/// between variables — the Monte Carlo part.
func uniformStream(_ name: String) -> [Double] {
  if let hit = streams.withLock({ $0.byName[name] }) { return hit }
  var u = (0..<SAMPLE_COUNT).map { (Double($0) + 0.5) / Double(SAMPLE_COUNT) }
  var rand = Mulberry32(seed: fnv1a(name))
  var i = SAMPLE_COUNT - 1
  while i > 0 {
    let j = Int((rand.next() * Double(i + 1)).rounded(.down))
    u.swapAt(i, j)
    i -= 1
  }
  let made = u
  streams.withLock {
    if $0.byName[name] == nil {
      $0.order.append(name)
      if $0.order.count > STREAMS_KEPT { $0.byName[$0.order.removeFirst()] = nil }
    }
    $0.byName[name] = made
  }
  return u
}

/// Ascending as a typed array sorts: by value, −0 before +0, NaN last.
func sortedNumeric(_ xs: [Double]) -> [Double] {
  xs.sorted { a, b in
    if b.isNaN { return !a.isNaN }
    if a.isNaN { return false }
    if a == b { return a.sign == .minus && b.sign == .plus }
    return a < b
  }
}

/// Quantiles of an already-sorted pool, by nearest rank (`quantileOf`).
func quantileOf(_ sorted: [Double]) -> (Double) -> Double {
  { p in sorted[min(sorted.count - 1, Int((p * Double(sorted.count)).rounded(.down)))] }
}

/// A sorted sample of at most ~4096 values: plenty for quantiles, and cheap
/// enough to take of a full sample column (`decimate`).
private func decimate(_ xs: [Double]) -> [Double] {
  let step = Int((Double(xs.count) / 4096).rounded(.up))
  if step == 0 { return [] }
  return sortedNumeric(stride(from: 0, to: xs.count, by: step).map { xs[$0] })
}

/// Clip a drawn window to where the density is visually present: iterate a
/// coarse-histogram zoom over a value pool, trimming end bins below ~1/256
/// of the peak bin — sub-pixel at plot scale. Without this, heavy tails
/// stretch a fixed-quantile window by orders of magnitude and starve the peak
/// of grid resolution (`visualWindow`).
func visualWindow(_ pool: [Double], _ lo0: Double, _ hi0: Double) -> (Double, Double) {
  var wlo = lo0
  var whi = hi0
  let NB = 256
  var counts = [Double](repeating: 0, count: NB)
  for _ in 0..<4 {
    let bw = (whi - wlo) / Double(NB)
    if !(bw > 0) { break }
    for b in 0..<NB { counts[b] = 0 }
    for v in pool where v >= wlo && v <= whi {
      counts[min(NB - 1, Int(((v - wlo) / bw).rounded(.down)))] += 1
    }
    var peak = 0.0
    for b in 0..<NB { peak = max(peak, counts[b]) }
    let thresh = peak / Double(NB)
    if thresh <= 1 { break }  // no dominant peak: the pool is already balanced
    var a = 0
    while a < NB && counts[a] < thresh { a += 1 }
    var b = NB - 1
    while b >= 0 && counts[b] < thresh { b -= 1 }
    if b < a { break }
    let nlo = wlo + Double(a) * bw
    let nhi = wlo + Double(b + 1) * bw
    // Zoom only on a genuine scale problem — the trim would collapse the
    // window several-fold. A modest proposed trim means the tails carry
    // honest visible mass; keep them and stop, or iteration would compound
    // sub-threshold trims into a real bite of probability.
    if nhi - nlo > 0.25 * (whi - wlo) { break }
    wlo = nlo
    whi = nhi
  }
  return (wlo, whi)
}

/// The tail index a variable built on a no-mean base (Cauchy, StudentT with
/// df ≤ 1) must clear, two standard errors included, before it reports a mean.
private let NO_MEAN_BASE_INDEX = 1.4

/// Below this estimated tail index a law fed by an infinite-variance base is
/// reported by median/IQR. The boundary is 2; the margin covers the Hill
/// estimate's bias.
private let HEAVY_INDEX = 2.25

/// Hill's estimate of the tail index on one side (`side` ±1) of a sorted
/// pool, from the outer 2% (k points) measured off `centre`: the mean
/// log-excess over the threshold is 1/index for a power tail, and ~0 (index →
/// ∞) for a bounded or exponential one (`hillIndex`).
private func hillIndex(_ sortedPool: [Double], _ centre: Double, _ side: Double) -> (index: Double, k: Double) {
  let n = sortedPool.count
  let k = max(16, Int((Double(n) * 0.02).rounded(.down)))
  if n < 4 * k { return (.infinity, Double(k)) }
  func at(_ i: Int) -> Double { side * ((side > 0 ? sortedPool[n - 1 - i] : sortedPool[i]) - centre) }
  let threshold = at(k)
  if !(threshold > 0) { return (.infinity, Double(k)) }
  var sum = 0.0
  for i in 0..<k { sum += log(at(i) / threshold) }
  return (sum > 0 ? Double(k) / sum : .infinity, Double(k))
}

/// Robust location/spread when the moments are truncation artifacts: a 1%
/// trim collapsing the spread severalfold means the tails own the second
/// moment (or it does not exist at all). Nil while moments are sound. The
/// pool must be the whole law, atoms included — the same population `sd`
/// came from — or a distant atom reads as a tail that trimming collapsed
/// (`robustIfUnstable`).
func robustIfUnstable(
  _ sortedPool: [Double], _ sd: Double, _ heavy: HeavyBase = 0, tailPool: (() -> [Double])? = nil
) -> Robust? {
  if sortedPool.isEmpty { return nil }
  let q = quantileOf(sortedPool)
  let tlo = q(0.005)
  let thi = q(0.995)
  var n = 0.0
  var s = 0.0
  var s2 = 0.0
  for v in sortedPool where v >= tlo && v <= thi {
    n += 1
    s += v
    s2 += v * v
  }
  if n == 0 { return nil }
  let m = s / n
  let sdTrim = JS.max([s2 / n - m * m, 0]).squareRoot()
  // A trimmed spread of zero is a law concentrated on one value with rare
  // company (a two-point discrete law, say) — finite moments, nothing to
  // stabilize, and the ratio below would call every one of them unstable.
  if !(sdTrim > 0) { return nil }
  // Whether the mean exists is its own question, asked of the tails and of
  // nothing else: it does exactly when both decay faster than 1/x (tail
  // index above 1).
  let collapsed = sd > 3 * sdTrim
  if !collapsed && heavy == 0 { return nil }
  // The tails are read off `tailPool` where the caller has a better one: the
  // two-variable tensor grid resolves a pole-driven tail (X/Y) only down to
  // its innermost node, and flattens the outer 2% the index is measured on.
  let tails = tailPool?() ?? sortedPool
  let up = hillIndex(tails, q(0.5), 1)
  let down = hillIndex(tails, q(0.5), -1)
  // A mean is reported only when the index clears its bar by two standard
  // errors (Hill's se is index/√k). The bar is 1 — and 1.4 when a base law
  // has no mean at all: there the analytic knowledge leads, and only a
  // transform that visibly tames the tail earns a mean.
  let bar = heavy == 2 ? NO_MEAN_BASE_INDEX : 1
  let robust = Robust(
    median: q(0.5), iqr: q(0.75) - q(0.25),
    meanOk: JS.min([up.index * (1 - 2 / up.k.squareRoot()), down.index * (1 - 2 / down.k.squareRoot())]) > bar)
  if collapsed { return robust }
  // Under a base law known to have no variance the bar is far lower: the
  // question is whether the transform let the tail through (X + 1, X + Z) or
  // tamed it (sin X, ln|X|), and the tail index answers it: a variance
  // exists only above index 2.
  return heavy != 0 && JS.min([up.index, down.index]) < HEAVY_INDEX ? robust : nil
}

/// Estimate a density curve from samples: point masses split off as atoms,
/// the continuous remainder as a binned kernel density estimate (Silverman
/// bandwidth over a robust spread) whose area equals its share of the
/// finite-sample mass. Nil when nothing is finite (`estimateCurve`).
func estimateCurve(_ col: [Double], _ heavy: HeavyBase = 0) -> DensityCurve? {
  var finite: [Double] = []
  finite.reserveCapacity(col.count)
  var sum = 0.0
  for x in col where x.isFinite {
    finite.append(x)
    sum += x
  }
  let n = finite.count
  if n < 16 { return nil }
  let mean = sum / Double(n)
  var ss = 0.0
  for x in finite { ss += (x - mean) * (x - mean) }
  let sd = (ss / Double(n)).squareRoot()
  let mass = Double(n) / Double(col.count)
  // Whether the moments are trustworthy is a question about the whole law, so
  // it is asked of the same population `sd` was computed from — before the
  // atom filter below narrows `finite` to the continuous remainder.
  let robust = robustIfUnstable(decimate(finite), sd, heavy)

  // Atoms: exactly repeated values are point masses — a piecewise branch, a
  // floor, a constant — and smearing them into KDE bumps would read as
  // continuous spread. Stratified streams make continuous values distinct, so
  // a duplicate probe over a prefix keeps that common case on the fast path.
  var atoms: [DensityAtom]?
  let probed = min(n, 4096)
  if Set(finite[0..<probed]).count < probed {
    var counts: [Double: Int] = [:]
    for x in finite { counts[x, default: 0] += 1 }
    let minAtom = max(8, Double(col.count) * 0.002)
    var atomValues: Set<Double> = []
    for (x, count) in counts where Double(count) >= minAtom {
      atomValues.insert(x)
      atoms = (atoms ?? []) + [DensityAtom(x: x, p: Double(count) / Double(col.count))]
    }
    if atoms != nil {
      atoms!.sort { $0.x < $1.x }
      finite = finite.filter { !atomValues.contains($0) }
    }
  }
  func bare() -> DensityCurve {
    DensityCurve(pts: [], mean: mean, sd: sd, mass: mass, atoms: atoms, robust: robust)
  }
  if finite.count < 16 { return bare() }  // purely discrete
  // The continuous part's own count and spread size the estimate below.
  let cn = finite.count
  // Quantiles from a decimated sort: plenty for a range and bandwidth.
  let every = Int((Double(cn) / 4096).rounded(.up))
  let sub = sortedNumeric(stride(from: 0, to: cn, by: every).map { finite[$0] })
  let q = quantileOf(sub)
  let spread = JS.min([sd, (q(0.75) - q(0.25)) / 1.349])
  if !(spread > 0) { return bare() }  // no continuous spread
  // 1.4× Silverman's rule: measured on these stratified columns, it lowers
  // both the sup-error and the curve's residual wobble.
  let h = 1.26 * spread * JS.pow(Double(cn), -0.2)
  // Drawn range: trim the extreme tails, but never past the observed support.
  // An end the trim does not reach is the support edge itself — beyond it the
  // density is truly zero, so a truncated variable like {X > 1: X, 0} has to
  // cut off straight at 1 rather than ramp up to a rounded peak past it.
  var x0 = Double.infinity
  var x1 = -Double.infinity
  for x in finite {
    if x < x0 { x0 = x }
    if x > x1 { x1 = x }
  }
  let (wlo, whi) = visualWindow(sub, x0, x1)
  var lo = JS.max([q(0.005), wlo]) - 3 * h
  var hi = JS.min([q(0.995), whi]) + 3 * h
  let hardLo = lo <= x0
  let hardHi = hi >= x1
  if hardLo { lo = x0 }
  if hardHi { hi = x1 }
  let B = 512
  let dx = (hi - lo) / Double(B)
  if !(dx > 0) || !dx.isFinite { return bare() }
  var hist = [Double](repeating: 0, count: B + 1)
  let w = 1 / (Double(col.count) * dx)
  var counted = 0.0
  for x in finite {
    // Linear binning: split each sample between its two neighboring grid
    // points, so the histogram carries no half-bin jitter into the curve.
    let k = (x - lo) / dx
    let kf = k.rounded(.down)
    if !(kf >= 0 && kf < Double(B)) { continue }
    let k0 = Int(kf)
    let f = k - kf
    hist[k0] += w * (1 - f)
    hist[k0 + 1] += w * f
    counted += 1
  }
  let inWindow = counted / Double(col.count)
  // A grid point holds the density there, but the ones on a support edge
  // collect from one side only — half a cell — so they read half the density.
  if hardLo { hist[0] *= 2 }
  if hardHi { hist[B] *= 2 }
  // Gaussian smoothing of the histogram — the binned KDE.
  let r = Int(JS.min([256, ((3 * h) / dx).rounded(.up)]))
  var kernel = [Double](repeating: 0, count: 2 * r + 1)
  var ksum = 0.0
  for k in -r...r {
    let v = exp(-0.5 * JS.pow((Double(k) * dx) / h, 2))
    kernel[k + r] = v
    ksum += v
  }
  for k in 0...(2 * r) { kernel[k] /= ksum }
  // Boundary correction, needed only where the support ends. Straight
  // truncation would halve the estimate at the edge and renormalizing alone
  // still sags wherever the density is sloped, so fit a local line instead of
  // a local mean: with kernel moments a₀,a₁,a₂ over the part of the window
  // inside the support, f̂ = (a₂S₀ − a₁S₁)/(a₀a₂ − a₁²), which reproduces any
  // linear density exactly. In the interior this is the plain KDE.
  let hard = hardLo || hardHi
  var P0 = [Double](repeating: 0, count: 2 * r + 2)
  var P1 = [Double](repeating: 0, count: 2 * r + 2)
  var P2 = [Double](repeating: 0, count: 2 * r + 2)
  if hard {
    for m in 0...(2 * r) {
      let d = Double(m - r) * dx
      P0[m + 1] = P0[m] + kernel[m]
      P1[m + 1] = P1[m] + kernel[m] * d
      P2[m + 1] = P2[m] + kernel[m] * d * d
    }
  }
  var pts: [Double] = []
  pts.reserveCapacity(2 * B + 6)
  if hardLo { pts += [lo, 0] }  // the jump itself: a vertical at the edge
  for j in 0...B {
    var s0 = 0.0
    var s1 = 0.0
    let k0 = max(0, j - r)
    let k1 = min(B, j + r)
    if k0 <= k1 {
      for k in k0...k1 {
        let wk = hist[k] * kernel[j - k + r]
        s0 += wk
        if hard { s1 += wk * Double(j - k) * dx }
      }
    }
    var y = s0
    if hard {
      // Clip the moment window only at the ends that are real support edges;
      // a merely trimmed tail keeps the full window (its data continues).
      let mlo = hardHi ? max(0, j + r - B) : 0
      let mhi = hardLo ? min(2 * r, j + r) : 2 * r
      let a0 = P0[mhi + 1] - P0[mlo]
      let a1 = P1[mhi + 1] - P1[mlo]
      let a2 = P2[mhi + 1] - P2[mlo]
      let den = a0 * a2 - a1 * a1
      // Local linear can undershoot below zero where samples are sparse;
      // there, fall back to the renormalized mean, which cannot.
      let ll = den > 0 ? (a2 * s0 - a1 * s1) / den : -1
      y = ll > 0 ? ll : a0 > 0.05 ? s0 / a0 : s0
    }
    pts += [lo + Double(j) * dx, y]
  }
  if hardHi { pts += [hi, 0] }
  // The curve's area is the probability of the drawn range — the promise a
  // density plot makes. Smoothing and the edge corrections each perturb it a
  // little, so restore it exactly.
  var area = 0.0
  var i = 0
  while i + 3 < pts.count {
    area += ((pts[i + 1] + pts[i + 3]) / 2) * (pts[i + 2] - pts[i])
    i += 2
  }
  if area > 0 {
    let k = inWindow / area
    var j = 1
    while j < pts.count {
      pts[j] *= k
      j += 2
    }
  }
  return DensityCurve(pts: pts, mean: mean, sd: sd, mass: mass, atoms: atoms, robust: robust)
}
