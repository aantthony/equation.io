import Foundation
import simd

/// 3D rendering: web/render3d.ts. Every equation is the zero set of
/// F(x,y,z), rendered by raymarching a bounding box in a fragment shader —
/// sign-change detection along the ray, bisection refinement,
/// finite-difference normals, and gl_FragDepth from the hit point so
/// multiple surfaces intersect correctly.
///
/// 2D-only equations (no z) still work here: F(x,y) extrudes to a vertical
/// sheet, which is exactly its locus in R^3.
///
/// This file has the site's scene types, field for field, and what the
/// renderer works out on the CPU; the shaders are in Frag3D.swift and the
/// renderer in Renderer3D.swift. The types are Codable so a scene can be
/// written down (metal-shot draws one from JSON, a `Graph3D`).

public struct Camera3D: Equatable, Codable, Sendable {
  public var target: SIMD3<Double>
  public var radius: Double
  /// Azimuth around +Z.
  public var theta: Double
  /// Elevation from the XY plane.
  public var phi: Double

  /// The camera a graph opens with (web/main.ts `defaultCamera`).
  public init(
    target: SIMD3<Double> = .zero, radius: Double = 14, theta: Double = -.pi / 3, phi: Double = .pi / 5.5
  ) {
    self.target = target
    self.radius = radius
    self.theta = theta
    self.phi = phi
  }
}

public struct Surface3D: Equatable, Codable, Sendable {
  public var uniforms: [String: Double]?
  /// GLSL expression for F(x,y,z) in terms of floats x, y, z.
  public var field: String
  public var color: RGB
  /// User-defined constants the field references (as u_<name> uniforms).
  public var params: [String]?
  /// GLSL for ∇F; absent → central differences.
  public var grad: [String]?

  public init(
    uniforms: [String: Double]? = nil, field: String, color: RGB, params: [String]? = nil, grad: [String]? = nil
  ) {
    self.uniforms = uniforms
    self.field = field
    self.color = color
    self.params = params
    self.grad = grad
  }
}

/// Half-width of the axis-aligned box every 3D plot is clipped to.
public func cameraBoxR(_ cam: Camera3D) -> Double { cam.radius * 0.85 }

/// Radius of the ball around the target where a cloud is at full density;
/// it thins to nothing at twice that, still short of the camera (at
/// cam.radius), so the field near the lens never fogs the view. A ball, not
/// a box: soft and round, it shows no face or corner from any side.
public func volumeRadius(_ cam: Camera3D) -> Double { cam.radius * 0.25 }

public func cameraEye(_ cam: Camera3D) -> SIMD3<Double> {
  let cp = cos(cam.phi)
  return cam.target + cam.radius * SIMD3(cp * cos(cam.theta), cp * sin(cam.theta), sin(cam.phi))
}

/// The camera's vertical field of view.
let FOV = Double.pi / 4

public func cameraMatrices(_ cam: Camera3D, _ aspect: Double) -> (vp: Mat4, invVp: Mat4, eye: SIMD3<Double>) {
  let eye = cameraEye(cam)
  let view = lookAt([eye.x, eye.y, eye.z], [cam.target.x, cam.target.y, cam.target.z], [0, 0, 1])
  let proj = perspective(FOV, aspect, cam.radius * 0.01, cam.radius * 100)
  let vp = multiply(proj, view)
  // No camera with a radius is singular; one without draws nothing either way.
  return (vp, invert(vp) ?? vp, eye)
}

/// How far `p` is in front of the eye under `vp`: its clip w, the view depth.
public func viewDepth(_ vp: Mat4, _ p: SIMD3<Double>) -> Double {
  Double(vp[3]) * p.x + Double(vp[7]) * p.y + Double(vp[11]) * p.z + Double(vp[15])
}

/// How many points pointSpacing measures from.
private let SPACING_SAMPLES = 64

