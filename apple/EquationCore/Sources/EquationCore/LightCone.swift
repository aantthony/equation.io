#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Light cones of a panel's metric (lib/light-cone.ts), as numbers and as
/// glyphs: `lightcones` draws them on a lattice over the window,
/// `lightcone(P)` one at a point.
///
/// On a spacetime diagram a light cone is two null lines through the point,
/// drawn as a filled wedge opening toward the future, with the past half as
/// two strokes; the future half is the one along which the row's written
/// time increases. With a time besides the panel's two coordinates the cone
/// is drawn by its section at dt = 1: the coordinate velocities light can
/// have, an ellipse (the light-speed indicatrix), all at one scale κ chosen
/// from the median ellipse in view.

/// With no orientation of its own: τ = y, and σ = x.
private let UP: [Double] = [0, 1, 1, 0]

/// The angles (in x and y, radians) of the two null lines of a 2 × 2 metric,
/// or nil where it is not Lorentzian or not defined (`nullAngles`).
func nullAngles(_ gxx: Double, _ gxy: Double, _ gyy: Double) -> (Double, Double)? {
  let A = (gxx + gyy) / 2
  let B = (gxx - gyy) / 2
  let R = hypot(B, gxy)
  if !A.isFinite || !R.isFinite || !(R > abs(A) * (1 + 1e-12)) { return nil }
  let phi = atan2(gxy, B)
  let alpha = acos(-A / R)
  return ((phi + alpha) / 2, (phi - alpha) / 2)
}

/// The future half of a 2 × 2 Lorentzian metric's timelike cone: its axis's
/// angle in x and y and its half-width, or nil (`futureCone`).
func futureCone(_ gxx: Double, _ gxy: Double, _ gyy: Double, _ orient: [Double]? = nil)
  -> (axis: Double, half: Double)?
{
  let orient = orient ?? UP
  guard let (a1, a2) = nullAngles(gxx, gxy, gyy) else { return nil }
  let phi = a1 + a2
  let half = (Double.pi - (a1 - a2)) / 2
  var axis = phi / 2 + Double.pi / 2
  let (c, s) = (cos(axis), sin(axis))
  let along = orient[0] * c + orient[1] * s
  let size = hypot(orient[0], orient[1])
  let back = abs(along) > 1e-9 * size ? along < 0 : orient[2] * c + orient[3] * s > 0
  if back { axis += Double.pi }
  axis = atan2(sin(axis), cos(axis))
  return (axis, half)
}

/// The null half-line of a 2 × 2 Lorentzian metric nearest the angle `of`,
/// as a unit vector in x and y, or nil (`nearestNull`).
func nearestNull(_ gxx: Double, _ gxy: Double, _ gyy: Double, _ of: Double) -> (Double, Double)? {
  guard let (a1, a2) = nullAngles(gxx, gxy, gyy) else { return nil }
  var best = Double.nan
  var gap = Double.infinity
  for a in [a1, a2] {
    for c in [a, a + Double.pi] {
      var d = c - of
      d -= 2 * Double.pi * JS.round(d / (2 * Double.pi))
      if abs(d) < gap {
        gap = abs(d)
        best = c
      }
    }
  }
  return (cos(best), sin(best))
}

/// An ellipse: centre, semi-axes a (along `angle`) and b, in x and y.
struct Ellipse {
  var cx: Double
  var cy: Double
  var a: Double
  var b: Double
  var angle: Double
}

/// The light-speed indicatrix of a 3 × 3 metric in (t, x, y) at a point, or
/// nil inside a horizon (`indicatrix`).
func indicatrix(_ g: [[Double]]) -> Ellipse? {
  let (gtt, bx, by) = (g[0][0], g[0][1], g[0][2])
  let (hxx, hxy, hyy) = (g[1][1], g[1][2], g[2][2])
  let det = hxx * hyy - hxy * hxy
  if !(hxx > 0) || !(det > 1e-14 * JS.max([hxx * hxx, hyy * hyy])) { return nil }
  let cx = -(hyy * bx - hxy * by) / det
  let cy = -(hxx * by - hxy * bx) / det
  let K = -(bx * cx + by * cy) - gtt
  if !(K > 0) || !K.isFinite { return nil }
  // h's eigenvalues, the larger along `angle`.
  let mean = (hxx + hyy) / 2
  let spread = hypot((hxx - hyy) / 2, hxy)
  let (l1, l2) = (mean + spread, mean - spread)
  if !(l2 > 0) { return nil }
  return Ellipse(
    cx: cx, cy: cy, a: (K / l1).squareRoot(), b: (K / l2).squareRoot(), angle: atan2(2 * hxy, hxx - hyy) / 2)
}

