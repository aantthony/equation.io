import Foundation
import Testing

@testable import EquationCore

/// What apple/corpus/highlight.ts records of the site: every example in the
/// Examples menu, edge cases, and rows as they are typed.
/// Regenerate with `pnpm swift:highlight`.
private struct Fixture: Decodable {
  struct Tables: Decodable {
    var functions: [String]
    var callForms: [String]
    var distributions: [String]
    var constants: [String]
    var lightPalette: [[Float]]
    var darkPalette: [[Float]]
  }
  struct Names: Decodable {
    struct Sequence: Decodable {
      var name: String
      var index: String
      var cell: String?
      var cell2: String?
    }
    var values: [String]
    var functions: [String]
    var sequences: [Sequence]

    var bound: BoundNames {
      BoundNames(
        values: Set(values), functions: Set(functions),
        sequences: sequences.map { .init(name: $0.name, index: $0.index, cell: $0.cell, cell2: $0.cell2) })
    }
  }
  struct SiteSpan: Decodable {
    var start: Int
    var end: Int
    var cls: String
    var name: String?
    var called: Bool?

    var span: HighlightSpan {
      HighlightSpan(start: start, end: end, cls: SpanClass(rawValue: cls)!, name: name, called: called ?? false)
    }
  }
  struct Facts: Decodable {
    var text: String
    var comment: Bool
    var def: Bool
    var point: Bool
    var view: Bool
    var plan: String?
    var shade: Bool

    var row: ColorRow {
      let plan: ColorPlan? =
        switch self.plan {
        case nil: nil
        case "note": .note
        case "metric": .metric
        case "value": .value(shade: shade)
        default: .other
        }
      return ColorRow(text: text, comment: comment, def: def, point: point, view: view, plan: plan)
    }
  }
  struct Colors: Decodable {
    var facts: [Facts]
    var takes: [Bool]
    var slots: [Int]
  }
  struct Document: Decodable {
    var name: String
    var rows: [String]
    var names: Names
    var spans: [[SiteSpan]]
    var notes: [Int]
    var noteColors: [[Float]?]
    var colors: Colors?
  }
  struct Assignment: Decodable {
    var before: [Int]
    var takes: [Bool]
    var size: Int
    var after: [Int]
  }
  var tables: Tables
  var documents: [Document]
  var assignments: [Assignment]

  /// Read once for the suite; nil when the fixture has not been generated.
  static let shared: Fixture? = Bundle.module.url(forResource: "Fixtures/highlight", withExtension: "json")
    .flatMap { try? JSONDecoder().decode(Fixture.self, from: Data(contentsOf: $0)) }
}

private func describe(_ spans: [HighlightSpan], _ row: String) -> String {
  let u = Array(row.utf16)
  return spans.map {
    let text = String(decoding: u[min($0.start, u.count)..<min($0.end, u.count)], as: UTF16.self)
    return "\(text):\($0.cls.rawValue)\($0.called ? "()" : "")"
  }.joined(separator: " ")
}

@Suite struct HighlightConformance {
  private let fixture: Fixture

  init() throws {
    fixture = try #require(Fixture.shared, "Fixtures/highlight.json is missing: run pnpm swift:highlight")
  }

  /// The tables the highlighter reads are the TypeScript's.
  @Test func builtinTablesMatchTheSite() {
    let tables = fixture.tables
    #expect(functions.union(laterFunctions) == Set(tables.functions))
    #expect(callForms == Set(tables.callForms))
    #expect(distributionNames == Set(tables.distributions))
    #expect(constantNames == Set(tables.constants))
  }

  /// The rows of `documents` whose spans are not the site's, and how many rows were looked at.
  private func differing(
    _ documents: [Fixture.Document], spans: (Fixture.Document) -> [[HighlightSpan]]
  ) -> (rows: Int, documents: Set<String>, report: String) {
    var rows = 0
    var names = Set<String>()
    var failures: [String] = []
    for document in documents {
      let got = spans(document)
      for (k, row) in document.rows.enumerated() {
        rows += 1
        let want = document.spans[k].map(\.span)
        if got[k] == want { continue }
        names.insert(document.name)
        failures.append(
          "\(document.name)\n    row  \(row)\n    want \(describe(want, row))\n    got  \(describe(got[k], row))")
      }
    }
    let report = "\(failures.count) of \(rows) rows differ:\n\(failures.prefix(20).joined(separator: "\n"))"
    return (rows, names, report)
  }

