import CoreGraphics
import EquationCore
import Foundation
import Metal
import simd

/// A document as the list of its panels: what web/main.ts keeps as `panels`
/// (`syncPanels`, `applyViewportRows`, `syncLinks`, `render`'s loop over them
/// and `drawPanelEdges`).
///
/// `---` rows split the frame (EquationCore `layoutPanels`). Each panel has
/// its own rows, its own window, grid mode and axis maps, all of which its
/// `Graph2D` reads from its rows alone; `Graph2D` itself stays the picture of
/// one panel filling a frame, so a document without dividers is drawn through
/// it exactly as before, and is one panel here.
///
/// The contract with whoever draws frames (the app, metal-shot):
///
/// - `layout(width:height:dpr:)` says where each panel goes, in device
///   pixels from the frame's top-left corner; `PanelLayout.fraction(of:)`
///   gives the same box as a fraction of the frame.
/// - `opening(width:height:dpr:)` gives each panel's opening window, shared
///   axes carried. The drawer keeps the windows from then on: a gesture in
///   panel k moves `views[k]` and calls `syncLinks(&views, layout, moved: k)`
///   to carry the axes it shares; `panelAt` finds the panel under a point.
/// - `scene(at:width:height:dpr:theme:views:run:)` writes one frame down, and
///   `Renderer2D.render(_:target:scene:theme:)` with `drawPanelLabels` draw
///   it (`MetalContext.image(of:)` does both).
/// - A document with states (`a' = …`) has a run, an EquationCore
///   `StateStepper` the drawer owns: advanced to each frame's time and passed
///   to `scene` as `run` (Graph2D+States.swift).
public struct GraphPanels: Equatable, Sendable {
  public struct Panel: Equatable, Sendable {
    /// The panel's rows, its divider first (the first panel has none).
    public var rows: Range<Int>
    /// The divider that opens the panel; nil for the first.
    public var split: ViewSpec?
    /// The panel's rows as one graph: its layers, grid mode, window and maps.
    public var graph: Graph2D
    /// One of the panel's rows is drawn in space, so the panel is a 3D scene
    /// (web/main.ts `Panel.mode`). `Graph2D` draws none of it: such a panel
    /// has no `Scene2D`, and whoever draws 3D takes its box from the layout.
    public var needs3D: Bool
    /// The panel's view(…) row pins it: gestures leave its window alone.
    public var locked: Bool
  }

  public var analysis: DocumentAnalysis
  public var colors: [RGB?]
  /// One per divider plus the first, in document order.
  public var panels: [Panel]
  /// Some panel moves with t, so the graph redraws every frame.
  public var animated: Bool
  /// What lies over the frame's top and bottom, in points: a status bar, a
  /// card of equations. A lone panel runs under it; a split is made of the
  /// part left clear, so no panel is hidden whole and an inset stays in sight.
  public var clear = Clear()

  public struct Clear: Equatable, Sendable {
    public var top = 0.0
    public var bottom = 0.0

    public init(top: Double = 0, bottom: Double = 0) {
      self.top = top
      self.bottom = bottom
    }
  }

  /// The gap between an inset and its host's edges, in points (web/session.ts `syncPanels`).
  public static let insetMargin = 12.0

  public init(_ analysis: DocumentAnalysis, colors: [RGB?]) {
    self.analysis = analysis
    self.colors = colors
    let at = panelIndices(analysis.rows)
    let count = (at.last ?? 0) + 1
    panels = (0..<count).map { index in
      let first = at.firstIndex(of: index) ?? 0
      let rows = first..<(at.lastIndex(of: index).map { $0 + 1 } ?? first)
      let own = analysis.rows[rows].filter { $0.error == nil }
      var locked = false
      for row in own {
        if case .view(_, _, _, true)? = row.view { locked = true }
        if case .mappedView(_, _, _, true, _)? = row.view { locked = true }
      }
      // (A panel drawn on a surface, an on(…) row, is 3D too: `Graph.kind`.)
      let own3D = Graph.kind(of: analysis.panel(index)) == .space
      return Panel(
        rows: rows, split: index == 0 ? nil : analysis.rows[first].view,
        graph: Graph2D(analysis.panel(index), colors: colors), needs3D: own3D, locked: locked)
    }
    animated = panels.contains { $0.graph.animated }
  }

