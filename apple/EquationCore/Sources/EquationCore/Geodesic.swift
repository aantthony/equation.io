#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Geodesics on a parametric surface (lib/surface-geometry.ts, from
/// `christoffelOf` to `geodesicPath`): the surface's connection as numbers at
/// a point, the curve integrated from a start in a direction, and what a
/// geodesic row draws (lib/analysis.ts `classifyGeodesic`).
///
/// Not ported: the symbols as expressions (`christoffelOf`,
/// `christoffelFromMetric`), which no row of the language reads.

private func num(_ value: Double) -> Expr { .num(value) }

/// Step of the symbolic central difference used where diff() cannot go (as
/// `applyDiff`).
private let FD_H = 1e-4

/// ∂e/∂v symbolically, or a symbolic central difference where e has no
/// usable derivative (floor, gamma, …) (`smoothPartial`).
func smoothPartial(_ e: Expr, _ v: String) throws -> Expr {
  do {
    return try diff(e, v)
  } catch {
    if !error.nonSmooth { throw LanguageError(error.message) }
    func at(_ h: Double) -> Expr { substVars(e, [v: add(.var(v), num(h))]) }
    return div(sub(at(FD_H), at(-FD_H)), num(2 * FD_H))
  }
}

/// The surface's first and second partial derivatives, the 15 numbers a
/// geodesic is integrated from: r_u, r_v, r_uu, r_uv, r_vv, three components
/// each. Everything else — E, F, G, EG − F² and the Christoffel symbols — is
/// formed from them in plain arithmetic at each point (connectionAt), rather
/// than compiled as six symbols that would each repeat the metric.
func surfaceDerivatives(_ r: [Expr], _ d: (Expr, String) throws -> Expr, _ params: [String] = ["u", "v"]) throws
  -> [Expr]
{
  if r.count != 3 { throw LanguageError("A surface has three components, like (u, v, u^2 - v^2).") }
  let (a, b) = (params[0], params[1])
  let ru = try r.map { try d($0, a) }
  let rv = try r.map { try d($0, b) }
  let ruu = try ru.map { try d($0, a) }
  let ruv = try ru.map { try d($0, b) }
  let rvv = try rv.map { try d($0, b) }
  return ru + rv + ruu + ruv + rvv
}

/// The connection at a point from surfaceDerivatives' 15 numbers there:
/// Γᵘ_uu, Γᵘ_uv, Γᵘ_vv, Γᵛ_uu, Γᵛ_uv, Γᵛ_vv, then E, F, G and EG − F² (from
/// the cross product).
func connectionAt(_ r: [Double], _ out: inout [Double]) {
  let (ux, uy, uz, vx, vy, vz) = (r[0], r[1], r[2], r[3], r[4], r[5])
  let E = ux * ux + uy * uy + uz * uz
  let F = ux * vx + uy * vy + uz * vz
  let G = vx * vx + vy * vy + vz * vz
  let nx = uy * vz - uz * vy
  let ny = uz * vx - ux * vz
  let nz = ux * vy - uy * vx
  let det = nx * nx + ny * ny + nz * nz
  for ij in 0..<3 {
    let k = 6 + 3 * ij
    let a = r[k] * ux + r[k + 1] * uy + r[k + 2] * uz
    let b = r[k] * vx + r[k + 1] * vy + r[k + 2] * vz
    out[ij] = (G * a - F * b) / det
    out[3 + ij] = (E * b - F * a) / det
  }
  out[6] = E
  out[7] = F
  out[8] = G
  out[9] = det
}

/// −Γᵏ_ij w^i w^j: the parameter acceleration of a geodesic at velocity w.
func geodesicAcceleration(_ g: [Double], _ w1: Double, _ w2: Double) -> (Double, Double) {
  let a = w1 * w1
  let b = 2 * w1 * w2
  let c = w2 * w2
  return (-(g[0] * a + g[1] * b + g[2] * c), -(g[3] * a + g[4] * b + g[5] * c))
}

/// A surface's connection as numbers: at (p, q), connectionAt's ten numbers
/// written into `out`.
typealias GeodesicSystem = (_ p: Double, _ q: Double, _ out: inout [Double]) -> Void

