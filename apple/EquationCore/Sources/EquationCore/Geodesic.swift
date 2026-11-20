#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Geodesics of a metric on a plane panel (a `ds^2 = …` row), traced as
/// they are drawn: lib/surface-geometry.ts from `traceGeodesic` on, for the
/// part a panel's metric needs (`numericIn`, `metricReader`, `metricValues`,
/// `metricStart`, `diagramStart`, `traceWindow`, `metricPath`).
///
/// The metric is written in the panel's x and y — pulled back through the
/// Jacobian of the coordinates it was written in, so the curve is integrated
/// and drawn in x and y with no inverse map — and at most one more
/// coordinate τ that no component depends on. Only g and its first
/// derivatives in x and y are compiled; the connection is formed from them
/// at each point and raised by solving g z = (…).
///
/// Not ported: a surface's geodesics (`geodesicSystem`, `periodicAxes`, …).
/// Where the site gives a trace a deadline in milliseconds, this takes a
/// closure that says when time is up: the core has no clock.

// MARK: - Expressions as numbers

/// An expression over numbered slots, as a closure: what lib/vm.ts's
/// `compileProg` and `run` are to the site. A value that cannot be had is NaN.
typealias SlotValues = UnsafeMutablePointer<Double>

private func compileSlots(_ e: Expr, _ slots: [String: Int]) -> (SlotValues) -> Double {
  /// Anything else: the tree-walking evaluator over the same values.
  func walked() -> (SlotValues) -> Double {
    let names = freeVars(e).list.compactMap { name in slots[name].map { (name, $0) } }
    return { vars in
      var env: [String: Double] = [:]
      for (name, k) in names { env[name] = vars[k] }
      return (try? evaluate(e, env)) ?? .nan
    }
  }
  switch e {
  case .num(let value):
    return { _ in value }
  case .var(let name):
    guard let k = slots[name] else { return { _ in .nan } }
    return { $0[k] }
  case .neg(let a):
    let f = compileSlots(a, slots)
    return { -f($0) }
  case .bin(let op, let l, let r, _):
    let (a, b) = (compileSlots(l, slots), compileSlots(r, slots))
    switch op {
    case .add: return { a($0) + b($0) }
    case .sub: return { a($0) - b($0) }
    case .mul: return { a($0) * b($0) }
    case .div: return { a($0) / b($0) }
    case .pow:
      return { realPow(a($0), b($0)) }
    }
  case .call(let name, let args):
    guard boundSumIndex(e) == nil, name != TERM_AT_FN, let fn = evalFunctions[name] else { return walked() }
    let compiled = args.map { compileSlots($0, slots) }
    switch compiled.count {
    case 1:
      let a = compiled[0]
      return { fn([a($0)]) }
    case 2:
      let (a, b) = (compiled[0], compiled[1])
      return { fn([a($0), b($0)]) }
    default:
      return { vars in fn(compiled.map { $0(vars) }) }
    }
  default:
    return walked()
  }
}

/// Expressions in several names (`names`, set per call) and in `env`'s, at
/// their values, as one function (lib/tidal.ts `numericMany`; with two
/// names, lib/surface-geometry.ts `numericIn`). It owns its storage: a class,
/// so the closures made of it stay valid.
final class NumericExprs {
  private let vars: SlotValues
  private let count: Int
  private let fns: [(SlotValues) -> Double]
  private let places: [Int]

  init(_ exprs: [Expr], _ names: [String], _ env: [String: Double]) {
    var all = NameSet()
    for n in names { all.insert(n) }
    for e in exprs {
      for n in freeVars(e) { all.insert(n) }
    }
    var slots: [String: Int] = [:]
    for (k, n) in all.list.enumerated() { slots[n] = k }
    count = max(1, all.list.count)
    vars = SlotValues.allocate(capacity: count)
    vars.initialize(repeating: .nan, count: count)
    for (n, k) in slots { vars[k] = env[n] ?? .nan }
    places = names.map { slots[$0]! }
    fns = exprs.map { compileSlots($0, slots) }
  }

  deinit { vars.deallocate() }

  /// The expressions' values with the names at `vals`, into `out`.
  func read(_ vals: [Double], _ out: inout [Double]) {
    for (k, place) in places.enumerated() { vars[place] = vals[k] }
    for k in fns.indices { out[k] = fns[k](vars) }
  }

  func read(_ p: Double, _ q: Double, _ out: inout [Double]) {
    vars[places[0]] = p
    vars[places[1]] = q
    for k in fns.indices { out[k] = fns[k](vars) }
  }
}

/// Expressions in x and y (and in `env`'s names, at their values) as one
/// function of a point (`numericIn`).
func numericIn(_ exprs: [Expr], _ params: [String] = ["x", "y"], _ env: [String: Double])
  -> (Double, Double, inout [Double]) -> Void
{
  let numeric = NumericExprs(exprs, params, env)
  return { p, q, out in numeric.read(p, q, &out) }
}

// MARK: - The integrator

/// What a geodesic is integrated from, in its two drawn coordinates (p, q)
/// (`GeodesicFlow`). The state is [p, q, p′, q′, …extras]: a metric with a
/// time coordinate τ carries U^τ as an extra.
struct GeodesicFlow {
  /// The extras' starting values.
  var extras: [Double] = []
  /// The rates of the velocity and the extras at state y, written to `out`.
  var accel: ([Double], inout [Double]) -> Void
  /// The velocity (and extras) of state y put back on the geodesic's
  /// constraint, in place; false where the metric degenerates or blows up.
  var normalize: (inout [Double]) -> Bool
  /// Whether the flow holds at (p, q), checked at each stage of a step.
  var holds: ((Double, Double) -> Bool)?
  /// Why it stopped, when that is worth a note.
  var stopped: (() -> String?)?
}

typealias Box = [[Double]]

struct GeodesicOptions {
  var start: (Double, Double)
  /// The starting direction; its length does not matter.
  var direction: (Double, Double)
  /// Arc length to run; negative runs back along −direction.
  var length: Double
  /// The coordinates' ranges: a geodesic stops where it leaves one.
  var domain: Box
  /// The longest gap between drawn points, measured in p and q themselves.
  var drawSpacing: Double?
  /// Where drawSpacing and maxStride hold; outside it, points are eight
  /// times sparser and steps may be eight times longer.
  var fine: Box?
  /// Where a geodesic with no length of its own stops: after this much drawn
  /// length in p and q.
  var drawnLimit: Double?
  /// Points to draw at most.
  var maxPoints: Int?
  /// The longest step, measured in p and q.
  var maxStride: Double?
  /// Steps to take at most (GEODESIC_MAX_STEPS).
  var maxSteps: Int?
  /// Says when its time is up (the site's `deadline`), asked every 16 steps.
  var outOfTime: (() -> Bool)?
}

