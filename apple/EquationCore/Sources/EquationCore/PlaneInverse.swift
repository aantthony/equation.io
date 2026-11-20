#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

// The way back through a plane map (lib/plane-map.ts `PlaneInverse`): from
// (x, y) to the screen, found numerically. Levenberg–Marquardt from the
// nearest of a grid of samples over the window, or from the last point along
// a line. A map may show a point more than once (an angle range wider than
// 2π); a point is drawn at each, a line follows the copy it started on.

/// Seeds across the window and this far past each edge, as a share of it,
/// so a point just off the screen is still found.
private let MARGIN = 0.25
/// How far past the window a line is followed before it is cut, as a share
/// of it: just off the screen, so the cut is hidden, and no further, so a
/// line leaving across the seam of an angle is picked up where it comes
/// back (planeOverlay) rather than followed on out of sight.
public let FOLLOW_MARGIN = 0.02
private let SEEDS = 24
/// How many of the nearest seeds a fresh search starts from.
private let STARTS = 8
/// The window's seeds in this many blocks a side: a search also starts from
/// the best of each, so each part of the screen gets its own try at a copy.
private let BLOCKS = 5
/// Points tried along a long run between ends off the screen.
private let PROBES = 32
/// A region's triangles search for copies of the plane at one in this many
/// (PlaneInverse.triangles); the rest try the copies found.
private let SEARCH_EVERY = 16
/// Seeds move onto one turn of a window holding at least this many
/// (PlaneInverse.reseed).
private let RESEED = 16.0
/// How many searches a window remembers.
private let MEMO = 1 << 17

/// Carries a point to the screen; a plane map follows on from `hint`, the
/// screen point of a neighbour, so a line stays on one copy of the plane.
public typealias Carry = (_ x: Double, _ y: Double, _ hint: ScreenPoint?) -> ScreenPoint

/// Carries a straight run a → b (see PlaneInverse.line).
public typealias Segment = (
  _ a: ScreenPoint, _ b: ScreenPoint, _ map: Carry, _ from: ScreenPoint?
) -> (piece: [Double], end: ScreenPoint)

private func shown(_ p: ScreenPoint?) -> Bool {
  guard let p else { return false }
  return p.0.isFinite && p.1.isFinite
}

/// The site's default `Segment`: a run's ends only (a renderer cuts the run
/// where the map bends it).
private func endsOnly(_ a: ScreenPoint, _ b: ScreenPoint, _ map: Carry, _ from: ScreenPoint?) -> (
  piece: [Double], end: ScreenPoint
) {
  let pa = map(a.0, a.1, shown(from) ? from : nil)
  return ([pa.0, pa.1], map(b.0, b.1, shown(pa) ? pa : nil))
}

/// `Array.prototype.sort` keeps equal elements in order; Swift's sort need not.
private func stableSorted<T>(_ items: [T], by key: (T) -> Double) -> [T] {
  let keys = items.map(key)
  let order = items.indices.sorted { (a: Int, b: Int) -> Bool in
    keys[a] < keys[b] || (keys[a] == keys[b] && a < b)
  }
  return order.map { items[$0] }
}

/// A point as a key, as JavaScript's Map reads a number (0 and −0 the same).
private struct PointKey: Hashable {
  let x: UInt64
  let y: UInt64
  init(_ x: Double, _ y: Double) {
    self.x = (x == 0 ? 0 : x).bitPattern
    self.y = (y == 0 ? 0 : y).bitPattern
  }
}

/// `Math.imul`'s reading of a number: its low 32 bits.
private func int32(_ v: Double) -> Int32 {
  guard v.isFinite else { return 0 }
  if abs(v) < 9e18 { return Int32(truncatingIfNeeded: Int64(v)) }
  return Int32(truncatingIfNeeded: Int64(fmod(v, 4294967296)))
}

/// The way back from the plane to one screen window. Built per window (a pan
/// makes a new one), from a grid of samples of the map over it. It remembers
/// what it found, so one is used from one thread at a time.
public final class PlaneInverse {
  private let c: PlaneProgram
  /// X, Y, x, y per seed.
  private var seeds: [Double]
  private var count: Int
  /// Which of the BLOCKS² blocks of the window each seed is in.
  private var blocks: [Int]
  /// How far in x and y each seed's cell reaches (mayShow).
  private var reach: [Double]
  /// The window with its margin.
  private let lo: [Double]
  private let hi: [Double]
  /// How big the window looks in x and y, and on the screen.
  private var worldScale: Double
  private let screenScale: Double
  private let center: [Double]
  public let box: ScreenBox

  public init(_ map: PlaneMap, _ box: ScreenBox) {
    c = map.program
    self.box = box
    let w = box.hi[0] - box.lo[0]
    let h = box.hi[1] - box.lo[1]
    lo = [box.lo[0] - MARGIN * w, box.lo[1] - MARGIN * h]
    hi = [box.hi[0] + MARGIN * w, box.hi[1] + MARGIN * h]
    center = [(box.lo[0] + box.hi[0]) / 2, (box.lo[1] + box.hi[1]) / 2]
    screenScale = hypot(w, h)
    let planted = PlaneInverse.plant(c, (lo[0], lo[1]), (hi[0] - lo[0], 0), (0, hi[1] - lo[1]))
    (seeds, blocks, reach, count, worldScale) = planted
  }