/// The typical distance from a point to its nearest neighbour in `pos` (xyz
/// triples): the median over up to SPACING_SAMPLES points spread through the
/// list, each against all the others. Infinity for fewer than two points.
public func pointSpacing(_ pos: ArraySlice<Float>) -> Double {
  let n = pos.count / 3
  if n < 2 { return .infinity }
  let samples = min(n, SPACING_SAMPLES)
  var nearest: [Float] = []
  pos.withUnsafeBufferPointer { pos in
    for s in 0..<samples {
      let i = (s * n / samples) * 3
      var best = Float.infinity
      for j in stride(from: 0, to: n * 3, by: 3) where j != i {
        let dx = pos[j] - pos[i]
        let dy = pos[j + 1] - pos[i + 1]
        let dz = pos[j + 2] - pos[i + 2]
        let d = dx * dx + dy * dy + dz * dz
        // A repeated point is not a neighbour: it would size the whole run to nothing.
        if d > 0, d < best { best = d }
      }
      nearest.append(best)
    }
  }
  nearest.sort()
  return Double(nearest[samples >> 1].squareRoot())
}

/// FNV-1a over the bits of some floats: what a cache of anything worked out
/// from them is keyed by.
func hashBits(_ floats: ArraySlice<Float>) -> UInt32 {
  var hash: UInt32 = 0x811c_9dc5
  for value in floats { hash = (hash ^ value.bitPattern) &* 0x0100_0193 }
  return hash
}

/// pointSpacing by the bits of the positions: the scene is rebuilt every
/// frame, but a cloud's points rarely move, and hashing them is a 64th of
/// measuring them.
final class SpacingCache {
  private var spacings: [String: Double] = [:]
  /// Oldest first.
  private var order: [String] = []

  func spacing(_ pos: ArraySlice<Float>) -> Double {
    let key = "\(pos.count):\(hashBits(pos))"
    if let spacing = spacings[key] { return spacing }
    if order.count >= 256 { spacings[order.removeFirst()] = nil }
    let spacing = pointSpacing(pos)
    spacings[key] = spacing
    order.append(key)
    return spacing
  }
}

/// Floats per point vertex (see POINT_VERT): position, colour, then world
/// diameter, fade start depth and fade span (0: no fade).
public let POINT_STRIDE = 9

/// The point dots as POINT_STRIDE vertices, farthest from the eye first, so
/// translucent dots blend over the ones behind them (see POINT_VERT).
///
/// Points form runs: consecutive points of one row (`group`) and colour. A
/// run of several is a cloud: its dots are POINT_SPACING of its spacing
/// across, between `minD` and `loneD`, and fade with depth from its own
/// nearest point over its depth range or `minSpan`, whichever is more. A lone
/// point is `loneD` across and never fades.
func pointVertices(
  _ vp: Mat4, _ points: [Scene3D.Point], loneD: Double, minD: Double, minSpan: Double, spacings: SpacingCache
) -> [Float] {
  let n = points.count
  var out = [Float](repeating: 0, count: n * POINT_STRIDE)
  let depth = points.map { viewDepth(vp, $0.pos) }
  let pos = points.flatMap { [Float($0.pos.x), Float($0.pos.y), Float($0.pos.z)] }
  var start = 0
  for k in 1..<(n + 1) {
    if k < n, points[k].group == points[start].group, points[k].color == points[start].color { continue }
    let cloud = k - start > 1
    let d = cloud ? min(loneD, max(minD, POINT_SPACING * spacings.spacing(pos[(start * 3)..<(k * 3)]))) : loneD
    var near = Double.infinity
    var far = -Double.infinity
    for i in start..<k where depth[i] > 0 {
      near = min(near, depth[i])
      far = max(far, depth[i])
    }
    let span = cloud && near <= far ? max(far - near, minSpan) : 0
    for i in start..<k {
      let o = i * POINT_STRIDE
      out.replaceSubrange(o..<(o + 3), with: pos[(i * 3)..<(i * 3 + 3)])
      out[o + 3] = points[i].color.x
      out[o + 4] = points[i].color.y
      out[o + 5] = points[i].color.z
      out[o + 6] = Float(d)
      out[o + 7] = Float(span != 0 ? near : 0)
      out[o + 8] = Float(span)
    }
    start = k
  }
  // Farthest first. Points behind the eye sort last; the GPU clips them.
  let key = depth.map { $0.isNaN ? 0 : $0 }
  let order = (0..<n).sorted { key[$0] > key[$1] }
  return order.flatMap { out[($0 * POINT_STRIDE)..<(($0 + 1) * POINT_STRIDE)] }
}

