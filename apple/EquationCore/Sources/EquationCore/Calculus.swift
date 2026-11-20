#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Symbolic differentiation and the simplifying constructors it builds with
/// (lib/diff.ts), as the language trunk needs them: d/dx in a row, a level
/// set's gradient, point arithmetic.
///
/// A stand-in under its own namespace: lib/diff.ts is being ported to
/// Diff.swift separately, and once that lands these should forward to it (or
/// go). It is a line-for-line port all the same, so the two agree.
enum Sym {
  /// A function with no usable symbolic derivative: callers may fall back to
  /// finite differences (unlike other diff errors, which are real errors).
  struct NonSmoothError: Error {
    var message: String
  }

  static let zero = Expr.num(0)
  static let one = Expr.num(1)

  private static func isNum(_ e: Expr, _ v: Double) -> Bool {
    if case .num(let value) = e { return value == v }
    return false
  }

  private static func value(_ e: Expr) -> Double? {
    if case .num(let value) = e { return value }
    return nil
  }

  static func add(_ a: Expr, _ b: Expr) -> Expr {
    if isNum(a, 0) { return b }
    if isNum(b, 0) { return a }
    if let x = value(a), let y = value(b) { return .num(x + y) }
    return .bin(.add, a, b)
  }

  static func sub(_ a: Expr, _ b: Expr) -> Expr {
    if isNum(b, 0) { return a }
    if let x = value(a), let y = value(b) { return .num(x - y) }
    if isNum(a, 0) { return neg(b) }
    return .bin(.sub, a, b)
  }

  static func neg(_ a: Expr) -> Expr {
    // (-a.value || 0: a negated zero, or NaN, is 0.)
    if let x = value(a) { return .num(-x == 0 || x.isNaN ? 0 : -x) }
    if case .neg(let inner) = a { return inner }
    return .neg(a)
  }

  static func mul(_ a: Expr, _ b: Expr) -> Expr {
    if isNum(a, 0) || isNum(b, 0) { return zero }
    if isNum(a, 1) { return b }
    if isNum(b, 1) { return a }
    if let x = value(a), let y = value(b) { return .num(x * y) }
    return .bin(.mul, a, b)
  }

  static func div(_ a: Expr, _ b: Expr) -> Expr {
    if isNum(a, 0) { return zero }
    if isNum(b, 1) { return a }
    if let x = value(a), let y = value(b), y != 0 { return .num(x / y) }
    return .bin(.div, a, b)
  }

  static func pow(_ a: Expr, _ b: Expr) -> Expr {
    if isNum(b, 1) { return a }
    if isNum(b, 0) { return one }
    return .bin(.pow, a, b)
  }

  private static func call(_ name: String, _ args: Expr...) -> Expr { .call(name, args) }

  /// sinc′ within 0.2 of 0: its Taylor polynomial Σ (−1)ⁿ 2n x^(2n−1)/(2n+1)!,
  /// n = 1…5, as (coefficient, power).
  private static let sincSeriesBelow = 0.2
  private static let sincPrimeSeries: [(Double, Double)] = (1...5).map { n in
    var fact = 1.0
    for j in stride(from: 2, through: 2 * n + 1, by: 1) { fact *= Double(j) }
    let sign: Double = n % 2 == 0 ? 1 : -1
    return ((sign * 2 * Double(n)) / fact, Double(2 * n - 1))
  }

  /// The name an internal function is known by in a message.
  private static func plainFnName(_ name: String) -> String {
    if name == angleRateFnName { return "angle" }
    return name.hasPrefix("[") ? String(name.dropFirst().dropLast()) : name
  }

