import Metal
import Testing

@testable import EquationCore
@testable import EquationRender

@Suite struct ShaderCompile {
  /// Every function the emitter names is one the prelude or the GLSL names define.
  @Test func everyFunctionCompiles() throws {
    let metal = try #require(MetalContext())
    let calls = [
      "sin(x)", "cos(x)", "tan(x)", "asin(x)", "acos(x)", "atan(x)", "sinh(x)", "cosh(x)", "tanh(x)", "sech(x)",
      "coth(x)", "asinh(x)", "acosh(x)", "atanh(x)", "sqrt(x)", "abs(x)", "exp(x)", "ln(x)", "log(x)", "log2(x)",
      "floor(x)", "ceil(x)", "round(x)", "sign(x)", "fract(x)", "sinc(x)", "erf(x)", "atan2(y, x)", "mod(x, y)",
      "gcd(x, y)", "min(x, y)", "max(x, 2)", "x^y", "(x + y)^2", "(x + y)^7", "{x > 0: x, y < 0 < x: 0.000001, -2}",
      "100000000000000000000 x - 0.1", "gamma(x)", "factorial(x)", "isprime(x)",
    ]
    for call in calls {
      let field = try toGLSL(try parseExpr("y = " + call))
      _ = try metal.makeLibrary(translateFragment(curveFrag(field)).source)
    }
  }

  @Test func theGridCompiles() throws {
    let metal = try #require(MetalContext())
    let cartesian = [
      GridSpec(glsl: "x", gradGlsl: ["1.0", "0.0"], major: 1, minor: 0.2),
      GridSpec(glsl: "y", gradGlsl: ["0.0", "1.0"], major: 1, minor: 0.2),
    ]
    let polar = [
      GridSpec(glsl: "sqrt(x*x + y*y)", major: 1, minor: 0.2),
      GridSpec(glsl: "atan(y, x) * u_k", params: ["k"], major: 1, minor: 0.2),
    ]
    for specs in [cartesian, polar] {
      _ = try metal.makeLibrary(translateFragment(gridFrag(specs, theme: .dark)).source)
    }
  }

  @Test func uniformsTakeSlots() {
    let shader = translateFragment(
      """
      #version 300 es
      precision highp float;
      uniform vec2 uCenter;
      uniform float u_a;
      uniform vec3 uTint;
      out vec4 outColor;
      void helper(out float a, inout vec2 b) { a = 1.0; }
      void main() { outColor = vec4(uTint, u_a); }
      """)
    #expect(shader.count == 4)
    #expect(shader.slots["u_a"]?.offset == 0)
    #expect(shader.slots["uTint"]?.offset == 1)
    #expect(shader.slots["uCenter"] == nil)
    #expect(shader.source.contains("void helper(thread float &a, thread vec2 &b)"))
  }
}
