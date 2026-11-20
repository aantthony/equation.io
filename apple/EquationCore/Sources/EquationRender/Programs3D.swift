import EquationCore
import Foundation
import Metal

// What stands between the 3D renderer and Metal: web/gl.ts's ProgramCache,
// and the state GL sets call by call that Metal bakes into a pipeline.

/// Where a program's vertex attributes come from: what GL's
/// vertexAttribPointer and vertexAttribDivisor calls say of a vertex array.
struct VertexLayout: Hashable {
  struct Attribute: Hashable {
    var location: Int
    /// Floats.
    var size: Int
    var buffer: Int
    var offset: Int
  }
  struct Buffer: Hashable {
    /// Bytes from one vertex to the next.
    var stride: Int
    /// One per instance, not per vertex (a divisor of 1).
    var perInstance = false
  }
  var attributes: [Attribute]
  var buffers: [Buffer]

  /// Attributes of `sizes` floats, each in a buffer of its own.
  static func separate(_ sizes: [Int]) -> VertexLayout {
    VertexLayout(
      attributes: sizes.enumerated().map { Attribute(location: $0, size: $1, buffer: $0, offset: 0) },
      buffers: sizes.map { Buffer(stride: $0 * 4) })
  }

  /// Attributes of `sizes` floats one after another in a single buffer.
  static func interleaved(_ sizes: [Int], perInstance: Bool = false) -> VertexLayout {
    var offset = 0
    var attributes: [Attribute] = []
    for (location, size) in sizes.enumerated() {
      attributes.append(Attribute(location: location, size: size, buffer: 0, offset: offset))
      offset += size * 4
    }
    return VertexLayout(attributes: attributes, buffers: [Buffer(stride: offset, perInstance: perInstance)])
  }

  var descriptor: MTLVertexDescriptor {
    let descriptor = MTLVertexDescriptor()
    for attribute in attributes {
      let a = descriptor.attributes[attribute.location]!
      a.format = [.float, .float2, .float3, .float4][attribute.size - 1]
      a.bufferIndex = attribute.buffer
      a.offset = attribute.offset
    }
    for (index, buffer) in buffers.enumerated() {
      let layout = descriptor.layouts[index]!
      layout.stride = buffer.stride
      layout.stepFunction = buffer.perInstance ? .perInstance : .perVertex
    }
    return descriptor
  }
}

/// How a draw's color meets what is there: GL's blendFunc, and colorMask.
enum Blend3D: Hashable {
  /// SRC_ALPHA, ONE_MINUS_SRC_ALPHA for color, with alpha kept premultiplied
  /// (ONE, ONE_MINUS_SRC_ALPHA). Into a surface target, so it composites as
  /// its surfaces would have blended into the frame directly; and into the
  /// frame, which then stays opaque, as the site's canvas is (`alpha: false`).
  case over
  /// ONE, ONE_MINUS_SRC_ALPHA: a premultiplied target into the frame.
  case premultiplied
  /// No blending.
  case replace
  /// CONSTANT_ALPHA, ONE_MINUS_CONSTANT_ALPHA: into a running average.
  case average
  /// No color written: depth alone.
  case depthOnly
}

/// What a pipeline draws into. The depth attachment is always `depthFormat`.
struct Target3D: Hashable {
  var color: MTLPixelFormat
  var samples: Int
}

/// The frame's and the surface targets' depth: 32-bit float, where the site
/// has 24 bits of fixed point, so surfaces that nearly touch far from the
/// eye are told apart a little better.
let depthFormat = MTLPixelFormat.depth32Float

/// A compiled vertex and fragment pair, and its pipelines by what they draw into and how.
final class Program3D {
  let library: any MTLLibrary
  let slots: [String: (offset: Int, count: Int)]
  let count: Int
  let textures: [String]
  private let vertexName: String
  private let fragmentName: String
  private struct Key: Hashable {
    var layout: VertexLayout?
    var blend: Blend3D
    var target: Target3D
  }
  private var states: [Key: (any MTLRenderPipelineState)?] = [:]

  init(_ library: any MTLLibrary, _ translated: TranslatedProgram) {
    self.library = library
    slots = translated.slots
    count = translated.count
    textures = translated.textures
    vertexName = "program_vertex"
    fragmentName = "program_fragment"
  }

  /// One of the renderer's own Metal shaders (`supportSource`), which take no uniform floats.
  init(_ library: any MTLLibrary, vertex: String, fragment: String) {
    self.library = library
    slots = [:]
    count = 0
    textures = []
    vertexName = vertex
    fragmentName = fragment
  }

  func state(layout: VertexLayout?, blend: Blend3D, target: Target3D) -> (any MTLRenderPipelineState)? {
    let key = Key(layout: layout, blend: blend, target: target)
    if let made = states[key] { return made }
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = library.makeFunction(name: vertexName)
    descriptor.fragmentFunction = library.makeFunction(name: fragmentName)
    descriptor.vertexDescriptor = layout?.descriptor
    descriptor.rasterSampleCount = target.samples
    descriptor.depthAttachmentPixelFormat = depthFormat
    let color = descriptor.colorAttachments[0]!
    color.pixelFormat = target.color
    color.isBlendingEnabled = blend != .replace && blend != .depthOnly
    color.destinationRGBBlendFactor = .oneMinusSourceAlpha
    color.destinationAlphaBlendFactor = .oneMinusSourceAlpha
    switch blend {
    case .over:
      color.sourceRGBBlendFactor = .sourceAlpha
      color.sourceAlphaBlendFactor = .one
    case .premultiplied:
      color.sourceRGBBlendFactor = .one
      color.sourceAlphaBlendFactor = .one
    case .average:
      color.sourceRGBBlendFactor = .blendAlpha
      color.sourceAlphaBlendFactor = .blendAlpha
      color.destinationRGBBlendFactor = .oneMinusBlendAlpha
      color.destinationAlphaBlendFactor = .oneMinusBlendAlpha
    case .replace: break
    case .depthOnly: color.writeMask = []
    }
    let state: (any MTLRenderPipelineState)?
    do {
      state = try library.device.makeRenderPipelineState(descriptor: descriptor)
    } catch {
      print("Pipeline error: \(error)")
      state = nil
    }
    states[key] = .some(state)
    return state
  }
}

