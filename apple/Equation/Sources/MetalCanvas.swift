import EquationCore
import EquationRender
import MetalKit
import SwiftUI

/// Draws the graph's panels, and moves their windows and cameras: under the
/// hand (GraphGestures.swift), for Ask's move_view and the Zoom commands,
/// and as a camera(…) row's spin turns it. What a hand does here is what
/// web/main.ts's pointer and wheel handlers do; the arithmetic is
/// EquationRender's (ViewMoves.swift, PanelWindows.swift, PointDrag.swift).
///
/// It owns what a frame needs beyond the rows: each panel's window or
/// camera, the clock, and the run of the document's states (`a' = …`), an
/// EquationCore `StateStepper` advanced to each frame's time.
final class MetalCanvas: MTKView, MTKViewDelegate {
  let viewport: GraphViewport
  private let renderer: FrameRenderer?
  /// The document's side: its rows, and the way to rewrite them.
  weak var model: GraphModel?

  var content: GraphContent? {
    didSet {
      // The same graph made again keeps the one that has drawn: what it
      // solved and traced is kept with it.
      guard content != oldValue else { return content = oldValue }
      // A system written as it was keeps its run through the edit; any other starts again.
      if let content {
        if run == nil { run = StateStepper(content.analysis) } else { run?.adopt(content.analysis) }
      }
      reconcile()
      updatePacing()
      redraw()
    }
  }
  var theme = GraphTheme.light {
    didSet { if theme != oldValue { redraw() } }
  }

  /// The states where the last frame left them, and the trails behind them.
  private(set) var run: StateStepper?

  /// The panel the last gesture was in: what the Zoom commands move.
  var active = 0
  /// A pointer or a finger is down on the graph.
  var held = false
  /// The point a drag has hold of, and where the pointer took it.
  var grab: (target: Grabbable.Target, dx: Double, dy: Double)?
  /// Where the pointer came down, and whether it has moved from there: a
  /// click that has not drops a seed (the site's `dragMoved`).
  private var down = CGPoint.zero
  private var wandered = false
  /// When the rows' notes were last handed to the model.
  private var noted = 0.0
  /// A drag that slides a 3D camera's target, not one that orbits it.
  var panning = false
  var coast = Coast()
  /// Where the pointer last was, for the Mac's drags.
  var last = CGPoint.zero
  /// The pan under way is a trackpad's scroll, not a finger's drag (iPad).
  var scrolling = false

  private var glide: Task<Bool, Never>?
  /// A hand is on the graph or a move is in flight: what is written meanwhile is one gesture's.
  var busy: Bool { held || glide != nil }
  private var coasting: Task<Void, Never>?
  private var spinEase: Task<Void, Never>?
  private var refine: Task<Void, Never>?
  private var writeback: Task<Void, Never>?
  /// Panels whose window or camera moved since their rows were last written.
  private var moved: Set<Int> = []
  private var lastFrame: Double?
  /// Frames drawn since the view was made (EQUATION_SCRIPT's `state` reports it).
  private(set) var drawn = 0

  init(viewport: GraphViewport) {
    self.viewport = viewport
    let metal = MetalContext()
    renderer = metal.map(FrameRenderer.init)
    super.init(frame: .zero, device: metal?.device)
    colorPixelFormat = MetalContext.pixelFormat
    isPaused = true
    enableSetNeedsDisplay = true
    delegate = self
    #if os(macOS)
      // The colors are sRGB, as the site's canvas takes them; without this
      // they are taken as the display's own, and a wide-gamut display
      // oversaturates them.
      colorspace = CGColorSpace(name: CGColorSpace.sRGB)
    #endif
    installGestures()
  }

  @available(*, unavailable)
  required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /// Show a new graph: each panel's opening window or camera, t from 0, and
  /// every state at its start.
  func open() {
    stopMoves()
    writeback?.cancel()
    writeback = nil
    moved = []
    viewport.states = []
    viewport.opened = .now
    viewport.hot = nil
    viewport.hover = nil
    run = nil
    active = 0
    reconcile()
    redraw()
  }

  /// Start the clock and the states again (the site's ↻), leaving the view where it is.
  func restart() {
    viewport.opened = .now
    run = content.map { StateStepper($0.analysis) }
    lastFrame = nil
    redraw()
  }

  func redraw() {
    #if os(macOS)
      needsDisplay = true
    #else
      setNeedsDisplay()
    #endif
  }

  /// Device pixels per point.
  var scale: Double { bounds.width > 0 ? drawableSize.width / bounds.width : 1 }

  // MARK: Framing

