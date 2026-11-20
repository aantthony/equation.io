import CryptoKit
import EquationCore
import Foundation

/// A graph document as a file: its rows, and the data files its rows open.
///
/// The site keeps a dropped CSV in the browser's IndexedDB, by the SHA-256 of
/// its bytes, and a row carries only the file's name and a prefix of that hash
/// (web/filestore.ts): its document is a URL, which cannot hold a file. A
/// document on disk can, so here the files travel inside it — one file to
/// keep, move, AirDrop or mail, which still draws when it arrives. A link
/// shared from it (`graphLink`) carries what the site's does: the rows, so the
/// file's name and hash and none of its bytes; whoever opens the link is asked
/// for the file, and a file with other bytes is a different file.
///
/// Embedded in the document's JSON rather than beside it in a package: the
/// document stays one regular file of the type it has always been
/// (`public.json`), which every place a document goes — Files, Mail, a
/// share sheet, a web upload — carries whole, and which the app's own store
/// writes in one atomic step. A CSV is text, so it is embedded as text and
/// stays readable there; bytes that are not UTF-8 are embedded as Base64.
///
/// Nothing here leaves the device: a file is read, hashed and parsed in
/// place, and written only into the document that opened it.
public struct GraphDocumentFile: Equatable, Sendable {
  public var rows: [String]
  public var data: DocumentData

  public init(rows: [String], data: DocumentData = DocumentData()) {
    self.rows = rows
    self.data = data
  }

  private struct Encoded: Codable {
    var version = 1
    var rows: [String]
    /// Absent from a document that opens no file.
    var files: [File]?

    struct File: Codable {
      var name: String
      /// The SHA-256 of the bytes, lowercase hex: what the rows name them by.
      /// Written for whoever reads the file; the bytes are hashed again when
      /// it is opened, and it is that hash they are kept under.
      var sha256: String
      var text: String?
      var base64: String?
    }
  }

  /// A document from a file's bytes. A data file whose bytes no longer parse
  /// is kept all the same: its rows say it is missing, and saving does not
  /// lose it.
  public init(data bytes: Data) throws {
    let file = try JSONDecoder().decode(Encoded.self, from: bytes)
    rows = file.rows
    data = DocumentData()
    for stored in file.files ?? [] {
      guard let bytes = stored.text.map({ Data($0.utf8) }) ?? stored.base64.flatMap({ Data(base64Encoded: $0) })
      else { continue }
      data.keep(name: stored.name, bytes: bytes)
    }
  }

  /// The file's bytes: the rows, and the data files they read. A file no row
  /// opens any more is left out — a row deleted takes its data with it, so a
  /// document passed on carries nothing its rows do not show.
  public func encoded() throws -> Data {
    let encoder = JSONEncoder()
    // (Keys in one order, so a document saved twice is the same bytes.)
    encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes, .sortedKeys]
    let read = filesRead(by: rows, files: data.files)
    let files = data.stored.filter { read.contains($0.hash) || !data.parses($0.hash) && data.names($0, in: rows) }
      .map { file -> Encoded.File in
        // (Text only when reading it back gives the very bytes: the hash is of them.)
        let text = String(data: file.bytes, encoding: .utf8).flatMap { Data($0.utf8) == file.bytes ? $0 : nil }
        return Encoded.File(
          name: file.name, sha256: file.hash, text: text,
          base64: text == nil ? file.bytes.base64EncodedString() : nil)
      }
    return try encoder.encode(Encoded(rows: rows, files: files.isEmpty ? nil : files))
  }
}

/// A data file as a document holds it: the bytes as they were given, under
/// the name a row can quote and the SHA-256 of the bytes (lowercase hex).
public struct StoredDataFile: Equatable, Sendable {
  public var name: String
  public var hash: String
  public var bytes: Data
}

/// A document's data files (web/filestore.ts, without the browser): the
/// bytes, and what lib/csv.ts made of them, which is what the analysis reads.
/// Parsing happens once, as a file arrives; the analysis runs on every
/// keystroke and only ever reads the result.
public struct DocumentData: Sendable {
  /// The files in the order they arrived, the newest last.
  public private(set) var stored: [StoredDataFile] = []
  /// The files that parse, for `analyze(_:files:)`.
  public private(set) var files = DataFiles()