/// How a geodesic ended (`GeodesicEnd`): the arc length it ran, out of
/// `asked`, and whether it ran out of its budget.
public struct GeodesicEnd: Equatable, Sendable {
  public var length = 0.0
  public var asked = 0.0
  public var budget = false
  /// Why it could not start at all (faster than light there, say).
  public var problem: String?
  /// Where it stopped, worth saying (a metric's signature changing).
  public var note: String?

  public init() {}
}

/// Steps a geodesic takes at most.
public let GEODESIC_MAX_STEPS = 20000
/// Relative accuracy each step is held to.
private let TOLERANCE = 1e-9

// Dormand–Prince 5(4): the stages' coefficients, and the weights of the
// fifth-order step and of the fourth-order one it is checked against.
private let A: [[Double]] = [
  [],
  [1.0 / 5],
  [3.0 / 40, 9.0 / 40],
  [44.0 / 45, -56.0 / 15, 32.0 / 9],
  [19372.0 / 6561, -25360.0 / 2187, 64448.0 / 6561, -212.0 / 729],
  [9017.0 / 3168, -355.0 / 33, 46732.0 / 5247, 49.0 / 176, -5103.0 / 18656],
  [35.0 / 384, 0, 500.0 / 1113, 125.0 / 192, -2187.0 / 6784, 11.0 / 84],
]
private let B5: [Double] = A[6] + [0]
private let B4: [Double] = [5179.0 / 57600, 0, 7571.0 / 16695, 393.0 / 640, -92097.0 / 339200, 187.0 / 2100, 1.0 / 40]

/// Whether (p, q), the start of `y`, is in the box.
private func inBox(_ box: Box, _ y: [Double]) -> Bool {
  y[0] >= box[0][0] && y[0] <= box[0][1] && y[1] >= box[1][0] && y[1] <= box[1][1]
}

/// How far (p, q), the start of `y`, is outside the box (0 inside).
private func fromBox(_ box: Box, _ y: [Double]) -> Double {
  hypot(JS.max([box[0][0] - y[0], 0, y[0] - box[0][1]]), JS.max([box[1][0] - y[1], 0, y[1] - box[1][1]]))
}

/// Coordinate c of the cubic Hermite interpolant of a step of length h from
/// y to z, at the fraction t.
private func hermite(_ y: [Double], _ z: [Double], _ h: Double, _ c: Int, _ t: Double) -> Double {
  let t2 = t * t
  let t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * y[c] + (t3 - 2 * t2 + t) * h * y[c + 2] + (-2 * t3 + 3 * t2) * z[c]
    + (t3 - t2) * h * z[c + 2]
}

