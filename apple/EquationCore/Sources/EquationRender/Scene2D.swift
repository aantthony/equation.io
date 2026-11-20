import CoreGraphics
import Foundation
import Metal

/// A 2D frame written down: what `Renderer2D.render` and the overlay are
/// given. metal-shot draws one from JSON, so a shader can be tried on a
/// hand-written field before the language reaches it.
public struct Scene2D: Equatable, Codable, Sendable {
  public var layers: Layers2D
  /// The constants' values, by name: what the u_<name> uniforms carry.
  public var env: [String: Double]?
  public var gridSpecs: [GridSpec]?
  public var frame: Frame2D?
  /// Seconds since the graph opened.
  public var time: Double?
  /// Absent: the opening window (`View2D.opening`).
  public var view: View2D?
  /// What the overlay draws over the shader passes, in math coordinates
  /// (already carried to the screen's, in a mapped panel).
  public var overlay: Overlay2D?
  /// A lattice panel's labels, in place of the axis numbers.
  public var lattice: LatticeLabels?
  /// The panel's axis maps (the site's `Frame.maps`), which the axis numbers follow.
  public var maps: AxisMaps?

  public init(
    layers: Layers2D = Layers2D(), env: [String: Double]? = nil, gridSpecs: [GridSpec]? = nil, frame: Frame2D? = nil,
    time: Double? = nil, view: View2D? = nil, overlay: Overlay2D? = nil, lattice: LatticeLabels? = nil,
    maps: AxisMaps? = nil
  ) {
    self.layers = layers
    self.env = env
    self.gridSpecs = gridSpecs
    self.frame = frame
    self.time = time
    self.view = view
    self.overlay = overlay
    self.lattice = lattice
    self.maps = maps
  }
}

extension View2D {
  /// The window a graph opens with: the origin at the center, 12 units
  /// across the shorter side of a frame `width` × `height` pixels.
  public static func opening(width: Double, height: Double) -> View2D {
    View2D(cx: 0, cy: 0, upp: 12 / min(width, height))
  }
}

extension MetalContext {
  /// Draw a scene into a new texture `width` × `height` pixels and read it
  /// back, with the overlay (at `dpr` pixels per point) over it: a picture of
  /// the graph without a view. BGRA bytes, rows from the top.
  public func image(
    of scene: Scene2D, width: Int, height: Int, dpr: Double, theme: GraphTheme
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
    let view = scene.view ?? .opening(width: Double(width), height: Double(height))
    Renderer2D(self).render(
      encoder, target: (width, height), view: view, layers: scene.layers, time: scene.time ?? 0,
      env: scene.env ?? [:], gridSpecs: scene.gridSpecs, frame: scene.frame ?? Frame2D(), theme: theme)
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
      // A layer of its own, as the site's overlay canvas is: a panel clears its box before drawing.
      ctx.beginTransparencyLayer(auxiliaryInfo: nil)
      // The panel's box from the top-left corner, in points (web/main.ts, for a split view).
      let box = scene.frame?.vp.map {
        OverlayBox(x: $0.x / dpr, y: (Double(height) - $0.y - $0.h) / dpr, w: $0.w / dpr, h: $0.h / dpr)
      }
      drawLabels2D(
        ctx, size: CGSize(width: Double(width) / dpr, height: Double(height) / dpr), view: view, dpr: dpr,
        theme: theme, extras: scene.overlay, numbers: (scene.frame?.grid ?? .on) != .off && scene.gridSpecs == nil,
        box: box, lattice: scene.lattice, maps: scene.maps ?? AxisMaps())
      ctx.endTransparencyLayer()
      return ctx.makeImage()
    }
  }
}
