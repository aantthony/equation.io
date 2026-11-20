import Foundation
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
    // Quadrature and the joint sample, which stands in for an enumeration past its cap too.
    let rows = ["X ~ Normal(0, 1)", "Y = sin(X)", "E(X^3)", "P(X > Y)", "D ~ Geometric(0.000001)", "D^2", "L ~ m X + b"]
    let analysis = analyze(rows)
    #expect(analysis.rows.map { $0.unsupported != nil } == [false, true, true, true, false, true, false])
    // A fit runs over lists.
    #expect(analyze(["L = 2", "L ~ m x + b", "y = m x"]).rows.map { $0.unsupported != nil } == [true, true, true])
  }

  @Test func discreteArithmeticIsEnumerated() throws {
    let rows = ["D ~ DiscreteUniform(1, 6)", "F ~ DiscreteUniform(1, 6)", "S = D + F", "P(D > F)", "D / 2", "E(D^2)"]
    let analysis = analyze(rows)
    #expect(analysis.rows.map(\.info) == [nil, nil, "μ = 7, σ = 2.41523", "≈ 0.4167", "μ = 1.75, σ = 0.853913", "≈ 15.1667"])
    let sum = try #require(try analysis.random.pmfOf("S", [:]))
    #expect(sum.xs == (2...12).map(Double.init) && abs(sum.ps[5] - 1.0 / 6) < 1e-15)
    // Atoms stand where the arithmetic puts them: every half from ½ to 3.
    let halves = try #require(try analysis.random.pmfRuns("@4", [:]))
    #expect(halves.count == 1 && halves[0].ks == [0.5, 1, 1.5, 2, 2.5, 3] && halves[0].step == 0.5)
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

// MARK: - What is drawn of a law, against the site's

/// Equal, or within what two libms' exp and log leave of a mass.
private func near(_ a: Double, _ b: Double) -> Bool {
  if a.isNaN || b.isNaN { return a.isNaN && b.isNaN }
  return a == b || abs(a - b) <= 1e-11 * max(abs(a), abs(b))
}

private func near(_ a: [Double], _ b: [Double]) -> Bool {
  a.count == b.count && zip(a, b).allSatisfy { near($0, $1) }
}

/// How what the port draws of a density, pmf, prob or expect plan differs
/// from what lib/dist.ts hands web/main.ts for it (apple/corpus/analysis.ts
/// `drawnOf`): a pmf's stems, the whole law and through a window; the stems or
/// the polygon a P(…) row selects; a uniform sum's curve; an E(…) row's marker.
func drawnDifferences(_ plan: CpuPlan?, _ want: Any?, _ analysis: DocumentAnalysis) -> [String] {
  guard let plan, let want = want as? [String: Any] else { return [] }
  var env = analysis.env
  env["t"] = 0
  let rvs = analysis.random
  let window = (lo: -2.5, hi: 9.25)
  var out: [String] = []

  /// A value the site computed, the port's attempt at it, and how to compare the two.
  func check<T>(_ what: String, _ theirs: Any?, _ mine: () throws -> T?, same: (T, Any) -> Bool) {
    if theirs as? String == "unrecorded" { return }
    let got: T?
    do {
      got = try mine()
    } catch {
      if theirs as? String != "error" { out.append("drawn \(what): the port throws \(error), the site does not") }
      return
    }
    if theirs as? String == "error" {
      out.append("drawn \(what): the site throws, the port does not")
    } else if theirs == nil || theirs is NSNull {
      if let got { out.append("drawn \(what): the site draws nothing, the port \(got)") }
    } else if let got {
      if !same(got, theirs!) { out.append("drawn \(what): got \(got), want \(theirs!)") }
    } else {
      out.append("drawn \(what): the port draws nothing, the site \(theirs!)")
    }
  }
  func sameRuns(_ mine: [PmfStems], _ theirs: Any) -> Bool {
    guard let theirs = theirs as? [[String: Any]], theirs.count == mine.count else { return false }
    return zip(mine, theirs).allSatisfy { run, want in
      near(run.ks, (want["ks"] as! [Any]).map(number)) && near(run.ps, (want["ps"] as! [Any]).map(number))
        && run.envelope == want["envelope"] as! Bool
        && (run.step.map { near($0, number(want["step"]!)) } ?? (want["step"] is NSNull))
    }
  }
  func samePoints(_ mine: [Double], _ theirs: Any) -> Bool {
    (theirs as? [Any]).map { near(mine, $0.map(number)) } ?? false
  }

  switch plan {
  case .pmf(let rv, _):
    check("stems", want["all"], { try rvs.pmfRuns(rv, env) }, same: sameRuns)
    check("stems in a window", want["window"], { try rvs.pmfRuns(rv, env, view: window) }, same: sameRuns)
  case .density(let rv, _):
    check("curve", want["curve"], { try rvs.curve(rv, env) }) { curve, theirs in
      guard let theirs = theirs as? [String: Any] else { return false }
      return samePoints(curve.pts, theirs["pts"]!) && near(curve.mean, number(theirs["mean"]!))
        && near(curve.sd, number(theirs["sd"]!)) && near(curve.mass, number(theirs["mass"]!))
    }
  case .prob(_, let shade?):
    check("selection", want["all"], { try rvs.pmfRuns(shade.rv, env, select: shade.bounds) }, same: sameRuns)
    check(
      "selection in a window", want["window"],
      { try rvs.pmfRuns(shade.rv, env, view: window, select: shade.bounds) }, same: sameRuns)
    check(
      "shaded polygon", want["polygon"],
      {
        try rvs.curve(shade.rv, env)?.shadePolygon(
          lo: try shade.bounds.lo.map { try evaluate($0, env) }, hi: try shade.bounds.hi.map { try evaluate($0, env) })
      }, same: samePoints)
  case .expect(let rv):
    check("marker", want["mark"], { try rvs.markerHeight(rv, env) }) { mark, theirs in
      guard let theirs = theirs as? [String: Any] else { return false }
      return near(mark.x, number(theirs["x"]!)) && near(mark.h, number(theirs["h"]!))
    }
  default:
    break
  }
  return out
}
