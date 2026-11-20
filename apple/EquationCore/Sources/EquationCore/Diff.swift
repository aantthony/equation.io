/// Symbolic differentiation over the plotting AST (lib/diff.ts), with just
/// enough simplification (constant folding, 0/1 pruning) that the emitted GLSL
/// stays readable and cheap. Discontinuous functions (floor, mod, …) throw;
/// callers fall back to finite differences.
///
/// The shader text is written from the tree this returns, so the tree is the
/// TypeScript's node for node, not merely an equal function: the builders
/// below fold exactly what lib/diff.ts's fold, in the same order.

/// What `diff` throws. `nonSmooth` is lib/diff.ts's `NonSmoothError`: a
/// function with no usable symbolic derivative, where callers may fall back
/// to finite differences (the other errors are real errors).
public struct DiffError: Error, Equatable, Sendable {
  public var message: String
  public var nonSmooth: Bool

  init(_ message: String, nonSmooth: Bool = false) {
    self.message = message
    self.nonSmooth = nonSmooth
  }
}

private let ZERO = Expr.num(0)
private let ONE = Expr.num(1)

private func numValue(_ e: Expr) -> Double? {
  if case .num(let value) = e { return value }
  return nil
}

/// Whether e is the number v; as JavaScript's ===, so -0 is 0 and NaN is nothing.
private func isNumVal(_ e: Expr, _ v: Double) -> Bool {
  if case .num(let value) = e { return value == v }
  return false
}

public func add(_ a: Expr, _ b: Expr) -> Expr {
  if isNumVal(a, 0) { return b }
  if isNumVal(b, 0) { return a }
  if let x = numValue(a), let y = numValue(b) { return .num(x + y) }
  return .bin(.add, a, b)
}

public func sub(_ a: Expr, _ b: Expr) -> Expr {
  if isNumVal(b, 0) { return a }
  if let x = numValue(a), let y = numValue(b) { return .num(x - y) }
  if isNumVal(a, 0) { return neg(b) }
  return .bin(.sub, a, b)
}

public func neg(_ a: Expr) -> Expr {
  if let x = numValue(a) {
    // The TypeScript's `-x || 0`: no -0, and (as there) NaN becomes 0 too.
    let value = -x
    return .num(value == 0 || value.isNaN ? 0 : value)
  }
  if case .neg(let inner) = a { return inner }
  return .neg(a)
}

public func mul(_ a: Expr, _ b: Expr) -> Expr {
  if isNumVal(a, 0) || isNumVal(b, 0) { return ZERO }
  if isNumVal(a, 1) { return b }
  if isNumVal(b, 1) { return a }
  if let x = numValue(a), let y = numValue(b) { return .num(x * y) }
  return .bin(.mul, a, b)
}

public func div(_ a: Expr, _ b: Expr) -> Expr {
  if isNumVal(a, 0) { return ZERO }
  if isNumVal(b, 1) { return a }
  if let x = numValue(a), let y = numValue(b), y != 0 { return .num(x / y) }
  return .bin(.div, a, b)
}

public func pow(_ a: Expr, _ b: Expr) -> Expr {
  if isNumVal(b, 1) { return a }
  if isNumVal(b, 0) { return ONE }
  return .bin(.pow, a, b)
}

private func call(_ name: String, _ args: Expr...) -> Expr { .call(name, args) }

/// sinc′ within SINC_SERIES_BELOW of 0: its Taylor polynomial
/// Σ (−1)ⁿ 2n x^(2n−1)/(2n+1)!, n = 1…5, as (coefficient, power), so sinc's
/// derivatives are exact at 0 through the 10th. Where the two branches meet,
/// at |x| = 0.2, the term left out and the quotient's cancellation each cost
/// sinc′, sinc″ and sinc‴ at most ~1e-13 (float64). Five terms, not more: the
/// polynomial is copied into every product- and chain-rule term of a
/// derivative, and an osculating circle's d³/du³ has dozens.
private let SINC_SERIES_BELOW = 0.2
private let SINC_PRIME_SERIES: [(Double, Double)] = (1...5).map { n in
  var fact = 1.0
  for j in stride(from: 2, through: 2 * n + 1, by: 1) { fact *= Double(j) }
  let sign: Double = n % 2 == 0 ? 1 : -1
  return ((sign * 2 * Double(n)) / fact, Double(2 * n - 1))
}

/// Math.LN10 and 2/√π, the two constants lib/diff.ts takes from Math.
private let LN10 = 2.302585092994046
private let TWO_OVER_SQRT_PI = 2 / Double.pi.squareRoot()

