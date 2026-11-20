import Foundation
import Metal
import simd

/// The device, and the pipelines compiled on it: web/gl.ts.
public final class MetalContext {
  /// Not an sRGB format: colors are blended as the numbers they are written
  /// as, which is what the site's canvas does.
  public static let pixelFormat = MTLPixelFormat.bgra8Unorm

  public let device: any MTLDevice
  public let queue: any MTLCommandQueue
  /// Shaders compiled since the context was made, so a test can assert that
  /// a slider's drag hits the cache (web/gl.ts `glStats`).
  public private(set) var compiles = 0
  /// Pipelines by fragment source, so editing one equation doesn't recompile
  /// the others; nil for a source that didn't compile.
  private var pipelines: [String: FragmentPipeline?] = [:]

  public init?(device: (any MTLDevice)? = MTLCreateSystemDefaultDevice()) {
    guard let device, let queue = device.makeCommandQueue() else { return nil }
    self.device = device
    self.queue = queue
  }

  struct FragmentPipeline {
    var state: any MTLRenderPipelineState
    var slots: [String: (offset: Int, count: Int)]
    var count: Int
  }

  /// The pipeline for a GLSL fragment shader over the fullscreen triangle,
  /// blended over what is there (SRC_ALPHA, ONE_MINUS_SRC_ALPHA).
  func pipeline(fragment glsl: String) -> FragmentPipeline? {
    if let cached = pipelines[glsl] { return cached }
    // Bound the cache; old pipelines are cheap to rebuild.
    if pipelines.count > 64 { pipelines.removeAll() }
    let made = compile(glsl)
    pipelines[glsl] = .some(made)
    return made
  }

  private func compile(_ glsl: String) -> FragmentPipeline? {
    compiles += 1
    let translated = translateFragment(glsl)
    do {
      let library = try makeLibrary(translated.source)
      let descriptor = MTLRenderPipelineDescriptor()
      descriptor.vertexFunction = library.makeFunction(name: "quad_vertex")
      descriptor.fragmentFunction = library.makeFunction(name: "graph_fragment")
      let color = descriptor.colorAttachments[0]!
      color.pixelFormat = Self.pixelFormat
      color.isBlendingEnabled = true
      color.sourceRGBBlendFactor = .sourceAlpha
      color.destinationRGBBlendFactor = .oneMinusSourceAlpha
      color.sourceAlphaBlendFactor = .one
      color.destinationAlphaBlendFactor = .oneMinusSourceAlpha
      let state = try device.makeRenderPipelineState(descriptor: descriptor)
      return FragmentPipeline(state: state, slots: translated.slots, count: translated.count)
    } catch {
      print("Shader compile error: \(error)\n---\n\(glsl)")
      return nil
    }
  }

  /// Compile Metal source as the shaders need it compiled.
  public func makeLibrary(_ source: String) throws -> any MTLLibrary {
    let options = MTLCompileOptions()
    // Fast math assumes there are no NaNs or infinities, and the shaders test for both.
    options.mathMode = .safe
    return try device.makeLibrary(source: source, options: options)
  }
}

/// What every fragment pass is told about where it draws. Laid out as the
/// `Frame` struct in GLSL.swift: float2 aligns to 8 bytes, float4 to 16.
struct FrameUniforms {
  var center: SIMD2<Float>
  var upp: SIMD2<Float>
  var res: SIMD2<Float>
  var origin: SIMD2<Float>
  var time: Float
  /// The target's height in pixels, to count gl_FragCoord.y up from its bottom.
  var height: Float
  var color: SIMD4<Float> = .zero
}

extension MetalContext {
  /// Draw one fullscreen pass. `value` gives each uniform the shader
  /// declares beyond the frame's; one it doesn't name is 0.
  func draw(
    _ encoder: any MTLRenderCommandEncoder, fragment glsl: String, frame: FrameUniforms,
    value: (String) -> [Float]?
  ) {
    guard let pipeline = pipeline(fragment: glsl) else { return }
    var frame = frame
    var floats = [Float](repeating: 0, count: pipeline.count)
    for (name, slot) in pipeline.slots {
      guard let given = value(name) else { continue }
      for k in 0..<min(slot.count, given.count) { floats[slot.offset + k] = given[k] }
    }
    encoder.setRenderPipelineState(pipeline.state)
    encoder.setFragmentBytes(&frame, length: MemoryLayout<FrameUniforms>.stride, index: 0)
    encoder.setFragmentBytes(&floats, length: floats.count * MemoryLayout<Float>.stride, index: 1)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  }
}
