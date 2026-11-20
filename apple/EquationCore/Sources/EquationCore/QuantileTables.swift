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

/// The quantile function and the pdf of a continuous base law at fixed
/// parameter values (lib/dist-sample.ts `quantileClosure`, `zooQuantile`,
/// `pdfClosure`): what the quadrature tier integrates against and every
/// sample is the transform of.
///
/// Quantiles of the laws with no closed-form inverse: every sample is a
/// quantile transform, so a base column costs SAMPLE_COUNT quantile calls.
/// Inverting an incomplete gamma or beta function that often is out of the
/// question; instead each (kind, shape) gets a table: the quantile solved
/// exactly (safeguarded Newton on whichever tail is the small one) at nodes
/// uniform in logit(u), then cubic Hermite between them with the exact slope
/// dy/ds = u(1 − u)/density. Both axes are warped so the function is nearly
/// linear where it is hard — logit(u) against ln x for a positive law, logit
/// x on [0, 1], asinh x on the line.

typealias Quantile = @Sendable (Double) -> Double

/// A law in its warped coordinate y: both tails and the density dP/dy (`WarpedLaw`).
private struct WarpedLaw {
  var pq: (Double) -> (Double, Double)
  var dens: (Double) -> Double
  var unwarp: @Sendable (Double) -> Double
}

private let QT_L = 15.0  // table spans logit(u) ∈ [−15, 15]: u from 3e-7, inside every grid here
private let QT_N = 600  // cells; Hermite error ~ h⁴ with h = 0.05
private let QT_YMAX = 700.0  // e^700 and sinh(700) are finite doubles

/// Solve P(y) = u for y, given u and 1 − u (both exact), from a starting
/// guess and a bracket. Newton, bisecting whenever a step leaves the bracket
/// (`solveWarped`).
private func solveWarped(
  _ pq: (Double) -> (Double, Double), _ dens: (Double) -> Double, _ u: Double, _ uc: Double, _ guess: Double,
  _ ylo: Double
) -> Double {
  var lo = ylo
  var hi = QT_YMAX
  var y = JS.min([hi, JS.max([lo, guess])])
  for _ in 0..<200 {
    let (p, q) = pq(y)
    let r = u <= 0.5 ? p - u : uc - q  // increasing in y, zero at the root
    if r.isNaN { return .nan }
    if r == 0 { return y }
    if r > 0 { hi = y } else { lo = y }
    var next = y - r / dens(y)
    // A step this small has arrived — checked before the bracket test, which
    // a converged step landing on the bracket edge would otherwise fail.
    if abs(next - y) <= 1e-13 * (1 + abs(y)) { return next }
    if !(next > lo && next < hi) { next = (lo + hi) / 2 }
    if hi - lo <= 1e-13 * (1 + abs(y)) { return next }
    y = next
  }
  return y
}

private func buildQuantile(_ law: WarpedLaw) -> Quantile? {
  var ys = [Double](repeating: 0, count: QT_N + 1)
  var ms = [Double](repeating: 0, count: QT_N + 1)  // dy/ds at the nodes
  let h = (2 * QT_L) / Double(QT_N)
  for k in 0...QT_N {
    let sk = -QT_L + Double(k) * h
    let u = 1 / (1 + exp(-sk))
    let uc = 1 / (1 + exp(sk))
    let prev = k > 0 ? ys[k - 1] : -QT_YMAX
    let y = solveWarped(law.pq, law.dens, u, uc, k > 0 ? prev + ms[k - 1] * h : 0, prev)
    if y.isNaN { return nil }
    ys[k] = y
    let m = (u * uc) / law.dens(y)
    // Pinned at the representable edge (a Gamma(0.01) quantile below e^−700)
    // or a density that underflowed: flat/secant, not a wild exact slope.
    ms[k] = abs(y) >= QT_YMAX - 1e-9 || !m.isFinite ? (k > 0 ? (y - prev) / h : 0) : m
  }
  let (nodes, slopes, unwarp) = (ys, ms, law.unwarp)
  let pq = SendableBox(law.pq)
  let dens = SendableBox(law.dens)
  return { u in
    if !(u > 0 && u < 1) { return .nan }
    let sv = log(u / (1 - u))
    if !(abs(sv) < QT_L) { return unwarp(solveWarped(pq.value, dens.value, u, 1 - u, 0, -QT_YMAX)) }
    let f = (sv + QT_L) / h
    let k = min(QT_N - 1, Int(f.rounded(.down)))
    let t = f - Double(k)
    let t2 = t * t
    let t3 = t2 * t
    return unwarp(
      (2 * t3 - 3 * t2 + 1) * nodes[k] + (t3 - 2 * t2 + t) * h * slopes[k] + (-2 * t3 + 3 * t2) * nodes[k + 1]
        + (t3 - t2) * h * slopes[k + 1])
  }
}

