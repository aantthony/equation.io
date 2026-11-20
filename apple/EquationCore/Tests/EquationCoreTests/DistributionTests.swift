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

  @Test func whatHasNoLawIsApproximated() throws {
    // Quadrature and the joint sample, which stands in for an enumeration past its cap too.
    let rows = ["X ~ Normal(0, 1)", "Y = sin(X)", "E(X^2)", "P(X > Y)", "D ~ Geometric(0.000001)", "D^2", "L ~ m X + b"]
    let analysis = analyze(rows)
    #expect(analysis.rows.map { $0.unsupported != nil } == [false, false, false, false, false, false, false])
    #expect(analysis.rows[2].info == "≈ 1.0000" && analysis.rows[3].info == "≈ 0.500")
    #expect(analysis.rows[5].info?.hasSuffix("(sampled)") == true)
    // sin of a normal: a curve on [-1, 1] with all of the mass under it.
    let curve = try #require(try analysis.random.curve("Y", [:]))
    #expect(abs(curve.pts[0] + 1) < 1e-6 && curve.mass == 1 && abs(curve.mean) < 1e-12 && curve.atoms == nil)
    var area = 0.0
    for i in stride(from: 0, to: curve.pts.count - 3, by: 2) {
      area += (curve.pts[i + 1] + curve.pts[i + 3]) / 2 * (curve.pts[i + 2] - curve.pts[i])
    }
    #expect(abs(area - 1) < 1e-3)
    // A fit is a definition of its coefficients; one that fails says why, as the site does.
    let fit = analyze(["L = [1, 2, 4]", "L ~ m [0, 1, 2] + b", "y = m x + b", "L ~ c x"])
    #expect(fit.rows.map { $0.unsupported != nil } == [false, false, false, false])
    #expect(fit.rows[1].info?.hasPrefix("m ≈ 1.5 · b ≈ 0.833333") == true)
    #expect(fit.rows[3].error == "Regression models must be static; x cannot vary during a fit.")
  }

  @Test func discreteArithmeticIsEnumerated() throws {
    let rows = ["D ~ DiscreteUniform(1, 6)", "F ~ DiscreteUniform(1, 6)", "S = D + F", "P(D > F)", "D / 2", "E(D^2)"]
    let analysis = analyze(rows)
    #expect(
      analysis.rows.map(\.info) == [nil, nil, "μ = 7, σ = 2.41523", "≈ 0.4167", "μ = 1.75, σ = 0.853913", "≈ 15.1667"])
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

/// The tolerance of the approximate tiers (ApproximateLaws.swift). The port
/// runs the site's arithmetic in the site's order over the same sample, so
/// what separates the two is the last bit of sin, exp, log and their kin in
/// the two math libraries (V8's are fdlibm's, not the system's). Over the
/// corpus a sample column agrees to a few parts in 10¹², and what is a smooth
/// function of one — a quantile, a moment, a kernel estimate, a window, a
/// sample's fraction — is held to this. Two things are not smooth, and each
/// has its own measure below: a spread about a far mean (`sameSpread`) and a
/// conditional-CDF curve over values that tie (`tieSlack`).
let APPROXIMATE_TOLERANCE = 1e-9

/// Two numbers of an approximate tier, against the `scale` they are read on.
private func about(_ a: Double, _ b: Double, scale: Double = 0, slack: Double = 0) -> Bool {
  if a.isNaN || b.isNaN { return a.isNaN && b.isNaN }
  return a == b || abs(a - b) <= APPROXIMATE_TOLERANCE * max(abs(a), abs(b), scale) + slack
}

/// Two standard deviations about a mean. These tiers form one as the root of
/// a second moment less the mean squared, so it is the second moment that
/// agrees to the tolerance: of ln of a Gamma(2·10⁶), mean 14.5 and σ 0.0007,
/// the site's own σ holds eight digits.
private func sameSpread(_ a: Double, _ b: Double, mean: Double) -> Bool {
  if about(a, b) { return true }
  guard a.isFinite, b.isFinite, mean.isFinite else { return false }
  return abs(a * a - b * b) <= APPROXIMATE_TOLERANCE * (mean * mean + max(a * a, b * b))
}