/// A surface's geodesic flow, at unit speed in its metric (`surfaceFlow`).
/// The state is [p, q, p′, q′].
private final class SurfaceFlow {
  let sys: GeodesicSystem
  var g = [Double](repeating: 0, count: 10)

  init(_ sys: @escaping GeodesicSystem) { self.sys = sys }

  /// The rates of the velocity at state y: (d²p/ds², d²q/ds²).
  func accel(_ y: [Double]) -> (Double, Double) {
    sys(y[0], y[1], &g)
    return geodesicAcceleration(g, y[2], y[3])
  }

  /// The velocity of state y put back to unit speed, in place, so drift does
  /// not build up; false where the metric degenerates or blows up there (a
  /// pole).
  func normalize(_ y: inout [Double]) -> Bool {
    sys(y[0], y[1], &g)
    let (E, F, G, det) = (g[6], g[7], g[8], g[9])
    let scale = JS.max([abs(E), abs(G)])
    if !(det > 1e-12 * scale * scale) || !det.isFinite { return false }
    let (w1, w2) = (y[2], y[3])
    let s2 = E * w1 * w1 + 2 * F * w1 * w2 + G * w2 * w2
    if !(s2 > 0) || !s2.isFinite { return false }
    let s = s2.squareRoot()
    y[2] = w1 / s
    y[3] = w2 / s
    return true
  }
}

struct GeodesicOptions {
  var start: (Double, Double)
  /// The starting direction in the parameters; its length does not matter.
  var direction: (Double, Double)
  /// Arc length to run, on the surface; negative runs back along −direction.
  var length: Double
  /// The parameters' ranges: a geodesic stops where it leaves one…
  var domain: [(Double, Double)]
  /// …unless the surface repeats across it (a torus's angles).
  var periodic = (false, false)
  /// The longest gap between drawn points, in arc length: each step, which
  /// the controller makes as long as the accuracy allows, is filled in by
  /// its cubic Hermite interpolant (from the point and velocity at both ends,
  /// no more evaluations). Without it, only the steps' own points.
  var spacing: Double? = nil
  /// Points to draw at most; past them only the steps' own points.
  var maxPoints: Int? = nil
  /// Steps to take at most (GEODESIC_MAX_STEPS).
  var maxSteps: Int? = nil
  /// Asked every sixteenth step: past its time, it stops where it has got to
  /// (the site's `deadline`, a reading of its clock; the core has none).
  var outOfTime: (() -> Bool)? = nil
}