  /// Bring the panels' states in step with the document: one each, and a
  /// view(…) or camera(…) row that changed under a panel is a new framing
  /// for it (web/scene.ts `applyViewportRows`).
  private func reconcile() {
    guard let content else { return }
    var states = viewport.states
    let count = content.panels.panels.count
    if states.count > count { states.removeLast(states.count - count) }
    while states.count < count { states.append(PanelState()) }
    for (k, framing) in content.framing.enumerated() where states[k].framed {
      let text = framing.frameRow.map { content.analysis.rows[$0].text }
      if states[k].spatial != (framing.space != nil) {
        states[k].framed = false
      } else if text != states[k].applied {
        // A row that is gone leaves the panel where it is, but no longer turning.
        if text == nil {
          states[k].applied = nil
          states[k].spin = 0
        } else {
          states[k].framed = false
        }
      }
    }
    if states != viewport.states { viewport.states = states }
    frame(in: drawableSize)
  }

  /// Give each panel not yet framed its opening window or camera
  /// (`GraphPanels.opening`: what its row asks for, or else the origin at
  /// the center with 12 units across the shorter side, a lattice on its
  /// cells), or the camera a 3D graph opens with; then carry shared axes
  /// from the panels that own them.
  private func frame(in size: CGSize) {
    guard let content, size.width > 0, size.height > 0 else { return }
    // Of the size being framed: on a resize the view's own drawable is still the old one.
    let scale = bounds.width > 0 ? size.width / bounds.width : 1
    var states = viewport.states
    if viewport.pixels != size {
      viewport.pixels = size
      // A window nothing has moved yet is framed again for its new box.
      for k in states.indices where !states[k].touched && !states[k].spatial { states[k].framed = false }
    }
    if viewport.scale != scale { viewport.scale = scale }
    guard states.count == content.framing.count, states.contains(where: { !$0.framed }) else { return }
    let layout = viewport.layout(content)
    let opening = content.panels.opening(width: size.width, height: size.height, dpr: scale)
    for (k, framing) in content.framing.enumerated() where !states[k].framed {
      states[k].framed = true
      states[k].touched = false
      states[k].spatial = framing.space != nil
      states[k].applied = framing.frameRow.map { content.analysis.rows[$0].text }
      if let space = framing.space {
        states[k].camera = framing.camera ?? space.opening
        states[k].spin = framing.spin
        states[k].spinScale = 1
      } else if k < opening.count {
        states[k].view = opening[k]
      }
    }
    var views = states.map(\.view)
    syncLinks(&views, layout)
    for k in states.indices { states[k].view = views[k] }
    viewport.states = states
    updatePacing()
  }

  /// A graph that moves, or a camera that turns, redraws every frame; any
  /// other redraws when something changes.
  private func updatePacing() {
    let continuous =
      content?.animated == true || viewport.states.contains { $0.spatial && $0.spin != 0 }
    guard isPaused == continuous else { return }
    isPaused = !continuous
    enableSetNeedsDisplay = !continuous
    lastFrame = nil
    redraw()
  }

