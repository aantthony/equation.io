import EquationCore
import EquationRender
import SwiftUI

/// One open document's graph: what the renderer says about the rows, what
/// the rows are shown with beyond their text, and the way to move its window.
@MainActor @Observable
final class GraphModel {
  /// Index-aligned with the document's rows.
  var status: [RowStatus] = []
  /// The display toggles that are on (`RowStatus.Toggle.id`), by the
  /// editor's id for the row. As on the site they are the view's, not the
  /// document's: nothing of them is in a row's text, a file or a link.
  var toggles: [Int: Set<String>] = [:]
  /// What rows say once a frame has drawn them, by row: a certificate, a
  /// geodesic's note, a readout that moves (`GraphContent.notes`). The
  /// editor shows them over `status`; Ask reads `status` alone.
  var notes: [Int: RowNote] = [:]
  /// The rows' status as the editor shows it.
  var shown: [RowStatus] {
    guard !notes.isEmpty else { return status }
    var out = status
    for (row, note) in notes where row < out.count && out[row].error == nil {
      if let error = note.error { out[row].error = error } else if let info = note.info { out[row].info = info }
    }
    return out
  }
  /// The Metal view drawing the graph (MetalGraphView.swift).
  @ObservationIgnored weak var metal: MetalCanvas?
  /// The theme the graph is drawn in, which picks the rows' colors.
  @ObservationIgnored var theme = GraphTheme.light

  /// Each row's palette slot, by the editor's id for it, so a row keeps its
  /// color as others come and go.
  @ObservationIgnored var slots: [Int: Int] = [:]
  /// Writes a slider's new value into its row (GraphView sets this).
  @ObservationIgnored var slide: (Int, Double) -> Void = { _, _ in }
  /// The document's rows as they are now, their ids, and the way the graph
  /// rewrites them: a dragged point, a moved window's view(…) row (GraphView sets these).
  @ObservationIgnored var rows: () -> [String] = { [] }
  @ObservationIgnored var ids: () -> [Int] = { [] }
  @ObservationIgnored var edit: ([String]) -> Void = { _ in }
  #if DEBUG
    /// EQUATION_SCRIPT's way to the window's data files and its document's
    /// bytes (DocumentView sets these; GraphGestures.swift plays them).
    @ObservationIgnored var importData: ([URL]) -> Void = { _ in }
    @ObservationIgnored var dataNotices: () -> [String] = { [] }
    @ObservationIgnored var encoded: () -> Data? = { nil }
    @ObservationIgnored var load: (Data) -> Void = { _ in }
  #endif

  /// The document's undo manager, where the document registers its own
  /// changes with one (a Mac document window): there a gesture's rewrites
  /// are grouped into one step. Nil elsewhere, and nothing is grouped.
  @ObservationIgnored weak var undoManager: UndoManager? {
    didSet {
      guard undoManager !== oldValue else { return }
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
      observers = []
      guard let undoManager else { return }
      // An undo taken in the middle of a gesture closes its group: the manager is its own again.
      for name in [Notification.Name.NSUndoManagerDidUndoChange, .NSUndoManagerDidRedoChange] {
        observers.append(
          NotificationCenter.default.addObserver(forName: name, object: undoManager, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.abandonGroup() }
          })
      }
    }
  }
  @ObservationIgnored private var observers: [any NSObjectProtocol] = []
  /// An undo group is open for the gesture under way; and the tasks that
  /// close it: once the gesture's last write has been registered, or a
  /// second after the last write of a gesture that has no end (a scroll).
  @ObservationIgnored private var grouped = false
  @ObservationIgnored private var closing: Task<Void, Never>?
  @ObservationIgnored private var idle: Task<Void, Never>?

  /// Rewrite the rows as part of a gesture — a drag, a scroll, a slider, a
  /// move of Ask's: everything written until `endGesture`, or within a
  /// second of the last write, is one undo step (the site's `pushUndo` with
  /// a key, which coalesces a run of one operation).
  func gestureEdit(_ lines: [String]) {
    if closing != nil { closeGroup() }
    if let undoManager, !grouped {
      undoManager.groupsByEvent = false
      undoManager.beginUndoGrouping()
      grouped = true
    }
    edit(lines)
    idle?.cancel()
    idle = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard let self, !Task.isCancelled else { return }
        // A hand still down, or a move still in flight, is the same gesture however slow.
        if self.metal?.busy != true { return self.closeGroup() }
      }
    }
  }

  /// The gesture is over: what it wrote is one undo step, and the next
  /// write starts another. The group closes on the next turn of the run
  /// loop, after the document has registered the last write.
  func endGesture() {
    idle?.cancel()
    idle = nil
    guard grouped, closing == nil else { return }
    closing = Task { @MainActor [weak self] in
      await Task.yield()
      if !Task.isCancelled { self?.closeGroup() }
    }
  }

  private func closeGroup() {
    closing?.cancel()
    closing = nil
    idle?.cancel()
    idle = nil
    guard grouped else { return }
    grouped = false
    guard let undoManager else { return }
    if undoManager.groupingLevel > 0 { undoManager.endUndoGrouping() }
    undoManager.groupsByEvent = true
  }

  private func abandonGroup() {
    guard grouped else { return }
    closing?.cancel()
    closing = nil
    grouped = false
    if let undoManager, undoManager.groupingLevel == 0 { undoManager.groupsByEvent = true }
  }

  func setSlider(row index: Int, to value: Double) {
    slide(index, value)
  }

  /// Flip one of a row's display toggles (web/main.ts `rowToggles`): a
  /// field's streamlines and arrows exclude each other.
  func flip(_ toggle: String, row index: Int) {
    let ids = ids()
    guard index < ids.count else { return }
    var on = toggles[ids[index]] ?? []
    if on.contains(toggle) {
      on.remove(toggle)
    } else {
      on.insert(toggle)
      if toggle == "streamlines" { on.remove("arrows") }
      if toggle == "arrows" { on.remove("streamlines") }
    }
    toggles[ids[index]] = on.isEmpty ? nil : on
  }

  /// Glide the zoom of the panel last touched, about its center: below 1 zooms in, above 1 out.
  func zoom(by factor: Double) {
    metal?.glideZoom(by: factor)
  }

  /// Start t, and every state, again (the site's ↻).
  func restart() {
    metal?.restart()
  }

  /// The status of `rows`: they are analyzed as they are asked about, so
  /// there is nothing to wait for.
  func status(after rows: [String]) async -> [RowStatus] {
    GraphAnalysis(rows: rows.enumerated().map { GraphRow(id: -1 - $0.offset, text: $0.element) }, theme: theme).status
  }
}

