/// Root finding over a real interval for arbitrary scalar expressions
/// (lib/roots.ts).
///
/// Polynomial expressions go through the exact multiset machinery in poly.ts
/// (solid enumeration: every root once, with its true multiplicity). Anything
/// else falls back to dense sampling + safeguarded Newton/bisection: sign
/// changes give odd-multiplicity roots, near-zero local minima of |f| give
/// tangential (even-multiplicity) roots, and poles are rejected by checking
/// the residual. Multiplicity in the numeric path is a log-slope estimate:
/// near a root of multiplicity m, |f(x0+h)| ≈ C·h^m.

// The C library, for the multiplicity estimate's log2 alone.
#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

public struct FoundRoot: Equatable, Sendable {
  public var x: Double
  public var mult: Int
  /// True when the root came from the exact polynomial path.
  public var exact: Bool
  /// Exact symbolic form ("√2", "1/3", "(1+√5)/2") when one exists.
  public var sym: String?
  /// Defining polynomial ("x⁷ - x - 2") when no radical form exists.
  public var rootOf: String?

  public init(x: Double, mult: Int, exact: Bool, sym: String? = nil, rootOf: String? = nil) {
    self.x = x
    self.mult = mult
    self.exact = exact
    self.sym = sym
    self.rootOf = rootOf
  }
}

/// What findRoots returns: the TypeScript's `FoundRoot[] | 'zero'`.
public enum FoundRoots: Equatable, Sendable {
  /// f is identically zero.
  case zero
  case roots([FoundRoot])
}

/// lib/poly.ts `polynomialRoots`: the multiset of real roots of e viewed as a
/// polynomial in v, sorted by x; nil when e is not a polynomial in v. Not
/// ported yet, so findRoots takes it as an argument and, given none, sends
/// polynomials down the numeric path with everything else.
public typealias PolynomialRoots = (Expr, String) -> FoundRoots?

private let SAMPLES = 1536

/// All roots of f(v) in [lo, hi]. `.zero` means f is identically zero.
public func findRoots(
  _ f: Expr, _ v: String, _ lo: Double, _ hi: Double, evaluate: Evaluator, polynomialRoots: PolynomialRoots? = nil
) -> FoundRoots {
  if !(hi > lo) || !lo.isFinite || !hi.isFinite { return .roots([]) }
  switch polynomialRoots?(f, v) {
  case .zero:
    return .zero
  case .roots(let exact):
    return .roots(
      exact.filter { $0.x >= lo && $0.x <= hi }
        .map { FoundRoot(x: $0.x, mult: $0.mult, exact: true, sym: $0.sym, rootOf: $0.rootOf) })
  case nil:
    return numericRoots(f, v, lo, hi, evaluate)
  }
}

private func numericRoots(_ f: Expr, _ v: String, _ lo: Double, _ hi: Double, _ evaluate: Evaluator) -> FoundRoots {
  func ev(_ x: Double) -> Double { (try? evaluate(f, [v: x])) ?? .nan }
  let dfExpr = try? diff(f, v)
  func dev(_ x: Double) -> Double {
    // (A derivative that will not evaluate falls through to finite differences.)
    if let dfExpr, let slope = try? evaluate(dfExpr, [v: x]) { return slope }
    let h = 6e-6 * (1 + abs(x))
    return (ev(x + h) - ev(x - h)) / (2 * h)
  }

  var xs = [Double](repeating: 0, count: SAMPLES + 1)
  var ys = [Double](repeating: 0, count: SAMPLES + 1)
  var maxAbs = 0.0
  var finiteCount = 0
  for i in 0...SAMPLES {
    let x = lo + ((hi - lo) * Double(i)) / Double(SAMPLES)
    let y = ev(x)
    xs[i] = x
    ys[i] = y
    if y.isFinite {
      finiteCount += 1
      maxAbs = max(maxAbs, abs(y))
    }
  }
  if finiteCount == 0 { return .roots([]) }
  if maxAbs == 0 { return .zero }
  let residualTol = 1e-7 * maxAbs

  var out: [FoundRoot] = []
  let minSep = (hi - lo) * 1e-9
  func push(_ x: Double, _ mult: Int) {
    for r in out where abs(r.x - x) <= max(minSep, 1e-13 * (1 + abs(x))) { return }
    out.append(FoundRoot(x: x, mult: mult, exact: false))
  }

  for i in 0..<SAMPLES {
    let y0 = ys[i]
    let y1 = ys[i + 1]
    if !y0.isFinite || !y1.isFinite { continue }
    if y0 == 0 {
      push(xs[i], multiplicityEstimate(ev, xs[i], hi - lo, true))
      continue
    }
    if y0 * y1 < 0 {
      let x = refineBracket(ev, dev, xs[i], xs[i + 1], y0)
      // A pole (tan at π/2) also flips sign; a genuine root has a tiny residual.
      let fx = ev(x)
      if fx.isFinite && abs(fx) <= residualTol {
        push(x, multiplicityEstimate(ev, x, hi - lo, true))
      }
      continue
    }
    // Tangential root candidate: an interior local minimum of |f| that dips
    // near zero without a sign change.
    if i > 0 && ys[i - 1].isFinite && abs(y0) <= abs(ys[i - 1]) && abs(y0) <= abs(y1) && abs(y0) < 1e-3 * maxAbs {
      let x = refineExtremum(ev, dev, xs[i - 1], xs[i + 1])
      let fx = ev(x)
      if fx.isFinite && abs(fx) <= 1e-10 * maxAbs {
        push(x, multiplicityEstimate(ev, x, hi - lo, false))
      }
    }
  }
  if ys[SAMPLES] == 0 { push(xs[SAMPLES], multiplicityEstimate(ev, xs[SAMPLES], hi - lo, true)) }
  return .roots(stableSorted(out) { $0.x < $1.x })
}

