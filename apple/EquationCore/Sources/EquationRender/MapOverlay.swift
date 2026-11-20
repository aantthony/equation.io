import EquationCore
import Foundation

// Carrying a row's overlay geometry from x and y to a mapped panel's screen
// coordinates: web/render2d.ts `mapOverlay`, `mapPolylines`, `mappedSegment`
// and `planeOverlay`.
//
// The site keeps what it carried while the arrays and the map stay the same
// (WeakMaps keyed by the array: `mappedColumns`, `planeLineCache`,
// `planeClouds`, `planeRegions`). A Swift array has no identity to key by, so
// nothing is kept here: a caller that redraws a still picture keeps the
// carried overlay itself.

/// A straight segment is cut until each mapped piece strays from its chord
/// by under this fraction of the segment's mapped length (a straight run in
/// x and y is a curve on a log axis), into at most 2^depth pieces. A sampled
/// curve's short segments are already straight on screen, so most cost one
/// extra evaluation.
private let mappedBend = 0.0005
private let mappedDepth = 12

public typealias ScreenPoint = (Double, Double)

/// Carries a point to the screen; a plane map follows on from `hint`, the
/// screen point of a neighbour, so a line stays on one copy of the plane.
public typealias Carry = (_ x: Double, _ y: Double, _ hint: ScreenPoint?) -> ScreenPoint

/// Carries a straight run a → b (lib/plane-map.ts `Segment`; `mappedSegment` is one).
public typealias Segment = (
  _ a: ScreenPoint, _ b: ScreenPoint, _ map: Carry, _ from: ScreenPoint?
) -> (piece: [Double], end: ScreenPoint)

/// The indices a row added to a list `count` long since its mark.
private func tail(_ from: Int, _ count: Int) -> Range<Int> { min(from, count)..<count }

private func shown(_ p: ScreenPoint) -> Bool { p.0.isFinite && p.1.isFinite }

/// Mapped points of the straight segment a → b, a included, b not, and b
/// mapped, to follow the next segment on from. `from` is a's neighbour.
public func mappedSegment(
  _ a: ScreenPoint, _ b: ScreenPoint, _ map: Carry, _ from: ScreenPoint? = nil
) -> (piece: [Double], end: ScreenPoint) {
  var out: [Double] = []
  let pa = map(a.0, a.1, from.flatMap { shown($0) ? $0 : nil })
  let pb = map(b.0, b.1, shown(pa) ? pa : nil)
  let tol = mappedBend * hypot(pb.0 - pa.0, pb.1 - pa.1)
  func split(_ t0: Double, _ p0: ScreenPoint, _ t1: Double, _ p1: ScreenPoint, _ depth: Int) {
    let t = (t0 + t1) / 2
    let hint: ScreenPoint? =
      shown(p0) && shown(p1) ? ((p0.0 + p1.0) / 2, (p0.1 + p1.1) / 2) : shown(p0) ? p0 : shown(p1) ? p1 : nil
    let pm = map(a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t, hint)
    // Where the map stops (one end shown, one not) the piece is cut as far
    // as depth allows, so the line breaks close to the edge; a piece shown
    // at both ends is cut while it bends; one shown at neither is a gap.
    var cut: Bool
    if shown(p0) != shown(p1) {
      cut = true
    } else if !shown(p0) {
      cut = false
    } else {
      let (dx, dy) = (p1.0 - p0.0, p1.1 - p0.1)
      let length = hypot(dx, dy)
      let off = abs((pm.0 - p0.0) * dy - (pm.1 - p0.1) * dx) / (length == 0 ? 1 : length)
      // With an end past the map the segment has no mapped length: the
      // piece's own stands in, which shrinks as it is cut.
      cut = !shown(pm) || off > (tol.isFinite ? tol : 4 * mappedBend * length)
    }
    if depth < mappedDepth, cut {
      split(t0, p0, t, pm, depth + 1)
      split(t, pm, t1, p1, depth + 1)
    } else {
      out.append(p0.0)
      out.append(p0.1)
    }
  }
  split(0, pa, 1, pb, 0)
  return (out, pb)
}

