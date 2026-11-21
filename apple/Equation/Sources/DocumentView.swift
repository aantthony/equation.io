import EquationCore
import EquationRender
import SwiftUI

/// A graph document's window: the rows beside the graph on iPad and Mac, and
/// in a glass card over it on iPhone.
struct DocumentView: View {
  @Binding var document: GraphDocument
  /// The app's own graph handling, on iPhone and iPad; nil in a document window.
  var library: LibraryActions? = nil
  /// The document registers its changes for undo (a Mac document window),
  /// so the graph groups a gesture's rewrites into one step there.
  var registersUndo = false
  @Environment(\.undoManager) private var undoManager
  @State private var model = GraphModel()
  @State private var chat = GraphChat()
  /// The window's way in for data files: the importer, a drop, a row that asks for its file.
  @State private var dataImport = DataImport()
  /// Bumped to put the cursor in Ask's field.
  @State private var askFocus = 0
  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
  #endif

  var body: some View {
    let _ = connectChat()
    content
      .focusedSceneValue(\.graphDocument, $document)
      .focusedSceneValue(\.graphModel, model)
      .focusedSceneValue(\.graphLibrary, library)
      .focusedSceneValue(\.dataImport, dataImport)
      .onAppear { timing.debug("window: appeared") }
      // A CSV, chosen or dropped anywhere on the window, is the document's to open.
      .fileImporter(
        isPresented: Bindable(dataImport).picking, allowedContentTypes: DataImport.types,
        allowsMultipleSelection: true
      ) { result in
        if case .success(let urls) = result { dataImport.take(urls: urls) }
      }
      .onDrop(of: [.fileURL] + DataImport.types, isTargeted: nil) { dataImport.take(providers: $0) }
      .alert(
        "Data", isPresented: Binding(get: { dataImport.problem != nil }, set: { if !$0 { dataImport.problem = nil } })
      ) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(dataImport.problem ?? "")
      }
  }

  @ViewBuilder private var content: some View {
    #if os(iOS)
      if sizeClass == .compact {
        StackedLayout {
          GraphView(document: $document, model: model)
        } header: {
          Text(title).font(.headline).lineLimit(1)
          Spacer()
          if let library {
            Button("Open", systemImage: "folder", action: library.open).labelStyle(.iconOnly)
          }
          examples.labelStyle(.iconOnly)
          addData.labelStyle(.iconOnly)
          ask.labelStyle(.iconOnly)
          share.labelStyle(.iconOnly)
        } editor: {
          editor
        }
        .overlay(alignment: .top) {
          // The equations card has the bottom: Ask sits at the top.
          ChatOverlay(chat: chat, focusRequest: askFocus, edge: .top)
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
      status: model.shown,
      slide: { [model] row, value in model.setSlider(row: row, to: value) },
      slid: { [model] in model.endGesture() },
      flip: { [model] row, toggle in model.flip(toggle, row: row) },
      supply: { [dataImport] in dataImport.picking = true },
      drop: { [dataImport] files in dataImport.take(providers: files) }
    )
  }

  /// Adds a data file (a CSV) to the graph: the importer; a drop does the same.
  private var addData: some View {
    Button("Add Data", systemImage: "tablecells") { dataImport.picking = true }
      .help("Add a data file (CSV) to this graph")
  }

  /// The examples, where there is no menu bar (iPhone, an iPad without a keyboard).
  private var examples: some View {
    Menu("Examples", systemImage: "books.vertical") {
      ExamplesMenu { rows in
        if let library { library.example(rows) } else { document.replace(with: rows) }
      }
    }
  }

  private var title: String { library?.title ?? "Equations" }

  /// Puts the cursor in Ask's field, which changes the graph from a request in words.
  private var ask: some View {
    Button("Ask", systemImage: "sparkles") { askFocus += 1 }
      .keyboardShortcut("k")
  }

  /// Point the chat's tools at this window's graph.
  private func connectChat() {
    let document = $document
    chat.access.rows = { document.wrappedValue.rows.map(\.text) }
    chat.access.apply = { rows in document.wrappedValue.setLines(rows) }
    chat.access.model = model
    model.undoManager = registersUndo ? undoManager : nil
    dataImport.open = { picked in document.wrappedValue.open(picked) }
    #if DEBUG
      // EQUATION_SCRIPT's `import`, `save` and `load` (GraphGestures.swift).
      model.importData = { [dataImport] urls in dataImport.take(urls: urls) }
      model.dataNotices = { [dataImport] in dataImport.last.map(\.text) }
      model.encoded = { try? document.wrappedValue.encoded() }
      model.load = { bytes in
        guard var next = try? GraphDocument(data: bytes) else { return }
        next.follow(document.wrappedValue)
        document.wrappedValue = next
      }
    #endif
  }

  /// Shares the graph as its equation.io link, which opens (and unfurls
  /// with a preview) anywhere, app or not; the share sheet has Copy.
  private var share: some View {
    ShareLink(
      // (The rows name a data file by its hash; its bytes stay in the document.)
      item: URL(string: graphLink(document.linkRows))!,
      subject: Text("Equation.io graph"),
      preview: SharePreview("Equation.io graph")
    )
  }

  private var split: some View {
    NavigationSplitView {
      editor
        .navigationTitle(title)
        .navigationSplitViewColumnWidth(min: 260, ideal: 340, max: 520)
        #if os(iOS)
          .toolbar {
            if let library {
              ToolbarItem { Button("Open", systemImage: "folder", action: library.open) }
              ToolbarItem { Button("New Graph", systemImage: "square.and.pencil", action: library.new) }
            }
            ToolbarItem { examples }
          }
        #endif
        .toolbar { ToolbarItem { addData } }
    } detail: {
      // Laid out beside the sidebar, not under it, so splits, centering and
      // zoom use the graph you can see; the system mirrors and blurs its edge
      // under the sidebar's glass. Top and bottom still run to the edges.
      ZStack(alignment: .bottom) {
        GraphView(document: $document, model: model)
          .backgroundExtensionEffect()
          .ignoresSafeArea(edges: .vertical)
        ChatOverlay(chat: chat, focusRequest: askFocus)
      }
      .toolbar {
          ToolbarItem(placement: .primaryAction) { ask }
          ToolbarItem(placement: .primaryAction) { share }
        }
    }
    #if os(macOS)
      // The title bar fades away while you work (WindowChrome.swift).
      .background(WindowChrome())
    #endif
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

    /// The home indicator's height, kept clear below the header and the equations.
    @State private var home: CGFloat = 0
    /// The status bar's height, and the window's.
    @State private var status: CGFloat = 0
    @State private var window: CGFloat = 0

    /// What lies over the graph: the status bar, and the card where it has
    /// settled, up to half the window (a card pulled higher covers the graph
    /// on purpose). Of the window, not the keyboard, so typing moves nothing.
    private var clear: GraphPanels.Clear {
      guard window > 0 else { return GraphPanels.Clear() }
      let stops = Self.stops(in: window, home: home)
      let card = min(stops[min(stop, stops.count - 1)], window * 0.5)
      return GraphPanels.Clear(top: status, bottom: card)
    }

    /// The card's inset from the screen's sides.
    private static var margin: CGFloat { 8 }
    /// The header's height: the grab bar, the title and its buttons.
    private static var headerHeight: CGFloat { 58 }
    /// How far the card runs on below the screen, so its bottom edge and
    /// corners never show, even as a drag pulls it up.
    private static var overhang: CGFloat { 80 }

    var body: some View {
      ZStack(alignment: .bottom) {
        graph
          .environment(\.graphClear, clear)
          .ignoresSafeArea()
        GeometryReader { geometry in
          let stops = Self.stops(in: geometry.size.height, home: home)
          let base = stops[min(stop, stops.count - 1)]
          // The card's visible height, from its top to the screen's bottom.
          let height = min(max(base - dragged, stops[0]), stops[stops.count - 1])
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
              // The equations fill the card, overhang and all, so a drag
              // anywhere on it reaches them; their scrolling keeps the last
              // row above the screen's edge instead.
              .environment(\.editorBottomInset, Self.overhang)
          }
          .frame(height: height + Self.overhang, alignment: .top)
          .clipShape(.rect(cornerRadius: 36))
          .glassEffect(.regular, in: .rect(cornerRadius: 36))
          .padding(.horizontal, Self.margin)
          .offset(y: Self.overhang)
          .frame(maxHeight: .infinity, alignment: .bottom)
        }
        // Down past the screen's edge, but above the keyboard when it is up.
        .ignoresSafeArea(.container, edges: .bottom)
      }
      .background {
        // From the window, which the keyboard doesn't change.
        HomeIndicatorReader { top, bottom, height in
          if home != bottom { home = bottom }
          if status != top { status = top }
          if window != height { window = height }
        }
      }
    }

    /// Point the equations' drag at this card as it is laid out now.
    private func configure(_ drag: PanelDrag, base: CGFloat, top: CGFloat, settle: @escaping (CGFloat) -> Void) {
      drag.moved = { dy in dragged = dy }
      drag.ended = { extra in settle(base - dragged - extra) }
      drag.canGrow = { base - dragged < top - 1 }
    }

    /// Reports the window's safe area at the top (the status bar) and the
    /// bottom (the home indicator), and its height.
    private struct HomeIndicatorReader: UIViewRepresentable {
      var report: (CGFloat, CGFloat, CGFloat) -> Void

      func makeUIView(context: Context) -> Probe {
        let probe = Probe()
        probe.isUserInteractionEnabled = false
        probe.report = report
        return probe
      }

      func updateUIView(_ probe: Probe, context: Context) { probe.report = report }

      final class Probe: UIView {
        var report: (CGFloat, CGFloat, CGFloat) -> Void = { _, _, _ in }
        override func didMoveToWindow() { send() }
        override func safeAreaInsetsDidChange() { send() }
        override func layoutSubviews() {
          super.layoutSubviews()
          send()
        }
        private func send() {
          let insets = window?.safeAreaInsets ?? .zero
          let height = window?.bounds.height ?? 0
          // Not during the layout pass that asked.
          DispatchQueue.main.async { [report] in report(insets.top, insets.bottom, height) }
        }
      }
    }

    /// Just the header (above the home indicator), a few rows, half, and
    /// nearly all of the window.
    private static func stops(in total: CGFloat, home: CGFloat) -> [CGFloat] {
      let low = headerHeight + home
      return [low, 190 + home, total * 0.5, total - 60].map { min(max($0, low), max(low, total - 40)) }
    }
  }
#endif
