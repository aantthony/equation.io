import Synchronization

#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Reductions over regions, curves and points (lib/measure.ts, "numeric:
/// regions, curves and points"): the route `reduceMeasure` takes for a filter
/// that is neither a product of ranges nor a graph over a bounded range.
///
/// A region (`x^2 + y^2 < 1`) or an implicit curve is measured by a quadtree
/// refined only where the set's edge is, its cells decided by interval
/// enclosures (Certify.swift); points (as many equations as coordinates) are
/// counted with a proof for each: a polynomial's exactly, a 1D equation's by
/// monotone pieces, a 2D system's by the Krawczyk test. An answer the bounds
/// cannot vouch for is an error, never a number.
///
/// Port: the site also stops a measurement on the wall clock (300 ms, for a
/// slow device) and forgets that refusal; here only the work budget ends one,
/// which is deterministic, so the same row always reads the same.

private func num(_ value: Double) -> Expr { .num(value) }

/// One comparison of a filter: it holds where `d < 0` (`d ≤ 0` when not
/// strict), or `d = 0` for an equation. Strictness matters only to points.
struct Cond {
  var d: Expr
  var eq: Bool
  var strict: Bool
}

/// `residualOf`.
func residualOf(_ c: Comparison) -> Cond {
  Cond(d: c.op == .gt ? .bin(.sub, c.r, c.l) : .bin(.sub, c.l, c.r), eq: c.op == .eq, strict: c.strict)
}

typealias PointFn = ([Double]) -> Double

private func bindConstants(_ e: Expr, _ env: [String: Double]) -> Expr { substVars(e, env.mapValues { num($0) }) }

/// The builtins of one argument a filter is usually written with, as
/// `evalFunctions` computes them, without the array a call there takes.
private let FAST_UNARY: [String: @Sendable (Double) -> Double] = [
  "sin": { sin($0) }, "cos": { cos($0) }, "tan": { tan($0) }, "exp": { exp($0) }, "ln": { log($0) },
  "sqrt": { $0.squareRoot() }, "abs": { abs($0) }, "atan": { atan($0) }, "sinh": { sinh($0) }, "cosh": { cosh($0) },
  "tanh": { tanh($0) },
]

/// `e` as nested closures over a point's slots, or nil for a tree with a
/// form that has to be walked (a piecewise, a Σ, an unbound name).
private func compilePoint(_ e: Expr, _ names: [String]) -> PointFn? {
  switch e {
  case .num(let value):
    return { _ in value }
  case .var(let name):
    guard let k = names.firstIndex(of: name) else { return nil }
    return { p in p[k] }
  case .neg(let inner):
    guard let a = compilePoint(inner, names) else { return nil }
    return { p in -a(p) }
  case .bin(let op, let lhs, let rhs, _):
    guard let a = compilePoint(lhs, names), let b = compilePoint(rhs, names) else { return nil }
    switch op {
    case .add: return { p in a(p) + b(p) }
    case .sub: return { p in a(p) - b(p) }
    case .mul: return { p in a(p) * b(p) }
    case .div: return { p in a(p) / b(p) }
    case .pow: return { p in realPow(a(p), b(p)) }
    }
  case .call(let name, let args):
    if boundSumIndex(e) != nil || name == TERM_AT_FN { return nil }
    guard let fn = evalFunctions[name] else { return nil }
    var fs: [PointFn] = []
    for arg in args {
      guard let f = compilePoint(arg, names) else { return nil }
      fs.append(f)
    }
    if fs.count == 1, let one = FAST_UNARY[name] {
      let a = fs[0]
      return { p in one(a(p)) }
    }
    return { p in fn(fs.map { $0(p) }) }
  default:
    return nil
  }
}

/// A fast evaluator of `e` at points of `names`, the constants bound; NaN
/// where it has no value (`pointFn`).
///
/// Port: the site compiles the tree for its stack machine (lib/vm.ts) and
/// walks it when that cannot; here it is compiled to closures, which compute
/// the same numbers, and walked when they cannot.
func pointFn(_ e: Expr, _ names: [String], _ env: [String: Double]) -> PointFn {
  let bound = bindConstants(e, env)
  if let f = compilePoint(bound, names) { return f }
  var scope: [String: Double] = [:]
  return { p in
    for (k, n) in names.enumerated() where k < p.count { scope[n] = p[k] }
    return (try? evaluate(bound, &scope)) ?? .nan
  }
}

private enum Truth {
  case no, yes, unknown
}

/// A condition with its enclosure compiled for the names and constants of
/// the measurement in progress (the site's `ivOf`, a cache by expression).
private struct CCond {
  var d: Expr
  var eq: Bool
  var strict: Bool
  var iv: IntervalFn
}

private func compile(_ conds: [Cond], _ names: [String], _ env: [String: Double]) -> [CCond] {
  conds.map { CCond(d: $0.d, eq: $0.eq, strict: $0.strict, iv: intervalFn($0.d, names, env)) }
}

/// Whether one condition holds on the whole box, on none of it, or neither
/// is proven (`truthOn`, one condition's share).
@inline(__always) private func truthOf(_ c: CCond, _ box: [Interval]) -> Truth {
  let (v, reach) = c.iv(box)
  if reach == .none { return .no }
  if c.eq {
    if v.lo > 0 || v.hi < 0 { return .no }
    return .unknown
  }
  if v.lo > 0 || (c.strict && v.lo >= 0) { return .no }
  if reach != .all || !(v.hi < 0 || (!c.strict && v.hi <= 0)) { return .unknown }
  return .yes
}

/// Whether every condition holds on the whole box, on none of it, or neither
/// is proven. An equation never holds on a whole box. A point where a
/// condition is undefined (sqrt(x) at x < 0) is in no set: a box wholly out
/// of its domain is outside, and one partly out is never wholly inside.
private func truthOn(_ conds: [CCond], _ box: [Interval]) -> Truth {
  var all = true
  for c in conds {
    switch truthOf(c, box) {
    case .no: return .no
    case .unknown: all = false
    case .yes: break
    }
  }
  return all ? .yes : .unknown
}

struct Measured: Sendable {
  /// Area, length or number of points; infinity for an unbounded set.
  var measure: Double
  /// How far `measure` may be off (0 when exact).
  var gap: Double? = nil
  /// ∫ f over the set, per component of the value.
  var totals: [Double]
  /// How far each total may be off.
  var totalGaps: [Double]? = nil
  /// ∫ |f| over the set, per component (the scale totalGaps compare to).
  var sizes: [Double]? = nil
  /// The values at the points (a 0-dimensional set only), for min and max.
  var values: [[Double]]? = nil
}

private enum Outcome: Sendable {
  case got(Measured)
  case failed(String)
}

/// A slider drag re-resolves every row: keep recent measurements.
private let memo = Mutex<[String: Outcome]>([:])