  /// More than one panel: each is drawn clipped to its box, with edges between them.
  public var split: Bool { panels.count > 1 }

  /// Where each panel goes in a frame `width` × `height` device pixels.
  public func layout(width: Double, height: Double, dpr: Double) -> [PanelLayout] {
    let splits = panels.compactMap(\.split)
    let margin = (Self.insetMargin * dpr).rounded()
    let top = (max(0, clear.top) * dpr).rounded()
    let bottom = (max(0, clear.bottom) * dpr).rounded()
    let room = height - top - bottom
    // Nothing over the frame, nothing to keep clear of it, or too little left to split.
    guard split, top + bottom > 0, room >= 120 * dpr else {
      return layoutPanels(splits, width, height, margin: margin)
    }
    var out = layoutPanels(splits, width, room, margin: margin)
    for k in out.indices {
      var r = out[k].rect
      r.y += top
      // A tile at the top runs on under the little that covers it there. At
      // the bottom none does: what covers that is tall, and a window centered
      // on a box half hidden would show its origin at the cover's edge.
      if !out[k].inset, r.y <= top {
        r.h += r.y
        r.y = 0
      }
      out[k].rect = r
    }
    return out
  }

  /// Each panel's opening window (web/session.ts `syncPanels`, then
  /// `applyViewportRows` and `syncLinks`): 12 units across the shorter side
  /// of its box (a lattice with no view row opens on its cells), then what
  /// its view(…) row frames, with shared axes taken from the panels that own
  /// them, which are earlier and already framed.
  public func opening(width: Double, height: Double, dpr: Double) -> [View2D] {
    let layout = layout(width: width, height: height, dpr: dpr)
    var views = zip(layout, panels).map { box, panel in
      panel.graph.window == nil && box.rect.w >= 1 && box.rect.h >= 1
        ? panel.graph.opening(width: box.rect.w, height: box.rect.h, dpr: dpr)
        : View2D(cx: 0, cy: 0, upp: 12 / max(min(box.rect.w, box.rect.h), 1))
    }
    for (p, panel) in panels.enumerated() {
      guard let spec = panel.graph.windowSpec, layout[p].rect.w > 0 else { continue }
      let (rx, ry) = (linkRoot(layout, p, .x), linkRoot(layout, p, .y))
      let from = (x: rx == p ? nil : views[rx], y: ry == p ? nil : views[ry])
      let linked = linkedWindow(views[p], sharedX: layout[p].sharedX, sharedY: layout[p].sharedY, from: from)
      views[p] = fitPanelWindow(
        spec, layout[p].rect.w, layout[p].rect.h, sharedX: layout[p].sharedX, sharedY: layout[p].sharedY,
        linked: linked)
    }
    syncLinks(&views, layout)
    return views
  }

  /// One frame written down: each panel's box and, for a 2D panel, its
  /// scene. `views` are the panels' windows (the opening ones without);
  /// `run` has the states where the frame finds them (their starts without).
  public func scene(
    at time: Double, width: Double, height: Double, dpr: Double, theme: GraphTheme = .light,
    views: [View2D]? = nil, run: StateStepper? = nil
  ) -> PanelScene {
    let layout = layout(width: width, height: height, dpr: dpr)
    let opening = opening(width: width, height: height, dpr: dpr)
    var out = PanelScene(panels: [])
    for (p, panel) in panels.enumerated() {
      let r = layout[p].rect
      var entry = PanelScene.Entry(layout: layout[p])
      if !panel.needs3D, r.w >= 1, r.h >= 1 {
        let view = views.flatMap { p < $0.count ? $0[p] : nil } ?? opening[p]
        var scene = panel.graph.scene(
          at: time, width: r.w, height: r.h, dpr: dpr, theme: theme, view: view, run: run)
        // A lone panel fills the frame, with no box of its own.
        if split {
          var frame = scene.frame ?? Frame2D()
          frame.vp = Frame2D.Box(x: r.x, y: height - r.y - r.h, w: r.w, h: r.h)
          scene.frame = frame
        }
        entry.scene = scene
      }
      out.panels.append(entry)
    }
    return out
  }
}