/// The geodesic from `start` in `direction`, as points (p, q) flat, from the
/// start to where it ends: after `length` of arc, where it leaves the
/// domain (cut at the edge), where the metric degenerates or stops being
/// defined, or when its budget runs out (`traceGeodesic`). Adaptive
/// Dormand–Prince steps; the velocity is put back on its constraint after
/// every step.
func traceGeodesic(_ flow: GeodesicFlow, _ opts: GeodesicOptions, ended: inout GeodesicEnd) -> [(Double, Double)] {
  let domain = opts.domain
  let (drawSpacing, drawnLimit) = (opts.drawSpacing, opts.drawnLimit)
  let maxSteps = opts.maxSteps ?? GEODESIC_MAX_STEPS
  // A real cap, met by giving up points where the line runs straight
  // (decimate), so tight turns keep theirs.
  let maxPoints = max(opts.maxPoints ?? .max, 3)
  let back = opts.length < 0
  let total = abs(opts.length)
  let (p0, q0) = opts.start
  var out: [(Double, Double)] = []
  func inside(_ p: Double, _ q: Double) -> Bool {
    p >= domain[0][0] && p <= domain[0][1] && q >= domain[1][0] && q <= domain[1][1]
  }
  if !p0.isFinite || !q0.isFinite || !inside(p0, q0) { return out }
  let sign: Double = back ? -1 : 1
  // The state: position, velocity, then whatever else the flow carries.
  let D = 4 + flow.extras.count
  var y = [p0, q0, sign * opts.direction.0, sign * opts.direction.1] + flow.extras
  let started = flow.normalize(&y)
  out.append((p0, q0))
  ended.length = 0
  ended.asked = total
  ended.budget = false
  if !started || !(total > 0) { return out }
  var rates = [Double](repeating: 0, count: D - 2)
  func f(_ y: [Double], _ k: inout [Double]) {
    flow.accel(y, &rates)
    k[0] = y[2]
    k[1] = y[3]
    for c in 2..<D { k[c] = rates[c - 2] }
  }
  var ks = [[Double]](repeating: [Double](repeating: 0, count: D), count: 7)
  var tmp = [Double](repeating: 0, count: D)
  f(y, &ks[0])
  // Tolerances: the parameters against their ranges, the velocity against
  // its starting size.
  let span = [domain[0][1] - domain[0][0], domain[1][1] - domain[1][0]].map { $0.isFinite && $0 > 0 ? $0 : 1 }
  let speed = JS.max([abs(y[2]), abs(y[3])])
  let accel = hypot(ks[0][2], ks[0][3])
  // With no length of its own, the step sizes start from the arc it takes
  // to cross the drawn limit: at its starting speed, or, for one starting
  // (nearly) at rest, falling from it.
  var reaches = [total]
  if let drawnLimit { reaches += [drawnLimit / speed, (2 * drawnLimit / accel).squareRoot()] }
  reaches = reaches.filter { $0.isFinite && $0 > 0 }
  let reach = reaches.isEmpty ? 1 : JS.min(reaches)
  // A velocity from (nearly) nothing is measured against what it gains.
  var vscale = JS.max([speed, drawnLimit != nil && accel.isFinite ? accel * reach : 0])
  if vscale == 0 || vscale.isNaN { vscale = 1 }
  var atol = [TOLERANCE * span[0], TOLERANCE * span[1], TOLERANCE * vscale, TOLERANCE * vscale]
  for c in 4..<max(D, 4) {
    let size = abs(y[c])
    atol.append(TOLERANCE * (size == 0 || size.isNaN ? 1 : size))
  }
  let hMin = reach * 1e-12
  var s = 0.0
  // A first step a hundredth of the way; the controller takes it from there.
  var h = reach / 100
  var steps = 0
  var outOfBudget = false
  // Drawn length so far, where it stood 32 steps ago, and how far it moved
  // in each of the four stretches of 32 before: a stall is a stretch moving
  // it less than a thousandth of the most of those.
  var drawn = 0.0
  var mark = (p0, q0)
  var headway: [Double] = []
  var next = [Double](repeating: 0, count: D)
  while s < total {
    if steps >= maxSteps || ((steps & 15) == 15 && opts.outOfTime?() == true) {
      outOfBudget = true
      break
    }
    h = min(h, total - s)
    if let maxStride = opts.maxStride, maxStride != 0 {
      // (Longer outside the fine box, which holds what is looked at.)
      // Far from it, a fiftieth of the way back to it.
      var stride = maxStride
      if let fine = opts.fine, !inBox(fine, y) { stride = JS.max([8 * maxStride, fromBox(fine, y) / 50]) }
      let moving = hypot(y[2], y[3])
      h = JS.min([h, stride / (moving == 0 || moving.isNaN ? 1 : moving)])
    }
    // A stage where the flow does not hold (across a horizon) rejects the
    // step, as one off the domain of definition does.
    var off = false
    for i in 1..<7 {
      for c in 0..<D {
        var acc = y[c]
        for j in 0..<i { acc += h * A[i][j] * ks[j][c] }
        tmp[c] = acc
      }
      if let holds = flow.holds, !holds(tmp[0], tmp[1]) {
        off = true
        break
      }
      f(tmp, &ks[i])
    }
    var err = 0.0
    if !off {
      for c in 0..<D {
        var hi = y[c]
        var e = 0.0
        for j in 0..<7 {
          hi += h * B5[j] * ks[j][c]
          e += h * (B5[j] - B4[j]) * ks[j][c]
        }
        next[c] = hi
        let sc = atol[c] + TOLERANCE * JS.max([abs(y[c]), abs(hi)])
        err = JS.max([err, abs(e) / sc])
      }
    }
    if off || !err.isFinite {
      // Off the domain of definition: shorten toward it, and stop once the
      // step is nothing.
      h /= 4
      if h < hMin { break }
      continue
    }
    if err > 1 {
      h = max(h * max(0.2, 0.9 * JS.pow(err, -0.2)), hMin)
      if h <= hMin { break }
      continue
    }
    steps += 1
    // The points between, along the step's interpolant.
    var pieces = 1
    if let drawSpacing, drawSpacing != 0 {
      var gap = drawSpacing
      if let fine = opts.fine, !inBox(fine, y), !inBox(fine, next) {
        gap = JS.max([8 * drawSpacing, fromBox(fine, next) / 100])
      }
      let wanted = (hypot(next[0] - y[0], next[1] - y[1]) / gap).rounded(.up)
      // (As JavaScript's Math.max(1, Math.min(256, NaN)) is NaN, and a loop to NaN runs no piece.)
      pieces = wanted.isNaN ? 0 : Int(max(1, min(256, wanted)))
    }
    let from = y
    let step = h
    func along(_ t: Double) -> (Double, Double) {
      (hermite(from, next, step, 0, t), hermite(from, next, step, 1, t))
    }
    if !inside(next[0], next[1]) {
      // Cut at the first edge it crosses: the first piece that leaves, then
      // bisection along the interpolant within it.
      var t0 = 0.0
      var t1 = 1.0
      var k = 1
      while k <= pieces {
        let t = Double(k) / Double(pieces)
        let at = along(t)
        if !inside(at.0, at.1) {
          t1 = t
          break
        }
        t0 = t
        out.append(at)
        k += 1
      }
      for _ in 0..<50 {
        let t = (t0 + t1) / 2
        let at = along(t)
        if inside(at.0, at.1) { t0 = t } else { t1 = t }
      }
      // On the edge exactly, in the coordinate that crossed it.
      var edge = along(t0)
      let crossed = along(t1)
      if crossed.0 < domain[0][0] { edge.0 = domain[0][0] } else if crossed.0 > domain[0][1] { edge.0 = domain[0][1] }
      if crossed.1 < domain[1][0] { edge.1 = domain[1][0] } else if crossed.1 > domain[1][1] { edge.1 = domain[1][1] }
      out.append(edge)
      break
    }
    // Back on the constraint: the drift is rounding and truncation. Where
    // the metric degenerates (a pole), end at the last good point.
    var settled = next
    if !flow.normalize(&settled) { break }
    if pieces > 1 {
      for k in 1..<pieces { out.append(along(Double(k) / Double(pieces))) }
    }
    if drawnLimit != nil { drawn += hypot(next[0] - y[0], next[1] - y[1]) }
    y = settled
    s += h
    out.append((y[0], y[1]))
    // Held to a few times its points as it goes, and to them at the end.
    if maxPoints < Int.max / 8, out.count > 8 * maxPoints { decimate(&out, 4 * maxPoints) }
    if let drawnLimit {
      if drawn >= drawnLimit { break }
      if steps % 32 == 0 {
        let moved = hypot(y[0] - mark.0, y[1] - mark.1)
        if headway.count == 4 && moved < 1e-3 * JS.max(headway) { break }
        headway.append(moved)
        if headway.count > 4 { headway.removeFirst() }
        mark = (y[0], y[1])
      }
    }
    f(y, &ks[0])
    h = h * min(5, 0.9 * JS.pow(max(err, 1e-10), -0.2))
  }
  ended.length = s
  ended.asked = total
  ended.budget = outOfBudget
  if maxPoints < Int.max { decimate(&out, maxPoints) }
  return out
}

