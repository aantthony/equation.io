/// Finding what the pointer is over on a surface map (lib/surface-pick.ts):
/// the ray from the eye through a pixel, met with the surface (x, y) ↦ P.
/// The surface is first cut into a coarse mesh, which the ray meets at a
/// triangle; Newton on P(x, y) = o + t d from there finds the surface
/// itself, as exact as the mesh is not.
///
/// Port: the site keeps each map's mesh by the map (a WeakMap); here a
/// `SurfacePicker` holds it, made once for a surface and asked for each ray.

public struct SurfaceHit: Equatable, Sendable {
  /// Where on the surface, in the x and y its rows are written in.
  public var x: Double
  public var y: Double
  /// How far along the ray, in lengths of its direction.
  public var t: Double
  /// The point in space.
  public var point: [Double]
}

/// Cells along each side of the mesh a ray is first met with.
private let MESH_N = 96

/// Slack at a triangle's edges, so a ray along a seam or through a corner
/// is not lost between the triangles either side.
private let EDGE = 1e-9

/// Whether (x, y) is within the ranges the surface is drawn over (to a
/// hair): past them it may repeat in space, but nothing is drawn there
/// (lib/surface-pick.ts `onSurface`).
public func withinSurface(_ map: SurfaceMap, _ x: Double, _ y: Double) -> Bool {
  let ex = 1e-9 * (map.x[1] - map.x[0])
  let ey = 1e-9 * (map.y[1] - map.y[0])
  return x >= map.x[0] - ex && x <= map.x[1] + ex && y >= map.y[0] - ey && y <= map.y[1] + ey
}

private func det3(_ a: [Double], _ b: [Double], _ c: [Double]) -> Double {
  a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1])
}
private func norm(_ a: [Double]) -> Double { (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).squareRoot() }

public struct SurfacePicker: Sendable {
  public let map: SurfaceMap
  /// The surface at the grid's (MESH_N + 1)² nodes, X, Y, Z each.
  private let pos: [Double]

  public init(_ map: SurfaceMap) {
    self.map = map
    let n = MESH_N + 1
    var pos = [Double](repeating: .nan, count: n * n * 3)
    for j in 0..<n {
      for i in 0..<n {
        let p = surfacePoint(map, SurfacePicker.gridX(map, Double(i)), SurfacePicker.gridY(map, Double(j)))
        for k in 0..<min(3, p.count) { pos[(j * n + i) * 3 + k] = p[k] }
      }
    }
    self.pos = pos
  }

  private static func gridX(_ map: SurfaceMap, _ i: Double) -> Double {
    map.x[0] + ((map.x[1] - map.x[0]) * i) / Double(MESH_N)
  }
  private static func gridY(_ map: SurfaceMap, _ j: Double) -> Double {
    map.y[0] + ((map.y[1] - map.y[0]) * j) / Double(MESH_N)
  }

  /// Where the ray o + t d (t > 0) first meets the surface, or nil where it
  /// misses. The nearest few triangles it crosses are each refined onto the
  /// surface, and the nearest of those wins: a coarse triangle can stand a
  /// little in front of the true surface behind another's hit (`raySurface`).
  public func hit(_ o: [Double], _ d: [Double]) -> SurfaceHit? {
    let n = MESH_N + 1
    var hits: [(t: Double, x: Double, y: Double)] = []
    func corner(_ i: Int, _ j: Int) -> Int { (j * n + i) * 3 }
    for j in 0..<MESH_N {
      for i in 0..<MESH_N {
        let a = corner(i, j)
        let b = corner(i + 1, j)
        let c = corner(i, j + 1)
        let e = corner(i + 1, j + 1)
        // Two triangles a b c and e c b; (s, r) their barycentric coordinates
        // along the cell's x and y.
        if let h = triangle(a, b, c, o, d) {
          hits.append((h.0, SurfacePicker.gridX(map, Double(i) + h.1), SurfacePicker.gridY(map, Double(j) + h.2)))
        }
        if let h = triangle(e, c, b, o, d) {
          hits.append(
            (h.0, SurfacePicker.gridX(map, Double(i + 1) - h.2), SurfacePicker.gridY(map, Double(j + 1) - h.1)))
        }
      }
    }
    if hits.isEmpty { return nil }
    var best: SurfaceHit?
    for h in stableSorted(hits, { $0.t < $1.t }).prefix(4) {
      let r =
        refine(o, d, h.x, h.y, h.t) ?? SurfaceHit(x: h.x, y: h.y, t: h.t, point: surfacePoint(map, h.x, h.y))
      if r.t > 0 && (best == nil || r.t < best!.t) { best = r }
    }
    return best
  }