/// How a geodesic ended: the arc length it ran, out of `asked`, and whether
/// it ran out of its budget rather than reached an end of its own.
public struct GeodesicEnd: Equatable, Sendable {
  public var length = 0.0
  public var asked = 0.0
  public var budget = false

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
private let B4: [Double] = [
  5179.0 / 57600, 0, 7571.0 / 16695, 393.0 / 640, -92097.0 / 339200, 187.0 / 2100, 1.0 / 40,
]

/// Coordinate c of the cubic Hermite interpolant of a step of length h from
/// y to z (position and velocity, [p, q, p′, q′]), at the fraction t.
private func hermite(_ y: [Double], _ z: [Double], _ h: Double, _ c: Int, _ t: Double) -> Double {
  let t2 = t * t
  let t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * y[c] + (t3 - 2 * t2 + t) * h * y[c + 2] + (-2 * t3 + 3 * t2) * z[c] + (t3 - t2) * h
    * z[c + 2]
}

/// The geodesic from `start` in `direction`, as parameter points (p, q), from
/// the start to where it ends: after `length` of arc, where it leaves the
/// domain (cut at the edge), where the metric degenerates (a sphere's pole, a
/// cone's apex: EG − F² falls to nothing beside E and G) or stops being
/// defined, or when its step or time budget runs out. It runs at unit speed —
/// the velocity is put back to length 1 in the metric after every step — with
/// adaptive Dormand–Prince steps, so the arc length is the step variable.
/// `ended` is filled in with how far it ran, and whether its budget is what
/// stopped it short of `length`.
func traceGeodesic(_ sys: @escaping GeodesicSystem, _ opts: GeodesicOptions, ended: inout GeodesicEnd)
  -> [(Double, Double)]
{
  let domain = opts.domain
  let flow = SurfaceFlow(sys)
  let maxSteps = opts.maxSteps ?? GEODESIC_MAX_STEPS
  // A real cap, met by giving up points where the line runs straight
  // (decimate), so tight turns keep theirs.
  let maxPoints = max(opts.maxPoints ?? .max, 3)
  let periodic = opts.periodic
  let back = opts.length < 0
  let total = abs(opts.length)
  let (p0, q0) = opts.start
  var out: [(Double, Double)] = []
  func inside(_ p: Double, _ q: Double) -> Bool {
    (periodic.0 || (p >= domain[0].0 && p <= domain[0].1)) && (periodic.1 || (q >= domain[1].0 && q <= domain[1].1))
  }
  if !p0.isFinite || !q0.isFinite || !inside(p0, q0) { return out }
  let sign: Double = back ? -1 : 1
  // The state: position, then velocity.
  let D = 4
  var y = [p0, q0, sign * opts.direction.0, sign * opts.direction.1]
  let started = flow.normalize(&y)
  out.append((p0, q0))
  ended = GeodesicEnd()
  ended.asked = total
  if !started || !(total > 0) { return out }
  func f(_ y: [Double], _ k: inout [Double]) {
    let rates = flow.accel(y)
    k[0] = y[2]
    k[1] = y[3]
    k[2] = rates.0
    k[3] = rates.1
  }
  var ks = [[Double]](repeating: [Double](repeating: 0, count: D), count: 7)
  var tmp = [Double](repeating: 0, count: D)
  f(y, &ks[0])
  // Tolerances: the parameters against their ranges, the velocity against
  // its starting size.
  let span = [domain[0].1 - domain[0].0, domain[1].1 - domain[1].0].map { $0.isFinite && $0 > 0 ? $0 : 1 }
  let largest = JS.max([abs(y[2]), abs(y[3])])
  let vscale = largest == 0 || largest.isNaN ? 1 : largest
  let reach = total.isFinite ? total : 1
  let atol = [TOLERANCE * span[0], TOLERANCE * span[1], TOLERANCE * vscale, TOLERANCE * vscale]
  let hMin = reach * 1e-12
  var s = 0.0
  // A first step a hundredth of the way; the controller takes it from there.
  var h = reach / 100
  var steps = 0
  var outOfBudget = false
  while s < total {
    if steps >= maxSteps || ((steps & 15) == 15 && opts.outOfTime?() == true) {
      outOfBudget = true
      break
    }
    h = JS.min([h, total - s])
    for i in 1..<7 {
      for c in 0..<D {
        var acc = y[c]
        for j in 0..<i { acc += h * A[i][j] * ks[j][c] }
        tmp[c] = acc
      }
      f(tmp, &ks[i])
    }
    var next = [Double](repeating: 0, count: D)
    var err = 0.0
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
    if !err.isFinite {
      // Off the surface's domain of definition: shorten toward it, and stop
      // once the step is nothing.
      h /= 4
      if h < hMin { break }
      continue
    }
    if err > 1 {
      h = JS.max([h * JS.max([0.2, 0.9 * JS.pow(err, -0.2)]), hMin])
      if h <= hMin { break }
      continue
    }
    steps += 1
    // The points between, along the step's interpolant (its velocity ends
    // as integrated, before it is put back to unit length).
    var pieces = 1
    if let spacing = opts.spacing, spacing != 0, !spacing.isNaN {
      // (Math.min(256, Math.ceil(h / spacing)); a NaN count draws no piece.)
      let count = (h / spacing).rounded(.up)
      pieces = count.isNaN ? 0 : Int(JS.min([256, count]))
    }
    let from = y
    func along(_ t: Double) -> (Double, Double) { (hermite(from, next, h, 0, t), hermite(from, next, h, 1, t)) }
    func insideAt(_ t: Double) -> Bool {
      let p = along(t)
      return inside(p.0, p.1)
    }
    if !inside(next[0], next[1]) {
      // Cut at the first edge it crosses: the first piece that leaves, then
      // bisection along the interpolant within it.
      var t0 = 0.0
      var t1 = 1.0
      if pieces >= 1 {
        for k in 1...pieces {
          let t = Double(k) / Double(pieces)
          if !insideAt(t) {
            t1 = t
            break
          }
          t0 = t
          out.append(along(t))
        }
      }
      for _ in 0..<50 {
        let t = (t0 + t1) / 2
        if insideAt(t) { t0 = t } else { t1 = t }
      }
      // On the edge exactly, in the coordinate that crossed it.
      var edge = along(t0)
      let crossed = along(t1)
      if !periodic.0 {
        if crossed.0 < domain[0].0 { edge.0 = domain[0].0 } else if crossed.0 > domain[0].1 { edge.0 = domain[0].1 }
      }
      if !periodic.1 {
        if crossed.1 < domain[1].0 { edge.1 = domain[1].0 } else if crossed.1 > domain[1].1 { edge.1 = domain[1].1 }
      }
      out.append(edge)
      break
    }
    // Back on the constraint: the drift is rounding and truncation, and the
    // arc length s is then the parameter the steps are taken in. Where the
    // metric degenerates (a pole), end at the last good point.
    var settled = next
    if !flow.normalize(&settled) { break }
    if pieces > 1 { for k in 1..<pieces { out.append(along(Double(k) / Double(pieces))) } }
    y = settled
    s += h
    out.append((y[0], y[1]))
    // Held to a few times its points as it goes, and to them at the end.
    if maxPoints < .max / 8, out.count > 8 * maxPoints { decimate(&out, 4 * maxPoints) }
    f(y, &ks[0])
    h = h * JS.min([5, 0.9 * JS.pow(JS.max([err, 1e-10]), -0.2)])
  }
  ended.length = s
  ended.asked = total
  ended.budget = outOfBudget
  decimate(&out, maxPoints)
  return out
}

/// A path cut down in place to at most `target` points, keeping its shape:
/// walking along it, a point is kept once the line has turned more than θ
/// since the last one kept, or run on a set length (the whole length over
/// half the target), and θ is the smallest that fits — so tight turns keep
/// their points and straight runs give theirs up. The ends stay.
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
    seg[i] = (dx * dx + dy * dy).squareRoot()
    length += seg[i]
  }
  let reach = length / max(1, Double(target - 2) / 2)
  /// The points kept with turn θ, written into `keep` when given.
  func run(_ theta: Double, _ keep: inout [Bool]) -> Int {
    var count = 1
    var ref = heading[0]
    var run = 0.0
    for i in 1..<(n - 1) {
      run += seg[i - 1]
      var turn = heading[i] - ref
      turn -= 2 * Double.pi * JS.round(turn / (2 * Double.pi))
      if abs(turn) > theta || run > reach {
        count += 1
        if !keep.isEmpty { keep[i] = true }
        ref = heading[i]
        run = 0
      }
    }
    return count + 1
  }
  var lo = 0.0
  var hi = Double.pi
  var none: [Bool] = []
  for _ in 0..<30 {
    let mid = (lo + hi) / 2
    if run(mid, &none) > target { lo = mid } else { hi = mid }
  }
  var keep = [Bool](repeating: false, count: n)
  keep[0] = true
  keep[n - 1] = true
  _ = run(hi, &keep)
  out = out.indices.filter { keep[$0] }.map { out[$0] }
}

