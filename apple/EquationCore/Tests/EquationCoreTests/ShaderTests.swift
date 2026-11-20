import Testing

@testable import EquationCore

#if canImport(Metal)
  import Metal
#endif

@Suite struct Shader {
  private func field(_ text: String) throws -> String {
    try toMetal(try parseExpr(text))
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
    #expect(try field("mod(x, 2)") == "eq_mod(x, 2.0)")
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
    for row in ["a = 2", "y = a x", "z = x y", "sin(x)", "(1, 2)", "y = [1, 2] x", "y < x", "y = gamma(x)", "y = ("] {
      #expect(plotRow(row) == nil, "\(row)")
    }
  }

  #if canImport(Metal)
    /// Every function the emitter names is one the prelude or MSL defines.
    @Test func everyFunctionCompiles() throws {
      let device = try #require(MTLCreateSystemDefaultDevice())
      let calls = [
        "sin(x)", "cos(x)", "tan(x)", "asin(x)", "acos(x)", "atan(x)", "sinh(x)", "cosh(x)", "tanh(x)", "sech(x)",
        "coth(x)", "asinh(x)", "acosh(x)", "atanh(x)", "sqrt(x)", "abs(x)", "exp(x)", "ln(x)", "log(x)", "log2(x)",
        "floor(x)", "ceil(x)", "round(x)", "sign(x)", "fract(x)", "sinc(x)", "erf(x)", "atan2(y, x)", "mod(x, y)",
        "gcd(x, y)", "min(x, y, 1)", "max(x, 2)", "x^y", "(x + y)^2", "(x + y)^7", "{x > 0: x, y < 0 < x: 0.000001, -2}",
        "100000000000000000000 x - 0.1",
      ]
      let fields = try calls.map { try field("y = " + $0) }
      let source = """
        #include <metal_stdlib>
        using namespace metal;
        \(metalPrelude)
        \(fields.enumerated().map { "static float F\($0.offset)(float x, float y) { return \($0.element); }" }.joined(separator: "\n"))
        fragment float4 probe(float4 p [[position]]) {
          return float4(\(fields.indices.map { "F\($0)(p.x, p.y)" }.joined(separator: " + ")));
        }
        """
      let options = MTLCompileOptions()
      options.mathMode = .safe
      _ = try device.makeLibrary(source: source, options: options)
    }
  #endif
}