/// A law's own functions, which read nothing but the numbers they were made
/// from: safe to call from any thread.
private struct SendableBox<T>: @unchecked Sendable {
  var value: T
  init(_ value: T) { self.value = value }
}

/// Standard-scale tables by shape: Gamma's rate (and ChiSquared's fixed one)
/// scales the result, so dragging a rate slider never rebuilds. Small and
/// bounded — a shape slider leaves a trail of one table per value; the least
/// recently used goes first (`quantileTables`).
private let quantileTables = Mutex<(order: [String], byKey: [String: Quantile?])>(([], [:]))

private func cachedQuantile(_ key: String, _ make: () -> WarpedLaw) -> Quantile? {
  let hit: Quantile?? = quantileTables.withLock { tables in
    guard let q = tables.byKey[key] else { return nil }
    tables.order.removeAll { $0 == key }
    tables.order.append(key)
    return q
  }
  if let hit { return hit }
  let q = buildQuantile(make())
  quantileTables.withLock { tables in
    if tables.byKey[key] == nil {
      if tables.order.count >= 64 { tables.byKey[tables.order.removeFirst()] = nil }
      tables.order.append(key)
    }
    tables.byKey[key] = .some(q)
  }
  return q
}

private func gammaQuantile(_ shape: Double) -> Quantile? {
  if shape > GAMMA_UNIFORM_SHAPE {
    // Wilson–Hilferty: relative error O(shape^−2) in the body.
    let c = 1 / (9 * shape)
    return { u in shape * JS.pow(JS.max([0, 1 - c + c.squareRoot() * normalQuantile(u)]), 3) }
  }
  let lg = lgammaFn(shape)
  return cachedQuantile("g\(shape.bitPattern)") {
    WarpedLaw(
      pq: { y in gammaPQ(shape, exp(y)) },
      // pdf(x)·dx/dy with x = e^y: x^α e^−x / Γ(α), finite even at a pole.
      dens: { y in exp(shape * y - exp(y) - lg) },
      unwarp: { exp($0) })
  }
}

/// Beta(a, b) quantiles for a + b > BETA_LIMIT_SUM, by the same two limits as
/// the cdf's: a Gamma law on a modest parameter's side (X/(1 − X) → G_a/b),
/// otherwise the normal with its first skewness correction (`betaLimitQuantile`).
private func betaLimitQuantile(_ al: Double, _ be: Double) -> Quantile? {
  if al < BETA_GAMMA_SIDE || be < BETA_GAMMA_SIDE {
    let small = JS.min([al, be])
    guard let g = gammaQuantile(small) else { return nil }
    let big = JS.max([al, be])
    if al <= be { return { u in g(u) / (big + g(u)) } }
    return { u in big / (big + g(1 - u)) }
  }
  let n = al + be
  let mean = al / n
  let sd = ((al * be) / (n + 1)).squareRoot() / n
  let skew = (2 * (be - al) * (n + 1).squareRoot()) / ((n + 2) * (al * be).squareRoot())
  return { u in
    let z = normalQuantile(u)
    return JS.min([1, JS.max([0, mean + sd * (z + (skew * (z * z - 1)) / 6)])])
  }
}

/// Quantile functions of the kinds quantileClosure has no formula for (`zooQuantile`).
func zooQuantile(_ kind: BaseKind, _ a: [Double]) -> Quantile? {
  if paramProblem(kind, a) != nil { return nil }
  switch kind {
  case .gamma, .chisquared:
    let (shape, rate) = kind == .gamma ? (a[0], a[1]) : (a[0] / 2, 0.5)
    guard let q = gammaQuantile(shape) else { return nil }
    return { u in q(u) / rate }
  case .beta:
    let (al, be) = (a[0], a[1])
    // The table inverts the exact cdf for as long as there is one; past it,
    // the cdf's own limits.
    if al + be > BETA_LIMIT_SUM { return betaLimitQuantile(al, be) }
    let lb = lbeta(al, be)
    // y = logit x, so x and 1 − x are both formed without cancellation.
    return cachedQuantile("b\(al.bitPattern),\(be.bitPattern)") {
      WarpedLaw(
        pq: { y in betaPQ(al, be, 1 / (1 + exp(-y)), 1 / (1 + exp(y))) },
        dens: { y in exp(-al * log1p(exp(-y)) - be * log1p(exp(y)) - lb) },
        unwarp: { 1 / (1 + exp(-$0)) })
    }
  case .studentt:
    let df = a[0]
    if df == 1 { return { u in tan(Double.pi * (u - 0.5)) } }
    return cachedQuantile("t\(df.bitPattern)") {
      WarpedLaw(
        pq: { y in studentTPQ(df, sinh(y)) },
        dens: { y in studentTPdf(sinh(y), df) * cosh(y) },
        unwarp: { sinh($0) })
    }
  case .lognormal:
    return { u in exp(a[0] + a[1] * normalQuantile(u)) }
  case .cauchy:
    return { u in a[0] + a[1] * tan(Double.pi * (u - 0.5)) }
  case .weibull:
    return { u in a[1] * JS.pow(-log1p(-u), 1 / a[0]) }
  default:
    return nil
  }
}

