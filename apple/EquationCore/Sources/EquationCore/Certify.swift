#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Outward-rounded interval arithmetic and a bounded Krawczyk certificate
/// (lib/certify.ts). Proofs cover the supplied closed box, for real arithmetic
/// on the expression's binary64 literals/parameters. Unsupported functions
/// remain unresolved. No numeric solver result is promoted to a certificate
/// by residual size.

public struct Interval: Equatable, Sendable {
  public var lo: Double
  public var hi: Double

  public init(_ lo: Double, _ hi: Double) {
    self.lo = lo
    self.hi = hi
  }
}

private let WHOLE = Interval(-.infinity, .infinity)
private let ZERO = Interval(0, 0)
private let ONE = Interval(1, 1)

/// The neighbouring float (`nextFloat`): the site steps the bits by hand,
/// which is what nextUp and nextDown are.
func nextFloat(_ x: Double, _ up: Bool) -> Double { up ? x.nextUp : x.nextDown }

/// `Math.min` and `Math.max` of two: NaN if either is, and -0 under +0.
@inline(__always) func jsMin(_ a: Double, _ b: Double) -> Double {
  if a.isNaN || b.isNaN { return .nan }
  if a == 0 && b == 0 { return a.sign == .minus ? a : b }
  return a < b ? a : b
}
@inline(__always) func jsMax(_ a: Double, _ b: Double) -> Double {
  if a.isNaN || b.isNaN { return .nan }
  if a == 0 && b == 0 { return a.sign == .minus ? b : a }
  return a > b ? a : b
}

private func point(_ v: Double) -> Interval { v.isFinite ? Interval(v, v) : WHOLE }
private func outward(_ lo: Double, _ hi: Double) -> Interval {
  lo.isNaN || hi.isNaN ? WHOLE : Interval(nextFloat(lo, false), nextFloat(hi, true))
}
/// Adding exactly 0 is exact: no widening (x^2 − 0 < 0 stays provably false).
func iadd(_ a: Interval, _ b: Interval) -> Interval {
  b.lo == 0 && b.hi == 0 ? a : a.lo == 0 && a.hi == 0 ? b : outward(a.lo + b.lo, a.hi + b.hi)
}
func ineg(_ a: Interval) -> Interval { Interval(-a.hi, -a.lo) }
func isub(_ a: Interval, _ b: Interval) -> Interval { iadd(a, ineg(b)) }
/// An endpoint product, with 0·∞ = 0: an interval holds reals, so an
/// infinite end is a limit, and 0 times any real is 0.
@inline(__always) private func endMul(_ p: Double, _ q: Double) -> Double { p == 0 || q == 0 ? 0 : p * q }
func imul(_ a: Interval, _ b: Interval) -> Interval {
  if (a.lo == 0 && a.hi == 0) || (b.lo == 0 && b.hi == 0) { return ZERO }
  let p = endMul(a.lo, b.lo)
  let q = endMul(a.lo, b.hi)
  let r = endMul(a.hi, b.lo)
  let t = endMul(a.hi, b.hi)
  return outward(jsMin(jsMin(p, q), jsMin(r, t)), jsMax(jsMax(p, q), jsMax(r, t)))
}
private func idiv(_ a: Interval, _ b: Interval) -> Interval {
  b.lo <= 0 && b.hi >= 0 ? WHOLE : imul(a, outward(1 / b.hi, 1 / b.lo))
}
private func excludesZero(_ v: Interval) -> Bool { v.lo > 0 || v.hi < 0 }

private struct AD {
  var valid: Bool
  var value: Interval
  var jac: [Interval]
}

