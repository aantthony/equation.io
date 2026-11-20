import EquationCore
import EquationRender
import MetalKit
import SwiftUI

/// The window onto the plane, shared by the Metal view and the labels over it.
@MainActor @Observable
final class GraphViewport {
  var view = View2D()
}

/// The graph's Metal view, with the overlay's labels over it.
struct MetalGraphView: View {
  var analysis: GraphAnalysis
  var theme: GraphTheme
  var generation: Int
  var model: GraphModel
  @State private var viewport = GraphViewport()
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    MetalCanvasView(analysis: analysis, theme: theme, generation: generation, viewport: viewport, model: model)
      .overlay {
        AxisLabels(view: viewport.view, scale: displayScale, theme: theme)
          .allowsHitTesting(false)
      }
  }
}

/// The overlay: the numbers along the axes (EquationRender `drawLabels2D`).
private struct AxisLabels: View {
  var view: View2D
  /// Device pixels per point.
  var scale: Double
  var theme: GraphTheme

  var body: some View {
    Canvas { context, size in
      context.withCGContext { ctx in
        drawLabels2D(ctx, size: size, view: view, dpr: scale, theme: theme)
      }
    }
  }
}

// MARK: - The Metal view

private struct MetalCanvasView {
  var analysis: GraphAnalysis
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
    return canvas
  }

  @MainActor private func update(_ canvas: MetalCanvas, _ coordinator: Coordinator) {
    canvas.layers = analysis.layers
    canvas.theme = theme
    canvas.animated = analysis.animated
    // A replaced document opens as a new graph: reframed, its clock at zero.
    if let shown = coordinator.generation, shown != generation { canvas.open() }
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

/// Draws the graph, and moves its window: a drag or a two-finger scroll
/// pans, a pinch (or Shift and a scroll) zooms about the pointer.
final class MetalCanvas: MTKView, MTKViewDelegate {
  let viewport: GraphViewport
  private let renderer: Renderer2D?

  var layers = Layers2D() {
    didSet { if layers != oldValue { redraw() } }
  }
  var theme = GraphTheme.light {
    didSet { if theme != oldValue { redraw() } }
  }
  /// Redraw every frame rather than on demand.
  var animated = false {
    didSet {
      guard animated != oldValue else { return }
      isPaused = !animated
      enableSetNeedsDisplay = !animated
      redraw()
    }
  }

  /// Whether the view has been given its opening window.
  private var framed = false
  /// When the graph opened, which is when t was 0.
  private var opened = CACurrentMediaTime()
  private var glide: Task<Void, Never>?

  init(viewport: GraphViewport) {
    self.viewport = viewport
    let metal = MetalContext()
    renderer = metal.map(Renderer2D.init)
    super.init(frame: .zero, device: metal?.device)
    colorPixelFormat = MetalContext.pixelFormat
    isPaused = true
    enableSetNeedsDisplay = true
    delegate = self
    #if os(macOS)
      // The colors are sRGB, as the web renderer's are; without this they
      // are taken as the display's own, and a wide-gamut display oversaturates them.
      colorspace = CGColorSpace(name: CGColorSpace.sRGB)
    #else
      let pan = UIPanGestureRecognizer(target: self, action: #selector(panned))
      pan.allowedScrollTypesMask = .all
      pan.delegate = self
      addGestureRecognizer(pan)
      let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched))
      pinch.delegate = self
      addGestureRecognizer(pinch)
    #endif
  }

  @available(*, unavailable)
  required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /// Show a new graph: the opening window, and t from 0.
  func open() {
    glide?.cancel()
    framed = false
    opened = CACurrentMediaTime()
    frame(in: drawableSize)
    redraw()
  }

  private func redraw() {
    #if os(macOS)
      needsDisplay = true
    #else
      setNeedsDisplay()
    #endif
  }

  /// The opening window: the origin at the center, 12 units across the shorter side.
  private func frame(in size: CGSize) {
    guard !framed, size.width > 0, size.height > 0 else { return }
    framed = true
    viewport.view = .opening(width: size.width, height: size.height)
  }

  // MARK: Drawing

  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
    frame(in: size)
    redraw()
  }

  func draw(in view: MTKView) {
    let size = drawableSize
    frame(in: size)
    guard let renderer, size.width > 0, size.height > 0, let pass = currentRenderPassDescriptor,
      let drawable = currentDrawable, let buffer = renderer.metal.queue.makeCommandBuffer(),
      let encoder = buffer.makeRenderCommandEncoder(descriptor: pass)
    else { return }
    renderer.render(
      encoder, target: (Int(size.width), Int(size.height)), view: viewport.view, layers: layers,
      time: CACurrentMediaTime() - opened, theme: theme)
    encoder.endEncoding()
    buffer.present(drawable)
    buffer.commit()
  }

  // MARK: Moving the window

  /// Device pixels per point.
  private var scale: Double { bounds.width > 0 ? drawableSize.width / bounds.width : 1 }

  /// Move the window as if the plot were dragged by (dx, dy) points, dy down the screen.
  private func pan(dx: Double, dy: Double) {
    glide?.cancel()
    viewport.view.cx -= dx * scale * viewport.view.upp
    viewport.view.cy += dy * scale * viewport.view.upp
    redraw()
  }

  /// Zoom by `factor`, keeping the math point under `point` where it is.
  /// `point` is in points from the view's center, y up.
  private func zoom(at point: CGPoint, by factor: Double) {
    guard factor > 0, factor.isFinite else { return }
    var view = viewport.view
    let px = point.x * scale
    let py = point.y * scale
    let mx = view.cx + px * view.upp
    let my = view.cy + py * view.upp
    view.upp = min(max(view.upp * factor, 1e-12), 1e12)
    view.cx = mx - px * view.upp
    view.cy = my - py * view.upp
    viewport.view = view
    redraw()
  }

  /// The visible window, in math units.
  var visible: (x: [Double], y: [Double]) {
    let view = viewport.view
    let halfX = Double(drawableSize.width) / 2 * view.upp
    let halfY = Double(drawableSize.height) / 2 * view.uppY
    return ([view.cx - halfX, view.cx + halfX], [view.cy - halfY, view.cy + halfY])
  }

  /// Ease the window to show the given ranges (one alone keeps the other
  /// axis's center, at the same scale), arriving after `seconds`.
  func glide(x: (Double, Double)?, y: (Double, Double)?, seconds: Double) async {
    glide?.cancel()
    let size = drawableSize
    guard size.width > 0, size.height > 0 else { return }
    let from = viewport.view
    var to = from
    if let x { to.cx = (x.0 + x.1) / 2 }
    if let y { to.cy = (y.0 + y.1) / 2 }
    // The scale that shows every range asked for.
    to.upp = max(x.map { ($0.1 - $0.0) / size.width } ?? 0, y.map { ($0.1 - $0.0) / size.height } ?? 0)
    let start = CACurrentMediaTime()
    let task = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        let k = seconds > 0 ? min((CACurrentMediaTime() - start) / seconds, 1) : 1
        let eased = k * k * (3 - 2 * k)
        var view = from
        view.cx = from.cx + (to.cx - from.cx) * eased
        view.cy = from.cy + (to.cy - from.cy) * eased
        view.upp = from.upp * pow(to.upp / from.upp, eased)
        self?.viewport.view = view
        self?.redraw()
        if k >= 1 { break }
        try? await Task.sleep(for: .milliseconds(8))
      }
    }
    glide = task
    await task.value
  }

  /// Glide the zoom about the graph's center: below 1 zooms in, above 1 out.
  func glideZoom(by factor: Double) {
    glide?.cancel()
    let total = log(factor)
    let start = CACurrentMediaTime()
    glide = Task { @MainActor [weak self] in
      var applied = 0.0
      while !Task.isCancelled {
        let k = min((CACurrentMediaTime() - start) / 0.25, 1)
        let eased = k * k * (3 - 2 * k)
        self?.zoom(at: .zero, by: exp(total * eased - applied))
        applied = total * eased
        if k >= 1 { break }
        try? await Task.sleep(for: .milliseconds(8))
      }
    }
  }

  #if os(macOS)
    private var dragged: CGPoint?

    private func fromCenter(_ event: NSEvent) -> CGPoint {
      let p = convert(event.locationInWindow, from: nil)
      return CGPoint(x: p.x - bounds.midX, y: p.y - bounds.midY)
    }

    override func mouseDown(with event: NSEvent) {
      glide?.cancel()
      dragged = convert(event.locationInWindow, from: nil)
    }

    override func mouseDragged(with event: NSEvent) {
      let p = convert(event.locationInWindow, from: nil)
      if let last = dragged { pan(dx: p.x - last.x, dy: last.y - p.y) }
      dragged = p
    }

    override func mouseUp(with event: NSEvent) { dragged = nil }

    /// The app scrolls like Maps: two fingers (or a wheel) pan; with Shift it zooms.
    override func scrollWheel(with event: NSEvent) {
      let lines = event.hasPreciseScrollingDeltas ? 1.0 : 10.0
      if event.modifierFlags.contains(.shift) {
        // Shift turns a wheel's motion sideways.
        let turned = event.scrollingDeltaY != 0 ? event.scrollingDeltaY : event.scrollingDeltaX
        glide?.cancel()
        zoom(at: fromCenter(event), by: exp(min(max(-turned * lines, -60), 60) * 0.002))
      } else {
        pan(dx: event.scrollingDeltaX * lines, dy: event.scrollingDeltaY * lines)
      }
    }

    override func magnify(with event: NSEvent) {
      glide?.cancel()
      zoom(at: fromCenter(event), by: 1 / max(1 + event.magnification, 0.01))
    }
  #else
    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
      let moved = gesture.translation(in: self)
      gesture.setTranslation(.zero, in: self)
      pan(dx: moved.x, dy: moved.y)
    }

    @objc private func pinched(_ gesture: UIPinchGestureRecognizer) {
      guard gesture.scale > 0 else { return }
      let p = gesture.location(in: self)
      glide?.cancel()
      zoom(at: CGPoint(x: p.x - bounds.midX, y: bounds.midY - p.y), by: 1 / gesture.scale)
      gesture.scale = 1
    }
  #endif
}

#if os(iOS)
  extension MetalCanvas: UIGestureRecognizerDelegate {
    /// A pinch pans as its fingers move.
    func gestureRecognizer(_ a: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith b: UIGestureRecognizer) -> Bool {
      true
    }
  }
#endif