/// Whether the surface P repeats across each parameter's range: P(p + span,
/// q) = P(p, q) at a spread of points (a torus's angles, a sphere's
/// longitude), so a geodesic runs on across that edge rather than stopping.
func periodicAxes(_ P: (Double, Double) -> [Double], _ domain: [(Double, Double)]) -> (Bool, Bool) {
  let (p0, p1) = domain[0]
  let (q0, q1) = domain[1]
  let sp = p1 - p0
  let sq = q1 - q0
  func test(_ shift: (Double, Double) -> (Double, Double)) -> Bool {
    var any = false
    for i in 0..<5 {
      for j in 0..<5 {
        let p = p0 + (sp * (Double(i) + 0.37)) / 5
        let q = q0 + (sq * (Double(j) + 0.41)) / 5
        let a = P(p, q)
        let moved = shift(p, q)
        let b = P(moved.0, moved.1)
        if !a.allSatisfy(\.isFinite) || !b.allSatisfy(\.isFinite) { continue }
        let size = JS.max([1] + a.map { abs($0) })
        if a.indices.contains(where: { abs(a[$0] - b[$0]) > 1e-9 * size }) { return false }
        any = true
      }
    }
    return any
  }
  return (sp.isFinite && sp > 0 && test { ($0 + sp, $1) }, sq.isFinite && sq > 0 && test { ($0, $1 + sq) })
}