/// What a last bit is worth in the height of a conditional-CDF curve. That
/// tier reads a CDF off the sorted values of g over a quantile grid, where
/// equal values are one step and unequal ones two. A grid symmetric about a
/// fold of g (sin over a uniform, the square of a StudentT) holds pairs of
/// nodes whose values are equal in exact arithmetic, so whether a pair comes
/// out equal is the last bit of g — in the site's curve as in the port's.
/// Each pair that falls the other way moves the CDF by half a sample there,
/// which differentiated over a cell `dz` wide is the height returned here:
/// one sample's mass in one cell. Rasterized again through a deep view
/// (smaller cells), the same bit is worth more. Zero for the other tiers.
private func tieSlack(_ rvs: RVSystem, _ rv: String, _ pts: [Double]) -> Double {
  if rvs.exactLaw(rv) != nil { return 0 }
  let bases = rvs.basesOf(rv)
  guard (1...2).contains(bases.count), bases.allSatisfy({ rvs.baseDist($0).map(isDiscrete) == false }) else { return 0 }
  // (QC_SINGLE, or QC_OUTER × QC_INNER.)
  let samples = bases.count == 1 ? 8192.0 : 512.0 * 512.0
  var dz = Double.infinity
  for i in stride(from: 2, to: pts.count, by: 2) where pts[i] > pts[i - 2] { dz = min(dz, pts[i] - pts[i - 2]) }
  return dz.isFinite ? 1 / (samples * dz) : 0
}

/// A polyline as the site drew it, against its own width and height.
private func samePolyline(_ mine: [Double], _ theirs: [Double], slack: Double) -> Bool {
  guard theirs.count == mine.count else { return false }
  var (width, height) = (0.0, 0.0)
  for i in stride(from: 0, to: theirs.count - 1, by: 2) {
    width = max(width, abs(theirs[i] - theirs[0]))
    height = max(height, abs(theirs[i + 1]))
  }
  return mine.indices.allSatisfy {
    $0 % 2 == 0 ? about(mine[$0], theirs[$0], scale: width) : about(mine[$0], theirs[$0], scale: height, slack: slack)
  }
}

/// A curve as the site drew it: its polyline, its point masses, and what its
/// readout would say.
private func sameCurve(_ mine: DensityCurve, _ theirs: Any, slack: Double) -> Bool {
  guard let theirs = theirs as? [String: Any] else { return false }
  guard samePolyline(mine.pts, (theirs["pts"] as! [Any]).map(number), slack: slack) else { return false }
  let atoms = theirs["atoms"] as? [[String: Any]]
  guard atoms?.count == mine.atoms?.count else { return false }
  for (a, b) in zip(mine.atoms ?? [], atoms ?? []) where !about(a.x, number(b["x"]!)) || !about(a.p, number(b["p"]!)) {
    return false
  }
  if let robust = theirs["robust"] as? [String: Any] {
    guard let r = mine.robust, about(r.median, number(robust["median"]!)), about(r.iqr, number(robust["iqr"]!)),
      r.meanOk == robust["meanOk"] as! Bool
    else { return false }
  } else if mine.robust != nil {
    return false
  }
  // (A mean of 0 is 0 against the spread.)
  let sd = number(theirs["sd"]!)
  return about(mine.mean, number(theirs["mean"]!), scale: sd.isFinite ? sd : 0)
    && sameSpread(mine.sd, sd, mean: mine.mean) && about(mine.mass, number(theirs["mass"]!))
}

