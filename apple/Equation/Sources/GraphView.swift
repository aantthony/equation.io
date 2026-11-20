import EquationCore
import EquationRender
import SwiftUI

/// One open document's graph: what the renderer says about the rows, and the
/// way to move its window.
@MainActor @Observable
final class GraphModel {
  /// Index-aligned with the document's rows.
  var status: [RowStatus] = []
  /// The Metal view drawing the graph (MetalGraphView.swift).
  @ObservationIgnored weak var metal: MetalCanvas?
  /// The theme the graph is drawn in, which picks the rows' colors.
  @ObservationIgnored var theme = GraphTheme.light

  /// Each row's palette slot, by the editor's id for it, so a row keeps its
  /// color as others come and go.
  @ObservationIgnored var slots: [Int: Int] = [:]
  /// Writes a slider's new value into its row (GraphView sets this).
  @ObservationIgnored var slide: (Int, Double) -> Void = { _, _ in }

  func setSlider(row index: Int, to value: Double) {
    slide(index, value)
  }

  /// Glide the zoom about the graph's center: below 1 zooms in, above 1 out.
  func zoom(by factor: Double) {
    metal?.glideZoom(by: factor)
  }

  /// The status of `rows`: they are analyzed as they are asked about, so
  /// there is nothing to wait for.
  func status(after rows: [String]) async -> [RowStatus] {
    GraphAnalysis(rows: rows.enumerated().map { GraphRow(id: -1 - $0.offset, text: $0.element) }, theme: theme).status
  }
}

/// What the app makes of a document's rows: each row's status for the
/// editor, and what to draw (EquationCore `analyze`, EquationRender `Graph2D`).
struct GraphAnalysis: Equatable {
  var status: [RowStatus] = []
  var graph: Graph2D
  /// Each row's palette slot, by its id.
  var slots: [Int: Int]

  /// What a row the language's port can't read yet says, with the port's reason.
  static func notDrawnYet(_ reason: String) -> String {
    "The app doesn't draw this yet (\(reason))."
  }

  init(rows: [GraphRow], theme: GraphTheme, previous: [Int: Int] = [:]) {
    let texts = rows.map(\.text)
    let analysis = analyze(texts)
    let colored = Graph2D.colors(analysis, ids: rows.map(\.id), previous: previous, theme: theme)
    graph = Graph2D(analysis, colors: colored.colors)
    slots = colored.slots
    // Syntax colors, as the site computes them (EquationCore `highlightRows`, lib/highlight.ts).
    let spans = highlightRows(texts, names: analysis.names)
    for (k, row) in analysis.rows.enumerated() {
      var error = row.error ?? row.unsupported.map(Self.notDrawnYet)
      if error == nil {
        // Rows the language reads and the app has nowhere to show yet.
        switch row.view {
        case .split?: error = Self.notDrawnYet("split views")
        case .camera?: error = Self.notDrawnYet("3D")
        default: break
        }
      }
      status.append(
        RowStatus(
          color: colored.colors[k].map { [Double($0.x), Double($0.y), Double($0.z)] },
          error: error, info: row.info, comment: row.comment, view: row.view != nil && !row.divider,
          divider: row.divider, note: row.noteStart,
          spans: spans[k].map { RowStatus.Span(start: $0.start, end: $0.end, cls: $0.cls.rawValue) },
          slider: row.slider.map { RowStatus.Slider(min: $0.min, max: $0.max, step: $0.step, value: $0.value) }))
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
    let analysis = GraphAnalysis(rows: document.rows, theme: theme, previous: model.slots)
    let _ = connect(analysis, theme)
    MetalGraphView(graph: analysis.graph, theme: theme, generation: document.generation, model: model)
      .onChange(of: analysis.status, initial: true) { _, status in model.status = status }
  }

  /// Keep the model's side of the graph in step: the colors rows hold, and
  /// the way a slider's value is written back into its row.
  private func connect(_ analysis: GraphAnalysis, _ theme: GraphTheme) {
    model.theme = theme
    model.slots = analysis.slots
    let document = $document
    model.slide = { index, value in
      var lines = document.wrappedValue.rows.map(\.text)
      guard lines.indices.contains(index),
        let moved = analyze(lines).settingSlider(row: index, to: value, in: lines[index]), moved != lines[index]
      else { return }
      lines[index] = moved
      document.wrappedValue.setLines(lines)
    }
  }
}
