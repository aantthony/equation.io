import EquationCore
import EquationDocument
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

/// A graph document: its rows, in order, and the data files they open. Saved
/// as JSON, the files inside it (EquationDocument `GraphDocumentFile` says why they
/// travel there), so that views and settings can join the rows later.
struct GraphDocument: FileDocument {
  static let readableContentTypes: [UTType] = [.equationGraph]

  var rows: [GraphRow]
  /// The data files the rows open (`p = open("people.csv", 3a7f…)`): their
  /// bytes, kept on this device and in this document only, and what the
  /// parser made of them, which is what the analysis reads.
  private(set) var data = DocumentData()
  /// The files as `analyze(_:files:)` takes them.
  var files: DataFiles { data.files }
  /// Counts whole-document replacements (an example), which the renderer
  /// opens as a new graph — reframed — rather than as an edit. Not saved.
  private(set) var generation = 0
  private var nextID: Int

  init(rows: [String] = ["y = sin(x)"]) {
    timing.debug("document: new")
    self.rows = rows.enumerated().map { GraphRow(id: $0.offset, text: $0.element) }
    nextID = rows.count
  }

  init(configuration: ReadConfiguration) throws {
    guard let data = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
    try self.init(data: data)
  }

  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: try encoded())
  }

  /// A graph from a file's bytes.
  init(data: Data) throws {
    timing.debug("document: read")
    let file = try GraphDocumentFile(data: data)
    self.init(rows: file.rows)
    self.data = file.data
  }

  /// The file's bytes: the rows, and the data files they read.
  func encoded() throws -> Data {
    timing.debug("document: write")
    return try file.encoded()
  }

  /// The document as its file has it.
  private var file: GraphDocumentFile { GraphDocumentFile(rows: rows.map(\.text), data: data) }

  /// Bring data files into the document (EquationDocument `GraphDocumentFile.open`):
  /// each is parsed and kept, a row that names it is pinned to its bytes, and
  /// a file no row names gets a row of its own. One edit, so one undo step.
  mutating func open(_ picked: [(name: String, bytes: Data)]) -> [DataNotice] {
    var file = file
    let notices = file.open(picked)
    data = file.data
    setLines(file.rows)
    return notices
  }

  /// The rows as a link carries them: each `open(…)` row pinned to the bytes
  /// it reads. The link names the file; it never holds it.
  var linkRows: [String] { file.linkRows }

  /// What is saved of the data files: their hashes, in order. With the rows'
  /// text, what tells an edited document from a saved one.
  var savedFiles: [String] { data.stored.map(\.hash) }

  /// Shown in place of `previous`: the renderer opens it as a new graph
  /// (reframed), not as an edit to the one before.
  mutating func follow(_ previous: GraphDocument) {
    generation = previous.generation + 1
  }

  /// The document as the editor shows it: one row per line.
  var text: String { rows.map(\.text).joined(separator: "\n") }

  /// A different graph in this document, as opening an example does: the
  /// rows are all new, and undo brings the old ones back.
  mutating func replace(with lines: [String]) {
    rows = lines.map { text in
      defer { nextID += 1 }
      return GraphRow(id: nextID, text: text)
    }
    generation += 1
  }

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
