import CoreGraphics
import Foundation
import Metal

/// A 3D frame written down: what `Renderer3D.render` and the overlay are
/// given (the site's `Scene3D` is the layers alone, as here). metal-shot
/// draws one from JSON, so a scene the TypeScript compiles — its shader
/// strings and sampled geometry — can be drawn before the language's Swift
/// port reaches 3D rows.
public struct Graph3D: Equatable, Codable, Sendable {
  public var scene: Scene3D
  /// Absent: the camera a graph opens with.
  public var camera: Camera3D?
  /// The constants' values, by name: what the u_<name> uniforms carry.
  public var env: [String: Double]?
  public var frame: Frame2D?
  /// Seconds since the graph opened.
  public var time: Double?

  public init(
    scene: Scene3D = Scene3D(), camera: Camera3D? = nil, env: [String: Double]? = nil, frame: Frame2D? = nil,
    time: Double? = nil
  ) {
    self.scene = scene
    self.camera = camera
    self.env = env
    self.frame = frame
    self.time = time
  }

  /// A graph from JSON. A vertex that lifts the pen is the string "NaN"
  /// there, JSON having no number for it.
  public static func decode(_ json: Data) throws -> Graph3D {
    let decoder = JSONDecoder()
    decoder.nonConformingFloatDecodingStrategy = .convertFromString(
      positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
    return try decoder.decode(Graph3D.self, from: json)
  }
}

extension MetalContext {
  /// Draw a 3D graph into a new texture `width` × `height` pixels and read
  /// it back, with the overlay (at `dpr` pixels per point) over it: a
  /// picture of the graph without a view, its surfaces refined as far as
  /// they go at rest. Drawn with `renderer`, when one is given to keep its
  /// compiled shaders (or to ask it afterwards how they compiled).
  public func image(
    of graph: Graph3D, width: Int, height: Int, dpr: Double, theme: GraphTheme, renderer: Renderer3D? = nil
  ) -> CGImage? {
    let renderer = renderer ?? Renderer3D(self)
    let rest = renderer.rest
    defer { renderer.rest = rest }
    // Nothing moves between this picture's frames, so none of them waits.
    renderer.rest = 0
    let camera = graph.camera ?? Camera3D()
    let frame = graph.frame ?? Frame2D()

    func texture(_ format: MTLPixelFormat, samples: Int) -> (any MTLTexture)? {
      let descriptor = MTLTextureDescriptor.texture2DDescriptor(
        pixelFormat: format, width: width, height: height, mipmapped: false)
      descriptor.usage = [.renderTarget]
      descriptor.storageMode = samples > 1 ? .private : .shared
      descriptor.textureType = samples > 1 ? .type2DMultisample : .type2D
      descriptor.sampleCount = samples
      return device.makeTexture(descriptor: descriptor)
    }
    let samples = renderer.sampleCount
    guard let resolved = texture(Self.pixelFormat, samples: 1), let depth = texture(depthFormat, samples: samples),
      let color = samples > 1 ? texture(Self.pixelFormat, samples: samples) : resolved
    else { return nil }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = color
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].clearColor = MTLClearColor(
      red: Double(theme.bg.x), green: Double(theme.bg.y), blue: Double(theme.bg.z), alpha: 1)
    if samples > 1 {
      pass.colorAttachments[0].resolveTexture = resolved
      pass.colorAttachments[0].storeAction = .multisampleResolve
    } else {
      pass.colorAttachments[0].storeAction = .store
    }
    pass.depthAttachment.texture = depth
    pass.depthAttachment.loadAction = .clear
    pass.depthAttachment.clearDepth = 1
    pass.depthAttachment.storeAction = .dontCare

    // A frame, then one more for each refinement the surfaces are due: at
    // most a pass for every cell of every sample, and the frame that began them.
    for _ in 0..<(AA_SAMPLES * 64 + 2) {
      guard let buffer = queue.makeCommandBuffer() else { return nil }
      renderer.prepare(
        buffer, target: (width, height), cam: camera, scene: graph.scene, time: graph.time ?? 0,
        env: graph.env ?? [:], frame: frame)
      guard let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return nil }
      renderer.render(
        encoder, target: (width, height), cam: camera, scene: graph.scene, time: graph.time ?? 0,
        env: graph.env ?? [:], frame: frame, theme: theme)
      encoder.endEncoding()
      buffer.commit()
      buffer.waitUntilCompleted()
      renderer.endFrame()
      if renderer.refineIn() == nil { break }
    }

    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    resolved.getBytes(&bytes, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
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
      // The panel's box counts up from the bottom of the frame in pixels; the overlay's, down in points.
      let vp = frame.vp ?? Frame2D.Box(x: 0, y: 0, w: Double(width), h: Double(height))
      let box = CGRect(x: vp.x / dpr, y: (Double(height) - vp.y - vp.h) / dpr, width: vp.w / dpr, height: vp.h / dpr)
      drawLabels3D(
        ctx, box: box, cam: camera, points: graph.scene.points, texts: graph.scene.texts ?? [], theme: theme,
        axes: frame.grid != .off)
      return ctx.makeImage()
    }
  }
}
