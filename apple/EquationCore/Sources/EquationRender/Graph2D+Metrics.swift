import EquationCore
import Foundation

// What is drawn of a panel's metric (a `ds^2 = …` row): web/main.ts
// `geodesicFor`, `lightConesFor`, `tidesFor` and the cases of its 2D overlay
// that call them. A geodesic is a polyline traced over a box round the
// window; light cones and tidal forces are glyphs laid out over the window,
// sized in points.
//
// The site traces a geodesic in a worker and draws the last one traced until
// the next arrives. Here it is traced where it is asked for, within the same
// budget of steps and time, and kept until a value it reads or the box it is
// traced over changes: a still graph traces once, and a dragged point costs
// its trace each frame it moves. Whoever draws frames may call `overlay` off
// the main thread.

/// What each metric row last drew, and what it was drawn from. Shared by the
/// copies of a graph, which are the same rows.
final class DrawnMetrics: Equatable, @unchecked Sendable {
  struct Traced {
    var key: String
    var pts: [Double]
    var note: String?
  }

  private let lock = NSLock()
  private var geodesics: [String: Traced] = [:]
  private var glyphs: [String: (key: String, drawn: ConeGlyphs)] = [:]
  /// A panel's tidal scale and the values it was taken at, by row.
  private var tidalScales: [String: (values: String, scale: Double)] = [:]

  /// A cache is no part of what a graph is.
  static func == (_: DrawnMetrics, _: DrawnMetrics) -> Bool { true }

  func geodesic(_ slot: String, key: String, _ trace: () -> (pts: [Double], note: String?)) -> [Double] {
    lock.lock()
    let hit = geodesics[slot]
    lock.unlock()
    if let hit, hit.key == key { return hit.pts }
    let fresh = trace()
    lock.lock()
    geodesics[slot] = Traced(key: key, pts: fresh.pts, note: fresh.note)
    lock.unlock()
    return fresh.pts
  }

  func glyphs(_ slot: String, key: String, _ draw: () -> ConeGlyphs) -> ConeGlyphs {
    lock.lock()
    let hit = glyphs[slot]
    lock.unlock()
    if let hit, hit.key == key { return hit.drawn }
    let fresh = draw()
    lock.lock()
    glyphs[slot] = (key, fresh)
    lock.unlock()
    return fresh
  }

  /// The scale a row's tides had at these values, if it has drawn at them.
  func tidalScale(_ slot: String, values: String) -> Double? {
    lock.lock()
    defer { lock.unlock() }
    guard let known = tidalScales[slot], known.values == values else { return nil }
    return known.scale
  }

  func setTidalScale(_ slot: String, values: String, _ scale: Double) {
    lock.lock()
    tidalScales[slot] = (values, scale)
    lock.unlock()
  }

  /// The notes of a row's traces, member by member.
  func notes(row: Int, members: Int) -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return (0..<members).compactMap { geodesics["\(row):\($0)"]?.note }
  }
}

/// A family of geodesics shares this budget, each member a share of it
/// (web/main.ts `GEODESIC_FAMILY_STEPS`, `GEODESIC_FAMILY_MS`, `GEODESIC_FAMILY_POINTS`).
private let geodesicFamilySteps = 200000
private let geodesicFamilyMs = 1000.0
private let geodesicFamilyPoints = 48000

/// The values of the names some expressions read, as a key.
private func valuesKey(_ exprs: [Expr], _ env: [String: Double]) -> String {
  var names: [String] = []
  for e in exprs {
    for name in freeVars(e) where name != "x" && name != "y" && !names.contains(name) { names.append(name) }
  }
  return names.map { "\(env[$0] ?? .nan)" }.joined(separator: ",")
}