/// The window glyphs are laid out over, and its scale: math units per point
/// across (upp) and up (uppY) (`ConeView`).
public struct ConeView: Equatable, Sendable {
  public var lo: (x: Double, y: Double)
  public var hi: (x: Double, y: Double)
  public var upp: Double
  public var uppY: Double

  public init(lo: (x: Double, y: Double), hi: (x: Double, y: Double), upp: Double, uppY: Double) {
    self.lo = lo
    self.hi = hi
    self.upp = upp
    self.uppY = uppY
  }

  public static func == (a: ConeView, b: ConeView) -> Bool {
    a.lo == b.lo && a.hi == b.hi && a.upp == b.upp && a.uppY == b.uppY
  }
}

/// Lattice spacing, near this many points.
let CONE_CELL_PX = 56.0
/// A spacetime diagram's cone, its edges this many points long, and a lone lightcone(P)'s.
let CONE_RADIUS_PX = 15.0
let LONE_CONE_RADIUS_PX = 30.0
/// The reach of the median indicatrix in view, as a part of the lattice's cell.
let ELLIPSE_REACH = 0.36
/// The lattice's cell across, in x, at `upp` units a point (`coneCell`).
func coneCell(_ upp: Double) -> Double { JS.pow(2, JS.round(log2(CONE_CELL_PX * upp))) }

/// Nodes behindHorizon's grid has at most.
private let HORIZON_NODES = 2000.0
/// Pieces an edge near a horizon is checked in.
private let EDGE_SAMPLES = 32
/// Glyphs a lattice has at most.
private let MAX_GLYPHS = 6000.0

private struct LatticeBounds {
  var wx: Double
  var wy: Double
  var i0: Double
  var i1: Double
  var k0: Double
  var k1: Double
}

/// The lattice's cells across and up, and the range of its cells' indices
/// over the view, or nil (`latticeBounds`).
private func latticeBounds(_ view: ConeView) -> LatticeBounds? {
  let wx = coneCell(view.upp)
  let wy = wx * view.uppY / view.upp
  if !(wx > 0) || !(wy > 0) || !wx.isFinite || !wy.isFinite { return nil }
  return LatticeBounds(
    wx: wx, wy: wy, i0: (view.lo.x / wx).rounded(.down) - 1, i1: (view.hi.x / wx).rounded(.up),
    k0: (view.lo.y / wy).rounded(.down) - 1, k1: (view.hi.y / wy).rounded(.up))
}

/// The lattice's points over the view: cell centres (i + ½) w, a cell beyond
/// each edge so a glyph half in view still draws (`coneLattice`).
func coneLattice(_ view: ConeView) -> [(Double, Double)] {
  var out: [(Double, Double)] = []
  guard let b = latticeBounds(view), !((b.i1 - b.i0 + 1) * (b.k1 - b.k0 + 1) > MAX_GLYPHS),
    b.i0.isFinite, b.i1.isFinite, b.k0.isFinite, b.k1.isFinite, b.i0 <= b.i1, b.k0 <= b.k1
  else { return out }
  var i = b.i0
  while i <= b.i1 {
    var k = b.k0
    while k <= b.k1 {
      out.append(((i + 0.5) * b.wx, (k + 0.5) * b.wy))
      k += 1
    }
    i += 1
  }
  return out
}

/// What a lattice's glyphs, the panel's indicatrix scale and its horizon
/// cut-off depend on in a view: the scale and which cells are in it
/// (`coneViewKey`).
public func coneViewKey(_ view: ConeView) -> String {
  let b = latticeBounds(view)
  return "\(view.upp),\(view.uppY)," + (b.map { "\($0.i0),\($0.i1),\($0.k0),\($0.k1)" } ?? "none")
}