/// The length a geodesic runs by default: twice the diagonal of the box
/// round the surface — once round a sphere and a little more, across a
/// patch and out of it.
public func defaultGeodesicLength(_ P: (Double, Double) -> [Double], _ domain: [(Double, Double)]) -> Double {
  var lo = [Double](repeating: .infinity, count: 3)
  var hi = [Double](repeating: -.infinity, count: 3)
  let (p0, p1) = domain[0]
  let (q0, q1) = domain[1]
  let n = 16
  for i in 0...n {
    for j in 0...n {
      let pt = P(p0 + ((p1 - p0) * Double(i)) / Double(n), q0 + ((q1 - q0) * Double(j)) / Double(n))
      if !pt.allSatisfy(\.isFinite) { continue }
      for k in 0..<min(3, pt.count) {
        lo[k] = JS.min([lo[k], pt[k]])
        hi[k] = JS.max([hi[k], pt[k]])
      }
    }
  }
  var sum = 0.0
  for k in 0..<3 where hi[k] > lo[k] { sum += (hi[k] - lo[k]) * (hi[k] - lo[k]) }
  let diagonal = sum.squareRoot()
  return diagonal.isFinite && diagonal > 0 ? 2 * diagonal : 1
}

/// Expressions in the parameters (and in `env`'s names, at their values) as
/// one function of (p, q). A value that cannot be had is NaN (`numericIn`).
///
/// Port: the site compiles each for its stack machine, with a name that has
/// no value as NaN; here they are the closures a measurement evaluates
/// (`pointFn`), which walk the tree where they cannot be made.
public func numericIn(_ exprs: [Expr], _ params: [String], _ env: [String: Double] = [:])
  -> (_ p: Double, _ q: Double) -> [Double]
{
  var constants = env
  // (The parameters are the point's, whatever a constant of their name holds.)
  for name in params { constants[name] = nil }
  let fns = exprs.map { pointFn($0, params, constants) }
  return { p, q in
    let at = [p, q]
    return fns.map { $0(at) }
  }
}

/// A surface's connection as numbers, from its surfaceDerivatives, its
/// sliders read from `env`: one evaluation of the 15 derivatives a point.
func geodesicSystem(_ derivatives: [Expr], _ params: [String] = ["u", "v"], _ env: [String: Double] = [:])
  -> GeodesicSystem
{
  let at = numericIn(derivatives, params, env)
  return { p, q, out in connectionAt(at(p, q), &out) }
}

/// The gain a diverging colouring multiplies a scalar on a surface by before
/// tanh, so its typical size reads as strong colour: 1.5 over the 90th
/// percentile of |f| at a lattice of points (the largest few are left out, as
/// curvature runs off to infinity at a cusp). `fallback` when f is no larger
/// than `floor` (rounding: a plane's K) everywhere, or nowhere defined.
/// `n` + 1 is the lattice's side.
public func divergingGain(
  _ f: (Double, Double) -> Double, _ domain: [(Double, Double)], floor: Double = 0, fallback: Double = 1, n: Int = 24
) -> Double {
  let (p0, p1) = domain[0]
  let (q0, q1) = domain[1]
  var sizes: [Double] = []
  for i in 0...n {
    for j in 0...n {
      let p = p0 + ((p1 - p0) * (Double(i) + 0.5)) / Double(n + 1)
      let q = q0 + ((q1 - q0) * (Double(j) + 0.5)) / Double(n + 1)
      let k = abs(f(p, q))
      if k.isFinite { sizes.append(k) }
    }
  }
  if sizes.isEmpty { return fallback }
  sizes.sort()
  let p90 = sizes[Int((0.9 * Double(sizes.count - 1)).rounded(.down))]
  return p90 > floor ? 1.5 / p90 : fallback
}

