#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Deterministic conditional-CDF curves — the quadrature tier
/// (lib/dist-sample.ts `conditionalBase`, `condDensity`, `condAssemble`).
///
/// Between the exact laws and the Monte Carlo estimate: a derived variable
/// over one or two independent bases gets its CDF by conditioning,
///
///   F(z) = E_X[ P(g(x, Y) ≤ z) ],
///
/// with both expectations taken over quantile-midpoint grids. The inner
/// grid's sorted g-values are order statistics — known quantiles of the
/// conditional law — so each sorted column is a conditional CDF read off by
/// linear interpolation; the outer average is the midpoint rule in
/// probability space. Everything is deterministic: no pairing noise, so the
/// flat plateau of Y/(X+1) renders flat, and the density (the differentiated
/// CDF) keeps kinks within a couple of grid cells instead of a kernel
/// bandwidth. Three or more variables fall through to the sampled tier: the
/// tensor grid would not scale.

private let QC_OUTER = 512  // conditioning-variable quantile nodes (two-var case)
private let QC_INNER = 512  // inner-variable grid per node
private let QC_SINGLE = 8192  // inner grid for one-variable transforms
private let QC_BINS = 512  // density grid resolution (matches estimateCurve)
let QC_ZOOM_MAX = 32.0  // deepest densification of a zoomed rasterization
/// Share of a conditional column one value must hold before it counts as a
/// point mass rather than the repeats a many-to-one g makes (see the run
/// scan in conditionalBase).
private let ATOM_RUN_FRAC = 0.01
/// Joint draws behind a two-variable tail estimate (`TAIL_POOL_SIZE`).
private let TAIL_POOL_SIZE = 1 << 14

/// The full drawn window of a quadrature curve's continuous part.
struct CurveWindow: Equatable, Sendable {
  var lo: Double
  var hi: Double
  var hardLo: Bool
  var hardHi: Bool
}

/// The reusable half of the quadrature tier: the sorted tensor columns and
/// everything derived from them once — atoms, moments, the drawn window.
/// Rasterizing a density over any z-range from this is cheap (condDensity),
/// which is what lets a zoomed-in viewport recompute the visible stretch of
/// the curve at full grid resolution instead of magnifying polyline cells
/// (`QCBase`).
struct QCBase: Sendable {
  var sorted: [[Double]]
  var M: Int
  var NX: Int
  var atoms: [DensityAtom]?
  var atomValues: Set<Double>
  var mean: Double
  var sd: Double
  var mass: Double
  var robust: Robust?
  /// Nil when purely discrete.
  var window: CurveWindow?
}

