import SwiftUI

/// A graph document's window: the rows beside the graph on iPad and Mac, and
/// in a sheet over it on iPhone.
struct DocumentView: View {
  @Binding var document: GraphDocument
  @State private var model = GraphModel()
  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
  #endif

  var body: some View {
    #if os(iOS)
      if sizeClass == .compact {
        graph
          .sheet(isPresented: .constant(true)) {
            editor
              .presentationDetents([.height(180), .medium, .large])
              .presentationBackgroundInteraction(.enabled(upThrough: .medium))
              .interactiveDismissDisabled()
          }
      } else {
        split
      }
    #else
      split
    #endif
  }

  private var editor: some View {
    EquationEditor(
      document: $document,
      status: model.status,
      slide: { [model] row, value in model.setSlider(row: row, to: value) }
    )
    .navigationTitle("Equations")
  }

  private var graph: some View {
    GraphView(document: $document, model: model)
      .ignoresSafeArea()
  }

  private var split: some View {
    NavigationSplitView {
      editor
        .navigationSplitViewColumnWidth(min: 260, ideal: 340, max: 520)
    } detail: {
      graph
    }
  }
}
