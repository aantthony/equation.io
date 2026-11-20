import CoreGraphics
import EquationCore
import Foundation
import Metal

/// One panel of a frame: where it is (EquationCore `layoutPanels`), and what
/// it shows there — a 2D panel's scene as `Graph2D.scene` writes it down
/// (window, layers, overlay, grid, axis maps, lattice), or a camera on a
/// scene in space.
public struct PanelFrame: Equatable, Sendable {
  public enum Content: Equatable, Sendable {
    /// Drawn exactly as `Renderer2D.render(_:target:scene:theme:)` draws a
    /// `PanelScene`'s entry; its `frame.vp` is the layout's box when the
    /// frame is split, whatever it holds.
    case plane(Scene2D)
    /// `env`: the constants' values this frame, which the u_<name> uniforms carry.
    case space(camera: Camera3D, scene: Scene3D, env: [String: Double], grid: Frame2D.Grid)
  }

  /// In device pixels, from the frame's top-left corner.
  public var layout: PanelLayout
  public var content: Content

  public init(layout: PanelLayout, content: Content) {
    self.layout = layout
    self.content = content
  }

  var isSpace: Bool {
    if case .space = content { return true }
    return false
  }

  /// The panel's box as the renderers take it: from the bottom-left corner
  /// of a frame `height` pixels high, as GL counts.
  func box(in height: Double) -> Frame2D.Box {
    Frame2D.Box(x: layout.rect.x, y: height - layout.rect.y - layout.rect.h, w: layout.rect.w, h: layout.rect.h)
  }
}

extension PanelScene {
  /// The frame's 2D panels, for `FrameRenderer`; whoever draws 3D adds the others.
  public var frames: [PanelFrame] {
    panels.compactMap { entry in entry.scene.map { PanelFrame(layout: entry.layout, content: .plane($0)) } }
  }
}

/// Draws a frame of several panels, 2D and 3D, into one target.
///
/// The two renderers want different passes: the 3D one a depth attachment
/// and several samples a pixel, the 2D one neither (its pipelines are
/// compiled for a plain color target, and a fullscreen shader gains nothing
/// from multisampling but its cost). So the 3D panels are drawn together
/// into a multisampled target of the renderer's own, resolved, and each one's
/// box is copied from there into the frame's single pass, in the panels'
/// order among the 2D ones — an inset 3D panel sits over its 2D host, and a
/// 2D inset over a 3D host, without either renderer knowing of the other.
/// The cost is a resolved texture the size of the frame and a copy; a frame
/// with no 3D panel allocates and pays nothing for it.
public final class FrameRenderer {
  public let metal: MetalContext
  public let plane: Renderer2D
  /// Made when a 3D panel is first drawn.
  public private(set) var space: Renderer3D?

  private var targets: (color: any MTLTexture, depth: any MTLTexture, resolved: any MTLTexture)?
  private var copy: (any MTLRenderPipelineState)?

  public init(_ metal: MetalContext) {
    self.metal = metal
    plane = Renderer2D(metal)
  }

  /// The GLSL of the loop helpers the 3D scenes' shaders name (see `Renderer3D.helpers`).
  public var helpers: String? {
    didSet { if let helpers, let space, space.helpers != helpers { space.helpers = helpers } }
  }

  /// Seconds until a 3D panel's surfaces are due their next refinement pass
  /// (0: now), or nil once the frame is at rest. The caller draws again then.
  public func refineIn() -> Double? {
    space?.refineIn()
  }

  private static let copySource = """
    #include <metal_stdlib>
    using namespace metal;
    struct CopyVertex { float4 position [[position]]; };
    vertex CopyVertex eq_copy_vertex(uint id [[vertex_id]]) {
      CopyVertex out;
      out.position = float4(float2((id << 1) & 2, id & 2) * 2.0 - 1.0, 0.0, 1.0);
      return out;
    }
    fragment float4 eq_copy_fragment(CopyVertex in [[stage_in]], texture2d<float> source [[texture(0)]]) {
      return source.read(uint2(in.position.xy));
    }
    """

  private func copyState() -> (any MTLRenderPipelineState)? {
    if let copy { return copy }
    do {
      let library = try metal.makeLibrary(Self.copySource)
      let descriptor = MTLRenderPipelineDescriptor()
      descriptor.vertexFunction = library.makeFunction(name: "eq_copy_vertex")
      descriptor.fragmentFunction = library.makeFunction(name: "eq_copy_fragment")
      descriptor.colorAttachments[0].pixelFormat = MetalContext.pixelFormat
      copy = try metal.device.makeRenderPipelineState(descriptor: descriptor)
    } catch {
      print("Shader compile error: \(error)")
    }
    return copy
  }

