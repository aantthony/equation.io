import SwiftUI

extension FocusedValues {
  /// The document in the key window, for menu commands.
  @Entry var graphDocument: Binding<GraphDocument>?
  /// The key window's graph, for menu commands that move its view.
  @Entry var graphModel: GraphModel?
}

/// View ▸ Zoom In / Zoom Out, as in Maps. In the menu, so the shortcuts work
/// while the caret is in the equations.
struct ZoomCommands: Commands {
  @FocusedValue(\.graphModel) private var graph

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
    }
  }
}

struct ExamplesCommands: Commands {
  @FocusedValue(\.graphDocument) private var document

  var body: some Commands {
    CommandMenu("Examples") {
      ExamplesMenu { rows in document?.wrappedValue.replace(with: rows) }
        .disabled(document == nil)
    }
  }
}
