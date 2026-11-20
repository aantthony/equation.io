#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// What the TypeScript throws as a plain `Error`: the message is the site's,
/// word for word, and is what a row reports.
public struct LanguageError: Error, Equatable, Sendable {
  public var message: String

  public init(_ message: String) { self.message = message }
}

/// Names in the order they were first met, as a JavaScript `Set` keeps them:
/// "found b" in an error names the first stray variable the TypeScript walks
/// into, so the order is part of the answer.
public struct NameSet: Equatable, Sendable, Sequence {
  public private(set) var list: [String] = []
  private var members: Set<String> = []

  public init() {}

  public init<S: Sequence>(_ names: S) where S.Element == String {
    for name in names { insert(name) }
  }

  public var isEmpty: Bool { list.isEmpty }
  public var count: Int { list.count }
  public func contains(_ name: String) -> Bool { members.contains(name) }
  public func makeIterator() -> IndexingIterator<[String]> { list.makeIterator() }

  public mutating func insert(_ name: String) {
    if members.insert(name).inserted { list.append(name) }
  }

  /// Whether the name was there (JavaScript's `Set.delete`).
  @discardableResult public mutating func remove(_ name: String) -> Bool {
    guard members.remove(name) != nil else { return false }
    list.removeAll { $0 == name }
    return true
  }
}

// MARK: - Structure (lib/expr.ts childrenOf, mapChildren, substVars, freeVars)

/// A node's direct children, in the order the TypeScript lists them.
func childrenOf(_ e: Expr) -> [Expr] {
  switch e {
  case .num, .var, .str: return []
  case .neg(let a): return [a]
  case .bin(_, let a, let b, _), .index(let a, let b), .range(let a, let b), .eqtest(_, let a, let b), .eq(let a, let b),
    .ineq(_, let a, let b, _):
    return [a, b]
  case .call(_, let items), .vec(let items), .list(let items): return items
  case .piecewise(let cases, let otherwise):
    return cases.flatMap { [$0.cond, $0.value] } + (otherwise.map { [$0] } ?? [])
  }
}

/// Map one level of children, keeping everything else about the node.
func mapChildren(_ e: Expr, _ map: (Expr) throws -> Expr) rethrows -> Expr {
  switch e {
  case .num, .var, .str: return e
  case .neg(let a): return .neg(try map(a))
  case .bin(let op, let a, let b, let glyph): return .bin(op, try map(a), try map(b), glyph: glyph)
  case .index(let a, let b): return .index(try map(a), try map(b))
  case .range(let a, let b): return .range(try map(a), try map(b))
  case .eqtest(let op, let a, let b): return .eqtest(op, try map(a), try map(b))
  case .eq(let l, let r): return .eq(try map(l), try map(r))
  case .ineq(let op, let l, let r, let grouped): return .ineq(op, try map(l), try map(r), grouped: grouped)
  case .call(let name, let args): return .call(name, try args.map(map))
  case .vec(let items): return .vec(try items.map(map))
  case .list(let items): return .list(try items.map(map))
  case .piecewise(let cases, let otherwise):
    return .piecewise(
      try cases.map { Expr.Case(cond: try map($0.cond), value: try map($0.value), bare: $0.bare) },
      otherwise: try otherwise.map(map))
  }
}

/// A Σ/Π that survived resolve: args are [index, lo, hi, body]. Its index is bound.
private func boundSumIndex(_ e: Expr) -> String? {
  guard case .call(let name, let args) = e, name == "sum" || name == "prod", args.count >= 4,
    case .var(let index) = args[0]
  else { return nil }
  return index
}

/// Replace free variables by expressions. A surviving Σ/Π binds its index.
func substVars(_ e: Expr, _ env: [String: Expr]) -> Expr {
  if case .var(let name) = e { return env[name] ?? e }
  if let index = boundSumIndex(e), env[index] != nil, case .call(let name, let args) = e {
    var bodyEnv = env
    bodyEnv[index] = nil
    return .call(name, args.enumerated().map { k, a in substVars(a, k == 0 || k == 3 ? bodyEnv : env) })
  }
  return mapChildren(e) { substVars($0, env) }
}

/// The free variable names (not function names or constants), in the order
/// the TypeScript's `freeVars` meets them.
func freeVarNames(_ e: Expr) -> NameSet {
  var out = NameSet()
  collectFreeVars(e, &out)
  return out
}

