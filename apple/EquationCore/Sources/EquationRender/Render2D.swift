import EquationCore
import Foundation
import Metal
import simd

/// 2D graph rendering: web/render2d.ts. Everything is a fullscreen fragment
/// shader: the fragment's position is mapped to math coordinates, the
/// equation's field F(x, y) is evaluated per pixel, and the curve F = 0 is
/// drawn where the screen-space distance estimate |F| / |∇F| is under the
/// line width.
///
/// The types here are the site's, field for field, so a scene described for
/// one describes it for the other; they are Codable so a scene can be written
/// down (metal-shot draws one from JSON).

/// The window onto the plane.
public struct View2D: Equatable, Codable, Sendable {
  public var cx: Double
  public var cy: Double
  /// Math units per device pixel.
  public var upp: Double
  /// x units per y unit on screen, when the axes are scaled apart (1 without).
  public var ratio: Double?

  public init(cx: Double = 0, cy: Double = 0, upp: Double = 0.01, ratio: Double? = nil) {
    self.cx = cx
    self.cy = cy
    self.upp = upp
    self.ratio = ratio
  }

  /// Math units per device pixel up the screen.
  public var uppY: Double { upp / (ratio ?? 1) }
}

public struct Curve2D: Equatable, Codable, Sendable {
  /// GLSL expression for F(x,y) in terms of floats x, y.
  public var field: String
  /// A finite Fourier graph's value and analytic slope, evaluated together.
  public var graphEval: GraphEval?
  public var color: RGB
  /// User-defined constants the field references (as u_<name> uniforms).
  public var params: [String]?
  /// Extra per-item float uniforms set each draw (e.g. a recurrence seed).
  public var uniforms: [String: Double]?

  public struct GraphEval: Equatable, Codable, Sendable {
    public var glsl: String
    public var slopeScale: Double
  }

  public init(
    field: String, graphEval: GraphEval? = nil, color: RGB, params: [String]? = nil, uniforms: [String: Double]? = nil
  ) {
    self.field = field
    self.graphEval = graphEval
    self.color = color
    self.params = params
    self.uniforms = uniforms
  }
}

/// Everything drawable in a 2D frame, in back-to-front draw order
/// (web/render2d.ts `Layers2D`). A layer joins this struct when its shader is ported.
public struct Layers2D: Equatable, Codable, Sendable {
  public var cells: [Cells2D]?
  public var fractals: [Fractal2D]?
  public var domains: [Curve2D]?
  public var colors: [ColorField2D]?
  public var conformals: [Curve2D]?
  public var vfields: [VField2D]?
  public var tfields: [TField2D]?
  public var complexes: [Curve2D]?
  public var curves: [Curve2D]?

  public init(
    cells: [Cells2D]? = nil, fractals: [Fractal2D]? = nil, domains: [Curve2D]? = nil, colors: [ColorField2D]? = nil,
    conformals: [Curve2D]? = nil, vfields: [VField2D]? = nil, tfields: [TField2D]? = nil,
    complexes: [Curve2D]? = nil, curves: [Curve2D]? = nil
  ) {
    self.cells = cells
    self.fractals = fractals
    self.domains = domains
    self.colors = colors
    self.conformals = conformals
    self.vfields = vfields
    self.tfields = tfields
    self.complexes = complexes
    self.curves = curves
  }
}

/// One grid family: level sets of a coordinate field c(x, y).
public struct GridSpec: Equatable, Codable, Sendable {
  /// GLSL for c(x, y) (constants as u_<name> uniforms).
  public var glsl: String
  /// GLSL for ∇c in math units; absent → screen derivatives (dFdx/dFdy).
  public var gradGlsl: [String]?
  public var params: [String]
  public var major: Double
  public var minor: Double

  public init(glsl: String, gradGlsl: [String]? = nil, params: [String] = [], major: Double, minor: Double) {
    self.glsl = glsl
    self.gradGlsl = gradGlsl
    self.params = params
    self.major = major
    self.minor = minor
  }
}

/// Where a renderer draws: a panel's box in device pixels, from the
/// bottom-left corner as GL counts, and how much of the grid goes behind its
/// plots (web/gl.ts `Frame`).
public struct Frame2D: Equatable, Codable, Sendable {
  public var vp: Box?
  public var grid: Grid?
  /// The ticks of the axes the panel's view(…) maps, which are gridded at
  /// them: the site's `maps`, as `mappedTicks` reads them (Frag2D+Ticks.swift).
  public var ticks: MappedTicks?