/// What the app makes of a document's rows: each row's status for the
/// editor, and what to draw in each panel (EquationCore `analyze`, GraphContent.swift).
struct GraphAnalysis: Equatable {
  var status: [RowStatus] = []
  var content: GraphContent
  /// Each row's palette slot, by its id.
  var slots: [Int: Int]

  /// What a row the language's port can't read yet says: the port's reason,
  /// which says the site draws it and the app does not yet.
  static func notDrawnYet(_ reason: String) -> String {
    reason.hasPrefix("Not supported in the app yet") ? reason : "The app doesn't draw this yet (\(reason))."
  }

  /// `files`: the document's data files, which its `open(…)` rows read. Nil
  /// for a reading that is to see none of them (Ask's: Chat.swift).
  ///
  /// Read with the stack a deep row needs (DeepStack.swift), wherever it is asked for.
  init(
    rows: [GraphRow], theme: GraphTheme, previous: [Int: Int] = [:], toggles on: [Int: Set<String>] = [:],
    files: DataFiles? = nil
  ) {
    self = DeepStack.run { GraphAnalysis(reading: rows, theme: theme, previous: previous, toggles: on, files: files) }
  }

  private init(
    reading rows: [GraphRow], theme: GraphTheme, previous: [Int: Int], toggles on: [Int: Set<String>],
    files: DataFiles?
  ) {
    let texts = rows.map(\.text)
    let analysis = analyze(texts, files: files)
    // (A `#hex` note's color is read from the rows as written.)
    let colored = Graph2D.colors(
      analysis, ids: rows.map(\.id), previous: previous, theme: theme, sources: texts)
    // The toggles a row offers (web/main.ts `rowToggles`, and "all levels"
    // for `f(x, y) = c`), and which of them are on.
    var offered: [[RowStatus.Toggle]] = analysis.rows.indices.map { k in
      let row = analysis.rows[k]
      guard row.error == nil, row.unsupported == nil, let cpu = row.cpu else { return [] }
      let shown = on[rows[k].id] ?? []
      func toggle(_ id: String, _ label: String, _ help: String) -> RowStatus.Toggle {
        RowStatus.Toggle(id: id, label: label, help: help, on: shown.contains(id))
      }
      switch cpu.type {
      case "implicit2d":
        if case .implicit2d(_, _, .some) = cpu {
          return [toggle("levels", "all levels", "Draw the whole family of level sets (topographic map)")]
        }
        return []
      case "sequence":
        return [toggle("sums", "Σ partial sums", "Plot the partial sums S_N = Σ aₙ instead of the terms")]
      case "vfield3d":
        // Trajectories unless one of these is on.
        let lines =
          row.gpu?.type == "vfield3d"
          ? [toggle("streamlines", "streamlines", "Fill space with short streamlines drifting along the field")] : []
        return lines + [toggle("arrows", "arrows", "Show a lattice of direction arrows")]
      case "system", "complexSystem":
        // (Whether its panel lets it is the panel's graph's to say: below.)
        return [
          toggle(
            "certify", "certify search box",
            "Prove roots and completeness in the bounded search box; unsupported functions remain unresolved")
        ]
      case "tfield2d":
        // streamlines(M) asks for them in the text; nothing to toggle.
        if case .tfield2d(_, true, _) = cpu { return [] }
        return [
          toggle(
            "tensor", "streamlines", "Trace the major eigenvector of the symmetric part instead of drawing glyphs")
        ]
      case "pcurve":
        // A curve in space: its combs (web/main.ts `makeCurveUI`).
        guard case .pcurve(3, _, _, _, _) = cpu else { return [] }
        return [
          toggle("combK", "κ comb", "Curvature comb: tooth length κ, away from the center of curvature"),
          toggle("combT", "τ comb", "Torsion comb: signed teeth along the binormal"),
        ]
      default:
        return []
      }
    }
    var shown = RowToggles()
    for (k, toggles) in offered.enumerated() {
      for toggle in toggles where toggle.on {
        switch toggle.id {
        case "levels": shown.levels.insert(k)
        case "sums": shown.sums.insert(k)
        case "streamlines": shown.streamlines.insert(k)
        case "certify": shown.certified.insert(k)
        case "tensor": shown.tensors.insert(k)
        case "combK": shown.combK.insert(k)
        case "combT": shown.combT.insert(k)
        default: shown.arrows.insert(k)
        }
      }
    }
    content = GraphContent(analysis, colors: colored.colors, toggles: shown, theme: theme)
    slots = colored.slots
    // An orbit that cannot be integrated says so on its row, as the site sets it when it draws.
    var orbitErrors: [Int: String] = [:]
    for panel in content.panels.panels { orbitErrors.merge(panel.graph.orbitErrors) { a, _ in a } }
    // A 3D panel leaves its plane-only toggles out, and a 2D one those of
    // space; a system certifies where its panel's graph says it can.
    let planar: Set<String> = ["levels", "sums", "certify", "tensor"]
    for (k, framing) in content.framing.enumerated() {
      let graph = content.panels.panels[k].graph
      for row in content.panels.panels[k].rows {
        offered[row].removeAll { planar.contains($0.id) == (framing.space != nil) }
        offered[row].removeAll { $0.id == "certify" && !graph.canCertify(row: row) }
      }
    }
    // Syntax colors, as the site computes them (EquationCore `highlightRows`, lib/highlight.ts).
    let spans = highlightRows(texts, names: analysis.names)
    for (k, row) in analysis.rows.enumerated() {
      status.append(
        RowStatus(
          color: colored.colors[k].map { [Double($0.x), Double($0.y), Double($0.z)] },
          error: row.error ?? orbitErrors[k], info: row.info, comment: row.comment,
          view: row.view != nil && !row.divider, divider: row.divider, note: row.noteStart,
          spans: spans[k].map { RowStatus.Span(start: $0.start, end: $0.end, cls: $0.cls.rawValue) },
          slider: row.slider.map { RowStatus.Slider(min: $0.min, max: $0.max, step: $0.step, value: $0.value) },
          unsupported: row.error == nil ? row.unsupported.map(Self.notDrawnYet) : nil,
          toggles: offered[k].isEmpty ? nil : offered[k],
          // A row whose file is not here says so; the row that names the file asks for it.
          needsFile: row.error == nil ? row.dataLocal : nil,
          opensFile: row.definition?.kind == "table"))
    }
  }
}

