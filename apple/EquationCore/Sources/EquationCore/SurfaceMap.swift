/// Surface maps (lib/surface-map.ts): a panel whose 2D rows are printed onto
/// a surface in space, `on((X, Y, Z) = (cos(y) cos(x), cos(y) sin(x),
/// sin(y)), x = -pi..pi, y = -pi/2..pi/2)` — the sphere, with x as longitude
/// and y as latitude.
///
/// The panel is 3D. X, Y and Z are the scene's coordinates; x and y are the
/// coordinates the panel's rows are written in, which the surface carries
/// into space over the ranges given. What is drawn per pixel in 2D (curves,
/// regions, fields) is painted on the surface per pixel the same way: its
/// shader reads x and y at each fragment. What places things (points,
/// parametric curves, figures, labels) is carried point by point
/// (`surfacePoint`), and a vector field as arrows along the surface's
/// tangents (`surfaceArrows`).
///
/// Not ported: a surface written with a Σ or Π (`expandMapSums`), and
/// geodesics on the panel's surface and its curvature `gaussian(x, y)`.

public struct SurfaceMap: Equatable, Sendable {
  /// The right side as the row wrote it, for writing the row back.
  public var text: String
  /// X, Y and Z in terms of x and y.
  public var embed: [Expr]
  /// The ranges of x and y the surface is drawn over.
  public var x: [Double]
  public var y: [Double]

  public init(text: String, embed: [Expr], x: [Double], y: [Double]) {
    self.text = text
    self.embed = embed
    self.x = x
    self.y = y
  }
}

private let surfaceUsage =
  "Expected on((X, Y, Z) = (cos(y) cos(x), cos(y) sin(x), sin(y)), x = lo..hi, y = lo..hi): the surface the "
  + "panel’s rows are drawn on."

/// Parse the right side of `(X, Y, Z) = (…)` in an on(…) row, with the
/// ranges of x and y (`parseSurfaceMap`). Sliders are read at their value,
/// as a view map reads them, so moving one reanalyses. `documentNames` are
/// the names the document defines, which a bare function name may be one of.
func parseSurfaceMap(
  _ src: String, x: [Double], y: [Double], env: [String: Double] = [:], documentNames: Set<String> = [],
  valueNames: Set<String> = []
) throws -> SurfaceMap {
  var doc = MapDoc()
  (doc.documentNames, doc.valueNames) = (documentNames, valueNames)
  return try parseSurfaceMap(src, x: x, y: y, env: env, doc: doc)
}

func parseSurfaceMap(
  _ src: String, x: [Double], y: [Double], env: [String: Double], doc: MapDoc
) throws -> SurfaceMap {
  guard let parsed = try? parseExpr(src, valueNames: doc.valueNames), case .vec(let written) = parsed,
    written.count == 3
  else {
    throw LanguageError(surfaceUsage)
  }
  // Its sums written out term by term (MapSums.swift).
  let items = try written.map { try expandMapSums($0, ["x", "y"], env, doc) }
  var values: [String: Expr] = [:]
  var uses = false
  for name in freeVars(.vec(items)).list {
    if name == "x" || name == "y" {
      uses = true
    } else if name != "pi" && name != "e" {
      guard let v = env[name], v.isFinite else {
        throw LanguageError(
          "The surface is written in x, y, numbers and sliders; \(name) has no fixed value here "
            + "(not defined, or it changes with t).")
      }
      values[name] = .num(v)
    }
  }
  if !uses { throw LanguageError(surfaceUsage) }
  let map = SurfaceMap(text: jsTrimmed(src), embed: items.map { substVars($0, values) }, x: x, y: y)
  // The surface and what is painted on it are drawn on the GPU.
  for e in map.embed {
    do {
      _ = try toGLSL(e)
    } catch {
      throw LanguageError("The surface cannot be drawn: \(error.message)")
    }
  }
  if !spreads(map) {
    throw LanguageError("(X, Y, Z) = \(map.text) is no surface over these x and y: it is a curve or a point.")
  }
  return map
}

