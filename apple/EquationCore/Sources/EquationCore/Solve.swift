/// Numeric solution of a square system F(p) = 0 in 2 or 3 real unknowns
/// (lib/solve.ts).
///
/// One unknown has an exact enumerator (poly.ts, via roots.ts): every root
/// once, with its true multiplicity. Nothing like that exists for arbitrary
/// expressions in several unknowns, so this is a seeded search — damped Newton
/// from a lattice of starts spread over the view box, then dedupe. The
/// Jacobian is symbolic when the residuals differentiate and finite
/// differences otherwise, the same fallback roots.ts uses.
///
/// Seeds are a deterministic function of their index (a hashed lattice, never
/// random), so re-solving the same box returns the same points in the same
/// order. Markers would otherwise jitter between frames.
///
/// The search is honest but not certified: it reports what it finds, and a
/// root can hide between seeds. Isolating every solution needs interval
/// subdivision with a Krawczyk/Newton existence test — the natural next step,
/// and the reason this lives behind a narrow interface.

// The C library, for the angular residuals' sin, cos and atan2 alone.
#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// lib/expr.ts `evaluate`: a scalar expression's value under the bindings.
/// The solvers use the core's (Evaluate.swift) unless they are handed another.
public typealias Evaluator = (Expr, [String: Double]) throws -> Double

/// Newton iterations per seed. Converging seeds take well under 20.
private let MAX_ITER = 64
/// Step halvings before a seed is abandoned.
private let MAX_BACKTRACK = 24
/// Lattice divisions per axis; 2D can afford a finer net than 3D.
private let LATTICE = [2: 24, 3: 6]
/// Solutions returned at most, so a degenerate system cannot flood the scene.
private let MAX_SOLUTIONS = 64
/// Midpoint solves spent refining one traced chord until it hugs the curve.
private let REFINE_BUDGET = 128

public struct SolveOptions: Sendable {
  /// Extra values in scope (constants, t). Unknowns are overwritten per step.
  public var env: [String: Double]
  /// Fraction of the box width a solution may sit outside and still count.
  public var margin: Double
  /// Warm starts, tried before the deterministic lattice.
  public var seeds: [[Double]]
  /// Disable the lattice while following already discovered branches.
  public var lattice: Bool
  /// Coordinate residuals measured modulo 2pi; ordinary equations never wrap.
  public var angular: [Bool]

  public init(
    env: [String: Double] = [:], margin: Double = 0.05, seeds: [[Double]] = [], lattice: Bool = true,
    angular: [Bool] = []
  ) {
    self.env = env
    self.margin = margin
    self.seeds = seeds
    self.lattice = lattice
    self.angular = angular
  }
}

/// Math.hypot as V8 computes it: scaled by the largest magnitude, summed with
/// Kahan's compensation. The solver's convergence tests compare these norms,
/// so they are taken the same way to the bit.
private func hypot(_ values: [Double]) -> Double {
  var largest = 0.0
  var undefined = false
  for value in values {
    if value.isNaN { undefined = true }
    largest = max(largest, abs(value))
  }
  if largest == .infinity { return .infinity }
  if undefined { return .nan }
  if largest == 0 { return 0 }
  var sum = 0.0
  var compensation = 0.0
  for value in values {
    let n = abs(value) / largest
    let summand = n * n - compensation
    let preliminary = sum + summand
    compensation = (preliminary - sum) - summand
    sum = preliminary
  }
  return sum.squareRoot() * largest
}

/// JavaScript's Array.prototype.sort: stable, which Swift's does not promise.
func stableSorted<T>(_ items: [T], _ before: (T, T) -> Bool) -> [T] {
  items.enumerated().sorted { a, b in
    if before(a.element, b.element) { return true }
    if before(b.element, a.element) { return false }
    return a.offset < b.offset
  }.map(\.element)
}