/// d(e)/d(v). Throws for functions without a usable derivative.
public func diff(_ e: Expr, _ v: String) throws(DiffError) -> Expr {
  switch e {
  case .num:
    return ZERO
  case .var(let name):
    return name == v ? ONE : ZERO
  case .neg(let a):
    return neg(try diff(a, v))
  case .bin(let op, let a, let b, _):
    switch op {
    case .add:
      let da = try diff(a, v)
      return add(da, try diff(b, v))
    case .sub:
      let da = try diff(a, v)
      return sub(da, try diff(b, v))
    case .mul:
      let da = try diff(a, v)
      return add(mul(da, b), mul(a, try diff(b, v)))
    case .div:
      let da = try diff(a, v)
      return div(sub(mul(da, b), mul(a, try diff(b, v))), pow(b, .num(2)))
    case .pow:
      if let n = numValue(b) {
        // d(a^n) = n a^(n-1) a'
        return mul(mul(b, pow(a, .num(n - 1))), try diff(a, v))
      }
      if let c = numValue(a) {
        // d(c^b) = c^b ln(c) b'
        return mul(mul(pow(a, b), .num(log(c))), try diff(b, v))
      }
      // d(a^b) = a^b (b' ln a + b a'/a)
      let db = try diff(b, v)
      return mul(pow(a, b), add(mul(db, call("ln", a)), mul(b, div(try diff(a, v), a))))
    }
  case .comp(let value, let index, let arity, let functionName):
    // f(P): a component of the derivative is the derivative of the
    // component. A value diff() cannot carry (a tuple inside arithmetic)
    // leaves the whole call to the finite-difference fallback.
    guard let dv = try? diff(value, v) else {
      throw DiffError("Cannot differentiate this point.", nonSmooth: true)
    }
    return isNumVal(dv, 0) ? ZERO : .comp(value: dv, index: index, arity: arity, functionName: functionName)
  case .index, .range, .eqtest, .figure, .lazy, .trail, .label, .hist, .family:
    throw DiffError(structuralDiagnostic(e), nonSmooth: true)
  case .call(let name, let args):
    // A continuous interval's parameter varies on its own, not with x.
    if name == INTERVAL { return ZERO }
    // A list with its origin or its axes (Expr.swift): elementwise, and
    // still the same list (lib/expr.ts `sameList`). One with neither is a
    // new list, as the node the TypeScript builds for it is: d/dx [x, 2x]^2
    // chooses [x, 2x] and [1, 2] apart.
    if name == LIST_ORIGIN || name == LIST_SEQ, args.count == 2 {
      return .call(name, [args[0], try diff(args[1], v)])
    }
    if name == LIST_ID, args.count == 2, case .list(let items) = try diff(args[1], v) { return identifiedList(items) }
    if name == "atan2" || (name == "atan" && args.count == 2) {
      // Fewer than two arguments is the TypeScript reading `undefined.kind`.
      guard args.count >= 2 else { throw DiffError("Cannot read properties of undefined (reading 'kind')") }
      let (y, x) = (args[0], args[1])
      let dy = try diff(y, v)
      let n = sub(mul(dy, x), mul(y, try diff(x, v)))
      return div(n, add(pow(x, .num(2)), pow(y, .num(2))))
    }
    if name == ANGLE_FN && args.count == 4 {
      // The angle turns as fast as arm v does, less how fast arm u does.
      // Each rate is its own scaled builtin: spelled out as
      // (cross′ dot − cross dot′)/(cross² + dot²) it is 0/0 in float32 long
      // before the angle itself stops being well defined near the vertex.
      func rate(_ a: Expr, _ b: Expr) throws(DiffError) -> Expr {
        let da = try diff(a, v)
        let db = try diff(b, v)
        return isNumVal(da, 0) && isNumVal(db, 0) ? ZERO : call(ANGLE_RATE_FN, a, b, da, db)
      }
      let turning = try rate(args[2], args[3])
      return sub(turning, try rate(args[0], args[1]))
    }
    if name == ANGLE_RATE_FN && args.count == 4 {
      // Rare (a second derivative): differentiate the unscaled quotient.
      let (a, b, da, db) = (args[0], args[1], args[2], args[3])
      return try diff(div(sub(mul(a, db), mul(b, da)), add(mul(a, a), mul(b, b))), v)
    }
    if (name == "normalpdf" || name == "normalcdf") && args.count == 3 {
      // Full chain rule in all three arguments (x, mean, sd may all move).
      let (x, m, s) = (args[0], args[1], args[2])
      let z = div(sub(x, m), s)
      let dx = try diff(x, v)
      let dm = try diff(m, v)
      let dz = div(sub(sub(dx, dm), mul(z, try diff(s, v))), s)
      let pdf = call("normalpdf", x, m, s)
      if name == "normalcdf" { return mul(mul(pdf, s), dz) }
      // φ′ = φ·(−z·z′ − s′/s): the −z z′ from the exponent, −s′/s from 1/s.
      return mul(pdf, sub(mul(neg(z), dz), div(try diff(s, v), s)))
    }
    if (name == "min" || name == "max") && args.count >= 2 {
      // The derivative of whichever argument is chosen; like abs, the kinks
      // are ignored. clamp(x, lo, hi) arrives here as min(max(x, lo), hi).
      let (a, b) = (args[0], args[1])
      if args.count > 2 { return try diff(.call(name, [call(name, a, b)] + args.dropFirst(2)), v) }
      let da = try diff(a, v)
      let db = try diff(b, v)
      if isNumVal(da, 0) && isNumVal(db, 0) { return ZERO }
      return .piecewise([Expr.Case(cond: .ineq(name == "min" ? .lt : .gt, a, b), value: da)], otherwise: db)
    }
    guard args.count == 1 else { throw DiffError("Cannot differentiate \(plainFnName(name)).", nonSmooth: true) }
    let a = args[0]
    let da = try diff(a, v)
    func chain(_ outer: Expr) -> Expr { mul(outer, da) }
    switch name {
    case "sin":
      return chain(call("cos", a))
    case "cos":
      return neg(chain(call("sin", a)))
    case "tan":
      return chain(div(ONE, pow(call("cos", a), .num(2))))
    case "asin":
      return chain(div(ONE, call("sqrt", sub(ONE, pow(a, .num(2))))))
    case "acos":
      return neg(chain(div(ONE, call("sqrt", sub(ONE, pow(a, .num(2)))))))
    case "atan":
      return chain(div(ONE, add(ONE, pow(a, .num(2)))))
    case "sinh":
      return chain(call("cosh", a))
    case "cosh":
      return chain(call("sinh", a))
    case "tanh":
      return chain(div(ONE, pow(call("cosh", a), .num(2))))
    case "sech":
      return neg(chain(mul(call("sech", a), call("tanh", a))))
    case "asinh":
      return chain(div(ONE, call("sqrt", add(pow(a, .num(2)), ONE))))
    case "acosh":
      return chain(div(ONE, call("sqrt", sub(pow(a, .num(2)), ONE))))
    case "atanh":
      return chain(div(ONE, sub(ONE, pow(a, .num(2)))))
    case "exp":
      return chain(call("exp", a))
    case "ln":
      return div(da, a)
    case "log":
      return div(da, mul(a, .num(LN10)))
    case "sqrt":
      return div(da, mul(.num(2), call("sqrt", a)))
    case "abs":
      return chain(call("sign", a))
    case "erf":
      return chain(mul(.num(TWO_OVER_SQRT_PI), call("exp", neg(pow(a, .num(2))))))
    case "sinc":
      // (x cos x − sin x)/x² away from 0, and its Taylor polynomial near
      // 0, where the quotient cancels (and each derivative of it divides
      // by x once more). Neither branch calls sinc, so differentiating
      // again nests no piecewise, and the polynomial differentiates in
      // turn: sinc″, sinc‴, … are right at and around 0 too.
      let terms = SINC_PRIME_SERIES.map { mul(.num($0.0), pow(a, .num($0.1))) }
      return chain(
        .piecewise(
          [
            Expr.Case(
              cond: .ineq(.gt, call("abs", a), .num(SINC_SERIES_BELOW)),
              value: div(sub(mul(a, call("cos", a)), call("sin", a)), pow(a, .num(2))))
          ],
          otherwise: terms.dropFirst().reduce(terms[0], add)))
    case "coth":
      return chain(sub(ONE, pow(call("coth", a), .num(2))))
    default:
      // floor/mod/… (and gamma: digamma isn't in the language):
      // no smooth derivative; caller falls back to FD.
      throw DiffError("Cannot differentiate \(plainFnName(name)).", nonSmooth: true)
    }
  case .eq(let l, let r):
    let dl = try diff(l, v)
    return sub(dl, try diff(r, v))
  case .ineq:
    throw DiffError("Cannot differentiate an inequality.")
  case .vec:
    throw DiffError("Differentiate vector components individually.")
  case .list(let items):
    // Elementwise: d/dx [x, x^2] pairs with [x, x^2].
    for item in items {
      if case .range = item { throw DiffError("Cannot differentiate a \"..\" range.") }
    }
    var out: [Expr] = []
    for item in items { out.append(try diff(item, v)) }
    return .list(out)
  case .data:
    throw DiffError("Cannot differentiate a list.")
  case .str, .text:
    throw DiffError("Cannot differentiate text.")
  case .piecewise(let cases, let otherwise):
    // Branchwise derivative (ignores the boundary points). A case comes out
    // without its `bare` mark, as the TypeScript rebuilds it.
    var out: [Expr.Case] = []
    for c in cases { out.append(Expr.Case(cond: c.cond, value: try diff(c.value, v))) }
    guard let otherwise else { return .piecewise(out, otherwise: nil) }
    return .piecewise(out, otherwise: try diff(otherwise, v))
  case .loop:
    // Central difference instead.
    throw DiffError("Cannot differentiate a recursive function.", nonSmooth: true)
  }
}