/// Interval automatic differentiation keeps rounding in the derivative proof
/// too; a symbolic simplifier's rounded coefficients cannot weaken enclosure.
private func intervalAD(_ e: Expr, _ names: [String], _ box: [Interval], _ env: [String: Double]) -> AD {
  func scalar(_ value: Interval) -> AD { AD(valid: true, value: value, jac: names.map { _ in ZERO }) }
  func bad() -> AD { AD(valid: false, value: WHOLE, jac: names.map { _ in WHOLE }) }
  func multiply(_ a: AD, _ b: AD) -> AD {
    if !a.valid || !b.valid { return bad() }
    return AD(
      valid: true, value: imul(a.value, b.value),
      jac: a.jac.indices.map { k in iadd(imul(a.jac[k], b.value), imul(a.value, b.jac[k])) })
  }
  func rec(_ e: Expr) -> AD { intervalAD(e, names, box, env) }
  switch e {
  case .num(let value):
    return value.isFinite ? scalar(point(value)) : bad()
  case .var(let name):
    guard let k = names.firstIndex(of: name) else {
      if let v = env[name], v.isFinite { return scalar(point(v)) }
      return bad()
    }
    var a = scalar(box[k])
    a.jac[k] = ONE
    return a
  case .neg(let inner):
    let a = rec(inner)
    return AD(valid: a.valid, value: ineg(a.value), jac: a.jac.map(ineg))
  case .eq(let l, let r):
    let a = rec(l)
    let b = rec(r)
    return AD(
      valid: a.valid && b.valid, value: isub(a.value, b.value),
      jac: a.jac.indices.map { isub(a.jac[$0], b.jac[$0]) })
  case .bin(let op, let lhs, let rhs, _):
    let a = rec(lhs)
    if !a.valid { return bad() }
    if op == .pow {
      guard case .num(let n) = rhs, JS.isInteger(n), abs(n) <= 32 else { return bad() }
      var p = scalar(ONE)
      for _ in 0..<Int(abs(n)) { p = multiply(p, a) }
      if n >= 0 { return p }
      if !excludesZero(p.value) { return bad() }
      return AD(
        valid: true, value: idiv(ONE, p.value),
        jac: p.jac.map { ineg(idiv($0, imul(p.value, p.value))) })
    }
    let b = rec(rhs)
    if !b.valid { return bad() }
    if op == .mul { return multiply(a, b) }
    if op == .add || op == .sub {
      let f = op == .add ? iadd : isub
      return AD(valid: true, value: f(a.value, b.value), jac: a.jac.indices.map { f(a.jac[$0], b.jac[$0]) })
    }
    if !excludesZero(b.value) { return bad() }
    return AD(
      valid: true, value: idiv(a.value, b.value),
      jac: a.jac.indices.map { k in
        idiv(isub(imul(a.jac[k], b.value), imul(a.value, b.jac[k])), imul(b.value, b.value))
      })
  default:
    return bad()
  }
}

/// x^n for a whole n ≥ 0: even powers of an interval that holds 0 start at 0,
/// which repeated multiplication (x·x over [-1, 1] is [-1, 1]) loses.
private func ipow(_ a: Interval, _ n: Int) -> Interval {
  if n == 0 { return ONE }
  var p = a
  if n > 1 { for _ in 1..<n { p = imul(p, a) } }
  if n % 2 == 0 && a.lo < 0 && a.hi > 0 { return Interval(0, p.hi) }
  if n % 2 == 0 && a.hi <= 0 { return Interval(p.lo < 0 ? 0 : p.lo, p.hi) }
  return p
}

/// f over [a, b] for an increasing f, rounded outward.
@inline(__always) private func rising(_ f: (Double) -> Double, _ a: Interval) -> Interval {
  outward(f(a.lo), f(a.hi))
}

/// sin over [a, b]: the ends, and ±1 wherever a peak or trough falls inside.
private func isin(_ a: Interval, _ shift: Double = 0) -> Interval {
  let lo = a.lo + shift
  let hi = a.hi + shift
  if !(hi - lo < 2 * Double.pi) { return Interval(-1, 1) }
  var least = jsMin(sin(lo), sin(hi))
  var most = jsMax(sin(lo), sin(hi))
  // Peaks at π/2 + 2πk, troughs at 3π/2 + 2πk.
  if ((lo - Double.pi / 2) / (2 * Double.pi)).rounded(.up) <= ((hi - Double.pi / 2) / (2 * Double.pi)).rounded(.down) {
    most = 1
  }
  let turn = 2 * Double.pi
  if ((lo - 1.5 * Double.pi) / turn).rounded(.up) <= ((hi - 1.5 * Double.pi) / turn).rounded(.down)
  {
    least = -1
  }
  return Interval(jsMax(-1, nextFloat(least, false)), jsMin(1, nextFloat(most, true)))
}

