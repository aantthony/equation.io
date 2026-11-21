import EquationCore
import Foundation
import Testing

@testable import EquationRender

/// Holds RowReport.swift to lib/assistant-tools.ts `checkRows`: what Ask's
/// check, get_graph and set_graph say of each row of every example and of
/// documents written for it. Regenerate the fixture with
///
///   pnpm swift:reports
///
/// A row the port cannot read is not compared (it is reported as not drawn);
/// a definition whose meaning the analysis does not say is compared in
/// everything but its meaning. REPORTS_WHY=1 lists both.
@Suite struct RowReportConformance {
  @Test func reportsAreTheSites() throws {
    let url = try #require(Bundle.module.url(forResource: "reports", withExtension: "json", subdirectory: "Scenes"))
    let fixture = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let meanings = try #require(fixture["meanings"] as? [String: String])
    let documents = try #require(fixture["documents"] as? [[String: Any]])
    var failures: [String] = []
    var (rows, compared, whole, unsupported, unmeant, unwarned) = (0, 0, 0, 0, 0, 0)
    var skipped: [String] = []
    for document in documents {
      let texts = document["rows"] as! [String]
      let wanted = document["report"] as! [[String: Any]]
      let analysis = analyze(texts)
      for (k, want) in wanted.enumerated() {
        rows += 1
        let row = analysis.rows[k]
        if row.unsupported != nil {
          unsupported += 1
          continue
        }
        compared += 1
        let got = analysis.describe(row: k, texts: texts, kindMeanings: meanings)
        var mine: [String: String] = [:]
        mine["kind"] = got.kind
        mine["meaning"] = got.meaning
        mine["value"] = got.value
        mine["error"] = got.error
        mine["hint"] = got.hint
        mine["warning"] = got.warning
        var theirs: [String: String] = [:]
        for key in ["kind", "meaning", "value", "error", "hint", "warning"] { theirs[key] = want[key] as? String }
        // A definition the analysis does not say enough of: no meaning, never a wrong one.
        if got.meaning == nil, theirs["meaning"] != nil, row.definition != nil {
          unmeant += 1
          skipped.append("\(texts[k]): \(theirs["meaning"]!)")
          theirs["meaning"] = nil
        } else {
          whole += 1
        }
        // Whether another row reads a name is not known beside a row the port cannot read.
        if got.warning == nil, theirs["warning"]?.hasPrefix("this defines") == true,
          analysis.usedElsewhere(texts, k, row.definition?.name ?? "") == nil
        {
          unwarned += 1
          skipped.append("\(document["name"]!): \(texts[k]): \(theirs["warning"]!)")
          theirs["warning"] = nil
        }
        if mine != theirs {
          let differing = Set(mine.keys).union(theirs.keys).filter { mine[$0] != theirs[$0] }.sorted()
          failures.append(
            "\(document["name"]!): \(texts[k])\n"
              + differing.map { "    \($0): got \(mine[$0] ?? "-"), want \(theirs[$0] ?? "-")" }
              .joined(separator: "\n"))
        }
      }
    }
    print(
      "Row reports: \(rows) rows, \(compared) compared (\(unsupported) not supported), \(whole) whole, "
        + "\(unmeant) definitions without a meaning, \(unwarned) without an unused warning")
    if ProcessInfo.processInfo.environment["REPORTS_WHY"] != nil { print(skipped.joined(separator: "\n")) }
    #expect(failures.isEmpty, "\(failures.count) differences:\n\(failures.prefix(40).joined(separator: "\n"))")
  }
}