/// A path cut down in place to at most `target` points, keeping its shape:
/// walking along it, a point is kept once the line has turned more than θ
/// since the last one kept, or run on a set length, and θ is the smallest
/// that fits (`decimate`). The ends stay.
private func decimate(_ out: inout [(Double, Double)], _ target: Int) {
  let n = out.count
  if n <= target || n < 3 { return }
  var heading = [Double](repeating: 0, count: n - 1)
  var seg = [Double](repeating: 0, count: n - 1)
  var length = 0.0
  for i in 0..<(n - 1) {
    let dx = out[i + 1].0 - out[i].0
    let dy = out[i + 1].1 - out[i].1
    heading[i] = atan2(dy, dx)
    seg[i] = hypot(dx, dy)
    length += seg[i]
  }
  let reach = length / max(1, Double(target - 2) / 2)
  var keep = [Bool](repeating: false, count: n)
  /// The points kept with turn θ, written into `keep` when asked.
  func run(_ theta: Double, mark: Bool) -> Int {
    var count = 1
    var ref = heading[0]
    var run = 0.0
    for i in 1..<(n - 1) {
      run += seg[i - 1]
      var turn = heading[i] - ref
      turn -= 2 * Double.pi * JS.round(turn / (2 * Double.pi))
      if abs(turn) > theta || run > reach {
        count += 1
        if mark { keep[i] = true }
        ref = heading[i]
        run = 0
      }
    }
    return count + 1
  }
  var lo = 0.0
  var hi = Double.pi
  for _ in 0..<30 {
    let mid = (lo + hi) / 2
    if run(mid, mark: false) > target { lo = mid } else { hi = mid }
  }
  keep[0] = true
  keep[n - 1] = true
  _ = run(hi, mark: true)
  out = out.indices.filter { keep[$0] }.map { out[$0] }
}

// MARK: - A metric as numbers

/// g and ∂g/∂x, ∂g/∂y in x and y as symmetric matrices at a point; pulled
/// back through the Jacobian J when the metric has one: g = Jᵀ g_AB J,
/// ∂g = ∂Jᵀ g_AB J + Jᵀ ∂g_AB J + Jᵀ g_AB ∂J (`metricReader`). The last
/// point's is kept, as the integrator asks for it twice.
final class MetricReader {
  private let sys: (Double, Double, inout [Double]) -> Void
  let n: Int
  private let pulled: Bool
  private let m: Int
  private var buf: [Double]
  private var gw: [[Double]]
  private var dw: [[[Double]]]
  private(set) var g: [[Double]]
  private(set) var d: [[[Double]]]
  private var J: [[Double]]
  private var dJ: [[[Double]]]
  private var gJ: [[Double]]
  private var dgJ: [[Double]]
  private var lp = Double.nan
  private var lq = Double.nan

  init(_ sys: @escaping (Double, Double, inout [Double]) -> Void, _ n: Int, pulled: Bool = false) {
    self.sys = sys
    self.n = n
    self.pulled = pulled
    m = n * (n + 1) / 2
    buf = [Double](repeating: 0, count: 3 * m + (pulled ? 12 : 0))
    let square = [[Double]](repeating: [Double](repeating: 0, count: n), count: n)
    gw = square
    dw = [square, square]
    g = square
    d = [square, square]
    J = square
    dJ = [square, square]
    gJ = square
    dgJ = square
    if n == 3 { J[0][0] = 1 }
  }

  convenience init(_ metric: MetricSpec, _ env: [String: Double]) {
    self.init(
      numericIn(metric.components + metric.derivatives + (metric.jacobian ?? []), ["x", "y"], env), metric.n,
      pulled: metric.jacobian != nil)
  }

  /// out = Jᵀ M J, M J going through `t`.
  private func congruence(_ out: inout [[Double]], _ M: [[Double]], _ t: inout [[Double]]) {
    for i in 0..<n {
      for j in 0..<n {
        var sum = 0.0
        for k in 0..<n { sum += M[i][k] * J[k][j] }
        t[i][j] = sum
      }
    }
    for i in 0..<n {
      for j in 0..<n {
        var sum = 0.0
        for k in 0..<n { sum += J[k][i] * t[k][j] }
        out[i][j] = sum
      }
    }
  }

  /// Reads the metric at (p, q) into `g` and `d`.
  func read(_ p: Double, _ q: Double) {
    if p == lp && q == lq { return }
    sys(p, q, &buf)
    lp = p
    lq = q
    var k = 0
    for i in 0..<n {
      for j in i..<n {
        gw[i][j] = buf[k]
        gw[j][i] = buf[k]
        dw[0][i][j] = buf[m + k]
        dw[0][j][i] = buf[m + k]
        dw[1][i][j] = buf[2 * m + k]
        dw[1][j][i] = buf[2 * m + k]
        k += 1
      }
    }
    guard pulled else {
      g = gw
      d = dw
      return
    }
    let s0 = n - 2
    for a in 0..<2 {
      for i in 0..<2 {
        J[s0 + a][s0 + i] = buf[3 * m + 2 * a + i]
        dJ[0][s0 + a][s0 + i] = buf[3 * m + 4 + 2 * a + i]
        dJ[1][s0 + a][s0 + i] = buf[3 * m + 8 + 2 * a + i]
      }
    }
    congruence(&g, gw, &gJ)
    for v in 0..<2 {
      congruence(&d[v], dw[v], &dgJ)
      // + ∂Jᵀ (g J) and its transpose.
      for i in 0..<n {
        for j in 0..<n {
          var sum = 0.0
          for c in 0..<n { sum += dJ[v][c][i] * gJ[c][j] }
          dgJ[i][j] = sum
        }
      }
      for i in 0..<n {
        for j in 0..<n { d[v][i][j] += dgJ[i][j] + dgJ[j][i] }
      }
    }
  }
}

/// A metric's components in x and y at a point: 2 × 2 (x, y) or 3 × 3 (t, x,
/// y) — nil where it is not defined (lib/light-cone.ts `MetricRead`).
public typealias MetricRead = (Double, Double) -> [[Double]]?

