import Foundation
import Metal
import simd

// The raymarched layers of a 3D frame — implicit surfaces and clouds — and
// the offscreen targets they are drawn into and refined in
// (web/render3d.ts `drawImplicits` and what serves it).

/// Pixels a raymarch of the surfaces may cover in a frame where the view
/// or the surfaces changed. A larger panel draws them at 1/2 (or 1/4 …) the
/// resolution on such frames, then refines at rest (drawImplicits).
let MOVING_PIXELS = 2e6
/// Rays per pixel the surfaces average once at rest: the first through the
/// pixel's center, the rest jittered within it.
let AA_SAMPLES = 8

/// An offscreen color and depth pair the implicit surfaces raymarch into.
struct SurfaceTarget {
  var color: any MTLTexture
  var depth: any MTLTexture
  var w: Int
  var h: Int

  /// What a pipeline drawing into one is made for.
  static let kind = Target3D(color: .rgba8Unorm, samples: 1)
}

/// A panel's surfaces as last drawn, and how far their refinement has got.
final class SurfaceState {
  var full: SurfaceTarget
  var low: SurfaceTarget?
  /// Everything the surfaces' pixels depend on but time.
  var key = ""
  var time = Double.nan
  /// The grid × grid cells still to draw at full resolution, in order.
  var cells: [(x: Int, y: Int)] = []
  var grid = 1
  /// The sample the cells belong to: 0 unjittered, up to AA_SAMPLES − 1.
  var sample = AA_SAMPLES
  /// The system's uptime when the key last changed.
  var changedAt = 0.0
  var used = true

  init(full: SurfaceTarget) {
    self.full = full
  }
}

/// One raymarched pass of a layer: into `encoder`, whose target is `height`
/// pixels high, at a resolution, chunk and jitter (see CHUNK_DECL).
typealias DrawSurfaces = (
  _ encoder: any MTLRenderCommandEncoder, _ height: Int, _ res: SIMD2<Float>, _ chunk: SIMD3<Int32>,
  _ jitter: SIMD2<Float>
) -> Void

extension Renderer3D {
  /// Raymarch a panel's implicit surfaces and clouds into their offscreen
  /// targets, in passes of their own on `buffer`: the part of the site's
  /// `render` that binds other framebuffers. Call it before the frame's pass
  /// begins, with what `render` will be given.
  public func prepare(
    _ buffer: any MTLCommandBuffer,
    target: (width: Int, height: Int),
    cam: Camera3D,
    scene: Scene3D,
    time: Double = 0,
    env: [String: Double] = [:],
    frame: Frame2D = Frame2D()
  ) {
    let panel = Panel(cam, target: target, frame: frame, time: time, env: env)
    let (w, h) = (panel.w, panel.h)
    guard w >= 1, h >= 1 else { return }
    let common = panel.common
    let boxR = panel.boxR
    /// What every raymarched pass is told of the target it draws into.
    func passValues(_ res: SIMD2<Float>, _ chunk: SIMD3<Int32>, _ jitter: SIMD2<Float>, _ color: RGB) -> Uniforms3D {
      [
        // Offscreen: the target's own pixels, which may be coarser than the panel's.
        "uRes": [res.x, res.y], "uOrigin": [0, 0], "uChunk": [Float(chunk.x), Float(chunk.y), Float(chunk.z)],
        "uJitter": [jitter.x, jitter.y], "uColor": [color.x, color.y, color.z],
      ]
    }

    let surfaces = scene.implicits
    var surfaceState: SurfaceState?
    var surfaceKey = ""
    if !surfaces.isEmpty {
      let drawSurfaces: DrawSurfaces = { encoder, height, res, chunk, jitter in
        for s in surfaces {
          guard let program = self.cache.get(QUAD_VERT, surfaceFrag(s.field, s.grad, s.params)) else { continue }
          let values = common.merging(panel.params(s.params, s.uniforms)) { $1 }
            .merging(passValues(res, chunk, jitter, s.color)) { $1 }
          if self.use(
            encoder, program, layout: Self.quadLayout, target: SurfaceTarget.kind,
            height: height, values)
          {
            self.drawQuad(encoder)
          }
        }
      }
      // What the surfaces' pixels depend on, bar time: a frame that changes
      // none of it (a hover, an edit to another row) reuses them as drawn.
      let key = "\(panel.vp)|\(boxR)|\(w)|\(h)|" + surfaces.map {
        "\($0.field)|\($0.grad ?? [])|\($0.color)|\(panel.values($0.params, $0.uniforms))"
      }.joined(separator: "|")
      let timed = surfaces.contains { readsTime(([$0.field] + ($0.grad ?? [])).joined(separator: " ")) }
      drawImplicits(buffer, panel.id, w, h, key, timed ? time : 0, drawSurfaces)
      surfaceState = surfaceStates[panel.id]
      // A cloud stops at the surfaces, so it redraws when they do — and once
      // more when their full-resolution depth is in.
      if let state = surfaceState {
        let settled = state.grid == 1 || state.sample > 0 || state.cells.isEmpty
        surfaceKey = "\(key)|\(settled)|\(timed ? time : 0)"
      }
    }

    // Clouds, raymarched like the surfaces — as costly, so drawn
    // progressively the same way, into targets of their own: one for the part
    // of each ray beyond the grid's plane and one for the part before it
    // (see volumeFrag).
    guard let volumes = scene.volumes, !volumes.isEmpty else { return }
    let volR = volumeRadius(cam)
    let stop = surfaceState?.full.depth
    for back in [true, false] {
      let drawVolumes: DrawSurfaces = { encoder, height, res, chunk, jitter in
        for v in volumes {
          guard let program = self.cache.get(QUAD_VERT, volumeFrag(v.field, v.params)) else { continue }
          var values = common.merging(panel.params(v.params, v.uniforms)) { $1 }
            .merging(passValues(res, chunk, jitter, v.color)) { $1 }
          values["uScale"] = [Float(v.scale)]
          values["uVolR"] = [Float(volR)]
          values["uVolC"] = [Float(cam.target.x), Float(cam.target.y), Float(cam.target.z)]
          values["uBack"] = [back ? 1 : 0]
          values["uStop"] = [stop != nil ? 1 : 0]
          // A sampler the shader won't read still needs a texture behind it.
          if self.use(
            encoder, program, layout: Self.quadLayout, target: SurfaceTarget.kind,
            height: height, values, textures: [stop ?? self.noDepth])
          {
            self.drawQuad(encoder)
          }
        }
      }
      let key = "\(panel.vp)|\(boxR)|\(w)|\(h)|\(surfaceKey)|" + volumes.map {
        "\($0.field)|\($0.color)|\($0.scale)|\(panel.values($0.params, $0.uniforms))"
      }.joined(separator: "|")
      let timed = volumes.contains { readsTime($0.field) }
      drawImplicits(buffer, panel.id + "/volume-\(back ? "back" : "front")", w, h, key, timed ? time : 0, drawVolumes)
    }
  }

