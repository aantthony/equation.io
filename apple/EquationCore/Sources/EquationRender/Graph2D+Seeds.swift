import EquationCore
import Foundation

// Integral curves seeded on a panel's vector fields (web/main.ts, a click's
// `drops`; web/scene.ts `integralCurve`), and the streamlines toggle of a
// matrix field's row.
//
// A seed is where a viewer tapped: like a state's value it belongs to
// whoever draws the panel, which keeps the seeds (`Graph2D.seeds`, as it
// keeps `partialSums`), adds one on a tap (`dropSeed`), and clears them on a
// double tap. Every 2D vector field of the panel traces a curve through each.

/// A point an integral curve is traced through, in the panel's plane.
public struct FieldSeed: Equatable, Sendable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

/// Each seed costs an RK4 integration per field per frame; the newest are kept (`MAX_DROPS`).
public let maxFieldSeeds = 12
/// RK4 steps each way along a seed's curve (`ODE_STEPS`).
let ODE_STEPS = 1400

extension Graph2D {
  /// Whether a tap drops a seed here: some row draws a 2D vector field
  /// (web/main.ts, pointerup).
  public var takesSeeds: Bool {
    analysis.rows.contains { row in
      if row.error != nil || row.unsupported != nil { return false }
      if case .vfield2d? = row.cpu { return true }
      return false
    }
  }

  /// Drop a seed at (x, y) of the plane, letting go of the oldest past
  /// `maxFieldSeeds`. Nothing where no row takes one.
  public mutating func dropSeed(x: Double, y: Double) {
    guard takesSeeds, x.isFinite, y.isFinite else { return }
    if seeds.count >= maxFieldSeeds { seeds.removeFirst(seeds.count - maxFieldSeeds + 1) }
    seeds.append(FieldSeed(x: x, y: y))
  }

  /// The curve of the normalized field through a seed, both directions
  /// (`integralCurve`): normalizing makes it a direction field, so the steps
  /// are of uniform arc length on screen and the trajectories the same (a
  /// slope field dy/dx = f integrates as (1, f) normalized). Traced over one
  /// and a half windows each way from the view's centre.
  static func integralCurve(
    _ comps: [Expr], _ seed: FieldSeed, env: [String: Double], view: View2D, bounds: Bounds
  ) -> [Double] {
    let w = 1.5 * (bounds.xmax - bounds.xmin)
    let h = 1.5 * (bounds.ymax - bounds.ymin)
    let ratio = view.ratio ?? 1
    return streamline(
      fieldEvaluator(comps, env), [seed.x, seed.y], 2.5 * view.upp, [view.cx - w, view.cy - h],
      [view.cx + w, view.cy + h], steps: ODE_STEPS, metric: [1, ratio]
    ).flatMap { $0 }
  }

  /// A vector field row's seeded curves and their seeds (web/scene.ts, case 'vfield2d').
  func drawSeeds(
    _ comps: [Expr], color: CSSColor, env: [String: Double], view: View2D?, bounds: Bounds,
    into overlay: inout Overlay2D
  ) {
    guard let view, comps.count == 2 else { return }
    for (k, seed) in seeds.enumerated() {
      overlay.polylines.append(
        .init(pts: Self.integralCurve(comps, seed, env: env, view: view, bounds: bounds), color: color))
      overlay.points.append(.init(x: seed.x, y: seed.y, color: color, hot: hotSeed == k ? true : nil))
    }
  }

  /// The shader passes with the rows' display toggles applied: a matrix
  /// field whose row asks for streamlines draws them (web/scene.ts, case
  /// 'tfield2d': `eq.showStreamlines`).
  func toggled(_ layers: Layers2D) -> Layers2D {
    guard !tensorStreamlines.isEmpty, var tfields = layers.tfields else { return layers }
    for (k, row) in tensorRows.enumerated() where k < tfields.count && tensorStreamlines.contains(row) {
      tfields[k].streamlines = true
    }
    var out = layers
    out.tfields = tfields
    return out
  }
}
