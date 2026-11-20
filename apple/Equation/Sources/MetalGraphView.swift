import EquationCore
import MetalKit
import SwiftUI

/// The setting that draws graphs in Metal where it can: View ▸ Draw with
/// Metal, or `EQUATION_RENDERER=metal` in the environment.
let metalRendererKey = "metalRenderer"

/// The graph. The web renderer draws it, and reports on the rows either way;
/// with the Metal renderer switched on, a document whose every row Metal can
/// draw is drawn by it instead, over the web view. Any other row (a slider,
/// a surface, a point, …) leaves the whole document to the web renderer.
struct GraphSurface: View {
  @Binding var document: GraphDocument
  var model: GraphModel
  @AppStorage(metalRendererKey) private var metal = false
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    let theme = colorScheme == .dark ? GraphTheme.dark : .light
    ZStack {
      GraphView(document: $document, model: model)
      if metal, MetalCanvas.available, let scene = MetalScene(rows: document.rows, status: model.status, theme: theme) {
        MetalGraphView(scene: scene, theme: theme, generation: document.generation, model: model)
      }
    }
  }
}

/// What the Metal renderer draws for a document.
struct MetalScene: Equatable {
  var curves: [MetalCurve] = []
  /// A row reads t, so the graph redraws every frame.
  var animated = false

  /// Nil when a row is not one the Metal renderer draws yet.
  init?(rows: [GraphRow], status: [RowStatus], theme: GraphTheme) {
    for (index, row) in rows.enumerated() {
      guard let plot = plotRow(row.text) else { return nil }
      guard case .curve(let field, let animated) = plot else { continue }
      // The web renderer's color for the row, once it has reported on these
      // rows; until then, the palette in order.
      var color = theme.palette[curves.count % theme.palette.count]
      if status.count == rows.count, let reported = status[index].color, reported.count == 3 {
        color = SIMD3(Float(reported[0]), Float(reported[1]), Float(reported[2]))
      }
      curves.append(MetalCurve(field: field, color: color))
      if animated { self.animated = true }
    }
  }
}

/// The window onto the plane, shared by the Metal view and the labels over it.
@MainActor @Observable
final class GraphViewport {
  var view = View2D()
}

private struct MetalGraphView: View {
  var scene: MetalScene
  var theme: GraphTheme
  var generation: Int
  var model: GraphModel
  @State private var viewport = GraphViewport()
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    MetalCanvasView(scene: scene, theme: theme, generation: generation, viewport: viewport, model: model)
      .overlay {
        AxisLabels(view: viewport.view, scale: displayScale, color: theme.label)
          .allowsHitTesting(false)
      }
  }
}

/// The numbers along the axes (web/render2d.ts `drawLabels2D`): at each major
/// grid line, beside the axis, or along the edge once the axis is off screen.
private struct AxisLabels: View {
  var view: View2D
  /// Device pixels per point.
  var scale: Double
  var color: SIMD3<Float>

  var body: some View {
    Canvas { context, size in
      let w = size.width
      let h = size.height
      let upp = view.upp * scale  // math units per point
      let major = niceSpacing(upp: view.upp, minPx: 90).major
      guard w > 0, h > 0, upp > 0, major > 0, major.isFinite else { return }
      let screenX = { (x: Double) in (x - view.cx) / upp + w / 2 }
      let screenY = { (y: Double) in h / 2 - (y - view.cy) / upp }
      let axisY = min(max(screenY(0), 12), h - 6)
      let axisX = min(max(screenX(0), 4), w - 30)
      let style = Color(red: Double(color.x), green: Double(color.y), blue: Double(color.z))

      func label(_ value: Double, x: Double, baseline: Double) {
        let text = context.resolve(Text(axisLabel(value)).font(.system(size: 11)).foregroundStyle(style))
        let rise = text.firstBaseline(in: CGSize(width: 400, height: 100))
        context.draw(text, at: CGPoint(x: x, y: baseline - rise), anchor: .topLeading)
      }
      /// The multiples of the major spacing between two edges, but zero.
      func ticks(from low: Double, to high: Double) -> [Double] {
        let first = (low / major).rounded(.up)
        let count = min(max(Int((high / major).rounded(.down) - first) + 1, 0), 200)
        return (0..<count).map { (first + Double($0)) * major }.filter { abs($0) >= major / 2 }
      }

      for x in ticks(from: view.cx - w / 2 * upp, to: view.cx + w / 2 * upp) {
        label(x, x: screenX(x) + 2, baseline: axisY + 13 <= h ? axisY + 13 : axisY - 4)
      }
      for y in ticks(from: view.cy - h / 2 * upp, to: view.cy + h / 2 * upp) {
        label(y, x: axisX + 4, baseline: screenY(y) - 3)
      }
    }
  }
}

/// An axis numeral: plain to ten significant digits, 1e5 and 2e-5 beyond.
func axisLabel(_ value: Double) -> String {
  if value == 0 { return "0" }
  let magnitude = abs(value)
  if magnitude >= 1e5 || magnitude < 1e-4 {
    var exponent = Int(floor(log10(magnitude)))
    var mantissa = (value / pow(10, Double(exponent))).rounded()
    if abs(mantissa) >= 10 {
      mantissa /= 10
      exponent += 1
    }
    return "\(Int(mantissa))e\(exponent)"
  }
  let rounded = Double(String(format: "%.9e", value)) ?? value
  let text = "\(rounded)"
  return text.hasSuffix(".0") ? String(text.dropLast(2)) : text
}

// MARK: - The Metal view

private struct MetalCanvasView {
  var scene: MetalScene
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
    canvas.curves = scene.curves
    canvas.theme = theme
    canvas.animated = scene.animated
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
  static let available = MTLCreateSystemDefaultDevice() != nil

  let viewport: GraphViewport
  private let renderer: MetalRenderer?

  var curves: [MetalCurve] = [] {
    didSet { if curves != oldValue { redraw() } }
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
    let device = MTLCreateSystemDefaultDevice()
    renderer = MetalRenderer(device: device)
    super.init(frame: .zero, device: device)
    colorPixelFormat = MetalRenderer.pixelFormat
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
    viewport.view = View2D(cx: 0, cy: 0, upp: 12 / min(size.width, size.height))
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
      let drawable = currentDrawable,
      let buffer = renderer.draw(
        pass: pass, size: SIMD2(Float(size.width), Float(size.height)), view: viewport.view, curves: curves,
        time: Float(CACurrentMediaTime() - opened), theme: theme)
    else { return }
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