private func hypot3(_ a: [Double]) -> Double { (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).squareRoot() }

/// Whether some of the surface spreads over an area: its tangents along x
/// and y are apart somewhere (`spreads`).
private func spreads(_ map: SurfaceMap) -> Bool {
  let h = 1e-4
  for i in 1..<8 {
    for j in 1..<8 {
      let x = map.x[0] + ((map.x[1] - map.x[0]) * Double(i)) / 8
      let y = map.y[0] + ((map.y[1] - map.y[0]) * Double(j)) / 8
      let p = surfacePoint(map, x, y)
      let px = surfacePoint(map, x + h, y)
      let py = surfacePoint(map, x, y + h)
      let a = (0..<3).map { px[$0] - p[$0] }
      let b = (0..<3).map { py[$0] - p[$0] }
      let n = hypot3([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]])
      // Apart relative to their lengths, so a small surface counts.
      if n > 1e-9 * hypot3(a) * hypot3(b) { return true }
    }
  }
  return false
}

/// Expressions in x and y at a point; NaN where one has no value (`compileXY`).
private func atXY(_ exprs: [Expr], _ x: Double, _ y: Double) -> [Double] {
  let scope = ["x": x, "y": y]
  return exprs.map { (try? evaluate($0, scope)) ?? .nan }
}

/// The point in space the surface puts at (x, y) (`surfacePoint`).
public func surfacePoint(_ map: SurfaceMap, _ x: Double, _ y: Double) -> [Double] {
  atXY(map.embed, x, y)
}

/// A surface's tangents (`surfaceTangents`): how its point moves with x, and
/// with y. Exact where the surface differentiates, central differences
/// where not. Made once for a surface, and read at many points.
public struct SurfaceTangents: Sendable {
  let map: SurfaceMap
  let derivatives: [Expr]?

  public init(_ map: SurfaceMap) {
    self.map = map
    derivatives = try? map.embed.map { try diff($0, "x") } + map.embed.map { try diff($0, "y") }
  }

  public func at(_ x: Double, _ y: Double) -> (x: [Double], y: [Double]) {
    if let derivatives {
      let t = atXY(derivatives, x, y)
      return (Array(t[..<3]), Array(t[3...]))
    }
    let h = 1e-5 * max(1, abs(x), abs(y))
    func d(_ a: [Double], _ b: [Double]) -> [Double] { (0..<3).map { (a[$0] - b[$0]) / (2 * h) } }
    return (
      d(surfacePoint(map, x + h, y), surfacePoint(map, x - h, y)),
      d(surfacePoint(map, x, y + h), surfacePoint(map, x, y - h))
    )
  }
}

/// Arrows along the longer side of the lattice a vector field is drawn at on
/// a surface (`SURFACE_ARROWS`).
public let surfaceArrowCount = 24