/// Cache programs by source so editing one equation doesn't recompile others (web/gl.ts).
final class ProgramCache3D {
  private let metal: MetalContext
  /// nil for a pair that didn't compile.
  private var map: [String: Program3D?] = [:]
  /// Programs compiled since the cache was made, so a test can assert that a
  /// slider's drag hits it (web/gl.ts `glStats`).
  private(set) var compiles = 0
  /// How many of them didn't compile.
  private(set) var failures = 0

  init(_ metal: MetalContext) {
    self.metal = metal
  }

  /// The declarations of the loop helpers (`eq_loop_…`: recursive functions,
  /// Fourier sums) the fragment shaders name. The site keeps a registry the
  /// language fills as it compiles a row, and splices the ones a shader
  /// names in after the prelude (lib/glsl.ts `withHelpers`); until the
  /// language's Swift port declares helpers, whoever builds the scene hands
  /// their GLSL over with it.
  var helpers = ""

  func get(_ vert: String, _ fragment: String) -> Program3D? {
    var frag = fragment
    if frag.contains("eq_loop_"), !helpers.isEmpty {
      frag.replace(glslPrelude, with: "\(glslPrelude)\n\(helpers)\n", maxReplacements: 1)
    }
    let key = vert + "\0" + frag
    if let cached = map[key] { return cached }
    // Bound the cache; old programs are cheap to rebuild.
    if map.count > 64 { map.removeAll() }
    compiles += 1
    let translated = translateProgram(vertex: vert, fragment: frag)
    var program: Program3D?
    do {
      program = Program3D(try metal.makeLibrary(translated.source), translated)
    } catch {
      failures += 1
      print("Shader compile error: \(error)\n---\n\(frag)")
    }
    map[key] = .some(program)
    return program
  }
}

/// The passes that move a surface target's pixels about, written in Metal:
/// the site's SCATTER_FRAG and COMPOSITE_FRAG, and its blitFramebuffer from
/// the coarse target to the full one. They read texels of a color and a
/// depth texture and write both; positions here count from the top-left, as
/// Metal's do, where the GLSL they stand for counts from the bottom-left.
let supportSource = """
  #include <metal_stdlib>
  using namespace metal;

  struct QuadOut { float4 position [[position]]; };
  struct ColorDepth { float4 color [[color(0)]]; float depth [[depth(any)]]; };

  vertex QuadOut eq3_quad(uint id [[vertex_id]]) {
    const float2 corners[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
    QuadOut out;
    out.position = float4(corners[id], 0.0, 1.0);
    return out;
  }

  struct ScatterArgs {
    // (grid, x, y): the cell of every grid × grid block the coarse image holds.
    int3 chunk;
    // The heights of the full target and of the coarse one.
    int height;
    int lowHeight;
  };

  // Writes a chunk pass into its cell of the full-resolution surface target.
  fragment ColorDepth eq3_scatter(QuadOut in [[stage_in]], texture2d<float> color [[texture(0)]],
                                  depth2d<float> depth [[texture(1)]], constant ScatterArgs &a [[buffer(0)]]) {
    // Cells are counted from the bottom-left, as the pass that drew them counted its pixels.
    int2 p = int2(int(in.position.x), a.height - 1 - int(in.position.y));
    if (p.x % a.chunk.x != a.chunk.y || p.y % a.chunk.x != a.chunk.z) discard_fragment();
    int2 q = p / a.chunk.x;
    uint2 at = uint2(q.x, a.lowHeight - 1 - q.y);
    ColorDepth out;
    out.color = color.read(at);
    out.depth = depth.read(at);
    return out;
  }

  // Draws a surface target (premultiplied color and depth) into the frame,
  // so the surfaces still hide, and hide behind, what the frame draws.
  // `origin` is the panel's top-left corner in the frame.
  fragment ColorDepth eq3_composite(QuadOut in [[stage_in]], texture2d<float> color [[texture(0)]],
                                    depth2d<float> depth [[texture(1)]], constant float2 &origin [[buffer(0)]]) {
    uint2 p = uint2(in.position.xy - origin);
    float4 c = color.read(p);
    if (c.a <= 0.0) discard_fragment();
    ColorDepth out;
    out.color = c;
    out.depth = depth.read(p);
    return out;
  }

  struct UpscaleArgs {
    float2 lowSize;
    float grid;
    float height;
  };

  constexpr sampler eq3_linear(coord::normalized, filter::linear, address::clamp_to_edge);
  constexpr sampler eq3_point(coord::normalized, filter::nearest, address::clamp_to_edge);

  // The coarse target stretched over the full one from its bottom-left
  // corner: color smoothed, depth the nearest texel's.
  fragment ColorDepth eq3_upscale(QuadOut in [[stage_in]], texture2d<float> color [[texture(0)]],
                                  depth2d<float> depth [[texture(1)]], constant UpscaleArgs &a [[buffer(0)]]) {
    float2 low = float2(in.position.x, a.height - in.position.y) / a.grid;
    float2 uv = float2(low.x / a.lowSize.x, 1.0 - low.y / a.lowSize.y);
    ColorDepth out;
    out.color = color.sample(eq3_linear, uv);
    out.depth = depth.sample(eq3_point, uv);
    return out;
  }
  """