private func collectFreeVars(_ e: Expr, _ out: inout NameSet) {
  switch e {
  case .num, .str:
    break
  case .var(let name):
    out.insert(name)
  case .call(_, let args):
    if let index = boundSumIndex(e) {
      collectFreeVars(args[1], &out)
      collectFreeVars(args[2], &out)
      var inner = freeVarNames(args[3])
      inner.remove(index)
      for v in inner { out.insert(v) }
    } else {
      for a in args { collectFreeVars(a, &out) }
    }
  default:
    for child in childrenOf(e) { collectFreeVars(child, &out) }
  }
}

/// Flatten a (possibly chained) inequality into its comparisons; comparison k
/// compares the previous comparison's right side, so 0 < y < x yields
/// [0 < y, y < x] (lib/expr.ts `ineqComparisons`).
func ineqComparisons(_ e: Expr) -> [(op: IneqOp, l: Expr, r: Expr)] {
  var chain: [(op: IneqOp, l: Expr, r: Expr)] = []
  var node = e
  while case .ineq(let op, let l, let r, _) = node {
    chain.insert((op, l, r), at: 0)
    node = l
  }
  return chain.enumerated().map { k, c in (c.op, k == 0 ? c.l : chain[k - 1].r, c.r) }
}

// MARK: - exprKey

/// `JSON.stringify` of the TypeScript's node (lib/expr.ts `exprKey`): the
/// stable spelling the compiler interns and compares expressions by.
public func exprKey(_ e: Expr) -> String {
  func list(_ items: [Expr]) -> String { "[" + items.map(exprKey).joined(separator: ",") + "]" }
  switch e {
  case .num(let value):
    return "{\"kind\":\"num\",\"value\":\(value.isFinite ? JS.string(value) : "null")}"
  case .var(let name):
    return "{\"kind\":\"var\",\"name\":\(jsonString(name))}"
  case .bin(let op, let a, let b, let glyph):
    let tail = glyph.map { ",\"glyph\":\"\($0.rawValue)\"" } ?? ""
    return "{\"kind\":\"bin\",\"op\":\"\(op.rawValue)\",\"a\":\(exprKey(a)),\"b\":\(exprKey(b))\(tail)}"
  case .neg(let a):
    return "{\"kind\":\"neg\",\"a\":\(exprKey(a))}"
  case .call(let name, let args):
    return "{\"kind\":\"call\",\"name\":\(jsonString(name)),\"args\":\(list(args))}"
  case .index(let a, let b):
    return "{\"kind\":\"index\",\"args\":\(list([a, b]))}"
  case .range(let a, let b):
    return "{\"kind\":\"range\",\"args\":\(list([a, b]))}"
  case .eqtest(let op, let a, let b):
    return "{\"kind\":\"eqtest\",\"op\":\"\(op.rawValue)\",\"args\":\(list([a, b]))}"
  case .eq(let l, let r):
    return "{\"kind\":\"eq\",\"l\":\(exprKey(l)),\"r\":\(exprKey(r))}"
  case .ineq(let op, let l, let r, let grouped):
    return "{\"kind\":\"ineq\",\"op\":\"\(op.rawValue)\",\"l\":\(exprKey(l)),\"r\":\(exprKey(r))"
      + (grouped ? ",\"grouped\":true}" : "}")
  case .vec(let items):
    return "{\"kind\":\"vec\",\"items\":\(list(items))}"
  case .list(let items):
    return "{\"kind\":\"list\",\"items\":\(list(items))}"
  case .str(let value):
    return "{\"kind\":\"str\",\"value\":\(jsonString(value))}"
  case .piecewise(let cases, let otherwise):
    let parts = cases.map {
      "{\"cond\":\(exprKey($0.cond)),\"value\":\(exprKey($0.value))" + ($0.bare ? ",\"bare\":true}" : "}")
    }
    return "{\"kind\":\"piecewise\",\"cases\":[\(parts.joined(separator: ","))]"
      + (otherwise.map { ",\"otherwise\":\(exprKey($0))}" } ?? "}")
  }
}

/// `JSON.stringify` of a string.
func jsonString(_ s: String) -> String {
  var out = "\""
  for u in s.unicodeScalars {
    switch u {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\u{08}": out += "\\b"
    case "\u{0C}": out += "\\f"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    default:
      if u.value < 0x20 {
        let hex = String(u.value, radix: 16)
        out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
      } else {
        out.unicodeScalars.append(u)
      }
    }
  }
  return out + "\""
}

// MARK: - Special functions (lib/expr.ts, lib/specfn.ts)

/// Abramowitz & Stegun 7.1.26; max absolute error ~1.5e-7.
func erfFn(_ x: Double) -> Double {
  let a = abs(x)
  let t = 1 / (1 + 0.3275911 * a)
  let poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
  let y = 1 - poly * exp(-a * a)
  return JS.sign(x) * y
}

