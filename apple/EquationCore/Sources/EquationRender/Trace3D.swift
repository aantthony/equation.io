import EquationCore
import Foundation

/// What a 3D scene's builder works out on the CPU from a row's expressions:
/// a vector field's streamlines and arrows (lib/flow.ts), the curve two
/// surfaces meet in (lib/intersection.ts), and the size a cloud's field
/// reaches in view (lib/volume.ts).
///
/// The site runs these over a compiled program (lib/vm.ts); here the
/// expression is evaluated as it stands, which gives the same numbers.

private func hypot(_ v: [Double]) -> Double { v.reduce(0) { $0 + $1 * $1 }.squareRoot() }

let FLOW_SEEDS = 32
let FLOW_STEPS = 256
/// Arrow glyphs per axis; a 3-vector field is an N×N×N lattice.
let FLOW_GLYPH_N = 9

/// The components' values at a point (`fieldEvaluator`): names the
/// environment lacks read 0, a component that cannot be evaluated NaN.
func fieldEvaluator(_ comps: [Expr], _ env: [String: Double]) -> ([Double]) -> [Double] {
  var scope = env
  for c in comps {
    for name in freeVars(c) where scope[name] == nil { scope[name] = 0 }
  }
  let axes = ["x", "y", "z"]
  return { p in
    for k in p.indices { scope[axes[k]] = p[k] }
    return comps.map { (try? evaluate($0, scope)) ?? .nan }
  }
}

/// A bounded RK4 streamline of the normalized field through `seed`, both
/// directions (`streamline`). Time is held fixed: these are integral curves
/// of a field, not time-integrated simulation states.
func streamline(
  _ f: ([Double]) -> [Double], _ seed: [Double], _ step: Double, _ lo: [Double], _ hi: [Double],
  steps: Int = FLOW_STEPS
) -> [[Double]] {
  guard seed.allSatisfy(\.isFinite), step > 0 else { return [] }
  func direction(_ p: [Double]) -> [Double]? {
    let v = f(p)
    let n = hypot(v)
    return n.isFinite && n > 1e-12 ? v.map { $0 / n } : nil
  }
  func side(_ sign: Double) -> [[Double]] {
    var path: [[Double]] = []
    var p = seed
    let h = sign * step
    func at(_ v: [Double], _ scale: Double) -> [Double] { p.indices.map { p[$0] + h * scale * v[$0] } }
    for _ in 0..<min(steps, 2048) {
      guard let a = direction(p), let b = direction(at(a, 0.5)), let c = direction(at(b, 0.5)),
        let d = direction(at(c, 1))
      else { break }
      let next = p.indices.map { p[$0] + (h / 6) * (a[$0] + 2 * b[$0] + 2 * c[$0] + d[$0]) }
      if !next.indices.allSatisfy({ next[$0].isFinite && next[$0] >= lo[$0] && next[$0] <= hi[$0] }) { break }
      if hypot(next.indices.map { next[$0] - p[$0] }) < step * 1e-6 { break }
      p = next
      path.append(p)
    }
    return path
  }
  return side(-1).reversed() + [seed] + side(1)
}

/// A field's paths over the box (`traceField`): streamlines from
/// deterministic seeds, or with `glyphs` one short arrow per lattice point.
/// A fixed work cap, independent of the size of the view.
func traceField(
  _ comps: [Expr], _ lo: [Double], _ hi: [Double], _ env: [String: Double], glyphs: Bool = false
) -> [[[Double]]] {
  let f = fieldEvaluator(comps, env)
  let span = lo.indices.map { hi[$0] - lo[$0] }.min() ?? 0
  guard span > 0, span.isFinite else { return [] }
  var paths: [[[Double]]] = []
  if glyphs {
    let n = FLOW_GLYPH_N
    var count = 1
    for _ in comps { count *= n }
    let glyphLen = (span * 0.28) / Double(n)
    for i in 0..<count {
      var stride = 1
      var seed: [Double] = []
      for k in lo.indices {
        seed.append(lo[k] + (hi[k] - lo[k]) * ((Double((i / stride) % n) + 0.5) / Double(n)))
        stride *= n
      }
      let v = f(seed)
      let len = hypot(v)
      if len > 1e-12, len.isFinite {
        paths.append([seed, seed.indices.map { seed[$0] + (glyphLen * v[$0]) / len }])
      }
    }
  } else {
    var hash: UInt32 = 0x1234_5678
    func random() -> Double {
      hash ^= hash << 13
      hash ^= hash >> 17
      hash ^= hash << 5
      return Double(hash) / 4294967296
    }
    for _ in 0..<FLOW_SEEDS {
      let seed = lo.indices.map { lo[$0] + (hi[$0] - lo[$0]) * (0.1 + 0.8 * random()) }
      paths.append(streamline(f, seed, span / 180, lo, hi))
    }
  }
  return paths
}

