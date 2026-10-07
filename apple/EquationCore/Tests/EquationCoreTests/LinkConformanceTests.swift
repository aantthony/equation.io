import Foundation
import Testing

@testable import EquationCore

/// Share links must be the site's links byte for byte (lib/link.ts), so a
/// graph shared from the app opens, unfurls and caches as the same page.
/// Regenerate the fixture with `pnpm swift:corpus`.
@Suite struct LinkConformance {
  @Test func payloadsMatchTheSite() throws {
    let url = try #require(Bundle.module.url(forResource: "Fixtures/link-corpus", withExtension: "json"))
    let entries = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
    var failures: [String] = []
    for entry in entries {
      let rows = entry["rows"] as! [String]
      let want = entry["payload"] as! String
      let got = encodePayload(rows)
      if got != want { failures.append("\(rows)\n    want \(want)\n    got  \(got)") }
    }
    #expect(failures.isEmpty, "\(failures.count) of \(entries.count) differ:\n\(failures.prefix(20).joined(separator: "\n"))")
  }

  @Test func linkForms() {
    #expect(graphLink(["y = x"]) == "https://equation.io/g/y%20%3D%20x")
    #expect(graphLink([" ", ""]) == "https://equation.io/")
  }
}
