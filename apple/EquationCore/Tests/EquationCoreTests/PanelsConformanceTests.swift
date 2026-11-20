import Foundation
import Testing

@testable import EquationCore

/// Holds Panels.swift to lib/panels.ts: the boxes a document's dividers come
/// to in frames of several sizes, the panel each shared axis follows, and
/// the panel under a point. Regenerate the fixture with
///
///   pnpm swift:panels
@Suite struct PanelsConformance {
  @Test func layouts() throws {
    let cases = try #require(try fixture("panels") as? [[String: Any]])
    var failures: [String] = []
    for c in cases {
      let rows = c["rows"] as! [String]
      let (w, h, margin) = (number(c["w"]!), number(c["h"]!), number(c["margin"]!))
      let name = "\(rows) in \(w)x\(h)"
      let splits = try rows.map { try #require(try parseDividerRow($0)) }
      let layout = layoutPanels(splits, w, h, margin: margin)
      let wanted = (c["layout"] as! [[String: Any]]).map { p -> PanelLayout in
        let r = (p["rect"] as! [String: Any]).mapValues(number)
        let shared = p["shared"] as! [String: Bool]
        return PanelLayout(
          rect: PanelRect(x: r["x"]!, y: r["y"]!, w: r["w"]!, h: r["h"]!), host: (p["host"] as! NSNumber).intValue,
          inset: p["inset"] as! Bool, sharedX: shared["x"]!, sharedY: shared["y"]!)
      }
      if layout != wanted { failures.append("\(name): got \(layout), want \(wanted)") }
      let roots = layout.indices.map { [linkRoot(layout, $0, .x), linkRoot(layout, $0, .y)] }
      if roots != (c["roots"] as! [[NSNumber]]).map({ $0.map(\.intValue) }) { failures.append("\(name): roots \(roots)") }
      for at in c["at"] as! [[Any]] {
        let got = panelAt(layout, number(at[0]), number(at[1]))
        if got != Int(number(at[2])) { failures.append("\(name): panel at \(at[0]), \(at[1]) is \(got)") }
      }
    }
    #expect(failures.isEmpty, "\(failures.count) differences:\n\(failures.prefix(20).joined(separator: "\n"))")
  }

  @Test func rowsByPanel() {
    let analysis = analyze(["a = 2", "y = a x", "--- right", "A = (1, 2)", "y = x^2", "---", "y = a"])
    #expect(panelIndices(analysis.rows) == [0, 0, 1, 1, 1, 2, 2])
    #expect(splitsOf(analysis.rows).count == 2)
    // A panel's document keeps every constant, and its own rows alone.
    let second = analysis.panel(1)
    #expect(second.env == analysis.env)
    #expect(second.rows.map { $0.cpu != nil || $0.definition != nil } == [false, false, false, true, true, false, false])
    #expect(second.rows[2].divider)
  }
}