/// What glyphs draw, in x and y: closed rings filled lightly and outlined,
/// open strokes, and dots; each ring and stroke ends with NaN, NaN (`ConeGlyphs`).
public struct ConeGlyphs: Sendable {
  public var rings: [Double] = []
  public var lines: [Double] = []
  public var dots: [Double] = []
}

/// The scale κ indicatrices are drawn at over a view: a power of two, so the
/// median ellipse's reach from its point is near ELLIPSE_REACH of a lattice
/// cell — or NaN when none is defined in view (`indicatrixScale`).
public func indicatrixScale(_ read: MetricRead, _ view: ConeView) -> Double {
  var reach: [Double] = []
  for (x, y) in coneLattice(view) {
    if let g = read(x, y), let e = indicatrix(g) { reach.append(hypot(e.cx, e.cy) + JS.max([e.a, e.b])) }
  }
  if reach.isEmpty { return .nan }
  reach.sort()
  let median = reach[reach.count / 2]
  let cell = coneCell(view.upp)
  return JS.pow(2, JS.round(log2(ELLIPSE_REACH * cell / median)))
}

/// Whether x and y are space in a 3 × 3 metric (t, x, y).
private func spatial(_ g: [[Double]]) -> Bool {
  let (hxx, hxy, hyy) = (g[1][1], g[1][2], g[2][2])
  return hxx > 0 && hxx * hyy - hxy * hxy > 0
}

