/// The symbolic expression tree (lib/expr.ts `Expr`).
///
/// Only the kinds the parser produces live here so far; the lowering-only
/// kinds (figure, data, lazy, loop, …) arrive with the resolver.
public indirect enum Expr: Equatable, Sendable {
  case num(Double)
  case `var`(String)
  case bin(BinOp, Expr, Expr, glyph: ProductGlyph? = nil)
  case neg(Expr)
  case call(String, [Expr])
  case index(Expr, Expr)
  case range(Expr, Expr)
  case eqtest(EqTestOp, Expr, Expr)
  case eq(Expr, Expr)
  /// Chains nest left: 0 < y < x is ((0 < y) < x). `grouped` marks one written in parentheses.
  case ineq(IneqOp, Expr, Expr, grouped: Bool = false)
  case vec([Expr])
  case list([Expr])
  case str(String)
  case piecewise([Case], otherwise: Expr?)

  public struct Case: Equatable, Sendable {
    public var cond: Expr
    public var value: Expr
    /// A condition written without a value (`{x > 0, …}`), whose value is 1.
    public var bare: Bool

    public init(cond: Expr, value: Expr, bare: Bool = false) {
      self.cond = cond
      self.value = value
      self.bare = bare
    }
  }
}

public enum BinOp: String, Sendable {
  case add = "+", sub = "-", mul = "*", div = "/", pow = "^"
}

public enum IneqOp: String, Sendable {
  case lt = "<", le = "<=", gt = ">", ge = ">="
}

public enum EqTestOp: String, Sendable {
  case eq = "==", ne = "!="
}

/// How a product was written: between vectors, tensors or multivectors the
/// glyph picks the product; between numbers it is plain multiplication.
public enum ProductGlyph: String, Sendable {
  case dot, cross, outer, wedge, geometric
}

/// Flatten a (possibly chained) inequality into its comparisons; comparison k
/// compares the previous comparison's right side, so 0 < y < x yields
/// [0 < y, y < x] (lib/expr.ts `ineqComparisons`). Empty unless `e` is an ineq.
func ineqComparisons(_ e: Expr) -> [(op: IneqOp, l: Expr, r: Expr)] {
  var chain: [(op: IneqOp, l: Expr, r: Expr)] = []
  var node = e
  while case .ineq(let op, let l, let r, _) = node {
    chain.insert((op, l, r), at: 0)
    node = l
  }
  return chain.indices.map { k in (chain[k].op, k == 0 ? chain[k].l : chain[k - 1].r, chain[k].r) }
}

/// What a node that only lowering reads says when it reaches scalar code
/// (lib/expr.ts `structuralDiagnostic`), for the kinds this Expr has.
func structuralDiagnostic(_ e: Expr) -> String {
  switch e {
  case .range: "'..' ranges only appear in sum(n=1..N, …), prod(…), int[a..b], or a list like [1..10]."
  case .index: "List indexing must resolve before scalar evaluation."
  case .eqtest(let op, _, _): "'\(op.rawValue)' tests a list inside a filter."
  default: "(…) must be the whole expression."
  }
}

/// A piecewise condition that is not one, by name when it has one
/// (lib/expr.ts `notACondition`, which makes the Error; this is its message).
func notACondition(_ cond: Expr) -> String {
  switch cond {
  case .var(let name): "\(name) is not a condition; piecewise conditions are inequalities, like x < 0."
  case .call(let name, _): "\(name)(…) is not a condition; piecewise conditions are inequalities, like x < 0."
  default: "Piecewise conditions must be inequalities, like x < 0."
  }
}

/// Whether two trees have the same `exprKey` (lib/expr.ts: their JSON text).
/// That is equality, except that JSON spells every non-finite number `null`,
/// so NaN and ±∞ are one value there (and -0 is 0, as it is to ==).
func sameExprKey(_ a: Expr, _ b: Expr) -> Bool {
  func same(_ a: [Expr], _ b: [Expr]) -> Bool {
    a.count == b.count && zip(a, b).allSatisfy { sameExprKey($0, $1) }
  }
  switch (a, b) {
  case (.num(let x), .num(let y)):
    return x.isFinite ? x == y : !y.isFinite
  case (.var(let x), .var(let y)), (.str(let x), .str(let y)):
    return x == y
  case (.bin(let op1, let a1, let b1, let g1), .bin(let op2, let a2, let b2, let g2)):
    return op1 == op2 && g1 == g2 && sameExprKey(a1, a2) && sameExprKey(b1, b2)
  case (.neg(let x), .neg(let y)):
    return sameExprKey(x, y)
  case (.call(let n1, let x), .call(let n2, let y)):
    return n1 == n2 && same(x, y)
  case (.index(let a1, let b1), .index(let a2, let b2)), (.range(let a1, let b1), .range(let a2, let b2)),
    (.eq(let a1, let b1), .eq(let a2, let b2)):
    return sameExprKey(a1, a2) && sameExprKey(b1, b2)
  case (.eqtest(let op1, let a1, let b1), .eqtest(let op2, let a2, let b2)):
    return op1 == op2 && sameExprKey(a1, a2) && sameExprKey(b1, b2)
  case (.ineq(let op1, let a1, let b1, let g1), .ineq(let op2, let a2, let b2, let g2)):
    return op1 == op2 && g1 == g2 && sameExprKey(a1, a2) && sameExprKey(b1, b2)
  case (.vec(let x), .vec(let y)), (.list(let x), .list(let y)):
    return same(x, y)
  case (.piecewise(let c1, let o1), .piecewise(let c2, let o2)):
    guard c1.count == c2.count, (o1 == nil) == (o2 == nil) else { return false }
    if let o1, let o2, !sameExprKey(o1, o2) { return false }
    return zip(c1, c2).allSatisfy {
      $0.bare == $1.bare && sameExprKey($0.cond, $1.cond) && sameExprKey($0.value, $1.value)
    }
  default:
    return false
  }
}

