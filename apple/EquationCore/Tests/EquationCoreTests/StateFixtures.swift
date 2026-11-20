import Foundation

@testable import EquationCore

/// Within what two libms may differ by after a few hundred steps of a tame system.
private func near(_ a: Double, _ b: Double) -> Bool {
  if a.isNaN || b.isNaN { return a.isNaN && b.isNaN }
  return a == b || abs(a - b) <= 1e-9 * max(1, abs(a), abs(b))
}

/// A document's state system against the fixture's (`states`, which
/// apple/corpus/cases-panels.ts records by running lib/state.ts and
/// lib/orbit.ts), for AnalysisConformanceTests: the same states, starting
/// where the site starts them; a run stepped frame by frame, 60 a second,
/// that is where the site's is after half a second and after two; and each
/// orbit row's polyline through the same points. Compared only when the port
/// supports every row, since a state the port cannot read is not in its system.
func compareStates(_ analysis: DocumentAnalysis, _ wanted: [String: Any]?) -> [String] {
  if analysis.rows.contains(where: { $0.unsupported != nil }) { return [] }
  guard let wanted else {
    return analysis.stateSystem == nil ? [] : ["a state system the site does not have"]
  }
  guard let sys = analysis.stateSystem else { return ["no state system"] }
  var out: [String] = []
  let names = wanted["names"] as! [String]
  if Set(sys.names) != Set(names) { return ["states \(sys.names), want \(names)"] }
  for (name, value) in zip(names, (wanted["initial"] as! [Any]).map(number)) {
    if !near(analysis.initialState[name] ?? .nan, value) {
      out.append("\(name) starts at \(String(describing: analysis.initialState[name])), want \(value)")
    }
    // The environment at t = 0 has every state at its start.
    if !near(analysis.env[name] ?? .nan, value) { out.append("env \(name) is not its start") }
  }
  var run = StateStepper(analysis)
  let runs = wanted["runs"] as! [[String: Any]]
  for frame in 1...120 {
    run.advance(to: Double(frame) / 60)
    guard let want = runs.first(where: { number($0["time"]!) == Double(frame) / 60 }) else { continue }
    if !near(run.time, number(want["reached"]!)) { out.append("reached \(run.time), want \(want["reached"]!)") }
    for (name, value) in zip(names, (want["values"] as! [Any]).map(number)) where !near(run.values[name] ?? .nan, value) {
      out.append("\(name) at t = \(run.time) is \(String(describing: run.values[name])), want \(value)")
    }
  }
  for (index, want) in (wanted["orbits"] as! [Any]).enumerated() {
    guard let want = want as? [String: Any] else { continue }
    do {
      guard let pts = try analysis.orbit(row: index) else {
        // (An orbit in space is not ported, and its row says so.)
        out.append("row \(index + 1): no orbit")
        continue
      }
      if let message = want["error"] as? String {
        out.append("row \(index + 1): an orbit the site refuses (\(message))")
        continue
      }
      let count = (want["count"] as! NSNumber).intValue
      let step = (want["step"] as! NSNumber).intValue
      // (Two numbers a point, or three for an orbit in space.)
      let points = want["points"] as! [[Any]]
      let dim = points.first?.count ?? 2
      if pts.count != count * dim {
        out.append("row \(index + 1): orbit of \(pts.count / dim) points, want \(count)")
        continue
      }
      for (k, point) in points.enumerated() {
        let at = k * step
        let mine = Array(pts[(dim * at)..<(dim * at + dim)])
        if !zip(mine, point.map(number)).allSatisfy({ near($0, $1) }) {
          out.append("row \(index + 1): orbit point \(at) is \(mine), want \(point)")
          break
        }
      }
    } catch {
      if want["error"] as? String != errorMessage(error) {
        out.append("row \(index + 1): orbit error \(errorMessage(error)), want \(want["error"] ?? "none")")
      }
    }
  }
  return out
}