func conditionalBase(
  _ g: Expr, _ vars: [(name: String, quantile: Quantile)], _ env: [String: Double], _ heavy: HeavyBase = 0
) throws -> QCBase? {
  let outer = vars.count == 2 ? vars[0] : nil
  let inner = vars[vars.count - 1]
  let NX = outer != nil ? QC_OUTER : 1
  let M = outer != nil ? QC_INNER : QC_SINGLE
  let cells = Double(NX * M)
  let innerCol = (0..<M).map { inner.quantile((Double($0) + 0.5) / Double(M)) }
  let cols = [inner.name: innerCol]

  // g over the whole grid, one sorted column per conditioning node. (The
  // sort is numeric; non-finite values land at the ends.)
  var sorted: [[Double]] = []
  sorted.reserveCapacity(NX)
  var finCount = 0
  var sum = 0.0
  var sumsq = 0.0
  for i in 0..<NX {
    var e = env
    if let outer { e[outer.name] = outer.quantile((Double(i) + 0.5) / Double(NX)) }
    let col = sortedNumeric(try evalCols(g, cols, e, M))
    for v in col where v.isFinite {
      finCount += 1
      sum += v
      sumsq += v * v
    }
    sorted.append(col)
  }
  if finCount < 16 { return nil }  // (almost) nowhere defined
  let mean = sum / Double(finCount)
  let sd = JS.max([sumsq / Double(finCount) - mean * mean, 0]).squareRoot()
  let mass = Double(finCount) / cells
  // The robust readout judges the whole law, so its pool keeps the atoms the
  // continuous pool below drops (see robustIfUnstable).
  var allPool: [Double] = []
  let allStride = max(1, finCount / 8192)
  var allSeen = 0
  for col in sorted {
    for v in col where v.isFinite {
      if allSeen % allStride == allStride >> 1 { allPool.append(v) }
      allSeen += 1
    }
  }
  allPool.sort()
  // The two-variable tensor grid resolves a pole-driven tail (X/Y) only down
  // to its innermost node and flattens the outer 2% a tail index is measured
  // on, so that tier reads its tails off a modest joint draw instead: the
  // head of each variable's own stream (a uniform random subsample, the two
  // independently shuffled), through the same quantile functions.
  let tailPool: (() -> [Double])? = outer.map { outer in
    {
      func draw(_ v: (name: String, quantile: Quantile)) -> [Double] {
        uniformStream(v.name)[0..<TAIL_POOL_SIZE].map(v.quantile)
      }
      // (g ran over the whole grid above: it does not fail here.)
      let joint = (try? evalCols(g, [outer.name: draw(outer), inner.name: draw(inner)], env, TAIL_POOL_SIZE)) ?? []
      return sortedNumeric(joint.filter(\.isFinite))
    }
  }
  let robust = robustIfUnstable(allPool, sd, heavy, tailPool: tailPool)

  // Repeated values are point masses (piecewise branches, floor, constants):
  // pooled across columns, heavy values become stems, and the continuous CDF
  // below must not carry their jumps.
  //
  // What makes a run an atom is that it does not thin out as the grid
  // refines. A continuous many-to-one g repeats values too — the ±y pair of
  // Y², the branches of any even function — but only ever as many times as
  // it has branches, so its run is O(1) in M while an atom's run is a
  // fraction of M.
  var runMass: [Double: Double] = [:]
  var runOrder: [Double] = []
  for col in sorted {
    var j = 0
    while j < M {
      let v = col[j]
      var k = j + 1
      while k < M && col[k] == v { k += 1 }
      if Double(k - j) / Double(M) >= ATOM_RUN_FRAC && v.isFinite {
        if runMass[v] == nil { runOrder.append(v) }
        runMass[v, default: 0] += Double(k - j) / cells
      }
      j = k
    }
  }
  var atoms: [DensityAtom]?
  var atomValues: Set<Double> = []
  for x in runOrder {
    let p = runMass[x]!
    if p >= 0.002 {
      atomValues.insert(x)
      atoms = (atoms ?? []) + [DensityAtom(x: x, p: p)]
    }
  }
  atoms?.sort { $0.x < $1.x }

  // Drawn range from the continuous part: pooled decimated quantiles, and
  // the same hard-edge rule as the sampler — an end the tail-trim cannot
  // reach is the support edge itself and must cut off straight.
  var contCount = 0
  var cmin = Double.infinity
  var cmax = -Double.infinity
  for col in sorted {
    for v in col where v.isFinite && !atomValues.contains(v) {
      contCount += 1
      if v < cmin { cmin = v }
      if v > cmax { cmax = v }
    }
  }
  var base = QCBase(
    sorted: sorted, M: M, NX: NX, atoms: atoms, atomValues: atomValues, mean: mean, sd: sd, mass: mass,
    robust: robust, window: nil)
  if contCount < 16 || !(cmax > cmin) { return base }
  let stride = max(1, contCount / 8192)
  var pool: [Double] = []
  var seen = 0
  for col in sorted {
    for v in col where v.isFinite && !atomValues.contains(v) {
      if seen % stride == 0 { pool.append(v) }
      seen += 1
    }
  }
  pool.sort()
  let q = quantileOf(pool)
  let (wlo, whi) = visualWindow(pool, cmin, cmax)
  let qlo = JS.max([q(0.005), wlo])
  let qhi = JS.min([q(0.995), whi])
  let span = qhi - qlo
  if !(span > 0) { return base }
  let hardLo = qlo - cmin <= 0.25 * span
  let hardHi = cmax - qhi <= 0.25 * span
  base.window = CurveWindow(lo: hardLo ? cmin : qlo, hi: hardHi ? cmax : qhi, hardLo: hardLo, hardHi: hardHi)
  return base
}

