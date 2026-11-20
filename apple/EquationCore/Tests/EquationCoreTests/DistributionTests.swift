import Testing

@testable import EquationCore

/// The probability rows the port reads (AnalysisDistributions.swift): what
/// the corpus compares row by row against the site, held here by a few rows
/// that must stay in reach, and the parts no fixture carries.
@Suite struct Distributions {
  @Test func declarationsDrawTheirLaw() {
    let rows = [
      "a = 1", "X ~ Normal(0, a)", "P(X < 0.5)", "E(X)", "Y = 2 X + 1", "N ~ Binomial(10, 0.3)", "P(N <= 3)",
      "U ~ Uniform(0, 1)", "V ~ Uniform(0, 1)", "U + V", "P(U + V > 1.5)",
    ]
    let analysis = analyze(rows)
    for (row, text) in zip(analysis.rows, rows) {
      #expect(row.unsupported == nil, "\(text)")
      #expect(row.error == nil, "\(text)")
    }
    #expect(analysis.rows.map(\.dist) == [
      nil, .density, .probability, .expectation, .density, .pmf, .probability, .density, .density, .density,
      .probability,
    ])
    #expect(analysis.rows.map { $0.cpu?.type } == [
      nil, "implicit2d", "ineq2d", "expect", "implicit2d", "pmf", "prob", "implicit2d", "implicit2d", "density",
      "prob",
    ])
    #expect(analysis.rows[2].info == "≈ 0.6915")
    #expect(analysis.rows[6].info == "≈ 0.6496")
    #expect(analysis.rows[10].info == "≈ 0.1250")
    // A derived row is no definition, and a slider drives the density's uniform.
    #expect(analysis.rows[4].definition == nil)
    #expect(analysis.rows[1].gpu?.params == ["a"])
    #expect(analysis.random.has("X") && analysis.random.has("@9"))
  }

  @Test func whatIsNotPortedSaysSo() {
    // Quadrature, enumeration and the joint sample; and a fit, which needs lists.
    let rows = ["X ~ Normal(0, 1)", "Y = sin(X)", "E(X^3)", "P(X > Y)", "D ~ Poisson(2)", "D^2", "L ~ m X + b"]
    let analysis = analyze(rows)
    #expect(analysis.rows.map { $0.unsupported != nil } == [false, true, true, true, false, true, false])
    #expect(analyze(["L = 2", "L ~ m x + b", "y = m x"]).rows.map { $0.unsupported != nil } == [true, true, true])
  }

  @Test func stemsFollowTheView() throws {
    let analysis = analyze(["N ~ Binomial(10, 0.3)", "P(2 < N <= 4)", "M ~ Poisson(1000000)"])
    let all = try #require(try analysis.random.pmfRuns("N", [:]))
    #expect(all.count == 1 && all[0].ks == (0...10).map(Double.init) && !all[0].envelope)
    #expect(abs(all[0].ps.reduce(0, +) - 1) < 1e-12)
    let windowed = try #require(try analysis.random.pmfRuns("N", [:], view: (2.5, 6.2)))
    #expect(windowed[0].ks == [3, 4, 5, 6])
    guard case .prob(_, let shade?)? = analysis.rows[1].cpu else {
      Issue.record("P(2 < N <= 4) shades N")
      return
    }
    let selected = try #require(try analysis.random.pmfRuns("N", [:], select: shade.bounds))
    #expect(selected.map(\.ks) == [[3, 4]])
    // More whole numbers in view than stems to draw: the envelope, with the mode on it.
    let wide = try #require(try analysis.random.pmfRuns("M", [:]))
    #expect(wide[0].envelope && wide[0].ks.count <= 1030 && wide[0].ks.contains(1_000_000))
    let geometry = stemGeometry(all[0], heavy: false, pxPerUnit: 40)
    #expect(geometry.lines.count == 11 * 6 && geometry.dots?.r == 3.5 && geometry.fill == nil)
  }

  @Test func uniformSumsAreExact() throws {
    let analysis = analyze(["X ~ Uniform(0, 1)", "Y ~ Uniform(0, 1)", "S = X + Y", "E(S)"])
    let curve = try #require(try analysis.random.curve("S", [:]))
    #expect(curve.mean == 1 && abs(curve.sd - (1.0 / 6).squareRoot()) < 1e-15)
    // The triangle: 0 at 0 and 2, 1 at 1.
    #expect(curve.density(at: 1) == 1 && curve.density(at: 0.5) == 0.5 && curve.density(at: 3) == 0)
    #expect(curve.shadePolygon(lo: 1.5, hi: nil)?.prefix(4) == [1.5, 0, 1.5, 0.5])
    let mark = try #require(try analysis.random.markerHeight("S", [:]))
    #expect(mark.x == 1 && mark.h == 1)
  }
}