/// Where a world point lands in a w×h viewport under `vp`, or nil behind the camera.
public func projectToScreen(_ vp: Mat4, _ p: SIMD3<Double>, _ w: Double, _ h: Double) -> CGPoint? {
  let cx = Double(vp[0]) * p.x + Double(vp[4]) * p.y + Double(vp[8]) * p.z + Double(vp[12])
  let cy = Double(vp[1]) * p.x + Double(vp[5]) * p.y + Double(vp[9]) * p.z + Double(vp[13])
  let cw = viewDepth(vp, p)
  if !(cw > 0) { return nil }
  return CGPoint(x: ((cx / cw) * 0.5 + 0.5) * w, y: (0.5 - (cy / cw) * 0.5) * h)
}

/// A point's dot in framebuffer pixels at the camera's target distance, at
/// most: a dense cloud's dots are smaller (see POINT_VERT).
let POINT_PX = 14.0
/// A cloud's dots, as a fraction of the spacing between its points.
let POINT_SPACING = 0.5
/// The least a cloud's dots are at the target distance, in framebuffer
/// pixels, however close its points: two roots a hair apart, or a tight
/// cluster setting the spacing, would otherwise size every dot to nothing.
let POINT_CLOUD_MIN_PX = 3.0
/// The smallest and largest a dot is drawn, in framebuffer pixels. Below the
/// smallest a dot keeps that size and fades by the area it lost instead, so a
/// far cloud thins rather than shimmering on and off between pixels.
let POINT_MIN_PX = 2.0
let POINT_MAX_PX = 64.0
/// How far toward the eye a point's dot is depth-tested, in dot radii.
let POINT_LIFT = 4.0
/// What a cloud's dot fades to at the far end of its depth (see POINT_VERT).
let POINT_FAR_ALPHA = 0.25

/// A 2D row painted on a surface: the surface as a parametric surface's
/// GLSL in u and v, the GLSL of x and y in u and v, and the row.
public struct SurfacePaint: Equatable, Codable, Sendable {
  public var comps: [String]
  public var du: [String]?
  public var dv: [String]?
  public var xy: [String]
  public var paint: Paint
  public var color: RGB
  public var params: [String]?
  public var uniforms: [String: Double]?
  /// A mesh of its own over the surface (a parametric region's), coarser
  /// or finer than the surface's: raised off it so it is not lost under
  /// the surface's facets (psurfVert).
  public var lift: Bool?

  /// A curve F = 0, a region F < 0 (edges its constraints'), a field F.
  public struct Paint: Equatable, Codable, Sendable {
    public enum Kind: String, Codable, Sendable {
      case curve, region, scalar
    }
    public var kind: Kind
    public var field: String
    /// A region's.
    public var edges: [String]?
    /// A scalar's: `gain` multiplies F before it is shaded (0.6, as in 2D, without).
    public var gain: Double?

    public init(kind: Kind, field: String, edges: [String]? = nil, gain: Double? = nil) {
      self.kind = kind
      self.field = field
      self.edges = edges
      self.gain = gain
    }
  }

  public init(
    comps: [String], du: [String]? = nil, dv: [String]? = nil, xy: [String], paint: Paint, color: RGB,
    params: [String]? = nil, uniforms: [String: Double]? = nil, lift: Bool? = nil
  ) {
    self.comps = comps
    self.du = du
    self.dv = dv
    self.xy = xy
    self.paint = paint
    self.color = color
    self.params = params
    self.uniforms = uniforms
    self.lift = lift
  }
}

/// Everything drawable in a 3D frame (web/render3d.ts `Scene3D`). Where the
/// site has a Float32Array there is an array of floats; a NaN vertex lifts
/// the pen, as there.
public struct Scene3D: Equatable, Codable, Sendable {
  /// 2D rows painted on a panel's surface (lib/surface-map.ts).
  public var paints: [SurfacePaint]?
  public var implicits: [Surface3D]
  public var psurfaces: [PSurface]
  public var curves: [Curve]
  /// Disconnected segments (comb teeth, hull edges), drawn as vertex pairs.
  public var segments: [Segments]
  /// Indexed position+normal meshes (curve tubes, hull solids) with material UVs.
  public var tubes: [Tube]
  /// Dots. `group` is the row a point came from: consecutive points of one
  /// group (and colour) are a cloud, sized and faded together.
  public var points: [Point]
  /// Planes a x + b y + c z + d = 0, the GLSL of [a, b, c, d]: drawn
  /// translucent over everything opaque, outlined where they meet the box.
  public var planes: [Plane]?
  /// `label(point, "text")` rows: text only, no point sprite.
  public var texts: [Text]?
  /// Fields in space, drawn as clouds (see volumeFrag).
  public var volumes: [Volume]?
  /// 3D vector fields drawn as animated streamlines (see streamlineVert).
  public var streamlines: [Streamlines]?