func normalpdf(_ x: Double, _ mean: Double, _ sd: Double) -> Double {
  let z = (x - mean) / sd
  return exp(-0.5 * (z * z)) / (sd * (2 * Double.pi).squareRoot())
}

func normalcdf(_ x: Double, _ mean: Double, _ sd: Double) -> Double {
  0.5 * (1 + erfFn((x - mean) / (sd * 2.0.squareRoot())))
}

/// Largest argument `isprime` decides: trial division stops at 2048
/// divisors, the cap the GLSL twin loops to.
let isprimeMax: Double = 2048 * 2048 - 1

/// a^b tolerance for snapping the exponent to a small rational p/q (real odd roots).
private let powRationalTol = 1e-6
/// Largest denominator considered when looking for the exponent's rational form.
private let powRationalMaxQ = 12

/// Real-valued a^b: a negative base with a fractional exponent has its real
/// odd root ((-8)^(1/3) = -2) where the exponent is a small rational p/q
/// with q odd, and is undefined otherwise. Kept in step with eq_pow() in the
/// shader prelude (lib/expr.ts `realPow`).
public func realPow(_ a: Double, _ b: Double) -> Double {
  if a >= 0 { return JS.pow(a, b) }
  for q in 1...powRationalMaxQ {
    let p = JS.round(b * Double(q))
    var x = abs(p)
    var y = Double(q)
    while y != 0 && !y.isNaN {
      let t = fmod(x, y)
      x = y
      y = t
    }
    let g = x == 0 || x.isNaN ? 1 : x
    let pr = p / g
    let qr = Double(q) / g
    if abs(b - pr / qr) < powRationalTol {
      if fmod(qr, 2) == 0 { return .nan }  // even root of a negative number: undefined
      let sign: Double = fmod(abs(pr), 2) == 1 ? -1 : 1
      return sign * JS.pow(-a, b)
    }
  }
  return .nan  // no small-denominator rational found: irrational-looking exponent
}

/// Lanczos approximation (g = 7, n = 9) coefficients for ln Γ (lib/specfn.ts).
private let lanczosG7: [Double] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
]
private let lnSqrt2Pi = 0.9189385332046727

/// ln|Γ(x)|. Poles (0, −1, −2, …) are +∞.
func lgammaFn(_ x: Double) -> Double {
  if x.isNaN { return .nan }
  if x < 0.5 {
    if JS.isInteger(x) { return .infinity }
    return log(Double.pi / abs(sin(Double.pi * x))) - lgammaFn(1 - x)
  }
  if x == .infinity { return .infinity }
  let z = x - 1
  var a = lanczosG7[0]
  for i in 1..<lanczosG7.count { a += lanczosG7[i] / (z + Double(i)) }
  let t = z + 7.5
  return lnSqrt2Pi + (z + 0.5) * log(t) - t + log(a)
}

/// Real Γ(x). Poles at 0, −1, −2, … are NaN; other negative reals go through
/// the reflection formula.
func gammaFn(_ x: Double) -> Double {
  if x < 0.5 {
    if JS.isInteger(x) { return .nan }  // pole
    return Double.pi / (sin(Double.pi * x) * gammaFn(1 - x))
  }
  return exp(lgammaFn(x))
}

/// k! for k = 0..170, every factorial a double can hold.
private let factorials: [Double] = {
  var out: [Double] = [1]
  for k in 1...170 { out.append(out[k - 1] * Double(k)) }
  return out
}()

/// x! = Γ(x + 1), except exact for the whole numbers a double can hold.
func factorialFn(_ x: Double) -> Double {
  if JS.isInteger(x) && x >= 0 && x <= 170 { return factorials[Int(x)] }
  return gammaFn(x + 1)
}

/// The signed angle turning from arm u to arm v, counterclockwise positive,
/// in (−π, π]; NaN for a zero arm (lib/expr.ts `angleFn`).
func angleFn(_ u0: Double, _ u1: Double, _ v0: Double, _ v1: Double) -> Double {
  let su = JS.max([abs(u0), abs(u1)])
  let sv = JS.max([abs(v0), abs(v1)])
  if !(su > 0 && sv > 0) { return .nan }
  let a0 = u0 / su
  let a1 = u1 / su
  let b0 = v0 / sv
  let b1 = v1 / sv
  let cross = a0 * b1 - a1 * b0
  let dot = a0 * b0 + a1 * b1
  if cross == 0 { return dot < 0 ? Double.pi : dot > 0 ? 0 : .nan }
  return atan2(cross, dot)
}