/// Every solution of `residuals = 0` found inside the box, as coordinate
/// tuples in the order of `vars`. `lo`/`hi` are per-unknown bounds.
public func solveSystem(
  _ residuals: [Expr], _ vars: [String], _ lo: [Double], _ hi: [Double], _ opts: SolveOptions = SolveOptions(),
  evaluate: Evaluator = evaluate
) -> [[Double]] {
  let n = residuals.count
  if n != vars.count || (n != 2 && n != 3) { return [] }
  // (The TypeScript reads a bound that is not there as undefined, and so
  // finds nothing; here a box of the wrong size is refused outright.)
  if lo.count != n || hi.count != n { return [] }
  for k in 0..<n where !(hi[k] > lo[k]) || !lo[k].isFinite || !hi[k].isFinite { return [] }

  let angular = (0..<n).map { $0 < opts.angular.count && opts.angular[$0] }
  func wrap(_ v: Double) -> Double { atan2(sin(v), cos(v)) }
  var env = opts.env
  let margin = opts.margin

  // Symbolic Jacobian where it exists; nil entries fall back to differences.
  let jac: [[Expr?]] = residuals.map { r in vars.map { v in try? diff(r, v) } }

  func evalAt(_ e: Expr) -> Double { (try? evaluate(e, env)) ?? .nan }
  func setPoint(_ p: [Double]) {
    for k in 0..<n { env[vars[k]] = p[k] }
  }
  func residualAt(_ p: [Double], _ out: inout [Double]) -> Bool {
    setPoint(p)
    for i in 0..<n {
      let v = evalAt(residuals[i])
      if !v.isFinite { return false }
      out[i] = angular[i] ? wrap(v) : v
    }
    return true
  }
  /// Row-major Jacobian at p; false if any entry is not finite.
  func jacobianAt(_ p: [Double], _ out: inout [[Double]]) -> Bool {
    for i in 0..<n {
      for j in 0..<n {
        let v: Double
        if let sym = jac[i][j] {
          setPoint(p)
          v = evalAt(sym)
        } else {
          let h = 1e-6 * (1 + abs(p[j]))
          var q = p
          q[j] = p[j] + h
          setPoint(q)
          let a = evalAt(residuals[i])
          q[j] = p[j] - h
          setPoint(q)
          let b = evalAt(residuals[i])
          v = (angular[i] ? wrap(a - b) : a - b) / (2 * h)
        }
        if !v.isFinite { return false }
        out[i][j] = v
      }
    }
    return true
  }

  let norm: ([Double]) -> Double = hypot
  var r = [Double](repeating: 0, count: n)
  var rTrial = [Double](repeating: 0, count: n)
  var J = [[Double]](repeating: [Double](repeating: 0, count: n), count: n)

  let width = (0..<n).map { hi[$0] - lo[$0] }
  let boxScale = width.max()!

  /// Backward error: the residual has reached the noise floor of evaluating a
  /// linearization this steep at this point. An absolute threshold would
  /// reject badly scaled systems and accept flat ones.
  func converged(_ p: [Double], _ res: [Double]) -> Bool {
    var scale = 1.0
    for i in 0..<n {
      for k in 0..<n { scale = max(scale, abs(J[i][k]) * (1 + abs(p[k]))) }
    }
    return norm(res) <= 1e-11 * scale * max(1, boxScale)
  }

  /// Damped Newton from one seed; nil when it fails to converge.
  func refine(_ seed: [Double]) -> [Double]? {
    var p = seed
    if !residualAt(p, &r) { return nil }
    var rn = norm(r)
    var previous: [Double]? = nil
    var older: [Double]? = nil
    for _ in 0..<MAX_ITER {
      if rn == 0 { return p }
      if !jacobianAt(p, &J) { return nil }
      // Test with J freshly evaluated at p, so the scale matches the point.
      let solved = solveLinear(J, r, n)
      // A tiny residual alone is misleading near a multiple root (w^3=0).
      // Require positional convergence as well, otherwise one root becomes
      // a cloud of apparently distinct solutions.
      if converged(p, r), let solved, norm(solved) <= 1e-9 * (1 + norm(p)) { return p }
      guard let step = solved else { return nil }
      if converged(p, r), let earlier = older, let prior = previous {
        // Multiple roots make Newton converge only linearly. Extrapolate the
        // last three iterates to their common limit. Verify its Newton
        // correction too: a small residual at a nearby stationary point can
        // otherwise divert every seed from two distinct, close roots.
        let limit = (0..<n).map { k -> Double in
          let v = p[k]
          let before = prior[k] - earlier[k]
          let after = v - prior[k]
          let bend = after - before
          return abs(bend) > 1e-15 * max(abs(before), abs(after)) ? v - (after * after) / bend : v
        }
        if limit.allSatisfy(\.isFinite) && residualAt(limit, &rTrial) && norm(rTrial) < rn {
          if norm(rTrial) == 0 { return limit }
          if jacobianAt(limit, &J) {
            if let correction = solveLinear(J, rTrial, n), converged(limit, rTrial),
              norm(correction) <= 1e-9 * (1 + norm(limit))
            {
              return limit
            }
          }
        }
      }
      // Backtrack until the residual actually drops.
      var scale = 1.0
      var accepted = false
      for _ in 0..<MAX_BACKTRACK {
        let q = (0..<n).map { p[$0] - scale * step[$0] }
        if q.allSatisfy(\.isFinite) && residualAt(q, &rTrial) && norm(rTrial) < rn {
          older = previous
          previous = p
          for i in 0..<n {
            p[i] = q[i]
            r[i] = rTrial[i]
          }
          rn = norm(rTrial)
          accepted = true
          break
        }
        scale /= 2
      }
      if !accepted { break }  // stalled: either converged or stuck
    }
    return nil
  }

  var found: [[Double]] = []
  func same(_ a: [Double], _ b: [Double]) -> Bool {
    (0..<n).allSatisfy { abs(a[$0] - b[$0]) <= 1e-7 * (1 + max(abs(a[$0]), abs(b[$0]))) }
  }

  let div = LATTICE[n]!
  let total = opts.lattice ? (n == 2 ? div * div : div * div * div) : 0
  let seeds = opts.seeds
  for s in 0..<(total + seeds.count) {
    var seed: [Double] = []
    if s < seeds.count {
      seed = seeds[s]
    } else {
      let index = s - seeds.count
      var rest = index
      for k in 0..<n {
        let cell = rest % div
        rest /= div
        // Cell centre, nudged by a hash of the seed index so seeds do not line
        // up with the symmetry axes that so many systems are built around.
        seed.append(lo[k] + (width[k] * (Double(cell) + 0.5 + 0.32 * (hash(index * 3 + k) - 0.5))) / Double(div))
      }
    }
    guard let sol = refine(seed) else { continue }
    if (0..<n).contains(where: { sol[$0] < lo[$0] - margin * width[$0] || sol[$0] > hi[$0] + margin * width[$0] }) {
      continue
    }
    if found.contains(where: { same($0, sol) }) { continue }
    found.append(sol)
    if found.count >= MAX_SOLUTIONS { break }
  }

  // Stable order so colours and labels do not shuffle between redraws.
  return stableSorted(found) { a, b in
    for k in 0..<n where a[k] != b[k] { return a[k] < b[k] }
    return false
  }
}

