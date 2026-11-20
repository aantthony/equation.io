import EquationCore
import Foundation
import Metal
import simd

/// 2D graph rendering in Metal: web/render2d.ts, ported a layer at a time.
///
/// As there, everything is a fullscreen fragment shader: the fragment's
/// position is mapped to math coordinates, the equation's field F(x, y) is
/// evaluated per pixel, and the curve F = 0 is drawn where the screen-space
/// distance estimate |F| / |∇F| is under the line width.
///
/// So far: the Cartesian grid and implicit curves (`l = r` in x and y).

/// The window onto the plane (web/render2d.ts `View2D`).
struct View2D: Equatable {
  var cx = 0.0
  var cy = 0.0
  /// Math units per device pixel.
  var upp = 0.01
}

/// One curve: MSL for its field F in floats x, y and t (EquationCore `toMetal`).
struct MetalCurve: Equatable {
  var field: String
  var color: SIMD3<Float>
}

/// The colors the graph is drawn in (web/theme.ts, lib/palette.ts).
struct GraphTheme: Equatable {
  var bg: SIMD3<Float>
  var gridMinor: SIMD3<Float>
  var gridMajor: SIMD3<Float>
  var axis: SIMD3<Float>
  /// Axis numerals.
  var label: SIMD3<Float>
  /// Row colors, in the order a document's rows take them.
  var palette: [SIMD3<Float>]

  static let light = GraphTheme(
    bg: [1, 1, 1],
    gridMinor: [0.91, 0.91, 0.91],
    gridMajor: [0.8, 0.8, 0.8],
    axis: [0.25, 0.25, 0.25],
    label: [1 / 3, 1 / 3, 1 / 3],
    palette: [
      [0.176, 0.439, 0.702], [0.78, 0.267, 0.251], [0.22, 0.549, 0.275], [0.376, 0.259, 0.651],
      [0.98, 0.494, 0.098], [0, 0, 0],
    ])

  static let dark = GraphTheme(
    bg: [0.09, 0.1, 0.12],
    gridMinor: [0.19, 0.2, 0.23],
    gridMajor: [0.3, 0.31, 0.35],
    axis: [0.55, 0.56, 0.6],
    label: [0.545, 0.565, 0.604],
    palette: [
      [0.4, 0.62, 0.92], [0.92, 0.45, 0.42], [0.42, 0.78, 0.48], [0.65, 0.52, 0.95], [0.98, 0.62, 0.28],
      [0.9, 0.91, 0.93],
    ])
}

/// A "nice" grid spacing (1, 2 or 5 × 10^k) at least `minPx` pixels apart.
func niceSpacing(upp: Double, minPx: Double) -> (major: Double, minor: Double) {
  let target = upp * minPx
  let base = pow(10, floor(log10(target)))
  for (m, div) in [(1.0, 5.0), (2, 4), (5, 5), (10, 5)] where m * base >= target {
    return (m * base, m * base / div)
  }
  return (10 * base, 2 * base)
}

final class MetalRenderer {
  /// Not an sRGB format: colors are blended as the numbers they are written
  /// as, which is what the web renderer's canvas does.
  static let pixelFormat = MTLPixelFormat.bgra8Unorm

  let device: any MTLDevice
  private let queue: any MTLCommandQueue
  /// Pipelines by fragment source, so editing one equation doesn't recompile
  /// the others; nil for a source that didn't compile.
  private var pipelines: [String: (any MTLRenderPipelineState)?] = [:]

  init?(device: (any MTLDevice)?) {
    guard let device, let queue = device.makeCommandQueue() else { return nil }
    self.device = device
    self.queue = queue
  }