/// The graph, drawn in Metal (MetalGraphView.swift).
struct GraphView: View {
  @Binding var document: GraphDocument
  var model: GraphModel
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    let theme = colorScheme == .dark ? GraphTheme.dark : .light
    let analysis = GraphAnalysis(
      rows: document.rows, theme: theme, previous: model.slots, toggles: model.toggles, files: document.files)
    let _ = connect(analysis, theme)
    MetalGraphView(content: analysis.content, theme: theme, generation: document.generation, model: model)
      .onChange(of: analysis.status, initial: true) { _, status in model.status = status }
  }

  /// Keep the model's side of the graph in step: the colors rows hold, and
  /// the way a slider's value is written back into its row.
  private func connect(_ analysis: GraphAnalysis, _ theme: GraphTheme) {
    model.theme = theme
    model.slots = analysis.slots
    let document = $document
    model.rows = { document.wrappedValue.rows.map(\.text) }
    model.ids = { document.wrappedValue.rows.map(\.id) }
    model.edit = { lines in document.wrappedValue.setLines(lines) }
    model.slide = { [weak model] index, value in
      var lines = document.wrappedValue.rows.map(\.text)
      guard lines.indices.contains(index),
        let moved = analyzeDeep(lines, files: document.wrappedValue.files)
          .settingSlider(row: index, to: value, in: lines[index]), moved != lines[index]
      else { return }
      lines[index] = moved
      // One drag of a slider is one undo step.
      model?.gestureEdit(lines)
    }
  }
}