extension Resolver {
  /// count, total, mean, min or max over the set the conditions keep
  /// (`numericReduction`).
  func numericReduction(_ name: String, _ conds: [Cond], _ value: Expr, _ coords: [Coord]) throws -> Expr {
    let what = "\(name) over that set"
    let names = coords.map(\.name)
    if names.contains("z") {
      throw LanguageError("\(name) over a set in space (volume, surface area) is not supported yet.")
    }
    if coords.count > 2 { throw LanguageError("\(what) takes at most two continuous variables.") }
    var values = [value]
    var isVec = false
    if case .vec(let items) = value {
      values = items
      isVec = true
    }
    let bounds = coords.flatMap { [$0.lo, $0.hi] }
    let env = try constantsFor(conds.map(\.d) + values + bounds, names, "\(name) of a filter")
    func range(_ e: Expr) throws -> Double {
      isInf(e, 1) ? .infinity : isInf(e, -1) ? -.infinity : try evaluate(e, env)
    }
    let lo = try coords.map { try range($0.lo) }
    let hi = try coords.map { try range($0.hi) }
    var key = name
    for c in conds { key += "|\(exprKey(c.d))\(c.eq ? 1 : c.strict ? 2 : 0)" }
    for v in values { key += "|\(exprKey(v))" }
    key += "|\(names)|\(lo)|\(hi)|"
    for n in env.keys.sorted() { key += "\(n)=\(env[n]!)," }
    // Failures are kept too: a slider drag must not redo a refused measurement.
    var hit = memo.withLock { $0[key] }
    if hit == nil {
      let outcome: Outcome
      do {
        // count needs only the measure; the others need the values too.
        outcome = .got(try measureSet(conds, name == "count" ? [] : values, names, lo, hi, env))
      } catch is Diverges {
        outcome = .failed(
          "\(name) over that set diverges: the value is unbounded near a point, and its integral is infinite.")
      } catch let error as LanguageError {
        outcome = .failed(error.message)
      }
      memo.withLock {
        if $0.count > 200 { $0.removeAll() }
        $0[key] = outcome
      }
      hit = outcome
    }
    guard case .got(let got)? = hit else {
      if case .failed(let message)? = hit { throw LanguageError(message) }
      throw LanguageError("\(what) has no value.")
    }
    func vec(_ xs: [Double]) -> Expr { isVec ? .vec(xs.map(num)) : num(xs[0]) }
    if name == "count" { return num(certified(got.measure, got.gap ?? 0)) }
    if name == "min" || name == "max" {
      guard let at = got.values else {
        throw LanguageError(
          "\(name) over a region or curve is not supported yet; over points (a solved filter) it is.")
      }
      if isVec { throw LanguageError("\(name) compares numbers; that set holds points.") }
      if at.isEmpty { throw LanguageError("\(name) over an empty set has no value.") }
      let xs = at.map { $0[0] }
      return num(name == "min" ? JS.min(xs) : JS.max(xs))
    }
    if got.measure == .infinity {
      throw LanguageError(
        "\(name) over a set of infinite measure is not supported: restrict it, like \(name)({x^2 + y^2 < 1: …}).")
    }
    let gaps = got.totalGaps ?? []
    func gapOf(_ i: Int) -> Double { i < gaps.count ? gaps[i] : 0 }
    if name == "total" { return vec(got.totals.indices.map { certified(got.totals[$0], gapOf($0)) }) }
    if got.measure == 0 { throw LanguageError("mean over an empty set has no value.") }
    // Each ratio's error, from the errors of its two parts.
    let m = got.measure
    let dm = got.gap ?? 0
    return vec(
      got.totals.indices.map { i in
        let t = got.totals[i]
        return certified(t / m, (gapOf(i) + (abs(t) * dm) / m) / m)
      })
  }
}

/// `v` to the digits its error bound `gap` vouches for, so a readout never
/// shows digits the measurement cannot back (the last one shown is the
/// first it leaves uncertain). The rounded number is nudged by
/// 1e-13 so it still reads `≈`, not `=`.
func certified(_ v: Double, _ gap: Double) -> Double {
  if !(gap > 0) || !v.isFinite || v == 0 { return v }
  // The last digit shown is the first the bound leaves uncertain.
  let unit = JS.pow(10, log10(gap).rounded(.down))
  if unit <= abs(v) * 1e-6 { return v }
  let r = JS.number(JS.toPrecision(JS.round(v / unit) * unit, 15))
  // A value smaller than its bound has no digit the bound vouches for, but
  // it is not 0: its first digit, which reads ≈, never an exact = 0.
  if r == 0 { return JS.number(JS.toPrecision(v, 1)) * (1 + 1e-13) }
  return r * (1 + 1e-13)
}

/// Measure the set where `conds` hold, over coordinates `names` with ranges
/// [lo, hi] (±infinity allowed), and integrate each of `values` over it.
/// Its dimension is the number of coordinates less the number of equations.
func measureSet(
  _ conds: [Cond], _ values: [Expr], _ names: [String], _ lo: [Double], _ hi: [Double], _ env: [String: Double]
) throws -> Measured {
  let eqs = conds.filter(\.eq).count
  let dim = names.count - eqs
  if dim < 0 {
    throw LanguageError("That filter has more equations than variables; count its points with fewer equations.")
  }
  let others = conds.filter { !$0.eq }
  if lo.indices.contains(where: { !(hi[$0] > lo[$0]) }) {
    // A range of one value (0 ≤ x ≤ 0) still holds a root there.
    if dim == 0 && names.count == 1 && hi[0] == lo[0] && pointFn(conds.first(where: \.eq)!.d, names, env)(lo) == 0 {
      return pointsMeasure([[lo[0]]], others, values, names, env)
    }
    return Measured(measure: 0, totals: values.map { _ in 0 }, values: [])
  }
  // A polynomial's real roots are all known exactly, with no box.
  if dim == 0 && names.count == 1 {
    if case .roots(let exact)? = polynomialRoots(bindConstants(conds.first(where: \.eq)!.d, env), names[0]) {
      let xs = exact.map(\.x).filter { $0 >= lo[0] && $0 <= hi[0] }
      return pointsMeasure(distinct(xs.map { [$0] }), others, values, names, env)
    }
  }
  let cc = compile(conds, names, env)
  // Nothing anywhere (x^2 < 0): empty, before any box is sought.
  if dim > 0 && truthOn(cc, names.indices.map { Interval(lo[$0], hi[$0]) }) == .no {
    return Measured(measure: 0, totals: values.map { _ in 0 }, values: [])
  }
  var bound = boundSet(cc, names, lo, hi)
  // Strips out to ∞ defeat interval arithmetic when terms cancel there
  // (x² − y² of the lemniscate): a polynomial's leading form can still
  // prove the set bounded, and the strips then tighten that box.
  if case .unproved = bound, names.count == 2, let R = polynomialRadius(conds, names, env) {
    let clipped = lo.map { jsMax($0, -R) }
    let upper = hi.map { jsMin($0, R) }
    if !clipped.indices.contains(where: { !(upper[$0] > clipped[$0]) }) {
      bound = boundSet(cc, names, clipped, upper)
    }
    if case .unproved = bound { bound = .box(clipped.indices.map { Interval(clipped[$0], upper[$0]) }) }
  }
  if case .infinite = bound { return Measured(measure: .infinity, totals: []) }
  if dim == 0 {
    guard case .box(let box) = bound else {
      throw LanguageError(
        "The solutions could not all be found: they may be infinitely many. Restrict the range, like "
          + "count({-10 < \(names[0]) < 10, …}).")
    }
    return names.count == 1
      ? try rootsOnLine(conds, values, names[0], box[0], env) : try rootsInPlane(conds, values, names, box, env)
  }
  guard case .box(let box) = bound else {
    // Neither proved bounded nor holding a whole strip: measure it in two
    // squares, one twice the other's size. Growth means it runs off to
    // infinity; no growth, and it is unbounded but thin, which a grid over
    // a finite box cannot measure honestly.
    func far(_ R: Double) -> [Interval] { lo.indices.map { Interval(jsMax(lo[$0], -R), jsMin(hi[$0], R)) } }
    let a = try gridMeasure(cc, [], names, far(1024), env, maxDepth: 7).measure
    let b = try gridMeasure(cc, [], names, far(2048), env, maxDepth: 7).measure
    if b > 1.5 * a && b > 0 { return Measured(measure: .infinity, totals: []) }
    throw LanguageError("That set is unbounded, and its measure could not be found. Restrict it to a bounded range.")
  }
  // Only the sides the bound search moved may move off the grid; a range the
  // author gave (0 < x < 1) is an edge of the set itself.
  let soft = box.indices.map { (box[$0].lo != lo[$0], box[$0].hi != hi[$0]) }
  let got = try gridMeasure(cc, values, names, box, env, soft: soft)
  // Report only what the bounds vouch for: an imprecise number is an error.
  let gap = got.gap ?? 0
  // (A gap below 1e-24 is a point's worth: x^2 + y^2 ≤ 0 has area 0.)
  if !(gap <= REPORT_REL * got.measure) && gap > 1e-24 { throw tooCostly() }
  for (i, g) in (got.totalGaps ?? []).enumerated() {
    let size = got.sizes.map { $0[i] } ?? abs(got.totals[i])
    if g > REPORT_REL_TOTAL * size && g > 0 {
      throw LanguageError(
        g == .infinity
          ? "The value could not be bounded on that set (it is unbounded near its edge, or at a point): "
            + "its integral may diverge."
          : "The integral over that set could not be computed precisely enough within the time a readout may take.")
    }
  }
  return got
}

