import SwiftUI

@main
enum Main {
  static func main() {
    // The Metal renderer, for a launch from a script or a scheme.
    if ProcessInfo.processInfo.environment["EQUATION_RENDERER"] == "metal" {
      UserDefaults.standard.register(defaults: [metalRendererKey: true])
    }
    #if DEBUG
      // A scratch window straight onto a graph, skipping the document
      // browser: how a simulator or UI test opens the editor directly.
      if ProcessInfo.processInfo.environment["EQUATION_SCRATCH"] != nil {
        ScratchApp.main()
        return
      }
    #endif
    #if os(macOS)
      // Launch into a new graph, not the Open panel.
      UserDefaults.standard.register(defaults: ["NSShowAppCentricOpenPanelInsteadOfUntitledFile": false])
    #endif
    EquationApp.main()
  }
}

struct EquationApp: App {
  var body: some Scene {
    #if os(iOS)
      // Straight into a new graph: the system document browser's import
      // step made every new graph wait (GraphLibrary.swift).
      WindowGroup {
        GraphLibraryRoot()
      }
      .commands {
        LibraryCommands()
        ZoomCommands()
        ExamplesCommands()
      }
    #else
      DocumentGroup(newDocument: GraphDocument()) { file in
        DocumentView(document: file.$document)
      }
      .commands {
        ZoomCommands()
        ExamplesCommands()
      }
    #endif
  }
}

#if DEBUG
  struct ScratchApp: App {
    @State private var document = GraphDocument(
      rows: (ProcessInfo.processInfo.environment["EQUATION_SCRATCH"] ?? "")
        .split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
        .nilIfEmpty ?? ["y = sin(a x)", "a = 2"])

    var body: some Scene {
      WindowGroup {
        DocumentView(document: $document)
      }
      .commands {
        ZoomCommands()
        ExamplesCommands()
      }
    }
  }

  extension Array {
    fileprivate var nilIfEmpty: Self? { isEmpty ? nil : self }
  }
#endif