  /// Raymarch a panel's implicit surfaces into its offscreen target, as little
  /// as the frame needs. Raymarching is by far the costliest thing drawn: a
  /// fractal's field is a whole orbit, sampled ~50 times per pixel.
  ///
  /// - Nothing changed since the last frame: keep the target as it is.
  /// - The view, a slider or the surfaces changed: raymarch at a resolution
  ///   of at most MOVING_PIXELS, upscale it into the target, and queue the
  ///   full-resolution pixels to follow as the cells of a grid × grid block,
  ///   one cell per frame in dither order, while nothing changes again
  ///   (`refineIn` asks for those frames).
  /// - Once they are in, keep going at rest: AA_SAMPLES − 1 more passes, each
  ///   jittered within the pixel and blended in as a running average, so
  ///   edges smooth and the dust of thin detail a single ray hits or misses
  ///   averages out. Depth stays the unjittered pass's.
  /// - Only time changed (an animated field): raymarch at full resolution,
  ///   as an animation has no rest to refine in.
  func drawImplicits(
    _ buffer: any MTLCommandBuffer, _ id: String, _ w: Int, _ h: Int, _ key: String, _ time: Double,
    _ drawSurfaces: DrawSurfaces
  ) {
    var existing = surfaceStates[id]
    if let found = existing, found.full.w != w || found.full.h != h { existing = nil }
    guard let st = existing ?? makeTarget(w, h).map({ SurfaceState(full: $0) }) else { return }
    surfaceStates[id] = st
    st.used = true

    /// A pass into a target: cleared first (premultiplied, so the target
    /// composites as the surfaces would have blended into the frame
    /// directly), or over what it holds.
    func pass(_ target: SurfaceTarget, clear: Bool, _ draw: (any MTLRenderCommandEncoder) -> Void) {
      let descriptor = MTLRenderPassDescriptor()
      descriptor.colorAttachments[0].texture = target.color
      descriptor.colorAttachments[0].loadAction = clear ? .clear : .load
      descriptor.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
      descriptor.colorAttachments[0].storeAction = .store
      descriptor.depthAttachment.texture = target.depth
      descriptor.depthAttachment.loadAction = clear ? .clear : .load
      descriptor.depthAttachment.clearDepth = 1
      descriptor.depthAttachment.storeAction = .store
      guard let encoder = buffer.makeRenderCommandEncoder(descriptor: descriptor) else { return }
      draw(encoder)
      encoder.endEncoding()
    }

    let grid = max(1, 1 << Int(ceil(log(max(1, Double(w * h) / MOVING_PIXELS)) / log(4))))
    let lw = (w + grid - 1) / grid
    let lh = (h + grid - 1) / grid
    if st.low?.w != lw || st.low?.h != lh { st.low = makeTarget(lw, lh) }
    guard let low = st.low, let support else { return }
    let full = st.full
    let now = ProcessInfo.processInfo.systemUptime
    let size = SIMD2(Float(w), Float(h))
    if key != st.key {
      st.key = key
      st.time = time
      st.changedAt = now
      st.grid = grid
      st.sample = 0
      if grid > 1 {
        // A coarse pixel's center is its block's center, so the upscale lines up.
        pass(low, clear: true) { drawSurfaces($0, lh, size / Float(grid), .zero, .zero) }
        pass(full, clear: true) { encoder in
          guard
            self.use(
              encoder, support.upscale, layout: nil, blend: .replace, target: SurfaceTarget.kind, height: h,
              depth: (true, true), [:], textures: [low.color, low.depth])
          else { return }
          var args: [Float] = [Float(lw), Float(lh), Float(grid), Float(h)]
          encoder.setFragmentBytes(&args, length: 16, index: 0)
          encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        }
        st.cells = ditherOrder(grid)
      } else {
        pass(full, clear: true) { drawSurfaces($0, h, size, .zero, .zero) }
        st.cells = []
      }
    } else if time != st.time {
      st.time = time
      pass(full, clear: true) { drawSurfaces($0, h, size, .zero, .zero) }
      st.cells = []
      st.sample = AA_SAMPLES
    } else if !st.cells.isEmpty, now - st.changedAt >= rest {
      let cell = st.cells.removeFirst()
      let chunk = SIMD3(Int32(st.grid), Int32(cell.x), Int32(cell.y))
      let sample = st.sample
      // Raymarch this cell of every block as a dense coarse image …
      pass(low, clear: true) { drawSurfaces($0, lh, size, chunk, sample > 0 ? haltonJitter(sample) : .zero) }
      // … then write it over the upscaled pass's pixels there, or for a
      // jittered sample, blend it into their running average (color only).
      pass(full, clear: false) { encoder in
        guard
          self.use(
            encoder, support.scatter, layout: nil, blend: sample > 0 ? .average : .replace,
            target: SurfaceTarget.kind, height: h, depth: (true, sample == 0), [:], textures: [low.color, low.depth])
        else { return }
        encoder.setBlendColor(red: 0, green: 0, blue: 0, alpha: 1 / Float(sample + 1))
        // ScatterArgs: an int3 takes four ints' room.
        var args: [Int32] = [chunk.x, chunk.y, chunk.z, 0, Int32(h), Int32(lh), 0, 0]
        encoder.setFragmentBytes(&args, length: 32, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
      }
    }
    // A pass done, and none of its cells left: the next jittered sample.
    if st.cells.isEmpty, st.sample + 1 < AA_SAMPLES {
      st.sample += 1
      st.cells = ditherOrder(st.grid)
    }
  }

  /// Draw a surface target into the frame at the panel's viewport.
  func composite(
    _ encoder: any MTLRenderCommandEncoder, _ t: SurfaceTarget, _ panel: Panel, target: Target3D, write: Bool
  ) {
    guard let support,
      use(
        encoder, support.composite, layout: nil, blend: .premultiplied, target: target, height: panel.targetHeight,
        depth: (false, write), [:], textures: [t.color, t.depth])
    else { return }
    // The panel's top-left corner, as Metal counts.
    var origin: [Float] = [Float(panel.box.x), Float(Double(panel.targetHeight) - panel.box.y - panel.box.h)]
    encoder.setFragmentBytes(&origin, length: 8, index: 0)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  }

  func makeTarget(_ w: Int, _ h: Int) -> SurfaceTarget? {
    func texture(_ format: MTLPixelFormat) -> (any MTLTexture)? {
      let descriptor = MTLTextureDescriptor.texture2DDescriptor(
        pixelFormat: format, width: w, height: h, mipmapped: false)
      descriptor.usage = [.renderTarget, .shaderRead]
      descriptor.storageMode = .private
      return metal.device.makeTexture(descriptor: descriptor)
    }
    guard let color = texture(.rgba8Unorm), let depth = texture(depthFormat) else { return nil }
    return SurfaceTarget(color: color, depth: depth, w: w, h: h)
  }

  /// Seconds until a panel's surfaces are due their next refinement pass
  /// (0: now), or nil once none has any left. The caller renders then.
  public func refineIn() -> Double? {
    var wait: Double?
    let now = ProcessInfo.processInfo.systemUptime
    for st in surfaceStates.values where !st.cells.isEmpty {
      let due = max(0, st.changedAt + rest - now)
      wait = min(wait ?? due, due)
    }
    return wait
  }
}

private nonisolated(unsafe) let timeWord = try! Regex(#"\bt\b"#)

/// Whether a shader expression reads t, and so changes from frame to frame.
private func readsTime(_ glsl: String) -> Bool {
  glsl.contains(timeWord)
}
