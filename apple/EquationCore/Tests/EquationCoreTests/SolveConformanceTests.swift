import Foundation
import Testing

@testable import EquationCore

/// Holds the Swift solvers (Solve.swift, Roots.swift) to the TypeScript ones
/// over the corpus apple/corpus/solve.ts records. Regenerate the fixture with
///
///   pnpm swift:solve-corpus
///
/// A case marked `exact` uses only arithmetic every IEEE machine computes
/// alike, and there the Swift must return the same doubles in the same order:
/// every seed, step and tie taken as the TypeScript takes it. Elsewhere the C
/// library and V8 may differ in a last place, so the same solutions are asked
/// for within a tolerance.
@Suite struct SolveConformance {
  let fixture: [String: Any]

  init() throws {
    let url = try #require(Bundle.module.url(forResource: "Fixtures/solve-corpus", withExtension: "json"))
    fixture = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
  }

  @Test func systems() throws {
    var failures: [String] = []
    let cases = fixture["solve"] as! [[String: Any]]
    for c in cases {
      let o = c["opts"] as! [String: Any]
      let opts = SolveOptions(
        env: (o["env"] as? [String: Any] ?? [:]).mapValues(number),
        margin: o["margin"].map(solveNumber) ?? 0.05,
        seeds: (o["seeds"] as? [[Any]] ?? []).map(numbers),
        lattice: o["lattice"] as? Bool ?? true,
        angular: o["angular"] as? [Bool] ?? [])
      let got = solveSystem(
        try exprs(c["residuals"]!), c["vars"] as! [String], numbers(c["lo"]!), numbers(c["hi"]!), opts)
      let want = (c["result"] as! [[Any]]).map(numbers)
      if !same([got], [want], exact: c["exact"] as! Bool) {
        failures.append("\(c["src"]!)\n  want \(want)\n  got  \(got)")
      }
    }
    #expect(failures.isEmpty, "\(failures.count) of \(cases.count) differ:\n\(failures.joined(separator: "\n"))")
  }

  @Test func linear() throws {
    for c in fixture["linear"] as! [[String: Any]] {
      let J = (c["J"] as! [[Any]]).map(numbers)
      let b = numbers(c["b"]!)
      let got = solveLinear(J, b, b.count)
      let want = (c["result"] as? [Any]).map(numbers)
      #expect(got.map { [[$0]] } == want.map { [[$0]] }, "\(J) \(b)")
    }
  }

  @Test func traces() throws {
    var failures: [String] = []
    let cases = fixture["trace"] as! [[String: Any]]
    for c in cases {
      let got = traceSystem(
        try exprs(c["residuals"]!), c["vars"] as! [String], numbers(c["lo"]!), numbers(c["hi"]!),
        (c["env"] as! [String: Any]).mapValues(number), Int(solveNumber(c["samples"]!)), c["angular"] as! [Bool])
      let want = (c["result"] as! [[[Any]]]).map { $0.map(numbers) }
      if !same(got, want, exact: c["exact"] as! Bool) {
        failures.append(
          "\(c["src"]!): want \(want.count) paths of \(want.map(\.count)), got \(got.count) of \(got.map(\.count))")
      }
    }
    #expect(failures.isEmpty, "\(failures.count) of \(cases.count) differ:\n\(failures.joined(separator: "\n"))")
  }

  @Test func numericRoots() throws {
    var failures: [String] = []
    let cases = fixture["roots"] as! [[String: Any]]
    for c in cases {
      let f = try decode(exactNumbers(c["f"]!))
      let got = findRoots(f, c["v"] as! String, solveNumber(c["lo"]!), solveNumber(c["hi"]!))
      let want: FoundRoots =
        if let list = c["result"] as? [[String: Any]] {
          .roots(
            list.map {
              FoundRoot(x: solveNumber($0["x"]!), mult: Int(solveNumber($0["mult"]!)), exact: $0["exact"] as! Bool)
            })
        } else {
          .zero
        }
      var matches = got == want
      if !matches, c["exact"] as! Bool == false, case .roots(let g) = got, case .roots(let w) = want {
        matches =
          g.map(\.mult) == w.map(\.mult) && g.map(\.exact) == w.map(\.exact)
          && same([[g.map(\.x)]], [[w.map(\.x)]], exact: false)
      }
      if !matches { failures.append("\(c["src"]!)\n  want \(want)\n  got  \(got)") }
    }
    #expect(failures.isEmpty, "\(failures.count) of \(cases.count) differ:\n\(failures.joined(separator: "\n"))")
  }
}

/// The fixture's numbers are text (see exactNumbers).
private func solveNumber(_ json: Any) -> Double {
  switch json as! String {
  case "Infinity": .infinity
  case "-Infinity": -.infinity
  case "NaN": .nan
  case let text: Double(text)!
  }
}
private func numbers(_ json: Any) -> [Double] { (json as! [Any]).map(solveNumber) }
private func exprs(_ json: Any) throws -> [Expr] { try (json as! [Any]).map { try decode(exactNumbers($0)) } }

/// Paths of points: the same doubles, or (not `exact`) the same shape with
/// each coordinate within rounding of the TypeScript's.
private func same(_ a: [[[Double]]], _ b: [[[Double]]], exact: Bool) -> Bool {
  guard a.count == b.count else { return false }
  for (p, q) in zip(a, b) {
    guard p.count == q.count else { return false }
    for (u, v) in zip(p, q) {
      guard u.count == v.count else { return false }
      for (x, y) in zip(u, v) {
        if exact ? x.bitPattern != y.bitPattern : !(abs(x - y) <= 1e-9 * (1 + abs(y))) { return false }
      }
    }
  }
  return true
}
