import EquationCore
import EquationRender
import MetalKit
import SwiftUI

/// Draws the graph's panels, and moves their windows and cameras: under the
/// hand (GraphGestures.swift), for Ask's move_view and the Zoom commands,
/// and as a camera(…) row's spin turns it. What a hand does here is what
/// web/main.ts's pointer and wheel handlers do; the arithmetic is
/// EquationRender's (ViewMoves.swift, PanelBoxes.swift, PointDrag.swift).
final class MetalCanvas: MTKView, MTKViewDelegate {
  let viewport: GraphViewport
  private let renderer: FrameRenderer?
  /// The document's side: its rows, and the way to rewrite them.
  weak var model: GraphModel?

  var content: GraphPanels? {
    didSet {
      guard content != oldValue else { return }
      reconcile()
      updatePacing()
      redraw()
    }
  }
  var theme = GraphTheme.light {
    didSet { if theme != oldValue { redraw() } }
  }

  /// The panel the last gesture was in: what the Zoom commands move.
  var active = 0
  /// A pointer or a finger is down on the graph.
  var held = false
  /// The point a drag has hold of, and where the pointer took it.
  var grab: (row: Int, dx: Double, dy: Double)?
  /// A drag that slides a 3D camera's target, not one that orbits it.
  var panning = false
  var coast = Coast()
  /// Where the pointer last was, for the Mac's drags.
  var last = CGPoint.zero
  /// The pan under way is a trackpad's scroll, not a finger's drag (iPad).
  var scrolling = false

  private var glide: Task<Bool, Never>?
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