  public struct PSurface: Equatable, Codable, Sendable {
    public var uniforms: [String: Double]?
    public var comps: [String]
    public var du: [String]?
    public var dv: [String]?
    public var color: RGB
    public var params: [String]?
    /// A scalar in u and v the surface is coloured by, and the gain that
    /// brings its typical size to about 1.
    public var paint: String?
    public var gain: Double?

    public init(
      uniforms: [String: Double]? = nil, comps: [String], du: [String]? = nil, dv: [String]? = nil, color: RGB,
      params: [String]? = nil, paint: String? = nil, gain: Double? = nil
    ) {
      self.uniforms = uniforms
      self.comps = comps
      self.du = du
      self.dv = dv
      self.color = color
      self.params = params
      self.paint = paint
      self.gain = gain
    }
  }

  public struct Curve: Equatable, Codable, Sendable {
    public var pts: [Float]
    public var color: RGB
    public var arrow: Bool?
    /// Closed, with its first vertex repeated last: fill it as a fan.
    public var fill: Bool?
    public var fade: Bool?

    public init(pts: [Float], color: RGB, arrow: Bool? = nil, fill: Bool? = nil, fade: Bool? = nil) {
      self.pts = pts
      self.color = color
      self.arrow = arrow
      self.fill = fill
      self.fade = fade
    }
  }

  public struct Segments: Equatable, Codable, Sendable {
    public var pts: [Float]
    public var color: RGB
    /// The array does not change from frame to frame and can keep its GPU buffer.
    public var retained: Bool?

    public init(pts: [Float], color: RGB, retained: Bool? = nil) {
      self.pts = pts
      self.color = color
      self.retained = retained
    }
  }

  public struct Tube: Equatable, Codable, Sendable {
    public var positions: [Float]
    public var normals: [Float]
    /// Per-vertex (arclength fraction, ring-angle fraction).
    public var uvs: [Float]
    public var indices: [UInt32]
    /// Checker cell counts along (length, circumference).
    public var cells: SIMD2<Float>
    public var color: RGB
    /// All four geometry arrays hold from frame to frame and can keep their GPU buffers.
    public var retained: Bool?

    public init(
      positions: [Float], normals: [Float], uvs: [Float], indices: [UInt32], cells: SIMD2<Float>, color: RGB,
      retained: Bool? = nil
    ) {
      self.positions = positions
      self.normals = normals
      self.uvs = uvs
      self.indices = indices
      self.cells = cells
      self.color = color
      self.retained = retained
    }
  }

  public struct Point: Equatable, Codable, Sendable {
    public var pos: SIMD3<Double>
    public var color: RGB
    public var label: String?
    /// The site keys a run by the row object; here, any number that tells rows apart.
    public var group: Int?

    public init(pos: SIMD3<Double>, color: RGB, label: String? = nil, group: Int? = nil) {
      self.pos = pos
      self.color = color
      self.label = label
      self.group = group
    }
  }

  public struct Plane: Equatable, Codable, Sendable {
    public var coeffs: [String]
    public var color: RGB
    public var params: [String]?
    public var uniforms: [String: Double]?

    public init(coeffs: [String], color: RGB, params: [String]? = nil, uniforms: [String: Double]? = nil) {
      self.coeffs = coeffs
      self.color = color
      self.params = params
      self.uniforms = uniforms
    }
  }

  public struct Text: Equatable, Codable, Sendable {
    public var pos: SIMD3<Double>
    public var text: String
    public var color: RGB

    public init(pos: SIMD3<Double>, text: String, color: RGB) {
      self.pos = pos
      self.text = text
      self.color = color
    }
  }

  public struct Volume: Equatable, Codable, Sendable {
    public var field: String
    /// The size of the field that draws densest. The site's is a function of
    /// the cloud's center and radius, sampling the field there
    /// (lib/volume.ts `fieldScale`); a scene's builder knows the camera, so
    /// here it is that function's value for it.
    public var scale: Double
    public var color: RGB
    public var params: [String]?
    public var uniforms: [String: Double]?

    public init(
      field: String, scale: Double, color: RGB, params: [String]? = nil, uniforms: [String: Double]? = nil
    ) {
      self.field = field
      self.scale = scale
      self.color = color
      self.params = params
      self.uniforms = uniforms
    }
  }