/// How much of a box lies in the domain of every function an enclosure passed
/// through (sqrt, ln and asin need their argument in range, and a fractional
/// power a base ≥ 0): all of it, some of it, or none. An enclosure covers only
/// the values at points where the expression is defined, so it proves a
/// comparison false wherever it is defined — the points where it is undefined
/// are in no set either — but proves it true only when the whole box is in
/// the domain (sqrt(x) < 1 does not hold at x = -1).
///
/// Port: the site keeps the reach of the last enclosure in a module variable
/// (`lastReach`); here an enclosure returns it beside the interval.
enum Reach: Int, Comparable, Sendable {
  case none = 0
  case some = 1
  case all = 2

  static func < (a: Reach, b: Reach) -> Bool { a.rawValue < b.rawValue }
}

private typealias IFn = (_ box: [Interval], _ reach: inout Reach) -> Interval

/// The part of `a` inside [lo, hi], noting how much of `a` that is; nil when
/// none of it is.
@inline(__always)
private func inDomain(_ a: Interval, _ lo: Double, _ hi: Double, _ reach: inout Reach) -> Interval? {
  if a.hi < lo || a.lo > hi {
    reach = .none
    return nil
  }
  if (a.lo < lo || a.hi > hi) && reach > .some { reach = .some }
  return Interval(jsMax(lo, a.lo), jsMin(hi, a.hi))
}

/// The values an expression takes over a box, compiled once for many boxes
/// (a quadtree's cells), without derivatives: the enclosure a quadtree prunes
/// by (Measure.swift). Wider than intervalAD's set of forms — the elementary
/// functions a filter is usually written with — and a form it does not know
/// encloses as the whole line, which only costs subdivision. Infinite box
/// sides are allowed, so a strip out to ∞ can be tested too (`intervalFn`).
struct IntervalFn {
  fileprivate let f: IFn

  /// The enclosure over `box`, and how much of the box is in the domain.
  func callAsFunction(_ box: [Interval]) -> (Interval, Reach) {
    var reach = Reach.all
    let v = f(box, &reach)
    return (v, reach)
  }
}

func intervalFn(_ e: Expr, _ names: [String], _ env: [String: Double]) -> IntervalFn {
  IntervalFn(f: compileInterval(e, names, env))
}

private func compileInterval(_ e: Expr, _ names: [String], _ env: [String: Double]) -> IFn {
  func rec(_ x: Expr) -> IFn { compileInterval(x, names, env) }
  switch e {
  case .num(let value):
    let v = point(value)
    return { _, _ in v }
  case .var(let name):
    if let k = names.firstIndex(of: name) { return { box, _ in box[k] } }
    let v = env[name].map(point) ?? WHOLE
    return { _, _ in v }
  case .neg(let inner):
    let a = rec(inner)
    return { box, reach in ineg(a(box, &reach)) }
  case .bin(let op, let lhs, let rhs, _):
    let fa = rec(lhs)
    if op == .pow {
      var q = Double.nan
      if case .num(let value) = rhs { q = value }
      if JS.isInteger(q) && abs(q) <= 64 {
        let n = Int(abs(q))
        return { box, reach in
          let p = ipow(fa(box, &reach), n)
          return q >= 0 ? p : idiv(ONE, p)
        }
      }
      let fb = rec(rhs)
      return { box, reach in
        var a = fa(box, &reach)
        // A fractional power of a negative number is undefined.
        if !q.isNaN && !JS.isInteger(q) {
          guard let base = inDomain(a, 0, .infinity, &reach) else { return WHOLE }
          a = base
        }
        // A fixed real power of a non-negative base rises (or falls) with it.
        if !q.isNaN && a.lo >= 0 {
          let p = JS.pow(a.lo, q)
          let r = JS.pow(a.hi, q)
          return outward(jsMin(p, r), jsMax(p, r))
        }
        let b = fb(box, &reach)
        // A constant positive base, as in 2^x: rising or falling in the power.
        if a.lo > 0 && a.lo == a.hi && b.lo.isFinite && b.hi.isFinite {
          let p = JS.pow(a.lo, b.lo)
          let r = JS.pow(a.lo, b.hi)
          return outward(jsMin(p, r), jsMax(p, r))
        }
        return WHOLE
      }
    }
    let fb = rec(rhs)
    let f: (Interval, Interval) -> Interval =
      switch op {
      case .add: iadd
      case .sub: isub
      case .mul: imul
      default: idiv
      }
    return { box, reach in
      let a = fa(box, &reach)
      return f(a, fb(box, &reach))
    }
  case .call(let name, let argExprs):
    let args = argExprs.map(rec)
    if (name == "min" || name == "max") && args.count >= 2 {
      let least = name == "min"
      return { box, reach in
        var out = args[0](box, &reach)
        for f in args.dropFirst() {
          let v = f(box, &reach)
          out =
            least
            ? Interval(jsMin(out.lo, v.lo), jsMin(out.hi, v.hi)) : Interval(jsMax(out.lo, v.lo), jsMax(out.hi, v.hi))
        }
        return out
      }
    }
    guard args.count == 1, let one = unary(name) else { return { _, _ in WHOLE } }
    let fa = args[0]
    return { box, reach in
      let a = fa(box, &reach)
      return one(a, &reach)
    }
  default:
    return { _, _ in WHOLE }
  }
}

