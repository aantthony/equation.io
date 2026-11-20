import CoreGraphics
import Foundation
import Metal
import Testing

@testable import EquationCore
@testable import EquationRender

/// The loop helpers a row compiles to (recursive functions, Fourier sums)
/// are linked into the fragment that names them, and their coefficient
/// tables reach the shader: web/gl.ts `compileProgram`.
@Suite struct HelperLink {
  private func picture(_ rows: [String], _ metal: MetalContext) throws -> [UInt8] {
    let analysis = analyze(rows)
    for (row, text) in zip(analysis.rows, rows) {
      #expect(row.error == nil && row.unsupported == nil, "\(text): \(row.error ?? row.unsupported ?? "")")
    }
    let colors = analysis.rows.map { $0.takesColor ? Optional(RGB(0.9, 0.1, 0.1)) : nil }
    let scene = Graph2D(analysis, colors: colors).scene(at: 0, width: 320, height: 240)
    let image = try #require(metal.image(of: scene, width: 320, height: 240, dpr: 1, theme: .light))
    let data = try #require(image.dataProvider?.data)
    return [UInt8](data as Data)
  }

  /// The share of bytes two pictures differ in by more than a little.
  private func difference(_ a: [UInt8], _ b: [UInt8]) -> Double {
    guard a.count == b.count, !a.isEmpty else { return 1 }
    let far = zip(a, b).reduce(0) { $0 + (abs(Int($1.0) - Int($1.1)) > 24 ? 1 : 0) }
    return Double(far) / Double(a.count)
  }

  @Test func recursiveFunctionsDraw() throws {
    let metal = try #require(MetalContext())
    // A loop over a slider (a uniform the helper takes as a parameter), over
    // complex state, and one loop inside another's exit.
    let rows = [
      "a = 30", "g(z, c, k) = {abs(z) > 2: k, k >= a: k, g(z^2 + c, c, k + 1)}", "rgb(g(0, w, 0)/a, 0.2, 0.4)",
      "y = g(0, x, 0)/10", "f(n) = {n <= 0: 0, f(n - 1)}", "h(n) = {n <= 0: f(n) + a, h(n - 1)}", "y < h(x) - 31",
    ]
    let drawn = try picture(rows, metal)
    #expect(metal.failures == 0)
    // The escape count the loop returns is what the field is coloured by:
    // without it the row is one flat colour.
    let flat = try picture(["rgb(0.5, 0.2, 0.4)"], metal)
    #expect(difference(drawn, flat) > 0.01)
    #expect(metal.failures == 0)
  }

  @Test func fourierTablesAreUploaded() throws {
    let metal = try #require(MetalContext())
    let gated = try picture(
      [
        "N = 4",
        "y = 1 + {N >= 1: 2 cos(3 x), 0} + {N >= 2: 0.5 sin(6 x), 0} + {N >= 3: cos(9 x) + sin(9 x), 0}"
          + " + {N >= 4: 0.25 cos(12 x), 0}",
      ], metal)
    let written = try picture(["y = 1 + 2 cos(3 x) + 0.5 sin(6 x) + cos(9 x) + sin(9 x) + 0.25 cos(12 x)"], metal)
    let constant = try picture(["y = 1"], metal)
    #expect(metal.failures == 0)
    // The series its table spells, not the offset alone a table of zeros would leave.
    // (The gated curve is drawn from its analytic slope, the written one from
    // differences, so their edges are not the same to the pixel.)
    #expect(difference(gated, constant) > 0.01)
    #expect(difference(gated, written) < difference(gated, constant) / 4)
  }

  @Test func helpersLinkAfterThePrelude() throws {
    let call = try compileTyped(
      .loop(
        params: ["k"], seeds: [.var("x")],
        body: .piecewise(
          [Expr.Case(cond: .ineq(.ge, .var("k"), .var("u_a")), value: .var("k"))],
          otherwise: .call(RECUR, [.bin(.add, .var("k"), .num(1))])), limit: 9))
    let frag = curveFrag("(y - \(call.code))", params: ["a"])
    let linked = try linkHelpers(frag)
    #expect(linked.tables.isEmpty)
    // Declared once, after the prelude, with the uniform it takes as a parameter respelled.
    #expect(linked.source.contains("float eq_loop_"))
    #expect(linked.source.contains("float eqv_a)"))
    #expect(linked.source.hasSuffix(String(frag.suffix(200))))
    // A shader that names no helper is left as it is.
    #expect(try linkHelpers("void main() {}").source == "void main() {}")
    #expect(throws: ShaderError.self) { try linkHelpers("float f() { return eq_loop_0123abcd(1.0); }") }
  }
}