  public struct Streamlines: Equatable, Codable, Sendable {
    public var comps: [String]
    public var color: RGB
    public var params: [String]?
    public var uniforms: [String: Double]?

    public init(comps: [String], color: RGB, params: [String]? = nil, uniforms: [String: Double]? = nil) {
      self.comps = comps
      self.color = color
      self.params = params
      self.uniforms = uniforms
    }
  }

  public init(
    paints: [SurfacePaint]? = nil, implicits: [Surface3D] = [], psurfaces: [PSurface] = [], curves: [Curve] = [],
    segments: [Segments] = [], tubes: [Tube] = [], points: [Point] = [], planes: [Plane]? = nil,
    texts: [Text]? = nil, volumes: [Volume]? = nil, streamlines: [Streamlines]? = nil
  ) {
    self.paints = paints
    self.implicits = implicits
    self.psurfaces = psurfaces
    self.curves = curves
    self.segments = segments
    self.tubes = tubes
    self.points = points
    self.planes = planes
    self.texts = texts
    self.volumes = volumes
    self.streamlines = streamlines
  }

  /// A scene written down may leave out the layers it has nothing in.
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    paints = try c.decodeIfPresent([SurfacePaint].self, forKey: .paints)
    implicits = try c.decodeIfPresent([Surface3D].self, forKey: .implicits) ?? []
    psurfaces = try c.decodeIfPresent([PSurface].self, forKey: .psurfaces) ?? []
    curves = try c.decodeIfPresent([Curve].self, forKey: .curves) ?? []
    segments = try c.decodeIfPresent([Segments].self, forKey: .segments) ?? []
    tubes = try c.decodeIfPresent([Tube].self, forKey: .tubes) ?? []
    points = try c.decodeIfPresent([Point].self, forKey: .points) ?? []
    planes = try c.decodeIfPresent([Plane].self, forKey: .planes)
    texts = try c.decodeIfPresent([Text].self, forKey: .texts)
    volumes = try c.decodeIfPresent([Volume].self, forKey: .volumes)
    streamlines = try c.decodeIfPresent([Streamlines].self, forKey: .streamlines)
  }
}

/// The drawable runs of a 3D polyline, as (first vertex, vertex count): a
/// non-finite vertex (an undefined sample, a break at a jump) lifts the pen.
/// A line strip has no such notion, so the renderer draws one strip per
/// run. Lone points draw nothing. (lib/curve3d.ts)
public func finiteRuns(_ pts: [Float]) -> [(first: Int, count: Int)] {
  var runs: [(first: Int, count: Int)] = []
  let n = pts.count / 3
  var start = -1
  for i in 0...n {
    if i < n, pts[i * 3].isFinite, pts[i * 3 + 1].isFinite, pts[i * 3 + 2].isFinite {
      if start < 0 { start = i }
      continue
    }
    if start >= 0, i - start >= 2 { runs.append((start, i - start)) }
    start = -1
  }
  return runs
}

/// Sample k's offset within the pixel, in (−½, ½)²: the Halton (2, 3)
/// sequence, which covers the pixel evenly at every count.
func haltonJitter(_ k: Int) -> SIMD2<Float> {
  func halton(_ index: Int, _ base: Int) -> Double {
    var f = 1.0
    var r = 0.0
    var i = index
    while i > 0 {
      f /= Double(base)
      r += f * Double(i % base)
      i /= base
    }
    return r
  }
  return SIMD2(Float(halton(k, 2) - 0.5), Float(halton(k, 3) - 0.5))
}

/// The cells of a grid × grid block (grid a power of two) in ordered-dither
/// order, so each pass spreads its samples evenly over the block.
func ditherOrder(_ grid: Int) -> [(x: Int, y: Int)] {
  var cells: [(x: Int, y: Int, rank: Int)] = []
  let levels = grid.trailingZeroBitCount
  for y in 0..<grid {
    for x in 0..<grid {
      var rank = 0
      for i in 0..<levels {
        let quadrant = [0, 2, 3, 1][((y >> i) & 1) * 2 + ((x >> i) & 1)]
        rank += quadrant << (2 * (levels - 1 - i))
      }
      cells.append((x, y, rank))
    }
  }
  return cells.sorted { $0.rank < $1.rank }.map { ($0.x, $0.y) }
}
