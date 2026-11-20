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

  /// Sliders arrive with the language's definitions.
  func setSlider(row index: Int, to value: Double) {}

  /// Glide the zoom about the graph's center: below 1 zooms in, above 1 out.
  func zoom(by factor: Double) {
    metal?.glideZoom(by: factor)
  }

  /// The status of `rows`: they are analyzed as they are asked about, so
  /// there is nothing to wait for.
  func status(after rows: [String]) async -> [RowStatus] {
    GraphAnalysis(rows: rows, theme: theme).status
  }
}

/// What the app makes of a document's rows: each row's status, and what to draw.
///
/// For now a row is drawn when it is an equation in x and y (EquationCore
/// `plotRow`); the language's own pipeline replaces this as it is ported.
struct GraphAnalysis: Equatable {
  var status: [RowStatus] = []
  var layers = Layers2D()
  /// A row reads t, so the graph redraws every frame.
  var animated = false

  static let notDrawnYet = "The app doesn't draw this kind of row yet."

  init(rows: [String], theme: GraphTheme) {
    var curves: [Curve2D] = []
    var slot = 0
    for text in rows {
      var row = RowStatus(
        color: nil, error: nil, info: nil, comment: false, view: false, divider: false, note: nil, spans: [],
        slider: nil)
      switch plotRow(text) {
      case .nothing?:
        row.comment = text.contains("#")
      case .curve(let field, let animated)?:
        let color = theme.palette[slot % theme.palette.count]
        slot += 1
        row.color = [Double(color.x), Double(color.y), Double(color.z)]
        curves.append(Curve2D(field: field, color: color))
        if animated { self.animated = true }
      case nil:
        // A row with an error takes a color: it is usually a curve being typed.
        let color = theme.palette[slot % theme.palette.count]
        slot += 1
        row.color = [Double(color.x), Double(color.y), Double(color.z)]
        row.error = Self.notDrawnYet
      }
      status.append(row)
    }
    layers.curves = curves
  }
}

/// The graph, drawn in Metal (MetalGraphView.swift).
struct GraphView: View {
  @Binding var document: GraphDocument
  var model: GraphModel
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    let theme = colorScheme == .dark ? GraphTheme.dark : .light
    let analysis = GraphAnalysis(rows: document.rows.map(\.text), theme: theme)
    MetalGraphView(analysis: analysis, theme: theme, generation: document.generation, model: model)
      .onChange(of: analysis.status, initial: true) { _, status in
        model.theme = theme
        model.status = status
      }
  }
}