/// A vector field in x and y as arrows on the surface (`surfaceArrows`). At
/// (x, y) the field (u, v) is the tangent u ∂P/∂x + v ∂P/∂y of the surface P
/// there; each arrow is that tangent from P(x, y), at the centres of a
/// lattice whose cells are near square on the surface. An arrow is the image
/// of a 2D arrow filling most of its cell in x and y, so it shows the
/// field's direction and shrinks where the surface crowds the cells, toward
/// a sphere's poles. Tail and head of each, then a NaN point to part them.
public func surfaceArrows(
  _ map: SurfaceMap, field: (_ x: Double, _ y: Double) -> [Double], n: Int = surfaceArrowCount
) -> [Double] {
  let (x0, x1) = (map.x[0], map.x[1])
  let (y0, y1) = (map.y[0], map.y[1])
  let tangents = SurfaceTangents(map)
  // How far the surface runs along x and along y, on average.
  var along = 0.0
  var across = 0.0
  for i in 0..<8 {
    for j in 0..<8 {
      let t = tangents.at(x0 + ((x1 - x0) * (Double(i) + 0.5)) / 8, y0 + ((y1 - y0) * (Double(j) + 0.5)) / 8)
      let a = hypot3(t.x) * (x1 - x0)
      let b = hypot3(t.y) * (y1 - y0)
      if a.isFinite && b.isFinite { (along, across) = (along + a, across + b) }
    }
  }
  let long = max(along, across)
  if !(long > 0) { return [] }
  let nx = max(2, Int(JS.round((Double(n) * along) / long)))
  let ny = max(2, Int(JS.round((Double(n) * across) / long)))
  let dx = (x1 - x0) / Double(nx)
  let dy = (y1 - y0) / Double(ny)
  var out: [Double] = []
  for i in 0..<nx {
    for j in 0..<ny {
      let x = x0 + (Double(i) + 0.5) * dx
      let y = y0 + (Double(j) + 0.5) * dy
      let f = field(x, y)
      let (u, v) = (f[0], f[1])
      // 0.7 of the cell, measured in cells in the direction it points.
      let s = 0.7 / ((u / dx) * (u / dx) + (v / dy) * (v / dy)).squareRoot()
      if !s.isFinite { continue }
      let p = surfacePoint(map, x, y)
      let t = tangents.at(x, y)
      let head = (0..<3).map { p[$0] + s * (u * t.x[$0] + v * t.y[$0]) }
      if p.allSatisfy(\.isFinite) && head.allSatisfy(\.isFinite) { out += p + head + [.nan, .nan, .nan] }
    }
  }
  return out
}

/// A parametric region's (x, y) carried onto the surface, in the region's
/// own u and v: a mesh that lies on the surface wherever the region does
/// (`surfaceOver`).
public func surfaceOver(_ map: SurfaceMap, _ coordinates: [Expr]) -> [Expr] {
  map.embed.map { substVars($0, ["x": coordinates[0], "y": coordinates[1]]) }
}

/// A parametric region carried onto a surface: the GLSL of its mesh there,
/// in the region's u and v, its sliders read as uniforms (web/scene.ts
/// `surfaceRegionGLSL`).
public func surfaceRegionGLSL(_ map: SurfaceMap, _ comps: [Expr], params: [String]) throws
  -> (comps: [String], du: [String]?, dv: [String]?)
{
  try parametricGLSL(surfaceOver(map, comps), uniformSub(params))
}

/// The surface over the unit square, as a parametric surface's mesh is laid
/// out (u, v in 0..1): x and y swept over their ranges (`surfaceInUV`). `uv`
/// gives the same x and y, for a shader that paints rows written in them.
public func surfaceInUV(_ map: SurfaceMap) -> (comps: [Expr], uv: (x: Expr, y: Expr)) {
  func sweep(_ range: [Double], _ p: String) -> Expr {
    .bin(.add, .num(range[0]), .bin(.mul, .num(range[1] - range[0]), .var(p)))
  }
  let uv = (x: sweep(map.x, "u"), y: sweep(map.y, "v"))
  return (map.embed.map { substVars($0, ["x": uv.x, "y": uv.y]) }, uv)
}

/// The surface's mesh as the shaders take it, and its x and y in the mesh's
/// u and v (web/scene.ts `surfaceGLSL`).
public func surfaceGLSL(_ map: SurfaceMap) throws -> (comps: [String], du: [String]?, dv: [String]?, xy: [String]) {
  let (comps, uv) = surfaceInUV(map)
  let mesh = try parametricGLSL(comps, { $0 })
  return (mesh.comps, mesh.du, mesh.dv, [try glsl(uv.x), try glsl(uv.y)])
}