/// What a geodesic row draws (lib/analysis.ts `classifyGeodesic`).
public struct GeodesicSpec: Equatable, Hashable, Sendable {
  /// 3: on the surface, in space; 2: in the parameters themselves (a panel's
  /// x and y), for an on(…) panel to carry onto its surface.
  public var dim: Int
  public var params: [String]
  /// The surface in the parameters.
  public var surface: [Expr]
  /// Its first and second derivatives (surfaceDerivatives).
  public var derivatives: [Expr]
  public var start: [Expr]
  public var direction: [Expr]
  /// Arc length; when absent, defaultGeodesicLength.
  public var length: Expr?
  /// The parameters' ranges: lo and hi of the first, then of the second.
  public var domain: [Expr]

  public init(
    dim: Int, params: [String], surface: [Expr], derivatives: [Expr], start: [Expr], direction: [Expr],
    length: Expr?, domain: [Expr]
  ) {
    self.dim = dim
    self.params = params
    self.surface = surface
    self.derivatives = derivatives
    self.start = start
    self.direction = direction
    self.length = length
    self.domain = domain
  }
}

/// What a geodesic's trace depends on besides the values of the names it
/// reads, as a string: its plan — the surface, start, direction, length and
/// domain as written in, after lists and definitions are inlined, which an
/// edit to another row (S's formula, a list of directions, the panel's
/// surface) changes. It is traced again when this or those values change.
public func geodesicPlanKey(_ spec: GeodesicSpec) -> String {
  var key = "\(spec.dim)|\(spec.params)"
  for list in [spec.surface, spec.start, spec.direction, spec.domain] {
    key += "|" + list.map(exprKey).joined(separator: ",")
  }
  return key + "|" + (spec.length.map(exprKey) ?? "null")
}

/// The note for a geodesic its budget stopped short, or nil.
public func geodesicCutNote(_ end: GeodesicEnd) -> String? {
  if !end.budget || !(end.length < end.asked) { return nil }
  func n(_ x: Double) -> String { JS.string(JS.number(JS.toPrecision(x, 3))) }
  return "cut short at L ≈ \(n(end.length)) of \(n(end.asked))"
}

/// Points a geodesic is drawn with along the size of its surface's box, at
/// least where its length allows.
private let DRAWN_ACROSS = 150.0
/// Points a geodesic is drawn with at most, unless its budget says fewer.
public let GEODESIC_MAX_POINTS = 4000

/// The geodesic a row draws, at the values in `env` (sliders, t, a named
/// point's coordinates): its points on the surface in space, flat — for a
/// panel's surface too (dim 2), which so need not carry them itself.
/// Empty when its domain cannot be had; the start alone when it has no
/// direction. `maxSteps` and `outOfTime` cap its steps and the time it may
/// take (traceGeodesic), and `maxPoints` the points it is drawn with, so a
/// long one, or many, cannot run on unbounded.
public func geodesicPath(
  _ spec: GeodesicSpec, _ env: [String: Double], maxSteps: Int? = nil, maxPoints given: Int? = nil,
  outOfTime: (() -> Bool)? = nil, ended: inout GeodesicEnd
) -> [Double] {
  let maxPoints = given ?? GEODESIC_MAX_POINTS
  let v = numericIn(spec.start + spec.direction + spec.domain + [spec.length ?? num(.nan)], spec.params, env)(
    .nan, .nan)
  let domain = [(v[4], v[5]), (v[6], v[7])]
  if !(v[5] > v[4]) || !(v[7] > v[6]) || !v[4...7].allSatisfy(\.isFinite) { return [] }
  let embed = numericIn(spec.surface, spec.params, env)
  func P(_ p: Double, _ q: Double) -> [Double] { embed(p, q) }
  let size = defaultGeodesicLength(P, domain)
  let length = spec.length != nil ? v[8] : size
  if !length.isFinite { return [] }
  let sys = geodesicSystem(spec.derivatives, spec.params, env)
  let path = traceGeodesic(
    sys,
    GeodesicOptions(
      start: (v[0], v[1]), direction: (v[2], v[3]), length: length, domain: domain, periodic: periodicAxes(P, domain),
      spacing: JS.max([size / 2 / DRAWN_ACROSS, abs(length) / Double(maxPoints)]), maxPoints: maxPoints,
      maxSteps: maxSteps, outOfTime: outOfTime),
    ended: &ended)
  var pts: [Double] = []
  pts.reserveCapacity(3 * path.count)
  for (p, q) in path { pts += P(p, q) }
  return pts
}

