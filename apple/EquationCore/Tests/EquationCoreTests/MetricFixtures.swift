import Foundation

@testable import EquationCore

/// The TypeScript's CPU plan for a row of a panel with a metric (a `metric`,
/// `geodesic`, `lightcone` or `tidal` plan), or nil for any other type.
func metricPlan(_ o: [String: Any]) throws -> MetricPlan? {
  func exprs(_ key: String, in o: [String: Any]) throws -> [Expr] { try (o[key] as? [Any] ?? []).map(decode) }
  func optional(_ key: String, in o: [String: Any]) throws -> [Expr]? { try (o[key] as? [Any])?.map(decode) }
  func whole(_ key: String, in o: [String: Any]) -> Int { (o[key] as! NSNumber).intValue }
  switch o["type"] as! String {
  case "metric":
    return .row(text: o["text"] as! String)
  case "geodesic":
    let metric = try (o["metric"] as? [String: Any]).map { m in
      MetricSpec(
        n: whole("n", in: m), components: try exprs("components", in: m),
        derivatives: try exprs("derivatives", in: m), jacobian: try optional("jacobian", in: m),
        motion: Motion(rawValue: m["motion"] as! String)!, time: m["time"] as? String)
    }
    return .geodesic(
      GeodesicSpec(
        dim: whole("dim", in: o), params: o["params"] as! [String], surface: try exprs("surface", in: o),
        derivatives: try exprs("derivatives", in: o), start: try exprs("start", in: o),
        direction: try exprs("direction", in: o), length: try o["length"].map { try decode($0) },
        domain: try exprs("domain", in: o), metric: metric))
  case "lightcone":
    return .lightcone(
      LightConeSpec(
        n: whole("n", in: o), components: try exprs("components", in: o), jacobian: try optional("jacobian", in: o),
        at: try optional("at", in: o), future: try optional("future", in: o)))
  case "tidal":
    return .tidal(
      TidalSpec(
        n: whole("n", in: o), time: whole("time", in: o), params: o["params"] as! [String],
        curvature: try exprs("curvature", in: o), symbols: o["symbols"] as? [String],
        chart: try optional("chart", in: o), components: try exprs("components", in: o),
        jacobian: try optional("jacobian", in: o), at: try optional("at", in: o)))
  default:
    return nil
  }
}

/// Within what two libms and two orders of summation may differ by along a
/// trace of a few thousand steps held to 1e-9 a step.
private func near(_ a: Double, _ b: Double, _ tolerance: Double) -> Bool {
  if a.isNaN || b.isNaN { return a.isNaN && b.isNaN }
  return a == b || abs(a - b) <= tolerance * max(1, abs(a), abs(b))
}

/// How far a point is from a polyline (x, y flat).
private func distance(_ x: Double, _ y: Double, toPolyline pts: [Double]) -> Double {
  if pts.count < 2 { return .infinity }
  var best = hypot(pts[0] - x, pts[1] - y)
  for k in stride(from: 0, to: pts.count - 3, by: 2) {
    let (ax, ay, bx, by) = (pts[k], pts[k + 1], pts[k + 2], pts[k + 3])
    let (dx, dy) = (bx - ax, by - ay)
    let len2 = dx * dx + dy * dy
    let t = len2 > 0 ? max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0
    best = min(best, hypot(ax + t * dx - x, ay + t * dy - y))
  }
  return best
}

private func thinned(_ values: [Double], like wanted: [String: Any]) -> (count: Int, values: [Double]) {
  let step = (wanted["step"] as! NSNumber).intValue
  var out: [Double] = []
  var k = 0
  while 2 * k + 1 < values.count {
    out += [values[2 * k], values[2 * k + 1]]
    k += step
  }
  return (values.count, out)
}

private func compareList(_ what: String, _ mine: [Double], _ wanted: Any?, tolerance: Double) -> String? {
  guard let wanted = wanted as? [String: Any] else { return nil }
  let count = (wanted["count"] as! NSNumber).intValue
  if mine.count != count { return "\(what): \(mine.count) numbers, want \(count)" }
  let got = thinned(mine, like: wanted).values
  let want = (wanted["values"] as! [Any]).map(number)
  for (k, (a, b)) in zip(got, want).enumerated() where !near(a, b, tolerance) {
    return "\(what): number \(k) is \(a), want \(b)"
  }
  return nil
}

