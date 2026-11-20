import Testing

@testable import EquationCore

/// Complex numbers, fractals, colour fields and recursive functions must not
/// slip out of the port's reach: what each comes to is the conformance
/// suite's to check (AnalysisConformanceTests), that each is read at all is
/// checked here.
@Suite struct ComplexRows {
  @Test func rowsAreSupported() {
    let rows = [
      "a = e^(i pi/3)", "a^2", "ln(w - a) - ln(w + a)", "domain((w^3 - 1)/w)", "conformal(w + 1/w)",
      "iter(z^2 + w)", "iter(z^2 + a, 80)", "hsl(arg(w) + t/3, 1, 0.5)", "exp(i 2 pi u)", "im(ln(w)) = 1",
      "f(n, acc) = {n <= 1: acc, f(n - 1, n acc)}", "f(5, 1)", "y = f(floor(x), 1)", "i^2 = -1",
    ]
    let analysis = analyze(rows)
    for (row, text) in zip(analysis.rows, rows) {
      #expect(row.unsupported == nil, "\(text)")
      #expect(row.error == nil, "\(text)")
    }
    let types = analysis.rows.map { $0.cpu?.type }
    #expect(
      types == [
        nil, "point", "complex2d", "domain2d", "conformal2d", "fractal2d", "fractal2d", "hsl2d", "pcurve",
        "implicit2d", nil, "value", "implicit2d", "note",
      ])
    #expect(analysis.rows[11].info == "= 120")
    #expect(analysis.rows[13].info == "Always true (-1 = -1)")
    // A complex constant is no uniform: it is written into the rows that read it.
    #expect(analysis.env.isEmpty)
    #expect(analysis.rows[2].gpu?.params == [])
  }

  @Test func loopsCompileToHelpers() throws {
    let analysis = analyze(["g(z, c, k) = {abs(z) > 2: k, k >= 20: k, g(z^2 + c, c, k + 1)}", "y = g(0, x + i, 0)"])
    guard case .implicit2d(let field, _)? = analysis.rows[1].gpu?.shader else {
      Issue.record("not a curve: \(analysis.rows[1])")
      return
    }
    #expect(field.contains("eq_loop_"))
    // z and c are complex once a pass hands them a complex value; k stays real.
    let linked = try withHelpers(glslPrelude + field)
    #expect(linked.contains("(vec2 p0_0, vec2 p0_1, float p0_2)"))
  }

  @Test func whatTypingRefuses() {
    let cases: [(String, String)] = [
      ("rgb(w, 0, 0)", "rgb channels must be real numbers; use re, im, abs, or arg for complex values."),
      ("1 + domain(w)", "domain(…) must be the whole expression."),
      ("domain(x)", "domain(…) needs a complex expression — use w for x + iy."),
      ("(1, i)", "Complex values are not supported in vectors."),
      ("w < 1", "Complex inequality: compare re(…) or im(…) instead."),
    ]
    for (text, message) in cases {
      #expect(analyze([text]).rows[0].error == message, "\(text)")
    }
    let recursion = analyze(["f(n) = n f(n - 1)"]).rows[0].error
    #expect(recursion == "f can only call itself as a whole case of {…}, like f(n) = {n <= 1: 1, f(n - 1)}.")
  }
}