  /// d(e)/d(v). Throws for functions without a usable derivative.
  static func diff(_ e: Expr, _ v: String) throws -> Expr {
    switch e {
    case .num:
      return zero
    case .var(let name):
      return name == v ? one : zero
    case .neg(let a):
      return neg(try diff(a, v))
    case .bin(let op, let a, let b, _):
      switch op {
      case .add: return add(try diff(a, v), try diff(b, v))
      case .sub: return sub(try diff(a, v), try diff(b, v))
      case .mul:
        let da = try diff(a, v)
        return add(mul(da, b), mul(a, try diff(b, v)))
      case .div:
        let da = try diff(a, v)
        return div(sub(mul(da, b), mul(a, try diff(b, v))), pow(b, .num(2)))
      case .pow:
        if let n = value(b) {
          // d(a^n) = n a^(n-1) a'
          return mul(mul(b, pow(a, .num(n - 1))), try diff(a, v))
        }
        if let c = value(a) {
          // d(c^b) = c^b ln(c) b'
          return mul(mul(pow(a, b), .num(log(c))), try diff(b, v))
        }
        // d(a^b) = a^b (b' ln a + b a'/a)
        let db = try diff(b, v)
        return mul(pow(a, b), add(mul(db, call("ln", a)), mul(b, div(try diff(a, v), a))))
      }
    case .index, .range, .eqtest:
      throw NonSmoothError(message: structuralDiagnostic(e))
    case .call(let name, let args):
      // A continuous interval's parameter varies on its own, not with x.
      if name == intervalFnName { return zero }
      if name == "atan2" || (name == "atan" && args.count == 2) {
        // (Both read their two arguments, however many atan2 was given.)
        let y = args.count > 0 ? args[0] : .num(.nan)
        let x = args.count > 1 ? args[1] : .num(.nan)
        let n = sub(mul(try diff(y, v), x), mul(y, try diff(x, v)))
        return div(n, add(pow(x, .num(2)), pow(y, .num(2))))
      }
      if name == angleFnName && args.count == 4 {
        // The angle turns as fast as arm v does, less how fast arm u does.
        func rate(_ a: Expr, _ b: Expr) throws -> Expr {
          let da = try diff(a, v)
          let db = try diff(b, v)
          return isNum(da, 0) && isNum(db, 0) ? zero : call(angleRateFnName, a, b, da, db)
        }
        return sub(try rate(args[2], args[3]), try rate(args[0], args[1]))
      }
      if name == angleRateFnName && args.count == 4 {
        // Rare (a second derivative): differentiate the unscaled quotient.
        let (a, b, da, db) = (args[0], args[1], args[2], args[3])
        return try diff(div(sub(mul(a, db), mul(b, da)), add(mul(a, a), mul(b, b))), v)
      }
      if (name == "normalpdf" || name == "normalcdf") && args.count == 3 {
        // Full chain rule in all three arguments (x, mean, sd may all move).
        let (x, m, s) = (args[0], args[1], args[2])
        let z = div(sub(x, m), s)
        let dz = div(sub(sub(try diff(x, v), try diff(m, v)), mul(z, try diff(s, v))), s)
        let pdf = call("normalpdf", x, m, s)
        if name == "normalcdf" { return mul(mul(pdf, s), dz) }
        // φ′ = φ·(−z·z′ − s′/s): the −z z′ from the exponent, −s′/s from 1/s.
        return mul(pdf, sub(mul(neg(z), dz), div(try diff(s, v), s)))
      }
      if (name == "min" || name == "max") && args.count >= 2 {
        // The derivative of whichever argument is chosen; like abs, the kinks
        // are ignored. clamp(x, lo, hi) arrives here as min(max(x, lo), hi).
        let (a, b) = (args[0], args[1])
        if args.count > 2 { return try diff(.call(name, [.call(name, [a, b])] + args[2...]), v) }
        let da = try diff(a, v)
        let db = try diff(b, v)
        if isNum(da, 0) && isNum(db, 0) { return zero }
        return .piecewise([Expr.Case(cond: .ineq(name == "min" ? .lt : .gt, a, b), value: da)], otherwise: db)
      }
      if args.count != 1 { throw NonSmoothError(message: "Cannot differentiate \(plainFnName(name)).") }
      let a = args[0]
      let da = try diff(a, v)
      func chain(_ outer: Expr) -> Expr { mul(outer, da) }
      switch name {
      case "sin": return chain(call("cos", a))
      case "cos": return neg(chain(call("sin", a)))
      case "tan": return chain(div(one, pow(call("cos", a), .num(2))))
      case "asin": return chain(div(one, call("sqrt", sub(one, pow(a, .num(2))))))
      case "acos": return neg(chain(div(one, call("sqrt", sub(one, pow(a, .num(2)))))))
      case "atan": return chain(div(one, add(one, pow(a, .num(2)))))
      case "sinh": return chain(call("cosh", a))
      case "cosh": return chain(call("sinh", a))
      case "tanh": return chain(div(one, pow(call("cosh", a), .num(2))))
      case "sech": return neg(chain(mul(call("sech", a), call("tanh", a))))
      case "asinh": return chain(div(one, call("sqrt", add(pow(a, .num(2)), one))))
      case "acosh": return chain(div(one, call("sqrt", sub(pow(a, .num(2)), one))))
      case "atanh": return chain(div(one, sub(one, pow(a, .num(2)))))
      case "exp": return chain(call("exp", a))
      case "ln": return div(da, a)
      case "log": return div(da, mul(a, .num(2.302585092994046)))
      case "sqrt": return div(da, mul(.num(2), call("sqrt", a)))
      case "abs": return chain(call("sign", a))
      case "erf": return chain(mul(.num(2 / Double.pi.squareRoot()), call("exp", neg(pow(a, .num(2))))))
      case "sinc":
        // (x cos x − sin x)/x² away from 0, and its Taylor polynomial near
        // 0, where the quotient cancels. Neither branch calls sinc, so
        // differentiating again nests no piecewise.
        let series = sincPrimeSeries.map { c, n in mul(.num(c), pow(a, .num(n))) }
        return chain(
          .piecewise(
            [
              Expr.Case(
                cond: .ineq(.gt, call("abs", a), .num(sincSeriesBelow)),
                value: div(sub(mul(a, call("cos", a)), call("sin", a)), pow(a, .num(2))))
            ],
            otherwise: series.dropFirst().reduce(series[0], add)))
      case "coth": return chain(sub(one, pow(call("coth", a), .num(2))))
      default:
        // floor/mod/… (and gamma: digamma isn't in the language): no smooth
        // derivative; the caller falls back to finite differences.
        throw NonSmoothError(message: "Cannot differentiate \(plainFnName(name)).")
      }
    case .eq(let l, let r):
      return sub(try diff(l, v), try diff(r, v))
    case .ineq:
      throw LanguageError("Cannot differentiate an inequality.")
    case .vec:
      throw LanguageError("Differentiate vector components individually.")
    case .list(let items):
      // Elementwise, and still the same list.
      if items.contains(where: { if case .range = $0 { true } else { false } }) {
        throw LanguageError("Cannot differentiate a \"..\" range.")
      }
      return .list(try items.map { try diff($0, v) })
    case .str:
      throw LanguageError("Cannot differentiate text.")
    case .piecewise(let cases, let otherwise):
      // Branchwise derivative (ignores the boundary points).
      return .piecewise(
        try cases.map { Expr.Case(cond: $0.cond, value: try diff($0.value, v)) },
        otherwise: try otherwise.map { try diff($0, v) })
    }
  }
}