/// Gaussian elimination with partial pivoting; nil when J is singular.
public func solveLinear(_ J: [[Double]], _ b: [Double], _ n: Int) -> [Double]? {
  var m = (0..<n).map { J[$0] + [b[$0]] }
  for i in 0..<n {
    var piv = i
    for k in (i + 1)..<max(n, i + 1) where abs(m[k][i]) > abs(m[piv][i]) { piv = k }
    if !(abs(m[piv][i]) > 1e-300) { return nil }
    m.swapAt(i, piv)
    for k in 0..<n where k != i {
      let f = m[k][i] / m[i][i]
      for j in i...n { m[k][j] -= f * m[i][j] }
    }
  }
  var out = [Double](repeating: 0, count: n)
  for i in 0..<n {
    out[i] = m[i][n] / m[i][i]
    if !out[i].isFinite { return nil }
  }
  return out
}

/// Deterministic [0,1) hash of a seed index (xorshift-style integer mix).
private func hash(_ i: Int) -> Double {
  // The TypeScript's product is a double, exact at these sizes, cut to 32
  // bits by the first shift; from there Math.imul is the wrapping multiply.
  var h = UInt32(truncatingIfNeeded: (i + 1) * 0x9e37_79b1)
  h ^= h >> 15
  h = h &* 0x85eb_ca6b
  h ^= h >> 13
  h = h &* 0xc2b2_ae35
  h ^= h >> 16
  return Double(h) / 4294967296
}