  /// Show a new graph: each panel's opening window or camera, and t from 0.
  func open() {
    stopMoves()
    writeback?.cancel()
    writeback = nil
    moved = []
    viewport.states = []
    viewport.opened = .now
    viewport.hot = nil
    active = 0
    reconcile()
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
  /// for it (web/main.ts `applyViewportRows`).
  private func reconcile() {
    guard let content else { return }
    var states = viewport.states
    if states.count > content.panels.count { states.removeLast(states.count - content.panels.count) }
    while states.count < content.panels.count { states.append(PanelState()) }
    for (k, panel) in content.panels.enumerated() where states[k].framed {
      let text = panel.frameRow.map { content.analysis.rows[$0].text }
      if states[k].spatial != (panel.space != nil) {
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

  /// Give each panel not yet framed its opening window or camera: what its
  /// row asks for, or else the origin at the center with 12 units across the
  /// shorter side, or the camera a 3D graph opens with.
  private func frame(in size: CGSize) {
    guard let content, size.width > 0, size.height > 0 else { return }
    var states = viewport.states
    if viewport.pixels != size {
      viewport.pixels = size
      // A window nothing has moved yet is framed again for its new box.
      for k in states.indices where !states[k].touched && !states[k].spatial { states[k].framed = false }
    }
    if viewport.scale != scale { viewport.scale = scale }
    guard states.count == content.panels.count, states.contains(where: { !$0.framed }) else { return }
    let boxes = viewport.boxes(content)
    for (k, panel) in content.panels.enumerated() where !states[k].framed {
      states[k].framed = true
      states[k].touched = false
      states[k].spatial = panel.space != nil
      states[k].applied = panel.frameRow.map { content.analysis.rows[$0].text }
      if let space = panel.space {
        states[k].camera = panel.camera ?? space.opening
        states[k].spin = panel.spin
        states[k].spinScale = 1
      } else {
        states[k].view = panel.plane.opening(width: boxes[k].w, height: boxes[k].h)
      }
    }
    var views = states.map(\.view)
    syncLinkedWindows(&views, boxes)
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

  func draw(in view: MTKView) {
    let size = drawableSize
    frame(in: size)
    guard let renderer, let content, size.width > 0, size.height > 0, let pass = currentRenderPassDescriptor,
      let drawable = currentDrawable, let buffer = renderer.metal.queue.makeCommandBuffer()
    else { return }
    turn()
    let time = viewport.time
    renderer.helpers = content.panels.lazy.compactMap { $0.space?.helpers }.first
    renderer.draw(
      viewport.frames(content, time: time, overlay: false), on: buffer, into: pass, width: Int(size.width),
      height: Int(size.height), time: time, theme: theme)
    buffer.present(drawable)
    drawn += 1
    buffer.commit()

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

  /// Turn each spinning camera by its spin since the last frame. A hand on
  /// the panel or a move in flight holds it, and it resumes from there
  /// (web/main.ts `advanceSpin`).
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

  // MARK: Where things are

  /// The panel under a point of the view (in points, from its top-left corner).
  func panel(at p: CGPoint) -> Int {
    guard let content else { return 0 }
    return panelAt(viewport.boxes(content), p.x * scale, p.y * scale)
  }

  /// A point of the view as device pixels from the center of panel `k`, y up.
  private func offset(_ p: CGPoint, in k: Int) -> (px: Double, py: Double) {
    guard let content else { return (0, 0) }
    let boxes = viewport.boxes(content)
    guard k < boxes.count else { return (0, 0) }
    return (p.x * scale - (boxes[k].x + boxes[k].w / 2), (boxes[k].y + boxes[k].h / 2) - p.y * scale)
  }

  /// Whether panel `k` is a 3D one.
  func spatial(_ k: Int) -> Bool {
    k < viewport.states.count && viewport.states[k].spatial
  }

  /// Whether a hand may move panel `k`: a `locked` row holds it still.
  private func free(_ k: Int) -> Bool {
    guard let content, k < content.panels.count, k < viewport.states.count else { return false }
    return !content.panels[k].locked
  }

  // MARK: Moving a panel

  /// Panel `k` just moved: carry its shared axes to the panels sharing
  /// them, write the rows back shortly, and draw.
  private func didMove(_ k: Int) {
    if let content, !spatial(k) {
      var views = viewport.states.map(\.view)
      syncLinkedWindows(&views, viewport.boxes(content), moved: k)
      for i in views.indices where views[i] != viewport.states[i].view {
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
  /// screen (web/main.ts `writebackViewport`). A panel without such a row
  /// has nothing to write: its framing is not part of the document.
  func flushWriteback() {
    writeback?.cancel()
    writeback = nil
    let panels = moved
    moved = []
    guard let content, let model, !panels.isEmpty else { return }
    var lines = model.rows()
    let boxes = viewport.boxes(content)
    var changed = false
    for k in panels.sorted() where k < content.panels.count && k < viewport.states.count && k < boxes.count {
      let panel = content.panels[k]
      guard let row = panel.frameRow, row < lines.count, !panel.locked else { continue }
      let state = viewport.states[k]
      let text: String? =
        state.spatial
        ? formatCameraRow(state.camera, spin: state.spin)
        : formatViewRow(
          state.view, width: boxes[k].w, height: boxes[k].h, sharedX: boxes[k].sharedX, sharedY: boxes[k].sharedY)
      guard let text else { continue }
      let line = keepNote(lines[row], text)
      guard line != lines[row] else { continue }
      lines[row] = line
      // The panel is already where its row now says.
      viewport.states[k].applied = stripNote(line).trimmingCharacters(in: .whitespaces)
      changed = true
    }
    if changed { model.edit(lines) }
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
    }
  }

  // MARK: Moves that take a while

  /// Run `step` with an eased 0…1 until `seconds` have passed, drawing each
  /// time. False if a hand or another move took over first.
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
    return finished
  }

  /// Ease the first panel's window to show the given ranges (one alone
  /// keeps the other axis's center), arriving after `seconds`.
  func glide(x: (Double, Double)?, y: (Double, Double)?, seconds: Double) async -> Bool {
    guard let content, !spatial(0), let box = viewport.boxes(content).first, !viewport.states.isEmpty,
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
  /// in, above 1 out; about `p`, or the panel's center.
  func glideZoom(by factor: Double, at p: CGPoint? = nil, panel: Int? = nil) {
    let k = panel ?? active
    guard free(k), factor > 0 else { return }
    let from = viewport.states[k]
    let at = p.map { offset($0, in: k) } ?? (px: 0, py: 0)
    Task { @MainActor in
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
  /// the panel's rows if it has none (web/main.ts `setCameraSpin`).
  func setSpin(_ spin: Double) {
    guard let content, let model, spatial(0), let panel = content.panels.first else { return }
    viewport.states[0].spin = spin
    viewport.states[0].spinScale = 0
    if panel.frameRow != nil {
      moved.insert(0)
      flushWriteback()
    } else {
      var lines = model.rows()
      let text = formatCameraRow(viewport.states[0].camera, spin: spin)
      viewport.states[0].applied = text
      lines.insert(text, at: min(panel.rows.upperBound, lines.count))
      model.edit(lines)
    }
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
  /// units, or the camera and its spin.
  enum Framing {
    case window(x: [Double], y: [Double])
    case camera(Camera3D, spin: Double)
  }

  var framing: Framing? {
    guard let content, let state = viewport.states.first, let box = viewport.boxes(content).first else { return nil }
    if state.spatial { return .camera(state.camera, spin: state.spin) }
    let shown = state.view.visible(width: box.w, height: box.h)
    return .window(x: shown.x, y: shown.y)
  }

  // MARK: Under the hand

  /// A pointer or a finger came down at `p` (in points from the top-left
  /// corner). The gesture belongs to the panel it starts in, wherever it
  /// wanders; grabbing a point there wins over moving the view. `pan`: the
  /// drag slides a 3D camera's target instead of orbiting it.
  func began(at p: CGPoint, pan: Bool, radius: Double = grabRadius) {
    stopMoves()
    held = true
    panning = pan
    active = panel(at: p)
    grab = nil
    coast.track(x: p.x, y: p.y, at: CACurrentMediaTime())
    guard !pan, !spatial(active), let content, active < content.panels.count else { return }
    let view = viewport.states[active].view
    let time = viewport.time
    var env = content.analysis.environment(at: time)
    env["t"] = time
    let points = content.analysis.grabPoints(rows: content.panels[active].rows, env: env)
    let at = offset(p, in: active)
    let math = view.point(px: at.px, py: at.py)
    guard
      let hit = grabPoint(
        points, at: math.x, math.y, upp: view.upp * scale, uppY: view.uppY * scale, radius: radius)
    else { return }
    grab = (hit.row, hit.x - math.x, hit.y - math.y)
    viewport.hot = hit.row
    redraw()
  }

  /// The pointer moved to `p`, by (dx, dy) points since it last did.
  func dragged(to p: CGPoint, dx: Double, dy: Double) {
    guard held else { return }
    if let grab {
      guard let model, active < viewport.states.count else { return }
      let view = viewport.states[active].view
      let at = offset(p, in: active)
      let math = view.point(px: at.px, py: at.py)
      // The rows as they are now: the last move's rewrite may not have come back round yet.
      let lines = model.rows()
      if let next = analyze(lines).movingPoint(
        row: grab.row, to: math.x + grab.dx, math.y + grab.dy, upp: (view.upp, view.uppY), in: lines)
      {
        model.edit(next)
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
      redraw()
      return
    }
    if free(active), coast.release(at: CACurrentMediaTime()) {
      startCoasting(panel: active)
    } else {
      flushWriteback()
    }
  }

  /// A two-finger scroll or a wheel, by (dx, dy) points, at `p`. The app
  /// scrolls like Maps in 2D: it pans, and with `modified` (Shift) zooms
  /// about the pointer. In 3D it zooms, as the site's wheel does, and with
  /// `modified` slides the camera's target.
  func scrolled(at p: CGPoint, dx: Double, dy: Double, modified: Bool) {
    stopMoves()
    if !held { active = panel(at: p) }
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
    glideZoom(by: out ? 2 : 0.5, at: p, panel: active)
  }
}
