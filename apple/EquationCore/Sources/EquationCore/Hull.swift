/// Convex hulls of evaluated points — the numeric half of `hull(…)`
/// (lib/hull.ts).
///
/// The vertices are ordinary expressions (they may move with sliders or t),
/// so which of them are extreme is only known once they have values: every
/// renderer evaluates the points, then asks here for the figure to draw. The
/// answer is a list of faces — one in the plane, the polygon itself; in space
/// the facets of the solid, with coplanar triangles merged so a cube has six
/// square faces rather than twelve triangles with a diagonal each.

/// One flat face: its outline in order (not repeated at the end), x, y, z
/// per vertex, and the triangles that fill it, as indices into the outline.
public struct HullFace: Equatable, Sendable {
  public var outline: [[Double]]
  public var triangles: [[Int]]
}

private typealias P3 = [Double]

private func sub(_ a: P3, _ b: P3) -> P3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
private func cross(_ a: P3, _ b: P3) -> P3 {
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
private func dot(_ a: P3, _ b: P3) -> Double { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
private func norm(_ a: P3) -> Double { jsHypot(a) }

/// Andrew's monotone chain: the hull counterclockwise, collinear points dropped.
public func hull2(_ points: [[Double]]) -> [[Double]] {
  let sorted = points.sorted { a, b in a[0] != b[0] ? a[0] < b[0] : a[1] < b[1] }
  var pts: [[Double]] = []
  for p in sorted where pts.last.map({ p[0] != $0[0] || p[1] != $0[1] }) ?? true { pts.append(p) }
  if pts.count < 3 { return pts }
  func turn(_ o: [Double], _ a: [Double], _ b: [Double]) -> Double {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  }
  func half(_ from: [[Double]]) -> [[Double]] {
    var out: [[Double]] = []
    for p in from {
      while out.count >= 2 && turn(out[out.count - 2], out[out.count - 1], p) <= 0 { out.removeLast() }
      out.append(p)
    }
    out.removeLast()
    return out
  }
  return half(pts) + half(pts.reversed())
}

private func fan(_ n: Int) -> [[Int]] {
  n < 3 ? [] : (0..<(n - 2)).map { [0, $0 + 1, $0 + 2] }
}

/// The hull of points that all lie in one plane (or on a line, or at a point).
private func flatHull(_ pts: [P3], _ origin: P3, _ normal: P3?, _ along: P3?) -> [HullFace] {
  guard let along else { return [HullFace(outline: [origin], triangles: [])] }
  let alongLength = norm(along)
  let u = along.map { $0 / alongLength }
  guard let normal else {
    // Collinear: the segment between the extremes.
    let ts = pts.map { dot(sub($0, origin), u) }
    let lo = ts.firstIndex(of: JS.min(ts)) ?? 0
    let hi = ts.firstIndex(of: JS.max(ts)) ?? 0
    return [HullFace(outline: [pts[lo], pts[hi]], triangles: [])]
  }
  let w = cross(normal, u)
  let wLength = norm(w)
  let v = w.map { $0 / wLength }
  let outline = hull2(pts.map { [dot(sub($0, origin), u), dot(sub($0, origin), v)] }).map { p -> P3 in
    [
      origin[0] + p[0] * u[0] + p[1] * v[0],
      origin[1] + p[0] * u[1] + p[1] * v[1],
      origin[2] + p[0] * u[2] + p[1] * v[2],
    ]
  }
  return [HullFace(outline: outline, triangles: fan(outline.count))]
}

/// The convex hull of points in space, as merged flat faces wound outward.
public func hull3(_ points: [[Double]]) -> [HullFace] {
  var pts: [P3] = []
  for p in points where !pts.contains(p) { pts.append(p) }
  guard let a = pts.first else { return [] }
  let size = JS.max((0..<3).map { k in JS.max(pts.map { $0[k] }) - JS.min(pts.map { $0[k] }) })
  let eps = 1e-9 * (size == 0 || size.isNaN ? 1 : size)

  // A first tetrahedron: two distinct points, a third off their line, a
  // fourth off their plane. Short of that the figure is flat.
  guard let b = pts.first(where: { norm(sub($0, a)) > eps }) else { return flatHull(pts, a, nil, nil) }
  let ab = sub(b, a)
  guard let c = pts.first(where: { norm(cross(ab, sub($0, a))) > eps * norm(ab) }) else {
    return flatHull(pts, a, nil, ab)
  }
  let n0 = cross(ab, sub(c, a))
  guard let d = pts.first(where: { abs(dot(n0, sub($0, a))) > eps * norm(n0) }) else {
    return flatHull(pts, a, n0, ab)
  }

  // Triangles as index triples, wound so their normals point away from a
  // point known to be inside.
  let inside: P3 = (0..<3).map { (a[$0] + b[$0] + c[$0] + d[$0]) / 4 }
  func normalOf(_ t: [Int]) -> P3 { cross(sub(pts[t[1]], pts[t[0]]), sub(pts[t[2]], pts[t[0]])) }
  func outward(_ t: [Int]) -> [Int] {
    dot(normalOf(t), sub(inside, pts[t[0]])) > 0 ? [t[0], t[2], t[1]] : t
  }
  let (ia, ib, ic, id) = (0, pts.firstIndex(of: b)!, pts.firstIndex(of: c)!, pts.firstIndex(of: d)!)
  var faces: [[Int]] = [[ia, ib, ic], [ia, ib, id], [ia, ic, id], [ib, ic, id]].map(outward)

  /// A directed edge, as a key.
  struct Edge: Hashable {
    var from: Int
    var to: Int
  }
  for k in pts.indices where k != ia && k != ib && k != ic && k != id {
    let sees = faces.map { t -> Bool in
      let n = normalOf(t)
      return dot(n, sub(pts[k], pts[t[0]])) > eps * norm(n)
    }
    if !sees.contains(true) { continue }
    // The horizon: edges of a visible face whose other side stays hidden.
    var hiddenEdges: Set<Edge> = []
    for (f, t) in faces.enumerated() where !sees[f] {
      for e in 0..<3 { hiddenEdges.insert(Edge(from: t[e], to: t[(e + 1) % 3])) }
    }
    var next = faces.enumerated().filter { !sees[$0.offset] }.map(\.element)
    for (f, t) in faces.enumerated() where sees[f] {
      for e in 0..<3 {
        let (from, to) = (t[e], t[(e + 1) % 3])
        if hiddenEdges.contains(Edge(from: to, to: from)) { next.append([from, to, k]) }
      }
    }
    faces = next
  }

  // Merge coplanar neighbours: group triangles by plane, walk each group's
  // boundary (edges no other triangle of the group shares) into an outline.
  func unit(_ t: [Int]) -> P3 {
    let n = normalOf(t)
    let len = norm(n)
    return [n[0] / len, n[1] / len, n[2] / len]
  }
  var groups: [(n: P3, tris: [[Int]])] = []
  for t in faces {
    let n = unit(t)
    let scale = size == 0 || size.isNaN ? 1 : size
    if let home = groups.firstIndex(where: { g in
      dot(g.n, n) > 1 - 1e-9 && abs(dot(g.n, sub(pts[t[0]], pts[g.tris[0][0]]))) <= 1e-7 * scale
    }) {
      groups[home].tris.append(t)
    } else {
      groups.append((n, [t]))
    }
  }
  return groups.map { group -> HullFace in
    let tris = group.tris
    // (In the order the edges were first set, as a JavaScript Map keeps them.)
    var edges: [Int: Int] = [:]
    var order: [Int] = []
    var all: Set<Edge> = []
    for t in tris {
      for e in 0..<3 { all.insert(Edge(from: t[e], to: t[(e + 1) % 3])) }
    }
    for t in tris {
      for e in 0..<3 {
        let (from, to) = (t[e], t[(e + 1) % 3])
        if !all.contains(Edge(from: to, to: from)) {
          if edges.updateValue(to, forKey: from) == nil { order.append(from) }
        }
      }
    }
    var loop: [Int] = []
    let start = order[0]
    var at: Int? = start
    var guardCount = 0
    while guardCount <= edges.count, let here = at {
      loop.append(here)
      at = edges[here]
      if at == start { break }
      guardCount += 1
    }
    // A convex face: drop the vertices that only split a straight edge, then fan.
    let corners = loop.enumerated().filter { i, v in
      let prev = pts[loop[(i + loop.count - 1) % loop.count]]
      let nextP = pts[loop[(i + 1) % loop.count]]
      return norm(cross(sub(pts[v], prev), sub(nextP, pts[v]))) > eps * eps
    }.map(\.element)
    let outline = (corners.count >= 3 ? corners : loop).map { pts[$0] }
    return HullFace(outline: outline, triangles: fan(outline.count))
  }
}

/// The faces `hull(…)` draws for a flat vertex list of the given dimension.
public func hullFaces(_ values: [Double], dim: Int) -> [HullFace] {
  if dim == 2 {
    var pts: [[Double]] = []
    var k = 0
    while k + 1 < values.count {
      pts.append([values[k], values[k + 1]])
      k += 2
    }
    let outline = hull2(pts).map { [$0[0], $0[1], 0] }
    return [HullFace(outline: outline, triangles: fan(outline.count))]
  }
  var pts: [[Double]] = []
  var k = 0
  while k + 2 < values.count {
    pts.append([values[k], values[k + 1], values[k + 2]])
    k += 3
  }
  return hull3(pts)
}

/// The faces as one flat-shaded mesh (lib/hull.ts `hullMesh`): every face
/// gets its own copies of its corners, so each carries that face's normal and
/// the facets stay crisp rather than being smoothed into a ball. UVs are
/// constant — the lit-mesh material paints its checker from them, and a solid
/// has none.
public struct HullMesh: Equatable, Sendable {
  public var positions: [Float]
  public var normals: [Float]
  public var uvs: [Float]
  public var indices: [UInt32]
}

public func hullMesh(_ faces: [HullFace]) -> HullMesh {
  var positions: [Float] = []
  var normals: [Float] = []
  var indices: [UInt32] = []
  for face in faces where !face.triangles.isEmpty {
    let outline = face.outline
    let n = cross(sub(outline[1], outline[0]), sub(outline[2], outline[0]))
    let length = norm(n)
    let len = length == 0 || length.isNaN ? 1 : length
    let base = positions.count / 3
    for p in outline {
      positions += p.map { Float($0) }
      normals += [Float(n[0] / len), Float(n[1] / len), Float(n[2] / len)]
    }
    for tri in face.triangles { indices += tri.map { UInt32(base + $0) } }
  }
  return HullMesh(
    positions: positions, normals: normals, uvs: Array(repeating: 0, count: positions.count / 3 * 2), indices: indices)
}

/// A hull's drawing buffers for the coordinates it has now (lib/hull-geometry.ts
/// `hullGeometrySampler`, without its cache: a caller keeps the last
/// coordinates if it wants one): the mesh, and the closed face outlines
/// packed as independent line pairs. Nil while a coordinate is not finite.
public func hullGeometry(_ coordinates: [Double], dim: Int) -> (mesh: HullMesh, edges: [Float])? {
  guard coordinates.allSatisfy(\.isFinite) else { return nil }
  let faces = hullFaces(coordinates, dim: dim)
  var edges: [Float] = []
  for face in faces {
    let outline = face.outline
    for i in outline.indices {
      edges += outline[i].map { Float($0) }
      edges += outline[(i + 1) % outline.count].map { Float($0) }
    }
  }
  return (hullMesh(faces), edges)
}
