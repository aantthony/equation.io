import EquationCore
import EquationRender
import MetalKit
import SwiftUI

/// One panel's window or camera as it is now: where a hand, a move or its
/// row last put it.
struct PanelState: Equatable {
  var view = View2D()
  var camera = Camera3D()
  /// The camera's turn about the vertical axis, in radians a second, and
  /// the factor a new spin eases in by.
  var spin = 0.0
  var spinScale = 1.0
  /// Whether the panel has been given its opening window or camera.
  var framed = false
  /// Whether it was framed as a 3D panel.
  var spatial = false
  /// The text of the view(…) or camera(…) row the panel was last framed
  /// from, or last wrote: a row that differs is a new framing to take.
  var applied: String?
  /// The integral-curve seeds a viewer dropped on the panel's vector fields
  /// (web/session.ts `Panel.drops`): the view's, kept through every edit.
  var seeds: [FieldSeed] = []
  /// A hand or a move has changed the window since it was framed: until
  /// then a resized view frames it again (a window comes up at one size and
  /// settles at another, and a view(…) row's ranges should fill what it settles at).
  var touched = false
}

/// The panels' windows and cameras and the graph's clock, and the frame the
/// Metal view last drew, which the overlay drawn over it shows the rest of.
@MainActor @Observable
final class GraphViewport {
  var states: [PanelState] = []
  /// When the graph opened, which is when t was 0.
  var opened = Date.now
  /// The Metal view's size in device pixels, and how many of them make a point.
  var pixels = CGSize.zero
  var scale = 1.0
  /// The point under a drag, or the seed under the pointer, drawn with a halo.
  var hot: HotPoint?
  /// The frame as last drawn: each panel in its box, with what goes over
  /// the shader passes (the numbers along the axes, the rows the CPU
  /// evaluates, a 3D panel's names), and every panel's place for the edges.
  var frames: [PanelFrame] = []
  var layout: [PanelLayout] = []
  /// What the pointer rests on, said beside it (in points from the top-left corner).
  var hover: Hover?

  struct Hover: Equatable {
    var at: CGPoint
    var text: String
  }

  /// A time the clock is held at (EQUATION_SCRIPT's `at`), for a picture of that moment.
  @ObservationIgnored var frozen: Double?

  /// Seconds since the graph opened.
  var time: Double { frozen ?? Date.now.timeIntervalSince(opened) }

  /// Where the panels are, in device pixels from the top-left corner.
  func layout(_ content: GraphContent) -> [PanelLayout] {
    content.panels.layout(width: pixels.width, height: pixels.height, dpr: scale)
  }
}

/// The graph's Metal view, with the overlay over it.
struct MetalGraphView: View {
  var content: GraphContent
  var theme: GraphTheme
  var generation: Int
  var model: GraphModel
  @State private var viewport = GraphViewport()

  var body: some View {
    MetalCanvasView(content: content, theme: theme, generation: generation, viewport: viewport, model: model)
      .overlay {
        // Drawn again whenever the Metal view draws a frame that differs.
        Overlay(frames: viewport.frames, layout: viewport.layout, scale: viewport.scale, theme: theme)
          .allowsHitTesting(false)
      }
      .overlay(alignment: .topLeading) {
        if let hover = viewport.hover {
          Text(hover.text)
            .font(.system(.caption, design: .monospaced))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(.regularMaterial, in: .rect(cornerRadius: 6))
            .fixedSize()
            .offset(x: hover.at.x + 12, y: hover.at.y - 28)
            .allowsHitTesting(false)
        }
      }
  }
}

/// What is drawn over the shader passes, panel by panel: the numbers along
/// the axes and the rows the CPU evaluates in 2D, the axes' and points'
/// names in 3D, and the edges between panels (EquationRender `drawPanelLabels`).
private struct Overlay: View, Equatable {
  var frames: [PanelFrame]
  var layout: [PanelLayout]
  /// Device pixels per point.
  var scale: Double
  var theme: GraphTheme

  var body: some View {
    Canvas { context, size in
      context.withCGContext { ctx in
        drawPanelLabels(ctx, frames, size: size, dpr: scale, theme: theme, edges: layout)
      }
    }
  }
}

// MARK: - The Metal view

private struct MetalCanvasView {
  var content: GraphContent
  var theme: GraphTheme
  var generation: Int
  var viewport: GraphViewport
  var model: GraphModel

  @MainActor final class Coordinator {
    var generation: Int?
    weak var model: GraphModel?
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  @MainActor private func make(_ coordinator: Coordinator) -> MetalCanvas {
    let canvas = MetalCanvas(viewport: viewport)
    update(canvas, coordinator)
    #if DEBUG
      canvas.runDebugScript()
    #endif
    return canvas
  }

  @MainActor private func update(_ canvas: MetalCanvas, _ coordinator: Coordinator) {
    canvas.model = model
    // A replaced document opens as a new graph: reframed, its clock at zero.
    if let shown = coordinator.generation, shown != generation { canvas.open() }
    canvas.content = content
    canvas.theme = theme
    coordinator.generation = generation
    coordinator.model = model
    model.metal = canvas
  }

  @MainActor private static func dismantle(_ canvas: MetalCanvas, _ coordinator: Coordinator) {
    if coordinator.model?.metal === canvas { coordinator.model?.metal = nil }
  }
}

#if os(iOS)
  extension MetalCanvasView: UIViewRepresentable {
    func makeUIView(context: Context) -> MetalCanvas { make(context.coordinator) }
    func updateUIView(_ canvas: MetalCanvas, context: Context) { update(canvas, context.coordinator) }
    static func dismantleUIView(_ canvas: MetalCanvas, coordinator: Coordinator) { dismantle(canvas, coordinator) }
  }
#else
  extension MetalCanvasView: NSViewRepresentable {
    func makeNSView(context: Context) -> MetalCanvas { make(context.coordinator) }
    func updateNSView(_ canvas: MetalCanvas, context: Context) { update(canvas, context.coordinator) }
    static func dismantleNSView(_ canvas: MetalCanvas, coordinator: Coordinator) { dismantle(canvas, coordinator) }
  }
#endif