/// A polynomial in two variables: coefficients by exponents (i, j), in the
/// order the terms were first met (the site's is a Map, which keeps it, and
/// the sums below are taken in that order).
private struct Poly2 {
  var keys: [Int] = []
  var coeff: [Int: Double] = [:]

  static func key(_ i: Int, _ j: Int) -> Int { i << 16 | j }
  static func ij(_ key: Int) -> (Int, Int) { (key >> 16, key & 0xffff) }

  mutating func add(_ key: Int, _ v: Double) {
    if let old = coeff[key] {
      coeff[key] = old + v
    } else {
      keys.append(key)
      coeff[key] = v
    }
  }
}

/// `e` as a polynomial in the two coordinates (constants read from env),
/// or nil when it is not one (or is too large to expand).
private func poly2(_ e: Expr, _ names: [String], _ env: [String: Double]) -> Poly2? {
  func constant(_ c: Double) -> Poly2 { Poly2(keys: [0], coeff: [0: c]) }
  func add(_ a: Poly2, _ b: Poly2, _ sign: Double) -> Poly2 {
    var out = a
    for k in b.keys { out.add(k, sign * b.coeff[k]!) }
    return out
  }
  func mul(_ a: Poly2, _ b: Poly2) -> Poly2? {
    if a.keys.count * b.keys.count > 4096 { return nil }
    var out = Poly2()
    for ka in a.keys {
      let (i, j) = Poly2.ij(ka)
      for kb in b.keys {
        let (p, q) = Poly2.ij(kb)
        out.add(Poly2.key(i + p, j + q), a.coeff[ka]! * b.coeff[kb]!)
      }
    }
    return out
  }
  func rec(_ x: Expr) -> Poly2? {
    switch x {
    case .num(let value):
      return value.isFinite ? constant(value) : nil
    case .var(let name):
      let k = names.firstIndex(of: name)
      if k == 0 { return Poly2(keys: [Poly2.key(1, 0)], coeff: [Poly2.key(1, 0): 1]) }
      if k == 1 { return Poly2(keys: [Poly2.key(0, 1)], coeff: [Poly2.key(0, 1): 1]) }
      if let v = env[name], v.isFinite { return constant(v) }
      return nil
    case .neg(let inner):
      return rec(inner).map { add(Poly2(), $0, -1) }
    case .bin(let op, let lhs, let rhs, _):
      guard let a = rec(lhs) else { return nil }
      if op == .pow {
        guard case .num(let n) = rhs, JS.isInteger(n), n >= 0, n <= 24 else { return nil }
        var p: Poly2? = constant(1)
        for _ in 0..<Int(n) {
          guard let q = p else { break }
          p = mul(q, a)
        }
        return p
      }
      guard let b = rec(rhs) else { return nil }
      if op == .add || op == .sub { return add(a, b, op == .add ? 1 : -1) }
      if op == .mul { return mul(a, b) }
      guard b.keys.count == 1, let c = b.coeff[0], c != 0, !c.isNaN else { return nil }
      return add(Poly2(), a, 1 / c)
    default:
      return nil
    }
  }
  return rec(e)
}

/// A radius outside which the set is empty, from polynomial leading forms:
/// for P of degree n whose top form H is definite (|H| ≥ m rⁿ in every
/// direction, checked by interval arithmetic on the circle), P keeps H's sign
/// once m rⁿ exceeds the lower terms' bound Σ C_k r^k. A region `P < 0` with
/// H > 0 is bounded so; a curve `P = 0` with H of either sign; several
/// equations through the sum of their squares. Nil when none applies.
private func polynomialRadius(_ conds: [Cond], _ names: [String], _ env: [String: Double]) -> Double? {
  let polys = conds.map { (c: $0, p: poly2($0.d, names, env)) }
  var candidates: [(p: Poly2, sign: Int)] = []
  for (c, p) in polys { if let p { candidates.append((p, c.eq ? 0 : 1)) } }
  let eqs = polys.filter { $0.c.eq && $0.p != nil }
  if eqs.count >= 2 {
    var sum = Poly2()
    for (_, p) in eqs {
      var sq = Poly2()
      for ka in p!.keys {
        let (i, j) = Poly2.ij(ka)
        for kb in p!.keys {
          let (u, w) = Poly2.ij(kb)
          sq.add(Poly2.key(i + u, j + w), p!.coeff[ka]! * p!.coeff[kb]!)
        }
      }
      for k in sq.keys { sum.add(k, sq.coeff[k]!) }
    }
    candidates.append((sum, 1))
  }
  var best: Double?
  for (p, sign) in candidates {
    if let R = leadingRadius(p, sign), best == nil || R < best! { best = R }
  }
  return best
}

private func leadingRadius(_ p: Poly2, _ sign: Int) -> Double? {
  let terms = p.keys.map { (ij: Poly2.ij($0), v: p.coeff[$0]!) }.filter { $0.v != 0 }
  if terms.isEmpty { return nil }
  func degree(_ t: (ij: (Int, Int), v: Double)) -> Int { t.ij.0 + t.ij.1 }
  let n = terms.map(degree).max()!
  if n == 0 { return nil }
  let top = terms.filter { degree($0) == n }
  // H(cos t, sin t) over the circle, by interval arithmetic on 1024 arcs.
  let th = Expr.var("t")
  var H = num(0)
  for t in top {
    H = .bin(
      .add, H,
      .bin(
        .mul, num(t.v),
        .bin(
          .mul, .bin(.pow, .call("cos", [th]), num(Double(t.ij.0))),
          .bin(.pow, .call("sin", [th]), num(Double(t.ij.1))))))
  }
  let f = intervalFn(H, ["t"], [:])
  var lo = Double.infinity
  var hi = -Double.infinity
  let N = 1024.0
  for k in 0..<1024 {
    let (v, _) = f([Interval((2 * Double.pi * Double(k)) / N, (2 * Double.pi * Double(k + 1)) / N)])
    lo = jsMin(lo, v.lo)
    hi = jsMax(hi, v.hi)
  }
  // m: the least |H| on the circle, with the sign the condition needs.
  let m = lo > 0 && sign >= 0 ? lo : hi < 0 && sign == 0 ? -hi : 0
  if !(m > 0) { return nil }
  let C = (0..<n).map { k in terms.filter { degree($0) == k }.reduce(0.0) { $0 + abs($1.v) } }
  func wins(_ r: Double) -> Bool {
    var lower = 0.0
    for (k, c) in C.enumerated() { lower += c * JS.pow(r, Double(k)) }
    return m * JS.pow(r, Double(n)) > lower * (1 + 1e-9)
  }
  var R = 1.0
  while !wins(R) {
    R *= 2
    if R > 1_099_511_627_776 { return nil }  // 2^40
  }
  return R
}

/// Candidate cut positions for a bounding box, ascending: ±2^e and 0.
private let CUTS: [Double] =
  (0..<29).map { -JS.pow(2, Double(20 - $0)) } + [0] + (0..<29).map { JS.pow(2, Double($0 - 8)) }

private enum Bound {
  /// A strip out to ∞ is proved inside the set.
  case infinite
  case box([Interval])
  /// A side is not proved bounded (the site's null).
  case unproved
}