/// (v × w)/|v|²: how fast the direction of arm v turns when v moves with velocity w.
func angleRateFn(_ v0: Double, _ v1: Double, _ w0: Double, _ w1: Double) -> Double {
  let s = JS.max([abs(v0), abs(v1)])
  if !(s > 0) { return .nan }
  let a0 = v0 / s
  let a1 = v1 / s
  return (a0 * (w1 / s) - a1 * (w0 / s)) / (a0 * a0 + a1 * a1)
}

let angleFnName = "[angle]"
let angleRateFnName = "[angle′]"
/// The member a guard leaves where no case holds: evaluates to NaN.
let noneFnName = "[none]"

/// The builtins `evaluate` runs (lib/expr.ts `EVAL_FNS`), for the elementary
/// set. A missing argument is JavaScript's `undefined`, which is NaN to
/// arithmetic; extra arguments are ignored.
let evalFunctions: [String: @Sendable ([Double]) -> Double] = {
  func one(_ f: @escaping @Sendable (Double) -> Double) -> @Sendable ([Double]) -> Double {
    { xs in f(xs.first ?? .nan) }
  }
  func two(_ f: @escaping @Sendable (Double, Double) -> Double) -> @Sendable ([Double]) -> Double {
    { xs in f(xs.count > 0 ? xs[0] : .nan, xs.count > 1 ? xs[1] : .nan) }
  }
  @Sendable func arg(_ xs: [Double], _ k: Int) -> Double { xs.count > k ? xs[k] : .nan }
  var fns: [String: @Sendable ([Double]) -> Double] = [
    "sin": one { sin($0) }, "cos": one { cos($0) }, "tan": one { tan($0) },
    "asin": one { asin($0) }, "acos": one { acos($0) }, "atan": one { atan($0) },
    "atan2": two { atan2($0, $1) },
    "sinh": one { sinh($0) }, "cosh": one { cosh($0) }, "tanh": one { tanh($0) },
    "sech": one { 1 / cosh($0) },
    "asinh": one { asinh($0) }, "acosh": one { acosh($0) }, "atanh": one { atanh($0) },
    "sqrt": one { $0.squareRoot() }, "abs": one { abs($0) }, "exp": one { exp($0) },
    "ln": one { log($0) }, "log": one { log10($0) },
    "floor": one { $0.rounded(.down) }, "ceil": one { $0.rounded(.up) },
    "round": one { JS.round($0) }, "sign": one { JS.sign($0) },
    "min": { JS.min($0) }, "max": { JS.max($0) },
    "mod": two { a, b in a - (a / b).rounded(.down) * b },
    "fract": one { $0 - $0.rounded(.down) },
    "erf": one { erfFn($0) },
    "gamma": one { gammaFn($0) }, "factorial": one { factorialFn($0) },
    "sinc": one { $0 == 0 ? 1 : sin($0) / $0 },
    "coth": one { 1 / tanh($0) },
  ]
  fns[noneFnName] = { _ in .nan }
  fns["normalpdf"] = { xs in normalpdf(arg(xs, 0), arg(xs, 1), arg(xs, 2)) }
  fns["normalcdf"] = { xs in normalcdf(arg(xs, 0), arg(xs, 1), arg(xs, 2)) }
  fns["gcd"] = two { a, b in
    var a = abs(JS.round(a))
    var b = abs(JS.round(b))
    while b != 0 && !b.isNaN {
      let t = fmod(a, b)
      a = b
      b = t
    }
    return a
  }
  fns["isprime"] = one { x in
    let n = JS.round(x)
    if !x.isFinite || abs(x - n) > 1e-6 || n < 2 { return 0 }
    // Past the shared trial-division limit the answer is unknown, not prime.
    if n > isprimeMax { return .nan }
    var i = 2.0
    while i * i <= n {
      if fmod(n, i) == 0 { return 0 }
      i += 1
    }
    return 1
  }
  fns[angleFnName] = { xs in angleFn(arg(xs, 0), arg(xs, 1), arg(xs, 2), arg(xs, 3)) }
  fns[angleRateFnName] = { xs in angleRateFn(arg(xs, 0), arg(xs, 1), arg(xs, 2), arg(xs, 3)) }
  return fns
}()

// MARK: - evaluate

/// How many terms one Σ/Π may run.
let sumMaxTerms = 500