  // MARK: Drawing

  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
    frame(in: size)
    redraw()
  }

  /// The frame at `time`: every panel in its box, as the view has it now.
  /// The rows are evaluated with the stack a deep one needs (DeepStack.swift).
  private func frames(_ content: GraphContent, at time: Double) -> (frames: [PanelFrame], layout: [PanelLayout]) {
    let (pixels, dpr, theme, run) = (viewport.pixels, viewport.scale, theme, run)
    let (states, hot) = (viewport.states, viewport.hot)
    return DeepStack.run {
      content.frames(
        at: time, width: pixels.width, height: pixels.height, dpr: dpr, theme: theme, views: states.map(\.view),
        cameras: states.map(\.camera), run: run, seeds: states.map(\.seeds), hot: hot)
    }
  }

  /// Step the states to `time`: frame by frame as they are drawn, or, for a
  /// picture where none were, as the frames up to then would have.
  private func step(to time: Double, playing: Bool = false) {
    guard var stepper = run else { return }
    // (Out of the view while it steps, so that its trails are not copied.)
    run = nil
    DeepStack.run { if playing { stepper.play(to: time) } else { stepper.advance(to: time) } }
    run = stepper
  }

  func draw(in view: MTKView) {
    let size = drawableSize
    frame(in: size)
    guard let renderer, let content, size.width > 0, size.height > 0, let pass = currentRenderPassDescriptor,
      let drawable = currentDrawable, let buffer = renderer.metal.queue.makeCommandBuffer()
    else { return }
    turn()
    let time = viewport.time
    step(to: time)
    let frame = frames(content, at: time)
    renderer.helpers = content.framing.lazy.compactMap { $0.space?.helpers }.first
    renderer.draw(
      frame.frames, on: buffer, into: pass, width: Int(size.width), height: Int(size.height), time: time, theme: theme)
    buffer.present(drawable)
    drawn += 1
    buffer.commit()
    // The overlay (MetalGraphView.swift) draws the rest of this same frame.
    if viewport.frames != frame.frames { viewport.frames = frame.frames }
    if viewport.layout != frame.layout { viewport.layout = frame.layout }
    note(content, at: time)

    // A 3D panel's surfaces are drawn coarsely while they move and refined
    // once they hold still, a pass a frame: draw again when the next is
    // due, until the renderer says it is at rest.
    refine?.cancel()
    refine = nil
    guard isPaused, let wait = renderer.refineIn() else { return }
    refine = Task { @MainActor [weak self] in
      if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
      if !Task.isCancelled { self?.redraw() }
    }
  }

  /// Hand the model what the rows say now that they are drawn (a
  /// certificate, a geodesic's note, a moving readout). A graph that moves
  /// says so ten times a second, not sixty: the editor lays its rows out again.
  private func note(_ content: GraphContent, at time: Double, now immediately: Bool = false) {
    guard let model else { return }
    let now = CACurrentMediaTime()
    if !isPaused, !immediately, now - noted < 0.1 { return }
    let run = run
    let notes = DeepStack.run { content.notes(at: time, run: run) }
    guard notes != model.notes else { return }
    noted = now
    // Not while the view that owns this one is being updated.
    Task { @MainActor [weak model] in
      if let model, model.notes != notes { model.notes = notes }
    }
  }

  /// Turn each spinning camera by its spin since the last frame. A hand on
  /// the panel or a move in flight holds it, and it resumes from there
  /// (web/scene.ts `advanceSpin`).
  private func turn() {
    let now = CACurrentMediaTime()
    let dt = lastFrame.map { min(0.1, now - $0) } ?? 0
    lastFrame = now
    guard glide == nil, dt > 0 else { return }
    for k in viewport.states.indices {
      let state = viewport.states[k]
      guard state.spatial, state.spin != 0, !(held && k == active) else { continue }
      viewport.states[k].camera.theta += state.spin * state.spinScale * dt
    }
  }

  #if DEBUG
    /// The frame the view shows now, drawn again offscreen with its overlay:
    /// EQUATION_SCRIPT's `shot` (GraphGestures.swift).
    func snapshot() -> CGImage? {
      guard let content, let metal = MetalContext() else { return nil }
      let renderer = FrameRenderer(metal)
      renderer.helpers = content.framing.lazy.compactMap { $0.space?.helpers }.first
      let time = viewport.time
      // Stepped as the frames up to now would have stepped it, where none were drawn (a hidden window).
      step(to: time, playing: true)
      let frame = frames(content, at: time)
      // (What the rows say once drawn, where no frame on screen has said it.)
      note(content, at: time, now: true)
      return renderer.image(
        of: frame.frames, width: Int(viewport.pixels.width), height: Int(viewport.pixels.height),
        dpr: viewport.scale, time: time, theme: theme)
    }
  #endif

  // MARK: Where things are

  /// The panel under a point of the view (in points, from its top-left corner).
  func panel(at p: CGPoint) -> Int {
    guard let content else { return 0 }
    return panelAt(viewport.layout(content), p.x * scale, p.y * scale)
  }

  /// A point of the view as device pixels from the center of panel `k`, y up.
  private func offset(_ p: CGPoint, in k: Int) -> (px: Double, py: Double) {
    guard let content else { return (0, 0) }
    let layout = viewport.layout(content)
    guard k < layout.count else { return (0, 0) }
    let r = layout[k].rect
    return (p.x * scale - (r.x + r.w / 2), (r.y + r.h / 2) - p.y * scale)
  }

  /// Whether panel `k` is a 3D one.
  func spatial(_ k: Int) -> Bool {
    k < viewport.states.count && viewport.states[k].spatial
  }

  /// Whether a hand may move panel `k`: a `locked` row holds it still.
  private func free(_ k: Int) -> Bool {
    guard let content, k < content.framing.count, k < viewport.states.count else { return false }
    return !content.framing[k].locked
  }

  // MARK: Moving a panel

  /// Panel `k` just moved: carry its shared axes to the panels sharing
  /// them, write the rows back shortly, and draw.
  private func didMove(_ k: Int) {
    if let content, !spatial(k) {
      var views = viewport.states.map(\.view)
      for i in syncLinks(&views, viewport.layout(content), moved: k) where i < viewport.states.count {
        viewport.states[i].view = views[i]
        moved.insert(i)
      }
    }
    moved.insert(k)
    for i in moved where i < viewport.states.count { viewport.states[i].touched = true }
    // The row trails the gesture by a beat instead of being rewritten per move.
    if writeback == nil {
      writeback = Task { @MainActor [weak self] in
        try? await Task.sleep(for: .milliseconds(200))
        if !Task.isCancelled { self?.flushWriteback() }
      }
    }
    redraw()
  }

  /// Rewrite the moved panels' view(…) and camera(…) rows to the picture on
  /// screen (web/scene.ts `writebackViewport`, `panelViewText`). A panel
  /// without such a row has nothing to write: its framing is not part of
  /// the document. The rewrites of one gesture are one undo step.
  func flushWriteback() {
    writeback?.cancel()
    writeback = nil
    let panels = moved
    moved = []
    guard let content, let model, !panels.isEmpty else { return }
    var lines = model.rows()
    let layout = viewport.layout(content)
    var changed: [(panel: Int, row: Int, was: String)] = []
    var mapped = false
    for k in panels.sorted() where k < content.framing.count && k < viewport.states.count && k < layout.count {
      let framing = content.framing[k]
      guard let row = framing.frameRow, row < lines.count, !framing.locked else { continue }
      let state = viewport.states[k]
      let graph = content.panels.panels[k].graph
      let (r, shared) = (layout[k].rect, layout[k])
      let text: String? =
        state.spatial
        ? formatCameraRow(state.camera, spin: state.spin)
        : formatViewRow(
          state.view, width: r.w, height: r.h, sharedX: shared.sharedX, sharedY: shared.sharedY, maps: graph.maps,
          lattice: graph.lattice, written: framing.written)
      guard let text else { continue }
      let line = keepNote(lines[row], text)
      guard line != lines[row] else { continue }
      changed.append((k, row, lines[row]))
      lines[row] = line
      if !state.spatial, graph.maps != nil { mapped = true }
    }
    // A mapped axis panned past what its map can name (ln(X) left of X = 0)
    // has no row to write: the row keeps the last window it could.
    if mapped {
      let read = analyzeDeep(lines)
      for change in changed where read.rows[change.row].error != nil { lines[change.row] = change.was }
      changed.removeAll { lines[$0.row] == $0.was }
    }
    guard !changed.isEmpty else { return }
    // The panel is already where its row now says.
    for change in changed {
      viewport.states[change.panel].applied = stripNote(lines[change.row]).trimmingCharacters(in: .whitespaces)
    }
    model.gestureEdit(lines)
  }

  /// Stop whatever is moving the view by itself: a hand beats a move in flight.
  func stopMoves() {
    glide?.cancel()
    glide = nil
    coasting?.cancel()
    coasting = nil
    coast.stop()
  }

  /// Zoom panel `k` by `factor` (under 1 moves in): in 2D keeping the math
  /// point under `p` where it is, in 3D moving the camera toward its target.
  /// A panel with mapped axes zooms its screen's window like any other.
  func zoom(panel k: Int, at p: CGPoint?, by factor: Double) {
    guard free(k), factor > 0, factor.isFinite else { return }
    if spatial(k) {
      viewport.states[k].camera.zoom(by: factor)
    } else {
      let at = p.map { offset($0, in: k) } ?? (px: 0, py: 0)
      viewport.states[k].view.zoom(by: factor, px: at.px, py: at.py)
    }
    didMove(k)
  }

  /// Move panel `k` as a drag of (dx, dy) points does, dy down the screen:
  /// the window slides in 2D; in 3D the camera orbits, or with `panning`
  /// its target slides in the screen's plane.
  func drag(panel k: Int, dx: Double, dy: Double) {
    guard free(k) else { return }
    if !spatial(k) {
      viewport.states[k].view.pan(dx: dx * scale, dy: dy * scale)
    } else if panning {
      viewport.states[k].camera.pan(dx: dx, dy: dy)
    } else {
      viewport.states[k].camera.orbit(dx: dx, dy: dy)
    }
    didMove(k)
  }

  /// Carry a drag on after the hand leaves it, slowing to rest.
  func startCoasting(panel k: Int) {
    coasting?.cancel()
    coasting = Task { @MainActor [weak self] in
      var last = CACurrentMediaTime()
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(8))
        guard let self, !Task.isCancelled else { return }
        let now = CACurrentMediaTime()
        guard let step = self.coast.step(now - last) else { break }
        last = now
        self.drag(panel: k, dx: step.x, dy: step.y)
      }
      self?.flushWriteback()
      if let self, !self.held { self.model?.endGesture() }
    }
  }

  // MARK: Moves that take a while

  /// Run `step` with an eased 0…1 until `seconds` have passed, drawing each
  /// time. False if a hand or another move took over first. The rows the
  /// move rewrites on its way are one undo step.
  private func ease(seconds: Double, _ step: @escaping @MainActor (Double) -> Void) async -> Bool {
    stopMoves()
    let start = CACurrentMediaTime()
    let task = Task { @MainActor [weak self] () -> Bool in
      while !Task.isCancelled {
        let k = seconds > 0 ? min((CACurrentMediaTime() - start) / seconds, 1) : 1
        step(easeInOut(k))
        self?.redraw()
        if k >= 1 { return true }
        try? await Task.sleep(for: .milliseconds(8))
      }
      return false
    }
    glide = task
    let finished = await task.value
    if glide == task { glide = nil }
    flushWriteback()
    if !held { model?.endGesture() }
    return finished
  }

  /// Ease the first panel's window to show the given ranges (one alone
  /// keeps the other axis's center), arriving after `seconds`.
  func glide(x: (Double, Double)?, y: (Double, Double)?, seconds: Double) async -> Bool {
    guard let content, !spatial(0), let box = viewport.layout(content).first?.rect, !viewport.states.isEmpty,
      box.w > 0, box.h > 0
    else { return false }
    let from = viewport.states[0].view
    let to = from.fitting(x: x, y: y, width: box.w, height: box.h)
    return await ease(seconds: seconds) { [weak self] k in
      guard let self, !self.viewport.states.isEmpty else { return }
      self.viewport.states[0].view = from.eased(to: to, k)
      self.didMove(0)
    }
  }

  /// Ease the first panel's camera through `move`, arriving after `seconds`.
  func glide(camera move: CameraMove, seconds: Double) async -> Bool {
    guard spatial(0) else { return false }
    let from = viewport.states[0].camera
    let to = from.moved(move)
    return await ease(seconds: seconds) { [weak self] k in
      guard let self, self.spatial(0) else { return }
      self.viewport.states[0].camera = from.eased(to: to, k)
      self.didMove(0)
    }
  }

  /// Glide a panel's zoom (the active one's, unless told): below 1 zooms
  /// in, above 1 out; about `p`, or the panel's center. The task finishes
  /// with the glide.
  @discardableResult
  func glideZoom(by factor: Double, at p: CGPoint? = nil, panel: Int? = nil) -> Task<Void, Never>? {
    let k = panel ?? active
    guard free(k), factor > 0 else { return nil }
    let from = viewport.states[k]
    let at = p.map { offset($0, in: k) } ?? (px: 0, py: 0)
    return Task { @MainActor in
      _ = await ease(seconds: 0.25) { [weak self] e in
        guard let self, k < self.viewport.states.count else { return }
        let part = pow(factor, e)
        if from.spatial {
          self.viewport.states[k].camera.radius = from.camera.radius
          self.viewport.states[k].camera.zoom(by: part)
        } else {
          var view = from.view
          view.zoom(by: part, px: at.px, py: at.py)
          self.viewport.states[k].view = view
        }
        self.didMove(k)
      }
    }
  }

  /// Set the first panel's spin, in radians a second, easing it in from
  /// rest, and save it in the panel's camera(…) row — written at the end of
  /// the panel's rows if it has none (the site's former voice mode's `setCameraSpin`).
  func setSpin(_ spin: Double) {
    guard let content, let model, spatial(0), let framing = content.framing.first,
      let panel = content.panels.panels.first
    else { return }
    viewport.states[0].spin = spin
    viewport.states[0].spinScale = 0
    if framing.frameRow != nil {
      moved.insert(0)
      flushWriteback()
    } else {
      var lines = model.rows()
      let text = formatCameraRow(viewport.states[0].camera, spin: spin)
      viewport.states[0].applied = text
      lines.insert(text, at: min(panel.rows.upperBound, lines.count))
      model.gestureEdit(lines)
    }
    model.endGesture()
    spinEase?.cancel()
    let start = CACurrentMediaTime()
    spinEase = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        let k = min((CACurrentMediaTime() - start) / 1.2, 1)
        guard let self, self.spatial(0) else { return }
        self.viewport.states[0].spinScale = easeInOut(k)
        if k >= 1 { return }
        try? await Task.sleep(for: .milliseconds(16))
      }
    }
    updatePacing()
  }

  /// How the first panel is framed, for Ask: the visible window in math
  /// units (the screen's, on a panel with mapped axes, as the site reports
  /// it), or the camera and its spin.
  enum Framing {
    case window(x: [Double], y: [Double])
    case camera(Camera3D, spin: Double)
  }

  var framing: Framing? {
    guard let content, let state = viewport.states.first, let box = viewport.layout(content).first?.rect
    else { return nil }
    if state.spatial { return .camera(state.camera, spin: state.spin) }
    let shown = state.view.visible(width: box.w, height: box.h)
    return .window(x: shown.x, y: shown.y)
  }

  // MARK: Under the hand

  /// The surface of panel `k` (if it draws on one) under `p`: the ray from
  /// the eye through it met with the surface (the core's SurfacePick.swift).
  /// With where a point in space lands in the view (in points from its
  /// top-left corner), how much x and y change across a point at a place on
  /// the surface, and whether a point there is in sight (web/main.ts `surfaceAt`).
  private struct OnSurface {
    var reads: Set<String>
    var hit: SurfaceHit?
    var toView: ([Double]) -> (Double, Double)?
    var units: (Double, Double) -> (Double, Double)
    var seen: ([Double]) -> Bool
  }

  /// The last surface picked on: its grid of points is made once.
  private var picker: SurfacePicker?

  private func surface(at p: CGPoint, in k: Int) -> OnSurface? {
    guard let content, spatial(k), k < content.framing.count, let surface = content.surface(panel: k)
    else { return nil }
    let layout = viewport.layout(content)
    guard k < layout.count, layout[k].rect.w > 0, layout[k].rect.h > 0 else { return nil }
    let (box, scale) = (layout[k].rect, scale)
    let picker = self.picker.flatMap { $0.map == surface.map ? $0 : nil } ?? SurfacePicker(surface.map)
    self.picker = picker
    let (vp, invVp, eye) = cameraMatrices(viewport.states[k].camera, box.w / box.h)
    // The pixel on the far plane, back into space.
    let nx = ((p.x * scale - box.x) / box.w) * 2 - 1
    let ny = 1 - ((p.y * scale - box.y) / box.h) * 2
    let m = invVp.map(Double.init)
    let w = m[3] * nx + m[7] * ny + m[11] + m[15]
    let from = [eye.x, eye.y, eye.z]
    let direction = (0..<3).map { (m[$0] * nx + m[4 + $0] * ny + m[8 + $0] + m[12 + $0]) / w - from[$0] }
    let toView = { (q: [Double]) -> (Double, Double)? in
      guard q.count == 3, let at = projectToScreen(vp, SIMD3(q[0], q[1], q[2]), box.w, box.h) else { return nil }
      return ((at.x + box.x) / scale, (at.y + box.y) / scale)
    }
    return OnSurface(
      reads: surface.reads, hit: picker.hit(from, direction), toView: toView,
      units: { x, y in surfacePixel(surface.map, x, y, toView) },
      // Nothing of the surface nearer along the ray to it.
      seen: { q in
        let hit = picker.hit(from, (0..<3).map { q[$0] - from[$0] })
        return hit == nil || hit!.t > 0.999
      })
  }

  /// The nearest point a drag can move within `radius` points of `p` on a
  /// surface panel, and in sight there (web/main.ts `surfaceGrabAt`).
  private func surfaceGrabbable(at p: CGPoint, in k: Int, radius: Double) -> Grabbable? {
    guard let content, let on = surface(at: p, in: k) else { return nil }
    let map = picker?.map
    var best: Grabbable?
    var nearest = radius
    for point in content.surfacePoints(panel: k, reads: on.reads, time: viewport.time, run: run) {
      guard let map else { break }
      let q = surfacePoint(map, point.x, point.y)
      guard q.allSatisfy(\.isFinite), let at = on.toView(q) else { continue }
      let away = hypot(at.0 - p.x, at.1 - p.y)
      if away <= nearest, on.seen(q) { (nearest, best) = (away, point) }
    }
    return best
  }

  /// The draggable point of panel `k` under `p`, within `radius` points
  /// (web/main.ts `pointAt`), and the point of the panel's window under `p`
  /// (on a surface panel, the point's own place: it is held where the pointer is).
  private func grabbable(at p: CGPoint, in k: Int, radius: Double) -> (point: Grabbable, x: Double, y: Double)? {
    if spatial(k) { return surfaceGrabbable(at: p, in: k, radius: radius).map { ($0, $0.x, $0.y) } }
    guard let content, !spatial(k), k < content.framing.count, k < viewport.states.count else { return nil }
    let layout = viewport.layout(content)
    guard k < layout.count else { return nil }
    let state = viewport.states[k]
    let view = state.view
    let points = content.grabPoints(
      panel: k, time: viewport.time, run: run, view: view, width: layout[k].rect.w, height: layout[k].rect.h,
      seeds: state.seeds)
    let at = offset(p, in: k)
    let math = view.point(px: at.px, py: at.py)
    let (upp, uppY) = (view.upp * scale, view.uppY * scale)
    var best: Grabbable?
    var nearest = radius
    for point in points {
      let away = hypot((point.x - math.x) / upp, (point.y - math.y) / uppY)
      if away <= nearest { (nearest, best) = (away, point) }
    }
    return best.map { ($0, math.x, math.y) }
  }

  /// A motionless click or tap at `p`: in a 2D panel with a vector field it
  /// drops a seed, which every field there traces its integral curve
  /// through (web/main.ts, pointerup).
  func tapped(at p: CGPoint) {
    let k = panel(at: p)
    guard let content, !spatial(k), k < viewport.states.count, k < content.panels.panels.count else { return }
    var graph = content.panels.panels[k].graph
    guard graph.takesSeeds else { return }
    let at = offset(p, in: k)
    let math = viewport.states[k].view.point(px: at.px, py: at.py)
    // (The graph keeps the newest twelve.)
    graph.seeds = viewport.states[k].seeds
    graph.dropSeed(x: math.x, y: math.y)
    viewport.states[k].seeds = graph.seeds
    redraw()
  }

  /// A pointer or a finger came down at `p` (in points from the top-left
  /// corner). The gesture belongs to the panel it starts in, wherever it
  /// wanders; grabbing a point there wins over moving the view. `pan`: the
  /// drag slides a 3D camera's target instead of orbiting it.
  func began(at p: CGPoint, pan: Bool, radius: Double = grabRadius) {
    stopMoves()
    // Whatever was being written is its own undo step; this gesture is the next.
    flushWriteback()
    model?.endGesture()
    held = true
    panning = pan
    active = panel(at: p)
    grab = nil
    down = p
    wandered = false
    viewport.hover = nil
    viewport.hot = nil
    coast.track(x: p.x, y: p.y, at: CACurrentMediaTime())
    guard !pan, let hit = grabbable(at: p, in: active, radius: radius) else { return }
    grab = (hit.point.target, hit.point.x - hit.x, hit.point.y - hit.y)
    viewport.hot = HotPoint(panel: active, target: hit.point.target)
    redraw()
  }

  /// The pointer moved to `p`, by (dx, dy) points since it last did.
  func dragged(to p: CGPoint, dx: Double, dy: Double) {
    guard held else { return }
    if hypot(p.x - down.x, p.y - down.y) > 3 { wandered = true }
    if let grab {
      guard let model, let content, active < viewport.states.count, active < content.panels.panels.count
      else { return }
      if spatial(active) {
        // Along the surface, to the pixel there; held where the pointer leaves it.
        guard case .row(let row) = grab.target, let on = surface(at: p, in: active), let hit = on.hit else { return }
        let lines = model.rows()
        let moved = analyzeDeep(lines).movingPoint(
          row: row, to: hit.x, hit.y, upp: on.units(hit.x, hit.y), pinned: on.reads, in: lines)
        if let moved { model.gestureEdit(moved) }
        return
      }
      let view = viewport.states[active].view
      let at = offset(p, in: active)
      let math = view.point(px: at.px, py: at.py)
      var to = (x: math.x + grab.dx, y: math.y + grab.dy)
      var upp = (x: view.upp, y: view.uppY)
      let graph = content.panels.panels[active].graph
      // A seed is the view's: it moves, and no row is rewritten.
      guard case .row(let row) = grab.target else {
        if case .seed(let index) = grab.target, index < viewport.states[active].seeds.count {
          viewport.states[active].seeds[index] = FieldSeed(x: to.x, y: to.y)
          redraw()
        } else if case .solution(let row, _) = grab.target {
          // A point placed by its coordinates' names: they are read where
          // the pointer is, and written as the row's pair (web/main.ts `coordinatePointWriter`).
          var env = graph.environment(at: viewport.time, run: run)
          env["t"] = viewport.time
          let lines = model.rows()
          let read = analyzeDeep(lines)
          let pinned = content.reads(read.coordinateNames(row: row) ?? [])
          let moved = read.movingCoordinatePoint(
            row: row, to: to.x, to.y, upp: upp, env: env, pinned: pinned, in: lines)
          if let moved { model.gestureEdit(moved) }
        }
        return
      }
      if graph.maps?.plane != nil {
        // Through a plane map the point is held on the screen and written
        // in x and y, each rounded to about a pixel there (web/main.ts `dragToPlane`).
        guard let world = graph.dragToPlane(to.x, to.y, upp: view.upp, uppY: view.uppY), world.x.isFinite,
          world.y.isFinite
        else { return }
        (to, upp) = (world, (0, 0))
      } else if let maps = graph.maps {
        // On a mapped axis the point is held on the screen and written in the
        // axis's own units, rounded to about a pixel there (web/main.ts `dragTo`).
        func carried(_ map: AxisMap?, _ s: Double, _ step: Double) -> Double? {
          guard let map else { return nil }
          let unit = pow(10, (log10(step * 3)).rounded(.down))
          let world = toWorld(map, ((s / unit) + 0.5).rounded(.down) * unit)
          return Double(String(format: "%.4e", world)) ?? world
        }
        if let x = carried(maps.x, to.x, view.upp) { (to.x, upp.x) = (x, 0) }
        if let y = carried(maps.y, to.y, view.uppY) { (to.y, upp.y) = (y, 0) }
        guard to.x.isFinite, to.y.isFinite else { return }
      }
      // The rows as they are now: the last move's rewrite may not have come back round yet.
      let lines = model.rows()
      if let next = analyzeDeep(lines).movingPoint(row: row, to: to.x, to.y, upp: upp, in: lines) {
        model.gestureEdit(next)
      }
      return
    }
    coast.track(x: p.x, y: p.y, at: CACurrentMediaTime())
    drag(panel: active, dx: dx, dy: dy)
  }

  /// The pointer let go: a point is put down; a drag that was still moving coasts on.
  func ended() {
    guard held else { return }
    held = false
    if grab != nil {
      grab = nil
      viewport.hot = nil
      coast.stop()
      model?.endGesture()
      redraw()
      return
    }
    if free(active), coast.release(at: CACurrentMediaTime()) {
      startCoasting(panel: active)
    } else {
      flushWriteback()
      model?.endGesture()
    }
    // A click that went nowhere, and was not a pan's, drops a seed.
    if !wandered, !panning { tapped(at: down) }
  }

  /// A two-finger scroll or a wheel, by (dx, dy) points, at `p`. The app
  /// scrolls like Maps in 2D: it pans, and with `modified` (Shift) zooms
  /// about the pointer. In 3D it zooms, as the site's wheel does, and with
  /// `modified` slides the camera's target.
  func scrolled(at p: CGPoint, dx: Double, dy: Double, modified: Bool) {
    stopMoves()
    if !held { active = panel(at: p) }
    viewport.hover = nil
    let factor = exp(min(max(-dy, -60), 60) * 0.002)
    if spatial(active) {
      if modified {
        panning = true
        drag(panel: active, dx: dx, dy: dy)
      } else {
        zoom(panel: active, at: p, by: factor)
      }
    } else if modified {
      zoom(panel: active, at: p, by: factor)
    } else {
      drag(panel: active, dx: dx, dy: dy)
    }
  }

  /// A pinch at `p`, by `factor` since it last changed (under 1 zooms in).
  func pinched(at p: CGPoint, by factor: Double) {
    stopMoves()
    if !held { active = panel(at: p) }
    zoom(panel: active, at: p, by: factor)
  }

  /// A double click or tap at `p`: zoom in about it, or out.
  func doubleTapped(at p: CGPoint, out: Bool) {
    active = panel(at: p)
    // On a panel with seeds it lets go of them (the site's double click), the one its first tap dropped too.
    if !out, active < viewport.states.count, !viewport.states[active].seeds.isEmpty {
      viewport.states[active].seeds = []
      viewport.hot = nil
      return redraw()
    }
    glideZoom(by: out ? 2 : 0.5, at: p, panel: active)
  }

  /// What the pointer rests on at `p` (nil: it left the graph), with no
  /// button down: a point a drag can move, which the cursor says, and any
  /// point the overlay draws, whose coordinates are shown beside it.
  /// Returns whether a drag would pick a point up.
  @discardableResult
  func hovered(at p: CGPoint?) -> Bool {
    guard let p, !held, let content else {
      if viewport.hover != nil { viewport.hover = nil }
      if !held, viewport.hot != nil {
        viewport.hot = nil
        redraw()
      }
      return false
    }
    let k = panel(at: p)
    let under = grabbable(at: p, in: k, radius: grabRadius)
    let draggable = under != nil
    // A seed under the pointer wears the halo a drag would give it (`hotSeed`).
    var hot: HotPoint?
    if let under, case .seed = under.point.target { hot = HotPoint(panel: k, target: under.point.target) }
    if viewport.hot != hot {
      viewport.hot = hot
      redraw()
    }
    var hover: GraphViewport.Hover?
    if !spatial(k), k < viewport.states.count, k < content.panels.panels.count,
      let frame = viewport.frames.first(where: { $0.layout == viewport.layout(content)[k] }),
      case .plane(let scene) = frame.content, let points = scene.overlay?.points
    {
      let view = viewport.states[k].view
      let at = offset(p, in: k)
      let math = view.point(px: at.px, py: at.py)
      let (upp, uppY) = (view.upp * scale, view.uppY * scale)
      let away = { (p: Overlay2D.Point) in hypot((p.x - math.x) / upp, (p.y - math.y) / uppY) }
      if let near = points.min(by: { away($0) < away($1) }), away(near) <= grabRadius {
        // The overlay holds a mapped panel's points on its screen: read them in the axes' own units.
        let maps = content.panels.panels[k].graph.maps
        var x = maps?.x.map { toWorld($0, near.x) } ?? snapToPixel(near.x, upp: view.upp / 100)
        var y = maps?.y.map { toWorld($0, near.y) } ?? snapToPixel(near.y, upp: view.uppY / 100)
        if let plane = maps?.plane {
          // Through a plane map, x and y each to a hundredth of the pixel
          // there, from the map's Jacobian (web/main.ts `readPlane`).
          let world = planeToWorld(plane, near.x, near.y)
          let span = pixelSpan(plane, near.x, near.y, view.upp, view.uppY)
          x = snapToPixel(world.0, upp: span.0 / 100)
          y = snapToPixel(world.1, upp: span.1 / 100)
        }
        let read = { (v: Double) in String(format: "%.6g", v == 0 ? 0 : v) }
        hover = .init(at: p, text: "\(near.label.map { "\($0) = " } ?? "")(\(read(x)), \(read(y)))")
      }
    }
    if viewport.hover != hover { viewport.hover = hover }
    return draggable
  }
}