let INTERSECTION_STEPS = 512
let INTERSECTION_BRANCHES = 24

/// Bounded predictor–corrector continuation of F = G = 0 in three dimensions
/// (`traceIntersection`). A seeded numerical search: this never claims
/// branch completeness.
func traceIntersection(_ residuals: [Expr], _ lo: [Double], _ hi: [Double], _ env: [String: Double])
  -> [[[Double]]]
{
  guard residuals.count == 2, lo.count == 3 else { return [] }
  let f = fieldEvaluator(residuals, env)
  // The symbolic gradient where there is one; finite differences otherwise.
  var gradient: (([Double]) -> [Double])?
  if let d = try? residuals.flatMap({ r in try ["x", "y", "z"].map { try diff(r, $0) } }) {
    gradient = fieldEvaluator(d, env)
  }
  let scale = (0..<3).map { hi[$0] - lo[$0] }.max() ?? 0
  guard scale > 0, scale.isFinite else { return [] }
  let step = scale / 180
  var budget = 180000
  func dot(_ a: [Double], _ b: [Double]) -> Double { zip(a, b).reduce(0) { $0 + $1.0 * $1.1 } }
  func cross(_ a: [Double], _ b: [Double]) -> [Double] {
    (0..<3).map { a[($0 + 1) % 3] * b[($0 + 2) % 3] - a[($0 + 2) % 3] * b[($0 + 1) % 3] }
  }
  func inside(_ p: [Double]) -> Bool { (0..<3).allSatisfy { p[$0].isFinite && p[$0] >= lo[$0] && p[$0] <= hi[$0] } }
  func jac(_ p: [Double]) -> [[Double]] {
    budget -= 1
    if budget < 0 { return [[.nan, .nan, .nan], [.nan, .nan, .nan]] }
    if let gradient {
      let g = gradient(p)
      return [Array(g[..<3]), Array(g[3...])]
    }
    var out = [[Double]](repeating: [0, 0, 0], count: 2)
    for k in 0..<3 {
      let h = 1e-6 * max(1, abs(p[k]))
      var (a, b) = (p, p)
      a[k] += h
      b[k] -= h
      let (fa, fb) = (f(a), f(b))
      for j in 0..<2 { out[j][k] = (fa[j] - fb[j]) / (2 * h) }
    }
    return out
  }
  func tangent(_ p: [Double]) -> [Double]? {
    let j = jac(p)
    let v = cross(j[0], j[1])
    let n = hypot(v)
    return n > 1e-12 && n.isFinite ? v.map { $0 / n } : nil
  }
  func correct(_ seed: [Double], _ plane: [Double]? = nil) -> [Double]? {
    var p = seed
    for _ in 0..<24 {
      let r = f(p)
      let j = jac(p)
      if !r.allSatisfy(\.isFinite) || !j.joined().allSatisfy(\.isFinite) { return nil }
      var delta: [Double]?
      if let plane {
        delta = solveLinear(j + [plane], r + [dot((0..<3).map { p[$0] - seed[$0] }, plane)], 3)
      } else if let weights = solveLinear(j.map { a in j.map { b in dot(a, b) } }, r, 2) {
        delta = (0..<3).map { weights[0] * j[0][$0] + weights[1] * j[1][$0] }
      }
      guard let delta, delta.allSatisfy(\.isFinite) else { return nil }
      let error = hypot(delta)
      if error < scale * 1e-10 && inside(p) { return p }
      let damping = min(1, (scale * 0.2) / max(error, 1e-30))
      p = (0..<3).map { p[$0] - damping * delta[$0] }
      if !inside(p) { return nil }
    }
    return nil
  }
  func distance(_ a: [Double], _ b: [Double]) -> Double { hypot((0..<3).map { a[$0] - b[$0] }) }
  var paths: [[[Double]]] = []
  var i = 0
  while i < 216, paths.count < INTERSECTION_BRANCHES, budget > 0 {
    defer { i += 1 }
    let cell = [i % 6, (i / 6) % 6, (i / 36) % 6]
    var seed = lo
    for k in 0..<3 {
      let fraction: Double = (Double(cell[k]) + 0.43) / 6
      seed[k] = lo[k] + (hi[k] - lo[k]) * fraction
    }
    guard let root = correct(seed) else { continue }
    if paths.contains(where: { path in path.contains { distance($0, root) < step * 1.3 } }) { continue }
    guard let t0 = tangent(root) else { continue }
    var closed = false
    func side(_ sign: Double) -> [[Double]] {
      var out: [[Double]] = []
      var p = root
      var last = t0.map { sign * $0 }
      var n = 0
      while n < INTERSECTION_STEPS, budget > 0 {
        defer { n += 1 }
        guard var t = tangent(p) else { break }
        if dot(t, last) < 0 { t = t.map { -$0 } }
        let predicted = (0..<3).map { p[$0] + step * t[$0] }
        guard let next = correct(predicted, t), distance(next, predicted) <= step * 0.5 else { break }
        if n > 8, distance(next, root) < step * 0.75 {
          out.append(root)
          closed = true
          break
        }
        out.append(next)
        p = next
        last = t
      }
      return out
    }
    let forward = side(1)
    let backward: [[Double]] = closed ? [] : side(-1).reversed()
    if !forward.isEmpty || !backward.isEmpty { paths.append(backward + [root] + forward) }
  }
  return paths
}