/// What the port draws of one metric plan over a view, against what
/// apple/corpus/cases-leftovers.ts recorded of the site's.
private func drawnDifferences(_ plan: MetricPlan, _ wanted: [String: Any], _ env: [String: Double], _ view: ConeView)
  -> [String]
{
  if let error = wanted["error"] as? String { return ["the site failed to draw it: \(error)"] }
  var out: [String] = []
  switch plan {
  case .row: break
  case .geodesic(let spec):
    var ended = GeodesicEnd()
    let pts = metricGeodesicPath(
      spec, env, window: traceWindow(lo: (view.lo.x, view.lo.y), hi: (view.hi.x, view.hi.y)), ended: &ended)
    let note = geodesicCutNote(ended)
    if note != wanted["note"] as? String { out.append("note \(note ?? "none"), want \(wanted["note"] ?? "none")") }
    // Two libms part in the last place, and the steps (and so how many points are drawn, and where a
    // geodesic crawling up to a horizon gives up) follow: the same curve is asked for, not the same points.
    let size = max(view.hi.x - view.lo.x, view.hi.y - view.lo.y)
    if let path = wanted["path"] as? [String: Any] {
      let want = (path["values"] as! [Any]).map(number)
      var worst = 0.0
      for k in stride(from: 0, to: want.count - 1, by: 2) {
        worst = max(worst, distance(want[k], want[k + 1], toPolyline: pts))
      }
      if !(worst <= 1e-6 * size) { out.append("path: \(worst) from the site's, \(pts.count) numbers") }
      let count = (path["count"] as! NSNumber).intValue
      if abs(pts.count - count) > max(16, count / 4) { out.append("path: \(pts.count) numbers, want \(count)") }
    }
    if let end = (wanted["end"] as? [Any])?.map(number), end.count == 2, pts.count >= 2 {
      let off = hypot(pts[pts.count - 2] - end[0], pts[pts.count - 1] - end[1])
      if !(off <= 1e-3 * size) { out.append("ends \(off) from the site's") }
    }
    if !near(ended.length, number(wanted["length"]!), 1e-2) {
      out.append("length \(ended.length), want \(number(wanted["length"]!))")
    }
  case .lightcone(let spec):
    let read = metricValues(n: spec.n, components: spec.components, jacobian: spec.jacobian, env)
    let orient = metricOrientation(spec.future, env)
    var kappa: Double?
    var cut: ((Double, Double) -> Bool)?
    if spec.n == 3 {
      kappa = indicatrixScale(read, view)
      cut = behindHorizon(read, view)
      if !near(kappa!, number(wanted["kappa"]!), 0) { out.append("kappa \(kappa!), want \(wanted["kappa"]!)") }
    }
    let glyphs = coneGlyphs(read, view, at: glyphPoint(spec.at, env), kappa: kappa, orient: orient, cut: cut)
    out += [
      compareList("rings", glyphs.rings, wanted["rings"], tolerance: 1e-9),
      compareList("lines", glyphs.lines, wanted["lines"], tolerance: 1e-9),
      compareList("dots", glyphs.dots, wanted["dots"], tolerance: 1e-9),
    ].compactMap { $0 }
  case .tidal(let spec):
    let read = tidalReader(spec, env)
    let cut =
      spec.n == 3
      ? behindHorizon(metricValues(n: 3, components: spec.components, jacobian: spec.jacobian, env), view) : nil
    let scale = tidalScale(read, view, skip: cut)
    if !near(scale, number(wanted["scale"]!), 0) { out.append("scale \(scale), want \(wanted["scale"]!)") }
    let glyphs = tidalGlyphs(read, view, at: glyphPoint(spec.at, env), scale: scale, cut: cut)
    out += [
      compareList("rings", glyphs.rings, wanted["rings"], tolerance: 1e-6),
      compareList("lines", glyphs.lines, wanted["lines"], tolerance: 1e-6),
    ].compactMap { $0 }
  }
  return out
}

/// A document's metric rows as drawn against the fixture's (`metrics`), for
/// AnalysisConformanceTests: each geodesic's path and note, each row's
/// glyphs and their scale, over the document's window at t = 0.
func compareMetrics(_ analysis: DocumentAnalysis, _ wanted: Any?) -> [String] {
  guard let wanted = wanted as? [Any] else { return [] }
  var (x0, x1, y0, y1) = (-6.0, 6.0, -6.0, 6.0)
  for row in analysis.rows where row.error == nil {
    if case .view(let x, let y, _, _)? = row.view {
      if let x { (x0, x1) = (x[0], x[1]) }
      if let y { (y0, y1) = (y[0], y[1]) }
      break
    }
  }
  let view = ConeView(lo: (x0, y0), hi: (x1, y1), upp: (x1 - x0) / 600, uppY: (y1 - y0) / 600)
  var env = analysis.env
  env["t"] = 0
  var out: [String] = []
  for (i, row) in analysis.rows.enumerated() where row.unsupported == nil && row.error == nil {
    guard let drawn = wanted[i] as? [Any] else { continue }
    var plans: [MetricPlan] = []
    switch row.cpu {
    case .metric(let plan)?: plans = [plan]
    case .family(let members)?:
      plans = members.compactMap { if case .metric(let plan) = $0.cpu { plan } else { nil } }
    default: break
    }
    for (k, plan) in plans.enumerated() where k < drawn.count {
      guard let want = drawn[k] as? [String: Any] else { continue }
      out += drawnDifferences(plan, want, env, view).map { "row \(i + 1) member \(k + 1): \($0)" }
    }
  }
  return out
}