  /// Draw the grid, then each curve over it, into `pass`. `size` is the
  /// target's, in pixels.
  func draw(
    pass: MTLRenderPassDescriptor,
    size: SIMD2<Float>,
    view: View2D,
    curves: [MetalCurve],
    time: Float,
    theme: GraphTheme
  ) -> (any MTLCommandBuffer)? {
    guard let buffer = queue.makeCommandBuffer(), let encoder = buffer.makeRenderCommandEncoder(descriptor: pass)
    else { return nil }
    let center = SIMD2(Float(view.cx), Float(view.cy))
    let upp = SIMD2(repeating: Float(view.upp))

    if let grid = pipeline(Self.gridFragment) {
      let spacing = niceSpacing(upp: view.upp, minPx: 90)
      var uniforms = GridUniforms(
        center: center, upp: upp, res: size,
        major: SIMD2(repeating: Float(spacing.major)), minor: SIMD2(repeating: Float(spacing.minor)),
        bg: SIMD4(theme.bg, 1), gridMinor: SIMD4(theme.gridMinor, 1), gridMajor: SIMD4(theme.gridMajor, 1),
        axis: SIMD4(theme.axis, 1))
      encoder.setRenderPipelineState(grid)
      encoder.setFragmentBytes(&uniforms, length: MemoryLayout<GridUniforms>.stride, index: 0)
      encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    }

    for curve in curves {
      guard let state = pipeline(Self.curveFragment(field: curve.field)) else { continue }
      var uniforms = CurveUniforms(center: center, upp: upp, res: size, time: time, color: SIMD4(curve.color, 1))
      encoder.setRenderPipelineState(state)
      encoder.setFragmentBytes(&uniforms, length: MemoryLayout<CurveUniforms>.stride, index: 0)
      encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    }

    encoder.endEncoding()
    return buffer
  }

  private func pipeline(_ fragment: String) -> (any MTLRenderPipelineState)? {
    if let cached = pipelines[fragment] { return cached }
    // Bound the cache; old pipelines are cheap to rebuild.
    if pipelines.count > 64 { pipelines.removeAll() }
    let state = compile(fragment)
    pipelines[fragment] = .some(state)
    return state
  }

  private func compile(_ fragment: String) -> (any MTLRenderPipelineState)? {
    let options = MTLCompileOptions()
    // Fast math assumes there are no NaNs or infinities, and the shaders test for both.
    options.mathMode = .safe
    do {
      let library = try device.makeLibrary(source: Self.header + fragment, options: options)
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
      return try device.makeRenderPipelineState(descriptor: descriptor)
    } catch {
      print("Metal shader failed to compile: \(error)\n---\n\(fragment)")
      return nil
    }
  }

  // MARK: - Shaders

  // Laid out as the MSL structs below: float2 aligns to 8 bytes, float4 to 16.
  private struct GridUniforms {
    var center: SIMD2<Float>
    var upp: SIMD2<Float>
    var res: SIMD2<Float>
    var major: SIMD2<Float>
    var minor: SIMD2<Float>
    var bg: SIMD4<Float>
    var gridMinor: SIMD4<Float>
    var gridMajor: SIMD4<Float>
    var axis: SIMD4<Float>
  }

  private struct CurveUniforms {
    var center: SIMD2<Float>
    var upp: SIMD2<Float>
    var res: SIMD2<Float>
    var time: Float
    var color: SIMD4<Float>
  }

  /// A triangle covering the target; every pass draws it. `mathPoint` maps a
  /// fragment to math coordinates: pixels count down from the top in Metal,
  /// and y counts up.
  private static let header = """
    #include <metal_stdlib>
    using namespace metal;

    struct Varyings { float4 position [[position]]; };

    vertex Varyings quad_vertex(uint id [[vertex_id]]) {
      const float2 corners[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
      Varyings out;
      out.position = float4(corners[id], 0.0, 1.0);
      return out;
    }

    static float2 mathPoint(float4 position, float2 center, float2 upp, float2 res) {
      return center + float2(position.x - 0.5 * res.x, 0.5 * res.y - position.y) * upp;
    }

    \(metalPrelude)

    """