/// Math.LN10.
private let LN10 = 2.302585092994046

/// A one-argument function over an interval, or nil when not known.
private func unary(_ name: String) -> ((Interval, inout Reach) -> Interval)? {
  switch name {
  case "sqrt":
    return { a, reach in
      guard let c = inDomain(a, 0, .infinity, &reach) else { return WHOLE }
      return rising({ $0.squareRoot() }, c)
    }
  case "exp":
    return { a, _ in rising(exp, a) }
  case "ln", "log":
    let base = name == "log" ? LN10 : 1
    // (ln 0 is -∞, which the arithmetic still reads as a value.)
    return { a, reach in
      guard let c = inDomain(a, 0, .infinity, &reach) else { return WHOLE }
      return rising({ log($0) / base }, c)
    }
  case "atan":
    return { a, _ in rising(atan, a) }
  // Steps rise too, and exactly: no rounding to widen.
  case "floor":
    return { a, _ in Interval(a.lo.rounded(.down), a.hi.rounded(.down)) }
  case "ceil":
    return { a, _ in Interval(a.lo.rounded(.up), a.hi.rounded(.up)) }
  case "round":
    return { a, _ in Interval(JS.round(a.lo), JS.round(a.hi)) }
  case "sign":
    return { a, _ in Interval(JS.sign(a.lo), JS.sign(a.hi)) }
  case "tanh":
    return { a, _ in rising(tanh, a) }
  case "sinh":
    return { a, _ in rising(sinh, a) }
  case "abs":
    return { a, _ in a.lo >= 0 ? a : a.hi <= 0 ? ineg(a) : Interval(0, jsMax(-a.lo, a.hi)) }
  case "cosh":
    return { a, _ in
      let p = cosh(a.lo)
      let q = cosh(a.hi)
      return outward(a.lo < 0 && a.hi > 0 ? 1 : jsMin(p, q), jsMax(p, q))
    }
  case "sin":
    return { a, _ in isin(a) }
  case "cos":
    return { a, _ in isin(a, Double.pi / 2) }
  case "tan":
    return { a, _ in
      // Rising between poles; a pole inside (or too wide to tell) is the whole line.
      let k = (a.lo / Double.pi + 0.5).rounded(.down)
      if !(a.hi - a.lo < Double.pi) || (a.hi / Double.pi + 0.5).rounded(.down) != k { return WHOLE }
      let lo = tan(a.lo)
      let hi = tan(a.hi)
      return lo <= hi ? outward(lo, hi) : WHOLE
    }
  case "asin", "acos":
    return { a, reach in
      guard let c = inDomain(a, -1, 1, &reach) else { return WHOLE }
      return name == "asin" ? rising(asin, c) : outward(acos(c.hi), acos(c.lo))
    }
  default:
    return nil
  }
}

/// Calls an enclosure knows (anything else is the whole line).
private let KNOWN_CALLS: Set<String> = [
  "sqrt", "exp", "ln", "log", "atan", "floor", "ceil", "round", "sign", "tanh", "sinh", "abs", "cosh", "sin", "cos",
  "tan", "asin", "acos",
]

