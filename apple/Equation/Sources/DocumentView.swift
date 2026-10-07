import EquationCore
import SwiftUI

/// A graph document's window: the rows beside the graph on iPad and Mac, and
/// below it on iPhone.
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
      .onAppear { timing.debug("window: appeared") }
  }

  @ViewBuilder private var content: some View {
    #if os(iOS)
      if sizeClass == .compact {
        StackedLayout {
          GraphView(document: $document, model: model)
        } header: {
          Text("Equations").font(.headline)
          Spacer()
          examples.labelStyle(.iconOnly)
          share.labelStyle(.iconOnly)
        } editor: {
          editor
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
  }

  /// The examples, where there is no menu bar (iPhone, an iPad without a keyboard).
  private var examples: some View {
    Menu("Examples", systemImage: "books.vertical") {
      ExamplesMenu { rows in document.replace(with: rows) }
    }
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

  private var split: some View {
    NavigationSplitView {
      editor
        .navigationTitle("Equations")
        .navigationSplitViewColumnWidth(min: 260, ideal: 340, max: 520)
        #if os(iOS)
          .toolbar { ToolbarItem { examples } }
        #endif
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

#if os(iOS)
  /// iPhone: the graph above, the equations below in a panel whose header
  /// drags it between three heights. Part of the window, not a sheet: a sheet
  /// presented as the document opens stalls the open, and would cover the
  /// graph rather than give it the space above.
  private struct StackedLayout<Graph: View, Header: View, Editor: View>: View {
    @ViewBuilder var graph: Graph
    @ViewBuilder var header: Header
    @ViewBuilder var editor: Editor

    /// The panel's settled height, or nil for the smallest stop.
    @State private var settled: CGFloat?
    @GestureState private var dragged: CGFloat = 0

    var body: some View {
      GeometryReader { geometry in
        let stops = Self.stops(in: geometry.size.height)
        let height = Self.clamp((settled ?? stops[0]) - dragged, in: geometry.size.height)
        VStack(spacing: 0) {
          graph
            .ignoresSafeArea(edges: .top)
          VStack(spacing: 0) {
            VStack(spacing: 6) {
              Capsule()
                .fill(.secondary.opacity(0.5))
                .frame(width: 36, height: 5)
              HStack(spacing: 16) { header }
                .padding(.horizontal, 16)
            }
            .padding(.top, 6)
            .padding(.bottom, 8)
            .contentShape(Rectangle())
            .gesture(
              DragGesture()
                .updating($dragged) { value, state, _ in state = value.translation.height }
                .onEnded { value in
                  // Settle on the stop nearest where a flick would carry it.
                  let target = height - value.predictedEndTranslation.height + value.translation.height
                  withAnimation(.snappy) {
                    settled = stops.min { abs($0 - target) < abs($1 - target) }
                  }
                }
            )
            Divider()
            editor
          }
          .frame(height: height)
          .background(.bar)
        }
      }
    }

    /// Small (a few rows), half, and nearly all of the window.
    private static func stops(in total: CGFloat) -> [CGFloat] {
      [180, total * 0.5, total - 120].map { clamp($0, in: total) }
    }

    private static func clamp(_ height: CGFloat, in total: CGFloat) -> CGFloat {
      min(max(height, 120), max(120, total - 80))
    }
  }
#endif