  /// The Cartesian grid (render2d.ts `gridFrag` over the identity pair x, y):
  /// an antialiased line at every multiple of the minor and major spacing,
  /// with width from the distance to the level in pixels, and the axes.
  private static let gridFragment = """
    struct GridUniforms {
      float2 center;
      float2 upp;
      float2 res;
      float2 major;
      float2 minor;
      float4 bg;
      float4 gridMinor;
      float4 gridMajor;
      float4 axis;
    };

    static float gridLine(float c, float lg, float spacing, float halfWidthPx) {
      if (isnan(c) || isnan(lg) || isinf(lg)) return 0.0;
      float lgv = max(lg / spacing, 1e-24);  // |∇(c/spacing)| per pixel
      float v = c / spacing;
      float distPx = abs(v - round(v)) / lgv;
      float a = 1.0 - smoothstep(halfWidthPx, halfWidthPx + 1.0, distPx);
      // Fade out where lines crowd toward subpixel spacing.
      return a * clamp((0.35 - lgv) / 0.25, 0.0, 1.0);
    }

    fragment float4 graph_fragment(Varyings in [[stage_in]], constant GridUniforms &u [[buffer(0)]]) {
      float2 p = mathPoint(in.position, u.center, u.upp, u.res);
      float minorA = 0.0;
      float majorA = 0.0;
      float axisA = 0.0;
      for (int k = 0; k < 2; k++) {
        float c = p[k];
        float lg = u.upp[k];
        minorA = max(minorA, gridLine(c, lg, u.minor[k], 0.5));
        majorA = max(majorA, gridLine(c, lg, u.major[k], 0.5));
        axisA = max(axisA, 1.0 - smoothstep(0.9, 1.9, abs(c) / max(lg, 1e-24)));
      }
      float3 col = u.bg.rgb;
      col = mix(col, u.gridMinor.rgb, minorA);
      col = mix(col, u.gridMajor.rgb, majorA);
      col = mix(col, u.axis.rgb, axisA);
      return float4(col, 1.0);
    }
    """

  /// The curve F = 0 (render2d.ts `curveFrag`).
  private static func curveFragment(field: String) -> String {
    """
    struct CurveUniforms {
      float2 center;
      float2 upp;
      float2 res;
      float time;
      float4 color;
    };

    static float F(float x, float y, float t) { return \(field); }

    fragment float4 graph_fragment(Varyings in [[stage_in]], constant CurveUniforms &u [[buffer(0)]]) {
      float t = u.time;
      float2 p = mathPoint(in.position, u.center, u.upp, u.res);
      float v = F(p.x, p.y, t);
      if (isnan(v) || isinf(v)) { discard_fragment(); return float4(0.0); }

      // Distance estimate |F| / |grad F| in pixels, from central differences at
      // two step sizes. For a genuine zero crossing the two estimates agree; near
      // a pole (y=tan(x) asymptotes, y=1/x at x=0) the first-order estimate is a
      // lie that varies with step size, so disagreement rejects the fake line.
      float2 h = u.upp;
      float2 g1 = float2(F(p.x + h.x, p.y, t) - F(p.x - h.x, p.y, t),
                         F(p.x, p.y + h.y, t) - F(p.x, p.y - h.y, t)) / (2.0 * h);
      float2 g2 = float2(F(p.x + 0.5 * h.x, p.y, t) - F(p.x - 0.5 * h.x, p.y, t),
                         F(p.x, p.y + 0.5 * h.y, t) - F(p.x, p.y - 0.5 * h.y, t)) / h;
      float e1 = abs(v) / max(length(g1 * h), 1e-24);
      float e2 = abs(v) / max(length(g2 * h), 1e-24);

      float distPx;
      if (isnan(e1) || isinf(e1) || isnan(e2) || isinf(e2)) {
        // Domain edges (sqrt, log): fall back to screen-space derivatives.
        float va = atan(v);
        float2 g = float2(dfdx(va), dfdy(va));
        distPx = abs(va) / max(length(g), 1e-24);
      } else {
        if (e2 > 1.6 * e1 || e1 > 1.6 * e2) { discard_fragment(); return float4(0.0); }
        distPx = max(e1, e2);
      }

      // Pixels within 2.1 of the curve are drawn.
      float alpha = 1.0 - smoothstep(1.1, 2.1, distPx);
      if (alpha <= 0.0) { discard_fragment(); return float4(0.0); }
      return float4(u.color.rgb, alpha);
    }
    """
  }
}
