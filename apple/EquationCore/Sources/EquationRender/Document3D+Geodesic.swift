import EquationCore
import Foundation

// Geodesic rows (web/scene.ts `geodesicFor`, `geodesicNote`, and the
// 'geodesic' case of renderPanel), and the gain a panel's surface shades its
// own curvature with (`surfaceFieldGain`).
//
// Port: the site traces a geodesic in its trace worker and draws the last
// finished one meanwhile, a frame or two behind a drag; here it is traced
// where the frame is built, within the same budget, and kept until a value
// it reads changes.

/// A family of geodesics shares this budget, each member a share of it.
private let GEODESIC_FAMILY_STEPS = 200000
private let GEODESIC_FAMILY_MS = 1000.0
/// (Carried onto its surface every frame on the site, so held to
/// GEODESIC_MAX_POINTS.)
private let GEODESIC_FAMILY_POINTS = 48000

/// Each geodesic's traced points, by its plan (`geodesicPlanKey`): the last
/// trace of it, with the values it read. Shared by every document, as a
/// trace is the same wherever its plan and values are.
private final class GeodesicTraces: @unchecked Sendable {
  struct Trace {
    var values: [UInt64]
    var members: Int
    var pts: [Double]
    var note: String?
  }

  private let lock = NSLock()
  private var traces: [String: Trace] = [:]
  /// Oldest first.
  private var order: [String] = []

  func trace(_ key: String, values: [UInt64], members: Int, _ work: () -> (pts: [Double], note: String?)) -> Trace {
    lock.lock()
    let hit = traces[key]
    lock.unlock()
    if let hit, hit.values == values, hit.members == members { return hit }
    let made = work()
    let trace = Trace(values: values, members: members, pts: made.pts, note: made.note)
    lock.lock()
    if traces[key] == nil {
      order.append(key)
      if order.count > 256 { traces[order.removeFirst()] = nil }
    }
    traces[key] = trace
    lock.unlock()
    return trace
  }

  func note(_ key: String) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return traces[key]?.note
  }
}

private let geodesicTraces = GeodesicTraces()

/// The gains panels' surfaces shade their fields with, by what each was
/// worked out from.
private final class FieldGains: @unchecked Sendable {
  private let lock = NSLock()
  private var gains: [String: Double] = [:]
  private var order: [String] = []

  func gain(_ key: String, _ work: () -> Double) -> Double {
    lock.lock()
    let hit = gains[key]
    lock.unlock()
    if let hit { return hit }
    let gain = work()
    lock.lock()
    if gains[key] == nil {
      order.append(key)
      if order.count > 64 { gains[order.removeFirst()] = nil }
    }
    gains[key] = gain
    lock.unlock()
    return gain
  }
}

private let fieldGains = FieldGains()

/// The gain a field painted on a surface's panel (gaussian(x, y)) is shaded
/// with, kept until the surface or a value it reads (a slider, t) changes
/// (`surfaceFieldGain`).
func surfaceFieldGain(_ surface: SurfaceMap, _ expr: Expr, _ env: [String: Double]) -> Double {
  let names = freeVars(expr).filter { $0 != "x" && $0 != "y" }
  let read = names.map { "\((env[$0] ?? .nan).bitPattern)" }.joined(separator: ",")
  let key = "\(exprKey(expr))|\(surface.embed.map(exprKey))|\(surface.x)|\(surface.y)|\(read)"
  return fieldGains.gain(key) {
    let f = numericIn([expr], ["x", "y"], env)
    let domain = [(surface.x[0], surface.x[1]), (surface.y[0], surface.y[1])]
    let size = defaultGeodesicLength({ x, y in surfacePoint(surface, x, y) }, domain) / 2
    // Rounding, not curvature, below 1e-9 of the surface's own size.
    return divergingGain({ x, y in f(x, y)[0] }, domain, floor: 1e-9 * min(1 / size, 1 / (size * size)))
  }
}

extension Document3D {
  /// The geodesics a row draws: one, or a family's.
  private func geodesics(row index: Int) -> [GeodesicSpec] {
    switch analysis.rows[index].cpu {
    case .geodesic(let spec)?: return [spec]
    case .family(let members)?:
      return members.compactMap { if case .geodesic(let spec) = $0.cpu { spec } else { nil } }
    default: return []
    }
  }

  /// A geodesic, on its surface already (its points are placed there, a
  /// panel's surface included): lifted a hair toward the eye so the surface
  /// does not hide it.
  func drawGeodesic(
    _ spec: GeodesicSpec, row index: Int, _ color: RGB, _ env: [String: Double], _ camera: Camera3D,
    into scene: inout Scene3D
  ) {
    let members = max(1, geodesics(row: index).count)
    var exprs = spec.surface + spec.derivatives + spec.start + spec.direction + spec.domain
    if let length = spec.length { exprs.append(length) }
    let names = freeVars(.vec(exprs)).filter { !spec.params.contains($0) }
    let values = names.map { (env[$0] ?? .nan).bitPattern }
    let trace = geodesicTraces.trace(geodesicPlanKey(spec), values: values, members: members) {
      var ended = GeodesicEnd()
      // (The time it may take is counted from here, its programs made.)
      let deadline = Date().addingTimeInterval(GEODESIC_FAMILY_MS / Double(members) / 1000)
      let pts = geodesicPath(
        spec, env,
        maxSteps: min(GEODESIC_MAX_STEPS, Int((Double(GEODESIC_FAMILY_STEPS) / Double(members)).rounded(.up))),
        maxPoints: min(GEODESIC_MAX_POINTS, max(300, GEODESIC_FAMILY_POINTS / members)),
        outOfTime: { Date() > deadline }, ended: &ended)
      return (pts, geodesicCutNote(ended))
    }
    let eye = cameraEye(camera)
    let lift = 0.004 * camera.radius
    var raised: [Float] = []
    raised.reserveCapacity(trace.pts.count)
    for k in stride(from: 0, to: trace.pts.count - 2, by: 3) {
      // (`towardEye`.)
      let p = [trace.pts[k], trace.pts[k + 1], trace.pts[k + 2]]
      let to = [eye.x - p[0], eye.y - p[1], eye.z - p[2]]
      let length = (to[0] * to[0] + to[1] * to[1] + to[2] * to[2]).squareRoot()
      let d = length == 0 || length.isNaN ? 1 : length
      for c in 0..<3 { raised.append(Float(p[c] + (lift * to[c]) / d)) }
    }
    if raised.count >= 6 { scene.curves.append(Scene3D.Curve(pts: raised, color: color)) }
  }

  /// A geodesic row's note, from its members' traces once drawn: where its
  /// budget cut one short, or how many of a family it cut (`geodesicNote`).
  /// Nil for a row that reached its ends, or is no geodesic.
  public func geodesicNote(row index: Int) -> String? {
    let specs = geodesics(row: index)
    let cuts = specs.compactMap { geodesicTraces.note(geodesicPlanKey($0)) }
    guard let first = cuts.first else { return nil }
    if specs.count == 1 { return first }
    let at = first.hasPrefix("cut short at ") ? String(first.dropFirst("cut short at ".count)) : first
    return "\(cuts.count) of \(specs.count) cut short by the family's budget (one at \(at))"
  }
}
