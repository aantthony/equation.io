#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// The sampled tier of discrete variables (lib/dist-discrete.ts): past the
/// enumeration's cap a derived discrete variable is the frequencies of the
/// joint sample — still a pmf, never a KDE — and what its moments may claim
/// is read off its bases' tails.

/// Distinct sampled values above which frequencies stop meaning anything.
private let SAMPLED_ATOMS_MAX = Int(STEM_MAX)
/// A sampled value this frequent is an atom in its own right, kept out of the
/// histogram's bins (the 0 of Poisson(1e6)·Bernoulli).
private let HEAVY_ATOM = 0.01
private let HIST_BINS = 256.0
/// Whole numbers a discrete base's quantiles are tabulated over by walking its cdf.
private let QUANTILE_WALK_MAX = Double(1 << 20)

/// `e` over columns, as canonical values: a finished column — an event's
/// term, a sampled variable (`canonicalColumn`).
func canonicalColumn(_ e: Expr, _ cols: [String: [Double]], _ env: [String: Double], _ count: Int) throws -> [Double] {
  if case .var = e { return try evalCols(e, cols, env, count) }
  let (vals, mags) = try columnOf(e, cols, env, count)
  return zip(vals, mags).map { canonical($0, $1) }
}

/// What a tail says of a moment's sum: it converges, it diverges, or the test
/// could not tell — which certifies nothing, and is said as such (`Tail`).
enum Tail { case ok, diverges, unknown }

/// The two tail slivers compared (`deep`: tail probability 1e-12..1e-9 or
/// 1e-9..1e-6, `shallow`: the 1000× likelier one inside it). A sum that
/// converges comfortably gains far less from the deeper one; within a factor
/// 2 of equal it is at the boundary, where no finite look decides (`tailOf`).
func tailOf(_ deep: Double, _ shallow: Double) -> Tail {
  if !deep.isFinite || !shallow.isFinite { return .unknown }
  if !(deep > 0) { return .ok }
  if !(shallow > 0) { return .unknown }
  let r = deep / shallow
  return r < 0.5 ? .ok : r > 2 ? .diverges : .unknown
}

/// Divergence along any path settles it (the path has positive probability);
/// short of that, one `unknown` leaves the moment uncertified (`worseTail`).
func worseTail(_ a: Tail, _ b: Tail) -> Tail {
  a == .diverges || b == .diverges ? .diverges : a == .unknown || b == .unknown ? .unknown : .ok
}

/// The upper tail of E[h(X)] for a law too wide to enumerate, by quadrature
/// in ln u over the slivers u ∈ [1e-9, 1e-6] and [1e-6, 1e-3]. An integral
/// that does not settle, or an h that overflows out there, is `unknown` —
/// never "fine" (`quantileTail`).
func quantileTail(_ h: (Double) -> Double, _ upperQuantile: (Double) -> Double) -> Tail {
  func sliver(_ lo: Double, _ hi: Double) -> Double {
    quadrature(
      { s in
        let u = exp(s)
        return h(upperQuantile(u)) * u
      }, log(lo), log(hi))
  }
  return tailOf(sliver(1e-9, 1e-6), sliver(1e-6, 1e-3))
}

/// Whether E[h(X)] diverges, by truncation in probability space, where it is
/// ∫₀¹ h(q(u)) du: the mass the integral gains from the two outer slivers
/// u ∈ [1e-6, 1e-3] and then [1e-9, 1e-6] (and their mirrors at 1), each
/// integrated in ln u so a power-law end is smooth. A convergent integral
/// gains less from each deeper sliver; a divergent one does not — a power
/// tail gains more, and at the logarithmic boundary (tail index exactly 2)
/// the two are equal, hence the 3% tolerance. A sliver that fails to settle
/// is "unknown", never "divergent" (`diverges`).
func diverges(_ h: (Double) -> Double, _ quantile: (Double) -> Double) -> Bool {
  func sliver(_ lo: Double, _ hi: Double) -> Double {
    quadrature(
      { s in
        let u = exp(s)
        let a = h(quantile(u))
        let b = h(quantile(1 - u))
        return ((a.isFinite ? a : 0) + (b.isFinite ? b : 0)) * u
      }, log(lo), log(hi))
  }
  let d1 = sliver(1e-6, 1e-3)
  let d2 = sliver(1e-9, 1e-6)
  return d1.isFinite && d2.isFinite && d1 > 0 && d2 >= 0.97 * d1
}