  public struct Box: Equatable, Codable, Sendable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
      self.x = x
      self.y = y
      self.w = w
      self.h = h
    }
  }

  public enum Grid: String, Codable, Sendable {
    case on, off, axes
  }

  public init(vp: Box? = nil, grid: Grid? = nil, ticks: MappedTicks? = nil) {
    self.vp = vp
    self.grid = grid
    self.ticks = ticks
  }
}

/// Pick a "nice" grid spacing (1, 2, or 5 × 10^k) at least minPx pixels apart.
public func niceSpacing(_ upp: Double, _ minPx: Double) -> (major: Double, minor: Double) {
  let target = upp * minPx
  let base = pow(10, floor(log10(target)))
  for (m, div) in [(1.0, 5.0), (2, 4), (5, 5), (10, 5)] where m * base >= target {
    return (m * base, m * base / div)
  }
  return (10 * base, 2 * base)
}

public final class Renderer2D {
  public let metal: MetalContext
  /// Cell textures by the shade buffer they were uploaded from (Cells2D.swift).
  let cellTextures = CellTextures()

  public init(_ metal: MetalContext) {
    self.metal = metal
  }

  /// Drop cell textures no render drew since the last call: once per frame,
  /// after every panel of a split view has rendered.
  public func endFrame() {
    cellTextures.endFrame()
  }