/// Math.sign(a) === Math.sign(b): both negative, both zero or both positive.
private func sameSign(_ a: Double, _ b: Double) -> Bool {
  if a.isNaN || b.isNaN { return false }
  return (a > 0) == (b > 0) && (a < 0) == (b < 0)
}

/// Safeguarded Newton within a sign-change bracket.
private func refineBracket(
  _ ev: (Double) -> Double, _ dev: (Double) -> Double, _ a: Double, _ b: Double, _ fa: Double
) -> Double {
  var (a, b, fa) = (a, b, fa)
  var x = (a + b) / 2
  for _ in 0..<80 {
    let fx = ev(x)
    if fx == 0 || !fx.isFinite { break }
    if sameSign(fx, fa) {
      a = x
      fa = fx
    } else {
      b = x
    }
    let d = dev(x)
    var nx = x - fx / d
    if !nx.isFinite || nx <= a || nx >= b { nx = (a + b) / 2 }
    if abs(nx - x) <= 2e-16 * (1 + abs(x)) { return nx }
    x = nx
  }
  return x
}

/// Locate the extremum of f in (a, b) by bisecting the derivative's sign
/// change, falling back to golden-section on |f|.
private func refineExtremum(_ ev: (Double) -> Double, _ dev: (Double) -> Double, _ a: Double, _ b: Double) -> Double {
  var (a, b) = (a, b)
  let da = dev(a)
  let db = dev(b)
  if da.isFinite && db.isFinite && da * db < 0 {
    return refineBracket(
      dev,
      { x in
        let h = 1e-6 * (1 + abs(x))
        return (dev(x + h) - dev(x - h)) / (2 * h)
      },
      a, b, da)
  }
  // Golden-section on |f|.
  let phi = (5.0.squareRoot() - 1) / 2
  var x1 = b - phi * (b - a)
  var x2 = a + phi * (b - a)
  var f1 = abs(ev(x1))
  var f2 = abs(ev(x2))
  var i = 0
  while i < 60 && b - a > 1e-15 * (1 + abs(a)) {
    if f1 <= f2 {
      b = x2
      x2 = x1
      f2 = f1
      x1 = b - phi * (b - a)
      f1 = abs(ev(x1))
    } else {
      a = x1
      x1 = x2
      f1 = f2
      x2 = a + phi * (b - a)
      f2 = abs(ev(x2))
    }
    i += 1
  }
  return (a + b) / 2
}

/// Estimate root multiplicity from the local growth rate of |f|:
/// m ≈ log2(|f(x0+h)| / |f(x0+h/2)|). Crossing roots are forced odd,
/// tangential ones even; unusable data defaults to 1 or 2.
private func multiplicityEstimate(_ ev: (Double) -> Double, _ x0: Double, _ span: Double, _ crossing: Bool) -> Int {
  var ests: [Double] = []
  for dir in [1.0, -1.0] {
    let h = dir * max(span * 1e-4, 1e-7 * (1 + abs(x0)))
    let fa = abs(ev(x0 + h))
    let fb = abs(ev(x0 + h / 2))
    if fa > 0 && fb > 0 && fa.isFinite && fb.isFinite {
      let m = log2(fa / fb)
      if m.isFinite && m > 0.4 && m < 9.5 { ests.append(m) }
    }
  }
  let fallback = crossing ? 1 : 2
  if ests.isEmpty { return fallback }
  // Math.round: halves go up.
  var m = Int((ests.reduce(0, +) / Double(ests.count) + 0.5).rounded(.down))
  if crossing && m % 2 == 0 { m += m > 1 ? -1 : 1 }
  if !crossing && m % 2 == 1 { m += 1 }
  return max(crossing ? 1 : 2, min(9, m))
}