extension Graph2D {
  /// What the panel's view(…) row frames, if it has one.
  public var windowSpec: WindowSpec? {
    window.map { WindowSpec(x: $0.x, y: $0.y, ratio: $0.ratio) }
  }
}

extension PanelLayout {
  /// The panel's box as a fraction of a frame `width` × `height` pixels, from the top-left corner.
  public func fraction(of width: Double, _ height: Double) -> PanelRect {
    PanelRect(x: rect.x / width, y: rect.y / height, w: rect.w / width, h: rect.h / height)
  }
}

/// A frame of a document's panels: where each is, and what a 2D one draws
/// (its `Scene2D`, whose `frame.vp` is the panel's box when the frame is split).
public struct PanelScene: Equatable, Sendable {
  public struct Entry: Equatable, Sendable {
    public var layout: PanelLayout
    /// Nil for a panel drawn in space, or one with no room.
    public var scene: Scene2D?

    public init(layout: PanelLayout, scene: Scene2D? = nil) {
      self.layout = layout
      self.scene = scene
    }
  }

  public var panels: [Entry]

  public init(panels: [Entry]) {
    self.panels = panels
  }
}

/// A panel's box filled with the page color: the site clears each panel's
/// box before drawing in it, so an inset paints over its host.
private let PANEL_CLEAR_FRAG = """
  #version 300 es
  precision highp float;
  uniform vec3 uColor;
  out vec4 outColor;
  void main() {
    outColor = vec4(uColor, 1.0);
  }

  """

extension Renderer2D {
  /// Draw every 2D panel of a frame into `encoder`, each in its box, in
  /// panel order (web/scene.ts `render`).
  public func render(
    _ encoder: any MTLRenderCommandEncoder, target: (width: Int, height: Int), scene: PanelScene, theme: GraphTheme
  ) {
    let split = scene.panels.count > 1
    for entry in scene.panels {
      guard let panel = entry.scene else { continue }
      render(encoder, target: target, panel: panel, clear: split, theme: theme)
    }
    endFrame()
  }

  /// One 2D panel in its box (`frame.vp`, or the whole target): cleared
  /// first when the frame is split, gridded at its mapped axes' ticks.
  func render(
    _ encoder: any MTLRenderCommandEncoder, target: (width: Int, height: Int), panel: Scene2D, clear split: Bool,
    theme: GraphTheme
  ) {
    var frame = panel.frame ?? Frame2D()
    let box = frame.vp ?? Frame2D.Box(x: 0, y: 0, w: Double(target.width), h: Double(target.height))
    let view = panel.view ?? .opening(width: box.w, height: box.h)
    // A mapped axis is gridded at its ticks, which follow from the maps and the window.
    if let maps = panel.maps, frame.ticks == nil {
      let ticks = mappedTicks(view, box.w, box.h, maps)
      if ticks.x != nil || ticks.y != nil { frame.ticks = MappedTicks(x: ticks.x, y: ticks.y) }
    }
    if split { clear(encoder, target: target, box: box, theme: theme) }
    render(
      encoder, target: target, view: view, layers: panel.layers, time: panel.time ?? 0, env: panel.env ?? [:],
      gridSpecs: panel.gridSpecs, frame: frame, theme: theme)
  }

  private func clear(
    _ encoder: any MTLRenderCommandEncoder, target: (width: Int, height: Int), box: Frame2D.Box, theme: GraphTheme
  ) {
    let top = Double(target.height) - box.y - box.h
    encoder.setViewport(MTLViewport(originX: box.x, originY: top, width: box.w, height: box.h, znear: 0, zfar: 1))
    let left = min(max(Int(box.x), 0), target.width)
    let upper = min(max(Int(top), 0), target.height)
    encoder.setScissorRect(
      MTLScissorRect(
        x: left, y: upper, width: max(min(Int(box.w), target.width - left), 0),
        height: max(min(Int(box.h), target.height - upper), 0)))
    let uniforms = FrameUniforms(
      center: .zero, upp: SIMD2(1, 1), res: SIMD2(Float(box.w), Float(box.h)),
      origin: SIMD2(Float(box.x), Float(box.y)), time: 0, height: Float(target.height), color: SIMD4(theme.bg, 1))
    metal.draw(encoder, fragment: PANEL_CLEAR_FRAG, frame: uniforms) { _ in nil }
  }
}