/// A box outside which no condition can hold, found by proving strips of each
/// coordinate empty with interval arithmetic — each side of each coordinate on
/// its own, so a finite side never stops the other's search: `infinite` when a
/// strip out to ∞ is proved inside the set (a region, so of infinite measure),
/// `unproved` when a side is not proved bounded. Finite sides are tightened too.
private func boundSet(_ conds: [CCond], _ names: [String], _ lo: [Double], _ hi: [Double]) -> Bound {
  var box = names.indices.map { Interval(lo[$0], hi[$0]) }
  func strip(_ k: Int, _ side: Interval) -> Truth {
    var b = box
    b[k] = side
    return truthOn(conds, b)
  }
  for _ in 0..<3 {
    var changed = false
    for k in names.indices {
      for up in [true, false] {
        let a = box[k].lo
        let b = box[k].hi
        // The strip beyond cut c: [c, b] above, [a, c] below.
        func beyond(_ c: Double) -> Interval { up ? Interval(c, b) : Interval(a, c) }
        let cuts = (up ? CUTS : CUTS.reversed()).filter { $0 > a && $0 < b }
        var prev = up ? a : b
        var found: Double?
        for c in cuts {
          let t = strip(k, beyond(c))
          if t == .yes && !(up ? b : a).isFinite { return .infinite }
          if t == .no {
            found = c
            break
          }
          prev = c
        }
        guard var cut = found else { continue }
        // Close in on the set between the last cut that failed and this one.
        if prev.isFinite {
          for _ in 0..<16 {
            let m = (prev + cut) / 2
            if strip(k, beyond(m)) == .no { cut = m } else { prev = m }
          }
        }
        box[k] = up ? Interval(a, cut) : Interval(cut, b)
        changed = true
      }
    }
    if !changed { break }
  }
  return box.allSatisfy { $0.lo.isFinite && $0.hi.isFinite } ? .box(box) : .unproved
}

/// Gauss–Legendre, 3 points on [-1, 1].
private let GL3_X = [-(0.6).squareRoot(), 0, (0.6).squareRoot()]
private let GL3_W = [5.0 / 9, 8.0 / 9, 5.0 / 9]

/// Interval-evaluated expression nodes one measurement may spend: about
/// 50 ms on the site, so a readout never stalls the page.
private let WORK_BUDGET = 2_200_000

/// A measurement that ran out of budget before it was precise enough (`TooCostly`).
private func tooCostly() -> LanguageError {
  LanguageError(
    "That set could not be measured precisely enough within the time a readout may take. "
      + "Restrict it to a smaller range.")
}

/// Relative precision a measure's bounds must reach to be reported (the
/// readout then shows only the digits they vouch for).
private let REPORT_REL = 2e-3
/// The same for a total, whose edge cells are bounded by |f| at its worst.
private let REPORT_REL_TOTAL = 5e-3
/// Relative precision at which refinement stops early (on a line an edge
/// is a few points, so it can be refined much further).
private let STOP_REL = 1e-6
private let STOP_REL_1D = 1e-12

/// A condition with its point evaluator: every test is `at(p) < 0`.
private struct DCond {
  var cond: CCond
  var at: PointFn
}

private func volume(_ cell: [Interval]) -> Double { cell.reduce(1) { $0 * ($1.hi - $1.lo) } }

/// Math.hypot of two, as V8 computes it (scaled by the larger magnitude,
/// summed with Kahan's compensation), so lengths add up to the site's.
private func hypot2(_ x: Double, _ y: Double) -> Double {
  if x.isInfinite || y.isInfinite { return .infinity }
  if x.isNaN || y.isNaN { return .nan }
  let largest = max(abs(x), abs(y))
  if largest == 0 { return 0 }
  var sum = 0.0
  var compensation = 0.0
  for value in [x, y] {
    let n = abs(value) / largest
    let summand = n * n - compensation
    let preliminary = sum + summand
    compensation = (preliminary - sum) - summand
    sum = preliminary
  }
  return sum.squareRoot() * largest
}

