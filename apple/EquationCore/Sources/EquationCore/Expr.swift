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