/// Whether an enclosure of `e` is tight enough to decide anything: an unknown
/// function makes every enclosure the whole line, which proves nothing (so a
/// measure built on it could never be certified).
func intervalKnows(_ e: Expr) -> Bool {
  switch e {
  case .num, .var:
    return true
  case .neg(let a):
    return intervalKnows(a)
  case .bin(_, let a, let b, _):
    return intervalKnows(a) && intervalKnows(b)
  case .call(let name, let args):
    return ((KNOWN_CALLS.contains(name) && args.count == 1) || ((name == "min" || name == "max") && args.count >= 2))
      && args.allSatisfy(intervalKnows)
  default:
    return false
  }
}

private func determinant(_ m: [[Interval]]) -> Interval {
  if m.count == 2 { return isub(imul(m[0][0], m[1][1]), imul(m[0][1], m[1][0])) }
  var sum = ZERO
  for (k, v) in m[0].enumerated() {
    let minor = m.dropFirst().map { row in row.enumerated().filter { $0.offset != k }.map(\.element) }
    sum = iadd(sum, imul(k % 2 == 1 ? ineg(v) : v, determinant(minor)))
  }
  return sum
}

public struct Certification: Sendable {
  public var roots: [[Double]] = []
  /// Each enclosure has an existence and uniqueness proof.
  public var enclosures: [[Interval]] = []
  public var complete = false
  public var unresolved = 0
  public var visited = 0
}

private enum Krawczyk {
  case none
  case root(enclosure: [Interval])
  case unknown
}

/// The Krawczyk test on one box: no zero there, exactly one (inside the
/// returned enclosure), or undecided.
private func krawczyk(_ residuals: [Expr], _ names: [String], _ box: [Interval], _ env: [String: Double]) -> Krawczyk {
  let n = names.count
  let f = residuals.map { intervalAD($0, names, box, env) }
  if f.contains(where: { $0.valid && excludesZero($0.value) }) { return .none }
  let mid = box.map { $0.lo / 2 + $0.hi / 2 }
  let atMid = residuals.map { intervalAD($0, names, mid.map(point), env) }
  let jm = atMid.map { $0.jac.map { $0.lo / 2 + $0.hi / 2 } }
  let cols = (0..<n).map { k in solveLinear(jm, (0..<n).map { $0 == k ? 1 : 0 }, n) }
  if !f.allSatisfy(\.valid) || !atMid.allSatisfy(\.valid)
    || !cols.allSatisfy({ $0 != nil && $0!.allSatisfy(\.isFinite) })
  {
    return .unknown
  }
  let c = (0..<n).map { i in cols.map { point($0![i]) } }
  if !excludesZero(determinant(c)) { return .unknown }
  let r = (0..<n).map { i in
    (0..<n).map { j in
      isub(point(i == j ? 1 : 0), (0..<n).reduce(ZERO) { sum, k in iadd(sum, imul(c[i][k], f[k].jac[j])) })
    }
  }
  let kraw = (0..<n).map { i in
    let center = isub(point(mid[i]), (0..<n).reduce(ZERO) { sum, j in iadd(sum, imul(c[i][j], atMid[j].value)) })
    return (0..<n).reduce(center) { sum, j in iadd(sum, imul(r[i][j], isub(box[j], point(mid[j])))) }
  }
  // K disjoint from X excludes a zero; strict containment and a
  // contraction prove one unique zero of the original equations.
  if (0..<n).contains(where: { kraw[$0].lo > box[$0].hi || kraw[$0].hi < box[$0].lo }) { return .none }
  let contraction = r.allSatisfy { row in
    row.reduce(0.0) { sum, v in nextFloat(sum + jsMax(abs(v.lo), abs(v.hi)), true) } < 1
  }
  if contraction && (0..<n).allSatisfy({ kraw[$0].lo > box[$0].lo && kraw[$0].hi < box[$0].hi }) {
    return .root(enclosure: kraw)
  }
  return .unknown
}

private func within(_ inner: [Interval], _ outer: [Interval]) -> Bool {
  inner.indices.allSatisfy { inner[$0].lo >= outer[$0].lo && inner[$0].hi <= outer[$0].hi }
}