/// Trace moving constraints with warm starts and periodic branch discovery.
/// Unmatched or discontinuous branches start a new polyline, never a chord.
public func traceSystem(
  _ residuals: [Expr], _ vars: [String], _ lo: [Double], _ hi: [Double], _ env: [String: Double] = [:],
  _ samples: Int = 256, _ angular: [Bool] = [], evaluate: Evaluator = evaluate
) -> [[[Double]]] {
  var paths: [[[Double]]] = []
  /// The paths still being followed, as indices into `paths`.
  var active: [Int] = []
  func distance(_ p: [Double], _ q: [Double]) -> Double { hypot(p.indices.map { p[$0] - q[$0] }) }
  let scale = hypot(hi.indices.map { hi[$0] - lo[$0] })
  let maxStep = scale / 16
  // How far a chord may stray from the curve. The app traces a box padded
  // past the view and reuses it until a zoom of about 4×, so this keeps the
  // error under a pixel there (and a quarter pixel on a fresh trace).
  let flatness = scale / 8000

  // A small step on a curved path can hide a still smaller jump. Retain the
  // discrete operations so an interval crossing one receives extra continuity
  // probes before curvature alone is allowed to certify the chord.
  var discreteProbes: [Expr] = []
  func collectDiscrete(_ e: Expr) {
    switch e {
    case .call(let name, let args):
      if ["floor", "ceil", "round", "sign", "fract", "mod"].contains(name) { discreteProbes.append(e) }
      args.forEach(collectDiscrete)
    case .bin(_, let a, let b, _):
      collectDiscrete(a)
      collectDiscrete(b)
    case .neg(let a):
      collectDiscrete(a)
    case .eq(let l, let r), .ineq(_, let l, let r, _):
      collectDiscrete(l)
      collectDiscrete(r)
    case .vec(let items), .list(let items):
      items.forEach(collectDiscrete)
    case .piecewise(let cases, let otherwise):
      discreteProbes.append(e)
      for c in cases {
        collectDiscrete(c.cond)
        collectDiscrete(c.value)
      }
      if let otherwise { collectDiscrete(otherwise) }
    case .loop(_, let seeds, _, _):
      seeds.forEach(collectDiscrete)
    case .num, .var, .index, .range, .eqtest, .str, .comp, .figure, .trail, .label, .hist, .family, .data, .lazy,
      .text:
      break
    }
  }
  residuals.forEach(collectDiscrete)
  func discreteValue(_ probe: Expr, _ p: [Double], _ u: Double) -> Double {
    var scope = env
    scope["u"] = u
    for (k, name) in vars.enumerated() { scope[name] = p[k] }
    func at(_ e: Expr) -> Double { (try? evaluate(e, scope)) ?? .nan }
    switch probe {
    case .piecewise(let cases, _):
      for (i, c) in cases.enumerated() {
        guard case .ineq = c.cond else { return .nan }
        let holds = ineqComparisons(c.cond).allSatisfy { comparison in
          let a = at(comparison.l)
          let b = at(comparison.r)
          switch comparison.op {
          case .lt: return a < b
          case .le: return a <= b
          case .gt: return a > b
          case .ge: return a >= b
          }
        }
        if holds { return Double(i) }
      }
      return Double(cases.count)
    case .call("fract", let args):
      return args.isEmpty ? .nan : at(args[0]).rounded(.down)
    case .call("mod", let args):
      return args.count < 2 ? .nan : (at(args[0]) / at(args[1])).rounded(.down)
    default:
      return at(probe)
    }
  }

  func solve(_ u: Double, seeds: [[Double]], lattice: Bool) -> [[Double]] {
    var scope = env
    scope["u"] = u
    let opts = SolveOptions(env: scope, seeds: seeds, lattice: lattice, angular: angular)
    return solveSystem(residuals, vars, lo, hi, opts, evaluate: evaluate)
  }

  // Solutions at parameter t, nearest the chord's centre first.
  func midpoints(_ start: [Double], _ end: [Double], _ t: Double) -> [[Double]] {
    let center = start.indices.map { (start[$0] + end[$0]) / 2 }
    let mids = solve(t, seeds: [center, start, end], lattice: false)
    return stableSorted(mids) { distance($0, center) < distance($1, center) }
  }

  // A large step can be ordinary motion in a zoomed-in view. Follow it at
  // intermediate parameter values before deciding the branch has jumped.
  // Kept midpoints carry their parameter so the winner can be refined.
  typealias Mid = (point: [Double], t: Double)
  func bridge(_ a: [Double], _ b: [Double], _ u0: Double, _ u1: Double) -> [Mid]? {
    var remaining = 96  // bound work when several branches compete for a match
    let jumps = discreteProbes.contains { probe in
      let before = discreteValue(probe, a, u0)
      let after = discreteValue(probe, b, u1)
      return before.isFinite && after.isFinite && before != after
    }
    let minDepth = jumps ? 4 : 0
    func subdivide(
      _ start: [Double], _ end: [Double], _ t0: Double, _ t1: Double, _ depth: Int, _ parentDeviation: Double?
    ) -> [Mid]? {
      remaining -= 1
      if remaining < 0 { return nil }
      let t = (t0 + t1) / 2
      if t == t0 || t == t1 { return nil }
      let center = start.indices.map { (start[$0] + end[$0]) / 2 }
      let length = distance(start, end)
      for mid in midpoints(start, end, t) {
        // Smooth curvature shrinks under subdivision; a jump's deviation does
        // not. Compare successive midpoints independently of the view-scaled
        // step limit so jumps smaller than maxStep can still break the path.
        let deviation = distance(mid, center)
        if length < maxStep && depth >= minDepth
          && (deviation <= 1e-12 * (1 + length) || parentDeviation.map { deviation < 0.5 * $0 } == true)
        {
          return []
        }
        guard let left = subdivide(start, mid, t0, t, depth + 1, deviation) else { continue }
        if let right = subdivide(mid, end, t, t1, depth + 1, deviation) {
          return length < maxStep ? [] : left + [(mid, t)] + right
        }
      }
      return nil
    }
    return subdivide(a, b, u0, u1, 0, nil)
  }

  // Split a chord the bridge already certified until it hugs the curve, so
  // many turns per sample step still draw smooth (issue #49). Each half gets
  // its own share of the budget, and running out keeps the chord rather than
  // breaking the path.
  func refine(
    _ start: [Double], _ end: [Double], _ t0: Double, _ t1: Double, _ budget: Int, _ parentDeviation: Double?
  ) -> [[Double]] {
    let t = (t0 + t1) / 2
    if budget <= 0 || t == t0 || t == t1 { return [] }
    let center = start.indices.map { (start[$0] + end[$0]) / 2 }
    let length = distance(start, end)
    for mid in midpoints(start, end, t) {
      let deviation = distance(mid, center)
      if deviation <= flatness { return [] }
      // A smooth arc's deviation falls about fourfold per split. One that
      // does not, or lies further off than the chord is long, is on another
      // branch.
      if deviation > length || parentDeviation.map({ deviation > 0.5 * $0 }) == true { continue }
      let rest = budget - 1
      let half = rest / 2
      return refine(start, mid, t0, t, half, deviation) + [mid] + refine(mid, end, t, t1, rest - half, deviation)
    }
    return []
  }

  for i in 0...max(samples, 0) {
    let u = Double(i) / Double(samples)
    let before = Double(i - 1) / Double(samples)
    let seeds = active.map { paths[$0].last! }
    let discover = i % 32 == 0 || seeds.isEmpty
    var points = solve(u, seeds: seeds, lattice: discover)
    if !discover && points.count < seeds.count { points = solve(u, seeds: points, lattice: true) }
    var available = active
    active = points.map { point in
      var best: Int? = nil
      var bestBridge: [Mid] = []
      var nearest = Double.infinity
      for path in available {
        let last = paths[path].last!
        let d = distance(point, last)
        if d >= nearest { continue }
        if let mids = bridge(last, point, before, u) {
          nearest = d
          best = path
          bestBridge = mids
        }
      }
      if let best {
        available.removeAll { $0 == best }
        // Refine only the winner's chords, not every candidate's.
        var prev: Mid = (paths[best].last!, before)
        for next in bestBridge + [(point, u)] {
          paths[best] += refine(prev.point, next.point, prev.t, next.t, REFINE_BUDGET, nil) + [next.point]
          prev = next
        }
        return best
      }
      paths.append([point])
      return paths.count - 1
    }
  }
  return paths
}
