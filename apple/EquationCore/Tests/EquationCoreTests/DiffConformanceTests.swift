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
      let input = try decode(exactNumbers(entry["input"]!))
      let got: Result<Expr, DiffError> = Result { () throws(DiffError) in try diff(input, variable) }
      let want: Result<Expr, DiffError> =
        if let message = entry["error"] as? String {
          .failure(DiffError(message, nonSmooth: entry["errorType"] as? String == "NonSmoothError"))
        } else {
          .success(try decode(exactNumbers(entry["expr"]!)))
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

/// The fixture writes every number as text, since JSONSerialization reads
/// some doubles an ulp off; this puts the exact doubles back, for `decode`.
private func exactNumbers(_ json: Any) -> Any {
  if let list = json as? [Any] { return list.map(exactNumbers) }
  guard var object = json as? [String: Any] else { return json }
  if object["kind"] as? String == "num", let text = object["value"] as? String {
    let value: Double =
      switch text {
      case "Infinity": .infinity
      case "-Infinity": -.infinity
      case "NaN": .nan
      default: Double(text)!
      }
    object["value"] = NSNumber(value: value)
    return object
  }
  for (key, value) in object { object[key] = exactNumbers(value) }
  return object
}