/// Area (2D) or length (1D) of a region, or the length of a curve (2D with one
/// equation), over `box`, by a quadtree refined only where the set's edge is:
/// cells the interval enclosures prove inside count whole, cells proved
/// outside drop, and the undecided cells are refined level by level while the
/// work budget lasts, then measured from their corner values. For a region
/// the undecided cells' total size bounds the error (`gap`, certified); for a
/// curve the change from the previous level estimates it.
///
/// `soft`: author-given sides stay put; the others are padded off the grid.
/// `maxDepth`: only a rough size (the unboundedness test), no precision demanded.
private func gridMeasure(
  _ conds: [CCond], _ values: [Expr], _ names: [String], _ box: [Interval], _ env: [String: Double],
  soft given: [(Bool, Bool)]? = nil, maxDepth depthLimit: Int? = nil
) throws -> Measured {
  let soft = given ?? box.map { _ in (true, true) }
  // Widen the box a little off any round grid, so a boundary never lies
  // along a cell edge (x = 1 of the unit circle, on a grid over [-2, 2]).
  let pad = box.map { ($0.hi - $0.lo) * 0.0137 }
  let root = box.indices.map { k in
    Interval(soft[k].0 ? box[k].lo - pad[k] * 0.61 : box[k].lo, soft[k].1 ? box[k].hi + pad[k] : box[k].hi)
  }
  let rootVol = volume(root)
  let dim = names.count
  let fs = values.map { pointFn($0, names, env) }
  let valuesKnown = values.allSatisfy(intervalKnows)
  let valueIv = values.map { intervalFn($0, names, env) }
  // Every test below is `at(p) < 0`: a comparison that allows equality
  // (≤) reads an exact 0 as just inside.
  let ds = conds.map { c -> DCond in
    let f = pointFn(c.d, names, env)
    if c.eq || c.strict { return DCond(cond: c, at: f) }
    return DCond(
      cond: c,
      at: { p in
        let v = f(p)
        return v == 0 ? -Double.leastNonzeroMagnitude : v
      })
  }
  let curve = conds.contains(where: \.eq)
  // Work is counted in cells, each one enclosure of the conditions; a cell
  // proved inside also integrates the values (an enclosure and 9 points).
  let condNodes = max(8, conds.reduce(0) { $0 + countNodes($1.d) })
  let valueCost = Int((Double(2 * values.reduce(0) { $0 + countNodes($1) }) / Double(condNodes)).rounded(.up))
  let maxCells = max(4096, WORK_BUDGET / condNodes)
  let maxDepth = depthLimit ?? (dim == 1 ? 60 : 30)
  let continuous = conds.allSatisfy { entire($0.d) }
  // Measuring an undecided cell at the end, in cells' worth of work: corner
  // values, or a sample grid when several comparisons are open there.
  let estimateCost = (conds.count > 1 ? 3 : 1) * (curve && !continuous ? 12 : 1)
  var cells = 0

  // Cells proved inside: their measure is exact; values integrate on them.
  var inner = 0.0
  var totals = values.map { _ in 0.0 }
  var sizes = values.map { _ in 0.0 }
  var totalGaps = values.map { _ in 0.0 }
  let singular = Singular(values.count)
  func addValues(_ p: [Double], _ w: Double) {
    for i in fs.indices {
      let f = w * fs[i](p)
      totals[i] += f
      sizes[i] += abs(f)
    }
  }
  /// Per value, ∫ f and ∫ |f| over a cell by the tensor Gauss rule.
  func gauss(_ c: [Interval]) -> (q: [Double], qa: [Double]) {
    let w = volume(c)
    var q = values.map { _ in 0.0 }
    var qa = q
    gaussCell(c) { p, g in
      for i in fs.indices {
        let f = g * w * fs[i](p)
        q[i] += f
        qa[i] += abs(f)
      }
    }
    return (q, qa)
  }
  func accept(_ l: Int, _ level: Int, _ q: [Double], _ qa: [Double], _ err: [Double]) {
    for i in fs.indices {
      totals[i] += q[i]
      sizes[i] += qa[i]
      totalGaps[i] += err[i]
      if l > level { singular.add(l, i, qa[i]) }
    }
  }
  func insideCell(_ cell: [Interval], _ level: Int) throws {
    inner += volume(cell)
    if fs.isEmpty { return }
    // A value unbounded on the cell (1/r at the origin) is refined toward
    // its singularity, keeping the shells' sizes to judge convergence; one
    // that varies a lot across it is checked against its four children's
    // rule, and refined until they agree.
    var stack: [([Interval], Int)] = [(cell, level)]
    while let (c, l) = stack.popLast() {
      cells += valueCost + 1
      if Double(cells) > 1.5 * Double(maxCells) { throw tooCostly() }
      var unbounded = false
      var varies = !valuesKnown
      if valuesKnown {
        for iv in valueIv {
          let (v, _) = iv(c)
          if !(v.lo.isFinite && v.hi.isFinite) {
            unbounded = true
          } else if v.hi - v.lo > 0.25 * (abs(v.lo) + abs(v.hi)) {
            varies = true
          }
        }
      }
      let deep = l >= level + 40
      if unbounded {
        if deep { singular.leftover += 1 } else { for child in split(c) { stack.append((child, l + 1)) } }
        continue
      }
      let (q, qa) = gauss(c)
      if !varies || deep {
        accept(l, level, q, qa, deep && varies ? qa : q.map { _ in 0 })
        continue
      }
      let kids = split(c).map(gauss)
      let qc = q.indices.map { i in kids.reduce(0.0) { $0 + $1.q[i] } }
      let qac = q.indices.map { i in kids.reduce(0.0) { $0 + $1.qa[i] } }
      let err = q.indices.map { abs(q[$0] - qc[$0]) }
      if err.indices.allSatisfy({ err[$0] <= 1e-6 * qac[$0] || err[$0] == 0 }) {
        accept(l, level, qc, qac, err)
      } else {
        for child in split(c) { stack.append((child, l + 1)) }
      }
    }
  }

  // Second-order bounds on an undecided cell's share (below): the part of
  // it certainly inside and certainly outside, and so how much is unknown.
  let slopes: [[IntervalFn]?]? = curve ? nil : try conds.map { try gradientFns($0.d, names, env) }
  func unknownIn(_ cell: [Interval]) -> Double {
    let vol = volume(cell)
    guard let slopes else { return vol }
    var only = -1
    for k in conds.indices {
      if truthOf(conds[k], cell) == .yes { continue }
      if only >= 0 { return vol }
      only = k
    }
    guard only >= 0, let g = slopes[only] else { return vol }
    let (inside, outside) = certainParts(cell, conds[only].iv, g)
    return jsMax(0, vol - inside - outside)
  }
  var level = [root]
  var open: [[Interval]] = []
  var previous: [[Interval]] = []
  var unknown: [Double] = []
  /// Whether `unknown` was taken of the cells now `open`.
  var unknownIsOpen = false
  var predicted = Double.infinity
  let stopRel = dim == 1 ? STOP_REL_1D : STOP_REL
  var depth = 0
  while true {
    previous = open
    open = []
    unknownIsOpen = false
    for cell in level {
      cells += 1
      switch truthOn(conds, cell) {
      case .no: continue
      case .yes: try insideCell(cell, depth)
      case .unknown: open.append(cell)
      }
    }
    if open.isEmpty || depth >= maxDepth { break }
    // (An edge has one dimension less than the set, so the undecided cells
    // grow by 2^(dim − 1) a level; cells proved inside integrate the values.)
    let next = open.count * ((1 << dim) + (1 << (dim - 1)) * (estimateCost + valueCost + 3))
    let last = cells + next > maxCells
    // The bound is costly, so it is taken only when it may be met: it
    // shrinks about 4× a level.
    if predicted.isFinite { predicted /= 4 }
    if !curve && ((depth >= 6 && (predicted == .infinity || predicted <= 2 * stopRel * inner)) || last) {
      // Sample first: when even the bound over a sample, scaled up, is far
      // too wide to report, stop now rather than bound every cell.
      if open.count > 2048 {
        let step = open.count / 256
        var sample = 0.0
        var vol = 0.0
        for k in stride(from: 0, to: open.count, by: step) {
          cells += 1
          sample += unknownIn(open[k])
          vol += volume(open[k])
        }
        let total = open.reduce(0.0) { $0 + volume($1) }
        predicted = (sample / vol) * total
        if last && predicted > 4 * REPORT_REL * (inner + total) { throw tooCostly() }
        if !last && predicted > 2 * stopRel * inner {
          level = open.flatMap(split)
          depth += 1
          continue
        }
      }
      unknown = open.map {
        cells += 1
        return unknownIn($0)
      }
      unknownIsOpen = true
      predicted = unknown.reduce(0, +)
      if predicted <= stopRel * inner { break }
    }
    if last { break }
    level = open.flatMap(split)
    depth += 1
  }

  // The undecided cells: a region's edge from corner values, a curve's
  // segments by marching squares.
  func measureOpen(_ cellsOpen: [[Interval]], _ add: ([Double], Double) -> Void) -> Double {
    var m = 0.0
    for cell in cellsOpen {
      cells += 1
      m += estimateCell(cell, ds, dim, curve, continuous, add, !fs.isEmpty)
    }
    return m
  }
  if curve {
    // Two levels, and how far apart they are: the length's error estimate.
    let here = measureOpen(open, addValues)
    var coarseTotals = values.map { _ in 0.0 }
    let coarse = measureOpen(previous) { p, w in for i in fs.indices { coarseTotals[i] += w * fs[i](p) } }
    if !open.isEmpty && previous.isEmpty { throw tooCostly() }
    // Where the curve meets its domain's edge (√(1 − x²) at x = ±1) the
    // corner values are undefined and marching squares cannot see it: each
    // such cell may hide up to its diagonal.
    let eq = ds.first { $0.cond.eq }!
    var edge = 0.0
    for cell in open {
      let (x0, x1, y0, y1) = (cell[0].lo, cell[0].hi, cell[1].lo, cell[1].hi)
      let corners = [eq.at([x0, y0]), eq.at([x1, y0]), eq.at([x1, y1]), eq.at([x0, y1])]
      if corners.contains(where: { !$0.isFinite }) && corners.contains(where: \.isFinite) {
        edge += hypot2(x1 - x0, y1 - y0)
      }
    }
    return Measured(
      measure: here,
      // Four times the change: marching squares converges as h² on a
      // smooth curve, only as h through a crossing (the lemniscate's node)
      // or where the curve ends at its domain's edge.
      gap: open.isEmpty ? 0 : 4 * abs(here - coarse) + edge,
      totals: totals.indices.map { abs(totals[$0]) < 1e-10 * sizes[$0] ? 0 : totals[$0] },
      totalGaps: totals.indices.map { 4 * abs(totals[$0] - coarseTotals[$0]) },
      sizes: sizes)
  }
  var gap = 0.0
  let est = measureOpen(open, addValues)
  if !unknownIsOpen { unknown = open.map(unknownIn) }
  for (k, cell) in open.enumerated() {
    gap += unknown[k]
    for i in values.indices {
      let v = valuesKnown ? valueIv[i](cell).0 : Interval(-.infinity, .infinity)
      totalGaps[i] += unknown[k] * jsMax(abs(v.lo), abs(v.hi))
    }
  }
  let tails = try singular.tails()
  return Measured(
    measure: inner + est,
    gap: gap <= 1e-12 * rootVol ? 0 : gap,
    totals: totals.indices.map { abs(totals[$0]) < 1e-10 * sizes[$0] ? 0 : totals[$0] },
    totalGaps: totalGaps.indices.map { (open.isEmpty ? 0 : totalGaps[$0]) + tails[$0] },
    sizes: sizes)
}