/// A metric's g alone in x and y at a point, read over and over (a light
/// cone's glyphs): its components and Jacobian compiled, its derivatives not
/// (`metricValues`). Nil where it is not finite.
public func metricValues(n: Int, components: [Expr], jacobian: [Expr]?, _ env: [String: Double]) -> MetricRead {
  let m = components.count
  let at = numericIn(components + (jacobian.map { Array($0.prefix(4)) } ?? []), ["x", "y"], env)
  let s0 = n - 2
  let pulled = jacobian != nil
  var buf = [Double](repeating: 0, count: m + (pulled ? 4 : 0))
  let square = [[Double]](repeating: [Double](repeating: 0, count: n), count: n)
  return { x, y in
    at(x, y, &buf)
    for v in buf where !v.isFinite { return nil }
    var gw = square
    var k = 0
    for i in 0..<n {
      for j in i..<n {
        gw[i][j] = buf[k]
        gw[j][i] = buf[k]
        k += 1
      }
    }
    if !pulled { return gw }
    var Jm = square
    if s0 > 0 { Jm[0][0] = 1 }
    for a in 0..<2 {
      for i in 0..<2 { Jm[s0 + a][s0 + i] = buf[m + 2 * a + i] }
    }
    // g = Jᵀ g_written J, as metricReader forms it.
    var t = square
    var g = square
    for i in 0..<n {
      for j in 0..<n {
        var sum = 0.0
        for c in 0..<n { sum += gw[i][c] * Jm[c][j] }
        t[i][j] = sum
      }
    }
    for i in 0..<n {
      for j in 0..<n {
        var sum = 0.0
        for c in 0..<n { sum += Jm[c][i] * t[c][j] }
        g[i][j] = sum
      }
    }
    return g
  }
}

/// A spacetime diagram's time orientation from its gradients
/// (`metricOrientation`), or nil with none.
public func metricOrientation(_ future: [Expr]?, _ env: [String: Double]) -> ((Double, Double) -> [Double])? {
  guard let future else { return nil }
  let at = numericIn(future, ["x", "y"], env)
  return { x, y in
    var out = [Double](repeating: 0, count: 4)
    at(x, y, &out)
    return out
  }
}

/// z with g z = a, g symmetric 2 × 2 or 3 × 3, into `z`.
private func solveSymmetric(_ g: [[Double]], _ a: [Double], _ z: inout [Double]) {
  if g.count == 2 {
    let det = g[0][0] * g[1][1] - g[0][1] * g[0][1]
    z[0] = (g[1][1] * a[0] - g[0][1] * a[1]) / det
    z[1] = (g[0][0] * a[1] - g[0][1] * a[0]) / det
    return
  }
  let (A, B, C, D, E, F) = (g[0][0], g[0][1], g[0][2], g[1][1], g[1][2], g[2][2])
  let c00 = D * F - E * E
  let c01 = C * E - B * F
  let c02 = B * E - C * D
  let c11 = A * F - C * C
  let c12 = B * C - A * E
  let c22 = A * D - B * B
  let det = A * c00 + B * c01 + C * c02
  z[0] = (c00 * a[0] + c01 * a[1] + c02 * a[2]) / det
  z[1] = (c01 * a[0] + c11 * a[1] + c12 * a[2]) / det
  z[2] = (c02 * a[0] + c12 * a[1] + c22 * a[2]) / det
}

/// −Γ^k_μν U^μ U^ν for every coordinate k, from g and its x and y
/// derivatives (`metricAcceleration`). U is (U^τ, U^x, U^y), or (U^x, U^y).
func metricAcceleration(_ g: [[Double]], _ d: [[[Double]]], _ U: [Double], _ out: inout [Double]) {
  let n = g.count
  let s0 = n - 2
  var lower = [Double](repeating: 0, count: n)
  for k in 0..<2 {
    let uk = U[s0 + k]
    var quad = 0.0
    for l in 0..<n {
      var row = 0.0
      for v in 0..<n { row += d[k][l][v] * U[v] }
      lower[l] += uk * row
      quad += U[l] * row
    }
    lower[s0 + k] -= quad / 2
  }
  solveSymmetric(g, lower, &out)
  for k in 0..<n { out[k] = -out[k] }
}

/// How much more than its size at the start a metric may grow (or less it
/// may shrink to) before a geodesic is taken to have met a singularity.
private let METRIC_RANGE = 1e8
/// How many times its starting rate τ may come to run per step, while the
/// metric degenerates DEGENERATE-fold, before it is taken to be at a horizon.
private let TIME_RUNAWAY = 1e3
private let DEGENERATE = 1e-4

/// The largest |g_ij|.
private func metricSize(_ g: [[Double]]) -> Double {
  var size = 0.0
  for row in g {
    for v in row { size = JS.max([size, abs(v)]) }
  }
  return size
}

/// Whether the 2 × 2 block of g from row and column s on is positive
/// definite (and not nearly degenerate).
private func positive(_ g: [[Double]], _ s: Int = 0) -> Bool {
  let (E, F, G) = (g[s][s], g[s][s + 1], g[s + 1][s + 1])
  let scale = JS.max([abs(E), abs(G)])
  return E > 0 && E * G - F * F > 1e-12 * scale * scale
}

/// Whether a 2 × 2 metric is Lorentzian (det g < 0), against its size here.
private func lorentz2(_ g: [[Double]]) -> Bool {
  let size = metricSize(g)
  return g[0][0] * g[1][1] - g[0][1] * g[0][1] < -1e-12 * size * size
}

/// det g of a 3 × 3 metric.
private func det3(_ g: [[Double]]) -> Double {
  let (A, B, C, D, E, F) = (g[0][0], g[0][1], g[0][2], g[1][1], g[1][2], g[2][2])
  return A * (D * F - E * E) - B * (B * F - C * E) + C * (B * E - C * D)
}

/// Whether a 3 × 3 metric is Lorentzian with x and y space.
private func spacetime(_ g: [[Double]]) -> Bool {
  let size = metricSize(g)
  return positive(g, 1) && det3(g) < -1e-12 * size * size * size
}

private func short(_ x: Double) -> String { JS.string(JS.number(JS.toPrecision(x, 3))) }

enum MetricStart {
  case flow(GeodesicFlow, velocity: (Double, Double))
  case problem(String)
  /// Nothing to trace (a light ray with no direction).
  case nothing
}