/// A derived row's moments as the site decided them (`RVSystem.moments`).
private func sameMoments(_ mine: Moments, _ theirs: Any) -> Bool {
  guard let theirs = theirs as? [String: Any] else { return false }
  func has(_ key: String, _ value: Double, scale: Double = 0) -> Bool {
    theirs[key].map { about(value, number($0), scale: scale.isFinite ? scale : 0) } ?? false
  }
  func spread(_ sd: Double, _ mean: Double) -> Bool {
    theirs["sd"].map { sameSpread(sd, number($0), mean: mean) } ?? false
  }
  func noted(_ note: String?) -> Bool { note == theirs["note"] as? String }
  switch mine {
  case .exact(let mean, let sd, let mass, let note):
    return theirs["kind"] as? String == "exact" && has("mean", mean, scale: sd) && spread(sd, mean) && has("mass", mass)
      && noted(note)
  case .estimate(let mean, let sd, let mass, let note):
    return theirs["kind"] as? String == "estimate" && has("mean", mean, scale: sd) && spread(sd, mean)
      && has("mass", mass) && noted(note)
  case .robust(let median, let iqr, let meanOk, let mass, let note):
    return theirs["kind"] as? String == "robust" && has("median", median, scale: iqr) && has("iqr", iqr)
      && has("mass", mass) && meanOk == theirs["meanOk"] as? Bool && noted(note)
  }
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
    check("curve", want["curve"], { try rvs.curve(rv, env) }) {
      sameCurve($0, $1, slack: tieSlack(rvs, rv, $0.pts))
    }
    // The same curve through a view deep inside it.
    if let zoomed = want["zoomed"] as? [String: Any], let view = zoomed["view"] as? [String: Any] {
      let window = (lo: number(view["lo"]!), hi: number(view["hi"]!))
      check("curve in a window", zoomed["curve"], { try rvs.curve(rv, env, view: window) }) {
        sameCurve($0, $1, slack: tieSlack(rvs, rv, $0.pts))
      }
    }
    check("moments", want["moments"], { try rvs.moments(rv, env) }, same: sameMoments)
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
      }
    ) { mine, theirs in
      guard let theirs = (theirs as? [Any])?.map(number) else { return false }
      return samePolyline(mine, theirs, slack: tieSlack(rvs, shade.rv, (try? rvs.curve(shade.rv, env))??.pts ?? []))
    }
  case .value(_, let shade?):
    // The area a definite integral's row shades (IntShade.swift), through the same window.
    if shadeNames(shade) != want["names"] as? [String] { out.append("drawn names: got \(shadeNames(shade))") }
    func sameRun(_ run: ShadeRun, _ theirs: [String: Any]) -> Bool {
      run.sign == (theirs["sign"] as! NSNumber).intValue && run.clipLo == theirs["clipLo"] as! Bool
        && run.clipHi == theirs["clipHi"] as! Bool && samePoints(run.pts, theirs["pts"]!)
    }
    check("shaded runs", want["runs"], { shadeRuns(shade, env, window.lo, window.hi) }) { runs, theirs in
      guard let theirs = theirs as? [[String: Any]], theirs.count == runs.count else { return false }
      return zip(runs, theirs).allSatisfy(sameRun)
    }
    check(
      "shaded paths", want["paths"], { shadeRuns(shade, env, window.lo, window.hi).map { runPaths($0, -1.5, 2.5) } }
    ) { paths, theirs in
      guard let theirs = theirs as? [[String: Any]], theirs.count == paths.count else { return false }
      return zip(paths, theirs).allSatisfy { samePoints($0.fill, $1["fill"]!) && samePoints($0.stroke, $1["stroke"]!) }
    }
  case .expect(let rv):
    check("marker", want["mark"], { try rvs.markerHeight(rv, env) }) { mark, theirs in
      guard let theirs = theirs as? [String: Any] else { return false }
      // Where the mean stands, against the spread it stands in; how high, against the curve it reaches.
      let curve = rvs.isDiscreteVar(rv) || rvs.exactDist(rv) != nil ? nil : (try? rvs.curve(rv, env)) ?? nil
      let spread = (try? rvs.moments(rv, env)).flatMap { m -> Double? in
        switch m {
        case .exact(_, let sd, _, _), .estimate(_, let sd, _, _): sd.isFinite ? sd : nil
        case .robust(_, let iqr, _, _, _): iqr
        }
      }
      let height = curve.map { c in stride(from: 1, to: c.pts.count, by: 2).reduce(0) { max($0, c.pts[$1]) } } ?? 0
      return about(mark.x, number(theirs["x"]!), scale: spread ?? 0)
        && about(
          mark.h, number(theirs["h"]!), scale: height, slack: curve.map { 2 * tieSlack(rvs, rv, $0.pts) } ?? 0)
    }
  default:
    break
  }
  return out
}
