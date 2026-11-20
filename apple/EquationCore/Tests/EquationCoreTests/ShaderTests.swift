import Testing

@testable import EquationCore

@Suite struct Shader {
  private func field(_ text: String) throws -> String {
    try toGLSL(try parseExpr(text))
  }

  @Test func equationsAreTheirDifference() throws {
    #expect(try field("y = sin(x)") == "(y - (sin(x)))")
    #expect(try field("x^2 + y^2 = 1") == "(((x*x) + (y*y)) - (1.0))")
  }

  @Test func powers() throws {
    #expect(try field("x^3") == "(x*x*x)")
    #expect(try field("(x + 1)^2") == "eq_sq((x + 1.0))")
    #expect(try field("(x + 1)^5") == "eq_ipow((x + 1.0), 5)")
    #expect(try field("x^0.5") == "eq_pow(x, 0.5)")
    #expect(try field("x^y") == "eq_pow(x, y)")
  }

  @Test func functionsTakeTheirShaderNames() throws {
    #expect(try field("ln(x) + log(x)") == "(log(x) + eq_log10(x))")
    #expect(try field("mod(x, 2)") == "mod(x, 2.0)")
    #expect(try field("max(x, y, 0)") == "max(max(x, y), 0.0)")
  }

  @Test func piecewiseIsATernary() throws {
    #expect(try field("{0 < x < 1: x, 2}") == "(((0.0 < x) && (x < 1.0)) ? x : 2.0)")
    #expect(try field("{x > 0: x}") == "(((x > 0.0)) ? x : EQ_NAN)")
  }

  @Test func rowsTheMetalRendererDraws() {
    #expect(plotRow("") == .nothing)
    #expect(plotRow("  # a heading") == .nothing)
    #expect(plotRow("y = sin(x)") == .curve(field: "(y - (sin(x)))", animated: false))
    #expect(plotRow("y = sin(x - t)") == .curve(field: "(y - (sin((x - t))))", animated: true))
    #expect(plotRow("x = 2") == .curve(field: "(x - (2.0))", animated: false))
  }

  @Test func rowsLeftToTheWebRenderer() {
    // A slider's constant, a definition, a surface, a field, a point, a list.
    for row in ["a = 2", "y = a x", "z = x y", "sin(x)", "(1, 2)", "y = [1, 2] x", "y < x", "y = ("] {
      #expect(plotRow(row) == nil, "\(row)")
    }
  }
}
