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
/// - `scene(at:width:height:dpr:views:)` writes one frame down, and
///   `Renderer2D.render(_:target:scene:theme:)` with `drawPanelLabels` draw
///   it (`MetalContext.image(of:)` does both).
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

  /// The gap between an inset and its host's edges, in points (web/main.ts `syncPanels`).
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
      return Panel(
        rows: rows, split: index == 0 ? nil : analysis.rows[first].view,
        graph: Graph2D(analysis.panel(index), colors: colors),
        needs3D: own.contains { $0.unsupported == nil && $0.classified?.needs3D == true }, locked: locked)
    }
    animated = panels.contains { $0.graph.animated }
  }

  /// More than one panel: each is drawn clipped to its box, with edges between them.
  public var split: Bool { panels.count > 1 }

  /// Where each panel goes in a frame `width` × `height` device pixels.
  public func layout(width: Double, height: Double, dpr: Double) -> [PanelLayout] {
    layoutPanels(panels.compactMap(\.split), width, height, margin: (Self.insetMargin * dpr).rounded())
  }

  /// Each panel's opening window (web/main.ts `syncPanels`, then
  /// `applyViewportRows` and `syncLinks`): 12 units across the shorter side
  /// of its box, then what its view(…) row frames, with shared axes taken
  /// from the panels that own them, which are earlier and already framed.
  public func opening(width: Double, height: Double, dpr: Double) -> [View2D] {
    let layout = layout(width: width, height: height, dpr: dpr)
    var views = layout.map { View2D(cx: 0, cy: 0, upp: 12 / max(min($0.rect.w, $0.rect.h), 1)) }
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
  /// scene. `views` are the panels' windows (the opening ones without).
  public func scene(
    at time: Double, width: Double, height: Double, dpr: Double, views: [View2D]? = nil
  ) -> PanelScene {
    let layout = layout(width: width, height: height, dpr: dpr)
    let opening = opening(width: width, height: height, dpr: dpr)
    var out = PanelScene(panels: [])
    for (p, panel) in panels.enumerated() {
      let r = layout[p].rect
      var entry = PanelScene.Entry(layout: layout[p])
      if !panel.needs3D, r.w >= 1, r.h >= 1 {
        let view = views.flatMap { p < $0.count ? $0[p] : nil } ?? opening[p]
        var scene = panel.graph.scene(at: time, width: r.w, height: r.h, view: view)
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

  /// The frame written down with the window given, not the opening one.
  public func scene(at time: Double, width: Double, height: Double, view: View2D) -> Scene2D {
    var scene = scene(at: time, width: width, height: height)
    scene.view = view
    // The grid's spacing follows the window.
    scene.gridSpecs = gridSpecs(at: time, view: view, width: width, height: height)
    return scene
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
  /// panel order (web/main.ts `render`).
  public func render(
    _ encoder: any MTLRenderCommandEncoder, target: (width: Int, height: Int), scene: PanelScene, theme: GraphTheme
  ) {
    let split = scene.panels.count > 1
    for entry in scene.panels {
      guard let panel = entry.scene else { continue }
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
    endFrame()
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
  let split = scene.panels.count > 1
  // One panel draws its overlay whole, clearing it; split panels each draw
  // clipped to their box, so the overlay is cleared once for all of them.
  if split { ctx.clear(CGRect(origin: .zero, size: size)) }
  for entry in scene.panels {
    guard let panel = entry.scene else { continue }
    let r = entry.layout.rect
    let box = split ? OverlayBox(x: r.x / dpr, y: r.y / dpr, w: r.w / dpr, h: r.h / dpr) : nil
    let view = panel.view ?? .opening(width: r.w, height: r.h)
    drawLabels2D(
      ctx, size: size, view: view, dpr: dpr, theme: theme, extras: panel.overlay,
      numbers: (panel.frame?.grid ?? .on) != .off && panel.gridSpecs == nil, box: box, lattice: panel.lattice,
      maps: panel.maps ?? AxisMaps())
  }
  if split { drawPanelEdges(ctx, scene.panels.map(\.layout), dpr: dpr, theme: theme) }
}

/// Hairlines between tiled panels, and a frame round each inset (web/main.ts `drawPanelEdges`).
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