/// Which points are cut off from the outside by a horizon, as inside a
/// spinning hole's inner horizon r₋, where x and y are space again and an
/// ellipse could be drawn (`behindHorizon`). A grid at half the lattice's
/// spacing over the view and a cell round it is flood-filled from the
/// outside through the nodes where x and y are space, never along an edge
/// with a horizon inside it; a point is cut off when neither its nearest
/// node nor any of that node's four neighbours was reached.
public func behindHorizon(_ read: @escaping MetricRead, _ view: ConeView) -> (Double, Double) -> Bool {
  guard let b = latticeBounds(view) else { return { _, _ in false } }
  let (cell, cellY) = (b.wx, b.wy)
  let x0 = (b.i0 - 1) * cell
  let y0 = (b.k0 - 1) * cellY
  let (w, h) = ((b.i1 + 2) * cell - x0, (b.k1 + 2) * cellY - y0)
  // Half a cell, or coarser to hold the grid to HORIZON_NODES.
  let grow = JS.max([1, ((w / (cell / 2)) * (h / (cellY / 2)) / HORIZON_NODES).squareRoot()])
  let (hx, hy) = ((cell / 2) * grow, (cellY / 2) * grow)
  let fx = (w / hx).rounded(.up) + 1
  let fy = (h / hy).rounded(.up) + 1
  if !(fx > 1 && fy > 1) || !(fx * fy).isFinite || fx * fy > 1e7 { return { _, _ in false } }
  let (nx, ny) = (Int(fx), Int(fy))
  // 1: a horizon's (x and y not space); 2: reached from the edge. And at
  // each node its x, y block (NaN where undefined).
  var state = [UInt8](repeating: 0, count: nx * ny)
  var block = [Double](repeating: .nan, count: 3 * nx * ny)
  var norms: [Double] = []
  var defined = false
  for k in 0..<ny {
    for i in 0..<nx {
      let j = k * nx + i
      guard let g = read(x0 + Double(i) * hx, y0 + Double(k) * hy), g.count == 3 else { continue }
      defined = true
      block[3 * j] = g[1][1]
      block[3 * j + 1] = g[1][2]
      block[3 * j + 2] = g[2][2]
      norms.append(JS.max([abs(g[1][1]), abs(g[1][2]), abs(g[2][2])]))
      if !spatial(g) { state[j] = 1 }
    }
  }
  if !defined { return { _, _ in false } }
  norms.sort()
  let typical = norms[norms.count / 2]
  // A horizon thinner than the grid between two nodes shows as x and y's
  // metric growing large, or changing fast, across the edge: those edges
  // are checked at points between, and closed if one is not space.
  func between(_ xa: Double, _ ya: Double, _ A: [Double], _ xb: Double, _ yb: Double, _ B: [Double]) -> Bool {
    var big = 0.0
    var change = 0.0
    for c in 0..<3 {
      let (p, q) = (A[c], B[c])
      if !p.isFinite || !q.isFinite { return false }
      big = JS.max([big, abs(p), abs(q)])
      change = JS.max([change, abs(p - q) / JS.max([abs(p), abs(q), 1e-300])])
    }
    if !(big > 4 * typical) && !(change > 0.5) { return false }
    for t in 1..<EDGE_SAMPLES {
      let f = Double(t) / Double(EDGE_SAMPLES)
      if let g = read(xa + (xb - xa) * f, ya + (yb - ya) * f), g.count == 3, !spatial(g) { return true }
    }
    return false
  }
  func at(_ j: Int) -> (Double, Double) { (x0 + Double(j % nx) * hx, y0 + Double(j / nx) * hy) }
  func blockOf(_ j: Int) -> [Double] { Array(block[(3 * j)..<(3 * j + 3)]) }
  func crosses(_ j: Int, _ j2: Int) -> Bool {
    let (a, c) = (at(j), at(j2))
    return between(a.0, a.1, blockOf(j), c.0, c.1, blockOf(j2))
  }
  var queue: [Int] = []
  func visit(_ i: Int, _ k: Int, _ from: Int = -1) {
    let j = k * nx + i
    if state[j] != 0 { return }
    if from >= 0 && crosses(from, j) { return }
    state[j] = 2
    queue.append(j)
  }
  // Seeds: the grid's corners and the middles of its sides that are
  // outside — a ray from each away from the view's middle, out to a
  // thousand times the view's size in steps growing 30% a time, meets no
  // point where x and y are not space.
  let (mx, my) = ((view.lo.x + view.hi.x) / 2, (view.lo.y + view.hi.y) / 2)
  let far = 1000 * hypot(view.hi.x - view.lo.x, view.hi.y - view.lo.y)
  func outside(_ j: Int) -> Bool {
    let (px, py) = at(j)
    let d = hypot(px - mx, py - my)
    if !(d > 0) { return false }
    let (ux, uy) = ((px - mx) / d, (py - my) / d)
    var (lx, ly) = (px, py)
    var last = blockOf(j)
    var step = min(hx, hy)
    while step < far {
      let (qx, qy) = (lx + ux * step, ly + uy * step)
      let g = read(qx, qy)
      if let g, g.count == 3, !spatial(g) { return false }
      var here = [Double.nan, .nan, .nan]
      if let g, g.count == 3 { here = [g[1][1], g[1][2], g[2][2]] }
      if between(lx, ly, last, qx, qy, here) { return false }
      (lx, ly, last) = (qx, qy, here)
      step *= 1.3
    }
    return true
  }
  let (ci, ck) = (nx / 2, ny / 2)
  for (i, k) in [(0, 0), (nx - 1, 0), (0, ny - 1), (nx - 1, ny - 1), (ci, 0), (ci, ny - 1), (0, ck), (nx - 1, ck)] {
    if state[k * nx + i] != 1 && outside(k * nx + i) { visit(i, k) }
  }
  // No seed escapes — a cosmological horizon round everything, or a view
  // wholly inside r₋: there is no outside to be cut off from.
  if queue.isEmpty { return { _, _ in false } }
  var head = 0
  while head < queue.count {
    let j = queue[head]
    head += 1
    let (i, k) = (j % nx, j / nx)
    if i > 0 { visit(i - 1, k, j) }
    if i + 1 < nx { visit(i + 1, k, j) }
    if k > 0 { visit(i, k - 1, j) }
    if k + 1 < ny { visit(i, k + 1, j) }
  }
  let reached = state
  return { x, y in
    let fi = JS.round((x - x0) / hx)
    let fk = JS.round((y - y0) / hy)
    if !(fi >= 0 && fi < Double(nx) && fk >= 0 && fk < Double(ny)) { return false }
    let (i, k) = (Int(fi), Int(fk))
    for (di, dk) in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)] {
      let (a, b) = (i + di, k + dk)
      if !(a >= 0 && a < nx && b >= 0 && b < ny && reached[b * nx + a] == 2) { continue }
      // Reached, and no horizon between it and the point.
      let g = read(x, y)
      var here = [Double.nan, .nan, .nan]
      if let g, g.count == 3 { here = [g[1][1], g[1][2], g[2][2]] }
      let j = b * nx + a
      let node = at(j)
      if !between(x, y, here, node.0, node.1, blockOf(j)) { return false }
    }
    return true
  }
}