/// How a surface panel draws a 2D row (`SurfaceMapping`):
///
/// - `paint`: drawn per pixel from x and y in 2D (curves, regions, fields),
///   so painted on the surface per pixel;
/// - `carry`: it puts things at positions (points, parametric curves,
///   figures, point lists, labels), each carried onto the surface; a vector
///   field's arrows by the surface's tangents;
/// - `none`: nothing drawn (a value, a note);
/// - `refused`: the site says the panel cannot draw it.
///
/// A row in space (3D) draws as in any 3D panel, and is not asked.
public enum SurfaceMapping: Sendable {
  case paint, carry, none, refused
}

/// `surfaceMapping`, for the kinds the port draws on a surface: nil for one
/// it does not draw there yet (a trail, a complex point or path), which is
/// then not supported rather than drawn in the wrong place.
public func surfaceMapping(_ object: MathObject) -> SurfaceMapping? {
  switch object {
  case .value, .note, .tuple: return SurfaceMapping.none
  case .curveGraph, .curveImplicit, .region, .scalarField: return .paint
  case .regionParametric: return .carry
  case .curveParametric(let coordinates): return coordinates.count == 2 ? .carry : .refused
  case .vectorField(let components): return components.count == 2 ? .carry : .refused
  case .point(let coordinates): return coordinates.count == 2 ? .carry : .refused
  // (A complex number is the point (re, im), a complex path the curve it
  // traces, and a trail in x and y where its point has been.)
  case .complexPoint, .complexPath: return .carry
  case .trail(let coordinates): return coordinates.count == 2 ? .carry : .refused
  case .label: return .carry
  // geodesic(P, d): traced in x and y, on this surface.
  case .geodesic(let spec): return spec.dim == 2 ? .carry : .refused
  case .figure(_, let dimension, _, _): return dimension == 2 ? .carry : .refused
  case .list(.points(let dimension, _)), .list(.scatter(let dimension, _)): return dimension == 2 ? .carry : .refused
  case .family(let members, _):
    // A family draws as its members, each drawn as it is.
    let each = members.map { surfaceMapping($0.object) }
    if each.contains(where: { $0 == nil }) { return nil }
    if each.contains(where: { $0 == .refused }) { return .refused }
    return each.first ?? SurfaceMapping.none
  default: return .refused
  }
}

/// The most nodes a flow's component may have to be traced on the CPU
/// (lib/flow.ts `FLOW_NODE_LIMIT`).
let flowNodeLimit = 8192

/// A 2D row as a surface panel draws it (`onSurface`). A 2D vector field is
/// marked animated for its moving streaks; on a surface it is still arrows,
/// which move only with t. Its arrows are traced on the CPU, so a field too
/// large to trace is refused here rather than left undrawn.
func onSurface(_ cls: Classified) throws -> Classified {
  var out = cls
  if case .family(let members, let shared) = cls.object {
    let carried = try members.map(onSurface)
    if carried == members { return cls }
    out.object = .family(members: carried, shared: shared)
    out.animated = carried.contains(where: \.animated)
    return out
  }
  guard case .vectorField(let components) = cls.object, components.count == 2 else { return cls }
  if components.contains(where: { exceedsNodes($0, flowNodeLimit) }) {
    throw LanguageError("This field is too large to draw on a surface (\(flowNodeLimit) nodes per component).")
  }
  out.animated = components.contains { freeVars($0).contains("t") }
  return out
}

let offSurfaceMessage =
  "This panel draws its rows on a surface (its on(…) row), which takes curves, inequalities, scalar fields, "
  + "vector fields, points, parametric curves and regions, and figures in x and y — not this."

/// A classified 2D row as its surface panel draws it (lib/analysis.ts, where
/// a panel has a surface): refused where the site refuses it, and not
/// supported where the port does not draw it there yet.
func classifyOnSurface(_ cls: Classified) throws -> Classified {
  guard let how = surfaceMapping(cls.object) else { throw Unsupported("this kind of row on a surface") }
  if how == .refused { throw LanguageError(offSurfaceMessage) }
  return try onSurface(cls)
}