  /// Given the names the site's definitions bind, every row's spans are the site's.
  @Test func spansMatchTheSite() {
    let result = differing(fixture.documents) { highlightRows($0.rows, names: $0.names.bound) }
    #expect(result.rows > 5000)
    #expect(result.documents.isEmpty, "\(result.report)")
  }

  /// The names read off the rows' shapes (`collectBoundNames`, the stand-in
  /// for the definitions port) color the Examples menu as the site does, but
  /// for the kinds of row its comment lists. The examples it gets wrong are
  /// named here, so one it starts or stops getting right is noticed.
  @Test func namesReadFromTheRowsColorTheExamples() {
    // om' = solve(M, f) is a vector state by what solve returns: om_1 and om_2 need the definitions.
    let known: Set<String> = ["simulations (↻ to restart): double pendulum"]
    let examples = fixture.documents.filter { $0.colors != nil && !$0.name.hasPrefix("edge") }
    let result = differing(examples) { highlightRows($0.rows) }
    #expect(result.rows > 1000)
    #expect(result.documents == known, "\(result.report)")
  }

  @Test func notesMatchTheSite() {
    for document in fixture.documents {
      for (k, row) in document.rows.enumerated() {
        #expect(noteStart(row) == (document.notes[k] < 0 ? nil : document.notes[k]), "\(row)")
        let got = noteColorRGB(row)
        if let want = document.noteColors[k] {
          #expect(got.map { simd_close($0, want) } == true, "\(row)")
        } else {
          #expect(got == nil, "\(row)")
        }
      }
    }
  }

  private func simd_close(_ a: SIMD3<Float>, _ b: [Float]) -> Bool {
    abs(a.x - b[0]) < 1e-6 && abs(a.y - b[1]) < 1e-6 && abs(a.z - b[2]) < 1e-6
  }

  @Test func palettesMatchTheSite() {
    #expect(lightPalette.map { [$0.x, $0.y, $0.z] } == fixture.tables.lightPalette)
    #expect(darkPalette.map { [$0.x, $0.y, $0.z] } == fixture.tables.darkPalette)
  }

  /// A freshly loaded document's rows take the slots the site gives them.
  @Test func documentColorsMatchTheSite() {
    var documents = 0
    for document in fixture.documents {
      guard let colors = document.colors else { continue }
      documents += 1
      let takes = colors.facts.map { takesColor($0.row) }
      #expect(takes == colors.takes, "\(document.name)")
      let rows = takes.enumerated().map { (id: $0.offset, takes: $0.element) }
      #expect(assignColors(rows: rows, previous: [:], size: lightPalette.count) == colors.slots, "\(document.name)")
    }
    #expect(documents > 300)
  }

  /// Documents mid-edit: rows already colored, rows that stopped taking a color, new rows.
  @Test func assignmentsMatchTheSite() {
    for assignment in fixture.assignments {
      var slots = assignment.before
      assignColors(&slots, takes: assignment.takes, size: assignment.size)
      #expect(slots == assignment.after, "\(assignment.before) \(assignment.takes) of \(assignment.size)")
    }
  }

  @Test func rowsKeepTheirSlotsByID() {
    // Three rows take blue, red, green; the middle one goes and a new row comes in at the top.
    let first = assignColors(rows: [("a", true), ("b", true), ("c", true)], previous: [String: Int](), size: 6)
    #expect(first == [0, 1, 2])
    let next = assignColors(rows: [("d", true), ("a", true), ("c", true)], previous: ["a": 0, "b": 1, "c": 2], size: 6)
    #expect(next == [1, 0, 2])
    // A row that stops taking a color gives its slot up.
    #expect(assignColors(rows: [("a", false), ("c", true)], previous: ["a": 0, "c": 2], size: 6) == [-1, 2])
  }
}