/// The quantile function of a base distribution at these parameter values,
/// or nil while the parameters are invalid (`quantileClosure`).
func quantileClosure(_ d: BaseDist, _ env: [String: Double]) throws -> Quantile? {
  let a = try d.args.map { try evaluate($0, env) }
  if !a.allSatisfy(\.isFinite) { return nil }
  switch d.kind {
  case .normal:
    if !(a[1] > 0) { return nil }
    return { u in a[0] + a[1] * normalQuantile(u) }
  case .uniform:
    if !(a[1] > a[0]) { return nil }
    return { u in a[0] + (a[1] - a[0]) * u }
  case .exponential:
    if !(a[0] > 0) { return nil }
    return { u in -log(1 - u) / a[0] }
  default: return zooQuantile(d.kind, a)
  }
}

/// The pdf and support of a base distribution at fixed parameter values.
/// `mid` is a point in the bulk for the integrator to split at: the (lo, ∞)
/// change of variables alone lands ChiSquared(200)'s whole peak between two
/// Kronrod nodes and integrates 0.
struct PdfClosure {
  var pdf: (Double) -> Double
  var lo: Double
  var hi: Double
  var mid: Double?
}

/// The pdf and support of a base distribution at these parameter values, or
/// nil while the parameters are invalid (`pdfClosure`).
func pdfClosure(_ d: BaseDist, _ env: [String: Double]) throws -> PdfClosure? {
  let a = try d.args.map { try evaluate($0, env) }
  if !a.allSatisfy(\.isFinite) { return nil }
  let inf = Double.infinity
  switch d.kind {
  case .normal: return a[1] > 0 ? PdfClosure(pdf: { normalpdf($0, a[0], a[1]) }, lo: -inf, hi: inf) : nil
  case .uniform: return a[1] > a[0] ? PdfClosure(pdf: { _ in 1 / (a[1] - a[0]) }, lo: a[0], hi: a[1]) : nil
  case .exponential: return a[0] > 0 ? PdfClosure(pdf: { a[0] * exp(-a[0] * $0) }, lo: 0, hi: inf) : nil
  default: break
  }
  if paramProblem(d.kind, a) != nil { return nil }
  switch d.kind {
  case .gamma: return PdfClosure(pdf: { gammaPdf($0, a[0], a[1]) }, lo: 0, hi: inf, mid: a[0] / a[1])
  case .chisquared: return PdfClosure(pdf: { gammaPdf($0, a[0] / 2, 0.5) }, lo: 0, hi: inf, mid: a[0])
  case .beta: return PdfClosure(pdf: { betaPdf($0, a[0], a[1]) }, lo: 0, hi: 1, mid: a[0] / (a[0] + a[1]))
  case .studentt: return PdfClosure(pdf: { studentTPdf($0, a[0]) }, lo: -inf, hi: inf, mid: 0)
  case .lognormal:
    return PdfClosure(pdf: { $0 > 0 ? normalpdf(log($0), a[0], a[1]) / $0 : 0 }, lo: 0, hi: inf, mid: exp(a[0]))
  case .cauchy:
    return PdfClosure(
      pdf: { 1 / (Double.pi * a[1] * (1 + JS.pow(($0 - a[0]) / a[1], 2))) }, lo: -inf, hi: inf, mid: a[0])
  case .weibull: return PdfClosure(pdf: { weibullPdf($0, a[0], a[1]) }, lo: 0, hi: inf, mid: a[1])
  default: return nil  // a discrete law has no pdf to integrate against (its transforms enumerate: pmfOf)
  }
}