/// The common step of ascending values, or 0 when they sit on no lattice.
/// Whole numbers are exact, and so is Euclid on their gaps. Anything else
/// (X/2 + 0.1, sqrt of a near-constant) carries rounding: Euclid stops at a
/// remainder under `floor`, the step is refit over the whole range, and then
/// every gap must be a whole multiple of it to 1e-3 — values on no lattice
/// pass Euclid with a meaningless tiny step, and fail that at once
/// (`latticeStep`).
private func latticeStep(_ xs: [Double]) -> Double {
  let n = xs.count
  let whole = xs.allSatisfy(JS.isInteger)
  let range = xs[n - 1] - xs[0]
  let floor = whole ? 0.5 : JS.max([range, abs(xs[0]), abs(xs[n - 1])]) / JS.pow(2, 28)
  var g = 0.0
  for i in 1..<n {
    var a = xs[i] - xs[i - 1]
    var b = g
    while b > floor { (a, b) = (b, a.truncatingRemainder(dividingBy: b)) }
    g = a
    if !(g > floor) { return 0 }
  }
  if whole { return g }
  g = range / JS.round(range / g)
  for i in 1..<n {
    let m = (xs[i] - xs[i - 1]) / g
    if abs(m - JS.round(m)) > 1e-3 { return 0 }
  }
  return g
}

/// The pmf the joint sample shows: the frequency of each distinct value of a
/// (canonical) sample column (`sampledPmf`).
func sampledPmf(_ col: [Double], _ tails: (mean: Tail, second: Tail)) -> DiscretePmf? {
  let finite = col.filter(\.isFinite).sorted()
  if finite.isEmpty { return nil }
  var xs: [Double] = []
  var counts: [Double] = []
  var first = Double.nan
  for v in finite {
    if !xs.isEmpty && sameAtom(first, v) {
      counts[counts.count - 1] += 1
    } else {
      first = v
      xs.append(v)
      counts.append(1)
    }
  }
  let ps = counts.map { $0 / Double(col.count) }
  // Mean and sd of the atoms, averaged where defined (`atomMoments`).
  var sum = 0.0
  var m1 = 0.0
  for (x, p) in zip(xs, ps) {
    sum += p
    m1 += x * p
  }
  let mean = m1 / sum
  var m2 = 0.0
  for (x, p) in zip(xs, ps) { m2 += JS.pow(x - mean, 2) * p }
  let sd = (m2 / sum).squareRoot()
  // A sample's moments are finite whatever the law's are: each is reported
  // only as far as its tail was certified (RVSystem.sampledTails).
  let meanOk = tails.mean == .ok
  var pmf = DiscretePmf(
    xs: xs, ps: ps, mass: Double(finite.count) / Double(col.count), mean: meanOk ? mean : .nan,
    sd: !meanOk ? .nan : tails.second == .ok ? sd : tails.second == .diverges ? .infinity : .nan, meanOk: meanOk,
    meanExact: false, certified: false, exact: false)
  if xs.count <= SAMPLED_ATOMS_MAX { return pmf }
  // Too many distinct values: a histogram on the values' own lattice.
  let light = zip(xs, ps).filter { $0.1 < HEAVY_ATOM }.map(\.0)
  let step = light.count > 1 ? latticeStep(light) : 0
  if step == 0 || step.isNaN {
    pmf.unresolved = true
    return pmf
  }
  var heavy = PmfStems(ks: [], ps: [], envelope: false)
  let origin = light[0]
  let cells = JS.round((light[light.count - 1] - origin) / step) + 1
  let per = JS.pow(2, JS.max([0, log2(cells / HIST_BINS).rounded(.up)]))  // lattice points per bin
  var bins = [Double](repeating: 0, count: Int((cells / per).rounded(.up)))
  for (x, p) in zip(xs, ps) {
    if p >= HEAVY_ATOM {
      heavy.ks.append(x)
      heavy.ps.append(p)
    } else {
      let b = (JS.round((x - origin) / step) / per).rounded(.down)
      if b >= 0 && b < Double(bins.count) { bins[Int(b)] += p }
    }
  }
  // Each bin at its centre, as the mass per lattice point — a pmf height, so
  // it sits on the same axis as the exact stems would. An empty stretch is
  // drawn empty: the outline comes down to the axis at its ends.
  var bulk = PmfStems(ks: [], ps: [], envelope: true)
  let width = per * step
  for (b, mass) in bins.enumerated() where mass > 0 {
    let centre = origin + (Double(b) + 0.5) * width - step / 2
    if b == 0 || !(bins[b - 1] > 0) {
      bulk.ks.append(centre - width / 2)
      bulk.ps.append(0)
    }
    bulk.ks.append(centre)
    bulk.ps.append(mass / per)
    if b == bins.count - 1 || !(bins[b + 1] > 0) {
      bulk.ks.append(centre + width / 2)
      bulk.ps.append(0)
    }
  }
  heavy.step = minGap(heavy.ks[...])
  pmf.binned = DiscretePmf.Binned(bulk: bulk, heavy: heavy)
  return pmf
}

