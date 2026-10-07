import SwiftUI
import UniformTypeIdentifiers

extension UTType {
  static let equationGraph = UTType(exportedAs: "io.equation.graph")
}

/// One row of a graph: an equation, a definition, a comment.
struct GraphRow: Identifiable, Hashable {
  /// Stable while the document is open, so edits and moves keep a row's
  /// color and slider range in the renderer. Not saved.
  var id: Int
  var text: String
}

/// A graph document: its rows, in order. Saved as JSON so that views,
/// data files and settings can join the rows later.
struct GraphDocument: FileDocument {
  static let readableContentTypes: [UTType] = [.equationGraph]

  var rows: [GraphRow]
  private var nextID: Int

  init(rows: [String] = ["y = sin(x)"]) {
    self.rows = rows.enumerated().map { GraphRow(id: $0.offset, text: $0.element) }
    nextID = rows.count
  }

  init(configuration: ReadConfiguration) throws {
    guard let data = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
    let file = try JSONDecoder().decode(File.self, from: data)
    self.init(rows: file.rows)
  }

  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
    return FileWrapper(regularFileWithContents: try encoder.encode(File(rows: rows.map(\.text))))
  }

  private struct File: Codable {
    var version = 1
    var rows: [String]
  }

  /// The document as the editor shows it: one row per line.
  var text: String { rows.map(\.text).joined(separator: "\n") }

  /// New row texts, from the editor or from the renderer (a slider, a
  /// dragged point). Rows keep their ids where they line up with the old
  /// ones: unchanged rows before and after the edit, then the edited rows
  /// in order — so an edited line is the same row, and Return makes a new one.
  mutating func setLines(_ lines: [String]) {
    let old = rows
    let shared = min(old.count, lines.count)
    var head = 0
    while head < shared && old[head].text == lines[head] { head += 1 }
    var tail = 0
    while tail < shared - head && old[old.count - 1 - tail].text == lines[lines.count - 1 - tail] { tail += 1 }
    let oldMiddle = old[head..<(old.count - tail)]
    let middle = lines[head..<(lines.count - tail)].enumerated().map { k, text in
      if k < oldMiddle.count { return GraphRow(id: oldMiddle[oldMiddle.startIndex + k].id, text: text) }
      defer { nextID += 1 }
      return GraphRow(id: nextID, text: text)
    }
    let next = Array(old[..<head]) + middle + old[(old.count - tail)...]
    if next != rows { rows = next }
  }
}
