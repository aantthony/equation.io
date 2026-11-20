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
    // As lib/glsl.ts spells any call: lowering has nested or refused it by then.
    #expect(try field("max(x, y, 0)") == "max(x, y, 0.0)")
    #expect(try field("mean(x)") == "mean(x)")
  }

  @Test func piecewiseIsATernary() throws {
    #expect(try field("{0 < x < 1: x, 2}") == "(((0.0 < x) && (x < 1.0)) ? x : 2.0)")
    #expect(try field("{x > 0: x}") == "(((x > 0.0)) ? x : EQ_NAN)")
  }
}