  /// Draw a frame into `encoder`, whose target is `target` pixels: the grid,
  /// then the layers over it, back to front (web/render2d.ts `Renderer2D.render`).
  public func render(
    _ encoder: any MTLRenderCommandEncoder,
    target: (width: Int, height: Int),
    view: View2D,
    layers: Layers2D,
    time: Double = 0,
    env: [String: Double] = [:],
    gridSpecs: [GridSpec]? = nil,
    frame: Frame2D = Frame2D(),
    theme: GraphTheme
  ) {
    let vp = frame.vp ?? Frame2D.Box(x: 0, y: 0, w: Double(target.width), h: Double(target.height))
    guard vp.w >= 1, vp.h >= 1 else { return }
    // GL counts the box up from the bottom of the target; Metal, down from the top.
    let top = Double(target.height) - vp.y - vp.h
    encoder.setViewport(
      MTLViewport(originX: vp.x, originY: top, width: vp.w, height: vp.h, znear: 0, zfar: 1))
    let left = min(max(Int(vp.x), 0), target.width)
    let upper = min(max(Int(top), 0), target.height)
    encoder.setScissorRect(
      MTLScissorRect(
        x: left, y: upper, width: max(min(Int(vp.w), target.width - left), 0),
        height: max(min(Int(vp.h), target.height - upper), 0)))

    var uniforms = FrameUniforms(
      center: SIMD2(Float(view.cx), Float(view.cy)), upp: SIMD2(Float(view.upp), Float(view.uppY)),
      res: SIMD2(Float(vp.w), Float(vp.h)), origin: SIMD2(Float(vp.x), Float(vp.y)), time: Float(time),
      height: Float(target.height))

    let grid = frame.grid ?? .on
    var specs = grid == .off ? [] : gridSpecs ?? []
    if grid != .off, specs.isEmpty {
      let spacing = niceSpacing(view.upp, 90)
      let spacingY = niceSpacing(view.uppY, 90)
      specs = [
        GridSpec(glsl: "x", gradGlsl: ["1.0", "0.0"], major: spacing.major, minor: spacing.minor),
        GridSpec(glsl: "y", gradGlsl: ["0.0", "1.0"], major: spacingY.major, minor: spacingY.minor),
      ]
      // A mapped axis is gridded at its ticks below, not evenly here.
      specs.removeAll { ($0.glsl == "x" && frame.ticks?.x != nil) || ($0.glsl == "y" && frame.ticks?.y != nil) }
    }
    let named = Dictionary(
      specs.enumerated().flatMap { k, s in [("uMajor\(k)", s.major), ("uMinor\(k)", s.minor)] },
      uniquingKeysWith: { a, _ in a })
    metal.draw(encoder, fragment: gridFrag(specs, axesOnly: grid == .axes, theme: theme), frame: uniforms) { name in
      (named[name] ?? Self.param(name, specs.flatMap(\.params), env)).map { [Float($0)] }
    }

    let mapped = [("x", frame.ticks?.x), ("y", frame.ticks?.y)].compactMap { a, ticks in ticks.map { (a, $0) } }
    if grid != .off, !mapped.isEmpty {
      var named: [String: [Float]] = [:]
      for (a, ticks) in mapped {
        let major = grid == .axes ? [] : ticks.major.prefix(MAX_MAJOR_TICKS).map { Float($0.at) }
        let minor = grid == .axes ? [] : ticks.minor.prefix(MAX_MINOR_TICKS).map { Float($0) }
        named["uMaj\(a)"] = major
        named["uMin\(a)"] = minor
        named["uNMaj\(a)"] = [Float(major.count)]
        named["uNMin\(a)"] = [Float(minor.count)]
        named["uZero\(a)"] = [Float(ticks.zero ?? 0)]
        named["uHasZero\(a)"] = [ticks.zero == nil ? 0 : 1]
      }
      metal.draw(encoder, fragment: tickFrag(mapped.map(\.0), theme: theme), frame: uniforms) { named[$0] }
    }

    func drawProgram(_ frag: String, _ color: RGB, _ params: [String]?, _ extra: [String: Double]? = nil) {
      uniforms.color = SIMD4(color, 1)
      metal.draw(encoder, fragment: frag, frame: uniforms) { name in
        (extra?[name] ?? Self.param(name, params ?? [], env)).map { [Float($0)] }
      }
    }

    func drawField(_ item: Curve2D, _ frag: (String, [String]?) -> String) {
      drawProgram(frag(item.field, item.params), item.color, item.params, item.uniforms)
    }

    for c in layers.cells ?? [] {
      guard let texture = cellTextures.texture(c, device: metal.device) else { continue }
      uniforms.color = SIMD4(c.color, 1)
      let named: [String: [Float]] = [
        "uSize": [Float(c.width), Float(c.rows)], "uCorner": [Float(c.x0), Float(c.y0)],
        "uRuns": [c.runs.x ? 1 : 0, c.runs.y ? 1 : 0],
      ]
      metal.draw(encoder, fragment: CELLS_FRAG, frame: uniforms, texture: { _ in texture }) { named[$0] }
    }
    for f in layers.fractals ?? [] {
      // The site leaves a fractal's own uniforms unset; they are set here, as every other layer's are.
      let frag = fractalFrag(f.step, seed: f.seed, maxIter: f.maxIter, params: f.params)
      drawProgram(frag, f.color, f.params, f.uniforms)
    }
    for d in layers.domains ?? [] { drawField(d) { domainFrag($0, params: $1) } }
    for c in layers.colors ?? [] {
      drawProgram(
        colorFrag(c.field, params: c.params, locals: c.locals, space: c.space), c.color, c.params, c.uniforms)
    }
    for c in layers.conformals ?? [] { drawField(c) { conformalFrag($0, params: $1) } }
    for f in layers.vfields ?? [] {
      drawProgram(vfieldFrag(f.fx, f.fy, params: f.params), f.color, f.params, f.uniforms)
    }
    for f in layers.tfields ?? [] where f.entries.count == 4 && (f.jacobian?.count ?? 4) == 4 {
      let frag =
        f.streamlines == true
        ? tlinesFrag(f.entries, params: f.params, jacobian: f.jacobian)
        : tfieldFrag(f.entries, params: f.params, jacobian: f.jacobian)
      drawProgram(frag, f.color, f.params, f.uniforms)
    }
    for c in layers.complexes ?? [] { drawField(c) { complexFrag($0, params: $1) } }
    for c in layers.curves ?? [] {
      drawProgram(curveFrag(c.field, params: c.params, graphEval: c.graphEval), c.color, c.params, c.uniforms)
    }
  }

  /// The value of the constant a uniform carries: `env[p]` for the param it is named after, 0 without one.
  private static func param(_ uniform: String, _ params: [String], _ env: [String: Double]) -> Double? {
    params.first { uniformName($0) == uniform }.map { env[$0] ?? 0 }
  }
}
