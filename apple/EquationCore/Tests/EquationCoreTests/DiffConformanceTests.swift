import Foundation
import Testing

@testable import EquationCore

/// Holds the Swift differentiator to the TypeScript one: for every input of
/// the corpus (lib/diff.test.ts's, the examples', each rule and each fold),
/// the same tree, node for node, or the same error. Regenerate the fixture
/// with
///
///   pnpm swift:diff-corpus
@Suite struct DiffConformance {
  @Test func corpus() throws {
    let url = try #require(Bundle.module.url(forResource: "Fixtures/diff-corpus", withExtension: "json"))
    let entries = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
    var failures: [String] = []
    for entry in entries {
      let variable = entry["variable"] as! String
      let input = try decode(entry["input"]!)
      let got: Result<Expr, DiffError> = Result { () throws(DiffError) in try diff(input, variable) }
      let want: Result<Expr, DiffError> =
        if let message = entry["error"] as? String {
          .failure(DiffError(message, nonSmooth: entry["errorType"] as? String == "NonSmoothError"))
        } else {
          .success(try decode(entry["expr"]!))
        }
      // Compared as printed, so a NaN matches a NaN (and -0 still differs from 0).
      let (g, w) = ("\(got)", "\(want)")
      if g != w {
        // The trees are long: show where they part.
        let at = max(0, zip(g, w).prefix { $0 == $1 }.count - 60)
        let src = (entry["src"] as! String).debugDescription
        failures.append(
          "d/d\(variable) \(src), from character \(at)\n"
            + "    want …\(w.dropFirst(at).prefix(200))\n    got  …\(g.dropFirst(at).prefix(200))")
      }
    }
    let shown = failures.prefix(10).joined(separator: "\n")
    #expect(failures.isEmpty, "\(failures.count) of \(entries.count) differ:\n\(shown)")
  }
}
