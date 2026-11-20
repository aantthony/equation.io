import SwiftUI

extension FocusedValues {
  /// The document in the key window, for menu commands.
  @Entry var graphDocument: Binding<GraphDocument>?
  /// The key window's graph, for menu commands that move its view.
  @Entry var graphModel: GraphModel?
  /// The app's own graph handling (iPhone and iPad), for New, Open and the examples.
  @Entry var graphLibrary: LibraryActions?
}

/// View ▸ Zoom In / Zoom Out, as in Maps. In the menu, so the shortcuts work
/// while the caret is in the equations. And Draw with Metal, while the Metal
/// renderer is being built (MetalGraphView.swift).
struct ZoomCommands: Commands {
  @FocusedValue(\.graphModel) private var graph
  @AppStorage(metalRendererKey) private var metal = false

  var body: some Commands {
    CommandGroup(before: .toolbar) {
      // ⌘= is the + key without Shift, which is what "⌘+" means in practice.
      Button("Zoom In") { graph?.zoom(by: 0.5) }
        .keyboardShortcut("=")
        .disabled(graph == nil)
      Button("Zoom Out") { graph?.zoom(by: 2) }
        .keyboardShortcut("-")
        .disabled(graph == nil)
      Divider()
      Toggle("Draw with Metal", isOn: $metal)
      Divider()
    }
  }
}

struct ExamplesCommands: Commands {
  @FocusedValue(\.graphDocument) private var document
  @FocusedValue(\.graphLibrary) private var library

  var body: some Commands {
    CommandMenu("Examples") {
      ExamplesMenu { rows in
        // In the app's own graphs an example is a new graph; in a document
        // window it replaces the graph, and undo brings the old one back.
        if let library { library.example(rows) } else { document?.wrappedValue.replace(with: rows) }
      }
      .disabled(document == nil)
    }
  }
}

/// File ▸ New Graph (⌘N) and Open (⌘O), where the app keeps its own graphs.
struct LibraryCommands: Commands {
  @FocusedValue(\.graphLibrary) private var library

  var body: some Commands {
    CommandGroup(replacing: .newItem) {
      Button("New Graph") { library?.new() }
        .keyboardShortcut("n")
        .disabled(library == nil)
      Button("Open…") { library?.open() }
        .keyboardShortcut("o")
        .disabled(library == nil)
    }
  }
}
