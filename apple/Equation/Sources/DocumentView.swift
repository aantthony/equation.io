import EquationCore
import SwiftUI

/// A graph document's window: the rows beside the graph on iPad and Mac, and
/// in a glass card over it on iPhone.
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
  /// The equations card's drag, for the text inside it: a pull down from the
  /// top of the equations moves the card, as a sheet takes over from its
  /// scroll view, and a push up grows it before the equations scroll.
  @MainActor final class PanelDrag {
    /// The card follows a drag: points moved down since the card took it.
    var moved: (CGFloat) -> Void = { _ in }
    /// The drag let go; the argument is how much further a flick would carry it.
    var ended: (CGFloat) -> Void = { _ in }
    /// Whether the card can still grow, so a push up moves it instead of scrolling.
    var canGrow: () -> Bool = { false }
  }

  extension EnvironmentValues {
    @Entry var panelDrag: PanelDrag? = nil
  }

  /// iPhone: the equations in a glass card floating over the graph — the look
  /// of a sheet, but part of the window: a sheet presented as the document
  /// opens stalls the open. Its header, or a pull on the equations when they
  /// are scrolled to the top, drags it between its stops, the lowest of which
  /// leaves only the header showing.
  private struct StackedLayout<Graph: View, Header: View, Editor: View>: View {
    @ViewBuilder var graph: Graph
    @ViewBuilder var header: Header
    @ViewBuilder var editor: Editor

    /// The card's settled stop, as an index into `stops`.
    @State private var stop = 1
    /// How far the current drag has pulled the card down from its stop.
    @State private var dragged: CGFloat = 0
    @State private var drag = PanelDrag()

    /// The card's inset from the screen's edges, as a floating sheet sits.
    private static var margin: CGFloat { 8 }
    /// The card's height with only its header showing.
    private static var headerHeight: CGFloat { 58 }

    var body: some View {
      ZStack(alignment: .bottom) {
        graph
          .ignoresSafeArea()
        GeometryReader { geometry in
          let stops = Self.stops(in: geometry.size.height)
          let base = stops[min(stop, stops.count - 1)]
          let height = min(max(base - dragged, Self.headerHeight), stops[stops.count - 1])
          let settle = { (target: CGFloat) in
            withAnimation(.snappy) {
              stop = stops.indices.min { abs(stops[$0] - target) < abs(stops[$1] - target) } ?? 1
              dragged = 0
            }
          }
          let _ = configure(drag, base: base, top: stops[stops.count - 1], settle: settle)
          VStack(spacing: 0) {
            VStack(spacing: 6) {
              Capsule()
                .fill(.secondary.opacity(0.5))
                .frame(width: 36, height: 5)
              HStack(spacing: 16) { header }
                .padding(.horizontal, 20)
            }
            .padding(.top, 8)
            .padding(.bottom, 6)
            .frame(height: Self.headerHeight, alignment: .top)
            .contentShape(Rectangle())
            .onTapGesture {
              // A tap on a collapsed card's header brings the equations back.
              if stop == 0 { withAnimation(.snappy) { stop = 1 } }
            }
            .gesture(
              // Measured on the screen, not the header: the header moves with
              // the card, so its own space would feed the drag back into itself.
              DragGesture(coordinateSpace: .global)
                .onChanged { value in dragged = value.translation.height }
                .onEnded { value in
                  // Settle on the stop nearest where a flick would carry it.
                  settle(base - value.predictedEndTranslation.height)
                }
            )
            editor
              .environment(\.panelDrag, drag)
          }
          .frame(height: height, alignment: .top)
          .clipShape(.rect(cornerRadius: 36))
          .glassEffect(.regular, in: .rect(cornerRadius: 36))
          .padding(.horizontal, Self.margin)
          .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .padding(.bottom, Self.margin)
        // Down to the screen's edge, but above the keyboard when it is up.
        .ignoresSafeArea(.container, edges: .bottom)
      }
    }

    /// Point the equations' drag at this card as it is laid out now.
    private func configure(_ drag: PanelDrag, base: CGFloat, top: CGFloat, settle: @escaping (CGFloat) -> Void) {
      drag.moved = { dy in dragged = dy }
      drag.ended = { extra in settle(base - dragged - extra) }
      drag.canGrow = { base - dragged < top - 1 }
    }

    /// Just the header, a few rows, half, and nearly all of the window.
    private static func stops(in total: CGFloat) -> [CGFloat] {
      [headerHeight, 190, total * 0.5, total - 60].map { min(max($0, headerHeight), max(headerHeight, total - 40)) }
    }
  }
#endif
