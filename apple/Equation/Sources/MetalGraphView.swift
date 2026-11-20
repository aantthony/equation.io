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
  /// A hand or a move has changed the window since it was framed: until
  /// then a resized view frames it again (a window comes up at one size and
  /// settles at another, and a view(…) row's ranges should fill what it settles at).
  var touched = false
}

/// The panels' windows and cameras and the graph's clock, shared by the
/// Metal view and the overlay drawn over it.
@MainActor @Observable
final class GraphViewport {
  var states: [PanelState] = []
  /// When the graph opened, which is when t was 0.
  var opened = Date.now
  /// The Metal view's size in device pixels, and how many of them make a point.
  var pixels = CGSize.zero
  var scale = 1.0
  /// The point under a drag, drawn with a halo.
  var hot: Int?

  /// Seconds since the graph opened.
  var time: Double { Date.now.timeIntervalSince(opened) }

  /// Where the panels are, in device pixels from the top-left corner.
  func boxes(_ content: GraphPanels) -> [PanelBox] {
    panelBoxes(content.splits, width: pixels.width, height: pixels.height, margin: (12 * scale).rounded())
  }

  /// The frame as it is at `time`: each panel's box, and what it shows
  /// there. `overlay` adds what the CPU evaluates for the 2D panels (the
  /// points and curves drawn over the shader passes).
  func frames(_ content: GraphPanels, time: Double, overlay: Bool) -> [PanelFrame] {
    let boxes = boxes(content)
    return content.panels.indices.compactMap { k -> PanelFrame? in
      guard k < states.count, k < boxes.count else { return nil }
      let panel = content.panels[k]
      if let space = panel.space {
        let camera = states[k].camera
        return PanelFrame(
          box: boxes[k], content: .space(camera: camera, scene: space.scene(at: time, camera: camera)),
          env: space.environment(at: time), grid: panel.grid)
      }
      var extras: Overlay2D?
      if overlay {
        var drawn = panel.plane.overlay(at: time)
        if let hot, panel.rows.contains(hot) {
          var env = panel.plane.environment(at: time)
          env["t"] = time
          // The overlay doesn't say which row a dot is: the one where the held point is.
          for at in content.analysis.grabPoints(rows: hot..<(hot + 1), env: env) {
            for index in drawn.points.indices where drawn.points[index].x == at.x && drawn.points[index].y == at.y {
              drawn.points[index].hot = true
            }
          }
        }
        extras = drawn
      }
      return PanelFrame(
        box: boxes[k], content: .plane(view: states[k].view, layers: panel.plane.layers, overlay: extras),
        env: panel.plane.environment(at: time), grid: panel.grid)
    }
  }
}

/// The graph's Metal view, with the overlay over it.
struct MetalGraphView: View {
  var content: GraphPanels
  var theme: GraphTheme
  var generation: Int
  var model: GraphModel
  @State private var viewport = GraphViewport()

  var body: some View {
    MetalCanvasView(content: content, theme: theme, generation: generation, viewport: viewport, model: model)
      .overlay {
        // A graph that moves redraws its overlay with every frame; a
        // window or a camera that moves, as the viewport says it has.
        TimelineView(.animation(paused: !content.animated)) { timeline in
          Overlay(
            frames: viewport.frames(content, time: timeline.date.timeIntervalSince(viewport.opened), overlay: true),
            scale: viewport.scale, theme: theme)
        }
        .allowsHitTesting(false)
      }
  }
}

/// What is drawn over the shader passes, panel by panel: the numbers along
/// the axes and the rows the CPU evaluates in 2D, the axes' and points'
/// names in 3D (EquationRender `drawPanelLabels`).
private struct Overlay: View, Equatable {
  var frames: [PanelFrame]
  /// Device pixels per point.
  var scale: Double
  var theme: GraphTheme

  var body: some View {
    Canvas { context, size in
      context.withCGContext { ctx in
        drawPanelLabels(ctx, frames, size: size, dpr: scale, theme: theme)
      }
    }
  }
}

// MARK: - The Metal view

private struct MetalCanvasView {
  var content: GraphPanels
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