  /// Seeds on a grid over the parallelogram from `origin` along a and b:
  /// each seed's X, Y, x, y, its block, how far its cell reaches, how many
  /// there are, and how big what they show is in x and y.
  private static func plant(
    _ c: PlaneProgram, _ origin: ScreenPoint, _ a: ScreenPoint, _ b: ScreenPoint
  ) -> ([Double], [Int], [Double], Int, Double) {
    let side = SEEDS + 1
    var seeds: [Double] = []
    var blocks: [Int] = []
    var reach: [Double] = []
    seeds.reserveCapacity(4 * side * side)
    var grid = [Double](repeating: 0, count: 2 * side * side)
    func at(_ i: Int, _ j: Int) -> ScreenPoint {
      let (u, v) = ((Double(i) + 0.5) / Double(side), (Double(j) + 0.5) / Double(side))
      return (origin.0 + a.0 * u + b.0 * v, origin.1 + a.1 * u + b.1 * v)
    }
    for i in 0..<side {
      for j in 0..<side {
        let p = at(i, j)
        (grid[2 * (i * side + j)], grid[2 * (i * side + j) + 1]) = c.f(p.0, p.1)
      }
    }
    var (xlo, ylo, xhi, yhi) = (Double.infinity, Double.infinity, -Double.infinity, -Double.infinity)
    for i in 0..<side {
      for j in 0..<side {
        let (X, Y) = at(i, j)
        let (x, y) = (grid[2 * (i * side + j)], grid[2 * (i * side + j) + 1])
        if !x.isFinite || !y.isFinite { continue }
        // How far the plane its cell shows reaches from it: to its
        // neighbours' points, and on to the next ones at the grid's edge.
        var r = 0.0
        for (di, dj) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
          let (p, q) = (i + di, j + dj)
          if p < 0 || q < 0 || p >= side || q >= side { continue }
          let d = hypot(grid[2 * (p * side + q)] - x, grid[2 * (p * side + q) + 1] - y)
          if d.isFinite { r = max(r, d) }
        }
        blocks.append((i * BLOCKS / side) * BLOCKS + j * BLOCKS / side)
        reach.append(r)
        seeds += [X, Y, x, y]
        (xlo, ylo, xhi, yhi) = (min(xlo, x), min(ylo, y), max(xhi, x), max(yhi, y))
      }
    }
    let n = blocks.count
    return (seeds, blocks, reach, n, n > 0 ? hypot(xhi - xlo, yhi - ylo) : 1)
  }

  /// Whether the window (with its margin) may show (x, y): near the point
  /// of some cell of it. False only where none comes near, so a cheap test
  /// before a search.
  public func mayShow(_ x: Double, _ y: Double) -> Bool {
    for k in 0..<count {
      let r = 1.5 * reach[k]
      if abs(seeds[4 * k + 2] - x) <= r && abs(seeds[4 * k + 3] - y) <= r { return true }
    }
    return false
  }

  /// Whether (X, Y) is in the window, or within `margin` of it (a share of
  /// its size).
  public func inside(_ X: Double, _ Y: Double, _ margin: Double = 0) -> Bool {
    let (mx, my) = (margin * (box.hi[0] - box.lo[0]), margin * (box.hi[1] - box.lo[1]))
    return X >= box.lo[0] - mx && X <= box.hi[0] + mx && Y >= box.lo[1] - my && Y <= box.hi[1] + my
  }

  /// The screen point near `from` that shows (x, y), by Levenberg–Marquardt:
  /// Newton's step where the map is regular, a short gradient step where it
  /// folds (the polar map's Y = 0). Nil when it does not get there, or gets
  /// there further than `margin` (a share of the window) past its edges.
  public func solve(
    _ x: Double, _ y: Double, _ from: ScreenPoint, _ margin: Double = FOLLOW_MARGIN
  ) -> ScreenPoint? {
    var (X, Y) = from
    let v = c.f(X, Y)
    var rx = v.0 - x
    var ry = v.1 - y
    var err = rx * rx + ry * ry
    if !err.isFinite { return nil }
    // Against the size of the point, not of all the window shows: where
    // the map grows fast (log-polar's e^Y, a window tall in Y) that would
    // pass points well off the one wanted, as copies of it.
    let scale = min(worldScale, 1) + abs(x) + abs(y)
    let done = (1e-10 * scale) * (1e-10 * scale)
    let reach = 0.5 * screenScale
    var lambda = 1e-3
    var it = 0
    while it < 60 && err > done {
      it += 1
      let (a, b, c, d) = self.c.j(X, Y)
      if !(a.isFinite && b.isFinite && c.isFinite && d.isFinite) { return nil }
      // Normal equations of the step: (JᵀJ + λ diag) δ = −Jᵀr.
      let A00 = a * a + c * c
      let A01 = a * b + c * d
      let A11 = b * b + d * d
      let g0 = a * rx + c * ry
      let g1 = b * rx + d * ry
      let floor = 1e-12 * (A00 + A11) + 1e-300
      var stepped = false
      for _ in 0..<12 {
        let m00 = A00 + lambda * max(A00, floor)
        let m11 = A11 + lambda * max(A11, floor)
        let det = m00 * m11 - A01 * A01
        var dX = -(m11 * g0 - A01 * g1) / det
        var dY = -(m00 * g1 - A01 * g0) / det
        // No leaping across the screen: a branch far off is not this one.
        let len = hypot(dX, dY)
        if len > reach {
          dX *= reach / len
          dY *= reach / len
        }
        let w = self.c.f(X + dX, Y + dY)
        let nrx = w.0 - x
        let nry = w.1 - y
        let nerr = nrx * nrx + nry * nry
        if nerr.isFinite && nerr < err {
          X += dX
          Y += dY
          (rx, ry, err) = (nrx, nry, nerr)
          lambda = max(lambda / 3, 1e-12)
          stepped = true
          break
        }
        lambda *= 4
      }
      // Wandering far off: whatever it finds there is not near this window.
      if !stepped || !inside(X, Y, margin + 0.5) { break }
    }
    return err <= (1e-7 * scale) * (1e-7 * scale) && inside(X, Y, margin) ? (X, Y) : nil
  }

  /// solve, along the straight path in x and y from where `from` shows to
  /// (x, y): in steps short enough that each starts near its answer. A line
  /// is that path, and one long step can land on another copy of the plane
  /// (across a fold, or a turn away) rather than follow it.
  public func follow(
    _ x: Double, _ y: Double, _ from: ScreenPoint, _ margin: Double = FOLLOW_MARGIN
  ) -> ScreenPoint? {
    let (x0, y0) = c.f(from.0, from.1)
    let steps = JS.min([64, (hypot(x - x0, y - y0) / (0.02 * worldScale)).rounded(.up)])
    if !(steps > 1) { return solve(x, y, from, margin) }
    var at: ScreenPoint? = from
    var k = 1.0
    while k <= steps, let here = at {
      let t = k / steps
      // Off the screen on the way is no matter, so long as it comes back.
      at = solve(x0 + (x - x0) * t, y0 + (y - y0) * t, here, k == steps ? margin : max(margin, 1))
      k += 1
    }
    return at
  }

  /// A polyline with a point added where a long run crosses the screen
  /// between ends the screen does not show (a chord across the window, its
  /// ends far off): carried as it is, that run would be a gap. With `copies`
  /// (PlaneInverse.lines, on a map with turns), also where a run carried on
  /// the screen spans more than the window and its margin: a copy of it can
  /// cross the window between ends past the margin on either side, shown
  /// only on other copies (log-polar twisted by 6 sin Y, a window one turn
  /// wide).
  public func through(
    _ count: Int, _ vertex: @escaping (Int) -> ScreenPoint, _ closed: Bool, _ copies: Bool = false
  ) -> (Int, (Int) -> ScreenPoint) {
    let long = 0.1 * worldScale
    func off(_ p: ScreenPoint) -> Bool { !first(p.0, p.1).0.isFinite }
    // Whether the run a → b, followed on the screen from a, spans more
    // than the window and its margin.
    func wide(_ a: ScreenPoint, _ b: ScreenPoint) -> Bool {
      let pa = first(a.0, a.1)
      guard pa.0.isFinite, let pb = follow(b.0, b.1, pa, 1e6) else { return false }
      return abs(pb.0 - pa.0) > hi[0] - lo[0] || abs(pb.1 - pa.1) > hi[1] - lo[1]
    }
    var out: [ScreenPoint]?
    for k in 0..<max(closed ? count : count - 1, 0) {
      let (a, b) = (vertex(k), vertex((k + 1) % count))
      var added: [ScreenPoint] = []
      if hypot(b.0 - a.0, b.1 - a.1) > long && ((off(a) && off(b)) || (copies && wide(a, b))) {
        for i in 1..<PROBES {
          let (i, n) = (Double(i), Double(PROBES))
          let p = (a.0 + (b.0 - a.0) * i / n, a.1 + (b.1 - a.1) * i / n)
          if !off(p) { added.append(p) }
        }
      }
      if !added.isEmpty && out == nil { out = (0...k).map(vertex) }
      if out != nil {
        out! += added
        if k + 1 < count { out!.append(b) }
      }
    }
    guard let pts = out else { return (count, vertex) }
    return (pts.count, { pts[$0] })
  }

  /// The world point at screen point (X, Y).
  public func world(_ X: Double, _ Y: Double) -> ScreenPoint { c.f(X, Y) }

  /// Whether shifting the screen by d shows the same plane: the map at
  /// (X, Y) + d is the map at (X, Y), sampled across the window.
  public func symmetric(_ d: ScreenPoint) -> Bool {
    let (lo, hi) = (box.lo, box.hi)
    var seen = 0
    for i in 0..<5 {
      for j in 0..<5 {
        let X = lo[0] + (hi[0] - lo[0]) * (Double(i) + 0.37) / 5
        let Y = lo[1] + (hi[1] - lo[1]) * (Double(j) + 0.61) / 5
        let (p, q) = (c.f(X, Y), c.f(X + d.0, Y + d.1))
        if !(p.0.isFinite && p.1.isFinite && q.0.isFinite && q.1.isFinite) { continue }
        // Against the point's own size, not the window's: where the map
        // grows fast (log-polar's e^Y) a window-wide tolerance passes a
        // shift that moves the small points it shows a long way.
        let tol = 1e-7 * (1 + abs(p.0) + abs(p.1))
        if abs(p.0 - q.0) + abs(p.1 - q.1) > tol { return false }
        seen += 1
      }
    }
    return seen > 0
  }

  /// The points of the plane the map folds at in and around the window (the
  /// polar origin, shown all along Y = 0): where the Jacobian's determinant
  /// changes sign between samples, found by halving.
  public func foldPoints() -> [ScreenPoint] {
    if let folds_ { return folds_ }
    let n = 24
    func det(_ p: ScreenPoint) -> Double {
      let (a, b, c, d) = c.j(p.0, p.1)
      return a * d - b * c
    }
    func at(_ i: Int, _ j: Int) -> ScreenPoint {
      (lo[0] + (hi[0] - lo[0]) * Double(i) / Double(n), lo[1] + (hi[1] - lo[1]) * Double(j) / Double(n))
    }
    var found: [ScreenPoint] = []
    let tol = 1e-6 * (1 + worldScale)
    func known(_ w: ScreenPoint) -> Bool { found.contains { abs($0.0 - w.0) + abs($0.1 - w.1) < tol } }
    for i in 0...n {
      for j in 0...n {
        for (di, dj) in [(1, 0), (0, 1)] {
          if i + di > n || j + dj > n || found.count >= 8 { continue }
          var (p, q) = (at(i, j), at(i + di, j + dj))
          var (dp, dq) = (det(p), det(q))
          // A sample right on the fold is one; otherwise it lies between
          // samples whose determinants differ in sign.
          if dp == 0 { q = p } else if !(dp * dq < 0) { continue }
          var k = 0
          while k < 50 && dp != 0 {
            k += 1
            let m = ((p.0 + q.0) / 2, (p.1 + q.1) / 2)
            let dm = det(m)
            if dm * dp > 0 { (p, dp) = (m, dm) } else { (q, dq) = (m, dm) }
          }
          let w = c.f((p.0 + q.0) / 2, (p.1 + q.1) / 2)
          if w.0.isFinite && w.1.isFinite && !known(w) { found.append(w) }
        }
      }
    }
    // And where it touches 0 without changing sign: a branch point of a
    // conformal map (z², at 0), where det J = 4|z|² ≥ 0. From each sample
    // lower than its neighbours, |det J| is walked down to its least; a
    // point it reaches 0 at, against the window's typical size of J, is one.
    var size: [Double] = []
    var grid: [Double] = []
    for i in 0...n {
      for j in 0...n {
        let p = at(i, j)
        let (a, b, c, d) = c.j(p.0, p.1)
        grid.append(abs(a * d - b * c))
        size.append(a * a + b * b + c * c + d * d)
      }
    }
    let sizes = size.filter(\.isFinite).sorted()
    // (No finite sample: nothing below compares under an undefined size.)
    let typical = sizes.isEmpty ? Double.nan : sizes[sizes.count >> 1]
    func g(_ i: Int, _ j: Int) -> Double { i < 0 || j < 0 || i > n || j > n ? .infinity : grid[i * (n + 1) + j] }
    var lows: [(Int, Int)] = []
    for i in 0...n {
      for j in 0...n {
        let v = g(i, j)
        if v.isFinite && v < 0.05 * typical && v <= g(i - 1, j) && v <= g(i + 1, j) && v <= g(i, j - 1)
          && v <= g(i, j + 1)
        {
          lows.append((i, j))
        }
      }
    }
    lows = stableSorted(lows) { g($0.0, $0.1) }
    for (i, j) in lows.prefix(4) {
      var p = at(i, j)
      var dp = det(p)
      var step = ((hi[0] - lo[0]) / Double(n), (hi[1] - lo[1]) / Double(n))
      for _ in 0..<60 {
        var moved = false
        for (u, v) in [(1.0, 0.0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)] {
          let q = (p.0 + u * step.0, p.1 + v * step.1)
          // In the window: a map whose det J only falls off past it (log-
          // polar, toward Y = −∞) has no point there.
          if q.0 < lo[0] || q.1 < lo[1] || q.0 > hi[0] || q.1 > hi[1] { continue }
          let dq = det(q)
          if abs(dq) < abs(dp) { (p, dp, moved) = (q, dq, true) }
        }
        if !moved { step = (step.0 / 2, step.1 / 2) }
      }
      // A least of |det J| at the window's edge is it falling off, not 0.
      let cellW = (hi[0] - lo[0]) / Double(n)
      let cellH = (hi[1] - lo[1]) / Double(n)
      let atEdge = p.0 - lo[0] < cellW || hi[0] - p.0 < cellW || p.1 - lo[1] < cellH || hi[1] - p.1 < cellH
      if atEdge || !(abs(dp) < 1e-9 * typical) { continue }
      let w = c.f(p.0, p.1)
      if w.0.isFinite && w.1.isFinite && !known(w) { found.append(w) }
    }
    folds_ = found
    return found
  }
  private var folds_: [ScreenPoint]?

  /// Whether the map folds at world point w alone, the plane round it shown
  /// where it does not fold: not a point of a fold along a curve (a curve
  /// clipped by the window's corner shows one or two points), nor the edge
  /// of what the map reaches.
  public func isolated(_ w: ScreenPoint) -> Bool {
    let r = 0.01 * worldScale
    for k in 0..<8 {
      let a = 2 * Double.pi * (Double(k) + 0.5) / 8
      let s = first(w.0 + r * cos(a), w.1 + r * sin(a))
      if !s.0.isFinite || folds(s.0, s.1) { return false }
    }
    return true
  }

  /// Whether the map folds at screen point (X, Y), showing one point of the
  /// plane all along a line there (the polar origin, along Y = 0).
  public func folds(_ X: Double, _ Y: Double) -> Bool {
    let (a, b, c, d) = c.j(X, Y)
    return !(abs(a * d - b * c) > 1e-6 * (a * a + b * b + c * c + d * d))
  }

  /// all(), remembered while the window stays: a still picture redraws its
  /// points without solving for them again.
  private var memo: [PointKey: [ScreenPoint]] = [:]

  /// Every screen point in or just around the window showing (x, y).
  public func all(_ x: Double, _ y: Double) -> [ScreenPoint] {
    let key = PointKey(x, y)
    if let hit = memo[key] { return hit }
    let hit = search(x, y)
    if memo.count >= MEMO { memo.removeAll() }
    memo[key] = hit
    return hit
  }

  /// search, and every copy a turn of the map (turns) from what it found
  /// that the window shows.
  private func search(_ x: Double, _ y: Double) -> [ScreenPoint] {
    // The turns first: finding them may move the seeds (reseed).
    let turns = self.turns()
    var out = searchSeeds(x, y)
    if turns.isEmpty { return out }
    let same = 1e-6 * screenScale
    func known(_ p: ScreenPoint) -> Bool { out.contains { abs($0.0 - p.0) + abs($0.1 - p.1) < same } }
    var i = 0
    while i < out.count && out.count < 1024 {
      for (dX, dY) in turns {
        for sign in [1.0, -1.0] {
          let c = (out[i].0 + sign * dX, out[i].1 + sign * dY)
          if !inside(c.0, c.1, MARGIN) || known(c) { continue }
          if let s = solve(x, y, c, MARGIN), !known(s) { out.append(s) }
        }
      }
      i += 1
    }
    return out
  }

  /// The shifts of the screen that show the same plane (2π along X, on the
  /// polar screen), as at most two shortest ones: found from where a few
  /// points' copies lie apart, and checked across the window (symmetric).
  /// A search that misses a copy finds it a turn from one it did not miss.
  public func turns() -> [ScreenPoint] {
    if let turns_ { return turns_ }
    var found: [ScreenPoint] = []
    turns_ = found
    let (lo, hi) = (box.lo, box.hi)
    var apart: [ScreenPoint] = []
    for (u, v) in [(0.5, 0.5), (0.23, 0.31), (0.77, 0.69), (0.31, 0.77), (0.69, 0.23)] {
      let p = (lo[0] + (hi[0] - lo[0]) * u, lo[1] + (hi[1] - lo[1]) * v)
      let w = c.f(p.0, p.1)
      if !(w.0.isFinite && w.1.isFinite) || folds(p.0, p.1) { continue }
      let copies = searchSeeds(w.0, w.1)
      for (i, a) in copies.enumerated() {
        for (j, b) in copies.enumerated() where i != j { apart.append((b.0 - a.0, b.1 - a.1)) }
      }
    }
    let small = 1e-6 * screenScale
    apart = stableSorted(apart) { hypot($0.0, $0.1) }
    // Copies found far apart are many turns apart: the turn is what those
    // along one line have in common, by Euclid's algorithm on their lengths
    // (2π from 38π and 40π). Tried first, before each apart itself.
    var common: [ScreenPoint] = []
    for d in apart {
      let len = hypot(d.0, d.1)
      if len < small { continue }
      let u = (d.0 / len, d.1 / len)
      if common.contains(where: { abs($0.0 * u.1 - $0.1 * u.0) < 1e-6 * hypot($0.0, $0.1) }) { continue }
      var g = len
      var far = 0.0
      for e in apart {
        let t = e.0 * u.0 + e.1 * u.1
        if abs(e.0 * u.1 - e.1 * u.0) > 1e-6 * abs(t) || abs(t) < small { continue }
        var (a, b) = (g, abs(t))
        var it = 0
        while it < 64 && b > small {
          (a, b) = (b, abs(a - JS.round(a / b) * b))
          it += 1
        }
        if a > small { g = a }
        far = max(far, abs(t))
      }
      // As the longest over the number of turns it spans: its error shared
      // among them, so a copy many turns off moved by it lands on its own.
      if far > g { g = far / JS.round(far / g) }
      common.append((g * u.0, g * u.1))
    }
    for d in common + apart {
      let len = hypot(d.0, d.1)
      if len < small || found.count >= 2 { continue }
      // Not one found already, or a whole number of it, or (with two) a sum.
      let along = found.contains { abs(d.0 * $0.1 - d.1 * $0.0) < 1e-6 * len * hypot($0.0, $0.1) }
      if along || found.count == 2 { continue }
      // A copy two turns on, its neighbour missed: the turn is a part of it.
      for k in stride(from: 6.0, through: 1, by: -1) {
        let t = (d.0 / k, d.1 / k)
        if hypot(t.0, t.1) > small && symmetric(t) {
          found.append(t)
          break
        }
      }
    }
    primitive(&found)
    // Each pointing up the screen's X (or up Y, along it): either way is a
    // turn, and one way is easier to read.
    for k in found.indices {
      let t = found[k]
      let len = hypot(t.0, t.1)
      if t.0 < -1e-9 * len || (!(t.0 > 1e-9 * len) && t.1 < 0) { found[k] = (-t.0, -t.1) }
    }
    turns_ = found
    reseed(found)
    return found
  }
  private var turns_: [ScreenPoint]?

  /// The turns found, made the shortest that show the same plane: one found
  /// may be a whole number of the true turn (in a window many turns wide the
  /// copies found from its seeds can all lie that far apart: polar's 6π for
  /// 2π), and two may span only part of the lattice the map repeats on
  /// ((cos X, sin Y)'s (2π, ±2π) for 2π along each). Each is divided by a
  /// small prime while the map is the same a part on; two, by the p + 1 ways
  /// to add a p-th of them, then made short and square (Lagrange).
  private func primitive(_ found: inout [ScreenPoint]) {
    let small = 1e-6 * screenScale
    func ok(_ t: ScreenPoint) -> Bool { hypot(t.0, t.1) > small && symmetric(t) }
    if found.count == 1 {
      var more = true
      while more {
        more = false
        for p in [2.0, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31] {
          let t = (found[0].0 / p, found[0].1 / p)
          if ok(t) { (found[0], more) = (t, true) }
        }
      }
    }
    if found.count == 1 && !(hypot(found[0].0, found[0].1) > 1e-3 * screenScale) { found = [] }
    if found.count != 2 { return }
    var more = true
    while more {
      more = false
      let (t1, t2) = (found[0], found[1])
      primes: for p in [2.0, 3, 5, 7] {
        var a = 0.0
        while a <= p {
          // t1 / p, or (a t1 + t2) / p in place of t2.
          let v = a == p ? (t1.0 / p, t1.1 / p) : ((a * t1.0 + t2.0) / p, (a * t1.1 + t2.1) / p)
          if ok(v) {
            found = a == p ? [v, t2] : [t1, v]
            more = true
            break primes
          }
          a += 1
        }
      }
      // Lagrange: the shorter first, the other less a whole number of it.
      for _ in 0..<64 {
        let (u, w) = hypot(found[0].0, found[0].1) <= hypot(found[1].0, found[1].1)
          ? (found[0], found[1]) : (found[1], found[0])
        let m = JS.round((u.0 * w.0 + u.1 * w.1) / (u.0 * u.0 + u.1 * u.1))
        found = [u, (w.0 - m * u.0, w.1 - m * u.1)]
        if m == 0 || m.isNaN { break }
      }
    }
    // What is left checked again: two nearly the same way are one, and
    // neither may be so short the window holds thousands (a false turn).
    let (t1, t2) = (found[0], found[1])
    let cross = abs(t1.0 * t2.1 - t1.1 * t2.0)
    found = found.enumerated().filter { k, t in
      hypot(t.0, t.1) > 1e-3 * screenScale && ok(t)
        && !(k == 1 && cross < 1e-3 * hypot(t1.0, t1.1) * hypot(t2.0, t2.1))
    }.map(\.element)
  }

  /// In a window many turns wide, its seeds moved onto one turn of it: a grid
  /// over the whole window can step a whole number of turns from seed to
  /// seed and so show the plane at only a few angles (polar's, across 200π),
  /// where one turn across shows all of it, as closely as one turn would.
  /// The turn's copies of what its seeds find are added by search.
  private func reseed(_ found: [ScreenPoint]) {
    guard let t1 = found.first else { return }
    let (W, H) = (hi[0] - lo[0], hi[1] - lo[1])
    // The other side: a second turn, or across the window the other way.
    let t2 = found.count > 1 ? found[1] : (abs(t1.0) / W >= abs(t1.1) / H ? (0, 0.999 * H) : (0.999 * W, 0))
    // Only where the window holds many of them, but no more than a search
    // finds copies (all), and one fits in it.
    let cell = abs(t1.0 * t2.1 - t1.1 * t2.0)
    if cell * RESEED > W * H || cell * 1024 < W * H { return }
    let mid = ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2)
    let origin = (mid.0 - (t1.0 + t2.0) / 2, mid.1 - (t1.1 + t2.1) / 2)
    for (u, v) in [(0.0, 0.0), (1, 0), (0, 1), (1, 1)] {
      let (X, Y) = (origin.0 + u * t1.0 + v * t2.0, origin.1 + u * t1.1 + v * t2.1)
      if X < lo[0] || X > hi[0] || Y < lo[1] || Y > hi[1] { return }
    }
    let scale = worldScale
    (seeds, blocks, reach, count, worldScale) = PlaneInverse.plant(c, origin, t1, t2)
    worldScale = max(scale, worldScale)
    memo.removeAll()
  }

  private func searchSeeds(_ x: Double, _ y: Double) -> [ScreenPoint] {
    var near: [(k: Int, dist: Double)] = []
    var best = [Double](repeating: .infinity, count: BLOCKS * BLOCKS)
    var bestAt = [Int](repeating: -1, count: BLOCKS * BLOCKS)
    for k in 0..<count {
      let (dx, dy) = (seeds[4 * k + 2] - x, seeds[4 * k + 3] - y)
      let dist = dx * dx + dy * dy
      let b = blocks[k]
      if dist < best[b] { (best[b], bestAt[b]) = (dist, k) }
      if near.count < STARTS || dist < near[near.count - 1].dist {
        // Kept in order: inserted where it belongs, the furthest dropped.
        var at = near.count
        while at > 0 && near[at - 1].dist > dist { at -= 1 }
        near.insert((k, dist), at: at)
        if near.count > STARTS { near.removeLast() }
      }
    }
    // And each block's best, when it comes near: a copy elsewhere on the
    // screen, which the nearest seeds overall can all miss.
    // Only from blocks away from those: the nearest seeds already search
    // round where they are.
    let close = (0.1 * worldScale) * (0.1 * worldScale)
    let (bw, bh) = ((hi[0] - lo[0]) / Double(BLOCKS), (hi[1] - lo[1]) / Double(BLOCKS))
    var covered = near.map { (seeds[4 * $0.k], seeds[4 * $0.k + 1]) }
    for b in best.indices {
      let k = bestAt[b]
      if k < 0 || !(best[b] < close) { continue }
      let (X, Y) = (seeds[4 * k], seeds[4 * k + 1])
      if covered.contains(where: { abs($0.0 - X) < bw && abs($0.1 - Y) < bh }) { continue }
      near.append((k, best[b]))
      covered.append((X, Y))
    }
    var out: [ScreenPoint] = []
    let same = 1e-6 * screenScale
    for (k, _) in near {
      guard let s = solve(x, y, (seeds[4 * k], seeds[4 * k + 1]), MARGIN) else { continue }
      if !out.contains(where: { abs($0.0 - s.0) + abs($0.1 - s.1) < same }) { out.append(s) }
    }
    return out
  }

  /// One screen point showing (x, y): in the window if one is, nearest its
  /// middle; NaN when none is.
  public func first(_ x: Double, _ y: Double) -> ScreenPoint {
    let (lo, hi) = (box.lo, box.hi)
    var best: ScreenPoint = (.nan, .nan)
    var bestScore = Double.infinity
    for s in all(x, y) {
      let outside = s.0 < lo[0] || s.0 > hi[0] || s.1 < lo[1] || s.1 > hi[1]
      let score = (outside ? 1e6 : 0) + hypot(s.0 - center[0], s.1 - center[1])
      if score < bestScore { (best, bestScore) = (s, score) }
    }
    return best
  }

  /// Triangles [x0, y0, x1, y1, x2, y2, …] carried to the screen: each on
  /// the copy of the plane its neighbour was on, its corners followed on from
  /// the first, well off the screen; and on every other copy the screen
  /// shows, so a region across the seam of an angle fills both sides, and a
  /// window wider than a full turn shows it twice.
  public func triangles(_ tris: [Double]) -> [Double] {
    // Corners are shared between neighbouring triangles: each is carried
    // once, followed on from the corner before it (a neighbour, in a
    // sampled grid), and once more per copy of the plane found.
    var ids: [PointKey: Int] = [:]
    var xy: [Double] = []
    var corner = [Int](repeating: 0, count: tris.count / 2)
    for k in corner.indices {
      let (x, y) = (tris[2 * k], tris[2 * k + 1])
      let key = PointKey(x, y)
      if let id = ids[key] {
        corner[k] = id
      } else {
        ids[key] = xy.count / 2
        corner[k] = xy.count / 2
        xy += [x, y]
      }
    }
    let count = xy.count / 2
    func same(_ p: ScreenPoint, _ q: ScreenPoint) -> Bool {
      abs(p.0 - q.0) + abs(p.1 - q.1) < 1e-6 * (1 + abs(p.0) + abs(p.1))
    }
    // Each corner on the copy its neighbour is on, well off the screen, and
    // the screen offsets of the other copies found by searching now and
    // then: on the polar screen, 2π along X.
    var main = [Double](repeating: .nan, count: 2 * count)
    var offsets: [ScreenPoint] = []
    // An offset found, and its opposite: copies of a turn lie both ways.
    func record(_ d: ScreenPoint) {
      for o in [d, (-d.0, -d.1)] where offsets.count < 8 && !offsets.contains(where: { same($0, o) }) {
        offsets.append(o)
      }
    }
    // Where the map folds (the polar origin, which the screen shows all
    // along Y = 0) one corner has no one place: it is placed per triangle,
    // from a corner that has, and says nothing of where the copies are.
    var folded = [Bool](repeating: false, count: count)
    var prev: ScreenPoint?
    for i in 0..<count {
      let (x, y) = (xy[2 * i], xy[2 * i + 1])
      var s: ScreenPoint? = prev.flatMap { follow(x, y, $0, 1) }
      // Followed off the window, onto a copy the screen does not show, when
      // it shows another (across the seam of an angle, or polar's copy at
      // (X + π, −Y)): that one.
      if s == nil || !inside(s!.0, s!.1) {
        let found = first(x, y)
        if found.0.isFinite && (s == nil || inside(found.0, found.1)) {
          // Where it came back is how far apart those copies are.
          if let s { record((found.0 - s.0, found.1 - s.1)) }
          s = found
        }
      }
      guard let s else { continue }
      (main[2 * i], main[2 * i + 1], prev) = (s.0, s.1, s)
      folded[i] = folds(s.0, s.1)
      if folded[i] || i % SEARCH_EVERY != 0 { continue }
      // Kept only if it shows on the screen: polar's copy at (X + π, −Y)
      // lies below it, at an offset that changes with Y.
      for other in all(x, y) where !same(other, s) && inside(other.0, other.1) {
        record((other.0 - s.0, other.1 - s.1))
      }
    }
    let copies = offsets.map { dX, dY -> [Double] in
      var at = [Double](repeating: .nan, count: 2 * count)
      for i in 0..<count {
        let (X, Y) = (main[2 * i] + dX, main[2 * i + 1] + dY)
        // A copy off past the margin is none the screen shows.
        if !inside(X, Y, MARGIN) { continue }
        if let s = solve(xy[2 * i], xy[2 * i + 1], (X, Y), MARGIN), !same(s, (main[2 * i], main[2 * i + 1])) {
          (at[2 * i], at[2 * i + 1]) = s
        }
      }
      return at
    }
    // A triangle whose corners were followed onto different copies spans
    // the screen: its corners are followed on from one of them instead.
    let far = 0.25 * screenScale
    var out: [Double] = []
    // Each triangle's copies drawn so far, by first corner: two copies of the
    // plane can carry it to the same place.
    var drawn: [ScreenPoint] = []
    func emit(_ on: [Double], _ k: Int, _ first: Bool) {
      let ids = [corner[k], corner[k + 1], corner[k + 2]]
      guard let anchor = ids.firstIndex(where: { !folded[$0] && on[2 * $0].isFinite }) else { return }
      let pa = (on[2 * ids[anchor]], on[2 * ids[anchor] + 1])
      var tri: [ScreenPoint] = []
      for (n, i) in ids.enumerated() {
        if n == anchor {
          tri.append(pa)
          continue
        }
        let p = (on[2 * i], on[2 * i + 1])
        if !folded[i] && abs(p.0 - pa.0) + abs(p.1 - pa.1) < far {
          tri.append(p)
        } else if let followed = follow(xy[2 * i], xy[2 * i + 1], pa, 1) {
          tri.append(followed)
        } else {
          return
        }
      }
      if !first && !tri.contains(where: { inside($0.0, $0.1) }) { return }
      if drawn.contains(where: { same($0, tri[0]) }) { return }
      drawn.append(tri[0])
      for p in tri { out += [p.0, p.1] }
      // A folded corner is a whole edge on the screen (the polar origin, all
      // along Y = 0 between its neighbours' angles): the triangle is a quad,
      // that corner placed from each of the other two.
      guard let fold = ids.firstIndex(where: { folded[$0] }), ids.filter({ folded[$0] }).count <= 1 else { return }
      let (next, other) = ((fold + 1) % 3, (fold + 2) % 3)
      let from = next == anchor ? other : next
      if let again = follow(xy[2 * ids[fold]], xy[2 * ids[fold] + 1], tri[from], 1), !same(again, tri[fold]) {
        out += [tri[fold].0, tri[fold].1, tri[from].0, tri[from].1, again.0, again.1]
      }
    }
    var k = 0
    while k + 2 < corner.count {
      drawn = []
      emit(main, k, true)
      for at in copies { emit(at, k, false) }
      k += 3
    }
    return out
  }

  /// A polyline on every copy of the plane the window shows, each run on
  /// each copy once. The places the screen shows a vertex are its copies:
  /// searched for (all) at every few vertices, and carried on from the
  /// vertex before along each run (follow), so a copy one search missed
  /// comes from its neighbour. A copy found with nothing leading into it
  /// came onto the screen from off it: traced back to where it did. Each
  /// chain of runs is one entry, cut just past the window's edge.
  public func lines(
    _ count: Int, _ vertex: @escaping (Int) -> ScreenPoint, _ closed: Bool, _ segment: Segment? = nil
  ) -> [[Double]] {
    let (count, vertex) = through(count, vertex, closed, !turns().isEmpty)
    let runs = closed ? count : count - 1
    if runs < 1 { return count > 0 ? [line(count, vertex, closed, FOLLOW_MARGIN, segment)] : [] }
    // As far past the window as a search looks (all), so a run between
    // ends just off it is one; the canvas cuts what is past its edge.
    let margin = MARGIN
    let carry: Carry = { [self] x, y, hint in
      if let hint { return follow(x, y, hint, margin) ?? (.nan, .nan) }
      return first(x, y)
    }
    let seg = segment ?? endsOnly
    // The copies of each vertex the screen shows, in arrays (one per field,
    // not an object per copy: a wide window has tens of thousands). A copy
    // is at (px, py), of vertex kOf. Its run on to the next vertex, once
    // carried, is pts moved by (dX, dY): a run moved by a turn shares the
    // one it was moved from. `to` is the copy that run reaches there, or −1
    // off the screen, (endX, endY) then where if it was moved; `into`
    // whether a run reaches it.
    var px: [Double] = []
    var py: [Double] = []
    var dX: [Double] = []
    var dY: [Double] = []
    var endX: [Double] = []
    var endY: [Double] = []
    var kOf: [Int] = []
    var to: [Int] = []
    var into: [Bool] = []
    var link: [Int] = []
    var pts: [[Double]?] = []
    var at = [[Int]](repeating: [], count: count)
    let tol = 1e-6 * screenScale
    // Each vertex's copies by cell, a thousand tolerances a side: one is
    // found among its cell's and the neighbours'. Each vertex has `slots`
    // slots of `table` side by side (kept together in memory, as a vertex's
    // copies are looked for together), a cell hashed to one of them: the
    // first copy there, the rest a list through `link`, told apart by
    // place. The slots double when a vertex fills half of them, up to 256
    // a vertex: past that, its lists grow longer instead.
    var slots = 4
    var table = [Int](repeating: -1, count: slots * count)
    let cell = 1000 * tol
    func slot(_ k: Int, _ i: Double, _ j: Double) -> Int {
      let h = (int32(i) &* Int32(bitPattern: 0x85eb_ca6b)) ^ (int32(j) &* Int32(bitPattern: 0xc2b2_ae35))
      let mixed = UInt32(bitPattern: h) ^ (UInt32(bitPattern: h) >> 15)
      return k * slots + Int(mixed & UInt32(slots - 1))
    }
    func enter(_ id: Int) {
      let c = slot(kOf[id], (px[id] / cell).rounded(.down), (py[id] / cell).rounded(.down))
      link[id] = table[c]
      table[c] = id
    }
    func find(_ k: Int, _ x: Double, _ y: Double) -> Int {
      let u = x / cell
      let v = y / cell
      let ci = u.rounded(.down)
      let cj = v.rounded(.down)
      // The neighbours only within a tolerance (a thousandth) of an edge.
      var i = u - ci < 0.01 ? ci - 1 : ci
      let iEnd = u - ci > 0.99 ? ci + 1 : ci
      let jEnd = v - cj > 0.99 ? cj + 1 : cj
      while i <= iEnd {
        var j = v - cj < 0.01 ? cj - 1 : cj
        while j <= jEnd {
          var id = table[slot(k, i, j)]
          while id >= 0 {
            if abs(px[id] - x) + abs(py[id] - y) < tol { return id }
            id = link[id]
          }
          j += 1
        }
        i += 1
      }
      return -1
    }
    func add(_ k: Int, _ x: Double, _ y: Double) -> Int {
      var id = find(k, x, y)
      if id < 0 {
        id = px.count
        px.append(x)
        py.append(y)
        kOf.append(k)
        dX.append(0)
        dY.append(0)
        endX.append(.nan)
        endY.append(.nan)
        to.append(-1)
        into.append(false)
        link.append(-1)
        pts.append(nil)
        at[k].append(id)
        if 2 * at[k].count > slots && slots < 256 {
          table = [Int](repeating: -1, count: 2 * table.count)
          slots *= 2
          for i in 0..<px.count { enter(i) }
        } else {
          enter(id)
        }
      }
      return id
    }
    // Searched at about a hundred vertices along it, and every vertex of a
    // short one (a polygon's edges are long).
    let every = max(1, count / 96)
    let turns = self.turns()
    let t1 = turns.first
    let t2 = turns.count > 1 ? turns[1] : nil
    let det = t1 != nil && t2 != nil ? t1!.0 * t2!.1 - t1!.1 * t2!.0 : 0
    // Each vertex's first copy carried by solving with its end shown: the
    // others are that run moved, however many turns from it they are.
    var solved = [Int](repeating: -1, count: count)
    func carried(_ m: Int) -> Bool { m >= 0 && pts[m] != nil && to[m] >= 0 }
    // The run from `id` reaches (x, y) of vertex k: set once that copy is
    // added.
    func reach(_ id: Int, _ k: Int, _ x: Double, _ y: Double) {
      let j = add(k, x, y)
      to[id] = j
      into[j] = true
    }
    func step(_ k: Int, _ id: Int) {
      if pts[id] != nil { return }
      let next = (k + 1) % count
      // A copy a turn from one carried whole is that run, moved: any number
      // of turns from the one solved, else a turn either way, found by its
      // cell. The shift is rounded to whole turns, so the run moves exactly.
      var from = -1
      var sX = 0.0
      var sY = 0.0
      let base = t1 != nil ? solved[k] : -1
      if let t1, carried(base) {
        let eX = px[id] - px[base]
        let eY = py[id] - py[base]
        let a = JS.round(
          t2.map { (eX * $0.1 - eY * $0.0) / det } ?? (eX * t1.0 + eY * t1.1) / (t1.0 * t1.0 + t1.1 * t1.1))
        let b = t2 != nil ? JS.round((t1.0 * eY - t1.1 * eX) / det) : 0
        sX = a * t1.0 + (t2.map { b * $0.0 } ?? 0)
        sY = a * t1.1 + (t2.map { b * $0.1 } ?? 0)
        let moved = (a != 0 && !a.isNaN) || (b != 0 && !b.isNaN)
        if moved && abs(eX - sX) + abs(eY - sY) < tol { from = base }
      }
      var i = 0
      while from < 0 && i < 2 * turns.count {
        let sign = i % 2 != 0 ? -1.0 : 1.0
        let (tX, tY) = turns[i >> 1]
        let m = find(k, px[id] - sign * tX, py[id] - sign * tY)
        if carried(m) { (from, sX, sY) = (m, sign * tX, sign * tY) }
        i += 1
      }
      if from >= 0 {
        pts[id] = pts[from]
        dX[id] = dX[from] + sX
        dY[id] = dY[from] + sY
        let eX = px[to[from]] + sX
        let eY = py[to[from]] + sY
        if inside(eX, eY, margin) { reach(id, next, eX, eY) } else { (endX[id], endY[id]) = (eX, eY) }
        return
      }
      let here = (px[id], py[id])
      let (piece, end) = seg(vertex(k), vertex(next), carry, here)
      pts[id] = piece
      if shown(end) {
        reach(id, next, end.0, end.1)
        if solved[k] < 0 { solved[k] = id }
      } else if !turns.isEmpty {
        // Off the screen across the seam of an angle: the copy a turn back
        // comes on at the other edge, traced back to there (lead).
        let v = vertex(next)
        if let off = follow(v.0, v.1, here, 1) {
          for (tX, tY) in turns {
            for sign in [1.0, -1.0] {
              let c = (off.0 + sign * tX, off.1 + sign * tY)
              if !inside(c.0, c.1, margin) { continue }
              if let s = solve(v.0, v.1, c, margin) { _ = add(next, s.0, s.1) }
            }
          }
        }
      }
    }
    // Searched where the line comes near what the window shows (a short
    // stretch across it is not missed), and at about a hundred vertices
    // along that (a copy coming on across a seam, or another branch).
    var near = false
    func search(_ k: Int) {
      let was = near
      let v = vertex(k)
      near = mayShow(v.0, v.1)
      if !near || (was && k % every != 0 && k != count - 1) { return }
      // Not where the map folds: the polar origin is shown all along Y = 0.
      for p in all(v.0, v.1) where inside(p.0, p.1, margin) && !folds(p.0, p.1) { _ = add(k, p.0, p.1) }
    }
    for k in 0..<runs {
      search(k)
      var i = 0
      while i < at[k].count {
        step(k, at[k][i])
        i += 1
      }
    }
    if !closed { search(count - 1) }
    // Closed: copies reached round the end, or found there, carried on.
    var pass = 0
    var more = closed
    while more && pass < count {
      more = false
      for k in 0..<runs {
        var i = 0
        while i < at[k].count {
          if pts[at[k][i]] == nil {
            step(k, at[k][i])
            more = true
          }
          i += 1
        }
      }
      pass += 1
    }
    // Where each copy with nothing leading into it came onto the screen.
    func lead(_ id: Int) -> [Double] {
      var rev: [Double] = []
      var k = kOf[id]
      var from = (px[id], py[id])
      var steps = 0
      while steps < count && (closed || k > 0) {
        let prev = (k - 1 + count) % count
        let (piece, end) = seg(vertex(k), vertex(prev), carry, from)
        rev += piece.dropFirst(2)
        if !shown(end) { break }
        rev += [end.0, end.1]
        // Into a copy already drawn: joined there.
        if find(prev, end.0, end.1) >= 0 { break }
        (k, from) = (prev, end)
        steps += 1
      }
      var out: [Double] = []
      var i = rev.count - 2
      while i >= 0 {
        out += [rev[i], rev[i + 1]]
        i -= 2
      }
      return out
    }
    let size = px.count
    var done = [Bool](repeating: false, count: size)
    var chains: [[Double]] = []
    func walk(_ id: Int, _ lead: [Double]) {
      var out = lead
      var cur = id
      while cur >= 0 && !done[cur] {
        done[cur] = true
        guard let run = pts[cur] else {
          out += [px[cur], py[cur]]
          break
        }
        var i = 0
        while i + 1 < run.count {
          out += [run[i] + dX[cur], run[i + 1] + dY[cur]]
          i += 2
        }
        if endX[cur].isFinite { out += [endX[cur], endY[cur]] }
        cur = to[cur]
        if cur >= 0 && done[cur] { out += [px[cur], py[cur]] }
      }
      if out.count >= 4 { chains.append(out) }
    }
    for id in 0..<size where !into[id] && !done[id] { walk(id, lead(id)) }
    // What is left goes round and round: a closed line on one copy.
    for id in 0..<size where !done[id] { walk(id, []) }
    return chains
  }

  /// A polyline's vertices carried to the screen, NaN pairs where it breaks.
  /// Each run is followed on from the last point and cut just past the
  /// window's edge (or `margin` past it: a filled shape is followed far off
  /// the screen, so it stays one shape to fill). Where a run is cut but its
  /// end is on the screen after all, it crossed the seam of an angle and
  /// comes back at the other edge: it is traced back from there, through
  /// earlier segments, until it leaves the window, so it re-enters at the
  /// edge. `segment` carries one straight run a → b, a included and b not,
  /// from a's neighbour `from`, handing back b carried; by default its ends
  /// only (a renderer cuts the run where the map bends it).
  public func line(
    _ count: Int, _ vertex: @escaping (Int) -> ScreenPoint, _ closed: Bool, _ margin: Double = FOLLOW_MARGIN,
    _ segment: Segment? = nil, _ start: ScreenPoint? = nil
  ) -> [Double] {
    let (count, vertex) = through(count, vertex, closed)
    let carry: Carry = { [self] x, y, hint in
      if let hint { return follow(x, y, hint, margin) ?? (.nan, .nan) }
      return first(x, y)
    }
    let seg = segment ?? endsOnly
    var out: [Double] = []
    let runs = closed ? count : count - 1
    var last: ScreenPoint? = start
    for k in 0..<max(runs, 0) {
      let (a, b) = (vertex(k), vertex((k + 1) % count))
      // A line starts on the copy its next point is on, followed back: where
      // the screen shows its start along a whole line (the polar origin, at
      // every angle), that picks the angle it leaves at.
      if last == nil {
        let next = first(b.0, b.1)
        last = shown(next) ? follow(a.0, a.1, next, margin) : nil
      }
      let (piece, end) = seg(a, b, carry, last)
      out += piece
      last = shown(end) ? end : nil
      if last != nil { continue }
      // Back on the screen on another copy (the same copy, just off it, is
      // no re-entry): traced back to where it comes in.
      let back = first(b.0, b.1)
      if !shown(back) || !inside(back.0, back.1, FOLLOW_MARGIN) { continue }
      var rev: [Double] = []
      var from = back
      var j = k
      var steps = 0
      while steps < count && (closed || j >= 0) {
        let i = (j + count) % count
        let (p, e) = seg(vertex((i + 1) % count), vertex(i), carry, from)
        rev += p
        if !shown(e) { break }
        // Back at the line's start: that point too, then stop.
        if !closed && i == 0 {
          rev += [e.0, e.1]
          break
        }
        from = e
        j -= 1
        steps += 1
      }
      out += [.nan, .nan]
      // Reversed, without b itself, which the next run starts with.
      var i = rev.count - 2
      while i >= 2 {
        out += [rev[i], rev[i + 1]]
        i -= 2
      }
      last = back
    }
    if !closed && count > 0 {
      if count > 1, let last {
        out += [last.0, last.1]
      } else {
        let v = vertex(count - 1)
        let p = carry(v.0, v.1, nil)
        out += [p.0, p.1]
      }
    }
    return out
  }
}

/// A line on every copy of the plane the window shows (PlaneInverse.lines).
public func planeLines(
  _ inverse: PlaneInverse, _ count: Int, _ vertex: @escaping (Int) -> ScreenPoint, _ closed: Bool,
  _ segment: Segment? = nil
) -> [[Double]] {
  inverse.lines(count, vertex, closed, segment)
}