/// Collect free variable names, excluding function names and constants
/// (lib/expr.ts `freeVars`). The index of a Σ/Π that survived resolve —
/// args [index, lo, hi, body] — is bound in its body.
func freeVars(_ e: Expr, into names: inout Set<String>) {
  switch e {
  case .num, .str:
    break
  case .var(let name):
    names.insert(name)
  case .neg(let a):
    freeVars(a, into: &names)
  case .bin(_, let a, let b, _), .index(let a, let b), .range(let a, let b), .eqtest(_, let a, let b),
    .eq(let a, let b), .ineq(_, let a, let b, _):
    freeVars(a, into: &names)
    freeVars(b, into: &names)
  case .call(let name, let args):
    if name == "sum" || name == "prod", args.count >= 4, case .var(let index) = args[0] {
      freeVars(args[1], into: &names)
      freeVars(args[2], into: &names)
      var inner: Set<String> = []
      freeVars(args[3], into: &inner)
      inner.remove(index)
      names.formUnion(inner)
      break
    }
    for arg in args { freeVars(arg, into: &names) }
  case .vec(let items), .list(let items):
    for item in items { freeVars(item, into: &names) }
  case .piecewise(let cases, let otherwise):
    for c in cases {
      freeVars(c.cond, into: &names)
      freeVars(c.value, into: &names)
    }
    if let otherwise { freeVars(otherwise, into: &names) }
  }
}

/// JavaScript's `String(number)` (ECMAScript Number::toString, radix 10):
/// the shortest digits that read back as the same double, written plainly
/// from 1e-6 up to 1e21 and with an exponent (`1e+21`, `1.5e-7`) outside.
/// Swift's description finds the same digits; only the layout differs.
func jsNumberString(_ value: Double) -> String {
  if value.isNaN { return "NaN" }
  if value == 0 { return "0" }
  if value < 0 { return "-" + jsNumberString(-value) }
  if value.isInfinite { return "Infinity" }
  // Swift writes 123.456, 1e-05, 1.2345e+20: digits with a point, and maybe an exponent.
  var digits: [UInt8] = []
  var point: Int?
  var exponent = 0
  let text = Array(value.description.utf8)
  var i = 0
  while i < text.count, text[i] != UInt8(ascii: "e") {
    if text[i] == UInt8(ascii: ".") { point = digits.count } else { digits.append(text[i]) }
    i += 1
  }
  if i < text.count {
    let negative = text[i + 1] == UInt8(ascii: "-")
    for c in text[(i + 1)...] where c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9") {
      exponent = exponent * 10 + Int(c - UInt8(ascii: "0"))
    }
    if negative { exponent = -exponent }
  }
  // The value is 0.d₁d₂…d_k × 10ⁿ, with d₁ and d_k not zero.
  var n = (point ?? digits.count) + exponent
  while digits.first == UInt8(ascii: "0") {
    digits.removeFirst()
    n -= 1
  }
  while digits.last == UInt8(ascii: "0") { digits.removeLast() }
  let k = digits.count
  func str(_ bytes: some Sequence<UInt8>) -> String { String(decoding: Array(bytes), as: UTF8.self) }
  let zeros = { (count: Int) in String(repeating: "0", count: count) }
  if k <= n && n <= 21 { return str(digits) + zeros(n - k) }
  if 0 < n && n <= 21 { return str(digits[..<n]) + "." + str(digits[n...]) }
  if -6 < n && n <= 0 { return "0." + zeros(-n) + str(digits) }
  let e = n - 1
  let power = (e < 0 ? "e-" : "e+") + "\(abs(e))"
  return k == 1 ? str(digits) + power : str(digits[..<1]) + "." + str(digits[1...]) + power
}