/// What a geodesic anywhere but as its whole row says (lib/defs.ts, the
/// resolver's call case).
let geodesicInsideARow = LanguageError(
  "geodesic(S, (u0, v0), (du, dv)) draws a curve, so it must be the whole row — on a panel drawn on a "
    + "surface, geodesic(P, (dx, dy)).")

private let GEODESIC_USAGE =
  "geodesic takes a surface, where to start on it and which way: geodesic(S, (0.5, 0.5), (1, 0)) with "
  + "S = (u, v, u^2 - v^2), and optionally how far, geodesic(S, P, (1, 0), 4)."
private let PANEL_GEODESIC_USAGE =
  "On a panel drawn on a surface, geodesic takes where to start and which way, in x and y: "
  + "geodesic((0, 0.5), (1, 0)) or geodesic(P, (1, 1), 6)."

/// A geodesic row: geodesic(S, (u0, v0), (du, dv)[, L]), or on a panel drawn
/// on a surface (an on(…) row) geodesic((x0, y0), (dx, dy)[, L]) on that
/// surface, in the panel's x and y. The surface's first and second
/// derivatives are expanded here (`surfaceDerivatives`), and the Christoffel
/// symbols formed from them at each point as the curve is traced, so the
/// start, direction and length may move with sliders, t and named points. A
/// list of starts, directions or lengths draws one geodesic per element, a
/// family (lib/analysis.ts `classifyGeodesic`).
///
/// `surfaceOperand` reads the first argument as a surface in u and v, over
/// their intervals where they are ones; `lower` resolves and lowers a start,
/// direction or length (a list of them as its items).
func classifyGeodesic(
  _ args: [Expr], surface: SurfaceMap?,
  surfaceOperand: (Expr) throws -> (items: [Expr], over: (u: Expr?, v: Expr?)), lower: (Expr) throws -> Expr,
  constNames: Set<String>, moving: Set<String>
) throws -> Classified {
  var operand: (items: [Expr], over: (u: Expr?, v: Expr?))?
  var failure: Error?
  if args.count >= 3 {
    do {
      operand = try surfaceOperand(args[0])
    } catch let error as Unsupported {
      throw error
    } catch {
      failure = error
    }
  }
  let panelForm = operand == nil && (args.count == 2 || args.count == 3)
  let onPanel = panelForm && surface != nil
  if operand == nil && !onPanel {
    if args.count == 2 {
      throw LanguageError(
        "geodesic(P, d) draws on its panel's surface (an on(…) row), and this panel has none. \(GEODESIC_USAGE)")
    }
    if let failure, args.count >= 3 { throw failure }
    throw LanguageError(GEODESIC_USAGE)
  }
  if operand != nil && args.count > 4 { throw LanguageError(GEODESIC_USAGE) }
  let name = "geodesic"
  let usage = onPanel ? PANEL_GEODESIC_USAGE : GEODESIC_USAGE
  let params = onPanel ? ["x", "y"] : ["u", "v"]
  let items = operand?.items ?? surface!.embed
  // The parameters' ranges: u's and v's intervals where they are defined as
  // ones, else [0, 1]; the panel's x and y ranges.
  func range(_ over: Expr?) -> [Expr] {
    if case .call(_, let bounds)? = over, bounds.count >= 2 { return [bounds[0], bounds[1]] }
    return [num(0), num(1)]
  }
  let domain = operand.map { range($0.over.u) + range($0.over.v) } ?? (surface!.x + surface!.y).map(num)
  // The connection is formed from these at each point as it is traced.
  let derivatives = try surfaceDerivatives(items, smoothPartial, params)
  // (The site counts the list of them as a node too.)
  if 1 + derivatives.reduce(0, { $0 + countNodes($1, limit: 4 * flowNodeLimit) }) > 4 * flowNodeLimit {
    throw LanguageError("This surface is too large to trace geodesics on.")
  }
  // Where it starts, which way and how far, each one value or a list.
  let rest = operand != nil ? Array(args.dropFirst()) : args
  func elements(_ e: Expr, _ size: Int, _ what: String) throws -> [[Expr]] {
    let lowered = try lower(e)
    var each = [lowered]
    if case .list(let listed) = lowered { each = listed }
    return try each.map { item in
      var parts: [Expr] = []
      if size == 1 { parts = [item] } else if case .vec(let comps) = item { parts = comps }
      let nested = parts.contains {
        switch $0 {
        case .vec, .list: true
        default: false
        }
      }
      if parts.count != size || nested {
        throw LanguageError("\(name): \(what) is \(size == 1 ? "one number" : "a pair, like (1, 0)"). \(usage)")
      }
      for p in parts {
        for n in freeVars(p) where n != "t" && !constNames.contains(n) {
          let found = n == params[0] || n == params[1] ? ", not \(n)" : " (found \(n))"
          throw LanguageError("\(name): \(what) is numbers, sliders, t and named points\(found). \(usage)")
        }
      }
      return parts
    }
  }
  let starts = try elements(rest[0], 2, "where it starts")
  let directions = try elements(rest[1], 2, "its direction")
  let lengths: [[Expr]] = rest.count > 2 ? try elements(rest[2], 1, "its length") : [[]]
  let n = max(starts.count, directions.count, lengths.count)
  for list in [starts, directions, lengths] where list.count != 1 && list.count != n {
    throw LanguageError(
      "\(name): lists of starts, directions and lengths go element by element, so they must be as long.")
  }
  if n > 64 { throw LanguageError("A family of geodesics has at most 64 members.") }
  func member(_ k: Int) -> Classified {
    func pick(_ list: [[Expr]]) -> [Expr] { list[list.count == 1 ? 0 : k] }
    let spec = GeodesicSpec(
      dim: operand != nil ? 3 : 2, params: params, surface: items, derivatives: derivatives, start: pick(starts),
      direction: pick(directions), length: rest.count > 2 ? pick(lengths)[0] : nil, domain: domain)
    var used = NameSet()
    for e in items + derivatives + domain + pick(starts) + pick(directions) + pick(lengths) {
      for name in freeVars(e) { used.insert(name) }
    }
    return Classified(
      object: .geodesic(spec), animated: used.list.contains { $0 == "t" || moving.contains($0) },
      needs3D: operand != nil, params: jsSorted(used.list.filter(constNames.contains)))
  }
  let members = (0..<n).map(member)
  if n == 1 { return members[0] }
  var params_: [String] = []
  for m in members { for p in m.params where !params_.contains(p) { params_.append(p) } }
  return Classified(
    object: .family(members: members, shared: nil), animated: members.contains(where: \.animated),
    needs3D: operand != nil, params: jsSorted(params_))
}

/// A geodesic row as the analysis reads it: `classifyGeodesic` with the
/// document's resolver. (Apart from `analyze`, whose frame the rows' deepest
/// expressions are resolved under.)
func geodesicRow(
  _ args: [Expr], _ surface: SurfaceMap?, _ getFn: @escaping GetFn, _ ropts: ResolveOpts, _ built: BuiltDefs,
  _ constNames: Set<String>, _ moving: Set<String>
) throws -> Classified {
  return try classifyGeodesic(
    args, surface: surface,
    surfaceOperand: { arg in
      var written = arg
      if case .var(let name) = arg, try getFn(name) != nil {} else {
        written = try Resolver(getFn: getFn, opts: ropts).resolve(arg)
      }
      return try Resolver(getFn: getFn, opts: ropts).surfaceOperand("geodesic", written)
    },
    lower: { try lowerObjects(try Resolver(getFn: getFn, opts: ropts).resolve($0), built, ropts).e },
    constNames: constNames, moving: moving)
}