  /// The 3D panels' targets, `width` × `height` pixels: remade when the frame's size changes.
  private func spaceTargets(_ width: Int, _ height: Int, samples: Int) -> (
    color: any MTLTexture, depth: any MTLTexture, resolved: any MTLTexture
  )? {
    if let targets, targets.resolved.width == width, targets.resolved.height == height { return targets }
    func texture(_ format: MTLPixelFormat, samples: Int, read: Bool = false) -> (any MTLTexture)? {
      let descriptor = MTLTextureDescriptor.texture2DDescriptor(
        pixelFormat: format, width: width, height: height, mipmapped: false)
      descriptor.usage = read ? [.renderTarget, .shaderRead] : [.renderTarget]
      descriptor.storageMode = .private
      descriptor.textureType = samples > 1 ? .type2DMultisample : .type2D
      descriptor.sampleCount = samples
      return metal.device.makeTexture(descriptor: descriptor)
    }
    guard let resolved = texture(MetalContext.pixelFormat, samples: 1, read: true),
      let depth = texture(depthFormat, samples: samples),
      let color = samples > 1 ? texture(MetalContext.pixelFormat, samples: samples) : resolved
    else { return nil }
    targets = (color, depth, resolved)
    return targets
  }

  /// Draw `panels` into `pass`'s first color attachment, which is `width` ×
  /// `height` pixels and takes the theme's background first. The 3D panels'
  /// own passes go on `buffer` before it. `time` is the 3D panels' (a 2D
  /// panel's scene carries its own).
  public func draw(
    _ panels: [PanelFrame], on buffer: any MTLCommandBuffer, into pass: MTLRenderPassDescriptor, width: Int,
    height: Int, time: Double, theme: GraphTheme
  ) {
    let size = (width: width, height: height)
    let background = MTLClearColor(
      red: Double(theme.bg.x), green: Double(theme.bg.y), blue: Double(theme.bg.z), alpha: 1)
    let split = panels.count > 1
    let frame = { (panel: PanelFrame, grid: Frame2D.Grid) in
      Frame2D(vp: panel.box(in: Double(height)), grid: grid)
    }

    var resolved: (any MTLTexture)?
    if panels.contains(where: \.isSpace) {
      let renderer = space ?? Renderer3D(metal)
      if space == nil, let helpers { renderer.helpers = helpers }
      space = renderer
      if let targets = spaceTargets(width, height, samples: renderer.sampleCount) {
        for panel in panels {
          guard case .space(let camera, let scene, let env, let grid) = panel.content else { continue }
          renderer.prepare(
            buffer, target: size, cam: camera, scene: scene, time: time, env: env, frame: frame(panel, grid))
        }
        let own = MTLRenderPassDescriptor()
        own.colorAttachments[0].texture = targets.color
        own.colorAttachments[0].loadAction = .clear
        own.colorAttachments[0].clearColor = background
        if renderer.sampleCount > 1 {
          own.colorAttachments[0].resolveTexture = targets.resolved
          own.colorAttachments[0].storeAction = .multisampleResolve
        } else {
          own.colorAttachments[0].storeAction = .store
        }
        own.depthAttachment.texture = targets.depth
        own.depthAttachment.loadAction = .clear
        own.depthAttachment.clearDepth = 1
        own.depthAttachment.storeAction = .dontCare
        if let encoder = buffer.makeRenderCommandEncoder(descriptor: own) {
          for panel in panels {
            guard case .space(let camera, let scene, let env, let grid) = panel.content else { continue }
            renderer.render(
              encoder, target: size, cam: camera, scene: scene, time: time, env: env, frame: frame(panel, grid),
              theme: theme)
          }
          encoder.endEncoding()
          resolved = targets.resolved
        }
      }
    } else {
      // Nothing to hold a frame's worth of textures for.
      targets = nil
    }

    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].clearColor = background
    guard let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return }
    // In panel order, as the site draws them: an inset comes after the tile it floats over.
    for panel in panels {
      switch panel.content {
      case .plane(var scene):
        if split {
          var own = scene.frame ?? Frame2D()
          own.vp = panel.box(in: Double(height))
          scene.frame = own
        }
        plane.render(encoder, target: size, panel: scene, clear: split, theme: theme)
      case .space:
        guard let resolved, let state = copyState() else { continue }
        let box = panel.layout.rect
        let left = min(max(Int(box.x), 0), width)
        let top = min(max(Int(box.y), 0), height)
        let across = max(min(Int(box.w), width - left), 0)
        let down = max(min(Int(box.h), height - top), 0)
        guard across > 0, down > 0 else { continue }
        encoder.setViewport(
          MTLViewport(originX: 0, originY: 0, width: Double(width), height: Double(height), znear: 0, zfar: 1))
        encoder.setScissorRect(MTLScissorRect(x: left, y: top, width: across, height: down))
        encoder.setRenderPipelineState(state)
        encoder.setFragmentTexture(resolved, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
      }
    }
    encoder.endEncoding()
    plane.endFrame()
    space?.endFrame()
  }

  /// Draw a frame into a new texture and read it back, with the overlay (at
  /// `dpr` pixels per point) over it: a picture of what a view of the panels
  /// shows, its 3D surfaces refined as far as they go at rest.
  public func image(
    of panels: [PanelFrame], width: Int, height: Int, dpr: Double, time: Double = 0, theme: GraphTheme
  ) -> CGImage? {
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: MetalContext.pixelFormat, width: width, height: height, mipmapped: false)
    descriptor.usage = [.renderTarget]
    descriptor.storageMode = .shared
    guard let texture = metal.device.makeTexture(descriptor: descriptor) else { return nil }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = texture
    pass.colorAttachments[0].storeAction = .store
    let rest = space?.rest ?? 0.15
    // A frame, then one more for each refinement the surfaces are due.
    for _ in 0..<(AA_SAMPLES * 64 + 2) {
      guard let buffer = metal.queue.makeCommandBuffer() else { return nil }
      draw(panels, on: buffer, into: pass, width: width, height: height, time: time, theme: theme)
      buffer.commit()
      buffer.waitUntilCompleted()
      // Nothing moves between this picture's frames, so none of them waits.
      space?.rest = 0
      if refineIn() == nil { break }
    }
    space?.rest = rest

    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    texture.getBytes(&bytes, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
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
      ctx.beginTransparencyLayer(auxiliaryInfo: nil)
      drawPanelLabels(
        ctx, panels, size: CGSize(width: Double(width) / dpr, height: Double(height) / dpr), dpr: dpr, theme: theme)
      ctx.endTransparencyLayer()
      return ctx.makeImage()
    }
  }
}