/// What is drawn over the shader passes for a frame of panels: each 2D
/// panel's labels and overlay, clipped to its box, then the edges between
/// panels. `size` is the whole overlay's, in points; `height` the frame's in
/// device pixels.
public func drawPanelLabels(
  _ ctx: CGContext, size: CGSize, scene: PanelScene, dpr: Double, theme: GraphTheme
) {
  drawPanelLabels(ctx, scene.frames, size: size, dpr: dpr, theme: theme, edges: scene.panels.map(\.layout))
}

/// Hairlines between tiled panels, and a frame round each inset (web/scene.ts `drawPanelEdges`).
public func drawPanelEdges(_ ctx: CGContext, _ layout: [PanelLayout], dpr: Double, theme: GraphTheme) {
  ctx.saveGState()
  defer { ctx.restoreGState() }
  ctx.setLineWidth(1)
  for p in layout {
    let (l, t, pw, ph) = (p.rect.x / dpr, p.rect.y / dpr, p.rect.w / dpr, p.rect.h / dpr)
    let color = CSSColor(theme.axis, alpha: p.inset ? 0.55 : 0.35)
    ctx.setStrokeColor(red: color.r, green: color.g, blue: color.b, alpha: color.a)
    ctx.beginPath()
    if p.inset {
      ctx.addRect(
        CGRect(x: l.rounded() + 0.5, y: t.rounded() + 0.5, width: pw.rounded() - 1, height: ph.rounded() - 1))
    } else {
      // Every shared edge is some panel's left or top.
      let (ex, ey) = (l.rounded() + 0.5, t.rounded() + 0.5)
      if p.rect.x > 0 {
        ctx.move(to: CGPoint(x: ex, y: t))
        ctx.addLine(to: CGPoint(x: ex, y: t + ph))
      }
      if p.rect.y > 0 {
        ctx.move(to: CGPoint(x: l, y: ey))
        ctx.addLine(to: CGPoint(x: l + pw, y: ey))
      }
    }
    ctx.strokePath()
  }
}

extension MetalContext {
  /// Draw a frame of panels into a new texture `width` × `height` pixels and
  /// read it back, each panel's overlay (at `dpr` pixels per point) over it:
  /// a picture of a split graph without a view. A panel drawn in space is
  /// left the page's color.
  public func image(
    of scene: PanelScene, width: Int, height: Int, dpr: Double, theme: GraphTheme
  ) -> CGImage? {
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: Self.pixelFormat, width: width, height: height, mipmapped: false)
    descriptor.usage = [.renderTarget]
    descriptor.storageMode = .shared
    let pass = MTLRenderPassDescriptor()
    guard let texture = device.makeTexture(descriptor: descriptor), let buffer = queue.makeCommandBuffer() else {
      return nil
    }
    pass.colorAttachments[0].texture = texture
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].clearColor = MTLClearColor(
      red: Double(theme.bg.x), green: Double(theme.bg.y), blue: Double(theme.bg.z), alpha: 1)
    pass.colorAttachments[0].storeAction = .store
    guard let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return nil }
    Renderer2D(self).render(encoder, target: (width, height), scene: scene, theme: theme)
    encoder.endEncoding()
    buffer.commit()
    buffer.waitUntilCompleted()

    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    texture.getBytes(
      &bytes, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
    let info = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    return bytes.withUnsafeMutableBytes { raw -> CGImage? in
      guard
        let ctx = CGContext(
          data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info)
      else { return nil }
      // Points, y down, as the overlay draws.
      ctx.translateBy(x: 0, y: CGFloat(height))
      ctx.scaleBy(x: CGFloat(dpr), y: -CGFloat(dpr))
      // A layer of its own, as the site's overlay canvas is.
      ctx.beginTransparencyLayer(auxiliaryInfo: nil)
      drawPanelLabels(
        ctx, size: CGSize(width: Double(width) / dpr, height: Double(height) / dpr), scene: scene, dpr: dpr,
        theme: theme)
      ctx.endTransparencyLayer()
      return ctx.makeImage()
    }
  }
}