/// Rasterize the density over [lo, hi]: accumulate F on the grid — each
/// column contributes its interpolated conditional CDF with equal weight
/// (quantile midpoints carry equal probability); order statistics sit at
/// run-midpoint quantiles, and half-gap extensions carry F to 0 and to the
/// column's full continuous mass, exact for a locally linear g so a
/// uniform's support edge lands exactly — then differentiate. Returns the
/// bare polyline, no edge drops (`condDensity`).
func condDensity(_ base: QCBase, _ lo: Double, _ hi: Double) -> [Double] {
  let (M, NX, atomValues) = (base.M, base.NX, base.atomValues)
  let B = QC_BINS
  let dz = (hi - lo) / Double(B)
  var F = [Double](repeating: 0, count: B + 1)
  let w = 1 / Double(NX)
  var bx: [Double] = []
  var bF: [Double] = []
  for col in base.sorted {
    // (The column's breakpoints, with a slot at each end for the extensions.)
    bx.removeAll(keepingCapacity: true)
    bF.removeAll(keepingCapacity: true)
    bx.append(0)
    bF.append(0)
    var cum = 0
    var j = 0
    while j < M {
      let v = col[j]
      var k = j + 1
      while k < M && col[k] == v { k += 1 }
      if v.isFinite && !atomValues.contains(v) {
        bx.append(v)
        bF.append((Double(cum) + Double(k - j) / 2) / Double(M))
        cum += k - j
      }
      j = k
    }
    if cum == 0 { continue }
    let count = bx.count - 1  // the values, at 1...count
    let top = Double(cum) / Double(M)
    let zeroX: Double
    let topX: Double
    if count > 1 {
      let s0 = (bF[2] - bF[1]) / (bx[2] - bx[1])
      let s1 = (bF[count] - bF[count - 1]) / (bx[count] - bx[count - 1])
      zeroX = bx[1] - bF[1] / s0
      topX = bx[count] + (top - bF[count]) / s1
    } else {
      zeroX = bx[1] - dz / 2  // a lone value: a step smeared over one cell
      topX = bx[1] + dz / 2
    }
    bx[0] = zeroX
    bx.append(topX)
    bF.append(top)
    var p = 0
    for k in 0...B {
      let z = lo + Double(k) * dz
      if z <= zeroX { continue }
      if z >= topX {
        F[k] += w * top
        continue
      }
      while bx[p + 1] < z { p += 1 }
      F[k] += w * (bF[p] + ((z - bx[p]) / (bx[p + 1] - bx[p])) * (bF[p + 1] - bF[p]))
    }
  }

  // The density is the differentiated CDF. A narrow Gaussian pass then
  // absorbs the outer midpoint rule's ripple (worst where the conditional
  // CDF has a moving square-root edge, e.g. X²+Y²). The ripple lives at the
  // full window's cell scale, so a zoomed-in rasterization widens the
  // radius to keep covering it — kinks round over about one full-window
  // cell either way, consistent at every zoom. One-variable transforms have
  // no outer grid and keep the minimal ±2 cells.
  var raw = [Double](repeating: 0, count: B + 1)
  for k in 0...B {
    let a = k == 0 ? F[0] : F[k - 1]
    let b = k == B ? F[B] : F[k + 1]
    raw[k] = JS.max([0, (b - a) / (k == 0 || k == B ? dz : 2 * dz)])
  }
  let win = base.window!
  let cells = JS.max([2, JS.min([64, JS.round((win.hi - win.lo) / Double(B) / dz / 2)])])
  let r = NX == 1 || !cells.isFinite ? 2 : Int(cells)
  var kern = [Double](repeating: 0, count: 2 * r + 1)
  for k in -r...r { kern[k + r] = exp(Double(-2 * k * k) / Double(r * r)) }
  var pts: [Double] = []
  pts.reserveCapacity(2 * B + 2)
  for k in 0...B {
    var s = 0.0
    var ws = 0.0
    for d in -r...r {
      let j = k + d
      if j < 0 || j > B { continue }  // clipped at ends, renormalized here
      s += kern[d + r] * raw[j]
      ws += kern[d + r]
    }
    pts += [lo + Double(k) * dz, s / ws]
  }
  // The curve's area is the range's continuous probability — the promise a
  // density plot makes. Differencing and smoothing each perturb it a
  // little, so restore it exactly.
  var area = 0.0
  var i = 0
  while i + 3 < pts.count {
    area += ((pts[i + 1] + pts[i + 3]) / 2) * (pts[i + 2] - pts[i])
    i += 2
  }
  let target = F[B] - F[0]
  if area > 0 && target > 0 {
    let scale = target / area
    var j = 1
    while j < pts.count {
      pts[j] *= scale
      j += 2
    }
  }
  return pts
}

/// The full-window curve for a base: the density polyline between hard-edge
/// drops, or a bare atoms-only curve when nothing continuous is drawable
/// (`condAssemble`).
func condAssemble(_ base: QCBase) -> DensityCurve {
  var curve = DensityCurve(
    pts: [], mean: base.mean, sd: base.sd, mass: base.mass, atoms: base.atoms, robust: base.robust)
  guard let win = base.window else { return curve }
  if win.hardLo { curve.pts += [win.lo, 0] }  // the jump itself: a vertical at the edge
  curve.pts += condDensity(base, win.lo, win.hi)
  if win.hardHi { curve.pts += [win.hi, 0] }
  return curve
}