/// What is drawn over a frame's panels with a 2D context (in points, y
/// down, `dpr` device pixels to the point): each panel's labels and overlay
/// clipped to its box, in panel order, then the edges between panels
/// (web/main.ts `drawPanelEdges`). `edges` is the whole layout when some
/// panels are not among `panels` (one with no room draws nothing).
public func drawPanelLabels(
  _ ctx: CGContext, _ panels: [PanelFrame], size: CGSize, dpr: Double, theme: GraphTheme,
  edges: [PanelLayout]? = nil
) {
  let layout = edges ?? panels.map(\.layout)
  let split = layout.count > 1
  // One 2D panel draws its overlay whole, clearing it; split panels each
  // draw clipped to their box, so the overlay is cleared once for all of them.
  if split || panels.contains(where: \.isSpace) { ctx.clear(CGRect(origin: .zero, size: size)) }
  for panel in panels {
    let r = panel.layout.rect
    let box = OverlayBox(x: r.x / dpr, y: r.y / dpr, w: r.w / dpr, h: r.h / dpr)
    switch panel.content {
    case .plane(let scene):
      let view = scene.view ?? .opening(width: r.w, height: r.h)
      drawLabels2D(
        ctx, size: size, view: view, dpr: dpr, theme: theme, extras: scene.overlay,
        numbers: (scene.frame?.grid ?? .on) != .off && scene.gridSpecs == nil, box: split ? box : nil,
        lattice: scene.lattice, maps: scene.maps ?? AxisMaps())
    case .space(let camera, let scene, _, let grid):
      let rect = CGRect(x: box.x, y: box.y, width: box.w, height: box.h)
      // An inset's box is its own: the labels of the panel under it stop at its edge.
      ctx.clear(rect)
      drawLabels3D(
        ctx, box: rect, cam: camera, points: scene.points, texts: scene.texts ?? [], theme: theme, axes: grid != .off)
    }
  }
  if split { drawPanelEdges(ctx, layout, dpr: dpr, theme: theme) }
}