/// Enclosures of ∂d/∂(each coordinate), or nil when d is not smooth or
/// not enclosable.
private func gradientFns(_ d: Expr, _ names: [String], _ env: [String: Double]) throws -> [IntervalFn]? {
  let bound = bindConstants(d, env)
  var gs: [Expr] = []
  for n in names {
    do {
      gs.append(try diff(bound, n))
    } catch {
      if error.nonSmooth { return nil }
      throw LanguageError(error.message)
    }
  }
  if !gs.allSatisfy(intervalKnows) { return nil }
  return gs.map { intervalFn($0, names, [:]) }
}

/// The parts of a cell where `d < 0` certainly holds, and where it certainly
/// fails, by the mean value theorem: d(p) lies between d(c) + G·(p − c) at the
/// gradient enclosure G's extremes, which is linear on each quadrant around
/// the centre c. The band left between them narrows as h² (the first-order
/// cell count as h), so a smooth edge is bounded far more tightly.
private func certainParts(_ cell: [Interval], _ F: IntervalFn, _ G: [IntervalFn]) -> (inside: Double, outside: Double) {
  // The mean value theorem needs F defined on the whole cell.
  if F(cell).1 != .all { return (0, 0) }
  let c = cell.map { ($0.lo + $0.hi) / 2 }
  let (fc, _) = F(c.map { Interval($0, $0) })
  let (flo, fhi) = (fc.lo, fc.hi)
  let g = G.map { f -> Interval in
    let (v, reach) = f(cell)
    return reach == .all ? v : Interval(-.infinity, .infinity)
  }
  if !flo.isFinite || !fhi.isFinite || !g.allSatisfy({ $0.lo.isFinite && $0.hi.isFinite }) { return (0, 0) }
  // Rounding in the linear bounds, generously.
  let h = cell.map { $0.hi - $0.lo }
  var slack = 0.0
  for k in g.indices { slack += (abs(g[k].lo) + abs(g[k].hi)) * h[k] }
  let eps = 1e-12 * (abs(flo) + abs(fhi) + slack)
  var inside = 0.0
  var outside = 0.0
  if cell.count == 1 {
    let (a, b) = (cell[0].lo, cell[0].hi)
    let (ga, gb) = (g[0].lo, g[0].hi)
    // Right half: up = fhi + gb·(x − c); left half: up = fhi + ga·(x − c).
    inside += negativeLength(c[0], b, fhi + eps, fhi + eps + gb * (b - c[0]))
    inside += negativeLength(a, c[0], fhi + eps - ga * (c[0] - a), fhi + eps)
    outside += negativeLength(c[0], b, -(flo - eps), -(flo - eps + ga * (b - c[0])))
    outside += negativeLength(a, c[0], -(flo - eps - gb * (c[0] - a)), -(flo - eps))
    return (inside, outside)
  }
  let (x0, x1, y0, y1) = (cell[0].lo, cell[0].hi, cell[1].lo, cell[1].hi)
  let (cx, cy) = (c[0], c[1])
  let (gxl, gxh, gyl, gyh) = (g[0].lo, g[0].hi, g[1].lo, g[1].hi)
  for qx in [-1, 1] {
    for qy in [-1, 1] {
      let (ax, bx) = qx < 0 ? (x0, cx) : (cx, x1)
      let (ay, by) = qy < 0 ? (y0, cy) : (cy, y1)
      // Above: the largest slope on the side it multiplies positively.
      let ux = qx > 0 ? gxh : gxl
      let uy = qy > 0 ? gyh : gyl
      let lx = qx > 0 ? gxl : gxh
      let ly = qy > 0 ? gyl : gyh
      func U(_ x: Double, _ y: Double) -> Double { fhi + eps + ux * (x - cx) + uy * (y - cy) }
      func L(_ x: Double, _ y: Double) -> Double { -(flo - eps + lx * (x - cx) + ly * (y - cy)) }
      inside += negativeArea(ax, bx, ay, by, [U(ax, ay), U(bx, ay), U(bx, by), U(ax, by)])
      outside += negativeArea(ax, bx, ay, by, [L(ax, ay), L(bx, ay), L(bx, by), L(ax, by)])
    }
  }
  return (inside, outside)
}

/// Length of the part of [a, b] where a linear function (fa at a, fb at b)
/// is negative.
private func negativeLength(_ a: Double, _ b: Double, _ fa: Double, _ fb: Double) -> Double {
  if fa < 0 && fb < 0 { return b - a }
  if fa >= 0 && fb >= 0 { return 0 }
  let s = a + ((b - a) * fa) / (fa - fb)
  return fa < 0 ? s - a : b - s
}

/// Area of the part of a rectangle where a linear function is negative,
/// from its corner values (counter-clockwise from (x0, y0)).
private func negativeArea(_ x0: Double, _ x1: Double, _ y0: Double, _ y1: Double, _ v: [Double]) -> Double {
  if v[0] < 0 && v[1] < 0 && v[2] < 0 && v[3] < 0 { return (x1 - x0) * (y1 - y0) }
  if v[0] >= 0 && v[1] >= 0 && v[2] >= 0 && v[3] >= 0 { return 0 }
  let xs = [x0, x1, x1, x0]
  let ys = [y0, y0, y1, y1]
  var twice = 0.0
  var px = Double.nan
  var py = Double.nan
  var fx = Double.nan
  var fy = Double.nan
  func add(_ x: Double, _ y: Double) {
    if px.isNaN {
      fx = x
      fy = y
    } else {
      twice += px * y - x * py
    }
    px = x
    py = y
  }
  for i in 0..<4 {
    let j = (i + 1) % 4
    if v[i] < 0 { add(xs[i], ys[i]) }
    if (v[i] < 0) != (v[j] < 0) {
      let t = v[i] / (v[i] - v[j])
      add(xs[i] + t * (xs[j] - xs[i]), ys[i] + t * (ys[j] - ys[i]))
    }
  }
  twice += px * fy - fx * py
  return abs(twice) / 2
}

/// The shells around a value's singularity inside a region: the |f| mass the
/// cells next to it carry, level by level. Shrinking geometrically, the part
/// left in the last cells is bounded by their sum; not shrinking, the
/// integral diverges.
private final class Singular {
  var leftover = 0
  /// Per value, the mass by level (the site's is a sparse array).
  private var shells: [[Int: Double]]

  init(_ n: Int) { shells = Array(repeating: [:], count: n) }

  func add(_ level: Int, _ i: Int, _ mass: Double) { shells[i][level, default: 0] += mass }

  /// Per value, a bound on what the unrefined singular cells hold.
  func tails() throws -> [Double] {
    try shells.map { sh -> Double in
      if leftover == 0 { return 0 }
      let last = Array(sh.keys.sorted().map { sh[$0]! }.suffix(10))
      if last.count < 10 || !(last[0] > 0) { return .infinity }
      // The shells' mean ratio over the last levels (the grid is not centred
      // on the singularity, so single ratios wobble).
      let r = JS.pow(last[last.count - 1] / last[0], 1 / Double(last.count - 1))
      if r >= 0.97 { throw Diverges(at: 0) }
      return r <= 0.9 ? (JS.max(Array(last.suffix(3))) * r) / (1 - r) : .infinity
    }
  }
}