/// The flow of a metric's geodesic from (p, q), set off with `direction` in
/// x and y, and the velocity it starts with — or why it cannot start there
/// (`metricStart`).
///
/// - riemannian: at unit speed; only the direction matters.
/// - timelike: `direction` is the coordinate velocity d(x, y)/dτ; U^τ comes
///   from g(U, U) = −1, and the step is proper time.
/// - null: only the direction matters; U^τ = 1 at the start.
func metricStart(
  _ read: MetricReader, _ motion: Motion, _ at: (Double, Double), _ direction: (Double, Double),
  sign: Double = 1, time: String = "t"
) -> MetricStart {
  let n = read.n
  let (p, q) = at
  let (a, b) = direction
  read.read(p, q)
  let g = read.g
  let size0 = metricSize(g)
  if !size0.isFinite || !(size0 > 0) { return .problem("the metric is not defined at the start") }
  func inRange(_ g: [[Double]]) -> Bool {
    let size = metricSize(g)
    return size < size0 * METRIC_RANGE && size > size0 / METRIC_RANGE && size.isFinite
  }
  // A diagram's geodesic where the metric is Lorentzian at the start; where
  // a metric of mixed signature is positive definite there, a particle's
  // runs as a plane's, and light has none.
  if n == 2 && motion != .riemannian && !positive(g) {
    return diagramStart(read, g, motion, direction, sign, inRange)
  }
  if n == 2 && motion == .null {
    return .problem(
      "no light here: the metric is positive definite at the start (a plane, not a spacetime, here)")
  }
  if n == 2 {
    if !positive(g) { return .problem("the metric is not positive definite at the start") }
    // Where it stops being positive definite and is Lorentzian instead (a
    // metric of mixed signature), the row's note says so.
    let why = Box1<String?>(nil)
    func sound(_ g: [[Double]]) -> Bool {
      if inRange(g) && positive(g) { return true }
      if inRange(g) && lorentz2(g) {
        why.value = "stops where the metric stops being positive definite (a spacetime beyond)"
      }
      return false
    }
    var acc = [0.0, 0.0]
    let flow = GeodesicFlow(
      accel: { y, out in
        read.read(y[0], y[1])
        metricAcceleration(read.g, read.d, [y[2], y[3]], &acc)
        out[0] = acc[0]
        out[1] = acc[1]
      },
      normalize: { y in
        read.read(y[0], y[1])
        let g = read.g
        if !sound(g) { return false }
        why.value = nil
        let (w1, w2) = (y[2], y[3])
        let s2 = g[0][0] * w1 * w1 + 2 * g[0][1] * w1 * w2 + g[1][1] * w2 * w2
        if !(s2 > 0) || !s2.isFinite { return false }
        let s = s2.squareRoot()
        y[2] = w1 / s
        y[3] = w2 / s
        return true
      },
      holds: { p, q in
        read.read(p, q)
        return sound(read.g)
      },
      stopped: { why.value })
    return .flow(flow, velocity: (sign * a, sign * b))
  }
  if !spacetime(g) {
    return .problem(
      positive(g, 1)
        ? "the metric is not Lorentzian at the start"
        : "x and y are not space at the start (inside a horizon?), so \(time) is no time there")
  }
  /// |det g| against its size: falls toward 0 where it degenerates.
  func soundness(_ g: [[Double]]) -> Double { abs(det3(g)) / JS.pow(metricSize(g), 3) }
  let sound0 = soundness(g)
  let gtt = g[0][0]
  func beta(_ u: Double, _ v: Double) -> Double { g[0][1] * u + g[0][2] * v }
  func h(_ u: Double, _ v: Double) -> Double { g[1][1] * u * u + 2 * g[1][2] * u * v + g[2][2] * v * v }
  let ergo = gtt >= 0 ? " (inside an ergoregion)" : ""
  let w: (Double, Double)
  let ut: Double
  if motion == .null {
    if a == 0 && b == 0 { return .nothing }
    // g(U, U) = 0 with U = (rate, a, b): the root moving forward in τ that
    // continues the one outside an ergoregion.
    let bd = beta(a, b)
    let disc = bd * bd - gtt * h(a, b)
    let rate = abs(gtt) < 1e-12 * size0 ? -h(a, b) / (2 * bd) : (-bd - max(disc, 0).squareRoot()) / gtt
    if !(rate > 0) || !rate.isFinite { return .problem("light cannot move this way here\(ergo)") }
    w = (a / rate, b / rate)
    ut = 1
  } else {
    let gvv = gtt + 2 * beta(a, b) + h(a, b)
    if !(gvv < 0) {
      // The speeds s along this direction g(U, U) < 0 allows: between the
      // roots of g_ττ + 2 β s + h s² = 0.
      let len = hypot(a, b)
      if len == 0 {
        return .problem(
          "nothing can stand still here\(gtt >= 0 ? ": inside an ergoregion everything is dragged round" : "")")
      }
      let (u, v) = (a / len, b / len)
      let (B, H) = (beta(u, v), h(u, v))
      let disc = B * B - H * gtt
      let hi = (-B + max(disc, 0).squareRoot()) / H
      let lo = (-B - max(disc, 0).squareRoot()) / H
      return .problem(
        disc < 0 || !(hi > 0)
          ? "no particle can move this way here\(ergo)"
          : lo > 0
            ? "a particle here must move between ≈ \(short(lo)) and \(short(hi)) in this direction\(ergo)"
            : "faster than light here: at most ≈ \(short(hi)) in this direction")
    }
    ut = 1 / (-gvv).squareRoot()
    w = (ut * a, ut * b)
  }
  // The velocity's heading as it turns, and where the current turn began.
  var lastHeading = Double.nan
  var lastAt = (p, q)
  var lapAt = (p, q)
  var turned = 0.0
  var lap = 0.0
  var acc = [0.0, 0.0, 0.0]
  let flow = GeodesicFlow(
    extras: [sign * ut],
    accel: { y, out in
      read.read(y[0], y[1])
      metricAcceleration(read.g, read.d, [y[4], y[2], y[3]], &acc)
      out[0] = acc[1]
      out[1] = acc[2]
      out[2] = acc[0]
    },
    normalize: { y in
      read.read(y[0], y[1])
      let g = read.g
      if !inRange(g) || !spacetime(g) { return false }
      // Where τ's rate runs off, these coordinates freeze at a horizon.
      if !(abs(y[4]) < TIME_RUNAWAY * max(1, abs(ut))) && soundness(g) < DEGENERATE * sound0 { return false }
      // Winding round a horizon: once τ's rate has grown tenfold, a whole
      // turn of the velocity that ends hardly a hundredth of the turn's
      // length from where it began is a ray creeping round a spinning hole.
      let heading = atan2(y[3], y[2])
      if lastHeading.isFinite {
        var turn = heading - lastHeading
        turn -= 2 * Double.pi * JS.round(turn / (2 * Double.pi))
        turned += turn
        lap += hypot(y[0] - lastAt.0, y[1] - lastAt.1)
      }
      lastHeading = heading
      lastAt = (y[0], y[1])
      if abs(turned) >= 2 * Double.pi {
        let chord = hypot(y[0] - lapAt.0, y[1] - lapAt.1)
        if chord < 0.01 * lap && abs(y[4]) > 10 * max(1, abs(ut)) { return false }
        turned = 0
        lap = 0
        lapAt = (y[0], y[1])
      }
      let (w1, w2, rate) = (y[2], y[3], y[4])
      let B = g[0][1] * w1 + g[0][2] * w2
      let C = g[1][1] * w1 * w1 + 2 * g[1][2] * w1 * w2 + g[2][2] * w2 * w2
      let A = g[0][0]
      if motion == .null {
        // U^τ re-solved from g(U, U) = 0: the root nearest the one carried.
        let disc = B * B - A * C
        if disc >= 0 {
          let roots =
            abs(A) < 1e-12 * size0 ? [-C / (2 * B)] : [(-B - disc.squareRoot()) / A, (-B + disc.squareRoot()) / A]
          var best = Double.infinity
          for r in roots where abs(r - rate) < abs(best - rate) { best = r }
          if abs(best - rate) < 0.1 * abs(rate) { y[4] = best }
        }
      } else {
        let s = A * rate * rate + 2 * B * rate + C
        if s < 0 {
          let k = 1 / (-s).squareRoot()
          if abs(k - 1) < 0.1 {
            y[2] = w1 * k
            y[3] = w2 * k
            y[4] = rate * k
          }
        }
      }
      return y[2].isFinite && y[3].isFinite && y[4].isFinite
    },
    holds: { p, q in
      read.read(p, q)
      return inRange(read.g) && spacetime(read.g)
    })
  return .flow(flow, velocity: (sign * w.0, sign * w.1))
}