  public init() {}

  public var isEmpty: Bool { stored.isEmpty }

  /// The SHA-256 of some bytes, lowercase hex, as a row's hash names them.
  public static func hash(_ bytes: Data) -> String {
    SHA256.hash(data: bytes).map { byte in
      let hex = String(byte, radix: 16)
      return hex.count == 1 ? "0" + hex : hex
    }.joined()
  }

  /// Parse, hash and keep a file someone gave (web/filestore.ts `ingest`).
  /// Throws what the parser says of a file it cannot read, before anything
  /// is kept. Stored under the name a row can quote, so the row and the
  /// record agree and the same file given again finds itself.
  @discardableResult
  public mutating func ingest(name: String, bytes: Data) throws -> (hash: String, file: DataFile) {
    // As the site decodes a dropped file: UTF-8, what is not becoming U+FFFD.
    let table = try parseCsv(String(decoding: bytes, as: UTF8.self))
    let hash = Self.hash(bytes)
    let file = DataFile(name: rowSafeFileName(name), table: table)
    stored.removeAll { $0.hash == hash }
    stored.append(StoredDataFile(name: file.name, hash: hash, bytes: bytes))
    files.add(file, hash: hash)
    return (hash, file)
  }

  /// Keep a file read back from a document: as `ingest`, but bytes that no
  /// longer parse stay with the document, as a file that is missing.
  mutating func keep(name: String, bytes: Data) {
    if (try? ingest(name: name, bytes: bytes)) != nil { return }
    let hash = Self.hash(bytes)
    stored.removeAll { $0.hash == hash }
    stored.append(StoredDataFile(name: rowSafeFileName(name), hash: hash, bytes: bytes))
  }

  func parses(_ hash: String) -> Bool { files[hash] != nil }

  /// Whether a row opens this file, by its hash or — pinning none — its name.
  func names(_ file: StoredDataFile, in rows: [String]) -> Bool {
    rows.contains { text in
      guard let row = tableRow(text) else { return false }
      return row.hash.isEmpty ? row.file == file.name : file.hash.hasPrefix(row.hash)
    }
  }
}

extension DocumentData: Equatable {
  /// A file is its hash: the same hashes under the same names are the same files.
  public static func == (a: DocumentData, b: DocumentData) -> Bool {
    a.stored.count == b.stored.count
      && zip(a.stored, b.stored).allSatisfy { $0.hash == $1.hash && $0.name == $1.name }
  }
}

/// What became of a file someone gave (the site's notice): what arrived and
/// under what name, or why it could not be read.
public struct DataNotice: Equatable, Sendable {
  public var text: String
  /// The file did not do what giving it meant to: it could not be read, or
  /// a row that names it is pinned to other bytes and stays as it was.
  public var problem: Bool
}

extension GraphDocumentFile {
  /// Bring files into the document and wire them into its rows (web/main.ts
  /// `openDataFiles`, lib side in EquationCore `rowsOpening`): each is
  /// parsed, hashed and kept, a row that names it is pinned to its bytes, and
  /// one that no row names gets a row of its own. Returns what to tell the
  /// person, a notice per file.
  public mutating func open(_ picked: [(name: String, bytes: Data)]) -> [DataNotice] {
    var notices: [DataNotice] = []
    for (name, bytes) in picked {
      do {
        let loaded = try data.ingest(name: name, bytes: bytes)
        let opened = rowsOpening(file: loaded.file.name, hash: loaded.hash, table: loaded.file.table, in: rows)
        rows = opened.rows
        notices.append(DataNotice(text: opened.notice, problem: opened.kept > 0))
      } catch {
        let why = (error as? LanguageError)?.message ?? error.localizedDescription
        notices.append(DataNotice(text: "\(name): \(why)", problem: true))
      }
    }
    // A row typed by hand before its file came is pinned to it now.
    if let pinned = pinningTableHashes(rows, files: data.files) { rows = pinned }
    return notices
  }

  /// The rows as a link carries them: every table row pinned to the bytes it
  /// reads, so the link names the exact data the graph was built against.
  public var linkRows: [String] { pinningTableHashes(rows, files: data.files) ?? rows }
}
