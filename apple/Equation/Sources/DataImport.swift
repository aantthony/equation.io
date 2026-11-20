import EquationDocument
import SwiftUI
import UniformTypeIdentifiers

/// One window's way in for data files (the site's `openDataFiles`): the file
/// importer, a drop on the window, and the row that asks for its file. A file
/// is read where it is, on this device, and kept in the window's document
/// (GraphDocument.swift); nothing of it goes anywhere else.
@MainActor @Observable
final class DataImport {
  /// The file importer is up.
  var picking = false
  /// What to say of files that did not do what giving them meant to: one
  /// that could not be read, a row pinned to other bytes. Shown as an alert.
  var problem: String?
  /// Opens files in the window's document (DocumentView sets this).
  @ObservationIgnored var open: ([(name: String, bytes: Data)]) -> [DataNotice] = { _ in [] }
  /// What the last files came to, for EQUATION_SCRIPT's `state`.
  @ObservationIgnored private(set) var last: [DataNotice] = []

  /// What the importer offers and a drop takes: delimited text, by any of its names.
  static let types: [UTType] = [.commaSeparatedText, .tabSeparatedText, .plainText]

  func take(_ picked: [(name: String, bytes: Data)], unread: [String] = []) {
    let notices = picked.isEmpty ? [] : open(picked)
    last = notices
    let problems = notices.filter(\.problem).map(\.text) + unread
    if !problems.isEmpty { problem = problems.joined(separator: "\n") }
  }

  /// Files by their URLs: chosen in the importer, or dragged from the Finder.
  /// Read in place; a file outside the sandbox is open to the app only while
  /// it is read.
  func take(urls: [URL]) {
    var picked: [(name: String, bytes: Data)] = []
    var unread: [String] = []
    for url in urls {
      do {
        picked.append(try Self.read(url))
      } catch {
        unread.append("\(url.lastPathComponent): \(error.localizedDescription)")
      }
    }
    take(picked, unread: unread)
  }

  private nonisolated static func read(_ url: URL) throws -> (name: String, bytes: Data) {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    return (url.lastPathComponent, try Data(contentsOf: url))
  }

  /// Whether a dragged item is a file to open rather than text to put in a row.
  static func isFile(_ provider: NSItemProvider) -> Bool {
    [UTType.fileURL, .commaSeparatedText, .tabSeparatedText].contains {
      provider.hasItemConformingToTypeIdentifier($0.identifier)
    }
  }

  /// Dropped items. False when none of them is a file this can open, so the
  /// drop is someone else's.
  func take(providers: [NSItemProvider]) -> Bool {
    let files = providers.filter { provider in
      Self.isFile(provider) || Self.types.contains { provider.hasItemConformingToTypeIdentifier($0.identifier) }
    }
    guard !files.isEmpty else { return false }
    Task { @MainActor in
      var picked: [(name: String, bytes: Data)] = []
      var unread: [String] = []
      for provider in files {
        if let file = await Self.load(provider) {
          picked.append(file)
        } else {
          unread.append("\(provider.suggestedName ?? "A dropped item") could not be read.")
        }
      }
      take(picked, unread: unread)
    }
    return true
  }

  /// A dropped item's name and bytes: from the file itself when the drag
  /// carries its URL (the Finder's), and otherwise from the copy the system
  /// hands over for as long as the closure runs (Files, on iPhone and iPad).
  private static func load(_ provider: NSItemProvider) async -> (name: String, bytes: Data)? {
    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      let url: URL? = await withCheckedContinuation { done in
        _ = provider.loadObject(ofClass: URL.self) { url, _ in done.resume(returning: url) }
      }
      if let url, url.isFileURL, let file = try? read(url) { return file }
    }
    for type in types where provider.hasItemConformingToTypeIdentifier(type.identifier) {
      let suggested = provider.suggestedName
      let file: (name: String, bytes: Data)? = await withCheckedContinuation { done in
        _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
          guard let url, let bytes = try? Data(contentsOf: url) else { return done.resume(returning: nil) }
          // The copy keeps the file's extension; the item's own name may not.
          let name = suggested.map { $0.contains(".") ? $0 : "\($0).\(url.pathExtension)" } ?? url.lastPathComponent
          done.resume(returning: (name, bytes))
        }
      }
      if let file { return file }
    }
    return nil
  }
}

extension FocusedValues {
  /// The key window's way in for data files, for File ▸ Add Data.
  @Entry var dataImport: DataImport?
}

/// File ▸ Add Data… (⇧⌘I): a CSV for the graph in the key window.
struct DataCommands: Commands {
  @FocusedValue(\.dataImport) private var dataImport

  var body: some Commands {
    CommandGroup(after: .importExport) {
      Button("Add Data…") { dataImport?.picking = true }
        .keyboardShortcut("i", modifiers: [.command, .shift])
        .disabled(dataImport == nil)
    }
  }
}