/// The way back through a plane map over one screen window (lib/plane-map.ts
/// `PlaneInverse`, with `planeLines` and `planeShapes`), as `planeOverlay`
/// reads it. The map itself, and its numerical inverse, are not ported (they
/// need the language's evaluator and derivative): whoever ports them conforms
/// to this, and `mapOverlay` takes one where the site reads `maps.plane`.
public protocol PlaneInverse {
  /// Every screen point in or just around the window showing (x, y).
  func all(_ x: Double, _ y: Double) -> [ScreenPoint]
  /// One screen point showing (x, y): in the window if one is.
  func first(_ x: Double, _ y: Double) -> ScreenPoint
  /// A region's triangles, carried to the screen.
  func triangles(_ tris: [Double]) -> [Double]
  /// `planeLines`: a line on every copy of the plane the window shows.
  func lines(count: Int, vertex: (Int) -> ScreenPoint, closed: Bool, segment: Segment) -> [[Double]]
  /// `planeShapes`: a closed shape to fill, whole on each copy of the plane it shows on.
  func shapes(count: Int, vertex: (Int) -> ScreenPoint, segment: Segment) -> [PlaneShape]
}

/// A shape carried to the screen (lib/plane-map.ts `PlaneShape`): an outline
/// to fill, or not closed on the screen; a fill with no outline of its own
/// (`stroke` false) is drawn by another entry's outline.
public struct PlaneShape: Equatable, Sendable {
  public var pts: [Double]
  public var closed: Bool
  public var stroke: Bool?

  public init(pts: [Double], closed: Bool, stroke: Bool? = nil) {
    self.pts = pts
    self.closed = closed
    self.stroke = stroke
  }
}

/// Carry what a row added to the overlay since `mark` from x and y to a
/// mapped panel's screen coordinates (lib/axis-map.ts). Positions the map
/// cannot show (x ≤ 0 on a log axis) become NaN: points there are dropped,
/// and lines break there, as they do at any other gap. With `plane`, the row
/// goes through that plane map instead, and `maps` is not read.
public func mapOverlay(
  _ o: inout Overlay2D, mark: OverlayMark, maps: AxisMaps, plane: (any PlaneInverse)? = nil
) {
  if let plane {
    planeOverlay(&o, mark: mark, inverse: plane)
    return
  }
  let mx = { (v: Double) in maps.x.map { toScreen($0, v) } ?? v }
  let my = { (v: Double) in maps.y.map { toScreen($0, v) } ?? v }
  let kept = o.points[min(mark.points, o.points.count)...].compactMap { p -> Overlay2D.Point? in
    let (x, y) = (mx(p.x), my(p.y))
    guard x.isFinite, y.isFinite else { return nil }
    var q = p
    (q.x, q.y) = (x, y)
    return q
  }
  o.points.replaceSubrange(min(mark.points, o.points.count)..., with: kept)
  for k in tail(mark.clouds, o.clouds?.count ?? 0) {
    if maps.x != nil { o.clouds![k].xs = o.clouds![k].xs.map(mx) }
    if maps.y != nil { o.clouds![k].ys = o.clouds![k].ys.map(my) }
  }
  mapPolylines(&o, mark: mark) { x, y, _ in (mx(x), my(y)) }
  for k in tail(mark.regions, o.regions?.count ?? 0) {
    var tris = o.regions![k].tris
    var i = 0
    while i + 1 < tris.count {
      tris[i] = mx(tris[i])
      tris[i + 1] = my(tris[i + 1])
      i += 2
    }
    o.regions![k].tris = tris
  }
  for k in tail(mark.texts, o.texts?.count ?? 0) {
    o.texts![k].x = mx(o.texts![k].x)
    o.texts![k].y = my(o.texts![k].y)
  }
  // A bar keeps its edges, and stands on y = 0 where the map shows it; a log
  // axis does not, so there it rises from the window's edge, as y = 0 lies
  // past every value the axis shows.
  for k in tail(mark.bars, o.bars?.count ?? 0) {
    var b = o.bars![k]
    let (l, r) = (mx(b.x - b.halfWidth), mx(b.x + b.halfWidth))
    b.x = (l + r) / 2
    b.halfWidth = (r - l) / 2
    if let map = maps.y { b.base = toScreenOrEdge(map, b.base ?? 0) }
    b.y = my(b.y)
    o.bars![k] = b
  }
}

