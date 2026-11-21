import Testing

@testable import EquationCore

/// lib/path.ts `foldAllExcept`: a large curve is folded under the frame's
/// values before it is sampled along u. Speed only — every sample is the
/// number the whole tree gives.
@Suite struct PathFold {
  @Test func foldingACurveChangesNoSample() throws {
    let rows = ["C = (3cos(2pi u), 1.5sin(2pi u))", "a = 0.3", "osculating(C, a + t/10)"]
    let analysis = analyze(rows)
    guard case .pcurve(2, let comps, _, _, _)? = analysis.rows[2].cpu else {
      Issue.record("not a curve in the plane: \(String(describing: analysis.rows[2].cpu))")
      return
    }
    var env = analysis.env
    env["t"] = 3.7
    let folded = foldAllExcept(comps, "u", env)
    let (before, after) = (comps.reduce(0) { $0 + countNodes($1) }, folded.reduce(0) { $0 + countNodes($1) })
    #expect(before > FOLD_NODES && after * 10 < before, "\(before) nodes folded to \(after)")
    for k in 0...64 {
      env["u"] = Double(k) / 64
      for (whole, part) in zip(comps, folded) {
        #expect(try evaluate(whole, env).bitPattern == evaluate(part, env).bitPattern)
      }
    }
    // What reads u stays; a name with no value stays, to fail at sample time as it would have.
    #expect(foldAllExcept([.bin(.add, .var("u"), .bin(.mul, .num(2), .var("a")))], "u", ["a": 3]) == [
      .bin(.add, .var("u"), .num(6))
    ])
    #expect(foldAllExcept([.bin(.mul, .var("q"), .num(2))], "u", [:]) == [.bin(.mul, .var("q"), .num(2))])
    // A Σ binds its index: folded whole, or not at all.
    let sum = Expr.call("sum", [.var("k"), .num(1), .num(3), .bin(.mul, .var("k"), .var("a"))])
    #expect(foldAllExcept([sum], "u", ["a": 2]) == [.num(12)])
    let along = Expr.call("sum", [.var("k"), .num(1), .num(3), .bin(.mul, .var("k"), .var("u"))])
    #expect(foldAllExcept([along], "u", ["a": 2]) == [along])
  }
}