extension Graph2D {
  /// Draws a row of a panel with a metric — a geodesic or light ray, light
  /// cones, tidal forces, or a family of them — and says whether the plan
  /// was one. A ds^2 row itself draws nothing.
  func drawMetrics(
    _ cpu: CpuPlan, row: Int, _ env: [String: Double], color: RGB, bounds: Bounds, pointsPerUnit: Double?,
    into overlay: inout Overlay2D
  ) -> Bool {
    var plans: [MetricPlan] = []
    switch cpu {
    case .metric(let plan): plans = [plan]
    case .family(let members):
      for member in members {
        guard case .metric(let plan) = member.cpu else { return false }
        plans.append(plan)
      }
    default: return false
    }
    // The window as the glyphs see it: math units a point across and up
    // (web/main.ts: `upp = view.upp * dpr`, `uppY = upp / ratio`).
    let upp = 1 / (pointsPerUnit ?? 50)
    let view = ConeView(
      lo: (bounds.xmin, bounds.ymin), hi: (bounds.xmax, bounds.ymax), upp: upp, uppY: upp / (window?.ratio ?? 1))
    for (k, plan) in plans.enumerated() {
      let shade = plans.count > 1 ? Self.familyColor(color, member: k, of: plans.count) : color
      let css = CSSColor(shade)
      let slot = "\(row):\(k)"
      switch plan {
      case .row:
        break
      case .geodesic(let spec):
        // Traced over a box round the window and drawn in x and y.
        let pts = geodesic(spec, slot: slot, members: plans.count, env, view)
        if pts.count >= 4 { overlay.polylines.append(.init(pts: pts, color: css)) }
      case .lightcone(let spec):
        // The light cones of the panel's metric, sized in points.
        let key =
          "\(valuesKey(spec.components + (spec.jacobian ?? []) + (spec.future ?? []) + (spec.at ?? []), env))|"
          + coneViewKey(view)
        let drawn = metricsDrawn.glyphs(slot, key: key) {
          let read = metricValues(n: spec.n, components: spec.components, jacobian: spec.jacobian, env)
          var kappa: Double?
          var cut: ((Double, Double) -> Bool)?
          if spec.n == 3 {
            kappa = indicatrixScale(read, view)
            cut = behindHorizon(read, view)
          }
          return coneGlyphs(
            read, view, at: glyphPoint(spec.at, env), kappa: kappa, orient: metricOrientation(spec.future, env),
            cut: cut)
        }
        let glyph = Overlay2D.Glyph(
          rings: drawn.rings, lines: drawn.lines, dots: drawn.dots, color: css, fill: CSSColor(shade, alpha: 0.2))
        overlay.glyphs = (overlay.glyphs ?? []) + [glyph]
      case .tidal(let spec):
        // The tidal forces of the panel's metric on an observer at rest:
        // solid bars and arrowheads, sized in points.
        let values = valuesKey(
          spec.curvature + (spec.chart ?? []) + spec.components + (spec.jacobian ?? []), env)
        let key = "\(values)|\(valuesKey(spec.at ?? [], env))|" + coneViewKey(view)
        let drawn = metricsDrawn.glyphs(slot, key: key) {
          let read = tidalReader(spec, env)
          let cut =
            spec.n == 3
            ? behindHorizon(metricValues(n: 3, components: spec.components, jacobian: spec.jacobian, env), view)
            : nil
          // Held through pans and zooms while the values stay; afresh when they change.
          let scale = tidalScale(read, view, skip: cut, previous: metricsDrawn.tidalScale(slot, values: values))
          metricsDrawn.setTidalScale(slot, values: values, scale)
          return tidalGlyphs(read, view, at: glyphPoint(spec.at, env), scale: scale, cut: cut)
        }
        let glyph = Overlay2D.Glyph(
          rings: drawn.rings, lines: drawn.lines, dots: drawn.dots, color: css, fill: css, lineWidth: 1.5,
          lineAlpha: 1)
        overlay.glyphs = (overlay.glyphs ?? []) + [glyph]
      }
    }
    return true
  }

  /// A geodesic's points (x, y flat), traced again only when a value it
  /// reads or the box round the window changes.
  private func geodesic(
    _ spec: GeodesicSpec, slot: String, members: Int, _ env: [String: Double], _ view: ConeView
  ) -> [Double] {
    let box = traceWindow(lo: (view.lo.x, view.lo.y), hi: (view.hi.x, view.hi.y))
    var exprs = spec.start + spec.direction
    if let length = spec.length { exprs.append(length) }
    if let metric = spec.metric { exprs += metric.components + metric.derivatives + (metric.jacobian ?? []) }
    let key = "\(valuesKey(exprs, env))|\(box)"
    return metricsDrawn.geodesic(slot, key: key) {
      // A metric's family shares more time than a surface's — its members
      // may each cross a wide box — but at most three times as much in all.
      let ms = max(geodesicFamilyMs / Double(members), min(150, 3 * geodesicFamilyMs / Double(members)))
      let deadline = Date().addingTimeInterval(ms / 1000)
      var ended = GeodesicEnd()
      let pts = metricGeodesicPath(
        spec, env, window: box,
        maxPoints: min(geodesicFamilyPoints, max(300, geodesicFamilyPoints / members)),
        maxSteps: min(GEODESIC_MAX_STEPS, Int((Double(geodesicFamilySteps) / Double(members)).rounded(.up))),
        outOfTime: { Date() > deadline }, ended: &ended)
      return (pts, geodesicCutNote(ended))
    }
  }

  /// What each geodesic row says of its last trace, by row (web/main.ts
  /// `geodesicNote`): where its budget cut one short, why one could not
  /// start, or how many of a family either happened to. Read after `overlay`
  /// (or `scene`) has drawn the rows; the row's readout is this, when it has one.
  public func geodesicNotes() -> [Int: String] {
    var out: [Int: String] = [:]
    for (index, row) in analysis.rows.enumerated() where row.error == nil && row.unsupported == nil {
      var members = 0
      switch row.cpu {
      case .metric(.geodesic)?: members = 1
      case .family(let all)?:
        if all.allSatisfy({ if case .metric(.geodesic) = $0.cpu { true } else { false } }) { members = all.count }
      default: break
      }
      if members == 0 { continue }
      let notes = metricsDrawn.notes(row: index, members: members)
      if notes.isEmpty { continue }
      if members == 1 {
        out[index] = notes[0]
        continue
      }
      // Budget cuts, and members that could not start (faster than light).
      let cuts = notes.filter { $0.hasPrefix("cut short at ") }
      let others = notes.filter { !$0.hasPrefix("cut short at ") }
      var parts: [String] = []
      if !others.isEmpty { parts.append("\(others.count) of \(members): \(others[0])") }
      if !cuts.isEmpty {
        parts.append(
          "\(cuts.count) of \(members) cut short by the family's budget (one at "
            + "\(cuts[0].dropFirst("cut short at ".count)))")
      }
      out[index] = parts.joined(separator: "; ")
    }
    return out
  }
}