/// Why a node that only exists between passes cannot be read as a number.
func structuralDiagnostic(_ e: Expr) -> String {
  switch e {
  case .range: "'..' ranges only appear in sum(n=1..N, …), prod(…), int[a..b], or a list like [1..10]."
  case .index: "List indexing must resolve before scalar evaluation."
  case .eqtest(let op, _, _): "'\(op.rawValue)' tests a list inside a filter."
  default: "(…) must be the whole expression."
  }
}

/// A piecewise condition that is not one, by name when it has one.
func notACondition(_ cond: Expr) -> LanguageError {
  let named: String? =
    switch cond {
    case .var(let name): name
    case .call(let name, _): "\(name)(…)"
    default: nil
    }
  return LanguageError(
    named.map { "\($0) is not a condition; piecewise conditions are inequalities, like x < 0." }
      ?? "Piecewise conditions must be inequalities, like x < 0.")
}

/// Σ/Π left for evaluate() because a bound uses a sequence index.
private func evalReduce(_ name: String, _ args: [Expr], _ index: String, _ env: inout [String: Double]) throws -> Double
{
  let sym = name == "sum" ? "Σ" : "Π"
  let lo = try evaluate(args[1], &env)
  let hi = try evaluate(args[2], &env)
  if !lo.isFinite || !hi.isFinite { throw LanguageError("\(sym) bound is not finite.") }
  let start = (lo - 1e-9).rounded(.up)
  let end = (hi + 1e-9).rounded(.down)
  let count = end - start + 1
  if count > Double(sumMaxTerms) {
    throw LanguageError("\(sym) expands to \(JS.string(count)) terms (limit \(sumMaxTerms)).")
  }
  let previous = env[index]
  defer { env[index] = previous }
  var acc: Double = name == "sum" ? 0 : 1
  var k = start
  while k <= end {
    env[index] = k
    let term = try evaluate(args[3], &env)
    acc = name == "sum" ? acc + term : acc * term
    k += 1
  }
  return acc
}

/// Numerically evaluate a scalar expression with the given variable bindings
/// (lib/expr.ts `evaluate`).
public func evaluate(_ e: Expr, _ env: [String: Double]) throws -> Double {
  var scope = env
  return try evaluate(e, &scope)
}

func evaluate(_ e: Expr, _ env: inout [String: Double]) throws -> Double {
  switch e {
  case .num(let value):
    return value
  case .var(let name):
    guard let value = env[name] else { throw LanguageError("Unbound variable: \(name)") }
    return value
  case .neg(let a):
    return -(try evaluate(a, &env))
  case .bin(let op, let lhs, let rhs, _):
    let a = try evaluate(lhs, &env)
    let b = try evaluate(rhs, &env)
    switch op {
    case .add: return a + b
    case .sub: return a - b
    case .mul: return a * b
    case .div: return a / b
    case .pow: return realPow(a, b)
    }
  case .call(let name, let args):
    if let index = boundSumIndex(e) { return try evalReduce(name, args, index, &env) }
    guard let fn = evalFunctions[name] else {
      if name == intervalFnName {
        throw LanguageError(
          "An interval is a range of numbers, not one value: draw it in a row of its own, in a tuple, or beside x and y."
        )
      }
      throw LanguageError("Unknown function: \(name)")
    }
    var values: [Double] = []
    for a in args { values.append(try evaluate(a, &env)) }
    return fn(values)
  case .eq(let l, let r):
    return try evaluate(l, &env) - evaluate(r, &env)
  case .index, .range, .eqtest:
    throw LanguageError(structuralDiagnostic(e))
  case .ineq:
    throw LanguageError("Cannot evaluate an inequality.")
  case .vec:
    throw LanguageError("Vector in scalar context.")
  case .list:
    throw LanguageError("List in scalar context.")
  case .str:
    throw LanguageError("Text has no numeric value — it can only be compared, inside a filter.")
  case .piecewise(let cases, let otherwise):
    for c in cases {
      guard case .ineq = c.cond else { throw notACondition(c.cond) }
      var holds = true
      for (op, l, r) in ineqComparisons(c.cond) {
        let a = try evaluate(l, &env)
        let b = try evaluate(r, &env)
        let ok =
          switch op {
          case .lt: a < b
          case .le: a <= b
          case .gt: a > b
          case .ge: a >= b
          }
        if !ok {
          holds = false
          break
        }
      }
      if holds { return try evaluate(c.value, &env) }
    }
    return try otherwise.map { try evaluate($0, &env) } ?? .nan
  }
}

/// A continuous interval's hidden parameter (lib/interval.ts): not an identifier.
let intervalFnName = "[interval]"