/// Carry each polyline added since `mark`, its straight runs cut where the
/// map bends them, each segment followed on from the last.
private func mapPolylines(_ o: inout Overlay2D, mark: OverlayMark, map: Carry) {
  for index in tail(mark.polylines, o.polylines.count) {
    let l = o.polylines[index]
    let pts = l.pts
    let n = pts.count / 2
    var out: [Double] = []
    let vertex = { (k: Int) -> ScreenPoint in (pts[(2 * k) % pts.count], pts[(2 * k + 1) % pts.count]) }
    var last: ScreenPoint?
    for k in 0..<max(l.closed == true ? n : n - 1, 0) {
      let (piece, end) = mappedSegment(vertex(k), vertex(k + 1), map, last)
      out += piece
      last = end
    }
    // The last vertex, unless closing back to the first draws it.
    if l.closed != true, n > 0 {
      let v = vertex(n - 1)
      let end = n > 1 ? last ?? map(v.0, v.1, nil) : map(v.0, v.1, nil)
      out += [end.0, end.1]
    }
    o.polylines[index].pts = out
  }
}

/// mapOverlay through a plane map (lib/plane-map.ts), whose way back is found
/// numerically. A point is drawn wherever the screen shows it (twice, on an
/// angle range wider than 2π); a line, a region's triangle and a cloud's dot
/// at one place, a line followed along from its start and cut where it
/// cannot be (the seam of an angle).
private func planeOverlay(_ o: inout Overlay2D, mark: OverlayMark, inverse: any PlaneInverse) {
  let kept = o.points[min(mark.points, o.points.count)...].flatMap { p in
    inverse.all(p.x, p.y).map { at -> Overlay2D.Point in
      var q = p
      (q.x, q.y) = at
      return q
    }
  }
  o.points.replaceSubrange(min(mark.points, o.points.count)..., with: kept)
  for k in tail(mark.clouds, o.clouds?.count ?? 0) {
    let cloud = o.clouds![k]
    let carried = zip(cloud.xs, cloud.ys).map { inverse.first($0, $1) }
    o.clouds![k].xs = carried.map(\.0)
    o.clouds![k].ys = carried.map(\.1)
  }
  for index in tail(mark.polylines, o.polylines.count) {
    let l = o.polylines[index]
    let pts = l.pts
    let vertex = { (k: Int) -> ScreenPoint in (pts[2 * k], pts[2 * k + 1]) }
    let closed = l.closed == true
    let fill = l.fill != nil && closed
    // A shape to fill stays one shape, on each copy of the plane it shows on.
    // A line on each copy the window shows.
    let shapes =
      fill
      ? inverse.shapes(count: pts.count / 2, vertex: vertex, segment: mappedSegment)
      : inverse.lines(count: pts.count / 2, vertex: vertex, closed: closed, segment: mappedSegment).map {
        // Cut into pieces, it no longer closes on itself.
        PlaneShape(pts: $0, closed: closed && $0.allSatisfy(\.isFinite))
      }
    let carried = shapes.map { shape -> Overlay2D.Polyline in
      var line = l
      line.pts = shape.pts
      if !fill {
        line.closed = shape.closed
      } else if !shape.closed {
        line.closed = false
        line.fill = nil
      } else if shape.stroke == false {
        line.noStroke = true
      }
      return line
    }
    if let first = carried.first {
      o.polylines[index] = first
    } else {
      o.polylines[index].pts = []
    }
    o.polylines += carried.dropFirst()
  }
  for k in tail(mark.regions, o.regions?.count ?? 0) { o.regions![k].tris = inverse.triangles(o.regions![k].tris) }
  for k in tail(mark.texts, o.texts?.count ?? 0) {
    (o.texts![k].x, o.texts![k].y) = inverse.first(o.texts![k].x, o.texts![k].y)
  }
}