/// A mutable value closures share.
final class Box1<T> {
  var value: T
  init(_ value: T) { self.value = value }
}

/// A geodesic of a spacetime diagram — a Lorentzian metric in x and y alone,
/// like -dy^2 + dx^2 or Schwarzschild's r and t (`diagramStart`).
///
/// - timelike: `direction` is the coordinate velocity, which must point
///   inside the light cone; U = v/√(−g(v, v)), so the step is proper time.
/// - null: the ray runs along the null half-line nearest `direction` by
///   angle in x and y.
private func diagramStart(
  _ read: MetricReader, _ g: [[Double]], _ motion: Motion, _ direction: (Double, Double), _ sign: Double,
  _ inRange: @escaping ([[Double]]) -> Bool
) -> MetricStart {
  let (a, b) = direction
  if !lorentz2(g) { return .problem("the metric is not Lorentzian at the start") }
  func Q(_ g: [[Double]], _ u: Double, _ v: Double) -> Double {
    g[0][0] * u * u + 2 * g[0][1] * u * v + g[1][1] * v * v
  }
  let U: (Double, Double)
  if motion == .null {
    if a == 0 && b == 0 { return .nothing }
    U = nearestNull(g[0][0], g[0][1], g[1][1], atan2(b, a))!
  } else {
    let s = Q(g, a, b)
    if !(s < 0) { return .problem("v must point inside the light cone here: a particle is slower than light") }
    U = (a / (-s).squareRoot(), b / (-s).squareRoot())
  }
  func soundness(_ g: [[Double]]) -> Double {
    abs(g[0][0] * g[1][1] - g[0][1] * g[0][1]) / JS.pow(metricSize(g), 2)
  }
  let sound0 = soundness(g)
  let speed0 = hypot(U.0, U.1)
  var acc = [0.0, 0.0]
  // Where it stops being Lorentzian and is positive definite instead (a
  // metric of mixed signature), the row's note says so.
  let why = Box1<String?>(nil)
  func sound(_ g: [[Double]]) -> Bool {
    if inRange(g) && lorentz2(g) { return true }
    if inRange(g) && positive(g) { why.value = "stops where the metric stops being Lorentzian (a plane beyond)" }
    return false
  }
  let flow = GeodesicFlow(
    accel: { y, out in
      read.read(y[0], y[1])
      metricAcceleration(read.g, read.d, [y[2], y[3]], &acc)
      out[0] = acc[0]
      out[1] = acc[1]
    },
    normalize: { y in
      read.read(y[0], y[1])
      let g = read.g
      if !sound(g) { return false }
      why.value = nil
      let (w1, w2) = (y[2], y[3])
      if !(hypot(w1, w2) < TIME_RUNAWAY * max(1, speed0)) && soundness(g) < DEGENERATE * sound0 {
        // Running away where det g falls to 0: a plane just ahead is a
        // change of signature, not a horizon these coordinates freeze at.
        let (p, q) = (y[0], y[1])
        let (ux, uy) = (w1 / hypot(w1, w2), w2 / hypot(w1, w2))
        let reach = max(1, hypot(p, q))
        for f in [1e-9, 1e-7, 1e-5, 1e-3] {
          read.read(p + ux * f * reach, q + uy * f * reach)
          if inRange(read.g) && positive(read.g) {
            why.value = "stops where the metric stops being Lorentzian (a plane beyond)"
            break
          }
        }
        return false
      }
      if motion == .null {
        // Onto the null line it runs along, if it is still the nearest.
        if let n = nearestNull(g[0][0], g[0][1], g[1][1], atan2(w2, w1)) {
          let along = w1 * n.0 + w2 * n.1
          if along > 0 && abs(w1 * n.1 - w2 * n.0) < 0.1 * along {
            y[2] = along * n.0
            y[3] = along * n.1
          }
        }
      } else {
        let s = Q(g, w1, w2)
        if s < 0 {
          let k = 1 / (-s).squareRoot()
          if abs(k - 1) < 0.1 {
            y[2] = w1 * k
            y[3] = w2 * k
          }
        }
      }
      return y[2].isFinite && y[3].isFinite
    },
    holds: { p, q in
      read.read(p, q)
      return sound(read.g)
    },
    stopped: { why.value })
  return .flow(flow, velocity: (sign * U.0, sign * U.1))
}