/// The exact quantile of a discrete law at every stratum of the sampling
/// streams, ascending: out[j] = quantile((j + ½)/N). A column is this, read
/// in the stream's shuffled order. Within QUANTILE_WALK_MAX whole numbers the cdf is
/// walked once (one pmf evaluation per whole number of the sampled range).
/// Past that (Poisson(1e12), sd ≥ 1e5) the quantile is solved exactly at
/// every 64th stratum and interpolated between in the normal score, rounded:
/// every value stays inside its own 64-strata cell, so the marginal is right
/// to 5e-4 in probability, and the whole numbers there are 1e-5 of σ apart —
/// nothing a sample resolves (`sortedQuantiles`).
func sortedQuantiles(_ law: DiscreteLaw) -> [Double] {
  let N = SAMPLE_COUNT
  var out = [Double](repeating: .nan, count: N)
  let kLo = law.quantile(0.5 / Double(N), false)
  let kHi = law.quantile(0.5 / Double(N), true)
  if !kLo.isFinite || !kHi.isFinite { return out }
  if kHi - kLo < QUANTILE_WALK_MAX {
    var k = kLo
    var cum = law.pq(k).0
    for j in 0..<N {
      let u = (Double(j) + 0.5) / Double(N)
      while cum < u && k < kHi {
        k += 1
        cum += law.pmf(k)
      }
      out[j] = k
    }
    return out
  }
  func at(_ j: Int) -> Double {
    let u = (Double(j) + 0.5) / Double(N)
    return u < 0.5 ? law.quantile(u, false) : law.quantile(1 - u, true)
  }
  let STRIDE = 64
  var j0 = 0
  while j0 < N {
    let j1 = min(N - 1, j0 + STRIDE)
    let (k0, k1) = (at(j0), at(j1))
    let z0 = normalQuantile((Double(j0) + 0.5) / Double(N))
    let z1 = normalQuantile((Double(j1) + 0.5) / Double(N))
    for j in j0...j1 {
      let s = (normalQuantile((Double(j) + 0.5) / Double(N)) - z0) / (z1 - z0)
      out[j] = JS.min([k1, JS.max([k0, JS.round(k0 + (k1 - k0) * s)])])
    }
    j0 += STRIDE
  }
  return out
}