/// Widths of the boxes tried around a seed, relative to max(1, |seed|).
private let SEED_RADII = [1e-9, 1e-7, 1e-5, 1e-4, 1e-3, 1e-2, 0.03, 0.1, 0.3]

/// Prove roots of a square system in the box [lo, hi]. `seeds` are approximate
/// roots (from the numeric solver): each only chooses a small box around it to
/// test, widened while the test still proves a unique root there, so a root
/// the subdivision would only reach after exhausting its budget elsewhere is
/// still certified. Subdivision then skips boxes inside those proven regions.
public func certifySystem(
  _ residuals: [Expr], _ names: [String], _ lo: [Double], _ hi: [Double], _ env: [String: Double] = [:],
  maxBoxes: Int = 2048, seeds: [[Double]] = []
) throws -> Certification {
  let n = names.count
  var result = Certification()
  if residuals.count != n || (n != 2 && n != 3) || lo.count != n || hi.count != n
    || (0..<n).contains(where: { !lo[$0].isFinite || !hi[$0].isFinite || !(lo[$0] < hi[$0]) })
  {
    throw LanguageError("Certification needs a finite box and a square 2D or 3D system.")
  }
  if residuals.contains(where: { exceedsNodes($0, 2048) }) {
    throw LanguageError("Certification accepts at most 2048 expression nodes per equation.")
  }
  // Boxes each proven to hold exactly one root: result.roots[k] is in unique[k].
  var unique: [[Interval]] = []
  func record(_ box: [Interval], _ enclosure: [Interval], _ guess: [Double]) {
    // The same root proven twice: its enclosure lies in the other's box.
    if unique.indices.contains(where: { within(enclosure, unique[$0]) || within(result.enclosures[$0], box) }) {
      return
    }
    let numeric = solveSystem(
      residuals, names, box.map(\.lo), box.map(\.hi),
      SolveOptions(env: env, margin: 0, seeds: [guess], lattice: false))
    result.roots.append(numeric.first ?? enclosure.map { $0.lo / 2 + $0.hi / 2 })
    result.enclosures.append(enclosure)
    unique.append(box)
  }
  for seed in seeds {
    if seed.count != n || !(0..<n).allSatisfy({ seed[$0] >= lo[$0] && seed[$0] <= hi[$0] }) { continue }
    if unique.contains(where: { within(seed.map(point), $0) }) { continue }
    let scale = JS.max([1] + seed.map { abs($0) })
    var proven: (box: [Interval], enclosure: [Interval])?
    for radius in SEED_RADII {
      let box = (0..<n).map { k in
        Interval(jsMax(lo[k], seed[k] - radius * scale), jsMin(hi[k], seed[k] + radius * scale))
      }
      guard case .root(let enclosure) = krawczyk(residuals, names, box, env) else {
        if proven != nil { break }
        continue
      }
      proven = (box, enclosure)
    }
    if let proven { record(proven.box, proven.enclosure, seed) }
  }
  var pending: [(box: [Interval], depth: Int)] = [((0..<n).map { Interval(lo[$0], hi[$0]) }, 0)]
  while let (box, depth) = pending.last, result.visited < min(8192, max(1, maxBoxes)) {
    pending.removeLast()
    result.visited += 1
    if unique.contains(where: { within(box, $0) }) { continue }
    let test = krawczyk(residuals, names, box, env)
    if case .none = test { continue }
    if case .root(let enclosure) = test {
      record(box, enclosure, box.map { $0.lo / 2 + $0.hi / 2 })
      continue
    }
    let widths = (0..<n).map { (box[$0].hi - box[$0].lo) / (hi[$0] - lo[$0]) }
    // (A finite box: its widest side is always found.)
    guard let axis = widths.firstIndex(of: JS.max(widths)) else {
      result.unresolved += 1
      continue
    }
    let split = box[axis].lo + 0.493 * (box[axis].hi - box[axis].lo)
    if depth >= 36 || split <= box[axis].lo || split >= box[axis].hi {
      result.unresolved += 1
      continue
    }
    var a = box
    var b = box
    a[axis].hi = split
    b[axis].lo = split
    pending.append((a, depth + 1))
    pending.append((b, depth + 1))
  }
  result.unresolved += pending.count
  result.complete = result.unresolved == 0
  return result
}