/// The natural logarithm as Math.log computes it where the fixtures are made
/// and the app runs (V8 on arm64), so d(c^x) folds ln c to the same double
/// the TypeScript does; and no Foundation. V8's is fdlibm's e_log.c
/// (ieee754::log), and clang builds it for arm64 with each `a*b + c` of the
/// source fused into one rounding: the fusings below are the ones in that
/// build, read off the compiled code. Unfused, about 1 double in 1000 comes
/// out a unit in the last place away (as it does from the C library's log).
private func log(_ value: Double) -> Double {
  let ln2Hi = 6.93147180369123816490e-01
  let ln2Lo = 1.90821492927058770002e-10
  let two54 = 1.80143985094819840000e+16
  let lg1 = 6.666666666666735130e-01
  let lg2 = 3.999999999940941908e-01
  let lg3 = 2.857142874366239149e-01
  let lg4 = 2.222219843214978396e-01
  let lg5 = 1.818357216161805012e-01
  let lg6 = 1.531383769920937332e-01
  let lg7 = 1.479819860511658591e-01
  /// a*b + c, rounded once.
  func fma(_ a: Double, _ b: Double, _ c: Double) -> Double { c.addingProduct(a, b) }

  var x = value
  var hx = Int32(truncatingIfNeeded: x.bitPattern >> 32)
  let lx = UInt32(truncatingIfNeeded: x.bitPattern)
  var k: Int32 = 0
  if hx < 0x0010_0000 {
    // x < 2**-1022
    if (UInt32(bitPattern: hx) & 0x7fff_ffff) | lx == 0 { return -.infinity }
    if hx < 0 { return .nan }
    // A subnormal number: scale it up.
    k -= 54
    x *= two54
    hx = Int32(truncatingIfNeeded: x.bitPattern >> 32)
  }
  if hx >= 0x7ff0_0000 { return x + x }
  k += (hx >> 20) - 1023
  hx &= 0x000f_ffff
  var i = (hx + 0x95f64) & 0x10_0000
  // Normalize x or x/2.
  let high = UInt64(UInt32(bitPattern: hx | (i ^ 0x3ff0_0000)))
  x = Double(bitPattern: (high << 32) | (x.bitPattern & 0xffff_ffff))
  k += i >> 20
  let f = x - 1.0
  let dk = Double(k)
  if 0x000f_ffff & (2 + hx) < 3 {
    // -2**-20 <= f < 2**-20
    if f == 0 { return k == 0 ? 0 : fma(dk, ln2Hi, dk * ln2Lo) }
    let r = f * f * fma(-0.33333333333333333, f, 0.5)
    return k == 0 ? f - r : fma(dk, ln2Hi, -(fma(-dk, ln2Lo, r) - f))
  }
  let s = f / (2.0 + f)
  let z = s * s
  i = hx - 0x6147a
  let w = z * z
  let j = 0x6b851 - hx
  let t1 = w * fma(w, fma(w, lg6, lg4), lg2)
  let t2 = z * fma(w, fma(w, fma(w, lg7, lg5), lg3), lg1)
  i |= j
  let r = t2 + t1
  if i > 0 {
    let hfsq = 0.5 * f * f
    if k == 0 { return f - fma(-s, hfsq + r, hfsq) }
    return fma(dk, ln2Hi, -((hfsq - fma(s, hfsq + r, dk * ln2Lo)) - f))
  }
  if k == 0 { return fma(-s, f - r, f) }
  return fma(dk, ln2Hi, -(fma(s, f - r, -(dk * ln2Lo)) - f))
}
