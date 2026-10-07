import EquationCore
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
    content
      .focusedSceneValue(\.graphDocument, $document)
      .focusedSceneValue(\.graphModel, model)
  }

  @ViewBuilder private var content: some View {
    #if os(iOS)
      if sizeClass == .compact {
        graph
          .sheet(isPresented: .constant(true)) {
            NavigationStack { editor.navigationBarTitleDisplayMode(.inline) }
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
    #if os(iOS)
      // No menu bar on iPhone, and none showing on an iPad without a keyboard.
      .toolbar {
        ToolbarItem {
          Menu("Examples", systemImage: "books.vertical") {
            ExamplesMenu { rows in document.replace(with: rows) }
          }
        }
        // On iPhone the graph has no toolbar of its own: share from here.
        if sizeClass == .compact {
          ToolbarItem { share }
        }
      }
    #endif
  }

  /// Shares the graph as its equation.io link, which opens (and unfurls
  /// with a preview) anywhere, app or not; the share sheet has Copy.
  private var share: some View {
    ShareLink(
      item: URL(string: graphLink(document.rows.map(\.text)))!,
      subject: Text("Equation.io graph"),
      preview: SharePreview("Equation.io graph")
    )
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
      // Laid out beside the sidebar, not under it, so splits, centering and
      // zoom use the graph you can see; the system mirrors and blurs its edge
      // under the sidebar's glass. Top and bottom still run to the edges.
      GraphView(document: $document, model: model)
        .backgroundExtensionEffect()
        .ignoresSafeArea(edges: .vertical)
        .toolbar {
          ToolbarItem(placement: .primaryAction) { share }
        }
    }
  }
}