/// One undecided cell's share of the set: a region's part from its corner
/// values (second order at one open comparison), or a curve's length.
private func estimateCell(
  _ cell: [Interval], _ ds: [DCond], _ dim: Int, _ curve: Bool, _ continuous: Bool,
  _ addValues: ([Double], Double) -> Void, _ wantValues: Bool
) -> Double {
  if curve {
    let k = ds.firstIndex { $0.cond.eq }!
    let eq = ds[k]
    let others = ds.indices.filter { $0 != k }.map { ds[$0] }
    var m = 0.0
    for (p, q) in marchingSegments(cell, eq.at, continuous) {
      guard let (a, b) = clipSegment(p, q, { pt in others.allSatisfy { $0.at(pt) < 0 } }) else { continue }
      let len = hypot2(b[0] - a[0], b[1] - a[1])
      m += len
      addValues([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], len)
    }
    return m
  }
  let open = ds.filter { truthOf($0.cond, cell) != .yes }
  if open.count == 1 && dim == 2 {
    let poly = clipCell(cell, open[0].at)
    let area = polygonArea(poly)
    if area > 0 && wantValues { addValues(centroid(poly), area) }
    return area > 0 ? area : 0
  }
  if open.count == 1 && dim == 1 {
    let (a, b) = (cell[0].lo, cell[0].hi)
    let fa = open[0].at([a])
    let fb = open[0].at([b])
    if fa < 0 && fb < 0 {
      addValues([(a + b) / 2], b - a)
      return b - a
    }
    if (fa < 0) != (fb < 0) && fa.isFinite && fb.isFinite {
      let s = a + ((b - a) * fa) / (fa - fb)
      let (l, r) = fa < 0 ? (a, s) : (s, b)
      addValues([(l + r) / 2], r - l)
      return r - l
    }
    return 0
  }
  let n = 8
  let vol = volume(cell) / JS.pow(Double(n), Double(dim))
  var m = 0.0
  for i in 0..<n {
    for j in 0..<(dim == 2 ? n : 1) {
      let p = cell.indices.map { k in
        cell[k].lo + ((cell[k].hi - cell[k].lo) * (Double(k == 0 ? i : j) + 0.5)) / Double(n)
      }
      if !ds.allSatisfy({ $0.cond.eq ? true : $0.at(p) < 0 }) { continue }
      m += vol
      addValues(p, vol)
    }
  }
  return m
}

private func split(_ cell: [Interval]) -> [[Interval]] {
  if cell.count == 1 {
    let m = (cell[0].lo + cell[0].hi) / 2
    return [[Interval(cell[0].lo, m)], [Interval(m, cell[0].hi)]]
  }
  let m = (cell[0].lo + cell[0].hi) / 2
  let n = (cell[1].lo + cell[1].hi) / 2
  let x0 = Interval(cell[0].lo, m)
  let x1 = Interval(m, cell[0].hi)
  let y0 = Interval(cell[1].lo, n)
  let y1 = Interval(n, cell[1].hi)
  return [[x0, y0], [x0, y1], [x1, y0], [x1, y1]]
}

/// Tensor 3-point Gauss rule on a cell, with weights summing to 1.
private func gaussCell(_ cell: [Interval], _ visit: ([Double], Double) -> Void) {
  func at(_ k: Int, _ i: Int) -> Double {
    (cell[k].lo + cell[k].hi) / 2 + ((cell[k].hi - cell[k].lo) / 2) * GL3_X[i]
  }
  if cell.count == 1 {
    for i in 0..<3 { visit([at(0, i)], GL3_W[i] / 2) }
    return
  }
  for i in 0..<3 {
    for j in 0..<3 { visit([at(0, i), at(1, j)], (GL3_W[i] * GL3_W[j]) / 4) }
  }
}

