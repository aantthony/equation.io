#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

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

/// A closed shape to fill, carried to the screen whole on each copy of the
/// plane it shows on: followed on from each place the screen shows its first
/// vertex, well off the screen (PlaneInverse.line, margin 1), so a shape
/// across the seam of an angle fills at both edges. One that does not close
/// on the screen (round a point the map folds at) is an outline only
/// (`planeShapes`).
public func planeShapes(
  _ inverse: PlaneInverse, _ count: Int, _ vertex: @escaping (Int) -> ScreenPoint, _ segment: Segment? = nil
) -> [PlaneShape] {
  var out: [PlaneShape] = []
  // Edges crossing the screen between far-off vertices have a point there.
  let (count, vertex) = inverse.through(count, vertex, true)
  // From a vertex the screen shows at points apart, not along a whole line
  // (the polar origin): the shape's outline is the same from any vertex.
  var from = 0
  func foldsAt(_ k: Int) -> Bool {
    let v = vertex(k)
    let s = inverse.first(v.0, v.1)
    return inverse.folds(s.0, s.1)
  }
  while from < count - 1 && foldsAt(from) { from += 1 }
  let offset = from
  let turned = { (k: Int) in vertex((k + offset) % count) }
  var opens: [(pts: [Double], start: ScreenPoint)] = []
  let first = turned(0)
  for start in inverse.all(first.0, first.1) {
    let pts = inverse.line(count, turned, true, 1, segment, start)
    var shows = false
    var i = 0
    while i + 1 < pts.count && !shows {
      shows = inverse.inside(pts[i], pts[i + 1])
      i += 2
    }
    // Round a point the map folds at (a square about the polar origin), the
    // outline does not come back to where it started: it is open on the
    // screen. Broken, it is no outline to fill either.
    let back =
      pts.count >= 2 ? inverse.follow(first.0, first.1, (pts[pts.count - 2], pts[pts.count - 1]), 1) : nil
    var closes = false
    if pts.allSatisfy(\.isFinite), let back {
      closes = abs(back.0 - start.0) + abs(back.1 - start.1) < 1e-6 * (1 + abs(start.0) + abs(start.1))
    }
    // An open one may fill the screen from off it (down to a fold in view).
    if closes {
      if shows { out.append(PlaneShape(pts: pts, closed: true)) }
    } else {
      opens.append((pts, start))
    }
  }
  if !opens.isEmpty {
    // Each branch filled once: one a whole number of turns from a branch
    // already filled is that branch again.
    var filled: [(start: ScreenPoint, turn: ScreenPoint?)] = []
    for open in opens {
      let again = filled.contains { entry in
        guard let turn = entry.turn else { return false }
        let (dx, dy) = (open.start.0 - entry.start.0, open.start.1 - entry.start.1)
        let k = JS.round((dx * turn.0 + dy * turn.1) / (turn.0 * turn.0 + turn.1 * turn.1))
        return abs(dx - k * turn.0) + abs(dy - k * turn.1) < 1e-6 * (1 + abs(open.start.0) + abs(open.start.1))
      }
      if again { continue }
      guard let fill = foldFills(inverse, count, turned, open.pts) else { continue }
      out += fill.shapes
      filled.append((open.start, fill.turn))
    }
    // Its outline drawn as a line, cut at the edges and picked up where it
    // comes back, on each copy the window shows.
    for pts in planeLines(inverse, count, turned, true, segment) { out.append(PlaneShape(pts: pts, closed: false)) }
  }
  // Nothing of it on the screen, but the screen inside it: filled edge to
  // edge, its outline (just past them) out of sight.
  let (lo, hi) = (inverse.box.lo, inverse.box.hi)
  if out.isEmpty && contains(count, vertex, inverse.world((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2)) {
    let (mx, my) = (0.01 * (hi[0] - lo[0]), 0.01 * (hi[1] - lo[1]))
    let (x0, y0, x1, y1) = (lo[0] - mx, lo[1] - my, hi[0] + mx, hi[1] + my)
    out.append(PlaneShape(pts: [x0, y0, x1, y0, x1, y1, x0, y1], closed: true))
  }
  return out
}

/// A shape round a point the map folds at, filled. Round the polar origin a
/// square unrolls into a curve across a full turn, from its start S to its
/// end E, the same point a turn on; what it encloses is the screen between
/// that curve and the line the origin is shown along. So: the trace `pts`,
/// then the fold point placed from E and from S, closed. When a turn on
/// (E − S) is a symmetry of the map — the screen shows the same plane there,
/// as polar does 2π along X — it is filled again a turn on either way while
/// the screen shows it; otherwise once (z², whose other half is another
/// branch, filled from its own start). Nil when the shape contains no
/// isolated fold point (the map folds along a curve there, or not at all) or
/// the trace broke: it stays an outline.
private func foldFills(
  _ inverse: PlaneInverse, _ count: Int, _ vertex: (Int) -> ScreenPoint, _ pts: [Double]
) -> (shapes: [PlaneShape], turn: ScreenPoint?)? {
  if !pts.allSatisfy(\.isFinite) || pts.count < 4 { return nil }
  let folds = inverse.foldPoints()
  // A fold along a curve shows up as points all along it: no point to fill round.
  if folds.count > 2 { return nil }
  // One fold point inside: round two, the trace's ends say nothing of either.
  let inside = folds.filter { contains(count, vertex, $0) }
  guard inside.count == 1, inverse.isolated(inside[0]) else { return nil }
  let fold = inside[0]
  let S = (pts[0], pts[1])
  let E = (pts[pts.count - 2], pts[pts.count - 1])
  // The trace ends one segment short of its start, a turn on: E is where
  // the start vertex is shown from there.
  let v0 = vertex(0)
  guard let end = inverse.follow(v0.0, v0.1, E, 1), let atE = inverse.follow(fold.0, fold.1, end, 1),
    let atS = inverse.follow(fold.0, fold.1, S, 1)
  else { return nil }
  let fill = pts + [end.0, end.1, atE.0, atE.1, atS.0, atS.1]
  let turn = (end.0 - S.0, end.1 - S.1)
  let (lo, hi) = (inverse.box.lo, inverse.box.hi)
  // A turn on, a way across the screen, and the same plane there.
  let across = hypot(turn.0, turn.1) > 0.05 * hypot(hi[0] - lo[0], hi[1] - lo[1])
  if !across || !inverse.symmetric(turn) { return ([PlaneShape(pts: fill, closed: true, stroke: false)], nil) }
  // (`turn[k] || Infinity`: a zero, or undefined, component spans no screen.)
  func span(_ t: Double) -> Double { t == 0 || t.isNaN ? .infinity : abs(t) }
  let turns = JS.min([40, JS.max([(hi[0] - lo[0]) / span(turn.0), (hi[1] - lo[1]) / span(turn.1)]).rounded(.up) + 1])
  var shapes: [PlaneShape] = []
  var k = -turns
  while k <= turns {
    var moved = fill
    for i in moved.indices { moved[i] += k * (i % 2 == 0 ? turn.0 : turn.1) }
    var shows = false
    var i = 0
    while i + 1 < moved.count && !shows {
      shows = inverse.inside(moved[i], moved[i + 1], 0.5)
      i += 2
    }
    if shows { shapes.append(PlaneShape(pts: moved, closed: true, stroke: false)) }
    k += 1
  }
  return (shapes, turn)
}

/// Whether polygon `vertex` contains point p (even–odd).
private func contains(_ count: Int, _ vertex: (Int) -> ScreenPoint, _ p: ScreenPoint) -> Bool {
  let (x, y) = p
  var inside = false
  var j = count - 1
  for i in 0..<max(count, 0) {
    let (a, b) = (vertex(i), vertex(j))
    if (a.1 > y) != (b.1 > y) && x < (b.0 - a.0) * (y - a.1) / (b.1 - a.1) + a.0 { inside.toggle() }
    j = i
  }
  return inside
}