/// Samples per axis of the lattice a cloud's scale is read from.
private let LATTICE = 12
/// The fraction of |F| over the lattice the scale sits above: high enough
/// that most of the cloud is thin, low enough that a pole (1/r) or a corner
/// (x y z) does not wash out the rest.
private let QUANTILE = 0.95

/// The size |F| typically reaches over the ball of radius r at center (where
/// the cloud is at full density), or 1 when it cannot be evaluated here or
/// is zero throughout (`fieldScale`).
func fieldScale(_ expr: Expr, _ env: [String: Double], _ center: SIMD3<Double>, _ r: Double) -> Double {
  var scope = env
  var sizes: [Double] = []
  for i in 0..<LATTICE {
    for j in 0..<LATTICE {
      for k in 0..<LATTICE {
        let dx = Double(2 * i + 1) / Double(LATTICE) - 1
        let dy = Double(2 * j + 1) / Double(LATTICE) - 1
        let dz = Double(2 * k + 1) / Double(LATTICE) - 1
        if dx * dx + dy * dy + dz * dz > 1 { continue }
        scope["x"] = center.x + r * dx
        scope["y"] = center.y + r * dy
        scope["z"] = center.z + r * dz
        // (A name with no value is a row the language refused: no scale.)
        guard let value = try? evaluate(expr, scope) else { return 1 }
        if value.isFinite { sizes.append(abs(value)) }
      }
    }
  }
  if sizes.isEmpty { return 1 }
  sizes.sort()
  let scale = sizes[min(sizes.count - 1, Int((QUANTILE * Double(sizes.count)).rounded(.down)))]
  return scale > 0 ? scale : 1
}

/// What brings a surface's paint (its curvature) to about 1 where it is
/// typical (web/scene.ts `paintGain`): 1.5 over the 90th percentile of |f| at
/// a lattice of points of the unit square of u and v — the largest few are
/// left out, as curvature runs off to infinity at a cusp — or 1 when f is
/// rounding everywhere, or nowhere defined (lib/surface-geometry.ts
/// `divergingGain`).
func paintGain(_ comps: [Expr], _ paint: Expr, _ env: [String: Double]) -> Double {
  var scope = env
  func at(_ e: Expr, _ u: Double, _ v: Double) -> Double {
    scope["u"] = u
    scope["v"] = v
    return (try? evaluate(e, scope)) ?? .nan
  }
  // Twice the diagonal of the box round the surface (`defaultGeodesicLength`), halved.
  var lo = [Double](repeating: .infinity, count: 3)
  var hi = [Double](repeating: -.infinity, count: 3)
  let n = 16
  for i in 0...n {
    for j in 0...n {
      let pt = comps.map { at($0, Double(i) / Double(n), Double(j) / Double(n)) }
      guard pt.allSatisfy(\.isFinite) else { continue }
      for k in 0..<min(3, pt.count) {
        lo[k] = min(lo[k], pt[k])
        hi[k] = max(hi[k], pt[k])
      }
    }
  }
  let diagonal = hypot((0..<3).map { hi[$0] > lo[$0] ? hi[$0] - lo[$0] : 0 })
  let size = (diagonal.isFinite && diagonal > 0 ? 2 * diagonal : 1) / 2
  // Rounding, not curvature, below 1e-9 of the surface's own size.
  let floor = 1e-9 * min(1 / size, 1 / (size * size))
  var sizes: [Double] = []
  let m = 24
  for i in 0...m {
    for j in 0...m {
      let k = abs(at(paint, (Double(i) + 0.5) / Double(m + 1), (Double(j) + 0.5) / Double(m + 1)))
      if k.isFinite { sizes.append(k) }
    }
  }
  if sizes.isEmpty { return 1 }
  sizes.sort()
  let typical = sizes[Int((0.9 * Double(sizes.count - 1)).rounded(.down))]
  return typical > floor ? 1.5 / typical : 1
}
