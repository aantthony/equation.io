/// What classify and the compiler make of the nodes geometry lowering
/// writes (lib/plot.ts `classifyLowered`, lib/compiler.ts `compileCpu`): a
/// `figure` is a CPU-drawn polygon plan, a `label` text at a point.

/// Points a 3D hull accepts (lib/hull.ts `HULL_3D_MAX`): the incremental
/// build is quadratic in the worst case.
public let HULL_3D_MAX = 2000

/// How a figure's vertices are named in an error, after the statement the
/// user wrote (lib/plot.ts `FIGURES`).
private func figureVertices(_ form: FigureForm) -> String {
  switch form {
  case .segment: "Segment endpoints"
  case .polyline: "Polyline vertices"
  case .vector: "Vector endpoints"
  case .polygon: "Polygon vertices"
  case .square: "Square vertices"
  case .hull: "Hull points"
  }
}

/// The first whole-row node (a figure, a label, a trail, …) at any position
/// other than the root itself (lib/plot.ts `nestedSpecial`, for the kinds
/// lowering writes).
func nestedFigure(_ e: Expr, isRoot: Bool = true) -> String? {
  if !isRoot {
    switch e {
    case .trail: return "trail"
    case .label: return "label"
    case .figure(let form, _, _, _): return form.rawValue
    case .hist: return "hist"
    case .family: return "family"
    default: break
    }
  }
  for child in childrenOf(e) {
    if let found = nestedFigure(child, isRoot: false) { return found }
  }
  return nil
}

/// A lowered row that is a label or a figure, as the object it is and
/// whether it draws in space; nil for any other row.
func classifyFigure(
  _ expr: Expr, hasSpace: Bool, hasParam: Bool, complex: Bool
) throws -> (object: MathObject, needs3D: Bool)? {
  switch expr {
  case .label(let coordinates, let text):
    if hasSpace || hasParam || complex {
      throw LanguageError(
        "label needs a real point using constants, points, sliders, and t: label((1, 2), \"peak\").")
    }
    return (.label(coordinates: coordinates, text: text), coordinates.count == 3)
  case .figure(let form, let dimension, let vertices, let over):
    // Desugared segment()/polyline()/vector()/polygon()/square(): evaluated
    // on the CPU each frame with the constants' own names, like points.
    if hasSpace || hasParam {
      throw LanguageError("\(figureVertices(form)) must be constant — they cannot use x, y, u, or v.")
    }
    let count = over.map { $0[0].values.count } ?? vertices.count / dimension
    if form == .hull && dimension == 3 && count > HULL_3D_MAX {
      throw LanguageError("A 3D hull takes at most \(HULL_3D_MAX) points (got \(count)).")
    }
    return (.figure(form: form, dimension: dimension, vertices: vertices, over: over), dimension == 3)
  default:
    return nil
  }
}

/// The CPU plan of a figure (lib/compiler.ts `compileCpu`, case 'figure').
func compileFigure(form: FigureForm, dimension: Int, vertices: [Expr], over: [Column]?) -> CpuPlan {
  .polygon(
    dim: dimension, pts: vertices, closed: form == .polygon || form == .square || form == .hull,
    arrow: form == .vector, hull: form == .hull, over: over)
}

// MARK: - A figure's coordinates (lib/figure-vertices.ts)

/// The coordinates a figure plan draws, flat: `dim` numbers per vertex
/// (lib/figure-vertices.ts `vertexSampler`). A plan either lists its
/// vertices' coordinates outright, or — packed, with `over` — holds one
/// vertex template run once per element of its columns. `env` holds the
/// constants and t. (The site compiles the coordinates for its VM; here
/// they are evaluated as they stand, to the same numbers.)
public func figureCoordinates(_ pts: [Expr], over: [Column]?, _ env: [String: Double]) throws -> [Double] {
  guard let over else { return try pts.map { try evaluate($0, env) } }
  let n = over.first?.values.count ?? 0
  var scope = env
  var out: [Double] = []
  out.reserveCapacity(n * pts.count)
  for k in 0..<n {
    for column in over { scope[column.name] = k < column.values.count ? column.values[k] : .nan }
    for p in pts { out.append(try evaluate(p, scope)) }
  }
  return out
}

/// Whether a closed polygon in space (x, y, z per vertex, not repeating the
/// first) fills correctly as a triangle fan from its first vertex: planar,
/// and every fan triangle turning the same way about the polygon's normal
/// (lib/figure-vertices.ts `fanFillable`).
public func fanFillable(_ pts: [Double]) -> Bool {
  let n = pts.count / 3
  if n < 3 { return false }
  func at(_ k: Int, _ i: Int) -> Double { pts[k * 3 + i] }
  // Newell's normal, robust for any simple polygon.
  var (nx, ny, nz, extent) = (0.0, 0.0, 0.0, 0.0)
  for k in 0..<n {
    let j = (k + 1) % n
    nx += (at(k, 1) - at(j, 1)) * (at(k, 2) + at(j, 2))
    ny += (at(k, 2) - at(j, 2)) * (at(k, 0) + at(j, 0))
    nz += (at(k, 0) - at(j, 0)) * (at(k, 1) + at(j, 1))
    for i in 0..<3 { extent = JS.max([extent, abs(at(k, i) - at(0, i))]) }
  }
  let len = jsHypot([nx, ny, nz])
  if !(len > 0) || !(extent > 0) { return false }
  nx /= len
  ny /= len
  nz /= len
  let tol = 1e-6 * extent
  for k in 1..<n {
    let (dx, dy, dz) = (at(k, 0) - at(0, 0), at(k, 1) - at(0, 1), at(k, 2) - at(0, 2))
    if abs(dx * nx + dy * ny + dz * nz) > 1e-4 * extent { return false }  // not planar
    if k + 1 < n {
      let (ex, ey, ez) = (at(k + 1, 0) - at(0, 0), at(k + 1, 1) - at(0, 1), at(k + 1, 2) - at(0, 2))
      let turn = (dy * ez - dz * ey) * nx + (dz * ex - dx * ez) * ny + (dx * ey - dy * ex) * nz
      if turn < -tol * extent { return false }
    }
  }
  return true
}