/// The light-cone glyphs of a metric read through `read` (2 × 2: a spacetime
/// diagram's wedges, oriented by `orient`; 3 × 3: indicatrices at scale κ)
/// at `at`, or over the view's lattice (`coneGlyphs`). Points where the
/// metric gives no cone are left out, and so are indicatrices cut off from
/// the outside by a horizon, and a lattice's reaching further than its cell.
public func coneGlyphs(
  _ read: @escaping MetricRead, _ view: ConeView, at: [(Double, Double)]? = nil, kappa: Double? = nil,
  radius: Double? = nil, orient: ((Double, Double) -> [Double])? = nil, cut: ((Double, Double) -> Bool)? = nil
) -> ConeGlyphs {
  var out = ConeGlyphs()
  let points = at ?? coneLattice(view)
  let (upp, uppY) = (view.upp, view.uppY)
  let R = radius ?? (at != nil ? LONE_CONE_RADIUS_PX : CONE_RADIUS_PX)
  let cell = coneCell(upp)
  var k = kappa
  var cut = cut
  for (x, y) in points {
    if !x.isFinite || !y.isFinite { continue }
    guard let g = read(x, y) else { continue }
    if g.count == 2 {
      guard let cone = futureCone(g[0][0], g[0][1], g[1][1], orient?(x, y)) else { continue }
      // The edges' angles on the screen, where a point is upp across and
      // uppY up; the cap is an arc between them, through the axis.
      func screen(_ t: Double) -> Double { atan2(sin(t) / uppY, cos(t) / upp) }
      let s1 = screen(cone.axis - cone.half)
      var sweep = screen(cone.axis + cone.half) - s1
      sweep -= 2 * Double.pi * (sweep / (2 * Double.pi)).rounded(.down)
      let steps = max(2, Int((sweep / 0.2).rounded(.up)))
      out.rings += [x, y]
      for j in 0...steps {
        let s = s1 + sweep * Double(j) / Double(steps)
        out.rings += [x + R * cos(s) * upp, y + R * sin(s) * uppY]
      }
      out.rings += [.nan, .nan]
      let s2 = s1 + sweep
      out.lines += [
        x - R * cos(s1) * upp, y - R * sin(s1) * uppY, x, y, x - R * cos(s2) * upp, y - R * sin(s2) * uppY, .nan,
        .nan,
      ]
      continue
    }
    guard let e = indicatrix(g) else { continue }
    if cut == nil { cut = behindHorizon(read, view) }
    if cut!(x, y) { continue }
    if k == nil { k = indicatrixScale(read, view) }
    let reach = hypot(e.cx, e.cy) + JS.max([e.a, e.b])
    let scale =
      k!.isFinite ? k! : at != nil ? JS.pow(2, JS.round(log2(ELLIPSE_REACH * cell / reach))) : Double.nan
    if !scale.isFinite { break }
    if at == nil && scale * reach > cell { continue }
    let (c, s) = (cos(e.angle), sin(e.angle))
    let steps = 32
    for j in 0...steps {
      let t = 2 * Double.pi * Double(j) / Double(steps)
      let (u, v) = (e.a * cos(t), e.b * sin(t))
      out.rings += [x + scale * (e.cx + c * u - s * v), y + scale * (e.cy + s * u + c * v)]
    }
    out.rings += [.nan, .nan]
    out.dots += [x, y]
  }
  return out
}
