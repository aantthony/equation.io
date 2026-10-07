import SwiftUI

@main
enum Main {
  static func main() {
    #if DEBUG
      // A scratch window straight onto a graph, skipping the document
      // browser: how a simulator or UI test opens the editor directly.
      if ProcessInfo.processInfo.environment["EQUATION_SCRATCH"] != nil {
        ScratchApp.main()
        return
      }
    #endif
    EquationApp.main()
  }
}

struct EquationApp: App {
  var body: some Scene {
    DocumentGroup(newDocument: GraphDocument()) { file in
      DocumentView(document: file.$document)
    }
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
    }
  }

  extension Array {
    fileprivate var nilIfEmpty: Self? { isEmpty ? nil : self }
  }
#endif