  /// Möller–Trumbore: (t, along a→b, along a→c) where the ray crosses the
  /// triangle a b c, or nil.
  private func triangle(_ a: Int, _ b: Int, _ c: Int, _ o: [Double], _ d: [Double]) -> (Double, Double, Double)? {
    let (e1x, e1y, e1z) = (pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2])
    let (e2x, e2y, e2z) = (pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2])
    let (px, py, pz) = (d[1] * e2z - d[2] * e2y, d[2] * e2x - d[0] * e2z, d[0] * e2y - d[1] * e2x)
    let det = e1x * px + e1y * py + e1z * pz
    // Edge-on, or a corner where the surface is undefined (NaN fails it too).
    if !(abs(det) > 1e-300) { return nil }
    let (sx, sy, sz) = (o[0] - pos[a], o[1] - pos[a + 1], o[2] - pos[a + 2])
    let u = (sx * px + sy * py + sz * pz) / det
    if u < -EDGE || u > 1 + EDGE { return nil }
    let (qx, qy, qz) = (sy * e1z - sz * e1y, sz * e1x - sx * e1z, sx * e1y - sy * e1x)
    let v = (d[0] * qx + d[1] * qy + d[2] * qz) / det
    if v < -EDGE || u + v > 1 + EDGE { return nil }
    let t = (e2x * qx + e2y * qy + e2z * qz) / det
    return t > 0 ? (t, u, v) : nil
  }

  /// Newton on P(x, y) − o − t d = 0 from a mesh hit: three equations in x, y
  /// and t. Nil when it does not settle, or leaves the ranges the surface is
  /// drawn over (where the mesh's hit is the better answer).
  private func refine(_ o: [Double], _ d: [Double], _ x0: Double, _ y0: Double, _ t0: Double) -> SurfaceHit? {
    var (x, y, t) = (x0, y0, t0)
    let spanX = map.x[1] - map.x[0]
    let spanY = map.y[1] - map.y[0]
    let hx = 1e-6 * spanX
    let hy = 1e-6 * spanY
    for _ in 0..<20 {
      let p = surfacePoint(map, x, y)
      let px = surfacePoint(map, x + hx, y)
      let mx = surfacePoint(map, x - hx, y)
      let py = surfacePoint(map, x, y + hy)
      let my = surfacePoint(map, x, y - hy)
      let fx = (0..<3).map { (px[$0] - mx[$0]) / (2 * hx) }
      let fy = (0..<3).map { (py[$0] - my[$0]) / (2 * hy) }
      let g = (0..<3).map { p[$0] - o[$0] - t * d[$0] }
      // Solve [fx fy −d] (δx, δy, δt) = −g by Cramer's rule.
      let nd = [-d[0], -d[1], -d[2]]
      let det = det3(fx, fy, nd)
      if !det.isFinite || abs(det) < 1e-14 * norm(fx) * norm(fy) * norm(d) { return nil }
      let r = g.map { -$0 }
      let dx = det3(r, fy, nd) / det
      let dy = det3(fx, r, nd) / det
      let dt = det3(fx, fy, r) / det
      x += dx
      y += dy
      t += dt
      if !x.isFinite || !y.isFinite || !t.isFinite { return nil }
      if !withinSurface(map, x, y) { return nil }
      if abs(dx) < 1e-12 * spanX && abs(dy) < 1e-12 * spanY {
        x = JS.min([JS.max([x, map.x[0]]), map.x[1]])
        y = JS.min([JS.max([y, map.y[0]]), map.y[1]])
        return SurfaceHit(x: x, y: y, t: t, point: surfacePoint(map, x, y))
      }
    }
    return nil
  }
}

/// How much x and y change across a pixel at (x, y) on the surface, given
/// where a point in space lands on the screen (in pixels): each read from
/// how far the screen moves as it steps. For readouts to the pixel, and for
/// tracing a curve there in pixel units (`surfacePixel`).
public func surfacePixel(
  _ map: SurfaceMap, _ x: Double, _ y: Double, _ toScreen: ([Double]) -> (Double, Double)?
) -> (Double, Double) {
  let hx = 1e-5 * (map.x[1] - map.x[0])
  let hy = 1e-5 * (map.y[1] - map.y[0])
  let at = toScreen(surfacePoint(map, x, y))
  let ax = toScreen(surfacePoint(map, x + hx, y))
  let ay = toScreen(surfacePoint(map, x, y + hy))
  func per(_ h: Double, _ q: (Double, Double)?) -> Double {
    guard let at, let q else { return .nan }
    let moved = ((q.0 - at.0) * (q.0 - at.0) + (q.1 - at.1) * (q.1 - at.1)).squareRoot()
    return moved > 0 ? h / moved : .nan
  }
  return (per(hx, ax), per(hy, ay))
}