/// The box a metric's geodesics are traced over for a window [lo, hi]: four
/// times the power of two at least as large as the window's larger side, on
/// a lattice of half that, so panning and zooming within a factor of two
/// keep it (and the traces) as they are (`traceWindow`).
public func traceWindow(lo: (Double, Double), hi: (Double, Double)) -> [[Double]] {
  let size = JS.max([hi.0 - lo.0, hi.1 - lo.1])
  let s = JS.pow(2, log2(size.isFinite && size > 0 ? size : 1).rounded(.up))
  func snap(_ c: Double) -> Double { JS.round(c / (s / 2)) * (s / 2) }
  let cx = snap((lo.0 + hi.0) / 2)
  let cy = snap((lo.1 + hi.1) / 2)
  return [[cx - 2 * s, cx + 2 * s], [cy - 2 * s, cy + 2 * s]]
}

/// Points a metric's geodesic is drawn with at most (`METRIC_MAX_POINTS`).
public let METRIC_MAX_POINTS = 48000

/// A metric geodesic's points, x and y flat, over `window` (a box round the
/// start when none is given), at the values in `env` (sliders, t, a named
/// point's coordinates): lib/surface-geometry.ts `geodesicPath` for a spec
/// with a metric (`metricPath`). The start alone when it cannot start, or
/// has no direction; nothing when it has no start.
public func metricGeodesicPath(
  _ spec: GeodesicSpec, _ env: [String: Double], window: [[Double]]? = nil, maxPoints: Int = METRIC_MAX_POINTS,
  maxSteps: Int? = nil, outOfTime: (() -> Bool)? = nil, ended: inout GeodesicEnd
) -> [Double] {
  guard let metric = spec.metric else { return [] }
  var values = [Double](repeating: 0, count: 5)
  numericIn(spec.start + spec.direction + [spec.length ?? .num(.nan)], ["x", "y"], env)(.nan, .nan, &values)
  let (x0, y0, a, b, L) = (values[0], values[1], values[2], values[3], values[4])
  if !x0.isFinite || !y0.isFinite { return [] }
  let length = spec.length != nil ? L : .infinity
  if length.isNaN || !a.isFinite || !b.isFinite { return [x0, y0] }
  // The box round the window, grown to take in the start: a ray sent in
  // from far off still crosses a window zoomed in on the hole.
  let box = window ?? traceWindow(lo: (x0 - 10, y0 - 10), hi: (x0 + 10, y0 + 10))
  let margin = (box[0][1] - box[0][0]) / 8
  let domain = [
    [min(box[0][0], x0 - margin), max(box[0][1], x0 + margin)],
    [min(box[1][0], y0 - margin), max(box[1][1], y0 + margin)],
  ]
  let read = MetricReader(metric, env)
  let start = metricStart(read, metric.motion, (x0, y0), (a, b), sign: length < 0 ? -1 : 1, time: metric.time ?? "t")
  ended = GeodesicEnd()
  ended.asked = abs(length)
  let flow: GeodesicFlow
  let velocity: (Double, Double)
  switch start {
  case .nothing: return [x0, y0]
  case .problem(let problem):
    ended.problem = problem
    return [x0, y0]
  case .flow(let f, let v): (flow, velocity) = (f, v)
  }
  // Drawn and stepped finely for the window's box; with no length of its
  // own, run as far as the whole domain is across.
  let diagonal = hypot(box[0][1] - box[0][0], box[1][1] - box[1][0])
  let drawnLimit = spec.length != nil ? nil : hypot(domain[0][1] - domain[0][0], domain[1][1] - domain[1][0])
  let path = traceGeodesic(
    flow,
    GeodesicOptions(
      start: (x0, y0), direction: velocity, length: abs(length), domain: domain,
      drawSpacing: max(diagonal / 1500, (drawnLimit ?? 0) / Double(maxPoints)), fine: box, drawnLimit: drawnLimit,
      maxPoints: maxPoints, maxStride: diagonal / 400, maxSteps: maxSteps, outOfTime: outOfTime),
    ended: &ended)
  // Stopped short of the domain's edge where the signature changes — on a
  // failed step, or crawling up to the line where it does — say so.
  var why = flow.stopped?()
  let (pe, qe) = path[path.count - 1]
  let onEdge = pe <= domain[0][0] || pe >= domain[0][1] || qe <= domain[1][0] || qe >= domain[1][1]
  if why == nil && metric.n == 2 && path.count > 1 && !onEdge && !ended.budget {
    // The other signature within a hair of where it stopped, any way round.
    let read = MetricReader(metric, env)
    read.read(pe, qe)
    let plane = metric.motion == .riemannian || positive(read.g)
    let reach = max(1, hypot(pe, qe))
    search: for f in [1e-9, 1e-7, 1e-5, 1e-3] {
      for k in 0..<8 {
        let a = Double(k) * Double.pi / 4
        read.read(pe + cos(a) * f * reach, qe + sin(a) * f * reach)
        if plane ? lorentz2(read.g) : positive(read.g) {
          why =
            plane
            ? "stops where the metric stops being positive definite (a spacetime beyond)"
            : "stops where the metric stops being Lorentzian (a plane beyond)"
          break search
        }
      }
    }
  }
  if let why, !onEdge, !ended.budget { ended.note = why }
  var pts: [Double] = []
  pts.reserveCapacity(2 * path.count)
  for (p, q) in path {
    pts.append(p)
    pts.append(q)
  }
  return pts
}

/// The note for a geodesic its budget stopped short, or nil (`geodesicCutNote`).
public func geodesicCutNote(_ end: GeodesicEnd) -> String? {
  if let problem = end.problem { return problem }
  func n(_ x: Double) -> String { JS.string(JS.number(JS.toPrecision(x, 3))) }
  // One run with no length of its own (a metric's, to the window's edge)
  // has no length to fall short of, only a place.
  if !end.asked.isFinite { return end.budget ? "cut short at L ≈ \(n(end.length))" : end.note }
  if !end.budget || !(end.length < end.asked) { return end.note }
  return "cut short at L ≈ \(n(end.length)) of \(n(end.asked))"
}

/// The point of a lightcone(P) or tidal(P) row at the values in `env`, as
/// the one place its glyph is drawn; nil for a row over the lattice.
public func glyphPoint(_ at: [Expr]?, _ env: [String: Double]) -> [(Double, Double)]? {
  guard let at else { return nil }
  var out = [0.0, 0.0]
  numericIn(at, ["x", "y"], env)(.nan, .nan, &out)
  return [(out[0], out[1])]
}