private func cornersOf(_ cell: [Interval]) -> [[Double]] {
  let (x0, x1, y0, y1) = (cell[0].lo, cell[0].hi, cell[1].lo, cell[1].hi)
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

/// The part of a square cell where `d < 0`, with the boundary linear between
/// corner values (marching squares, as a polygon).
private func clipCell(_ cell: [Interval], _ d: PointFn) -> [[Double]] {
  let corners = cornersOf(cell)
  let vals = corners.map(d)
  if vals.contains(where: { !$0.isFinite }) { return [] }
  var poly: [[Double]] = []
  for i in 0..<4 {
    let j = (i + 1) % 4
    if vals[i] < 0 { poly.append(corners[i]) }
    if (vals[i] < 0) != (vals[j] < 0) {
      let s = vals[i] / (vals[i] - vals[j])
      poly.append([
        corners[i][0] + s * (corners[j][0] - corners[i][0]), corners[i][1] + s * (corners[j][1] - corners[i][1]),
      ])
    }
  }
  return poly
}

private func polygonArea(_ poly: [[Double]]) -> Double {
  var a = 0.0
  for i in poly.indices {
    let p = poly[i]
    let q = poly[(i + 1) % poly.count]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return abs(a) / 2
}

private func centroid(_ poly: [[Double]]) -> [Double] {
  var twice = 0.0
  var cx = 0.0
  var cy = 0.0
  for i in poly.indices {
    let p = poly[i]
    let q = poly[(i + 1) % poly.count]
    let c = p[0] * q[1] - q[0] * p[1]
    twice += c
    cx += (p[0] + q[0]) * c
    cy += (p[1] + q[1]) * c
  }
  return twice == 0 ? poly[0] : [cx / (3 * twice), cy / (3 * twice)]
}

/// The pieces of the curve `g = 0` in a cell, from the signs at its corners;
/// an ambiguous saddle is resolved by the value at the centre.
private func marchingSegments(_ cell: [Interval], _ g: PointFn, _ continuous: Bool = true) -> [([Double], [Double])] {
  let corners = cornersOf(cell)
  let vals = corners.map(g)
  if vals.contains(where: { !$0.isFinite }) { return [] }
  var cross: [[Double]] = []
  for i in 0..<4 {
    let j = (i + 1) % 4
    if (vals[i] < 0) != (vals[j] < 0) {
      let s = vals[i] / (vals[i] - vals[j])
      cross.append([
        corners[i][0] + s * (corners[j][0] - corners[i][0]), corners[i][1] + s * (corners[j][1] - corners[i][1]),
      ])
    }
  }
  // A sign change across a jump (y = sign(x) at x = 0) is not a zero: where
  // g may be discontinuous, bisect along the edge and keep only crossings
  // where g really approaches 0.
  if !continuous {
    var k = 0
    var i = 0
    while i < 4 && k < cross.count {
      defer { i += 1 }
      let j = (i + 1) % 4
      if (vals[i] < 0) == (vals[j] < 0) { continue }
      var a = corners[i]
      var fa = vals[i]
      var b = corners[j]
      var fm = fa
      for _ in 0..<24 {
        let mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        fm = g(mid)
        if (fm < 0) == (fa < 0) {
          a = mid
          fa = fm
        } else {
          b = mid
        }
      }
      if !(abs(fm) <= 1e-5 * (abs(vals[i]) + abs(vals[j]))) { return [] }
      k += 1
    }
  }
  if cross.count == 2 { return [(cross[0], cross[1])] }
  if cross.count != 4 { return [] }
  // Edges 0..3 each crossed; pair them so the centre's side stays connected.
  let centre = g([(cell[0].lo + cell[0].hi) / 2, (cell[1].lo + cell[1].hi) / 2])
  return (centre < 0) == (vals[0] < 0)
    ? [(cross[0], cross[1]), (cross[2], cross[3])] : [(cross[3], cross[0]), (cross[1], cross[2])]
}

/// The part of segment pq where `inside` holds, assuming it changes at most
/// once along it; nil when none does.
private func clipSegment(_ p: [Double], _ q: [Double], _ inside: ([Double]) -> Bool) -> ([Double], [Double])? {
  let ip = inside(p)
  let iq = inside(q)
  if ip && iq { return (p, q) }
  if !ip && !iq { return nil }
  var a = 0.0
  var b = 1.0
  func at(_ s: Double) -> [Double] { [p[0] + s * (q[0] - p[0]), p[1] + s * (q[1] - p[1])] }
  for _ in 0..<40 {
    let m = (a + b) / 2
    if inside(at(m)) == ip { a = m } else { b = m }
  }
  let s = (a + b) / 2
  return ip ? (p, at(s)) : (at(s), q)
}

/// Intervals one root count may examine: past this it is an error, never
/// a short count.
private let ROOT_BUDGET = 40_000

/// Distinct roots of a 1D equation in [lo, hi] that satisfy the other
/// conditions, each certified: interval arithmetic drops the pieces where
/// the function cannot vanish, and on a piece where its derivative keeps one
/// sign (so at most one root) a certain sign change proves exactly one. A
/// piece that never settles (a double root, or roots piling up as sin(1/x)'s
/// do at 0), or a count past the budget, is an error rather than a count
/// that may be short.
private func rootsOnLine(_ conds: [Cond], _ values: [Expr], _ v: String, _ range: Interval, _ env: [String: Double])
  throws -> Measured
{
  let (lo, hi) = (range.lo, range.hi)
  let eq = conds.first(where: \.eq)!
  // (One equation on a line: the others are its inequalities.)
  let others = conds.filter { !$0.eq }
  let d = bindConstants(eq.d, env)
  let f = pointFn(d, [v], [:])
  // An identity (sin(x)^2 + cos(x)^2 = 1) is a range, not points.
  let probe = (0..<33).map { lo + ((hi - lo) * (Double($0) + 0.37)) / 33 }
  if probe.allSatisfy({ abs(f([$0])) <= 1e-12 }) {
    throw LanguageError("That equation holds for every value: it is not a set of points.")
  }
  var dd: Expr?
  do {
    dd = try diff(d, v)
  } catch {
    if !error.nonSmooth { throw LanguageError(error.message) }
  }
  guard let dd, intervalKnows(d), intervalKnows(dd) else {
    throw LanguageError(
      "The roots of that equation cannot all be proved (it uses a function without an interval enclosure), "
        + "so they are not counted.")
  }
  let F = intervalFn(d, [v], [:])
  let D = intervalFn(dd, [v], [:])
  // (NaN where the equation is undefined: no root there.)
  func sign(_ x: Double) -> Double {
    let (iv, reach) = F([Interval(x, x)])
    if reach == .none { return .nan }
    return iv.lo > 0 ? 1 : iv.hi < 0 ? -1 : 0
  }
  /// JavaScript's truth of a number: neither 0 nor NaN.
  func truthy(_ s: Double) -> Bool { s != 0 && !s.isNaN }
  var roots: [Double] = []
  var stack = [Interval(lo, hi)]
  var visited = 0
  while let piece = stack.popLast() {
    let (a, b) = (piece.lo, piece.hi)
    visited += 1
    if visited > ROOT_BUDGET {
      throw LanguageError(
        "That equation has too many roots in the range to count (or infinitely many). Restrict the range, like "
          + "count({0 < \(v) < 10, …}).")
    }
    let (fv, reach) = F([piece])
    // No root where the equation is undefined, nor where it cannot vanish.
    if reach == .none || fv.lo > 0 || fv.hi < 0 { continue }
    let (dv, dreach) = D([piece])
    // Monotone only where both are defined throughout (sqrt(x) − 1 on
    // [-1, 4] rises where it is defined, but its end at -1 has no sign).
    if reach == .all && dreach == .all && (dv.lo > 0 || dv.hi < 0) {
      // Monotone here: at most one root, found by the signs at the ends.
      let sa = sign(a)
      let sb = sign(b)
      if truthy(sa) && truthy(sb) {
        if sa != sb { roots.append(bisectRoot(f, a, b, sa)) }
      } else {
        // An end within rounding of the root: it is there (a neighbour that
        // finds it too is merged by distinct).
        roots.append(truthy(sa) ? b : a)
      }
      continue
    }
    let w = b - a
    let m = a + 0.493 * w
    if !(w > 1e-12 * JS.max([1, abs(a), abs(b)])) || m <= a || m >= b {
      // A root exactly at an end of the range (sin(x^2) at 0) never
      // separates; prove the rest of the piece empty, shell by shell toward
      // that end, and let the range's own condition decide the end itself.
      if let end = [lo, hi].first(where: { $0 == a || $0 == b }), emptyToward(F, a, b, end) {
        if sign(end) == 0 { roots.append(end) }
        continue
      }
      throw LanguageError(
        "The roots near \(v) = \(JS.string(JS.number(JS.toPrecision(a, 6)))) could not be told apart (a repeated "
          + "root, or roots closer together than the arithmetic can separate), so they are not counted.")
    }
    stack.append(Interval(m, b))
    stack.append(Interval(a, m))
  }
  return pointsMeasure(distinct(roots.map { [$0] }), others, values, [v], env)
}

/// Whether F excludes 0 on all of [a, b] but the point `end` (one of its
/// ends): dyadic shells toward it, down to 1e-30 of the scale (below that,
/// powers underflow and nothing can be proved; a root that close to the end
/// is taken to be the end).
private func emptyToward(_ F: IntervalFn, _ a: Double, _ b: Double, _ end: Double) -> Bool {
  let far = end == a ? b : a
  let floor = 1e-30 * JS.max([1, abs(end)])
  for k in 0..<1100 {
    let near = end + (far - end) / JS.pow(2, Double(k + 1))
    let outer = end + (far - end) / JS.pow(2, Double(k))
    if abs(near - end) < floor { return true }
    let (v, reach) = F([Interval(jsMin(near, outer), jsMax(near, outer))])
    if reach != .none && !(v.lo > 0 || v.hi < 0) { return false }
  }
  return false
}

/// The root of f in [a, b], where f(a) has sign `sa` and f(b) the other.
private func bisectRoot(_ f: PointFn, _ a0: Double, _ b0: Double, _ sa: Double) -> Double {
  var a = a0
  var b = b0
  for _ in 0..<80 {
    let m = (a + b) / 2
    if m <= a || m >= b { break }
    let fm = f([m])
    if fm == 0 { return m }
    if JS.sign(fm) == sa { a = m } else { b = m }
  }
  return (a + b) / 2
}

/// Roots of a 2D system in a box, each proved unique by the Krawczyk test;
/// an incomplete search is an error rather than a count that may be short.
private func rootsInPlane(
  _ conds: [Cond], _ values: [Expr], _ names: [String], _ box: [Interval], _ env: [String: Double]
) throws -> Measured {
  let residuals = conds.filter(\.eq).map(\.d)
  let others = conds.filter { !$0.eq }
  let lo = box.map(\.lo)
  let hi = box.map(\.hi)
  let seeds = solveSystem(residuals, names, lo, hi, SolveOptions(env: env))
  let cert = try certifySystem(residuals, names, lo, hi, env, maxBoxes: 8192, seeds: seeds)
  if !cert.complete {
    throw LanguageError(
      "The solutions of that system could not all be proved: count needs every one. Try a system of polynomials, "
        + "or a smaller range.")
  }
  return pointsMeasure(distinct(cert.roots), others, values, names, env)
}

private func distinct(_ points: [[Double]]) -> [[Double]] {
  var out: [[Double]] = []
  for p in points
  where !out.contains(where: { q in q.indices.allSatisfy { abs(q[$0] - p[$0]) <= 1e-9 * (1 + abs(q[$0])) } }) {
    out.append(p)
  }
  return out
}

private func pointsMeasure(
  _ points: [[Double]], _ others: [Cond], _ values: [Expr], _ names: [String], _ env: [String: Double]
) -> Measured {
  let tests = others.map { (at: pointFn($0.d, names, env), strict: $0.strict) }
  let kept = points.filter { p in tests.allSatisfy { $0.strict ? $0.at(p) < 0 : $0.at(p) <= 0 } }
  let fs = values.map { pointFn($0, names, env) }
  let at = kept.map { p in fs.map { $0(p) } }
  let totals = fs.indices.map { i in at.reduce(0.0) { $0 + $1[i] } }
  return Measured(measure: Double(kept.count), totals: totals, values: at)
}
